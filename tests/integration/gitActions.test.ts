import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { discoverRepositories } from "../../electron/git/discovery";
import { runGit } from "../../electron/git/exec";
import { getRepositoryStatus } from "../../electron/git/status";
import { getCommitDiff } from "../../electron/git/diff";
import { bumpPackageVersion, commit, pull, push, stageFiles, sync } from "../../electron/git/actions";
import { getBranchComparison } from "../../electron/git/branchComparison";
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

  it("discovers immediate child repositories when the configured root is also a repository", async () => {
    const rootRepo = await initRepo(".");
    const childRepo = await initRepo("child");
    const nestedRepo = await initRepo(path.join("child", "nested"));
    const repoBelowNonRepoChild = await initRepo(path.join("container", "nested"));

    await expect(discoverRepositories(root, false)).resolves.toEqual([childRepo, rootRepo].sort((a, b) => a.localeCompare(b)));
    await expect(discoverRepositories(root, true)).resolves.toEqual(
      [childRepo, nestedRepo, repoBelowNonRepoChild, rootRepo].sort((a, b) => a.localeCompare(b))
    );
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

  it("compares origin develop and main branch gaps with package versions", async () => {
    const bare = path.join(root, "branches-remote.git");
    await runGit(root, ["init", "--bare", bare]);
    const repo = await initRepo("branches");
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "branches", version: "1.0.0" }, null, 2));
    await runGit(repo, ["add", "package.json"]);
    await runGit(repo, ["commit", "-m", "Add package"]);
    await runGit(repo, ["branch", "-M", "main"]);
    await runGit(repo, ["remote", "add", "origin", bare]);
    await runGit(repo, ["push", "-u", "origin", "main"]);

    await runGit(repo, ["checkout", "-b", "develop"]);
    await writeFile(path.join(repo, "develop.txt"), "develop");
    await runGit(repo, ["add", "develop.txt"]);
    await runGit(repo, ["commit", "-m", "Develop only"]);
    await runGit(repo, ["push", "-u", "origin", "develop"]);

    await runGit(repo, ["checkout", "main"]);
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "branches", version: "1.0.1" }, null, 2));
    await writeFile(path.join(repo, "main.txt"), "main");
    await runGit(repo, ["add", "package.json", "main.txt"]);
    await runGit(repo, ["commit", "-m", "Main release"]);
    await runGit(repo, ["push"]);
    await runGit(repo, ["checkout", "develop"]);

    await getRepositoryStatus(repo, root, true);
    const comparison = await getBranchComparison(repo);
    expect(comparison).toMatchObject({
      developRef: "origin/develop",
      mainRef: "origin/main",
      developVersion: "1.0.0",
      mainVersion: "1.0.1",
      developBehindMain: 1,
      developAheadMain: 1
    });
    expect(comparison?.commitsInDevelopNotMain).toEqual([
      expect.objectContaining({ subject: "Develop only", files: expect.arrayContaining(["develop.txt"]) })
    ]);
    const diff = await getCommitDiff(repo, comparison?.commitsInDevelopNotMain[0].hash ?? "");
    expect(diff.text).toContain("develop.txt");
    expect(diff.text).toContain("+develop");
  });

  it("bumps root package version and stages package.json before committing", async () => {
    const repo = await initRepo("version-bump");
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "version-bump", version: "1.2.3" }, null, 2));
    await stageFiles(repo, root, ["package.json"]);
    await commit(repo, root, "Add package");

    await writeFile(path.join(repo, "README.md"), "# Test\nchanged\n");
    await bumpPackageVersion(repo, root);

    const status = await getRepositoryStatus(repo, root, false);
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "package.json", staged: true }),
      expect.objectContaining({ path: "README.md", unstaged: true })
    ]));
    expect(JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version).toBe("1.2.4");
  });
});
