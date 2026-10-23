export type DatabaseEnvironment = "dev" | "production" | "sandbox";
export type DatabaseCredentialRole = "inspection" | "migration" | "diagnostic";
export interface DatabaseCredentials { username: string; password: string }
export type DatabaseTlsMode = "disabled" | "verify";
export interface DatabaseCredentialInput { username: string; password?: string }
export interface DatabaseServerInput {
  id?: string;
  label: string;
  host: string;
  port: number;
  tlsMode: DatabaseTlsMode;
  tlsCa?: string;
}
export interface DatabaseServer extends Omit<DatabaseServerInput, "id" | "tlsCa"> {
  id: string;
  hasInspectionCredentials: boolean;
  hasMigrationCredentials: boolean;
  hasDiagnosticCredentials: boolean;
}
/** Passwords are write-only; usernames and connection settings can be edited. */
export interface DatabaseServerDetails extends DatabaseServer {
  tlsCa?: string;
  credentialUsernames: Partial<Record<DatabaseCredentialRole, string>>;
}
export interface DatabaseServerConnectionConfig {
  serverConnectionId: string;
  host: string;
  port: number;
  tlsMode?: DatabaseTlsMode;
  tlsCa?: string;
  credentials: DatabaseCredentials;
}
export interface DiscoveredDatabase { database: string; assigned: boolean; profileIds: string[] }
export interface DatabaseDiscovery { serverConnectionId: string; databases: DiscoveredDatabase[] }
export interface DatabaseProfileInput {
  id?: string;
  databaseKey: string;
  label: string;
  environment: DatabaseEnvironment;
  serverConnectionId: string;
  database: string;
}
export interface DatabaseIdentity {
  serverId: string;
  database: string;
  engine: "mysql" | "mariadb";
  version: string;
  settings: { sqlMode: string; lowerCaseTableNames: number; characterSet: string; collation: string };
  fingerprint: string;
}
/** Renderer-safe target. Passwords remain in the main process. */
export interface DatabaseProfile {
  id: string;
  databaseKey: string;
  label: string;
  environment: DatabaseEnvironment;
  serverConnectionId: string;
  database: string;
  hasInspectionCredentials: boolean;
  hasMigrationCredentials: boolean;
  hasDiagnosticCredentials: boolean;
  identity?: DatabaseIdentity;
}
export interface DatabaseConnectionConfig {
  profileId: string;
  databaseKey: string;
  environment: DatabaseEnvironment;
  host: string;
  port: number;
  database: string;
  tlsCa?: string;
  tlsMode?: DatabaseTlsMode;
  serverConnectionId?: string;
  credentials: DatabaseCredentials;
  identity?: DatabaseIdentity;
}
export interface SchemaObject { objectType: "table" | "column" | "index" | "foreign-key" | "view" | "routine" | "trigger"; objectPath: string; definition: string }
export interface SchemaCoverage { complete: boolean; limitations: string[]; excludedObjectPrefixes?: string[] }
export interface SchemaSnapshot { identity: DatabaseIdentity; capturedAt: string; digest: string; objects: SchemaObject[]; coverage: SchemaCoverage }
export interface SchemaDifference {
  objectType: SchemaObject["objectType"];
  objectPath: string;
  devDefinition: string | null;
  productionDefinition: string | null;
  assessment: "explained" | "unexplained" | "unverified";
  migrationIds: string[];
  reason: string;
}
export interface SchemaComparison {
  tableStorageEngines?: { tableName: string; development: string | null; production: string | null }[];
  engines?: {
    development: Pick<DatabaseIdentity, "engine" | "version">;
    production: Pick<DatabaseIdentity, "engine" | "version">;
  };
  assessment: "explained" | "unexplained" | "unverified";
  capturedAt: string;
  devSchemaDigest: string;
  productionSchemaDigest: string;
  differences: SchemaDifference[];
  coverage: SchemaCoverage;
}
