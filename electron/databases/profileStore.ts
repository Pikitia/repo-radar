import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseConnectionConfig, DatabaseCredentialInput, DatabaseCredentialRole, DatabaseCredentials, DatabaseIdentity, DatabaseProfile, DatabaseProfileInput, DatabaseServer, DatabaseServerConnectionConfig, DatabaseServerDetails, DatabaseServerInput } from "../../src/types/database.js";

export interface DatabaseSecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type CredentialSet = Partial<Record<DatabaseCredentialRole, DatabaseCredentials>>;
interface StoredServer extends Omit<DatabaseServerInput, "id"> { id: string; credentials: CredentialSet }
interface StoredProfile extends Omit<DatabaseProfileInput, "id"> { id: string; identity?: DatabaseIdentity }
interface StoredData { version: 2; servers: StoredServer[]; profiles: StoredProfile[] }
interface LegacyProfile extends Omit<StoredProfile, "serverConnectionId"> { host: string; port: number; tlsCa?: string; credentials: CredentialSet }
interface LoadedData { data: StoredData; original?: Buffer }
const roles: DatabaseCredentialRole[] = ["inspection", "migration", "diagnostic"];
const environments = ["dev", "production", "sandbox"];
const limit = 100;
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value); }
function validateServer(input: DatabaseServerInput): void {
  if (!input || (input.id !== undefined && !validId(input.id)) || !bounded(input.label, 160) || !bounded(input.host, 253) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !["disabled", "verify"].includes(input.tlsMode) || (input.tlsCa !== undefined && !bounded(input.tlsCa, 100_000))) throw new Error("Invalid database server connection");
}
function validateProfile(input: DatabaseProfileInput): void {
  if (!input || !bounded(input.databaseKey, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(input.databaseKey) || !bounded(input.label, 160) || !environments.includes(input.environment) || !validId(input.serverConnectionId) || !bounded(input.database, 64) || (input.id !== undefined && !validId(input.id))) throw new Error("Invalid database profile");
}
function validCredentials(value: unknown): value is CredentialSet {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([role, credential]) => roles.includes(role as DatabaseCredentialRole) && !!credential && typeof credential === "object" && bounded(credential.username, 128) && typeof credential.password === "string" && credential.password.length <= 10_000);
}
function validIdentity(identity: DatabaseIdentity, database: string): boolean {
  return !!identity && identity.database === database && bounded(identity.fingerprint, 128) && bounded(identity.serverId, 256) && ["mysql", "mariadb"].includes(identity.engine) && bounded(identity.version, 128) && !!identity.settings && typeof identity.settings.sqlMode === "string" && [0, 1, 2].includes(identity.settings.lowerCaseTableNames) && bounded(identity.settings.characterSet, 128) && bounded(identity.settings.collation, 128);
}
function credentialFlags(server: StoredServer) { return { hasInspectionCredentials: !!server.credentials.inspection, hasMigrationCredentials: !!server.credentials.migration, hasDiagnosticCredentials: !!server.credentials.diagnostic }; }
function safeServer(server: StoredServer): DatabaseServer {
  return { id: server.id, label: server.label, host: server.host, port: server.port, tlsMode: server.tlsMode, ...credentialFlags(server) };
}
function safeProfile(profile: StoredProfile, servers: StoredServer[]): DatabaseProfile {
  const server = servers.find(item => item.id === profile.serverConnectionId);
  if (!server) throw new Error("Database server connection not found");
  return { id: profile.id, databaseKey: profile.databaseKey, label: profile.label, environment: profile.environment, serverConnectionId: profile.serverConnectionId, database: profile.database, ...credentialFlags(server), hasDiagnosticCredentials: profile.environment === "dev" && !!server.credentials.diagnostic, ...(profile.identity ? { identity: structuredClone(profile.identity) } : {}) };
}
function serverConfig(server: StoredServer, role: DatabaseCredentialRole): DatabaseServerConnectionConfig {
  const credentials = server.credentials[role];
  if (!credentials) throw new Error("Database server credentials unavailable");
  return { serverConnectionId: server.id, host: server.host, port: server.port, tlsMode: server.tlsMode, ...(server.tlsCa ? { tlsCa: server.tlsCa } : {}), credentials: structuredClone(credentials) };
}

/** Serialized encrypted storage. Version-1 files remain unchanged until a successful mutation. */
export class DatabaseProfileStore {
  private readonly file: string;
  private readonly backup: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly protector: DatabaseSecretProtector) {
    this.file = path.join(directory, "database-profiles.enc");
    this.backup = path.join(directory, "database-profiles.v1.enc.bak");
  }
  private available(): void { if (!this.protector.isEncryptionAvailable()) throw new Error("Protected database storage is unavailable"); }
  private async read(): Promise<LoadedData> {
    this.available();
    let bytes: Buffer;
    try { bytes = await readFile(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: { version: 2, servers: [], profiles: [] } }; throw new Error("Cannot read protected database profiles"); }
    try {
      const value = JSON.parse(this.protector.decryptString(bytes)) as Record<string, unknown>;
      if (!value || typeof value !== "object" || !Array.isArray(value.profiles) || value.profiles.length > limit) throw new Error();
      const ids = new Set<string>();
      if (value.version === 1) {
        const servers: StoredServer[] = []; const profiles: StoredProfile[] = []; const grouped = new Map<string, string>();
        for (const legacy of value.profiles as LegacyProfile[]) {
          if (!legacy || !validId(legacy.id) || ids.has(legacy.id) || !validCredentials(legacy.credentials) || (legacy.tlsCa !== undefined && !bounded(legacy.tlsCa, 100_000))) throw new Error();
          ids.add(legacy.id);
          const serverInput: DatabaseServerInput = { label: `${legacy.label} server`.slice(0, 160), host: legacy.host, port: legacy.port, tlsMode: legacy.tlsCa ? "verify" : "disabled", ...(legacy.tlsCa ? { tlsCa: legacy.tlsCa } : {}) };
          validateServer(serverInput);
          const groupKey = JSON.stringify([serverInput.host, serverInput.port, serverInput.tlsMode, serverInput.tlsCa ?? null, roles.map(role => legacy.credentials[role] ? [legacy.credentials[role]!.username, legacy.credentials[role]!.password] : null)]);
          let serverConnectionId = grouped.get(groupKey);
          if (!serverConnectionId) {
            // Public IDs must not expose a digest of passwords or credential material.
            serverConnectionId = `legacy-${createHash("sha256").update(legacy.id).digest("hex").slice(0, 40)}`;
            grouped.set(groupKey, serverConnectionId);
            servers.push({ ...serverInput, id: serverConnectionId, credentials: structuredClone(legacy.credentials) });
          }
          const profile: StoredProfile = { id: legacy.id, databaseKey: legacy.databaseKey, label: legacy.label, environment: legacy.environment, serverConnectionId, database: legacy.database, ...(legacy.identity ? { identity: structuredClone(legacy.identity) } : {}) };
          validateProfile(profile);
          if (profile.identity && !validIdentity(profile.identity, profile.database)) throw new Error();
          profiles.push(profile);
        }
        return { data: { version: 2, servers, profiles }, original: bytes };
      }
      if (value.version !== 2 || !Array.isArray(value.servers) || value.servers.length > limit) throw new Error();
      const data = value as unknown as StoredData;
      for (const server of data.servers) {
        validateServer(server);
        if (!validId(server.id) || ids.has(server.id) || !validCredentials(server.credentials)) throw new Error();
        ids.add(server.id);
      }
      const profileIds = new Set<string>();
      for (const profile of data.profiles) {
        validateProfile(profile);
        if (!validId(profile.id) || profileIds.has(profile.id) || !ids.has(profile.serverConnectionId) || (profile.identity && !validIdentity(profile.identity, profile.database))) throw new Error();
        profileIds.add(profile.id);
      }
      return { data };
    } catch { throw new Error("Protected database profiles are corrupt or cannot be decrypted"); }
  }
  private mutate<T>(operation: (data: StoredData) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const { data, original } = await this.read();
      const result = operation(data);
      this.available();
      const encrypted = this.protector.encryptString(JSON.stringify(data));
      await mkdir(this.directory, { recursive: true });
      if (original) {
        try { await writeFile(this.backup, original, { mode: 0o600, flag: "wx" }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(this.backup)).equals(original)) throw new Error("Cannot preserve original protected database profiles");
        }
      }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" }); await rename(temporary, this.file); }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return result;
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
  async list(): Promise<DatabaseProfile[]> { await this.pending; const { data } = await this.read(); return data.profiles.map(profile => safeProfile(profile, data.servers)); }
  async listServers(): Promise<DatabaseServer[]> { await this.pending; return (await this.read()).data.servers.map(safeServer); }
  async getServerDetails(id: string): Promise<DatabaseServerDetails> {
    await this.pending; const server = (await this.read()).data.servers.find(item => item.id === id);
    if (!server) throw new Error("Database server connection not found");
    return { ...safeServer(server), ...(server.tlsCa ? { tlsCa: server.tlsCa } : {}), credentialUsernames: Object.fromEntries(roles.filter(role => server.credentials[role]).map(role => [role, server.credentials[role]!.username])) };
  }
  saveServer(input: DatabaseServerInput): Promise<DatabaseServer> {
    validateServer(input);
    return this.mutate(data => {
      const previous = input.id ? data.servers.find(server => server.id === input.id) : undefined;
      if (input.id && !previous) throw new Error("Database server connection not found");
      if (!previous && data.servers.length >= limit) throw new Error("Database server connection limit reached");
      const endpointChanged = previous && (previous.host !== input.host || previous.port !== input.port);
      const tlsChanged = previous && (previous.tlsMode !== input.tlsMode || previous.tlsCa !== input.tlsCa);
      const server: StoredServer = { id: previous?.id ?? randomUUID(), label: input.label, host: input.host, port: input.port, tlsMode: input.tlsMode, ...(input.tlsCa ? { tlsCa: input.tlsCa } : {}), credentials: previous && !endpointChanged ? previous.credentials : {} };
      if (previous) data.servers[data.servers.indexOf(previous)] = server; else data.servers.push(server);
      if (endpointChanged || tlsChanged) for (const profile of data.profiles) if (profile.serverConnectionId === server.id) delete profile.identity;
      return safeServer(server);
    });
  }
  private saveTargets(data: StoredData, inputs: DatabaseProfileInput[]): DatabaseProfile[] {
    const edited = new Set<string>();
    return inputs.map(input => {
      if (input.id && edited.has(input.id)) throw new Error("Duplicate database profile edit");
      if (input.id) edited.add(input.id);
      if (!data.servers.some(server => server.id === input.serverConnectionId)) throw new Error("Database server connection not found");
      const previous = input.id ? data.profiles.find(profile => profile.id === input.id) : undefined;
      if (input.id && !previous) throw new Error("Database profile not found");
      if (!previous && data.profiles.length >= limit) throw new Error("Database profile limit reached");
      const sameTarget = previous && ["serverConnectionId", "database", "environment", "databaseKey"].every(key => previous[key as keyof StoredProfile] === input[key as keyof DatabaseProfileInput]);
      const profile: StoredProfile = { id: previous?.id ?? randomUUID(), databaseKey: input.databaseKey, label: input.label, environment: input.environment, serverConnectionId: input.serverConnectionId, database: input.database, ...(sameTarget && previous.identity ? { identity: previous.identity } : {}) };
      const caseInsensitive = data.profiles.some(item => item.serverConnectionId === profile.serverConnectionId && (item.identity?.settings.lowerCaseTableNames ?? 0) > 0);
      const duplicate = data.profiles.some(item => item.id !== profile.id && item.serverConnectionId === profile.serverConnectionId && (item.database === profile.database || (caseInsensitive && item.database.toLowerCase() === profile.database.toLowerCase())));
      if (duplicate) throw new Error("Database is already assigned on this server connection");
      if (previous) data.profiles[data.profiles.indexOf(previous)] = profile; else data.profiles.push(profile);
      return safeProfile(profile, data.servers);
    });
  }
  saveProfiles(inputs: DatabaseProfileInput[]): Promise<DatabaseProfile[]> {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > limit) throw new Error("Invalid database profiles");
    inputs.forEach(validateProfile);
    return this.mutate(data => this.saveTargets(data, inputs));
  }
  saveProfile(input: DatabaseProfileInput): Promise<DatabaseProfile> { validateProfile(input); return this.mutate(data => this.saveTargets(data, [input])[0]); }
  private updateCredentials(server: StoredServer, role: DatabaseCredentialRole, input: DatabaseCredentialInput): void {
    const previous = server.credentials[role];
    if (input.password === undefined && (!previous || previous.username !== input.username)) throw new Error("A replacement password is required when changing the username");
    server.credentials[role] = { username: input.username, password: input.password ?? previous!.password };
  }
  private validateCredentialInput(role: DatabaseCredentialRole, input: DatabaseCredentialInput): void {
    if (!roles.includes(role) || !input || !bounded(input.username, 128) || (input.password !== undefined && (typeof input.password !== "string" || input.password.length > 10_000))) throw new Error("Invalid database credentials");
  }
  setServerCredentials(id: string, role: DatabaseCredentialRole, input: DatabaseCredentialInput): Promise<void> {
    this.validateCredentialInput(role, input);
    return this.mutate(data => { const server = data.servers.find(item => item.id === id); if (!server) throw new Error("Database server connection not found"); this.updateCredentials(server, role, input); });
  }
  setCredentials(id: string, role: DatabaseCredentialRole, credentials: DatabaseCredentials): Promise<void> {
    this.validateCredentialInput(role, credentials);
    return this.mutate(data => {
      const profile = data.profiles.find(item => item.id === id);
      if (!profile) throw new Error("Database profile not found");
      if (role === "diagnostic" && profile.environment !== "dev") throw new Error("Diagnostic credentials require a development profile");
      this.updateCredentials(data.servers.find(item => item.id === profile.serverConnectionId)!, role, credentials);
    });
  }
  async getServerConfig(id: string, role: DatabaseCredentialRole): Promise<DatabaseServerConnectionConfig> {
    if (!roles.includes(role)) throw new Error("Invalid credential role");
    await this.pending; const server = (await this.read()).data.servers.find(item => item.id === id);
    if (!server) throw new Error("Database server connection not found");
    return serverConfig(server, role);
  }
  async getConnection(id: string, role: DatabaseCredentialRole): Promise<DatabaseConnectionConfig> {
    if (!roles.includes(role)) throw new Error("Invalid credential role");
    await this.pending; const { data } = await this.read(); const profile = data.profiles.find(item => item.id === id);
    if (!profile) throw new Error("Database profile or credentials unavailable");
    if (role === "diagnostic" && profile.environment !== "dev") throw new Error("Diagnostic access requires a development profile");
    const server = data.servers.find(item => item.id === profile.serverConnectionId)!;
    return { ...serverConfig(server, role), profileId: profile.id, databaseKey: profile.databaseKey, environment: profile.environment, database: profile.database, ...(profile.identity ? { identity: structuredClone(profile.identity) } : {}) };
  }
  enrollIdentity(id: string, identity: DatabaseIdentity): Promise<void> {
    return this.mutate(data => { const profile = data.profiles.find(item => item.id === id); if (!profile) throw new Error("Database profile not found"); if (!validIdentity(identity, profile.database)) throw new Error("Invalid database identity"); profile.identity = structuredClone(identity); });
  }
  deleteProfile(id: string): Promise<void> { return this.mutate(data => { const index = data.profiles.findIndex(item => item.id === id); if (index < 0) throw new Error("Database profile not found"); data.profiles.splice(index, 1); }); }
}
