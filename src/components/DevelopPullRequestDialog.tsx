import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { DevelopPullRequestPreview, DevelopPullRequestResult } from "../types/api.js";
import type { RepoStatus } from "../types/repo.js";

type Props = {
  repo: RepoStatus;
  onClose(): void;
  onRepoUpdated(repo: RepoStatus): void;
  onMessage(message: string): void;
};

export function DevelopPullRequestDialog({ repo, onClose, onRepoUpdated, onMessage }: Props) {
  const [preview, setPreview] = useState<DevelopPullRequestPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DevelopPullRequestResult | null>(null);
  const executing = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    let cancelled = false;
    void window.repoRadar.getDevelopPullRequestPreview(repo.absolutePath).then((value) => {
      if (!cancelled) setPreview(value);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; previous?.focus(); };
  }, [repo.absolutePath]);

  async function confirm() {
    if (!preview || executing.current) return;
    executing.current = true;
    setBusy(true);
    setError(null);
    try {
      const completed = await window.repoRadar.promoteDevelop(repo.absolutePath, preview);
      setResult(completed);
      onMessage(completed.message);
      try {
        const status = await window.repoRadar.refreshRepository(repo.absolutePath, true);
        onRepoUpdated(status);
        const comparison = await window.repoRadar.getBranchComparison(repo.absolutePath);
        onRepoUpdated({ ...status, branchComparison: comparison, branchComparisonLoaded: true, branchComparisonLoading: false });
      } catch (err) {
        setError(`Pull request operation finished, but repository refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Any changed branch or ambiguous network failure needs a fresh confirmation.
      setPreview(null);
    } finally {
      executing.current = false;
      setBusy(false);
    }
  }

  function openResult(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (result) void window.repoRadar.openExternal(result.url).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="develop-pr-title" ref={dialog} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []);
          const next = event.shiftKey ? items.at(-1) : items[0];
          if (document.activeElement === dialog.current || document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) {
            event.preventDefault(); next?.focus();
          }
        }
      }}>
      <div className="modal develop-pr-modal">
        <header>
          <h2 id="develop-pr-title">Merge develop into main: {repo.name}</h2>
          <button title="Close pull request confirmation" disabled={busy} onClick={onClose}>Close</button>
        </header>
        <p className="muted">{repo.absolutePath}</p>
        {loading && <p role="status">Fetching origin and checking remote branches…</p>}
        {error && <p className="issue-box" role="alert">{error}</p>}
        {preview && !result && <>
          <p>Create or reuse a pull request in <strong>{preview.repository}</strong> from <strong>origin/develop</strong> into <strong>origin/main</strong>.</p>
          <p>{preview.ahead} commit{preview.ahead === 1 ? "" : "s"} waiting for main. Develop: <code>{preview.developSha.slice(0, 8)}</code>; main: <code>{preview.mainSha.slice(0, 8)}</code>.</p>
          <p>Enable GitHub auto-merge after required checks and reviews pass. If checks have already succeeded and GitHub allows merging, merge now.</p>
          <p className="muted">GitHub must allow auto-merge and main must require the checks you want to wait for. While auto-merge waits, future pushes to origin/develop are included. Local changes and local develop commits are not published.</p>
          <div className="row-actions">
            <button title="Cancel without creating or merging a pull request" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="primary" title="Create or reuse the remote develop-to-main pull request and merge after GitHub checks" disabled={busy} onClick={() => { void confirm(); }}>{busy ? "Submitting…" : "Confirm PR and merge"}</button>
          </div>
        </>}
        {result && <div role={result.outcome === "blocked" ? "alert" : "status"}>
          <p>{result.message}</p>
          <a href={result.url} onClick={openResult}>Open pull request #{result.number} in GitHub</a>
        </div>}
      </div>
    </div>
  );
}
