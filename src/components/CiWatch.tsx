import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Clock, ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import type { CiWatch as Watch, CiWorkflow, CiRun, CiJob } from "../types/ci.js";
import type { RepoStatus } from "../types/repo.js";
import { ciDuration, ciPathKey, ciStatus, ciWhenRun, compareCiRows, type CiSort, type CiSortColumn } from "../state/ciLogic.js";
import { useCiWatch } from "../state/useCiWatch.js";

type Props = {
  repos: RepoStatus[];
  watches: Watch[];
  root: string | null;
  intervalMinutes: number;
  active: boolean;
  onWatchesChanged(watches: Watch[]): void;
  onOpenRepository(repo: RepoStatus): void;
};

function Status({ status, conclusion }: { status: string | null; conclusion: string | null }) {
  const { label, tone } = ciStatus(status, conclusion);
  return <span className={`ci-status ci-${tone}`}>
    {tone === "success" ? <Check size={13} /> : tone === "failure" ? <X size={13} /> : <Clock size={13} />}
    {label}
  </span>;
}

async function openExternal(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  await window.repoRadar.openExternal(event.currentTarget.href);
}

function RunDetails({ repoPath, run, checkedAt, refreshing }: { repoPath: string; run: CiRun; checkedAt?: string; refreshing?: boolean }) {
  const [jobs, setJobs] = useState<CiJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.repoRadar.getCiJobs(repoPath, run.id, run.attempt).then((next) => {
      if (!cancelled) setJobs(next);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPath, run.id, run.attempt, checkedAt, retry]);
  const now = Date.now();
  return <div className="ci-run-details" aria-label={`Run details for ${run.workflowName}`}>
    <div className="ci-run-heading">
      <div><strong>{run.title} #{run.number}</strong><p className="muted">Attempt {run.attempt} · {run.commit} · Updated {new Date(run.updatedAt).toLocaleString()}</p>{checkedAt && <p className="muted">Status last refreshed {new Date(checkedAt).toLocaleString()}</p>}</div>
      <a href={run.htmlUrl} onClick={(event) => { void openExternal(event); }}>Open run in GitHub <ExternalLink size={13} /></a>
    </div>
    {(loading || refreshing) && <p className="muted">Refreshing jobs…</p>}
    {error && <div className="issue-box" role="alert">Could not refresh jobs. {jobs && "Showing previously loaded jobs. "}{error} <button onClick={() => setRetry((current) => current + 1)}>Retry jobs</button></div>}
    {jobs?.length === 0 && <p className="muted">No jobs reported yet. The workflow may be queued or waiting.</p>}
    {jobs?.map((job) => <article className="ci-job" key={job.id}>
      <div className="ci-job-heading"><strong>{job.name}</strong><Status status={job.status} conclusion={job.conclusion} /><span className="muted">{ciDuration(job.startedAt, job.completedAt, now)}</span><a href={job.htmlUrl} onClick={(event) => { void openExternal(event); }}>Job log <ExternalLink size={12} /></a></div>
      <ol className="ci-steps">{job.steps.map((step) => <li key={step.number}><span>{step.number}. {step.name}</span><Status status={step.status} conclusion={step.conclusion} /></li>)}</ol>
    </article>)}
  </div>;
}

export function CiWatch({ repos, watches, root, intervalMinutes, active, onWatchesChanged, onOpenRepository }: Props) {
  const repoByPath = useMemo(() => new Map(repos.map((repo) => [ciPathKey(repo.absolutePath), repo])), [repos]);
  const visibleWatches = useMemo(() => watches.filter((watch) => repoByPath.has(ciPathKey(watch.repoPath))), [watches, repoByPath]);
  const { results, refreshing, refresh } = useCiWatch(visibleWatches, root, intervalMinutes, active);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<CiSort>({ column: "whenRun", direction: "descending" });
  const [adding, setAdding] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [branch, setBranch] = useState("main");
  const [workflowId, setWorkflowId] = useState("");
  const [workflows, setWorkflows] = useState<CiWorkflow[]>([]);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scope = useRef(root);
  scope.current = root;
  const chosenPath = repoByPath.has(ciPathKey(repoPath)) ? repoPath : repos[0]?.absolutePath ?? "";
  const now = Date.now();
  const rows = visibleWatches.map((watch) => ({
    watch, repo: repoByPath.get(ciPathKey(watch.repoPath))!, ...results[watch.id], run: results[watch.id]?.run ?? null
  })).sort((left, right) => compareCiRows(left, right, sort, now));

  function sortHeader(column: CiSortColumn, label: string) {
    const selected = sort.column === column;
    return <th aria-sort={selected ? sort.direction : "none"}>
      <button className="ci-sort-button" aria-label={`Sort by ${label}`} title={`Sort ${selected && sort.direction === "ascending" ? "descending" : "ascending"}`} onClick={() => setSort({ column, direction: selected && sort.direction === "ascending" ? "descending" : "ascending" })}>
        {label}{selected ? sort.direction === "ascending" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} />}
      </button>
    </th>;
  }

  useEffect(() => {
    if (!adding || !chosenPath) return;
    let cancelled = false;
    setWorkflows([]);
    setWorkflowId("");
    setWorkflowError(null);
    setWorkflowLoading(true);
    void window.repoRadar.getCiWorkflows(chosenPath).then((next) => { if (!cancelled) setWorkflows(next); })
      .catch((err) => { if (!cancelled) setWorkflowError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setWorkflowLoading(false); });
    return () => { cancelled = true; };
  }, [adding, chosenPath, root]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const startingRoot = root;
    setSaving(true);
    setError(null);
    try {
      const workflow = workflows.find((item) => item.id === Number(workflowId));
      const next = await window.repoRadar.addCiWatch({ repoPath: chosenPath, branch: branch.trim(), ...(workflow ? { workflowId: workflow.id, workflowName: workflow.name } : {}) });
      if (scope.current !== startingRoot) return;
      onWatchesChanged(next);
      setAdding(false);
    } catch (err) {
      if (scope.current === startingRoot) setError(err instanceof Error ? err.message : String(err));
    } finally { setSaving(false); }
  }

  async function remove(id: string) {
    const startingRoot = root;
    setSaving(true);
    setError(null);
    try {
      const next = await window.repoRadar.removeCiWatch(id);
      if (scope.current === startingRoot) onWatchesChanged(next);
    }
    catch (err) { if (scope.current === startingRoot) setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  }

  return <section className="ci-watch" aria-label="CI Watch">
    <header className="ci-watch-header">
      <div><h1>CI Watch</h1><p>Watched branches across all repositories</p></div>
      <div className="ci-watch-actions">
        <button onClick={() => { void refresh(); }} disabled={refreshing || visibleWatches.length === 0}><RefreshCw size={14} />{refreshing ? "Refreshing…" : "Refresh CI"}</button>
        <button onClick={() => { setAdding((current) => !current); setError(null); }} disabled={!repos.length || saving}><Plus size={14} />Watch branch</button>
      </div>
    </header>
    <p className="ci-watch-hint">{intervalMinutes > 0 ? "Checks every 30 seconds while this view is open." : "Automatic refresh is disabled in Settings."} Choose a deployment workflow to track production.</p>
    {error && <div className="issue-box" role="alert">{error}</div>}
    {adding && <form className="ci-watch-form" onSubmit={(event) => { void add(event); }}>
      <label>Repository<select value={chosenPath} onChange={(event) => setRepoPath(event.target.value)} disabled={saving}>{repos.map((repo) => <option key={repo.id} value={repo.absolutePath}>{repo.relativePath}</option>)}</select></label>
      <label>Branch<input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main or production" required maxLength={255} disabled={saving} /></label>
      <label>Workflow<select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} disabled={workflowLoading || saving}><option value="">Latest run on branch (any workflow)</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name} · {workflow.path}{workflow.state !== "active" ? " (disabled)" : ""}</option>)}</select></label>
      <div className="ci-watch-form-buttons"><button className="primary" type="submit" disabled={saving || !chosenPath || !branch.trim() || workflowLoading}>{saving ? "Saving…" : "Add watch"}</button><button type="button" onClick={() => setAdding(false)} disabled={saving}>Cancel</button></div>
      {workflowLoading && <p className="muted">Loading workflows…</p>}
      {workflowError && <p className="ci-form-error" role="alert">Could not list workflows. {workflowError}</p>}
    </form>}
    <div className="ci-watch-body">
      {visibleWatches.length === 0 ? <div className="ci-empty"><h2>No watched branches yet</h2><p>Use Watch branch to add main, production, or any other branch. Watches are saved for each repository.</p>{!repos.length && <p>Choose a root folder and scan repositories first.</p>}</div> : <table className="ci-table">
        <colgroup><col className="ci-col-action" /><col className="ci-col-repo" /><col className="ci-col-branch" /><col /><col className="ci-col-status" /><col className="ci-col-commit" /><col className="ci-col-timing" /><col className="ci-col-when" /><col className="ci-col-action" /></colgroup>
        <thead><tr><th aria-label="Expand run" />{sortHeader("repository", "Repository")}{sortHeader("branch", "Branch")}{sortHeader("workflow", "Workflow")}{sortHeader("status", "Status")}{sortHeader("commit", "Commit")}{sortHeader("timing", "Timing")}{sortHeader("whenRun", "When run")}<th aria-label="Remove watch" /></tr></thead>
        <tbody>{rows.map(({ watch, repo, run, ...result }) => {
          const isExpanded = expanded.has(watch.id);
          const detailsId = `ci-details-${watch.id}`;
          return <Fragment key={watch.id}>
            <tr className={`ci-summary-row${isExpanded ? " ci-expanded-row" : ""}`}>
              <td><button className="icon-button" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${repo.name} ${watch.branch} ${watch.workflowName ?? "latest run"}`} aria-expanded={isExpanded} aria-controls={detailsId} disabled={!run} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(watch.id)) next.delete(watch.id); else next.add(watch.id); return next; })}>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td>
              <td><button className="ci-repo-link" title={repo.relativePath} onClick={() => onOpenRepository(repo)}>{repo.name}</button></td>
              <td title={`${watch.branch}${watch.branch === repo.branch ? " (checked out)" : ""}`}>{watch.branch}</td>
              <td title={`${run?.workflowName ?? watch.workflowName ?? "Latest run on branch (any workflow)"}${run ? ` #${run.number}` : ""}`}>{run?.workflowName ?? watch.workflowName ?? "Latest run"}{run && <span className="muted"> #{run.number}</span>}</td>
              <td title={result.checkedAt ? `Status last refreshed ${new Date(result.checkedAt).toLocaleString()}` : undefined}>{result.error ? <span className="ci-status ci-failure">Unavailable</span> : run ? <Status status={run.status} conclusion={run.conclusion} /> : <span className="muted">{result.loading || !result.checkedAt ? "Loading…" : "No runs"}</span>}{result.loading && run && <span className="mini-spinner ci-refresh-spinner" aria-label="Refreshing status" />}</td>
              <td><code>{run?.commit?.slice(0, 7) ?? "—"}</code></td>
              <td>{run ? ciDuration(run.startedAt, run.status === "completed" ? run.updatedAt : null, now) : "—"}</td>
              <td title={run ? new Date(run.createdAt).toLocaleString() : undefined}>{ciWhenRun(run?.createdAt ?? null)}</td>
              <td><button className="icon-button" title="Remove watch" aria-label={`Remove watch for ${repo.name} ${watch.branch} ${watch.workflowName ?? "latest run"}`} disabled={saving} onClick={() => { void remove(watch.id); }}><X size={14} /></button></td>
            </tr>
            {result.error && <tr className="ci-row-issue"><td colSpan={9}><div className="ci-row-error" role="alert">{run ? "Previous run retained. " : ""}{result.error}{result.checkedAt && <span className="muted"> · Last successful refresh {new Date(result.checkedAt).toLocaleString()}</span>}</div></td></tr>}
            {isExpanded && run && <tr id={detailsId}><td colSpan={9}><RunDetails key={`${run.id}:${run.attempt}`} repoPath={watch.repoPath} run={run} checkedAt={result.checkedAt} refreshing={result.loading} /></td></tr>}
          </Fragment>;
        })}</tbody>
      </table>}
    </div>
  </section>;
}
