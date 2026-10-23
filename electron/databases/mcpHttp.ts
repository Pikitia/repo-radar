import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { DatabaseMcpStatus } from "../../src/types/settings.js";
import type { DatabaseSecretProtector } from "./profileStore.js";
import { createDatabaseMcpServer, type DiagnosticDependencies } from "./mcp.js";

interface LocalMcpOptions {
  /** Port zero is reserved for disposable test listeners. */
  port?: number;
  maxRequestBytes?: number;
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  dependencies?: DiagnosticDependencies;
}
interface ActiveRequest {
  request: IncomingMessage;
  response: ServerResponse;
  server?: Server;
  closed: boolean;
  work: Set<Promise<unknown>>;
}
const host = "127.0.0.1";

/** Desktop listener only: transport authentication never grants diagnostic enrollment. */
export class LocalDatabaseMcpServer {
  private listener?: HttpServer;
  private token?: string;
  private current: DatabaseMcpStatus = { enabled: false, running: false };
  private pending: Promise<void> = Promise.resolve();
  private readonly active = new Set<ActiveRequest>();
  private readonly port: number;
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly timeout: number;

  constructor(private readonly directory: string, private readonly protector: DatabaseSecretProtector, private readonly options: LocalMcpOptions = {}) {
    this.port = options.port ?? 47321;
    this.maxBytes = options.maxRequestBytes ?? 256000;
    this.maxConcurrent = options.maxConcurrentRequests ?? 8;
    this.timeout = options.requestTimeoutMs ?? 10000;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535 || !Number.isInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || !Number.isInteger(this.timeout) || this.timeout < 1) throw new Error("Invalid local MCP server options.");
  }

  status(): DatabaseMcpStatus { return { ...this.current }; }
  connectionDetails(): { url: string; token: string } {
    if (!this.current.running || !this.current.url || !this.token) throw new Error("The local MCP server is not running.");
    return { url: this.current.url, token: this.token };
  }
  setEnabled(enabled: boolean): Promise<void> {
    const operation = this.pending.then(async () => {
      if (!enabled) { await this.stop(); this.current = { enabled: false, running: false }; return; }
      if (this.current.running) return;
      this.current = { enabled: true, running: false };
      try {
        this.token = await this.loadToken();
        const listener = createServer((request, response) => { void this.handle(request, response); });
        this.listener = listener;
        listener.headersTimeout = this.timeout;
        listener.requestTimeout = this.timeout;
        listener.keepAliveTimeout = 1000;
        listener.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => { listener.off("listening", ready); reject(error); };
          const ready = () => { listener.off("error", failed); resolve(); };
          listener.once("error", failed);
          listener.once("listening", ready);
          listener.listen(this.port, host);
        });
        listener.on("error", () => {
          this.current = { enabled: true, running: false, error: "The local MCP listener stopped. Toggle it off and on to retry." };
          void this.stop();
        });
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("No local listener address.");
        this.current = { enabled: true, running: true, url: `http://${host}:${address.port}/mcp` };
      } catch {
        await this.stop();
        this.current = { enabled: true, running: false, error: "The local MCP server could not start. Check protected storage and whether port 47321 is already in use." };
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  close(): Promise<void> { return this.setEnabled(false); }

  private async loadToken(): Promise<string> {
    if (!this.protector.isEncryptionAvailable()) throw new Error("Protected MCP storage is unavailable.");
    await mkdir(this.directory, { recursive: true });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid MCP storage directory.");
    const file = path.join(this.directory, "mcp-auth.enc");
    const existing = async () => {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) throw new Error("Invalid protected MCP token.");
      const token = this.protector.decryptString(await readFile(file));
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid protected MCP token.");
      return token;
    };
    try { return await existing(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const token = randomBytes(32).toString("base64url");
    const temporary = path.join(this.directory, `.mcp-auth-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, this.protector.encryptString(token), { flag: "wx", mode: 0o600 });
      // Atomic publication without replacing a token created by another app process.
      try { await link(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return await existing();
    } finally { await rm(temporary, { force: true }); }
  }

  private reject(response: ServerResponse, status: number): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close", ...(status === 405 ? { Allow: "POST" } : {}) });
    response.end(JSON.stringify({ error: "Local MCP request rejected." }));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (request.url !== "/mcp") { this.reject(response, 404); return; }
    if (request.socket.remoteAddress !== host || request.headers.host !== new URL(this.current.url ?? "http://invalid").host || request.headers.origin !== undefined) { this.reject(response, 403); return; }
    const authorization = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token ?? ""}`);
    if (!this.token || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { this.reject(response, 401); return; }
    if (request.method !== "POST") { this.reject(response, 405); return; }
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) { this.reject(response, 415); return; }
    if (this.active.size >= this.maxConcurrent) { this.reject(response, 429); return; }
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > this.maxBytes)) { this.reject(response, 413); return; }
    const active: ActiveRequest = { request, response, closed: false, work: new Set() };
    this.active.add(active);
    const timer = setTimeout(() => { this.reject(response, 408); void active.server?.close().catch(() => undefined); }, this.timeout);
    const finished = () => {
      clearTimeout(timer);
      active.closed = true;
      this.release(active);
      void active.server?.close().catch(() => undefined);
    };
    response.once("close", finished);
    request.once("error", () => this.reject(response, 400));
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      const body = await new Promise<Buffer>((resolve, reject) => {
        request.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.maxBytes) { this.reject(response, 413); reject(new Error("Request exceeds bounds.")); }
          else chunks.push(chunk);
        });
        request.once("end", () => resolve(Buffer.concat(chunks)));
        request.once("error", reject);
        response.once("close", () => reject(new Error("Request closed.")));
      });
      if (response.writableEnded || response.destroyed) return;
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { this.reject(response, 400); return; }
      const dependencies: DiagnosticDependencies = {
        ...this.options.dependencies,
        enabled: async () => !active.closed && (this.options.dependencies?.enabled ? await this.options.dependencies.enabled() : true),
      };
      const server = createDatabaseMcpServer(this.directory, this.protector, dependencies, operation => {
        this.active.add(active);
        active.work.add(operation);
        const settled = () => { active.work.delete(operation); this.release(active); };
        void operation.then(settled, settled);
      });
      active.server = server;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      if (response.writableEnded || response.destroyed) { await server.close(); return; }
      await transport.handleRequest(request, response, parsed);
    } catch { this.reject(response, 400); }
    finally { this.release(active); }
  }
  private release(active: ActiveRequest): void {
    if (active.closed && active.work.size === 0) this.active.delete(active);
  }
  private async stop(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    this.token = undefined;
    for (const active of this.active) {
      active.closed = true;
      active.response.destroy(); active.request.destroy();
      await active.server?.close().catch(() => undefined);
      this.release(active);
    }
    // A transport close cannot cancel an in-flight driver connection. Retain its
    // capacity across off/on until the tracked broker promise has settled.
    if (listener) await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  }
}
