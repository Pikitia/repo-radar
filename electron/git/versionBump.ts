import { promises as fs } from "node:fs";
import path from "node:path";

export type PackageVersionInfo = {
  path: string;
  current: string;
  next: string;
};

function incrementPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  if (!match) return version;
  const [, major, minor, patch, suffix] = match;
  return `${major}.${minor}.${Number(patch) + 1}${suffix}`;
}

async function readPackage(repoPath: string): Promise<{ text: string; parsed: { version?: unknown } } | null> {
  try {
    const text = await fs.readFile(path.join(repoPath, "package.json"), "utf8");
    return { text, parsed: JSON.parse(text) as { version?: unknown } };
  } catch {
    return null;
  }
}

export async function getPackageVersionInfo(repoPath: string): Promise<PackageVersionInfo | null> {
  const pkg = await readPackage(repoPath);
  if (!pkg || typeof pkg.parsed.version !== "string") return null;
  const next = incrementPatch(pkg.parsed.version);
  if (next === pkg.parsed.version) return null;
  return { path: "package.json", current: pkg.parsed.version, next };
}

export async function bumpPackageVersionFile(repoPath: string): Promise<PackageVersionInfo | null> {
  const pkg = await readPackage(repoPath);
  if (!pkg || typeof pkg.parsed.version !== "string") return null;
  const next = incrementPatch(pkg.parsed.version);
  if (next === pkg.parsed.version) return null;

  const nextText = pkg.text.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${next}$3`);
  await fs.writeFile(path.join(repoPath, "package.json"), nextText, "utf8");
  return { path: "package.json", current: pkg.parsed.version, next };
}

