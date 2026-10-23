// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseConnectionConfig, DatabaseIdentity, DatabaseProfile } from "../../src/types/database.js";
import type { SqlSession } from "../../electron/databases/connections.js";
import { databaseDigest } from "../../electron/databases/connections.js";
import { DatabaseService } from "../../electron/databases/service.js";
import { loadDiagnosticConfig } from "../../electron/databases/devConfig.js";
import * as schema from "../../electron/databases/schema.js";

vi.mock("../../electron/databases/connections.js", async original => ({ ...await original<object>(), readIdentity: async (session: SqlSession & { fixtureIdentity: DatabaseIdentity }) => session.fixtureIdentity }));
vi.mock("../../electron/databases/schema.js", async original => ({ ...await original<object>(), captureSchema: async (_session: unknown, identity: DatabaseIdentity) => ({ identity, capturedAt: new Date().toISOString(), digest: "fixture-schema", objects: [], coverage: { complete: true, limitations: [] } }) }));

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const protector = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() };
function actualIdentity(config: DatabaseConnectionConfig): DatabaseIdentity {
  return { serverId: config.host, database: config.database, fingerprint: databaseDigest([config.host, config.database]), engine: "mariadb", version: "10.6.25", settings: { sqlMode: "STRICT_TRANS_TABLES", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" } };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "radar-auto-identity-")); directories.push(directory);
  const writes: string[] = [];
  const observations = new Map<string, number>();
  const identities = new Map<string, (config: DatabaseConnectionConfig, ordinal: number) => DatabaseIdentity | Promise<DatabaseIdentity>>();
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async (config: DatabaseConnectionConfig) => {
    const ordinal = (observations.get(config.profileId) ?? 0) + 1; observations.set(config.profileId, ordinal);
    const identity = await (identities.get(config.profileId)?.(config, ordinal) ?? actualIdentity(config));
    return { fixtureIdentity: identity, query: async () => [], execute: async (sql: string) => { writes.push(sql); }, close };
  });
  const confirm = vi.fn().mockResolvedValue(false);
  const service = new DatabaseService({ directory, protector, root: () => directory, repositories: async () => [], confirm, connect });
  async function target(environment: "dev" | "production" | "sandbox" = "dev", host = `${environment}.invalid`, database = "catalog"): Promise<DatabaseProfile> {
    const server = await service.saveServerConnection({ label: `${environment} server`, host, port: 3306, tlsMode: "disabled" });
    await service.saveServerCredentials(server.id, "inspection", { username: "reader", password: "fixture-private-password" });
    return service.saveProfile({ serverConnectionId: server.id, label: `${environment} target`, databaseKey: "catalog", environment, database });
  }
  return { service, target, directory, writes, connect, close, identities, observations, confirm };
}

describe("automatic initial database identity verification", () => {
  it("keeps saving and overview offline, then binds two stable observations without database writes", async () => {
    const { service, target, connect, writes, close } = await fixture(); const profile = await target();
    const capture = vi.spyOn(schema, "captureSchema");
    expect((await service.overview()).profiles[0].identity).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(await service.verifyTargets([profile.id])).toEqual([{ profileId: profile.id, status: "verified" }]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
    expect((await service.overview()).profiles[0].identity).toMatchObject({ serverId: "dev.invalid", database: "catalog", version: "10.6.25" });
    expect(writes).toEqual([]);
  });

  it("isolates failed targets, withholds driver details and continues the batch", async () => {
    const { service, target, identities, writes } = await fixture();
    const bad = await target("dev", "unavailable.invalid"), good = await target("production");
    identities.set(bad.id, () => { throw new Error("driver leaked fixture-private-password"); });
    const results = await service.verifyTargets([bad.id, good.id]);
    expect(results).toEqual([{ profileId: bad.id, status: "failed", message: expect.stringContaining("inspection credentials") }, { profileId: good.id, status: "verified" }]);
    expect(JSON.stringify(results)).not.toContain("fixture-private-password");
    const profiles = (await service.overview()).profiles;
    expect(profiles.find(item => item.id === bad.id)?.identity).toBeUndefined();
    expect(profiles.find(item => item.id === good.id)?.identity).toBeDefined();
    expect(writes).toEqual([]);
  });

  it("validates batch limits, duplicate IDs and identifiers before making connections", async () => {
    const { service, connect } = await fixture();
    for (const ids of [[], ["duplicate", "duplicate"], [""], ["bad\0id"], ["a".repeat(101)], Array.from({ length: 101 }, (_, index) => `target-${index}`)]) await expect(service.verifyTargets(ids)).rejects.toThrow();
    await expect(service.verifyTargets(null as unknown as string[])).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    expect(await service.verifyTargets(["missing"])).toEqual([{ profileId: "missing", status: "failed", message: expect.any(String) }]);
  });

  it("rejects a development/production alias while retaining the successfully verified target", async () => {
    const { service, target, writes } = await fixture();
    const dev = await target("dev", "same-server.invalid"), production = await target("production", "same-server.invalid");
    expect(await service.verifyTargets([dev.id, production.id])).toEqual([{ profileId: dev.id, status: "verified" }, { profileId: production.id, status: "failed", message: expect.stringContaining("cannot share") }]);
    const profiles = (await service.overview()).profiles;
    expect(profiles.find(item => item.id === dev.id)?.identity).toBeDefined();
    expect(profiles.find(item => item.id === production.id)?.identity).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("requires both observations to match before creating an initial binding", async () => {
    const { service, target, identities } = await fixture(); const profile = await target();
    identities.set(profile.id, (config, ordinal) => ({ ...actualIdentity(config), version: ordinal === 1 ? "10.6.25" : "10.6.26" }));
    expect(await service.verifyTargets([profile.id])).toEqual([{ profileId: profile.id, status: "failed", message: expect.stringContaining("changed during verification") }]);
    expect((await service.overview()).profiles[0].identity).toBeUndefined();
  });

  it.each(["server", "engine", "version", "settings"])("does not replace an existing binding when %s changes", async field => {
    const { service, target, identities } = await fixture(); const profile = await target();
    await service.verifyTargets([profile.id]);
    const enrolled = (await service.overview()).profiles[0].identity;
    identities.set(profile.id, config => {
      const identity = actualIdentity(config);
      if (field === "server") return { ...identity, serverId: "replacement", fingerprint: databaseDigest(["replacement", config.database]) };
      if (field === "engine") return { ...identity, engine: "mysql" };
      if (field === "version") return { ...identity, version: "10.6.26" };
      return { ...identity, settings: { ...identity.settings, sqlMode: "" } };
    });
    expect(await service.verifyTargets([profile.id])).toEqual([{ profileId: profile.id, status: "failed", message: expect.stringContaining("changed") }]);
    expect((await service.overview()).profiles[0].identity).toEqual(enrolled);
    await expect(service.history(profile.id)).rejects.toThrow("changed");
    await expect(service.createPlan({ profileId: profile.id, kind: "enroll", direction: "up", migrationIds: [] })).rejects.toThrow("changed");
  });

  it("automatically verifies comparison and history without creating history tables", async () => {
    const { service, target, writes } = await fixture(); const dev = await target(), production = await target("production");
    await expect(service.compare("catalog")).resolves.toMatchObject({ differences: [] });
    expect((await service.overview()).profiles.every(item => item.identity)).toBe(true);
    await expect(service.history(dev.id)).resolves.toMatchObject({ enrolled: false, events: [] });
    await expect(service.history(production.id)).resolves.toMatchObject({ enrolled: false, events: [] });
    expect(writes).toEqual([]);
  });

  it("compares only after both identities pass, including already-bound development drift", async () => {
    const { service, target, identities } = await fixture(); const dev = await target(); await target("production");
    await service.verifyTargets([dev.id]);
    const enrolled = (await service.overview()).profiles.find(item => item.id === dev.id)?.identity;
    identities.set(dev.id, config => ({ ...actualIdentity(config), version: "10.6.26" }));
    await expect(service.compare("catalog")).rejects.toThrow("changed");
    expect((await service.overview()).profiles.find(item => item.id === dev.id)?.identity).toEqual(enrolled);
  });

  it("initially verifies during planning, retains native cancellation and preserves plans across read-only checks", async () => {
    const { service, target, writes, confirm } = await fixture(); const profile = await target();
    await service.saveServerCredentials(profile.serverConnectionId, "migration", { username: "migrator", password: "fixture-migration-password" });
    const plan = await service.createPlan({ profileId: profile.id, kind: "enroll", direction: "up", migrationIds: [] });
    expect((await service.overview()).profiles[0].identity).toBeDefined();
    await service.history(profile.id);
    await expect(service.runPlan(plan.planId)).rejects.toThrow("cancelled");
    expect(confirm).toHaveBeenCalledWith(plan);
    expect(writes).toEqual([]);
  });

  it("serializes verification against configuration, planning and execution", async () => {
    const { service, target, identities } = await fixture(); const profile = await target();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    identities.set(profile.id, async config => { started(); await new Promise<void>(resolve => { release = resolve; }); return actualIdentity(config); });
    const verifying = service.verifyTargets([profile.id]); await ready;
    await expect(service.saveProfile({ ...profile, label: "Changed while checking" })).rejects.toThrow("active database operation");
    await expect(service.verifyTargets([profile.id])).rejects.toThrow("active database operation");
    await expect(service.inspect(profile.id)).rejects.toThrow("active database operation");
    await expect(service.history(profile.id)).rejects.toThrow("active database operation");
    await expect(service.createPlan({ profileId: profile.id, kind: "enroll", direction: "up", migrationIds: [] })).rejects.toThrow("current database operation");
    await expect(service.runPlan("unused-plan")).rejects.toThrow("current database operation");
    identities.delete(profile.id); release();
    expect(await verifying).toEqual([{ profileId: profile.id, status: "verified" }]);
  });

  it("auto-verifies development and production identities for the diagnostic denylist while rejecting production enrollment", async () => {
    const { service, target, directory, writes } = await fixture(); const dev = await target(), production = await target("production");
    await service.saveServerCredentials(dev.serverConnectionId, "diagnostic", { username: "dev_reader", password: "fixture-diagnostic-password" });
    await expect(service.configureDiagnostics({ profileId: production.id, policy: { tables: {} } })).rejects.toThrow("development");
    expect((await service.overview()).profiles.every(item => !item.identity)).toBe(true);
    await expect(service.configureDiagnostics({ profileId: dev.id, policy: { tables: {} } })).resolves.toHaveProperty("instructions");
    const config = await loadDiagnosticConfig(directory, protector);
    const profiles = (await service.overview()).profiles;
    expect(config.profile.identity).toEqual(profiles.find(item => item.id === dev.id)?.identity);
    expect(config.deniedIdentities).toEqual([profiles.find(item => item.id === production.id)?.identity?.fingerprint]);
    expect(writes).toEqual([]);
  });

  it("revokes diagnostics when a previously verified production identity drifts", async () => {
    const { service, target, directory, identities } = await fixture(); const dev = await target(), production = await target("production");
    await service.saveServerCredentials(dev.serverConnectionId, "diagnostic", { username: "dev_reader", password: "fixture-diagnostic-password" });
    await service.configureDiagnostics({ profileId: dev.id, policy: { tables: {} } });
    identities.set(production.id, config => ({ ...actualIdentity(config), version: "10.6.26" }));
    expect((await service.verifyTargets([production.id]))[0].status).toBe("failed");
    await expect(loadDiagnosticConfig(directory, protector)).rejects.toThrow("disabled");
  });

  it("requires replacement credentials after an endpoint edit before automatically binding its new identity", async () => {
    const { service, target, writes } = await fixture(); const profile = await target();
    await service.verifyTargets([profile.id]);
    const previous = (await service.overview()).profiles[0].identity;
    await service.saveServerConnection({ ...await service.getServerConnection(profile.serverConnectionId), host: "new-server.invalid" });
    expect((await service.overview()).profiles[0]).toMatchObject({ hasInspectionCredentials: false });
    expect((await service.overview()).profiles[0].identity).toBeUndefined();
    expect((await service.verifyTargets([profile.id]))[0].status).toBe("failed");
    await service.saveServerCredentials(profile.serverConnectionId, "inspection", { username: "new_reader", password: "new-fixture-password" });
    expect((await service.verifyTargets([profile.id]))[0].status).toBe("verified");
    const current = (await service.overview()).profiles[0].identity;
    expect(current?.serverId).toBe("new-server.invalid");
    expect(current?.fingerprint).not.toBe(previous?.fingerprint);
    expect(writes).toEqual([]);
  });
});
