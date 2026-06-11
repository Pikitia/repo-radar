import { useEffect, useState } from "react";
import type { RepoStatus } from "../types/repo";
import { visibleTabs } from "../state/repoLogic";
import { Toolbar } from "./Toolbar";
import { DiffViewer } from "./DiffViewer";
import { ProjectFilesViewer } from "./ProjectFilesViewer";
import { CommitDialog } from "./CommitDialog";

type Props = {
  repo: RepoStatus | null;
  onRepoUpdated(repo: RepoStatus): void;
  onMessage(message: string): void;
};

type Tab = "working" | "staged" | "untracked" | "ahead" | "project";

const tabLabels: Record<Tab, string> = {
  working: "Working Tree",
  staged: "Staged",
  untracked: "Untracked",
  ahead: "Ahead Commits",
  project: "Project Files"
};

export function RepoDetail({ repo, onRepoUpdated, onMessage }: Props) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);

  const tabs = repo ? visibleTabs(repo) : [];

  useEffect(() => {
    if (!repo) {
      setTab(null);
      return;
    }
    if (!tab || !tabs.includes(tab)) setTab(tabs[0] ?? null);
  }, [repo?.id, tabs.join("|")]);

  if (!repo) {
    return <main className="detail empty-detail">Select a repository or configure a root folder.</main>;
  }

  async function runAction(action: () => Promise<RepoStatus | void>, success: string) {
    setBusy(true);
    try {
      const updated = await action();
      if (updated) onRepoUpdated(updated);
      onMessage(success);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="detail">
      <header className="detail-header">
        <div>
          <h1>{repo.name}</h1>
          <p title={repo.absolutePath}>{repo.absolutePath}</p>
        </div>
      </header>
      <Toolbar
        repo={repo}
        busy={busy}
        onCommit={() => setCommitOpen(true)}
        onPull={() => runAction(() => window.repoRadar.pull(repo.absolutePath), "Pull complete.")}
        onPush={() => runAction(() => window.repoRadar.push(repo.absolutePath), "Push complete.")}
        onSync={() => runAction(() => window.repoRadar.sync(repo.absolutePath), "Sync complete.")}
        onRefresh={() => runAction(() => window.repoRadar.refreshRepository(repo.absolutePath, true), "Repository refreshed.")}
        onVSCode={() => runAction(() => window.repoRadar.openVSCode(repo.absolutePath), "Opened VS Code.")}
        onExplorer={() => runAction(() => window.repoRadar.openExplorer(repo.absolutePath), "Opened Explorer.")}
        onTerminal={() => runAction(() => window.repoRadar.openTerminal(repo.absolutePath), "Opened terminal.")}
        onCopy={() => runAction(() => window.repoRadar.copyPath(repo.absolutePath), "Path copied.")}
        onRemote={() => runAction(() => window.repoRadar.openRemote(repo.absolutePath), "Opened remote.")}
      />
      <section className="status-strip">
        <span>Branch <b>{repo.branch ?? "detached"}</b></span>
        <span>Upstream <b>{repo.upstream ?? "none"}</b></span>
        <span>Ahead <b>{repo.ahead}</b></span>
        <span>Behind <b>{repo.behind}</b></span>
        <span>Files <b>{repo.files.length}</b></span>
      </section>
      {(repo.errors.length > 0 || repo.warnings.length > 0) && (
        <section className="issues">
          {[...repo.errors, ...repo.warnings].map((issue) => (
            <p key={`${issue.code}-${issue.message}`} title={issue.detail}>{issue.message}</p>
          ))}
        </section>
      )}
      <nav className="tabs">
        {tabs.map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabLabels[item]}</button>
        ))}
      </nav>
      <section className="tab-body">
        {!tab && <div className="empty-panel">No changed files, ahead commits, or known project files.</div>}
        {tab === "working" && <DiffViewer repo={repo} mode="working" />}
        {tab === "staged" && <DiffViewer repo={repo} mode="staged" />}
        {tab === "untracked" && <DiffViewer repo={repo} mode="untracked" />}
        {tab === "project" && <ProjectFilesViewer repo={repo} />}
        {tab === "ahead" && (
          <div className="commit-list">
            {repo.aheadCommits.map((commit) => (
              <article key={commit.hash}>
                <strong>{commit.subject}</strong>
                <span>{commit.hash.slice(0, 8)} · {commit.author} · {new Date(commit.date).toLocaleString()}</span>
                <p>{commit.files.join(", ")}</p>
              </article>
            ))}
          </div>
        )}
      </section>
      {commitOpen && <CommitDialog repo={repo} onClose={() => setCommitOpen(false)} onCommitted={onRepoUpdated} />}
    </main>
  );
}
