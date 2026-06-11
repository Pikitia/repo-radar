import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set(["node_modules"]);

export async function discoverRepositories(root: string, includeNestedRepositories: boolean): Promise<string[]> {
  const repos: string[] = [];
  const normalizedRoot = path.resolve(root);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGit = entries.some((entry) => entry.name === ".git");
    if (hasGit) {
      repos.push(dir);
      if (!includeNestedRepositories) {
        return;
      }
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !IGNORED_DIRS.has(entry.name))
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => walk(path.join(dir, entry.name)))
    );
  }

  await walk(normalizedRoot);
  return repos.sort((a, b) => a.localeCompare(b));
}
