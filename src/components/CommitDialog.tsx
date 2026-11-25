import { useEffect, useMemo, useState } from "react";
import type { CommitPreview } from "../types/api";
import type { RepoStatus } from "../types/repo";
import { RepositoryDialog } from "./RepositoryDialog.js";

type Props = {
  repo: RepoStatus;
  syncReason?: string;
  onSyncCommit?(files: string[], message: string): Promise<void>;
  onClose(): void;
  onCommitted(repo: RepoStatus): void;
};

type FileOption = { disabled: boolean; note?: string };

function fileCheckboxes(files: string[], selected: Set<string>, toggle: (file: string) => void, busy: boolean, options?: Map<string, FileOption>) {
  return files.map((file) => {
    const option = options?.get(file);
    return (
      <label key={file} className="check-row">
        <input type="checkbox" disabled={busy || option?.disabled} checked={selected.has(file)} onChange={() => toggle(file)} />
        {file}{option?.note && <span className="muted">{option.note}</span>}
      </label>
    );
  });
}

function availableFiles(preview: CommitPreview, options: Map<string, FileOption>) {
  return [...preview.unstaged, ...preview.untracked].filter(file => !options.get(file)?.disabled);
}

export function CommitDialog({ repo, syncReason, onSyncCommit, onClose, onCommitted }: Props) {
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState(syncReason ? "Save local changes before syncing" : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bumpVersion, setBumpVersion] = useState(!syncReason);
  const [doEverythingStep, setDoEverythingStep] = useState<string | null>(null);

  const stagedSelected = useMemo(() => [...selected].filter((file) => preview?.staged.includes(file)), [selected, preview]);
  const options = useMemo(() => {
    const result = new Map<string, FileOption>();
    if (syncReason) {
      for (const file of repo.files) {
        if (file.untracked && file.path.endsWith("/")) result.set(file.path, { disabled: true });
        if (file.submoduleChange === "contents") result.set(file.path, { disabled: true, note: "Commit file changes inside this submodule first." });
        if (file.submoduleChange === "commit") result.set(file.path, { disabled: false, note: "Record the new submodule commit." });
        if (file.submoduleChange === "commit-and-contents") result.set(file.path, { disabled: false, note: "Record the new submodule commit. Uncommitted files stay in the submodule." });
      }
    }
    return result;
  }, [syncReason, repo.files]);
  const stageableFiles = useMemo(() => preview ? availableFiles(preview, options) : [], [preview, options]);
  // In the sync prompt these checkboxes select working-tree changes, including the
  // remaining edits in a file whose staged version is already part of the commit.
  const selectedToStage = stageableFiles.filter(file => selected.has(file));

  async function loadPreview() {
    const details = await window.repoRadar.getCommitPreview(repo.absolutePath);
    const next = syncReason ? {
      ...details,
      staged: repo.files.filter(file => file.staged).map(file => file.path),
      unstaged: repo.files.filter(file => file.unstaged && !file.untracked).map(file => file.path),
      untracked: repo.files.filter(file => file.untracked).map(file => file.path)
    } : details;
    setPreview(next);
    const localFiles = availableFiles(next, options);
    setSelected(new Set(syncReason ? (!next.staged.length && localFiles.length === 1 ? localFiles : []) : next.staged));
    return next;
  }

  useEffect(() => {
    setBumpVersion(!syncReason);
    void loadPreview().catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [repo.absolutePath, repo.syncCommitGuard, syncReason]);

  function toggle(file: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  async function stageSelected() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setDoEverythingStep(null);
    try {
      await window.repoRadar.stageFiles(repo.absolutePath, [...selected].filter((file) => !preview.staged.includes(file)));
      await loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stageFiles(files: string[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setDoEverythingStep(null);
    try {
      await window.repoRadar.stageFiles(repo.absolutePath, files);
      await loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unstageFiles(files: string[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setDoEverythingStep(null);
    try {
      await window.repoRadar.unstageFiles(repo.absolutePath, files);
      await loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unstageSelected() {
    await unstageFiles(stagedSelected);
  }

  async function generateMessage() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setDoEverythingStep(null);
    try {
      setMessage(await window.repoRadar.generateCommitMessage(repo.absolutePath, preview.staged));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doCommit(pushAfterCommit = false) {
    setBusy(true);
    setError(null);
    setDoEverythingStep(null);
    try {
      if (onSyncCommit) {
        await onSyncCommit(selectedToStage, message.trim());
        return;
      }
      if (bumpVersion && preview?.packageVersion) {
        await window.repoRadar.bumpPackageVersion(repo.absolutePath);
      }
      const committed = await window.repoRadar.commit(repo.absolutePath, message.trim());
      onCommitted(committed);
      if (pushAfterCommit) {
        try {
          const pushed = await window.repoRadar.push(repo.absolutePath);
          onCommitted(pushed);
        } catch (err) {
          setError(`Commit succeeded, but push failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doEverything() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setBumpVersion(true);
    try {
      let nextPreview = preview;
      const filesToStage = [...new Set([...nextPreview.unstaged, ...nextPreview.untracked])];
      if (filesToStage.length > 0) {
        setDoEverythingStep(`Staging ${filesToStage.length} file${filesToStage.length === 1 ? "" : "s"}...`);
        await window.repoRadar.stageFiles(repo.absolutePath, filesToStage);
        nextPreview = await loadPreview();
      }

      if (nextPreview.packageVersion) {
        setDoEverythingStep(`Bumping ${nextPreview.packageVersion.path} to ${nextPreview.packageVersion.next}...`);
        await window.repoRadar.bumpPackageVersion(repo.absolutePath);
        nextPreview = await loadPreview();
      }

      setDoEverythingStep("Generating AI commit message...");
      const generatedMessage = await window.repoRadar.generateCommitMessage(repo.absolutePath, nextPreview.staged);
      setMessage(generatedMessage);

      setDoEverythingStep("Committing changes...");
      const committed = await window.repoRadar.commit(repo.absolutePath, generatedMessage.trim());
      onCommitted(committed);

      setDoEverythingStep("Pushing commit...");
      const pushed = await window.repoRadar.push(repo.absolutePath);
      onCommitted(pushed);
      setDoEverythingStep("Done.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const blockers = preview?.blockers ?? [];
  const willStageVersion = Boolean(bumpVersion && preview?.packageVersion);
  const canCommit = Boolean(message.trim()) && ((preview?.staged.length ?? 0) > 0 || willStageVersion || (syncReason && selectedToStage.length > 0)) && blockers.length === 0 && !busy;
  const canDoEverything = Boolean(preview?.aiAvailable) && ((preview?.staged.length ?? 0) > 0 || stageableFiles.length > 0 || Boolean(preview?.packageVersion)) && blockers.length === 0 && !busy;

  return (
    <RepositoryDialog titleId="repo-commit-title" busy={busy} onClose={onClose}>
        <header>
          <h2 id="repo-commit-title">{syncReason ? "Save local changes to sync" : `Commit ${repo.name}`}</h2>
          <button title="Close commit dialog" disabled={busy} onClick={onClose}>Close</button>
        </header>
        {syncReason && <section className="sync-commit-info">
          <p>Review the files to commit on <strong>{repo.name} · {repo.syncCommitGuard?.branch}</strong> before syncing.
            All staged changes are included. Select any remaining edits you want to add.</p>
          <details><summary>Show Git’s explanation</summary><pre>{syncReason}</pre></details>
        </section>}
        {!preview ? <div className="empty-panel">{error ?? "Loading commit state..."}</div> : (
          <>
            {blockers.length > 0 && <div className="issue-box">{blockers.map((blocker) => <p key={blocker.code}>{blocker.message}</p>)}</div>}
            {error && <div className="issue-box">{error}</div>}
            <div className="commit-grid">
              <section>
                <div className="file-group-header">
                  <h3>Staged</h3>
                  {!syncReason && <button title="Unstage all staged files" disabled={busy || preview.staged.length === 0} onClick={() => unstageFiles(preview.staged)}>Unstage all</button>}
                </div>
                {preview.staged.length ? (syncReason
                  ? <ul aria-label="Already staged">{preview.staged.map(file => <li key={file}>{file}</li>)}</ul>
                  : fileCheckboxes(preview.staged, selected, toggle, busy)) : <p>No staged files.</p>}
                <div className="file-group-header">
                  <h3>Unstaged</h3>
                  {!syncReason && <button title="Stage all unstaged files" disabled={busy || preview.unstaged.length === 0} onClick={() => stageFiles(preview.unstaged)}>Stage all</button>}
                </div>
                {preview.unstaged.length ? fileCheckboxes(preview.unstaged, selected, toggle, busy, options) : <p>No unstaged files.</p>}
                <div className="file-group-header">
                  <h3>Untracked</h3>
                  {!syncReason && <button title="Stage all untracked files" disabled={busy || preview.untracked.length === 0} onClick={() => stageFiles(preview.untracked)}>Stage all</button>}
                </div>
                {preview.untracked.length ? fileCheckboxes(preview.untracked, selected, toggle, busy, options) : <p>No untracked files.</p>}
                {syncReason && preview.untracked.some(file => file.endsWith("/")) &&
                  <p className="muted">Nested repositories are managed separately. Open the nested repository to sync its changes.</p>}
                {!syncReason && <div className="row-actions">
                  <button title="Stage all unstaged and untracked files" disabled={busy || stageableFiles.length === 0} onClick={() => stageFiles(stageableFiles)}>Stage all changes</button>
                  <button title="Stage selected files" disabled={busy || selected.size === 0} onClick={stageSelected}>Stage selected</button>
                  <button title="Unstage selected staged files" disabled={busy || stagedSelected.length === 0} onClick={unstageSelected}>Unstage selected</button>
                </div>}
              </section>
              <section>
                <div className="message-header">
                  <h3>Message</h3>
                  <button disabled={busy || !preview.aiAvailable || preview.staged.length === 0} title={preview.aiAvailable ? "Generate AI message. Diff content may be sent to provider." : "AI provider unavailable."} onClick={generateMessage}>
                    Generate AI Message
                  </button>
                </div>
                {!preview.aiAvailable && <p className="muted">AI generation is unavailable. Manual commit messages still work.</p>}
                {!syncReason && preview.packageVersion && (
                  <label className="version-bump-option">
                    <input type="checkbox" disabled={busy} checked={bumpVersion} onChange={(event) => setBumpVersion(event.target.checked)} />
                    <span>
                      Bump {preview.packageVersion.path} from {preview.packageVersion.current} to {preview.packageVersion.next}
                    </span>
                  </label>
                )}
                <textarea disabled={busy} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" />
                <div className="commit-actions">
                  <button title={syncReason ? "Save these changes and retry sync" : "Commit staged changes with this message"} className="primary" disabled={!canCommit} onClick={() => doCommit(false)}>{syncReason ? "Commit and continue sync" : "Commit"}</button>
                  {!syncReason && <button title="Commit staged changes and push the current branch" className="primary" disabled={!canCommit} onClick={() => doCommit(true)}>Commit and Push</button>}
                </div>
                {!syncReason && <div className="do-everything-actions">
                  <button className="primary do-everything-button" disabled={!canDoEverything} title={preview.aiAvailable ? "Stage all changes, bump version, generate an AI message, commit, and push." : "AI provider unavailable."} onClick={doEverything}>
                    Do Everything
                  </button>
                  {doEverythingStep && <p className="do-everything-status">{doEverythingStep}</p>}
                </div>}
              </section>
            </div>
          </>
        )}
    </RepositoryDialog>
  );
}
