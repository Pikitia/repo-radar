import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCiWatch } from "../../src/state/useCiWatch.js";
import type { CiRun, CiWatch } from "../../src/types/ci.js";

const watch = { id: "one", repoPath: "C:/root/repo", branch: "main" };

describe("CI polling", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("polls every 30 seconds in the open view, uses the configured background interval, and honors disabled polling", async () => {
    vi.useFakeTimers();
    const getCiRun = vi.fn().mockResolvedValue(null);
    window.repoRadar = { getCiRun } as unknown as Window["repoRadar"];
    const hook = renderHook(({ active, minutes }) => useCiWatch([watch], "C:/root", minutes, active), { initialProps: { active: true, minutes: 5 } });
    await act(async () => {});
    expect(getCiRun).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(getCiRun).toHaveBeenCalledTimes(2);
    hook.rerender({ active: false, minutes: 5 });
    await act(async () => { await vi.advanceTimersByTimeAsync(299999); });
    expect(getCiRun).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getCiRun).toHaveBeenCalledTimes(3);
    hook.rerender({ active: false, minutes: 0 });
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(getCiRun).toHaveBeenCalledTimes(3);
    await act(async () => { await hook.result.current.refresh(); });
    expect(getCiRun).toHaveBeenCalledTimes(4);
  });

  it("discards late responses after changing root or removing a watch", async () => {
    let finishOld: (run: CiRun | null) => void = () => {};
    const getCiRun = vi.fn().mockImplementationOnce(() => new Promise<CiRun | null>((resolve) => { finishOld = resolve; })).mockResolvedValue(null);
    window.repoRadar = { getCiRun } as unknown as Window["repoRadar"];
    const hook = renderHook(({ root, watches }: { root: string; watches: CiWatch[] }) => useCiWatch(watches, root, 0, true), { initialProps: { root: "C:/root", watches: [watch] } });
    const nextWatch = { ...watch, id: "two", repoPath: "C:/other/repo" };
    hook.rerender({ root: "C:/other", watches: [nextWatch] });
    await waitFor(() => expect(hook.result.current.results.two?.checkedAt).toBeDefined());
    await act(async () => { finishOld({ id: 1 } as CiRun); });
    expect(hook.result.current.results.one).toBeUndefined();
    expect(hook.result.current.results.two.run).toBeNull();
    hook.rerender({ root: "C:/other", watches: [] });
    expect(hook.result.current.results).toEqual({});
  });

  it("limits simultaneous requests and prevents overlapping refreshes", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const getCiRun = vi.fn().mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<null>((resolve) => { releases.push(() => { inFlight--; resolve(null); }); });
    });
    window.repoRadar = { getCiRun } as unknown as Window["repoRadar"];
    const watches = Array.from({ length: 6 }, (_, index) => ({ ...watch, id: String(index) }));
    const hook = renderHook(() => useCiWatch(watches, "C:/root", 0, true));
    expect(getCiRun).toHaveBeenCalledTimes(4);
    await act(async () => { await hook.result.current.refresh(); });
    expect(getCiRun).toHaveBeenCalledTimes(4);
    await act(async () => { releases.splice(0).forEach((release) => release()); });
    expect(getCiRun).toHaveBeenCalledTimes(6);
    await act(async () => { releases.splice(0).forEach((release) => release()); });
    expect(maxInFlight).toBe(4);
    expect(hook.result.current.refreshing).toBe(false);
  });
});
