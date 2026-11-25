// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit, tryGit } from "../../electron/git/exec.js";
import { applySyncConflicts, inspectSyncConflicts } from "../../electron/git/syncConflicts.js";

describe("reviewing externally staged conflict markers", () => {
  let repo: string;
  const write = (file: string, value: string) => writeFile(path.join(repo, file), value);
  const git = (...args: string[]) => runGit(repo, args);

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "radar-staged-markers-"));
    await git("init", "-b", "main");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await git("config", "core.autocrlf", "false");
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true, maxRetries: 3 }); });

  async function createConflict(command: string[], prefix = "", differingAttributes = false, markerSize = 3,
    note = "guide.md", format = (value: string) => value + "\n") {
    async function save(size: number, content: string, title: string) {
      await write(".gitattributes", `*${path.extname(note)} conflict-marker-size=${size}\n`);
      await write(note, prefix + format(content));
      await git("add", ".");
      await git("commit", "-m", title);
    }
    await save(differingAttributes ? 7 : markerSize, "base", "Base");
    await git("switch", "-c", "upstream");
    await save(differingAttributes ? 9 : markerSize, "remote version", "Remote change");
    await git("switch", "main");
    await git("branch", "--set-upstream-to", "upstream");
    await save(markerSize, "local version", "Local change");
    expect((await tryGit(repo, [...command, "upstream"])).code).toBe(1);
    const original = await readFile(path.join(repo, note), "utf8");
    return { note, original, closing: original.trimEnd().split("\n").at(-1)! };
  }

  it.each([["merge"], ["rebase", "--merge"], ["rebase", "--apply"]])("requires removing a lone short marker after %s %s", async (...command) => {
    const { note, closing } = await createConflict(command);
    const partial = "Chosen text\n" + closing + "\n";
    await write(note, partial);
    await git("add", "--", note);
    const review = await inspectSyncConflicts(repo, repo);
    expect(review.files.map(file => file.path)).toEqual([note]);
    expect(review.files[0].generatedMarkerLines).toContain(closing);
    await expect(applySyncConflicts(repo, repo, review.token, [])).rejects.toThrow();
    await expect(applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: partial }])).rejects.toThrow(/remove the conflict markers/i);
    await applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: "Chosen text\n" }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe("Chosen text\n");
  });

  it("uses the indexed content and the actual marker width in a large file, while retaining documented examples", async () => {
    const example = ["```", "<<< HEAD", "demo A", "===", "demo B", ">>> upstream", "```", ""].join("\n");
    const prefix = "This shared line stays in all versions.\n".repeat(7200) + example + "Unchanged context\n";
    const { note, closing } = await createConflict(["merge"], prefix, true);
    expect(closing).toBe(">>> upstream");
    await git("add", "--", note);
    let review = await inspectSyncConflicts(repo, repo);
    expect(review).toMatchObject({ hasDeferredFiles: true, files: [{ path: ".gitattributes" }] });
    await applySyncConflicts(repo, repo, review.token, [{ path: ".gitattributes", choice: "incoming" }]);
    review = await inspectSyncConflicts(repo, repo);
    expect(review.files.find(file => file.path === note)).toMatchObject({ markerSize: 9, mergedText: null });
    await write(note, prefix + "resolved\n" + closing + "\n");
    await git("add", "--", note);
    review = await inspectSyncConflicts(repo, repo);
    expect(review.files.map(file => file.path)).toContain(note);
    await write(note, prefix + "resolved\n");
    await git("add", "--", note);
    review = await inspectSyncConflicts(repo, repo);
    expect(review.files.map(file => file.path)).not.toContain(note);
    await applySyncConflicts(repo, repo, review.token, []);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(prefix + "resolved\n");
  });

  it.each([["merge"], ["rebase", "--merge"], ["rebase", "--apply"]])("recognizes an unstaged partial conflict after %s %s", async (...command) => {
    const { note, closing } = await createConflict(command);
    const partial = "Resolved outside Repo Radar\n" + closing + "\n";
    await write(note, partial);
    const review = await inspectSyncConflicts(repo, repo);
    expect(review.files[0]).toMatchObject({ path: note, mergedText: partial });
    expect(review.files[0].generatedMarkerLines).toContain(closing);
    await expect(applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: partial }])).rejects.toThrow(/remove the conflict markers/i);
    await applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: "Resolved outside Repo Radar\n" }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe("Resolved outside Repo Radar\n");
  });

  it("keeps an example distinct from a byte-identical real conflict when Git has no AUTO_MERGE tree", async () => {
    const identical = "<<< HEAD\nlocal version\n===\nremote version\n>>> upstream\n";
    const prefix = "# Example\n```\n" + identical + "```\nInstructions:\n";
    const { note } = await createConflict(["merge"], prefix);
    await git("update-ref", "-d", "AUTO_MERGE");
    await write(note, "Instructions:\n" + identical);
    await git("add", "--", note);
    const ambiguous = await inspectSyncConflicts(repo, repo);
    expect(ambiguous.files.map(file => file.path)).toEqual([note]);
    await expect(applySyncConflicts(repo, repo, ambiguous.token, [])).rejects.toThrow();
    await write(note, prefix + "New decision\n");
    await git("add", "--", note);
    const resolved = await inspectSyncConflicts(repo, repo);
    expect(resolved.files).toEqual([]);
    await applySyncConflicts(repo, repo, resolved.token, []);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(prefix + "New decision\n");
  });

  it("rejects an unstaged default-width conflict after a user removes the identical documented example", async () => {
    const block = "<<<<<<< HEAD\nlocal version\n=======\nremote version\n>>>>>>> upstream\n";
    const prefix = "# Guide\n```\n" + block + "```\nAfter example\n";
    const { note, original } = await createConflict(["merge"], prefix, false, 7);
    expect(original).toBe(prefix + block);
    const partial = "After example\n" + block;
    await write(note, partial);
    const review = await inspectSyncConflicts(repo, repo);
    const decide = (text: string) => applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text }]);
    await expect(decide(partial)).rejects.toThrow(/remove the conflict markers/i);
    expect((await git("ls-files", "--unmerged", "--", note)).stdout).toContain(note);
    await decide(prefix + "combined\n");
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(prefix + "combined\n");
  });

  it("commits an edited result containing a documented standalone opening marker", async () => {
    const prefix = "# Opening marker\n```\n<<<<<<< HEAD\n```\nChoose the value below\n";
    const { note } = await createConflict(["merge"], prefix, false, 7);
    const review = await inspectSyncConflicts(repo, repo);
    const decide = (text: string) => applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text }]);
    await expect(decide(prefix + "combined\n<<<<<<< HEAD\n")).rejects.toThrow(/remove the conflict markers/i);
    await decide(prefix + "combined\n");
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(prefix + "combined\n");
  });

  it.each([["merge"], ["rebase", "--apply"]])("requires removing an isolated separator in JSON after %s %s", async (...command) => {
    const json = (value: string) => JSON.stringify({ site: value }, null, 2) + "\n";
    const { note, original } = await createConflict(command, "", false, 7, "config.json", json);
    expect(original).toContain("\n=======\n");
    const partial = json("resolved").replace("\n}\n", "\n=======\n}\n");
    await write(note, partial);
    for (const staged of [false, true]) {
      if (staged) await git("add", "--", note);
      const review = await inspectSyncConflicts(repo, repo);
      expect(review.files[0].generatedMarkerLines).toContain("=======");
      await expect(applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: partial }])).rejects.toThrow(/remove the conflict markers/i);
    }
    const ready = await inspectSyncConflicts(repo, repo);
    await applySyncConflicts(repo, repo, ready.token, [{ path: note, choice: "edited", text: json("resolved") }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(json("resolved"));
  });

  it.each([["merge"], ["rebase", "--apply"]])("checks a paste after an external editor cleared every marker during %s %s", async (...command) => {
    const json = (value: string) => JSON.stringify({ site: value }, null, 2) + "\n";
    const { note, original } = await createConflict(command, "", false, 3, "config.json", json);
    expect(original).toContain("\n===\n");
    await write(note, json("resolved externally"));
    const review = await inspectSyncConflicts(repo, repo);
    expect(review.files[0].mergedText).toBe(json("resolved externally"));
    const decide = (text: string) => applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text }]);
    const closing = original.split("\n").find(line => line.startsWith(">>> "))!;
    for (const marker of ["===", closing]) {
      await expect(decide(json("pasted").replace("\n}\n", "\n" + marker + "\n}\n"))).rejects.toThrow(/remove the conflict markers/i);
    }
    expect((await git("ls-files", "--unmerged", "--", note)).stdout).toContain(note);
    await decide(json("combined"));
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(json("combined"));
  });

  it.each(["guide.py", "report.Rmd"])("commits a renamed underlined heading in %s with an independent resolution", async note => {
    const heading = "Options\n=======\nShared documentation.\n";
    const prefix = note.endsWith(".py") ? '"""\n' + heading + '"""\n\n' : heading + "\n";
    const format = (value: string) => 'setting = "' + value + '"\n';
    await createConflict(["merge"], prefix, false, 7, note, format);
    const review = await inspectSyncConflicts(repo, repo);
    const text = prefix.replace("Options", "Q & A") + format("combined");
    const decide = (value: string) => applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: value }]);
    if (note.endsWith(".py")) await expect(decide(text + "=======\n")).rejects.toThrow(/remove the conflict markers/i);
    await decide(text);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(text);
  });

  it.each([["merge"], ["rebase", "--merge"], ["rebase", "--apply"]])("recognizes the original short diff3 ancestor without AUTO_MERGE after %s %s", async (...command) => {
    await git("config", "merge.conflictStyle", "diff3");
    const json = (value: string) => JSON.stringify({ site: value }, null, 2) + "\n";
    const { note, original } = await createConflict(command, "", false, 3, "config.json", json);
    const ancestor = original.split("\n").find(line => line.startsWith("||| "));
    expect(ancestor).toBeDefined();
    await git("update-ref", "-d", "AUTO_MERGE");
    const clean = json("combined");
    const partial = clean.replace("\n}\n", "\n" + ancestor + "\n}\n");
    await write(note, clean);
    const review = await inspectSyncConflicts(repo, repo);
    await expect(applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: partial }]))
      .rejects.toThrow(/remove the conflict markers/i);
    await write(note, partial);
    await git("add", "--", note);
    const staged = await inspectSyncConflicts(repo, repo);
    expect(staged.files.map(file => file.path)).toEqual([note]);
    await applySyncConflicts(repo, repo, staged.token, [{ path: note, choice: "edited", text: clean }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(clean);
  });

  it("rejects the original short diff3 markers when a rebase recreates a merge without AUTO_MERGE", async () => {
    const note = "guide.json";
    const json = (value: string) => JSON.stringify({ site: value }) + "\n";
    async function commitFile(file: string, content: string, subject: string) {
      await write(file, content);
      await git("add", "--", file);
      await git("commit", "-m", subject);
    }
    await git("config", "merge.conflictStyle", "diff3");
    await write(".gitattributes", "*.json conflict-marker-size=3\n");
    await git("add", ".gitattributes");
    await commitFile(note, json("base"), "Base");
    await git("switch", "-c", "upstream");
    await commitFile("extra", "from peer\n", "Upstream work");
    await git("switch", "main");
    await git("branch", "--set-upstream-to=upstream");
    await git("switch", "-c", "topic");
    await commitFile(note, json("topic"), "Topic work");
    await git("switch", "main");
    await commitFile(note, json("main"), "Main work");
    expect((await tryGit(repo, ["merge", "--no-edit", "topic"])).code).toBe(1);
    await commitFile(note, json("old resolution"), "Merge topic");
    expect((await tryGit(repo, ["rebase", "--rebase-merges", "--strategy=recursive", "upstream"])).code).toBe(1);
    const original = await readFile(path.join(repo, note), "utf8");
    const lines = original.split("\n").filter(line => /^(?:\|\|\||>>>) /.test(line));
    expect(lines).toHaveLength(2);
    // Recent Git aliases recursive to ort, which may save an AUTO_MERGE tree.
    await git("update-ref", "-d", "AUTO_MERGE");
    const clean = json("combined");
    await write(note, clean);
    const preview = await inspectSyncConflicts(repo, repo);
    const first = (await git("rev-parse", "HEAD")).stdout.trim();
    const second = (await git("rev-parse", "MERGE_HEAD")).stdout.trim();
    for (const line of lines) {
      await expect(applySyncConflicts(repo, repo, preview.token, [{ path: note, choice: "edited", text: clean + line + "\n" }]))
        .rejects.toThrow(/remove the conflict markers/i);
    }
    for (const line of lines) {
      await write(note, clean + line + "\n");
      await git("add", "--", note);
      const staged = await inspectSyncConflicts(repo, repo);
      expect(staged.files.map(file => file.path)).toEqual([note]);
      await expect(applySyncConflicts(repo, repo, staged.token, [])).rejects.toThrow(/every conflicted file/i);
    }
    const staged = await inspectSyncConflicts(repo, repo);
    await applySyncConflicts(repo, repo, staged.token, [{ path: note, choice: "edited", text: clean }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(clean);
    expect((await git("show", "-s", "--format=%P", "HEAD")).stdout.trim()).toBe(first + " " + second);
  });

  it.each([true, false])("keeps a complete conflict unresolved when its example has identical neighbors (saved merge: %s)", async saved => {
    const block = "<<<<<<< HEAD\nlocal version\n=======\nremote version\n>>>>>>> upstream\n";
    const section = (text: string) => "Before\n" + text + "\nAfter\n";
    const prefix = section(block.trimEnd()) + "Between sections\n";
    const { note, original } = await createConflict(["merge"], prefix, false, 7, "guide.md", section);
    expect(original).toBe(prefix + section(block.trimEnd()));
    if (!saved) await git("update-ref", "-d", "AUTO_MERGE");
    const partial = section(block.trimEnd());
    await write(note, partial);
    for (const staged of [false, true]) {
      if (staged) await git("add", "--", note);
      const review = await inspectSyncConflicts(repo, repo);
      expect(review.files[0].ambiguousMarkerExamples).toContainEqual({ width: 7, exampleIndex: 0 });
      await expect(applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "edited", text: partial }])).rejects.toThrow(/remove the conflict markers/i);
    }
    const ready = await inspectSyncConflicts(repo, repo);
    await applySyncConflicts(repo, repo, ready.token, [{ path: note, choice: "local" }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(prefix + section("local version"));
  });

  it("checks a staged separator in a large JSON file using the width from Git's original merge", async () => {
    const prefix = "[\n" + '  "unchanged entry",\n'.repeat(14000);
    const last = (text: string) => JSON.stringify(text) + "\n]\n";
    const { note } = await createConflict(["merge"], prefix, true, 3, "large.json", last);
    const attrs = await inspectSyncConflicts(repo, repo);
    await applySyncConflicts(repo, repo, attrs.token, [{ path: ".gitattributes", choice: "incoming" }]);
    await write(note, prefix + '"combined"\n===\n]\n');
    await git("add", "--", note);
    const partial = await inspectSyncConflicts(repo, repo);
    expect(partial.files[0]).toMatchObject({ path: note, mergedText: null, markerSize: 9 });
    expect(partial.files[0].generatedMarkerLines).toContain("===");
    await write(note, prefix + last("combined"));
    await git("add", "--", note);
    const ready = await inspectSyncConflicts(repo, repo);
    expect(ready.files).toEqual([]);
    await applySyncConflicts(repo, repo, ready.token, []);
  });

  it("keeps indistinguishable examples unresolved with large source blobs and no saved merge tree", async () => {
    const block = "<<<<<<< HEAD\nlocal version\n=======\nremote version\n>>>>>>> upstream";
    const section = (text: string) => "Before\n" + text + "\nAfter\n";
    const prefix = "Unchanged source text\n".repeat(15000) + section(block) + "Between sections\n";
    const { note } = await createConflict(["merge"], prefix, false, 7, "guide.md", section);
    await git("update-ref", "-d", "AUTO_MERGE");
    await write(note, section(block));
    await git("add", "--", note);
    const review = await inspectSyncConflicts(repo, repo);
    expect(review.files.map(file => file.path)).toEqual([note]);
    await applySyncConflicts(repo, repo, review.token, [{ path: note, choice: "incoming" }]);
    expect((await git("show", `HEAD:${note}`)).stdout).toBe(prefix + section("remote version"));
  });
});
