import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { canReviewSync } from "../state/repoLogic.js";
import type { RepoStatus, SyncConflictSide, SyncConflictReview, SyncDecision } from "../types/repo.js";
import { blockVersions, combineBlocks, hasConflictMarkers, restoreEditorLineEndings, splitMergeText, type BlockChoice } from "../state/mergeText.js";
import { RepositoryDialog } from "./RepositoryDialog.js";

type Props = {
  repo: RepoStatus;
  onClose(): void;
  onRepoUpdated(status: RepoStatus): void;
  onComplete(status: RepoStatus): Promise<void>;
  onMessage(message: string): void;
};

type VersionChoice =
  | { choice: "local" }
  | { choice: "incoming" }
  | { choice: "blocks"; choices: BlockChoice[] };
type Draft = VersionChoice | { choice: "edited"; text: string; previous?: VersionChoice; modified?: boolean };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type Side = "local" | "incoming";

function SideChoices({ versions, selected, rebase, parents, wholeFile, choose }: {
  versions: Record<Side, SyncConflictSide>; selected?: string; rebase: boolean; parents?: SyncConflictReview["mergeParents"];
  wholeFile?: boolean; choose(side: Side): void;
}) {
  return <div className="merge-sides">
    {(["local", "incoming"] as const).map(side => {
      const version = versions[side];
      const parent = side === "local" ? "first" : "second";
      const label = parents ? (parent === "first" ? "First parent" : "Second parent")
        : side === "local" ? (rebase ? "Local commit" : "This computer") : (rebase ? "Updated branch" : "Incoming");
      const source = parents ? `${parent} parent` : side === "local" ? "local" : (rebase ? "updated branch" : "incoming");
      return <section key={side}>
        <h4>{label}{parents && ` · ${parents[parent]}`}</h4>
        <pre>{version.exists ? version.text ?? "Preview unavailable for this file." : "File deleted"}
          {version.exists && version.text === "" && <em>{wholeFile ? "Empty file" : "No lines"}</em>}</pre>
        <button aria-pressed={selected === side} onClick={() => choose(side)}>
          {version.exists ? `Keep ${source} ${wholeFile ? "file" : "change"}` : `Use ${source} deletion`}
        </button>
      </section>;
    })}
  </div>;
}

export function SyncConflictDialog({ repo, onClose, onRepoUpdated, onComplete, onMessage }: Props) {
  const [review, setReview] = useState<SyncConflictReview | null>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadId, setLoadId] = useState(0);
  const submitting = useRef(false);
  const recovery = useRef<{ repoPath: string; review: SyncConflictReview; drafts: Map<string, Draft>; selectedPath?: string } | null>(null);
  const repoPath = repo.absolutePath;

  useEffect(() => {
    let cancelled = false;
    window.repoRadar.getSyncConflictReview(repoPath).then(next => {
      if (cancelled) return;
      const previous = recovery.current;
      recovery.current = null;
      const kept = new Map<string, Draft>();
      let nextIndex = 0;
      if (previous?.repoPath === repoPath && previous.review.operation === next.operation) {
        const oldFiles = new Map(previous.review.files.map(file => [file.path, file.identity]));
        for (const file of next.files) {
          const draft = previous.drafts.get(file.path);
          if (draft && (previous.review.token === next.token || (file.identity && file.identity === oldFiles.get(file.path)))) {
            kept.set(file.path, draft);
          }
        }
        nextIndex = Math.max(0, next.files.findIndex(file => file.path === previous.selectedPath));
        if (kept.size) setNotice(`Review refreshed. Kept your choices for ${kept.size} unchanged ${kept.size === 1 ? "file" : "files"}.`);
      }
      setReview(next);
      setSelected(nextIndex);
      setDrafts(kept);
    }).catch((err: unknown) => { if (!cancelled) setError(messageOf(err)); });
    return () => { cancelled = true; };
  }, [repoPath, loadId]);

  const rebase = review?.operation === "rebase";
  const replayPick = rebase && !review?.mergeParents;
  const files = useMemo(() => (review?.files ?? []).map(file => ({
    file,
    parts: file.mergedText === null ? [] : splitMergeText(file.mergedText, file.markerSize, {
      current: replayPick ? file.incoming.text : file.local.text,
      incoming: replayPick ? file.local.text : file.incoming.text
    })
  })), [review, replayPick]);
  const decisions = useMemo(() => files.map(({ file, parts }): SyncDecision | null => {
    const draft = drafts.get(file.path);
    if (!draft) return null;
    if (draft.choice === "local" || draft.choice === "incoming") return { path: file.path, choice: draft.choice };
    if (draft.choice === "edited" && !draft.modified && (draft.previous?.choice === "local" || draft.previous?.choice === "incoming")) {
      return { path: file.path, choice: draft.previous.choice };
    }
    const text = draft.choice === "blocks" ? combineBlocks(parts, draft.choices, replayPick) : draft.text;
    return text !== null && !hasConflictMarkers(text, file.markerSize, file) ? { path: file.path, choice: "edited", text } : null;
  }), [files, drafts, replayPick]);
  const ready = decisions.filter((d): d is SyncDecision => d !== null);
  const entry = files[selected];
  const file = entry?.file;
  const draft = file && drafts.get(file.path);
  const blocks = entry?.parts.filter(part => typeof part !== "string") ?? [];

  function choose(next: Draft) {
    if (file) setDrafts(previous => new Map(previous).set(file.path, next));
  }

  function reload() {
    setReview(null);
    setLoadId(current => current + 1);
  }

  async function finish() {
    if (submitting.current || !review || ready.length !== files.length) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await window.repoRadar.finishSync(repoPath, review.token, ready, review.canSkipEmptyPatch === true);
      if (canReviewSync(updated)) {
        onRepoUpdated(updated);
        setNotice("Review the next step to finish syncing.");
        reload();
      } else {
        await onComplete(updated);
      }
    } catch (err) {
      const reason = messageOf(err);
      recovery.current = { repoPath, review, drafts, selectedPath: file?.path };
      setError(reason);
      try {
        const updated = await window.repoRadar.refreshRepository(repoPath, false);
        onRepoUpdated(updated);
        if (canReviewSync(updated)) {
          reload();
        } else {
          onMessage(reason);
          onClose();
        }
      } catch (refreshError) {
        setReview(null);
        setError(`${reason} Could not refresh the repository. ${messageOf(refreshError)}`);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const nextUndecided = decisions.findIndex((decision, i) => !decision && i > selected);
  const nextFile = nextUndecided >= 0 ? nextUndecided : decisions.findIndex(decision => !decision);
  const sides = file && <SideChoices versions={file} rebase={rebase} parents={review?.mergeParents} selected={draft?.choice} wholeFile choose={side => choose({ choice: side })} />;

  return <RepositoryDialog titleId="merge-title" className="merge-dialog" busy={busy} onClose={onClose}>
      <header><div><h2 id="merge-title">Review merge</h2><p>{repo.name} {repo.upstream && <>· {repo.upstream}</>}</p></div>
        <button disabled={busy} title="Close without applying these choices" onClick={onClose}>Close</button>
      </header>
      <div className="merge-body">
        {error && <p className="issue-box" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!review && (error ? <button onClick={() => { setError(""); reload(); }}>Reload review</button> : <p role="status">Reading conflicting files…</p>)}
        {review && <>
          {review.hasDeferredFiles && <p>Resolve Git attributes first. Repo Radar will use those settings to show the remaining files.</p>}
          {!!review.stagedPaths?.length && <details>
            <summary>Already staged for this {rebase ? "commit" : "merge"} ({review.stagedPaths.length})</summary>
            <ul>{review.stagedPaths.map(path => <li key={path}>{path}</li>)}</ul>
          </details>}
          {file && <>
            <div className="merge-file-picker"><label htmlFor="merge-file">File to review</label>
              <select id="merge-file" value={selected} disabled={busy} onChange={event => setSelected(Number(event.target.value))}>
                {files.map(({ file: item }, index) => <option value={index} key={item.path}>{decisions[index] ? "✓ " : ""}{item.path}</option>)}
              </select><span>{ready.length} of {files.length} ready</span>
            </div>
            {review.mergeParents && <p className="muted">Git is recreating a merge between the two commits shown below.</p>}
            {replayPick && <p className="muted">Git is replaying a local commit onto the updated branch. The updated branch includes incoming changes and any earlier commits already replayed.</p>}
            <fieldset disabled={busy} className="merge-options" key={file.path}>
              {draft?.choice !== "edited" && blocks.length > 0 && <>
                <p>Choose what to keep in each conflict. The changes Git already combined will be included.</p>
                {blocks.map((block, index) => {
                  const versions = blockVersions(block, replayPick);
                  const selection = draft?.choice === "blocks" ? draft.choices[index] : undefined;
                  function pick(value: BlockChoice) {
                    const choices = draft?.choice === "blocks" ? [...draft.choices] : [];
                    choices[index] = value;
                    choose({ choice: "blocks", choices });
                  }
                  return <section key={index} className="merge-block" aria-label={`Conflict ${index + 1}`}>
                    <h3>Conflict {index + 1} of {blocks.length}</h3>
                    <SideChoices versions={{ local: { exists: true, text: versions.local }, incoming: { exists: true, text: versions.incoming } }}
                      rebase={rebase} parents={review.mergeParents} selected={selection} choose={pick} />
                    <button aria-pressed={selection === "both"} onClick={() => pick("both")}>{review.mergeParents ? "Keep both in parent order" : "Keep both, local first"}</button>
                  </section>;
                })}
                <details><summary>Compare and choose whole files</summary>
                  <p>Choosing a whole file replaces every line with that version.</p>{sides}
                </details>
              </>}
              {draft?.choice !== "edited" && !blocks.length && <><p>Choose the version to keep for this entire file.</p>{sides}</>}
              {file.mergedText !== null && <div className="merge-editor">
                {draft?.choice !== "edited" ? <button onClick={() => {
                  let text = file.mergedText;
                  if (draft?.choice === "blocks") text = combineBlocks(entry.parts, draft.choices, replayPick, true);
                  if (draft?.choice === "local" || draft?.choice === "incoming") text = file[draft.choice].text;
                  choose({ choice: "edited", text: text ?? "", previous: draft });
                }}>Edit merged text</button> : <><label htmlFor="merge-result">Merged file contents</label>
                  <textarea id="merge-result" spellCheck={false} value={draft.text.replace(/\r\n?/g, "\n")} onChange={event =>
                    choose({ ...draft, modified: true, text: restoreEditorLineEndings(draft.text, event.target.value, file.mergedText ?? "") })} />
                  {!draft.modified && (draft.previous?.choice === "local" || draft.previous?.choice === "incoming") && !file[draft.previous.choice].exists &&
                    <p>The file will be deleted. Enter replacement text to keep it.</p>}
                  {hasConflictMarkers(draft.text, file.markerSize, file) && <p>Remove the remaining conflict markers to finish this file.</p>}
                  <button onClick={() => choose(draft.previous ?? { choice: "blocks", choices: [] })}>Discard text edits and return to choices</button>
                </>}
              </div>}
            </fieldset>
          </>}
          {!file && <p>{review.canSkipEmptyPatch
            ? "Your choices leave this commit with no changes. Skip this empty commit to continue the rebase, or close to leave it paused."
            : "All conflicts have been staged. Finish sync to continue Git and push the result."}</p>}
        </>}
      </div>
      {review && <footer>
        <span>{file && decisions[selected] && <><Check size={16} /> File ready</>}</span>
        {nextFile >= 0 && nextFile !== selected && <button disabled={busy} onClick={() => setSelected(nextFile)}>Next unresolved file</button>}
        <button className="primary" disabled={busy || ready.length !== files.length} onClick={() => void finish()}>
          {busy ? "Applying choices…" : review.hasDeferredFiles ? "Apply choices and continue review"
            : review.canSkipEmptyPatch ? "Skip empty commit and continue sync" : "Finish sync and push"}
        </button>
      </footer>}
  </RepositoryDialog>;
}
