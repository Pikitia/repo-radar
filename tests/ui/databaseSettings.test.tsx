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
    discoverDatabases: vi.fn(), assignDatabases: vi.fn(), configureDiagnostics: vi.fn(), inspect: vi.fn(), acceptIdentity: vi.fn().mockResolvedValue(undefined)
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

describe("Independent database settings", () => {
  it("opens setup with no targets or operation dropdown selection", async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...overview, servers: [], profiles: [] });
    render(panel());
    expect(await screen.findByRole("heading", { name: "Server connections" })).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("");
    expect(screen.getByLabelText("TLS")).toHaveValue("disabled");
    expect(screen.getByRole("button", { name: "New database target" })).toBeEnabled();
    expect(screen.queryByLabelText("Logical database")).not.toBeInTheDocument();
    expect(api.verifyTargets).not.toHaveBeenCalled();
  });
  it("edits targets from every logical database and verifies each saved target automatically", async () => {
    render(panel());
    await screen.findByRole("heading", { name: "Database targets" });
    expect(within(screen.getByLabelText("Database target")).getAllByRole("option")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Database target"), { target: { value: prod.id } });
    expect(screen.getByLabelText("Database name")).toHaveValue("orders_prod");
    fireEvent.change(screen.getByLabelText("Target label"), { target: { value: "Orders production" } });
    fireEvent.click(screen.getByRole("button", { name: "Save protected target" }));
    await waitFor(() => expect(api.verifyTargets).toHaveBeenCalledWith([prod.id]));
    expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: prod.id, label: "Orders production", databaseKey: "orders" }));
    expect(screen.queryByRole("button", { name: "Inspect target" })).not.toBeInTheDocument();
    expect(api.acceptIdentity).not.toHaveBeenCalled();
  });
  it("verifies all assigned targets after inspection credentials are saved", async () => {
    render(panel());
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveValue("reader"));
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(api.verifyTargets).toHaveBeenCalledWith([dev.id, prod.id]));
  });
  it("shows per-target failures and requires a deliberate identity review", async () => {
    vi.mocked(api.verifyTargets).mockResolvedValue([{ profileId: dev.id, status: "verified" }, { profileId: prod.id, status: "failed", message: "Target identity changed" }]);
    const snapshot = { identity: { engine: "mariadb", version: "fixture", database: "orders_prod", fingerprint: "changed-identity", settings: {} }, capturedAt: new Date().toISOString(), objects: [], coverage: { complete: true, limitations: [] } } as unknown as SchemaSnapshot;
    vi.mocked(api.inspect).mockResolvedValue(snapshot);
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Verify all connections" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Verify all connections" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review identity for Catalog dev" }));
    await waitFor(() => expect(api.inspect).toHaveBeenCalledWith(dev.id));
    view.rerender(<DatabaseSettings initialProfileId={prod.id} mcpEnabled onMcpEnabledChange={vi.fn()} />);
    await act(async () => { finish({ identity: { fingerprint: "development-identity" } } as SchemaSnapshot); });
    expect(screen.getByLabelText("Database target")).toHaveValue(prod.id);
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
    await waitFor(() => expect(screen.getByLabelText("Database target")).toHaveValue(prod.id));
    expect(screen.getByLabelText("Database name")).toHaveValue("orders_prod");
  });
});
