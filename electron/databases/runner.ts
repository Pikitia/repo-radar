import { randomUUID } from 'node:crypto';
import type { DatabaseIdentity } from '../../src/types/database.js';
import type { SqlSession } from './connections.js';
import type {
  AdmissionEvidence, DatabaseHistory, FrozenSqlStatement, HistoryEvent, MigrationPlan,
  MigrationPlanRequest, MigrationRunResult, RunnerCheck, RunnerInspection, RunnerMigration, RunnerTarget,
} from '../../src/types/databaseExecution.js';
import { freezeSql, sqlDigest } from './sql.js';

const ENROLLMENT = 'db_radar_enrollment';
const EVENTS = 'db_radar_events';
const digest = (value: unknown): string => sqlDigest(JSON.stringify(value));
const timestamp = (now: () => number): string => new Date(now()).toISOString();
const emptyHistory = (): DatabaseHistory => ({ enrolled: false, events: [], digest: digest({ enrolled: false }) });

/** Inspection never creates tables. Partial enrollment requires human reconciliation. */
export async function readHistory(session: SqlSession): Promise<DatabaseHistory> {
  const tables = await session.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)', [ENROLLMENT, EVENTS]);
  if (tables.length === 0) return emptyHistory();
  if (tables.length !== 2) throw new Error('History enrollment is incomplete; reconcile it before continuing.');
  const enrollment = await session.query('SELECT identity_fingerprint, baseline_digest FROM db_radar_enrollment WHERE singleton_id = 1');
  if (enrollment.length !== 1 || typeof enrollment[0].identity_fingerprint !== 'string' || typeof enrollment[0].baseline_digest !== 'string') throw new Error('Invalid history enrollment.');
  const rows = await session.query('SELECT event_id, payload FROM db_radar_events ORDER BY event_id LIMIT 100001');
  if (rows.length > 100_000) throw new Error('History exceeds the supported inspection limit.');
  const events = rows.map(row => {
    if (typeof row.payload !== 'string') throw new Error('Invalid history event.');
    let value: unknown;
    try { value = JSON.parse(row.payload); } catch { throw new Error('Invalid history event JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history event.');
    const event = { ...value, eventId: Number(row.event_id) } as HistoryEvent;
    if (!Number.isSafeInteger(event.eventId) || !['adoption', 'attempt-start', 'statement-intent', 'statement-outcome', 'attempt-end'].includes(event.kind) || typeof event.at !== 'string') throw new Error('Invalid history event shape.');
    return event;
  });
  const history = { enrolled: true, identityFingerprint: enrollment[0].identity_fingerprint, baselineDigest: enrollment[0].baseline_digest, events };
  return { ...history, digest: digest(history) };
}

/** Called only after an approved enrollment plan under the database-wide lock. */
export async function setupHistory(session: SqlSession, identity: DatabaseIdentity, baselineDigest: string): Promise<void> {
  if (!baselineDigest || !identity.fingerprint) throw new Error('Enrollment requires an exact identity and baseline.');
  const history = await readHistory(session);
  if (history.enrolled) throw new Error('This database is already enrolled.');
  // No IF NOT EXISTS: a concurrent/partial setup must fail, never silently adopt tables.
  await session.execute('CREATE TABLE db_radar_enrollment (singleton_id TINYINT NOT NULL PRIMARY KEY, identity_fingerprint VARCHAR(128) NOT NULL, baseline_digest VARCHAR(128) NOT NULL) ENGINE=InnoDB');
  await session.execute('CREATE TABLE db_radar_events (event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, payload LONGTEXT NOT NULL) ENGINE=InnoDB');
  await session.execute('INSERT INTO db_radar_enrollment (singleton_id, identity_fingerprint, baseline_digest) VALUES (1, ?, ?)', [identity.fingerprint, baselineDigest]);
}

async function append(session: SqlSession, event: Omit<HistoryEvent, 'eventId'>): Promise<void> {
  await session.execute('INSERT INTO db_radar_events (payload) VALUES (?)', [JSON.stringify(event)]);
}

export interface MigrationRunnerDependencies {
  open(target: RunnerTarget): Promise<SqlSession>;
  inspect(session: SqlSession, target: RunnerTarget): Promise<RunnerInspection>;
  /** Obtains evidence from trusted app-owned stores; never forwards renderer flags. */
  trustedEvidence(target: RunnerTarget, migrations: RunnerMigration[], direction: 'up' | 'down', releaseDigest: string, beforeSchemaDigest: string): Promise<AdmissionEvidence>;
  now?: () => number;
  progress?: (result: { planId: string; migrationId?: string; ordinal?: number; state: string }) => void;
}

interface CompiledMigration {
  migration: RunnerMigration;
  up: FrozenSqlStatement[];
  down: FrozenSqlStatement[];
}
interface StoredPlan {
  request: MigrationPlanRequest;
  plan: MigrationPlan;
  compiled: CompiledMigration[];
  evidenceDigest: string;
  approval?: string;
}

function validateRequest(request: MigrationPlanRequest): void {
  if (!['execute', 'enroll', 'adopt'].includes(request.kind) || !['up', 'down'].includes(request.direction) || !['dev', 'production'].includes(request.target.environment) || !request.target.targetId || !request.target.databaseKey || !request.target.identity.fingerprint || !request.releaseDigest) throw new Error('Invalid migration plan request.');
  const ids = new Set<string>();
  request.migrations.forEach((migration, index) => {
    if (migration.sequence !== index + 1 || ids.has(migration.id) || !migration.id || !migration.contentDigest) throw new Error('Release sequences must be unique, contiguous and immutable.');
    ids.add(migration.id);
  });
  if (new Set(request.migrationIds).size !== request.migrationIds.length || request.migrationIds.some(id => !ids.has(id))) throw new Error('Requested migrations are missing or duplicated.');
  if (request.kind === 'enroll' && (request.migrationIds.length || !request.baselineDigest)) throw new Error('Enrollment requires an explicit baseline and no migrations.');
  if (request.kind !== 'enroll' && !request.migrationIds.length) throw new Error('Select at least one migration.');
  if (request.kind === 'adopt' && request.direction !== 'up') throw new Error('Adoption must be a prefix.');
}

function compile(migrations: RunnerMigration[]): CompiledMigration[] {
  return migrations.map(migration => {
    const up = freezeSql(migration.upSql);
    const down = freezeSql(migration.downSql);
    if (!up.length || (migration.recoveryRoute === 'tested-down' && !down.length)) throw new Error('Migration or required down SQL is empty.');
    for (const check of [...migration.preconditions, ...migration.postconditions, ...migration.eligibilityChecks]) {
      if (freezeSql([check.sql], 'check').length !== 1 || !['empty', 'nonempty', 'scalar-equals', 'row-count'].includes(check.expect)) throw new Error('Each check requires one supported read-only SELECT and a typed expectation.');
      if (check.expect === 'row-count' && (!Number.isSafeInteger(check.value) || Number(check.value) < 0)) throw new Error('Invalid expected row count.');
    }
    if (migration.transactional && [...up, ...down].some(statement => statement.kind !== 'dml')) throw new Error('Transactional migrations must contain data-only statements.');
    return { migration, up, down };
  });
}

/** Reconstruct the current prefix without modifying or discarding old attempts. */
export function appliedPrefix(history: DatabaseHistory, migrations: RunnerMigration[]): string[] {
  const applied: string[] = [];
  const starts = new Map<string, HistoryEvent>();
  const ended = new Set<string>();
  const known = new Map(migrations.map(migration => [migration.id, migration]));
  const apply = (event: HistoryEvent): void => {
    const migration = known.get(event.migrationId ?? '');
    if (!migration || event.contentDigest !== migration.contentDigest || event.sequence !== migration.sequence) throw new Error('Applied history does not match these immutable release contents.');
    if (event.direction === 'down') {
      if (applied.at(-1) !== migration.id) throw new Error('Down history is not a reverse suffix.');
      applied.pop();
    } else {
      if (migrations[applied.length]?.id !== migration.id) throw new Error('History is not an exact release prefix.');
      applied.push(migration.id);
    }
  };
  for (const event of history.events) {
    if (event.kind === 'adoption') apply(event);
    else if (event.kind === 'attempt-start') {
      if (!event.attemptId || starts.has(event.attemptId)) throw new Error('Invalid duplicate attempt.');
      starts.set(event.attemptId, event);
    } else if (event.kind === 'attempt-end') {
      const start = starts.get(event.attemptId ?? '');
      if (!start || ended.has(event.attemptId!)) throw new Error('Invalid attempt completion.');
      ended.add(event.attemptId!);
      if (event.state !== 'succeeded') throw new Error('Failed or uncertain history requires explicit reconciliation; automatic retries are prohibited.');
      apply(start);
    } else if (!starts.has(event.attemptId ?? '')) throw new Error('Statement history has no attempt.');
  }
  if ([...starts.keys()].some(id => !ended.has(id))) throw new Error('Unfinished attempt requires explicit reconciliation; automatic resume is prohibited.');
  return applied;
}

function validateOrder(request: MigrationPlanRequest, history: DatabaseHistory): void {
  if (request.kind === 'enroll') {
    if (history.enrolled) throw new Error('Database is already enrolled.');
    return;
  }
  if (!history.enrolled || history.identityFingerprint !== request.target.identity.fingerprint) throw new Error('Enroll this exact target before planning migrations.');
  const applied = appliedPrefix(history, request.migrations);
  if (request.kind === 'adopt' && history.events.length) throw new Error('Adoption is only available on a new baseline without attempts.');
  const expected = request.direction === 'up'
    ? request.migrations.slice(applied.length, applied.length + request.migrationIds.length).map(migration => migration.id)
    : applied.slice(-request.migrationIds.length).reverse();
  if (JSON.stringify(expected) !== JSON.stringify(request.migrationIds)) throw new Error('Run only the next contiguous prefix, or reverse the latest applied suffix.');
}

function checkEvidence(request: MigrationPlanRequest, schemaDigest: string, evidence: AdmissionEvidence, now: number): string[] {
  if (request.kind !== 'execute') return [];
  const evidenceIds: string[] = [];
  const selected = request.migrations.filter(migration => request.migrationIds.includes(migration.id));
  for (const migration of selected) {
    if (!evidence.expectedSchemaDigests[migration.id]) throw new Error('Every migration requires an isolated replay result for its final schema.');
    const matching = evidence.recovery.filter(item => item.targetId === request.target.targetId && item.releaseDigest === request.releaseDigest && item.beforeSchemaDigest === schemaDigest && item.migrationId === migration.id && item.contentDigest === migration.contentDigest && Date.parse(item.expiresAt) > now && item.evidenceId);
    const down = matching.find(item => item.route === 'tested-down' && item.rehearsal === 'up-down-up-passed');
    const restore = matching.find(item => {
      const backup = item.backup;
      return item.route === 'tested-restore' && item.rehearsal === 'restore-passed' && backup && backup.identity && backup.available && backup.scope.includes(request.target.databaseKey)
        && Number.isFinite(Date.parse(backup.capturedAt)) && now >= Date.parse(backup.capturedAt) && now - Date.parse(backup.capturedAt) <= backup.acceptedMaxAgeMs
        && backup.acceptedMaxAgeMs > 0 && backup.downtimeLimitMinutes >= 0 && backup.dataLossLimitMinutes >= 0
        && backup.affectedServices.length > 0 && backup.affectedServices.every(service => backup.approvedServices.includes(service));
    });
    if (migration.recoveryRoute === 'tested-down' ? !down : !restore) throw new Error('Each migration requires current, target-bound tested recovery evidence.');
    if (migration.conditionalDown && !restore) throw new Error('Conditional down migrations require tested restore coverage for subsequent business use.');
    if (request.direction === 'down' && migration.conditionalDown && !migration.eligibilityChecks.length) throw new Error('Conditional/destructive down requires explicit current data-eligibility checks.');
    if (request.direction === 'down' && (!down || !migration.downSql.length)) throw new Error('Down requires a tested down path and current eligibility checks.');
    evidenceIds.push((migration.recoveryRoute === 'tested-down' ? down : restore)!.evidenceId);
    if (migration.conditionalDown) evidenceIds.push(restore!.evidenceId);
  }
  if (request.target.environment === 'production') {
    if (!evidence.development?.evidenceId || evidence.development.releaseDigest !== request.releaseDigest || selected.some(migration => !evidence.development!.migrations.some(item => item.id === migration.id && item.contentDigest === migration.contentDigest))) throw new Error('Production requires successful development execution of identical contents.');
    const explanation = evidence.explanation;
    if (!explanation?.evidenceId || explanation.targetId !== request.target.targetId || explanation.releaseDigest !== request.releaseDigest || explanation.beforeSchemaDigest !== schemaDigest || explanation.assessment !== 'explained' || !explanation.coverageComplete || !(Date.parse(explanation.expiresAt) > now)) throw new Error('Production requires a fresh complete schema explanation.');
  }
  return [...new Set(evidenceIds)];
}

async function checks(session: SqlSession, items: RunnerCheck[]): Promise<void> {
  for (const check of items) {
    const rows = await session.query(freezeSql([check.sql], 'check')[0].sql);
    const scalar = rows.length === 1 ? Object.values(rows[0]) : [];
    const passed = check.expect === 'empty' ? rows.length === 0
      : check.expect === 'nonempty' ? rows.length > 0
      : check.expect === 'row-count' ? rows.length === check.value
      : scalar.length === 1 && scalar[0] === check.value;
    if (!passed) throw new Error('Migration check did not match its expected result.');
  }
}

export class MigrationRunner {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly now: () => number;
  constructor(private readonly dependencies: MigrationRunnerDependencies) { this.now = dependencies.now ?? Date.now; }

  async createPlan(input: MigrationPlanRequest): Promise<MigrationPlan> {
    const request = structuredClone(input);
    validateRequest(request);
    // All source bytes, including down/check files and later selected migrations, are parsed before any write.
    const compiled = compile(request.migrations);
    const session = await this.dependencies.open(request.target);
    try {
      const inspection = await this.dependencies.inspect(session, request.target);
      this.validateInspection(request, inspection);
      const history = await readHistory(session);
      validateOrder(request, history);
      if ((request.kind === 'enroll' || request.kind === 'adopt') && (request.baselineDigest ?? history.baselineDigest) !== inspection.schemaDigest) throw new Error('Baseline adoption/enrollment must match the complete current schema.');
      const evidence = await this.dependencies.trustedEvidence(request.target, request.migrations, request.direction, request.releaseDigest, inspection.schemaDigest);
      const recoveryEvidenceIds = checkEvidence(request, inspection.schemaDigest, evidence, this.now());
      const plan: MigrationPlan = {
        planId: randomUUID(), targetId: request.target.targetId, environment: request.target.environment,
        releaseDigest: request.releaseDigest, migrationIds: request.migrationIds, direction: request.direction, kind: request.kind,
        historyDigest: history.digest, beforeSchemaDigest: inspection.schemaDigest, expiresAt: new Date(this.now() + 10 * 60_000).toISOString(),
        recoveryEvidenceIds, rehearsalEvidenceId: evidence.explanation?.evidenceId,
        statementCount: compiled.filter(item => request.migrationIds.includes(item.migration.id)).reduce((count, item) => count + item[request.direction].length, 0),
      };
      this.plans.set(plan.planId, { request, plan, compiled, evidenceDigest: digest(evidence) });
      return structuredClone(plan);
    } finally { await session.close(); }
  }

  /** Internal capability issued only by the desktop human-review handler. MCP must never call this. */
  issueApproval(planId: string): string {
    const stored = this.getPlan(planId);
    stored.approval = randomUUID();
    return stored.approval;
  }

  invalidatePlans(): void { this.plans.clear(); }

  private getPlan(planId: string): StoredPlan {
    const stored = this.plans.get(planId);
    if (!stored || Date.parse(stored.plan.expiresAt) <= this.now()) throw new Error('Plan is unavailable or expired; review a new plan.');
    return stored;
  }

  private validateInspection(request: MigrationPlanRequest, inspection: RunnerInspection): void {
    const expected = request.target.identity;
    const actual = inspection.identity;
    if (!actual || !inspection.coverageComplete || inspection.identityFingerprint !== expected.fingerprint
      || actual.fingerprint !== expected.fingerprint || actual.serverId !== expected.serverId || actual.database !== expected.database
      || actual.engine !== expected.engine || actual.version !== expected.version || digest(actual.settings) !== digest(expected.settings)
      || !inspection.schemaDigest) throw new Error('Target identity, engine settings or complete schema inspection could not be verified.');
  }

  async execute(planId: string, approval: string, operator = 'desktop operator'): Promise<MigrationRunResult> {
    const stored = this.getPlan(planId);
    if (!approval || stored.approval !== approval) throw new Error('A fresh desktop approval for this exact plan is required.');
    // Consume before opening connections: failures never make approval reusable.
    this.plans.delete(planId);
    const { request, plan } = stored;
    const session = await this.dependencies.open(request.target);
    const lockName = `db-radar:${sqlDigest(`${request.target.identity.serverId}:${request.target.identity.database.toLowerCase()}`).slice(0, 50)}`;
    let locked = false;
    const attemptIds: string[] = [];
    const assertLock = async (): Promise<void> => {
      const rows = await session.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [lockName]);
      if (Number(rows[0]?.owned) !== 1) throw new Error('Database execution lock was lost.');
    };
    try {
      const lock = await session.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
      if (Number(lock[0]?.acquired) !== 1) throw new Error('Another runner holds this database lock.');
      locked = true;
      if (Date.parse(plan.expiresAt) <= this.now()) throw new Error('Plan expired while opening the target; review a new plan.');
      await assertLock();
      const inspection = await this.dependencies.inspect(session, request.target);
      this.validateInspection(request, inspection);
      const history = await readHistory(session);
      if (inspection.schemaDigest !== plan.beforeSchemaDigest || history.digest !== plan.historyDigest) throw new Error('Schema or migration history changed after review.');
      validateOrder(request, history);
      const evidence = await this.dependencies.trustedEvidence(request.target, request.migrations, request.direction, request.releaseDigest, inspection.schemaDigest);
      checkEvidence(request, inspection.schemaDigest, evidence, this.now());
      if (digest(evidence) !== stored.evidenceDigest) throw new Error('Recovery/rehearsal evidence changed after review.');
      if (Date.parse(plan.expiresAt) <= this.now()) throw new Error('Plan expired during target verification; review a new plan.');
      if (request.kind === 'enroll') {
        await assertLock();
        await setupHistory(session, request.target.identity, plan.beforeSchemaDigest);
        return { planId, state: 'succeeded', attemptIds };
      }
      if (request.kind === 'adopt') {
        await assertLock();
        await session.execute('START TRANSACTION');
        try {
          for (const id of request.migrationIds) {
            const migration = request.migrations.find(item => item.id === id)!;
            await append(session, { kind: 'adoption', at: timestamp(this.now), migrationId: id, contentDigest: migration.contentDigest, sequence: migration.sequence, direction: 'up', targetId: request.target.targetId, releaseDigest: request.releaseDigest, schemaDigest: plan.beforeSchemaDigest, operator });
          }
          await assertLock();
          await session.execute('COMMIT');
        } catch { try { await session.execute('ROLLBACK'); } catch { /* Connection may be gone; never retry. */ } return { planId, state: 'uncertain', attemptIds, errorCode: 'ADOPTION_ACKNOWLEDGEMENT_UNCERTAIN' }; }
        return { planId, state: 'succeeded', attemptIds };
      }
      for (const migrationId of request.migrationIds) {
        const compiled = stored.compiled.find(item => item.migration.id === migrationId)!;
        const migration = compiled.migration;
        const attemptId = randomUUID(); attemptIds.push(attemptId);
        let transaction: SqlSession | undefined;
        let writeDispatched = false;
        let transactionStarted = false;
        let commitDispatched = false;
        let startDispatched = false;
        let startAcknowledged = false;
        try {
          await assertLock();
          const beforeMigration = await this.dependencies.inspect(session, request.target);
          this.validateInspection(request, beforeMigration);
          // This durable start remains if the process is lost, even if a data transaction rolls back.
          startDispatched = true;
          await append(session, { kind: 'attempt-start', at: timestamp(this.now), attemptId, migrationId, contentDigest: migration.contentDigest, sequence: migration.sequence, direction: request.direction, state: 'running', targetId: request.target.targetId, releaseDigest: request.releaseDigest, schemaDigest: beforeMigration.schemaDigest, operator });
          startAcknowledged = true;
          await checks(session, request.direction === 'up' ? migration.preconditions : migration.eligibilityChecks);
          if (migration.transactional) {
            transaction = await this.dependencies.open(request.target);
            const txInspection = await this.dependencies.inspect(transaction, request.target);
            this.validateInspection(request, txInspection);
            if (txInspection.schemaDigest !== beforeMigration.schemaDigest) throw new Error('Transaction target changed.');
            const engines = await transaction.query('SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\'');
            if (engines.some(row => String(row.engine).toUpperCase() !== 'INNODB')) throw new Error('Data-only transactions require every target table to use InnoDB.');
            await transaction.execute('START TRANSACTION'); transactionStarted = true;
          }
          const execution = transaction ?? session;
          for (const statement of compiled[request.direction]) {
            await assertLock();
            await append(session, { kind: 'statement-intent', at: timestamp(this.now), attemptId, ordinal: statement.ordinal, statementDigest: statement.digest });
            await assertLock();
            writeDispatched = true;
            await execution.execute(statement.sql);
            await assertLock();
            await append(session, { kind: 'statement-outcome', at: timestamp(this.now), attemptId, ordinal: statement.ordinal, statementDigest: statement.digest, state: 'succeeded' });
            this.dependencies.progress?.({ planId, migrationId, ordinal: statement.ordinal, state: 'running' });
          }
          await checks(execution, request.direction === 'up' ? migration.postconditions : migration.preconditions);
          await assertLock();
          const after = await this.dependencies.inspect(execution, request.target);
          this.validateInspection(request, after);
          if (after.schemaDigest !== evidence.expectedSchemaDigests[migrationId]) throw new Error('Observed schema does not match the isolated replay result.');
          await append(execution, { kind: 'attempt-end', at: timestamp(this.now), attemptId, state: 'succeeded', schemaDigest: after.schemaDigest });
          if (transaction) { await assertLock(); commitDispatched = true; await transaction.execute('COMMIT'); transactionStarted = false; }
          this.dependencies.progress?.({ planId, migrationId, state: 'succeeded' });
        } catch {
          let rolledBack = false;
          if (transactionStarted && transaction && !commitDispatched) {
            try { await transaction.execute('ROLLBACK'); rolledBack = true; } catch { /* Unknown connection outcome. */ }
          }
          // A rejected driver write may have committed on the server. Never infer safety from an error code.
          const state = (!writeDispatched || rolledBack) && !commitDispatched && (!startDispatched || startAcknowledged) ? 'failed' : 'uncertain';
          const errorCode = state === 'uncertain' ? 'WRITE_ACKNOWLEDGEMENT_UNCERTAIN' : 'MIGRATION_CHECK_OR_TRANSACTION_FAILED';
          if (startAcknowledged) try { await assertLock(); await append(session, { kind: 'attempt-end', at: timestamp(this.now), attemptId, state, errorCode }); } catch { /* Durable start/intent still blocks a fresh app instance. */ }
          this.dependencies.progress?.({ planId, migrationId, state });
          return { planId, state, attemptIds, errorCode };
        } finally { if (transaction) await transaction.close(); }
      }
      return { planId, state: 'succeeded', attemptIds };
    } finally {
      if (locked) { try { await session.query('SELECT RELEASE_LOCK(?) AS released', [lockName]); } catch { /* Session close also releases its lock. */ } }
      await session.close();
    }
  }
}
