import { runGit, tryGit } from "./exec.js";
import { getRepositoryStatus } from "./status.js";
import type { AppSettings } from "../../src/types/settings.js";
import { bumpPackageVersionFile } from "./versionBump.js";

export async function stageFiles(repoPath: string, rootPath: string, files: string[]) {
  await runGit(repoPath, ["add", "--", ...files]);
  return getRepositoryStatus(repoPath, rootPath, false);
}

export async function unstageFiles(repoPath: string, rootPath: string, files: string[]) {
  await runGit(repoPath, ["restore", "--staged", "--", ...files]);
  return getRepositoryStatus(repoPath, rootPath, false);
}

export async function bumpPackageVersion(repoPath: string, rootPath: string) {
  const version = await bumpPackageVersionFile(repoPath);
  if (!version) throw new Error("Could not bump package.json version. Ensure the repository has a root package.json with a semver version.");
  await runGit(repoPath, ["add", "--", version.path]);
  return getRepositoryStatus(repoPath, rootPath, false);
}

export async function commit(repoPath: string, rootPath: string, message: string) {
  await runGit(repoPath, ["commit", "-m", message]);
  return getRepositoryStatus(repoPath, rootPath, true);
}

export async function pull(repoPath: string, rootPath: string, settings: AppSettings) {
  await runGit(repoPath, ["fetch", "--prune"], 60000);
  const args = ["pull"];
  if (settings.pullStrategy === "merge") args.push("--no-rebase");
  if (settings.pullStrategy === "rebase") args.push("--rebase");
  await runGit(repoPath, args, 60000);
  return getRepositoryStatus(repoPath, rootPath, true);
}

export async function push(repoPath: string, rootPath: string) {
  await runGit(repoPath, ["push"], 60000);
  return getRepositoryStatus(repoPath, rootPath, true);
}

export async function sync(repoPath: string, rootPath: string, settings: AppSettings) {
  await runGit(repoPath, ["fetch", "--prune"], 60000);
  let status = await getRepositoryStatus(repoPath, rootPath, false);
  if (status.behind > 0) {
    status = await pull(repoPath, rootPath, settings);
    if (status.errors.length > 0) return status;
  }
  status = await getRepositoryStatus(repoPath, rootPath, false);
  if (status.ahead > 0) {
    status = await push(repoPath, rootPath);
  }
  return getRepositoryStatus(repoPath, rootPath, true);
}

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  const result = await tryGit(repoPath, ["remote", "get-url", "--push", "origin"]);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getGitIdentityBlockers(repoPath: string): Promise<string[]> {
  const blockers: string[] = [];
  const name = await tryGit(repoPath, ["config", "user.name"]);
  const email = await tryGit(repoPath, ["config", "user.email"]);
  if (name.code !== 0 || !name.stdout.trim()) blockers.push("Git user.name is not configured.");
  if (email.code !== 0 || !email.stdout.trim()) blockers.push("Git user.email is not configured.");
  return blockers;
}
