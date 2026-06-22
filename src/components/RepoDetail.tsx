import { useEffect, useState, type MouseEvent } from "react";
import { X } from "lucide-react";
import type { NpmScriptCommand } from "../types/api";
import type { RepoStatus } from "../types/repo";
import { visibleTabs } from "../state/repoLogic";
import { Toolbar } from "./Toolbar";
import { DiffViewer } from "./DiffViewer";
import { ProjectFilesViewer } from "./ProjectFilesViewer";
import { CommitDialog } from "./CommitDialog";
import { BranchComparisonTab } from "./BranchComparisonTab";

type Props = {
  repo: RepoStatus | null;
  onRepoUpdated(repo: RepoStatus): void;
  onMessage(message: string): void;
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

export function RepoDetail({ repo, onRepoUpdated, onMessage }: Props) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [npmCommandTabs, setNpmCommandTabs] = useState<NpmCommandTab[]>([]);
  const [verifyScript, setVerifyScript] = useState<NpmScriptCommand | null>(null);

  const tabs: StaticTab[] = repo ? visibleTabs(repo) : [];
  const repoNpmCommandTabs = repo ? npmCommandTabs.filter((item) => item.repoId === repo.id) : [];
  const npmCommandRunning = repoNpmCommandTabs.some((item) => item.running);

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
    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    setNpmCommandTabs((current) => [...current, nextTab]);
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
        onNpmUpdate={() => runNpmCommand("update")}
        onNpmVerify={verifyScript ? () => runNpmCommand(verifyScript) : undefined}
        npmCommandRunning={npmCommandRunning}
        verifyScript={verifyScript}
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
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabLabels[item]}</button>
        ))}
        {repoNpmCommandTabs.map((item) => (
          <button key={item.id} className={tab === npmCommandTabId(item.id) ? "active tab-with-close" : "tab-with-close"} onClick={() => setTab(npmCommandTabId(item.id))}>
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
        {tab === "branches" && <BranchComparisonTab repo={repo} onMessage={onMessage} onRepoUpdated={onRepoUpdated} />}
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
    </main>
  );
}
