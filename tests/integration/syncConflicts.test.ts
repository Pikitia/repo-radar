// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitAndSync, finishSync, sync } from "../../electron/git/actions.js";
import { runGit, tryGit } from "../../electron/git/exec.js";
import { parsePorcelainV2 } from "../../electron/git/status.js";
import { inspectSyncConflicts } from "../../electron/git/syncConflicts.js";
import { defaultSettings } from "../../src/types/settings.js";

type Changes = Record<string, string | Buffer | null>;
const mergeSettings = { ...defaultSettings, pullStrategy: "merge" as const };
let root: string;
let local: string;
let other: string;
let remote: string;

async function git(repo: string, ...args: string[]) {
  const result = await tryGit(repo, args);
  if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trimEnd();
}

async function commitFiles(repo: string, subject: string, changes: Changes) {
  for (const [name, contents] of Object.entries(changes)) {
    const file = path.join(repo, name);
    if (contents === null) await rm(file);
    else await writeFile(file, contents);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

async function createClones(base: Changes) {
  await git(root, "init", "--bare", "-b", "main", remote);
  await git(root, "clone", remote, local);
  await commitFiles(local, "Common base", base);
  await git(local, "push", "-u", "origin", "main");
  await git(root, "clone", remote, other);
}

async function diverge(localFiles: Changes, otherFiles: Changes) {
  const localTip = await commitFiles(local, "This machine", localFiles);
  const remoteTip = await commitFiles(other, "Other machine", otherFiles);
  await git(other, "push");
  return { localTip, remoteTip };
}

describe("guided sync between two machines", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-conflicts-"));
    remote = path.join(root, "remote.git");
    local = path.join(root, "first");
    other = path.join(root, "second");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "gitconfig"));
    await writeFile(path.join(root, "gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.test\n[core]\n\tautocrlf = false\n");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function publishFirstRemoteCommit() {
    await git(root, "init", "--bare", "-b", "main", remote);
    await git(root, "clone", remote, local);
    await git(root, "clone", remote, other);
    const first = await commitFiles(other, "First commit from the other machine", { "guide.md": "remote guide" });
    await git(other, "push", "-u", "origin", "main");
    return first;
  }

  it.each(["ahead", "behind"])("stops before fetch or push with multiple configured merge heads (%s)", async direction => {
    await createClones({ guide: "base" });
    await git(other, "switch", "-c", "topic");
    await commitFiles(other, "Second pull head", { topic: "topic" });
    await git(other, "push", "origin", "topic");
    await git(other, "switch", "main");
    if (direction === "ahead") await commitFiles(local, "Local work", { local: "local" });
    else {
      await commitFiles(other, "Incoming work", { incoming: "incoming" });
      await git(other, "push");
    }
    await git(local, "config", "--add", "branch.main.merge", "refs/heads/topic");
    const localRefs = await git(local, "show-ref");
    const remoteRefs = await git(remote, "show-ref");
    await expect(sync(local, root, mergeSettings, "main")).rejects.toThrow(/pull multiple branches.*in Git/);
    expect(await git(local, "show-ref")).toBe(localRefs);
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await git(local, "status", "--porcelain")).toBe("");
  });

  it("preserves both clones and local branch pointers when an automatic ref-updating rebase would be needed", async () => {
    await createClones({ guide: "base" });
    const { localTip, remoteTip } = await diverge({ guide: "local" }, { guide: "remote" });
    await git(local, "branch", "checkpoint");
    const tip = await commitFiles(local, "Next change", { next: "local next" });
    await git(local, "config", "pull.rebase", "true");
    await git(local, "config", "rebase.updateRefs", "true");
    await expect(sync(local, root, defaultSettings, "main")).rejects.toThrow(/rebase.updateRefs.*in Git/);
    expect(await git(local, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(local, "rev-parse", "checkpoint")).toBe(localTip);
    expect(await git(local, "status", "--porcelain")).toBe("");
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);

    // A rebase already started outside Repo Radar must retain its plan and conflict stages.
    expect((await tryGit(local, ["rebase", "origin/main"])).code).toBe(1);
    const index = await git(local, "ls-files", "--stage");
    const todoPath = path.join(local, ".git", "rebase-merge", "git-rebase-todo");
    const todo = await readFile(todoPath, "utf8");
    expect(todo).toContain("update-ref refs/heads/checkpoint");
    await expect(inspectSyncConflicts(local, root)).rejects.toThrow(/rebase.updateRefs.*in Git/);
    expect(await readFile(todoPath, "utf8")).toBe(todo);
    expect(await git(local, "ls-files", "--stage")).toBe(index);
  });

  it.each(["multiple heads", "rebase.updateRefs"])("rechecks %s before saving files from an open Sync prompt", async policy => {
    await createClones({ guide: "base" });
    const original = await git(local, "rev-parse", "HEAD");
    const remoteTip = await commitFiles(other, "Incoming", { guide: "incoming" });
    await git(other, "push");
    await writeFile(path.join(local, "guide"), "my unstaged work");
    const settings = { ...defaultSettings, pullStrategy: "rebase" as const };
    const prompt = await sync(local, root, settings, "main");
    expect(prompt.syncCommitGuard).toBeDefined();
    if (policy === "multiple heads") await git(local, "config", "--add", "branch.main.merge", "refs/heads/topic");
    else await git(local, "config", "rebase.updateRefs", "true");
    await expect(commitAndSync(local, root, settings, prompt.syncCommitGuard!, ["guide"], "My edits")).rejects.toThrow(/in Git/);
    expect(await git(local, "rev-parse", "HEAD")).toBe(original);
    expect(await git(local, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(path.join(local, "guide"), "utf8")).toBe("my unstaged work");
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
  });

  it("allows a clean fast-forward with automatic rebase ref updates configured", async () => {
    await createClones({ guide: "base" });
    const original = await git(local, "rev-parse", "HEAD");
    await git(local, "branch", "checkpoint");
    await git(local, "config", "pull.rebase", "true");
    await git(local, "config", "rebase.updateRefs", "true");
    const incoming = await commitFiles(other, "Peer edit", { guide: "incoming" });
    await git(other, "push");
    const result = await sync(local, root, defaultSettings, "main");
    expect(result.errors).toEqual([]);
    expect(await git(local, "rev-parse", "HEAD")).toBe(incoming);
    expect(await git(local, "rev-parse", "checkpoint")).toBe(original);
  });

  it("checks out the first upstream commit and preserves unrelated staged and untracked files", async () => {
    const first = await publishFirstRemoteCommit();
    await writeFile(path.join(local, "staged.txt"), "local staging");
    await git(local, "add", "staged.txt");
    await writeFile(path.join(local, "private.txt"), "local only");
    const result = await sync(local, root, { ...defaultSettings, pullStrategy: "rebase" }, "main");
    expect(result).toMatchObject({ branch: "main", isUnborn: false, ahead: 0, behind: 0, errors: [] });
    expect(await git(local, "rev-parse", "HEAD")).toBe(first);
    expect(await readFile(path.join(local, "guide.md"), "utf8")).toBe("remote guide");
    expect(await git(local, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(await readFile(path.join(local, "private.txt"), "utf8")).toBe("local only");
  });

  it.each(["merge", "rebase"] as const)("guides an overlapping first checkout through a reviewed %s", async pullStrategy => {
    await publishFirstRemoteCommit();
    await writeFile(path.join(local, "guide.md"), "my guide");
    const settings = { ...defaultSettings, pullStrategy };
    const prompt = await sync(local, root, settings, "main");
    expect(prompt.isUnborn).toBe(true);
    expect(prompt.syncCommitGuard?.branch).toBe("main");
    const paused = await commitAndSync(local, root, settings, prompt.syncCommitGuard!, ["guide.md"], "Preserve my first local guide");
    expect(paused.conflicts).toEqual(["guide.md"]);
    const review = await inspectSyncConflicts(local, root);
    expect(review.operation).toBe(pullStrategy);
    await finishSync(local, root, review.token, [{ path: "guide.md", choice: "edited", text: "both guides\n" }]);
    expect(await git(remote, "show", "main:guide.md")).toBe("both guides");
    expect(await git(local, "rev-parse", "HEAD")).toBe(await git(remote, "rev-parse", "main"));
  });

  it.each([["pull.ff", "only"], ["merge.ff", "only"], ["branch.main.mergeOptions", "--no-ff --ff-only"]])(
    "retains a recoverable first save under %s fast-forward-only policy", async (key, value) => {
      await publishFirstRemoteCommit();
      await git(local, "config", key, value);
      await writeFile(path.join(local, "guide.md"), "local guide");
      const prompt = await sync(local, root, defaultSettings, "main");
      const blocked = await commitAndSync(local, root, defaultSettings, prompt.syncCommitGuard!, ["guide.md"], "Keep my guide");
      expect(blocked.isUnborn).toBe(true);
      expect(blocked.syncCommitRequired).toContain("fast-forward-only");
      expect(await git(local, "show", ":guide.md")).toBe("local guide");
      expect((await tryGit(local, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).toBe(1);
      const retrySettings = key === "pull.ff" ? mergeSettings : defaultSettings;
      if (key !== "pull.ff") await git(local, "config", "--unset", key);
      const reopened = await sync(local, root, retrySettings, "main");
      const paused = await commitAndSync(local, root, retrySettings, reopened.syncCommitGuard!, [], "Keep my guide");
      expect(paused.conflicts).toEqual(["guide.md"]);
      const review = await inspectSyncConflicts(local, root);
      await finishSync(local, root, review.token, [{ path: "guide.md", choice: "local" }]);
      expect(await git(remote, "show", "main:guide.md")).toBe("local guide");
    });

  it.each(["merge", "rebase"] as const)("keeps a first %s checkout recoverable when overlapping files are selected separately", async pullStrategy => {
    await publishFirstRemoteCommit();
    await commitFiles(other, "Add another guide", { "notes.md": "upstream notes" });
    await git(other, "push");
    await writeFile(path.join(local, "guide.md"), "local guide");
    await writeFile(path.join(local, "notes.md"), "local notes");
    await writeFile(path.join(local, "private.md"), "unrelated draft");
    const settings = { ...defaultSettings, pullStrategy };
    const first = await sync(local, root, settings, "main");
    const partial = await commitAndSync(local, root, settings, first.syncCommitGuard!, ["guide.md"], "Save selected guides");
    expect(partial.isUnborn).toBe(true);
    expect(partial.syncCommitRequired).toContain("notes.md");
    expect(partial.syncCommitRequired).not.toContain("private.md");
    expect(await git(local, "diff", "--cached", "--name-only")).toBe("guide.md");
    // Closing the dialog and starting Sync again can recover directly from Git's index.
    const reopened = await sync(local, root, settings, "main");
    const paused = await commitAndSync(local, root, settings, reopened.syncCommitGuard!, ["notes.md"], "Save both guides");
    expect(paused.conflicts.sort()).toEqual(["guide.md", "notes.md"]);
    const review = await inspectSyncConflicts(local, root);
    await finishSync(local, root, review.token, review.files.map(file => ({ path: file.path, choice: "local" })));
    expect(await git(remote, "show", "main:guide.md")).toBe("local guide");
    expect(await git(remote, "show", "main:notes.md")).toBe("local notes");
    expect(await git(local, "status", "--porcelain")).toBe("?? private.md");
  });

  it.each(["staged", "unstaged"] as const)("requires review of unrelated %s edits for a behind-only rebase and preserves untracked files", async kind => {
    await createClones({ "local-note": "base" });
    const original = await git(local, "rev-parse", "HEAD");
    const incoming = await commitFiles(other, "New remote file", { incoming: "new" });
    await git(other, "push");
    await writeFile(path.join(local, "local-note"), "my edit");
    if (kind === "staged") await git(local, "add", "--", "local-note");
    await writeFile(path.join(local, "untracked-note"), "my draft");
    const settings = { ...defaultSettings, pullStrategy: "rebase" as const };
    const prompt = await sync(local, root, settings, "main");
    expect(prompt.syncCommitGuard?.branch).toBe("main");
    expect(prompt.syncCommitRequired).toMatch(/clean working tree/i);
    expect(await git(local, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(path.join(local, "local-note"), "utf8")).toBe("my edit");
    expect(await git(local, "diff", "--name-only", "--cached")).toBe(kind === "staged" ? "local-note" : "");
    await git(local, "restore", "--staged", "--worktree", "--", "local-note");
    const synced = await sync(local, root, settings, "main");
    expect(synced).toMatchObject({ ahead: 0, behind: 0, errors: [] });
    expect(await git(local, "rev-parse", "HEAD")).toBe(incoming);
    expect(await readFile(path.join(local, "untracked-note"), "utf8")).toBe("my draft");
  });

  it("pauses before a fast-forward overwrites an ignored file and resumes after it is moved", async () => {
    await createClones({ "guide.md": "base" });
    const original = await git(local, "rev-parse", "HEAD");
    const incoming = await commitFiles(other, "Add default settings", { "local.env": "upstream settings" });
    await git(other, "push");
    await writeFile(path.join(local, ".git", "info", "exclude"), "local.env\n");
    await writeFile(path.join(local, "local.env"), "my private settings");
    await expect(sync(local, root, mergeSettings, "main")).rejects.toThrow(/ignored local data.*local\.env/);
    expect(await git(local, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(path.join(local, "local.env"), "utf8")).toBe("my private settings");
    await rename(path.join(local, "local.env"), path.join(root, "saved.env"));
    expect((await sync(local, root, mergeSettings, "main")).errors).toEqual([]);
    expect(await git(local, "rev-parse", "HEAD")).toBe(incoming);
    expect(await readFile(path.join(local, "local.env"), "utf8")).toBe("upstream settings");
    expect(await readFile(path.join(root, "saved.env"), "utf8")).toBe("my private settings");
  });

  it("offers to save local files when upstream replaces their directory with a file", async () => {
    await createClones({ "base.txt": "base" });
    await mkdir(path.join(local, "notes"));
    await commitFiles(local, "Tracked directory", { "notes/tracked.txt": "tracked" });
    await git(local, "push");
    await git(other, "pull", "--ff-only");
    await git(other, "rm", "-r", "notes");
    await commitFiles(other, "Replace directory", { notes: "incoming file" });
    await git(other, "push");
    await writeFile(path.join(local, "notes", "draft.txt"), "my draft");
    const prompt = await sync(local, root, mergeSettings, "main");
    expect(prompt.syncCommitRequired).toMatch(/lose untracked files/i);
    expect(await readFile(path.join(local, "notes", "draft.txt"), "utf8")).toBe("my draft");
    const paused = await commitAndSync(local, root, mergeSettings, prompt.syncCommitGuard!, ["notes/draft.txt"], "Keep draft");
    expect(paused.conflicts.length).toBeGreaterThan(0);
    const review = await inspectSyncConflicts(local, root);
    // Keep the local directory, including the selected file, at its original path.
    await finishSync(local, root, review.token, review.files.map(file => ({ path: file.path, choice: "local" })));
    expect(await git(remote, "show", "main:notes/draft.txt")).toBe("my draft");
    expect(await git(local, "status", "--porcelain")).toBe("");
  });

  it("presents both versions and pushes the reviewed text with both histories and the automatically merged lines", async () => {
    const file = "plan.md";
    const unchanged = "one\ntwo\nthree\nfour\nfive\nsix\n";
    const doc = (first: string, middle: string, last: string) => `${first}\n${unchanged}${middle}\n${unchanged}${last}\n`;
    const localDoc = doc("Local heading", "Local note", "Original ending");
    const incomingDoc = doc("Original heading", "Remote note", "Remote ending");
    await createClones({ [file]: doc("Original heading", "Original note", "Original ending") });
    const { localTip, remoteTip } = await diverge({ [file]: localDoc }, { [file]: incomingDoc });

    // The default setting must also handle a machine with no configured pull policy.
    const paused = await sync(local, root, defaultSettings, "main");
    expect(paused.conflicts).toEqual([file]);
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
    const review = await inspectSyncConflicts(local, root);
    expect(review.operation).toBe("merge");
    expect(review.files).toHaveLength(1);
    const conflict = review.files[0];
    expect(conflict).toMatchObject({ path: file, local: { exists: true, text: localDoc }, incoming: { exists: true, text: incomingDoc } });
    expect(conflict.mergedText).toContain("<<<<<<<");
    expect(conflict.mergedText).toContain("Local heading");
    expect(conflict.mergedText).toContain("Remote ending");

    const combined = doc("Local heading", "Local note and remote note", "Remote ending");
    const decisions = [{ path: file, choice: "edited" as const, text: combined }];
    const complete = await finishSync(local, root, review.token, decisions);
    expect(complete).toMatchObject({ ahead: 0, behind: 0, conflicts: [], files: [], errors: [] });
    expect(await git(remote, "show", "-s", "--format=%P", "main")).toBe(`${localTip} ${remoteTip}`);
    expect((await runGit(remote, ["show", `main:${file}`])).stdout).toBe(combined);
    const finishedHead = await git(local, "rev-parse", "HEAD");
    await expect(finishSync(local, root, review.token, decisions)).rejects.toThrow();
    expect(await git(remote, "rev-parse", "main")).toBe(finishedHead);
  });

  it("applies deletion and binary decisions to literal paths after validating the entire review", async () => {
    const removed = "draft [ab].txt";
    const decoy = "draft a.txt";
    const binary = "shape.bin";
    const bytes = Buffer.from([255, 0, 70, 81]);
    await createClones({ [removed]: "base", [decoy]: "untouched", [binary]: Buffer.from([0, 129]) });
    await diverge({ [removed]: null, [binary]: Buffer.from([0, 192]) }, { [removed]: "remote edit", [binary]: bytes });
    await sync(local, root, mergeSettings, "main");
    const review = await inspectSyncConflicts(local, root);
    expect(review.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: removed, local: { exists: false, text: null }, incoming: { exists: true, text: "remote edit" } }),
      expect.objectContaining({ path: binary, local: { exists: true, text: null }, incoming: { exists: true, text: null }, mergedText: null })
    ]));
    const existingIndex = await git(local, "ls-files", "--stage");
    const remove = { path: removed, choice: "local" as const };
    await expect(inspectSyncConflicts(local, other)).rejects.toThrow();
    await expect(finishSync(local, other, review.token, [remove, { path: binary, choice: "incoming" }])).rejects.toThrow();
    await expect(finishSync(local, root, review.token, [remove])).rejects.toThrow();
    await expect(finishSync(local, root, review.token, [remove, { path: "../second/shape.bin", choice: "incoming" }])).rejects.toThrow();
    expect(await git(local, "ls-files", "--stage")).toBe(existingIndex);
    expect(await readFile(path.join(local, removed), "utf8")).toBe("remote edit");
    await finishSync(local, root, review.token, [remove, { path: binary, choice: "incoming" }]);
    expect(await readFile(path.join(local, binary))).toEqual(bytes);
    expect(await readFile(path.join(local, decoy), "utf8")).toBe("untouched");
    expect(await git(remote, "ls-tree", "--name-only", "main")).toBe([decoy, binary].join("\n"));
  });

  it("requires a fresh review after a file changes and resumes an externally staged resolution", async () => {
    await createClones({ "notes.txt": "base" });
    const { remoteTip } = await diverge({ "notes.txt": "local" }, { "notes.txt": "remote" });
    await sync(local, root, mergeSettings, "main");
    const initial = await inspectSyncConflicts(local, root);
    const file = path.join(local, "notes.txt");
    await writeFile(file, "edited by a person outside Repo Radar");
    await expect(finishSync(local, root, initial.token, [{ path: "notes.txt", choice: "incoming" }])).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("edited by a person outside Repo Radar");
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
    await git(local, "add", "--", "notes.txt");
    const staged = await inspectSyncConflicts(local, root);
    expect(staged.files).toEqual([]);
    await finishSync(local, root, staged.token, []);
    expect(await git(remote, "show", "main:notes.txt")).toBe("edited by a person outside Repo Radar");
  });

  it("labels the replayed local and incoming versions correctly through two rebased commits", async () => {
    await createClones({ "one.txt": "base one", "two.txt": "base two" });
    const { remoteTip } = await diverge({ "one.txt": "local one" }, { "one.txt": "remote one", "two.txt": "remote two" });
    await commitFiles(local, "Second local change", { "two.txt": "local two" });
    await sync(local, root, { ...defaultSettings, pullStrategy: "rebase" }, "main");
    const first = await inspectSyncConflicts(local, root);
    expect(first.operation).toBe("rebase");
    expect(first.files).toMatchObject([{ path: "one.txt", local: { text: "local one" }, incoming: { text: "remote one" } }]);
    const paused = await finishSync(local, root, first.token, [{ path: "one.txt", choice: "local" }]);
    expect(paused.conflicts).toEqual(["two.txt"]);
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
    const second = await inspectSyncConflicts(local, root);
    expect(second.files).toMatchObject([{ path: "two.txt", local: { text: "local two" }, incoming: { text: "remote two" } }]);
    const complete = await finishSync(local, root, second.token, [{ path: "two.txt", choice: "edited", text: "both two" }]);
    expect(complete).toMatchObject({ branch: "main", ahead: 0, behind: 0, errors: [] });
    expect(await git(remote, "rev-parse", "main~2")).toBe(remoteTip);
    expect(await git(remote, "show", "main:one.txt")).toBe("local one");
    expect(await git(remote, "show", "main:two.txt")).toBe("both two");
  });

  it("retains the local resolution and a newer remote commit when the final push is rejected", async () => {
    await createClones({ "notes.txt": "base" });
    const { localTip, remoteTip } = await diverge({ "notes.txt": "local" }, { "notes.txt": "remote" });
    await sync(local, root, mergeSettings, "main");
    const review = await inspectSyncConflicts(local, root);
    const newestRemote = await commitFiles(other, "Another edit while reviewing", { "later.txt": "later" });
    await git(other, "push");
    await expect(finishSync(local, root, review.token, [{ path: "notes.txt", choice: "local" }])).rejects.toThrow();
    expect(await git(local, "show", "-s", "--format=%P", "HEAD")).toBe(`${localTip} ${remoteTip}`);
    expect(await git(remote, "rev-parse", "main")).toBe(newestRemote);
    expect((await sync(local, root, mergeSettings, "main")).errors).toEqual([]);
    expect(await git(remote, "show", "main:notes.txt")).toBe("local");
    expect(await git(remote, "show", "main:later.txt")).toBe("later");
    expect(await git(local, "rev-parse", "HEAD")).toBe(await git(remote, "rev-parse", "main"));
  });

  it("offers a commit first when incoming changes overlap an uncommitted file and syncs only the chosen work", async () => {
    await createClones({ "notes.txt": "base" });
    const latest = await commitFiles(other, "Other machine", { "notes.txt": "changed" });
    await git(other, "push");
    await writeFile(path.join(local, "notes.txt"), "uncommitted");
    await writeFile(path.join(local, "unrelated.txt"), "leave this on the first machine");
    const paused = await sync(local, root, mergeSettings, "main");
    expect(paused.syncCommitRequired).toEqual(expect.any(String));
    expect(paused).toMatchObject({ hasStagedChanges: false, hasUnstagedChanges: true, hasUntrackedFiles: true, conflicts: [] });
    expect(await readFile(path.join(local, "notes.txt"), "utf8")).toBe("uncommitted");
    await expect(inspectSyncConflicts(local, root)).rejects.toThrow();
    expect(await git(remote, "rev-parse", "main")).toBe(latest);
    const conflict = await commitAndSync(local, root, mergeSettings, paused.syncCommitGuard!, ["notes.txt"], "Keep my notes");
    expect(conflict.conflicts).toEqual(["notes.txt"]);
    const review = await inspectSyncConflicts(local, root);
    expect(review.files[0]).toMatchObject({ local: { text: "uncommitted" }, incoming: { text: "changed" } });
    const complete = await finishSync(local, root, review.token, [{ path: "notes.txt", choice: "local" }]);
    expect(complete).toMatchObject({ errors: [], ahead: 0, behind: 0, hasUntrackedFiles: true });
    expect(await git(remote, "ls-tree", "--name-only", "main")).toBe("notes.txt");
    expect(await git(remote, "show", "main:notes.txt")).toBe("uncommitted");
    expect(await readFile(path.join(local, "unrelated.txt"), "utf8")).toBe("leave this on the first machine");
  });

  it("syncs only the branch shown when Sync was clicked", async () => {
    await createClones({ "notes.txt": "base" });
    const base = await git(local, "rev-parse", "main");
    await git(local, "switch", "-c", "develop");
    await git(local, "push", "-u", "origin", "develop");
    const unpublished = await commitFiles(local, "Develop only", { "develop.txt": "develop" });
    await commitFiles(other, "Update main", { "notes.txt": "new main" });
    await git(other, "push");

    for (const stale of ["main", ""]) {
      await expect(sync(local, root, mergeSettings, stale)).rejects.toThrow(/checked-out branch changed/);
    }
    expect(await git(remote, "rev-parse", "develop")).toBe(base);
    expect(await git(local, "rev-parse", "origin/main")).toBe(base);
    expect(await git(local, "rev-parse", "HEAD")).toBe(unpublished);
    await sync(local, root, mergeSettings, "develop");
    expect(await git(remote, "rev-parse", "develop")).toBe(unpublished);
  });

  it.each([false, true])("stages a file replaced by a directory with a selected child = %s", async includeChild => {
    await createClones({ notes: "base", "overlap.txt": "base" });
    await commitFiles(other, "Remote change", { "overlap.txt": "remote" });
    await git(other, "push");
    await writeFile(path.join(local, "overlap.txt"), "local");
    await writeFile(path.join(local, "notes"), "partially staged");
    await git(local, "add", "notes");
    await rm(path.join(local, "notes"));
    await mkdir(path.join(local, "notes"));
    await writeFile(path.join(local, "notes", "local-only.txt"), "private");
    await writeFile(path.join(local, "notes", "reviewed.txt"), "reviewed");
    const prompt = await sync(local, root, mergeSettings, "main");
    const guard = prompt.syncCommitGuard!;
    // A child alone would require deleting the unselected index entry.
    const priorIndex = await git(local, "ls-files", "--stage");
    await expect(commitAndSync(local, root, mergeSettings, guard, ["notes/reviewed.txt"], "Child alone")).rejects.toThrow();
    expect(await git(local, "ls-files", "--stage")).toBe(priorIndex);

    const paths = includeChild ? ["notes/reviewed.txt", "notes"] : ["notes"];
    const next = await commitAndSync(local, root, mergeSettings, guard, paths, "Reviewed paths");
    expect(next.syncCommitRequired).toBeTruthy();
    const expectedTree = includeChild ? "notes/reviewed.txt\noverlap.txt" : "overlap.txt";
    expect(await git(local, "ls-tree", "-r", "--name-only", "HEAD")).toBe(expectedTree);
    expect(await git(local, "ls-files")).toBe(expectedTree);
    expect(await readFile(path.join(local, "notes", "local-only.txt"), "utf8")).toBe("private");
    expect(await readFile(path.join(local, "notes", "reviewed.txt"), "utf8")).toBe("reviewed");
  });

  it("refuses a selected embedded repository before committing other staged files", async () => {
    await createClones({ "notes.txt": "base" });
    const base = await git(local, "rev-parse", "HEAD");
    await commitFiles(other, "Incoming notes", { "notes.txt": "incoming" });
    await git(other, "push");
    await writeFile(path.join(local, "notes.txt"), "local notes");
    await git(local, "add", "notes.txt");
    await writeFile(path.join(local, "extra.txt"), "optional");
    await git(local, "init", "-b", "main", "nested");
    const nested = path.join(local, "nested");
    const nestedTip = await commitFiles(nested, "Embedded project", { "private.txt": "private" });
    const prompt = await sync(local, root, mergeSettings, "main");
    expect(prompt.files).toContainEqual(expect.objectContaining({ path: "nested/", untracked: true }));
    const before = await git(local, "ls-files", "--stage");
    await expect(commitAndSync(local, root, mergeSettings, prompt.syncCommitGuard!, ["extra.txt", "nested/"], "Selected work"))
      .rejects.toThrow(/nested repository nested\//);
    expect(await git(local, "ls-files", "--stage")).toBe(before);
    expect(await git(local, "rev-parse", "HEAD")).toBe(base);
    expect(await git(nested, "rev-parse", "HEAD")).toBe(nestedTip);
    const paused = await commitAndSync(local, root, mergeSettings, prompt.syncCommitGuard!, [], "Save just my notes");
    expect(paused.conflicts).toEqual(["notes.txt"]);
    expect(await git(local, "ls-tree", "--name-only", "HEAD")).toBe("notes.txt");
  });

  it.each([false, true])("saves a tracked submodule commit while preserving edits inside it (already staged: %s)", async (alreadyStaged) => {
    await createClones({ "notes.txt": "base" });
    const source = path.join(root, "child-source");
    const child = path.join(local, "child");
    await git(root, "init", "-b", "main", source);
    await commitFiles(source, "Initial component", { "component.txt": "base component" });
    await git(local, "-c", "protocol.file.allow=always", "submodule", "add", source, "child");
    await git(local, "commit", "-m", "Track child");
    await git(local, "push");
    await git(other, "pull", "--ff-only");
    await commitFiles(other, "Incoming notes", { "notes.txt": "incoming" });
    await git(other, "push");
    await writeFile(path.join(local, "notes.txt"), "local notes");

    const childStatus = async () => parsePorcelainV2(await git(local, "status", "--porcelain=v2", "-z")).files.find(file => file.path === "child");
    const saved = path.join(root, "saved-child");
    await rename(child, saved);
    expect(await childStatus()).toMatchObject({ kind: "deleted", unstaged: true, submoduleChange: undefined });
    await writeFile(child, "regular file in place of the submodule");
    expect(await childStatus()).toMatchObject({ unstaged: true, submoduleChange: undefined });
    await rm(child);
    await rename(saved, child);

    await writeFile(path.join(child, "untracked.txt"), "private");
    const first = await sync(local, root, mergeSettings, "main");
    expect(first.files.find(file => file.path === "child")).toMatchObject({ submoduleChange: "contents", staged: false, unstaged: true });
    const before = await git(local, "ls-files", "--stage");
    await expect(commitAndSync(local, root, mergeSettings, first.syncCommitGuard!, ["notes.txt", "child"], "Save both"))
      .rejects.toThrow(/inside the submodule child/);
    expect(await git(local, "ls-files", "--stage")).toBe(before);

    await rm(path.join(child, "untracked.txt"));
    const tip = await commitFiles(child, "New component", { "component.txt": "updated component" });
    expect(await childStatus()).toMatchObject({ submoduleChange: "commit", staged: false, unstaged: true });
    if (alreadyStaged) await git(local, "add", "child");
    await writeFile(path.join(child, "component.txt"), "additional uncommitted edit");
    const prompt = await sync(local, root, mergeSettings, "main");
    expect(prompt.files.find(file => file.path === "child")).toMatchObject({
      submoduleChange: alreadyStaged ? "contents" : "commit-and-contents", staged: alreadyStaged, unstaged: true
    });
    const selection = alreadyStaged ? ["notes.txt"] : ["notes.txt", "child"];
    const paused = await commitAndSync(local, root, mergeSettings, prompt.syncCommitGuard!, selection, "Save notes and child commit");
    expect(paused.conflicts).toEqual(["notes.txt"]);
    expect(await git(local, "rev-parse", "HEAD:child")).toBe(tip);
    expect(await git(child, "status", "--porcelain")).toBe(" M component.txt");
    expect(await readFile(path.join(child, "component.txt"), "utf8")).toBe("additional uncommitted edit");
  });

  it("requires a new review after a branch switch, HEAD change or newly staged work", async () => {
    await createClones({ "notes.txt": "base" });
    const remoteTip = await commitFiles(other, "Remote change", { "notes.txt": "remote" });
    await git(other, "push");
    await writeFile(path.join(local, "notes.txt"), "working copy");
    const prompt = await sync(local, root, mergeSettings, "main");
    const expected = prompt.syncCommitGuard!;
    const submit = () => commitAndSync(local, root, mergeSettings, expected, ["notes.txt"], "Reviewed on main");
    await git(local, "switch", "-c", "develop");
    await git(local, "branch", "--set-upstream-to=origin/main");
    const before = await git(local, "rev-parse", "HEAD");
    expect((await submit()).syncCommitGuard?.branch).toBe("develop");
    expect(await git(local, "rev-parse", "HEAD")).toBe(before);
    expect(await git(local, "diff", "--name-only", "--cached")).toBe("");
    await git(local, "switch", "main");
    await git(local, "commit", "--allow-empty", "-m", "Separate local commit");
    const newHead = await git(local, "rev-parse", "HEAD");
    const fresh = (await submit()).syncCommitGuard!;
    expect(fresh.token).not.toBe(expected.token);
    expect(await git(local, "rev-parse", "HEAD")).toBe(newHead);
    await writeFile(path.join(local, "other.txt"), "someone staged this");
    await git(local, "add", "other.txt");
    const changed = await commitAndSync(local, root, mergeSettings, fresh, ["notes.txt"], "Earlier review");
    expect(changed.syncCommitGuard?.token).not.toBe(fresh.token);
    expect(await git(local, "diff", "--name-only", "--cached")).toBe("other.txt");
    expect(await git(local, "rev-parse", "HEAD")).toBe(newHead);
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
  });

  it.each([true, false])("commits a partially staged file with remaining edits selected = %s", async includeRemaining => {
    await createClones({ "notes.txt": "base" });
    await commitFiles(other, "Remote notes", { "notes.txt": "remote" });
    await git(other, "push");
    await writeFile(path.join(local, "notes.txt"), "staged");
    await git(local, "add", "notes.txt");
    await writeFile(path.join(local, "notes.txt"), "remaining");
    const prompt = await sync(local, root, mergeSettings, "main");
    const next = await commitAndSync(local, root, mergeSettings, prompt.syncCommitGuard!, includeRemaining ? ["notes.txt"] : [], "Save my notes");
    expect(await git(local, "show", "HEAD:notes.txt")).toBe(includeRemaining ? "remaining" : "staged");
    if (includeRemaining) {
      expect(next.conflicts).toEqual(["notes.txt"]);
    } else {
      expect(next.syncCommitRequired).toBeTruthy();
      expect(await readFile(path.join(local, "notes.txt"), "utf8")).toBe("remaining");
    }
  });

  it.each(["ort", "ours"])("enforces pull.ff=only before the %s merge strategy on divergent machines", async strategy => {
    await createClones({ "notes.txt": "base" });
    const { localTip, remoteTip } = await diverge({ "notes.txt": "local" }, { "notes.txt": "remote" });
    await git(local, "config", "pull.ff", "only");
    await git(local, "config", "pull.twohead", strategy);
    await expect(sync(local, root, defaultSettings, "main")).rejects.toThrow(/fast-forward-only/i);
    await expect(inspectSyncConflicts(local, root)).rejects.toThrow();
    expect(await git(local, "rev-parse", "HEAD")).toBe(localTip);
    expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
    if (strategy === "ours") {
      // Explicit merge in the app overrides pull.ff=only just as git pull --no-rebase does.
      await sync(local, root, mergeSettings, "main");
      expect(await git(local, "show", "-s", "--format=%P", "HEAD")).toBe(`${localTip} ${remoteTip}`);
      expect(await git(remote, "rev-parse", "main")).toBe(await git(local, "rev-parse", "HEAD"));
    }
  });
});
