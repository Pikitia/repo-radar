/** Service-owned declarations. SQL paths are relative to the manifest directory. */
export interface MigrationCheck {
  path: string;
  expect: "empty" | "nonempty" | "scalar-equals";
  value?: string | number | boolean | null;
}

export interface MigrationManifest {
  formatVersion: 1;
  id: string;
  title: string;
  databaseKey: string;
  service: string;
  dependsOn: string[];
  engine: {
    product: "mysql" | "mariadb";
    minVersion: string;
    maxVersion?: string;
    requiredSettings: Record<string, string | number | boolean>;
    storageEngines: string[];
  };
  up: string[];
  preconditions: MigrationCheck[];
  postconditions: MigrationCheck[];
  recovery: {
    mode: "down" | "forward-fix" | "restore" | "retain-schema";
    down?: string[];
    eligibilityChecks: MigrationCheck[];
    runbook: string;
    applicationCompatibility: string;
    rollbackRoute: "tested-down" | "tested-restore";
  };
  dataImpact: {
    description: string;
    destructive: boolean;
    requiresWritePause: boolean;
    locking: string;
  };
  applicationCompatibility: string;
  expectedSchemaChanges: { objectType: string; objectPath: string; description: string }[];
}

export interface MigrationProposal {
  proposalId: string;
  manifest: MigrationManifest;
  contentDigest: string;
  /** Exact UTF-8 bytes represented as text; keys match the manifest paths. */
  files: Record<string, string>;
  source: {
    repositoryPath: string;
    manifestRelativePath: string;
    commit: string | null;
    dirty: boolean;
  };
  status: "draft" | "sealed";
  importedAt: string;
  /** Local validity never grants execution approval or target-bound recovery evidence. */
  validationWarnings: string[];
}

export interface MigrationRelease {
  formatVersion: 1;
  databaseKey: string;
  releaseId: string;
  parentReleaseDigest: string | null;
  digest: string;
  migrations: { sequence: number; id: string; contentDigest: string; proposalId: string }[];
}
