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
});
