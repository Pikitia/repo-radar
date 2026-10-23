import type { SchemaComparison, SchemaDifference } from "../types/database.js";
import { tableDefinitionsEquivalent } from "./schemaTableDefinition.js";

type Metadata = Record<string, unknown>;
type Engine = NonNullable<SchemaComparison["engines"]>["development"];
type Classification = { category: "review" | "representation"; reason: string };
const required = ["TABLE_NAME", "COLUMN_NAME", "ORDINAL_POSITION", "COLUMN_DEFAULT", "IS_NULLABLE", "COLUMN_TYPE", "CHARACTER_SET_NAME", "COLLATION_NAME", "EXTRA", "GENERATION_EXPRESSION", "COLUMN_COMMENT"] as const;
const review = (reason = "This difference needs review; it is not a recognized metadata representation difference."): Classification => ({ category: "review", reason });

function parse(definition: string | null): Metadata | undefined {
  if (definition === null) return;
  try {
    const value: unknown = JSON.parse(definition);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Metadata;
  } catch { /* SQL and malformed metadata always remain in the review list. */ }
}

function complete(row: Metadata): boolean {
  if (!required.every(field => Object.hasOwn(row, field))) return false;
  if (!["TABLE_NAME", "COLUMN_NAME", "COLUMN_TYPE"].every(field => typeof row[field] === "string" && !!row[field].trim())) return false;
  if (!["EXTRA", "COLUMN_COMMENT"].every(field => typeof row[field] === "string")) return false;
  if (!["CHARACTER_SET_NAME", "COLLATION_NAME", "GENERATION_EXPRESSION"].every(field => row[field] === null || typeof row[field] === "string")) return false;
  if (row.IS_NULLABLE !== "YES" && row.IS_NULLABLE !== "NO") return false;
  if (!(row.COLUMN_DEFAULT === null || typeof row.COLUMN_DEFAULT === "string" || (typeof row.COLUMN_DEFAULT === "number" && Number.isFinite(row.COLUMN_DEFAULT)))) return false;
  return (typeof row.ORDINAL_POSITION === "string" && /^[1-9]\d*$/.test(row.ORDINAL_POSITION)) || (typeof row.ORDINAL_POSITION === "number" && Number.isSafeInteger(row.ORDINAL_POSITION) && row.ORDINAL_POSITION > 0);
}

function supported(engine: Engine | undefined): boolean {
  if (!engine || typeof engine.version !== "string") return false;
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(engine.version);
  if (!version) return false;
  const major = Number(version[1]), minor = Number(version[2]);
  return engine.engine === "mysql" ? major === 8 : engine.engine === "mariadb" && ((major === 10 && minor >= 6) || major === 11);
}

function temporalPrecision(type: unknown): number | undefined {
  if (typeof type !== "string") return;
  const match = /^(?:timestamp|datetime)(?:\(([0-6])\))?$/i.exec(type);
  return match ? Number(match[1] ?? 0) : undefined;
}

function timestampPrecision(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const match = /^current_timestamp(?:\(([0-6]?)\))?$/i.exec(value);
  return match ? Number(match[1] || 0) : undefined;
}

function withoutDefaultAnnotation(extra: string, engine: Engine): string {
  // Only MySQL documents DEFAULT_GENERATED. Do not remove any other EXTRA
  // attributes, including on-update, generated-column or invisible attributes.
  return engine.engine === "mysql" ? extra.replace(/^DEFAULT_GENERATED(?: |$)/, "") : extra;
}

function temporalExtra(extra: string, engine: Engine, precision: number, timestampDefault: boolean): string | undefined {
  // DEFAULT_GENERATED describes the default expression, not ON UPDATE. Only
  // disregard it when both defaults are confirmed equivalent expressions.
  const value = timestampDefault ? withoutDefaultAnnotation(extra, engine) : extra;
  if (value === "") return value;
  const update = /^on update (current_timestamp(?:\([0-6]?\))?)$/i.exec(value);
  return update && timestampPrecision(update[1]) === precision ? `on update CURRENT_TIMESTAMP(${precision})` : undefined;
}

function integer(type: unknown): { base: string; width?: number; unsigned: boolean } | undefined {
  if (typeof type !== "string") return;
  const match = /^(tinyint|smallint|mediumint|int|bigint)(?:\(([1-9]\d{0,2})\))?( unsigned)?$/i.exec(type);
  if (!match || (match[2] && Number(match[2]) > 255)) return;
  return { base: match[1].toLowerCase(), width: match[2] ? Number(match[2]) : undefined, unsigned: !!match[3] };
}

function changedFields(dev: Metadata, production: Metadata): string[] {
  return [...new Set([...Object.keys(dev), ...Object.keys(production)])].filter(field => Object.hasOwn(dev, field) !== Object.hasOwn(production, field) || JSON.stringify(dev[field]) !== JSON.stringify(production[field]));
}

function foreignKey(item: SchemaDifference, engines: SchemaComparison["engines"], tables: SchemaComparison["tableStorageEngines"]): Classification {
  const dev = parse(item.devDefinition), production = parse(item.productionDefinition);
  if (!dev || !production || !supported(engines?.development) || !supported(engines?.production)) return review();
  const identity = ["TABLE_NAME", "CONSTRAINT_NAME", "COLUMN_NAME", "REFERENCED_TABLE_NAME", "REFERENCED_COLUMN_NAME"];
  if (!identity.every(field => typeof dev[field] === "string" && !!dev[field] && dev[field] === production[field])) return review();
  if (typeof dev.ORDINAL_POSITION !== "string" || !/^[1-9]\d*$/.test(dev.ORDINAL_POSITION) || dev.ORDINAL_POSITION !== production.ORDINAL_POSITION || item.objectPath !== `${dev.TABLE_NAME}.${dev.CONSTRAINT_NAME}.${dev.ORDINAL_POSITION}`) return review();
  const storage = tables?.filter(table => table.tableName === dev.TABLE_NAME);
  if (storage?.length !== 1 || storage[0].development?.toLowerCase() !== "innodb" || storage[0].production?.toLowerCase() !== "innodb") return review("Foreign-key action equivalence requires confirmed InnoDB storage on both sides.");
  const actions = ["RESTRICT", "NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT"];
  if (![dev.UPDATE_RULE, dev.DELETE_RULE, production.UPDATE_RULE, production.DELETE_RULE].every(action => typeof action === "string" && actions.includes(action))) return review();
  const changed = changedFields(dev, production);
  if (!changed.length || !changed.every(field => ["UPDATE_RULE", "DELETE_RULE"].includes(field) && [dev[field], production[field]].every(value => value === "RESTRICT" || value === "NO ACTION"))) return review();
  return { category: "representation", reason: "InnoDB RESTRICT and NO ACTION both reject the parent change immediately; foreign-key columns and references match." };
}

/** Presentation only: original definitions and migration assessments stay intact. */
export function classifySchemaDifference(item: SchemaDifference, engines?: SchemaComparison["engines"], tables?: SchemaComparison["tableStorageEngines"]): Classification {
  if (item.objectType === "foreign-key") return foreignKey(item, engines, tables);
  if (item.objectType === "table" && item.objectPath.endsWith("/definition") && item.devDefinition !== null && item.productionDefinition !== null && supported(engines?.development) && supported(engines?.production) && tableDefinitionsEquivalent(item.devDefinition, item.productionDefinition, item.objectPath.slice(0, -"/definition".length))) {
    return { category: "representation", reason: "Complete table definitions match after bounded integer-width, timestamp spelling, whitespace and InnoDB default foreign-key action normalization; all other tokens are retained." };
  }
  if (item.objectType !== "column") return review();
  const dev = parse(item.devDefinition), production = parse(item.productionDefinition);
  if (!dev || !production || !complete(dev) || !complete(production)) return review("Incomplete column metadata needs review.");
  if (dev.TABLE_NAME !== production.TABLE_NAME || dev.COLUMN_NAME !== production.COLUMN_NAME || item.objectPath !== `${dev.TABLE_NAME}.${dev.COLUMN_NAME}`) return review("Column identity differs or could not be confirmed.");

  const types = [String(dev.COLUMN_TYPE).toLowerCase(), String(production.COLUMN_TYPE).toLowerCase()];
  if (types.includes("json") && types.includes("longtext")) return review("MySQL JSON and MariaDB LONGTEXT JSON storage and validation can behave differently; review compatibility and constraints.");
  if (!engines || !supported(engines.development) || !supported(engines.production)) return review("Supported engine and version details are required to classify representation differences.");

  const changed = new Set(changedFields(dev, production));
  if (!changed.size) return review();
  const covered = new Set<string>(), reasons: string[] = [];
  const sameType = dev.COLUMN_TYPE === production.COLUMN_TYPE;
  const ordinary = [dev, production].every(row => (row.GENERATION_EXPRESSION === null || row.GENERATION_EXPRESSION === "") && !/\b(?:GENERATED|VIRTUAL|STORED)\b/i.test(String(row.EXTRA)));
  const precision = temporalPrecision(dev.COLUMN_TYPE);
  if (ordinary && sameType && precision !== undefined) {
    const timestampDefault = timestampPrecision(dev.COLUMN_DEFAULT) === precision && timestampPrecision(production.COLUMN_DEFAULT) === precision;
    const devExtra = temporalExtra(String(dev.EXTRA), engines.development, precision, timestampDefault);
    const productionExtra = temporalExtra(String(production.EXTRA), engines.production, precision, timestampDefault);
    if (devExtra !== undefined && productionExtra !== undefined) {
      if (changed.has("COLUMN_DEFAULT") && timestampDefault) covered.add("COLUMN_DEFAULT");
      if (changed.has("EXTRA") && devExtra === productionExtra) covered.add("EXTRA");
      if (covered.size) reasons.push("Equivalent CURRENT_TIMESTAMP spelling or MySQL DEFAULT_GENERATED annotation; timestamp precision and on-update behavior are retained.");
    }
  }

  const devInteger = integer(dev.COLUMN_TYPE), productionInteger = integer(production.COLUMN_TYPE);
  if (ordinary && changed.has("COLUMN_TYPE") && devInteger && productionInteger && devInteger.base === productionInteger.base && devInteger.unsigned === productionInteger.unsigned && devInteger.width !== productionInteger.width && !(devInteger.base === "tinyint" && [devInteger.width, productionInteger.width].includes(1))) {
    covered.add("COLUMN_TYPE");
    reasons.push("Integer display width differs; stored range and signedness match. Application metadata interpretation is not certified.");
  }

  const maria = engines.development.engine === "mariadb" ? dev : engines.production.engine === "mariadb" ? production : undefined;
  const mysql = engines.development.engine === "mysql" ? dev : engines.production.engine === "mysql" ? production : undefined;
  if (ordinary && (sameType || covered.has("COLUMN_TYPE")) && changed.has("COLUMN_DEFAULT") && maria && mysql && maria !== mysql && maria.COLUMN_DEFAULT === "NULL" && mysql.COLUMN_DEFAULT === null && dev.IS_NULLABLE === "YES" && production.IS_NULLABLE === "YES") {
    covered.add("COLUMN_DEFAULT");
    reasons.push("MariaDB reports an unquoted NULL default as text; MySQL reports SQL NULL for this nullable column.");
  }

  if ([...changed].some(field => !covered.has(field))) return review();
  return { category: "representation", reason: reasons.join(" ") };
}
