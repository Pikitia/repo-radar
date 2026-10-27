// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseConnectionConfig, DatabaseEnvironment } from "../../src/types/database.js";
import { DatabaseService } from "../../electron/databases/service.js";
import { DatabaseDiagnosticBroker } from "../../electron/databases/mcp.js";
import { loadMcpReadConfig, saveMcpReadConfig, saveDiagnosticConfig } from "../../electron/databases/devConfig.js";

const directories: string[] = [];
const protector = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (value: Buffer) => Buffer.from(value).reverse().toString() };
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "radar-mcp-targets-")); directories.push(directory);
  let writable = false;
  const close = vi.fn(async () => {}), execute = vi.fn(async (sql: string) => {
    if (!["SET SESSION TRANSACTION READ ONLY", "START TRANSACTION READ ONLY", "ROLLBACK"].includes(sql)) throw new Error("Unexpected write");
  });
  const connect = vi.fn(async (config: DatabaseConnectionConfig) => ({
    close, execute,
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT DATABASE")) return [{ database_name: config.database, version: "11.4.10-MariaDB", version_comment: "MariaDB", hostname: config.host, port: config.port, server_id: 10, sql_mode: "STRICT_TRANS_TABLES", lower_case_table_names: 0, character_set_database: "utf8mb4", collation_database: "utf8mb4_general_ci" }];
      if (sql.startsWith("SHOW GRANTS")) return [{ Grants: writable ? "GRANT SELECT, UPDATE ON *.* TO `reader`@`localhost`" : "GRANT SELECT ON *.* TO `reader`@`localhost`" }];
      if (sql.startsWith("SELECT TABLE_TYPE")) return [{ TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" }];
      if (sql.startsWith("SELECT COLUMN_NAME")) return ["id", "name", "password_hash"].map(COLUMN_NAME => ({ COLUMN_NAME, EXTRA: "", GENERATION_EXPRESSION: "" }));
      if (sql.includes("FROM `stock`")) return [{ id: "1", name: config.host, password_hash: "must-not-leak" }];
      return [];
    })
  }));
  const service = new DatabaseService({ directory, protector, root: () => null, repositories: async () => [], confirm: async () => false, connect });
  const broker = new DatabaseDiagnosticBroker(directory, protector, { connect });
  async function target(environment: DatabaseEnvironment, host: string, database: string) {
    let server = (await service.overview()).servers.find(item => item.host === host);
    if (!server) {
      server = await service.saveServerConnection({ label: host, host, port: 3306, tlsMode: "disabled" });
      await service.saveServerCredentials(server.id, "inspection", { username: "inspect", password: "fixture-private" });
      await service.saveServerCredentials(server.id, "diagnostic", { username: "reader", password: "fixture-private" });
    }
    return service.saveProfile({ databaseKey: "shared", label: `${environment} ${database}`, environment, serverConnectionId: server.id, database });
  }
  return { directory, service, broker, target, connect, close, execute, setWritable: () => { writable = true; } };
}

describe("explicit MCP target collection", () => {
  it("upgrades legacy development enrollment while preserving its policy when another target is enabled", async () => {
    const { service, target, directory } = await fixture();
    const dev = await target("dev", "first.invalid", "development");
    const prod = await target("production", "second.invalid", "production");
    await service.setMcpReadAccess({ profileId: dev.id, enabled: true, policy: { mode: "all" } });
    const enrolled = (await loadMcpReadConfig(directory, protector)).targets[0];
    await saveDiagnosticConfig(directory, protector, { profile: enrolled.profile, policy: { tables: { stock: ["id"] } }, deniedIdentities: [], workspaceRoot: directory, repositories: [] });
    await service.setMcpReadAccess({ profileId: prod.id, enabled: true, policy: { mode: "all" } });
    const updated = await loadMcpReadConfig(directory, protector);
    expect(updated.legacy).toBe(false);
    expect(updated.targets.map(item => item.profile.profileId)).toEqual([dev.id, prod.id]);
    expect(updated.targets[0].policy).toEqual({ tables: { stock: ["id"] } });
  });
  it("never routes a legacy development-only alias to an enabled production target", async () => {
    const { service, broker, target, connect } = await fixture();
    const prod = await target("production", "first.invalid", "production");
    await service.setMcpReadAccess({ profileId: prod.id, enabled: true, policy: { mode: "all" } });
    connect.mockClear();
    await expect(broker.call("query_dev_data", { databaseKey: prod.databaseKey, table: "stock", columns: ["id"] })).rejects.toThrow("not enrolled");
    expect(connect).not.toHaveBeenCalled();
    expect(await broker.call("list_dev_databases", {})).toEqual({ databases: [] });
    await expect(broker.call("query_database", { databaseKey: prod.databaseKey, table: "stock", columns: ["id"] })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it("reads explicitly enabled dev/production/sandbox targets across servers with the same logical key", async () => {
    const { service, broker, target, connect, execute, directory } = await fixture();
    const dev = await target("dev", "first.invalid", "development");
    const production = await target("production", "first.invalid", "production");
    const sandbox = await target("sandbox", "second.invalid", "testing");
    for (const profile of [dev, production, sandbox]) await service.setMcpReadAccess({ profileId: profile.id, enabled: true, policy: { mode: "all" } });
    const listed = await broker.call("list_databases", {}) as { databases: { profileId: string; environment: string }[] };
    expect(listed.databases.map(item => item.profileId)).toEqual([dev.id, production.id, sandbox.id]);
    expect(JSON.stringify(listed)).not.toContain("fixture-private");
    expect((await service.overview()).mcpAccess).toHaveLength(3);
    expect((await readFile(path.join(directory, "diagnostics.enc"))).toString()).not.toContain("fixture-private");
    connect.mockClear();
    for (const profile of [dev, production, sandbox]) {
      const result = await broker.call("query_database", { profileId: profile.id, table: "stock", columns: ["id", "name"] });
      expect(result).toMatchObject({ rows: [{ id: "1", name: profile.serverConnectionId === dev.serverConnectionId ? "first.invalid" : "second.invalid" }] });
    }
    expect(connect.mock.calls.map(([config]) => config.database)).toEqual(["development", "production", "testing"]);
    expect(execute).toHaveBeenCalledWith("START TRANSACTION READ ONLY");
    await expect(broker.call("query_database", { profileId: production.id, table: "stock", columns: ["password_hash"] })).rejects.toThrow("not permitted");
    await expect(broker.call("query_database", { profileId: production.id, table: "stock", columns: ["id"], sql: "UPDATE stock SET id=2" })).rejects.toThrow();
  });
  it("unchecking one database immediately removes only its access, without a database connection", async () => {
    const { service, broker, target, connect } = await fixture();
    const dev = await target("dev", "first.invalid", "development");
    const prod = await target("production", "second.invalid", "production");
    for (const profile of [dev, prod]) await service.setMcpReadAccess({ profileId: profile.id, enabled: true, policy: { mode: "all" } });
    connect.mockClear();
    await service.setMcpReadAccess({ profileId: prod.id, enabled: false });
    expect(connect).not.toHaveBeenCalled();
    await expect(broker.call("query_database", { profileId: prod.id, table: "stock", columns: ["id"] })).rejects.toThrow("not enrolled");
    expect(connect).not.toHaveBeenCalled();
    expect((await service.overview()).mcpAccess?.map(item => item.profileId)).toEqual([dev.id]);
  });
  it("revokes an edited server's targets while retaining access on another server", async () => {
    const { service, target } = await fixture();
    const dev = await target("dev", "first.invalid", "development");
    const prod = await target("production", "second.invalid", "production");
    for (const profile of [dev, prod]) await service.setMcpReadAccess({ profileId: profile.id, enabled: true, policy: { mode: "all" } });
    await service.saveServerConnection({ ...await service.getServerConnection(dev.serverConnectionId), host: "replacement.invalid" });
    expect((await service.overview()).mcpAccess?.map(item => item.profileId)).toEqual([prod.id]);
  });
  it("refuses writable accounts and keeps unapproved targets out of the projection", async () => {
    const { service, target, setWritable, directory } = await fixture();
    const prod = await target("production", "first.invalid", "production"); setWritable();
    await expect(service.setMcpReadAccess({ profileId: prod.id, enabled: true, policy: { mode: "all" } })).rejects.toThrow("privileges");
    expect((await loadMcpReadConfig(directory, protector)).targets).toEqual([]);
  });
  it("does not return rows if a target is revoked while its request is in flight", async () => {
    const { service, target, connect, directory } = await fixture();
    const dev = await target("dev", "first.invalid", "development");
    await service.setMcpReadAccess({ profileId: dev.id, enabled: true, policy: { tables: { stock: ["id"] } } });
    const config = await loadMcpReadConfig(directory, protector);
    const db = await connect(config.targets[0].profile);
    const original = db.query;
    db.query = vi.fn(async sql => {
      const result = await original(sql);
      if (sql.includes("FROM `stock`")) await saveMcpReadConfig(directory, protector, { formatVersion: 2, targets: [], repositories: [] });
      return result;
    });
    const broker = new DatabaseDiagnosticBroker(directory, protector, { connect: async () => db });
    await expect(broker.call("query_database", { profileId: dev.id, table: "stock", columns: ["id"] })).rejects.toThrow("disabled");
    expect(db.close).toHaveBeenCalled();
  });
});
