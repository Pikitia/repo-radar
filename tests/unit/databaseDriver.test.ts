// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectDatabase, connectDatabaseServer } from "../../electron/databases/connections.js";

const driver = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), destroy: vi.fn(), createConnection: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createConnection: driver.createConnection } }));
const config = { profileId: "fixture", databaseKey: "fixture", label: "Fixture", environment: "sandbox" as const, host: "127.0.0.1", port: 33399, database: "fixture", credentials: { username: "fixture", password: "fixture" } };
beforeEach(() => { vi.resetAllMocks(); driver.createConnection.mockResolvedValue(driver); });
afterEach(() => vi.useRealTimers());

describe("database driver error boundary", () => {
  it.each([
    ["ETIMEDOUT", "timed out"], ["ECONNREFUSED", "refused"], ["ENOTFOUND", "hostname"],
    ["ER_ACCESS_DENIED_ERROR", "authentication"], ["CERT_HAS_EXPIRED", "TLS certificate"]
  ])("keeps the safe connection failure category for %s without driver details", async (code, message) => {
    driver.createConnection.mockRejectedValue(Object.assign(new Error("private-user private-password at private-host"), { code }));
    const attempt = connectDatabaseServer({ serverConnectionId: "fixture", host: "fixture.invalid", port: 3306, credentials: config.credentials });
    await expect(attempt).rejects.toThrow(message);
    await expect(attempt).rejects.not.toThrow(/private-/);
  });
  it.each(["query", "execute"] as const)("withholds native error details from %s", async operation => {
    const sensitive = new Error("Duplicate entry 'private-row-value' from private-user at private-host in SELECT private-secret");
    driver.query.mockRejectedValue(sensitive); driver.end.mockRejectedValue(sensitive);
    const session = await connectDatabase(config);
    const result = session[operation]("SELECT fixture");
    await expect(result).rejects.toThrow(/^Database /);
    await expect(result).rejects.not.toThrow(/private-|Duplicate entry/);
  });
  it("keeps connection cleanup from replacing a failed or uncertain operation result", async () => {
    driver.end.mockRejectedValue(new Error("Connection closed after private-row-value was written"));
    const session = await connectDatabase(config);
    await expect(session.close()).resolves.toBeUndefined();
    expect(driver.destroy).toHaveBeenCalledOnce();
  });
  it.each(["query", "execute"] as const)("destroys an unusable session immediately after a %s timeout", async operation => {
    driver.query.mockRejectedValue(Object.assign(new Error("Private statement still running"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" }));
    const session = await connectDatabase(config);
    await expect(session[operation]("SELECT fixture")).rejects.toThrow(/^Database /);
    expect(driver.destroy).toHaveBeenCalledOnce();
  });
  it("bounds cleanup when the driver never acknowledges queued QUIT", async () => {
    vi.useFakeTimers();
    driver.end.mockImplementation(() => new Promise(() => undefined));
    const session = await connectDatabase(config);
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(closing).resolves.toBeUndefined();
    expect(driver.destroy).toHaveBeenCalledOnce();
  });
});

describe("shared database server connections and optional TLS", () => {
  const server = { serverConnectionId: "fixture-server", host: "fixture.invalid", port: 33399, credentials: config.credentials };
  it("connects an inspection server without selecting a schema and keeps target sessions bound", async () => {
    await connectDatabaseServer(server);
    expect(driver.createConnection).toHaveBeenLastCalledWith(expect.objectContaining({ host: server.host, user: "fixture", multipleStatements: false }));
    expect(driver.createConnection.mock.calls.at(-1)![0]).not.toHaveProperty("database");
    await connectDatabase({ ...config, host: server.host, serverConnectionId: server.serverConnectionId });
    expect(driver.createConnection.mock.calls.at(-1)![0]).toHaveProperty("database", "fixture");
  });

  it.each(["dev", "production", "sandbox"] as const)("defaults TLS off for %s targets without a CA", async environment => {
    await connectDatabase({ ...config, environment });
    expect(driver.createConnection.mock.calls.at(-1)![0]).not.toHaveProperty("ssl");
  });

  it("retains legacy CA verification and allows explicit verification with system trust", async () => {
    await connectDatabaseServer({ ...server, tlsCa: "fixture-ca" });
    expect(driver.createConnection.mock.calls.at(-1)![0].ssl).toEqual({ ca: "fixture-ca", rejectUnauthorized: true, verifyIdentity: true });
    await connectDatabaseServer({ ...server, tlsMode: "verify" });
    expect(driver.createConnection.mock.calls.at(-1)![0].ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true });
  });

  it("respects an explicit TLS-off choice even when a previous CA is still supplied", async () => {
    await connectDatabaseServer({ ...server, host: "127.0.0.1", tlsMode: "disabled", tlsCa: "previous-ca" });
    expect(driver.createConnection.mock.calls.at(-1)![0]).not.toHaveProperty("ssl");
  });

  it.each(["127.0.0.1", "::1", "[::1]"])("refuses verified TLS to an unverifiable IP literal %s before connecting", async host => {
    await expect(connectDatabaseServer({ ...server, host, tlsMode: "verify" })).rejects.toThrow("DNS hostname");
    expect(driver.createConnection).not.toHaveBeenCalled();
  });

  it("rejects unknown TLS modes and redacts unbound connection errors", async () => {
    await expect(connectDatabaseServer({ ...server, tlsMode: "unverified" as never })).rejects.toThrow("TLS mode");
    expect(driver.createConnection).not.toHaveBeenCalled();
    driver.createConnection.mockRejectedValue(new Error("Private fixture credential in driver exception"));
    await expect(connectDatabaseServer(server)).rejects.toThrow(/^Database connection failed;/);
  });
});
