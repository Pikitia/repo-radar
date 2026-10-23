import type { DatabaseCredentialRole, DatabaseCredentials, DatabaseCredentialInput, DatabaseServer, DatabaseServerInput, DatabaseServerDetails, DatabaseDiscovery, DatabaseProfile, DatabaseProfileInput, SchemaComparison, SchemaSnapshot } from "./database.js";
import type { MigrationProposal, MigrationRelease } from "./migration.js";
import type { DatabaseHistory, MigrationPlan, MigrationRunResult } from "./databaseExecution.js";

export interface RehearsalResult {
  evidenceId: string;
  databaseKey: string;
  releaseDigest: string;
  createdAt: string;
  expiresAt: string;
  assessment: "explained" | "unexplained" | "unverified";
  notes: string[];
  migrationIds: string[];
}
export interface DatabaseOverview {
  submissionErrors?: { proposalId: string; message: string }[];
  profiles: DatabaseProfile[];
  servers: DatabaseServer[];
  proposals: MigrationProposal[];
  releases: MigrationRelease[];
  rehearsals: RehearsalResult[];
  activeRun: { planId: string; targetId: string; message: string } | null;
  lastRun: MigrationRunResult | null;
}
export interface DatabasePlanInput {
  profileId: string;
  kind: "enroll" | "adopt" | "execute";
  direction: "up" | "down";
  migrationIds: string[];
}
export interface DevDataPolicy {
  tables: Record<string, string[]>;
}
export interface DatabaseDiagnosticSetup {
  profileId: string;
  policy: DevDataPolicy;
}
/** Every operation is implemented by validated main-process handlers. No raw SQL API. */
export interface DatabaseTargetVerification {
  profileId: string;
  status: "verified" | "failed";
  message?: string;
}
export interface DatabaseDesktopApi {
  verifyTargets(profileIds: string[]): Promise<DatabaseTargetVerification[]>;
  overview(): Promise<DatabaseOverview>;
  saveServerConnection(server: DatabaseServerInput): Promise<DatabaseServer>;
  getServerConnection(serverConnectionId: string): Promise<DatabaseServerDetails>;
  saveServerCredentials(serverConnectionId: string, role: DatabaseCredentialRole, credentials: DatabaseCredentialInput): Promise<void>;
  discoverDatabases(serverConnectionId: string): Promise<DatabaseDiscovery>;
  assignDatabases(serverConnectionId: string, profiles: DatabaseProfileInput[]): Promise<DatabaseProfile[]>;
  saveProfile(profile: DatabaseProfileInput): Promise<DatabaseProfile>;
  saveCredentials(profileId: string, role: DatabaseCredentialRole, credentials: DatabaseCredentials): Promise<void>;
  inspect(profileId: string): Promise<SchemaSnapshot>;
  acceptIdentity(profileId: string, fingerprint: string): Promise<void>;
  compare(databaseKey: string): Promise<SchemaComparison>;
  importProposal(repositoryPath: string, manifestPath: string): Promise<MigrationProposal>;
  sealRelease(databaseKey: string): Promise<MigrationRelease>;
  history(profileId: string): Promise<DatabaseHistory>;
  createPlan(input: DatabasePlanInput): Promise<MigrationPlan>;
  runPlan(planId: string): Promise<MigrationRunResult>;
  rehearse(databaseKey: string, sandboxProfileId: string): Promise<RehearsalResult>;
  exportLibrary(): Promise<string>;
  importLibrary(serialized: string): Promise<void>;
  configureDiagnostics(input: DatabaseDiagnosticSetup): Promise<{ instructions: string }>;
  recordRestoreVerification(profileId: string, restoredSandboxProfileId: string): Promise<{ evidenceIds: string[] }>;
}
