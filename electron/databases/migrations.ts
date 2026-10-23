import path from "node:path";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { runGit, tryGit } from "../git/exec.js";
import type { MigrationCheck, MigrationManifest, MigrationProposal, MigrationRelease } from "../../src/types/migration.js";

const MAX_FILE = 2 * 1024 * 1024;
const MAX_PROPOSAL = 16 * 1024 * 1024;
const MAX_LIBRARY = 64 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const WARNINGS = ["Target-bound rehearsal and rollback/restore evidence must be reviewed before execution."];

interface LibraryState {
  formatVersion: 1;
  proposals: MigrationProposal[];
  releases: MigrationRelease[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const field of required) if (!Object.hasOwn(value, field)) throw new Error(`Missing ${field}.`);
  for (const field of Object.keys(value)) if (![...required, ...optional].includes(field)) throw new Error(`Unknown field ${field}.`);
}

function text(value: unknown, label: string, max = 10000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid ${label}.`);
  return value;
}

function array(value: unknown, label: string, max = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}.`);
  return value;
}

function relativePath(value: unknown): string {
  const result = text(value, "relative file path", 1000);
  if (path.isAbsolute(result) || path.win32.isAbsolute(result) || result.includes(":") || result.includes("\\")) throw new Error("Use a relative path with forward slashes.");
  return result;
}

function strings(value: unknown, label: string, validate: (item: unknown) => string): string[] {
  const result = array(value, label).map(validate);
  if (new Set(result).size !== result.length) throw new Error(`Duplicate ${label}.`);
  return result;
}

function identifier(value: unknown): string {
  const result = text(value, "migration ID", 240);
  if (!ID.test(result)) throw new Error("Migration ID must be namespaced, for example service/change-v1.");
  return result;
}

function databaseKey(value: unknown): string {
  const result = text(value, "database key", 120);
  if (!KEY.test(result)) throw new Error("Invalid logical database key.");
  return result;
}

function version(value: unknown): string {
  const result = text(value, "engine version", 40);
  if (!/^\d+\.\d+\.\d+$/.test(result)) throw new Error("Engine version must use major.minor.patch.");
  return result;
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function check(value: unknown): MigrationCheck {
  const item = record(value, "check");
  keys(item, ["path", "expect"], ["value"]);
  const file = relativePath(item.path);
  if (!["empty", "nonempty", "scalar-equals"].includes(String(item.expect))) throw new Error("Invalid check expectation.");
  if (item.expect === "scalar-equals") {
    if (!Object.hasOwn(item, "value") || !(item.value === null || ["string", "number", "boolean"].includes(typeof item.value)) || (typeof item.value === "number" && !Number.isFinite(item.value))) throw new Error("Scalar checks require a finite typed value.");
  } else if (Object.hasOwn(item, "value")) throw new Error("Only scalar-equals checks accept a value.");
  return { path: file, expect: item.expect as MigrationCheck["expect"], ...(Object.hasOwn(item, "value") ? { value: item.value as MigrationCheck["value"] } : {}) };
}

/** Strict validation is shared by disk reads and imports; persisted artifacts are never trusted. */
export function validateMigrationManifest(value: unknown): MigrationManifest {
  const item = record(value, "manifest");
  keys(item, ["formatVersion", "id", "title", "databaseKey", "service", "dependsOn", "engine", "up", "preconditions", "postconditions", "recovery", "dataImpact", "applicationCompatibility", "expectedSchemaChanges"]);
  if (item.formatVersion !== 1) throw new Error("Unsupported migration format version.");
  const id = identifier(item.id), service = databaseKey(item.service);
  if (!id.startsWith(`${service}/`)) throw new Error("Migration ID namespace must match its service.");
  const dependsOn = strings(item.dependsOn, "dependencies", identifier);
  if (dependsOn.includes(id)) throw new Error("A migration cannot depend on itself.");
  const engine = record(item.engine, "engine");
  keys(engine, ["product", "minVersion", "requiredSettings", "storageEngines"], ["maxVersion"]);
  if (engine.product !== "mysql" && engine.product !== "mariadb") throw new Error("Unsupported database engine.");
  const minVersion = version(engine.minVersion), maxVersion = engine.maxVersion === undefined ? undefined : version(engine.maxVersion);
  if (maxVersion && compareVersion(minVersion, maxVersion) > 0) throw new Error("Engine version bounds are reversed.");
  const settings = record(engine.requiredSettings, "required settings");
  if (Object.keys(settings).length > 100) throw new Error("Too many engine settings.");
  for (const [name, setting] of Object.entries(settings)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || !["string", "number", "boolean"].includes(typeof setting) || (typeof setting === "number" && !Number.isFinite(setting))) throw new Error("Invalid required engine setting.");
  }
  const storageEngines = strings(engine.storageEngines, "storage engines", (entry) => text(entry, "storage engine", 60));
  if (!storageEngines.length) throw new Error("Declare at least one required storage engine.");
  const up = strings(item.up, "up files", relativePath);
  if (!up.length) throw new Error("At least one up script is required.");
  const recovery = record(item.recovery, "recovery");
  keys(recovery, ["mode", "eligibilityChecks", "runbook", "applicationCompatibility", "rollbackRoute"], ["down"]);
  if (!["down", "forward-fix", "restore", "retain-schema"].includes(String(recovery.mode))) throw new Error("Invalid recovery mode.");
  if (recovery.rollbackRoute !== "tested-down" && recovery.rollbackRoute !== "tested-restore") throw new Error("Declare a tested rollback route.");
  const down = recovery.down === undefined ? undefined : strings(recovery.down, "down files", relativePath);
  if ((recovery.mode === "down" || recovery.rollbackRoute === "tested-down") && !down?.length) throw new Error("Down recovery requires down scripts.");
  const impact = record(item.dataImpact, "data impact");
  keys(impact, ["description", "destructive", "requiresWritePause", "locking"]);
  return {
    formatVersion: 1, id, title: text(item.title, "title", 500), databaseKey: databaseKey(item.databaseKey), service, dependsOn,
    engine: { product: engine.product, minVersion, ...(maxVersion ? { maxVersion } : {}), requiredSettings: { ...settings } as MigrationManifest["engine"]["requiredSettings"], storageEngines },
    up, preconditions: array(item.preconditions, "preconditions").map(check), postconditions: array(item.postconditions, "postconditions").map(check),
    recovery: { mode: recovery.mode as MigrationManifest["recovery"]["mode"], ...(down ? { down } : {}), eligibilityChecks: array(recovery.eligibilityChecks, "eligibility checks").map(check), runbook: relativePath(recovery.runbook), applicationCompatibility: text(recovery.applicationCompatibility, "recovery compatibility"), rollbackRoute: recovery.rollbackRoute },
    dataImpact: { description: text(impact.description, "data impact"), destructive: boolean(impact.destructive, "destructive"), requiresWritePause: boolean(impact.requiresWritePause, "write pause"), locking: text(impact.locking, "locking") },
    applicationCompatibility: text(item.applicationCompatibility, "application compatibility"),
    expectedSchemaChanges: array(item.expectedSchemaChanges, "schema changes").map((entry) => {
      const change = record(entry, "schema change"); keys(change, ["objectType", "objectPath", "description"]);
      return { objectType: text(change.objectType, "object type", 100), objectPath: text(change.objectPath, "object path", 500), description: text(change.description, "change description") };
    })
  };
}

function references(manifest: MigrationManifest): string[] {
  return [...new Set([...manifest.up, ...(manifest.recovery.down ?? []), ...manifest.preconditions.map((item) => item.path), ...manifest.postconditions.map((item) => item.path), ...manifest.recovery.eligibilityChecks.map((item) => item.path), manifest.recovery.runbook])].sort();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function migrationContentDigest(manifest: MigrationManifest, files: Record<string, string>): string {
  return digest(canonical({ manifest, files: Object.fromEntries(references(manifest).map((file) => [file, digest(files[file])])) }));
}

function proposalId(manifest: MigrationManifest, contentDigest: string): string { return digest(`${manifest.id}\0${contentDigest}`); }
function releaseDigest(release: Omit<MigrationRelease, "digest" | "releaseId">): string { return digest(canonical(release)); }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }

async function readBounded(file: string, limit: number): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) throw new Error("Migration file is missing, not regular, or oversized.");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error("Migration file is oversized.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function validateProposal(value: unknown): MigrationProposal {
  const item = record(value, "proposal");
  keys(item, ["proposalId", "manifest", "contentDigest", "files", "source", "status", "importedAt", "validationWarnings"]);
  const manifest = validateMigrationManifest(item.manifest), files = record(item.files, "files");
  const expected = references(manifest);
  if (Object.keys(files).sort().join("\0") !== expected.join("\0")) throw new Error("Snapshot file set does not match the manifest.");
  let size = 0;
  for (const file of expected) {
    if (typeof files[file] !== "string" || Buffer.byteLength(files[file] as string) > MAX_FILE) throw new Error("Invalid snapshot file.");
    size += Buffer.byteLength(files[file] as string);
  }
  if (size > MAX_PROPOSAL) throw new Error("Proposal is oversized.");
  const contentDigest = migrationContentDigest(manifest, files as Record<string, string>);
  if (item.contentDigest !== contentDigest || item.proposalId !== proposalId(manifest, contentDigest)) throw new Error("Proposal content digest mismatch.");
  const source = record(item.source, "source"); keys(source, ["repositoryPath", "manifestRelativePath", "commit", "dirty"]);
  text(source.repositoryPath, "repository path", 4000); relativePath(source.manifestRelativePath); boolean(source.dirty, "source dirty status");
  if (source.commit !== null && (typeof source.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(source.commit))) throw new Error("Invalid source commit.");
  if (item.status !== "draft" && item.status !== "sealed") throw new Error("Invalid proposal status.");
  if (typeof item.importedAt !== "string" || !Number.isFinite(Date.parse(item.importedAt))) throw new Error("Invalid import timestamp.");
  if (canonical(item.validationWarnings) !== canonical(WARNINGS)) throw new Error("Invalid proposal evidence warnings.");
  return { ...item, manifest, files, source } as unknown as MigrationProposal;
}

function validateState(value: unknown): LibraryState {
  const item = record(value, "library"); keys(item, ["formatVersion", "proposals", "releases"]);
  if (item.formatVersion !== 1) throw new Error("Unsupported library format.");
  const proposals = array(item.proposals, "proposals", 10000).map(validateProposal);
  const byProposal = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  if (byProposal.size !== proposals.length) throw new Error("Duplicate proposal identity.");
  const releases: MigrationRelease[] = [];
  const latest = new Map<string, MigrationRelease>();
  const sealed = new Set<string>();
  for (const value of array(item.releases, "releases", 10000)) {
    const raw = record(value, "release"); keys(raw, ["formatVersion", "databaseKey", "releaseId", "parentReleaseDigest", "digest", "migrations"]);
    const key = databaseKey(raw.databaseKey), previous = latest.get(key);
    if (raw.formatVersion !== 1 || raw.parentReleaseDigest !== (previous?.digest ?? null)) throw new Error("Release predecessor mismatch.");
    const seen = new Set<string>();
    const migrations = array(raw.migrations, "release migrations", 10000).map((value, index) => {
      const row = record(value, "release migration"); keys(row, ["sequence", "id", "contentDigest", "proposalId"]);
      const proposal = byProposal.get(String(row.proposalId));
      if (row.sequence !== index + 1 || !proposal || row.id !== proposal.manifest.id || row.contentDigest !== proposal.contentDigest || proposal.manifest.databaseKey !== key || proposal.status !== "sealed" || seen.has(proposal.manifest.id)) throw new Error("Invalid release migration or snapshot.");
      for (const dependency of proposal.manifest.dependsOn) if (!seen.has(dependency)) throw new Error("Release dependency order is invalid.");
      seen.add(proposal.manifest.id); sealed.add(proposal.proposalId);
      return row as unknown as MigrationRelease["migrations"][number];
    });
    if (previous && (migrations.length <= previous.migrations.length || previous.migrations.some((row, index) => canonical(row) !== canonical(migrations[index])))) throw new Error("Release history is not append-only.");
    const body = { formatVersion: 1 as const, databaseKey: key, parentReleaseDigest: previous?.digest ?? null, migrations };
    const expectedDigest = releaseDigest(body);
    if (raw.digest !== expectedDigest || raw.releaseId !== expectedDigest || !HASH.test(expectedDigest)) throw new Error("Release digest mismatch.");
    const release = { ...body, digest: expectedDigest, releaseId: expectedDigest };
    latest.set(key, release); releases.push(release);
  }
  for (const proposal of proposals) if ((proposal.status === "sealed") !== sealed.has(proposal.proposalId)) throw new Error("Proposal seal does not match release history.");
  return { formatVersion: 1, proposals, releases };
}

/** No database access. Artifacts remain usable when their source branch or checkout changes. */
export class MigrationLibrary {
  constructor(private readonly directory: string) {}

  private async read(): Promise<LibraryState> {
    try { return validateState(JSON.parse(await readBounded(path.join(this.directory, "library.json"), MAX_LIBRARY))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { formatVersion: 1, proposals: [], releases: [] };
      throw error;
    }
  }

  private async mutate<T>(operation: (state: LibraryState) => T | Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, ".write-lock");
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Migration library is locked; another operation or interrupted writer needs review.");
      throw error;
    }
    const temporary = path.join(this.directory, `.library-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = await operation(state);
      validateState(state);
      const encoded = JSON.stringify(state, null, 2);
      if (Buffer.byteLength(encoded) > MAX_LIBRARY) throw new Error("Library exceeds the local storage limit.");
      await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(this.directory, "library.json"));
      return structuredClone(result);
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true });
    }
  }

  async importProposal(repositoryRoot: string, manifestRelativePath: string, workspaceRoot: string): Promise<MigrationProposal> {
    relativePath(manifestRelativePath);
    const [repository, workspace] = await Promise.all([realpath(repositoryRoot), realpath(workspaceRoot)]);
    if (!inside(workspace, repository)) throw new Error("Repository is outside the selected workspace.");
    const gitArgs = ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`];
    const actual = await runGit(repository, [...gitArgs, "rev-parse", "--show-toplevel"]);
    if (!samePath(await realpath(actual.stdout.trim()), repository)) throw new Error("Select the Git repository root.");
    const manifestPath = await realpath(path.resolve(repository, manifestRelativePath));
    if (!inside(repository, manifestPath)) throw new Error("Manifest escapes the selected repository.");
    const verifiedDirectories = new Set<string>();
    const verifyGitBoundary = async (file: string): Promise<void> => {
      const directory = path.dirname(file);
      if (verifiedDirectories.has(directory)) return;
      const actual = await runGit(directory, [...gitArgs, "rev-parse", "--show-toplevel"]);
      if (!samePath(await realpath(actual.stdout.trim()), repository)) throw new Error("Referenced file belongs to a nested repository, not the selected Git boundary.");
      verifiedDirectories.add(directory);
    };
    await verifyGitBoundary(manifestPath);
    const manifest = validateMigrationManifest(JSON.parse(await readBounded(manifestPath, MAX_FILE)));
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    let size = 0;
    for (const reference of references(manifest)) {
      const file = await realpath(path.resolve(path.dirname(manifestPath), reference));
      if (!inside(repository, file)) throw new Error("Referenced file escapes the selected repository.");
      await verifyGitBoundary(file);
      files[reference] = await readBounded(file, MAX_FILE);
      size += Buffer.byteLength(files[reference]);
      if (size > MAX_PROPOSAL) throw new Error("Proposal is oversized.");
    }
    const [revision, status] = await Promise.all([tryGit(repository, [...gitArgs, "rev-parse", "--verify", "HEAD"]), runGit(repository, [...gitArgs, "status", "--porcelain=v1", "--untracked-files=normal"])]);
    const contentDigest = migrationContentDigest(manifest, files);
    const proposal: MigrationProposal = { proposalId: proposalId(manifest, contentDigest), manifest, contentDigest, files, source: { repositoryPath: repository, manifestRelativePath, commit: revision.code === 0 ? revision.stdout.trim() : null, dirty: !!status.stdout.trim() }, status: "draft", importedAt: new Date().toISOString(), validationWarnings: [...WARNINGS] };
    return this.mutate((state) => {
      const sameId = state.proposals.filter((entry) => entry.manifest.id === manifest.id);
      if (sameId.some((entry) => entry.manifest.databaseKey !== manifest.databaseKey || !samePath(entry.source.repositoryPath, repository))) throw new Error("Migration ID is already owned by a different source or database.");
      if (sameId.some((entry) => entry.status === "sealed" && entry.contentDigest !== contentDigest)) throw new Error("Sealed migration content cannot change; use a new migration ID.");
      const existing = state.proposals.find((entry) => entry.proposalId === proposal.proposalId);
      if (existing) return existing;
      state.proposals.push(proposal); return proposal;
    });
  }

  async listProposals(database?: string): Promise<MigrationProposal[]> {
    if (database !== undefined) databaseKey(database);
    return (await this.read()).proposals.filter((entry) => database === undefined || entry.manifest.databaseKey === database);
  }

  /** Adopt a validated broker snapshot without rereading a mutable source checkout. */
  async importProposalSnapshot(snapshot: MigrationProposal): Promise<MigrationProposal> {
    const proposal = validateProposal(structuredClone(snapshot));
    if (proposal.status !== "draft") throw new Error("Only draft proposal snapshots can be submitted.");
    return this.mutate(state => {
      const sameId = state.proposals.filter(entry => entry.manifest.id === proposal.manifest.id);
      if (sameId.some(entry => entry.manifest.databaseKey !== proposal.manifest.databaseKey || !samePath(entry.source.repositoryPath, proposal.source.repositoryPath))) throw new Error("Migration ID is already owned by a different source or database.");
      const existing = state.proposals.find(entry => entry.proposalId === proposal.proposalId);
      if (existing) return existing;
      if (sameId.some(entry => entry.status === "sealed" && entry.contentDigest !== proposal.contentDigest)) throw new Error("Sealed migration content cannot change; use a new migration ID.");
      state.proposals.push(proposal); return proposal;
    });
  }

  async getProposal(id: string): Promise<MigrationProposal> {
    const proposals = (await this.read()).proposals;
    const result = proposals.find((entry) => entry.proposalId === id) ?? [...proposals].reverse().find((entry) => entry.manifest.id === id);
    if (!result) throw new Error("Migration proposal was not found.");
    return result;
  }

  async getRelease(database: string): Promise<MigrationRelease | undefined> {
    databaseKey(database);
    return (await this.read()).releases.filter((entry) => entry.databaseKey === database).at(-1);
  }

  async sealRelease(database: string): Promise<MigrationRelease> {
    databaseKey(database);
    return this.mutate((state) => {
      const previous = state.releases.filter((entry) => entry.databaseKey === database).at(-1);
      const proposals = state.proposals.filter((entry) => entry.manifest.databaseKey === database);
      const latest = new Map(proposals.map((proposal) => [proposal.manifest.id, proposal]));
      const migrations = [...(previous?.migrations ?? [])];
      const included = new Set(migrations.map((entry) => entry.id));
      const pending = [...latest.values()].filter((proposal) => !included.has(proposal.manifest.id));
      for (const proposal of pending) for (const dependency of proposal.manifest.dependsOn) if (!latest.has(dependency)) throw new Error(`Missing dependency ${dependency}.`);
      while (pending.length) {
        const available = pending.filter((proposal) => proposal.manifest.dependsOn.every((dependency) => included.has(dependency))).sort((a, b) => a.manifest.id < b.manifest.id ? -1 : 1);
        if (!available.length) throw new Error("Migration dependencies contain a cycle.");
        const proposal = available[0];
        pending.splice(pending.indexOf(proposal), 1);
        proposal.status = "sealed"; included.add(proposal.manifest.id);
        migrations.push({ sequence: migrations.length + 1, id: proposal.manifest.id, contentDigest: proposal.contentDigest, proposalId: proposal.proposalId });
      }
      if (previous && previous.migrations.length === migrations.length) return previous;
      if (!migrations.length) throw new Error("No proposals are available to seal.");
      const body = { formatVersion: 1 as const, databaseKey: database, parentReleaseDigest: previous?.digest ?? null, migrations };
      const hash = releaseDigest(body), release = { ...body, digest: hash, releaseId: hash };
      state.releases.push(release); return release;
    });
  }

  async exportLibrary(): Promise<string> { return JSON.stringify(await this.read(), null, 2); }

  /** Portable import intentionally requires an empty destination; never replaces local history. */
  async importLibrary(serialized: string): Promise<void> {
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_LIBRARY) throw new Error("Invalid or oversized library import.");
    const imported = validateState(JSON.parse(serialized));
    await this.mutate((state) => {
      if (state.proposals.length || state.releases.length) throw new Error("Import requires an empty library to preserve local history.");
      state.proposals = imported.proposals; state.releases = imported.releases;
    });
  }
}
