// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit, tryGit } from "../../electron/git/exec.js";
import { configuredPullRebase, fastForwardPlan, mergeOptionWords, syncPullPlan } from "../../electron/git/syncPull.js";
import { defaultSettings } from "../../src/types/settings.js";

describe("pulling the checked commit", () => {
  let root: string;
  let local: string;
  let upstream: string;
  const git = async (repo: string, ...args: string[]) => (await runGit(repo, args)).stdout.trimEnd();
  async function commit(repo: string, file: string) {
    await writeFile(path.join(repo, file), file + "\n");
    await git(repo, "add", "--", file);
    await git(repo, "commit", "-m", file);
    return git(repo, "rev-parse", "HEAD");
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "radar-pinned-pull-"));
    const config = path.join(root, "gitconfig");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    await writeFile(config, "[user]\n\tname = Fixture\n\temail = fixture@example.test\n");
    local = path.join(root, "local");
    upstream = path.join(root, "upstream");
    await git(root, "init", "-b", "main", upstream);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function rewritten() {
    const base = await commit(upstream, "base");
    const old = await commit(upstream, "dropped-by-upstream");
    await git(root, "clone", upstream, local);
    await commit(local, "local-change");
    await git(upstream, "branch", "-m", "previous-main");
    await git(upstream, "switch", "-c", "main", base);
    const incoming = await commit(upstream, "checked-upstream");
    await git(local, "fetch", "--prune");
    await commit(upstream, "arrived-after-check");
    return { old, incoming };
  }

  it("replays just the local commits and honors configured rebase-merges over a pinned rewritten upstream", async () => {
    const { old, incoming } = await rewritten();
    await git(local, "switch", "-c", "topic");
    await commit(local, "topic");
    await git(local, "switch", "main");
    await commit(local, "parallel-change");
    await git(local, "merge", "--no-ff", "--no-edit", "topic");
    await git(local, "config", "pull.rebase", "false");
    await git(local, "config", "branch.main.rebase", "merges");
    expect(await configuredPullRebase(local, "main")).toBe("merges");
    const plan = await syncPullPlan(local, "main", true, defaultSettings, incoming);
    expect(plan.replayRange).toBe(`${old}..HEAD`);
    await git(local, ...plan.args);
    expect((await git(local, "ls-tree", "--name-only", "HEAD")).split("\n"))
      .toEqual(["base", "checked-upstream", "local-change", "parallel-change", "topic"]);
    expect(await git(local, "rev-list", "--count", "--merges", `${incoming}..HEAD`)).toBe("1");
    expect(await git(local, "rev-parse", "origin/main")).toBe(incoming);
  });

  it("preserves configured fast-forward-only and an explicit app override on divergent histories", async () => {
    const { old, incoming } = await rewritten();
    await git(local, "config", "pull.rebase", "yes");
    await git(local, "config", "pull.ff", "only");
    expect(await configuredPullRebase(local, "main")).toBe("true");
    const guarded = await syncPullPlan(local, "main", true, defaultSettings, incoming);
    expect(guarded.replayRange).toBeUndefined();
    expect((await tryGit(local, guarded.args)).stderr).toMatch(/fast-forward/i);
    const explicit = await syncPullPlan(local, "main", true, { ...defaultSettings, pullStrategy: "rebase" }, incoming);
    expect(explicit.replayRange).toBe(`${old}..HEAD`);
    await git(local, ...explicit.args);
    expect(await git(local, "log", "--format=%s", `${incoming}..HEAD`)).toBe("local-change");
  });

  it("applies branch and pull fast-forward overrides to a reviewed first save", async () => {
    const incoming = await commit(upstream, "base");
    await git(root, "clone", upstream, local);
    await git(local, "config", "merge.ff", "only");
    await git(local, "config", "branch.main.mergeOptions", "--ff-only --ff");
    const first = () => syncPullPlan(local, "main", true, defaultSettings, incoming, true);
    expect((await first()).fastForwardOnly).toBe(false);
    await git(local, "config", "branch.main.mergeOptions", "--ff --ff-only");
    expect((await first()).fastForwardOnly).toBe(true);
    await git(local, "config", "pull.ff", "true");
    expect((await first()).fastForwardOnly).toBe(false);
  });

  it("preserves quoting and escaping in configured merge strategy arguments", () => {
    expect(mergeOptionWords(`-s "o"urs -X 'left "as is"' two\\ words ""`))
      .toEqual(["-s", "ours", "-X", 'left "as is"', "two words", ""]);
    expect(() => mergeOptionWords('--strategy "ours')).toThrow(/unclosed quote/);
    expect(() => mergeOptionWords("--strategy\\")).toThrow(/backslash/);
  });

  it("rebases directly onto an ordinarily diverged commit and exposes its replay range", async () => {
    await commit(upstream, "base");
    await git(root, "clone", upstream, local);
    await commit(local, "mine");
    const incoming = await commit(upstream, "theirs");
    await git(local, "fetch");
    const settings = { ...defaultSettings, pullStrategy: "rebase" as const };
    const plan = await syncPullPlan(local, "main", true, settings, incoming);
    expect(plan).toEqual({ args: ["rebase", "--no-autostash", "--onto", incoming, incoming], replayRange: `${incoming}..HEAD` });
    expect((await syncPullPlan(local, "main", true, defaultSettings, incoming)).args[0]).toBe("merge");
    expect((await syncPullPlan(local, "main", false, settings, incoming)).replayRange).toBeUndefined();
    await git(local, ...plan.args);
    expect(await git(local, "rev-parse", "HEAD^")).toBe(incoming);
  });

  it.each(["signatures", "strategy"] as const)("matches native behind-only pull --rebase for %s", async policy => {
    const base = await commit(upstream, "base");
    await git(root, "clone", upstream, local);
    const reference = path.join(root, "native-pull");
    await git(root, "clone", upstream, reference);
    const incoming = await commit(upstream, "incoming");
    const config = policy === "signatures" ? ["merge.verifySignatures", "true"] : ["pull.twohead", "ours"];
    for (const repo of [local, reference]) await git(repo, "config", ...config);
    await git(local, "fetch");
    const plan = await syncPullPlan(local, "main", false, { ...defaultSettings, pullStrategy: "rebase" }, incoming);
    const native = await tryGit(reference, ["pull", "--rebase", "--no-autostash", "--no-edit"]);
    const checked = await tryGit(local, plan.args);
    expect(checked.code).toBe(native.code);
    if (policy === "signatures") {
      expect(checked.stderr).toMatch(/does not have a .*signature/i);
      expect(await git(local, "rev-parse", "HEAD")).toBe(base);
    } else {
      expect(checked.code).toBe(0);
      expect(await git(local, "show", "-s", "--format=%P", "HEAD")).toBe(`${base} ${incoming}`);
      expect(await git(local, "rev-parse", "HEAD^{tree}")).toBe(await git(reference, "rev-parse", "HEAD^{tree}"));
      expect(await git(local, "ls-tree", "--name-only", "HEAD")).toBe("base");
    }
  });

  it.each(["first", "merge", "rebase"] as const)("integrates the checked %s commit when file transport is denied", async kind => {
    const base = await commit(upstream, "base");
    await git(root, "clone", upstream, local);
    if (kind !== "first") await commit(local, "local");
    const incoming = await commit(upstream, "incoming");
    await git(local, "fetch");
    if (kind === "first") await git(local, "switch", "--orphan", "new");
    await git(local, "config", "protocol.file.allow", "never");
    expect((await tryGit(local, ["fetch", ".", incoming])).stderr).toMatch(/transport 'file' not allowed/);
    const plan = kind === "first" ? fastForwardPlan(incoming) :
      await syncPullPlan(local, "main", true, { ...defaultSettings, pullStrategy: kind }, incoming);
    await git(local, ...plan.args);
    expect((await tryGit(local, ["merge-base", "--is-ancestor", incoming, "HEAD"])).code).toBe(0);
    expect(await git(local, "rev-parse", "HEAD")).not.toBe(base);
  });
});
