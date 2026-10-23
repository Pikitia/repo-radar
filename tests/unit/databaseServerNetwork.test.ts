// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectDatabase, connectDatabaseServer, databaseDigest, readIdentity, readServerIdentity } from "../../electron/databases/connections.js";

const driver = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), destroy: vi.fn(), createConnection: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createConnection: driver.createConnection } }));
const connection = { serverConnectionId: "fixture-server", host: "fixture.invalid", port: 3306, credentials: { username: "fixture", password: "fixture" } };
beforeEach(() => { vi.resetAllMocks(); driver.createConnection.mockResolvedValue(driver); });

function metadata(engine: "mysql" | "mariadb") {
  return { database_name: "fixture_schema", version: engine === "mysql" ? "8.4.11" : "11.4.10-MariaDB", version_comment: engine === "mysql" ? "MySQL Community Server - GPL" : "mariadb.org binary distribution", hostname: "fixture-host", port: 3306, server_id: 110, sql_mode: "STRICT_TRANS_TABLES", lower_case_table_names: 1, character_set_database: "utf8mb4", collation_database: "utf8mb4_unicode_ci" };
}
function answer(row: Record<string, unknown>) {
  driver.query.mockImplementation(async ({ sql }: { sql: string }) => [sql.includes("@@server_uuid") ? [{ server_uuid: "fixture-uuid" }] : [row]]);
}

describe("schema-independent server identity", () => {
  it.each(["mysql", "mariadb"] as const)("uses the identical %s server identity for bound and unbound inspection", async engine => {
    answer(metadata(engine));
    const unbound = await connectDatabaseServer(connection);
    const server = await readServerIdentity(unbound);
    const expectedId = engine === "mysql" ? "mysql:fixture-uuid" : `mariadb:${databaseDigest(["fixture-host", "3306", "110"])}`;
    expect(server).toEqual({ serverId: expectedId, engine, version: metadata(engine).version, lowerCaseTableNames: 1 });
    const calls = driver.query.mock.calls.map(([query]) => query.sql as string);
    expect(calls.every(sql => !sql.includes("DATABASE()") && !sql.includes("character_set_database"))).toBe(true);
    const bound = await connectDatabase({ ...connection, profileId: "fixture-target", databaseKey: "fixture", environment: "dev", database: "fixture_schema" });
    const identity = await readIdentity(bound, "fixture_schema");
    expect(identity.serverId).toBe(server.serverId);
    expect(identity.fingerprint).toBe(databaseDigest([expectedId, "fixture_schema"]));
    await expect(readIdentity(bound, "other_schema")).rejects.toThrow("does not match");
  });

  it.each([
    { ...metadata("mysql"), version: "9.0.0" },
    { ...metadata("mariadb"), version: "10.5.28-MariaDB" },
    { ...metadata("mariadb"), version: "12.0.1-MariaDB" },
    { ...metadata("mysql"), version: "unknown" },
  ])("refuses unverified engine versions %j", async row => {
    answer(row);
    const session = await connectDatabaseServer(connection);
    await expect(readServerIdentity(session)).rejects.toThrow(/engine version/);
  });

  it("refuses incomplete settings and missing stable server identities", async () => {
    answer({ ...metadata("mariadb"), lower_case_table_names: 7 });
    const session = await connectDatabaseServer(connection);
    await expect(readServerIdentity(session)).rejects.toThrow("settings");
    answer({ ...metadata("mariadb"), hostname: "" });
    await expect(readServerIdentity(session)).rejects.toThrow("identity is unavailable");
    driver.query.mockImplementation(async ({ sql }: { sql: string }) => [sql.includes("@@server_uuid") ? [] : [metadata("mysql")]]);
    await expect(readServerIdentity(session)).rejects.toThrow("identity is unavailable");
  });
});
