import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffMode, RepoStatus } from "../src/types/repo.js";
import type { ScanOptions } from "../src/types/api.js";
import { getSettings, updateSettings } from "./settings.js";
import { discoverRepositories } from "./git/discovery.js";
import { getRepositoryStatus } from "./git/status.js";
import { getCommitDiff, getDiff } from "./git/diff.js";
import { getProjectFiles, readProjectFile } from "./git/projectFiles.js";
import { bumpPackageVersion, commit, getGitIdentityBlockers, getRemoteUrl, pull, push, stageFiles, sync, unstageFiles } from "./git/actions.js";
import { createCommitProvider } from "./aiCommit.js";
import { tryGit } from "./git/exec.js";
import { getPackageVersionInfo } from "./git/versionBump.js";
import { getBranchComparison } from "./git/branchComparison.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.VITE_DEV_SERVER_URL !== undefined || !app.isPackaged;

if (process.env.REPO_RADAR_USER_DATA) {
  app.setPath("userData", process.env.REPO_RADAR_USER_DATA);
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "Repo Radar",
    icon: path.join(app.getAppPath(), "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

function rootFolder(): string {
  const settings = getSettings();
  return settings.rootFolder || process.cwd();
}

function launchDetached(command: string, args: string[], options: { cwd?: string; windowsHide?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: options.windowsHide ?? true,
        shell: false
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", reject);
    child.once("spawn", () => {
      child.removeListener("error", reject);
      child.unref();
      resolve();
    });
  });
}

function toVSCodeFileUri(repoPath: string): string {
  const normalized = path.resolve(repoPath).replaceAll("\\", "/");
  return `vscode://file/${encodeURI(normalized)}`;
}

function assertHttpUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP(S) URLs can be opened.");
  }
  return parsed.toString();
}

async function openVSCode(repoPath: string): Promise<void> {
  const uriErrors: string[] = [];
  try {
    await shell.openExternal(toVSCodeFileUri(repoPath));
    return;
  } catch (error) {
    uriErrors.push(error instanceof Error ? error.message : String(error));
  }

  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    "code.cmd",
    "code.exe",
    "code",
    localAppData ? path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe") : null,
    programFiles ? path.join(programFiles, "Microsoft VS Code", "Code.exe") : null,
    programFilesX86 ? path.join(programFilesX86, "Microsoft VS Code", "Code.exe") : null
  ].filter((candidate): candidate is string => Boolean(candidate));

  const errors: string[] = [];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) {
      errors.push(`${candidate}: not found`);
      continue;
    }
    try {
      await launchDetached(candidate, [repoPath]);
      return;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Could not open VS Code. The vscode:// protocol failed (${uriErrors.join("; ")}). Install the VS Code command line launcher or add it to PATH. Tried: ${errors.join("; ")}`);
}

async function scan(options: ScanOptions): Promise<RepoStatus[]> {
  const repos = await discoverRepositories(options.root, options.includeNestedRepositories);
  const statuses = await Promise.all(
    repos.map(async (repo) => {
      try {
        return await getRepositoryStatus(repo, options.root, options.fetch);
      } catch (error) {
        const relative = path.relative(options.root, repo) || path.basename(repo);
        return {
          id: path.resolve(repo).toLowerCase(),
          name: path.basename(repo),
          absolutePath: repo,
          relativePath: relative.replaceAll("\\", "/"),
          parentGroup: path.dirname(relative).replaceAll("\\", "/"),
          branch: null,
          upstream: null,
          isDetachedHead: false,
          hasUnstagedChanges: false,
          hasStagedChanges: false,
          hasUntrackedFiles: false,
          ahead: 0,
          behind: 0,
          conflicts: [],
          files: [],
          aheadCommits: [],
          branchComparison: null,
          branchComparisonLoaded: false,
          branchComparisonLoading: false,
          statusLoading: false,
          projectFiles: [],
          warnings: [],
          errors: [{ code: "status-failed", message: "Could not read repository status.", detail: error instanceof Error ? error.message : String(error) }]
        };
      }
    })
  );
  return statuses.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function discoverRepoShells(root: string, includeNestedRepositories: boolean): Promise<RepoStatus[]> {
  const repos = await discoverRepositories(root, includeNestedRepositories);
  return repos.map((repo) => {
    const relative = path.relative(root, repo) || path.basename(repo);
    const parent = path.dirname(relative);
    return {
      id: path.resolve(repo).toLowerCase(),
      name: path.basename(repo),
      absolutePath: path.resolve(repo),
      relativePath: relative.replaceAll("\\", "/"),
      parentGroup: parent === "." ? "/" : parent.replaceAll("\\", "/"),
      branch: null,
      upstream: null,
      isDetachedHead: false,
      hasUnstagedChanges: false,
      hasStagedChanges: false,
      hasUntrackedFiles: false,
      ahead: 0,
      behind: 0,
      conflicts: [],
      files: [],
      aheadCommits: [],
      branchComparison: undefined,
      branchComparisonLoaded: false,
      branchComparisonLoading: false,
      statusLoading: true,
      projectFiles: [],
      githubActions: null,
      warnings: [],
      errors: []
    };
  });
}

function registerIpc() {
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:update", (_event, settings) => updateSettings(settings));
  ipcMain.handle("dialog:chooseRootFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("repo:scan", (_event, options: ScanOptions) => scan(options));
  ipcMain.handle("repo:discover", (_event, options: Omit<ScanOptions, "fetch">) => discoverRepoShells(options.root, options.includeNestedRepositories));
  ipcMain.handle("repo:refresh", (_event, repoPath: string, fetch = true) => getRepositoryStatus(repoPath, rootFolder(), fetch));
  ipcMain.handle("repo:branchComparison", (_event, repoPath: string) => getBranchComparison(repoPath));
  ipcMain.handle("repo:diff", (_event, repoPath: string, file: string, mode: DiffMode) => getDiff(repoPath, file, mode));
  ipcMain.handle("repo:commitDiff", (_event, repoPath: string, hash: string) => getCommitDiff(repoPath, hash));
  ipcMain.handle("repo:projectFiles", (_event, repoPath: string) => getProjectFiles(repoPath));
  ipcMain.handle("repo:readProjectFile", (_event, repoPath: string, file: string) => readProjectFile(repoPath, file));
  ipcMain.handle("repo:stage", (_event, repoPath: string, files: string[]) => stageFiles(repoPath, rootFolder(), files));
  ipcMain.handle("repo:unstage", (_event, repoPath: string, files: string[]) => unstageFiles(repoPath, rootFolder(), files));
  ipcMain.handle("repo:bumpPackageVersion", (_event, repoPath: string) => bumpPackageVersion(repoPath, rootFolder()));
  ipcMain.handle("repo:commit", (_event, repoPath: string, message: string) => commit(repoPath, rootFolder(), message));
  ipcMain.handle("repo:pull", (_event, repoPath: string) => pull(repoPath, rootFolder(), getSettings()));
  ipcMain.handle("repo:push", (_event, repoPath: string) => push(repoPath, rootFolder()));
  ipcMain.handle("repo:sync", (_event, repoPath: string) => sync(repoPath, rootFolder(), getSettings()));
  ipcMain.handle("commit:preview", async (_event, repoPath: string) => {
    const status = await getRepositoryStatus(repoPath, rootFolder(), false);
    const identityBlockers = await getGitIdentityBlockers(repoPath);
    const provider = createCommitProvider(getSettings());
    return {
      blockers: [
        ...status.errors.map((issue) => ({ code: issue.code, message: issue.message })),
        ...identityBlockers.map((message) => ({ code: "git-identity", message }))
      ],
      staged: status.files.filter((file) => file.staged).map((file) => file.path),
      unstaged: status.files.filter((file) => file.unstaged).map((file) => file.path),
      untracked: status.files.filter((file) => file.untracked).map((file) => file.path),
      aiAvailable: await provider.isAvailable(),
      packageVersion: await getPackageVersionInfo(repoPath)
    };
  });
  ipcMain.handle("commit:generateMessage", async (_event, repoPath: string, files: string[]) => {
    const provider = createCommitProvider(getSettings());
    return provider.generate({ repoPath, files });
  });
  ipcMain.handle("open:vscode", (_event, repoPath: string) => openVSCode(repoPath));
  ipcMain.handle("open:explorer", (_event, repoPath: string) => shell.openPath(repoPath));
  ipcMain.handle("open:terminal", (_event, repoPath: string) => launchDetached("cmd.exe", ["/K", "cd", "/d", repoPath], { windowsHide: false }));
  ipcMain.handle("open:copyPath", (_event, repoPath: string) => clipboard.writeText(repoPath));
  ipcMain.handle("open:remote", async (_event, repoPath: string) => {
    const remote = await getRemoteUrl(repoPath);
    if (!remote) throw new Error("No origin remote URL is configured.");
    const httpsUrl = remote.startsWith("git@")
      ? remote.replace(/^git@([^:]+):(.+?)(\.git)?$/, "https://$1/$2")
      : remote.replace(/\.git$/, "");
    await shell.openExternal(httpsUrl);
  });
  ipcMain.handle("open:external", (_event, url: string) => shell.openExternal(assertHttpUrl(url)));
  ipcMain.handle("debug:info", async () => {
    const version = await tryGit(process.cwd(), ["--version"]);
    const pathResult = await tryGit(process.cwd(), ["--exec-path"]);
    return { gitPath: pathResult.stdout.trim() || "git", version: version.stdout.trim() };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
