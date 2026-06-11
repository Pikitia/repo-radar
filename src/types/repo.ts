export type GitIssue = {
  code: string;
  message: string;
  detail?: string;
};

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "unknown";

export type ChangedFile = {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
};

export type AheadCommit = {
  hash: string;
  subject: string;
  author: string;
  date: string;
  files: string[];
};

export type BranchComparisonCommit = {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
};

export type BranchComparison = {
  developRef: string;
  mainRef: string;
  developVersion: string | null;
  mainVersion: string | null;
  developBehindMain: number;
  developAheadMain: number;
  commitsInDevelopNotMain: BranchComparisonCommit[];
};

export type ProjectFile = {
  path: string;
  displayName: string;
  kind: "markdown" | "text";
};

export type GitHubActionFailedStep = {
  name: string;
  conclusion: string | null;
  number: number;
};

export type GitHubActionFailedJob = {
  name: string;
  conclusion: string | null;
  htmlUrl: string;
  steps: GitHubActionFailedStep[];
};

export type GitHubActionsStatus = {
  repository: string;
  branch: string | null;
  status: string | null;
  conclusion: string | null;
  workflowName: string;
  runName: string;
  runNumber: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  failedJobs: GitHubActionFailedJob[];
  error?: string;
};

export type RepoStatus = {
  id: string;
  name: string;
  absolutePath: string;
  relativePath: string;
  parentGroup: string;
  branch: string | null;
  upstream: string | null;
  isDetachedHead: boolean;
  hasUnstagedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedFiles: boolean;
  ahead: number;
  behind: number;
  conflicts: string[];
  files: ChangedFile[];
  aheadCommits: AheadCommit[];
  branchComparison?: BranchComparison | null;
  branchComparisonLoaded?: boolean;
  branchComparisonLoading?: boolean;
  statusLoading?: boolean;
  projectFiles: ProjectFile[];
  githubActions?: GitHubActionsStatus | null;
  warnings: GitIssue[];
  errors: GitIssue[];
  lastFetchedAt?: string;
};

export type RepoFilter = "all" | "changed" | "clean" | "ahead" | "behind" | "diverged" | "errors";

export type DiffMode = "working" | "staged" | "untracked";

export type DiffResult = {
  file: string;
  mode: DiffMode | "commit";
  text: string;
  isBinary: boolean;
  error?: string;
};

export type CommitBlocker = {
  code: string;
  message: string;
};

export type ActionAvailability = {
  commit: boolean;
  pull: boolean;
  push: boolean;
  sync: boolean;
  reasons: Record<"commit" | "pull" | "push" | "sync", string | null>;
};
