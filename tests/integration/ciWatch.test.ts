import { mkdtemp, mkdir, writeFile, realpath, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../electron/git/exec.js";
import { addCiWatch, removeCiWatch, getCiRun, getCiJobs, getCiWorkflows, validateCiRepository } from "../../electron/git/ciWatch.js";
import { defaultSettings, type AppSettings } from "../../src/types/settings.js";

let settings: AppSettings;
vi.mock("../../electron/settings.js", () => ({
  getSettings: () => settings,
  updateSettings: (partial: Partial<AppSettings>) => { settings = { ...settings, ...partial }; return settings; }
}));

let root: string;
let repository: string;
let outside: string;
let request: ReturnType<typeof vi.fn>;
const run = {
  id: 41, run_attempt: 2, name: "Deploy production", display_title: "Release search", run_number: 18,
  head_branch: "release/production", head_sha: "abcdef1234567890", status: "in_progress", conclusion: null,
  created_at: "2026-10-05T10:00:00Z", run_started_at: "2026-10-05T10:01:00Z", updated_at: "2026-10-05T10:02:00Z",
  html_url: "https://github.com/example/storefront/actions/runs/41"
};

function response(body: unknown, status = 200) {
  return { ok: status === 200, status, json: async () => body };
}

describe("CI Watch GitHub integration", () => {
  beforeEach(async () => {
    settings = { ...defaultSettings, ciWatches: [] };
    root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-ci-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "repo-radar-ci-outside-"));
    repository = path.join(root, "storefront");
    await mkdir(repository);
    await runGit(repository, ["init", "-b", "feature/local"]);
    await runGit(repository, ["remote", "add", "origin", "git@github.com:example/storefront.git"]);
    request = vi.fn().mockResolvedValue(response({ workflow_runs: [run] }));
    vi.stubGlobal("fetch", request);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const target of [root, outside]) {
      if (path.dirname(target) !== os.tmpdir() || !path.basename(target).startsWith("repo-radar-ci-")) throw new Error("Unexpected fixture cleanup path.");
    }
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("queries a remote branch and chosen workflow without changing the checkout or working tree", async () => {
    await writeFile(path.join(repository, "unfinished.txt"), "local work");
    const before = (await runGit(repository, ["status", "--porcelain=v2", "--branch"])).stdout;
    const result = await getCiRun(repository, root, "release/production", 8);
    expect(result).toMatchObject({ id: 41, attempt: 2, workflowName: "Deploy production", commit: "abcdef1234567890", branch: "release/production", status: "in_progress" });
    const url = new URL(request.mock.calls[0][0]);
    expect(url.pathname).toBe("/repos/example/storefront/actions/workflows/8/runs");
    expect(url.searchParams.get("branch")).toBe("release/production");
    expect((await runGit(repository, ["status", "--porcelain=v2", "--branch"])).stdout).toBe(before);
  });

  it("keeps two repositories with the same branch independent", async () => {
    const second = path.join(root, "payments");
    await mkdir(second);
    await runGit(second, ["init"]);
    await runGit(second, ["remote", "add", "origin", "https://github.com/example/payments.git"]);
    await getCiRun(repository, root, "main");
    await getCiRun(second, root, "main");
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/repos/example/storefront/actions/runs", "/repos/example/payments/actions/runs"
    ]);
  });

  it("persists separate watches and ignores duplicates", async () => {
    const input = { repoPath: repository, branch: "main", workflowId: 8, workflowName: "Deploy production" };
    const first = await addCiWatch(input, root);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ repoPath: await realpath(repository), branch: "main", workflowId: 8 });
    expect(await addCiWatch(input, root)).toEqual(first);
    await addCiWatch({ ...input, workflowId: 9, workflowName: "Tests" }, root);
    await addCiWatch({ ...input, branch: "develop" }, root);
    expect(settings.ciWatches).toHaveLength(3);
    expect(removeCiWatch(first[0].id)).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("supports nested repositories but rejects subfolders, outside paths, and symlink escapes before network calls", async () => {
    const nested = path.join(repository, "nested");
    await mkdir(nested);
    await runGit(nested, ["init"]);
    await expect(validateCiRepository(nested, root)).resolves.toBe(await realpath(nested));
    const subfolder = path.join(repository, "src");
    await mkdir(subfolder);
    await expect(getCiRun(subfolder, root, "main")).rejects.toThrow("not a subfolder");
    await expect(getCiRun(outside, root, "main")).rejects.toThrow("outside the selected root");
    const escape = path.join(root, "escape");
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
    await expect(getCiRun(escape, root, "main")).rejects.toThrow("outside the selected root");
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves discovery's path identity when the selected root is a folder alias", async () => {
    const alias = path.join(outside, "root-alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasRepo = path.join(alias, "storefront");
    const watches = await addCiWatch({ repoPath: aliasRepo, branch: "production" }, alias);
    expect(watches[0].repoPath).toBe(path.resolve(aliasRepo));
    await expect(getCiRun(watches[0].repoPath, alias, watches[0].branch)).resolves.toMatchObject({ id: 41 });
  });

  it("rejects invalid workflow/run IDs and non-GitHub origin remotes", async () => {
    await expect(getCiRun(repository, root, "main", -1)).rejects.toThrow("Invalid workflow");
    await expect(getCiJobs(repository, root, 0, 1)).rejects.toThrow("Invalid run");
    await expect(getCiJobs(repository, root, 41, 0)).rejects.toThrow("Invalid run attempt");
    await expect(getCiRun(repository, root, "")).rejects.toThrow("branch name");
    await runGit(repository, ["remote", "set-url", "origin", "https://example.com/owner/repo.git"]);
    await expect(getCiRun(repository, root, "main")).rejects.toThrow("github.com");
    await runGit(repository, ["remote", "set-url", "origin", "https://github.com/owner/repo/../../other?secret=yes"]);
    await expect(getCiRun(repository, root, "main")).rejects.toThrow("github.com");
    expect(request).not.toHaveBeenCalled();
  });

  it("distinguishes no run from denied access and keeps actionable authentication errors", async () => {
    request.mockResolvedValueOnce(response({ workflow_runs: [] }));
    await expect(getCiRun(repository, root, "main")).resolves.toBeNull();
    request.mockResolvedValueOnce(response({ message: "Bad credentials" }, 401));
    await expect(getCiRun(repository, root, "main")).rejects.toThrow(/token.*invalid/);
  });

  it("paginates workflows and all jobs/steps for the requested rerun attempt", async () => {
    request.mockResolvedValueOnce(response({ workflows: Array.from({ length: 100 }, (_, id) => ({ id: id + 1, name: "Build", path: "ci.yml", state: "active" })) }))
      .mockResolvedValueOnce(response({ workflows: [{ id: 101, name: "Deploy", path: "deploy.yml", state: "disabled_manually" }] }));
    expect(await getCiWorkflows(repository, root)).toHaveLength(101);
    const job = { id: 1, name: "Deploy", status: "in_progress", conclusion: null, started_at: run.created_at, completed_at: null, html_url: run.html_url, steps: [{ number: 1, name: "Build", status: "completed", conclusion: "success" }, { number: 2, name: "Deploy", status: "in_progress", conclusion: null }] };
    request.mockResolvedValueOnce(response({ jobs: Array.from({ length: 100 }, (_, id) => ({ ...job, id })) }))
      .mockResolvedValueOnce(response({ jobs: [{ ...job, id: 100 }] }));
    const jobs = await getCiJobs(repository, root, 41, 2);
    expect(jobs).toHaveLength(101);
    expect(jobs[0].steps).toEqual(job.steps);
    expect(request.mock.calls[3][0]).toContain("runs/41/attempts/2/jobs?per_page=100&page=2");
  });
});
