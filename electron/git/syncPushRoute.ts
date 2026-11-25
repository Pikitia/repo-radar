import { createHash } from "node:crypto";
import { runGit, tryGit, type GitResult } from "./exec.js";

const heads = "refs/heads/";

async function config(repo: string, key: string) {
  const value = await tryGit(repo, ["config", "--get", key]);
  if (value.code === 1) return null;
  if (value.code !== 0) throw new Error(value.stderr.trim() || "Git could not read the push configuration.");
  return value.stdout.trimEnd();
}

function describeEndpoint(value: string) {
  // Transport URLs can contain credentials. Keep userinfo, query and fragment out of the renderer.
  try {
    const url = new URL(value);
    if (url.host) return url.host + url.pathname;
  } catch { /* SCP-style Git URLs and local paths are also valid. */ }
  return value.replace(/^[^/@]+@/, "").split(/[?#]/, 1)[0];
}

async function remoteUrl(repo: string, name: string, push: boolean) {
  if (name === ".") return ".";
  const result = await runGit(repo, ["remote", "get-url", ...(push ? ["--push", "--all"] : []), "--", name]);
  const urls = result.stdout.trimEnd().split(/\r?\n/);
  if (urls.length !== 1 || !urls[0]) throw new Error("Sync needs a single push destination. This remote has multiple push URLs.");
  return urls[0];
}

function branchResult(branch: string, result: GitResult) {
  let unrelatedRejection = false;
  let selected: { target: string; upToDate: boolean } | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const [flag, mapping, summary] = line.split("\t");
    if (flag?.length !== 1 || !mapping) continue;
    const [source, target] = mapping.split(":");
    if (source !== heads + branch && source !== branch && source !== "HEAD") {
      if (flag === "!") unrelatedRejection = true;
      continue;
    }
    if (flag === "!") throw new Error(`Git rejected the push of ${branch} to ${target}. ${summary ?? ""}`.trimEnd());
    if (!target?.startsWith(heads) || ![" ", "=", "*"].includes(flag)) {
      throw new Error("Sync requires a normal push to a branch. Review this push configuration in Git.");
    }
    if (selected && selected.target !== target) throw new Error("Git's push configuration does not select a single destination for this branch.");
    selected = { target, upToDate: flag === "=" };
  }
  return { selected, unrelatedRejection };
}

async function configuredTarget(repo: string, branch: string, remote: string) {
  // Ask Git to expand matching/wildcard/custom refspecs and evaluate its own push policy.
  // A dry run sends no changes. Hooks run on the actual, single-branch push.
  const args = ["push", "--dry-run", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", "--", remote];
  let result = await tryGit(repo, args, 60000);
  let parsed = branchResult(branch, result);
  if (result.code === 1 && parsed.selected && parsed.unrelatedRejection) {
    // Check the single ref we will actually push. A rejected sibling may have caused the first exit code.
    result = await tryGit(repo, [...args, `${heads}${branch}:${parsed.selected.target}`], 60000);
    parsed = branchResult(branch, result);
  }
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Git rejected the configured push.");
  if (!parsed.selected) throw new Error("Git's push configuration does not select a single destination for this branch.");
  return parsed.selected;
}

export async function resolveSyncPush(repo: string, branch: string, ahead: boolean) {
  const ref = heads + branch;
  const fields = "%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push:remotename)";
  const result = await runGit(repo, ["for-each-ref", "--format=" + fields, "--", ref]);
  const [head, upstreamRemote, upstreamRef, remote] = result.stdout.trimEnd().split("\0");
  if (!head || !upstreamRef?.startsWith(heads) || !upstreamRemote || !remote) throw new Error("Choose an upstream and push remote before syncing.");
  const [upstreamUrl, pushUrl, spec, mode, mirror, submodulePush, recurse] = await Promise.all([
    remoteUrl(repo, upstreamRemote, false), remoteUrl(repo, remote, true), config(repo, `remote.${remote}.push`),
    config(repo, "push.default"), tryGit(repo, ["config", "--bool", "--get", `remote.${remote}.mirror`]),
    config(repo, "push.recurseSubmodules"), tryGit(repo, ["config", "--bool", "--get", "submodule.recurse"])
  ]);
  const simple = mode === null || mode === "simple";
  const sameRemote = remote === upstreamRemote;
  const sameUrl = upstreamUrl === pushUrl;
  const standard = spec === null && simple && sameRemote && upstreamRef === ref;
  if (!ahead && spec === null && (mode === "nothing" || (simple && sameRemote && upstreamRef !== ref))) return null;
  const tracksDestination = mode === "upstream" || mode === "tracking" || (upstreamRef === ref && (simple || mode === "current" || mode === "matching"));
  if (!ahead && spec === null && sameRemote && sameUrl && tracksDestination) return null;
  if (mirror.stdout.trim() === "true") throw new Error("This remote mirrors all refs. Sync requires a single-branch push.");
  if (submodulePush === "only") throw new Error("Git is configured to push only submodules. Sync requires a push of this branch.");
  // Keep Git's dependency check when the configured alternative would publish other repositories.
  const checkSubmodules = submodulePush === "on-demand" || (submodulePush === null && recurse.stdout.trim() === "true");
  const { target, upToDate } = standard && sameUrl ? { target: ref, upToDate: false } : await configuredTarget(repo, branch, remote);
  const needsReview = !sameRemote || target !== upstreamRef || !sameUrl;
  const destination = remote + "/" + target.slice(heads.length)
    + (sameRemote && !sameUrl ? ` (${describeEndpoint(pushUrl)})` : "");
  const upstream = upstreamRemote + "/" + upstreamRef.slice(heads.length);
  const token = createHash("sha256").update(JSON.stringify([repo, branch, head, upstream, upstreamUrl, remote, target, pushUrl])).digest("hex");
  // Different remote names or URL spellings can refer to the same server-side branch.
  const refreshUpstream = target === upstreamRef && (!sameRemote || !sameUrl);
  return { head, remote, target, upToDate, checkSubmodules, refreshUpstream, review: needsReview ? { token, upstream, destination } : null };
}
