import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as git from "../../electron/git/exec.js";
import { getDevelopPullRequestPreview, promoteDevelop } from "../../electron/git/pullRequests.js";
import { defaultSettings, type AppSettings } from "../../src/types/settings.js";

let settings: AppSettings;
vi.mock("../../electron/settings.js", () => ({ getSettings: () => settings }));

const realGit = git.runGit;
let root: string;
let repository: string;
let remote: string;
let request: ReturnType<typeof vi.fn>;
let developSha: string;
let mainSha: string;
let mergeState: Record<string, unknown>;
let existing = false;
const pr = { number: 42, node_id: "PR_example42", html_url: "https://github.com/example/storefront/pull/42" };

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mutations() {
  return request.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(call[1].body));
}

describe("origin develop pull requests", () => {
  beforeEach(async () => {
    settings = { ...defaultSettings, github: { tokenSource: "settings", token: "fixture-token" } };
    root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-pr-"));
    repository = path.join(root, "storefront");
    remote = path.join(root, "origin.git");
    await mkdir(repository);
    await realGit(root, ["init", "--bare", remote]);
    await realGit(repository, ["init", "-b", "main"]);
    await realGit(repository, ["config", "user.email", "test@example.com"]);
    await realGit(repository, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repository, "README.md"), "main\n");
    await realGit(repository, ["add", "README.md"]);
    await realGit(repository, ["commit", "-m", "Initial"]);
    mainSha = (await realGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
    await realGit(repository, ["remote", "add", "origin", remote]);
    await realGit(repository, ["push", "origin", "main"]);
    await realGit(repository, ["checkout", "-b", "develop"]);
    await writeFile(path.join(repository, "README.md"), "develop\n");
    await realGit(repository, ["commit", "-am", "Published develop"]);
    developSha = (await realGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
    await realGit(repository, ["push", "origin", "develop"]);
    await realGit(repository, ["remote", "set-url", "origin", "https://github.com/example/storefront.git"]);
    // Only transport is redirected. Ref discovery, fetch, prune and comparisons use real temporary Git repositories.
    vi.spyOn(git, "runGit").mockImplementation((cwd, args, timeout) => realGit(cwd,
      args[0] === "fetch" ? ["fetch", "--prune", remote, "+refs/heads/*:refs/remotes/origin/*"] : args, timeout));
    mergeState = {
      headRefOid: developSha, baseRefOid: mainSha, headRefName: "develop", baseRefName: "main",
      headRepository: { nameWithOwner: "example/storefront" }, merged: false, isDraft: false,
      mergeStateStatus: "BLOCKED", autoMergeRequest: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
      repository: { autoMergeAllowed: true, mergeCommitAllowed: true }
    };
    existing = false;
    request = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.includes("/pulls?")) return response(existing ? [pr] : []);
      if (url.endsWith("/pulls")) return response(pr, 201);
      if (body?.query.startsWith("query")) return response({ data: { node: mergeState } });
      if (body?.query.includes("enablePullRequestAutoMerge")) return response({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "now" }, merged: false } } } });
      if (body?.query.includes("mergePullRequest")) return response({ data: { mergePullRequest: { pullRequest: { merged: true } } } });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", request);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("repo-radar-pr-")) throw new Error("Unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  });

  it("uses origin/develop even when local develop has unpublished commits and another branch is checked out", async () => {
    await writeFile(path.join(repository, "README.md"), "local only\n");
    await realGit(repository, ["commit", "-am", "Unpublished local change"]);
    await realGit(repository, ["checkout", "-b", "feature/local"]);
    await writeFile(path.join(repository, "untracked.txt"), "do not publish\n");
    const before = (await realGit(repository, ["status", "--porcelain=v2", "--branch"])).stdout;
    const preview = await getDevelopPullRequestPreview(repository, root);
    expect(preview).toEqual({ repository: "example/storefront", developSha, mainSha, ahead: 1 });
    expect(request).not.toHaveBeenCalled();
    const result = await promoteDevelop(repository, root, preview);
    expect(result).toMatchObject({ outcome: "auto-merge", url: pr.html_url });
    expect((await realGit(repository, ["status", "--porcelain=v2", "--branch"])).stdout).toBe(before);
    expect((await realGit(root, ["--git-dir", remote, "rev-parse", "develop"])).stdout.trim()).toBe(developSha);
    expect(mutations()[0]).toMatchObject({ head: "develop", base: "main" });
    expect(mutations().at(-1).variables.input.expectedHeadOid).toBe(developSha);
    expect(mutations().some((body) => body.query?.includes("mergePullRequest(input"))).toBe(false);
    expect(vi.mocked(git.runGit).mock.calls.some((call) => ["push", "checkout", "merge"].includes(call[1][0]))).toBe(false);
  });

  it("requires both origin branches and a positive remote ahead count, pruning deleted refs", async () => {
    await realGit(root, ["--git-dir", remote, "update-ref", "refs/heads/develop", mainSha]);
    await expect(getDevelopPullRequestPreview(repository, root)).rejects.toThrow("no commits waiting");
    await realGit(root, ["--git-dir", remote, "update-ref", "-d", "refs/heads/main"]);
    await expect(getDevelopPullRequestPreview(repository, root)).rejects.toThrow("Both origin/develop and origin/main");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects changed remote refs before creating a PR", async () => {
    const preview = await getDevelopPullRequestPreview(repository, root);
    await realGit(root, ["--git-dir", remote, "update-ref", "refs/heads/main", developSha]);
    await expect(promoteDevelop(repository, root, preview)).rejects.toThrow("no commits waiting");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects changed remote commits that are still ahead before writes", async () => {
    const preview = await getDevelopPullRequestPreview(repository, root);
    await writeFile(path.join(repository, "README.md"), "next remote\n");
    await realGit(repository, ["commit", "-am", "New remote commit"]);
    await realGit(repository, ["push", remote, "develop"]);
    await expect(promoteDevelop(repository, root, preview)).rejects.toThrow("changed since confirmation");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "FAILURE", "ERROR"])("enables GitHub auto-merge without an immediate merge when checks are %s", async (checks) => {
    mergeState.commits = { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] };
    const preview = await getDevelopPullRequestPreview(repository, root);
    expect((await promoteDevelop(repository, root, preview)).outcome).toBe("auto-merge");
    expect(mutations().some((body) => body.query?.includes("enablePullRequestAutoMerge"))).toBe(true);
    expect(mutations().some((body) => body.query?.includes("mergePullRequest(input"))).toBe(false);
  });

  it("merges a clean PR with successful checks using the confirmed remote commit guard", async () => {
    mergeState.mergeStateStatus = "CLEAN";
    mergeState.commits = { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] };
    const preview = await getDevelopPullRequestPreview(repository, root);
    expect((await promoteDevelop(repository, root, preview)).outcome).toBe("merged");
    expect(mutations().at(-1).variables.input).toEqual({ pullRequestId: pr.node_id, mergeMethod: "MERGE", expectedHeadOid: developSha });
  });

  it("does not merge immediately with no reported checks", async () => {
    mergeState.mergeStateStatus = "CLEAN";
    mergeState.commits = { nodes: [{ commit: { statusCheckRollup: null } }] };
    mergeState.repository = { autoMergeAllowed: false, mergeCommitAllowed: true };
    const result = await promoteDevelop(repository, root, await getDevelopPullRequestPreview(repository, root));
    expect(result).toMatchObject({ outcome: "blocked", url: pr.html_url });
    expect(mutations().filter((body) => body.query?.startsWith("mutation"))).toHaveLength(0);
  });

  it("reuses an open PR and reports already-enabled auto-merge", async () => {
    existing = true;
    mergeState.autoMergeRequest = { enabledAt: "before" };
    const result = await promoteDevelop(repository, root, await getDevelopPullRequestPreview(repository, root));
    expect(result.outcome).toBe("auto-merge");
    expect(mutations().filter((body) => body.head || body.query?.startsWith("mutation"))).toHaveLength(0);
  });

  it.each([
    { isDraft: true },
    { headRefOid: "c".repeat(40) },
    { baseRefOid: "c".repeat(40) },
    { headRepository: { nameWithOwner: "other/storefront" } },
    { repository: { autoMergeAllowed: false, mergeCommitAllowed: true } },
    { repository: { autoMergeAllowed: true, mergeCommitAllowed: false } }
  ])("retains the PR link when GitHub cannot safely merge: %j", async (change) => {
    Object.assign(mergeState, change);
    const result = await promoteDevelop(repository, root, await getDevelopPullRequestPreview(repository, root));
    expect(result).toMatchObject({ outcome: "blocked", url: pr.html_url });
    expect(mutations().some((body) => body.query?.startsWith("mutation"))).toBe(false);
  });

  it("reports GraphQL errors without losing the created PR", async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation((url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      return body?.query?.startsWith("mutation") ? response({ errors: [{ message: "Auto-merge is not permitted" }] }) : normal(url, init);
    });
    const result = await promoteDevelop(repository, root, await getDevelopPullRequestPreview(repository, root));
    expect(result).toMatchObject({ outcome: "blocked", url: pr.html_url });
    expect(result.message).toContain("Auto-merge is not permitted");
  });

  it("waits for GitHub's initial merge eligibility computation before requesting auto-merge", async () => {
    const normal = request.getMockImplementation()!;
    let reads = 0;
    request.mockImplementation((url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (body?.query?.startsWith("query") && reads++ === 0) return response({ data: { node: { ...mergeState, mergeStateStatus: "UNKNOWN" } } });
      return normal(url, init);
    });
    const result = await promoteDevelop(repository, root, await getDevelopPullRequestPreview(repository, root));
    expect(result.outcome).toBe("auto-merge");
    expect(reads).toBe(2);
  });

  it("prevents concurrent submissions for the same repository", async () => {
    const preview = await getDevelopPullRequestPreview(repository, root);
    const first = promoteDevelop(repository, root, preview);
    await expect(promoteDevelop(repository, root, preview)).rejects.toThrow("already running");
    expect((await first).outcome).toBe("auto-merge");
    expect(mutations().filter((body) => body.head === "develop")).toHaveLength(1);
  });

  it("rejects missing credentials before writes and gives permission guidance for a failed create", async () => {
    const preview = await getDevelopPullRequestPreview(repository, root);
    settings.github.token = "";
    await expect(promoteDevelop(repository, root, preview)).rejects.toThrow("Configure a GitHub token");
    expect(request).not.toHaveBeenCalled();
    settings.github.token = "fixture-token";
    request.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ message: "Denied" }, 403));
    await expect(promoteDevelop(repository, root, preview)).rejects.toThrow("Pull requests read/write");
  });

  it("validates repository roots and symlink escapes before Git fetch or provider requests", async () => {
    const subfolder = path.join(repository, "src");
    await mkdir(subfolder);
    await expect(getDevelopPullRequestPreview(subfolder, root)).rejects.toThrow("not a subfolder");
    await expect(getDevelopPullRequestPreview(repository, remote)).rejects.toThrow("outside the selected root");
    const escape = path.join(remote, "escape");
    await symlink(repository, escape, process.platform === "win32" ? "junction" : "dir");
    await expect(getDevelopPullRequestPreview(escape, remote)).rejects.toThrow("outside the selected root");
    expect(request).not.toHaveBeenCalled();
    expect(vi.mocked(git.runGit).mock.calls.some((call) => call[1][0] === "fetch")).toBe(false);
    expect(await realpath(repository)).toBeTruthy();
  });

  it("rejects non-GitHub origins without a provider request", async () => {
    await realGit(repository, ["remote", "set-url", "origin", "https://gitlab.com/example/storefront.git"]);
    await expect(getDevelopPullRequestPreview(repository, root)).rejects.toThrow("github.com origin");
    expect(request).not.toHaveBeenCalled();
  });
});
