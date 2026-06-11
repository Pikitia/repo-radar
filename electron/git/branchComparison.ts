import type { BranchComparison, BranchComparisonCommit } from "../../src/types/repo.js";
import { tryGit } from "./exec.js";

const DEVELOP_REF = "origin/develop";
const MAIN_REF = "origin/main";

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await tryGit(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
  return result.code === 0;
}

async function getPackageVersionAtRef(repoPath: string, ref: string): Promise<string | null> {
  const result = await tryGit(repoPath, ["show", `${ref}:package.json`]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function getCommitFiles(repoPath: string, hash: string): Promise<string[]> {
  const result = await tryGit(repoPath, ["show", "--name-only", "--format=", hash]);
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function getCommits(repoPath: string, range: string): Promise<BranchComparisonCommit[]> {
  const result = await tryGit(repoPath, ["log", "--format=%H%x1f%s%x1f%b%x1f%an%x1f%cI%x1e", range]);
  if (result.code !== 0 || !result.stdout.trim()) return [];

  const commits: BranchComparisonCommit[] = [];
  for (const record of result.stdout.split("\x1e")) {
    const [hash, subject, body, author, date] = record.replace(/^\r?\n/, "").split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      subject: subject ?? "",
      body: body ?? "",
      author: author ?? "",
      date: date?.trim() ?? "",
      files: await getCommitFiles(repoPath, hash)
    });
  }
  return commits;
}

export async function getBranchComparison(repoPath: string): Promise<BranchComparison | null> {
  const [hasDevelop, hasMain] = await Promise.all([
    refExists(repoPath, DEVELOP_REF),
    refExists(repoPath, MAIN_REF)
  ]);
  if (!hasDevelop || !hasMain) return null;

  const counts = await tryGit(repoPath, ["rev-list", "--left-right", "--count", `${DEVELOP_REF}...${MAIN_REF}`]);
  if (counts.code !== 0) return null;
  const [developAheadText, developBehindText] = counts.stdout.trim().split(/\s+/);
  const developAheadMain = Number(developAheadText) || 0;
  const developBehindMain = Number(developBehindText) || 0;

  const [developVersion, mainVersion, commitsInDevelopNotMain] = await Promise.all([
    getPackageVersionAtRef(repoPath, DEVELOP_REF),
    getPackageVersionAtRef(repoPath, MAIN_REF),
    getCommits(repoPath, `${MAIN_REF}..${DEVELOP_REF}`)
  ]);

  return {
    developRef: DEVELOP_REF,
    mainRef: MAIN_REF,
    developVersion,
    mainVersion,
    developBehindMain,
    developAheadMain,
    commitsInDevelopNotMain
  };
}
