import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChangedFile, DiffMode, DiffResult, RepoStatus } from "../types/repo.js";
import { SideBySideDiff } from "./SideBySideDiff.js";

type Props = {
  repo: RepoStatus;
  mode: DiffMode;
};

const fileListMinWidth = 160;
const diffMinWidth = 240;
const dividerAndGapsWidth = 14;

export function DiffViewer({ repo, mode }: Props) {
  const files = useMemo(() => {
    if (mode === "working") return repo.files.filter((file) => file.unstaged && !file.untracked);
    if (mode === "staged") return repo.files.filter((file) => file.staged);
    return repo.files.filter((file) => file.untracked);
  }, [repo, mode]);
  const [selected, setSelected] = useState<ChangedFile | null>(files[0] ?? null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [fileListWidth, setFileListWidth] = useState(220);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const maxFileListWidth = Math.max(fileListMinWidth, layoutWidth - diffMinWidth - dividerAndGapsWidth);
  const visibleFileListWidth = layoutWidth ? Math.min(fileListWidth, maxFileListWidth) : fileListWidth;
  const hasFiles = files.length > 0;

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const observer = new ResizeObserver(([entry]) => setLayoutWidth(entry.contentRect.width));
    observer.observe(layout);
    return () => {
      observer.disconnect();
      dragRef.current = null;
      document.body.classList.remove("resizing-panels");
    };
  }, [hasFiles]);

  function resizeFileList(width: number) {
    setFileListWidth(Math.min(Math.max(width, fileListMinWidth), maxFileListWidth));
  }

  function finishResize() {
    dragRef.current = null;
    document.body.classList.remove("resizing-panels");
  }

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
    <div ref={layoutRef} className="diff-layout resizable-diff-layout" style={{ "--file-list-width": `${visibleFileListWidth}px` } as CSSProperties}>
      <div className="file-list">
        {files.map((file) => (
          <button key={`${file.path}-${file.kind}`} className={selected?.path === file.path ? "selected" : ""} onClick={() => setSelected(file)}>
            <span title={file.path}>{file.path}</span>
            <b>{file.kind}</b>
          </button>
        ))}
      </div>
      <div
        className="split-resizer diff-resizer"
        role="separator"
        aria-label="Resize file list"
        aria-orientation="vertical"
        aria-valuemin={fileListMinWidth}
        aria-valuemax={layoutWidth ? maxFileListWidth : fileListWidth}
        aria-valuenow={Math.round(visibleFileListWidth)}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: visibleFileListWidth };
          document.body.classList.add("resizing-panels");
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          resizeFileList(drag.startWidth + event.clientX - drag.startX);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          finishResize();
        }}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 50 : 20;
          if (event.key === "ArrowLeft") resizeFileList(visibleFileListWidth - step);
          else if (event.key === "ArrowRight") resizeFileList(visibleFileListWidth + step);
          else if (event.key === "Home") resizeFileList(fileListMinWidth);
          else if (event.key === "End") resizeFileList(maxFileListWidth);
          else return;
          event.preventDefault();
        }}
      />
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
        {diff && !diff.isBinary && <SideBySideDiff text={diff.text} mode={mode} label={`Diff for ${selected?.path ?? "selected file"}`} />}
      </section>
    </div>
  );
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}
