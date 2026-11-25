// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit, tryGit } from "../../electron/git/exec.js";
import { sync } from "../../electron/git/actions.js";
import { defaultSettings } from "../../src/types/settings.js";
import { assertNoIgnoredCheckoutCollision, assertNoReplayCollision } from "../../electron/git/syncCheckout.js";

let root: string;
let repo: string;

async function put(dir: string, file: string, content: string) {
  const absolute = path.join(dir, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function incoming(files: string[], contents = "upstream file") {
  await runGit(repo, ["switch", "-c", "incoming"]);
  for (const file of files) await put(repo, file, contents);
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-m", "Incoming files"]);
  const tip = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await runGit(repo, ["switch", "main"]);
  return tip;
}

describe("preserving ignored files before a sync checkout", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-ignored-"));
    repo = path.join(root, "local");
    const config = path.join(root, "gitconfig");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    await writeFile(config, "[user]\n name = Fixture\n email = fixture@example.test\n");
    await runGit(root, ["init", "-b", "main", repo]);
    await runGit(repo, ["commit", "--allow-empty", "-m", "Common base"]);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each([
    ["config[1].private", "config[1].private", "*.private", []],
    ["work/private/child.txt", "work/private", "private", ["work/sibling.txt"]],
    ["cache/pkg/config", "cache/pkg/config", "cache/", ["cache/pkg/sibling.txt"]],
    ["mixed", "mixed/data.private", "*.private", ["mixed/plain.txt"]],
    ["private-files", "private-files/deeper/data.private", "*.private", []]
  ] as const)("protects local %s collisions with %s", async (target, collision, rule, siblings) => {
    const tip = await incoming([target]);
    await put(repo, ".git/info/exclude", rule + "\n");
    await put(repo, collision, "private local data");
    for (const sibling of siblings) await put(repo, sibling, "unrelated");
    const index = (await runGit(repo, ["ls-files", "--stage", "-z"])).stdout;
    await expect(assertNoIgnoredCheckoutCollision(repo, tip)).rejects.toThrow(/ignored local data.*Move it somewhere safe/);
    expect(await readFile(path.join(repo, collision), "utf8")).toBe("private local data");
    expect((await runGit(repo, ["ls-files", "--stage", "-z"])).stdout).toBe(index);
  });

  it("allows a new file beside ignored data and leaves ordinary untracked collisions to Git", async () => {
    const tip = await incoming(["cache/new.txt", "work/normal.txt"]);
    await put(repo, ".git/info/exclude", "cache/\n*.private\n");
    await put(repo, "cache/subdir/private.txt", "local cache");
    await put(repo, "work/settings.private", "private settings");
    await put(repo, "work/normal.txt", "ordinary untracked change");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "win32").each([["DATA", "data"], ["RÉSUMÉ", "résumé"]])("protects the on-disk spelling of %s before fast-forward and replay checkouts", async (target, physical) => {
    const tip = await incoming([target]);
    const file = physical + "/mine.private";
    await put(repo, file, "private data");
    await put(repo, ".git/info/exclude", "*.private\n");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip)).rejects.toThrow("ignored local data at " + file);
    await put(repo, ".git/info/exclude", "");
    await expect(assertNoReplayCollision(repo, [tip])).rejects.toThrow("untracked local data at " + file);
    expect(await readFile(path.join(repo, file), "utf8")).toBe("private data");
  });

  it.skipIf(process.platform !== "win32")("uses the on-disk name of an ignored junction without inspecting its external contents", async () => {
    const tip = await incoming(["RÉSUMÉ/new.txt"]);
    const outside = path.join(root, "outside");
    await put(outside, "private.txt", "external data");
    await symlink(outside, path.join(repo, "résumé"), "junction");
    await put(repo, ".git/info/exclude", "résumé\n");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip)).rejects.toThrow(/ignored local data.*résumé/);
    expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe("external data");
  });

  it.each(["forced subtree", "fast-forward", "ours"] as const)("preserves ignored local data during a behind-only %s sync", async strategy => {
    await put(repo, "vendor/base", "base");
    await runGit(repo, ["add", "vendor/base"]);
    await runGit(repo, ["commit", "-m", "Shared vendor tree"]);
    const original = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const remote = path.join(root, "shared.git");
    const other = path.join(root, "other");
    await runGit(root, ["init", "--bare", "-b", "main", remote]);
    await runGit(repo, ["remote", "add", "origin", remote]);
    await runGit(repo, ["push", "-u", "origin", "main"]);
    await runGit(root, ["clone", remote, other]);
    await runGit(other, ["mv", "vendor/base", "base"]);
    await put(other, "new.env", "peer contents");
    await runGit(other, ["add", "new.env"]);
    await runGit(other, ["commit", "-m", "Move base and add peer file"]);
    await runGit(other, ["push"]);
    const incoming = (await runGit(other, ["rev-parse", "HEAD"])).stdout.trim();
    const target = strategy === "forced subtree" ? "vendor/new.env" : "new.env";
    const privatePath = path.join(repo, target);
    await put(repo, ".git/info/exclude", "*.env\n");
    await put(repo, target, "private contents");
    await put(repo, "cache.env", "unrelated");
    if (strategy === "ours") await runGit(repo, ["config", "pull.twohead", "ours"]);
    else {
      const branchFf = strategy === "forced subtree" ? "--ff" : "--no-ff";
      await runGit(repo, ["config", "branch.main.mergeOptions", branchFf + " -Xsubtree=vendor"]);
      await runGit(repo, ["config", "pull.ff", strategy === "forced subtree" ? "false" : "true"]);
    }

    if (strategy !== "ours") {
      await expect(sync(repo, root, defaultSettings, "main")).rejects.toThrow(target);
      expect(await readFile(privatePath, "utf8")).toBe("private contents");
      expect((await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim()).toBe(original);
      expect((await runGit(remote, ["rev-parse", "main"])).stdout.trim()).toBe(incoming);
      await rename(privatePath, path.join(root, "saved.env"));
    }
    await sync(repo, root, defaultSettings, "main");
    if (strategy === "ours") {
      expect(await readFile(privatePath, "utf8")).toBe("private contents");
      expect((await runGit(remote, ["ls-tree", "main", "--", target])).stdout).toBe("");
    } else {
      expect((await runGit(remote, ["show", "main:" + target])).stdout).toBe("peer contents");
      expect(await readFile(path.join(root, "saved.env"), "utf8")).toBe("private contents");
    }
    expect(await readFile(path.join(repo, "cache.env"), "utf8")).toBe("unrelated");
    const tip = (await runGit(remote, ["rev-parse", "main"])).stdout.trim();
    if (strategy === "fast-forward") expect(tip).toBe(incoming);
    else expect((await runGit(remote, ["show", "-s", "--format=%P", tip])).stdout.trim()).toBe(original + " " + incoming);
  });

  it("protects the configured subtree destination and allows a retry with unrelated ignored data present", async () => {
    await put(repo, "base", "base");
    await runGit(repo, ["add", "base"]);
    await runGit(repo, ["commit", "-m", "Shared base"]);
    const tip = await incoming(["new.env"]);
    await put(repo, "vendor/base", "local base");
    await runGit(repo, ["add", "vendor"]);
    await runGit(repo, ["commit", "-m", "Local subtree"]);
    await runGit(repo, ["tag", "main", "HEAD"]);
    await runGit(repo, ["config", "branch.main.mergeOptions", "-nXsubtree=vendor"]);
    await put(repo, ".git/info/exclude", "*.env\nnode_modules/\n");
    await put(repo, "vendor/new.env", "private");
    await put(repo, "vendor/other.env", "unrelated");
    await put(repo, "node_modules/cache", "cache");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"])).rejects.toThrow(/vendor\/new\.env/);
    expect(await readFile(path.join(repo, "vendor/new.env"), "utf8")).toBe("private");
    await rm(path.join(repo, "vendor/new.env"));
    await runGit(repo, ["config", "branch.main.mergeOptions", "--strategy-option='subtree=vendor'"]);
    await assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"]);
    await runGit(repo, ["merge", "--no-edit", "--no-overwrite-ignore", "--", tip]);
    expect(await readFile(path.join(repo, "vendor/new.env"), "utf8")).toBe("upstream file");
    expect(await readFile(path.join(repo, "vendor/other.env"), "utf8")).toBe("unrelated");
  });

  it.each([["branch.main.mergeOptions", "-s ours"], ["branch.main.mergeOptions", "-nsours"], ["pull.twohead", "ours"]])("permits %s %s to keep the local tree with ignored files present", async (key, value) => {
    const tip = await incoming(["new.env"]);
    await runGit(repo, ["commit", "--allow-empty", "-m", "Local work"]);
    await runGit(repo, ["config", key, value]);
    await put(repo, ".git/info/exclude", "*.env\n");
    await put(repo, "new.env", "private");
    await assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"]);
    await runGit(repo, ["merge", "--no-edit", "--no-overwrite-ignore", "--", tip]);
    expect(await readFile(path.join(repo, "new.env"), "utf8")).toBe("private");
    expect((await runGit(repo, ["ls-tree", "HEAD", "--", "new.env"])).stdout).toBe("");
  });

  it("checks relocations without invoking the configured merge driver before the real merge", async () => {
    await put(repo, ".gitattributes", "design.txt merge=design.format\n");
    await put(repo, "design.txt", "base\n");
    await put(repo, "old/first", "tracked");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "Initial design"]);
    await runGit(repo, ["config", "merge.directoryRenames", "true"]);
    await runGit(repo, ["config", "merge.design.format.driver", "node .git/merge-design.cjs %A"]);
    await put(repo, ".git/merge-design.cjs",
      "const fs = require('node:fs'); fs.appendFileSync('.git/driver-calls', 'called\\n'); fs.writeFileSync(process.argv[2], 'driver result\\n');");
    await put(repo, ".git/driver-calls", "");
    const tip = await incoming(["old/new.env", "design.txt"]);
    await runGit(repo, ["mv", "old", "renamed"]);
    await put(repo, "design.txt", "local\n");
    await runGit(repo, ["commit", "-am", "Rename directory and edit design"]);
    await put(repo, ".git/info/exclude", "*.env\ncache/\n");
    await put(repo, "renamed/new.env", "private");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"])).rejects.toThrow(/renamed\/new\.env/);
    expect(await readFile(path.join(repo, ".git", "driver-calls"), "utf8")).toBe("");
    await rm(path.join(repo, "renamed", "new.env"));
    await put(repo, "cache/file", "unrelated");
    await assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"]);
    expect(await readFile(path.join(repo, ".git", "driver-calls"), "utf8")).toBe("");
    await runGit(repo, ["merge", "--no-edit", "--no-overwrite-ignore", tip]);
    expect(await readFile(path.join(repo, ".git", "driver-calls"), "utf8")).toBe("called\n");
    expect((await runGit(repo, ["show", "HEAD:design.txt"])).stdout).toBe("driver result\n");
  });

  it("protects ignored data at paths only written by intermediate rebase commits", async () => {
    const tip = await incoming(["upstream.txt"]);
    await put(repo, "temporary.txt", "committed locally");
    await runGit(repo, ["add", "temporary.txt"]);
    await runGit(repo, ["commit", "-m", "Introduce temporary file"]);
    await runGit(repo, ["rm", "temporary.txt"]);
    await runGit(repo, ["commit", "-m", "Remove temporary file"]);
    await put(repo, ".git/info/exclude", "temporary.txt\n");
    await put(repo, "temporary.txt", "ignored work");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip, `${tip}..HEAD`)).rejects.toThrow(/temporary\.txt/);
    expect(await readFile(path.join(repo, "temporary.txt"), "utf8")).toBe("ignored work");
    await assertNoIgnoredCheckoutCollision(repo, tip);
    await runGit(repo, ["merge", "--no-edit", tip]);
    expect(await readFile(path.join(repo, "temporary.txt"), "utf8")).toBe("ignored work");
  });

  it("allows a merge that preserves a locally deleted template while protecting the same path for rebase", async () => {
    await put(repo, "old.settings", "shared template");
    await runGit(repo, ["add", "old.settings"]);
    await runGit(repo, ["commit", "-m", "Add template"]);
    const tip = await incoming(["unrelated.txt"]);
    await runGit(repo, ["rm", "old.settings"]);
    await runGit(repo, ["commit", "-m", "Remove template locally"]);
    await put(repo, ".git/info/exclude", "*.settings\n");
    await put(repo, "old.settings", "private settings");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip, `${tip}..HEAD`)).rejects.toThrow(/old\.settings/);
    await assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"]);
    await runGit(repo, ["merge", "--no-edit", tip]);
    expect(await readFile(path.join(repo, "old.settings"), "utf8")).toBe("private settings");
  });

  it.each(["conflict", "true"])("protects the actual destination from a directory rename with merge.directoryRenames=%s", async setting => {
    await runGit(repo, ["config", "merge.directoryRenames", setting]);
    await put(repo, "old/first.txt", "tracked");
    await runGit(repo, ["add", "old"]);
    await runGit(repo, ["commit", "-m", "Original directory"]);
    const tip = await incoming(["old/new.env"]);
    await runGit(repo, ["mv", "old", "renamed"]);
    await runGit(repo, ["commit", "-m", "Rename directory locally"]);
    await put(repo, ".git/info/exclude", "*.env\n");
    await put(repo, "renamed/new.env", "private");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip, undefined, ["merge"])).rejects.toThrow(/renamed\/new\.env/);
    expect(await readFile(path.join(repo, "renamed", "new.env"), "utf8")).toBe("private");
    expect((await runGit(repo, ["ls-files", "--stage"])).stdout).not.toContain("new.env");
  });

  it.each([false, true])("protects an addition relocated by the upstream directory rename (resuming: %s)", async resuming => {
    await put(repo, "old/sub/first", "first");
    await put(repo, "guide", "base");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "Original directory and guide"]);
    await runGit(repo, ["switch", "-c", "incoming"]);
    await runGit(repo, ["mv", "old", "renamed"]);
    await put(repo, "guide", "incoming");
    await runGit(repo, ["commit", "-am", "Move directory upstream"]);
    const tip = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(repo, ["switch", "main"]);
    if (resuming) {
      await put(repo, "guide", "local");
      await runGit(repo, ["commit", "-am", "Stop first on the guide"]);
    }
    await put(repo, "old/local.env", "intermediate tracked version");
    await runGit(repo, ["add", "old/local.env"]);
    await runGit(repo, ["commit", "-m", "Add environment in the original directory"]);
    const add = (await runGit(repo, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    await runGit(repo, ["rm", "old/local.env"]);
    await runGit(repo, ["commit", "-m", "Remove environment"]);
    const remove = (await runGit(repo, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    if (resuming) expect((await tryGit(repo, ["rebase", tip])).code).toBe(1);
    await put(repo, ".git/info/exclude", "*.env\n");
    await put(repo, "renamed/sibling.env", "safe unrelated data");
    const check = () => resuming ? assertNoReplayCollision(repo, [add, remove])
      : assertNoIgnoredCheckoutCollision(repo, tip, `${tip}..HEAD`);
    await expect(check()).resolves.toBeUndefined();
    await put(repo, "renamed/local.env", "private data at the real replay destination");
    await expect(check()).rejects.toThrow(/renamed\/local\.env/);
    expect(await readFile(path.join(repo, "renamed", "local.env"), "utf8")).toBe("private data at the real replay destination");
  });

  it("permits a replay when an upstream file move leaves the original directory in place", async () => {
    await put(repo, "old/moved", "moves");
    await put(repo, "old/stays", "stays");
    await runGit(repo, ["add", "old"]);
    await runGit(repo, ["commit", "-m", "Original files"]);
    await runGit(repo, ["switch", "-c", "incoming"]);
    await mkdir(path.join(repo, "new"));
    await runGit(repo, ["mv", "old/moved", "new/moved"]);
    await runGit(repo, ["commit", "-m", "Move one file"]);
    const tip = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(repo, ["switch", "main"]);
    await put(repo, "old/next.env", "committed change");
    await runGit(repo, ["add", "old/next.env"]);
    await runGit(repo, ["commit", "-m", "Add beside the file that stays"]);
    await put(repo, ".git/info/exclude", "*.env\n");
    await put(repo, "new/next.env", "unrelated private data");
    await assertNoIgnoredCheckoutCollision(repo, tip, `${tip}..HEAD`);
    await runGit(repo, ["rebase", tip]);
    expect(await readFile(path.join(repo, "new", "next.env"), "utf8")).toBe("unrelated private data");
    expect(await readFile(path.join(repo, "old", "next.env"), "utf8")).toBe("committed change");
  });

  it("preserves an untracked file that becomes ignored before a later commit replays", async () => {
    const tip = await incoming([".gitignore"], "cache.env\n");
    await put(repo, "cache.env", "tracked in an intermediate commit");
    await runGit(repo, ["add", "cache.env"]);
    await runGit(repo, ["commit", "-m", "Add environment"]);
    await runGit(repo, ["rm", "cache.env"]);
    await runGit(repo, ["commit", "-m", "Drop environment"]);
    await put(repo, "cache.env", "local untracked data");
    expect((await runGit(repo, ["status", "--porcelain"])).stdout.trimEnd()).toBe("?? cache.env");
    await expect(assertNoIgnoredCheckoutCollision(repo, tip, `${tip}..HEAD`)).rejects.toThrow(/untracked local data at cache\.env/);
    expect(await readFile(path.join(repo, "cache.env"), "utf8")).toBe("local untracked data");
  });

  it("checks only the commits remaining after a paused rebase, including data created during the pause", async () => {
    await put(repo, "guide", "base");
    await runGit(repo, ["add", "guide"]);
    await runGit(repo, ["commit", "-m", "Base guide"]);
    const tip = await incoming(["guide"]);
    await put(repo, "guide", "local");
    await runGit(repo, ["add", "guide"]);
    await runGit(repo, ["commit", "-m", "Conflicting guide"]);
    await put(repo, "future.txt", "future file");
    await runGit(repo, ["add", "future.txt"]);
    await runGit(repo, ["commit", "-m", "Introduce file"]);
    const add = (await runGit(repo, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    await put(repo, "later.txt", "independent");
    await runGit(repo, ["add", "later.txt"]);
    await runGit(repo, ["commit", "-m", "Later independent file"]);
    const later = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect((await tryGit(repo, ["rebase", tip])).code).toBe(1);
    await put(repo, "future.txt", "private data created while paused");
    await expect(assertNoReplayCollision(repo, [later])).resolves.toBeUndefined();
    await expect(assertNoReplayCollision(repo, [add, later])).rejects.toThrow(/untracked local data at future\.txt/);
    await put(repo, ".git/info/exclude", "future.txt\n");
    await expect(assertNoReplayCollision(repo, [add])).rejects.toThrow(/ignored local data.*future\.txt/);
    expect(await readFile(path.join(repo, "future.txt"), "utf8")).toBe("private data created while paused");
    expect((await runGit(repo, ["ls-files", "-u"])).stdout).toContain("guide");
  });

  it("protects an ignored collision before an empty clone's first checkout", async () => {
    const tip = await incoming(["local.env"]);
    const unborn = path.join(root, "unborn");
    await runGit(root, ["init", "-b", "main", unborn]);
    await runGit(unborn, ["fetch", repo, tip]);
    await put(unborn, ".git/info/exclude", "*.env\n");
    await put(unborn, "local.env", "private environment");
    await expect(assertNoIgnoredCheckoutCollision(unborn, tip)).rejects.toThrow(/local\.env/);
    expect(await readFile(path.join(unborn, "local.env"), "utf8")).toBe("private environment");
  });
});
