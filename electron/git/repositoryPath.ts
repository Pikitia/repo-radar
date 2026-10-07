import path from "node:path";
import { realpath } from "node:fs/promises";
import { runGit } from "./exec.js";

export async function validateRepositoryPath(repoPath: string, rootPath: string): Promise<string> {
  if (typeof repoPath !== "string" || !path.isAbsolute(repoPath)) throw new Error("Choose a repository inside the selected root.");
  const [root, repository] = await Promise.all([realpath(rootPath), realpath(repoPath)]);
  const relative = path.relative(root, repository);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Repository is outside the selected root.");
  }
  const topLevel = await runGit(repository, ["rev-parse", "--show-toplevel"]);
  const actualRoot = await realpath(topLevel.stdout.trim());
  const same = process.platform === "win32" ? actualRoot.toLowerCase() === repository.toLowerCase() : actualRoot === repository;
  if (!same) throw new Error("Choose the repository root, not a subfolder.");
  return repository;
}
