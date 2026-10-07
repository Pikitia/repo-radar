import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CiWatch, CiWatchInput, CiWorkflow, CiRun, CiJob } from "../../src/types/ci.js";
import { getSettings, updateSettings } from "../settings.js";
import { runGit } from "./exec.js";
import { describeGitHubError, githubFetch, parseGitHubRemote } from "./githubActions.js";

import { validateRepositoryPath as validateCiRepository } from "./repositoryPath.js";
export { validateCiRepository };

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function githubRepository(repoPath: string, rootPath: string): Promise<{ path: string; api: string }> {
  const validated = await validateCiRepository(repoPath, rootPath);
  const origin = await runGit(validated, ["remote", "get-url", "origin"]);
  const remote = parseGitHubRemote(origin.stdout.trim());
  if (!remote || !/^[\w.-]+$/.test(remote.owner) || !/^[\w.-]+$/.test(remote.repo)) {
    throw new Error("CI Watch requires a github.com origin remote.");
  }
  // Match discovery's path identity while keeping Git reads on the validated real path.
  return { path: path.resolve(repoPath), api: `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/actions` };
}

function validateBranch(branch: string): string {
  if (typeof branch !== "string" || !branch.trim() || branch.length > 255 || Array.from(branch).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
    throw new Error("Enter a branch name, such as main or production.");
  }
  return branch.trim();
}

function validateId(id: number, label: string) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid ${label}.`);
}

async function request<T>(url: string): Promise<T> {
  try {
    return await githubFetch<T>(url);
  } catch (error) {
    throw new Error(describeGitHubError(error));
  }
}

export async function addCiWatch(input: CiWatchInput, rootPath: string): Promise<CiWatch[]> {
  if (!input || typeof input !== "object") throw new Error("Invalid CI watch.");
  const branch = validateBranch(input.branch);
  if (input.workflowId !== undefined) validateId(input.workflowId, "workflow ID");
  const repository = await githubRepository(input.repoPath, rootPath);
  const ciWatches = getSettings().ciWatches;
  if (ciWatches.some((watch) => samePath(watch.repoPath, repository.path) && watch.branch === branch && watch.workflowId === input.workflowId)) {
    return ciWatches;
  }
  const watch: CiWatch = {
    id: randomUUID(), repoPath: repository.path, branch,
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId, workflowName: String(input.workflowName ?? "Workflow").slice(0, 200) } : {})
  };
  return updateSettings({ ciWatches: [...ciWatches, watch] }).ciWatches;
}

export function removeCiWatch(id: string): CiWatch[] {
  if (typeof id !== "string") throw new Error("Invalid watch ID.");
  return updateSettings({ ciWatches: getSettings().ciWatches.filter((watch) => watch.id !== id) }).ciWatches;
}

export async function getCiWorkflows(repoPath: string, rootPath: string): Promise<CiWorkflow[]> {
  const { api } = await githubRepository(repoPath, rootPath);
  const workflows: CiWorkflow[] = [];
  for (let page = 1; ; page++) {
    const result = await request<{ workflows: CiWorkflow[] }>(`${api}/workflows?per_page=100&page=${page}`);
    workflows.push(...result.workflows.map(({ id, name, path, state }) => ({ id, name, path, state })));
    if (result.workflows.length < 100) return workflows;
  }
}

type GitHubWatchRun = {
  id: number; run_attempt: number; name: string | null; display_title: string; run_number: number;
  head_branch: string | null; head_sha: string; status: string | null; conclusion: string | null;
  created_at: string; run_started_at: string | null; updated_at: string; html_url: string;
};

export async function getCiRun(repoPath: string, rootPath: string, branch: string, workflowId?: number): Promise<CiRun | null> {
  const validatedBranch = validateBranch(branch);
  if (workflowId !== undefined) validateId(workflowId, "workflow ID");
  const { api } = await githubRepository(repoPath, rootPath);
  const query = new URLSearchParams({ branch: validatedBranch, per_page: "1" });
  const endpoint = workflowId === undefined ? `${api}/runs` : `${api}/workflows/${workflowId}/runs`;
  const result = await request<{ workflow_runs: GitHubWatchRun[] }>(`${endpoint}?${query}`);
  const run = result.workflow_runs[0];
  if (!run) return null;
  return {
    id: run.id, attempt: run.run_attempt ?? 1, workflowName: run.name ?? "GitHub Actions", title: run.display_title,
    number: run.run_number, branch: run.head_branch, commit: run.head_sha, status: run.status, conclusion: run.conclusion,
    createdAt: run.created_at, startedAt: run.run_started_at, updatedAt: run.updated_at, htmlUrl: run.html_url
  };
}

type GitHubWatchJob = {
  id: number; name: string; status: string | null; conclusion: string | null;
  started_at: string | null; completed_at: string | null; html_url: string;
  steps?: Array<{ number: number; name: string; status: string | null; conclusion: string | null }>;
};

export async function getCiJobs(repoPath: string, rootPath: string, runId: number, attempt: number): Promise<CiJob[]> {
  validateId(runId, "run ID");
  validateId(attempt, "run attempt");
  const { api } = await githubRepository(repoPath, rootPath);
  const jobs: CiJob[] = [];
  for (let page = 1; ; page++) {
    const result = await request<{ jobs: GitHubWatchJob[] }>(`${api}/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...result.jobs.map((job) => ({
      id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
      startedAt: job.started_at, completedAt: job.completed_at, htmlUrl: job.html_url,
      steps: (job.steps ?? []).map(({ number, name, status, conclusion }) => ({ number, name, status, conclusion }))
    })));
    if (result.jobs.length < 100) return jobs;
  }
}
