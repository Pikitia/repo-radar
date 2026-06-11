import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectFiles } from "../../electron/git/projectFiles";

describe("project file discovery", () => {
  it("finds known instruction files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "repo-radar-project-"));
    await writeFile(path.join(dir, "README.md"), "# Test");
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(dir, ".cursor", "rules", "rule.md"), "Rule");

    const files = await getProjectFiles(dir);
    expect(files.map((file) => file.path)).toEqual(["README.md", ".cursor/rules/rule.md"]);
  });
});
