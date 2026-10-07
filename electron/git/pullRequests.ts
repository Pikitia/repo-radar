import type { DevelopPullRequestPreview, DevelopPullRequestResult } from "../../src/types/api.js";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryPath } from "./repositoryPath.js";
import { runGit } from "./exec.js";
import { describeGitHubError, githubFetch, hasGitHubToken, parseGitHubRemote } from "./githubActions.js";

type PullRequest = { number: number; node_id: string; html_url: string };
type MergeInfo = {
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  baseRefName: string;
  headRepository: { nameWithOwner: string } | null;
  merged: boolean;
  isDraft: boolean;
  mergeStateStatus: string;
  autoMergeRequest: { enabledAt: string } | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
  repository: { autoMergeAllowed: boolean; mergeCommitAllowed: boolean };
};

const running = new Set<string>();

async function preview(repositoryPath: string): Promise<DevelopPullRequestPreview> {
  const origin = await runGit(repositoryPath, ["remote", "get-url", "origin"]);
  const remote = parseGitHubRemote(origin.stdout.trim());
  if (!remote || !/^[\w.-]+$/.test(remote.owner) || !/^[\w.-]+$/.test(remote.repo)) {
    throw new Error("Develop-to-main pull requests require a github.com origin remote.");
  }
  // Refresh both remote branches even in repositories cloned with a single-branch refspec.
  await runGit(repositoryPath, ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], 60000);
  let developSha: string;
  let mainSha: string;
  try {
    const refs = await Promise.all([
      runGit(repositoryPath, ["rev-parse", "--verify", "refs/remotes/origin/develop^{commit}"]),
      runGit(repositoryPath, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"])
    ]);
    [developSha, mainSha] = refs.map((ref) => ref.stdout.trim());
  } catch {
    throw new Error("Both origin/develop and origin/main must exist.");
  }
  const counts = await runGit(repositoryPath, ["rev-list", "--count", `${mainSha}..${developSha}`]);
  const ahead = Number(counts.stdout.trim());
  if (!Number.isSafeInteger(ahead) || ahead <= 0) throw new Error("origin/develop has no commits waiting for origin/main.");
  return { repository: `${remote.owner}/${remote.repo}`, developSha, mainSha, ahead };
}

export async function getDevelopPullRequestPreview(repoPath: string, rootPath: string): Promise<DevelopPullRequestPreview> {
  return preview(await validateRepositoryPath(repoPath, rootPath));
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await githubFetch<{ data?: T; errors?: Array<{ message: string }> }>("https://api.github.com/graphql", {
    purpose: "pull-request", body: { query, variables }
  });
  if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join(" "));
  if (!response.data) throw new Error("GitHub returned no pull request data.");
  return response.data;
}

export async function promoteDevelop(repoPath: string, rootPath: string, expected: DevelopPullRequestPreview): Promise<DevelopPullRequestResult> {
  const validated = await validateRepositoryPath(repoPath, rootPath);
  const key = process.platform === "win32" ? validated.toLowerCase() : validated;
  if (running.has(key)) throw new Error("A develop-to-main operation is already running for this repository.");
  running.add(key);
  try {
    if (!expected || typeof expected.repository !== "string" || !/^[a-f0-9]{40,64}$/.test(expected.developSha) || !/^[a-f0-9]{40,64}$/.test(expected.mainSha)) {
      throw new Error("Review and confirm the develop-to-main operation again.");
    }
    if (!hasGitHubToken()) throw new Error("Configure a GitHub token in Settings with Pull requests and Contents read/write permissions before creating a pull request.");
    const current = await preview(validated);
    if (current.repository !== expected.repository || current.developSha !== expected.developSha || current.mainSha !== expected.mainSha) {
      throw new Error("The origin repository or branches changed since confirmation. Review and confirm again.");
    }
    const [owner, repo] = current.repository.split("/");
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
    const query = new URLSearchParams({ state: "open", base: "main", head: `${owner}:develop`, per_page: "100" });
    let pr: PullRequest;
    try {
      const existing = await githubFetch<PullRequest[]>(`${api}?${query}`, { purpose: "pull-request" });
      pr = existing[0] ?? await githubFetch<PullRequest>(api, {
        purpose: "pull-request",
        body: { title: "Merge develop into main", head: "develop", base: "main", body: "Promote origin/develop into origin/main. Created with Repo Radar; merge after GitHub checks and required reviews pass." }
      });
    } catch (error) {
      throw new Error(`Could not create or find the develop-to-main pull request. ${describeGitHubError(error)}`);
    }
    const result = (outcome: DevelopPullRequestResult["outcome"], message: string): DevelopPullRequestResult => ({
      number: pr.number, url: pr.html_url, outcome, message
    });
    // Do not trust provider URLs or identifiers as executable instructions.
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !pr.node_id || pr.html_url !== `https://github.com/${current.repository}/pull/${pr.number}`) {
      throw new Error("GitHub returned an invalid pull request response. Check the repository's pull requests before retrying.");
    }
    try {
      const readState = () => graphql<{ node: MergeInfo | null }>(`query($id: ID!) {
        node(id: $id) { ... on PullRequest {
          headRefOid baseRefOid headRefName baseRefName headRepository { nameWithOwner }
          merged isDraft mergeStateStatus autoMergeRequest { enabledAt }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          repository { autoMergeAllowed mergeCommitAllowed }
        } }
      }`, { id: pr.node_id });
      let state = (await readState()).node;
      // GitHub briefly reports UNKNOWN while computing a newly created PR's merge eligibility.
      for (let attempt = 0; state?.mergeStateStatus === "UNKNOWN" && attempt < 3; attempt++) {
        await delay(1000);
        state = (await readState()).node;
      }
      if (!state || state.headRefName !== "develop" || state.baseRefName !== "main" || state.headRepository?.nameWithOwner !== current.repository) {
        return result("blocked", "Pull request found, but its branches do not match this origin repository. Review it in GitHub.");
      }
      if (state.merged) return result("merged", `Pull request #${pr.number} is already merged.`);
      if (state.headRefOid !== current.developSha || state.baseRefOid !== current.mainSha) {
        return result("blocked", "Pull request available, but origin branches changed. Review and confirm again.");
      }
      if (state.isDraft) return result("blocked", "Pull request is a draft. Mark it ready for review in GitHub before enabling a merge.");
      if (!state.repository.mergeCommitAllowed) return result("blocked", "This repository does not allow merge commits. Enable them in GitHub to preserve develop/main history.");
      if (state.autoMergeRequest) return result("auto-merge", `Pull request #${pr.number} already has auto-merge enabled. GitHub will merge after required checks and reviews pass.`);
      const checks = state.commits.nodes[0]?.commit.statusCheckRollup?.state;
      if (state.mergeStateStatus === "CLEAN" && checks === "SUCCESS") {
        const merged = await graphql<{ mergePullRequest: { pullRequest: { merged: boolean } } }>(`mutation($input: MergePullRequestInput!) {
          mergePullRequest(input: $input) { pullRequest { merged } }
        }`, { input: { pullRequestId: pr.node_id, mergeMethod: "MERGE", expectedHeadOid: current.developSha } });
        if (!merged.mergePullRequest.pullRequest.merged) throw new Error("GitHub did not confirm the merge.");
        return result("merged", `Pull request #${pr.number} merged into main after successful GitHub checks.`);
      }
      if (!state.repository.autoMergeAllowed) {
        return result("blocked", "Pull request available. Enable Allow auto-merge in GitHub repository Settings and require the checks on main, then retry. No merge was performed.");
      }
      const enabled = await graphql<{ enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: string } | null; merged: boolean } } }>(`mutation($input: EnablePullRequestAutoMergeInput!) {
        enablePullRequestAutoMerge(input: $input) { pullRequest { autoMergeRequest { enabledAt } merged } }
      }`, { input: { pullRequestId: pr.node_id, mergeMethod: "MERGE", expectedHeadOid: current.developSha } });
      if (enabled.enablePullRequestAutoMerge.pullRequest.merged) return result("merged", `Pull request #${pr.number} merged by GitHub.`);
      if (!enabled.enablePullRequestAutoMerge.pullRequest.autoMergeRequest) throw new Error("GitHub did not confirm auto-merge.");
      return result("auto-merge", `Auto-merge enabled for pull request #${pr.number}. GitHub will merge into main after required checks and reviews pass.`);
    } catch (error) {
      return result("blocked", `Pull request #${pr.number} is available, but merging could not be confirmed. ${describeGitHubError(error)} Check GitHub before retrying; main must require the checks you want to wait for.`);
    }
  } finally {
    running.delete(key);
  }
}
