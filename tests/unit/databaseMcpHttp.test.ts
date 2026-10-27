// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalDatabaseMcpServer } from "../../electron/databases/mcpHttp.js";
import { saveDiagnosticConfig } from "../../electron/databases/devConfig.js";

let directory: string;
const controllers: LocalDatabaseMcpServer[] = [];
const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)),
  decryptString: (value: Buffer) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)).toString()
};
function controller(options: ConstructorParameters<typeof LocalDatabaseMcpServer>[2] = {}) {
  const value = new LocalDatabaseMcpServer(directory, protector, { port: 0, ...options });
  controllers.push(value); return value;
}
function headers(value: LocalDatabaseMcpServer) { return { Authorization: `Bearer ${value.connectionDetails().token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }; }
async function send(value: LocalDatabaseMcpServer, options: RequestInit = {}) {
  return fetch(value.connectionDetails().url, { method: "POST", headers: headers(value), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ...options });
}
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "radar-mcp-http-")); });
afterEach(async () => { await Promise.all(controllers.splice(0).map(value => value.close())); await rm(directory, { recursive: true, force: true }); });

describe("desktop loopback MCP lifecycle", () => {
  it("negotiates the real protocol, exposes only restricted tools, and denies unenrolled data access", async () => {
    const value = controller(); await value.setEnabled(true);
    expect(value.status()).toMatchObject({ enabled: true, running: true });
    const client = new Client({ name: "local-http-fixture", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(value.connectionDetails().url), { requestInit: { headers: headers(value) } }));
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(["get_database_schema", "get_submission_status", "list_databases", "query_database", "submit_migration"].sort());
      const denied = await client.callTool({ name: "list_dev_databases", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain(value.connectionDetails().token);
    } finally { await client.close(); }
  });
  it("keeps request identifiers independent across simultaneous clients", async () => {
    const value = controller(); await value.setEnabled(true);
    const responses = await Promise.all(Array.from({ length: 5 }, () => send(value)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 1, result: { tools: expect.any(Array) } });
    }
  });
  it("persists an encrypted token across disable, restart and concurrent first publication", async () => {
    const first = controller(), second = controller();
    await Promise.all([first.setEnabled(true), second.setEnabled(true)]);
    const token = first.connectionDetails().token;
    expect(second.connectionDetails().token).toBe(token);
    expect((await readFile(path.join(directory, "mcp-auth.enc"))).toString()).not.toContain(token);
    expect(JSON.stringify(first.status())).not.toContain(token);
    await first.setEnabled(false);
    expect(first.status()).toEqual({ enabled: false, running: false });
    expect(() => first.connectionDetails()).toThrow("not running");
    await first.setEnabled(true);
    expect(first.connectionDetails().token).toBe(token);
    expect(await readdir(directory)).toEqual(["mcp-auth.enc"]);
  });
  it("leaves a conflicting listener running and exposes a safe startup error", async () => {
    const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const address = occupied.address(); if (!address || typeof address === "string") throw new Error("Fixture has no port");
      const value = controller({ port: address.port }); await value.setEnabled(true);
      expect(value.status()).toMatchObject({ enabled: true, running: false, error: expect.stringContaining("could not start") });
      expect(occupied.listening).toBe(true);
      expect(() => value.connectionDetails()).toThrow("not running");
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
  it("fails closed on corrupt protected storage and preserves its bytes", async () => {
    const bytes = Buffer.from("damaged encrypted token"); await writeFile(path.join(directory, "mcp-auth.enc"), bytes);
    const value = controller(); await value.setEnabled(true);
    expect(value.status()).toMatchObject({ enabled: true, running: false, error: expect.any(String) });
    expect(await readFile(path.join(directory, "mcp-auth.enc"))).toEqual(bytes);
  });
  it("does not listen or write a token when OS encryption is unavailable", async () => {
    const value = new LocalDatabaseMcpServer(directory, { ...protector, isEncryptionAvailable: () => false }, { port: 0 }); controllers.push(value);
    await value.setEnabled(true);
    expect(value.status()).toMatchObject({ enabled: true, running: false, error: expect.any(String) });
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects an ordinary directory in place of the token without replacing it", async () => {
    await mkdir(path.join(directory, "mcp-auth.enc"));
    const value = controller(); await value.setEnabled(true);
    expect(value.status().running).toBe(false);
    expect(await readdir(path.join(directory, "mcp-auth.enc"))).toEqual([]);
  });
});

describe("loopback request boundary", () => {
  it("retains capacity for aborted broker work across disable/re-enable until its connection settles", async () => {
    await saveDiagnosticConfig(directory, protector, {
      profile: { profileId: "dev", databaseKey: "fixture", environment: "dev", host: "fixture.invalid", port: 3306, database: "development", credentials: { username: "fixture-reader", password: "fake-password" }, identity: { serverId: "fixture", database: "development", fingerprint: "a".repeat(64), engine: "mariadb", version: "10.6.25", settings: { sqlMode: "", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" } } },
      policy: { tables: {} }, deniedIdentities: [], workspaceRoot: directory, repositories: []
    });
    let started!: () => void, release!: () => void;
    const connecting = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<never>((_resolve, reject) => { release = () => reject(new Error("Owned fixture connection released without contacting any database.")); });
    const connect = vi.fn(() => { started(); return blocked; });
    const value = controller({ maxConcurrentRequests: 1, dependencies: { connect } }); await value.setEnabled(true);
    const pending = request(value.connectionDetails().url, { method: "POST", headers: headers(value) });
    pending.on("error", () => undefined);
    pending.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_dev_schema", arguments: { databaseKey: "fixture" } } }));
    try {
      await connecting;
      pending.destroy();
      // Aborting a response must not free a slot while the driver is connecting.
      for (let attempt = 0; attempt < 3; attempt++) expect((await send(value)).status).toBe(429);
      await value.setEnabled(false);
      await value.setEnabled(true);
      expect((await send(value)).status).toBe(429);
      expect(connect).toHaveBeenCalledOnce();
      release();
      await vi.waitFor(async () => { expect((await send(value)).status).toBe(200); });
    } finally { pending.destroy(); release(); }
  });
  it("rejects missing or wrong authorization before protocol processing", async () => {
    const value = controller(); await value.setEnabled(true);
    for (const Authorization of [undefined, "Bearer incorrect", "Basic incorrect"]) {
      const response = await send(value, { headers: { "Content-Type": "application/json", ...(Authorization ? { Authorization } : {}) } });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(value.connectionDetails().token);
    }
  });
  it("rejects browser origins and foreign Host headers even with valid authorization", async () => {
    const value = controller(); await value.setEnabled(true);
    for (const Origin of ["https://example.invalid", "null", "http://127.0.0.1"]) {
      const response = await send(value, { headers: { ...headers(value), Origin } });
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    // fetch normalizes Host, so send a real custom HTTP Host header directly.
    const foreignHost = await new Promise<number>(resolve => {
      const pending = request(value.connectionDetails().url, { method: "POST", headers: { ...headers(value), Host: "example.invalid" } }, response => { response.resume(); resolve(response.statusCode!); });
      pending.on("error", () => resolve(0)); pending.end("{}");
    });
    expect(foreignHost).toBe(403);
  });
  it("only serves the exact MCP path and POST with JSON", async () => {
    const value = controller(); await value.setEnabled(true);
    const base = value.connectionDetails().url;
    expect((await fetch(`${base}?token=ignored`, { headers: headers(value) })).status).toBe(404);
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const response = await fetch(base, { method, headers: headers(value) });
      expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await send(value, { headers: { ...headers(value), "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await send(value, { body: "invalid json" })).status).toBe(400);
  });
  it("bounds both declared and streamed request bodies", async () => {
    const value = controller({ maxRequestBytes: 128 }); await value.setEnabled(true);
    expect((await send(value, { body: "x".repeat(129) })).status).toBe(413);
    const streamed = await new Promise<number>(resolve => {
      const pending = request(value.connectionDetails().url, { method: "POST", headers: { ...headers(value), "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      pending.on("error", () => resolve(0)); pending.write("x".repeat(129)); pending.end();
    });
    expect(streamed).toBe(413);
  });
  it("bounds concurrent incomplete bodies and expires them", async () => {
    const value = controller({ maxConcurrentRequests: 1, requestTimeoutMs: 250 }); await value.setEnabled(true);
    let pending!: ReturnType<typeof request>;
    let ready!: () => void;
    const sent = new Promise<void>(resolve => { ready = resolve; });
    const slow = new Promise<number>(resolve => {
      pending = request(value.connectionDetails().url, { method: "POST", headers: { ...headers(value), "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      pending.on("error", () => resolve(0));
      pending.write("{", () => ready());
    });
    await sent;
    // A separate authenticated request is processed after the incomplete body's first chunk.
    expect((await send(value)).status).toBe(429);
    expect(await slow).toBe(408); pending.destroy();
    expect((await send(value)).status).toBe(200);
  });
  it("closes in-flight bodies and stops accepting requests immediately when disabled", async () => {
    const value = controller({ maxConcurrentRequests: 1 }); await value.setEnabled(true);
    const details = value.connectionDetails();
    let sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    const incomplete = new Promise<number>(resolve => {
      const pending = request(details.url, { method: "POST", headers: { ...headers(value), "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      pending.once("error", () => resolve(0)); pending.write("{", () => sent());
    });
    await started;
    expect((await send(value)).status).toBe(429);
    await value.setEnabled(false);
    expect(await incomplete).toBe(0);
    await expect(fetch(details.url, { method: "POST", headers: { Authorization: `Bearer ${details.token}` } })).rejects.toThrow();
  });
});
