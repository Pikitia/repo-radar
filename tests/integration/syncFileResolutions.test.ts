// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit, tryGit } from "../../electron/git/exec.js";
import { applySyncConflicts, inspectSyncConflicts } from "../../electron/git/syncConflicts.js";
import { assertNoIgnoredCheckoutCollision } from "../../electron/git/syncCheckout.js";

describe("resolving Git file conflicts", () => {
  let repo: string;
  const git = (...args: string[]) => runGit(repo, args);
  const write = (file: string, text: string) => writeFile(path.join(repo, file), text);

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "repo-radar-file-resolutions-"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(repo, "unused-gitconfig"));
    await git("init", "-b", "main");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await git("config", "core.autocrlf", "false");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  });

  async function branchFromBase() {
    await git("commit", "-m", "Shared base");
    await git("switch", "-c", "incoming");
    await git("branch", "--set-upstream-to=incoming", "main");
  }

  async function pauseMerge() {
    const result = await tryGit(repo, ["merge", "--no-edit", "incoming"]);
    expect(result.code).toBe(1);
    return inspectSyncConflicts(repo, repo);
  }

  it.each([
    ["--merge", false, false], ["--merge", true, false],
    ["--apply", false, false], ["--merge", true, true]
  ] as const)("protects Git's generated file/directory conflict path (%s, resumed=%s, incoming file=%s)", async (backend, resumed, incomingFile) => {
    await write("guide", "base");
    await git("add", "guide");
    await branchFromBase();
    if (!incomingFile) await mkdir(path.join(repo, "entry"));
    await write(incomingFile ? "entry" : "entry/file", "peer");
    if (resumed) await write("guide", "peer guide");
    await git("add", ".");
    await git("commit", "-m", "Peer changes");
    await git("switch", "main");
    if (resumed) {
      await write("guide", "local guide");
      await git("commit", "-am", "First conflict");
    }
    if (incomingFile) await mkdir(path.join(repo, "entry"));
    await write(incomingFile ? "entry/file" : "entry", "local");
    await git("add", ".");
    await git("config", "core.abbrev", "12");
    // Keep the merge subject's trailing spaces so native Git must preserve them inside its filename.
    const subject = backend === "--merge" ? "File/shape  " : "File/shape";
    await git("commit", "--cleanup=verbatim", "-m", subject + "\nsecond subject line");
    const abbreviation = (await git("rev-parse", "--short", "HEAD")).stdout.trim();
    const label = incomingFile ? "HEAD" : backend === "--apply" ? "File_shape" : `${abbreviation} (File_shape  )`;
    let collision = "entry~" + label;
    await git("rm", "-r", "entry");
    await git("commit", "-m", "Remove temporary entry");
    if (backend === "--merge" && !resumed) {
      await git("switch", "incoming");
      await write(collision, "tracked sibling");
      await git("add", "--", collision);
      await git("commit", "-m", "Occupy the first generated path");
      await git("switch", "main");
      collision += "_0";
    }
    const peerTip = (await git("rev-parse", "incoming")).stdout.trim();
    if (resumed) expect((await tryGit(repo, ["rebase", backend, "incoming"])).code).toBe(1);
    const head = (await git("rev-parse", "HEAD")).stdout;
    const index = (await git("ls-files", "--stage")).stdout;
    const review = resumed ? await inspectSyncConflicts(repo, repo) : null;
    const preflight = () => review ? applySyncConflicts(repo, repo, review.token, [{ path: "guide", choice: "local" }])
      : assertNoIgnoredCheckoutCollision(repo, peerTip, `${peerTip}..HEAD`);
    await write(".git/info/exclude", "entry~*\n");
    await write(collision, "private bytes");
    await write("entry~my-notes", "unrelated");
    await expect(preflight()).rejects.toThrow(collision);
    expect(await readFile(path.join(repo, collision), "utf8")).toBe("private bytes");
    expect((await git("rev-parse", "HEAD")).stdout).toBe(head);
    expect((await git("ls-files", "--stage")).stdout).toBe(index);
    const saved = path.join(repo, ".git", "saved-private");
    await rename(path.join(repo, collision), saved);
    await preflight();
    if (!resumed) expect((await tryGit(repo, ["rebase", backend, "incoming"])).code).toBe(1);
    expect(await readFile(path.join(repo, collision), "utf8")).toBe(incomingFile ? "peer" : "local");
    expect(await readFile(saved, "utf8")).toBe("private bytes");
    expect(await readFile(path.join(repo, "entry~my-notes"), "utf8")).toBe("unrelated");
  });

  it.each([["--apply", false], ["--merge", false], ["--rebase-merges", false], ["--apply", true]] as const)(
    "preserves ignored data during a paused %s rebase with skip=%s", async (backend, skip) => {
    await write("guide", "base\n");
    await git("add", "guide");
    await branchFromBase();
    await write("guide", "peer\n");
    await git("commit", "-am", "Peer change");
    await git("switch", "main");
    await write("guide", "local\n");
    await git("commit", "-am", "Local change");
    await write("temporary", "committed temporarily");
    await git("add", "temporary");
    await git("commit", "-m", "Add temporary");
    await git("rm", "temporary");
    await git("commit", "-m", "Remove temporary");
    expect((await tryGit(repo, ["rebase", backend, "incoming"])).code).toBe(1);
    if (skip) {
      await git("checkout", "--ours", "--", "guide");
      await git("add", "guide");
    }
    const review = await inspectSyncConflicts(repo, repo);
    const choices = skip ? [] : [{ path: "guide", choice: "local" as const }];
    const index = (await git("ls-files", "--stage")).stdout;
    await write(".git/info/exclude", "temporary\n");
    await write("temporary", "private work created during review");
    await expect(applySyncConflicts(repo, repo, review.token, choices, skip)).rejects.toThrow(/temporary/);
    expect(await readFile(path.join(repo, "temporary"), "utf8")).toBe("private work created during review");
    expect((await git("ls-files", "--stage")).stdout).toBe(index);
    await rm(path.join(repo, "temporary"));
    await applySyncConflicts(repo, repo, review.token, choices, skip);
    expect((await git("symbolic-ref", "--short", "HEAD")).stdout.trim()).toBe("main");
    expect(await readFile(path.join(repo, "guide"), "utf8")).toBe(skip ? "peer\n" : "local\n");
  });

  it("resolves competing renames after both branches move the last file out of a directory", async () => {
    await mkdir(path.join(repo, "old"));
    await write("old/note", "shared note\n");
    await git("add", "--", "old/note");
    await branchFromBase();
    await git("mv", "old/note", "their-note");
    await git("commit", "-m", "Incoming rename");
    await git("switch", "main");
    await git("mv", "old/note", "my-note");
    await git("commit", "-m", "Local rename");
    await rmdir(path.join(repo, "old")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const review = await pauseMerge();
    expect((await git("ls-files", "--unmerged")).stdout).toMatch(/ 1\told\/note/);
    expect(review.files.map(file => file.path)).toEqual(["my-note", "their-note"]);
    await applySyncConflicts(repo, repo, review.token, review.files.map(file => ({ path: file.path, choice: "local" })));
    expect((await git("ls-tree", "--name-only", "HEAD")).stdout.trim()).toBe("my-note");
    expect(await readFile(path.join(repo, "my-note"), "utf8")).toBe("shared note\n");
    expect((await git("status", "--porcelain")).stdout).toBe("");
  });

  it("retains incoming executable mode changes on edited text with core.filemode disabled", async () => {
    await git("config", "core.filemode", "false");
    const files = ["added-exec.sh", "removed-exec.sh"];
    for (const file of files) await write(file, "base\n");
    await git("add", "--", ...files);
    await git("update-index", "--chmod=+x", "removed-exec.sh");
    await branchFromBase();
    for (const file of files) await write(file, "incoming\n");
    await git("add", "--", ...files);
    await git("update-index", "--chmod=+x", "added-exec.sh");
    await git("update-index", "--chmod=-x", "removed-exec.sh");
    await git("commit", "-m", "Incoming text and mode");
    await git("switch", "main");
    for (const file of files) await write(file, "local\n");
    await git("commit", "-am", "Local text");
    const review = await pauseMerge();
    await applySyncConflicts(repo, repo, review.token, files.map(file => ({ path: file, choice: "edited", text: "combined\n" })));
    const tree = (await git("ls-tree", "HEAD")).stdout;
    expect(tree).toMatch(/^100755 blob .*\tadded-exec\.sh$/m);
    expect(tree).toMatch(/^100644 blob .*\tremoved-exec\.sh$/m);
  });

  it("reads the per-file marker width and rejects unresolved short markers before applying decisions", async () => {
    await write(".gitattributes", "*.txt conflict-marker-size=3\n");
    await write("note.txt", "base\n");
    await git("add", "--", ".gitattributes", "note.txt");
    await branchFromBase();
    await write("note.txt", "incoming\n");
    await git("commit", "-am", "Incoming version");
    await git("switch", "main");
    await write("note.txt", "local\n");
    await git("commit", "-am", "Local version");
    const review = await pauseMerge();
    const file = review.files[0];
    expect(file.markerSize).toBe(3);
    expect(file.mergedText).toMatch(/^<<< HEAD$/m);
    const index = await git("ls-files", "--unmerged");
    await expect(applySyncConflicts(repo, repo, review.token, [
      { path: file.path, choice: "edited", text: file.mergedText! }
    ])).rejects.toThrow("Remove the conflict markers");
    expect((await git("ls-files", "--unmerged")).stdout).toBe(index.stdout);
    await applySyncConflicts(repo, repo, review.token, [{ path: file.path, choice: "edited", text: "combined\n" }]);
    expect((await git("show", "HEAD:note.txt")).stdout).toBe("combined\n");
  });

  it("uses exact whole-file choices for a non-UTF-8 working tree and finishes despite an inherited Git editor", async () => {
    await write(".gitattributes", "*.txt working-tree-encoding=ISO-8859-1\n");
    await write("ascii.txt", "base\n");
    await write("accent.txt", "base\n");
    await git("add", "--", ".gitattributes", "ascii.txt", "accent.txt");
    await branchFromBase();
    await write("ascii.txt", "incoming\n");
    const incomingBytes = Buffer.from("café\n", "latin1");
    await writeFile(path.join(repo, "accent.txt"), incomingBytes);
    await git("commit", "-am", "Incoming versions");
    const incomingBlob = (await git("rev-parse", "HEAD:accent.txt")).stdout;
    await git("switch", "main");
    await write("ascii.txt", "local\n");
    await write("accent.txt", "local\n");
    await git("commit", "-am", "Local versions");
    const review = await pauseMerge();
    expect(review.files).toMatchObject([
      { path: "accent.txt", mergedText: null, incoming: { text: "café\n" } },
      { path: "ascii.txt", mergedText: null, incoming: { text: "incoming\n" } }
    ]);
    await expect(applySyncConflicts(repo, repo, review.token, [
      { path: "accent.txt", choice: "incoming" }, { path: "ascii.txt", choice: "edited", text: "café\n" }
    ])).rejects.toThrow(/invalid edited text/i);
    vi.stubEnv("GIT_EDITOR", "missing-fixture-editor");
    await applySyncConflicts(repo, repo, review.token, [
      { path: "accent.txt", choice: "incoming" }, { path: "ascii.txt", choice: "local" }
    ]);
    expect((await git("rev-parse", "HEAD:accent.txt")).stdout).toBe(incomingBlob);
    expect(await readFile(path.join(repo, "accent.txt"))).toEqual(incomingBytes);
    expect((await git("show", "HEAD:ascii.txt")).stdout).toBe("local\n");
  });

  it("requires a fresh explicit skip for an empty apply-backend patch and continues reviewing later conflicts", async () => {
    await write("first.txt", "base\n");
    await write("second.txt", "base\n");
    await git("add", "--", "first.txt", "second.txt");
    await branchFromBase();
    await write("first.txt", "incoming first\n");
    await write("second.txt", "incoming second\n");
    await git("commit", "-am", "Incoming changes");
    const upstream = (await git("rev-parse", "HEAD")).stdout;
    await git("switch", "main");
    await write("first.txt", "local first\n");
    await git("commit", "-am", "First local patch");
    const first = (await git("rev-parse", "HEAD")).stdout;
    await write("second.txt", "local second\n");
    await git("commit", "-am", "Second local patch");
    const second = (await git("rev-parse", "HEAD")).stdout;
    expect((await tryGit(repo, ["rebase", "--apply", "incoming"])).code).toBe(1);
    const review = await inspectSyncConflicts(repo, repo);
    expect(review.canSkipEmptyPatch).toBe(false);
    const incoming = [{ path: "first.txt", choice: "incoming" as const }];
    await expect(applySyncConflicts(repo, repo, review.token, incoming, true)).rejects.toThrow();
    await applySyncConflicts(repo, repo, review.token, incoming);
    expect((await git("rev-parse", "REBASE_HEAD")).stdout).toBe(first);
    const empty = await inspectSyncConflicts(repo, repo);
    expect(empty).toMatchObject({ files: [], canSkipEmptyPatch: true });
    await expect(applySyncConflicts(repo, repo, review.token, [], true)).rejects.toThrow();
    await write("second.txt", "keep my unstaged work\n");
    await expect(applySyncConflicts(repo, repo, empty.token, [], true)).rejects.toThrow();
    expect(await readFile(path.join(repo, "second.txt"), "utf8")).toBe("keep my unstaged work\n");
    await git("add", "--", "second.txt");
    await expect(applySyncConflicts(repo, repo, empty.token, [], true)).rejects.toThrow();
    expect((await git("show", ":second.txt")).stdout).toBe("keep my unstaged work\n");
    // Revert only the fixture edit, then check a plain Finish still cannot skip.
    await git("restore", "--source=HEAD", "--staged", "--worktree", "--", "second.txt");
    const refreshed = await inspectSyncConflicts(repo, repo);
    await applySyncConflicts(repo, repo, refreshed.token, []);
    expect((await git("rev-parse", "REBASE_HEAD")).stdout).toBe(first);
    vi.stubEnv("GIT_EDITOR", "missing-fixture-editor");
    await applySyncConflicts(repo, repo, refreshed.token, [], true);
    expect((await git("rev-parse", "REBASE_HEAD")).stdout).toBe(second);
    const next = await inspectSyncConflicts(repo, repo);
    expect(next.files.map(file => file.path)).toEqual(["second.txt"]);
    await expect(applySyncConflicts(repo, repo, refreshed.token, [], true)).rejects.toThrow();
    await applySyncConflicts(repo, repo, next.token, [{ path: "second.txt", choice: "local" }]);
    expect((await git("rev-parse", "HEAD^")).stdout).toBe(upstream);
    expect((await git("symbolic-ref", "--short", "HEAD")).stdout.trim()).toBe("main");
    expect((await git("show", "HEAD:first.txt")).stdout).toBe("incoming first\n");
    expect((await git("show", "HEAD:second.txt")).stdout).toBe("local second\n");
  });

  it("reviews marker text staged externally using only the saved conflict paths and indexed content", async () => {
    await write("note", "base\n");
    await write("other", "base\n");
    await git("add", "note", "other");
    await branchFromBase();
    await write("note", "incoming\n");
    await write("other", "incoming\n");
    await git("commit", "-am", "Incoming changes");
    await git("switch", "main");
    await write("note", "local\n");
    await write("other", "local\n");
    await git("commit", "-am", "Local changes");
    await pauseMerge();
    await write("other", "resolved externally\n");
    await write("manual.md", "<<<<<<< Example marker in unrelated documentation\n");
    await git("add", "note", "other", "manual.md");
    // The index still contains unresolved markers in note, even though its working text has been fixed.
    await write("note", "unstaged resolution\n");
    await write("other", "<<<<<<< Unstaged and separate from its valid indexed resolution\n");
    const review = await inspectSyncConflicts(repo, repo);
    expect(review.files).toMatchObject([{ path: "note", mergedText: "unstaged resolution\n",
      local: { text: "local\n" }, incoming: { text: "incoming\n" } }]);
    await expect(applySyncConflicts(repo, repo, review.token, [])).rejects.toThrow(/every conflicted file/i);
    await applySyncConflicts(repo, repo, review.token, [{ path: "note", choice: "incoming" }]);
    expect((await git("show", "HEAD:note")).stdout).toBe("incoming\n");
    expect(await readFile(path.join(repo, "note"), "utf8")).toBe("incoming\n");
    expect((await git("show", "HEAD:other")).stdout).toBe("resolved externally\n");
    expect(await readFile(path.join(repo, "other"), "utf8")).toContain("Unstaged");
    expect((await git("show", "HEAD:manual.md")).stdout).toContain("Example marker");
  });

  it("keeps a nonempty unapplied patch pending when an untracked file blocks the next apply-backend commit", async () => {
    await write("note", "base\n");
    await git("add", "note");
    await branchFromBase();
    await write("note", "incoming\n");
    await git("commit", "-am", "Incoming version");
    await git("switch", "main");
    await write("note", "local\n");
    await git("commit", "-am", "First patch");
    await write("later", "from second local commit\n");
    await git("add", "later");
    await git("commit", "-m", "Second patch");
    const second = (await git("rev-parse", "HEAD")).stdout;
    expect((await tryGit(repo, ["rebase", "--apply", "incoming"])).code).toBe(1);
    const first = await inspectSyncConflicts(repo, repo);
    await applySyncConflicts(repo, repo, first.token, [{ path: "note", choice: "incoming" }]);
    const empty = await inspectSyncConflicts(repo, repo);
    expect(empty.canSkipEmptyPatch).toBe(true);
    await write("later", "new untracked work\n");
    await expect(applySyncConflicts(repo, repo, empty.token, [], true)).rejects.toThrow(/untracked/i);
    // A rebase advanced outside Repo Radar can still land on a blocked patch.
    expect((await tryGit(repo, ["rebase", "--skip"])).code).not.toBe(0);
    await expect(inspectSyncConflicts(repo, repo)).rejects.toThrow(/rebase is paused.*untracked file “later”/i);
    await expect(applySyncConflicts(repo, repo, empty.token, [], true)).rejects.toThrow(/rebase is paused/i);
    expect((await git("rev-parse", "REBASE_HEAD")).stdout).toBe(second);
    expect(await readFile(path.join(repo, "later"), "utf8")).toBe("new untracked work\n");
  });

  it("reviews conflicts in a recreated merge and retains both parents", async () => {
    await write("guide", "base");
    await git("add", "guide");
    await branchFromBase();
    await write("extra", "upstream");
    await git("add", "extra");
    await git("commit", "-m", "Upstream work");
    await git("switch", "main");
    await git("switch", "-c", "topic");
    await write("guide", "topic text");
    await git("commit", "-am", "Topic work");
    await git("switch", "main");
    await write("guide", "main text");
    await git("commit", "-am", "Main work");
    expect((await tryGit(repo, ["merge", "--no-ff", "topic"])).code).toBe(1);
    await write("guide", "previous resolution");
    await git("commit", "-am", "Merge topic");
    expect((await tryGit(repo, ["rebase", "--rebase-merges", "incoming"])).code).toBe(1);
    const review = await inspectSyncConflicts(repo, repo);
    expect(review).toMatchObject({ operation: "rebase",
      mergeParents: { first: (await git("show", "-s", "--format=%h %s", "HEAD")).stdout.trimEnd(),
        second: (await git("show", "-s", "--format=%h %s", "MERGE_HEAD")).stdout.trimEnd() },
      files: [{ path: "guide", local: { text: "main text" }, incoming: { text: "topic text" } }] });
    await applySyncConflicts(repo, repo, review.token, [{ path: "guide", choice: "incoming" }]);
    expect((await git("rev-list", "--parents", "-1", "HEAD")).stdout.trim().split(" ")).toHaveLength(3);
    expect((await git("symbolic-ref", "--short", "HEAD")).stdout.trim()).toBe("main");
    expect((await git("show", "HEAD:guide")).stdout).toBe("topic text");
    expect((await git("show", "HEAD:extra")).stdout).toBe("upstream");
  });

  it("checks the tree of a queued topology reset before continuing a rebase", async () => {
    await write("guide", "base");
    await write("config", "tracked original");
    await git("add", ".");
    await branchFromBase();
    await write("guide", "incoming");
    await git("commit", "-am", "Upstream guide");
    await git("switch", "main");
    await git("switch", "-c", "topic");
    await git("rm", "config");
    await git("commit", "-m", "Remove config");
    await write("guide", "topic");
    await git("commit", "-am", "Topic guide");
    await git("switch", "main");
    await write("other", "local");
    await git("add", "other");
    await git("commit", "-m", "Independent change");
    await git("merge", "--no-edit", "topic");
    expect((await tryGit(repo, ["rebase", "--rebase-merges", "incoming"])).code).toBe(1);
    const review = await inspectSyncConflicts(repo, repo);
    await write(".git/info/exclude", "config\n");
    await write("config", "private changes");
    const choices = [{ path: "guide", choice: "local" as const }];
    await expect(applySyncConflicts(repo, repo, review.token, choices)).rejects.toThrow(/config/);
    expect(await readFile(path.join(repo, "config"), "utf8")).toBe("private changes");
    await rm(path.join(repo, "config"));
    await applySyncConflicts(repo, repo, review.token, choices);
    expect((await git("rev-list", "--parents", "-1", "HEAD")).stdout.trim().split(" ")).toHaveLength(3);
  });

  it("requires a new review after the pending picks are reordered during a paused rebase", async () => {
    await write("note", "base\n");
    await git("add", "note");
    await branchFromBase();
    await write("note", "incoming\n");
    await git("commit", "-am", "Incoming version");
    await git("switch", "main");
    await write("note", "local\n");
    await git("commit", "-am", "First patch");
    for (const file of ["second", "third"]) {
      await write(file, file + "\n");
      await git("add", file);
      await git("commit", "-m", file);
    }
    expect((await tryGit(repo, ["rebase", "--merge", "incoming"])).code).toBe(1);
    const before = await inspectSyncConflicts(repo, repo);
    const todo = path.join(repo, ".git", "rebase-merge", "git-rebase-todo");
    const lines = (await readFile(todo, "utf8")).trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    await writeFile(todo, lines.reverse().join("\n") + "\n");
    const choices = [{ path: "note", choice: "local" as const }];
    await expect(applySyncConflicts(repo, repo, before.token, choices)).rejects.toThrow(/changed since this review/i);
    expect((await git("ls-files", "-u")).stdout).toContain("note");
    const fresh = await inspectSyncConflicts(repo, repo);
    expect(fresh.files[0].identity).not.toBe(before.files[0].identity);
    await applySyncConflicts(repo, repo, fresh.token, choices);
    expect((await git("log", "--reverse", "--format=%s", "incoming..HEAD")).stdout.trimEnd().split("\n")).toEqual(["First patch", "third", "second"]);
  });

  it("resolves Git attributes before reviewing a file whose working-tree encoding changes", async () => {
    await write(".gitattributes", "note text\n");
    await write("note", "base\n");
    await write("removed file", "old\n");
    await git("add", ".gitattributes", "note", "removed file");
    await branchFromBase();
    await git("rm", "--", "removed file");
    await write(".gitattributes", "note working-tree-encoding=UTF-8\n");
    await write("note", "incoming\n");
    await git("commit", "-am", "Incoming UTF-8 version");
    await git("switch", "main");
    await write(".gitattributes", "note working-tree-encoding=ISO-8859-1\n");
    await write("note", "local\n");
    await git("commit", "-am", "Local Latin-1 version");
    const initial = await pauseMerge();
    expect(initial.hasDeferredFiles).toBe(true);
    expect(initial.files.map(file => file.path)).toEqual([".gitattributes"]);
    expect(initial.stagedPaths).toEqual(["removed file"]);
    await applySyncConflicts(repo, repo, initial.token, [{ path: ".gitattributes", choice: "local" }]);
    expect((await git("ls-files", "-u")).stdout).toContain("note");
    const next = await inspectSyncConflicts(repo, repo);
    expect(next.files).toMatchObject([{ path: "note", mergedText: null }]);
    await expect(applySyncConflicts(repo, repo, next.token, [{ path: "note", choice: "edited", text: "café\n" }]))
      .rejects.toThrow(/invalid edited text/i);
    await applySyncConflicts(repo, repo, next.token, [{ path: "note", choice: "incoming" }]);
    expect((await git("show", "HEAD:note")).stdout).toBe("incoming\n");
    expect((await git("show", "HEAD:.gitattributes")).stdout).toContain("ISO-8859-1");
  });

  it.each(["worktree", "index", "attributes"] as const)("preserves concurrent %s changes made while applying a review", async change => {
    for (const file of ["a", "z"]) await write(file, "base\n");
    await git("add", "a", "z");
    await branchFromBase();
    for (const file of ["a", "z"]) await write(file, "incoming\n");
    await git("commit", "-am", "Incoming changes");
    await git("switch", "main");
    for (const file of ["a", "z"]) await write(file, "local\n");
    await git("commit", "-am", "Local changes");
    const head = (await git("rev-parse", "HEAD")).stdout;
    const review = await pauseMerge();
    // A real Git hook simulates another writer exactly after the first path is staged.
    const actions = {
      worktree: "echo 'saved while syncing' > z",
      index: "echo 'separate staged work' > unrelated && git add -- unrelated",
      attributes: "echo 'z working-tree-encoding=ISO-8859-1' > .git/info/attributes"
    };
    await writeFile(path.join(repo, ".git", "hooks", "post-index-change"), [
      "#!/bin/sh",
      "test -f .git/fixture-changed && exit 0",
      'test -n "$(git ls-files -u -- a)" && exit 0',
      'test -z "$(git ls-files -u -- z)" && exit 0',
      "touch .git/fixture-changed",
      actions[change], ""
    ].join("\n"), { mode: 0o755 });
    await expect(applySyncConflicts(repo, repo, review.token, [
      { path: "a", choice: "incoming" }, { path: "z", choice: "edited", text: "café\n" }
    ])).rejects.toThrow(/changed since this review/i);
    expect((await git("rev-parse", "HEAD")).stdout).toBe(head);
    expect((await git("rev-parse", "--verify", "MERGE_HEAD")).stdout.trim()).toBeTruthy();
    if (change === "worktree") expect(await readFile(path.join(repo, "z"), "utf8")).toBe("saved while syncing\n");
    if (change === "index") {
      expect((await git("show", ":unrelated")).stdout).toBe("separate staged work\n");
      expect((await inspectSyncConflicts(repo, repo)).stagedPaths).toContain("unrelated");
    }
    if (change === "attributes") expect((await inspectSyncConflicts(repo, repo)).files).toMatchObject([{ path: "z", mergedText: null }]);
  });

  it("lists a staged submodule pointer even when the repository hides submodule diffs, then commits that pointer", async () => {
    const submodule = path.join(repo, "lib");
    await mkdir(submodule);
    const sub = (...args: string[]) => runGit(submodule, args);
    await sub("init", "-b", "main");
    await sub("config", "user.name", "Fixture");
    await sub("config", "user.email", "fixture@example.test");
    await sub("commit", "--allow-empty", "-m", "Initial library");
    await write(".gitmodules", '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
    await write("note", "base\n");
    await git("add", ".gitmodules", "lib", "note");
    await branchFromBase();
    await write("note", "incoming\n");
    await git("commit", "-am", "Incoming change");
    await git("switch", "main");
    await write("note", "local\n");
    await git("commit", "-am", "Local change");
    await git("config", "diff.ignoreSubmodules", "all");
    const initial = await pauseMerge();
    await sub("commit", "--allow-empty", "-m", "Updated library");
    const pointer = (await sub("rev-parse", "HEAD")).stdout.trim();
    await git("add", "--", "lib");
    expect((await git("ls-files", "--stage", "--", "lib")).stdout).toBe(`160000 ${pointer} 0\tlib\n`);
    expect((await git("diff", "--cached", "--name-only", "--", "lib")).stdout).toBe("");
    const fresh = await inspectSyncConflicts(repo, repo);
    expect(fresh.stagedPaths).toContain("lib");
    expect(fresh.token).not.toBe(initial.token);
    expect(fresh.files[0].identity).toBe(initial.files[0].identity);
    await applySyncConflicts(repo, repo, fresh.token, [{ path: "note", choice: "local" }]);
    expect((await git("ls-tree", "HEAD", "--", "lib")).stdout).toBe(`160000 commit ${pointer}\tlib\n`);
  });

  it("keeps file identities across independent changes and invalidates changed stages, working bytes, attributes or a restarted operation", async () => {
    for (const file of ["a", "z"]) await write(file, "base\n");
    await git("add", "a", "z");
    await branchFromBase();
    for (const file of ["a", "z"]) await write(file, "incoming\n");
    await git("commit", "-am", "Incoming changes");
    await git("switch", "main");
    for (const file of ["a", "z"]) await write(file, "local\n");
    await git("commit", "-am", "Local changes");
    const initial = await pauseMerge();
    const ids = (review: typeof initial) => review.files.map(file => file.identity);
    const [a, z] = ids(initial);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(z).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(z);
    const originalTarget = (await git("rev-parse", "incoming")).stdout.trim();
    const advanced = (await git("commit-tree", "incoming^{tree}", "-p", "incoming", "-m", "Upstream advanced")).stdout.trim();
    await git("update-ref", "refs/heads/incoming", advanced, originalTarget);
    const fetched = await inspectSyncConflicts(repo, repo);
    expect(fetched.token).not.toBe(initial.token);
    expect(ids(fetched)).toEqual([a, z]);
    await git("update-ref", "refs/heads/incoming", originalTarget, advanced);
    await write("a", "working draft in editor\n");
    const working = await inspectSyncConflicts(repo, repo);
    expect(working.files[0].identity).not.toBe(a);
    expect(working.files[1].identity).toBe(z);
    await write(".git/info/attributes", "z text\n");
    const attributes = await inspectSyncConflicts(repo, repo);
    expect(attributes.files[0].identity).toBe(working.files[0].identity);
    expect(attributes.files[1].identity).not.toBe(z);
    await git("add", "--", "z"); // Stage the still-marked working file without changing its bytes.
    const staged = await inspectSyncConflicts(repo, repo);
    expect(staged.files[1].mergedText).toBe(attributes.files[1].mergedText);
    expect(staged.files[1].identity).not.toBe(attributes.files[1].identity);
    await git("merge", "--abort");
    await write(".git/info/attributes", "");
    await git("restore", "--source=HEAD", "--staged", "--worktree", "--", "a", "z");
    const restarted = await pauseMerge();
    expect(restarted.files.map(file => file.mergedText)).toEqual(initial.files.map(file => file.mergedText));
    expect(restarted.files[0].identity).not.toBe(a);
    expect(restarted.files[1].identity).not.toBe(z);
    expect(restarted.token).not.toBe(initial.token);
  });
});
