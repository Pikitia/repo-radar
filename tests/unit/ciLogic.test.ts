import { describe, expect, it } from "vitest";
import { ciStatus, ciDuration, ciPathKey, ciWhenRun, compareCiRows, type CiSortColumn, type CiSortRow } from "../../src/state/ciLogic.js";
import type { CiRun } from "../../src/types/ci.js";

describe("CI display states", () => {
  it.each([
    ["queued", null, "Queued"], ["in_progress", null, "Running"], ["waiting", null, "Waiting for approval"],
    ["completed", "success", "Succeeded"], ["completed", "failure", "Failed"],
    ["completed", "cancelled", "Cancelled"], ["completed", "skipped", "Skipped"],
    ["completed", "timed_out", "Timed out"], ["completed", "action_required", "Action required"]
  ])("displays %s / %s as %s", (status, conclusion, label) => {
    expect(ciStatus(status, conclusion).label).toBe(label);
  });

  it("matches Windows path forms without confusing neighboring repositories", () => {
    expect(ciPathKey("C:\\root\\Repo/")).toBe(ciPathKey("c:/root/repo"));
    expect(ciPathKey("C:/root/repo-one")).not.toBe(ciPathKey("C:/root/repo-two"));
  });

  it("formats elapsed time and handles missing/invalid timestamps", () => {
    expect(ciDuration("2026-10-05T10:00:00Z", "2026-10-05T10:02:13Z", 0)).toBe("2m 13s");
    expect(ciDuration(null, null, 0)).toBe("—");
    expect(ciDuration("invalid", null, 0)).toBe("—");
    expect(ciDuration("2026-10-05T10:00:00Z", null, Date.parse("2026-10-05T10:00:30Z"))).toBe("30s");
  });

  it("formats a compact run date without seconds and handles missing dates", () => {
    const time = "2026-10-05T10:02:00Z";
    const expected = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(time));
    expect(ciWhenRun(time)).toBe(expected);
    expect(ciWhenRun(null)).toBe("—");
    expect(ciWhenRun("invalid")).toBe("—");
  });
});

describe("CI ordering", () => {
  const now = Date.parse("2026-10-05T10:03:00Z");
  const run: CiRun = { id: 1, attempt: 1, workflowName: "Zebra", title: "Run", number: 1, branch: "main", commit: "ccccccc", status: "completed", conclusion: "failure", createdAt: "2026-10-05T10:00:00Z", startedAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:02:00Z", htmlUrl: "https://github.com/owner/repo/actions/runs/1" };
  const rows: CiSortRow[] = [
    { watch: { id: "a", repoPath: "C:/root/alpha", branch: "zebra" }, repo: { name: "Alpha", relativePath: "alpha" }, run },
    { watch: { id: "b", repoPath: "C:/root/bravo", branch: "middle" }, repo: { name: "Bravo", relativePath: "bravo" }, run: { ...run, id: 2, workflowName: "Mike", status: "in_progress", conclusion: null, commit: "bbbbbbb", createdAt: "2026-10-05T10:02:00Z", startedAt: "2026-10-05T10:02:40Z" } },
    { watch: { id: "c", repoPath: "C:/root/charlie", branch: "alpha" }, repo: { name: "Charlie", relativePath: "charlie" }, run: { ...run, id: 3, workflowName: "Alpha", conclusion: "success", commit: "aaaaaaa", createdAt: "2026-10-05T09:55:00Z", startedAt: "2026-10-05T09:55:00Z", updatedAt: "2026-10-05T10:00:00Z" } }
  ];
  const cases: Array<[CiSortColumn, string[]]> = [
    ["repository", ["a", "b", "c"]], ["branch", ["c", "b", "a"]], ["workflow", ["c", "b", "a"]],
    ["status", ["a", "b", "c"]], ["commit", ["c", "b", "a"]], ["timing", ["b", "a", "c"]], ["whenRun", ["c", "a", "b"]]
  ];
  it.each(cases)("sorts %s in both directions using underlying values", (column, expected) => {
    expect([...rows].sort((a, b) => compareCiRows(a, b, { column, direction: "ascending" }, now)).map((row) => row.watch.id)).toEqual(expected);
    expect([...rows].sort((a, b) => compareCiRows(a, b, { column, direction: "descending" }, now)).map((row) => row.watch.id)).toEqual([...expected].reverse());
  });

  it.each(["timing", "whenRun", "commit"] as const)("keeps unavailable %s values last in both directions", (column) => {
    const missing = { ...rows[0], watch: { ...rows[0].watch, id: "missing" }, run: null };
    for (const direction of ["ascending", "descending"] as const) {
      const sorted = [missing, ...rows].sort((a, b) => compareCiRows(a, b, { column, direction }, now));
      expect(sorted.at(-1)?.watch.id).toBe("missing");
    }
  });
});
