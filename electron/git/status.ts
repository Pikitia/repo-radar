import { promises as fs } from "node:fs";
import path from "node:path";
import type { AheadCommit, ChangedFile, ChangeKind, GitIssue, RepoStatus } from "../../src/types/repo.js";
import { getProjectFiles } from "./projectFiles.js";
import { runGit, tryGit } from "./exec.js";
import { getGitHubActionsStatus } from "./githubActions.js";

export type ParsedStatus = {
  branch: string | null;
  upstream: string | null;
  isDetachedHead: boolean;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  conflicts: string[];
};

function mapStatusCode(code: string): ChangeKind {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "U") return "conflicted";
  if (code === "M" || code === ".") return "modified";
  return "unknown";
}

export function parsePorcelainV2(output: string): ParsedStatus {
  const files: ChangedFile[] = [];
  const conflicts: string[] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let isDetachedHead = false;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      isDetachedHead = head === "(detached)";
      branch = isDetachedHead ? null : head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      const file = line.slice(2);
      files.push({ path: file, kind: "untracked", staged: false, unstaged: false, untracked: true, conflicted: false });
      continue;
    }
    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const file = parts.slice(10).join(" ");
      conflicts.push(file);
      files.push({ path: file, kind: "conflicted", staged: false, unstaged: true, untracked: false, conflicted: true });
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const stagedCode = xy[0] ?? ".";
      const unstagedCode = xy[1] ?? ".";
      const pathStart = line.startsWith("2 ") ? 9 : 8;
      const fileParts = parts.slice(pathStart);
      const rawPath = fileParts.join(" ");
      const [newPath, oldPath] = rawPath.split("\t");
      files.push({
        path: newPath,
        oldPath,
        kind: mapStatusCode(stagedCode !== "." ? stagedCode : unstagedCode),
        staged: stagedCode !== ".",
        unstaged: unstagedCode !== ".",
        untracked: false,
        conflicted: stagedCode === "U" || unstagedCode === "U"
      });
    }
  }

  return { branch, upstream, isDetachedHead, ahead, behind, files, conflicts };
}

async function hasGitStateFile(repoPath: string, relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoPath, ".git", relativePath));
    return true;
  } catch {
    return false;
  }
}

async function detectWarnings(repoPath: string, parsed: ParsedStatus, fetchWarning?: GitIssue): Promise<{ warnings: GitIssue[]; errors: GitIssue[] }> {
  const warnings: GitIssue[] = [];
  const errors: GitIssue[] = [];

  if (fetchWarning) warnings.push(fetchWarning);
  if (parsed.isDetachedHead) warnings.push({ code: "detached-head", message: "Detached HEAD." });
  if (!parsed.upstream) warnings.push({ code: "missing-upstream", message: "No upstream branch configured." });
  if (parsed.conflicts.length > 0) errors.push({ code: "conflicts", message: "Merge conflicts are present." });
  if (await hasGitStateFile(repoPath, "MERGE_HEAD")) errors.push({ code: "merge-in-progress", message: "Merge in progress." });
  if (await hasGitStateFile(repoPath, "rebase-merge")) errors.push({ code: "rebase-in-progress", message: "Rebase in progress." });
  if (await hasGitStateFile(repoPath, "rebase-apply")) errors.push({ code: "rebase-in-progress", message: "Rebase in progress." });
  if (await hasGitStateFile(repoPath, "CHERRY_PICK_HEAD")) errors.push({ code: "cherry-pick-in-progress", message: "Cherry-pick in progress." });

  return { warnings, errors };
}

async function getAheadCommits(repoPath: string, upstream: string | null): Promise<AheadCommit[]> {
  if (!upstream) return [];
  const result = await tryGit(repoPath, ["log", "--format=%H%x1f%s%x1f%an%x1f%cI", `${upstream}..HEAD`]);
  if (result.code !== 0 || !result.stdout.trim()) return [];

  const commits: AheadCommit[] = [];
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const [hash, subject, author, date] = line.split("\x1f");
    const filesResult = await tryGit(repoPath, ["show", "--name-only", "--format=", hash]);
    commits.push({
      hash,
      subject,
      author,
      date,
      files: filesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    });
  }
  return commits;
}

export async function getRepositoryStatus(repoPath: string, rootPath: string, fetchFirst: boolean): Promise<RepoStatus> {
  let fetchWarning: GitIssue | undefined;
  if (fetchFirst) {
    const fetchResult = await tryGit(repoPath, ["fetch", "--prune"], 60000);
    if (fetchResult.code !== 0) {
      fetchWarning = { code: "fetch-failed", message: "Fetch failed.", detail: fetchResult.stderr || fetchResult.stdout };
    }
  }

  const status = await runGit(repoPath, ["status", "--porcelain=v2", "--branch"]);
  const parsed = parsePorcelainV2(status.stdout);
  const issues = await detectWarnings(repoPath, parsed, fetchWarning);
  const relativePath = path.relative(rootPath, repoPath) || path.basename(repoPath);
  const parent = path.dirname(relativePath);
  const projectFiles = await getProjectFiles(repoPath);
  const githubActions = await getGitHubActionsStatus(repoPath, parsed.branch);
  if (githubActions?.error) {
    issues.warnings.push({
      code: "github-actions-unavailable",
      message: `GitHub Actions status unavailable for ${githubActions.repository}.`,
      detail: githubActions.error
    });
  }

  return {
    id: path.resolve(repoPath).toLowerCase(),
    name: path.basename(repoPath),
    absolutePath: path.resolve(repoPath),
    relativePath: relativePath.replaceAll("\\", "/"),
    parentGroup: parent === "." ? "/" : parent.replaceAll("\\", "/"),
    branch: parsed.branch,
    upstream: parsed.upstream,
    isDetachedHead: parsed.isDetachedHead,
    hasUnstagedChanges: parsed.files.some((file) => file.unstaged),
    hasStagedChanges: parsed.files.some((file) => file.staged),
    hasUntrackedFiles: parsed.files.some((file) => file.untracked),
    ahead: parsed.ahead,
    behind: parsed.behind,
    conflicts: parsed.conflicts,
    files: parsed.files,
    aheadCommits: await getAheadCommits(repoPath, parsed.upstream),
    branchComparison: undefined,
    branchComparisonLoaded: false,
    branchComparisonLoading: false,
    statusLoading: false,
    projectFiles,
    githubActions,
    warnings: issues.warnings,
    errors: issues.errors,
    lastFetchedAt: fetchFirst ? new Date().toISOString() : undefined
  };
}
