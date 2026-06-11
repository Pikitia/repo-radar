import { describe, expect, it } from "vitest";
import { parseSideBySideDiff } from "../../src/utils/diffParser";

describe("parseSideBySideDiff", () => {
  it("pairs changed lines and keeps added and removed lines side-by-side", () => {
    const rows = parseSideBySideDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,5 @@",
        " const name = \"repo\";",
        "-const state = \"old\";",
        "+const state = \"new\";",
        "+const extra = true;",
        "-console.log(name);",
        " export { name };"
      ].join("\n"),
      "working"
    );

    expect(rows.map((row) => row.kind)).toEqual(["hunk", "context", "changed", "added", "removed", "context"]);
    expect(rows[2]).toMatchObject({ leftNumber: 2, rightNumber: 2, leftText: "const state = \"old\";", rightText: "const state = \"new\";" });
    expect(rows[3]).toMatchObject({ leftNumber: null, rightNumber: 3, rightText: "const extra = true;" });
    expect(rows[4]).toMatchObject({ leftNumber: 3, rightNumber: null, leftText: "console.log(name);" });
  });

  it("renders untracked file content as additions", () => {
    const rows = parseSideBySideDiff("first\nsecond", "untracked");

    expect(rows).toEqual([
      { id: "0-added-x-1", kind: "added", leftNumber: null, rightNumber: 1, leftText: "", rightText: "first" },
      { id: "1-added-x-2", kind: "added", leftNumber: null, rightNumber: 2, leftText: "", rightText: "second" }
    ]);
  });
});

