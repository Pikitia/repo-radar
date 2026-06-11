import { describe, expect, it } from "vitest";
import { isFailedActionsConclusion, parseGitHubRemote } from "../../electron/git/githubActions";

describe("GitHub Actions helpers", () => {
  it("parses common GitHub remote URL forms", () => {
    expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubRemote("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubRemote("https://example.com/owner/repo.git")).toBeNull();
  });

  it("classifies failed workflow conclusions", () => {
    expect(isFailedActionsConclusion("failure")).toBe(true);
    expect(isFailedActionsConclusion("timed_out")).toBe(true);
    expect(isFailedActionsConclusion("success")).toBe(false);
    expect(isFailedActionsConclusion(null)).toBe(false);
  });
});
