import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import type { DatabaseCredentialRole, DatabaseCredentials, DatabaseCredentialInput, DatabaseServerInput, DatabaseDiscovery, DatabaseProfile, DatabaseProfileInput, SchemaSnapshot } from "../../src/types/database.js";
import type { DatabaseDesktopApi, DatabaseDiagnosticSetup, DatabaseOverview, DatabasePlanInput, DatabaseTargetVerification, RehearsalResult } from "../../src/types/databaseApi.js";
import type { AdmissionEvidence, DatabaseHistory, MigrationPlan, RunnerCheck, RunnerMigration, RunnerTarget } from "../../src/types/databaseExecution.js";
import type { MigrationCheck, MigrationProposal, MigrationRelease } from "../../src/types/migration.js";
import { connectDatabase, connectDatabaseServer, databaseDigest, readIdentity, readServerIdentity, type SqlSession } from "./connections.js";
import { DatabaseProfileStore, type DatabaseSecretProtector } from "./profileStore.js";
import { captureSchema, compareSchemas } from "./schema.js";
import { MigrationLibrary } from "./migrations.js";
import { MigrationRunner, appliedPrefix, readHistory } from "./runner.js";
import { freezeSql } from "./sql.js";
import { DatabaseEvidenceStore } from "./evidenceStore.js";
import { rehearseOnEmptySandbox, runChecks, type ReplayEvidence } from "./rehearsal.js";
import { saveDiagnosticConfig, disableDiagnosticConfig, collectDiagnosticSubmissions } from "./devConfig.js";
import { restoreRecordSchema, type RestoreVerificationRecord } from "./restoreRecord.js";

function text(value: unknown, name: string, max = 1000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}.`);
}
function sameIdentity(a: SchemaSnapshot["identity"], b: SchemaSnapshot["identity"]): boolean { return databaseDigest(a) === databaseDigest(b); }
class TargetVerificationError extends Error {}
function checks(proposal: MigrationProposal, list: MigrationCheck[]): RunnerCheck[] { return list.map(check => ({ sql: proposal.files[check.path], expect: check.expect, ...(Object.hasOwn(check, "value") ? { value: check.value } : {}) })); }
function version(value: string): number[] { const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value); if (!match) throw new Error("Engine version cannot be verified."); return match.slice(1).map(Number); }
function compareVersion(a: string, b: string): number { const left = version(a), right = version(b); return left.findIndex((part, index) => part !== right[index]) < 0 ? 0 : left.reduce((result, part, index) => result || Math.sign(part - right[index]), 0); }

/** A tested suffix remains reversible after applying only part of a rehearsed prefix. */
export function replayMatchesTarget(item: ReplayEvidence, target: RunnerTarget, releaseDigest: string, beforeSchemaDigest: string, history: DatabaseHistory, migrations: RunnerMigration[], direction: "up" | "down", now = Date.now()): boolean {
  if (item.targetId !== target.targetId || item.releaseDigest !== releaseDigest || !sameIdentity(item.baseline.identity, target.identity) || !item.history || Date.parse(item.expiresAt) <= now) return false;
  if (history.enrolled !== item.history.enrolled || history.identityFingerprint !== item.history.identityFingerprint || history.baselineDigest !== item.history.baselineDigest) return false;
  if (databaseDigest(history.events.slice(0, item.history.events.length)) !== databaseDigest(item.history.events)) return false;
  const prefix = history.enrolled ? appliedPrefix(history, migrations) : [];
  const count = prefix.length - item.appliedIds.length;
  if (count < 0 || count > item.migrationIds.length || JSON.stringify(prefix) !== JSON.stringify([...item.appliedIds, ...item.migrationIds.slice(0, count)])) return false;
  const expectedSchema = count ? item.upDigests[item.migrationIds[count - 1]] : item.beforeSchemaDigest;
  return expectedSchema === beforeSchemaDigest && (direction === "up" ? history.digest === item.historyDigest : count > 0 && item.testedDownIds.length > 0);
}

export interface DatabaseServiceOptions {
  directory: string;
  protector: DatabaseSecretProtector;
  root: () => string | null;
  repositories: () => Promise<string[]>;
  confirm: (plan: MigrationPlan) => Promise<boolean>;
  connect?: typeof connectDatabase;
  connectServer?: typeof connectDatabaseServer;
  diagnosticInstructions?: string;
  reviewRestoreRecord?: (record?: RestoreVerificationRecord) => Promise<string | boolean | null>;
}

/** Privileged coordinator. No renderer-supplied evidence, approval capability or SQL. */
export class DatabaseService implements DatabaseDesktopApi {
  readonly profiles: DatabaseProfileStore;
  readonly library: MigrationLibrary;
  readonly evidence: DatabaseEvidenceStore;
  readonly runner: MigrationRunner;
  private readonly observed = new Map<string, SchemaSnapshot>();
  private readonly plans = new Map<string, { plan: MigrationPlan; profileId: string; migrationIds: string[] }>();
  private readonly connect: typeof connectDatabase;
  private active: DatabaseOverview["activeRun"] = null;
  private maintenance = false;
  constructor(private readonly options: DatabaseServiceOptions) {
    this.connect = options.connect ?? connectDatabase;
    this.profiles = new DatabaseProfileStore(options.directory, options.protector);
    this.library = new MigrationLibrary(path.join(options.directory, "library"));
    this.evidence = new DatabaseEvidenceStore(options.directory, options.protector);
    this.runner = new MigrationRunner({
      open: async target => {
        const config = await this.profiles.getConnection(target.targetId, "migration");
        if (!config.identity || !sameIdentity(config.identity, target.identity) || config.databaseKey !== target.databaseKey || config.environment !== target.environment) throw new Error("The registered migration target changed; review a new plan.");
        const session = await this.connect(config);
        try { await this.validateTarget(session, target); await this.validateReleaseEngine(session, target); return session; } catch (error) { await session.close(); throw error; }
      },
      inspect: async (session, target) => {
        const identity = await this.validateTarget(session, target);
        const snapshot = await captureSchema(session, identity);
        return { identity, identityFingerprint: identity.fingerprint, schemaDigest: snapshot.digest, coverageComplete: snapshot.coverage.complete };
      },
      trustedEvidence: (target, migrations, direction, releaseDigest, beforeSchemaDigest) => this.trustedEvidence(target, migrations, direction, releaseDigest, beforeSchemaDigest),
      progress: progress => { if (this.active?.planId === progress.planId) this.active.message = `${progress.migrationId ?? "Migration"}: ${progress.state}${progress.ordinal ? `, statement ${progress.ordinal}` : ""}`; },
    });
  }
  private mutable(): void { if (this.active || this.maintenance) throw new Error("Wait for the active database operation before changing configuration or artifacts."); this.runner.invalidatePlans(); this.plans.clear(); }
  private async change<T>(operation: () => Promise<T>, invalidatePlans = true): Promise<T> {
    if (invalidatePlans) this.mutable();
    else if (this.active || this.maintenance) throw new Error("Wait for the active database operation before verifying targets.");
    this.maintenance = true;
    const lock = path.join(this.options.directory, ".configuration-lock");
    let acquired = false;
    try {
      await mkdir(this.options.directory, { recursive: true });
      try { await mkdir(lock); acquired = true; } catch { throw new Error("Another database configuration/rehearsal operation or interrupted writer requires review."); }
      return await operation();
    } finally { if (acquired) await rmdir(lock); this.maintenance = false; }
  }
  private async profile(id: string): Promise<DatabaseProfile> { text(id, "profile ID", 100); const profile = (await this.profiles.list()).find(item => item.id === id); if (!profile) throw new Error("Database profile was not found."); return profile; }
  private async validateTarget(session: SqlSession, target: RunnerTarget) {
    const identity = await readIdentity(session, target.identity.database);
    if (!sameIdentity(identity, target.identity)) throw new Error("Database identity, engine, version or settings changed since enrollment.");
    const profiles = await this.profiles.list();
    if (profiles.some(profile => profile.id !== target.targetId && profile.environment !== target.environment && profile.environment !== "sandbox" && profile.identity?.fingerprint === identity.fingerprint)) throw new Error("Development and production resolve to the same registered database.");
    return identity;
  }
  private async validateReleaseEngine(session: SqlSession, target: RunnerTarget): Promise<void> {
    const release = await this.library.getRelease(target.databaseKey);
    if (!release) return;
    const allowed = new Set(["sql_mode", "lower_case_table_names", "innodb_page_size", "innodb_default_row_format", "character_set_database", "collation_database"]);
    for (const entry of release.migrations) {
      const proposal = await this.library.getProposal(entry.proposalId);
      const engine = proposal.manifest.engine;
      if (engine.product !== target.identity.engine || compareVersion(target.identity.version, engine.minVersion) < 0 || (engine.maxVersion && compareVersion(target.identity.version, engine.maxVersion) > 0)) throw new Error(`Migration ${entry.id} is incompatible with the observed engine/version.`);
      for (const [setting, expected] of Object.entries(engine.requiredSettings)) {
        if (!allowed.has(setting)) throw new Error(`Unsupported engine prerequisite: ${setting}.`);
        const [row] = await session.query(`SELECT @@${setting} AS value`);
        if (String(row?.value) !== String(expected)) throw new Error(`An engine prerequisite is not satisfied for ${entry.id}.`);
      }
      if (engine.storageEngines.length) {
        const engines = await session.query("SHOW ENGINES");
        if (engine.storageEngines.some(required => !engines.some(row => String(row.Engine).toLowerCase() === required.toLowerCase() && ["YES", "DEFAULT"].includes(String(row.Support))))) throw new Error("A required storage engine is unavailable.");
      }
    }
  }
  async overview(): Promise<DatabaseOverview> {
    const submissionErrors: { proposalId: string; message: string }[] = [];
    // The dev MCP broker can only submit drafts into its own library. Merge validated
    // snapshots for currently discovered repositories without exposing desktop state.
    if (!this.active && !this.maintenance) {
      let repositories: string[] = [], submissions: MigrationProposal[] = [];
      try { repositories = await this.options.repositories(); submissions = await collectDiagnosticSubmissions(this.options.directory); }
      catch { submissionErrors.push({ proposalId: "submission-inbox", message: "Agent submissions could not be read. Existing database profiles and releases remain available." }); }
      for (const proposal of submissions) {
        if (repositories.some(repository => path.resolve(repository).toLowerCase() === path.resolve(proposal.source.repositoryPath).toLowerCase())) {
          const existing = await this.library.listProposals(proposal.manifest.databaseKey);
          if (!existing.some(item => item.proposalId === proposal.proposalId)) {
            try { await this.library.importProposalSnapshot(proposal); this.invalidateSourcePlans(); }
            catch { submissionErrors.push({ proposalId: proposal.proposalId, message: `Draft ${proposal.manifest.id} conflicts with the immutable library or requires source review. Correct it using a new migration ID when the old ID is sealed.` }); }
          }
        }
      }
    }
    const [profiles, servers, proposals, state] = await Promise.all([this.profiles.list(), this.profiles.listServers(), this.library.listProposals(), this.evidence.read()]);
    const keys = [...new Set([...profiles.map(profile => profile.databaseKey), ...proposals.map(proposal => proposal.manifest.databaseKey)])];
    const releases = (await Promise.all(keys.map(key => this.library.getRelease(key)))).filter((release): release is MigrationRelease => !!release);
    return { profiles, servers, proposals, releases, rehearsals: state.replays.map(({ evidenceId, databaseKey, releaseDigest, createdAt, expiresAt, assessment, notes, migrationIds }) => ({ evidenceId, databaseKey, releaseDigest, createdAt, expiresAt, assessment, notes, migrationIds })), activeRun: this.active ? { ...this.active } : null, lastRun: state.runs.at(-1)?.result ?? null, submissionErrors };
  }
  private async revokeConfigurationEvidence(ids: string[]): Promise<void> {
    await disableDiagnosticConfig(this.options.directory);
    for (const id of ids) this.observed.delete(id);
    await this.evidence.update(state => {
      // A changed sandbox may have supplied proofs for another target.
      state.replays = []; state.restores = [];
      for (const id of ids) delete state.snapshots[id];
    });
  }
  async getServerConnection(id: string) { text(id, "server connection ID", 80); return this.profiles.getServerDetails(id); }
  async saveServerConnection(input: DatabaseServerInput) {
    return this.change(async () => {
      const ids = (await this.profiles.list()).filter(profile => profile.serverConnectionId === input?.id).map(profile => profile.id);
      await this.revokeConfigurationEvidence(ids);
      return this.profiles.saveServer(input);
    });
  }
  async saveServerCredentials(id: string, role: DatabaseCredentialRole, credentials: DatabaseCredentialInput) {
    text(id, "server connection ID", 80);
    return this.change(async () => {
      const ids = (await this.profiles.list()).filter(profile => profile.serverConnectionId === id).map(profile => profile.id);
      await this.revokeConfigurationEvidence(ids);
      await this.profiles.setServerCredentials(id, role, credentials);
    });
  }
  private async discover(id: string): Promise<DatabaseDiscovery> {
    text(id, "server connection ID", 80);
    const config = await this.profiles.getServerConfig(id, "inspection");
    const session = await (this.options.connectServer ?? connectDatabaseServer)(config);
    try {
      const identity = await readServerIdentity(session);
      const rows = await session.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 2001");
      if (rows.length > 2000) throw new Error("This server exposes more than 2000 schemas; register targets individually.");
      const [profiles, servers] = await Promise.all([this.profiles.list(), this.profiles.listServers()]);
      const host = (value: string) => value.toLowerCase().replace(/\.$/, "");
      const fold = (value: string) => identity.lowerCaseTableNames ? value.toLowerCase() : value;
      const names = new Set<string>();
      const databases = rows.map(row => {
        const database = row.name;
        text(database, "discovered database name", 64);
        if (["information_schema", "performance_schema", "mysql", "sys"].includes(database.toLowerCase())) return null;
        if (names.has(fold(database))) return null;
        names.add(fold(database));
        const assigned = profiles.filter(profile => {
          if (fold(profile.database) !== fold(database)) return false;
          const server = servers.find(item => item.id === profile.serverConnectionId);
          return profile.serverConnectionId === id || (server && host(server.host) === host(config.host) && server.port === config.port) || profile.identity?.serverId === identity.serverId;
        });
        return { database, assigned: assigned.length > 0, profileIds: assigned.map(profile => profile.id) };
      }).filter((database): database is NonNullable<typeof database> => database !== null);
      return { serverConnectionId: id, databases };
    } finally { await session.close(); }
  }
  async discoverDatabases(id: string): Promise<DatabaseDiscovery> {
    // Serialize against endpoint/credential edits and migration execution so the list
    // belongs to one unchanged server configuration.
    return this.change(() => this.discover(id));
  }
  async assignDatabases(id: string, inputs: DatabaseProfileInput[]) {
    return this.change(async () => {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100 || inputs.some(input => !input || input.id !== undefined || input.serverConnectionId !== id)) throw new Error("Invalid database assignments.");
      const discovery = await this.discover(id);
      const available = new Set(discovery.databases.filter(item => !item.assigned).map(item => item.database));
      if (inputs.some(input => !available.has(input.database)) || new Set(inputs.map(input => input.database)).size !== inputs.length) throw new Error("Choose distinct available databases that are not already assigned; refresh discovery.");
      await this.revokeConfigurationEvidence([]);
      return this.profiles.saveProfiles(inputs);
    });
  }
  async saveProfile(input: DatabaseProfileInput) { return this.change(async () => { await this.revokeConfigurationEvidence(input?.id ? [input.id] : []); return this.profiles.saveProfile(input); }); }
  async saveCredentials(id: string, role: DatabaseCredentialRole, credentials: DatabaseCredentials) {
    const profile = await this.profile(id);
    if (role === "diagnostic" && profile.environment !== "dev") throw new Error("Diagnostic credentials require a development profile.");
    await this.saveServerCredentials(profile.serverConnectionId, role, credentials);
  }
  async inspect(id: string): Promise<SchemaSnapshot> {
    return this.change(() => this.inspectTarget(id), false);
  }
  private async inspectTarget(id: string): Promise<SchemaSnapshot> {
    const profile = await this.profile(id), config = await this.profiles.getConnection(id, "inspection"), session = await this.connect(config);
    try {
      const identity = await readIdentity(session, config.database);
      const snapshot = await captureSchema(session, identity);
      if (profile.identity && !sameIdentity(profile.identity, identity)) snapshot.coverage = { ...snapshot.coverage, complete: false, limitations: [...snapshot.coverage.limitations, "Observed identity/settings differ from the enrolled target; explicit enrollment is required."] };
      this.observed.set(id, snapshot);
      await this.evidence.update(state => { state.snapshots[id] = snapshot; });
      return snapshot;
    } finally { await session.close(); }
  }
  private async observeIdentity(id: string): Promise<SchemaSnapshot["identity"]> {
    const config = await this.profiles.getConnection(id, "inspection"), session = await this.connect(config);
    try { return await readIdentity(session, config.database); } finally { await session.close(); }
  }
  /** Call only while holding the configuration lock; initial binding is local and read-only. */
  private async verifyTargetIdentity(id: string): Promise<DatabaseProfile> {
    const profile = await this.profile(id);
    const first = await this.observeIdentity(id);
    if (profile.identity && !sameIdentity(profile.identity, first)) {
      await disableDiagnosticConfig(this.options.directory);
      throw new TargetVerificationError("The database identity, engine, version or settings changed. Review the target configuration before accepting a replacement identity.");
    }
    const second = await this.observeIdentity(id);
    if (!sameIdentity(first, second)) {
      await disableDiagnosticConfig(this.options.directory);
      throw new TargetVerificationError("The target changed during verification. Check its connection and try again.");
    }
    if ((await this.profiles.list()).some(other => other.id !== id && other.environment !== profile.environment && other.environment !== "sandbox" && profile.environment !== "sandbox" && other.identity?.fingerprint === second.fingerprint)) {
      await disableDiagnosticConfig(this.options.directory);
      throw new TargetVerificationError("Dev and production cannot share the same database identity.");
    }
    if (!profile.identity) {
      await disableDiagnosticConfig(this.options.directory);
      await this.evidence.update(state => { state.replays = state.replays.filter(item => item.targetId !== id); state.restores = state.restores.filter(item => item.targetId !== id); });
      await this.profiles.enrollIdentity(id, second);
    }
    return this.profile(id);
  }
  async verifyTargets(ids: string[]): Promise<DatabaseTargetVerification[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error("Choose between one and 100 distinct database targets.");
    ids.forEach(id => text(id, "profile ID", 100));
    return this.change(async () => {
      const results: DatabaseTargetVerification[] = [];
      for (const profileId of ids) {
        try { await this.verifyTargetIdentity(profileId); results.push({ profileId, status: "verified" }); }
        catch (error) { results.push({ profileId, status: "failed", message: error instanceof TargetVerificationError ? error.message : "Unable to verify this target. Check its saved connection details, inspection credentials and database permissions." }); }
      }
      return results;
    });
  }
  async acceptIdentity(id: string, fingerprint: string): Promise<void> {
    return this.change(async () => {
    text(fingerprint, "identity fingerprint", 128);
    await disableDiagnosticConfig(this.options.directory);
    const previous = this.observed.get(id);
    if (!previous || previous.identity.fingerprint !== fingerprint) throw new Error("Inspect this exact target before accepting its identity.");
    const current = await this.inspectTarget(id);
    if (!sameIdentity(previous.identity, current.identity)) throw new Error("The target changed during review.");
    const profile = await this.profile(id);
    if ((await this.profiles.list()).some(other => other.id !== id && other.environment !== profile.environment && other.environment !== "sandbox" && profile.environment !== "sandbox" && other.identity?.fingerprint === fingerprint)) throw new Error("Dev and production cannot share the same database identity.");
    await this.profiles.enrollIdentity(id, current.identity);
    await this.evidence.update(state => { state.replays = state.replays.filter(item => item.targetId !== id); state.restores = state.restores.filter(item => item.targetId !== id); });
    });
  }
  private async pair(key: string): Promise<{ dev: DatabaseProfile; production: DatabaseProfile }> {
    text(key, "database key", 128); const profiles = (await this.profiles.list()).filter(profile => profile.databaseKey === key);
    const dev = profiles.filter(profile => profile.environment === "dev"), production = profiles.filter(profile => profile.environment === "production");
    if (dev.length !== 1 || production.length !== 1) throw new Error("Configure exactly one development and one production profile for this logical database.");
    return { dev: dev[0], production: production[0] };
  }
  async compare(key: string) {
    return this.change(async () => {
    const pair = await this.pair(key);
    await this.verifyTargetIdentity(pair.dev.id);
    await this.verifyTargetIdentity(pair.production.id);
    const [dev, production] = await Promise.all([this.inspectTarget(pair.dev.id), this.inspectTarget(pair.production.id)]);
    const comparison = compareSchemas(dev, production), release = await this.library.getRelease(key);
    const history = await this.readTargetHistory(pair.production.id);
    const evidence = (await this.evidence.read()).replays.slice().reverse().find(replay => replay.targetId === pair.production.id && replay.releaseDigest === release?.digest && sameIdentity(replay.baseline.identity, production.identity) && replay.historyDigest === history.digest && replay.beforeSchemaDigest === production.digest && replay.afterSchemaDigest === dev.digest && replay.assessment === "explained" && Date.parse(replay.expiresAt) > Date.now());
    if (comparison.coverage.complete && evidence) {
      comparison.assessment = "explained";
      comparison.differences = comparison.differences.map(difference => ({ ...difference, assessment: "explained" as const, migrationIds: evidence.migrationIds.filter(id => evidence.changesByMigration[id]?.includes(`${difference.objectType}:${difference.objectPath}`)), reason: "The exact pending migration prefix reproduced development structure on an isolated matching instance." }));
    }
    return comparison;
    }, false);
  }
  async importProposal(repositoryPath: string, manifestPath: string) {
    return this.change(async () => {
    text(repositoryPath, "repository path", 4000); text(manifestPath, "manifest path", 2000);
    const root = this.options.root(); if (!root) throw new Error("Choose a repository root in Settings first.");
    if (!(await this.options.repositories()).some(repository => path.resolve(repository).toLowerCase() === path.resolve(repositoryPath).toLowerCase())) throw new Error("Choose a discovered repository within the selected root.");
    return this.library.importProposal(repositoryPath, manifestPath, root);
    });
  }
  async sealRelease(key: string) { return this.change(() => this.library.sealRelease(key)); }
  private async target(id: string): Promise<RunnerTarget> {
    const profile = await this.profile(id);
    if (!profile.identity || profile.environment === "sandbox") throw new Error("Inspect and accept a dev/production target identity first.");
    return { targetId: profile.id, databaseKey: profile.databaseKey, environment: profile.environment, identity: profile.identity };
  }
  async history(id: string) {
    return this.change(async () => { await this.verifyTargetIdentity(id); return this.readTargetHistory(id); }, false);
  }
  private async readTargetHistory(id: string) {
    const target = await this.target(id), config = await this.profiles.getConnection(id, "inspection"), session = await this.connect(config);
    try { await this.validateTarget(session, target); return await readHistory(session); } finally { await session.close(); }
  }
  async releaseMigrations(release: MigrationRelease): Promise<RunnerMigration[]> {
    return Promise.all(release.migrations.map(async entry => {
      const proposal = await this.library.getProposal(entry.proposalId);
      if (proposal.contentDigest !== entry.contentDigest) throw new Error("Sealed proposal digest changed.");
      const upSql = proposal.manifest.up.map(file => proposal.files[file]), downSql = (proposal.manifest.recovery.down ?? []).map(file => proposal.files[file]);
      const up = freezeSql(upSql), down = freezeSql(downSql);
      const destructiveDown = down.some(statement => /^DROP\s+TABLE\b|\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?!(?:INDEX|KEY|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b)/i.test(statement.sql));
      return { id: entry.id, sequence: entry.sequence, contentDigest: entry.contentDigest, upSql, downSql, preconditions: checks(proposal, proposal.manifest.preconditions), postconditions: checks(proposal, proposal.manifest.postconditions), eligibilityChecks: checks(proposal, proposal.manifest.recovery.eligibilityChecks), transactional: [...up, ...down].every(statement => statement.kind === "dml"), recoveryRoute: proposal.manifest.recovery.rollbackRoute, conditionalDown: proposal.manifest.recovery.eligibilityChecks.length > 0 || proposal.manifest.dataImpact.destructive || destructiveDown };
    }));
  }
  async createPlan(input: DatabasePlanInput): Promise<MigrationPlan> {
    if (this.active || this.maintenance) throw new Error("Wait for the current database operation.");
    if (!input || !["enroll", "adopt", "execute"].includes(input.kind) || !["up", "down"].includes(input.direction) || !Array.isArray(input.migrationIds) || input.migrationIds.length > 10_000 || input.migrationIds.some(id => typeof id !== "string")) throw new Error("Invalid migration plan input.");
    return this.change(async () => {
    await this.verifyTargetIdentity(input.profileId);
    const target = await this.target(input.profileId), release = await this.library.getRelease(target.databaseKey);
    if (!release && input.kind !== "enroll") throw new Error("Seal a migration release first.");
    const snapshot = await this.inspectTarget(input.profileId);
    const plan = await this.runner.createPlan({ target, releaseDigest: release?.digest ?? databaseDigest([target.databaseKey, "enrollment"]), migrations: release ? await this.releaseMigrations(release) : [], migrationIds: input.migrationIds, kind: input.kind, direction: input.direction, baselineDigest: snapshot.digest });
    const selectedProfile = await this.profile(input.profileId);
    const review = [`${selectedProfile.label} (${target.environment})`, `Database: ${target.identity.database}`, `Server: ${target.identity.serverId}`, `Identity: ${target.identity.fingerprint}`, `Engine: ${target.identity.engine} ${target.identity.version}`];
    if (input.kind === "enroll") { plan.statementCount = 3; review.push("Create two history tables and record the current baseline. No business migration will run."); }
    if (input.kind === "adopt") review.push("Record an operator-reviewed existing prefix as adoption. This does not claim that the tool executed those historical scripts.");
    if (release && input.kind === "execute") {
      const admitted = await this.trustedEvidence(target, await this.releaseMigrations(release), input.direction, release.digest, snapshot.digest);
      for (const id of input.migrationIds) {
        const entry = release.migrations.find(item => item.id === id)!, proposal = await this.library.getProposal(entry.proposalId);
        const recovery = admitted.recovery.filter(item => item.migrationId === id);
        review.push(`\n${id}: ${proposal.manifest.title}`, `Expected after schema: ${admitted.expectedSchemaDigests[id]}`, `Data impact: ${proposal.manifest.dataImpact.description}`, `Write pause required: ${proposal.manifest.dataImpact.requiresWritePause ? "YES — pause writers before Run" : "no declared pause"}`, `Locking: ${proposal.manifest.dataImpact.locking}`, `Application compatibility: ${proposal.manifest.applicationCompatibility}`, `Recovery compatibility: ${proposal.manifest.recovery.applicationCompatibility}`, `Recovery procedure:\n${proposal.files[proposal.manifest.recovery.runbook]}`);
        for (const evidence of recovery) review.push(evidence.backup ? `External backup: ${evidence.backup.identity}\nCaptured: ${evidence.backup.capturedAt}\nDowntime limit: ${evidence.backup.downtimeLimitMinutes} minutes\nData loss limit: ${evidence.backup.dataLossLimitMinutes} minutes\nAffected services: ${evidence.backup.affectedServices.join(", ")}` : "Tested down path on isolated structure; data recovery is not established by schema equality.");
      }
    }
    plan.reviewSummary = review.join("\n");
    if (plan.reviewSummary.length > 60000) { this.invalidateSourcePlans(); throw new Error("This review is too large; select a smaller contiguous migration batch."); }
    this.plans.set(plan.planId, { plan, profileId: input.profileId, migrationIds: input.migrationIds });
    return plan;
    }, false);
  }
  async runPlan(planId: string) {
    text(planId, "plan ID", 100); if (this.active || this.maintenance) throw new Error("Wait for the current database operation.");
    const selected = this.plans.get(planId); if (!selected) throw new Error("Review a new migration plan.");
    this.active = { planId, targetId: selected.profileId, message: "Waiting for operator confirmation" };
    try {
      if (!await this.options.confirm(selected.plan)) throw new Error("Execution cancelled; no database statements were sent.");
      this.plans.delete(planId);
      const result = await this.runner.execute(planId, this.runner.issueApproval(planId));
      await this.evidence.update(state => { state.runs.push({ result, profileId: selected.profileId, releaseDigest: selected.plan.releaseDigest, migrationIds: selected.migrationIds, direction: selected.plan.direction, at: new Date().toISOString() }); });
      return result;
    } finally { this.active = null; }
  }
  hasActiveOperation(): boolean { return !!this.active || this.maintenance; }
  invalidateSourcePlans(): void { this.plans.clear(); this.runner.invalidatePlans(); }
  async revokeDiagnostics(): Promise<void> { await disableDiagnosticConfig(this.options.directory); }
  async serializeRootChange<T>(operation: () => T | Promise<T>): Promise<T> { return this.change(async () => { await disableDiagnosticConfig(this.options.directory); return operation(); }); }
  private async trustedEvidence(target: RunnerTarget, _migrations: RunnerMigration[], direction: "up" | "down", releaseDigest: string, beforeSchemaDigest: string): Promise<AdmissionEvidence> {
    const state = await this.evidence.read();
    const currentHistory = await this.readTargetHistory(target.targetId);
    const replay = state.replays.slice().reverse().find(item => replayMatchesTarget(item, target, releaseDigest, beforeSchemaDigest, currentHistory, _migrations, direction));
    if (!replay) return { recovery: [], expectedSchemaDigests: {} };
    const profiles = await this.profiles.list();
    const devProfiles = profiles.filter(profile => profile.databaseKey === target.databaseKey && profile.environment === "dev");
    let development: AdmissionEvidence["development"];
    let explanationCurrent = replay.assessment === "explained";
    if (target.environment === "production" && devProfiles.length === 1) {
      const devProfile = devProfiles[0], devTarget = await this.target(devProfile.id);
      const session = await this.connect(await this.profiles.getConnection(devProfile.id, "inspection"));
      try {
        const identity = await this.validateTarget(session, devTarget);
        const snapshot = await captureSchema(session, identity), history = await readHistory(session);
        const prefix = appliedPrefix(history, _migrations);
        const completed = new Set(history.events.filter(event => event.kind === "attempt-end" && event.state === "succeeded").map(event => event.attemptId));
        const executed = history.events.filter(event => event.kind === "attempt-start" && event.direction === "up" && completed.has(event.attemptId));
        development = { evidenceId: history.digest, releaseDigest, migrations: _migrations.filter(migration => (direction === "down" || prefix.includes(migration.id)) && executed.some(event => event.migrationId === migration.id && event.contentDigest === migration.contentDigest)).map(({ id, contentDigest }) => ({ id, contentDigest })) };
        const devCount = prefix.length - replay.appliedIds.length;
        const knownDevPrefix = devCount >= 0 && devCount <= replay.migrationIds.length && JSON.stringify(prefix) === JSON.stringify([...replay.appliedIds, ...replay.migrationIds.slice(0, devCount)]);
        const expectedDevDigest = direction === "down" && knownDevPrefix ? (devCount ? replay.upDigests[replay.migrationIds[devCount - 1]] : replay.beforeSchemaDigest) : replay.afterSchemaDigest;
        explanationCurrent = explanationCurrent && snapshot.coverage.complete && snapshot.digest === expectedDevDigest && snapshot.identity.engine === target.identity.engine && snapshot.identity.version === target.identity.version && JSON.stringify(snapshot.identity.settings) === JSON.stringify(target.identity.settings);
      } finally { await session.close(); }
    }
    return {
      expectedSchemaDigests: direction === "up" ? replay.upDigests : replay.downDigests,
      recovery: [...replay.testedDownIds.map(id => ({ evidenceId: `${replay.evidenceId}:${id}`, targetId: target.targetId, releaseDigest, beforeSchemaDigest, migrationId: id, contentDigest: _migrations.find(migration => migration.id === id)!.contentDigest, expiresAt: replay.expiresAt, route: "tested-down" as const, rehearsal: "up-down-up-passed" as const })), ...state.restores.filter(item => item.targetId === target.targetId && item.releaseDigest === releaseDigest && item.beforeSchemaDigest === beforeSchemaDigest && Date.parse(item.expiresAt) > Date.now())],
      ...(development ? { development } : {}),
      ...(explanationCurrent ? { explanation: { evidenceId: replay.evidenceId, targetId: target.targetId, releaseDigest, beforeSchemaDigest, expiresAt: replay.expiresAt, assessment: "explained", coverageComplete: true } } : {}),
    };
  }
  async rehearse(key: string, sandboxId: string): Promise<RehearsalResult> {
    return this.change(async () => {
    const sandboxProfile = await this.profile(sandboxId);
    if (sandboxProfile.environment !== "sandbox" || !sandboxProfile.identity) throw new Error("Choose an explicitly enrolled isolated sandbox profile.");
    const release = await this.library.getRelease(key); if (!release) throw new Error("Seal a release before rehearsal.");
    const migrations = await this.releaseMigrations(release);
    const targets = (await this.profiles.list()).filter(profile => profile.databaseKey === key && profile.environment !== "sandbox");
    if (!targets.length || targets.some(profile => !profile.identity)) throw new Error("Inspect and accept all target identities before rehearsal.");
    if ((await this.profiles.list()).some(profile => profile.environment !== "sandbox" && profile.identity?.serverId === sandboxProfile.identity!.serverId)) throw new Error("The sandbox must use a separate server instance from every managed target.");
    this.maintenance = true;
    try {
      let latest: RehearsalResult | undefined;
      const dev = targets.find(profile => profile.environment === "dev");
      const expectedDev = dev ? await this.inspectTarget(dev.id) : undefined;
      for (const profile of targets) {
        const baseline = await this.inspectTarget(profile.id), history = await this.readTargetHistory(profile.id), target = await this.target(profile.id);
        const appliedIds = history.enrolled ? appliedPrefix(history, migrations) : [];
        const config = await this.profiles.getConnection(sandboxId, "migration"), session = await this.connect(config);
        let locked = false;
        try {
          const actual = await readIdentity(session, config.database);
          if (!sameIdentity(actual, sandboxProfile.identity!)) throw new Error("Sandbox identity changed.");
          const [lock] = await session.query("SELECT GET_LOCK(?, 0) AS acquired", [`db-radar-sandbox:${actual.fingerprint.slice(0, 40)}`]);
          if (Number(lock?.acquired) !== 1) throw new Error("The rehearsal sandbox is already in use."); locked = true;
          await this.validateReleaseEngine(session, { ...target, identity: actual });
          const sandbox = await captureSchema(session, actual);
          const replay = await rehearseOnEmptySandbox({ session, sandbox, baseline, targetId: profile.id, databaseKey: key, releaseDigest: release.digest, historyDigest: history.digest, history, migrations, appliedIds, ...(profile.environment === "production" && expectedDev ? { expectedDev } : {}) });
          const fresh = await this.inspectTarget(profile.id);
          if (fresh.digest !== baseline.digest || !sameIdentity(fresh.identity, baseline.identity) || (await this.readTargetHistory(profile.id)).digest !== history.digest) throw new Error("Target schema or history changed during rehearsal.");
          if (profile.environment === "production" && expectedDev && dev && (await this.inspectTarget(dev.id)).digest !== expectedDev.digest) throw new Error("Development changed during production replay.");
          await this.evidence.update(state => { state.replays.push(replay); }); latest = replay;
        } finally { if (locked) try { await session.query("SELECT RELEASE_LOCK(?)", [`db-radar-sandbox:${sandboxProfile.identity!.fingerprint.slice(0, 40)}`]); } catch { /* closing releases the sandbox lock */ } await session.close(); }
      }
      return latest!;
    } finally { this.maintenance = false; }
    });
  }
  async exportLibrary() { return this.library.exportLibrary(); }
  async importLibrary(serialized: string) { await this.change(() => this.library.importLibrary(serialized)); }
  async configureDiagnostics(input: DatabaseDiagnosticSetup) {
    return this.change(async () => {
    if ((await this.profile(input.profileId)).environment !== "dev") throw new Error("Diagnostics require a development profile.");
    const profile = await this.verifyTargetIdentity(input.profileId);
    for (const production of (await this.profiles.list()).filter(item => item.environment === "production")) await this.verifyTargetIdentity(production.id);
    const config = await this.profiles.getConnection(profile.id, "diagnostic"), session = await this.connect(config);
    try { await this.validateTarget(session, await this.target(profile.id)); } finally { await session.close(); }
    const profiles = await this.profiles.list(), root = this.options.root();
    if (profiles.some(item => item.environment === "production" && !item.identity)) throw new Error("Enroll all production identities before enabling the dev diagnostic denylist.");
    if (!root) throw new Error("Choose a repository root before configuring diagnostics.");
    await saveDiagnosticConfig(this.options.directory, this.options.protector, { profile: config, policy: input.policy, deniedIdentities: profiles.filter(item => item.environment === "production" && item.identity).map(item => item.identity!.fingerprint), workspaceRoot: root, repositories: await this.options.repositories() });
    return { instructions: this.options.diagnosticInstructions ?? "Start Repo Radar with --database-mcp. Only the separately saved development diagnostic configuration is loaded." };
    });
  }
  async recordRestoreVerification(profileId: string, sandboxId: string): Promise<{ evidenceIds: string[] }> {
    return this.change(async () => {
    if (!this.options.reviewRestoreRecord) throw new Error("External restore evidence review is unavailable.");
    const target = await this.target(profileId), sandbox = await this.profile(sandboxId);
    if (sandbox.environment !== "sandbox" || !sandbox.identity || (await this.profiles.list()).some(profile => profile.environment !== "sandbox" && profile.identity?.serverId === sandbox.identity!.serverId)) throw new Error("Select a separately enrolled restored sandbox instance.");
    const serialized = await this.options.reviewRestoreRecord();
    if (typeof serialized !== "string" || serialized.length > 256000) throw new Error("Restore evidence review cancelled or oversized.");
    const record = restoreRecordSchema.parse(JSON.parse(serialized));
    const release = await this.library.getRelease(target.databaseKey);
    if (!release || record.releaseDigest !== release.digest || record.targetFingerprint !== target.identity.fingerprint) throw new Error("Restore evidence does not match the enrolled target and sealed release.");
    const now = Date.now(), captured = Date.parse(record.backupCapturedAt), restoredAt = Date.parse(record.restoredAt);
    if (captured > now || restoredAt > now || restoredAt < captured || now - captured > record.acceptedMaxAgeMinutes * 60000) throw new Error("The backup/restore evidence is stale or has invalid times.");
    const actual = await this.inspectTarget(sandboxId);
    if (!actual.coverage.complete || !sameIdentity(actual.identity, sandbox.identity) || actual.digest !== record.restoredSchemaDigest || actual.identity.engine !== target.identity.engine || actual.identity.version !== target.identity.version || JSON.stringify(actual.identity.settings) !== JSON.stringify(target.identity.settings)) throw new Error("The restored sandbox structure or engine does not match the reviewed evidence.");
    const before = await this.inspectTarget(profileId);
    if (!before.coverage.complete || before.digest !== actual.digest) throw new Error("This backup must restore the current complete target baseline before the release is admitted.");
    const proposals = await Promise.all(release.migrations.map(entry => this.library.getProposal(entry.proposalId)));
    const requiredServices = [...new Set(proposals.map(proposal => proposal.manifest.service))];
    if (requiredServices.some(service => !record.affectedServices.includes(service))) throw new Error("Restore evidence must account for every service owning migrations in this shared release.");
    const session = await this.connect(await this.profiles.getConnection(sandboxId, "inspection"));
    try {
      const identity = await readIdentity(session, sandbox.identity.database);
      if (!sameIdentity(identity, sandbox.identity)) throw new Error("Restored sandbox identity changed.");
      const history = await this.readTargetHistory(profileId), migrations = await this.releaseMigrations(release);
      const prefix = history.enrolled ? appliedPrefix(history, migrations) : [];
      const first = proposals.find(proposal => !prefix.includes(proposal.manifest.id));
      if (first) await runChecks(session, checks(first, first.manifest.preconditions));
    } finally { await session.close(); }
    if (await this.options.reviewRestoreRecord(record) !== true) throw new Error("Operator did not confirm the external restore verification.");
    const evidenceIds: string[] = [];
    await this.evidence.update(state => {
      for (const proposal of proposals) {
        const evidenceId = randomUUID(); evidenceIds.push(evidenceId);
        state.restores.push({ evidenceId, targetId: profileId, releaseDigest: release.digest, beforeSchemaDigest: before.digest, migrationId: proposal.manifest.id, contentDigest: proposal.contentDigest, expiresAt: new Date(now + 10 * 60000).toISOString(), route: "tested-restore", rehearsal: "restore-passed", backup: { identity: `${record.backupIdentity} (operator-verified record ${databaseDigest(record)})`, capturedAt: record.backupCapturedAt, available: true, scope: [target.databaseKey], acceptedMaxAgeMs: record.acceptedMaxAgeMinutes * 60000, downtimeLimitMinutes: record.downtimeLimitMinutes, dataLossLimitMinutes: record.dataLossLimitMinutes, affectedServices: record.affectedServices, approvedServices: record.affectedServices } });
      }
    });
    return { evidenceIds };
    });
  }
}
