import type { DatabaseIdentity, SchemaComparison, SchemaObject, SchemaSnapshot } from "../../src/types/database.js";
import { databaseDigest, type SqlSession } from "./connections.js";

function quote(value: string): string { return `\`${value.replaceAll("`", "``")}\``; }
function stable(row: Record<string, unknown>): string { return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString("hex") : value]))); }
function normalizeMetadata(row: Record<string, unknown>, integerFields: readonly string[], column = false): Record<string, unknown> {
  const normalized = { ...row };
  // Drivers/server versions return these documented integer fields as numbers or
  // decimal strings. Keep a decimal string without converting large values to Number.
  // Defaults, expressions and arbitrary metadata must retain their original types.
  for (const field of integerFields) {
    const value = row[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) normalized[field] = String(value);
    else if (typeof value === "string" && /^\d+$/.test(value)) normalized[field] = value.replace(/^0+(?=\d)/, "");
  }
  // Both NULL and empty text mean no expression for an ordinary column. Missing
  // EXTRA/expression metadata and generated columns remain distinguishable.
  if (column && typeof row.EXTRA === "string" && !/\b(?:GENERATED|VIRTUAL|STORED)\b/i.test(row.EXTRA) && (row.GENERATION_EXPRESSION === null || row.GENERATION_EXPRESSION === "")) normalized.GENERATION_EXPRESSION = null;
  return normalized;
}
function normalizeDefinition(value: string, database: string, table = false): string {
  // Never rewrite quoted SQL literals or comments: they may contain executable dynamic SQL.
  const literals = /('(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*)/g;
  return value.split(literals).map((part, index) => index % 2 ? part : (table ? part.replace(/\bAUTO_INCREMENT=\d+\b/g, "") : part).replaceAll(`${quote(database)}.`, "")).join("").trim();
}
const objectKey = (object: SchemaObject): string => `${object.objectType}:${object.objectPath}`;
const excluded = (name: string): boolean => name.toLowerCase().startsWith("db_radar_");

async function metadata(session: SqlSession, identity: DatabaseIdentity): Promise<{ objects: SchemaObject[]; limitations: string[] }> {
  const objects: SchemaObject[] = [];
  const limitations: string[] = [];
  const schema = identity.database;
  const add = (objectType: SchemaObject["objectType"], objectPath: string, definition: string): void => { objects.push({ objectType, objectPath, definition }); };
  async function rows(sql: string, params: unknown[] = [schema]): Promise<Record<string, unknown>[]> {
    try { return await session.query(sql, params); } catch { limitations.push(`Metadata unavailable: ${sql.match(/FROM\s+([\w.]+)/i)?.[1] ?? "object definition"}`); return []; }
  }
  const grants = await rows("SHOW GRANTS FOR CURRENT_USER", []);
  const text = grants.flatMap(row => Object.values(row).map(String)).join("\n");
  const escapedSchema = quote(schema);
  const applicable = text.split("\n").filter(grant => grant.includes(" ON *.* ") || grant.includes(` ON ${escapedSchema}.* `));
  const privileges = applicable.join(" ");
  const all = applicable.some(grant => /GRANT ALL PRIVILEGES ON/.test(grant));
  if (!all && !["SELECT", "SHOW VIEW", "TRIGGER", "EXECUTE"].every(permission => new RegExp(`\\b${permission}\\b`).test(privileges))) limitations.push("Schema-wide SELECT, SHOW VIEW, TRIGGER and EXECUTE visibility could not be verified; hidden objects may exist");
  const globalMetadata = text.split("\n").some(grant => grant.includes(" ON *.* ") && /GRANT (?:ALL PRIVILEGES|.*\bSELECT\b|.*\bSHOW_ROUTINE\b)/.test(grant));
  const mariaProc = identity.engine === "mariadb" && text.split("\n").some(grant => /\bSELECT\b/.test(grant) && / ON `mysql`\.`proc` /.test(grant));
  if (!globalMetadata && !mariaProc) limitations.push("Complete routine visibility could not be verified with these credentials");
  if (!all && !/\bEVENT\b/.test(privileges)) limitations.push("Complete scheduled-event visibility could not be verified");
  const scheduled = await rows("SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME");
  if (scheduled.length) limitations.push("Scheduled events exist and are outside this adapter's supported structural coverage");
  const tables = await rows("SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, ROW_FORMAT, CREATE_OPTIONS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME");
  for (const table of tables) {
    const name = String(table.TABLE_NAME);
    if (excluded(name)) continue;
    const type = table.TABLE_TYPE === "VIEW" ? "view" : "table";
    if (type === "table") add("table", name, stable(Object.fromEntries(Object.entries(table).filter(([key]) => key !== "TABLE_TYPE"))));
    const definitions = await rows(`SHOW CREATE ${type === "view" ? "VIEW" : "TABLE"} ${quote(schema)}.${quote(name)}`, []);
    const definition = definitions[0] && Object.entries(definitions[0]).find(([key]) => /^Create (Table|View)$/i.test(key))?.[1];
    if (typeof definition !== "string" || !definition) limitations.push(`Definition unavailable: ${type} ${name}`);
    else add(type, type === "table" ? `${name}/definition` : name, normalizeDefinition(definition, schema, type === "table"));
  }
  for (const row of await rows("SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, GENERATION_EXPRESSION, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION")) {
    const column = normalizeMetadata(row, ["ORDINAL_POSITION"], true);
    if (!excluded(String(column.TABLE_NAME))) add("column", `${String(column.TABLE_NAME)}.${String(column.COLUMN_NAME)}`, stable(column));
  }
  for (const row of await rows("SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART, NULLABLE, INDEX_TYPE, COMMENT, INDEX_COMMENT FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX")) {
    const index = normalizeMetadata(row, ["NON_UNIQUE", "SEQ_IN_INDEX", "SUB_PART"]);
    if (!excluded(String(index.TABLE_NAME))) add("index", `${String(index.TABLE_NAME)}.${String(index.INDEX_NAME)}.${String(index.SEQ_IN_INDEX)}`, stable(index));
  }
  for (const row of await rows("SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION")) {
    const fk = normalizeMetadata(row, ["ORDINAL_POSITION"]);
    if (!excluded(String(fk.TABLE_NAME))) add("foreign-key", `${String(fk.TABLE_NAME)}.${String(fk.CONSTRAINT_NAME)}.${String(fk.ORDINAL_POSITION)}`, stable(fk));
  }
  for (const routine of await rows("SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_DEFINITION, SQL_MODE, CHARACTER_SET_CLIENT, COLLATION_CONNECTION, DATABASE_COLLATION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME, ROUTINE_TYPE")) {
    const name = String(routine.ROUTINE_NAME);
    if (excluded(name)) continue;
    if (!routine.ROUTINE_DEFINITION) limitations.push(`Definition unavailable: routine ${name}`);
    const kind = routine.ROUTINE_TYPE === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
    const [definition] = await rows(`SHOW CREATE ${kind} ${quote(schema)}.${quote(name)}`, []);
    const sql = definition && Object.entries(definition).find(([key]) => /^Create (Function|Procedure)$/i.test(key))?.[1];
    if (typeof sql !== "string" || !sql) limitations.push(`Complete definition unavailable: routine ${name}`);
    else add("routine", `${kind.toLowerCase()}.${name}`, stable({ ...routine, create: normalizeDefinition(sql, schema) }));
  }
  for (const trigger of await rows("SELECT TRIGGER_NAME, DEFINER, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_ORDER, ACTION_CONDITION, ACTION_STATEMENT, ACTION_ORIENTATION, ACTION_TIMING, SQL_MODE, CHARACTER_SET_CLIENT, COLLATION_CONNECTION, DATABASE_COLLATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME")) {
    if (excluded(String(trigger.TRIGGER_NAME)) || excluded(String(trigger.EVENT_OBJECT_TABLE))) continue;
    if (!trigger.ACTION_STATEMENT) limitations.push(`Definition unavailable: trigger ${String(trigger.TRIGGER_NAME)}`);
    add("trigger", String(trigger.TRIGGER_NAME), stable(normalizeMetadata(trigger, ["ACTION_ORDER"])));
  }
  objects.sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  return { objects, limitations: [...new Set(limitations)] };
}

export async function captureSchema(session: SqlSession, identity: DatabaseIdentity): Promise<SchemaSnapshot> {
  const first = await metadata(session, identity);
  const second = await metadata(session, identity);
  const limitations = [...new Set([...first.limitations, ...second.limitations])];
  if (databaseDigest(first.objects) !== databaseDigest(second.objects)) limitations.push("Schema changed during capture; refresh when schema changes have stopped");
  const version = identity.version.match(/^(\d+)\.(\d+)/);
  const supported = version && (identity.engine === "mysql" ? Number(version[1]) === 8 : (Number(version[1]) === 10 && Number(version[2]) >= 6) || Number(version[1]) === 11);
  if (!supported) limitations.push(`Untested metadata version: ${identity.engine} ${identity.version}`);
  return { identity, capturedAt: new Date().toISOString(), digest: databaseDigest(first.objects), objects: first.objects, coverage: { complete: limitations.length === 0, limitations, excludedObjectPrefixes: ["db_radar_"] } };
}

function tableEngines(snapshot: SchemaSnapshot): Map<string, string> {
  const engines = new Map<string, string>();
  for (const object of snapshot.objects) {
    if (object.objectType !== "table") continue;
    try {
      const row: unknown = JSON.parse(object.definition);
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const metadata = row as Record<string, unknown>;
      if (metadata.TABLE_NAME === object.objectPath && typeof metadata.ENGINE === "string" && metadata.ENGINE.trim()) engines.set(object.objectPath, metadata.ENGINE);
    } catch { /* Raw CREATE TABLE definitions are not metadata records. */ }
  }
  return engines;
}

export function compareSchemas(dev: SchemaSnapshot, production: SchemaSnapshot): SchemaComparison {
  const limitations = [...dev.coverage.limitations, ...production.coverage.limitations];
  if (dev.identity.fingerprint === production.identity.fingerprint) limitations.push("Development and production resolve to the same database identity");
  if (dev.identity.engine !== production.identity.engine) limitations.push("Different database engines require an explicitly verified compatibility plan");
  if (JSON.stringify(dev.identity.settings) !== JSON.stringify(production.identity.settings)) limitations.push("Database settings differ; equivalent SQL behavior has not been verified");
  if (dev.identity.version !== production.identity.version) limitations.push("Database versions differ; equivalent metadata and SQL behavior have not been verified");
  const complete = dev.coverage.complete && production.coverage.complete && limitations.length === 0;
  const left = new Map(dev.objects.map(object => [objectKey(object), object]));
  const right = new Map(production.objects.map(object => [objectKey(object), object]));
  const differences = [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(key => {
    const a = left.get(key); const b = right.get(key);
    if (a?.definition === b?.definition) return [];
    return [{ objectType: (a ?? b)!.objectType, objectPath: (a ?? b)!.objectPath, devDefinition: a?.definition ?? null, productionDefinition: b?.definition ?? null, assessment: complete ? "unexplained" as const : "unverified" as const, migrationIds: [], reason: "Pending migration replay evidence has not verified this difference" }];
  });
  const devEngines = tableEngines(dev), productionEngines = tableEngines(production);
  const tableStorageEngines = [...new Set([...devEngines.keys(), ...productionEngines.keys()])].sort().map(tableName => ({ tableName, development: devEngines.get(tableName) ?? null, production: productionEngines.get(tableName) ?? null }));
  return { assessment: !complete ? "unverified" : differences.length ? "unexplained" : "explained", capturedAt: new Date().toISOString(), devSchemaDigest: dev.digest, productionSchemaDigest: production.digest, engines: { development: { engine: dev.identity.engine, version: dev.identity.version }, production: { engine: production.identity.engine, version: production.identity.version } }, tableStorageEngines, differences, coverage: { complete, limitations: [...new Set(limitations)], excludedObjectPrefixes: ["db_radar_"] } };
}
