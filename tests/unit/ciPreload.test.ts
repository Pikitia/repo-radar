import { describe, expect, it, vi } from "vitest";
import type { RepoRadarApi } from "../../src/types/api.js";

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: { invoke: electron.invoke } }));

describe("CI preload contract", () => {
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
