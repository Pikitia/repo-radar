// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileDevQuery, queryDevData, verifyReadOnlyDiagnosticGrants } from "../../electron/databases/devQuery.js";
import { disableDiagnosticConfig, loadDiagnosticConfig, saveDiagnosticConfig, type DiagnosticConfig } from "../../electron/databases/devConfig.js";
import { DatabaseDiagnosticBroker } from "../../electron/databases/mcp.js";
import { databaseDigest, readIdentity, type SqlSession } from "../../electron/databases/connections.js";
import { createDatabaseMcpServer } from "../../electron/databases/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let directory: string;
const protector = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)), decryptString: (value: Buffer) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)).toString() };
const policy = { tables: { stock: ["id", "name", "quantity"] } };
function session(): SqlSession {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT DATABASE")) return [{ database_name: "development", version: "10.6.20-MariaDB", version_comment: "MariaDB", hostname: "fixture", port: 3306, server_id: 10, sql_mode: "STRICT_TRANS_TABLES", lower_case_table_names: 0, character_set_database: "utf8mb4", collation_database: "utf8mb4_general_ci" }];
      if (sql.startsWith("SHOW GRANTS")) return [{ Grants: "GRANT SELECT ON `development`.* TO `diagnostic`@`localhost`" }];
      if (sql.startsWith("SELECT TABLE_TYPE")) return [{ TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" }];
      if (sql.startsWith("SELECT COLUMN_NAME")) return ["id", "name", "quantity"].map(COLUMN_NAME => ({ COLUMN_NAME, EXTRA: "", GENERATION_EXPRESSION: "" }));
      return [{ id: "1", name: "Fixture", quantity: "5", password: "must never leak" }];
    }), execute: vi.fn(async () => {}), close: vi.fn(async () => {}), destroy: vi.fn()
  };
}
async function config(): Promise<DiagnosticConfig> {
  const workspace = path.join(directory, "workspace"); await mkdir(workspace, { recursive: true });
  return { profile: { profileId: "dev", databaseKey: "shared", environment: "dev", host: "fixture.invalid", port: 3306, database: "development", tlsCa: "fixture-only-not-a-real-ca", credentials: { username: "diagnostic", password: "test-secret" }, identity: await readIdentity(session(), "development") }, policy, deniedIdentities: [], workspaceRoot: workspace, repositories: [] };
}
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "radar-diagnostics-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("dedicated encrypted diagnostic configuration", () => {
  it("round trips only a dev profile and removes it on revocation", async () => {
    const input = await config(); await saveDiagnosticConfig(directory, protector, input);
    expect(await loadDiagnosticConfig(directory, protector)).toEqual(input);
    expect((await readFile(path.join(directory, "diagnostics.enc"))).toString()).not.toContain("test-secret");
    await disableDiagnosticConfig(directory);
    await expect(loadDiagnosticConfig(directory, protector)).rejects.toThrow("disabled");
  });
  it("rejects production, denied identities, forbidden fields and secret-like allowlists", async () => {
    const input = await config();
    await expect(saveDiagnosticConfig(directory, protector, { ...input, profile: { ...input.profile, environment: "production" } })).rejects.toThrow();
    await expect(saveDiagnosticConfig(directory, protector, { ...input, deniedIdentities: [input.profile.identity!.fingerprint] })).rejects.toThrow("approved development");
    await expect(saveDiagnosticConfig(directory, protector, { ...input, policy: { tables: { invoicing_settings: ["id"] } } })).rejects.toThrow("restricted");
    await expect(saveDiagnosticConfig(directory, protector, { ...input, policy: { tables: { stock: ["password_hash"] } } })).rejects.toThrow("restricted");
    await expect(saveDiagnosticConfig(directory, protector, { ...input, production: {} } as DiagnosticConfig)).rejects.toThrow();
  });
  it.each([undefined, "disabled", "verify"] as const)("preserves a dev-only server reference with optional TLS mode %s and no custom CA", async tlsMode => {
    const input = await config();
    delete input.profile.tlsCa;
    input.profile.serverConnectionId = "fixture-shared-server";
    if (tlsMode) input.profile.tlsMode = tlsMode;
    await saveDiagnosticConfig(directory, protector, input);
    expect(await loadDiagnosticConfig(directory, protector)).toEqual(input);
    expect((await readFile(path.join(directory, "diagnostics.enc"))).toString()).not.toContain("test-secret");
  });
  it("continues to reject unverifiable TLS modes and arbitrary connection options", async () => {
    const input = await config();
    await expect(saveDiagnosticConfig(directory, protector, { ...input, profile: { ...input.profile, tlsMode: "unverified" as never } })).rejects.toThrow();
    await expect(saveDiagnosticConfig(directory, protector, { ...input, profile: { ...input.profile, ssl: { rejectUnauthorized: false } } } as DiagnosticConfig)).rejects.toThrow();
  });
});

describe("structured read-only query grammar", () => {
  it("quotes permitted names and parameterizes every value and page bound", () => {
    const compiled = compileDevQuery({ databaseKey: "shared", table: "stock", columns: ["id", "name"], filters: [{ column: "name", op: "eq", value: "'; DROP TABLE stock; --" }], order: [{ column: "id", direction: "desc" }], page: { limit: 10, offset: 20 } }, policy);
    expect(compiled.sql).toContain("WHERE `name` = ? ORDER BY `id` DESC LIMIT ? OFFSET ?");
    expect(compiled.sql).not.toContain("DROP"); expect(compiled.params).toEqual(["'; DROP TABLE stock; --", 11, 20]);
  });
  it.each([
    { table: "stock; DROP TABLE stock" }, { columns: ["password"] }, { sql: "SELECT 1" }, { environment: "production" }, { database: "mysql" },
    { table: "stock", columns: ["id"], page: { limit: 100000 } }, { aggregate: { function: "sleep", column: "id" } },
    { filters: [{ column: "id", op: "eq" }] }, { filters: [{ column: "id", op: "is-null", value: 0 }] }
  ])("rejects unsafe input %j", extra => {
    expect(() => compileDevQuery({ databaseKey: "shared", table: "stock", columns: ["id"], ...extra }, policy)).toThrow();
  });
  it("rejects disallowed tables even if the operator supplies a secret table policy", () => {
    expect(() => compileDevQuery({ databaseKey: "shared", table: "api_tokens", columns: ["id"] }, { tables: { api_tokens: ["id"] } })).toThrow("not permitted");
  });
  it("bounds rows, drops unrequested fields and exposes cell limits", async () => {
    const db = session();
    vi.mocked(db.query).mockImplementation(async sql => sql.startsWith("SELECT TABLE_TYPE") ? [{ TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" }] : sql.startsWith("SELECT COLUMN_NAME") ? [{ COLUMN_NAME: "id", EXTRA: "", GENERATION_EXPRESSION: "" }] : [{ id: "1", password: "secret" }, { id: "2" }]);
    const result = await queryDevData(db, "development", { databaseKey: "shared", table: "stock", columns: ["id"], page: { limit: 1 } }, policy);
    expect(result.rows).toEqual([{ id: "1" }]); expect(result.truncated).toBe(true); expect(result.cellLimitCharacters).toBe(1024);
  });
  it.each([{ TABLE_TYPE: "VIEW", ENGINE: null }, { TABLE_TYPE: "BASE TABLE", ENGINE: "FEDERATED" }])("rejects views and remote storage %j", async row => {
    const db = session(); vi.mocked(db.query).mockResolvedValue([row]);
    await expect(queryDevData(db, "development", { databaseKey: "shared", table: "stock", columns: ["id"] }, policy)).rejects.toThrow("local InnoDB");
  });
  it("rejects generated expressions", async () => {
    const db = session(); vi.mocked(db.query).mockImplementation(async sql => sql.startsWith("SELECT TABLE_TYPE") ? [{ TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" }] : [{ COLUMN_NAME: "id", EXTRA: "VIRTUAL GENERATED", GENERATION_EXPRESSION: "unsafe()" }]);
    await expect(queryDevData(db, "development", { databaseKey: "shared", table: "stock", columns: ["id"] }, policy)).rejects.toThrow("Generated");
  });
  it("pins the user object before validating metadata and returns no data if it resolves to a view", async () => {
    const db = session();
    vi.mocked(db.query).mockImplementation(async sql => sql.startsWith("SELECT TABLE_TYPE") ? [{ TABLE_TYPE: "VIEW", ENGINE: null }] : []);
    await expect(queryDevData(db, "development", { databaseKey: "shared", table: "stock", columns: ["id"] }, policy)).rejects.toThrow("base tables");
    expect(db.query).toHaveBeenNthCalledWith(1, "SELECT 1 FROM `stock` LIMIT 0");
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.startsWith("SELECT LEFT"))).toBe(false);
  });
  it.each(["GRANT ALL PRIVILEGES ON `development`.* TO `u`@`%`", "GRANT SELECT, EXECUTE ON `development`.* TO `u`@`%`", "GRANT SELECT ON *.* TO `u`@`%`", "GRANT SELECT ON `other`.* TO `u`@`%`", "GRANT `reader` TO `u`@`%`", "GRANT SELECT ON `development`.* TO `u`@`%` WITH GRANT OPTION"]) ("rejects unsafe grants %s", async grant => {
    const db = session(); vi.mocked(db.query).mockResolvedValue([{ Grants: grant }]);
    await expect(verifyReadOnlyDiagnosticGrants(db, "development")).rejects.toThrow();
  });
});

describe("MCP development-only enforcement", () => {
  it("honors the global off switch even for an already-running broker", async () => {
    await saveDiagnosticConfig(directory, protector, await config());
    let enabled = true;
    const connect = vi.fn(async () => session());
    const broker = new DatabaseDiagnosticBroker(directory, protector, { enabled: () => enabled, connect });
    await expect(broker.call("list_dev_databases", {})).resolves.toBeDefined();
    enabled = false;
    await expect(broker.call("list_dev_databases", {})).rejects.toThrow("disabled in Settings");
    await expect(broker.call("query_dev_data", { databaseKey: "shared", table: "stock", columns: ["id"] })).rejects.toThrow("disabled in Settings");
    expect(connect).not.toHaveBeenCalled();
  });
  it("negotiates MCP and exposes only five safe tools over an SDK transport", async () => {
    await saveDiagnosticConfig(directory, protector, await config());
    const server = createDatabaseMcpServer(directory, protector, { connect: async () => session() });
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["list_dev_databases", "get_dev_schema", "query_dev_data", "submit_migration", "get_submission_status"]);
      const allowed = await client.callTool({ name: "list_dev_databases", arguments: {} });
      expect(JSON.stringify(allowed)).toContain("shared");
      const denied = await client.callTool({ name: "query_dev_data", arguments: { databaseKey: "shared", table: "stock", columns: ["id"], sql: "DROP DATABASE production" } });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("DROP DATABASE");
    } finally { await client.close(); await server.close(); }
  });
  it("checks identity, read-only grants and transaction before returning only permitted rows", async () => {
    const input = await config(); await saveDiagnosticConfig(directory, protector, input);
    const db = session(), connect = vi.fn(async () => db);
    const broker = new DatabaseDiagnosticBroker(directory, protector, { connect });
    const result = await broker.call("query_dev_data", { databaseKey: "shared", table: "stock", columns: ["id", "name"] });
    expect(result).toMatchObject({ identity: input.profile.identity, rows: [{ id: "1", name: "Fixture" }] });
    expect(db.execute).toHaveBeenNthCalledWith(1, "SET SESSION TRANSACTION READ ONLY");
    expect(db.execute).toHaveBeenNthCalledWith(2, "START TRANSACTION READ ONLY");
    expect(db.execute).toHaveBeenLastCalledWith("ROLLBACK"); expect(db.close).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(input.profile);
  });
  it("denies different database keys and environment overrides before making a connection", async () => {
    await saveDiagnosticConfig(directory, protector, await config());
    const connect = vi.fn(async () => session()), broker = new DatabaseDiagnosticBroker(directory, protector, { connect });
    await expect(broker.call("query_dev_data", { databaseKey: "production", table: "stock", columns: ["id"] })).rejects.toThrow("not enrolled");
    await expect(broker.call("query_dev_data", { databaseKey: "shared", table: "stock", columns: ["id"], environment: "production" })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    await expect(broker.call("run_migration", {})).rejects.toThrow("Unknown");
  });
  it("denies changed live identity before data, and closes the connection", async () => {
    const input = await config(); input.profile.identity!.fingerprint = databaseDigest("other"); await saveDiagnosticConfig(directory, protector, input);
    const db = session(), broker = new DatabaseDiagnosticBroker(directory, protector, { connect: async () => db });
    await expect(broker.call("query_dev_data", { databaseKey: "shared", table: "stock", columns: ["id"] })).rejects.toThrow("Live development identity");
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining("FROM `stock`"), expect.anything()); expect(db.close).toHaveBeenCalled();
  });
  it("reloads revocation for each request and withholds rows when revoked during a request", async () => {
    await saveDiagnosticConfig(directory, protector, await config());
    const db = session();
    const previous = db.query;
    db.query = vi.fn(async (sql, params) => { const result = await previous(sql, params); if (sql.includes("FROM `stock`")) await disableDiagnosticConfig(directory); return result; });
    const broker = new DatabaseDiagnosticBroker(directory, protector, { connect: async () => db });
    await expect(broker.call("query_dev_data", { databaseKey: "shared", table: "stock", columns: ["id"] })).rejects.toThrow("disabled");
    await expect(broker.call("list_dev_databases", {})).rejects.toThrow("disabled");
  });
  it("does not expose hostnames, passwords or production registration when listing", async () => {
    await saveDiagnosticConfig(directory, protector, await config());
    const connect = vi.fn(async () => session());
    const result = JSON.stringify(await new DatabaseDiagnosticBroker(directory, protector, { connect }).call("list_dev_databases", {}));
    expect(result).toContain("shared"); expect(result).not.toContain("test-secret"); expect(result).not.toContain("fixture.invalid"); expect(connect).not.toHaveBeenCalled();
  });
});
