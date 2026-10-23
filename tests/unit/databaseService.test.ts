// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseConnectionConfig, DatabaseIdentity, DatabaseServerConnectionConfig } from "../../src/types/database.js";
import type { SqlSession } from "../../electron/databases/connections.js";
import { DatabaseService } from "../../electron/databases/service.js";
import * as diagnosticSubmissions from "../../electron/databases/devConfig.js";
import type { MigrationProposal } from "../../src/types/migration.js";

vi.mock("../../electron/databases/connections.js", async original => ({ ...await original<object>(), readIdentity: async (session: SqlSession & { fixtureIdentity: DatabaseIdentity }) => session.fixtureIdentity, readServerIdentity: async () => ({ serverId: "shared-server", engine: "mysql", version: "8.4.8", lowerCaseTableNames: 1 }) }));
vi.mock("../../electron/databases/schema.js", async original => ({ ...await original<object>(), captureSchema: async (_session: unknown, identity: DatabaseIdentity) => ({ identity, capturedAt: new Date().toISOString(), digest: "baseline", objects: [], coverage: { complete: true, limitations: [] } }) }));
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const protector = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() };
async function setup(confirmed = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repo-radar-service-")); directories.push(directory);
  const writes: string[] = [], state = new Map<string, { tables: number; enrolled: boolean; fingerprint: string }>();
  const confirm = vi.fn().mockResolvedValue(confirmed);
  const repositories = vi.fn(async (): Promise<string[]> => []);
  const discoveryRows = [{ name: "information_schema" }, { name: "mysql" }, { name: "modern" }, { name: "orders" }];
  const discoveryClose = vi.fn(async () => undefined);
  const connectServer = vi.fn(async (config: DatabaseServerConnectionConfig) => {
    if ("database" in config) throw new Error("Discovery must not select a schema");
    return { query: async () => discoveryRows, execute: async () => { throw new Error("Discovery cannot write"); }, close: discoveryClose };
  });
  const service = new DatabaseService({ directory, protector, root: () => directory, repositories, confirm, connectServer, connect: async (config: DatabaseConnectionConfig) => {
    const identity: DatabaseIdentity = { serverId: config.host, database: config.database, fingerprint: `${config.host}/${config.database}`, engine: "mysql", version: "8.4.8", settings: { sqlMode: "", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" } };
    const target = state.get(config.host) ?? { tables: 0, enrolled: false, fingerprint: identity.fingerprint }; state.set(config.host, target);
    return {
      fixtureIdentity: identity,
      query: async (sql: string) => {
        if (sql.includes("IS_USED_LOCK")) return [{ owned: 1 }];
        if (sql.includes("GET_LOCK")) return [{ acquired: 1 }];
        if (sql.includes("TABLE_NAME AS name")) return target.tables ? [{ name: "db_radar_enrollment" }, { name: "db_radar_events" }].slice(0, target.tables) : [];
        if (sql.includes("SELECT identity_fingerprint")) return target.enrolled ? [{ identity_fingerprint: target.fingerprint, baseline_digest: "baseline" }] : [];
        return [];
      },
      execute: async (sql: string) => { writes.push(sql); if (sql.startsWith("CREATE TABLE db_radar_")) target.tables++; if (sql.startsWith("INSERT INTO db_radar_enrollment")) target.enrolled = true; },
      close: async () => undefined,
    };
  } });
  async function profile(environment: "dev" | "production" = "dev", host = `${environment}.fixture`) {
    const server = await service.saveServerConnection({ label: environment, host, port: 3306, tlsMode: "disabled" });
    const result = await service.saveProfile({ databaseKey: "shared", label: environment, environment, serverConnectionId: server.id, database: "modern" });
    await service.saveCredentials(result.id, "inspection", { username: "inspect", password: "hidden-value" });
    await service.saveCredentials(result.id, "migration", { username: "migrate", password: "hidden-value" });
    return result;
  }
  return { service, profile, writes, confirm, repositories, directory, discoveryRows, connectServer, discoveryClose };
}

describe("privileged database integration", () => {
  it("discovers with shared inspection credentials, excludes system schemas and assigns a selected batch", async () => {
    const { service, profile, connectServer, discoveryClose, writes } = await setup();
    const dev = await profile();
    const discovery = await service.discoverDatabases(dev.serverConnectionId);
    expect(discovery.databases).toEqual([{ database: "modern", assigned: true, profileIds: [dev.id] }, { database: "orders", assigned: false, profileIds: [] }]);
    expect(connectServer).toHaveBeenCalledWith(expect.objectContaining({ serverConnectionId: dev.serverConnectionId, host: "dev.fixture", credentials: { username: "inspect", password: "hidden-value" } }));
    expect(connectServer.mock.calls[0][0]).not.toHaveProperty("database");
    expect(discoveryClose).toHaveBeenCalledOnce();
    const profiles = await service.assignDatabases(dev.serverConnectionId, [{ serverConnectionId: dev.serverConnectionId, database: "orders", databaseKey: "orders", label: "Orders production", environment: "production" }]);
    expect(profiles[0]).toMatchObject({ database: "orders", environment: "production", hasInspectionCredentials: true });
    expect((await service.overview()).servers).toHaveLength(1);
    expect(writes).toEqual([]);
    await expect(service.profiles.getConnection(profiles[0].id, "diagnostic")).rejects.toThrow();
  });
  it("rechecks discovery and rejects assigned, inaccessible, duplicate and forged assignments atomically", async () => {
    const { service, profile } = await setup(); const dev = await profile();
    const row = { serverConnectionId: dev.serverConnectionId, database: "orders", databaseKey: "orders", label: "Orders", environment: "dev" as const };
    for (const rows of [[{ ...row, database: "modern" }], [{ ...row, database: "missing" }], [row, row], [{ ...row, serverConnectionId: "other" }], [row, { ...row, label: "" }]]) {
      await expect(service.assignDatabases(dev.serverConnectionId, rows)).rejects.toThrow();
      expect((await service.overview()).profiles).toHaveLength(1);
    }
  });
  it("recognizes assigned schemas across endpoint aliases and case-insensitive server names", async () => {
    const { service, profile } = await setup(); const dev = await profile();
    const sameEndpoint = await service.saveServerConnection({ label: "Another account", host: "DEV.FIXTURE.", port: 3306, tlsMode: "disabled" });
    await service.saveServerCredentials(sameEndpoint.id, "inspection", { username: "reader", password: "fixture" });
    expect((await service.discoverDatabases(sameEndpoint.id)).databases[0].assigned).toBe(true);
    const observed = await service.inspect(dev.id);
    await service.profiles.enrollIdentity(dev.id, { ...observed.identity, serverId: "shared-server" });
    const alias = await service.saveServerConnection({ label: "Tunnel", host: "localhost", port: 3307, tlsMode: "disabled" });
    await service.saveServerCredentials(alias.id, "inspection", { username: "reader", password: "fixture" });
    expect((await service.discoverDatabases(alias.id)).databases[0].profileIds).toEqual([dev.id]);
  });
  it("invalidates every attached target's plans and observations when a shared connection changes", async () => {
    const { service, profile } = await setup(); const dev = await profile();
    const second = await service.saveProfile({ serverConnectionId: dev.serverConnectionId, database: "orders", databaseKey: "orders", label: "Orders", environment: "dev" });
    for (const target of [dev, second]) { const observed = await service.inspect(target.id); await service.acceptIdentity(target.id, observed.identity.fingerprint); }
    const plan = await service.createPlan({ profileId: second.id, kind: "enroll", direction: "up", migrationIds: [] });
    const details = await service.getServerConnection(dev.serverConnectionId);
    await service.saveServerConnection({ ...details, host: "replacement.fixture" });
    await expect(service.runPlan(plan.planId)).rejects.toThrow("new migration plan");
    const overview = await service.overview();
    expect(overview.profiles.every(target => !target.identity && !target.hasInspectionCredentials)).toBe(true);
    expect((await service.evidence.read()).snapshots).toEqual({});
    await expect(service.acceptIdentity(second.id, "dev.fixture/orders")).rejects.toThrow("Inspect");
  });
  it("bounds discovery and closes failed sessions without writing targets", async () => {
    const { service, profile, discoveryRows, discoveryClose } = await setup(); const dev = await profile();
    discoveryRows.splice(0, discoveryRows.length, ...Array.from({ length: 2001 }, (_, index) => ({ name: `schema_${index}` })));
    await expect(service.discoverDatabases(dev.serverConnectionId)).rejects.toThrow("2000");
    expect(discoveryClose).toHaveBeenCalledOnce();
    expect((await service.overview()).profiles).toHaveLength(1);
  });
  it("inspection is read-only and safe overview never returns saved secrets", async () => {
    const { service, profile, writes } = await setup(); const dev = await profile();
    const snapshot = await service.inspect(dev.id);
    expect(snapshot.identity.serverId).toBe("dev.fixture");
    expect(writes).toEqual([]);
    const overview = await service.overview();
    expect(JSON.stringify(overview)).not.toContain("hidden-value");
    expect(overview.profiles[0]).not.toHaveProperty("host");
    expect(overview.profiles[0]).not.toHaveProperty("credentials");
  });
  it("requires inspected identity and rejects aliases across dev and production", async () => {
    const { service, profile } = await setup(); const dev = await profile();
    await expect(service.acceptIdentity(dev.id, "made-up")).rejects.toThrow("Inspect");
    const observed = await service.inspect(dev.id); await service.acceptIdentity(dev.id, observed.identity.fingerprint);
    const production = await profile("production", "dev.fixture"), aliased = await service.inspect(production.id);
    await expect(service.acceptIdentity(production.id, aliased.identity.fingerprint)).rejects.toThrow("cannot share");
  });
  it("native cancellation sends no history setup statements", async () => {
    const { service, profile, writes, confirm } = await setup(false); const dev = await profile();
    const snapshot = await service.inspect(dev.id); await service.acceptIdentity(dev.id, snapshot.identity.fingerprint);
    const plan = await service.createPlan({ profileId: dev.id, kind: "enroll", direction: "up", migrationIds: [] });
    await expect(service.runPlan(plan.planId)).rejects.toThrow("cancelled");
    expect(confirm).toHaveBeenCalledWith(plan); expect(writes).toEqual([]);
  });
  it("explicit enrollment writes only history objects and a fresh service reads them", async () => {
    const { service, profile, writes } = await setup(); const dev = await profile();
    const snapshot = await service.inspect(dev.id); await service.acceptIdentity(dev.id, snapshot.identity.fingerprint);
    const plan = await service.createPlan({ profileId: dev.id, kind: "enroll", direction: "up", migrationIds: [] });
    expect((await service.runPlan(plan.planId)).state).toBe("succeeded");
    expect(writes).toHaveLength(3);
    expect(writes.every(sql => /^(?:CREATE TABLE|INSERT INTO) db_radar_/.test(sql))).toBe(true);
    expect((await service.history(dev.id)).enrolled).toBe(true);
    await expect(service.runPlan(plan.planId)).rejects.toThrow("new migration plan");
  });
  it("configuration changes invalidate reviewed plans and diagnostics cannot select production", async () => {
    const { service, profile } = await setup(); const dev = await profile();
    const snapshot = await service.inspect(dev.id); await service.acceptIdentity(dev.id, snapshot.identity.fingerprint);
    const plan = await service.createPlan({ profileId: dev.id, kind: "enroll", direction: "up", migrationIds: [] });
    const production = await profile("production");
    await expect(service.runPlan(plan.planId)).rejects.toThrow("new migration plan");
    await expect(service.configureDiagnostics({ profileId: production.id, policy: { tables: {} } })).rejects.toThrow("development");
    await expect(service.createPlan({ profileId: dev.id, kind: "execute", direction: "up", migrationIds: ["missing"] })).rejects.toThrow("Seal");
  });
  it("serializes repository-root changes with diagnostic and profile configuration", async () => {
    const { service, profile } = await setup();
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const changing = service.serializeRootChange(async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); });
    await ready;
    await expect(profile()).rejects.toThrow("active database operation");
    finish(); await changing;
    await expect(profile()).resolves.toMatchObject({ environment: "dev" });
  });
  it("keeps existing profiles available when the agent submission inbox cannot be read", async () => {
    const { service, profile, writes } = await setup();
    const dev = await profile();
    vi.spyOn(diagnosticSubmissions, "collectDiagnosticSubmissions").mockRejectedValueOnce(new Error("private inbox contents must not appear"));
    const result = await service.overview();
    expect(result.profiles).toContainEqual(expect.objectContaining({ id: dev.id }));
    expect(result.submissionErrors).toEqual([{ proposalId: "submission-inbox", message: "Agent submissions could not be read. Existing database profiles and releases remain available." }]);
    expect(JSON.stringify(result)).not.toContain("private inbox contents");
    expect(writes).toEqual([]);
  });
  it("reports a conflicting broker draft without hiding valid profiles or later submissions", async () => {
    const { service, profile, repositories, directory, writes } = await setup();
    const dev = await profile();
    repositories.mockResolvedValue([directory]);
    const proposal = (id: string): MigrationProposal => ({ proposalId: id, contentDigest: `${id}-digest`, source: { repositoryPath: directory, manifestRelativePath: "db/migrations/item/migration.json", commit: null, dirty: true }, status: "draft", importedAt: new Date().toISOString(), validationWarnings: [], files: { "up.sql": "ALTER TABLE stock ADD COLUMN label TEXT", "down.sql": "ALTER TABLE stock DROP COLUMN label", "recovery.md": "Restore reviewed baseline" }, manifest: { formatVersion: 1, id: `catalog/${id}`, title: id, databaseKey: "shared", service: "catalog", dependsOn: [], engine: { product: "mysql", minVersion: "8.0.0", requiredSettings: {}, storageEngines: ["InnoDB"] }, up: ["up.sql"], preconditions: [], postconditions: [], recovery: { mode: "down", down: ["down.sql"], eligibilityChecks: [], runbook: "recovery.md", applicationCompatibility: "Compatible application", rollbackRoute: "tested-down" }, dataImpact: { description: "Fixture only", destructive: false, requiresWritePause: false, locking: "Fixture only" }, applicationCompatibility: "Fixture only", expectedSchemaChanges: [] } });
    const conflicting = proposal("conflict"), valid = proposal("valid");
    vi.spyOn(diagnosticSubmissions, "collectDiagnosticSubmissions").mockResolvedValueOnce([conflicting, valid]);
    vi.spyOn(service.library, "importProposalSnapshot").mockRejectedValueOnce(new Error("private conflict detail")).mockResolvedValueOnce(valid);
    const result = await service.overview();
    expect(result.profiles).toContainEqual(expect.objectContaining({ id: dev.id }));
    expect(result.submissionErrors).toEqual([{ proposalId: conflicting.proposalId, message: expect.stringContaining("conflicts with the immutable library") }]);
    expect(service.library.importProposalSnapshot).toHaveBeenNthCalledWith(2, valid);
    expect(JSON.stringify(result)).not.toContain("private conflict detail");
    expect(writes).toEqual([]);
  });
});
