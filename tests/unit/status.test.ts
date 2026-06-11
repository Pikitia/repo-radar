import { describe, expect, it } from "vitest";
import { parsePorcelainV2 } from "../../electron/git/status";

describe("parsePorcelainV2", () => {
  it("parses branch, upstream, ahead/behind, and file states", () => {
    const parsed = parsePorcelainV2([
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 a b file-a.txt",
      "1 .M N... 100644 100644 100644 a b file-b.txt",
      "? new.txt"
    ].join("\n"));

    expect(parsed.branch).toBe("main");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "file-a.txt", staged: true }),
      expect.objectContaining({ path: "file-b.txt", unstaged: true }),
      expect.objectContaining({ path: "new.txt", untracked: true })
    ]));
  });

  it("detects detached head and conflicts", () => {
    const parsed = parsePorcelainV2([
      "# branch.head (detached)",
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt"
    ].join("\n"));

    expect(parsed.isDetachedHead).toBe(true);
    expect(parsed.conflicts).toContain("conflict.txt");
  });
});
