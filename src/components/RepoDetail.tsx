import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Check, Plus, X } from "lucide-react";
import type { NpmScriptCommand } from "../types/api";
import type { RepoStatus } from "../types/repo";
import { canReviewSync, visibleTabs } from "../state/repoLogic";
import { Toolbar } from "./Toolbar";
import { DiffViewer } from "./DiffViewer";
import { ProjectFilesViewer } from "./ProjectFilesViewer";
import { CommitDialog } from "./CommitDialog";
import { BranchComparisonTab } from "./BranchComparisonTab";
import { DevelopPullRequestDialog } from "./DevelopPullRequestDialog.js";
import { SyncConflictDialog } from "./SyncConflictDialog.js";
import { RepositoryDialog } from "./RepositoryDialog.js";

type Props = {
  repo: RepoStatus | null;
  onRepoUpdated(repo: RepoStatus): void;
  onUpdateAndCompare(repo: RepoStatus, expected?: RepoStatus): Promise<string | undefined>;
  onMessage(message: string): void;
  onWatchMain(): void;
  mainWatched: boolean;
  watchMainBusy: boolean;
};

type StaticTab = "working" | "staged" | "untracked" | "ahead" | "branches" | "actions" | "project";
type Tab = StaticTab | `npm-command:${string}`;

type NpmCommandTab = {
  id: string;
  repoId: string;
  repoPath: string;
  command: "update" | NpmScriptCommand;
  label: string;
  displayCommand: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  error?: string;
};

const tabLabels: Record<StaticTab, string> = {
  working: "Working Tree",
  staged: "Staged",
  untracked: "Untracked",
  ahead: "Ahead Commits",
  branches: "Develop/Main",
  actions: "Actions",
  project: "Project Files"
};

export function RepoDetail({ repo, onRepoUpdated, onUpdateAndCompare, onMessage, onWatchMain, mainWatched, watchMainBusy }: Props) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [promoteRepo, setPromoteRepo] = useState<RepoStatus | null>(null);
  const [syncReview, setSyncReview] = useState<RepoStatus | null>(null);
  const syncButton = useRef<HTMLButtonElement>(null);
  const repoHeading = useRef<HTMLHeadingElement>(null);
  const restoreSyncFocus = useRef<string | null>(null);
  const [npmCommandTabs, setNpmCommandTabs] = useState<NpmCommandTab[]>([]);
  const [verifyScript, setVerifyScript] = useState<NpmScriptCommand | null>(null);

  const tabs: StaticTab[] = repo ? visibleTabs(repo) : [];
  const repoNpmCommandTabs = repo ? npmCommandTabs.filter((item) => item.repoId === repo.id) : [];
  const npmCommandRunning = repoNpmCommandTabs.some((item) => item.running);

  useLayoutEffect(() => {
    if (syncReview && syncReview.id === repo?.id) {
      restoreSyncFocus.current = repo.id;
    } else if (restoreSyncFocus.current && !busy) {
      // Sync can disable and blur its launcher before the first dialog even opens.
      // Wait for the action to finish and respect focus moved elsewhere by the user.
      if (restoreSyncFocus.current === repo?.id && document.activeElement === document.body) {
        (syncButton.current?.disabled ? repoHeading.current : syncButton.current)?.focus();
      }
      restoreSyncFocus.current = null;
    }
  }, [syncReview, repo?.id, busy]);

  useEffect(() => {
    if (!repo) {
      setTab(null);
      return;
    }
    const commandTabs = repoNpmCommandTabs.map((item) => npmCommandTabId(item.id));
    if (!tab || (!tabs.includes(tab as StaticTab) && !commandTabs.some((item) => item === tab))) {
      setTab(tabs[0] ?? commandTabs[0] ?? null);
    }
  }, [repo?.id, tabs.join("|"), repoNpmCommandTabs.map((item) => item.id).join("|")]);

  useEffect(() => {
    if (!repo) {
      setVerifyScript(null);
      return;
    }
    let cancelled = false;
    setVerifyScript(null);
    void window.repoRadar.getNpmVerifyScript(repo.absolutePath)
      .then((script) => {
        if (!cancelled) setVerifyScript(script);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVerifyScript(null);
          onMessage(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo?.id, repo?.absolutePath, onMessage]);

  useEffect(() => window.repoRadar.onNpmCommandEvent((event) => {
    if (event.type === "output") {
      setNpmCommandTabs((current) => current.map((item) => (
        item.id === event.runId ? { ...item, output: item.output + event.text } : item
      )));
      return;
    }

    setNpmCommandTabs((current) => current.map((item) => {
      if (item.id !== event.runId) return item;
      const status = event.error
        ? `\nFailed to run ${item.displayCommand}: ${event.error}\n`
        : `\n${item.displayCommand} exited with code ${event.exitCode ?? "unknown"}.\n`;
      return { ...item, output: item.output + status, running: false, exitCode: event.exitCode, error: event.error };
    }));
    const label = event.displayCommand;
    onMessage(event.error ? `${label} failed: ${event.error}` : `${label} finished with exit code ${event.exitCode ?? "unknown"}.`);
  }), [onMessage]);

  if (!repo) {
    return <main className="detail empty-detail">Select a repository or configure a root folder.</main>;
  }

  async function runAction(action: () => Promise<RepoStatus>, success: string) {
    setBusy(true);
    try {
      const updated = await action();
      await onUpdateAndCompare(updated);
      onMessage(success);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runShortcut(action: () => Promise<void>, success: string) {
    try {
      await action();
      onMessage(success);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function showSyncResult(updated: RepoStatus, done = "Sync complete.") {
    if (updated.syncPushReview || updated.syncCommitGuard || canReviewSync(updated)) {
      onRepoUpdated(updated);
      setSyncReview(updated);
      onMessage(`Review ${updated.name} to finish syncing.`);
    } else {
      setSyncReview(null);
      onMessage(updated.errors[0]?.message ?? done);
      await onUpdateAndCompare(updated);
    }
  }

  async function runSyncAction(target: RepoStatus, action: () => Promise<RepoStatus>, done?: string) {
    setBusy(true);
    try {
      await showSyncResult(await action(), done);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const updated = await window.repoRadar.refreshRepository(target.absolutePath, false);
        onRepoUpdated(updated);
        setSyncReview(canReviewSync(updated) ? updated : null);
        onMessage(message);
      } catch (refreshError) {
        onMessage(`${message} Could not refresh ${target.name}. ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  function startSync(target: RepoStatus) {
    const branch = target.branch;
    if (canReviewSync(target)) setSyncReview(target);
    else if (branch) void runSyncAction(target, () => window.repoRadar.sync(target.absolutePath, branch));
  }

  function openExternal(event: MouseEvent<HTMLAnchorElement>, url: string) {
    event.preventDefault();
    void window.repoRadar.openExternal(url).catch((error: unknown) => {
      onMessage(error instanceof Error ? error.message : String(error));
    });
  }

  function npmCommandTabId(runId: string): `npm-command:${string}` {
    return `npm-command:${runId}`;
  }

  function activeNpmCommandTab(): NpmCommandTab | null {
    if (!tab?.startsWith("npm-command:")) return null;
    const id = tab.slice("npm-command:".length);
    return npmCommandTabs.find((item) => item.id === id) ?? null;
  }

  function closeNpmCommandTab(runId: string) {
    setNpmCommandTabs((current) => current.filter((item) => item.id !== runId));
    if (tab === npmCommandTabId(runId)) {
      setTab(tabs[0] ?? null);
    }
  }

  async function runNpmCommand(command: "update" | NpmScriptCommand) {
    if (!repo) return;
    const existing = repoNpmCommandTabs.find((item) => item.running);
    if (existing) {
      setTab(npmCommandTabId(existing.id));
      return;
    }

    const displayCommand = command === "update" ? "npm update" : `npm run ${command}`;
    const label = command === "update" ? "npm update" : `npm run ${command}`;
    const reusableTab = repoNpmCommandTabs.find((item) => !item.running);
    const runId = reusableTab?.id ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const nextTab: NpmCommandTab = {
      id: runId,
      repoId: repo.id,
      repoPath: repo.absolutePath,
      command,
      label,
      displayCommand,
      output: `> ${displayCommand}\n\n`,
      running: true,
      exitCode: null
    };
    setNpmCommandTabs((current) => (
      reusableTab
        ? current.map((item) => (item.id === reusableTab.id ? nextTab : item))
        : [...current, nextTab]
    ));
    setTab(npmCommandTabId(runId));

    try {
      await window.repoRadar.startNpmCommand(repo.absolutePath, runId, command);
      onMessage(`${label} started.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setNpmCommandTabs((current) => current.map((item) => (
        item.id === runId
          ? { ...item, output: `${item.output}Failed to start ${displayCommand}: ${message}\n`, running: false, error: message }
          : item
      )));
      onMessage(message);
    }
  }

  const selectedNpmCommandTab = activeNpmCommandTab();

  return (
    <main className="detail">
      <header className="detail-header repo-detail-header">
        <div>
          <h1 tabIndex={-1} ref={repoHeading}>{repo.name}</h1>
          <p title={repo.absolutePath}>{repo.absolutePath}</p>
        </div>
        <button onClick={onWatchMain} disabled={mainWatched || watchMainBusy || repo.statusLoading} title={mainWatched ? "The main branch is already in CI Watch." : "Add main to CI Watch using the latest run on that branch."}>
          {mainWatched ? <Check size={14} /> : <Plus size={14} />}{mainWatched ? "Watching main" : watchMainBusy ? "Adding watch…" : "Watch main"}
        </button>
      </header>
      <Toolbar
        syncButtonRef={syncButton}
        repo={repo}
        busy={busy}
        onCommit={() => setCommitOpen(true)}
        onPull={() => runAction(() => window.repoRadar.pull(repo.absolutePath), "Pull complete.")}
        onPush={() => runAction(() => window.repoRadar.push(repo.absolutePath), "Push complete.")}
        onSync={() => void startSync(repo)}
        onRefresh={() => runAction(() => window.repoRadar.refreshRepository(repo.absolutePath, true), "Repository refreshed.")}
        onNpmUpdate={() => runNpmCommand("update")}
        onNpmVerify={verifyScript ? () => runNpmCommand(verifyScript) : undefined}
        npmCommandRunning={npmCommandRunning}
        verifyScript={verifyScript}
        onVSCode={() => runShortcut(() => window.repoRadar.openVSCode(repo.absolutePath), "Opened VS Code.")}
        onExplorer={() => runShortcut(() => window.repoRadar.openExplorer(repo.absolutePath), "Opened Explorer.")}
        onTerminal={() => runShortcut(() => window.repoRadar.openTerminal(repo.absolutePath), "Opened terminal.")}
        onCopy={() => runShortcut(() => window.repoRadar.copyPath(repo.absolutePath), "Path copied.")}
        onRemote={() => runShortcut(() => window.repoRadar.openRemote(repo.absolutePath), "Opened remote.")}
        onPromoteDevelop={() => setPromoteRepo(repo)}
      />
      <section className="status-strip">
        <span>Branch <b>{repo.branch ?? "detached"}</b></span>
        <span>Upstream <b>{repo.upstream ?? "none"}</b></span>
        <span>Ahead <b>{repo.ahead}</b></span>
        <span>Behind <b>{repo.behind}</b></span>
        <span>Files <b>{repo.files.length}</b></span>
        {repo.githubActions && !repo.githubActions.error && <span>Actions <b>{repo.githubActions.conclusion ?? repo.githubActions.status ?? "unknown"}</b></span>}
      </section>
      {(repo.errors.length > 0 || repo.warnings.length > 0) && (
        <section className="issues">
          {[...repo.errors, ...repo.warnings].map((issue) => (
            <p key={`${issue.code}-${issue.message}`} title={issue.detail}>
              <strong>{issue.message}</strong>
              {issue.detail && <span>{issue.detail}</span>}
            </p>
          ))}
        </section>
      )}
      <nav className="tabs">
        {tabs.map((item) => (
          <button key={item} title={`Show ${tabLabels[item]}`} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabLabels[item]}</button>
        ))}
        {repoNpmCommandTabs.map((item) => (
          <button key={item.id} title={`Show ${item.label} output`} className={tab === npmCommandTabId(item.id) ? "active tab-with-close" : "tab-with-close"} onClick={() => setTab(npmCommandTabId(item.id))}>
            <span>{item.running ? `${item.label}...` : item.label}</span>
            {!item.running && (
              <span
                className="tab-close"
                title="Close npm command output"
                onClick={(event) => {
                  event.stopPropagation();
                  closeNpmCommandTab(item.id);
                }}
              >
                <X size={13} />
              </span>
            )}
          </button>
        ))}
      </nav>
      <section className="tab-body">
        {!tab && <div className="empty-panel">No changed files, ahead commits, or known project files.</div>}
        {repo.statusLoading && <div className="empty-panel"><span className="mini-spinner" /> Loading repository status...</div>}
        {tab === "working" && <DiffViewer repo={repo} mode="working" />}
        {tab === "staged" && <DiffViewer repo={repo} mode="staged" />}
        {tab === "untracked" && <DiffViewer repo={repo} mode="untracked" />}
        {tab === "branches" && <BranchComparisonTab repo={repo} onMessage={onMessage} onCompare={onUpdateAndCompare} />}
        {tab === "project" && <ProjectFilesViewer repo={repo} />}
        {tab === "actions" && repo.githubActions && (
          <div className="actions-panel">
            <article className="actions-run">
              <h3>{repo.githubActions.workflowName}</h3>
              <p>{repo.githubActions.runName} #{repo.githubActions.runNumber}</p>
              <p>
                {repo.githubActions.repository}
                {repo.githubActions.branch ? ` - ${repo.githubActions.branch}` : ""}
                {repo.githubActions.updatedAt ? ` - ${new Date(repo.githubActions.updatedAt).toLocaleString()}` : ""}
              </p>
              <a href={repo.githubActions.htmlUrl} onClick={(event) => openExternal(event, event.currentTarget.href)}>
                Open run in GitHub
              </a>
            </article>
            {repo.githubActions.failedJobs.length === 0 ? (
              <div className="empty-panel">
                {repo.githubActions.status === "completed"
                  ? "The latest workflow failed, but GitHub did not return failed job details."
                  : "The latest workflow is still running."}
              </div>
            ) : repo.githubActions.failedJobs.map((job) => (
              <article key={job.htmlUrl} className="actions-job">
                <h3>{job.name}</h3>
                <p>Conclusion: {job.conclusion ?? "unknown"}</p>
                <a href={job.htmlUrl} onClick={(event) => openExternal(event, event.currentTarget.href)}>
                  Open job log in GitHub
                </a>
                {job.steps.length > 0 && (
                  <ul>
                    {job.steps.map((step) => (
                      <li key={`${step.number}-${step.name}`}>{step.number}. {step.name} ({step.conclusion ?? "unknown"})</li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
        {selectedNpmCommandTab && (
          <div className="command-output">
            <div className="command-output-toolbar">
              <strong>{selectedNpmCommandTab.running ? `Running ${selectedNpmCommandTab.label}` : `${selectedNpmCommandTab.label} complete`}</strong>
              <button title="Close npm command output" disabled={selectedNpmCommandTab.running} onClick={() => closeNpmCommandTab(selectedNpmCommandTab.id)}><X size={14} /> Close</button>
            </div>
            <pre>{selectedNpmCommandTab.output || "Waiting for output..."}</pre>
          </div>
        )}
        {tab === "ahead" && (
          <div className="commit-list">
            {repo.aheadCommits.map((commit) => (
              <article key={commit.hash}>
                <strong>{commit.subject}</strong>
                <span>{commit.hash.slice(0, 8)} - {commit.author} - {new Date(commit.date).toLocaleString()}</span>
                <p>{commit.files.join(", ")}</p>
              </article>
            ))}
          </div>
        )}
      </section>
      {commitOpen && <CommitDialog repo={repo} onClose={() => setCommitOpen(false)} onCommitted={onRepoUpdated} />}
      {syncReview?.id === repo.id && syncReview.syncCommitGuard && <CommitDialog key={syncReview.syncCommitGuard.token}
        repo={syncReview} syncReason={syncReview.syncCommitRequired} onClose={() => setSyncReview(null)}
        onCommitted={onRepoUpdated} onSyncCommit={(files, message) => runSyncAction(syncReview,
          () => window.repoRadar.commitAndSync(syncReview.absolutePath, syncReview.syncCommitGuard!, files, message))} />}
      {syncReview?.id === repo.id && syncReview.syncPushReview && (
        <RepositoryDialog titleId="sync-push-title" className="develop-pr-modal" busy={busy} onClose={() => setSyncReview(null)}>
            <header><h2 id="sync-push-title">Confirm push destination</h2></header>
            <p><strong>{syncReview.name}</strong> pulls from <strong>{syncReview.syncPushReview.upstream}</strong>.
              Git is configured to push {syncReview.branch} to <strong>{syncReview.syncPushReview.destination}</strong>.</p>
            <div className="row-actions">
              <button disabled={busy} onClick={() => setSyncReview(null)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={() => {
                const { token, destination } = syncReview.syncPushReview!;
                void runSyncAction(syncReview, () => window.repoRadar.confirmSyncPush(syncReview.absolutePath, token), `Pushed to ${destination}.`);
              }}>{busy ? "Pushing…" : `Push to ${syncReview.syncPushReview.destination}`}</button>
            </div>
        </RepositoryDialog>
      )}
      {promoteRepo && <DevelopPullRequestDialog repo={promoteRepo} onClose={() => setPromoteRepo(null)} onUpdateAndCompare={onUpdateAndCompare} onMessage={onMessage} />}
      {syncReview?.id === repo.id && canReviewSync(syncReview) && <SyncConflictDialog key={repo.id} repo={syncReview}
        onClose={() => setSyncReview(null)} onRepoUpdated={onRepoUpdated} onMessage={onMessage}
        onComplete={showSyncResult} />}
    </main>
  );
}
