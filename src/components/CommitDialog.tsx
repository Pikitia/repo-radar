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

  const stagedSelected = useMemo(() => [...selected].filter((file) => preview?.staged.includes(file)), [selected, preview]);
  const stageableFiles = useMemo(() => [...(preview?.unstaged ?? []), ...(preview?.untracked ?? [])], [preview]);

  async function loadPreview() {
    const next = await window.repoRadar.getCommitPreview(repo.absolutePath);
    setPreview(next);
    setSelected(new Set(next.staged));
  }

  useEffect(() => {
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
    try {
      setMessage(await window.repoRadar.generateCommitMessage(repo.absolutePath, preview.staged));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.repoRadar.commit(repo.absolutePath, message.trim());
      onCommitted(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const blockers = preview?.blockers ?? [];
  const canCommit = Boolean(message.trim()) && (preview?.staged.length ?? 0) > 0 && blockers.length === 0 && !busy;

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
                <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" />
                <button className="primary" disabled={!canCommit} onClick={doCommit}>Commit</button>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
