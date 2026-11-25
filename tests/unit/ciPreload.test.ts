import { describe, expect, it, vi } from "vitest";
import type { RepoRadarApi } from "../../src/types/api.js";

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: { invoke: electron.invoke } }));

describe("CI preload contract", () => {
  it("forwards sync reviews and decisions through the typed repository channels", async () => {
    await import("../../electron/preload.js");
    const api = electron.exposeInMainWorld.mock.calls[0][1] as RepoRadarApi;
    const repo = "C:/root/repo";
    const decisions = [{ path: "notes.txt", choice: "edited" as const, text: "combined\n" }];
    electron.invoke.mockClear();
    await api.sync(repo, "develop");
    await api.getSyncConflictReview(repo);
    await api.finishSync(repo, "review", decisions);
    await api.finishSync(repo, "empty-patch", [], true);
    const expected = { branch: "main", token: "staged-state" };
    await api.commitAndSync(repo, expected, ["notes.txt"], "Save notes");
    await api.confirmSyncPush(repo, "destination-review");
    expect(electron.invoke.mock.calls).toEqual([
      ["repo:sync", repo, "develop"], ["repo:syncConflictReview", repo], ["repo:finishSync", repo, "review", decisions, false],
      ["repo:finishSync", repo, "empty-patch", [], true],
      ["repo:commitAndSync", repo, expected, ["notes.txt"], "Save notes"], ["repo:confirmSyncPush", repo, "destination-review"]
    ]);
    electron.invoke.mockClear();
  });
  it("exposes only typed develop PR preview and confirmed promotion channels", async () => {
    await import("../../electron/preload.js");
    const api = electron.exposeInMainWorld.mock.calls[0][1] as RepoRadarApi;
    electron.invoke.mockClear();
    const expected = { repository: "example/repo", developSha: "a".repeat(40), mainSha: "b".repeat(40), ahead: 1 };
    await api.getDevelopPullRequestPreview("C:/root/repo");
    await api.promoteDevelop("C:/root/repo", expected);
    expect(electron.invoke.mock.calls).toEqual([
      ["repo:developPullRequestPreview", "C:/root/repo"], ["repo:promoteDevelop", "C:/root/repo", expected]
    ]);
    electron.invoke.mockClear();
  });
  it("maps typed watch operations to the narrow main-process channels", async () => {
    await import("../../electron/preload.js");
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith("repoRadar", expect.any(Object));
    const api = electron.exposeInMainWorld.mock.calls[0][1] as RepoRadarApi;
    const watch = { repoPath: "C:/root/repo", branch: "main", workflowId: 8, workflowName: "Deploy" };
    await api.addCiWatch(watch);
    await api.removeCiWatch("watch-1");
    await api.getCiWorkflows(watch.repoPath);
    await api.getCiRun(watch.repoPath, watch.branch, watch.workflowId);
    await api.getCiJobs(watch.repoPath, 41, 2);
    expect(electron.invoke.mock.calls).toEqual([
      ["ci:addWatch", watch], ["ci:removeWatch", "watch-1"], ["ci:workflows", watch.repoPath],
      ["ci:run", watch.repoPath, "main", 8], ["ci:jobs", watch.repoPath, 41, 2]
    ]);
  });
});
