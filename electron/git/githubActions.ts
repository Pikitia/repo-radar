import type { GitHubActionsStatus } from "../../src/types/repo.js";
import { tryGit } from "./exec.js";
import { getSettings } from "../settings.js";

type GitHubRepo = {
  owner: string;
  repo: string;
};

type GitHubRun = {
  id: number;
  name?: string;
  display_title?: string;
  run_number: number;
  html_url: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  created_at: string;
  updated_at: string;
};

type GitHubJob = {
  name: string;
  html_url: string;
  conclusion: string | null;
  steps?: Array<{
    name: string;
    conclusion: string | null;
    number: number;
  }>;
};

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly fix: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export function isFailedActionsConclusion(conclusion: string | null | undefined): boolean {
  return conclusion ? FAILED_CONCLUSIONS.has(conclusion) : false;
}

export function parseGitHubRemote(remote: string): GitHubRepo | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, ...repoParts] = url.pathname.replace(/^\/+/, "").split("/");
    const repo = repoParts.join("/");
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

function getGitHubToken(): string | undefined {
  const settings = getSettings();
  if (settings.github.tokenSource === "settings") return settings.github.token?.trim() || undefined;
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function privateRepoFix(status: number, tokenPresent: boolean): string {
  if (status === 401) {
    return "The GitHub token is missing, invalid, or expired. In Settings, use GitHub token source 'Environment' with GITHUB_TOKEN/GH_TOKEN, or 'Settings' and paste a token with repository access and Actions read permission.";
  }
  if (status === 403) {
    return tokenPresent
      ? "GitHub denied the Actions request. Check that the token has access to this private repository and Actions read permission, and that API rate limits have not been exceeded."
      : "GitHub denied the unauthenticated request, often due to private repository access or rate limits. Configure a GitHub token in Settings or set GITHUB_TOKEN/GH_TOKEN before launching Repo Radar.";
  }
  if (status === 404) {
    return tokenPresent
      ? "GitHub could not find the repository or Actions endpoint. Check that the token can access this private repository and that Actions is enabled."
      : "GitHub returned 404. For private repositories this usually means Repo Radar is unauthenticated. Configure a GitHub token in Settings or set GITHUB_TOKEN/GH_TOKEN before launching Repo Radar.";
  }
  return "Check network access to api.github.com and verify the configured GitHub token can read repository Actions.";
}

function describeGitHubError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    return `${error.message} ${error.fix}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function githubFetch<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const token = getGitHubToken();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Repo-Radar",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
    if (!response.ok) {
      let message = `GitHub returned ${response.status}.`;
      try {
        const body = await response.json() as { message?: string };
        if (body.message) message = `GitHub returned ${response.status}: ${body.message}.`;
      } catch {
        // Keep the status-only message when the response is not JSON.
      }
      throw new GitHubApiError(message, response.status, privateRepoFix(response.status, Boolean(token)));
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function getOrigin(repoPath: string): Promise<string | null> {
  const result = await tryGit(repoPath, ["remote", "get-url", "origin"]);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getGitHubActionsStatus(repoPath: string, branch: string | null): Promise<GitHubActionsStatus | null> {
  const remote = await getOrigin(repoPath);
  if (!remote) return null;
  const repo = parseGitHubRemote(remote);
  if (!repo) return null;

  const query = new URLSearchParams({ per_page: "1" });
  if (branch) query.set("branch", branch);
  const repository = `${repo.owner}/${repo.repo}`;

  try {
    const runs = await githubFetch<{ workflow_runs: GitHubRun[] }>(`https://api.github.com/repos/${repository}/actions/runs?${query}`);
    const run = runs.workflow_runs[0];
    if (!run) return null;

    let failedJobs: GitHubActionsStatus["failedJobs"] = [];
    if (isFailedActionsConclusion(run.conclusion)) {
      const jobs = await githubFetch<{ jobs: GitHubJob[] }>(`https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`);
      failedJobs = jobs.jobs
        .filter((job) => isFailedActionsConclusion(job.conclusion))
        .map((job) => ({
          name: job.name,
          conclusion: job.conclusion,
          htmlUrl: job.html_url,
          steps: (job.steps ?? [])
            .filter((step) => isFailedActionsConclusion(step.conclusion))
            .map((step) => ({ name: step.name, conclusion: step.conclusion, number: step.number }))
        }));
    }

    return {
      repository,
      branch: run.head_branch,
      status: run.status,
      conclusion: run.conclusion,
      workflowName: run.name ?? "GitHub Actions",
      runName: run.display_title ?? run.name ?? "Workflow run",
      runNumber: run.run_number,
      htmlUrl: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      failedJobs
    };
  } catch (error) {
    return {
      repository,
      branch,
      status: null,
      conclusion: null,
      workflowName: "GitHub Actions",
      runName: "Unavailable",
      runNumber: 0,
      htmlUrl: `https://github.com/${repository}/actions`,
      createdAt: "",
      updatedAt: "",
      failedJobs: [],
      error: describeGitHubError(error)
    };
  }
}
