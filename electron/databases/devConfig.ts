import path from "node:path";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseConnectionConfig } from "../../src/types/database.js";
import type { DevDataPolicy, McpDataPolicy } from "../../src/types/databaseApi.js";
import type { DatabaseSecretProtector } from "./profileStore.js";
import { MigrationLibrary } from "./migrations.js";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const databaseName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/);
const bounded = z.string().min(1).max(4000).refine(value => !value.includes("\0"));
const identity = z.object({ serverId: bounded, database: databaseName, engine: z.enum(["mysql", "mariadb"]), version: bounded, settings: z.object({ sqlMode: z.string().max(4000), lowerCaseTableNames: z.number().int().min(0).max(2), characterSet: bounded, collation: bounded }).strict(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const schema = z.object({
  profile: z.object({ profileId: bounded, serverConnectionId: bounded.optional(), databaseKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/), environment: z.literal("dev"), host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), database: databaseName, tlsMode: z.enum(["disabled", "verify"]).optional(), tlsCa: z.string().min(1).max(100000).optional(), credentials: z.object({ username: z.string().min(1).max(128), password: z.string().max(10000) }).strict(), identity }).strict(),
  policy: z.object({ tables: z.record(name, z.array(name).min(1).max(50)) }).strict(),
  deniedIdentities: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
  workspaceRoot: bounded,
  repositories: z.array(bounded).max(1000)
}).strict();

export interface DiagnosticConfig {
  profile: DatabaseConnectionConfig;
  policy: DevDataPolicy;
  deniedIdentities: string[];
  workspaceRoot: string;
  repositories: string[];
}

const mcpPolicy = z.union([schema.shape.policy, z.object({ mode: z.literal("all") }).strict()]);
export const mcpAccessInputSchema = z.discriminatedUnion("enabled", [
  z.object({ profileId: bounded, enabled: z.literal(false) }).strict(),
  z.object({ profileId: bounded, enabled: z.literal(true), policy: mcpPolicy }).strict()
]);
export function parseMcpAccessInput(value: unknown) {
  const input = mcpAccessInputSchema.parse(value);
  if (input.enabled && !("mode" in input.policy)) validatePolicy(input.policy);
  return input;
}
const mcpTarget = z.object({
  profile: schema.shape.profile.extend({ environment: z.enum(["dev", "production", "sandbox"]) }),
  policy: mcpPolicy,
  deniedIdentities: schema.shape.deniedIdentities,
  label: z.string().min(1).max(160), serverLabel: z.string().min(1).max(160)
}).strict();
const mcpConfig = z.object({ formatVersion: z.literal(2), targets: z.array(mcpTarget).max(100), workspaceRoot: bounded.optional(), repositories: schema.shape.repositories }).strict();
export interface McpReadTarget {
  profile: DatabaseConnectionConfig;
  policy: McpDataPolicy;
  deniedIdentities: string[];
  label: string;
  serverLabel: string;
}
export interface McpReadConfig {
  formatVersion: 2;
  targets: McpReadTarget[];
  workspaceRoot?: string;
  repositories: string[];
}
function validateMcpConfig(value: unknown): McpReadConfig {
  const config = mcpConfig.parse(value);
  const ids = new Set<string>();
  for (const target of config.targets) {
    if (ids.has(target.profile.profileId) || target.profile.identity.database !== target.profile.database || target.deniedIdentities.includes(target.profile.identity.fingerprint)) throw new Error("Invalid or duplicate MCP database identity.");
    ids.add(target.profile.profileId);
    if (!("mode" in target.policy)) validatePolicy(target.policy);
  }
  if (!config.workspaceRoot && config.repositories.length) throw new Error("MCP submissions require a selected workspace.");
  return config;
}
/** Reads the same encrypted projection, preserving legacy single-development setup. */
export async function loadMcpReadConfig(directory: string, protector: DatabaseSecretProtector): Promise<McpReadConfig & { legacy: boolean }> {
  if (!protector.isEncryptionAvailable()) throw new Error("Protected diagnostic storage is unavailable.");
  try {
    const bytes = await readFile(path.join(directory, "diagnostics.enc"));
    if (bytes.length > 2_000_000) throw new Error();
    const raw = JSON.parse(protector.decryptString(bytes));
    if (raw?.formatVersion === 2) return { ...validateMcpConfig(raw), legacy: false };
    const old = validate(raw);
    return { formatVersion: 2, targets: [{ profile: old.profile, policy: old.policy, deniedIdentities: old.deniedIdentities, label: old.profile.databaseKey, serverLabel: "Saved server" }], workspaceRoot: old.workspaceRoot, repositories: old.repositories, legacy: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { formatVersion: 2, targets: [], repositories: [], legacy: false };
    throw new Error("MCP access is disabled or its protected configuration is invalid.");
  }
}
export async function saveMcpReadConfig(directory: string, protector: DatabaseSecretProtector, input: McpReadConfig): Promise<void> {
  const config = validateMcpConfig(input);
  if (config.workspaceRoot) {
    config.workspaceRoot = await realpath(config.workspaceRoot);
    config.repositories = await Promise.all(config.repositories.map(repository => realpath(repository)));
    if (config.repositories.some(repository => !inside(config.workspaceRoot!, repository))) throw new Error("MCP repository is outside the selected workspace.");
  }
  await writeDiagnosticFile(directory, protector, config);
}
export async function revokeMcpTargets(directory: string, protector: DatabaseSecretProtector, ids: string[]): Promise<void> {
  const config = await loadMcpReadConfig(directory, protector);
  if (config.legacy) { await disableDiagnosticConfig(directory); return; }
  if (!config.targets.some(target => ids.includes(target.profile.profileId))) return;
  await saveMcpReadConfig(directory, protector, { formatVersion: 2, targets: config.targets.filter(target => !ids.includes(target.profile.profileId)), workspaceRoot: config.workspaceRoot, repositories: config.repositories });
}

/** Defense in depth even when the operator accidentally allowlists a credential table/column. */
export function permittedDiagnosticName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) && !/(?:pass(?:word|wd)?|secret|token|credential|auth|session|cookie|private.?key|api.?key|salt|grant|settings?|config|connection|smtp|credit.?card|bank.?account|db_radar)/i.test(value) && !["mysql", "sys", "information_schema", "performance_schema"].includes(value.toLowerCase());
}

function validate(value: unknown): DiagnosticConfig {
  const config = schema.parse(value);
  if (config.profile.identity.database !== config.profile.database || config.deniedIdentities.includes(config.profile.identity.fingerprint)) throw new Error("Diagnostic configuration is not an approved development identity.");
  validatePolicy(config.policy);
  return config;
}
function validatePolicy(policy: DevDataPolicy): void {
  if (Object.keys(policy.tables).length > 100) throw new Error("Diagnostic table policy is too large.");
  for (const [table, columns] of Object.entries(policy.tables)) if (!permittedDiagnosticName(table) || new Set(columns).size !== columns.length || columns.some(column => !permittedDiagnosticName(column))) throw new Error("Diagnostic policy contains restricted tables or columns.");
}

function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }

export async function saveDiagnosticConfig(directory: string, protector: DatabaseSecretProtector, input: DiagnosticConfig): Promise<void> {
  if (!protector.isEncryptionAvailable()) throw new Error("Protected diagnostic storage is unavailable.");
  const config = validate(input);
  config.workspaceRoot = await realpath(config.workspaceRoot);
  config.repositories = await Promise.all(config.repositories.map(repository => realpath(repository)));
  if (config.repositories.some(repository => !inside(config.workspaceRoot, repository))) throw new Error("Diagnostic repository is outside the selected workspace.");
  await writeDiagnosticFile(directory, protector, config);
}
async function writeDiagnosticFile(directory: string, protector: DatabaseSecretProtector, config: DiagnosticConfig | McpReadConfig): Promise<void> {
  if (!protector.isEncryptionAvailable()) throw new Error("Protected diagnostic storage is unavailable.");
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.diagnostics-${randomUUID()}.tmp`);
  try { await writeFile(temporary, protector.encryptString(JSON.stringify(config)), { flag: "wx", mode: 0o600 }); await rename(temporary, path.join(directory, "diagnostics.enc")); }
  finally { await rm(temporary, { force: true }); }
}

/** Reload for every request: a running server never retains enrollment after revocation. */
export async function loadDiagnosticConfig(directory: string, protector: DatabaseSecretProtector): Promise<DiagnosticConfig> {
  if (!protector.isEncryptionAvailable()) throw new Error("Protected diagnostic storage is unavailable.");
  try { const bytes = await readFile(path.join(directory, "diagnostics.enc")); if (bytes.length > 2_000_000) throw new Error(); return validate(JSON.parse(protector.decryptString(bytes))); }
  catch { throw new Error("Development diagnostics are disabled or their protected configuration is invalid."); }
}

export async function disableDiagnosticConfig(directory: string): Promise<void> { await rm(path.join(directory, "diagnostics.enc"), { force: true }); }

export async function collectDiagnosticSubmissions(directory: string) { return new MigrationLibrary(path.join(directory, "dev-submissions")).listProposals(); }
