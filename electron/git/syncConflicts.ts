import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { hasConflictMarkers, markerEvidence } from "../../src/state/mergeText.js";
import type { SyncConflictReview, SyncConflictSide, SyncDecision } from "../../src/types/repo.js";
import { GitCommandError, runGit, tryGit } from "./exec.js";
import { validateRepositoryPath } from "./repositoryPath.js";
import { assertNoReplayCollision } from "./syncCheckout.js";
import { assertSingleSyncUpstream, updateRefsMessage } from "./syncPull.js";

const previewLimit = 256 * 1024;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const regularMode = /^100(?:644|755)$/;
const stale = "The repository changed since this review. Reload the conflicts and check your choices.";

type Entry = { mode: string; oid: string; stage: number };
type Entries = Map<string, Map<number, Entry>>;
type FileGuard = { fingerprint: string; attributes: string };

async function optionalText(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The apply backend stores the pending series as numbered format-patch files.
// Read only the envelope containing the source commit, even for large patches.
async function pendingApplyCommits(dir: string) {
  const [next, last] = await Promise.all(["next", "last"].map(name => readFile(path.join(dir, name), "utf8")));
  const first = Number(next.trim());
  const end = Number(last.trim());
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || first < 1 || end < first) {
    throw new Error("Git's pending patch list changed. Reopen the review.");
  }
  const commits: string[] = [];
  for (let i = first + 1; i <= end; i++) {
    const patch = await open(path.join(dir, String(i).padStart(4, "0")), "r");
    try {
      const { buffer, bytesRead } = await patch.read(Buffer.alloc(100), 0, 100, 0);
      const oid = buffer.toString("ascii", 0, bytesRead).match(/^From ([a-f0-9]+) /)?.[1];
      if (!oid || !objectId.test(oid)) throw new Error("Git could not identify the next patch. Continue the rebase in Git.");
      commits.push(oid);
    } finally {
      await patch.close();
    }
  }
  return commits;
}

// Labels refer to rewritten commits for completed steps and to their
// original trees for steps that Git has yet to replay.
async function replayPlan(repo: string, done: string, todo: string, onto: string) {
  const pendingCommits: string[] = [];
  const trees = new Set<string>();
  const rewritten = new Map<string, string>();
  if (/^label /m.test(done)) {
    const refs = await runGit(repo, ["for-each-ref", "--format=%(objectname) %(refname:lstrip=2)", "refs/rewritten/"]);
    for (const line of refs.stdout.trimEnd().split(/\r?\n/)) {
      const [oid, name] = line.split(" ");
      if (objectId.test(oid)) rewritten.set(name, oid);
    }
  }
  const labels = new Map([["onto", onto]]);
  const custom = "This rebase includes custom steps. Continue it in Git.";
  const shortId = /^[a-f0-9]{4,64}$/;
  function target(name: string) {
    const oid = labels.get(name) ?? (shortId.test(name) ? name : undefined);
    if (!oid) throw new Error(custom);
    return oid;
  }
  let current = onto;
  for (const [plan, queued] of [[done, false], [todo, true]] as const) {
    for (const line of plan.split(/\r?\n/)) {
      const [command, arg, ...rest] = line.trim().split(/\s+/);
      if (!command || command.startsWith("#")) continue;
      if (command === "update-ref" || command === "u") throw new Error(updateRefsMessage);
      if (command === "label" && arg && !rest.length) {
        labels.set(arg, (!queued && rewritten.get(arg)) || current);
      } else if (command === "reset" && arg && (!rest.length || rest[0] === "#")) {
        current = target(arg);
        if (queued) trees.add(current);
      } else if (command === "pick" && shortId.test(arg)) {
        current = arg;
        if (queued) pendingCommits.push(arg);
      } else if (command === "merge" && arg === "-C" && shortId.test(rest[0])) {
        const [original, ...others] = rest;
        const comment = others.indexOf("#");
        const parents = others.slice(0, comment < 0 ? others.length : comment);
        if (!parents.length) throw new Error(custom);
        for (const parent of parents) {
          const oid = target(parent);
          if (queued) trees.add(oid);
        }
        current = original;
        if (queued) trees.add(original);
      } else throw new Error(custom);
    }
  }
  return { pendingCommits, pendingTrees: [...trees] };
}

async function operationState(repo: string) {
  const gitDir = (await runGit(repo, ["rev-parse", "--absolute-git-dir"])).stdout.trimEnd();
  let operationFile = path.join(gitDir, "MERGE_HEAD");
  const mergeHead = (await optionalText(operationFile))?.trim();
  const head = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  let operation: SyncConflictReview["operation"];
  let branch: string;
  let target: string;
  let replay = "";
  let applyPatch: string | null = null;
  let rebasePlan: string | null = null;
  let pendingCommits: string[] = [];
  let pendingTrees: string[] = [];
  const rebaseName = await optionalText(path.join(gitDir, "rebase-merge", "head-name"));
  if (mergeHead && rebaseName === null) {
    operation = "merge";
    branch = (await runGit(repo, ["symbolic-ref", "HEAD"])).stdout.trim();
    target = mergeHead;
  } else {
    operation = "rebase";
    let dir = path.join(gitDir, "rebase-merge");
    let headName = rebaseName;
    if (headName === null) {
      dir = path.join(gitDir, "rebase-apply");
      if (await optionalText(path.join(dir, "rebasing")) === null) {
        throw new Error("There is no upstream merge or rebase to finish.");
      }
      headName = await optionalText(path.join(dir, "head-name"));
      applyPatch = (await optionalText(path.join(dir, "original-commit")))?.trim() ?? null;
      pendingCommits = await pendingApplyCommits(dir);
    } else {
      const done = await optionalText(path.join(dir, "done"));
      const todo = await optionalText(path.join(dir, "git-rebase-todo"));
      rebasePlan = createHash("sha256").update(JSON.stringify([done, todo])).digest("hex");
      const onto = (await readFile(path.join(dir, "onto"), "utf8")).trim();
      ({ pendingCommits, pendingTrees } = await replayPlan(repo, done ?? "", todo ?? "", onto));
    }
    operationFile = path.join(dir, "head-name");
    branch = headName?.trim() ?? "";
    target = (await optionalText(path.join(dir, "onto")))?.trim() ?? "";
    const stopped = await tryGit(repo, ["rev-parse", "--verify", "REBASE_HEAD"]);
    if (stopped.code !== 0) throw new Error("This rebase is not paused on a commit to resolve.");
    replay = stopped.stdout.trim();
  }
  if (!branch.startsWith("refs/heads/") || !objectId.test(target)) {
    throw new Error("The current operation is not a single upstream branch integration.");
  }
  await assertSingleSyncUpstream(repo, branch.slice("refs/heads/".length));
  const upstream = (await runGit(repo, ["for-each-ref", "--format=%(upstream)", "--", branch])).stdout.trim();
  if (!upstream.startsWith("refs/") || upstream.includes("\n")) throw new Error("This branch needs a configured upstream to finish syncing.");
  const upstreamId = (await runGit(repo, ["rev-parse", "--verify", upstream])).stdout.trim();
  if ((await tryGit(repo, ["merge-base", "--is-ancestor", target, upstreamId])).code !== 0) {
    throw new Error("The current operation is integrating another branch. Finish it in Git before syncing.");
  }
  // A restarted merge or rebase can have the same heads, stages, and working bytes.
  // Git recreates this per-worktree state file when it starts a new operation.
  const info = await lstat(operationFile, { bigint: true });
  const generation = [info.dev, info.ino, info.birthtimeNs, info.ctimeNs].join("/");
  return { operation, branch, head, target, upstream, upstreamId, replay, applyPatch, rebasePlan, generation, pendingCommits, pendingTrees, mergeHead };
}

async function emptyApplyPatch(repo: string, state: Awaited<ReturnType<typeof operationState>>, resolved: Entries) {
  if (!state.applyPatch || state.applyPatch !== state.replay) return false;
  const status = await runGit(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=none"]);
  if (status.stdout) return false;
  // A clean index can also mean Git never applied this patch (e.g. an untracked file was in its way).
  // Verify Git recorded a resolution with this patch's exact before/after blobs and modes.
  const diff = await runGit(repo, ["diff-tree", "-r", "--raw", "--root", "--no-commit-id", "--no-renames", "--no-abbrev", "-z", state.replay, "--"]);
  const records = diff.stdout.split("\0");
  const patchPaths = new Set<string>();
  for (let i = 0; i + 1 < records.length; i += 2) {
    const [oldMode, newMode, before, after] = records[i].slice(1).split(" ");
    const file = records[i + 1];
    patchPaths.add(file);
    const stages = resolved.get(file);
    if (!stages) continue;
    const matches = (entry: Entry | undefined, mode: string, oid: string) =>
      entry ? entry.mode === mode && entry.oid === oid : mode === "000000" && /^0+$/.test(oid);
    if (matches(stages.get(1), oldMode, before) && matches(stages.get(3), newMode, after)) return true;
  }
  const others = await runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const blocked = others.stdout.split("\0").find(file => patchPaths.has(file));
  const detail = blocked ? ` The untracked file “${blocked}” is in its path. Move that file somewhere safe before retrying.` : "";
  throw new Error(`Git could not apply commit ${state.replay.slice(0, 8)}. The rebase is paused.${detail} Resolve this patch in Git before finishing Sync.`);
}

function parseConflicts(index: string, saved = false): Entries {
  const entries: Entries = new Map();
  for (const record of index.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (stage === "0") continue;
    const file = record.slice(tab + 1);
    if (tab < 0 || !objectId.test(oid) || !/^[123]$/.test(stage) || file.includes("\uFFFD")) {
      throw new Error("This conflict has a filename or index entry Repo Radar cannot display. Resolve it in Git.");
    }
    if (!saved && !regularMode.test(mode) && mode !== "120000") {
      throw new Error(`Resolve the submodule or special file ${file} in Git, then reopen the review.`);
    }
    const stages = entries.get(file) ?? new Map<number, Entry>();
    stages.set(Number(stage), { mode, oid, stage: Number(stage) });
    entries.set(file, stages);
  }
  return entries;
}

async function checkedWorkPath(repo: string, file: string) {
  const parts = file.split("/");
  if (path.isAbsolute(file) || parts.some(part => !part || part === "." || part === ".." || /^\.git$/i.test(part))
    || (process.platform === "win32" && /[\\:]/.test(file))) {
    throw new Error("The conflicted file is outside the repository.");
  }
  let parent = repo;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) break; // Both branches can rename the last file out of its old directory.
    if (!info.isDirectory() || path.relative(parent, await realpath(parent)) !== "") {
      throw new Error(`The parent of ${file} changed. Resolve this path in Git.`);
    }
  }
  return path.join(repo, ...parts);
}

async function workingFile(repo: string, file: string) {
  const absolute = await checkedWorkPath(repo, file);
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { fingerprint: "absent", text: null };
  if (stat.isSymbolicLink()) return { fingerprint: `link ${await readlink(absolute)}`, text: null };
  if (!stat.isFile()) throw new Error(`Resolve the directory conflict at ${file} in Git.`);
  const hash = createHash("sha256");
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error(stale);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      hash.update(chunk);
      if (size <= previewLimit) chunks.push(chunk);
    }
    let text = null;
    if (size <= previewLimit) {
      const bytes = Buffer.concat(chunks);
      const decoded = bytes.toString("utf8");
      if (!bytes.includes(0) && Buffer.from(decoded).equals(bytes)) text = decoded;
    }
    return { fingerprint: `${stat.mode} ${hash.digest("hex")}`, text };
  } finally {
    await handle.close();
  }
}

async function side(repo: string, entry: Entry | undefined): Promise<SyncConflictSide> {
  if (!entry) return { exists: false, text: null };
  if (regularMode.test(entry.mode)) {
    const size = Number((await runGit(repo, ["cat-file", "-s", entry.oid])).stdout);
    if (size <= previewLimit) {
      const { stdout } = await runGit(repo, ["cat-file", "blob", entry.oid]);
      if (!stdout.includes("\0") && !stdout.includes("\uFFFD")) return { exists: true, text: stdout };
    }
  }
  return { exists: true, text: null };
}

function mergedFileMode(stages: Map<number, Entry>) {
  const base = stages.get(1)?.mode;
  const current = stages.get(2)?.mode;
  const incoming = stages.get(3)?.mode;
  if (!current || !incoming || current === incoming) return current ?? incoming ?? base;
  if (current === base) return incoming;
  if (incoming === base) return current;
  // Two independent additions can disagree about whether a new file is executable.
  return undefined;
}

async function conflictAttributes(repo: string, file: string) {
  const { stdout } = await runGit(repo, ["check-attr", "-z", "--all", "--", file]);
  const fields = stdout.split("\0");
  const values = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) values.set(fields[i + 1], fields[i + 2]);
  const size = Number.parseInt(values.get("conflict-marker-size") ?? "", 10);
  return { markerSize: Number.isSafeInteger(size) && size > 0 ? size : 7,
    encoding: values.get("working-tree-encoding") ?? "unspecified", attributes: stdout };
}

// Preserve marker lines and the exact identity of their surrounding content
// without keeping a large file in memory or exposing it to the renderer.
async function compactMarkerText(repo: string, oid?: string, anchors?: Set<string>): Promise<string | null> {
  if (!oid) return null;
  const child = spawn("git", ["cat-file", "blob", oid], { cwd: repo, shell: false, windowsHide: true, timeout: 60000 });
  child.stdout.setEncoding("latin1"); // Hash the original bytes, including non-UTF-8 text.
  let errorText = "";
  child.stderr.setEncoding("utf8").on("data", value => { errorText += value; });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(errorText.trim() || "Could not read the staged conflict.")));
  });
  const collect = async () => {
    const result: string[] = [];
    let run = createHash("sha256");
    let first = "", last = "", length = 0;
    function flush() {
      if (!length) return;
      result.push(first);
      if (length > 2) result.push(run.digest("hex"));
      if (length > 1) result.push(last);
      run = createHash("sha256");
      length = 0;
    }
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (/^[<>=|]+(?:\s|$)/.test(line)) {
        flush();
        result.push(Buffer.from(line, "latin1").toString("utf8"));
      } else {
        const digest = createHash("sha256").update(line, "latin1").digest("hex");
        if (anchors?.has(digest)) {
          flush();
          result.push(digest);
          continue;
        }
        last = digest;
        if (!length) first = last;
        length++;
        run.update(last);
      }
    }
    flush();
    return result.join("\n");
  };
  const [text] = await Promise.all([collect(), completion]);
  return text;
}

async function fallbackMarkerLabels(repo: string, state: Awaited<ReturnType<typeof operationState>>) {
  const labels = new Set(["HEAD"]);
  if (state.operation === "rebase" && !state.mergeHead) {
    const { stdout } = await runGit(repo, ["show", "-s", "--format=%h%x00%s", state.replay]);
    const [short, subject] = stdout.trimEnd().split("\0");
    labels.add(subject);
    labels.add(`${short} (${subject})`);
    labels.add(state.applyPatch ? "constructed merge base" : `parent of ${short} (${subject})`);
  } else {
    // A recreated merge compares HEAD with MERGE_HEAD. The rebase's onto
    // commit can be a different ancestor from the one named by Git's diff3 output.
    const secondParent = state.mergeHead ?? state.target;
    labels.add(secondParent);
    const [{ stdout }, bases] = await Promise.all([
      runGit(repo, ["for-each-ref", "--format=%(refname)%00%(refname:short)", "--points-at", secondParent]),
      tryGit(repo, ["merge-base", "--all", state.head, secondParent])
    ]);
    for (const line of stdout.trimEnd().split(/\r?\n/).filter(Boolean)) {
      const [ref, short] = line.split("\0");
      labels.add(short);
      if (state.operation === "rebase" && ref.startsWith("refs/rewritten/")) {
        // The recursive strategy labels the side with its full rewritten ref.
        labels.add(ref);
        labels.add(ref.slice("refs/rewritten/".length));
      }
    }
    if (bases.code !== 0 && bases.code !== 1) throw new Error(bases.stderr.trim() || "Could not identify the merge base for conflict review.");
    if (bases.code === 1) labels.add("empty tree");
    if (bases.code === 0) {
      const ids = bases.stdout.trimEnd().split(/\r?\n/);
      const ancestor = ids.length === 1 ? (await runGit(repo, ["rev-parse", "--short", ids[0]])).stdout.trimEnd() : "merged common ancestors";
      labels.add(ancestor);
    }
  }
  return labels;
}

async function reviewMarkers(repo: string, file: string, candidate: Entry | { text: string }, stages: Map<number, Entry>, localSide: SyncConflictSide, incomingSide: SyncConflictSide, markerSize: number,
  state: Awaited<ReturnType<typeof operationState>>) {
  const staged = "oid" in candidate ? candidate : undefined;
  const preview = "text" in candidate ? { exists: true, text: candidate.text } : await side(repo, candidate);
  if (staged && preview.text !== null) {
    // A clean staged result is finished. An editable unmerged file still
    // needs original Git evidence to validate a later edit or clipboard paste.
    if (!/^[<>=|]+(?:\s|$)/m.test(preview.text)) return { unresolved: false };
  } else if (staged) {
    const found = await tryGit(repo, ["grep", "-I", "-q", "-E", "-e", "^[<>=|]+([[:space:]]|$)", staged.oid, "--"]);
    if (found.code === 1) return { unresolved: false };
    if (found.code !== 0) throw new Error(found.stderr.trim() || `Could not check the staged resolution of ${file}.`);
  }
  const saved = await tryGit(repo, ["rev-parse", "--verify", "--quiet", `AUTO_MERGE:${file}`]);
  const originalOid = saved.code === 0 && objectId.test(saved.stdout.trim()) ? saved.stdout.trim() : undefined;
  const originalSide = await side(repo, originalOid ? { oid: originalOid, mode: "100644", stage: 0 } : undefined);
  const previews = [preview, originalSide, localSide, incomingSide];
  const compact = previews.some(value => value.exists && value.text === null);
  const stageFor = conflictSides(state);
  const currentOid = stages.get(stageFor.local)?.oid;
  const incomingOid = stages.get(stageFor.incoming)?.oid;
  const versions = compact
    ? await Promise.all([staged ? compactMarkerText(repo, staged.oid) : preview.text, compactMarkerText(repo, originalOid),
      compactMarkerText(repo, currentOid), compactMarkerText(repo, incomingOid)])
    : previews.map(value => value.text);
  const original = versions[1];
  let [text, , current, incoming] = versions;
  if (compact && staged && !original && text && /^<+ /m.test(text) && /^<+ /m.test((current ?? "") + "\n" + (incoming ?? ""))) {
    // A saved tree normally identifies duplicate examples. Without one, keep
    // the lines bordering source markers wherever they recur inside a long
    // unmarked run, so an actual alternative can be compared with its example.
    const anchors = new Set<string>();
    for (const source of [current, incoming]) {
      const lines = source?.split("\n") ?? [];
      for (const [i, line] of lines.entries()) {
        if (!/^[<>=|]+(?:\s|$)/.test(line)) continue;
        for (const neighbor of [lines[i - 1], lines[i + 1]]) if (neighbor && /^[0-9a-f]{64}$/.test(neighbor)) anchors.add(neighbor);
      }
    }
    if (anchors.size) [text, current, incoming] = await Promise.all(
      [staged.oid, currentOid, incomingOid].map(oid => compactMarkerText(repo, oid, anchors)));
  }
  if (text === null) throw new Error(`Could not read the staged resolution of ${file}.`);
  const labels = original === null && current !== null && incoming !== null && current !== incoming
    ? await fallbackMarkerLabels(repo, state) : undefined;
  const evidence = markerEvidence(original ?? text, markerSize, { current, incoming }, labels);
  if (!staged) return { unresolved: true, evidence };
  const unresolved = hasConflictMarkers(text, markerSize, {
    path: file, local: { exists: current !== null, text: current }, incoming: { exists: incoming !== null, text: incoming },
    mergedText: original ?? text, ...evidence
  });
  return { unresolved, evidence };
}

function conflictSides(state: Awaited<ReturnType<typeof operationState>>) {
  // Only an ordinary replayed pick reverses the updated branch and local commit.
  return state.operation === "rebase" && !state.mergeHead ? { local: 3, incoming: 2 } : { local: 2, incoming: 3 };
}

async function snapshot(repo: string) {
  const state = await operationState(repo);
  const [{ stdout: index }, { stdout: undo }, { stdout: stagedNames }] = await Promise.all([
    runGit(repo, ["ls-files", "--stage", "-z"]), runGit(repo, ["ls-files", "--resolve-undo", "-z"]),
    runGit(repo, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=u", "--no-ext-diff", "--ignore-submodules=none", "HEAD", "--"])
  ]);
  const entries = parseConflicts(index);
  const resolved = parseConflicts(undo, true);
  const stagedCandidates = new Map<string, Entry>();
  for (const record of index.split("\0")) {
    const tab = record.indexOf("\t");
    const file = record.slice(tab + 1);
    const stages = resolved.get(file);
    if (!stages || entries.has(file)) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (stage !== "0" || !regularMode.test(mode) || [stages.get(2)?.oid, stages.get(3)?.oid].includes(oid)) continue;
    entries.set(file, stages);
    stagedCandidates.set(file, { mode, oid, stage: 0 });
  }
  const hash = createHash("sha256").update(JSON.stringify([repo, state])).update(index).update(undo);
  // A fetch can advance the same upstream without changing the merge already in progress.
  const draftOperation = createHash("sha256").update(JSON.stringify([repo, { ...state, upstreamId: undefined }]));
  const stageFor = conflictSides(state);
  let mergeParents: SyncConflictReview["mergeParents"];
  if (state.operation === "rebase" && state.mergeHead) {
    if (!objectId.test(state.mergeHead)) throw new Error("Resolve this multi-parent rebase step in Git.");
    const describe = async (oid: string) => (await runGit(repo, ["show", "-s", "--no-show-signature", "--format=%h %s", oid, "--"])).stdout.trimEnd();
    const [first, second] = await Promise.all([describe(state.head), describe(state.mergeHead)]);
    mergeParents = { first, second };
    draftOperation.update(JSON.stringify(mergeParents));
    hash.update(JSON.stringify(mergeParents));
  }
  const files: SyncConflictReview["files"] = [];
  const obsoletePaths: string[] = [];
  const guards = new Map<string, FileGuard>();
  for (const [file, stages] of entries) {
    const [local, incoming, { markerSize, encoding, attributes }] = await Promise.all([
      side(repo, stages.get(stageFor.local)), side(repo, stages.get(stageFor.incoming)), conflictAttributes(repo, file)
    ]);
    const staged = stagedCandidates.get(file);
    let markers = staged && await reviewMarkers(repo, file, staged, stages, local, incoming, markerSize, state);
    if (markers && !markers.unresolved) {
      entries.delete(file);
      continue;
    }
    const working = await workingFile(repo, file);
    const guard = { fingerprint: working.fingerprint, attributes };
    guards.set(file, guard);
    hash.update(JSON.stringify([file, guard]));
    if (!local.exists && !incoming.exists && working.fingerprint === "absent") {
      obsoletePaths.push(file);
      continue;
    }
    // Even an entirely ASCII preview may need a different working-tree encoding when a user types new text.
    const utf8 = encoding === "unspecified" || encoding === "unset" || /^utf-?8$/i.test(encoding);
    const editable = utf8 && [...stages.values()].every(entry => regularMode.test(entry.mode))
      && mergedFileMode(stages) !== undefined && (!local.exists || local.text !== null) && (!incoming.exists || incoming.text !== null);
    if (!staged && editable && working.text !== null) {
      markers = await reviewMarkers(repo, file, { text: working.text }, stages, local, incoming, markerSize, state);
    }
    const identity = draftOperation.copy().update(JSON.stringify([file, [...stages.values()], staged, guard, markers?.evidence])).digest("hex");
    hash.update(identity);
    files.push({ path: file, identity, local, incoming, mergedText: editable ? working.text : null, markerSize, ...markers?.evidence });
  }
  const canSkipEmptyPatch = entries.size === 0 && await emptyApplyPatch(repo, state, resolved);
  hash.update(JSON.stringify(canSkipEmptyPatch));
  // Resolve an ancestor .gitattributes before offering decisions whose filters or encoding it could change.
  const attributeFiles = files.filter(file => path.posix.basename(file.path) === ".gitattributes");
  const ready = files.filter(file => !attributeFiles.some(attr =>
    file !== attr && file.path.startsWith(attr.path.slice(0, -".gitattributes".length))));
  const stagedPaths = stagedNames.split("\0").filter(file => file && !entries.has(file));
  hash.update(JSON.stringify(stagedPaths));
  const review: SyncConflictReview = { operation: state.operation, mergeParents, token: hash.digest("hex"), files: ready, canSkipEmptyPatch,
    hasDeferredFiles: ready.length < files.length, stagedPaths };
  return { review, entries, index, guards, stageFor, state, obsoletePaths, stagedCandidates };
}

export async function inspectSyncConflicts(repoPath: string, rootPath: string): Promise<SyncConflictReview> {
  return (await snapshot(await validateRepositoryPath(repoPath, rootPath))).review;
}

function indexByPath(index: string) {
  const records = new Map<string, string>();
  for (const record of index.split("\0")) {
    if (!record) continue;
    const file = record.slice(record.indexOf("\t") + 1);
    records.set(file, (records.get(file) ?? "") + record + "\0");
  }
  return records;
}

async function verifyIndexPath(repo: string, file: string, expectedIndex: string | undefined) {
  const records = await runGit(repo, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file]);
  if (records.stdout !== (expectedIndex ?? "")) throw new Error(stale);
}

async function verifyReviewedPath(repo: string, file: string, guard: FileGuard, expectedIndex: string | undefined) {
  const [, effective] = await Promise.all([verifyIndexPath(repo, file, expectedIndex), conflictAttributes(repo, file)]);
  if (effective.attributes !== guard.attributes || (await workingFile(repo, file)).fingerprint !== guard.fingerprint) throw new Error(stale);
}

async function writeEdited(repo: string, file: string, text: string, verify: () => Promise<void>) {
  const absolute = await checkedWorkPath(repo, file);
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error(stale);
  // Replace this directory entry so a tracked hard link cannot modify another file.
  const temp = path.join(path.dirname(absolute), `.repo-radar-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", info.mode);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.chmod(info.mode);
    } finally {
      await handle.close();
    }
    // Store the reviewed bytes with Git's normal clean filters before replacing the working file.
    const blob = await runGit(repo, ["hash-object", "-w", `--path=${file}`, "--", temp]);
    await verify();
    await rename(temp, absolute);
    return blob.stdout.trimEnd();
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function applySyncConflicts(repoPath: string, rootPath: string, token: string, decisions: SyncDecision[], skipEmptyPatch = false): Promise<string> {
  const repo = await validateRepositoryPath(repoPath, rootPath);
  const { review, entries, index, guards, stageFor, state, obsoletePaths, stagedCandidates } = await snapshot(repo);
  const branch = state.branch.slice("refs/heads/".length);
  if (review.token !== token) throw new Error(stale);
  if (typeof skipEmptyPatch !== "boolean" || (skipEmptyPatch && !review.canSkipEmptyPatch)) {
    throw new Error("Review the empty rebase patch before skipping it.");
  }
  if (!Array.isArray(decisions) || decisions.length !== review.files.length) {
    throw new Error("Choose a resolution for every conflicted file.");
  }
  const byPath = new Map(decisions.map(decision => [decision?.path, decision]));
  for (const file of review.files) {
    const decision = byPath.get(file.path);
    if (!decision || !["local", "incoming", "edited"].includes(decision.choice)) throw new Error("Choose a resolution for every conflicted file.");
    if (decision.choice === "edited") {
      if (file.mergedText === null || typeof decision.text !== "string" || decision.text.includes("\0")
        || Buffer.byteLength(decision.text) > 4 * previewLimit) throw new Error(`Invalid edited text for ${file.path}.`);
      if (hasConflictMarkers(decision.text, file.markerSize, file)) {
        throw new Error(`Remove the conflict markers from ${file.path} before finishing.`);
      }
    }
  }
  const expected = indexByPath(index);
  if (decisions.length && !review.hasDeferredFiles) await assertNoReplayCollision(repo, state.pendingCommits, state.pendingTrees);
  try {
    for (const decision of decisions) {
      const file = decision.path;
      const verify = () => verifyReviewedPath(repo, file, guards.get(file)!, expected.get(file));
      if (decision.choice === "edited") {
        const oid = await writeEdited(repo, file, decision.text, verify);
        const mode = mergedFileMode(entries.get(file)!)!;
        await verifyIndexPath(repo, file, expected.get(file));
        await runGit(repo, ["update-index", "--add", "--cacheinfo", mode, oid, file]);
        expected.set(file, `${mode} ${oid} 0\t${file}\0`);
        continue;
      }
      await verify();
      const entry = entries.get(file)?.get(stageFor[decision.choice]);
      if (!entry) {
        await runGit(repo, ["--literal-pathspecs", "rm", "--force", "--", file]);
        expected.delete(file);
        continue;
      }
      const chosenRecord = `${entry.mode} ${entry.oid} 0\t${file}\0`;
      const previouslyStaged = stagedCandidates.get(file);
      if (previouslyStaged) {
        // The conflict stages exist only in Git's undo data. Materialize the chosen exact blob from stage zero.
        await runGit(repo, ["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, file]);
        try {
          await verifyReviewedPath(repo, file, guards.get(file)!, chosenRecord);
          await runGit(repo, ["--literal-pathspecs", "checkout-index", "--force", "--", file]);
        } catch (error) {
          const current = await runGit(repo, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file]);
          if (current.stdout === chosenRecord) {
            await runGit(repo, ["update-index", "--add", "--cacheinfo", previouslyStaged.mode, previouslyStaged.oid, file]);
          }
          throw error;
        }
      } else {
        await runGit(repo, ["--literal-pathspecs", "checkout-index", "--force", `--stage=${entry.stage}`, "--", file]);
        // Stage exactly the selected blob and executable/symlink mode, including binary files.
        await verifyIndexPath(repo, file, expected.get(file));
        await runGit(repo, ["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, file]);
      }
      expected.set(file, chosenRecord);
    }
    for (const file of obsoletePaths) {
      await verifyReviewedPath(repo, file, guards.get(file)!, expected.get(file));
      await runGit(repo, ["--literal-pathspecs", "rm", "--cached", "--force", "--", file]);
      expected.delete(file);
    }
    const current = await operationState(repo);
    if (JSON.stringify(current) !== JSON.stringify(state)) throw new Error(stale);
    let empty = false;
    if (current.applyPatch && !review.hasDeferredFiles) {
      const undo = await runGit(repo, ["ls-files", "--resolve-undo", "-z"]);
      empty = await emptyApplyPatch(repo, current, parseConflicts(undo.stdout, true));
      if (skipEmptyPatch && !empty) throw new Error(stale);
    }
    for (const { path: file } of decisions) {
      // Resolving .gitattributes can intentionally change how Git treats that file itself.
      if (path.posix.basename(file) !== ".gitattributes" && (await conflictAttributes(repo, file)).attributes !== guards.get(file)!.attributes) {
        throw new Error(stale);
      }
    }
    const continuing = !review.hasDeferredFiles && (!empty || skipEmptyPatch);
    if (continuing) await assertNoReplayCollision(repo, current.pendingCommits, current.pendingTrees);
    const actual = indexByPath((await runGit(repo, ["ls-files", "--stage", "-z"])).stdout);
    if (actual.size !== expected.size || [...expected].some(([file, records]) => actual.get(file) !== records)) throw new Error(stale);
    if (!continuing) return branch;
    const result = await tryGit(repo, [review.operation, skipEmptyPatch ? "--skip" : "--continue"], 60000, { GIT_EDITOR: ":" });
    if (result.code !== 0) {
      if (review.operation === "rebase" && (await runGit(repo, ["ls-files", "-u", "-z"])).stdout) {
        const next = await tryGit(repo, ["rev-parse", "--verify", "REBASE_HEAD"]);
        if (next.code === 0 && next.stdout.trim() !== state.replay) return branch;
      }
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Git could not finish the operation.");
    }
  } catch (error) {
    if (error instanceof GitCommandError) throw new Error(error.result.stderr.trim() || error.message);
    throw error;
  }
  return branch;
}
