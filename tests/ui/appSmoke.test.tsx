import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App";
import type { RepoRadarApi } from "../../src/types/api";
import type { RepoStatus } from "../../src/types/repo";
import type { AppSettings } from "../../src/types/settings";
import { defaultSettings } from "../../src/types/settings";

const sampleRepo: RepoStatus = {
  id: "c:/root/repo-one",
  name: "repo-one",
  absolutePath: "C:/root/repo-one",
  relativePath: "repo-one",
  parentGroup: "/",
  branch: "main",
  upstream: "origin/main",
  isDetachedHead: false,
  hasUnstagedChanges: true,
  hasStagedChanges: false,
  hasUntrackedFiles: false,
  ahead: 0,
  behind: 0,
  conflicts: [],
  files: [{ path: "src/app.ts", kind: "modified", staged: false, unstaged: true, untracked: false, conflicted: false }],
  aheadCommits: [],
  projectFiles: [{ path: "README.md", displayName: "README.md", kind: "markdown" }],
  warnings: [],
  errors: []
};

function installApi(settings: AppSettings = { ...defaultSettings, rootFolder: "C:/root" }) {
  const api: RepoRadarApi = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    chooseRootFolder: vi.fn().mockResolvedValue("C:/root"),
    scanRepositories: vi.fn().mockResolvedValue([sampleRepo]),
    refreshRepository: vi.fn().mockResolvedValue(sampleRepo),
    getDiff: vi.fn().mockResolvedValue({ file: "src/app.ts", mode: "working", text: "diff --git a/src/app.ts b/src/app.ts", isBinary: false }),
    getProjectFiles: vi.fn().mockResolvedValue(sampleRepo.projectFiles),
    readProjectFile: vi.fn().mockResolvedValue("# Repo One"),
    getCommitPreview: vi.fn().mockResolvedValue({ blockers: [], staged: [], unstaged: ["src/app.ts"], untracked: [], aiAvailable: false }),
    stageFiles: vi.fn().mockResolvedValue({ ...sampleRepo, hasStagedChanges: true }),
    unstageFiles: vi.fn().mockResolvedValue(sampleRepo),
    generateCommitMessage: vi.fn().mockResolvedValue("Update app"),
    commit: vi.fn().mockResolvedValue({ ...sampleRepo, files: [], hasUnstagedChanges: false }),
    pull: vi.fn().mockResolvedValue(sampleRepo),
    push: vi.fn().mockResolvedValue(sampleRepo),
    sync: vi.fn().mockResolvedValue(sampleRepo),
    openVSCode: vi.fn().mockResolvedValue(undefined),
    openExplorer: vi.fn().mockResolvedValue(undefined),
    openTerminal: vi.fn().mockResolvedValue(undefined),
    copyPath: vi.fn().mockResolvedValue(undefined),
    openRemote: vi.fn().mockResolvedValue(undefined),
    getDebugInfo: vi.fn().mockResolvedValue({ gitPath: "git", version: "git version test" })
  };
  window.repoRadar = api;
  return api;
}

describe("App UI smoke", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders discovered repos, detail tabs, diffs, project files, and commit dialog state", async () => {
    installApi();
    render(<App />);

    expect((await screen.findAllByText("repo-one")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Working Tree")).toBeInTheDocument();
    expect(screen.queryByText("Staged")).not.toBeInTheDocument();
    expect(screen.getByText("Project Files")).toBeInTheDocument();
    expect(await screen.findByText("diff --git a/src/app.ts b/src/app.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Project Files"));
    expect(await screen.findByText("Repo One")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Commit"));
    expect(await screen.findByText("AI generation is unavailable. Manual commit messages still work.")).toBeInTheDocument();
    const commitButtons = screen.getAllByText("Commit");
    expect(commitButtons[commitButtons.length - 1]).toBeDisabled();
  });

  it("opens settings on first run without a root folder", async () => {
    installApi({ ...defaultSettings, rootFolder: null });
    render(<App />);

    await waitFor(() => expect(screen.getByText("Settings")).toBeInTheDocument());
    expect(screen.getByText("Default root folder")).toBeInTheDocument();
  });
});
