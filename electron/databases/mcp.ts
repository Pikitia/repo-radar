import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseSecretProtector } from "./profileStore.js";
import { connectDatabase, databaseDigest, readIdentity, type SqlSession } from "./connections.js";
import { captureSchema } from "./schema.js";
import { loadMcpReadConfig, type McpReadConfig, type McpReadTarget } from "./devConfig.js";
import { devQuerySchema, mcpQuerySchema, queryMcpData, verifyReadOnlyDiagnosticGrants } from "./devQuery.js";
import { MigrationLibrary } from "./migrations.js";

const key = z.string().min(1).max(128);
const schemaInput = z.object({ databaseKey: key, objectTypes: z.array(z.enum(["table", "column", "index", "foreign-key", "view", "routine", "trigger"])).max(7).optional(), objectPaths: z.array(z.string().min(1).max(500)).max(100).optional() }).strict();
const mcpSchemaInput = schemaInput.omit({ databaseKey: true }).extend({ profileId: z.string().min(1).max(100) });
const submitInput = z.object({ repositoryId: z.string().regex(/^[a-f0-9]{64}$/), manifestPath: z.string().min(1).max(1000) }).strict();
const statusInput = z.object({ proposalId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const none = z.object({}).strict();
const toolDefinitions = [
  { name: "list_databases", description: "List only databases explicitly enabled for MCP read access, across servers and environments. Use profileId to select an exact database.", inputSchema: z.toJSONSchema(none), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "get_database_schema", description: "Read bounded schema definitions and coverage for an explicitly enabled database using its profileId and separate read-only credentials.", inputSchema: z.toJSONSchema(mcpSchemaInput), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "query_database", description: "Read permitted InnoDB base tables and columns in one enabled database by profileId, using bounded structured predicates. No SQL, writes, views, routines or secret fields.", inputSchema: z.toJSONSchema(mcpQuerySchema), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "submit_migration", description: "Capture a service-repository migration as an immutable local draft. Does not connect to any database or grant execution approval.", inputSchema: z.toJSONSchema(submitInput), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "get_submission_status", description: "Read this diagnostic broker's draft submission status and captured digest. Does not expose release or environment execution history.", inputSchema: z.toJSONSchema(statusInput), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
];

export interface DiagnosticDependencies { connect?: typeof connectDatabase; enabled?: () => boolean | Promise<boolean> }

type BrokerConfig = McpReadConfig & { legacy: boolean };
/** Only the explicit protected read projection is loaded, never the desktop credential vault. */
export class DatabaseDiagnosticBroker {
  constructor(private readonly directory: string, private readonly protector: DatabaseSecretProtector, private readonly dependencies: DiagnosticDependencies = {}) {}
  private library(): MigrationLibrary { return new MigrationLibrary(path.join(this.directory, "dev-submissions")); }
  private async config(): Promise<BrokerConfig> {
    if (this.dependencies.enabled && !await this.dependencies.enabled()) throw new Error("Database MCP is disabled in Settings.");
    const config = await loadMcpReadConfig(this.directory, this.protector);
    if (!config.targets.length) throw new Error("Database MCP access is disabled; enable a database in Settings.");
    return config;
  }
  private async unchanged(config: BrokerConfig): Promise<void> { if (databaseDigest(await this.config()) !== databaseDigest(config)) throw new Error("Diagnostic enrollment changed during this request."); }

  private async read<T>(config: BrokerConfig, selector: string, legacy: boolean, operation: (session: SqlSession, target: McpReadTarget) => Promise<T>): Promise<T> {
    const matches = config.targets.filter(target => legacy ? target.profile.environment === "dev" && target.profile.databaseKey === selector : target.profile.profileId === selector);
    if (matches.length !== 1) throw new Error("This database is not enrolled unambiguously for MCP reads; use its enabled profileId.");
    const target = matches[0];
    if (!target.profile.identity || target.deniedIdentities.includes(target.profile.identity.fingerprint)) throw new Error("This database identity is not approved for MCP reads.");
    const session = await (this.dependencies.connect ?? connectDatabase)(target.profile);
    let expired = false;
    const timer = setTimeout(() => { expired = true; session.destroy?.(); }, 5000);
    try {
      const identity = await readIdentity(session, target.profile.database);
      if (databaseDigest(identity) !== databaseDigest(target.profile.identity) || target.deniedIdentities.includes(identity.fingerprint)) throw new Error(`Live ${legacy ? "development" : "database"} identity differs from enrollment or matches a denied target.`);
      await verifyReadOnlyDiagnosticGrants(session, identity.database, !config.legacy);
      await this.unchanged(config);
      // Session-level safety is independent of the query grammar and database grants.
      await session.execute("SET SESSION TRANSACTION READ ONLY");
      await session.execute("START TRANSACTION READ ONLY");
      const value = await operation(session, target);
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
      case "list_databases":
      case "list_dev_databases": {
        none.parse(input);
        const targets = config.targets.filter(target => name !== "list_dev_databases" || target.profile.environment === "dev");
        return { databases: targets.map(target => ({ profileId: target.profile.profileId, databaseKey: target.profile.databaseKey, label: target.label, server: target.serverLabel, database: target.profile.database, environment: target.profile.environment, health: "enabled; live identity verified on each read", repositories: config.repositories.map(repository => ({ repositoryId: databaseDigest(repository), name: path.basename(repository) })) })) };
      }
      case "get_database_schema":
      case "get_dev_schema": {
        const legacy = name === "get_dev_schema";
        const request = legacy ? schemaInput.parse(input) : mcpSchemaInput.parse(input);
        return this.read(config, "profileId" in request ? request.profileId : request.databaseKey, legacy, async (session, target) => {
          const snapshot = await captureSchema(session, target.profile.identity!);
          const filtered = snapshot.objects.filter(object => (!request.objectTypes || request.objectTypes.includes(object.objectType)) && (!request.objectPaths || request.objectPaths.includes(object.objectPath)));
          const objects: typeof filtered = []; let bytes = 0;
          for (const object of filtered) { const size = Buffer.byteLength(JSON.stringify(object)); if (objects.length >= 500 || bytes + size > 256000) break; bytes += size; objects.push(object); }
          const truncated = objects.length !== filtered.length;
          return { digest: snapshot.digest, objects, truncated, coverage: { ...snapshot.coverage, complete: snapshot.coverage.complete && !truncated, limitations: [...snapshot.coverage.limitations, ...(truncated ? ["Diagnostic schema response truncated by object/byte bounds."] : [])] } };
        });
      }
      case "query_database": {
        const { profileId, ...request } = mcpQuerySchema.parse(input);
        return this.read(config, profileId, false, (session, target) => queryMcpData(session, target.profile.database, { ...request, databaseKey: target.profile.databaseKey }, target.policy));
      }
      case "query_dev_data": {
        const request = devQuerySchema.parse(input);
        return this.read(config, request.databaseKey, true, (session, target) => queryMcpData(session, target.profile.database, request, target.policy));
      }
      case "submit_migration": {
        const request = submitInput.parse(input);
        if (!config.workspaceRoot) throw new Error("Choose a repository root before submitting migrations.");
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
      default: throw new Error("Unknown database MCP tool.");
    }
  }
}

export function createDatabaseMcpServer(directory: string, protector: DatabaseSecretProtector, dependencies: DiagnosticDependencies = {}, observeOperation?: (operation: Promise<unknown>) => void): Server {
  const server = new Server({ name: "repo-radar-databases", version: "1.0.0" }, { capabilities: { tools: {} } });
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
    catch { return { isError: true, content: [{ type: "text", text: "Database MCP request denied or failed. Review enabled databases, permitted fields, read-only grants and local submission validation in Repo Radar." }] }; }
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
