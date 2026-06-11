import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import type { ProjectFile, RepoStatus } from "../types/repo";

type Props = {
  repo: RepoStatus;
};

export function ProjectFilesViewer({ repo }: Props) {
  const defaultFile = useMemo(() => repo.projectFiles.find((file) => file.path.toLowerCase() === "readme.md") ?? repo.projectFiles[0], [repo]);
  const [selected, setSelected] = useState<ProjectFile | undefined>(defaultFile);
  const [content, setContent] = useState("");
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    setSelected(defaultFile);
  }, [defaultFile]);

  useEffect(() => {
    let cancelled = false;
    setContent("");
    if (!selected) return;
    void window.repoRadar.readProjectFile(repo.absolutePath, selected.path).then((text) => {
      if (!cancelled) setContent(text);
    });
    return () => {
      cancelled = true;
    };
  }, [repo.absolutePath, selected]);

  if (!selected) return <div className="empty-panel">No known project files.</div>;

  return (
    <div className="diff-layout">
      <div className="file-list">
        {repo.projectFiles.map((file) => (
          <button key={file.path} className={selected.path === file.path ? "selected" : ""} onClick={() => setSelected(file)}>
            <span>{file.displayName}</span>
          </button>
        ))}
      </div>
      <div className="project-view">
        <div className="project-view-toolbar">
          <strong>{selected.displayName}</strong>
          <button onClick={() => setRaw((value) => !value)}>{raw ? "Rendered" : "Raw"}</button>
        </div>
        {selected.kind === "markdown" && !raw ? (
          <article className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(content) }} />
        ) : (
          <pre>{content}</pre>
        )}
      </div>
    </div>
  );
}
