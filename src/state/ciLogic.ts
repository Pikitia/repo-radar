import type { CiRun, CiWatch } from "../types/ci.js";

export function ciStatus(status: string | null, conclusion: string | null): { label: string; tone: string } {
  const value = conclusion ?? status;
  switch (value) {
    case "success": return { label: "Succeeded", tone: "success" };
    case "failure": case "startup_failure": return { label: "Failed", tone: "failure" };
    case "timed_out": return { label: "Timed out", tone: "failure" };
    case "cancelled": return { label: "Cancelled", tone: "muted" };
    case "action_required": return { label: "Action required", tone: "waiting" };
    case "in_progress": return { label: "Running", tone: "running" };
    case "waiting": return { label: "Waiting for approval", tone: "waiting" };
    case "queued": case "requested": case "pending": return { label: "Queued", tone: "waiting" };
    case "skipped": return { label: "Skipped", tone: "muted" };
    case "neutral": return { label: "Neutral", tone: "muted" };
    case "stale": return { label: "Stale", tone: "muted" };
    case "completed": return { label: "Completed", tone: "muted" };
    default: return { label: value ?? "Unknown", tone: "muted" };
  }
}

export function ciPathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

export function ciDuration(start: string | null, end: string | null, now: number): string {
  const elapsed = ciElapsedMs(start, end, now);
  if (elapsed === null) return "—";
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ciElapsedMs(start: string | null, end: string | null, now: number): number | null {
  if (!start) return null;
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null;
}

export function ciWhenRun(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}

export type CiSortColumn = "repository" | "branch" | "workflow" | "status" | "commit" | "timing" | "whenRun";
export type CiSort = { column: CiSortColumn; direction: "ascending" | "descending" };
export type CiSortRow = {
  watch: CiWatch;
  repo: { name: string; relativePath: string };
  run: CiRun | null;
  error?: string;
  loading?: boolean;
  checkedAt?: string;
};

function sortValue(row: CiSortRow, column: CiSortColumn, now: number): string | number | null {
  switch (column) {
    case "repository": return row.repo.name;
    case "branch": return row.watch.branch;
    case "workflow": return row.run?.workflowName ?? row.watch.workflowName ?? "Latest run";
    case "status": return row.error ? "Unavailable" : row.run ? ciStatus(row.run.status, row.run.conclusion).label : row.loading || !row.checkedAt ? "Loading…" : "No runs";
    case "commit": return row.run?.commit || null;
    case "timing": return row.run ? ciElapsedMs(row.run.startedAt, row.run.status === "completed" ? row.run.updatedAt : null, now) : null;
    case "whenRun": {
      const timestamp = row.run ? Date.parse(row.run.createdAt) : Number.NaN;
      return Number.isFinite(timestamp) ? timestamp : null;
    }
  }
}

export function compareCiRows(left: CiSortRow, right: CiSortRow, sort: CiSort, now: number): number {
  const a = sortValue(left, sort.column, now);
  const b = sortValue(right, sort.column, now);
  // Missing timestamps and commits remain last in either direction.
  if (a === null && b !== null) return 1;
  if (b === null && a !== null) return -1;
  const difference = typeof a === "number" && typeof b === "number" ? a - b
    : a !== null && b !== null ? String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }) : 0;
  if (difference !== 0) return sort.direction === "ascending" ? difference : -difference;
  return left.repo.relativePath.localeCompare(right.repo.relativePath)
    || left.watch.branch.localeCompare(right.watch.branch)
    || (left.watch.workflowId ?? 0) - (right.watch.workflowId ?? 0)
    || left.watch.id.localeCompare(right.watch.id);
}
