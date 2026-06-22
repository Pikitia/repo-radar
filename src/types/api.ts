import type { AppSettings } from "./settings.js";
import type { BranchComparison, DiffMode, DiffResult, RepoStatus, ProjectFile } from "./repo.js";

export type ScanOptions = {
  root: string;
  includeNestedRepositories: boolean;
  fetch: boolean;
};

export type CommitPreview = {
  blockers: { code: string; message: string }[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
  aiAvailable: boolean;
  packageVersion: { path: string; current: string; next: string } | null;
};

export type NpmScriptCommand = "verify" | "test";

export type NpmCommandEvent =
  | {
      runId: string;
      repoPath: string;
      type: "output";
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      runId: string;
      repoPath: string;
      type: "complete";
      command: "update" | NpmScriptCommand;
      displayCommand: string;
      exitCode: number | null;
      error?: string;
    };

export type RepoRadarApi = {
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  chooseRootFolder(): Promise<string | null>;
  discoverRepositories(options: Omit<ScanOptions, "fetch">): Promise<RepoStatus[]>;
  scanRepositories(options: ScanOptions): Promise<RepoStatus[]>;
  refreshRepository(path: string, fetch?: boolean): Promise<RepoStatus>;
  getBranchComparison(path: string): Promise<BranchComparison | null>;
  getDiff(path: string, file: string, mode: DiffMode): Promise<DiffResult>;
  getCommitDiff(path: string, hash: string): Promise<DiffResult>;
  getProjectFiles(path: string): Promise<ProjectFile[]>;
  readProjectFile(path: string, file: string): Promise<string>;
  getCommitPreview(path: string): Promise<CommitPreview>;
  stageFiles(path: string, files: string[]): Promise<RepoStatus>;
  unstageFiles(path: string, files: string[]): Promise<RepoStatus>;
  bumpPackageVersion(path: string): Promise<RepoStatus>;
  generateCommitMessage(path: string, files: string[]): Promise<string>;
  commit(path: string, message: string): Promise<RepoStatus>;
  pull(path: string): Promise<RepoStatus>;
  push(path: string): Promise<RepoStatus>;
  sync(path: string): Promise<RepoStatus>;
  getNpmVerifyScript(path: string): Promise<NpmScriptCommand | null>;
  startNpmCommand(path: string, runId: string, command: "update" | NpmScriptCommand): Promise<void>;
  onNpmCommandEvent(callback: (event: NpmCommandEvent) => void): () => void;
  openVSCode(path: string): Promise<void>;
  openExplorer(path: string): Promise<void>;
  openTerminal(path: string): Promise<void>;
  copyPath(path: string): Promise<void>;
  openRemote(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  getDebugInfo(): Promise<{ gitPath: string; version: string }>;
};

declare global {
  interface Window {
    repoRadar: RepoRadarApi;
  }
}
