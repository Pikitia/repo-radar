import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings } from "../src/types/settings.js";
import type { DiffMode } from "../src/types/repo.js";
import type { ScanOptions, RepoRadarApi } from "../src/types/api.js";

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: RepoRadarApi = {
  getSettings: () => invoke("settings:get"),
  updateSettings: (settings: Partial<AppSettings>) => invoke("settings:update", settings),
  chooseRootFolder: () => invoke("dialog:chooseRootFolder"),
  scanRepositories: (options: ScanOptions) => invoke("repo:scan", options),
  refreshRepository: (path: string, fetch?: boolean) => invoke("repo:refresh", path, fetch),
  getDiff: (path: string, file: string, mode: DiffMode) => invoke("repo:diff", path, file, mode),
  getProjectFiles: (path: string) => invoke("repo:projectFiles", path),
  readProjectFile: (path: string, file: string) => invoke("repo:readProjectFile", path, file),
  getCommitPreview: (path: string) => invoke("commit:preview", path),
  stageFiles: (path: string, files: string[]) => invoke("repo:stage", path, files),
  unstageFiles: (path: string, files: string[]) => invoke("repo:unstage", path, files),
  generateCommitMessage: (path: string, files: string[]) => invoke("commit:generateMessage", path, files),
  commit: (path: string, message: string) => invoke("repo:commit", path, message),
  pull: (path: string) => invoke("repo:pull", path),
  push: (path: string) => invoke("repo:push", path),
  sync: (path: string) => invoke("repo:sync", path),
  openVSCode: (path: string) => invoke("open:vscode", path),
  openExplorer: (path: string) => invoke("open:explorer", path),
  openTerminal: (path: string) => invoke("open:terminal", path),
  copyPath: (path: string) => invoke("open:copyPath", path),
  openRemote: (path: string) => invoke("open:remote", path),
  getDebugInfo: () => invoke("debug:info")
};

contextBridge.exposeInMainWorld("repoRadar", api);
