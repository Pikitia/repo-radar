import { useEffect, useState } from "react";
import type { BranchComparisonCommit, DiffResult, RepoStatus } from "../types/repo";
import { SideBySideDiff } from "./SideBySideDiff";

type Props = {
  repo: RepoStatus;
  onMessage(message: string): void;
  onRepoUpdated(repo: RepoStatus): void;
};

type DiffState = {
  loading: boolean;
  diff: DiffResult | null;
};

export function BranchComparisonTab({ repo, onMessage, onRepoUpdated }: Props) {
  const comparison = repo.branchComparison;
  const commits = comparison?.commitsInDevelopNotMain ?? [];
  const [selected, setSelected] = useState<BranchComparisonCommit | null>(commits[0] ?? null);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});

  useEffect(() => {
    setSelected(commits[0] ?? null);
  }, [repo.id, commits.map((commit) => commit.hash).join("|")]);

  useEffect(() => {
    let cancelled = false;
    if (repo.branchComparisonLoaded || repo.branchComparisonLoading || repo.statusLoading) return;

    onRepoUpdated({ ...repo, branchComparisonLoading: true });
    void window.repoRadar.getBranchComparison(repo.absolutePath).then((result) => {
      if (!cancelled) {
        onRepoUpdated({
          ...repo,
          branchComparison: result,
          branchComparisonLoaded: true,
          branchComparisonLoading: false
        });
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        onRepoUpdated({ ...repo, branchComparison: null, branchComparisonLoaded: true, branchComparisonLoading: false });
        onMessage(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [repo.id, repo.absolutePath, repo.branchComparisonLoaded, repo.statusLoading]);

  useEffect(() => {
    let cancelled = false;
    if (!selected) return;
    const current = diffs[selected.hash];
    if (current?.loading || current?.diff) return;

    setDiffs((items) => ({ ...items, [selected.hash]: { loading: true, diff: null } }));
    void window.repoRadar.getCommitDiff(repo.absolutePath, selected.hash).then((result) => {
      if (!cancelled) {
        setDiffs((items) => ({ ...items, [selected.hash]: { loading: false, diff: result } }));
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setDiffs((items) => ({ ...items, [selected.hash]: { loading: false, diff: null } }));
        onMessage(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [repo.absolutePath, selected?.hash]);

  const selectedDiffState = selected ? diffs[selected.hash] : null;
  const diff = selectedDiffState?.diff ?? null;

  if (repo.statusLoading || repo.branchComparisonLoading || !repo.branchComparisonLoaded) {
    return <div className="empty-panel"><span className="mini-spinner" /> Loading develop/main comparison...</div>;
  }

  if (!comparison) return <div className="empty-panel">origin/develop and origin/main were not found for this repository.</div>;

  return (
    <div className="branch-compare">
      <section className="version-strip">
        <article>
          <span>{comparison.developRef}</span>
          <strong>{comparison.developVersion ?? "No package version"}</strong>
        </article>
        <article>
          <span>{comparison.mainRef}</span>
          <strong>{comparison.mainVersion ?? "No package version"}</strong>
        </article>
        <article>
          <span>Develop ahead</span>
          <strong>{comparison.developAheadMain}</strong>
        </article>
      </section>
      {commits.length === 0 ? (
        <div className="empty-panel">origin/develop has no commits waiting for origin/main.</div>
      ) : (
        <section className="commit-compare-layout">
          <div className="compare-commit-list">
            {commits.map((commit) => (
              <button key={commit.hash} className={selected?.hash === commit.hash ? "selected" : ""} onClick={() => setSelected(commit)}>
                <strong>{commit.subject}</strong>
                <span>{commit.hash.slice(0, 8)} - {commit.author} - {new Date(commit.date).toLocaleString()}</span>
                {commit.body.trim() && <p>{commit.body.trim()}</p>}
              </button>
            ))}
          </div>
          <section className="diff-viewer">
            <header className="diff-header">
              <div>
                <strong>{selected?.subject ?? "No commit selected"}</strong>
                {selected && <span>{selected.hash} - {selected.files.join(", ") || "No changed files returned"}</span>}
              </div>
            </header>
            {!selected && <div className="diff-state">Select a commit to view its diff.</div>}
            {selected && selectedDiffState?.loading && <div className="diff-state"><span className="mini-spinner" /> Loading commit diff...</div>}
            {selected && !selectedDiffState?.loading && !diff && <div className="diff-state">No diff loaded.</div>}
            {diff?.error && <div className="diff-state issue-box">{diff.error}</div>}
            {diff?.isBinary && <div className="diff-state">Binary diff.</div>}
            {diff && !diff.isBinary && <SideBySideDiff text={diff.text} mode="commit" label={`Diff for commit ${selected?.hash ?? ""}`} />}
          </section>
        </section>
      )}
    </div>
  );
}
