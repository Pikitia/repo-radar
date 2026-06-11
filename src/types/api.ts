import type { AppSettings } from "./settings.js";
import type { DiffMode, DiffResult, RepoStatus, ProjectFile } from "./repo.js";

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
};

export type RepoRadarApi = {
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  chooseRootFolder(): Promise<string | null>;
  scanRepositories(options: ScanOptions): Promise<RepoStatus[]>;
  refreshRepository(path: string, fetch?: boolean): Promise<RepoStatus>;
  getDiff(path: string, file: string, mode: DiffMode): Promise<DiffResult>;
  getProjectFiles(path: string): Promise<ProjectFile[]>;
  readProjectFile(path: string, file: string): Promise<string>;
  getCommitPreview(path: string): Promise<CommitPreview>;
  stageFiles(path: string, files: string[]): Promise<RepoStatus>;
  unstageFiles(path: string, files: string[]): Promise<RepoStatus>;
  generateCommitMessage(path: string, files: string[]): Promise<string>;
  commit(path: string, message: string): Promise<RepoStatus>;
  pull(path: string): Promise<RepoStatus>;
  push(path: string): Promise<RepoStatus>;
  sync(path: string): Promise<RepoStatus>;
  openVSCode(path: string): Promise<void>;
  openExplorer(path: string): Promise<void>;
  openTerminal(path: string): Promise<void>;
  copyPath(path: string): Promise<void>;
  openRemote(path: string): Promise<void>;
  getDebugInfo(): Promise<{ gitPath: string; version: string }>;
};

declare global {
  interface Window {
    repoRadar: RepoRadarApi;
  }
}
