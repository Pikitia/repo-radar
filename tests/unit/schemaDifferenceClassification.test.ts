import { describe, expect, it } from "vitest";
import { classifySchemaDifference } from "../../src/components/schemaDifferenceClassification.js";
import type { SchemaComparison, SchemaDifference } from "../../src/types/database.js";

const engines: NonNullable<SchemaComparison["engines"]> = { development: { engine: "mysql", version: "8.0.42" }, production: { engine: "mariadb", version: "10.6.25-MariaDB-log" } };
const column = { TABLE_NAME: "items", COLUMN_NAME: "created_at", ORDINAL_POSITION: "1", COLUMN_DEFAULT: "CURRENT_TIMESTAMP", IS_NULLABLE: "NO", COLUMN_TYPE: "timestamp", CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: "", GENERATION_EXPRESSION: null, COLUMN_COMMENT: "" };
function difference(dev: Record<string, unknown>, production: Record<string, unknown>): SchemaDifference {
  return { objectType: "column", objectPath: "items.created_at", devDefinition: JSON.stringify(dev), productionDefinition: JSON.stringify(production), assessment: "unverified", migrationIds: [], reason: "Unchanged backend reason" };
}
const classify = (dev: Record<string, unknown>, production: Record<string, unknown>, context: SchemaComparison["engines"] = engines) => classifySchemaDifference(difference(dev, production), context);
const reversed = { development: engines.production, production: engines.development };

describe("schema difference presentation classification", () => {
  it("combines integer-width and MariaDB NULL representation differences", () => {
    const mysql = { ...column, COLUMN_TYPE: "int", IS_NULLABLE: "YES", COLUMN_DEFAULT: null };
    const maria = { ...mysql, COLUMN_TYPE: "int(11)", COLUMN_DEFAULT: "NULL" };
    expect(classify(mysql, maria).category).toBe("representation");
    expect(classify(maria, mysql, reversed).category).toBe("representation");
    expect(classify({ ...mysql, IS_NULLABLE: "NO" }, maria).category).toBe("review");
    expect(classify(mysql, { ...maria, COLUMN_TYPE: "bigint(20)" }).category).toBe("review");
  });

  it("recognizes equivalent timestamp ON UPDATE spelling combined with default annotation", () => {
    const mysql = { ...column, EXTRA: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" };
    const maria = { ...column, COLUMN_DEFAULT: "current_timestamp()", EXTRA: "on update current_timestamp()" };
    expect(classify(mysql, maria).category).toBe("representation");
    expect(classify(maria, mysql, reversed).category).toBe("representation");
    expect(classify(mysql, { ...maria, EXTRA: "on update current_timestamp(6)" }).category).toBe("review");
    expect(classify(mysql, { ...maria, EXTRA: "" }).category).toBe("review");
    expect(classify(mysql, { ...maria, EXTRA: "on update 'current_timestamp()'" }).category).toBe("review");
  });

  it("combines nullable SQL NULL defaults with equivalent timestamp ON UPDATE spelling", () => {
    const mysql = { ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: null, EXTRA: "on update CURRENT_TIMESTAMP" };
    const maria = { ...mysql, COLUMN_DEFAULT: "NULL", EXTRA: "on update current_timestamp()" };
    expect(classify(mysql, maria).category).toBe("representation");
    expect(classify(maria, mysql, reversed).category).toBe("representation");
  });

  it.each([null, "'2000-01-01 00:00:00'"])("recognizes equivalent ON UPDATE spelling with identical default %s", value => {
    const mysql = { ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: value, EXTRA: "on update CURRENT_TIMESTAMP" };
    expect(classify(mysql, { ...mysql, EXTRA: "on update current_timestamp()" }).category).toBe("representation");
  });

  it("retains fractional precision when nullable defaults and ON UPDATE spelling both differ", () => {
    const mysql = { ...column, COLUMN_TYPE: "datetime(6)", IS_NULLABLE: "YES", COLUMN_DEFAULT: null, EXTRA: "on update CURRENT_TIMESTAMP(6)" };
    const maria = { ...mysql, COLUMN_DEFAULT: "NULL", EXTRA: "on update current_timestamp(6)" };
    expect(classify(mysql, maria).category).toBe("representation");
    expect(classify(mysql, { ...maria, EXTRA: "on update current_timestamp()" }).category).toBe("review");
  });

  it("keeps changed defaults, ON UPDATE behavior, annotations and unknown temporal attributes visible", () => {
    const mysql = { ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: null, EXTRA: "on update CURRENT_TIMESTAMP" };
    const maria = { ...mysql, COLUMN_DEFAULT: "NULL", EXTRA: "on update current_timestamp()" };
    for (const change of [
      { COLUMN_DEFAULT: "'NULL'" }, { COLUMN_DEFAULT: "'2000-01-01 00:00:00'" },
      { COLUMN_DEFAULT: "current_timestamp()" }, { EXTRA: "" },
      { EXTRA: "on update current_timestamp(6)" }, { EXTRA: "on update 'current_timestamp()'" },
      { EXTRA: "on update current_timestamp() INVISIBLE" }, { EXTRA: "STORED GENERATED" },
      { GENERATION_EXPRESSION: "created_at + 1" }
    ]) expect(classify(mysql, { ...maria, ...change }).category).toBe("review");
    expect(classify({ ...mysql, EXTRA: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" }, maria).category).toBe("review");
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED unknown" }, { ...column, COLUMN_DEFAULT: "current_timestamp()", EXTRA: "unknown" }).category).toBe("review");
  });

  it("classifies only equivalent foreign-key actions on confirmed InnoDB tables", () => {
    const fk = { TABLE_NAME: "items", CONSTRAINT_NAME: "fk_owner", COLUMN_NAME: "owner_id", ORDINAL_POSITION: "1", REFERENCED_TABLE_NAME: "owners", REFERENCED_COLUMN_NAME: "id", UPDATE_RULE: "NO ACTION", DELETE_RULE: "RESTRICT" };
    const item: SchemaDifference = { ...difference({}, {}), objectType: "foreign-key", objectPath: "items.fk_owner.1", devDefinition: JSON.stringify(fk), productionDefinition: JSON.stringify({ ...fk, UPDATE_RULE: "RESTRICT", DELETE_RULE: "NO ACTION" }) };
    const tables = [{ tableName: "items", development: "InnoDB", production: "InnoDB" }];
    expect(classifySchemaDifference(item, engines, tables).category).toBe("representation");
    expect(classifySchemaDifference({ ...item, devDefinition: item.productionDefinition, productionDefinition: item.devDefinition }, reversed, tables).category).toBe("representation");
    expect(classifySchemaDifference(item, engines).category).toBe("review");
    expect(classifySchemaDifference(item, engines, [{ ...tables[0], development: "NDB" }]).category).toBe("review");
    expect(classifySchemaDifference(item, engines, [{ ...tables[0], production: null }]).category).toBe("review");
    expect(classifySchemaDifference(item, engines, [...tables, ...tables]).category).toBe("review");
    expect(classifySchemaDifference(item, undefined, tables).category).toBe("review");
    for (const change of [{ UPDATE_RULE: "CASCADE" }, { DELETE_RULE: "SET NULL" }, { REFERENCED_COLUMN_NAME: "other" }, { FUTURE_METADATA: "unknown" }, { ORDINAL_POSITION: "2" }]) {
      expect(classifySchemaDifference({ ...item, productionDefinition: JSON.stringify({ ...fk, ...change }) }, engines, tables).category).toBe("review");
    }
    for (const field of Object.keys(fk)) {
      const incomplete: Record<string, unknown> = { ...fk }; delete incomplete[field];
      expect(classifySchemaDifference({ ...item, productionDefinition: JSON.stringify(incomplete) }, engines, tables).category).toBe("review");
    }
  });

  it("classifies raw table representations only with supported context and exact table identity", () => {
    const item: SchemaDifference = { ...difference({}, {}), objectType: "table", objectPath: "items/definition", devDefinition: "CREATE TABLE `items` (`id` int) ENGINE=InnoDB", productionDefinition: "CREATE TABLE `items` (`id` int(11)) ENGINE=InnoDB" };
    expect(classifySchemaDifference(item, engines).category).toBe("representation");
    expect(classifySchemaDifference(item).category).toBe("review");
    expect(classifySchemaDifference({ ...item, objectPath: "other/definition" }, engines).category).toBe("review");
    expect(classifySchemaDifference({ ...item, objectPath: "items" }, engines).category).toBe("review");
    expect(classifySchemaDifference({ ...item, productionDefinition: null }, engines).category).toBe("review");
    expect(classifySchemaDifference({ ...item, devDefinition: "CREATE TABLE `items` (`id` bigint) ENGINE=InnoDB" }, engines).category).toBe("review");
  });
  it.each([
    ["CURRENT_TIMESTAMP", "current_timestamp()"], ["current_timestamp()", "CURRENT_TIMESTAMP(0)"], ["CURRENT_TIMESTAMP(0)", "current_timestamp"]
  ])("recognizes unquoted timestamp spellings %s and %s in either direction", (devDefault, productionDefault) => {
    const dev = { ...column, COLUMN_DEFAULT: devDefault, EXTRA: "DEFAULT_GENERATED" }, production = { ...column, COLUMN_DEFAULT: productionDefault };
    expect(classify(dev, production).category).toBe("representation");
    expect(classify(production, dev, reversed).category).toBe("representation");
  });

  it.each(["timestamp(6)", "datetime(6)"])("retains matching fractional precision for %s", type => {
    expect(classify({ ...column, COLUMN_TYPE: type, COLUMN_DEFAULT: "CURRENT_TIMESTAMP(6)", EXTRA: "DEFAULT_GENERATED" }, { ...column, COLUMN_TYPE: type, COLUMN_DEFAULT: "current_timestamp(6)" }).category).toBe("representation");
  });

  it("recognizes an annotation-only difference without changing identical on-update behavior", () => {
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" }, { ...column, EXTRA: "on update CURRENT_TIMESTAMP" }).category).toBe("representation");
  });

  it.each([
    ["int(11)", "int"], ["bigint(20) unsigned", "bigint unsigned"], ["smallint(6)", "smallint(5)"], ["tinyint(4)", "tinyint"]
  ])("recognizes integer display width only: %s and %s", (devType, productionType) => {
    const dev = { ...column, COLUMN_TYPE: devType, COLUMN_DEFAULT: null }, production = { ...column, COLUMN_TYPE: productionType, COLUMN_DEFAULT: null };
    expect(classify(dev, production).category).toBe("representation");
    expect(classify(production, dev, reversed).category).toBe("representation");
  });

  it("recognizes MariaDB unquoted NULL versus MySQL SQL NULL in either direction", () => {
    const mysql = { ...column, COLUMN_TYPE: "varchar(100)", IS_NULLABLE: "YES", COLUMN_DEFAULT: null }, maria = { ...mysql, COLUMN_DEFAULT: "NULL" };
    expect(classify(mysql, maria).category).toBe("representation");
    expect(classify(maria, mysql, reversed).category).toBe("representation");
  });

  it.each([
    ["COLUMN_TYPE", "timestamp(6)"], ["COLUMN_DEFAULT", "CURRENT_TIMESTAMP(6)"], ["COLUMN_DEFAULT", "'CURRENT_TIMESTAMP'"],
    ["COLUMN_DEFAULT", "(CURRENT_TIMESTAMP())"], ["COLUMN_DEFAULT", ""], ["IS_NULLABLE", "YES"],
    ["EXTRA", "on update CURRENT_TIMESTAMP"], ["EXTRA", "STORED GENERATED"], ["EXTRA", "INVISIBLE"],
    ["GENERATION_EXPRESSION", "created_at + 1"], ["COLLATION_NAME", "utf8mb4_bin"], ["COLUMN_COMMENT", "Changed comment"],
    ["ORDINAL_POSITION", "2"], ["TABLE_NAME", "another"], ["COLUMN_NAME", "updated_at"], ["FUTURE_METADATA", "unknown"]
  ])("keeps mixed timestamp and actual or unknown %s changes visible", (field, value) => {
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED", [field]: value }, { ...column, COLUMN_DEFAULT: "current_timestamp()" }).category).toBe("review");
  });

  it.each([
    ["int(11) unsigned", "int"], ["int(11)", "bigint"], ["int(11) zerofill", "int"], ["int(11) unsigned zerofill", "int unsigned"],
    ["tinyint(1)", "tinyint"], ["tinyint(4)", "tinyint(1)"], ["decimal(11,2)", "decimal(12,2)"], ["varchar(11)", "varchar(12)"],
    ["bit(1)", "bit(2)"], ["int(256)", "int"]
  ])("keeps risky or unsupported type differences %s and %s visible", (devType, productionType) => {
    expect(classify({ ...column, COLUMN_TYPE: devType }, { ...column, COLUMN_TYPE: productionType }).category).toBe("review");
  });

  it.each(["'NULL'", "", "null", "(NULL)", "'null'"])("does not treat MariaDB literal or expression %s as SQL NULL", value => {
    expect(classify({ ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: null }, { ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: value }).category).toBe("review");
  });

  it("does not infer null defaults for nonnullable columns or from MySQL text NULL", () => {
    expect(classify({ ...column, COLUMN_DEFAULT: null }, { ...column, COLUMN_DEFAULT: "NULL" }).category).toBe("review");
    expect(classify({ ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: "NULL" }, { ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: null }).category).toBe("review");
    expect(classify({ ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: null }, { ...column, IS_NULLABLE: "YES", COLUMN_DEFAULT: "NULL" }, { development: engines.development, production: engines.development }).category).toBe("review");
  });

  it("keeps JSON versus LONGTEXT visible with a compatibility explanation", () => {
    const result = classify({ ...column, COLUMN_TYPE: "json" }, { ...column, COLUMN_TYPE: "longtext", COLLATION_NAME: "utf8mb4_bin" });
    expect(result.category).toBe("review");
    expect(result.reason).toMatch(/storage and validation.*review compatibility/i);
  });

  it.each(["8.0", "5.7.44", "9.0.0", "unknown"])("does not hide differences with unsupported MySQL version %s", version => {
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED" }, column, { ...engines, development: { engine: "mysql", version } }).category).toBe("review");
  });

  it.each(["10.5.25", "12.0.0", "10.6"])("does not hide differences with unsupported MariaDB version %s", version => {
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED" }, column, { ...engines, production: { engine: "mariadb", version } }).category).toBe("review");
  });

  it("keeps missing context, missing objects, raw SQL, malformed metadata and unrelated object kinds visible", () => {
    const item = difference({ ...column, EXTRA: "DEFAULT_GENERATED" }, column);
    expect(classifySchemaDifference(item).category).toBe("review");
    expect(classifySchemaDifference(item, {} as NonNullable<SchemaComparison["engines"]>).category).toBe("review");
    for (const devDefinition of [null, "bad JSON", "[]", "42", "CREATE TABLE items (id int)"]) expect(classifySchemaDifference({ ...item, devDefinition }, engines).category).toBe("review");
    expect(classifySchemaDifference({ ...item, objectType: "table" }, engines).category).toBe("review");
  });

  it.each(Object.keys(column))("does not infer equivalence when %s is missing", field => {
    const incomplete: Record<string, unknown> = { ...column }; delete incomplete[field];
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED" }, incomplete).category).toBe("review");
  });

  it.each([null, {}, "yes", 1])("keeps malformed nullability %s visible", value => {
    expect(classify({ ...column, IS_NULLABLE: value, EXTRA: "DEFAULT_GENERATED" }, { ...column, IS_NULLABLE: value }).category).toBe("review");
  });

  it("does not coerce a nullability array to YES", () => {
    expect(classify({ ...column, IS_NULLABLE: ["YES"], EXTRA: "DEFAULT_GENERATED" }, { ...column, IS_NULLABLE: ["YES"] }).category).toBe("review");
  });

  it("only removes the recognized annotation on the MySQL side", () => {
    expect(classify(column, { ...column, EXTRA: "DEFAULT_GENERATED" }).category).toBe("review");
    expect(classify({ ...column, EXTRA: "DEFAULT_GENERATED DEFAULT_GENERATED" }, column).category).toBe("review");
  });

  it("does not mutate definitions, backend assessment, migration evidence or context", () => {
    const item = difference({ ...column, EXTRA: "DEFAULT_GENERATED" }, column);
    item.migrationIds = ["001"];
    const before = JSON.stringify({ item, engines });
    Object.freeze(item); Object.freeze(item.migrationIds);
    expect(classifySchemaDifference(item, engines).category).toBe("representation");
    expect(JSON.stringify({ item, engines })).toBe(before);
  });
});
