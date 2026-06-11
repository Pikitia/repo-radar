import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiffMode, DiffResult } from "../../src/types/repo.js";
import { tryGit } from "./exec.js";

function isBinaryText(text: string): boolean {
  return text.includes("\u0000") || /Binary files .* differ/.test(text);
}

export async function getDiff(repoPath: string, file: string, mode: DiffMode): Promise<DiffResult> {
  if (mode === "untracked") {
    try {
      const content = await fs.readFile(path.join(repoPath, file));
      const isBinary = content.includes(0);
      return {
        file,
        mode,
        isBinary,
        text: isBinary ? "Binary file." : content.toString("utf8")
      };
    } catch (error) {
      return { file, mode, isBinary: false, text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  const args = mode === "staged" ? ["diff", "--staged", "--", file] : ["diff", "--", file];
  const result = await tryGit(repoPath, args);
  return {
    file,
    mode,
    isBinary: isBinaryText(result.stdout),
    text: result.stdout || result.stderr,
    error: result.code === 0 ? undefined : result.stderr
  };
}

export async function getCommitDiff(repoPath: string, hash: string): Promise<DiffResult> {
  const result = await tryGit(repoPath, ["show", "--no-ext-diff", "--format=", "--patch", "--find-renames", hash]);
  return {
    file: hash,
    mode: "commit",
    isBinary: isBinaryText(result.stdout),
    text: result.stdout.trimStart() || result.stderr,
    error: result.code === 0 ? undefined : result.stderr
  };
}
