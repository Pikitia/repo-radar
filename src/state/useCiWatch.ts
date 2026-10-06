import { useCallback, useEffect, useRef, useState } from "react";
import type { CiWatch, CiRun } from "../types/ci.js";

export type CiWatchResult = { run: CiRun | null; checkedAt?: string; error?: string; loading?: boolean };

export function useCiWatch(watches: CiWatch[], root: string | null, intervalMinutes: number, active: boolean) {
  const [results, setResults] = useState<Record<string, CiWatchResult>>({});
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const busy = useRef<number | null>(null);
  const signature = JSON.stringify(watches);

  const refresh = useCallback(async () => {
    const current = generation.current;
    if (busy.current === current || !root || watches.length === 0) return;
    busy.current = current;
    setRefreshing(true);
    setResults((previous) => Object.fromEntries(watches.map((watch) => [watch.id, { ...previous[watch.id], run: previous[watch.id]?.run ?? null, loading: true }])));
    let next = 0;
    async function worker() {
      while (next < watches.length && generation.current === current) {
        const watch = watches[next++];
        try {
          const run = await window.repoRadar.getCiRun(watch.repoPath, watch.branch, watch.workflowId);
          if (generation.current !== current) return;
          setResults((previous) => ({ ...previous, [watch.id]: { run, checkedAt: new Date().toISOString(), loading: false } }));
        } catch (error) {
          if (generation.current !== current) return;
          setResults((previous) => ({ ...previous, [watch.id]: { ...previous[watch.id], run: previous[watch.id]?.run ?? null, error: error instanceof Error ? error.message : String(error), loading: false } }));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, watches.length) }, () => worker()));
    if (generation.current === current) {
      busy.current = null;
      setRefreshing(false);
    }
  // The serialized list keeps equivalent discovery results from restarting requests.
  }, [signature, root]);

  useEffect(() => {
    generation.current++;
    busy.current = null;
    setRefreshing(false);
    setResults((previous) => Object.fromEntries(watches.map((watch) => [watch.id, previous[watch.id] ?? { run: null }])));
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!root || intervalMinutes <= 0 || watches.length === 0) return;
    const interval = active ? Math.min(30000, intervalMinutes * 60000) : intervalMinutes * 60000;
    const timer = window.setInterval(() => { void refresh(); }, interval);
    return () => window.clearInterval(timer);
  }, [root, intervalMinutes, active, refresh, signature]);

  return { results, refreshing, refresh };
}
