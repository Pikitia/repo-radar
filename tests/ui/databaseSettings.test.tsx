import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSettings } from "../../src/components/DatabaseSettings.js";
import { SettingsDialog } from "../../src/components/SettingsDialog.js";
import { Databases } from "../../src/components/Databases.js";
import type { DatabaseDesktopApi, DatabaseOverview } from "../../src/types/databaseApi.js";
import type { DatabaseProfile, DatabaseServer, SchemaSnapshot } from "../../src/types/database.js";
import type { RepoRadarApi } from "../../src/types/api.js";
import { defaultSettings } from "../../src/types/settings.js";

const server: DatabaseServer = { id: "shared", label: "Shared server", host: "fixture.invalid", port: 3306, tlsMode: "disabled", hasInspectionCredentials: true, hasMigrationCredentials: false, hasDiagnosticCredentials: false };
const dev: DatabaseProfile = { id: "catalog-dev", databaseKey: "catalog", label: "Catalog dev", environment: "dev", serverConnectionId: server.id, database: "catalog_dev", hasInspectionCredentials: true, hasMigrationCredentials: false, hasDiagnosticCredentials: false };
const prod: DatabaseProfile = { ...dev, id: "orders-prod", databaseKey: "orders", label: "Orders live", environment: "production", database: "orders_prod" };
const overview: DatabaseOverview = { servers: [server], profiles: [dev, prod], proposals: [], releases: [], rehearsals: [], activeRun: null, lastRun: null };
let api: DatabaseDesktopApi;
let desktop: RepoRadarApi;
beforeEach(() => {
  api = {
    overview: vi.fn().mockResolvedValue(overview), getServerConnection: vi.fn().mockResolvedValue({ ...server, credentialUsernames: { inspection: "reader" } }),
    saveProfile: vi.fn().mockImplementation(async profile => profile), saveServerConnection: vi.fn().mockResolvedValue(server), saveServerCredentials: vi.fn().mockResolvedValue(undefined),
    verifyTargets: vi.fn().mockImplementation(async ids => ids.map((profileId: string) => ({ profileId, status: "verified" }))),
    checkServerConnection: vi.fn().mockResolvedValue({ status: "verified" }), discoverDatabases: vi.fn(), assignDatabases: vi.fn(), configureDiagnostics: vi.fn(), inspect: vi.fn(), acceptIdentity: vi.fn().mockResolvedValue(undefined)
  } as unknown as DatabaseDesktopApi;
  desktop = {
    databases: api, getSettings: vi.fn().mockResolvedValue(defaultSettings), getDebugInfo: vi.fn().mockResolvedValue({ gitPath: "git", version: "fixture" }),
    updateSettings: vi.fn().mockImplementation(async value => value), getDatabaseMcpStatus: vi.fn().mockResolvedValue({ enabled: true, running: true, url: "http://127.0.0.1:47321/mcp" }),
    copyDatabaseMcpConfig: vi.fn().mockResolvedValue(undefined)
  } as unknown as RepoRadarApi;
  window.repoRadar = desktop;
});
afterEach(cleanup);
const panel = () => <DatabaseSettings mcpEnabled onMcpEnabledChange={vi.fn()} />;
async function clickReady(name: string) {
  await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("Independent database settings", () => {
  it("opens server and database editing in dialogs and closes them without saving drafts", async () => {
    render(panel());
    await clickReady("Edit connection");
    const connectionDialog = screen.getByRole("dialog", { name: "Edit server connection" });
    expect(within(connectionDialog).getByRole("form", { name: "Server connection settings" })).toBeInTheDocument();
    fireEvent.change(within(connectionDialog).getByLabelText("Host"), { target: { value: "unsaved.invalid" } });
    fireEvent.click(within(connectionDialog).getByRole("button", { name: "Close connection setup" }));
    expect(screen.queryByRole("dialog", { name: "Edit server connection" })).not.toBeInTheDocument();
    await clickReady("Edit Catalog dev");
    const databaseDialog = screen.getByRole("dialog", { name: "Edit database" });
    expect(within(databaseDialog).getByLabelText("Database name")).toHaveValue(dev.database);
    fireEvent.click(within(databaseDialog).getByRole("button", { name: "Close database setup" }));
    expect(screen.queryByRole("dialog", { name: "Edit database" })).not.toBeInTheDocument();
    expect(api.saveServerConnection).not.toHaveBeenCalled();
    expect(api.saveProfile).not.toHaveBeenCalled();
  });
  it("shows operation failures inside the editor and blocks cancellation during a save", async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(api.saveServerConnection).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(panel());
    await clickReady("Edit connection");
    const dialog = screen.getByRole("dialog", { name: "Edit server connection" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save server connection" }));
    expect(within(dialog).getByRole("button", { name: "Close connection setup" })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(dialog).toBeInTheDocument();
    await act(async () => { fail(new Error("Fixture configuration cannot be saved")); });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Fixture configuration cannot be saved");
    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(dialog).not.toBeInTheDocument();
  });
  it("keeps a newly saved connection open so credentials can be set up next", async () => {
    const added = { ...server, id: "added", label: "New endpoint", host: "new.invalid", hasInspectionCredentials: false };
    vi.mocked(api.saveServerConnection).mockResolvedValue(added);
    vi.mocked(api.getServerConnection).mockImplementation(async id => ({ ...(id === added.id ? added : server), credentialUsernames: id === added.id ? {} : { inspection: "reader" } }));
    render(panel());
    await screen.findByRole("table", { name: "Server databases" });
    fireEvent.click(screen.getByRole("button", { name: "Add server connection" }));
    fireEvent.change(screen.getByLabelText("Server label"), { target: { value: added.label } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: added.host } });
    vi.mocked(api.overview).mockResolvedValue({ ...overview, servers: [...overview.servers, added] });
    fireEvent.click(screen.getByRole("button", { name: "Save server connection" }));
    await clickReady("Edit Read-only inspection credentials");
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByRole("tab", { name: /New endpoint/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Check Read-only inspection connection" })).toBeDisabled();
  });
  it("requires unsaved endpoint changes to be saved before credential checks or rescans", async () => {
    render(panel());
    await clickReady("Edit connection");
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "changed.invalid" } });
    expect(screen.getByRole("button", { name: "Check Read-only inspection connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rescan databases" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check databases" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close connection setup" }));
    expect(screen.getByRole("button", { name: "Rescan databases" })).toBeEnabled();
    expect(api.checkServerConnection).not.toHaveBeenCalled();
  });
  it("keeps editing and credentials hidden and puts verification in the database grid", async () => {
    render(panel());
    const grid = await screen.findByRole("table", { name: "Server databases" });
    expect(within(grid).getByText(dev.database)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Server connection settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Server credentials" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Connection verification results" })).not.toBeInTheDocument();
    expect(screen.getByText("Development MCP access").closest("details")).not.toHaveAttribute("open");
    await clickReady("Check Catalog dev");
    await waitFor(() => expect(within(grid).getByRole("row", { name: /catalog_dev/ })).toHaveTextContent("✓ Available"));
    expect(api.verifyTargets).toHaveBeenCalledWith([dev.id]);
    expect(within(grid).getByRole("row", { name: /orders_prod/ })).toHaveTextContent("Not checked");
  });
  it("shows all three credential roles, tests the chosen account and clears results after credential changes", async () => {
    vi.mocked(api.getServerConnection).mockResolvedValue({ ...server, hasMigrationCredentials: true, hasDiagnosticCredentials: true, credentialUsernames: { inspection: "reader", migration: "writer", diagnostic: "diagnose" } });
    render(panel());
    await clickReady("Edit connection");
    const grid = screen.getByRole("table", { name: "Server credentials" });
    expect(within(grid).getAllByText("✓ Set up")).toHaveLength(3);
    for (const [role, label] of [["inspection", "Read-only inspection"], ["migration", "Migration execution"], ["diagnostic", "Development diagnostics"]] as const) {
      const button = within(grid).getByRole("button", { name: `Check ${label} connection` });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(api.checkServerConnection).toHaveBeenCalledWith(server.id, role));
    }
    await waitFor(() => expect(within(grid).getAllByText("✓ Connected")).toHaveLength(3));
    vi.mocked(api.checkServerConnection).mockResolvedValue({ status: "failed", message: "Connection failed" });
    await waitFor(() => expect(within(grid).getByRole("button", { name: "Check Migration execution connection" })).toBeEnabled());
    fireEvent.click(within(grid).getByRole("button", { name: "Check Migration execution connection" }));
    expect(await within(grid).findByText("Connection failed")).toBeInTheDocument();
    expect(within(grid).getAllByText("✓ Connected")).toHaveLength(2);
    await waitFor(() => expect(within(grid).getByRole("button", { name: "Edit Read-only inspection credentials" })).toBeEnabled());
    fireEvent.click(within(grid).getByRole("button", { name: "Edit Read-only inspection credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(within(grid).queryByText("✓ Connected")).not.toBeInTheDocument());
  });
  it("switches servers without leaking databases or credential drafts, including delayed details", async () => {
    const other = { ...server, id: "other", label: "Other server", host: "other.invalid" };
    const otherTarget = { ...dev, id: "other-target", serverConnectionId: other.id, database: "other_db", label: "Other dev" };
    vi.mocked(api.overview).mockResolvedValue({ ...overview, servers: [server, other], profiles: [dev, prod, otherTarget] });
    let finish!: (value: Awaited<ReturnType<DatabaseDesktopApi["getServerConnection"]>>) => void;
    vi.mocked(api.getServerConnection).mockImplementation(async id => id === server.id ? { ...server, credentialUsernames: { inspection: "reader" } } : new Promise(resolve => { finish = resolve; }));
    render(panel());
    await clickReady("Edit connection");
    fireEvent.click(screen.getByRole("button", { name: "Edit Read-only inspection credentials" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "unsaved-secret" } });
    fireEvent.click(screen.getByRole("tab", { name: /Other server/ }));
    expect(screen.getByRole("table", { name: "Server databases" })).toHaveTextContent("other_db");
    expect(screen.queryByText(dev.database)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Shared server/ }));
    await act(async () => { finish({ ...other, credentialUsernames: { inspection: "other-reader" } }); });
    await clickReady("Edit connection");
    fireEvent.click(screen.getByRole("button", { name: "Edit Read-only inspection credentials" }));
    expect(screen.getByLabelText("Username")).toHaveValue("reader");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Host")).toHaveValue(server.host);
  });
  it("opens setup with no targets or operation dropdown selection", async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...overview, servers: [], profiles: [] });
    render(panel());
    expect(await screen.findByRole("heading", { name: "Server connections" })).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("");
    expect(screen.getByLabelText("TLS")).toHaveValue("disabled");
    expect(screen.getByRole("button", { name: "Add server connection" })).toBeEnabled();
    expect(screen.queryByLabelText("Logical database")).not.toBeInTheDocument();
    expect(api.verifyTargets).not.toHaveBeenCalled();
  });
  it("edits targets from every logical database and verifies each saved target automatically", async () => {
    render(panel());
    await clickReady("Edit Orders live");
    expect(screen.getByLabelText("Database name")).toHaveValue("orders_prod");
    fireEvent.change(screen.getByLabelText("Target label"), { target: { value: "Orders production" } });
    fireEvent.click(screen.getByRole("button", { name: "Save database target" }));
    await waitFor(() => expect(api.verifyTargets).toHaveBeenCalledWith([prod.id]));
    expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: prod.id, label: "Orders production", databaseKey: "orders" }));
    expect(screen.queryByRole("button", { name: "Inspect target" })).not.toBeInTheDocument();
    expect(api.acceptIdentity).not.toHaveBeenCalled();
  });
  it("verifies all assigned targets after inspection credentials are saved", async () => {
    render(panel());
    await clickReady("Edit connection");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Read-only inspection credentials" }));
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveValue("reader"));
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(api.verifyTargets).toHaveBeenCalledWith([dev.id, prod.id]));
  });
  it("shows per-target failures and requires a deliberate identity review", async () => {
    vi.mocked(api.verifyTargets).mockResolvedValue([{ profileId: dev.id, status: "verified" }, { profileId: prod.id, status: "failed", message: "Target identity changed" }]);
    const snapshot = { identity: { engine: "mariadb", version: "fixture", database: "orders_prod", fingerprint: "changed-identity", settings: {} }, capturedAt: new Date().toISOString(), objects: [], coverage: { complete: true, limitations: [] } } as unknown as SchemaSnapshot;
    vi.mocked(api.inspect).mockResolvedValue(snapshot);
    render(panel());
    await clickReady("Check databases");
    expect(await screen.findByText(/Target identity changed/)).toBeInTheDocument();
    expect(api.acceptIdentity).not.toHaveBeenCalled();
    expect(api.inspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review identity for Orders live" }));
    expect(await screen.findByRole("article", { name: "Target identity review" })).toHaveTextContent("changed-identity");
    expect(api.acceptIdentity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept reviewed identity" }));
    await waitFor(() => expect(api.acceptIdentity).toHaveBeenCalledWith(prod.id, "changed-identity"));
  });
  it("never attaches an in-flight identity review to a newly selected target", async () => {
    vi.mocked(api.verifyTargets).mockResolvedValue([{ profileId: dev.id, status: "failed", message: "Identity needs review" }]);
    let finish!: (snapshot: SchemaSnapshot) => void;
    vi.mocked(api.inspect).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<DatabaseSettings initialProfileId={dev.id} mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await clickReady("Check databases");
    fireEvent.click(await screen.findByRole("button", { name: "Review identity for Catalog dev" }));
    await waitFor(() => expect(api.inspect).toHaveBeenCalledWith(dev.id));
    view.rerender(<DatabaseSettings initialProfileId={prod.id} mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await act(async () => { finish({ identity: { fingerprint: "development-identity" } } as SchemaSnapshot); });
    expect(screen.getByRole("row", { name: /orders_prod/ })).toHaveClass("database-selected-row");
    expect(screen.queryByRole("article", { name: "Target identity review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept reviewed identity" })).not.toBeInTheDocument();
    expect(api.acceptIdentity).not.toHaveBeenCalled();
  });
  it("offers setup independently and passes an optional target from overview", async () => {
    const onOpenSettings = vi.fn();
    render(<Databases active root={null} repos={[]} onOpenRepository={vi.fn()} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure databases" }));
    expect(onOpenSettings).toHaveBeenCalledWith();
    fireEvent.click(await screen.findByRole("button", { name: "Configure Orders live" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith(prod.id);
    expect(screen.queryByRole("button", { name: "Connections" })).not.toBeInTheDocument();
  });
  it("shows server status and copies configuration through main without receiving a token", async () => {
    render(panel());
    fireEvent.click(screen.getByText("Development MCP access"));
    expect(await screen.findByText(/MCP server running/)).toHaveTextContent("http://127.0.0.1:47321/mcp");
    fireEvent.click(screen.getByRole("button", { name: "Copy MCP configuration" }));
    await waitFor(() => expect(desktop.copyDatabaseMcpConfig).toHaveBeenCalledOnce());
    expect(desktop.copyDatabaseMcpConfig).toHaveBeenCalledWith();
  });
  it("retains General drafts across tabs and saves the global MCP switch", async () => {
    const onSaved = vi.fn();
    render(<SettingsDialog open onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(await screen.findByLabelText("Refresh interval minutes"), { target: { value: "17" } });
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    fireEvent.click(screen.getByText("Development MCP access"));
    const toggle = screen.getByLabelText("Start the development MCP server automatically");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.getByLabelText("Refresh interval minutes")).toHaveValue(17);
    fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
    expect(screen.getByLabelText("Start the development MCP server automatically")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ refreshIntervalMinutes: 17, databaseMcpEnabled: false })));
  });
  it("opens directly on the requested target in Settings", async () => {
    render(<SettingsDialog open initialTab="databases" initialDatabaseProfileId={prod.id} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Databases" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("row", { name: /orders_prod/ })).toHaveClass("database-selected-row");
  });
});
