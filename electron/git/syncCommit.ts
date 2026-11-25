import { createHash } from "node:crypto";
import type { RepoStatus, SyncCommitGuard } from "../../src/types/repo.js";
import type { AppSettings } from "../../src/types/settings.js";
import { runGit, tryGit } from "./exec.js";
import { getRepositoryStatus, parsePorcelainV2 } from "./status.js";
import { assertSingleSyncUpstream, syncPullPlan } from "./syncPull.js";
import { assertNoIgnoredCheckoutCollision } from "./syncCheckout.js";

async function readCommitState(repo: string) {
  const [branch, tracking, head, index] = await Promise.all([
    runGit(repo, ["symbolic-ref", "HEAD"]),
    runGit(repo, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
    tryGit(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    runGit(repo, ["ls-files", "--stage", "-z"])
  ]);
  const branchRef = branch.stdout.trimEnd();
  const upstream = tracking.stdout.trimEnd();
  if (!branchRef.startsWith("refs/heads/") || !upstream) throw new Error("Choose a branch with an upstream and start Sync again.");
  if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr.trim() || "Could not read the checked-out commit.");
  const initialUpstream = head.code === 1 ? (await runGit(repo, ["rev-parse", "--verify", "@{upstream}^{commit}"])).stdout.trimEnd() : null;
  const checkout = JSON.stringify([repo, branchRef, head.stdout.trimEnd(), upstream, initialUpstream]);
  const guard = {
    branch: branchRef.slice("refs/heads/".length),
    token: createHash("sha256").update(checkout).update(index.stdout).digest("hex")
  };
  return { checkout, index: index.stdout, guard, initialUpstream };
}

export async function createSyncCommitGuard(repo: string): Promise<SyncCommitGuard> {
  return (await readCommitState(repo)).guard;
}

function indexPath(entry: string) {
  return entry.slice(entry.indexOf("\t") + 1);
}

function otherIndexEntries(index: string, selected: Set<string>) {
  return index.split("\0").filter(entry => !selected.has(indexPath(entry))).join("\0");
}

async function reviewChangedCheckout(repo: string, rootPath: string,
  reason = "The branch, commit, or staged files changed. Review the current checkout before continuing."): Promise<RepoStatus> {
  const before = await createSyncCommitGuard(repo);
  const status = await getRepositoryStatus(repo, rootPath, false);
  if (status.errors.length || !status.branch || !status.upstream || (!status.behind && !status.isUnborn) || !status.files.length) {
    throw new Error(`${reason} Close this review and start Sync again.`);
  }
  const guard = await createSyncCommitGuard(repo);
  if (guard.branch !== status.branch || guard.token !== before.token) throw new Error(reason);
  return { ...status, syncCommitGuard: guard, syncCommitRequired: reason };
}

// An initial local commit starts a separate history. Keep the reviewed files
// staged until the first checkout can proceed in the same operation as that commit.
async function remainingFirstCheckoutFiles(repo: string, upstream: string, rebase: boolean) {
  const [tree, status, ignoreCase] = await Promise.all([
    runGit(repo, ["ls-tree", "-r", "--name-only", "-z", upstream]),
    runGit(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    tryGit(repo, ["config", "--bool", "--get", "core.ignorecase"])
  ]);
  const normalize = (file: string) => ignoreCase.stdout.trim() === "true" ? file.toLowerCase() : file;
  const targets = new Set(tree.stdout.split("\0").filter(Boolean).map(normalize));
  const directories = new Set<string>();
  for (const target of targets) {
    for (let slash = target.indexOf("/"); slash >= 0; slash = target.indexOf("/", slash + 1)) directories.add(target.slice(0, slash));
  }
  const pending = parsePorcelainV2(status.stdout).files.filter(file =>
    file.untracked || (file.unstaged && file.submoduleChange !== "contents"));
  return pending.filter(file => {
    if (rebase && file.unstaged) return true;
    const name = normalize(file.path.replace(/\/$/, ""));
    if (directories.has(name) || targets.has(name)) return true;
    for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
      if (targets.has(name.slice(0, slash))) return true;
    }
    return false;
  }).map(file => file.path);
}

// The caller holds the repository's sync lock throughout this commit and the following sync.
export async function prepareSyncCommit(repo: string, rootPath: string, expected: SyncCommitGuard, files: string[], message: string, settings: AppSettings) {
  if (!expected || typeof expected.branch !== "string" || typeof expected.token !== "string" ||
    !Array.isArray(files) || typeof message !== "string" || !message.trim()) throw new Error("Review the selected files and enter a commit message.");
  const status = await getRepositoryStatus(repo, rootPath, false);
  if (status.errors.length) throw new Error(status.errors.map(issue => issue.message).join(" "));
  const before = await readCommitState(repo);
  if (expected.branch !== before.guard.branch || expected.token !== before.guard.token || status.branch !== expected.branch) {
    return reviewChangedCheckout(repo, rootPath);
  }
  const selected = new Set(files);
  const available = new Set(status.files.filter(file => file.unstaged || file.untracked).map(file => file.path));
  if (files.some(file => !available.has(file))) return reviewChangedCheckout(repo, rootPath);
  const nested = status.files.find(file => file.untracked && file.path.endsWith("/") && selected.has(file.path));
  if (nested) throw new Error(`Manage the nested repository ${nested.path} separately. Select individual files in this repository to continue.`);
  const dirtyChild = status.files.find(file => file.submoduleChange === "contents" && selected.has(file.path));
  if (dirtyChild) throw new Error(`Commit changes inside the submodule ${dirtyChild.path} first. This repository can record its new commit once it is ready.`);
  await assertSingleSyncUpstream(repo, expected.branch);
  // Saving here creates a local commit to integrate with the fetched upstream.
  // Check the effective policy before changing the user's index or creating that commit.
  const savePlan = await syncPullPlan(repo, expected.branch, true, settings, before.initialUpstream ?? "@{upstream}", Boolean(before.initialUpstream));
  const initialPlan = before.initialUpstream ? savePlan : null;
  let reviewed = before;
  if (selected.size) {
    // update-index names individual entries. A deleted file replaced by a directory
    // must never turn into a recursive add of the new directory's contents.
    const tracked = new Set(before.index.split("\0").map(indexPath));
    const paths = [...selected];
    await runGit(repo, ["update-index", "--add", "--remove", "--",
      ...paths.filter(file => tracked.has(file)), ...paths.filter(file => !tracked.has(file))]);
    const after = await readCommitState(repo);
    if (after.checkout !== before.checkout || otherIndexEntries(before.index, selected) !== otherIndexEntries(after.index, selected)) {
      return reviewChangedCheckout(repo, rootPath);
    }
    reviewed = after;
  } else if (!status.hasStagedChanges) {
    throw new Error("Select at least one local change to commit.");
  }
  if (initialPlan && before.initialUpstream) {
    if (initialPlan.fastForwardOnly) return reviewChangedCheckout(repo, rootPath,
      "Your selected files are staged. A first local commit and the upstream already have separate histories, so fast-forward-only cannot join them. Choose a merge or rebase policy, then retry Sync.");
    await assertNoIgnoredCheckoutCollision(repo, before.initialUpstream);
    const remaining = await remainingFirstCheckoutFiles(repo, before.initialUpstream, Boolean(initialPlan.replayRange));
    if (remaining.length) {
      return reviewChangedCheckout(repo, rootPath,
        `Your selected changes are staged. Before the first checkout, select or move the remaining local changes:\n${remaining.join("\n")}`);
    }
    if ((await createSyncCommitGuard(repo)).token !== reviewed.guard.token) return reviewChangedCheckout(repo, rootPath);
  }
  await runGit(repo, ["commit", "-m", message.trim()]);
  if (before.initialUpstream && initialPlan) {
    const root = (await runGit(repo, ["rev-list", "--parents", "-1", "HEAD"])).stdout.trimEnd();
    if (root.includes(" ")) throw new Error("The initial branch changed during the commit. Refresh before syncing.");
    return { initialCommit: root, initialUpstream: before.initialUpstream, plan: initialPlan };
  }
  return null;
}
