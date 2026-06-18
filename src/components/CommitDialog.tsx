import { useEffect, useMemo, useState } from "react";
import type { CommitPreview } from "../types/api";
import type { RepoStatus } from "../types/repo";

type Props = {
  repo: RepoStatus;
  onClose(): void;
  onCommitted(repo: RepoStatus): void;
};

function fileCheckboxes(files: string[], selected: Set<string>, toggle: (file: string) => void) {
  return files.map((file) => (
    <label key={file} className="check-row">
      <input type="checkbox" checked={selected.has(file)} onChange={() => toggle(file)} />
      {file}
    </label>
  ));
}

export function CommitDialog({ repo, onClose, onCommitted }: Props) {
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bumpVersion, setBumpVersion] = useState(true);
  const [doEverythingStep, setDoEverythingStep] = useState<string | null>(null);

  const stagedSelected = useMemo(() => [...selected].filter((file) => preview?.staged.includes(file)), [selected, preview]);
  const stageableFiles = useMemo(() => [...(preview?.unstaged ?? []), ...(preview?.untracked ?? [])], [preview]);

  async function loadPreview() {
    const next = await window.repoRadar.getCommitPreview(repo.absolutePath);
    setPreview(next);
    setSelected(new Set(next.staged));
    return next;
  }

  useEffect(() => {
    setBumpVersion(true);
    void loadPreview();
  }, [repo.absolutePath]);

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
  const canCommit = Boolean(message.trim()) && ((preview?.staged.length ?? 0) > 0 || willStageVersion) && blockers.length === 0 && !busy;
  const canDoEverything = Boolean(preview?.aiAvailable) && ((preview?.staged.length ?? 0) > 0 || stageableFiles.length > 0 || Boolean(preview?.packageVersion)) && blockers.length === 0 && !busy;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header>
          <h2>Commit {repo.name}</h2>
          <button onClick={onClose}>Close</button>
        </header>
        {!preview ? <div className="empty-panel">Loading commit state...</div> : (
          <>
            {blockers.length > 0 && <div className="issue-box">{blockers.map((blocker) => <p key={blocker.code}>{blocker.message}</p>)}</div>}
            {error && <div className="issue-box">{error}</div>}
            <div className="commit-grid">
              <section>
                <div className="file-group-header">
                  <h3>Staged</h3>
                  <button disabled={busy || preview.staged.length === 0} onClick={() => unstageFiles(preview.staged)}>Unstage all</button>
                </div>
                {preview.staged.length ? fileCheckboxes(preview.staged, selected, toggle) : <p>No staged files.</p>}
                <div className="file-group-header">
                  <h3>Unstaged</h3>
                  <button disabled={busy || preview.unstaged.length === 0} onClick={() => stageFiles(preview.unstaged)}>Stage all</button>
                </div>
                {preview.unstaged.length ? fileCheckboxes(preview.unstaged, selected, toggle) : <p>No unstaged files.</p>}
                <div className="file-group-header">
                  <h3>Untracked</h3>
                  <button disabled={busy || preview.untracked.length === 0} onClick={() => stageFiles(preview.untracked)}>Stage all</button>
                </div>
                {preview.untracked.length ? fileCheckboxes(preview.untracked, selected, toggle) : <p>No untracked files.</p>}
                <div className="row-actions">
                  <button disabled={busy || stageableFiles.length === 0} onClick={() => stageFiles(stageableFiles)}>Stage all changes</button>
                  <button disabled={busy || selected.size === 0} onClick={stageSelected}>Stage selected</button>
                  <button disabled={busy || stagedSelected.length === 0} onClick={unstageSelected}>Unstage selected</button>
                </div>
              </section>
              <section>
                <div className="message-header">
                  <h3>Message</h3>
                  <button disabled={busy || !preview.aiAvailable || preview.staged.length === 0} title={preview.aiAvailable ? "Generate AI message. Diff content may be sent to provider." : "AI provider unavailable."} onClick={generateMessage}>
                    Generate AI Message
                  </button>
                </div>
                {!preview.aiAvailable && <p className="muted">AI generation is unavailable. Manual commit messages still work.</p>}
                {preview.packageVersion && (
                  <label className="version-bump-option">
                    <input type="checkbox" checked={bumpVersion} onChange={(event) => setBumpVersion(event.target.checked)} />
                    <span>
                      Bump {preview.packageVersion.path} from {preview.packageVersion.current} to {preview.packageVersion.next}
                    </span>
                  </label>
                )}
                <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" />
                <div className="commit-actions">
                  <button className="primary" disabled={!canCommit} onClick={() => doCommit(false)}>Commit</button>
                  <button className="primary" disabled={!canCommit} onClick={() => doCommit(true)}>Commit and Push</button>
                </div>
                <div className="do-everything-actions">
                  <button className="primary do-everything-button" disabled={!canDoEverything} title={preview.aiAvailable ? "Stage all changes, bump version, generate an AI message, commit, and push." : "AI provider unavailable."} onClick={doEverything}>
                    Do Everything
                  </button>
                  {doEverythingStep && <p className="do-everything-status">{doEverythingStep}</p>}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
