// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseProfileStore, type DatabaseSecretProtector } from "../../electron/databases/profileStore.js";
import { connectDatabase, readIdentity, type SqlSession } from "../../electron/databases/connections.js";
import { captureSchema, compareSchemas } from "../../electron/databases/schema.js";
import type { DatabaseIdentity, DatabaseProfileInput, DatabaseServerInput } from "../../src/types/database.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const result = await mkdtemp(path.join(os.tmpdir(), "radar-database-access-")); temporary.push(result); return result; }
function protector(): DatabaseSecretProtector {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); }
  };
}
const serverInput: DatabaseServerInput = { label: "Shared server", host: "private-host.example", port: 3306, tlsMode: "verify", tlsCa: "test certificate authority" };
const input: DatabaseProfileInput = { databaseKey: "catalog", label: "Catalog development", environment: "dev", serverConnectionId: "replaced-by-fixture", database: "catalog_dev" };
const identity: DatabaseIdentity = { serverId: "mysql:one", database: "catalog_dev", engine: "mysql", version: "8.0.39", fingerprint: "dev-fingerprint", settings: { sqlMode: "STRICT_TRANS_TABLES", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" } };
function session(query: SqlSession["query"]): SqlSession { return { query, execute: async () => undefined, close: async () => undefined }; }

describe("protected database profiles", () => {
  it("encrypts all target details, exposes safe summaries and survives reload", async () => {
    const dir = await directory(); const protection = protector(); const store = new DatabaseProfileStore(dir, protection);
    const server = await store.saveServer(serverInput);
    const profile = await store.saveProfile({ ...input, serverConnectionId: server.id });
    await store.setCredentials(profile.id, "inspection", { username: "private-username", password: "private-password" });
    await store.enrollIdentity(profile.id, identity);
    const safe = (await store.list())[0];
    expect(safe).toMatchObject({ hasInspectionCredentials: true, identity });
    expect(JSON.stringify(safe)).not.toMatch(/private-host|private-username|private-password|test certificate/);
    const bytes = (await readFile(path.join(dir, "database-profiles.enc"))).toString();
    expect(bytes).not.toMatch(/private-host|private-username|private-password|catalog_dev/);
    const reloaded = new DatabaseProfileStore(dir, protection);
    expect((await reloaded.getConnection(profile.id, "inspection")).credentials.password).toBe("private-password");
    expect((await reloaded.getConnection(profile.id, "inspection")).host).toBe(serverInput.host);
  });
  it("fails closed for unavailable encryption and corruption without overwriting history", async () => {
    const dir = await directory(); const protection = protector(); const store = new DatabaseProfileStore(dir, protection);
    const server = await store.saveServer(serverInput);
    await store.saveProfile({ ...input, serverConnectionId: server.id });
    await writeFile(path.join(dir, "database-profiles.enc"), "corrupt-private-payload");
    await expect(store.list()).rejects.toThrow("corrupt or cannot be decrypted");
    await expect(store.saveProfile(input)).rejects.toThrow("corrupt or cannot be decrypted");
    expect(await readFile(path.join(dir, "database-profiles.enc"), "utf8")).toBe("corrupt-private-payload");
    const unavailable = new DatabaseProfileStore(dir, { ...protection, isEncryptionAvailable: () => false });
    await expect(unavailable.list()).rejects.toThrow("unavailable");
  });
  it("separates roles, serializes writes and revokes target identity on connection edits", async () => {
    const store = new DatabaseProfileStore(await directory(), protector());
    const server = await store.saveServer(serverInput);
    const target = { ...input, serverConnectionId: server.id };
    const [dev, prod] = await Promise.all([store.saveProfile(target), store.saveProfile({ ...target, database: "catalog_prod", environment: "production", label: "Production" })]);
    expect(await store.list()).toHaveLength(2);
    await store.setCredentials(dev.id, "inspection", { username: "reader", password: "read-secret" });
    await expect(store.getConnection(dev.id, "migration")).rejects.toThrow("unavailable");
    await expect(store.setCredentials(prod.id, "diagnostic", { username: "diagnostic", password: "secret" })).rejects.toThrow("development");
    await store.enrollIdentity(dev.id, identity);
    await store.saveServer({ ...serverInput, id: server.id, host: "different.example" });
    expect((await store.list()).find(profile => profile.id === dev.id)?.identity).toBeUndefined();
  });
  it("rejects invalid profiles and mismatched enrollment", async () => {
    const store = new DatabaseProfileStore(await directory(), protector());
    expect(() => store.saveServer({ ...serverInput, port: 0 })).toThrow("Invalid");
    expect(() => store.saveProfile({ ...input, database: "" })).toThrow("Invalid");
    const server = await store.saveServer(serverInput);
    const profile = await store.saveProfile({ ...input, serverConnectionId: server.id });
    await expect(store.enrollIdentity(profile.id, { ...identity, database: "production" })).rejects.toThrow("Invalid");
  });
});

describe("database engine identity and TLS policy", () => {
  it.each(["mysql", "mariadb"] as const)("detects %s from server metadata", async engine => {
    const fixture = session(async sql => sql.includes("server_uuid") ? [{ server_uuid: "stable-uuid" }] : [{ database_name: "catalog_dev", version: engine === "mysql" ? "8.0.39" : "10.11.8-MariaDB", version_comment: engine === "mysql" ? "MySQL Community Server - GPL" : "mariadb.org binary distribution", hostname: "test-server", port: 3306, server_id: 11, sql_mode: "STRICT_TRANS_TABLES", lower_case_table_names: 0, character_set_database: "utf8mb4", collation_database: "utf8mb4_unicode_ci" }]);
    const result = await readIdentity(fixture, "catalog_dev");
    expect(result.engine).toBe(engine);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(readIdentity(fixture, "different")).rejects.toThrow("does not match");
  });
  it("rejects verified TLS with IP literals before networking", async () => {
    await expect(connectDatabase({ ...input, ...serverInput, tlsMode: "verify", host: "10.0.0.8", profileId: "fixture", credentials: { username: "fixture", password: "fixture" }, environment: "production" })).rejects.toThrow("DNS hostname");
  });
});

function schemaFixture(options: { grants?: string; hidden?: boolean; change?: boolean; triggerDefiner?: string; events?: string[]; denyEvents?: boolean } = {}): SqlSession {
  let tableCapture = 0;
  return session(async sql => {
    if (sql.startsWith("SHOW GRANTS")) return [{ grant: options.grants ?? "GRANT ALL PRIVILEGES ON *.* TO 'test'@'localhost'" }];
    if (sql.includes("information_schema.EVENTS")) { if (options.denyEvents) throw new Error("Fixture event metadata denied"); return (options.events ?? []).map(EVENT_NAME => ({ EVENT_NAME })); }
    if (sql.includes("information_schema.TABLES")) { tableCapture++; return [{ TABLE_NAME: "items", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_unicode_ci", ROW_FORMAT: "Dynamic", CREATE_OPTIONS: "", TABLE_COMMENT: "" }, { TABLE_NAME: "db_radar_history", TABLE_TYPE: "BASE TABLE" }, { TABLE_NAME: "item_view", TABLE_TYPE: "VIEW" }]; }
    if (sql.startsWith("SHOW CREATE TABLE")) return [{ "Create Table": `CREATE TABLE \`items\` (\`id\` int, \`text\` varchar(30) DEFAULT 'AUTO_INCREMENT=1') ENGINE=InnoDB AUTO_INCREMENT=${options.change && tableCapture > 1 ? 2 : 1}` }];
    if (sql.startsWith("SHOW CREATE VIEW")) return [{ "Create View": "CREATE VIEW `item_view` AS SELECT `id` FROM `catalog_dev`.`items`" }];
    if (sql.includes("information_schema.COLUMNS")) return [{ TABLE_NAME: "items", COLUMN_NAME: "id", ORDINAL_POSITION: 1, COLUMN_TYPE: options.change && tableCapture > 1 ? "bigint" : "int", EXTRA: "STORED GENERATED", GENERATION_EXPRESSION: "`price` * 2" }];
    if (sql.includes("information_schema.STATISTICS")) return [{ TABLE_NAME: "items", INDEX_NAME: "PRIMARY", SEQ_IN_INDEX: 1, COLUMN_NAME: "id" }];
    if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return [{ TABLE_NAME: "items", CONSTRAINT_NAME: "fk_owner", ORDINAL_POSITION: 1, COLUMN_NAME: "owner_id", REFERENCED_TABLE_NAME: "owners", REFERENCED_COLUMN_NAME: "id", DELETE_RULE: "RESTRICT" }];
    if (sql.includes("information_schema.ROUTINES")) return [{ ROUTINE_NAME: "count_items", ROUTINE_TYPE: "FUNCTION", ROUTINE_DEFINITION: options.hidden ? null : "RETURN 1" }];
    if (sql.startsWith("SHOW CREATE FUNCTION")) return [{ "Create Function": options.hidden ? null : "CREATE FUNCTION `count_items`() RETURNS INT RETURN 1" }];
    if (sql.includes("information_schema.TRIGGERS")) return [{ TRIGGER_NAME: "items_before_insert", ...(sql.includes("DEFINER") ? { DEFINER: options.triggerDefiner ?? "app_reader@localhost" } : {}), EVENT_OBJECT_TABLE: "items", ACTION_STATEMENT: "SET NEW.id = 1", ACTION_TIMING: "BEFORE" }];
    throw new Error("Unexpected fixture query");
  });
}

describe.each(["mysql", "mariadb"] as const)("%s schema metadata fixtures", engine => {
  const target = { ...identity, engine, version: engine === "mysql" ? "8.0.39" : "10.11.8-MariaDB" };
  it("captures every advertised object and omits only tool history objects", async () => {
    const snapshot = await captureSchema(schemaFixture(), target);
    expect(snapshot.coverage).toEqual({ complete: true, limitations: [], excludedObjectPrefixes: ["db_radar_"] });
    expect(new Set(snapshot.objects.map(object => object.objectType))).toEqual(new Set(["table", "column", "index", "foreign-key", "view", "routine", "trigger"]));
    expect(JSON.stringify(snapshot.objects)).not.toContain("db_radar_history");
    expect(JSON.stringify(snapshot.objects)).toContain("GENERATION_EXPRESSION");
    const definition = snapshot.objects.find(object => object.objectPath === "items/definition")!.definition;
    expect(definition).toContain("DEFAULT 'AUTO_INCREMENT=1'");
    expect(definition).not.toContain("ENGINE=InnoDB AUTO_INCREMENT");
  });
  it("never reports clean for missing metadata privileges, hidden routines or changing schemas", async () => {
    const restricted = await captureSchema(schemaFixture({ grants: "GRANT SELECT ON `catalog_dev`.* TO 'test'@'localhost'", hidden: true }), target);
    const comparison = compareSchemas(restricted, { ...restricted, identity: { ...target, fingerprint: "other" } });
    expect(comparison.assessment).toBe("unverified");
    expect(comparison.coverage.limitations.join(" ")).toMatch(/visibility|Definition unavailable/);
    const changed = await captureSchema(schemaFixture({ change: true }), target);
    expect(changed.coverage.complete).toBe(false);
    expect(changed.coverage.limitations.join(" ")).toContain("changed during capture");
  });
  it("exposes differences and identity/settings blockers", async () => {
    const snapshot = await captureSchema(schemaFixture(), target);
    const production = { ...snapshot, identity: { ...target, fingerprint: "production-fingerprint" } };
    expect(compareSchemas(snapshot, production).assessment).toBe("explained");
    expect(compareSchemas(snapshot, { ...production, objects: [] }).assessment).toBe("unexplained");
    expect(compareSchemas(snapshot, snapshot).assessment).toBe("unverified");
    expect(compareSchemas(snapshot, { ...production, identity: { ...production.identity, settings: { ...target.settings, lowerCaseTableNames: 1 } } }).assessment).toBe("unverified");
  });
  it("detects a trigger definer change even when its body and table are identical", async () => {
    const before = await captureSchema(schemaFixture({ triggerDefiner: "restricted_app@localhost" }), target);
    const after = await captureSchema(schemaFixture({ triggerDefiner: "privileged_app@localhost" }), { ...target, fingerprint: "production-fingerprint" });
    expect(before.coverage.complete).toBe(true);
    expect(after.coverage.complete).toBe(true);
    expect(before.digest).not.toBe(after.digest);
    const comparison = compareSchemas(before, after);
    expect(comparison.assessment).toBe("unexplained");
    expect(comparison.differences).toHaveLength(1);
    expect(comparison.differences[0]).toMatchObject({ objectType: "trigger", objectPath: "items_before_insert", devDefinition: expect.stringContaining("restricted_app@localhost"), productionDefinition: expect.stringContaining("privileged_app@localhost") });
  });
  it("keeps scheduled events outside supported coverage instead of claiming a clean schema", async () => {
    const withEvent = await captureSchema(schemaFixture({ events: ["nightly_rollup"] }), target);
    expect(withEvent.coverage.complete).toBe(false);
    expect(withEvent.coverage.limitations).toContain("Scheduled events exist and are outside this adapter's supported structural coverage");
    const withoutEvent = await captureSchema(schemaFixture(), { ...target, fingerprint: "production-fingerprint" });
    expect(compareSchemas(withEvent, withoutEvent).assessment).toBe("unverified");
  });
  it("requires event visibility even if every other structural privilege is present", async () => {
    const grants = "GRANT SELECT, SHOW VIEW, TRIGGER, EXECUTE ON `catalog_dev`.* TO 'test'@'localhost'\nGRANT SHOW_ROUTINE ON *.* TO 'test'@'localhost'";
    const hidden = await captureSchema(schemaFixture({ grants }), target);
    expect(hidden.coverage.complete).toBe(false);
    expect(hidden.coverage.limitations).toEqual(["Complete scheduled-event visibility could not be verified"]);
    const visible = await captureSchema(schemaFixture({ grants: grants.replace("TRIGGER, EXECUTE", "TRIGGER, EXECUTE, EVENT") }), target);
    expect(visible.coverage.complete).toBe(true);
  });
  it("marks denied event metadata unverified even with advertised broad privileges", async () => {
    const denied = await captureSchema(schemaFixture({ denyEvents: true }), target);
    expect(denied.coverage.complete).toBe(false);
    expect(denied.coverage.limitations).toContain("Metadata unavailable: information_schema.EVENTS");
  });
});
