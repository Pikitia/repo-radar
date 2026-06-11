import { useMemo } from "react";
import type { DiffMode } from "../types/repo";
import { parseSideBySideDiff } from "../utils/diffParser";

type Props = {
  text: string;
  mode: DiffMode | "commit";
  label: string;
};

export function SideBySideDiff({ text, mode, label }: Props) {
  const rows = useMemo(() => parseSideBySideDiff(text, mode), [text, mode]);

  if (rows.length === 0) return <div className="diff-state">No textual diff.</div>;

  return (
    <div className="side-by-side-diff" role="table" aria-label={label}>
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
  );
}

