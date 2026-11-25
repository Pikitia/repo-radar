import { useLayoutEffect, useRef, type ReactNode } from "react";

type Props = {
  titleId: string;
  className?: string;
  busy: boolean;
  onClose(): void;
  children: ReactNode;
};

export function RepositoryDialog({ titleId, className = "", busy, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    dialog.showModal();
    (dialog.querySelector<HTMLElement>("button:not(:disabled)") ?? dialog).focus();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(":disabled")) opener.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (busy) ref.current?.focus();
  }, [busy]);

  return <dialog ref={ref} tabIndex={-1} aria-labelledby={titleId} aria-modal="true" aria-busy={busy}
    className={`modal ${className}`}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }
      if (event.key !== "Tab") return;
      const dialog = event.currentTarget;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, a[href]"))
        .filter(item => !item.matches(":disabled, [type=hidden], [tabindex='-1']") &&
          (!item.closest("details:not([open])") || item.matches("details:not([open]) > summary")));
      if (busy || !items.length || document.activeElement === dialog ||
        document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) {
        event.preventDefault();
        (busy ? dialog : (event.shiftKey ? items.at(-1) : items[0]) ?? dialog).focus();
      }
    }}>
    {children}
  </dialog>;
}
