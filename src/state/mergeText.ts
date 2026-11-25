import type { SyncConflictFile } from "../types/repo.js";

type ConflictBlock = { current: string; incoming: string; original: string };
type MergePart = string | ConflictBlock;
type Versions = { current: string | null; incoming: string | null };
type Span = { start: number; end: number };

export type BlockChoice = "local" | "incoming" | "both";

function markerOf(line: string, size: number) {
  const run = line.match(/^(<+|>+|=+|\|+)(?=\s|$)/)?.[0];
  if (!run || run.length !== size || (run[0] === "=" && line.trimEnd() !== run)) return null;
  return run[0];
}

// Match entire examples (including their bodies), since a real conflict often
// has exactly the same opening and closing labels as a documented example.
function completeBlocks(lines: string[], size: number) {
  const blocks = new Map<string, Span[]>();
  let start = -1;
  let divided = false;
  for (const [i, line] of lines.entries()) {
    const marker = markerOf(line, size);
    if (marker === "<") { start = i; divided = false; }
    if (start < 0) continue;
    if (marker === "=") divided = true;
    if (marker !== ">" || !divided) continue;
    const body = lines.slice(start, i + 1).join("\n");
    const matches = blocks.get(body) ?? [];
    matches.push({ start, end: i });
    blocks.set(body, matches);
    start = -1;
  }
  return blocks;
}

function neighbors(lines: string[], span: Span) {
  return JSON.stringify([lines[span.start - 1], lines[span.end + 1]]);
}

function couldBeConflict(body: string, otherLines: Set<string>, size: number) {
  const lines = body.split("\n");
  const divider = lines.findIndex(line => markerOf(line, size) === "=");
  const ancestor = lines.findIndex(line => markerOf(line, size) === "|");
  // A real conflict needs one of its alternatives to come from the opposite
  // version. If neither occurs there, this can only be the source example.
  return [lines.slice(1, ancestor < 0 ? divider : ancestor), lines.slice(divider + 1, -1)]
    .some(alternative => alternative.every(line => otherLines.has(line)));
}

// With no saved AUTO_MERGE tree, check whether the exact two alternatives
// actually occur at the example's source location in addition to the example.
function matchesAlternativeContexts(body: string, size: number, contexts: Set<string>, sources: Versions) {
  if (!sources.current || !sources.incoming) return false;
  const lines = body.split("\n");
  const divider = lines.findIndex(line => markerOf(line, size) === "=");
  const ancestor = lines.findIndex(line => markerOf(line, size) === "|");
  const left = lines.slice(1, ancestor < 0 ? divider : ancestor);
  const right = lines.slice(divider + 1, -1);
  const current = "\n" + sources.current.replaceAll("\r\n", "\n") + "\n";
  const incoming = "\n" + sources.incoming.replaceAll("\r\n", "\n") + "\n";
  for (const context of contexts) {
    const [before, after] = JSON.parse(context) as (string | null)[];
    const surrounded = (alternative: string[]) => "\n" + [before, ...alternative, after].filter(line => line !== null).join("\n") + "\n";
    const a = surrounded(left), b = surrounded(right);
    if ((current.includes(a) && incoming.includes(b)) || (incoming.includes(a) && current.includes(b))) return true;
  }
  return false;
}

// A guide can demonstrate just one marker. Match its exact text AND its two
// neighbors so an identically labelled Git marker elsewhere is still checked.
function standaloneMarkers(lines: string[], size: number, covered: Set<number>) {
  const groups = new Map<string, number[]>();
  for (const [i, line] of lines.entries()) {
    const marker = markerOf(line, size);
    if (covered.has(i) || !marker || (size < 7 && marker !== "=")) continue;
    const title = lines[i - 1] ?? "";
    // A docstring can retain its underline while its title is edited. Bind
    // that separator to the lines around the heading, including its underline.
    const key = marker === "=" && /[\p{L}\p{N}]/u.test(title) && !markerOf(title, size)
      ? JSON.stringify(["heading", lines[i - 2], line, lines[i + 1]])
      : JSON.stringify([lines[i - 1], line, lines[i + 1]]);
    const indices = groups.get(key) ?? [];
    indices.push(i);
    groups.set(key, indices);
  }
  return groups;
}

function sourceExamples(sources: Versions | undefined, size: number, working?: string | null, requireLocation = false) {
  const examples = {
    blocks: new Map<string, { count: number; contexts: Set<string>; needsContext: boolean; ambiguous: boolean }>(),
    standalone: new Map<string, number>()
  };
  if (!sources) return examples;
  const current = sources.current?.split(/\r?\n/) ?? [];
  const incoming = sources.incoming?.split(/\r?\n/) ?? [];
  const leftBlocks = completeBlocks(current, size);
  const rightBlocks = completeBlocks(incoming, size);
  for (const [lines, blocks] of [[current, leftBlocks], [incoming, rightBlocks]] as const) {
    const covered = new Set<number>();
    for (const spans of blocks.values()) for (const { start, end } of spans) for (let i = start; i <= end; i++) covered.add(i);
    for (const [key, indices] of standaloneMarkers(lines, size, covered)) {
      examples.standalone.set(key, Math.max(examples.standalone.get(key) ?? 0, indices.length));
    }
  }
  if (!leftBlocks.size && !rightBlocks.size) return examples;
  const currentLines = new Set(current);
  const incomingLines = new Set(incoming);
  for (const body of new Set([...leftBlocks.keys(), ...rightBlocks.keys()])) {
    const left = leftBlocks.get(body) ?? [];
    const right = rightBlocks.get(body) ?? [];
    const count = Math.max(left.length, right.length);
    const contexts = new Set([...left.map(span => neighbors(current, span)), ...right.map(span => neighbors(incoming, span))]);
    // An example newly added by either branch is ordinary content. Use its
    // location when the SAME block could also represent a genuine conflict.
    const needsContext = (requireLocation || left.length !== right.length) && couldBeConflict(body, left.length > right.length ? incomingLines : currentLines, size);
    examples.blocks.set(body, { count, contexts, needsContext, ambiguous: false });
  }
  if (working && examples.blocks.size) {
    const lines = working.split(/\r?\n/);
    for (const [body, spans] of completeBlocks(lines, size)) {
      const example = examples.blocks.get(body);
      if (!example || spans.length <= example.count) continue;
      example.needsContext = true;
      example.ambiguous = spans.filter(span => example.contexts.has(neighbors(lines, span))).length !== example.count;
    }
  }
  return examples;
}

function literalLines(lines: string[], size: number, examples: ReturnType<typeof sourceExamples>) {
  const literal = new Set<number>();
  let ambiguous = false;
  if (examples.blocks.size) for (const [body, spans] of completeBlocks(lines, size)) {
    const example = examples.blocks.get(body);
    if (!example) continue;
    if (example.ambiguous) { ambiguous = true; continue; }
    // If even the entire real block duplicates an example, use its original
    // surrounding lines. Abstain from hunk decisions when positions still tie.
    const needsContext = example.needsContext || spans.length > example.count;
    const matches = needsContext ? spans.filter(span => example.contexts.has(neighbors(lines, span))) : spans;
    if (matches.length > example.count || (needsContext && matches.length < Math.min(spans.length, example.count))) {
      ambiguous = true;
      continue;
    }
    for (const { start, end } of matches) for (let i = start; i <= end; i++) literal.add(i);
  }
  if (examples.standalone.size) for (const [key, indices] of standaloneMarkers(lines, size, literal)) {
    const count = examples.standalone.get(key);
    if (!count || indices.length > count) continue;
    for (const i of indices) literal.add(i);
  }
  return { literal, ambiguous };
}

function candidateMarkerSizes(text: string, configured: number) {
  const sizes = new Set([configured]);
  const openings = new Set<number>();
  const dividers = new Set<number>();
  // The merged .gitattributes can report a different size from the one Git
  // used. Also recognize complete native HEAD blocks present in the review.
  for (const line of text.split(/\r?\n/)) {
    const token = line.match(/^(<+) HEAD(?::.*)?$|^(=+)$|^(>+)(?:\s|$)/);
    if (!token) continue;
    if (token[1]) { openings.add(token[1].length); dividers.delete(token[1].length); }
    if (token[2] && openings.has(token[2].length)) dividers.add(token[2].length);
    if (token[3] && dividers.has(token[3].length)) sizes.add(token[3].length);
  }
  return sizes;
}

function trimInsertedNewline(chunk: string, source: string | null | undefined) {
  if (!source || /[\r\n]$/.test(source)) return chunk;
  const trimmed = chunk.replace(/\r?\n$/, "");
  return source.replaceAll("\r\n", "\n").endsWith(trimmed.replaceAll("\r\n", "\n")) ? trimmed : chunk;
}

// Keep each line ending with its text so untouched portions survive byte for byte.
export function splitMergeText(text: string, size = 7, sources?: Versions): MergePart[] {
  let parts: MergePart[] = [];
  for (const width of candidateMarkerSizes(text, size)) {
    const candidate = splitAtWidth(text, width, sources);
    if (!candidate.length) continue;
    if (parts.length) return [];
    parts = candidate;
  }
  return parts;
}

function splitAtWidth(text: string, size: number, sources?: Versions): MergePart[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const examples = sourceExamples(sources, size);
  const { literal, ambiguous } = literalLines(text.split(/\r?\n/), size, examples);
  if (ambiguous) return [];
  // A short marker can be real content (e.g. "> quote" or "| table").
  // Ambiguous blocks can still be reviewed with the whole-file and text options.
  const sourceLines = size < 7 && sources
    ? new Set([sources.current, sources.incoming].flatMap(source => outsideExamples(source, size, examples))) : null;
  const parts: MergePart[] = [];
  let start = 0;
  let index = 0;
  while (index < lines.length) {
    if (literal.has(index) || markerOf(lines[index], size) !== "<") {
      index++;
      continue;
    }
    if (sourceLines?.has(lines[index].replace(/\r?\n$/, ""))) return [];
    parts.push(lines.slice(start, index).join(""));
    const currentStart = ++index;
    let ancestor = -1;
    let divider = -1;
    for (; index < lines.length; index++) {
      if (literal.has(index)) continue;
      const marker = markerOf(lines[index], size);
      if (!marker) continue;
      if (sourceLines?.has(lines[index].replace(/\r?\n$/, ""))) return [];
      if (marker === "|" && ancestor < 0 && divider < 0) ancestor = index;
      else if (marker === "=" && divider < 0) divider = index;
      else if (marker === ">" && divider >= 0) break;
      else return [];
    }
    if (index === lines.length || divider < 0) return [];
    let current = lines.slice(currentStart, ancestor < 0 ? divider : ancestor).join("");
    let incoming = lines.slice(divider + 1, index).join("");
    if (index === lines.length - 1) {
      // Git adds a newline to separate its marker from an unterminated final line.
      current = trimInsertedNewline(current, sources?.current);
      incoming = trimInsertedNewline(incoming, sources?.incoming);
    }
    parts.push({ current, incoming, original: lines.slice(currentStart - 1, index + 1).join("") });
    start = ++index;
  }
  if (!parts.length) return [];
  parts.push(lines.slice(start).join(""));
  return parts;
}

function outsideExamples(text: string | null, size: number, examples: ReturnType<typeof sourceExamples>) {
  const lines = text?.split(/\r?\n/) ?? [];
  const { literal } = literalLines(lines, size, examples);
  return lines.filter((_, index) => !literal.has(index));
}

export function hasConflictMarkers(text: string, size = 7, reviewed?: SyncConflictFile): boolean {
  const widths = candidateMarkerSizes(text, size);
  if (reviewed?.mergedText && reviewed.mergedText !== text) {
    for (const width of candidateMarkerSizes(reviewed.mergedText, size)) widths.add(width);
  }
  for (const line of reviewed?.generatedMarkerLines ?? []) widths.add(line.match(/^[<>=|]+/)![0].length);
  for (const example of reviewed?.ambiguousMarkerExamples ?? []) widths.add(example.width);
  for (const width of widths) {
    if (hasMarkersAtWidth(text, width, reviewed)) return true;
  }
  return false;
}

function hasMarkersAtWidth(text: string, size: number, reviewed?: SyncConflictFile): boolean {
  const sources = reviewed && { current: reviewed.local.text, incoming: reviewed.incoming.text };
  const examples = sourceExamples(sources, size, reviewed?.mergedText, Boolean(reviewed?.generatedMarkerLines?.length));
  const ambiguous = reviewed?.ambiguousMarkerExamples?.filter(example => example.width === size);
  if (ambiguous?.length) {
    const blocks = [...examples.blocks.values()];
    for (const { exampleIndex } of ambiguous) if (blocks[exampleIndex]) blocks[exampleIndex].ambiguous = true;
  }
  // Short marker characters also start ordinary Markdown quotes, tables and headings.
  let opening = false;
  let divider = false;
  const remaining = new Set<string>();
  const generated = new Set(reviewed?.generatedMarkerLines);
  const fallback = new Set(reviewed?.fallbackMarkerLabels);
  // Underlined headings and dividers are valid new content in prose. A source
  // separator retained in its original context is already handled as a literal.
  const prose = reviewed && /(?:\.(?:md|rmd|qmd|mdx|markdown|mdown|mkd|rst|adoc|asciidoc|txt|text)|(?:^|\/)(?:readme|changelog|license|copying))$/i.test(reviewed.path);
  const sourceLines = fallback.size && sources
    ? new Set([sources.current, sources.incoming].flatMap(source => outsideExamples(source, size, examples))) : undefined;
  for (const line of outsideExamples(text, size, examples)) {
    const marker = markerOf(line, size);
    const possibleFallback = fallback.size > 0 && !sourceLines?.has(line) && (marker === "=" || fallback.has(line.slice(size + 1)));
    if (marker && (generated.has(marker === "=" ? line.trimEnd() : line) || possibleFallback) && (marker !== "=" || !prose)) return true;
    if (size >= 7 && marker && marker !== "=") return true;
    if (reviewed && marker && marker !== "=") remaining.add(line);
    if (marker === "<") { opening = true; divider = false; }
    else if (marker === "=" && opening) divider = true;
    else if (marker === ">" && divider) return true;
  }
  if (!remaining.size || !reviewed?.mergedText) return false;
  const original = outsideExamples(reviewed.mergedText, size, examples);
  if (!hasMarkersAtWidth(original.join("\n"), size)) return false;
  // A labelled marker unique to the reviewed conflict is still unresolved on its
  // own. Quotes or table rows present in either version remain valid file content.
  for (const side of [reviewed.local, reviewed.incoming]) {
    for (const line of outsideExamples(side.text, size, examples)) remaining.delete(line);
  }
  return original.some(line => remaining.has(line));
}

// Extract the original generated labels before inspecting a partially resolved
// index. Older merge strategies may only leave the replay's commit/ref labels.
export function markerEvidence(text: string, size: number, sources: Versions, fallbackLabels?: Set<string>) {
  const widths = candidateMarkerSizes(text, size);
  if (fallbackLabels) {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([<>|]+) (.+)$/);
      if (match && fallbackLabels.has(match[2])) widths.add(match[1].length);
    }
  }
  const generated = new Set<string>();
  const ambiguous: NonNullable<SyncConflictFile["ambiguousMarkerExamples"]> = [];
  for (const width of widths) {
    const examples = sourceExamples(sources, width, text, Boolean(fallbackLabels));
    // Keep the index in the original source examples, even if a later working
    // edit removes one copy. This also works for streamed, compacted Git blobs.
    for (const [exampleIndex, [body, example]] of [...examples.blocks].entries()) {
      if (example.ambiguous || (fallbackLabels && matchesAlternativeContexts(body, width, example.contexts, sources))) {
        ambiguous.push({ width, exampleIndex });
      }
    }
    const prior = new Set([sources.current, sources.incoming].flatMap(source => outsideExamples(source, width, examples)));
    for (const line of outsideExamples(text, width, examples)) {
      const marker = markerOf(line, width);
      if (!marker || prior.has(line)) continue;
      if (!fallbackLabels || marker === "=" || fallbackLabels.has(line.slice(width + 1))) generated.add(line);
    }
  }
  return { generatedMarkerLines: [...generated], ambiguousMarkerExamples: ambiguous, fallbackMarkerLabels: fallbackLabels && [...fallbackLabels] };
}

// Textarea.value normalizes every line ending to LF. Keep the endings of unchanged
// prefix/suffix lines and use the surrounding file style for newly inserted lines.
export function restoreEditorLineEndings(previous: string, value: string, original: string): string {
  const endings = previous.match(/\r\n|[\r\n]/g) ?? [];
  const fallback = endings[0] ?? original.match(/\r\n|[\r\n]/)?.[0] ?? "\n";
  if (endings.every(ending => ending === fallback)) return value.replaceAll("\n", fallback);
  const before = previous.split(/\r\n|[\r\n]/);
  const after = value.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return after.map((line, i) => {
    if (i === after.length - 1) return line;
    const oldIndex = i >= newEnd ? oldEnd + i - newEnd : i;
    const ending = i >= start && i < newEnd && i >= oldEnd ? endings[oldEnd - 1] : endings[oldIndex];
    return line + (ending ?? fallback);
  }).join("");
}

export function blockVersions(block: ConflictBlock, rebase: boolean) {
  return rebase ? { local: block.incoming, incoming: block.current } : { local: block.current, incoming: block.incoming };
}

export function combineBlocks(parts: MergePart[], choices: BlockChoice[], rebase: boolean, keepUnresolved = false): string | null {
  let index = 0;
  let result = "";
  for (const part of parts) {
    if (typeof part === "string") {
      result += part;
      continue;
    }
    const choice = choices[index++];
    if (!choice) {
      if (!keepUnresolved) return null;
      result += part.original;
      continue;
    }
    const versions = blockVersions(part, rebase);
    if (choice === "both") {
      const separator = versions.local && versions.incoming && !versions.local.endsWith("\n") ? part.original.match(/\r?\n/)?.[0] ?? "\n" : "";
      result += versions.local + separator + versions.incoming;
    } else {
      result += versions[choice];
    }
  }
  return index ? result : null;
}
