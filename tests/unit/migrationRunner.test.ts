import { describe, expect, it } from 'vitest';
import type { SqlSession } from '../../electron/databases/connections.js';
import { MigrationRunner, readHistory, setupHistory } from '../../electron/databases/runner.js';
import type { AdmissionEvidence, HistoryEvent, MigrationPlanRequest, RunnerMigration, RunnerTarget } from '../../src/types/databaseExecution.js';

const NOW = Date.parse('2026-10-19T00:00:00Z');
const target: RunnerTarget = {
  targetId: 'dev-inventory', databaseKey: 'inventory', environment: 'dev',
  identity: { serverId: 'mysql:fixture', database: 'inventory', engine: 'mysql', version: '8.0.36', settings: { sqlMode: '', lowerCaseTableNames: 0, characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }, fingerprint: 'identity' },
};
const migration = (id = 'inventory/one', sequence = 1): RunnerMigration => ({
  id, sequence, contentDigest: `hash-${id}`, upSql: ['INSERT INTO stock (value) VALUES (1);'], downSql: ['DELETE FROM stock WHERE value = 1;'],
  preconditions: [], postconditions: [], eligibilityChecks: [], transactional: false, recoveryRoute: 'tested-down',
});

class FixtureDatabase {
  tables = new Set<string>();
  enrollment?: { identity_fingerprint: string; baseline_digest: string };
  events: { event_id: number; payload: string }[] = [];
  calls: string[] = [];
  schema = 'baseline';
  identity = 'identity';
  data = 0;
  owner?: number;
  nextSession = 0;
  nextEvent = 0;
  failSql?: string;
  loseLockOnSql?: string;
  failCommit = false;
  engine = 'InnoDB';
  version = target.identity.version;
  sqlMode = target.identity.settings.sqlMode;
  async open(): Promise<SqlSession> {
    const id = ++this.nextSession;
    let tx: { events: { event_id: number; payload: string }[]; data: number } | undefined;
    let closed = false;
    const ensureOpen = () => { if (closed) throw new Error('Lost session'); };
    return {
      query: async (sql, params = []) => {
        ensureOpen(); this.calls.push(sql);
        if (sql.includes('GET_LOCK')) {
          if (this.owner !== undefined) return [{ acquired: 0 }];
          this.owner = id; return [{ acquired: 1 }];
        }
        if (sql.includes('IS_USED_LOCK')) return [{ owned: this.owner === id ? 1 : 0 }];
        if (sql.includes('RELEASE_LOCK')) { if (this.owner === id) this.owner = undefined; return [{ released: 1 }]; }
        if (sql.includes('TABLE_NAME IN')) return [...this.tables].map(name => ({ name }));
        if (sql.includes("TABLE_TYPE = 'BASE TABLE'")) return [{ name: 'stock', engine: this.engine }];
        if (sql.includes('FROM db_radar_enrollment')) return this.enrollment ? [this.enrollment] : [];
        if (sql.includes('FROM db_radar_events')) return [...this.events, ...(tx?.events ?? [])].sort((a, b) => a.event_id - b.event_id);
        if (sql === 'SELECT 0 AS value') return [{ value: 0 }];
        if (sql === 'SELECT 1 AS value') return [{ value: 1 }];
        if (sql === 'SELECT value FROM stock') return [{ value: tx?.data ?? this.data }];
        void params;
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql, params = []) => {
        ensureOpen(); this.calls.push(sql);
        if (sql === 'START TRANSACTION') { tx = { events: [], data: this.data }; return; }
        if (sql === 'ROLLBACK') { tx = undefined; return; }
        if (sql === 'COMMIT') {
          if (tx) { this.events.push(...tx.events); this.data = tx.data; tx = undefined; }
          if (this.failCommit) { this.failCommit = false; throw new Error('Commit acknowledgement lost'); }
          return;
        }
        if (sql.startsWith('CREATE TABLE db_radar_')) {
          const name = sql.split(' ')[2];
          if (this.tables.has(name)) throw new Error('Already exists');
          this.tables.add(name); return;
        }
        if (sql.startsWith('INSERT INTO db_radar_enrollment')) { this.enrollment = { identity_fingerprint: String(params[0]), baseline_digest: String(params[1]) }; return; }
        if (sql.startsWith('INSERT INTO db_radar_events')) {
          const event = { event_id: ++this.nextEvent, payload: String(params[0]) };
          (tx?.events ?? this.events).push(event); return;
        }
        if (sql.startsWith('INSERT INTO stock')) { if (tx) tx.data++; else this.data++; }
        else if (sql.startsWith('DELETE FROM stock')) { if (tx) tx.data--; else this.data--; }
        else if (sql.startsWith('ALTER TABLE stock')) this.schema = 'changed';
        else throw new Error(`Unexpected execute: ${sql}`);
        if (this.loseLockOnSql && sql.includes(this.loseLockOnSql)) this.owner = undefined;
        if (this.failSql && sql.includes(this.failSql)) { this.failSql = undefined; throw new Error('Server accepted write but acknowledgement was lost'); }
      },
      close: async () => { closed = true; tx = undefined; if (this.owner === id) this.owner = undefined; },
    };
  }
  historyEvents(): HistoryEvent[] { return this.events.map(row => ({ ...JSON.parse(row.payload), eventId: row.event_id })); }
}

function evidence(request: MigrationPlanRequest, beforeSchemaDigest: string): AdmissionEvidence {
  return {
    expectedSchemaDigests: Object.fromEntries(request.migrationIds.map(id => [id, beforeSchemaDigest])),
    recovery: request.migrations.map(item => ({ evidenceId: `recovery-${item.id}`, targetId: request.target.targetId, releaseDigest: request.releaseDigest, beforeSchemaDigest, migrationId: item.id, contentDigest: item.contentDigest, expiresAt: new Date(NOW + 60_000).toISOString(), route: 'tested-down', rehearsal: 'up-down-up-passed' })),
  };
}
function makeRunner(db: FixtureDatabase, override?: (proof: AdmissionEvidence) => void): MigrationRunner {
  return new MigrationRunner({
    open: () => db.open(), inspect: async () => ({ identity: { ...target.identity, fingerprint: db.identity, version: db.version, settings: { ...target.identity.settings, sqlMode: db.sqlMode } }, identityFingerprint: db.identity, schemaDigest: db.schema, coverageComplete: true }), now: () => NOW,
    trustedEvidence: async (selectedTarget, migrations, direction, releaseDigest, beforeSchemaDigest) => {
      const proof = evidence({ target: selectedTarget, migrations, direction, releaseDigest, migrationIds: migrations.map(item => item.id), kind: 'execute' }, beforeSchemaDigest);
      override?.(proof); return proof;
    },
  });
}
function request(migrations = [migration()], overrides: Partial<MigrationPlanRequest> = {}): MigrationPlanRequest {
  return { target, migrations, releaseDigest: 'release-v1', migrationIds: migrations.map(item => item.id), direction: 'up', kind: 'execute', ...overrides };
}
async function enroll(db: FixtureDatabase): Promise<void> { const session = await db.open(); await setupHistory(session, target.identity, 'baseline'); await session.close(); }
async function run(runner: MigrationRunner, input: MigrationPlanRequest) { const plan = await runner.createPlan(input); return runner.execute(plan.planId, runner.issueApproval(plan.planId)); }

describe('reviewed migration execution and durable history', () => {
  it('inspection never enrolls; enrollment is explicit and cannot overwrite an existing baseline', async () => {
    const db = new FixtureDatabase(); const session = await db.open();
    expect((await readHistory(session)).enrolled).toBe(false);
    expect(db.tables.size).toBe(0);
    const runner = makeRunner(db);
    expect((await run(runner, request([], { kind: 'enroll', baselineDigest: 'baseline' }))).state).toBe('succeeded');
    expect((await readHistory(session)).baselineDigest).toBe('baseline');
    await expect(setupHistory(session, target.identity, 'different')).rejects.toThrow('already enrolled');
    expect(db.enrollment?.baseline_digest).toBe('baseline');
  });

  it('blocks unsupported later SQL before the first database call', async () => {
    const db = new FixtureDatabase(); const one = migration(); const two = migration('inventory/two', 2); two.downSql = ['PREPARE x FROM @q; EXECUTE x;'];
    await expect(makeRunner(db).createPlan(request([one, two]))).rejects.toThrow();
    expect(db.calls).toHaveLength(0);
  });

  it('permits only the next exact prefix and rejects tampered hashes', async () => {
    const db = new FixtureDatabase(); await enroll(db); const runner = makeRunner(db); const one = migration(); const two = migration('inventory/two', 2);
    await expect(runner.createPlan(request([one, two], { migrationIds: [two.id] }))).rejects.toThrow('next contiguous prefix');
    expect((await run(runner, request([one, two], { migrationIds: [one.id] }))).state).toBe('succeeded');
    await expect(runner.createPlan(request([one, two], { migrationIds: [one.id] }))).rejects.toThrow();
    const tampered = { ...one, contentDigest: 'different' };
    await expect(runner.createPlan(request([tampered, two], { migrationIds: [two.id] }))).rejects.toThrow('immutable');
  });

  it('preserves up/down/up attempts and refuses a non-suffix reversal', async () => {
    const db = new FixtureDatabase(); await enroll(db); const runner = makeRunner(db); const one = migration(); const two = migration('inventory/two', 2);
    expect((await run(runner, request([one, two]))).state).toBe('succeeded');
    await expect(runner.createPlan(request([one, two], { direction: 'down', migrationIds: [one.id] }))).rejects.toThrow();
    expect((await run(runner, request([one, two], { direction: 'down', migrationIds: [two.id] }))).state).toBe('succeeded');
    expect((await run(runner, request([one, two], { migrationIds: [two.id] }))).state).toBe('succeeded');
    expect(db.historyEvents().filter(event => event.kind === 'attempt-start').map(event => event.direction)).toEqual(['up', 'up', 'down', 'up']);
  });

  it('records adoption distinctly without executing migration SQL', async () => {
    const db = new FixtureDatabase(); await enroll(db); const runner = makeRunner(db);
    expect((await run(runner, request([migration()], { kind: 'adopt' }))).state).toBe('succeeded');
    expect(db.historyEvents().map(event => event.kind)).toEqual(['adoption']);
    expect(db.data).toBe(0);
  });

  it.each(['schema', 'identity', 'history', 'version', 'sqlMode'])('invalidates reviewed plans when %s changes and consumes approval', async changed => {
    const db = new FixtureDatabase(); await enroll(db); const runner = makeRunner(db); const plan = await runner.createPlan(request()); const approval = runner.issueApproval(plan.planId);
    if (changed === 'schema') db.schema = 'drift';
    else if (changed === 'identity') db.identity = 'other';
    else if (changed === 'version') db.version = '8.0.37';
    else if (changed === 'sqlMode') db.sqlMode = 'ANSI_QUOTES';
    else db.events.push({ event_id: ++db.nextEvent, payload: JSON.stringify({ kind: 'adoption', at: 'now', migrationId: 'other' }) });
    await expect(runner.execute(plan.planId, approval)).rejects.toThrow();
    await expect(runner.execute(plan.planId, approval)).rejects.toThrow('unavailable');
    expect(db.data).toBe(0);
  });

  it('serializes cooperating app instances with a database-wide session lock', async () => {
    const db = new FixtureDatabase(); await enroll(db); const runner = makeRunner(db); const plan = await runner.createPlan(request());
    const other = await db.open(); await other.query('SELECT GET_LOCK(?, 0) AS acquired', ['fixture']);
    await expect(runner.execute(plan.planId, runner.issueApproval(plan.planId))).rejects.toThrow('Another runner');
    expect(db.data).toBe(0); await other.close();
  });

  it('stops after acknowledgement loss and blocks restart instead of retrying', async () => {
    const db = new FixtureDatabase(); await enroll(db); const two = migration('inventory/two', 2); db.failSql = 'INSERT INTO stock';
    const result = await run(makeRunner(db), request([migration(), two]));
    expect(result.state).toBe('uncertain'); expect(result.attemptIds).toHaveLength(1); expect(db.data).toBe(1);
    expect(db.historyEvents().filter(event => event.kind === 'statement-intent')).toHaveLength(1);
    await expect(makeRunner(db).createPlan(request([migration(), two]))).rejects.toThrow('reconciliation');
    expect(db.data).toBe(1);
  });

  it('a lost lock stops further statements and leaves blocking history', async () => {
    const db = new FixtureDatabase(); await enroll(db); const item = migration(); item.upSql.push('UPDATE stock SET value = 2;'); db.loseLockOnSql = 'INSERT INTO stock';
    expect((await run(makeRunner(db), request([item]))).state).toBe('uncertain');
    expect(db.calls.filter(sql => sql.startsWith('UPDATE stock'))).toHaveLength(0);
    await expect(makeRunner(db).createPlan(request([item]))).rejects.toThrow('Unfinished');
  });

  it('checks refuse down after provenance/business use and preserve applied up', async () => {
    const db = new FixtureDatabase(); await enroll(db); const runner = makeRunner(db); const item = migration(); item.eligibilityChecks = [{ sql: 'SELECT 0 AS value', expect: 'scalar-equals', value: 1 }];
    await run(runner, request([item]));
    expect((await run(runner, request([item], { direction: 'down' }))).state).toBe('failed');
    expect(db.data).toBe(1);
    expect(db.calls.filter(sql => sql.startsWith('DELETE FROM stock'))).toHaveLength(0);
  });

  it('rolls back data-only changes on a failed postcondition but retains durable attempt evidence', async () => {
    const db = new FixtureDatabase(); await enroll(db); const item = migration(); item.transactional = true; item.postconditions = [{ sql: 'SELECT value FROM stock', expect: 'scalar-equals', value: 99 }];
    expect((await run(makeRunner(db), request([item]))).state).toBe('failed'); expect(db.data).toBe(0);
    expect(db.historyEvents().at(-1)?.state).toBe('failed');
    expect(db.historyEvents().some(event => event.kind === 'statement-intent')).toBe(true);
  });

  it('commits data and success history together; a lost COMMIT acknowledgement remains uncertain', async () => {
    const db = new FixtureDatabase(); await enroll(db); const item = migration(); item.transactional = true;
    db.failCommit = true;
    expect((await run(makeRunner(db), request([item]))).state).toBe('uncertain'); expect(db.data).toBe(1);
    expect(db.historyEvents().some(event => event.kind === 'attempt-end' && event.state === 'succeeded')).toBe(true);
    await expect(makeRunner(db).createPlan(request([item]))).rejects.toThrow();
  });

  it('refuses a false transactional guarantee on a non-InnoDB target', async () => {
    const db = new FixtureDatabase(); await enroll(db); db.engine = 'MyISAM'; const item = migration(); item.transactional = true;
    expect((await run(makeRunner(db), request([item]))).state).toBe('failed'); expect(db.data).toBe(0);
  });

  it('requires tested recovery even for development; conditional downs also require restore coverage', async () => {
    const db = new FixtureDatabase(); await enroll(db);
    await expect(makeRunner(db, proof => { proof.recovery = []; }).createPlan(request())).rejects.toThrow('tested recovery');
    const item = migration(); item.conditionalDown = true;
    await expect(makeRunner(db).createPlan(request([item]))).rejects.toThrow('tested restore');
  });

  it('requires current data guards for destructive down even when a backup is verified', async () => {
    const db = new FixtureDatabase(); await enroll(db); const item = migration(); item.conditionalDown = true;
    const runner = makeRunner(db, proof => {
      proof.recovery.push({ ...proof.recovery[0], evidenceId: 'restore-proof', route: 'tested-restore', rehearsal: 'restore-passed', backup: { identity: 'backup-1', capturedAt: new Date(NOW - 1000).toISOString(), available: true, scope: ['inventory'], acceptedMaxAgeMs: 60_000, downtimeLimitMinutes: 10, dataLossLimitMinutes: 1, affectedServices: ['inventory'], approvedServices: ['inventory'] } });
    });
    expect((await run(runner, request([item]))).state).toBe('succeeded');
    await expect(runner.createPlan(request([item], { direction: 'down' }))).rejects.toThrow('data-eligibility');
    expect(db.data).toBe(1);
  });

  it('production requires identical dev contents and current complete explanation evidence', async () => {
    const db = new FixtureDatabase(); await enroll(db); const prodTarget = { ...target, targetId: 'production', environment: 'production' as const };
    await expect(makeRunner(db).createPlan(request([migration()], { target: prodTarget }))).rejects.toThrow('development');
    const runner = makeRunner(db, proof => {
      proof.development = { evidenceId: 'dev-proof', releaseDigest: 'release-v1', migrations: [{ id: migration().id, contentDigest: migration().contentDigest }] };
      proof.explanation = { evidenceId: 'replay-proof', targetId: 'production', releaseDigest: 'release-v1', beforeSchemaDigest: 'baseline', assessment: 'explained', coverageComplete: true, expiresAt: new Date(NOW + 60_000).toISOString() };
    });
    expect((await run(runner, request([migration()], { target: prodTarget }))).state).toBe('succeeded');
  });

  it('detects unfinished durable starts even on a new process', async () => {
    const db = new FixtureDatabase(); await enroll(db);
    db.events.push({ event_id: 1, payload: JSON.stringify({ kind: 'attempt-start', at: 'now', attemptId: 'crashed' }) });
    await expect(makeRunner(db).createPlan(request())).rejects.toThrow('Unfinished');
  });
});
