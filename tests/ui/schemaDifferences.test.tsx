import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaDifferences, type SchemaComparisonGroup } from "../../src/components/SchemaDifferences.js";
import type { SchemaComparison, SchemaDifference } from "../../src/types/database.js";

afterEach(cleanup);

function comparison(overrides: Partial<SchemaComparison> = {}): SchemaComparison {
  return {
    assessment: "unverified", capturedAt: "2026-10-19T10:00:00.000Z", devSchemaDigest: "dev-digest", productionSchemaDigest: "production-digest",
    coverage: { complete: false, limitations: ["Trigger visibility could not be verified", "Routine visibility could not be verified"], excludedObjectPrefixes: ["db_radar_"] },
    differences: [{ objectType: "table", objectPath: "invoices", devDefinition: '{"TABLE_NAME":"invoices","ENGINE":"InnoDB"}', productionDefinition: '{"TABLE_NAME":"invoices","ENGINE":"MyISAM"}', assessment: "unverified", reason: "Pending migration has not been replayed", migrationIds: ["20261019-add-note"] }],
    ...overrides
  };
}

function group(overrides: Partial<SchemaComparisonGroup> = {}): SchemaComparisonGroup {
  return { databaseKey: "invoicing", devDatabase: "invoicing_dev", productionDatabase: "invoicing_prod", comparison: comparison(), ...overrides };
}

function databaseDetails(key = "invoicing"): HTMLDetailsElement {
  return screen.getByLabelText(`Schema differences for ${key}`) as HTMLDetailsElement;
}

function difference(objectType: SchemaDifference["objectType"], objectPath: string, devDefinition: string | null, productionDefinition: string | null = null, assessment: SchemaDifference["assessment"] = "unverified"): SchemaDifference {
  return { objectType, objectPath, devDefinition, productionDefinition, assessment, reason: `Reason for ${objectPath}`, migrationIds: [`migration-${objectPath}`] };
}

function tableDetails(name: string, databaseKey = "invoicing"): HTMLDetailsElement {
  return screen.getByLabelText(`Table differences for ${name} in ${databaseKey}`) as HTMLDetailsElement;
}

const engines: NonNullable<SchemaComparison["engines"]> = { development: { engine: "mysql", version: "8.0.42" }, production: { engine: "mariadb", version: "10.6.25-MariaDB-log" } };
function columnRow(name: string, type: string) {
  return { TABLE_NAME: "invoices", COLUMN_NAME: name, ORDINAL_POSITION: "1", COLUMN_DEFAULT: null, IS_NULLABLE: "YES", COLUMN_TYPE: type, CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: "", GENERATION_EXPRESSION: null, COLUMN_COMMENT: "" };
}
function representationColumn() {
  return difference("column", "invoices.count", JSON.stringify(columnRow("count", "int")), JSON.stringify(columnRow("count", "int(11)")));
}

describe("Grouped schema differences", () => {
  it("uses one top-level filter across databases and removes table groups containing only hidden differences", () => {
    const quiet = difference("column", "quiet.count", JSON.stringify({ ...columnRow("count", "int"), TABLE_NAME: "quiet" }), JSON.stringify({ ...columnRow("count", "int(11)"), TABLE_NAME: "quiet" }));
    const raw = difference("table", "archived/definition", "CREATE TABLE archived (id INT CHECK (id > 0))", "CREATE TABLE archived (id INT CHECK (id > 10))");
    const actual = difference("column", "invoices.quantity", JSON.stringify(columnRow("quantity", "bigint")), JSON.stringify(columnRow("quantity", "int")));
    render(<SchemaDifferences groups={[
      group({ comparison: comparison({ engines, differences: [quiet, actual] }) }),
      group({ databaseKey: "inventory", comparison: comparison({ differences: [raw] }) })
    ]} />);
    const filter = screen.getByRole("button", { name: "Show all differences (2 hidden)" });
    expect(screen.getAllByRole("button", { name: /Show all differences/ })).toHaveLength(1);
    expect(filter.compareDocumentPosition(databaseDetails()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filter.compareDocumentPosition(databaseDetails("inventory")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("Table differences for quiet in invoicing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Table differences for archived in inventory")).not.toBeInTheDocument();
    fireEvent.click(filter);
    expect(filter).toHaveAccessibleName("Hide noise");
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(tableDetails("quiet")).toBeInTheDocument();
    expect(tableDetails("archived", "inventory")).toBeInTheDocument();
    fireEvent.click(filter);
    expect(screen.queryByLabelText("Table differences for quiet in invoicing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Table differences for archived in inventory")).not.toBeInTheDocument();
    expect(tableDetails("invoices")).toBeInTheDocument();
  });

  it("hides arbitrary two-sided CREATE TABLE SQL as a preference and restores original constraint bytes", () => {
    const raw = difference("table", "invoices/definition", "CREATE TABLE invoices (quantity INT CHECK (quantity > 0))", "CREATE TABLE invoices (quantity INT CHECK (quantity >= 0))");
    const result = comparison({ differences: [raw] });
    const before = JSON.stringify(result);
    render(<SchemaDifferences groups={[group({ comparison: result })]} />);
    expect(screen.queryByLabelText("Table differences for invoices in invoicing")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all differences (1 hidden)" }));
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    const detail = tableDetails("invoices").querySelector("details")!;
    fireEvent.click(detail.querySelector("summary")!);
    expect(within(detail).getByText(raw.devDefinition!)).toBeVisible();
    expect(within(detail).getByText(raw.productionDefinition!)).toBeVisible();
    expect(detail).not.toHaveTextContent(/Representation difference|equivalent|unverified/i);
    expect(JSON.stringify(result)).toBe(before);
  });

  it("hides the reported nullable default and timestamp update spelling together", () => {
    const mysql = { ...columnRow("updated", "timestamp"), EXTRA: "on update CURRENT_TIMESTAMP" };
    const maria = { ...mysql, COLUMN_DEFAULT: "NULL", EXTRA: "on update current_timestamp()" };
    const item = difference("column", "invoices.updated", JSON.stringify(mysql), JSON.stringify(maria));
    render(<SchemaDifferences groups={[group({ comparison: comparison({ engines, differences: [item] }) })]} />);
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("0 differences to review1 hidden");
    expect(screen.queryByLabelText("Table differences for invoices in invoicing")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all differences (1 hidden)" }));
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    expect(screen.getByRole("rowheader", { name: "updated" })).toBeVisible();
  });

  it("prioritizes missing tables, missing columns and actual type changes without engine context", () => {
    const note = difference("column", "invoices.note", JSON.stringify(columnRow("note", "text")));
    const quantity = difference("column", "invoices.quantity", JSON.stringify(columnRow("quantity", "bigint")), JSON.stringify(columnRow("quantity", "int")));
    const metadata = difference("table", "settings", '{"TABLE_NAME":"settings","ENGINE":"InnoDB"}', '{"TABLE_NAME":"settings","ENGINE":"MyISAM"}');
    const added = difference("table", "added/definition", "CREATE TABLE added (id INT)");
    const removed = difference("table", "removed/definition", null, "CREATE TABLE removed (id INT)");
    const result = comparison({ differences: [metadata, quantity, note, added, removed] });
    const before = JSON.stringify(result);
    render(<SchemaDifferences groups={[group({ comparison: result })]} />);
    expect(screen.queryByRole("button", { name: /Show all differences/ })).not.toBeInTheDocument();
    fireEvent.click(databaseDetails().querySelector("summary")!);
    const tables = databaseDetails().querySelectorAll(".database-schema-table");
    expect([...tables].map(item => item.getAttribute("aria-label"))).toEqual([
      "Table differences for added in invoicing", "Table differences for removed in invoicing",
      "Table differences for invoices in invoicing", "Table differences for settings in invoicing"
    ]);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    expect(within(tableDetails("invoices")).getAllByRole("rowheader").map(item => item.textContent)).toEqual(["note", "quantity"]);
    expect(JSON.stringify(result)).toBe(before);
  });

  it("hides the combined reported formatting cases and equivalent raw table SQL while keeping actual changes", () => {
    const count = difference("column", "invoices.count", JSON.stringify(columnRow("count", "int")), JSON.stringify({ ...columnRow("count", "int(11)"), COLUMN_DEFAULT: "NULL" }));
    const timestamp = difference("column", "invoices.updated", JSON.stringify({ ...columnRow("updated", "timestamp"), COLUMN_DEFAULT: "CURRENT_TIMESTAMP", EXTRA: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" }), JSON.stringify({ ...columnRow("updated", "timestamp"), COLUMN_DEFAULT: "current_timestamp()", EXTRA: "on update current_timestamp()" }));
    const fk = { TABLE_NAME: "invoices", CONSTRAINT_NAME: "fk_owner", COLUMN_NAME: "owner_id", ORDINAL_POSITION: "1", REFERENCED_TABLE_NAME: "owners", REFERENCED_COLUMN_NAME: "id", UPDATE_RULE: "NO ACTION", DELETE_RULE: "RESTRICT" };
    const foreignKey = difference("foreign-key", "invoices.fk_owner.1", JSON.stringify(fk), JSON.stringify({ ...fk, UPDATE_RULE: "RESTRICT" }));
    const raw = difference("table", "invoices/definition", "CREATE TABLE `invoices` (`count` int DEFAULT NULL) ENGINE=InnoDB", "CREATE TABLE `invoices` (`count` int(11) DEFAULT NULL) ENGINE=InnoDB");
    const actual = difference("column", "invoices.quantity", JSON.stringify(columnRow("quantity", "bigint")), JSON.stringify(columnRow("quantity", "int")));
    const result = comparison({ engines, tableStorageEngines: [{ tableName: "invoices", development: "InnoDB", production: "InnoDB" }], differences: [count, timestamp, foreignKey, raw, actual] });
    const before = JSON.stringify(result);
    render(<SchemaDifferences groups={[group({ comparison: result })]} />);
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("1 difference to review4 hidden");
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    const list = screen.getByRole("table", { name: "Changes for Table invoices in invoicing" });
    expect(within(list).getAllByRole("row")).toHaveLength(2);
    expect(within(list).getByRole("rowheader", { name: "quantity" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show all differences (4 hidden)" }));
    expect(within(list).getAllByRole("row")).toHaveLength(6);
    expect(within(list).getByRole("rowheader", { name: "count" })).toBeVisible();
    expect(within(list).getByRole("rowheader", { name: "updated" })).toBeVisible();
    expect(within(list).getByRole("rowheader", { name: "foreign-key fk_owner" })).toBeVisible();
    fireEvent.click(within(list).getByRole("rowheader", { name: "table invoices/definition" }).closest("tr")!.querySelector("summary")!);
    expect(within(list).getByText(raw.devDefinition!)).toBeVisible();
    expect(within(list).getByText("table invoices/definition")).toBeVisible();
    expect(within(list).queryByText(/unverified/i)).not.toBeInTheDocument();
    expect(JSON.stringify(result)).toBe(before);
  });
  it("defaults to actual type changes and omits verification and engine clutter", () => {
    const actual = difference("column", "invoices.quantity", JSON.stringify(columnRow("quantity", "bigint")), JSON.stringify(columnRow("quantity", "int")));
    const json = difference("column", "invoices.payload", JSON.stringify(columnRow("payload", "json")), JSON.stringify({ ...columnRow("payload", "longtext"), CHARACTER_SET_NAME: "utf8mb4", COLLATION_NAME: "utf8mb4_bin", COLUMN_DEFAULT: "NULL" }));
    const item = comparison({ engines, differences: [representationColumn(), actual, json] });
    render(<SchemaDifferences groups={[group({ comparison: item })]} />);
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("2 differences to review");
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("1 hidden");
    expect(databaseDetails()).not.toHaveTextContent(/unverified|8\.0\.42|10\.6\.25|Captured|History objects excluded|db_radar_|The list shows detected/i);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    expect(screen.getByRole("rowheader", { name: "quantity" })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "payload" })).toBeVisible();
    expect(screen.queryByRole("rowheader", { name: "count" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all differences (1 hidden)" }));
    expect(screen.getByRole("rowheader", { name: "count" })).toBeVisible();
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("3 differences (all)");
    const details = screen.getByRole("rowheader", { name: "count" }).closest("tr")!.querySelector("summary")!;
    fireEvent.click(details);
    expect(within(details.parentElement!).getByText(/Representation difference:/)).toBeVisible();
    expect(within(details.parentElement!).getByText("column invoices.count")).toBeVisible();
    expect(within(details.parentElement!).queryByText(/unverified|None verified|Reason for/i)).not.toBeInTheDocument();
    expect(item.differences).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Hide noise" }));
    expect(screen.queryByRole("rowheader", { name: "count" })).not.toBeInTheDocument();
  });

  it("omits whole table groups when every difference is hidden and retains coverage warnings", () => {
    render(<SchemaDifferences groups={[group({ comparison: comparison({ engines, differences: [representationColumn()] }) })]} />);
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("0 differences to review");
    expect(screen.queryByLabelText("Table differences for invoices in invoicing")).not.toBeInTheDocument();
    fireEvent.click(databaseDetails().querySelector("summary")!);
    expect(screen.getByText("No differences to review.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Coverage warnings (2)" })).toBeVisible();
  });

  it("keeps uncertain legacy rows visible and resets the filter only for fresh results", () => {
    const original = group({ comparison: comparison({ engines, differences: [representationColumn()] }) });
    const view = render(<SchemaDifferences groups={[original]} />);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Show all differences (1 hidden)" }));
    view.rerender(<SchemaDifferences groups={[{ ...original }]} />);
    expect(screen.getByRole("button", { name: "Hide noise" })).toBeVisible();
    view.rerender(<SchemaDifferences groups={[{ ...original, comparison: { ...original.comparison! } }]} />);
    expect(databaseDetails().open).toBe(false);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    expect(screen.getByRole("button", { name: "Show all differences (1 hidden)" })).toBeVisible();
    view.rerender(<SchemaDifferences groups={[group({ comparison: comparison({ differences: [representationColumn()] }) })]} />);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    expect(screen.getByRole("rowheader", { name: "count" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Show all differences/ })).not.toBeInTheDocument();
  });
  it("shows every column change in a compact table before opening full definitions", () => {
    const quantityDev = JSON.stringify({ TABLE_NAME: "invoices", COLUMN_NAME: "quantity", COLUMN_TYPE: "bigint" });
    const quantityProd = JSON.stringify({ TABLE_NAME: "invoices", COLUMN_NAME: "quantity", COLUMN_TYPE: "int" });
    const noteDev = JSON.stringify({ TABLE_NAME: "invoices", COLUMN_NAME: "note", COLUMN_TYPE: "text" });
    render(<SchemaDifferences groups={[group({ comparison: comparison({ differences: [
      difference("column", "invoices.quantity", quantityDev, quantityProd),
      difference("column", "invoices.note", noteDev)
    ] }) })]} />);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    const list = screen.getByRole("table", { name: "Changes for Table invoices in invoicing" });
    expect(within(list).getByRole("columnheader", { name: "Column / object" })).toBeVisible();
    expect(within(list).getByRole("columnheader", { name: "Difference (production → development)" })).toBeVisible();
    expect(within(list).getAllByRole("row")).toHaveLength(3);
    expect(within(list).getByRole("rowheader", { name: "quantity" })).toBeVisible();
    expect(within(list).getByRole("rowheader", { name: "note" })).toBeVisible();
    const changes = list.querySelectorAll<HTMLDetailsElement>("details");
    expect([...changes].every(item => !item.open)).toBe(true);
    expect(changes[0].querySelector("summary")).toHaveTextContent("Present in development; not reported in production");
    expect(changes[1].querySelector("summary")).toHaveTextContent(/int.*→.*bigint/);
    expect(within(list).getByText(quantityDev)).not.toBeVisible();
    expect(within(list).getByText(quantityProd)).not.toBeVisible();
    expect(screen.queryByText("The list shows detected differences in visible objects. Coverage warnings limit verification of the complete database.")).not.toBeInTheDocument();
    fireEvent.click(changes[1].querySelector("summary")!);
    expect(within(list).getByText(quantityDev)).toBeVisible();
    expect(within(list).getByText(quantityProd)).toBeVisible();
    expect(within(list).getByText("Migrations: migration-invoices.quantity")).toBeVisible();
    expect(within(list).getByText("column invoices.quantity")).toBeVisible();
    fireEvent.click(changes[0].querySelector("summary")!);
    expect(within(list).getByText("Not reported (limited coverage)")).toBeVisible();
  });

  it("uses confirmed absence wording only when schema coverage is complete", () => {
    render(<SchemaDifferences groups={[group({ comparison: comparison({ coverage: { complete: true, limitations: [] }, differences: [
      difference("column", "invoices.note", JSON.stringify({ TABLE_NAME: "invoices", COLUMN_NAME: "note", COLUMN_TYPE: "text" }))
    ] }) })]} />);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    const details = tableDetails("invoices").querySelector("details")!;
    expect(details.querySelector("summary")).toHaveTextContent("Only in development");
    fireEvent.click(details.querySelector("summary")!);
    expect(within(details).getByText("Absent")).toBeVisible();
    expect(within(details).queryByText("Not reported (limited coverage)")).not.toBeInTheDocument();
  });
  it("starts each database, table and object difference collapsed and keeps definitions and attribution available", () => {
    render(<SchemaDifferences groups={[group(), group({ databaseKey: "inventory", comparison: comparison({ assessment: "explained", differences: [], coverage: { complete: true, limitations: [] } }) })]} />);
    const invoicing = databaseDetails();
    const inventory = databaseDetails("inventory");
    expect(invoicing.open).toBe(false);
    expect(inventory.open).toBe(false);
    const summary = invoicing.querySelector("summary")!;
    expect(summary).toHaveTextContent("invoicing");
    expect(summary).toHaveTextContent("Dev: invoicing_dev · Production: invoicing_prod");
    expect(summary).toHaveTextContent("1 difference");
    expect(summary).not.toHaveTextContent(/warnings|unverified/);
    expect(inventory.querySelector("summary")).toHaveTextContent("0 differences");
    expect(inventory.querySelector("summary")).not.toHaveTextContent(/warnings|explained/);
    fireEvent.click(summary);
    expect(invoicing.open).toBe(true);
    const table = tableDetails("invoices");
    expect(table.open).toBe(false);
    expect(table.querySelector("summary")).toHaveTextContent("Table invoices1 difference");
    fireEvent.click(table.querySelector("summary")!);
    const object = table.querySelector("details")!;
    expect(object.open).toBe(false);
    expect(within(invoicing).getByText('{"TABLE_NAME":"invoices","ENGINE":"InnoDB"}')).not.toBeVisible();
    fireEvent.click(object.querySelector("summary")!);
    expect(object.open).toBe(true);
    expect(within(invoicing).getByText('{"TABLE_NAME":"invoices","ENGINE":"InnoDB"}')).toBeVisible();
    expect(within(invoicing).getByText('{"TABLE_NAME":"invoices","ENGINE":"MyISAM"}')).toBeVisible();
    expect(within(invoicing).queryByText("Pending migration has not been replayed")).not.toBeInTheDocument();
    expect(within(invoicing).getByText("Migrations: 20261019-add-note")).toBeVisible();
    fireEvent.click(summary);
    expect(invoicing.open).toBe(false);
  });

  it("puts coverage warnings behind an accessible red toggle with per-database attribution", () => {
    render(<SchemaDifferences groups={[group(), group({ databaseKey: "inventory", comparison: comparison({ coverage: { complete: false, limitations: ["Scheduled-event visibility could not be verified"] } }) })]} />);
    const button = screen.getByRole("button", { name: "Coverage warnings (3)" });
    expect(button).toHaveClass("database-warning-button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeVisible();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(screen.getByRole("region", { name: "invoicing coverage warnings" })).toHaveTextContent("Trigger visibility could not be verified");
    expect(screen.getByRole("region", { name: "inventory coverage warnings" })).toHaveTextContent("Scheduled-event visibility could not be verified");
    expect(databaseDetails().open).toBe(false);
    fireEvent.click(button);
    expect(panel).not.toBeVisible();
  });

  it("collapses database, table, object and warning panels for fresh results even with identical timestamps and contents", () => {
    const original = group();
    const view = render(<SchemaDifferences groups={[original]} />);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("summary")!);
    fireEvent.click(tableDetails("invoices").querySelector("details")!.querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Coverage warnings (2)" }));
    expect(databaseDetails().open).toBe(true);
    // Ordinary parent renders keep the user's expanded state.
    view.rerender(<SchemaDifferences groups={[{ ...original }]} />);
    expect(databaseDetails().open).toBe(true);
    expect(tableDetails("invoices").open).toBe(true);
    expect(tableDetails("invoices").querySelector("details")!.open).toBe(true);
    expect(screen.getByRole("button", { name: "Coverage warnings (2)" })).toHaveAttribute("aria-expanded", "true");
    view.rerender(<SchemaDifferences groups={[group()]} />);
    expect(databaseDetails().open).toBe(false);
    expect(tableDetails("invoices").open).toBe(false);
    expect(tableDetails("invoices").querySelector("details")!.open).toBe(false);
    expect(screen.getByRole("button", { name: "Coverage warnings (2)" })).toHaveAttribute("aria-expanded", "false");
  });

  it("collects table, column, index, foreign-key and trigger changes under their owning table without assessment badges", () => {
    const definitions = [
      difference("column", "invoices.note", JSON.stringify({ TABLE_NAME: "invoices", COLUMN_NAME: "note" })),
      difference("index", "invoices.ix_note.1", JSON.stringify({ TABLE_NAME: "invoices", INDEX_NAME: "ix_note" }), null, "explained"),
      difference("foreign-key", "invoices.fk_customer.1", JSON.stringify({ TABLE_NAME: "invoices", CONSTRAINT_NAME: "fk_customer" }), null, "unexplained"),
      difference("table", "invoices", "CREATE TABLE invoices (note TEXT)"),
      difference("trigger", "invoice_update", JSON.stringify({ EVENT_OBJECT_TABLE: "invoices", TRIGGER_NAME: "invoice_update" })),
      difference("column", "customers.name", JSON.stringify({ TABLE_NAME: "customers", COLUMN_NAME: "name" }))
    ];
    render(<SchemaDifferences groups={[group({ comparison: comparison({ differences: definitions }) })]} />);
    fireEvent.click(databaseDetails().querySelector("summary")!);
    const invoices = tableDetails("invoices");
    const customers = tableDetails("customers");
    expect(invoices.open).toBe(false);
    expect(customers.open).toBe(false);
    expect(invoices.querySelector("summary")).toHaveTextContent("Table invoices5 differences");
    expect(customers.querySelector("summary")).toHaveTextContent("Table customers1 difference");
    expect(invoices.querySelectorAll("details")).toHaveLength(5);
    expect(customers.querySelectorAll("details")).toHaveLength(1);
    fireEvent.click(invoices.querySelector("summary")!);
    for (const object of invoices.querySelectorAll("details")) fireEvent.click(object.querySelector("summary")!);
    for (const item of definitions.slice(0, 5)) {
      expect(within(invoices).getByText(`${item.objectType} ${item.objectPath}`)).toBeVisible();
      expect(within(invoices).queryByText(item.reason)).not.toBeInTheDocument();
      expect(within(invoices).getByText(`Migrations: ${item.migrationIds.join(", ")}`)).toBeVisible();
      expect(within(invoices).getByText(item.devDefinition!)).toBeVisible();
    }
    expect(customers.open).toBe(false);
  });

  it("uses either available side for added or removed tables and preserves dotted identifier ownership", () => {
    const dev = JSON.stringify({ TABLE_NAME: "audit.chunks", COLUMN_NAME: "change.set.id" });
    const prod = JSON.stringify({ TABLE_NAME: "audit.chunks", INDEX_NAME: "ix.change.set" });
    render(<SchemaDifferences groups={[group({ comparison: comparison({ differences: [
      difference("table", "audit.chunks", "CREATE TABLE `audit.chunks` (`change.set.id` INT)"),
      difference("column", "audit.chunks.change.set.id", dev),
      difference("index", "audit.chunks.ix.change.set.1", null, prod),
      difference("table", "removed.table", null, "CREATE TABLE `removed.table` (id INT)"),
      difference("column", "removed.table.id", null, JSON.stringify({ TABLE_NAME: "removed.table", COLUMN_NAME: "id" })),
      difference("trigger", "removed_trigger", null, JSON.stringify({ EVENT_OBJECT_TABLE: "removed.table" }))
    ] }) })]} />);
    expect(tableDetails("audit.chunks").querySelector("summary")).toHaveTextContent("3 differences");
    expect(tableDetails("removed.table").querySelector("summary")).toHaveTextContent("3 differences");
    expect(screen.queryByLabelText("Table differences for audit in invoicing")).not.toBeInTheDocument();
    fireEvent.click(databaseDetails().querySelector("summary")!);
    fireEvent.click(tableDetails("audit.chunks").querySelector("summary")!);
    const removedIndex = within(tableDetails("audit.chunks")).getByText("index audit.chunks.ix.change.set.1").closest("details")!;
    fireEvent.click(removedIndex.querySelector("summary")!);
    expect(within(removedIndex).getByText("Not reported (limited coverage)")).toBeVisible();
    expect(within(removedIndex).getByText(prod)).toBeVisible();
  });

  it("groups real table metadata and SHOW CREATE definitions with columns, including slashes in table names", () => {
    const changes = ["items", "audit.chunks", "a/definition"].flatMap(table => [
      difference("table", table, JSON.stringify({ TABLE_NAME: table, ENGINE: "InnoDB" })),
      difference("table", `${table}/definition`, `CREATE TABLE \`${table}\` (id INT)`),
      difference("column", `${table}.id`, JSON.stringify({ TABLE_NAME: table, COLUMN_NAME: "id" }))
    ]);
    render(<SchemaDifferences groups={[group({ comparison: comparison({ differences: changes }) })]} />);
    for (const table of ["items", "audit.chunks", "a/definition"]) {
      const objects = tableDetails(table);
      expect(objects.querySelector("summary")).toHaveTextContent(`Table ${table}3 differences`);
      expect(objects.querySelectorAll("details")).toHaveLength(3);
    }
    expect(screen.queryByLabelText("Table differences for items/definition in invoicing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Table differences for a in invoicing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Table differences for a/definition/definition in invoicing")).not.toBeInTheDocument();
  });

  it("keeps views, routines and uncertain table ownership in separate named groups without guessing from paths", () => {
    render(<SchemaDifferences groups={[group({ comparison: comparison({ differences: [
      difference("view", "invoices", "CREATE VIEW invoices AS SELECT 1"),
      difference("routine", "PROCEDURE.rebuild", JSON.stringify({ TABLE_NAME: "invoices", ROUTINE_NAME: "rebuild" })),
      difference("column", "invoices.note", "not JSON"),
      difference("column", "ambiguous.table.column.name", JSON.stringify({ COLUMN_NAME: "column.name" })),
      difference("column", "conflicting.note", JSON.stringify({ TABLE_NAME: "invoices" }), JSON.stringify({ TABLE_NAME: "customers" })),
      difference("index", "invoices.ix.1", "[]"),
      difference("foreign-key", "invoices.fk.1", JSON.stringify({ TABLE_NAME: 2 })),
      difference("trigger", "invoice_update", "null")
    ] }) })]} />);
    expect(screen.queryByLabelText("Table differences for invoices in invoicing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Table differences for ambiguous in invoicing")).not.toBeInTheDocument();
    const columns = screen.getByLabelText("Columns (table unknown) differences in invoicing");
    expect(columns.querySelector("summary")).toHaveTextContent("3 differences");
    for (const label of ["Views", "Routines", "Indexes (table unknown)", "Foreign keys (table unknown)", "Triggers (table unknown)"]) {
      const objects = screen.getByLabelText(`${label} differences in invoicing`) as HTMLDetailsElement;
      expect(objects.open).toBe(false);
      expect(objects.querySelector("summary")).toHaveTextContent("1 difference");
    }
  });

  it("keeps failed, loading and uncompared counts unavailable instead of presenting zero differences", () => {
    render(<SchemaDifferences groups={[
      group({ databaseKey: "failed", error: "Inspection account cannot connect" }),
      group({ databaseKey: "loading", loading: true }),
      group({ databaseKey: "waiting", comparison: undefined, devDatabase: undefined })
    ]} />);
    expect(databaseDetails("failed").querySelector("summary")).toHaveTextContent("Comparison failed · difference count unavailable");
    expect(databaseDetails("loading").querySelector("summary")).toHaveTextContent("Comparing… · difference count unavailable");
    expect(databaseDetails("waiting").querySelector("summary")).toHaveTextContent("Not compared · difference count unavailable");
    expect(databaseDetails("waiting").querySelector("summary")).toHaveTextContent("Dev: Not configured");
    expect(screen.queryByRole("button", { name: /Coverage warnings/ })).not.toBeInTheDocument();
    fireEvent.click(databaseDetails("failed").querySelector("summary")!);
    expect(screen.getByText("Inspection account cannot connect")).toBeVisible();
    expect(screen.queryByText(/0 differences/)).not.toBeInTheDocument();
  });

  it("retains incomplete-coverage warnings without an unverified badge or capture clutter", () => {
    render(<SchemaDifferences groups={[group({ comparison: comparison({ differences: [], coverage: { complete: false, limitations: [] } }) })]} />);
    expect(databaseDetails().querySelector("summary")).toHaveTextContent("0 differences");
    expect(databaseDetails()).not.toHaveTextContent(/unverified|Captured|History objects excluded/);
    fireEvent.click(screen.getByRole("button", { name: "Coverage warnings (1)" }));
    expect(screen.getByText("Complete schema visibility could not be verified.")).toBeVisible();
    fireEvent.click(databaseDetails().querySelector("summary")!);
    expect(screen.getByText("No differences found in the captured structure.")).toBeVisible();
  });

  it("shows an explicit empty state when there are no configured databases", () => {
    render(<SchemaDifferences groups={[]} />);
    expect(screen.getByText("No databases available for comparison. Add development and production targets in Connections.")).toBeVisible();
  });
});
