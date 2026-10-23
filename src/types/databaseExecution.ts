import type { DatabaseIdentity } from './database.js';

export interface RunnerTarget {
  targetId: string;
  databaseKey: string;
  environment: 'dev' | 'production';
  identity: DatabaseIdentity;
}

export interface RunnerCheck {
  sql: string;
  expect: 'empty' | 'nonempty' | 'scalar-equals' | 'row-count';
  value?: string | number | boolean | null;
}

export interface RunnerMigration {
  id: string;
  sequence: number;
  contentDigest: string;
  upSql: string[];
  downSql: string[];
  preconditions: RunnerCheck[];
  postconditions: RunnerCheck[];
  eligibilityChecks: RunnerCheck[];
  transactional: boolean;
  recoveryRoute: 'tested-down' | 'tested-restore';
  conditionalDown?: boolean;
}

export interface FrozenSqlStatement {
  ordinal: number;
  sql: string;
  digest: string;
  kind: 'ddl' | 'dml' | 'check';
}

export interface RunnerInspection {
  identity: DatabaseIdentity;
  identityFingerprint: string;
  schemaDigest: string;
  coverageComplete: boolean;
}

/** Main-process evidence. Never accepted from an IPC or renderer payload. */
export interface RecoveryEvidence {
  evidenceId: string;
  targetId: string;
  releaseDigest: string;
  beforeSchemaDigest: string;
  migrationId: string;
  contentDigest: string;
  expiresAt: string;
  route: 'tested-down' | 'tested-restore';
  rehearsal: 'up-down-up-passed' | 'restore-passed';
  backup?: {
    identity: string;
    capturedAt: string;
    available: boolean;
    scope: string[];
    acceptedMaxAgeMs: number;
    downtimeLimitMinutes: number;
    dataLossLimitMinutes: number;
    affectedServices: string[];
    approvedServices: string[];
  };
}

export interface AdmissionEvidence {
  recovery: RecoveryEvidence[];
  /** Schema at the end of each selected migration in this direction, from isolated replay. */
  expectedSchemaDigests: Record<string, string>;
  development?: { evidenceId: string; releaseDigest: string; migrations: { id: string; contentDigest: string }[] };
  explanation?: {
    evidenceId: string;
    targetId: string;
    releaseDigest: string;
    beforeSchemaDigest: string;
    expiresAt: string;
    assessment: 'explained';
    coverageComplete: boolean;
  };
}

export interface MigrationPlanRequest {
  target: RunnerTarget;
  releaseDigest: string;
  /** Entire immutable release, including previously applied migrations. */
  migrations: RunnerMigration[];
  direction: 'up' | 'down';
  migrationIds: string[];
  kind: 'execute' | 'enroll' | 'adopt';
  baselineDigest?: string;
}

export interface MigrationPlan {
  /** Built by the privileged service from immutable scripts and target-bound evidence. */
  reviewSummary?: string;
  planId: string;
  targetId: string;
  environment: 'dev' | 'production';
  releaseDigest: string;
  migrationIds: string[];
  direction: 'up' | 'down';
  kind: 'execute' | 'enroll' | 'adopt';
  historyDigest: string;
  beforeSchemaDigest: string;
  expiresAt: string;
  recoveryEvidenceIds: string[];
  rehearsalEvidenceId?: string;
  statementCount: number;
}

export type AttemptState = 'running' | 'succeeded' | 'failed' | 'uncertain';

export interface HistoryEvent {
  eventId: number;
  kind: 'adoption' | 'attempt-start' | 'statement-intent' | 'statement-outcome' | 'attempt-end';
  at: string;
  attemptId?: string;
  migrationId?: string;
  contentDigest?: string;
  sequence?: number;
  direction?: 'up' | 'down';
  targetId?: string;
  releaseDigest?: string;
  state?: AttemptState;
  ordinal?: number;
  statementDigest?: string;
  schemaDigest?: string;
  operator?: string;
  /** Fixed codes only; SQL, data, credentials and raw driver errors are excluded. */
  errorCode?: string;
}

export interface DatabaseHistory {
  enrolled: boolean;
  identityFingerprint?: string;
  baselineDigest?: string;
  events: HistoryEvent[];
  digest: string;
}

export interface MigrationRunResult {
  planId: string;
  state: 'succeeded' | 'failed' | 'uncertain';
  attemptIds: string[];
  errorCode?: string;
}
