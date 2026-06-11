import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { discoverRepositories } from "../../electron/git/discovery";
import { runGit } from "../../electron/git/exec";
import { getRepositoryStatus } from "../../electron/git/status";
import { commit, pull, push, stageFiles, sync } from "../../electron/git/actions";
import { defaultSettings } from "../../src/types/settings";

let root: string;

async function initRepo(name: string) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test User"]);
  await writeFile(path.join(dir, "README.md"), "# Test\n");
  await runGit(dir, ["add", "README.md"]);
  await runGit(dir, ["commit", "-m", "Initial commit"]);
  return dir;
}

describe("Git integration", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-int-"));
  });

  it("discovers repositories while ignoring node_modules and dot folders", async () => {
    const repo = await initRepo("visible");
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await runGit(path.join(root, "node_modules", "ignored"), ["init"]);
    await mkdir(path.join(root, ".hidden", "ignored"), { recursive: true });
    await runGit(path.join(root, ".hidden", "ignored"), ["init"]);

    await expect(discoverRepositories(root, false)).resolves.toEqual([repo]);
  });

  it("detects clean, unstaged, staged, and untracked changes", async () => {
    const repo = await initRepo("states");
    expect((await getRepositoryStatus(repo, root, false)).files).toHaveLength(0);

    await writeFile(path.join(repo, "README.md"), "# Test\nchanged\n");
    let status = await getRepositoryStatus(repo, root, false);
    expect(status.hasUnstagedChanges).toBe(true);

    await runGit(repo, ["add", "README.md"]);
    status = await getRepositoryStatus(repo, root, false);
    expect(status.hasStagedChanges).toBe(true);

    await writeFile(path.join(repo, "new.txt"), "new");
    status = await getRepositoryStatus(repo, root, false);
    expect(status.hasUntrackedFiles).toBe(true);
  });

  it("detects ahead, behind, diverged and supports pull, push, sync", async () => {
    const bare = path.join(root, "remote.git");
    await runGit(root, ["init", "--bare", bare]);
    const repo = await initRepo("local");
    await runGit(repo, ["remote", "add", "origin", bare]);
    await runGit(repo, ["push", "-u", "origin", "master"]);

    await writeFile(path.join(repo, "ahead.txt"), "ahead");
    await runGit(repo, ["add", "ahead.txt"]);
    await runGit(repo, ["commit", "-m", "Ahead"]);
    expect((await getRepositoryStatus(repo, root, true)).ahead).toBe(1);
    await push(repo, root);
    expect((await getRepositoryStatus(repo, root, true)).ahead).toBe(0);

    const clone = path.join(root, "clone");
    await runGit(root, ["clone", bare, clone]);
    await runGit(clone, ["config", "user.email", "test@example.com"]);
    await runGit(clone, ["config", "user.name", "Test User"]);
    await writeFile(path.join(clone, "behind.txt"), "behind");
    await runGit(clone, ["add", "behind.txt"]);
    await runGit(clone, ["commit", "-m", "Behind"]);
    await runGit(clone, ["push"]);

    let status = await getRepositoryStatus(repo, root, true);
    expect(status.behind).toBe(1);
    await pull(repo, root, defaultSettings);
    expect(await readFile(path.join(repo, "behind.txt"), "utf8")).toBe("behind");

    await writeFile(path.join(clone, "remote.txt"), "remote");
    await runGit(clone, ["add", "remote.txt"]);
    await runGit(clone, ["commit", "-m", "Remote"]);
    await runGit(clone, ["push"]);
    await writeFile(path.join(repo, "local.txt"), "local");
    await runGit(repo, ["add", "local.txt"]);
    await runGit(repo, ["commit", "-m", "Local"]);
    status = await getRepositoryStatus(repo, root, true);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(1);
    await sync(repo, root, defaultSettings);
    status = await getRepositoryStatus(repo, root, true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("handles fetch failures and commit flow", async () => {
    const repo = await initRepo("commit");
    await runGit(repo, ["remote", "add", "origin", path.join(root, "missing.git")]);
    const status = await getRepositoryStatus(repo, root, true);
    expect(status.warnings.some((warning) => warning.code === "fetch-failed")).toBe(true);

    await writeFile(path.join(repo, "file.txt"), "content");
    await stageFiles(repo, root, ["file.txt"]);
    await commit(repo, root, "Add file");
    const clean = await getRepositoryStatus(repo, root, false);
    expect(clean.files).toHaveLength(0);
  });
});
