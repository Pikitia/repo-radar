import type { SchemaDifference } from "../types/database.js";

type Metadata = Record<string, unknown>;
const fields: Record<string, string> = {
  COLUMN_TYPE: "Type", IS_NULLABLE: "Nullable", COLUMN_DEFAULT: "Default",
  CHARACTER_SET_NAME: "Character set", COLLATION_NAME: "Collation", EXTRA: "Extra",
  GENERATION_EXPRESSION: "Generated expression", ORDINAL_POSITION: "Position", COLUMN_COMMENT: "Comment",
  ENGINE: "Engine", TABLE_COLLATION: "Collation", ROW_FORMAT: "Row format", CREATE_OPTIONS: "Options", TABLE_COMMENT: "Comment",
  NON_UNIQUE: "Non-unique", SEQ_IN_INDEX: "Index position", COLUMN_NAME: "Column", COLLATION: "Sort direction",
  SUB_PART: "Prefix length", NULLABLE: "Nullable", INDEX_TYPE: "Index type", COMMENT: "Comment", INDEX_COMMENT: "Index comment",
  REFERENCED_TABLE_NAME: "Referenced table", REFERENCED_COLUMN_NAME: "Referenced column", UPDATE_RULE: "On update", DELETE_RULE: "On delete",
  DEFINER: "Definer", EVENT_MANIPULATION: "Event", EVENT_OBJECT_TABLE: "Table", ACTION_ORDER: "Trigger order",
  ACTION_CONDITION: "Condition", ACTION_STATEMENT: "Statement", ACTION_ORIENTATION: "Orientation", ACTION_TIMING: "Timing",
  SQL_MODE: "SQL mode", CHARACTER_SET_CLIENT: "Client character set", COLLATION_CONNECTION: "Connection collation", DATABASE_COLLATION: "Database collation",
  TABLE_NAME: "Table", INDEX_NAME: "Index", CONSTRAINT_NAME: "Constraint", TRIGGER_NAME: "Trigger"
};
const nameFields: Partial<Record<SchemaDifference["objectType"], string>> = {
  column: "COLUMN_NAME", table: "TABLE_NAME", index: "INDEX_NAME", "foreign-key": "CONSTRAINT_NAME", trigger: "TRIGGER_NAME", routine: "ROUTINE_NAME"
};

function metadata(definition: string | null): Metadata | undefined {
  if (definition === null) return;
  try {
    const value: unknown = JSON.parse(definition);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Metadata;
  } catch { /* SHOW CREATE SQL and invalid metadata remain available in full details. */ }
}

function name(item: SchemaDifference, dev: Metadata | undefined, production: Metadata | undefined): string {
  const field = nameFields[item.objectType];
  if (!field) return item.objectPath;
  const definitions = [item.devDefinition === null ? undefined : dev, item.productionDefinition === null ? undefined : production];
  // Missing metadata or conflicting identities cannot safely name a column by
  // splitting a dotted object path: the dots may belong to the identifiers.
  if ((item.devDefinition !== null && !dev) || (item.productionDefinition !== null && !production)) return item.objectPath;
  const ownerField = item.objectType === "trigger" ? "EVENT_OBJECT_TABLE" : "TABLE_NAME";
  if (dev && production && Object.hasOwn(dev, ownerField) && Object.hasOwn(production, ownerField) && dev[ownerField] !== production[ownerField]) return item.objectPath;
  const names = definitions.filter(value => value !== undefined).map(value => value[field]);
  if (!names.length || names.some(value => typeof value !== "string" || !value.trim() || value !== names[0])) return item.objectPath;
  return names[0] as string;
}

function preview(value: unknown, present: boolean): string {
  if (!present) return "not reported";
  const text = JSON.stringify(value) ?? "not reported";
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

/** Describes observed states, always in Production → Development order. */
export function summarizeSchemaDifference(item: SchemaDifference, coverageComplete = false): { name: string; description: string } {
  const dev = metadata(item.devDefinition);
  const production = metadata(item.productionDefinition);
  const label = name(item, dev, production);
  if (item.devDefinition !== null && item.productionDefinition === null) return { name: label, description: coverageComplete ? "Only in development" : "Present in development; not reported in production" };
  if (item.devDefinition === null && item.productionDefinition !== null) return { name: label, description: coverageComplete ? "Only in production" : "Present in production; not reported in development" };
  const fallback = item.objectType === "table" && item.devDefinition !== null && item.productionDefinition !== null && !dev && !production && /^\s*CREATE\s+TABLE\b/i.test(item.devDefinition) && /^\s*CREATE\s+TABLE\b/i.test(item.productionDefinition)
    ? "Table definition differs; see details"
    : item.objectType === "view" ? "View definition differs; see details"
      : item.objectType === "routine" ? "Routine definition differs; see details" : "Definition differs; see details";
  if (!dev || !production || ["view", "routine"].includes(item.objectType)) return { name: label, description: fallback };
  const keys = [...new Set([...Object.keys(production), ...Object.keys(dev)])];
  const changes = keys.filter(key => Object.hasOwn(production, key) !== Object.hasOwn(dev, key) || JSON.stringify(production[key]) !== JSON.stringify(dev[key])).map(key => {
    const before = preview(production[key], Object.hasOwn(production, key));
    const after = preview(dev[key], Object.hasOwn(dev, key));
    return `${fields[key] ?? key}: ${before} → ${after}${before === after ? " (values differ; see details)" : ""}`;
  });
  return { name: label, description: changes.length ? changes.join("; ") : fallback };
}
