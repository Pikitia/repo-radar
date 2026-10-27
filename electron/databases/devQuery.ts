import { z } from "zod";
import type { SqlSession } from "./connections.js";
import type { DevDataPolicy, McpDataPolicy } from "../../src/types/databaseApi.js";
import { permittedDiagnosticName } from "./devConfig.js";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
export const devQuerySchema = z.object({
  databaseKey: z.string().min(1).max(128), table: name, columns: z.array(name).min(1).max(20),
  filters: z.array(z.object({ column: name, op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "like", "is-null", "not-null"]), value: scalar.optional() }).strict()).max(10).optional(),
  order: z.array(z.object({ column: name, direction: z.enum(["asc", "desc"]) }).strict()).max(5).optional(),
  page: z.object({ limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(10000).default(0) }).strict().optional(),
  aggregate: z.object({ function: z.enum(["count", "min", "max", "sum", "avg"]), column: name.optional() }).strict().optional()
}).strict();
export type DevQueryRequest = z.infer<typeof devQuerySchema>;
export const mcpQuerySchema = devQuerySchema.omit({ databaseKey: true }).extend({ profileId: z.string().min(1).max(100) });
const quote = (value: string) => `\`${value}\``;

/** Legacy setup is single-schema; explicit MCP targets may share an account with read-only grants. */
export async function verifyReadOnlyDiagnosticGrants(session: SqlSession, database: string, allowOtherReadOnlySchemas = false): Promise<void> {
  const rows = await session.query("SHOW GRANTS FOR CURRENT_USER");
  if (!rows.length || rows.length > 100) throw new Error("Read-only diagnostic grants could not be verified.");
  let select = false;
  for (const row of rows) for (const raw of Object.values(row)) {
    if (typeof raw !== "string" || raw.includes("WITH GRANT OPTION")) throw new Error("Diagnostic credentials must have independently verified read-only grants.");
    const match = /^GRANT (.+?) ON (.+?) TO /i.exec(raw);
    if (!match) throw new Error("Role/proxy grants are not supported for diagnostic access.");
    const privileges = match[1].split(",").map(value => value.trim().toUpperCase());
    if (privileges.every(value => value === "USAGE") && match[2] === "*.*") continue;
    if (!privileges.every(value => value === "SELECT" || value === "SHOW VIEW") || !allowOtherReadOnlySchemas && !match[2].startsWith(`${quote(database)}.`)) throw new Error("Diagnostic credentials have privileges beyond the permitted read-only scope.");
    if (privileges.includes("SELECT") && (match[2] === "*.*" || match[2].startsWith(`${quote(database)}.`))) select = true;
  }
  if (!select) throw new Error("Diagnostic SELECT privilege is required.");
}

export function compileDevQuery(input: unknown, policy: DevDataPolicy): { request: DevQueryRequest; sql: string; params: unknown[]; columns: string[] } {
  const request = devQuerySchema.parse(input);
  const allowed = Object.hasOwn(policy.tables, request.table) ? policy.tables[request.table] : undefined;
  if (!permittedDiagnosticName(request.table) || !allowed) throw new Error("This base table is not permitted for diagnostics.");
  const used = [...request.columns, ...(request.filters ?? []).map(item => item.column), ...(request.order ?? []).map(item => item.column), ...(request.aggregate?.column ? [request.aggregate.column] : [])];
  if (new Set(request.columns).size !== request.columns.length || used.some(column => !allowed.includes(column) || !permittedDiagnosticName(column))) throw new Error("A requested column is not permitted for diagnostics.");
  const params: unknown[] = [], clauses: string[] = [];
  const operators = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=", like: "LIKE" };
  for (const filter of request.filters ?? []) {
    if (filter.op === "is-null" || filter.op === "not-null") {
      if (Object.hasOwn(filter, "value")) throw new Error("Null predicates do not accept values.");
      clauses.push(`${quote(filter.column)} IS ${filter.op === "not-null" ? "NOT " : ""}NULL`);
    } else {
      if (!Object.hasOwn(filter, "value") || filter.value === null) throw new Error("Comparison predicates require a typed non-null value.");
      clauses.push(`${quote(filter.column)} ${operators[filter.op]} ?`); params.push(filter.value);
    }
  }
  let projection = request.columns.map(column => `LEFT(CAST(${quote(column)} AS CHAR), 1024) AS ${quote(column)}`).join(", ");
  if (request.aggregate) {
    if (!request.aggregate.column && request.aggregate.function !== "count") throw new Error("This aggregate requires a column.");
    if (request.order?.length || request.page?.offset) throw new Error("Aggregate requests do not accept ordering or offsets.");
    projection = `LEFT(CAST(${request.aggregate.function.toUpperCase()}(${request.aggregate.column ? quote(request.aggregate.column) : "*"}) AS CHAR), 1024) AS aggregate_value`;
  }
  let sql = `SELECT ${projection} FROM ${quote(request.table)}`;
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  if (request.order?.length) sql += ` ORDER BY ${request.order.map(item => `${quote(item.column)} ${item.direction.toUpperCase()}`).join(", ")}`;
  sql += " LIMIT ? OFFSET ?"; params.push(request.aggregate ? 1 : (request.page?.limit ?? 50) + 1, request.page?.offset ?? 0);
  return { request, sql, params, columns: [...new Set(used)] };
}

/** Metadata is checked immediately before querying; views, generated expressions and remote engines fail closed. */
export async function queryDevData(session: SqlSession, database: string, input: unknown, policy: DevDataPolicy) {
  const compiled = compileDevQuery(input, policy);
  // The broker has already started a read-only transaction. Opening this object
  // without selecting any values pins its metadata until transaction end. Then
  // revalidate its actual type/columns under that lock before selecting data.
  await session.query(`SELECT 1 FROM ${quote(compiled.request.table)} LIMIT 0`);
  const [table] = await session.query("SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [database, compiled.request.table]);
  if (!table || table.TABLE_TYPE !== "BASE TABLE" || String(table.ENGINE).toLowerCase() !== "innodb") throw new Error("Diagnostics support only local InnoDB base tables.");
  const columns = await session.query("SELECT COLUMN_NAME, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [database, compiled.request.table]);
  for (const used of compiled.columns) {
    const column = columns.find(column => column.COLUMN_NAME === used);
    if (!column || column.GENERATION_EXPRESSION || /GENERATED/i.test(String(column.EXTRA))) throw new Error("Generated or unavailable columns cannot be queried by diagnostics.");
  }
  const rows = await session.query(compiled.sql, compiled.params);
  const limit = compiled.request.aggregate ? 1 : compiled.request.page?.limit ?? 50;
  const result: Record<string, unknown>[] = []; let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const projected = Object.fromEntries((compiled.request.aggregate ? ["aggregate_value"] : compiled.request.columns).map(column => [column, row[column] ?? null]));
    const size = Buffer.byteLength(JSON.stringify(projected));
    if (bytes + size > 256000) break;
    bytes += size; result.push(projected);
  }
  return { rows: result, truncated: rows.length > result.length, cellLimitCharacters: 1024, byteLimit: 256000, rowLimit: limit, bytes, timedOut: false };
}

/** All-table access still excludes sensitive names, generated values, views and remote engines. */
export async function queryMcpData(session: SqlSession, database: string, input: unknown, policy: McpDataPolicy) {
  if (!("mode" in policy)) return queryDevData(session, database, input, policy);
  const request = devQuerySchema.parse(input);
  if (!permittedDiagnosticName(request.table)) throw new Error("This base table is not permitted for MCP reads.");
  const columns = await session.query("SELECT COLUMN_NAME, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [database, request.table]);
  const allowed = columns.filter(column => typeof column.COLUMN_NAME === "string" && permittedDiagnosticName(column.COLUMN_NAME) && !column.GENERATION_EXPRESSION && !/GENERATED/i.test(String(column.EXTRA))).map(column => String(column.COLUMN_NAME));
  return queryDevData(session, database, request, { tables: { [request.table]: allowed } });
}
