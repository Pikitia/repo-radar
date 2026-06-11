import { useEffect, useMemo, useState } from "react";
import type { ChangedFile, DiffMode, DiffResult, RepoStatus } from "../types/repo";

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
            <span>{file.path}</span>
            <b>{file.kind}</b>
          </button>
        ))}
      </div>
      <pre className="diff-view">{diff ? diff.isBinary ? "Binary file." : diff.text || "No textual diff." : "Loading diff..."}</pre>
    </div>
  );
}
