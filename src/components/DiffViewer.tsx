import { useEffect, useMemo, useState } from "react";
import type { ChangedFile, DiffMode, DiffResult, RepoStatus } from "../types/repo";
import { parseSideBySideDiff } from "../utils/diffParser";

type Props = {
  repo: RepoStatus;
  mode: DiffMode;
};

export function DiffViewer({ repo, mode }: Props) {
  const files = useMemo(() => {
    if (mode === "working") return repo.files.filter((file) => file.unstaged && !file.untracked);
    if (mode === "staged") return repo.files.filter((file) => file.staged);
    return repo.files.filter((file) => file.untracked);
  }, [repo, mode]);
  const [selected, setSelected] = useState<ChangedFile | null>(files[0] ?? null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const rows = useMemo(() => diff && !diff.isBinary ? parseSideBySideDiff(diff.text, mode) : [], [diff, mode]);

  useEffect(() => {
    setSelected(files[0] ?? null);
  }, [repo.id, mode, files]);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    if (!selected) return;
    void window.repoRadar.getDiff(repo.absolutePath, selected.path, mode).then((result) => {
      if (!cancelled) setDiff(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repo.absolutePath, selected, mode]);

  if (files.length === 0) return <div className="empty-panel">No files in this view.</div>;

  return (
    <div className="diff-layout">
      <div className="file-list">
        {files.map((file) => (
          <button key={`${file.path}-${file.kind}`} className={selected?.path === file.path ? "selected" : ""} onClick={() => setSelected(file)}>
            <span title={file.path}>{compactPath(file.path)}</span>
            <b>{file.kind}</b>
          </button>
        ))}
      </div>
      <section className="diff-viewer">
        <header className="diff-header">
          <div>
            <strong>{selected ? fileName(selected.path) : "No file selected"}</strong>
            {selected && <span title={selected.path}>{selected.path}</span>}
          </div>
          {selected && <b>{selected.kind}</b>}
        </header>
        {!diff && <div className="diff-state">Loading diff...</div>}
        {diff?.error && <div className="diff-state issue-box">{diff.error}</div>}
        {diff?.isBinary && <div className="diff-state">Binary file.</div>}
        {diff && !diff.isBinary && rows.length === 0 && <div className="diff-state">No textual diff.</div>}
        {diff && !diff.isBinary && rows.length > 0 && (
          <div className="side-by-side-diff" role="table" aria-label={`Diff for ${selected?.path ?? "selected file"}`}>
            <div className="diff-columns" role="row">
              <span>Original</span>
              <span>Changed</span>
            </div>
            {rows.map((row) => (
              <div key={row.id} className={`diff-row ${row.kind}`} role="row">
                <span className="line-number">{row.leftNumber ?? ""}</span>
                <code className="line-text">{row.leftText || " "}</code>
                <span className="line-number">{row.rightNumber ?? ""}</span>
                <code className="line-text">{row.rightText || " "}</code>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function compactPath(filePath: string): string {
  const name = fileName(filePath);
  return name === filePath ? name : `../${name}`;
}
