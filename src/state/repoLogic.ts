import type { ActionAvailability, RepoFilter, RepoStatus } from "../types/repo";

export function isChanged(repo: RepoStatus): boolean {
  return repo.hasStagedChanges || repo.hasUnstagedChanges || repo.hasUntrackedFiles;
}

export function repoMatchesFilter(repo: RepoStatus, filter: RepoFilter): boolean {
  if (filter === "changed") return isChanged(repo);
  if (filter === "clean") return !isChanged(repo) && repo.ahead === 0 && repo.behind === 0 && repo.errors.length === 0;
  if (filter === "ahead") return repo.ahead > 0 && repo.behind === 0;
  if (filter === "behind") return repo.behind > 0 && repo.ahead === 0;
  if (filter === "diverged") return repo.ahead > 0 && repo.behind > 0;
  if (filter === "errors") return repo.errors.length > 0 || repo.warnings.some((issue) => issue.code === "fetch-failed");
  return true;
}

export function sidebarIndicators(repo: RepoStatus): string[] {
  const indicators: string[] = [];
  if (repo.errors.length > 0) indicators.push("Error");
  if (isChanged(repo)) indicators.push("Changed");
  if (!isChanged(repo) && repo.errors.length === 0) indicators.push("Clean");
  if (repo.ahead > 0 && repo.behind > 0) indicators.push("Diverged");
  else {
    if (repo.ahead > 0) indicators.push(`+${repo.ahead}`);
    if (repo.behind > 0) indicators.push(`-${repo.behind}`);
  }
  if (repo.warnings.length > 0) indicators.push("Warn");
  return indicators;
}

export function actionAvailability(repo: RepoStatus | null): ActionAvailability {
  const unavailable = {
    commit: false,
    pull: false,
    push: false,
    sync: false,
    reasons: {
      commit: "No repository selected.",
      pull: "No repository selected.",
      push: "No repository selected.",
      sync: "No repository selected."
    }
  };
  if (!repo) return unavailable;

  const blocked = repo.errors.length > 0;
  const changed = isChanged(repo);
  const noUpstream = !repo.upstream;
  return {
    commit: changed && !blocked,
    pull: repo.behind > 0 && !blocked && !noUpstream,
    push: repo.ahead > 0 && !blocked && !noUpstream,
    sync: (repo.ahead > 0 || repo.behind > 0) && !blocked && !noUpstream,
    reasons: {
      commit: blocked ? "Resolve blocking Git state first." : changed ? null : "No local changes.",
      pull: blocked ? "Resolve blocking Git state first." : noUpstream ? "No upstream branch." : repo.behind > 0 ? null : "Branch is not behind.",
      push: blocked ? "Resolve blocking Git state first." : noUpstream ? "No upstream branch." : repo.ahead > 0 ? null : "Branch is not ahead.",
      sync: blocked ? "Resolve blocking Git state first." : noUpstream ? "No upstream branch." : repo.ahead > 0 || repo.behind > 0 ? null : "Nothing to sync."
    }
  };
}

export function visibleTabs(repo: RepoStatus): Array<"working" | "staged" | "untracked" | "ahead" | "project"> {
  const tabs: Array<"working" | "staged" | "untracked" | "ahead" | "project"> = [];
  if (repo.files.some((file) => file.unstaged && !file.untracked)) tabs.push("working");
  if (repo.files.some((file) => file.staged)) tabs.push("staged");
  if (repo.files.some((file) => file.untracked)) tabs.push("untracked");
  if (repo.aheadCommits.length > 0) tabs.push("ahead");
  if (repo.projectFiles.length > 0) tabs.push("project");
  return tabs;
}
