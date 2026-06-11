import type { DiffMode } from "../types/repo";

export type SideBySideDiffRow = {
  id: string;
  kind: "context" | "added" | "removed" | "changed" | "hunk";
  leftNumber: number | null;
  rightNumber: number | null;
  leftText: string;
  rightText: string;
};

type RemovedLine = {
  number: number;
  text: string;
};

function parseHunkHeader(line: string): { left: number; right: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return { left: Number(match[1]), right: Number(match[2]) };
}

function makeId(index: number, kind: SideBySideDiffRow["kind"], leftNumber: number | null, rightNumber: number | null) {
  return `${index}-${kind}-${leftNumber ?? "x"}-${rightNumber ?? "x"}`;
}

function diffHeaderLabel(line: string): string {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!match) return line;
  return match[1] === match[2] ? match[2] : `${match[1]} -> ${match[2]}`;
}

export function parseSideBySideDiff(text: string, mode: DiffMode | "commit"): SideBySideDiffRow[] {
  text = text.trimStart();
  if (!text) return [];

  if (mode === "untracked" || !text.startsWith("diff --git")) {
    return text.split(/\r?\n/).map((line, index) => ({
      id: makeId(index, "added", null, index + 1),
      kind: "added",
      leftNumber: null,
      rightNumber: index + 1,
      leftText: "",
      rightText: line
    }));
  }

  const rows: SideBySideDiffRow[] = [];
  const pendingRemoved: RemovedLine[] = [];
  let leftNumber = 0;
  let rightNumber = 0;

  const flushRemoved = () => {
    while (pendingRemoved.length > 0) {
      const removed = pendingRemoved.shift()!;
      rows.push({
        id: makeId(rows.length, "removed", removed.number, null),
        kind: "removed",
        leftNumber: removed.number,
        rightNumber: null,
        leftText: removed.text,
        rightText: ""
      });
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flushRemoved();
      const hunk = parseHunkHeader(line);
      if (hunk) {
        leftNumber = hunk.left;
        rightNumber = hunk.right;
      }
      rows.push({
        id: makeId(rows.length, "hunk", null, null),
        kind: "hunk",
        leftNumber: null,
        rightNumber: null,
        leftText: line,
        rightText: line
      });
      continue;
    }

    if (line.startsWith("diff --git")) {
      flushRemoved();
      rows.push({
        id: makeId(rows.length, "hunk", null, null),
        kind: "hunk",
        leftNumber: null,
        rightNumber: null,
        leftText: diffHeaderLabel(line),
        rightText: diffHeaderLabel(line)
      });
      continue;
    }

    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    if (line.startsWith("-")) {
      pendingRemoved.push({ number: leftNumber, text: line.slice(1) });
      leftNumber += 1;
      continue;
    }

    if (line.startsWith("+")) {
      const addedText = line.slice(1);
      const removed = pendingRemoved.shift();
      if (removed) {
        rows.push({
          id: makeId(rows.length, "changed", removed.number, rightNumber),
          kind: "changed",
          leftNumber: removed.number,
          rightNumber,
          leftText: removed.text,
          rightText: addedText
        });
      } else {
        rows.push({
          id: makeId(rows.length, "added", null, rightNumber),
          kind: "added",
          leftNumber: null,
          rightNumber,
          leftText: "",
          rightText: addedText
        });
      }
      rightNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      flushRemoved();
      rows.push({
        id: makeId(rows.length, "context", leftNumber, rightNumber),
        kind: "context",
        leftNumber,
        rightNumber,
        leftText: line.slice(1),
        rightText: line.slice(1)
      });
      leftNumber += 1;
      rightNumber += 1;
    }
  }

  flushRemoved();
  return rows;
}
