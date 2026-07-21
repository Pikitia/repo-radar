import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set(["node_modules"]);

export async function discoverRepositories(root: string, includeNestedRepositories: boolean): Promise<string[]> {
  const repos: string[] = [];
  const normalizedRoot = path.resolve(root);

  let rootIsRepository = false;

  async function walk(dir: string, depth = 0): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGit = entries.some((entry) => entry.name === ".git");
    if (depth === 0) {
      rootIsRepository = hasGit;
    }

    if (hasGit) {
      repos.push(dir);
      // The configured root can be a repository used for shared agent metadata
      // while its immediate subfolders are the repositories the user works in.
      // Inspect those immediate children before applying the normal nested-repo
      // boundary.
      if (!includeNestedRepositories && depth > 0) {
        return;
      }
    }

    if (!includeNestedRepositories && rootIsRepository && depth >= 1) {
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !IGNORED_DIRS.has(entry.name))
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => walk(path.join(dir, entry.name), depth + 1))
    );
  }

  await walk(normalizedRoot);
  return repos.sort((a, b) => a.localeCompare(b));
}
