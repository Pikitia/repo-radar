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
  githubActions: null,
  warnings: [],
  errors: []
};

function installApi(settings: AppSettings = { ...defaultSettings, rootFolder: "C:/root" }) {
  const api: RepoRadarApi = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    chooseRootFolder: vi.fn().mockResolvedValue("C:/root"),
    discoverRepositories: vi.fn().mockResolvedValue([sampleRepo]),
    scanRepositories: vi.fn().mockResolvedValue([sampleRepo]),
    refreshRepository: vi.fn().mockResolvedValue(sampleRepo),
    getBranchComparison: vi.fn().mockResolvedValue(null),
    getDiff: vi.fn().mockResolvedValue({
      file: "src/app.ts",
      mode: "working",
      text: [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old line",
        "+new line"
      ].join("\n"),
      isBinary: false
    }),
    getCommitDiff: vi.fn().mockResolvedValue({ file: "abc123", mode: "commit", text: "", isBinary: false }),
    getProjectFiles: vi.fn().mockResolvedValue(sampleRepo.projectFiles),
    readProjectFile: vi.fn().mockResolvedValue("# Repo One"),
    getCommitPreview: vi.fn().mockResolvedValue({ blockers: [], staged: [], unstaged: ["src/app.ts"], untracked: ["notes.txt"], aiAvailable: false, packageVersion: null }),
    stageFiles: vi.fn().mockResolvedValue({ ...sampleRepo, hasStagedChanges: true }),
    unstageFiles: vi.fn().mockResolvedValue(sampleRepo),
    bumpPackageVersion: vi.fn().mockResolvedValue({ ...sampleRepo, hasStagedChanges: true }),
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
    openExternal: vi.fn().mockResolvedValue(undefined),
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
    expect(await screen.findByText("Original")).toBeInTheDocument();
    expect(screen.getAllByText("Changed").length).toBeGreaterThan(0);
    expect(screen.getByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Project Files"));
    expect(await screen.findByText("Repo One")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Commit"));
    expect(await screen.findByText("AI generation is unavailable. Manual commit messages still work.")).toBeInTheDocument();
    expect(screen.getAllByText("Stage all").length).toBe(2);
    expect(screen.getByText("Stage all changes")).toBeInTheDocument();
    expect(screen.getByText("Unstage all")).toBeDisabled();
    const commitButtons = screen.getAllByText("Commit");
    expect(commitButtons[commitButtons.length - 1]).toBeDisabled();
  });

  it("commits and pushes from the commit dialog", async () => {
    const api = installApi();
    vi.mocked(api.getCommitPreview).mockResolvedValue({
      blockers: [],
      staged: ["src/app.ts"],
      unstaged: [],
      untracked: [],
      aiAvailable: false,
      packageVersion: null
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Commit"));
    fireEvent.change(await screen.findByPlaceholderText("Commit message"), { target: { value: "Update app" } });
    fireEvent.click(screen.getByText("Commit and Push"));

    await waitFor(() => expect(api.commit).toHaveBeenCalledWith(sampleRepo.absolutePath, "Update app"));
    expect(api.push).toHaveBeenCalledWith(sampleRepo.absolutePath);
    expect(vi.mocked(api.commit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.push).mock.invocationCallOrder[0]);
  });

  it("does every commit step in order from the commit dialog", async () => {
    const api = installApi();
    vi.mocked(api.getCommitPreview)
      .mockResolvedValueOnce({
        blockers: [],
        staged: [],
        unstaged: ["src/app.ts"],
        untracked: ["notes.txt"],
        aiAvailable: true,
        packageVersion: { path: "package.json", current: "1.0.2", next: "1.0.3" }
      })
      .mockResolvedValueOnce({
        blockers: [],
        staged: ["src/app.ts", "notes.txt"],
        unstaged: [],
        untracked: [],
        aiAvailable: true,
        packageVersion: { path: "package.json", current: "1.0.2", next: "1.0.3" }
      })
      .mockResolvedValueOnce({
        blockers: [],
        staged: ["src/app.ts", "notes.txt", "package.json"],
        unstaged: [],
        untracked: [],
        aiAvailable: true,
        packageVersion: { path: "package.json", current: "1.0.3", next: "1.0.4" }
      });
    vi.mocked(api.generateCommitMessage).mockResolvedValue("Update app");
    vi.mocked(api.stageFiles).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...sampleRepo, hasStagedChanges: true };
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Commit"));
    fireEvent.click(await screen.findByText("Do Everything"));

    expect(await screen.findByText("Staging 2 files...")).toBeInTheDocument();
    await waitFor(() => expect(api.push).toHaveBeenCalledWith(sampleRepo.absolutePath));
    expect(api.stageFiles).toHaveBeenCalledWith(sampleRepo.absolutePath, ["src/app.ts", "notes.txt"]);
    expect(api.bumpPackageVersion).toHaveBeenCalledWith(sampleRepo.absolutePath);
    expect(api.generateCommitMessage).toHaveBeenCalledWith(sampleRepo.absolutePath, ["src/app.ts", "notes.txt", "package.json"]);
    expect(api.commit).toHaveBeenCalledWith(sampleRepo.absolutePath, "Update app");

    const stageOrder = vi.mocked(api.stageFiles).mock.invocationCallOrder[0];
    const bumpOrder = vi.mocked(api.bumpPackageVersion).mock.invocationCallOrder[0];
    const messageOrder = vi.mocked(api.generateCommitMessage).mock.invocationCallOrder[0];
    const commitOrder = vi.mocked(api.commit).mock.invocationCallOrder[0];
    const pushOrder = vi.mocked(api.push).mock.invocationCallOrder[0];
    expect(stageOrder).toBeLessThan(bumpOrder);
    expect(bumpOrder).toBeLessThan(messageOrder);
    expect(messageOrder).toBeLessThan(commitOrder);
    expect(commitOrder).toBeLessThan(pushOrder);
  });

  it("opens settings on first run without a root folder", async () => {
    installApi({ ...defaultSettings, rootFolder: null });
    render(<App />);

    await waitFor(() => expect(screen.getByText("Settings")).toBeInTheDocument());
    expect(screen.getByText("Default root folder")).toBeInTheDocument();
  });
});
