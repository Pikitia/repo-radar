import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectFile } from "../../src/types/repo.js";

const EXACT_FILES = ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"];
const GLOB_DIRS = [".cursor/rules", ".agents", ".codex"];

async function exists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listFilesInDir(dir: string, prefix: string): Promise<ProjectFile[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.posix.join(prefix.replaceAll("\\", "/"), entry.name))
      .sort()
      .map(toProjectFile);
  } catch {
    return [];
  }
}

export function toProjectFile(relativePath: string): ProjectFile {
  return {
    path: relativePath.replaceAll("\\", "/"),
    displayName: relativePath.replaceAll("\\", "/"),
    kind: relativePath.toLowerCase().endsWith(".md") ? "markdown" : "text"
  };
}

export async function getProjectFiles(repoPath: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  for (const file of EXACT_FILES) {
    if (await exists(path.join(repoPath, file))) {
      files.push(toProjectFile(file));
    }
  }

  for (const dir of GLOB_DIRS) {
    files.push(...(await listFilesInDir(path.join(repoPath, dir), dir)));
  }

  return files;
}

export async function readProjectFile(repoPath: string, relativePath: string): Promise<string> {
  const safePath = path.normalize(relativePath);
  if (path.isAbsolute(safePath) || safePath.startsWith("..")) {
    throw new Error("Invalid project file path.");
  }
  return fs.readFile(path.join(repoPath, safePath), "utf8");
}
