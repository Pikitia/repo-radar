import { GitCommandError, runGit, tryGit } from "./exec.js";
import { getRepositoryStatus } from "./status.js";
import type { AppSettings } from "../../src/types/settings.js";
import type { RepoStatus, SyncCommitGuard, SyncDecision } from "../../src/types/repo.js";
import { validateRepositoryPath } from "./repositoryPath.js";
import { applySyncConflicts } from "./syncConflicts.js";
import { createSyncCommitGuard, prepareSyncCommit } from "./syncCommit.js";
import { resolveSyncPush } from "./syncPushRoute.js";
import { assertNoIgnoredCheckoutCollision } from "./syncCheckout.js";
import { assertSingleSyncUpstream, fastForwardPlan, syncPullPlan, type SyncPullPlan } from "./syncPull.js";
import { bumpPackageVersionFile } from "./versionBump.js";

export async function stageFiles(repoPath: string, rootPath: string, files: string[]) {
  repoPath = await validateRepositoryPath(repoPath, rootPath);
  await runGit(repoPath, ["--literal-pathspecs", "add", "--", ...files]);
  return getRepositoryStatus(repoPath, rootPath, false);
}

export async function unstageFiles(repoPath: string, rootPath: string, files: string[]) {
  repoPath = await validateRepositoryPath(repoPath, rootPath);
  await runGit(repoPath, ["--literal-pathspecs", "restore", "--staged", "--", ...files]);
  return getRepositoryStatus(repoPath, rootPath, false);
}

export async function bumpPackageVersion(repoPath: string, rootPath: string) {
  const version = await bumpPackageVersionFile(repoPath);
  if (!version) throw new Error("Could not bump package.json version. Ensure the repository has a root package.json with a semver version.");
  await runGit(repoPath, ["add", "--", version.path]);
  return getRepositoryStatus(repoPath, rootPath, false);
}

export async function commit(repoPath: string, rootPath: string, message: string) {
  repoPath = await validateRepositoryPath(repoPath, rootPath);
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

const syncing = new Set<string>();

async function withSync(repoPath: string, rootPath: string, action: (repo: string) => Promise<RepoStatus>) {
  const repo = await validateRepositoryPath(repoPath, rootPath);
  const key = process.platform === "win32" ? repo.toLowerCase() : repo;
  if (syncing.has(key)) throw new Error("A sync is already running for this repository.");
  syncing.add(key);
  try {
    return await action(repo);
  } catch (error) {
    if (error instanceof GitCommandError) throw new Error(error.result.stderr.trim() || error.result.stdout.trim() || error.message);
    throw error;
  } finally {
    syncing.delete(key);
  }
}

function pausedIntegration(status: RepoStatus) {
  return status.errors.some(issue => issue.code === "merge-in-progress" || issue.code === "rebase-in-progress");
}

async function ensureUpstreamExists(repo: string, upstream: string) {
  const target = await tryGit(repo, ["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"]);
  if (target.code !== 0) throw new Error(`The upstream branch ${upstream} is missing. Choose an existing upstream before syncing.`);
  return target.stdout.trimEnd();
}

async function pushSyncedBranch(repo: string, rootPath: string, branch: string, status: RepoStatus, confirmation?: string) {
  if (pausedIntegration(status) && confirmation === undefined) return status;
  if (status.errors.length) throw new Error(status.errors.map(issue => issue.message).join(" "));
  if (status.branch !== branch || !status.upstream) throw new Error("The checked-out branch or its upstream changed. Refresh before syncing.");
  await assertSingleSyncUpstream(repo, branch);
  await ensureUpstreamExists(repo, status.upstream);
  if (status.behind) throw new Error("The upstream advanced during sync. Sync again to get the latest changes.");
  const route = await resolveSyncPush(repo, branch, status.ahead > 0);
  if (confirmation !== undefined && route?.review?.token !== confirmation) throw new Error("The branch or push destination changed. Sync again to review the current push.");
  if (!route || route.upToDate) return status;
  const { head, remote, target, review, checkSubmodules, refreshUpstream } = route;
  if (review && confirmation === undefined) return { ...status, syncPushReview: review };
  const localRef = `refs/heads/${branch}`;
  const [current, tip] = await Promise.all([runGit(repo, ["symbolic-ref", "HEAD"]), runGit(repo, ["rev-parse", "--verify", localRef])]);
  if (current.stdout.trimEnd() !== localRef || tip.stdout.trimEnd() !== head) {
    throw new Error("The checked-out branch or its commits changed. Sync again from the current branch.");
  }
  try {
    // Use the branch ref so pre-push hooks receive the normal local branch name.
    const args = ["push", "--no-follow-tags"];
    if (checkSubmodules) args.push("--recurse-submodules=check");
    await runGit(repo, [...args, "--", remote, `${localRef}:${target}`], 60000);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new Error(`Your commits are saved locally. The push failed.\n${error.result.stderr.trim() || error.message}`);
    }
    throw error;
  }
  return getRepositoryStatus(repo, rootPath, refreshUpstream);
}

async function verifySyncBranch(repo: string, expectedBranch: string) {
  const current = await tryGit(repo, ["symbolic-ref", "--quiet", "HEAD"]);
  if (typeof expectedBranch !== "string" || !expectedBranch || current.code !== 0 || current.stdout.trimEnd() !== `refs/heads/${expectedBranch}`) {
    throw new Error("The checked-out branch changed. Refresh and choose the branch you want to sync.");
  }
}

async function reviewBeforePull(repo: string, status: RepoStatus, branch: string, before: SyncCommitGuard | null, settings: AppSettings, reason: string) {
  if (status.errors.length) throw new Error(status.errors.map(issue => issue.message).join(" "));
  const guard = await createSyncCommitGuard(repo);
  if (status.branch !== branch || guard.branch !== branch || before?.token !== guard.token || !status.files.length) {
    throw new Error("Your local changes moved during sync. Review the current changes and sync again.");
  }
  // A save creates a divergent history, even if this checkout could fast-forward now.
  await syncPullPlan(repo, branch, true, settings, "@{upstream}", status.isUnborn);
  return { ...status, syncCommitRequired: reason, syncCommitGuard: guard };
}

async function syncBranch(repo: string, rootPath: string, settings: AppSettings, expectedBranch: string,
  firstSave?: { initialCommit: string; initialUpstream: string; plan: SyncPullPlan }) {
  await verifySyncBranch(repo, expectedBranch);
  await assertSingleSyncUpstream(repo, expectedBranch);
  // An approved first save already records the fetched tip used to check its files.
  if (!firstSave) await runGit(repo, ["fetch", "--prune"], 60000);
  let status = await getRepositoryStatus(repo, rootPath, false);
  if (status.branch !== expectedBranch) throw new Error("The checked-out branch changed. Refresh and choose the branch you want to sync.");
  if (pausedIntegration(status)) return status;
  if (status.errors.length) throw new Error(status.errors.map(issue => issue.message).join(" "));
  const branch = status.branch;
  if (!branch || !status.upstream) throw new Error("Check out a branch with an upstream before syncing.");
  if (status.behind || status.isUnborn) {
    const trackingTip = await ensureUpstreamExists(repo, status.upstream);
    const incoming = firstSave?.initialUpstream ?? trackingTip;
    if (firstSave) {
      // The user saved overlapping local files before their first checkout. Only
      // this reviewed root commit and its fetched upstream may join independent histories.
      const head = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trimEnd();
      if (head !== firstSave.initialCommit ||
        (trackingTip !== incoming && (await tryGit(repo, ["merge-base", "--is-ancestor", incoming, trackingTip])).code !== 0)) {
        throw new Error("The branch changed after your first local commit. Your changes are saved locally.");
      }
    }
    const before = status.files.length ? await createSyncCommitGuard(repo) : null;
    // Integrate exactly the checked tree. A second fetch from the server could
    // introduce an ignored-file collision after the local worktree check.
    const plan = firstSave?.plan ?? (status.isUnborn ? fastForwardPlan(incoming)
      : await syncPullPlan(repo, branch, status.ahead > 0, settings, incoming));
    if (plan.fastForwardOnly) {
      // Pull checks ancestry itself. Some merge strategies can create a merge commit even with --ff-only.
      const ancestry = await tryGit(repo, ["merge-base", "--is-ancestor", "HEAD", incoming]);
      if (ancestry.code === 1) throw new Error("The branches have diverged. Your fast-forward-only pull policy prevents this sync.");
      if (ancestry.code !== 0) throw new Error(ancestry.stderr.trim() || "Could not verify whether this branch can fast-forward.");
    }
    await assertNoIgnoredCheckoutCollision(repo, incoming, plan.replayRange, status.isUnborn ? undefined : plan.args);
    await verifySyncBranch(repo, branch);
    if (plan.requiresCleanWorktree) {
      // Native pull --rebase ignores submodules and untracked files for its clean-worktree check.
      const tracked = await runGit(repo, ["status", "--porcelain", "-z", "--untracked-files=no", "--ignore-submodules=all"]);
      if (tracked.stdout) return reviewBeforePull(repo, await getRepositoryStatus(repo, rootPath, false), branch, before, settings,
        "Git requires a clean working tree before pulling with rebase. Commit your staged or unstaged changes to continue.");
    }
    const result = await tryGit(repo, plan.args, 60000, { LC_ALL: "C" });
    status = await getRepositoryStatus(repo, rootPath, false);
    if (result.code !== 0 && !(status.conflicts.length && pausedIntegration(status))) {
      const dirtyPull = /^error: (?:(?:Your local changes|The following untracked working tree files|Untracked working tree file|Entry) .*would be (?:overwritten|removed) by (?:merge|checkout)|Updating the following directories would lose untracked files in them:|cannot (?:pull with )?rebase: (?:You have unstaged changes|Your index contains uncommitted changes))/im;
      if (!status.errors.length && status.files.length && dirtyPull.test(result.stderr)) {
        return reviewBeforePull(repo, status, branch, before, settings, result.stderr.trim());
      }
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Git could not pull this branch.");
    }
  }
  return pushSyncedBranch(repo, rootPath, branch, status);
}

export function sync(repoPath: string, rootPath: string, settings: AppSettings, displayedBranch: string) {
  return withSync(repoPath, rootPath, repo => syncBranch(repo, rootPath, settings, displayedBranch));
}

export function commitAndSync(repoPath: string, rootPath: string, settings: AppSettings, expected: SyncCommitGuard, files: string[], message: string) {
  return withSync(repoPath, rootPath, async repo => {
    const result = await prepareSyncCommit(repo, rootPath, expected, files, message, settings);
    if (result && "initialCommit" in result) return syncBranch(repo, rootPath, settings, expected.branch, result);
    return result ?? syncBranch(repo, rootPath, settings, expected.branch);
  });
}

export function confirmSyncPush(repoPath: string, rootPath: string, token: string) {
  return withSync(repoPath, rootPath, async repo => {
    if (typeof token !== "string" || !token) throw new Error("Review the push destination before continuing.");
    const status = await getRepositoryStatus(repo, rootPath, false);
    if (!status.branch) throw new Error("Check out a branch before syncing.");
    return pushSyncedBranch(repo, rootPath, status.branch, status, token);
  });
}

export function finishSync(repoPath: string, rootPath: string, token: string, decisions: SyncDecision[], skipEmptyPatch = false) {
  return withSync(repoPath, rootPath, async repo => {
    const branch = await applySyncConflicts(repo, rootPath, token, decisions, skipEmptyPatch);
    return pushSyncedBranch(repo, rootPath, branch, await getRepositoryStatus(repo, rootPath, false));
  });
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
