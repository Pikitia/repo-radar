import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { AppSettings } from "../src/types/settings.js";
import type { CiWatchInput } from "../src/types/ci.js";
import type { DiffMode } from "../src/types/repo.js";
import type { NpmCommandEvent, NpmScriptCommand, ScanOptions, RepoRadarApi } from "../src/types/api.js";

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: RepoRadarApi = {
  databases: {
    setMcpReadAccess: (input) => invoke("db:setMcpReadAccess", input),
    checkServerConnection: (id, role) => invoke("db:checkServerConnection", id, role),
    verifyTargets: (ids) => invoke("db:verifyTargets", ids),
    overview: () => invoke("db:overview"),
    saveServerConnection: (server) => invoke("db:saveServerConnection", server),
    getServerConnection: (id) => invoke("db:getServerConnection", id),
    saveServerCredentials: (id, role, credentials) => invoke("db:saveServerCredentials", id, role, credentials),
    discoverDatabases: (id) => invoke("db:discoverDatabases", id),
    assignDatabases: (id, profiles) => invoke("db:assignDatabases", id, profiles),
    saveProfile: (profile) => invoke("db:saveProfile", profile),
    saveCredentials: (profileId, role, credentials) => invoke("db:saveCredentials", profileId, role, credentials),
    inspect: (profileId) => invoke("db:inspect", profileId),
    acceptIdentity: (profileId, fingerprint) => invoke("db:acceptIdentity", profileId, fingerprint),
    compare: (databaseKey) => invoke("db:compare", databaseKey),
    importProposal: (repositoryPath, manifestPath) => invoke("db:importProposal", repositoryPath, manifestPath),
    sealRelease: (databaseKey) => invoke("db:sealRelease", databaseKey),
    history: (profileId) => invoke("db:history", profileId),
    createPlan: (input) => invoke("db:createPlan", input),
    runPlan: (planId) => invoke("db:runPlan", planId),
    rehearse: (databaseKey, sandboxProfileId) => invoke("db:rehearse", databaseKey, sandboxProfileId),
    exportLibrary: () => invoke("db:exportLibrary"),
    importLibrary: (serialized) => invoke("db:importLibrary", serialized),
    configureDiagnostics: (input) => invoke("db:configureDiagnostics", input),
    recordRestoreVerification: (profileId, sandboxId) => invoke("db:recordRestoreVerification", profileId, sandboxId),
  },
  getSettings: () => invoke("settings:get"),
  getDatabaseMcpStatus: () => invoke("database-mcp:status"),
  copyDatabaseMcpConfig: () => invoke("database-mcp:copyConfig"),
  updateSettings: (settings: Partial<AppSettings>) => invoke("settings:update", settings),
  chooseRootFolder: () => invoke("dialog:chooseRootFolder"),
  discoverRepositories: (options: Omit<ScanOptions, "fetch">) => invoke("repo:discover", options),
  scanRepositories: (options: ScanOptions) => invoke("repo:scan", options),
  refreshRepository: (path: string, fetch?: boolean) => invoke("repo:refresh", path, fetch),
  getBranchComparison: (path: string) => invoke("repo:branchComparison", path),
  getDevelopPullRequestPreview: (path: string) => invoke("repo:developPullRequestPreview", path),
  promoteDevelop: (path, expected) => invoke("repo:promoteDevelop", path, expected),
  addCiWatch: (watch: CiWatchInput) => invoke("ci:addWatch", watch),
  removeCiWatch: (id: string) => invoke("ci:removeWatch", id),
  getCiWorkflows: (path: string) => invoke("ci:workflows", path),
  getCiRun: (path: string, branch: string, workflowId?: number) => invoke("ci:run", path, branch, workflowId),
  getCiJobs: (path: string, runId: number, attempt: number) => invoke("ci:jobs", path, runId, attempt),
  getDiff: (path: string, file: string, mode: DiffMode) => invoke("repo:diff", path, file, mode),
  getCommitDiff: (path: string, hash: string) => invoke("repo:commitDiff", path, hash),
  getProjectFiles: (path: string) => invoke("repo:projectFiles", path),
  readProjectFile: (path: string, file: string) => invoke("repo:readProjectFile", path, file),
  getCommitPreview: (path: string) => invoke("commit:preview", path),
  stageFiles: (path: string, files: string[]) => invoke("repo:stage", path, files),
  unstageFiles: (path: string, files: string[]) => invoke("repo:unstage", path, files),
  bumpPackageVersion: (path: string) => invoke("repo:bumpPackageVersion", path),
  generateCommitMessage: (path: string, files: string[]) => invoke("commit:generateMessage", path, files),
  commit: (path: string, message: string) => invoke("repo:commit", path, message),
  pull: (path: string) => invoke("repo:pull", path),
  push: (path: string) => invoke("repo:push", path),
  sync: (path: string) => invoke("repo:sync", path),
  getNpmVerifyScript: (path: string) => invoke<NpmScriptCommand | null>("repo:npmVerifyScript", path),
  startNpmCommand: (path: string, runId: string, command: "update" | NpmScriptCommand) => invoke("repo:npmCommand", path, runId, command),
  onNpmCommandEvent: (callback: (event: NpmCommandEvent) => void) => {
    const listener = (_event: IpcRendererEvent, commandEvent: NpmCommandEvent) => callback(commandEvent);
    ipcRenderer.on("repo:npmCommand:event", listener);
    return () => ipcRenderer.off("repo:npmCommand:event", listener);
  },
  openVSCode: (path: string) => invoke("open:vscode", path),
  openExplorer: (path: string) => invoke("open:explorer", path),
  openTerminal: (path: string) => invoke("open:terminal", path),
  copyPath: (path: string) => invoke("open:copyPath", path),
  openRemote: (path: string) => invoke("open:remote", path),
  openExternal: (url: string) => invoke("open:external", url),
  getDebugInfo: () => invoke("debug:info")
};

contextBridge.exposeInMainWorld("repoRadar", api);
