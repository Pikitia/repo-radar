import { describe, expect, it } from "vitest";
import type { SchemaDifference } from "../../src/types/database.js";
import { summarizeSchemaDifference } from "../../src/components/schemaDifferenceSummary.js";

function difference(dev: unknown, production: unknown, objectType: SchemaDifference["objectType"] = "column"): SchemaDifference {
  return { objectType, objectPath: "orders.owner", devDefinition: dev === null ? null : JSON.stringify(dev), productionDefinition: production === null ? null : JSON.stringify(production), assessment: "unverified", reason: "not replayed", migrationIds: [] };
}
const column = { TABLE_NAME: "orders", COLUMN_NAME: "owner", COLUMN_TYPE: "varchar(255)", IS_NULLABLE: "NO", COLUMN_DEFAULT: null };

describe("readable schema differences", () => {
  it("shows only changed fields in Production to Development order", () => {
    expect(summarizeSchemaDifference(difference({ ...column, COLUMN_TYPE: "varchar(500)", IS_NULLABLE: "YES" }, column))).toEqual({ name: "owner", description: 'Type: "varchar(255)" → "varchar(500)"; Nullable: "NO" → "YES"' });
  });
  it.each([[null, ""], [null, "NULL"], [1, "1"], ["0", "00"], ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP()"]])("preserves distinct defaults %s and %s", (production, dev) => {
    expect(summarizeSchemaDifference(difference({ ...column, COLUMN_DEFAULT: dev }, { ...column, COLUMN_DEFAULT: production })).description).toBe(`Default: ${JSON.stringify(production)} → ${JSON.stringify(dev)}`);
  });
  it("distinguishes missing and explicit null metadata", () => {
    const withoutDefault: Record<string, unknown> = { ...column };
    delete withoutDefault.COLUMN_DEFAULT;
    expect(summarizeSchemaDifference(difference(column, withoutDefault)).description).toBe("Default: not reported → null");
  });
  it.each(["COLLATION_NAME", "CHARACTER_SET_NAME", "EXTRA", "GENERATION_EXPRESSION", "ORDINAL_POSITION", "COLUMN_COMMENT"])("includes changed %s", field => {
    expect(summarizeSchemaDifference(difference({ ...column, [field]: "dev" }, { ...column, [field]: "prod" })).description).toContain('"prod" → "dev"');
  });
  it.each([[column, null, "Only in development"], [null, column, "Only in production"]])("describes one-sided presence without inventing change history", (dev, production, description) => {
    expect(summarizeSchemaDifference(difference(dev, production), true)).toEqual({ name: "owner", description });
  });
  it.each([
    [column, null, "Present in development; not reported in production"],
    [null, column, "Present in production; not reported in development"]
  ])("does not infer absence when a column may be hidden by permissions", (dev, production, description) => {
    const item = difference(dev, production);
    expect(summarizeSchemaDifference(item)).toEqual({ name: "owner", description });
    expect(summarizeSchemaDifference(item, false)).toEqual({ name: "owner", description });
  });
  it.each([
    [{ ROUTINE_NAME: "hidden.proc", ROUTINE_DEFINITION: "SELECT 1" }, null, "Present in development; not reported in production", "Only in development"],
    [null, { ROUTINE_NAME: "hidden.proc", ROUTINE_DEFINITION: "SELECT 1" }, "Present in production; not reported in development", "Only in production"]
  ])("describes unavailable routine visibility conservatively", (dev, production, partial, complete) => {
    const item = difference(dev, production, "routine");
    expect(summarizeSchemaDifference(item)).toEqual({ name: "hidden.proc", description: partial });
    expect(summarizeSchemaDifference(item, true)).toEqual({ name: "hidden.proc", description: complete });
  });
  it("uses exact dotted identifiers from metadata", () => {
    const row = { ...column, TABLE_NAME: "orders.with.dot", COLUMN_NAME: "owner.with.dot" };
    expect(summarizeSchemaDifference(difference({ ...row, COLUMN_DEFAULT: "1" }, row)).name).toBe("owner.with.dot");
  });
  it("does not guess a name from ambiguous or conflicting metadata", () => {
    const item = difference({ ...column, COLUMN_NAME: "other" }, column);
    expect(summarizeSchemaDifference(item).name).toBe("orders.owner");
    expect(summarizeSchemaDifference(difference({ COLUMN_TYPE: "int" }, { COLUMN_TYPE: "bigint" })).name).toBe("orders.owner");
    expect(summarizeSchemaDifference(difference({ ...column, TABLE_NAME: "other" }, column)).name).toBe("orders.owner");
  });
  it("describes table properties", () => {
    const row = { TABLE_NAME: "orders", ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_general_ci", ROW_FORMAT: "Dynamic", CREATE_OPTIONS: "", TABLE_COMMENT: "" };
    const result = summarizeSchemaDifference(difference({ ...row, ENGINE: "MyISAM", TABLE_COMMENT: "Archived" }, row, "table"));
    expect(result).toEqual({ name: "orders", description: 'Engine: "InnoDB" → "MyISAM"; Comment: "" → "Archived"' });
  });
  it.each([
    ["index", { TABLE_NAME: "orders", INDEX_NAME: "idx.owner", NON_UNIQUE: 1 }, { TABLE_NAME: "orders", INDEX_NAME: "idx.owner", NON_UNIQUE: 0 }, "idx.owner", "Non-unique: 0 → 1"],
    ["foreign-key", { TABLE_NAME: "orders", CONSTRAINT_NAME: "fk.owner", DELETE_RULE: "CASCADE" }, { TABLE_NAME: "orders", CONSTRAINT_NAME: "fk.owner", DELETE_RULE: "RESTRICT" }, "fk.owner", 'On delete: "RESTRICT" → "CASCADE"'],
    ["trigger", { TRIGGER_NAME: "owner.changed", EVENT_OBJECT_TABLE: "orders", ACTION_TIMING: "AFTER" }, { TRIGGER_NAME: "owner.changed", EVENT_OBJECT_TABLE: "orders", ACTION_TIMING: "BEFORE" }, "owner.changed", 'Timing: "BEFORE" → "AFTER"']
  ] as const)("describes %s metadata using exact names and readable labels", (kind, dev, production, name, description) => {
    expect(summarizeSchemaDifference(difference(dev, production, kind))).toEqual({ name, description });
  });
  it("bounds long values without suppressing changed fields", () => {
    const common = "x".repeat(1000);
    const result = summarizeSchemaDifference(difference({ ...column, COLUMN_DEFAULT: `${common}a`, COLUMN_COMMENT: "dev" }, { ...column, COLUMN_DEFAULT: `${common}b`, COLUMN_COMMENT: "prod" }));
    expect(result.description.length).toBeLessThan(300);
    expect(result.description).toContain("values differ; see details");
    expect(result.description).toContain('Comment: "prod" → "dev"');
  });
  it("does not parse SQL table definitions", () => {
    const item = difference({}, {}, "table");
    item.productionDefinition = "CREATE TABLE orders (id int)";
    item.devDefinition = "CREATE TABLE orders (id bigint)";
    expect(summarizeSchemaDifference(item)).toEqual({ name: "orders.owner", description: "Table definition differs; see details" });
  });
  it.each(["invalid json", "[]", "42", "null", "\"text\""])("safely falls back for unsupported metadata %s", text => {
    const item = difference(column, column);
    item.devDefinition = text;
    expect(summarizeSchemaDifference(item)).toEqual({ name: "orders.owner", description: "Definition differs; see details" });
  });
  it.each(["view", "routine"] as const)("keeps %s SQL definitions in full details", kind => {
    expect(summarizeSchemaDifference(difference({ SQL: "dev" }, { SQL: "prod" }, kind)).description).toBe(`${kind === "view" ? "View" : "Routine"} definition differs; see details`);
  });
  it("retains unknown changed metadata fields and handles equal metadata defensively", () => {
    expect(summarizeSchemaDifference(difference({ ...column, UNKNOWN: 1 }, { ...column, UNKNOWN: 2 })).description).toBe("UNKNOWN: 2 → 1");
    expect(summarizeSchemaDifference(difference(column, column)).description).toBe("Definition differs; see details");
    expect(summarizeSchemaDifference(difference(null, null)).description).toBe("Definition differs; see details");
  });
});
