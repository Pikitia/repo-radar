import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SyncConflictDialog } from "../../src/components/SyncConflictDialog.js";
import { combineBlocks, hasConflictMarkers, restoreEditorLineEndings, splitMergeText } from "../../src/state/mergeText.js";
import type { RepoStatus, SyncConflictReview } from "../../src/types/repo.js";

describe("sync text choices", () => {
  it("shows both recreated merge parents and combines their text in that order", async () => {
    const repo = { absolutePath: "C:/fixture", name: "fixture", errors: [] } as unknown as RepoStatus;
    const review: SyncConflictReview = { token: "recreated", operation: "rebase",
      mergeParents: { first: "abc123 Main work", second: "def456 Topic work" },
      files: [{ path: "guide", local: { exists: true, text: "main\n" }, incoming: { exists: true, text: "topic\n" },
        mergedText: "<<<<<<< HEAD\nmain\n=======\ntopic\n>>>>>>> topic\n" }]
    };
    const finishSync = vi.fn().mockResolvedValue(repo);
    vi.stubGlobal("repoRadar", { getSyncConflictReview: vi.fn().mockResolvedValue(review), finishSync });
    try {
      render(<SyncConflictDialog repo={repo} onComplete={vi.fn()} onRepoUpdated={vi.fn()} onClose={vi.fn()} onMessage={vi.fn()} />);
      const hunk = within(await screen.findByRole("region", { name: "Conflict 1" }));
      expect(hunk.getByRole("heading", { name: "First parent · abc123 Main work" })).toBeVisible();
      expect(hunk.getByRole("heading", { name: "Second parent · def456 Topic work" })).toBeVisible();
      fireEvent.click(hunk.getByRole("button", { name: "Keep both in parent order" }));
      fireEvent.click(screen.getByRole("button", { name: "Finish sync and push" }));
      await waitFor(() => expect(finishSync).toHaveBeenCalledWith(repo.absolutePath, review.token, [
        { path: "guide", choice: "edited", text: "main\ntopic\n" }
      ], false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])("preserves a chosen deletion in the editor until replacement text is entered (%s)", async changeText => {
    const repo = { absolutePath: "C:/fixture", name: "fixture", upstream: "origin/main", errors: [] } as unknown as RepoStatus;
    const finishSync = vi.fn().mockResolvedValue(repo);
    const file = { path: "draft.md", local: { exists: true, text: "Changed draft" }, incoming: { exists: false, text: null }, mergedText: "Changed draft" };
    vi.stubGlobal("repoRadar", { getSyncConflictReview: vi.fn().mockResolvedValue({ token: "deletion", operation: "merge", files: [file] }), finishSync });
    try {
      render(<SyncConflictDialog repo={repo} onComplete={vi.fn()} onRepoUpdated={vi.fn()} onClose={vi.fn()} onMessage={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Use incoming deletion" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit merged text" }));
      expect(screen.getByText(/the file will be deleted/i)).toBeVisible();
      if (changeText) fireEvent.change(screen.getByRole("textbox", { name: "Merged file contents" }), { target: { value: "New text" } });
      fireEvent.click(screen.getByRole("button", { name: "Finish sync and push" }));
      const expected = changeText ? { path: file.path, choice: "edited", text: "New text" } : { path: file.path, choice: "incoming" };
      await waitFor(() => expect(finishSync).toHaveBeenCalledWith(repo.absolutePath, "deletion", [expected], false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the configured width and submits manual edits with the reviewed line endings", async () => {
    const repo = { absolutePath: "C:/fixture", name: "fixture", upstream: "origin/main", errors: [] } as unknown as RepoStatus;
    const review: SyncConflictReview = { token: "review", operation: "merge", files: [{
      path: "guide.md", markerSize: 3, local: { exists: true, text: "Heading\r\nlocal\r\nend\nlast" },
      incoming: { exists: true, text: "Heading\r\nremote\r\nend\nlast" },
      mergedText: "Heading\r\n<<< HEAD\r\nlocal\r\n===\r\nremote\r\n>>> origin/main\r\nend\nlast"
    }] };
    const finishSync = vi.fn().mockResolvedValue(repo);
    vi.stubGlobal("repoRadar", { getSyncConflictReview: vi.fn().mockResolvedValue(review), finishSync });
    try {
      render(<SyncConflictDialog repo={repo} onComplete={vi.fn()} onRepoUpdated={vi.fn()} onClose={vi.fn()} onMessage={vi.fn()} />);
      await screen.findByRole("region", { name: "Conflict 1" });
      fireEvent.click(screen.getByRole("button", { name: "Edit merged text" }));
      const finish = screen.getByRole("button", { name: "Finish sync and push" });
      expect(finish).toBeDisabled();
      const input = screen.getByRole("textbox", { name: "Merged file contents" });
      fireEvent.change(input, { target: { value: "Heading\ncombined\n>>> origin/main\nend\nlast" } });
      expect(finish).toBeDisabled();
      fireEvent.change(input, { target: { value: "Heading\n===\n> Quote\ncombined\nend\nlast" } });
      fireEvent.click(finish);
      await waitFor(() => expect(finishSync).toHaveBeenCalledWith(repo.absolutePath, review.token, [
        { path: "guide.md", choice: "edited", text: "Heading\r\n===\r\n> Quote\r\ncombined\r\nend\nlast" }
      ], false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes short markers from Markdown quotes, headings and tables", () => {
    for (const width of [1, 3, 7, 12]) {
      const opening = "<".repeat(width), divider = "=".repeat(width), close = ">".repeat(width);
      const marked = `${opening} HEAD\nlocal\n${divider}\nincoming\n${close} upstream\n`;
      expect(hasConflictMarkers(marked, width)).toBe(true);
      expect(hasConflictMarkers(`Heading\n${divider}\n> quote\n| table |\n`, width)).toBe(false);
      const parts = splitMergeText(marked, width, { current: "local", incoming: "incoming" });
      expect(combineBlocks(parts, ["local"], false)).toBe("local");
      expect(combineBlocks(parts, ["both"], true)).toBe("incoming\nlocal");
    }
    const ambiguous = "< HEAD\nlocal\n=\nincoming\n> quote\nmore context\n> upstream\n";
    expect(splitMergeText(ambiguous, 1, { current: "local", incoming: "incoming\n> quote\nmore context" })).toEqual([]);
    const reviewed = { path: "note.md", mergedText: ambiguous, markerSize: 1,
      local: { exists: true, text: "local" }, incoming: { exists: true, text: "incoming\n> quote\nmore context" } };
    expect(hasConflictMarkers("merged\n> upstream", 1, reviewed)).toBe(true);
    expect(hasConflictMarkers("merged\n> quote\n> newly added quote\n=", 1, reviewed)).toBe(false);
  });

  it("carries the original line style through insertion and deleting all text", () => {
    expect(restoreEditorLineEndings("a\r\nb\nc", "a\nadded\nb\nc", "")).toBe("a\r\nadded\r\nb\nc");
    expect(restoreEditorLineEndings("", "new\nlines\n", "old\r\n")).toBe("new\r\nlines\r\n");
  });

  it.each([1, 3, 7, 12])("preserves shared Markdown examples when resolving actual conflicts with marker width %i", width => {
    const open = "<".repeat(width) + " HEAD", divider = "=".repeat(width), close = ">".repeat(width) + " origin/main";
    const block = (left: string, right: string) => [open, left, divider, right, close].join("\n");
    const example = ["# Resolving conflicts", "```text", block("sample left", "sample right"), "```"].join("\n");
    const document = (a: string, b: string) => [example, "## First choice", a, example, "## Second choice", b, "End"].join("\n");
    const local = document("local A", "local B"), incoming = document("other A", "other B");
    const a = block("local A", "other A"), b = block("local B", "other B");
    const mergedText = document(a, b);
    const reviewed = { path: "README.md", markerSize: width, mergedText, local: { exists: true, text: local }, incoming: { exists: true, text: incoming } };
    const parts = splitMergeText(mergedText, width, { current: local, incoming });
    expect(parts.filter(part => typeof part !== "string")).toHaveLength(2);
    expect(combineBlocks(parts, ["incoming", "local"], false)).toBe(document("other A", "local B"));
    expect(combineBlocks(parts, ["incoming", "local"], true)).toBe(document("local A", "other B"));
    expect(hasConflictMarkers(mergedText, width, reviewed)).toBe(true);
    expect(hasConflictMarkers(document("manually edited", b), width, reviewed)).toBe(true);
    expect(hasConflictMarkers(document("manually edited", close), width, reviewed)).toBe(true);
    expect(hasConflictMarkers(document("manually edited", "selected"), width, reviewed)).toBe(false);
  });

  it("presents only the real conflict in a Markdown guide and submits its documented example intact", async () => {
    const repo = { absolutePath: "C:/fixture", name: "fixture", upstream: "origin/main", errors: [] } as unknown as RepoStatus;
    const example = ["# Guide", "```text", "<<<<<<< HEAD", "example on this machine", "=======", "example upstream", ">>>>>>> origin/main", "```", ""].join("\r\n");
    const file = { path: "AGENTS.md", local: { exists: true, text: example + "Use local instructions" },
      incoming: { exists: true, text: example + "Use remote instructions" },
      mergedText: example + "<<<<<<< HEAD\r\nUse local instructions\r\n=======\r\nUse remote instructions\r\n>>>>>>> origin/main\r\n" };
    const finishSync = vi.fn().mockResolvedValue(repo);
    vi.stubGlobal("repoRadar", { getSyncConflictReview: vi.fn().mockResolvedValue({ token: "example", operation: "merge", files: [file] }), finishSync });
    try {
      render(<SyncConflictDialog repo={repo} onComplete={vi.fn()} onRepoUpdated={vi.fn()} onClose={vi.fn()} onMessage={vi.fn()} />);
      expect(await screen.findAllByRole("region", { name: /^Conflict \d+$/ })).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Keep incoming change" }));
      const finish = screen.getByRole("button", { name: "Finish sync and push" });
      expect(finish).toBeEnabled();
      fireEvent.click(finish);
      await waitFor(() => expect(finishSync).toHaveBeenCalledWith(repo.absolutePath, "example", [
        { path: file.path, choice: "edited", text: file.incoming.text }
      ], false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses context when the unresolved block is byte-for-byte identical to the documented example", () => {
    const sameBlock = "<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> origin/main";
    const doc = (example: string, real: string) => ["Example:", "```", example, "```", "Use this value:", real, "End"].join("\n");
    const local = doc(sameBlock, "old"), incoming = doc(sameBlock, "new");
    const mergedText = doc(sameBlock, sameBlock);
    const reviewed = { path: "guide.md", mergedText, local: { exists: true, text: local }, incoming: { exists: true, text: incoming } };
    const parts = splitMergeText(mergedText, 7, { current: local, incoming });
    expect(parts.filter(part => typeof part !== "string")).toHaveLength(1);
    expect(combineBlocks(parts, ["incoming"], false)).toBe(incoming);
    expect(hasConflictMarkers(incoming, 7, reviewed)).toBe(false);
    expect(hasConflictMarkers(mergedText, 7, reviewed)).toBe(true);
    expect(hasConflictMarkers(doc("removed example", sameBlock), 7, reviewed)).toBe(true);
  });

  it.each([3, 7])("checks leftover width-%i dividers and preserves source separators and Markdown headings", size => {
    const divider = "=".repeat(size);
    const sourceDoc = "/*\n" + divider + "\n*/\n";
    const file = { path: "code.js", markerSize: size, generatedMarkerLines: [divider],
      mergedText: sourceDoc + "resolved\n" + divider + "\n", local: { exists: true, text: sourceDoc + "old\n" },
      incoming: { exists: true, text: sourceDoc + "new\n" } };
    expect(hasConflictMarkers(file.mergedText, size, file)).toBe(true);
    expect(hasConflictMarkers(sourceDoc + "resolved\n", size, file)).toBe(false);
    expect(hasConflictMarkers("New heading\n" + divider + "\n", size, { ...file, path: "guides/README.md" })).toBe(false);
  });

  it("updates Finish when a pasted edit places a marker back in externally cleaned JSON", async () => {
    const repo = { absolutePath: "C:/fixture", name: "fixture", errors: [] } as unknown as RepoStatus;
    const file = { path: "config.json", markerSize: 3, fallbackMarkerLabels: ["HEAD", "upstream"], mergedText: '{"site":"clean"}',
      local: { exists: true, text: '{"site":"local"}' }, incoming: { exists: true, text: '{"site":"incoming"}' } };
    const finishSync = vi.fn().mockResolvedValue(repo);
    vi.stubGlobal("repoRadar", { getSyncConflictReview: vi.fn().mockResolvedValue({ token: "cleaned", operation: "merge", files: [file] }), finishSync });
    try {
      render(<SyncConflictDialog repo={repo} onComplete={vi.fn()} onRepoUpdated={vi.fn()} onClose={vi.fn()} onMessage={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit merged text" }));
      const finish = screen.getByRole("button", { name: "Finish sync and push" });
      const input = screen.getByRole("textbox", { name: "Merged file contents" });
      expect(finish).toBeEnabled();
      fireEvent.change(input, { target: { value: '{"site":"pasted"}\n===\n' } });
      expect(finish).toBeDisabled();
      fireEvent.change(input, { target: { value: '{"site":"combined"}' } });
      fireEvent.click(finish);
      await waitFor(() => expect(finishSync).toHaveBeenCalledWith(repo.absolutePath, "cleaned", [
        { path: file.path, choice: "edited", text: '{"site":"combined"}' }
      ], false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([7, 12])("preserves standalone examples while resolving the actual width-%i hunk", size => {
    const open = "<".repeat(size) + " HEAD";
    const close = ">".repeat(size) + " upstream";
    const divider = "=".repeat(size);
    for (const sample of [open, close, divider, "|".repeat(size) + " ancestor"]) {
      const example = ["# Git markers", "```", sample, "```", "Choose the value below", ""].join("\n");
      const local = example + "local\n", incoming = example + "remote\n";
      const mergedText = example + [open, "local", divider, "remote", close, ""].join("\n");
      const file = { path: "guide.md", mergedText, local: { exists: true, text: local }, incoming: { exists: true, text: incoming } };
      const parts = splitMergeText(mergedText, size, { current: local, incoming });
      expect(parts.filter(part => typeof part !== "string")).toHaveLength(1);
      expect(combineBlocks(parts, ["both"], false)).toBe(example + "local\nremote\n");
      expect(hasConflictMarkers(example + "both\n", size, file)).toBe(false);
      expect(hasConflictMarkers(mergedText, size, file)).toBe(true);
      expect(hasConflictMarkers("Choose the value below\n" + open + "\n", size, file)).toBe(true);
    }
  });

  it.each([1, 3, 7])("retains one-sided documentation and still reviews a real conflict with width %i", size => {
    const opening = "<".repeat(size) + " HEAD", divider = "=".repeat(size), closing = ">".repeat(size) + " upstream";
    const block = (a: string, b: string) => [opening, a, divider, b, closing].join("\n");
    const added = ["# Example", "```text", block("sample left", "sample right"), "```", ""].join("\n");
    const context = "unchanged context\n";
    const real = block("local decision", "remote decision");
    for (const addedLocally of [true, false]) {
      const local = (addedLocally ? added : "") + context + "local decision\n";
      const incoming = (addedLocally ? "" : added) + context + "remote decision\n";
      const file = { path: "AGENTS.md", mergedText: added + context + real + "\n", local: { exists: true, text: local }, incoming: { exists: true, text: incoming } };
      const parts = splitMergeText(file.mergedText, size, { current: local, incoming });
      expect(parts.filter(part => typeof part !== "string")).toHaveLength(1);
      expect(combineBlocks(parts, ["local"], false)).toBe(added + context + "local decision\n");
      expect(hasConflictMarkers(file.mergedText, size, file)).toBe(true);
      expect(hasConflictMarkers(added + context + closing, size, file)).toBe(true);
      expect(hasConflictMarkers(added + context + "resolved\n", size, file)).toBe(false);
    }
  });

  it("does not excuse a real block that duplicates an example present in just one source", () => {
    const block = "<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> upstream";
    const example = ["# Example", "```text", block, "```", ""].join("\n");
    const local = example + "Instructions\nold\n", incoming = "Instructions\nnew\n";
    const file = { path: "guide.md", mergedText: example + "Instructions\n" + block + "\n", local: { exists: true, text: local }, incoming: { exists: true, text: incoming } };
    const parts = splitMergeText(file.mergedText, 7, { current: local, incoming });
    expect(parts.filter(part => typeof part !== "string")).toHaveLength(1);
    expect(combineBlocks(parts, ["incoming"], false)).toBe(example + incoming);
    expect(hasConflictMarkers("Instructions\n" + block + "\n", 7, file)).toBe(true);
    expect(hasConflictMarkers(example + incoming, 7, file)).toBe(false);
  });

  it("uses Git's actual markers when the two machines also change .gitattributes", () => {
    const file = { path: "instructions.md", markerSize: 9, mergedText: "<<< HEAD\nlocal\n===\nremote\n>>> upstream\n",
      local: { exists: true, text: "local\n" }, incoming: { exists: true, text: "remote\n" } };
    const parts = splitMergeText(file.mergedText, 9, { current: file.local.text, incoming: file.incoming.text });
    expect(combineBlocks(parts, ["both"], false)).toBe("local\nremote\n");
    expect(hasConflictMarkers(file.mergedText, 9, file)).toBe(true);
    expect(hasConflictMarkers("resolved\n>>> upstream\n", 9, file)).toBe(true);
    expect(hasConflictMarkers("resolved\n", 9, file)).toBe(false);
  });

  it("defers when a one-sided example and the generated block have identical text and neighbors", () => {
    const same = "<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> upstream";
    const section = (value: string) => ["Before", value, "After", ""].join("\n");
    const file = { path: "guide.md", mergedText: section(same) + section(same),
      local: { exists: true, text: section(same) + section("old") }, incoming: { exists: true, text: section("new") } };
    expect(splitMergeText(file.mergedText, 7, { current: file.local.text, incoming: file.incoming.text })).toEqual([]);
    expect(hasConflictMarkers(section("removed example") + section(same), 7, file)).toBe(true);
    expect(hasConflictMarkers(section("resolved"), 7, file)).toBe(false);
  });
});
