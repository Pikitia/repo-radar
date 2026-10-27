import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  closeLabel: string;
  busy: boolean;
  error?: string;
  notice?: string;
  progress?: string;
  onClose(): void;
  children: ReactNode;
}

/** Native top-layer modality keeps the Settings form inert and restores its focus. */
export function DatabaseEditorDialog({ title, closeLabel, busy, error, notice, progress, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="database-editor-dialog database-workspace" aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}>
    <header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose}>{closeLabel}</button></header>
    <div className="database-editor-body">
      {error && <p role="alert" className="issue-box">{error}</p>}{notice && <p role="status">{notice}</p>}{progress && <p role="status">{progress}…</p>}
      {children}
    </div>
  </dialog>;
}
