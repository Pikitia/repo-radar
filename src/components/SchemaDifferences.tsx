import { useEffect, useId, useRef, useState } from "react";
import type { SchemaComparison, SchemaDifference } from "../types/database.js";
import { summarizeSchemaDifference } from "./schemaDifferenceSummary.js";
import { classifySchemaDifference } from "./schemaDifferenceClassification.js";

export interface SchemaComparisonGroup {
  databaseKey: string;
  devDatabase?: string;
  productionDatabase?: string;
  comparison?: SchemaComparison;
  error?: string;
  loading?: boolean;
}

interface Props { groups: SchemaComparisonGroup[] }

interface ObjectGroup { key: string; label: string; table?: string; differences: SchemaDifference[] }

function tableSql(item: SchemaDifference): boolean {
  return item.objectType === "table" && item.devDefinition !== null && item.productionDefinition !== null && /^\s*CREATE\s+TABLE\b/i.test(item.devDefinition) && /^\s*CREATE\s+TABLE\b/i.test(item.productionDefinition);
}

function hiddenFromReview(item: SchemaDifference, comparison: SchemaComparison): boolean {
  // Raw table SQL is a display preference, never a claim of equivalence.
  return tableSql(item) || classifySchemaDifference(item, comparison.engines, comparison.tableStorageEngines).category === "representation";
}

function priority(item: SchemaDifference): number {
  if ((item.devDefinition === null) !== (item.productionDefinition === null)) {
    if (item.objectType === "table") return 0;
    if (item.objectType === "column") return 1;
  }
  if (item.objectType === "column" && item.devDefinition !== null && item.productionDefinition !== null) {
    try {
      const dev: unknown = JSON.parse(item.devDefinition), production: unknown = JSON.parse(item.productionDefinition);
      if (dev && production && typeof dev === "object" && typeof production === "object" && "COLUMN_TYPE" in dev && "COLUMN_TYPE" in production && typeof dev.COLUMN_TYPE === "string" && typeof production.COLUMN_TYPE === "string" && dev.COLUMN_TYPE !== production.COLUMN_TYPE) return 2;
    } catch { /* Unknown metadata retains its original relative order. */ }
  }
  return 3;
}

function owningTable(item: SchemaDifference): string | undefined {
  if (!["table", "column", "index", "foreign-key", "trigger"].includes(item.objectType)) return;
  const field = item.objectType === "trigger" ? "EVENT_OBJECT_TABLE" : "TABLE_NAME";
  let table: string | undefined;
  // Object paths join identifiers with dots, so splitting them can invent ownership
  // when a table or column name itself contains dots. Use the captured metadata.
  for (const definition of [item.devDefinition, item.productionDefinition]) {
    if (definition === null) continue;
    let name: unknown;
    try {
      const metadata: unknown = JSON.parse(definition);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
      name = (metadata as Record<string, unknown>)[field];
    } catch {
      if (item.objectType !== "table" || !/^\s*CREATE\s+TABLE\b/i.test(definition)) return;
      // SHOW CREATE uses this exact adapter suffix. Metadata TABLE_NAME above
      // keeps a real table called "a/definition" intact.
      name = item.objectPath.endsWith("/definition") ? item.objectPath.slice(0, -"/definition".length) : item.objectPath;
    }
    if (typeof name !== "string" || !name.trim() || (table !== undefined && table !== name)) return;
    table = name;
  }
  return table;
}

function groupObjects(differences: SchemaDifference[]): ObjectGroup[] {
  const groups = new Map<string, ObjectGroup>();
  const labels: Record<SchemaDifference["objectType"], string> = {
    table: "Tables (name unknown)", column: "Columns (table unknown)", index: "Indexes (table unknown)",
    "foreign-key": "Foreign keys (table unknown)", trigger: "Triggers (table unknown)", view: "Views", routine: "Routines"
  };
  for (const item of differences) {
    const table = owningTable(item);
    const key = table === undefined ? `type:${item.objectType}` : `table:${table}`;
    const group = groups.get(key) ?? { key, label: table === undefined ? labels[item.objectType] : `Table ${table}`, table, differences: [] };
    group.differences.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function ObjectDifferences({ group, databaseKey, coverageComplete, engines, tables }: { group: ObjectGroup; databaseKey: string; coverageComplete: boolean; engines?: SchemaComparison["engines"]; tables?: SchemaComparison["tableStorageEngines"] }) {
  return <details className="database-schema-table" aria-label={group.table === undefined ? `${group.label} differences in ${databaseKey}` : `Table differences for ${group.table} in ${databaseKey}`}>
    <summary>
      <span className="database-schema-name">{group.label}</span>
      <span className="database-schema-counts">
        <span>{group.differences.length} {group.differences.length === 1 ? "difference" : "differences"}</span>
      </span>
    </summary>
    <div className="database-schema-table-body">
      <div className="database-change-list-scroll"><table className="database-change-list" aria-label={`Changes for ${group.label} in ${databaseKey}`}>
        <thead><tr><th scope="col">Column / object</th><th scope="col">Difference (production → development)</th></tr></thead>
        <tbody>{group.differences.map(item => {
          const summary = summarizeSchemaDifference(item, coverageComplete);
          const classification = classifySchemaDifference(item, engines, tables);
          return <tr key={`${item.objectType}:${item.objectPath}`}>
            <th scope="row">{item.objectType !== "column" && <span className="database-change-kind">{item.objectType}</span>}{summary.name}</th>
            <td><details className="database-schema-difference">
              <summary aria-label={`${summary.name}: ${summary.description}. Details for ${item.objectType} ${item.objectPath}`}><span>{summary.description}</span><span className="database-change-details-link">Details</span></summary>
              <p><strong>{item.objectType} {item.objectPath}</strong></p>
              {!tableSql(item) && classification.category === "representation" && <p>Representation difference: {classification.reason}</p>}
              {item.migrationIds.length > 0 && <p>Migrations: {item.migrationIds.join(", ")}</p>}
              <div className="database-comparison">
                <div><h4>Development</h4><pre>{item.devDefinition ?? (coverageComplete ? "Absent" : "Not reported (limited coverage)")}</pre></div>
                <div><h4>Production</h4><pre>{item.productionDefinition ?? (coverageComplete ? "Absent" : "Not reported (limited coverage)")}</pre></div>
              </div>
            </details></td>
          </tr>;
        })}</tbody>
      </table></div>
    </div>
  </details>;
}

function comparisonWarnings(group: SchemaComparisonGroup): string[] {
  if (group.loading || group.error || !group.comparison) return [];
  const { coverage } = group.comparison;
  return coverage.limitations.length > 0 ? coverage.limitations : coverage.complete ? [] : ["Complete schema visibility could not be verified."];
}

function DatabaseGroup({ group, showAll }: { group: SchemaComparisonGroup; showAll: boolean }) {
  const details = useRef<HTMLDetailsElement>(null);
  const { comparison, loading, error } = group;
  const hiddenCount = comparison?.differences.filter(item => hiddenFromReview(item, comparison)).length ?? 0;
  const visibleDifferences = comparison?.differences.filter(item => showAll || !hiddenFromReview(item, comparison)).sort((a, b) => priority(a) - priority(b)) ?? [];
  const ready = !!comparison && !loading && !error;
  // A repeated comparison is a fresh result even when its timestamp or content matches.
  useEffect(() => {
    if (!details.current) return;
    details.current.open = false;
    details.current.querySelectorAll("details").forEach(item => { item.open = false; });
  }, [comparison, loading, error]);

  return <details ref={details} className="database-schema-group" aria-label={`Schema differences for ${group.databaseKey}`}>
    <summary>
      <span className="database-schema-name">{group.databaseKey}</span>
      <span className="database-schema-targets">Dev: {group.devDatabase || "Not configured"} · Production: {group.productionDatabase || "Not configured"}</span>
      <span className="database-schema-counts">{ready ? <>
        <span>{visibleDifferences.length} {visibleDifferences.length === 1 ? "difference" : "differences"}{hiddenCount > 0 ? showAll ? " (all)" : " to review" : ""}</span>
        {!showAll && hiddenCount > 0 && <span>{hiddenCount} hidden</span>}
      </> : <span>{loading ? "Comparing…" : error ? "Comparison failed" : "Not compared"} · difference count unavailable</span>}</span>
    </summary>
    <div className="database-schema-body">
      {loading && <p role="status">Comparing development and production for {group.databaseKey}…</p>}
      {error && !loading && <p className="issue-box">{error}</p>}
      {!comparison && !loading && !error && <p>Compare this database to see its structural differences.</p>}
      {ready && <>
        {visibleDifferences.length === 0 && <p>{hiddenCount > 0 && !showAll ? "No differences to review." : "No differences found in the captured structure."}</p>}
        {groupObjects(visibleDifferences).map(objects => <ObjectDifferences key={objects.key} group={objects} databaseKey={group.databaseKey} coverageComplete={comparison.coverage.complete} engines={comparison.engines} tables={comparison.tableStorageEngines} />)}
      </>}
    </div>
  </details>;
}

export function SchemaDifferences({ groups }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const warningsId = useId();
  const previousGroups = useRef(groups);
  const warningGroups = groups.map(group => ({ group, warnings: comparisonWarnings(group) })).filter(item => item.warnings.length > 0);
  const warningCount = warningGroups.reduce((count, item) => count + item.warnings.length, 0);
  const hiddenCount = groups.reduce((count, group) => count + (!group.loading && !group.error && group.comparison ? group.comparison.differences.filter(item => hiddenFromReview(item, group.comparison!)).length : 0), 0);

  useEffect(() => {
    const previous = previousGroups.current;
    if (groups.length !== previous.length || groups.some((group, index) => {
      const prior = previous[index];
      return !prior || group.databaseKey !== prior.databaseKey || group.comparison !== prior.comparison || group.error !== prior.error || group.loading !== prior.loading;
    })) { setWarningsOpen(false); setShowAll(false); }
    previousGroups.current = groups;
  }, [groups]);

  if (groups.length === 0) return <p>No databases available for comparison. Add development and production targets in Connections.</p>;
  return <div className="database-schema-results">
    {hiddenCount > 0 && <div className="database-review-filter">
      <button type="button" aria-pressed={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? "Hide noise" : `Show all differences (${hiddenCount} hidden)`}</button>
    </div>}
    {warningCount > 0 && <div className="database-schema-warnings">
      <button type="button" className="database-warning-button" aria-expanded={warningsOpen} aria-controls={warningsId} onClick={() => setWarningsOpen(open => !open)}>
        Coverage warnings ({warningCount})
      </button>
      <div id={warningsId} hidden={!warningsOpen} className="database-schema-warning-panel">
        {warningGroups.map(({ group, warnings }) => <section key={group.databaseKey} aria-label={`${group.databaseKey} coverage warnings`}>
          <h3>{group.databaseKey}</h3>
          <ul>{warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
        </section>)}
      </div>
    </div>}
    {groups.map(group => <DatabaseGroup key={group.databaseKey} group={group} showAll={showAll} />)}
  </div>;
}

export default SchemaDifferences;
