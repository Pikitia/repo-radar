import { describe, expect, it } from "vitest";
import type { RepoStatus } from "../../src/types/repo";
import { actionAvailability, repoMatchesFilter, sidebarIndicators, visibleTabs } from "../../src/state/repoLogic";

function repo(overrides: Partial<RepoStatus>): RepoStatus {
  return {
    id: "id",
    name: "repo",
    absolutePath: "C:/repo",
    relativePath: "repo",
    parentGroup: "/",
    branch: "main",
    upstream: "origin/main",
    isDetachedHead: false,
    hasUnstagedChanges: false,
    hasStagedChanges: false,
    hasUntrackedFiles: false,
    ahead: 0,
    behind: 0,
    conflicts: [],
    files: [],
    aheadCommits: [],
    projectFiles: [],
    warnings: [],
    errors: [],
    ...overrides
  };
}

describe("repo display logic", () => {
  it("maps sidebar indicators and filters", () => {
    const changed = repo({ hasUnstagedChanges: true, ahead: 1, files: [{ path: "a", kind: "modified", staged: false, unstaged: true, untracked: false, conflicted: false }] });
    expect(sidebarIndicators(changed)).toContain("Changed");
    expect(sidebarIndicators(changed)).toContain("+1");
    expect(repoMatchesFilter(changed, "changed")).toBe(true);
    expect(repoMatchesFilter(changed, "clean")).toBe(false);
  });

  it("enables toolbar actions based on repository state", () => {
    expect(actionAvailability(repo({ behind: 1 })).pull).toBe(true);
    expect(actionAvailability(repo({ ahead: 1 })).push).toBe(true);
    expect(actionAvailability(repo({ ahead: 1, behind: 1 })).sync).toBe(true);
    expect(actionAvailability(repo({ upstream: null, ahead: 1 })).push).toBe(false);
    expect(actionAvailability(repo({ errors: [{ code: "merge", message: "Merge in progress" }], hasStagedChanges: true })).commit).toBe(false);
  });

  it("shows only tabs with content", () => {
    const tabs = visibleTabs(repo({
      files: [
        { path: "a", kind: "modified", staged: true, unstaged: false, untracked: false, conflicted: false },
        { path: "b", kind: "untracked", staged: false, unstaged: false, untracked: true, conflicted: false }
      ],
      aheadCommits: [{ hash: "abc", subject: "test", author: "a", date: new Date().toISOString(), files: ["a"] }],
      projectFiles: [{ path: "README.md", displayName: "README.md", kind: "markdown" }]
    }));
    expect(tabs).toEqual(["staged", "untracked", "ahead", "project"]);
  });

  it("shows CI indicators and Actions tab for failed GitHub Actions", () => {
    const failed = repo({
      githubActions: {
        repository: "owner/repo",
        branch: "main",
        status: "completed",
        conclusion: "failure",
        workflowName: "CI",
        runName: "Build",
        runNumber: 42,
        htmlUrl: "https://github.com/owner/repo/actions/runs/1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        failedJobs: []
      }
    });

    expect(sidebarIndicators(failed)).toContain("CI");
    expect(visibleTabs(failed)).toContain("actions");
  });

  it("shows running CI indicators and Actions tab for active GitHub Actions", () => {
    const running = repo({
      githubActions: {
        repository: "owner/repo",
        branch: "main",
        status: "in_progress",
        conclusion: null,
        workflowName: "CI",
        runName: "Build",
        runNumber: 43,
        htmlUrl: "https://github.com/owner/repo/actions/runs/2",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        failedJobs: []
      }
    });

    expect(sidebarIndicators(running)).toContain("CI...");
    expect(visibleTabs(running)).toContain("actions");
  });
});
