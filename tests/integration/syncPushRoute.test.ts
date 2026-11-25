// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmSyncPush, sync } from "../../electron/git/actions.js";
import { tryGit } from "../../electron/git/exec.js";
import { defaultSettings } from "../../src/types/settings.js";

let root: string;
let repo: string;
let upstream: string;
let fork: string;
let base: string;
let head: string;

async function git(dir: string, ...args: string[]) {
  const result = await tryGit(dir, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trimEnd();
}

describe("sync push routing", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-route-"));
    repo = path.join(root, "working");
    upstream = path.join(root, "upstream.git");
    fork = path.join(root, "fork.git");
    const config = path.join(root, "gitconfig");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    await writeFile(config, "[user]\n\tname=Fixture\n\temail=fixture@example.test\n");
    await git(root, "init", "-b", "main", repo);
    await git(root, "init", "--bare", "-b", "main", upstream);
    await git(root, "init", "--bare", "-b", "main", fork);
    await git(repo, "remote", "add", "origin", upstream);
    await git(repo, "remote", "add", "fork", fork);
    await git(repo, "commit", "--allow-empty", "-m", "Common base");
    base = await git(repo, "rev-parse", "HEAD");
    await git(repo, "push", "-u", "origin", "main");
    await git(repo, "commit", "--allow-empty", "-m", "Local work");
    head = await git(repo, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("asks before sending to a fork and rechecks the branch, commit and configured destination", async () => {
    await git(repo, "config", "remote.pushDefault", "origin");
    await git(repo, "config", "branch.main.pushRemote", "fork");
    const pending = (await sync(repo, root, defaultSettings, "main")).syncPushReview!;
    expect(pending).toMatchObject({ upstream: "origin/main", destination: "fork/main" });
    expect(await git(fork, "for-each-ref", "--format=%(refname)")).toBe("");
    await git(repo, "config", "branch.main.pushRemote", "origin");
    await expect(confirmSyncPush(repo, root, pending.token)).rejects.toThrow(/changed/i);
    expect(await git(upstream, "rev-parse", "main")).toBe(base);
    await git(repo, "config", "--unset", "branch.main.pushRemote");
    await git(repo, "config", "remote.pushDefault", "fork");
    await git(repo, "commit", "--allow-empty", "-m", "New local work");
    await expect(confirmSyncPush(repo, root, pending.token)).rejects.toThrow(/changed/i);
    expect(await git(fork, "for-each-ref", "--format=%(refname)")).toBe("");
    const fresh = (await sync(repo, root, defaultSettings, "main")).syncPushReview!;
    await confirmSyncPush(repo, root, fresh.token);
    expect(await git(fork, "rev-parse", "main")).toBe(await git(repo, "rev-parse", "main"));
    expect(await git(upstream, "rev-parse", "main")).toBe(base);
    const repeated = await sync(repo, root, defaultSettings, "main");
    expect(repeated.ahead).toBeGreaterThan(0);
    expect(repeated.syncPushReview).toBeUndefined();
  });

  it("updates the fork after fast-forwarding to the fetch upstream and skips a repeat push", async () => {
    await git(repo, "push", "fork", `${base}:refs/heads/main`);
    await git(repo, "push", "origin", "main");
    await git(repo, "switch", "-c", "other-machine");
    await git(repo, "commit", "--allow-empty", "-m", "Incoming work");
    const incoming = await git(repo, "rev-parse", "HEAD");
    await git(repo, "push", "origin", "HEAD:refs/heads/main");
    await git(repo, "switch", "main");
    await git(repo, "config", "branch.main.pushRemote", "fork");
    const caughtUp = await sync(repo, root, defaultSettings, "main");
    expect(caughtUp).toMatchObject({ behind: 0, ahead: 0, syncPushReview: { destination: "fork/main" } });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(incoming);
    expect(await git(fork, "rev-parse", "main")).toBe(base);
    await confirmSyncPush(repo, root, caughtUp.syncPushReview!.token);
    expect(await git(fork, "rev-parse", "main")).toBe(incoming);
    expect((await sync(repo, root, defaultSettings, "main")).syncPushReview).toBeUndefined();
  });

  it("handles an unrelated rejected ref independently and honors a rejection of the selected branch", async () => {
    await git(repo, "branch", "topic", base);
    await git(repo, "push", "origin", `${head}:refs/heads/topic`);
    await git(repo, "config", "--add", "remote.origin.push", "main:refs/heads/review");
    await git(repo, "config", "--add", "remote.origin.push", "topic:refs/heads/topic");
    const pending = (await sync(repo, root, defaultSettings, "main")).syncPushReview!;
    expect(pending.destination).toBe("origin/review");
    await confirmSyncPush(repo, root, pending.token);
    expect(await git(upstream, "rev-parse", "review")).toBe(head);
    expect(await git(upstream, "rev-parse", "topic")).toBe(head);
    await git(repo, "switch", "-c", "other-machine");
    await git(repo, "commit", "--allow-empty", "-m", "Advance review independently");
    const other = await git(repo, "rev-parse", "HEAD");
    await git(repo, "push", "origin", "HEAD:refs/heads/review");
    await git(repo, "switch", "main");
    await expect(sync(repo, root, defaultSettings, "main")).rejects.toThrow(/rejected/i);
    expect(await git(upstream, "rev-parse", "review")).toBe(other);
  });

  it("finishes a clean central checkout with pushing disabled", async () => {
    await git(repo, "push", "origin", "main");
    await git(repo, "config", "push.default", "nothing");
    const clean = await sync(repo, root, defaultSettings, "main");
    expect(clean).toMatchObject({ ahead: 0, behind: 0 });
    expect(clean.syncPushReview).toBeUndefined();
    await git(repo, "config", "push.default", "current");
    await git(repo, "config", "remote.origin.receivepack", "unavailable-receive-pack");
    expect((await sync(repo, root, defaultSettings, "main")).ahead).toBe(0);
  });

  it("reports an unavailable fork even when the fetch upstream is current", async () => {
    await git(repo, "push", "origin", "main");
    await git(repo, "remote", "set-url", "--push", "fork", path.join(root, "missing.git"));
    await git(repo, "config", "branch.main.pushRemote", "fork");
    await expect(sync(repo, root, defaultSettings, "main")).rejects.toThrow(/repository/i);
    expect(await git(fork, "for-each-ref", "--format=%(refname)")).toBe("");
    expect(await git(upstream, "rev-parse", "main")).toBe(head);
  });

  it("respects configured refspecs and pushes only the reviewed branch", async () => {
    await git(repo, "branch", "another", head);
    await git(repo, "config", "--add", "remote.origin.push", "main:refs/heads/review");
    await git(repo, "config", "--add", "remote.origin.push", "another:refs/heads/unrelated");
    const pending = (await sync(repo, root, defaultSettings, "main")).syncPushReview!;
    expect(pending.destination).toBe("origin/review");
    await confirmSyncPush(repo, root, pending.token);
    expect(await git(upstream, "rev-parse", "review")).toBe(head);
    expect(await git(upstream, "rev-parse", "main")).toBe(base);
    expect(await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/unrelated")).toBe("");
    await git(repo, "config", "--add", "remote.origin.push", "main:refs/heads/also-review");
    await expect(sync(repo, root, defaultSettings, "main")).rejects.toThrow(/single destination/i);
    expect(await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/also-review")).toBe("");
  });

  it("honors simple, current and nothing policies with a differently named local branch", async () => {
    await git(repo, "branch", "-m", "work");
    await expect(sync(repo, root, defaultSettings, "work")).rejects.toThrow();
    await git(repo, "config", "push.default", "nothing");
    await expect(sync(repo, root, defaultSettings, "work")).rejects.toThrow();
    await git(repo, "config", "push.default", "current");
    const pending = (await sync(repo, root, defaultSettings, "work")).syncPushReview!;
    expect(pending).toMatchObject({ upstream: "origin/main", destination: "origin/work" });
    await confirmSyncPush(repo, root, pending.token);
    expect(await git(upstream, "rev-parse", "work")).toBe(head);
    expect(await git(upstream, "rev-parse", "main")).toBe(base);
  });

  it("refreshes the upstream after pushing to a differently spelled alias of the same repository", async () => {
    await git(repo, "remote", "add", "writer", pathToFileURL(upstream).href);
    await git(repo, "config", "branch.main.pushRemote", "writer");
    const pending = (await sync(repo, root, defaultSettings, "main")).syncPushReview!;
    expect(pending.destination).toBe("writer/main");
    const result = await confirmSyncPush(repo, root, pending.token);
    expect(result).toMatchObject({ ahead: 0, behind: 0, aheadCommits: [] });
    expect(await git(repo, "rev-parse", "origin/main")).toBe(head);
    expect(await git(upstream, "rev-parse", "main")).toBe(head);
  });

  it("confirms a separate push URL and refreshes counts from the fetch URL", async () => {
    await git(repo, "remote", "set-url", "--push", "origin", fork);
    const pending = (await sync(repo, root, defaultSettings, "main")).syncPushReview!;
    expect(pending.upstream).toBe("origin/main");
    expect(pending.destination).toContain("fork.git");
    expect(await git(fork, "for-each-ref", "--format=%(refname)")).toBe("");
    const result = await confirmSyncPush(repo, root, pending.token);
    expect(result.ahead).toBe(1);
    expect(await git(fork, "rev-parse", "main")).toBe(head);
    expect(await git(upstream, "rev-parse", "main")).toBe(base);
    expect((await sync(repo, root, defaultSettings, "main")).syncPushReview).toBeUndefined();
    await git(repo, "remote", "set-url", "--add", "--push", "origin", upstream);
    await expect(sync(repo, root, defaultSettings, "main")).rejects.toThrow(/multiple push URLs/i);
    expect(await git(upstream, "rev-parse", "main")).toBe(base);
  });

  it("reports an upstream branch deleted on another machine after pruning it", async () => {
    await git(upstream, "update-ref", "-d", "refs/heads/main");
    await expect(sync(repo, root, defaultSettings, "main")).rejects.toThrow(/upstream branch origin\/main is missing/i);
    expect(await git(repo, "rev-parse", "main")).toBe(head);
    expect(await git(upstream, "for-each-ref", "--format=%(refname)")).toBe("");
  });
});
