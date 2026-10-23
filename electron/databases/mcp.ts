import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseSecretProtector } from "./profileStore.js";
import { connectDatabase, databaseDigest, readIdentity, type SqlSession } from "./connections.js";
import { captureSchema } from "./schema.js";
import { loadDiagnosticConfig, type DiagnosticConfig } from "./devConfig.js";
import { devQuerySchema, queryDevData, verifyReadOnlyDiagnosticGrants } from "./devQuery.js";
import { MigrationLibrary } from "./migrations.js";

const key = z.string().min(1).max(128);
const schemaInput = z.object({ databaseKey: key, objectTypes: z.array(z.enum(["table", "column", "index", "foreign-key", "view", "routine", "trigger"])).max(7).optional(), objectPaths: z.array(z.string().min(1).max(500)).max(100).optional() }).strict();
const submitInput = z.object({ repositoryId: z.string().regex(/^[a-f0-9]{64}$/), manifestPath: z.string().min(1).max(1000) }).strict();
const statusInput = z.object({ proposalId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const none = z.object({}).strict();
const toolDefinitions = [
  { name: "list_dev_databases", description: "List operator-enrolled development database identifiers and diagnostic health. No production profiles are available.", inputSchema: z.toJSONSchema(none), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "get_dev_schema", description: "Read bounded development-only schema definitions and coverage; requires an enrolled development identity and independent read-only credentials.", inputSchema: z.toJSONSchema(schemaInput), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "query_dev_data", description: "Query only operator-permitted development InnoDB base tables and columns with structured predicates. No SQL, views, routines, secrets or production access.", inputSchema: z.toJSONSchema(devQuerySchema), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "submit_migration", description: "Capture a service-repository migration as an immutable local draft. Does not connect to any database or grant execution approval.", inputSchema: z.toJSONSchema(submitInput), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "get_submission_status", description: "Read this diagnostic broker's draft submission status and captured digest. Does not expose release or environment execution history.", inputSchema: z.toJSONSchema(statusInput), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
];

export interface DiagnosticDependencies { connect?: typeof connectDatabase; enabled?: () => boolean | Promise<boolean> }

/** Explicit tool allowlist; this process never reads desktop profiles, production evidence or main releases. */
export class DatabaseDiagnosticBroker {
  constructor(private readonly directory: string, private readonly protector: DatabaseSecretProtector, private readonly dependencies: DiagnosticDependencies = {}) {}
  private library(): MigrationLibrary { return new MigrationLibrary(path.join(this.directory, "dev-submissions")); }
  private async config(): Promise<DiagnosticConfig> {
    if (this.dependencies.enabled && !await this.dependencies.enabled()) throw new Error("Development MCP is disabled in Settings.");
    return loadDiagnosticConfig(this.directory, this.protector);
  }
  private async unchanged(config: DiagnosticConfig): Promise<void> { if (databaseDigest(await this.config()) !== databaseDigest(config)) throw new Error("Diagnostic enrollment changed during this request."); }

  private async read<T>(config: DiagnosticConfig, databaseKey: string, operation: (session: SqlSession) => Promise<T>): Promise<T> {
    if (databaseKey !== config.profile.databaseKey || config.profile.environment !== "dev" || !config.profile.identity || config.deniedIdentities.includes(config.profile.identity.fingerprint)) throw new Error("This database is not enrolled for development diagnostics.");
    const session = await (this.dependencies.connect ?? connectDatabase)(config.profile);
    let expired = false;
    const timer = setTimeout(() => { expired = true; session.destroy?.(); }, 5000);
    try {
      const identity = await readIdentity(session, config.profile.database);
      if (databaseDigest(identity) !== databaseDigest(config.profile.identity) || config.deniedIdentities.includes(identity.fingerprint)) throw new Error("Live development identity differs from enrollment or matches a denied target.");
      await verifyReadOnlyDiagnosticGrants(session, identity.database);
      await this.unchanged(config);
      // Session-level safety is independent of the query grammar and database grants.
      await session.execute("SET SESSION TRANSACTION READ ONLY");
      await session.execute("START TRANSACTION READ ONLY");
      const value = await operation(session);
      await this.unchanged(config);
      if (expired) throw new Error("Development diagnostic request timed out.");
      return { ...value, identity, capturedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
      try { await session.execute("ROLLBACK"); } catch { /* closing also discards the read-only transaction */ }
      await session.close();
    }
  }

  async call(name: string, input: unknown): Promise<unknown> {
    const config = await this.config();
    switch (name) {
      case "list_dev_databases": {
        none.parse(input);
        return { databases: [{ databaseKey: config.profile.databaseKey, environment: "dev", health: "enrolled; live identity verified on each read", repositories: config.repositories.map(repository => ({ repositoryId: databaseDigest(repository), name: path.basename(repository) })) }] };
      }
      case "get_dev_schema": {
        const request = schemaInput.parse(input);
        return this.read(config, request.databaseKey, async session => {
          const snapshot = await captureSchema(session, config.profile.identity!);
          const filtered = snapshot.objects.filter(object => (!request.objectTypes || request.objectTypes.includes(object.objectType)) && (!request.objectPaths || request.objectPaths.includes(object.objectPath)));
          const objects: typeof filtered = []; let bytes = 0;
          for (const object of filtered) { const size = Buffer.byteLength(JSON.stringify(object)); if (objects.length >= 500 || bytes + size > 256000) break; bytes += size; objects.push(object); }
          const truncated = objects.length !== filtered.length;
          return { digest: snapshot.digest, objects, truncated, coverage: { ...snapshot.coverage, complete: snapshot.coverage.complete && !truncated, limitations: [...snapshot.coverage.limitations, ...(truncated ? ["Diagnostic schema response truncated by object/byte bounds."] : [])] } };
        });
      }
      case "query_dev_data": {
        const request = devQuerySchema.parse(input);
        return this.read(config, request.databaseKey, session => queryDevData(session, config.profile.database, request, config.policy));
      }
      case "submit_migration": {
        const request = submitInput.parse(input);
        const repository = config.repositories.find(repository => databaseDigest(repository) === request.repositoryId);
        if (!repository) throw new Error("Repository is not enrolled for migration submission.");
        const proposal = await this.library().importProposal(repository, request.manifestPath, config.workspaceRoot);
        await this.unchanged(config);
        return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest, status: "draft", validationErrors: [], validationWarnings: proposal.validationWarnings };
      }
      case "get_submission_status": {
        const request = statusInput.parse(input), proposal = await this.library().getProposal(request.proposalId);
        if (!config.repositories.includes(proposal.source.repositoryPath)) throw new Error("Submission source is no longer enrolled.");
        return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest, status: "draft", validationErrors: [], validationWarnings: proposal.validationWarnings };
      }
      default: throw new Error("Unknown development diagnostic tool.");
    }
  }
}

export function createDatabaseMcpServer(directory: string, protector: DatabaseSecretProtector, dependencies: DiagnosticDependencies = {}, observeOperation?: (operation: Promise<unknown>) => void): Server {
  const server = new Server({ name: "repo-radar-dev-databases", version: "1.0.0" }, { capabilities: { tools: {} } });
  const broker = new DatabaseDiagnosticBroker(directory, protector, dependencies);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      // The HTTP owner must retain capacity until broker work actually settles,
      // even when the client closes its transport while a connection is pending.
      let observationFailed = false;
      const operation = Promise.resolve().then(() => {
        if (observationFailed) throw new Error("Diagnostic operation could not be tracked.");
        return broker.call(request.params.name, request.params.arguments ?? {});
      });
      try { observeOperation?.(operation); } catch { observationFailed = true; }
      const result = await operation;
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    catch { return { isError: true, content: [{ type: "text", text: "Development diagnostic request denied or failed. Review enrollment, permitted fields, read-only grants and local submission validation in Repo Radar." }] }; }
  });
  return server;
}

/** SDK negotiates the supported MCP protocol; stdout belongs exclusively to stdio transport. */
export async function startDatabaseMcp(directory: string, protector: DatabaseSecretProtector, onDisconnect: () => void = () => undefined, dependencies: DiagnosticDependencies = {}): Promise<void> {
  // Electron on Windows can expose an empty process.stdin for inherited pipes.
  // The actual standard descriptors still work; use them directly for MCP.
  const input = createReadStream("", { fd: 0, autoClose: false });
  const output = createWriteStream("", { fd: 1, autoClose: false });
  const server = createDatabaseMcpServer(directory, protector, dependencies);
  let disconnected = false;
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    void server.close().catch(() => undefined).then(onDisconnect);
  };
  input.once("end", disconnect);
  input.once("error", disconnect);
  output.once("error", disconnect);
  await server.connect(new StdioServerTransport(input, output));
}
