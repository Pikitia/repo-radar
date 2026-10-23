// @vitest-environment node
import { describe, expect, it } from "vitest";
import { captureSchema, compareSchemas } from "../../electron/databases/schema.js";
import type { SqlSession } from "../../electron/databases/connections.js";
import type { DatabaseIdentity } from "../../src/types/database.js";

type Row = Record<string, unknown>;
type Metadata = Partial<Record<"COLUMNS" | "STATISTICS" | "KEY_COLUMN_USAGE" | "TRIGGERS", Row[]>>;
const identity: DatabaseIdentity = { serverId: "dev-server", database: "audit", engine: "mariadb", version: "10.6.25", settings: { sqlMode: "", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_unicode_520_ci" }, fingerprint: "dev" };
const column: Row = { CHARACTER_SET_NAME: "utf8mb4", COLLATION_NAME: "utf8mb4_unicode_520_ci", COLUMN_COMMENT: "", COLUMN_DEFAULT: null, COLUMN_NAME: "change_set_id", COLUMN_TYPE: "varchar(255)", EXTRA: "", GENERATION_EXPRESSION: "", IS_NULLABLE: "NO", ORDINAL_POSITION: 1, TABLE_NAME: "audit_change_set_chunks" };
function session(rows: Metadata, alternating?: Metadata): SqlSession {
  let capture = 0;
  return {
    async query(sql) {
      if (sql === "SHOW GRANTS FOR CURRENT_USER") { capture++; return [{ grants: "GRANT ALL PRIVILEGES ON *.* TO 'fixture'@'localhost'" }]; }
      const selected = alternating && capture % 2 === 0 ? alternating : rows;
      const name = /information_schema\.(\w+)/.exec(sql)?.[1];
      return (selected[name as keyof Metadata] ?? []).map(row => ({ ...row }));
    },
    async execute() { throw new Error("Metadata capture must not execute SQL writes"); },
    async close() { /* no real connection */ }
  };
}
async function comparison(dev: Metadata, production: Metadata) {
  const left = await captureSchema(session(dev), identity);
  const right = await captureSchema(session(production), { ...identity, serverId: "production-server", fingerprint: "production" });
  return { left, right, result: compareSchemas(left, right) };
}

describe("schema metadata representation normalization", () => {
  it("projects storage engines from captured table metadata even for matching tables without changing schema bytes", async () => {
    const left = await captureSchema(session({}), identity);
    left.objects = [
      { objectType: "table", objectPath: "items", definition: JSON.stringify({ TABLE_NAME: "items", ENGINE: "InnoDB" }) },
      { objectType: "table", objectPath: "dev_only", definition: JSON.stringify({ TABLE_NAME: "dev_only", ENGINE: "InnoDB" }) },
      { objectType: "table", objectPath: "items/definition", definition: "CREATE TABLE `items` (`id` int) ENGINE=InnoDB" },
      { objectType: "table", objectPath: "unknown", definition: JSON.stringify({ TABLE_NAME: "unknown", ENGINE: null }) },
      { objectType: "table", objectPath: "mismatch", definition: JSON.stringify({ TABLE_NAME: "items", ENGINE: "NDB" }) }
    ];
    const right = { ...left, identity: { ...identity, fingerprint: "production" }, objects: [left.objects[0], { objectType: "table" as const, objectPath: "prod_only", definition: JSON.stringify({ TABLE_NAME: "prod_only", ENGINE: "NDB" }) }] };
    const before = JSON.stringify([left, right]);
    const result = compareSchemas(left, right);
    expect(result.tableStorageEngines).toEqual([
      { tableName: "dev_only", development: "InnoDB", production: null },
      { tableName: "items", development: "InnoDB", production: "InnoDB" },
      { tableName: "prod_only", development: null, production: "NDB" }
    ]);
    expect(result.differences.some(item => item.objectPath === "items")).toBe(false);
    expect(JSON.stringify([left, right])).toBe(before);
    expect(result.devSchemaDigest).toBe(left.digest);
    expect(result.productionSchemaDigest).toBe(right.digest);
  });

  it("treats the reported MariaDB column metadata as the same schema and digest", async () => {
    const { left, right, result } = await comparison({ COLUMNS: [column] }, { COLUMNS: [{ ...column, GENERATION_EXPRESSION: null, ORDINAL_POSITION: "1" }] });
    expect(result.differences).toEqual([]);
    expect(result.assessment).toBe("explained");
    expect(left.digest).toBe(right.digest);
  });

  it("does not report schema mutation when numeric metadata representation changes between capture passes", async () => {
    const snapshot = await captureSchema(session({ COLUMNS: [column] }, { COLUMNS: [{ ...column, GENERATION_EXPRESSION: null, ORDINAL_POSITION: "1" }] }), identity);
    expect(snapshot.coverage).toMatchObject({ complete: true, limitations: [] });
  });

  it.each([
    ["STATISTICS", { TABLE_NAME: "items", INDEX_NAME: "idx_owner", NON_UNIQUE: 1, SEQ_IN_INDEX: 2, SUB_PART: 12, COLUMN_NAME: "owner" }, { TABLE_NAME: "items", INDEX_NAME: "idx_owner", NON_UNIQUE: "1", SEQ_IN_INDEX: "2", SUB_PART: "12", COLUMN_NAME: "owner" }],
    ["KEY_COLUMN_USAGE", { TABLE_NAME: "items", CONSTRAINT_NAME: "fk_owner", COLUMN_NAME: "owner", ORDINAL_POSITION: 1 }, { TABLE_NAME: "items", CONSTRAINT_NAME: "fk_owner", COLUMN_NAME: "owner", ORDINAL_POSITION: "1" }],
    ["TRIGGERS", { TRIGGER_NAME: "items_changed", EVENT_OBJECT_TABLE: "items", ACTION_ORDER: 1, ACTION_STATEMENT: "SET @changed = 1" }, { TRIGGER_NAME: "items_changed", EVENT_OBJECT_TABLE: "items", ACTION_ORDER: "1", ACTION_STATEMENT: "SET @changed = 1" }]
  ] as const)("normalizes known integer metadata in %s", async (kind, dev, production) => {
    const { left, right, result } = await comparison({ [kind]: [dev] }, { [kind]: [production] });
    expect(result.differences).toEqual([]);
    expect(left.digest).toBe(right.digest);
  });

  it("preserves exact decimal integer strings beyond the safe number range", async () => {
    const row = { TABLE_NAME: "items", INDEX_NAME: "idx", NON_UNIQUE: "0", SEQ_IN_INDEX: "0002", SUB_PART: "009007199254740993" };
    const { left, right } = await comparison({ STATISTICS: [row] }, { STATISTICS: [{ ...row, SEQ_IN_INDEX: 2, SUB_PART: "9007199254740993" }] });
    expect(left.digest).toBe(right.digest);
    expect(left.objects[0].definition).toContain('"SUB_PART":"9007199254740993"');
    const changed = await comparison({ STATISTICS: [row] }, { STATISTICS: [{ ...row, SUB_PART: "9007199254740992" }] });
    expect(changed.result.differences).toHaveLength(1);
  });

  it.each([
    ["COLUMN_DEFAULT", null, ""],
    ["COLUMN_DEFAULT", 1, "1"],
    ["COLUMN_DEFAULT", "0", "00"],
    ["COLUMN_DEFAULT", "CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP()"],
    ["COLUMN_TYPE", "varchar(255)", "varchar(256)"],
    ["COLLATION_NAME", "utf8mb4_unicode_520_ci", "utf8mb4_general_ci"],
    ["ORDINAL_POSITION", 1, "2"],
    ["GENERATION_EXPRESSION", "`cost` * 2", "`cost` * 3"]
  ])("preserves meaningful %s differences (%s versus %s)", async (field, dev, production) => {
    const { result } = await comparison({ COLUMNS: [{ ...column, [field]: dev }] }, { COLUMNS: [{ ...column, [field]: production }] });
    expect(result.differences).toHaveLength(1);
  });

  it.each(["STORED GENERATED", "VIRTUAL GENERATED", "stored generated invisible"])("retains unavailable expression differences for %s columns", async extra => {
    const { result } = await comparison({ COLUMNS: [{ ...column, EXTRA: extra, GENERATION_EXPRESSION: "" }] }, { COLUMNS: [{ ...column, EXTRA: extra, GENERATION_EXPRESSION: null }] });
    expect(result.differences).toHaveLength(1);
  });

  it("allows DEFAULT_GENERATED on a nongenerated column without treating it as a generated expression", async () => {
    const { result } = await comparison({ COLUMNS: [{ ...column, EXTRA: "DEFAULT_GENERATED" }] }, { COLUMNS: [{ ...column, EXTRA: "DEFAULT_GENERATED", GENERATION_EXPRESSION: null }] });
    expect(result.differences).toEqual([]);
  });

  it.each(["GENERATION_EXPRESSION", "ORDINAL_POSITION", "EXTRA"])("preserves absent %s metadata", async field => {
    const missing = { ...column };
    delete missing[field];
    const { result } = await comparison({ COLUMNS: [missing] }, { COLUMNS: [column] });
    expect(result.differences).toHaveLength(1);
  });

  it("does not infer nongenerated status without EXTRA metadata", async () => {
    const noExtra = { ...column }; delete noExtra.EXTRA;
    const { result } = await comparison({ COLUMNS: [{ ...noExtra, GENERATION_EXPRESSION: "" }] }, { COLUMNS: [{ ...noExtra, GENERATION_EXPRESSION: null }] });
    expect(result.differences).toHaveLength(1);
  });

  it("retains buffer metadata and integer null distinctions", async () => {
    const row = { TABLE_NAME: "items", INDEX_NAME: "idx", NON_UNIQUE: 0, SEQ_IN_INDEX: 1, SUB_PART: null, INDEX_COMMENT: Buffer.from([0, 255]) };
    const { left, result } = await comparison({ STATISTICS: [row] }, { STATISTICS: [{ ...row, SUB_PART: 0 }] });
    expect(left.objects[0].definition).toContain('"INDEX_COMMENT":"00ff"');
    expect(result.differences).toHaveLength(1);
  });

  it.each([
    ["STATISTICS", "NON_UNIQUE", { TABLE_NAME: "items", INDEX_NAME: "idx", SEQ_IN_INDEX: 1 }],
    ["STATISTICS", "SEQ_IN_INDEX", { TABLE_NAME: "items", INDEX_NAME: "idx", NON_UNIQUE: 0 }],
    ["STATISTICS", "SUB_PART", { TABLE_NAME: "items", INDEX_NAME: "idx", SEQ_IN_INDEX: 1 }],
    ["KEY_COLUMN_USAGE", "ORDINAL_POSITION", { TABLE_NAME: "items", CONSTRAINT_NAME: "fk_owner" }],
    ["TRIGGERS", "ACTION_ORDER", { TRIGGER_NAME: "items_changed", EVENT_OBJECT_TABLE: "items", ACTION_STATEMENT: "SET @changed = 1" }]
  ] as const)("preserves actual %s.%s changes", async (kind, field, row) => {
    const { result, left, right } = await comparison({ [kind]: [{ ...row, [field]: 1 }] }, { [kind]: [{ ...row, [field]: "2" }] });
    expect(result.differences.length).toBeGreaterThan(0);
    expect(left.digest).not.toBe(right.digest);
  });

  it.each(["1.0", "1e0", " 1", 9007199254740992])("does not coerce unsupported integer representation %s", async value => {
    const { result } = await comparison({ COLUMNS: [{ ...column, ORDINAL_POSITION: value }] }, { COLUMNS: [{ ...column, ORDINAL_POSITION: typeof value === "number" ? "9007199254740992" : 1 }] });
    expect(result.differences).toHaveLength(1);
  });

  it("keeps engine/version and coverage warnings even when normalized objects match", async () => {
    const left = await captureSchema(session({ COLUMNS: [column] }), identity);
    const right = await captureSchema(session({ COLUMNS: [{ ...column, GENERATION_EXPRESSION: null, ORDINAL_POSITION: "1" }] }), { ...identity, engine: "mysql", version: "8.0.42", fingerprint: "production" });
    right.coverage = { ...right.coverage, complete: false, limitations: ["Fixture metadata visibility unavailable"] };
    const result = compareSchemas(left, right);
    expect(result.differences).toEqual([]);
    expect(result.engines).toEqual({ development: { engine: identity.engine, version: identity.version }, production: { engine: "mysql", version: "8.0.42" } });
    expect(JSON.stringify(result.engines)).not.toMatch(/serverId|fingerprint|credentials|password/);
    expect(result.assessment).toBe("unverified");
    expect(result.coverage.limitations).toEqual(expect.arrayContaining(["Fixture metadata visibility unavailable", "Different database engines require an explicitly verified compatibility plan", "Database versions differ; equivalent metadata and SQL behavior have not been verified"]));
  });
});
