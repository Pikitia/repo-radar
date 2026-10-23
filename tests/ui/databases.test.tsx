import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSettings } from "../../src/components/DatabaseSettings.js";
import { Databases } from "../../src/components/Databases.js";
import { App } from "../../src/app/App.js";
import { defaultSettings } from "../../src/types/settings.js";
import type { DatabaseDesktopApi, DatabaseOverview } from "../../src/types/databaseApi.js";
import type { DatabaseProfile, DatabaseServer, DatabaseServerDetails, SchemaComparison } from "../../src/types/database.js";
import type { RepoRadarApi } from "../../src/types/api.js";

const server: DatabaseServer = { id: "shared-server", label: "Shared database server", host: "databases.invalid", port: 3306, tlsMode: "disabled", hasInspectionCredentials: true, hasMigrationCredentials: false, hasDiagnosticCredentials: false };
const serverDetails: DatabaseServerDetails = { ...server, credentialUsernames: { inspection: "reader" } };
const dev: DatabaseProfile = { id: "dev", databaseKey: "catalog", label: "Catalog development", environment: "dev", serverConnectionId: server.id, database: "catalog_dev", hasInspectionCredentials: true, hasMigrationCredentials: false, hasDiagnosticCredentials: false };
const production: DatabaseProfile = { ...dev, id: "prod", database: "catalog_prod", label: "Catalog production", environment: "production" };
const overview: DatabaseOverview = { servers: [server], profiles: [dev, production], proposals: [], releases: [], rehearsals: [], activeRun: null, lastRun: null };
let api: DatabaseDesktopApi;
beforeEach(() => {
  api = {
    setMcpReadAccess: vi.fn(),
    checkServerConnection: vi.fn().mockResolvedValue({ status: "verified" }),
    verifyTargets: vi.fn().mockImplementation(async ids => ids.map((profileId: string) => ({ profileId, status: "verified" }))), overview: vi.fn().mockResolvedValue(overview), saveServerConnection: vi.fn().mockResolvedValue(server), getServerConnection: vi.fn().mockResolvedValue(serverDetails), saveServerCredentials: vi.fn().mockResolvedValue(undefined), discoverDatabases: vi.fn().mockResolvedValue({ serverConnectionId: server.id, databases: [] }), assignDatabases: vi.fn().mockResolvedValue([]), saveProfile: vi.fn().mockResolvedValue(dev), saveCredentials: vi.fn().mockResolvedValue(undefined), inspect: vi.fn(), acceptIdentity: vi.fn(), compare: vi.fn(), importProposal: vi.fn(), sealRelease: vi.fn(), history: vi.fn().mockResolvedValue({ enrolled: false, digest: "history", events: [] }),
    createPlan: vi.fn().mockResolvedValue({ planId: "plan", targetId: "dev", environment: "dev", releaseDigest: "release-digest", migrationIds: [], direction: "up", kind: "enroll", historyDigest: "history-digest", beforeSchemaDigest: "schema-digest", expiresAt: new Date(Date.now() + 60_000).toISOString(), recoveryEvidenceIds: [], statementCount: 2 }),
    runPlan: vi.fn().mockResolvedValue({ planId: "plan", state: "succeeded", attemptIds: [] }), rehearse: vi.fn(), exportLibrary: vi.fn(), importLibrary: vi.fn(), configureDiagnostics: vi.fn().mockResolvedValue({ instructions: "Start the isolated dev MCP entry point" }), recordRestoreVerification: vi.fn().mockResolvedValue({ evidenceIds: [] })
  };
  window.repoRadar = { databases: api, getDatabaseMcpStatus: vi.fn().mockResolvedValue({ enabled: true, running: true, url: "http://127.0.0.1:47321/mcp" }), copyDatabaseMcpConfig: vi.fn().mockResolvedValue(undefined) } as unknown as RepoRadarApi;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const props = { active: true, root: "C:/fixtures", repos: [], onOpenRepository: vi.fn() };
const comparisonFixture = (key: string): SchemaComparison => ({ assessment: "unverified", capturedAt: "2026-10-19T00:00:00.000Z", devSchemaDigest: `${key}-dev`, productionSchemaDigest: `${key}-prod`, differences: [{ objectType: "column", objectPath: `${key}_items.amount`, devDefinition: "bigint", productionDefinition: "int", assessment: "unverified", migrationIds: [], reason: `${key} difference needs verification` }], coverage: { complete: false, limitations: [`${key} routine visibility incomplete`] } });
function installComparisonPairs() {
  vi.mocked(api.overview).mockResolvedValue({ ...overview, profiles: [...overview.profiles, { ...dev, id: "orders-dev", label: "Orders development", databaseKey: "orders", database: "orders_dev" }, { ...production, id: "orders-prod", label: "Orders production", databaseKey: "orders", database: "orders_prod" }] });
}

describe("Database view", () => {
  it("does not offer a comparison for a database configured only as a sandbox", async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...overview, profiles: [{ ...dev, id: "sandbox-only", databaseKey: "scratch", label: "Scratch", environment: "sandbox" }] });
    render(<Databases {...props} />);
    await waitFor(() => expect(screen.getByLabelText("Logical database")).toHaveValue("scratch"));
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    expect(screen.getByRole("button", { name: "Compare development and production" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compare all databases" })).toBeDisabled();
    expect(api.compare).not.toHaveBeenCalled();
  });
  it("compares database groups only on request and preserves results when the selected logical database changes", async () => {
    installComparisonPairs();
    vi.mocked(api.compare).mockImplementation(async key => comparisonFixture(key));
    render(<Databases {...props} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    expect(api.compare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Compare all databases" }));
    await waitFor(() => expect(api.compare).toHaveBeenCalledTimes(2));
    expect(api.compare).toHaveBeenNthCalledWith(1, "catalog");
    expect(api.compare).toHaveBeenNthCalledWith(2, "orders");
    await waitFor(() => expect(screen.getByRole("button", { name: "Compare all databases" })).toBeEnabled());
    expect(screen.getByLabelText("Schema differences for catalog")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Schema differences for orders")).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("Logical database"), { target: { value: "orders" } });
    expect(screen.getByText("column catalog_items.amount")).toBeInTheDocument();
    expect(screen.getByText("column orders_items.amount")).toBeInTheDocument();
    expect(api.compare).toHaveBeenCalledTimes(2);
    expect(api.runPlan).not.toHaveBeenCalled();
    expect(api.acceptIdentity).not.toHaveBeenCalled();
  });
  it("keeps fresh comparisons when initial identities are bound but invalidates a changed established identity", async () => {
    const identity = { fingerprint: "initial", engine: "mariadb", version: "fixture", database: "catalog_dev", settings: {} } as NonNullable<DatabaseProfile["identity"]>;
    let current = overview;
    vi.mocked(api.overview).mockImplementation(async () => current);
    vi.mocked(api.compare).mockImplementation(async key => { current = { ...overview, profiles: [{ ...dev, identity }, production] }; return comparisonFixture(key); });
    render(<Databases {...props} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare all databases" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Compare all databases" })).toBeEnabled());
    expect(screen.getByText("column catalog_items.amount")).toBeInTheDocument();
    current = { ...current, profiles: [{ ...dev, identity: { ...identity, fingerprint: "changed" } }, production] };
    fireEvent.click(screen.getByRole("button", { name: "Refresh databases" }));
    await waitFor(() => expect(screen.queryByText("column catalog_items.amount")).not.toBeInTheDocument());
  });
  it("continues comparing other databases after a failure and retries only the selected group", async () => {
    installComparisonPairs();
    vi.mocked(api.compare).mockImplementation(async key => { if (key === "catalog") throw new Error("Accept Catalog production identity first"); return comparisonFixture(key); });
    render(<Databases {...props} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare all databases" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Comparison failed for catalog");
    expect(screen.getByText("Accept Catalog production identity first")).toBeInTheDocument();
    expect(screen.getByText("column orders_items.amount")).toBeInTheDocument();
    vi.mocked(api.compare).mockResolvedValue(comparisonFixture("catalog"));
    fireEvent.click(screen.getByRole("button", { name: "Compare development and production" }));
    await waitFor(() => expect(api.compare).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "Compare all databases" })).toBeEnabled());
    expect(api.compare).toHaveBeenLastCalledWith("catalog");
    expect(screen.getByText("column orders_items.amount")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("discards stale comparison results and stops queued databases when the repository root changes", async () => {
    installComparisonPairs();
    let finish!: (value: SchemaComparison) => void;
    vi.mocked(api.compare).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Databases {...props} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare all databases" }));
    await waitFor(() => expect(api.compare).toHaveBeenCalledOnce());
    view.rerender(<Databases {...props} root="C:/different-root" />);
    await act(async () => { finish(comparisonFixture("catalog")); });
    expect(screen.queryByText("column catalog_items.amount")).not.toBeInTheDocument();
    expect(api.compare).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Compare all databases" })).toBeEnabled();
  });
  it("links the main Databases tab and keeps Git and CI usable after a database failure", async () => {
    vi.mocked(api.overview).mockRejectedValue(new Error("Database setup failed"));
    window.repoRadar = { databases: api, getSettings: vi.fn().mockResolvedValue({ ...defaultSettings, rootFolder: "C:/fixtures", refreshIntervalMinutes: 0 }), discoverRepositories: vi.fn().mockResolvedValue([]), onNpmCommandEvent: vi.fn().mockReturnValue(() => undefined) } as unknown as RepoRadarApi;
    render(<App />);
    const tab = screen.getByRole("tab", { name: "Databases" });
    expect(tab).toHaveAttribute("aria-controls", "databases-view");
    expect(api.overview).not.toHaveBeenCalled();
    fireEvent.click(tab);
    expect(await screen.findByRole("alert")).toHaveTextContent("Database setup failed");
    expect(screen.getByRole("tabpanel", { name: "Databases" })).toHaveAttribute("aria-labelledby", "databases-tab");
    fireEvent.click(screen.getByRole("tab", { name: "Repositories" }));
    expect(screen.getByRole("tabpanel", { name: "Repositories" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "CI Watch" }));
    expect(screen.getByRole("tabpanel", { name: "CI Watch" })).toBeVisible();
    expect(api.runPlan).not.toHaveBeenCalled();
  });
  it("loads on activation, preserves sections while hidden and pauses background polling", async () => {
    vi.useFakeTimers();
    const view = render(<Databases {...props} active={false} />);
    expect(api.overview).not.toHaveBeenCalled();
    view.rerender(<Databases {...props} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.overview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    view.rerender(<Databases {...props} active={false} />);
    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(api.overview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "History and reviewed execution" })).toBeInTheDocument();
    view.rerender(<Databases {...props} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.overview).toHaveBeenCalledTimes(2);
    expect(api.runPlan).not.toHaveBeenCalled();
  });
  it("contains setup failures and leaves section navigation usable", async () => {
    vi.mocked(api.overview).mockRejectedValue(new Error("Protected storage unavailable"));
    render(<Databases {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Protected storage unavailable");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("button", { name: "Review execution plan" })).toBeInTheDocument();
    expect(api.runPlan).not.toHaveBeenCalled();
    expect(api.inspect).not.toHaveBeenCalled();
  });
  it("writes credentials once, clears the password and prevents production diagnostics", async () => {
    render(<DatabaseSettings mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Server connections" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Read-only inspection credentials" }));
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveValue("reader"));
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "local-reader" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-not-returned" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(api.saveServerCredentials).toHaveBeenCalledWith(server.id, "inspection", { username: "local-reader", password: "secret-not-returned" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByText("secret-not-returned")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save credentials" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Edit Catalog production" }));
    fireEvent.click(screen.getByText("Development MCP access"));
    expect(screen.getByRole("button", { name: "Configure dev-only MCP" })).toBeDisabled();
    expect(api.configureDiagnostics).not.toHaveBeenCalled();
  });
  it("loads saved server and target fields for editing and saves them independently", async () => {
    render(<DatabaseSettings mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Server connections" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Catalog development" }));
    await waitFor(() => expect(screen.getByLabelText("Host")).toHaveValue("databases.invalid"));
    expect(screen.getByLabelText("Port")).toHaveValue(3306);
    expect(screen.getByLabelText("Server label")).toHaveValue(server.label);
    expect(screen.getByLabelText("TLS")).toHaveValue("disabled");
    expect(screen.getByLabelText("Database name")).toHaveValue("catalog_dev");
    expect(screen.getByLabelText("Target label")).toHaveValue("Catalog development");
    expect(screen.getByLabelText("Database key")).toHaveValue("catalog");
    expect(screen.getByLabelText("Target server connection")).toHaveValue(server.id);
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "replacement.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server connection" }));
    await waitFor(() => expect(api.saveServerConnection).toHaveBeenCalledWith({ id: server.id, label: server.label, host: "replacement.invalid", port: 3306, tlsMode: "disabled", tlsCa: undefined }));
    expect(api.saveProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save database target" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Edit Catalog production" }));
    expect(screen.getByLabelText("Database name")).toHaveValue("catalog_prod");
    expect(screen.getByLabelText("Environment")).toHaveValue("production");
    fireEvent.change(screen.getByLabelText("Target label"), { target: { value: "Live catalog" } });
    fireEvent.click(screen.getByRole("button", { name: "Save database target" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith({ id: "prod", serverConnectionId: server.id, database: "catalog_prod", databaseKey: "catalog", label: "Live catalog", environment: "production" }));
  });
  it("keeps saved passwords write-only and omits an unchanged password on save", async () => {
    render(<DatabaseSettings mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Server connections" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Read-only inspection credentials" }));
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveValue("reader"));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Leave blank to keep saved password");
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(api.saveServerCredentials).toHaveBeenCalledWith(server.id, "inspection", { username: "reader" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save credentials" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "another-reader" } });
    expect(screen.getByLabelText("Password")).toBeRequired();
  });
  it("defaults new server connections to TLS off and allows verified TLS without a custom authority", async () => {
    render(<DatabaseSettings mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Server connections" });
    fireEvent.click(screen.getByRole("button", { name: "Add server connection" }));
    expect(screen.getByLabelText("TLS")).toHaveValue("disabled");
    expect(screen.getByLabelText("Host")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Server label"), { target: { value: "Future TLS server" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "secure.invalid" } });
    fireEvent.change(screen.getByLabelText("TLS"), { target: { value: "verify" } });
    expect(screen.getByLabelText("TLS certificate authority (PEM, optional)")).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "Save server connection" }));
    await waitFor(() => expect(api.saveServerConnection).toHaveBeenCalledWith({ label: "Future TLS server", host: "secure.invalid", port: 3306, tlsMode: "verify", tlsCa: undefined }));
  });
  it("discovers shared-server databases and assigns only selected unassigned names with explicit environments", async () => {
    vi.mocked(api.discoverDatabases).mockResolvedValue({ serverConnectionId: server.id, databases: [
      { database: "catalog_dev", assigned: true, profileIds: [dev.id] },
      { database: "orders_dev", assigned: false, profileIds: [] },
      { database: "stock_prod", assigned: false, profileIds: [] }
    ] });
    vi.mocked(api.assignDatabases).mockResolvedValue([{ ...dev, id: "orders", databaseKey: "orders", label: "Orders development", database: "orders_dev" }]);
    render(<DatabaseSettings mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Server connections" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rescan databases" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Rescan databases" }));
    await screen.findByLabelText("Assign orders_dev");
    expect(screen.queryByLabelText("Assign catalog_dev")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all unassigned" }));
    expect(screen.getByLabelText("Assign orders_dev")).toBeChecked();
    expect(screen.getByLabelText("Assign stock_prod")).toBeChecked();
    expect(screen.getByRole("button", { name: "Assign selected databases" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Environment for selected databases"), { target: { value: "dev" } });
    expect(screen.getByLabelText("Environment for orders_dev")).toHaveValue("dev");
    fireEvent.click(screen.getByLabelText("Assign stock_prod"));
    fireEvent.change(screen.getByLabelText("Database key for orders_dev"), { target: { value: "orders" } });
    fireEvent.change(screen.getByLabelText("Target label for orders_dev"), { target: { value: "Orders development" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign selected databases" }));
    await waitFor(() => expect(api.assignDatabases).toHaveBeenCalledWith(server.id, [{ serverConnectionId: server.id, database: "orders_dev", databaseKey: "orders", label: "Orders development", environment: "dev" }]));
    await waitFor(() => expect(api.verifyTargets).toHaveBeenCalledWith(["orders"]));
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.createPlan).not.toHaveBeenCalled();
    expect(api.runPlan).not.toHaveBeenCalled();
  });
  it("clears comparison, history, plan and migration selection after a configuration revision with unchanged targets", async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...overview, releases: [{ formatVersion: 1, databaseKey: "catalog", releaseId: "release", parentReleaseDigest: null, digest: "release-digest", migrations: [{ sequence: 1, id: "add-items", contentDigest: "content", proposalId: "proposal" }] }] });
    vi.mocked(api.compare).mockResolvedValue(comparisonFixture("catalog"));
    const view = render(<Databases {...props} configurationVersion={0} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare all databases" }));
    await screen.findByText("column catalog_items.amount");
    await waitFor(() => expect(screen.getByRole("button", { name: "Compare all databases" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Load target history" }));
    await screen.findByText("History digest: history");
    await waitFor(() => expect(screen.getByRole("button", { name: "Review execution plan" })).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: /add-items/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review execution plan" }));
    await screen.findByRole("article", { name: "Reviewed migration plan" });
    view.rerender(<Databases {...props} configurationVersion={1} />);
    expect(screen.queryByRole("article", { name: "Reviewed migration plan" })).not.toBeInTheDocument();
    expect(screen.queryByText("History digest: history")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /add-items/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    expect(screen.queryByText("column catalog_items.amount")).not.toBeInTheDocument();
  });
  it("suppresses pending comparison results after a configuration revision", async () => {
    installComparisonPairs();
    let finish!: (value: SchemaComparison) => void;
    vi.mocked(api.compare).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Databases {...props} configurationVersion={0} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "Schema differences" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare all databases" }));
    await waitFor(() => expect(api.compare).toHaveBeenCalledOnce());
    view.rerender(<Databases {...props} configurationVersion={1} />);
    await act(async () => { finish(comparisonFixture("catalog")); });
    expect(screen.queryByText("column catalog_items.amount")).not.toBeInTheDocument();
    expect(api.compare).toHaveBeenCalledOnce();
  });
  it.each(["history", "plan"] as const)("suppresses pending %s after a configuration revision", async operation => {
    let finish!: () => void;
    if (operation === "history") {
      vi.mocked(api.history).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ enrolled: false, digest: "stale-history", events: [] }); }));
    } else {
      const stalePlan = await api.createPlan({ profileId: dev.id, kind: "enroll", direction: "up", migrationIds: [] });
      vi.mocked(api.createPlan).mockImplementation(() => new Promise(resolve => { finish = () => resolve(stalePlan); }));
    }
    const view = render(<Databases {...props} configurationVersion={0} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: operation === "history" ? "Load target history" : "Review execution plan" }));
    view.rerender(<Databases {...props} configurationVersion={1} />);
    await act(async () => { finish(); });
    expect(screen.queryByText("History digest: stale-history")).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Reviewed migration plan" })).not.toBeInTheDocument();
  });
  it("requires explicit plan review and Run and invalidates plans when the selected target changes", async () => {
    render(<Databases {...props} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(api.createPlan).not.toHaveBeenCalled();
    expect(api.runPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review execution plan" }));
    await screen.findByRole("article", { name: "Reviewed migration plan" });
    expect(screen.getByText("schema-digest")).toBeInTheDocument();
    expect(api.runPlan).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Database target"), { target: { value: "prod" } });
    expect(screen.queryByRole("button", { name: "Run reviewed plan" })).not.toBeInTheDocument();
    expect(api.runPlan).not.toHaveBeenCalled();
  });
  it("does not duplicate a run and reports completion to the application footer", async () => {
    const onMessage = vi.fn();
    let finish: ((value: Awaited<ReturnType<DatabaseDesktopApi["runPlan"]>>) => void) | undefined;
    vi.mocked(api.runPlan).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<Databases {...props} onMessage={onMessage} />);
    await screen.findByText("Catalog development");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Review execution plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run reviewed plan" }));
    expect(api.runPlan).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("operation started"));
    await act(async () => { finish?.({ planId: "plan", state: "uncertain", attemptIds: [] }); });
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("uncertain"));
    expect(api.runPlan).toHaveBeenCalledTimes(1);
  });
});

