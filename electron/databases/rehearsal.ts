import { randomUUID } from "node:crypto";
import type { SchemaSnapshot } from "../../src/types/database.js";
import type { RehearsalResult } from "../../src/types/databaseApi.js";
import type { DatabaseHistory, RunnerCheck, RunnerMigration } from "../../src/types/databaseExecution.js";
import type { SqlSession } from "./connections.js";
import { captureSchema } from "./schema.js";
import { freezeSql } from "./sql.js";

export interface ReplayEvidence extends RehearsalResult {
  targetId: string;
  beforeSchemaDigest: string;
  afterSchemaDigest: string;
  historyDigest: string;
  history?: DatabaseHistory;
  upDigests: Record<string, string>;
  downDigests: Record<string, string>;
  changesByMigration: Record<string, string[]>;
  appliedIds: string[];
  testedDownIds: string[];
  /** Baseline definitions only; never includes production rows. */
  baseline: SchemaSnapshot;
}

export async function runChecks(session: SqlSession, checks: RunnerCheck[]): Promise<void> {
  for (const check of checks) {
    const statements = freezeSql([check.sql], "check");
    if (statements.length !== 1) throw new Error("Each validation must contain one supported query.");
    const rows = await session.query(statements[0].sql);
    const values = rows.length === 1 ? Object.values(rows[0]) : [];
    if (!(check.expect === "empty" ? rows.length === 0 : check.expect === "nonempty" ? rows.length > 0 : check.expect === "row-count" ? rows.length === check.value : values.length === 1 && values[0] === check.value)) throw new Error("A rehearsal validation did not match; schema-only fixtures cannot establish data-dependent conditions.");
  }
}

/** Only called after service verifies an enrolled, empty, separate sandbox instance. */
export async function rehearseOnEmptySandbox(input: {
  session: SqlSession;
  sandbox: SchemaSnapshot;
  baseline: SchemaSnapshot;
  targetId: string;
  databaseKey: string;
  releaseDigest: string;
  historyDigest: string;
  history?: DatabaseHistory;
  migrations: RunnerMigration[];
  appliedIds: string[];
  expectedDev?: SchemaSnapshot;
}): Promise<ReplayEvidence> {
  const { session, sandbox, baseline } = input;
  if (!sandbox.coverage.complete || !baseline.coverage.complete) throw new Error("Complete schema coverage is required for rehearsal.");
  if (sandbox.identity.serverId === baseline.identity.serverId) throw new Error("The sandbox must use a separate database server instance.");
  if (sandbox.objects.length) throw new Error("The rehearsal database must be empty; existing objects are never removed automatically.");
  // Filtered schema snapshots exclude db_radar_* and cannot prove physical emptiness.
  const physical = await session.query("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  const routines = await session.query("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()");
  const triggers = await session.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()");
  const events = await session.query("SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()");
  if (physical.length || routines.length || triggers.length || events.length) throw new Error("The sandbox must be physically empty, including excluded history objects, routines and events.");
  if (sandbox.identity.engine !== baseline.identity.engine || sandbox.identity.version !== baseline.identity.version || JSON.stringify(sandbox.identity.settings) !== JSON.stringify(baseline.identity.settings)) throw new Error("The sandbox engine, version and relevant settings must match the baseline.");
  if (baseline.objects.some(object => ["view", "routine", "trigger"].includes(object.objectType))) throw new Error("This rehearsal adapter supports base tables only; views, routines and triggers remain unverified.");
  const definitions = baseline.objects.filter(object => object.objectType === "table" && object.objectPath.endsWith("/definition"));
  const compiled = input.migrations.map(migration => ({ migration, up: freezeSql(migration.upSql), down: freezeSql(migration.downSql) }));
  if (compiled.some(item => [...item.up, ...item.down].some(statement => statement.kind === "dml"))) throw new Error("Data-changing migrations require a sanitized data-fixture verifier; an empty structural replay cannot prove data recovery.");
  // Parse the complete workload before creating anything on the sandbox.
  const creates = definitions.flatMap(object => freezeSql([object.definition]));
  const tableKey = (name: string) => sandbox.identity.settings.lowerCaseTableNames === 0 ? name : name.toLowerCase();
  const ownedNames = new Set<string>();
  for (const statement of [...creates, ...compiled.flatMap(item => [...item.up, ...item.down])]) {
    const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`(?:``|[^`])+`|[A-Za-z_$][\w$]*)/i.exec(statement.sql);
    if (create) ownedNames.add(tableKey(create[1].startsWith("`") ? create[1].slice(1, -1).replaceAll("``", "`") : create[1]));
  }
  let fixtureStarted = false;
  try {
    await session.execute("SET SESSION FOREIGN_KEY_CHECKS = 0");
    fixtureStarted = true;
    for (const statement of creates) await session.execute(statement.sql);
    await session.execute("SET SESSION FOREIGN_KEY_CHECKS = 1");
    const cloned = await captureSchema(session, sandbox.identity);
    if (!cloned.coverage.complete || cloned.digest !== baseline.digest) throw new Error("The recreated baseline differs from the observed target; no proof was produced.");
    const pending = compiled.filter(item => !input.appliedIds.includes(item.migration.id));
    const upDigests: Record<string, string> = {};
    const downDigests: Record<string, string> = {};
    const beforeDigests: Record<string, string> = {};
    const changesByMigration: Record<string, string[]> = {};
    for (const item of pending) {
      const before = await captureSchema(session, sandbox.identity);
      beforeDigests[item.migration.id] = before.digest;
      await runChecks(session, item.migration.preconditions);
      for (const statement of item.up) await session.execute(statement.sql);
      await runChecks(session, item.migration.postconditions);
      const after = await captureSchema(session, sandbox.identity);
      if (!after.coverage.complete) throw new Error("Rehearsal schema coverage became incomplete.");
      upDigests[item.migration.id] = after.digest;
      const beforeObjects = new Map(before.objects.map(object => [`${object.objectType}:${object.objectPath}`, object.definition]));
      const afterObjects = new Map(after.objects.map(object => [`${object.objectType}:${object.objectPath}`, object.definition]));
      changesByMigration[item.migration.id] = [...new Set([...beforeObjects.keys(), ...afterObjects.keys()])].filter(key => beforeObjects.get(key) !== afterObjects.get(key));
    }
    const final = await captureSchema(session, sandbox.identity);
    const testedDownIds: string[] = [];
    let reversible = true;
    for (const item of [...pending].reverse()) {
      if (!item.down.length) { reversible = false; break; }
      await runChecks(session, item.migration.eligibilityChecks);
      for (const statement of item.down) await session.execute(statement.sql);
      await runChecks(session, item.migration.preconditions);
      const after = await captureSchema(session, sandbox.identity);
      if (!after.coverage.complete || after.digest !== beforeDigests[item.migration.id]) throw new Error("Down rehearsal did not recover the preceding structure.");
      downDigests[item.migration.id] = after.digest;
      testedDownIds.push(item.migration.id);
    }
    if (reversible) {
      for (const item of pending) {
        await runChecks(session, item.migration.preconditions);
        for (const statement of item.up) await session.execute(statement.sql);
        await runChecks(session, item.migration.postconditions);
        if ((await captureSchema(session, sandbox.identity)).digest !== upDigests[item.migration.id]) throw new Error("Up/down/up rehearsal produced different structure.");
      }
    }
    const devCompatible = input.expectedDev && input.expectedDev.identity.engine === baseline.identity.engine && input.expectedDev.identity.version === baseline.identity.version && JSON.stringify(input.expectedDev.identity.settings) === JSON.stringify(baseline.identity.settings);
    const assessment = input.expectedDev ? (!input.expectedDev.coverage.complete || !devCompatible ? "unverified" : final.digest === input.expectedDev.digest ? "explained" : "unexplained") : "unverified";
    return {
      evidenceId: randomUUID(), databaseKey: input.databaseKey, releaseDigest: input.releaseDigest,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      assessment, notes: ["Schema-only rehearsal; production rows are never copied.", ...(reversible ? ["Up/down/up passed for the pending prefix on an empty structural fixture."] : ["A tested backup/restore route is required; a complete down rehearsal was unavailable."]), ...(pending.some(item => item.migration.conditionalDown) ? ["Conditional/destructive down paths additionally require a current verified backup/restore route before Run."] : []), ...(!input.expectedDev ? ["No development comparison was requested; this is rehearsal evidence only."] : [])],
      migrationIds: pending.map(item => item.migration.id), targetId: input.targetId, beforeSchemaDigest: baseline.digest,
      afterSchemaDigest: final.digest, historyDigest: input.historyDigest, upDigests, downDigests, changesByMigration,
      appliedIds: input.appliedIds, testedDownIds: reversible ? testedDownIds : [], baseline, ...(input.history ? { history: input.history } : {}),
    };
  } finally {
    // The service admitted an empty, isolated sandbox. Remove only base tables made in this run.
    if (fixtureStarted) {
      const current = await session.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
      await session.execute("SET SESSION FOREIGN_KEY_CHECKS = 0");
      for (const row of current) {
        const name = String(row.TABLE_NAME);
        if (ownedNames.has(tableKey(name))) await session.execute(`DROP TABLE \`${name.replaceAll("`", "``")}\``);
      }
      await session.execute("SET SESSION FOREIGN_KEY_CHECKS = 1");
    }
  }
}
