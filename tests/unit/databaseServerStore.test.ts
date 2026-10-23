// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseProfileStore, type DatabaseSecretProtector } from "../../electron/databases/profileStore.js";
import type { DatabaseIdentity, DatabaseServerInput } from "../../src/types/database.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "radar-server-store-")); directories.push(directory);
  const key = randomBytes(32);
  const protector: DatabaseSecretProtector = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"); }
  };
  return { directory, protector, store: new DatabaseProfileStore(directory, protector), file: path.join(directory, "database-profiles.enc"), backup: path.join(directory, "database-profiles.v1.enc.bak") };
}
const serverInput: DatabaseServerInput = { label: "Shared fixture server", host: "server.invalid", port: 3306, tlsMode: "disabled" };
const identity = (database: string): DatabaseIdentity => ({ serverId: "mysql:fixture", database, engine: "mysql", version: "8.4.11", fingerprint: `fixture-${database}`, settings: { sqlMode: "STRICT_TRANS_TABLES", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" } });
const target = (serverConnectionId: string, database: string) => ({ serverConnectionId, database, databaseKey: database, label: database, environment: "dev" as const });

describe("shared protected database server connections", () => {
  it("shares credentials across schemas, returns editable details without passwords and retains omitted passwords", async () => {
    const { store } = await fixture(); const server = await store.saveServer(serverInput);
    const [first, second] = await store.saveProfiles([target(server.id, "one"), { ...target(server.id, "two"), environment: "production" }]);
    await store.setServerCredentials(server.id, "inspection", { username: "reader", password: "private-reader-password" });
    await store.setServerCredentials(server.id, "migration", { username: "migrator", password: "private-migrator-password" });
    expect(await store.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id, hasInspectionCredentials: true, hasMigrationCredentials: true }), expect.objectContaining({ id: second.id, hasInspectionCredentials: true, hasMigrationCredentials: true })]));
    const details = await store.getServerDetails(server.id);
    expect(details).toMatchObject({ ...serverInput, credentialUsernames: { inspection: "reader", migration: "migrator" } });
    expect(JSON.stringify(details)).not.toContain("password");
    await store.setServerCredentials(server.id, "inspection", { username: "reader" });
    expect((await store.getConnection(first.id, "inspection")).credentials.password).toBe("private-reader-password");
    expect((await store.getConnection(second.id, "inspection")).credentials.password).toBe("private-reader-password");
    await expect(store.setServerCredentials(server.id, "inspection", { username: "new-reader" })).rejects.toThrow("replacement password");
    await expect(store.setServerCredentials(server.id, "diagnostic", { username: "diagnostic" })).rejects.toThrow("replacement password");
    await store.setServerCredentials(server.id, "inspection", { username: "new-reader", password: "" });
    expect((await store.getServerConfig(server.id, "inspection")).credentials).toEqual({ username: "new-reader", password: "" });
    await store.setServerCredentials(server.id, "diagnostic", { username: "diagnostic", password: "dev-secret" });
    expect((await store.list()).find(profile => profile.id === second.id)?.hasDiagnosticCredentials).toBe(false);
    expect((await store.getConnection(first.id, "diagnostic")).database).toBe("one");
    await expect(store.getConnection(second.id, "diagnostic")).rejects.toThrow("development");
  });
  it("preserves identities on label edits, revokes all identities for TLS changes and clears credentials for endpoint changes", async () => {
    const { store } = await fixture(); const server = await store.saveServer(serverInput);
    const profiles = await store.saveProfiles([target(server.id, "one"), target(server.id, "two")]);
    await store.setServerCredentials(server.id, "inspection", { username: "reader", password: "secret" });
    await Promise.all(profiles.map(profile => store.enrollIdentity(profile.id, identity(profile.database))));
    await store.saveServer({ ...serverInput, id: server.id, label: "Renamed" });
    expect((await store.list()).every(profile => profile.identity)).toBe(true);
    await store.saveServer({ ...serverInput, id: server.id, tlsMode: "verify", tlsCa: "certificate" });
    expect((await store.list()).every(profile => !profile.identity)).toBe(true);
    expect((await store.getConnection(profiles[0].id, "inspection")).tlsMode).toBe("verify");
    expect((await store.getConnection(profiles[0].id, "inspection")).credentials.password).toBe("secret");
    await Promise.all(profiles.map(profile => store.enrollIdentity(profile.id, identity(profile.database))));
    await store.saveServer({ ...serverInput, id: server.id, host: "replacement.invalid" });
    expect((await store.list()).every(profile => !profile.identity && !profile.hasInspectionCredentials)).toBe(true);
    await expect(store.getConnection(profiles[0].id, "inspection")).rejects.toThrow("unavailable");
  });
  it("atomically rejects invalid bulk assignments, duplicate targets and duplicate edits without poisoning subsequent writes", async () => {
    const { store, file } = await fixture(); const server = await store.saveServer(serverInput);
    const initial = await readFile(file);
    await expect(store.saveProfiles([target(server.id, "one"), target(server.id, "one")])).rejects.toThrow("already assigned");
    expect(await readFile(file)).toEqual(initial);
    expect(await store.list()).toEqual([]);
    await expect(store.saveProfiles([target(server.id, "one"), target("missing-server", "two")])).rejects.toThrow("not found");
    expect(await store.list()).toEqual([]);
    const [first, second] = await store.saveProfiles([target(server.id, "one"), target(server.id, "two")]);
    await expect(store.saveProfile({ ...target(server.id, "one"), environment: "production" })).rejects.toThrow("already assigned");
    await expect(store.saveProfiles([{ ...target(server.id, "one"), id: first.id }, { ...target(server.id, "one"), id: first.id }])).rejects.toThrow("Duplicate");
    await expect(store.saveProfile({ ...target(server.id, "one"), id: second.id })).rejects.toThrow("already assigned");
    expect(await store.list()).toHaveLength(2);
    await store.enrollIdentity(first.id, { ...identity("one"), settings: { ...identity("one").settings, lowerCaseTableNames: 1 } });
    await expect(store.saveProfile(target(server.id, "ONE"))).rejects.toThrow("already assigned");
    await store.saveProfile({ ...target(server.id, "three"), id: second.id });
    expect((await store.list()).map(profile => profile.database)).toEqual(["one", "three"]);
  });
  it("switches target references without moving credentials and invalidates enrollment when its logical identity changes", async () => {
    const { store } = await fixture(); const first = await store.saveServer(serverInput); const second = await store.saveServer({ ...serverInput, host: "second.invalid" });
    await store.setServerCredentials(first.id, "inspection", { username: "first", password: "first-secret" });
    await store.setServerCredentials(second.id, "inspection", { username: "second", password: "second-secret" });
    const profile = await store.saveProfile(target(first.id, "one")); await store.enrollIdentity(profile.id, identity("one"));
    await store.saveProfile({ ...target(first.id, "one"), id: profile.id, label: "Friendly target" });
    expect((await store.list())[0].identity).toBeDefined();
    await store.saveProfile({ ...target(second.id, "one"), id: profile.id });
    expect((await store.list())[0].identity).toBeUndefined();
    expect((await store.getConnection(profile.id, "inspection")).credentials.username).toBe("second");
    await store.enrollIdentity(profile.id, identity("one"));
    await store.saveProfile({ ...target(second.id, "one"), id: profile.id, databaseKey: "linked-key" });
    expect((await store.list())[0].identity).toBeUndefined();
  });
  it("validates target/server identifiers, credentials, references and limits before persistence", async () => {
    const { store, file } = await fixture();
    expect(() => store.saveServer({ ...serverInput, id: "../escape" })).toThrow("Invalid");
    expect(() => store.saveServer({ ...serverInput, tlsMode: "insecure" as "verify" })).toThrow("Invalid");
    expect(() => store.saveServer({ ...serverInput, tlsCa: "" })).toThrow("Invalid");
    expect(() => store.saveProfile(target("../invalid", "one"))).toThrow("Invalid");
    expect(() => store.saveProfiles([])).toThrow("Invalid");
    await expect(store.saveServer({ ...serverInput, id: "missing" })).rejects.toThrow("not found");
    const server = await store.saveServer(serverInput);
    expect(() => store.setServerCredentials(server.id, "inspection", { username: "", password: "secret" })).toThrow("Invalid");
    expect(() => store.setServerCredentials(server.id, "unknown" as "inspection", { username: "user", password: "secret" })).toThrow("Invalid");
    await store.saveProfiles(Array.from({ length: 100 }, (_, index) => target(server.id, `schema${index}`)));
    const before = await readFile(file);
    await expect(store.saveProfile(target(server.id, "extra"))).rejects.toThrow("limit");
    expect(await readFile(file)).toEqual(before);
  });
});

describe("protected profile version upgrade", () => {
  it("preserves encrypted backup, target IDs, identities and role credentials while grouping only identical connections", async () => {
    const { store, directory, file, backup, protector } = await fixture();
    const credentials = { inspection: { username: "reader", password: "reader-secret" }, migration: { username: "writer", password: "writer-secret" } };
    const legacy = (id: string, database: string) => ({ id, databaseKey: database, label: database, environment: "dev", host: "legacy.invalid", port: 3306, database, tlsCa: "legacy-ca", credentials, identity: identity(database) });
    const original = protector.encryptString(JSON.stringify({ version: 1, profiles: [legacy("first-id", "one"), { ...legacy("second-id", "two"), environment: "production", credentials: { migration: credentials.migration, inspection: { password: "reader-secret", username: "reader" } } }, { ...legacy("third-id", "three"), credentials: { ...credentials, migration: { username: "writer", password: "different-secret" } } }, { ...legacy("fourth-id", "four"), tlsCa: undefined }] }));
    await writeFile(file, original);
    const firstRead = await store.list(); const servers = await store.listServers();
    expect(servers).toHaveLength(3);
    expect(firstRead.map(profile => profile.id)).toEqual(["first-id", "second-id", "third-id", "fourth-id"]);
    expect(firstRead[0].serverConnectionId).toBe(firstRead[1].serverConnectionId);
    expect(firstRead[0].serverConnectionId).not.toBe(firstRead[2].serverConnectionId);
    expect(firstRead[0].serverConnectionId).toMatch(/^legacy-/);
    expect(firstRead).toEqual(await store.list());
    expect(servers.find(server => server.id === firstRead[0].serverConnectionId)?.tlsMode).toBe("verify");
    expect(servers.find(server => server.id === firstRead[3].serverConnectionId)?.tlsMode).toBe("disabled");
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(directory)).toEqual(["database-profiles.enc"]);
    const details = await store.getServerDetails(firstRead[0].serverConnectionId);
    await store.saveServer({ ...details, label: "Saved shared server" });
    expect(await readFile(backup)).toEqual(original);
    const persisted = JSON.parse(protector.decryptString(await readFile(file)));
    expect(persisted).toMatchObject({ version: 2, servers: expect.any(Array) });
    const reloaded = new DatabaseProfileStore(directory, protector);
    expect(await reloaded.list()).toEqual(firstRead);
    expect((await reloaded.getConnection("second-id", "migration")).credentials.password).toBe("writer-secret");
    expect((await reloaded.getConnection("third-id", "migration")).credentials.password).toBe("different-secret");
    expect((await reloaded.getConnection("first-id", "inspection")).identity).toEqual(identity("one"));
    await reloaded.setServerCredentials(firstRead[0].serverConnectionId, "inspection", { username: "reader", password: "changed" });
    expect(await readFile(backup)).toEqual(original);
    expect((await readFile(file)).includes(Buffer.from("legacy.invalid"))).toBe(false);
  });
  it("refuses to overwrite a different original backup and leaves the old file untouched", async () => {
    const { store, file, backup, protector } = await fixture();
    const original = protector.encryptString(JSON.stringify({ version: 1, profiles: [] }));
    await writeFile(file, original); await writeFile(backup, "existing-backup");
    await expect(store.saveServer(serverInput)).rejects.toThrow("preserve original");
    expect(await readFile(file)).toEqual(original);
    expect(await readFile(backup, "utf8")).toBe("existing-backup");
    expect(await store.listServers()).toEqual([]);
  });
  it("fails closed for invalid references and credential payloads in version-2 files", async () => {
    const { store, file, protector } = await fixture();
    for (const data of [
      { version: 2, servers: [], profiles: [{ ...target("missing-server", "one"), id: "profile" }] },
      { version: 2, servers: [{ ...serverInput, id: "server", credentials: { inspection: { username: "user", password: null } } }], profiles: [] }
    ]) {
      const original = protector.encryptString(JSON.stringify(data)); await writeFile(file, original);
      await expect(store.listServers()).rejects.toThrow("corrupt");
      await expect(store.saveServer(serverInput)).rejects.toThrow("corrupt");
      expect(await readFile(file)).toEqual(original);
    }
  });
});
