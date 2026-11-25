import type { AppSettings } from "../../src/types/settings.js";
import { tryGit } from "./exec.js";

async function configValue(repo: string, key: string) {
  const result = await tryGit(repo, ["config", "--type=bool-or-str", "--get", key]);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not read ${key}.`);
  return result.stdout.trimEnd();
}

export async function configuredPullRebase(repo: string, branch: string) {
  return await configValue(repo, `branch.${branch}.rebase`) ?? await configValue(repo, "pull.rebase");
}

export async function assertSingleSyncUpstream(repo: string, branch: string) {
  const heads = await tryGit(repo, ["config", "--null", "--get-all", `branch.${branch}.merge`]);
  if (heads.code !== 0 && heads.code !== 1) throw new Error(heads.stderr.trim() || "Could not read the branch's pull configuration.");
  if (new Set(heads.stdout.split("\0").filter(Boolean)).size > 1) {
    throw new Error(`Branch ${branch} is configured to pull multiple branches. Complete this sync in Git.`);
  }
}

export const updateRefsMessage = "This rebase can update other local branches (rebase.updateRefs). Complete this sync in Git.";

export type SyncPullPlan = { args: string[]; replayRange?: string; fastForwardOnly?: boolean; requiresCleanWorktree?: boolean };

export function fastForwardPlan(incoming: string): SyncPullPlan {
  return { args: ["merge", "--ff-only", "--no-edit", "--no-autostash", "--no-overwrite-ignore", "--", incoming] };
}

function ffOption(value?: string) {
  if (value === undefined) return undefined;
  if (value === "only") return "--ff-only";
  if (value === "true") return "--ff";
  if (value === "false") return "--no-ff";
  throw new Error(`Invalid Git fast-forward setting: ${value}.`);
}

// Git splits branch.<name>.mergeOptions into arguments using split_cmdline():
// quotes group words, and a backslash escapes the next character outside single quotes.
export function mergeOptionWords(value = ""): string[] {
  const words: string[] = [];
  let word = "", quote = "";
  let started = false;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (!quote && /[ \t\n\r\f\v]/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    started = true;
    if (!quote && (character === "'" || character === '"')) quote = character;
    else if (character === quote) quote = "";
    else if (character === "\\" && quote !== "'") {
      if (++i === value.length) throw new Error("A backslash at the end of the branch merge options needs an argument.");
      word += value[i];
    } else word += character;
  }
  if (quote) throw new Error("The Git branch merge options contain an unclosed quote.");
  if (started) words.push(word);
  return words;
}

async function firstMergeRequiresFastForward(repo: string, branch: string, pullOption?: string) {
  if (pullOption) return pullOption === "--ff-only";
  // Git reads merge.ff, then the branch's mergeOptions, then command-line flags.
  const [ff, branchOptions] = await Promise.all([configValue(repo, "merge.ff"), configValue(repo, `branch.${branch}.mergeOptions`)]);
  let option = ffOption(ff);
  for (const argument of mergeOptionWords(branchOptions)) {
    if (["--ff", "--ff-only", "--no-ff"].includes(argument)) option = argument;
  }
  return option === "--ff-only";
}

export async function syncPullPlan(repo: string, branch: string, diverged: boolean, settings: AppSettings, incoming: string, joinInitialHistories = false): Promise<SyncPullPlan> {
  const explicit = settings.pullStrategy !== "git-config";
  const [rebase, ff] = await Promise.all([
    explicit ? (settings.pullStrategy === "rebase" ? "true" : "false") : configuredPullRebase(repo, branch),
    configValue(repo, "pull.ff")
  ]);
  if (rebase !== undefined && !["false", "true", "merges", "m", "interactive", "i"].includes(rebase)) {
    throw new Error(`Invalid Git pull rebase setting: ${rebase}.`);
  }
  // Git treats an explicit --rebase/--no-rebase as overriding pull.ff=only.
  const ffArg = ffOption(explicit && ff === "only" ? "true" : ff);
  const wantsRebase = rebase !== undefined && rebase !== "false";
  if (!diverged && wantsRebase) {
    // Pull checks rebase cleanliness, then uses merge --ff-only when there is nothing to replay.
    // Git's merge command enforces signature verification and the configured two-head strategy.
    return { ...fastForwardPlan(incoming), requiresCleanWorktree: true, fastForwardOnly: ffArg === "--ff-only" };
  }
  if (!wantsRebase || ffArg === "--ff-only") {
    const args = ["merge", "--no-edit", "--no-autostash", "--no-overwrite-ignore"];
    if (ffArg) args.push(ffArg);
    if (joinInitialHistories) args.push("--allow-unrelated-histories");
    const fastForwardOnly = ffArg === "--ff-only" || (joinInitialHistories && await firstMergeRequiresFastForward(repo, branch, ffArg));
    return { args: [...args, "--", incoming], fastForwardOnly, requiresCleanWorktree: wantsRebase };
  }
  const updateRefs = await tryGit(repo, ["config", "--bool", "--get", "rebase.updateRefs"]);
  if (updateRefs.code !== 0 && updateRefs.code !== 1) throw new Error(updateRefs.stderr.trim() || "Could not read rebase.updateRefs.");
  if (updateRefs.stdout.trim() === "true") throw new Error(updateRefsMessage);
  const args = ["rebase", "--no-autostash"];
  if (rebase === "merges" || rebase === "m") args.push("--rebase-merges");
  if (rebase === "interactive" || rebase === "i") args.push("--interactive");
  let boundary = incoming;
  if (!joinInitialHistories) {
    // Normal pull --rebase excludes former upstream commits after an upstream rewrite.
    const fork = await tryGit(repo, ["merge-base", "--fork-point", `${branch}@{upstream}`, "HEAD"]);
    if (fork.code !== 0 && fork.code !== 1) throw new Error(fork.stderr.trim() || "Could not find the branch's upstream fork point.");
    if (fork.code === 0) {
      const old = fork.stdout.trimEnd();
      const included = await tryGit(repo, ["merge-base", "--is-ancestor", old, incoming]);
      if (included.code === 1) boundary = old;
      else if (included.code !== 0) throw new Error(included.stderr.trim() || "Could not compare the upstream history.");
    }
  }
  return { args: [...args, "--onto", incoming, boundary], replayRange: `${boundary}..HEAD` };
}
