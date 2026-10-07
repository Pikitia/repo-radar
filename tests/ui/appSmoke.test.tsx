import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App";
import { DiffViewer } from "../../src/components/DiffViewer.js";
import type { DevelopPullRequestPreview, NpmCommandEvent, RepoRadarApi } from "../../src/types/api";
import type { RepoStatus } from "../../src/types/repo";
import type { AppSettings } from "../../src/types/settings";
import { defaultSettings } from "../../src/types/settings";
import type { CiRun } from "../../src/types/ci.js";

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
    getDevelopPullRequestPreview: vi.fn().mockResolvedValue({ repository: "example/repo-one", developSha: "a".repeat(40), mainSha: "b".repeat(40), ahead: 1 }),
    promoteDevelop: vi.fn().mockResolvedValue({ number: 42, url: "https://github.com/example/repo-one/pull/42", outcome: "auto-merge", message: "Auto-merge enabled for pull request #42." }),
    addCiWatch: vi.fn().mockResolvedValue([]),
    removeCiWatch: vi.fn().mockResolvedValue([]),
    getCiWorkflows: vi.fn().mockResolvedValue([]),
    getCiRun: vi.fn().mockResolvedValue(null),
    getCiJobs: vi.fn().mockResolvedValue([]),
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
    getNpmVerifyScript: vi.fn().mockResolvedValue("verify"),
    startNpmCommand: vi.fn().mockResolvedValue(undefined),
    onNpmCommandEvent: vi.fn().mockReturnValue(() => undefined),
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
  it("only offers remote promotion with both origin branches ahead, and creates nothing on cancellation", async () => {
    const api = installApi();
    vi.mocked(api.getBranchComparison).mockResolvedValue({
      developRef: "origin/develop", mainRef: "origin/main", developVersion: null, mainVersion: null,
      developAheadMain: 1, developBehindMain: 0, commitsInDevelopNotMain: []
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Merge origin/develop into origin/main" });
    expect(button).toHaveAttribute("title", expect.stringContaining("GitHub checks"));
    fireEvent.click(button);
    const confirmation = await screen.findByRole("dialog", { name: "Merge develop into main: repo-one" });
    await within(confirmation).findByText("example/repo-one");
    expect(api.promoteDevelop).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.promoteDevelop).not.toHaveBeenCalled();

    cleanup();
    const equalApi = installApi();
    vi.mocked(equalApi.getBranchComparison).mockResolvedValue({
      developRef: "origin/develop", mainRef: "origin/main", developVersion: null, mainVersion: null,
      developAheadMain: 0, developBehindMain: 1, commitsInDevelopNotMain: []
    });
    render(<App />);
    await screen.findByText("Original");
    await waitFor(() => expect(equalApi.getBranchComparison).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Merge origin/develop into origin/main" })).not.toBeInTheDocument();

    cleanup();
    const missingApi = installApi();
    render(<App />);
    await screen.findByText("Original");
    await waitFor(() => expect(missingApi.getBranchComparison).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Merge origin/develop into origin/main" })).not.toBeInTheDocument();
  });

  it("uses the fresh confirmed remote preview, prevents repeated submission, and shows the PR result", async () => {
    const api = installApi();
    vi.mocked(api.getBranchComparison).mockResolvedValue({
      developRef: "origin/develop", mainRef: "origin/main", developVersion: null, mainVersion: null,
      developAheadMain: 1, developBehindMain: 0, commitsInDevelopNotMain: []
    });
    const preview: DevelopPullRequestPreview = { repository: "example/repo-one", developSha: "c".repeat(40), mainSha: "d".repeat(40), ahead: 3 };
    vi.mocked(api.getDevelopPullRequestPreview).mockResolvedValue(preview);
    let finish: ((value: Awaited<ReturnType<RepoRadarApi["promoteDevelop"]>>) => void) | undefined;
    vi.mocked(api.promoteDevelop).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge origin/develop into origin/main" }));
    const confirm = await screen.findByRole("button", { name: "Confirm PR and merge" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.promoteDevelop).toHaveBeenCalledTimes(1));
    expect(api.promoteDevelop).toHaveBeenCalledWith(sampleRepo.absolutePath, preview);
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(api.push).not.toHaveBeenCalled();
    act(() => finish?.({ number: 42, url: "https://github.com/example/repo-one/pull/42", outcome: "auto-merge", message: "Auto-merge enabled. Waiting for checks." }));
    const link = await screen.findByRole("link", { name: "Open pull request #42 in GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/example/repo-one/pull/42");
    fireEvent.click(link);
    expect(api.openExternal).toHaveBeenCalledWith("https://github.com/example/repo-one/pull/42");
  });

  it("shows a remote preview error without allowing a write", async () => {
    const api = installApi();
    vi.mocked(api.getBranchComparison).mockResolvedValue({
      developRef: "origin/develop", mainRef: "origin/main", developVersion: null, mainVersion: null,
      developAheadMain: 1, developBehindMain: 0, commitsInDevelopNotMain: []
    });
    vi.mocked(api.getDevelopPullRequestPreview).mockRejectedValue(new Error("Both origin/develop and origin/main must exist."));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge origin/develop into origin/main" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Both origin/develop and origin/main must exist.");
    expect(screen.queryByRole("button", { name: "Confirm PR and merge" })).not.toBeInTheDocument();
    expect(api.promoteDevelop).not.toHaveBeenCalled();
  });

  it("refreshes remote promotion eligibility after a repository toolbar refresh", async () => {
    const api = installApi();
    const comparison = { developRef: "origin/develop", mainRef: "origin/main", developVersion: null, mainVersion: null,
      developAheadMain: 1, developBehindMain: 0, commitsInDevelopNotMain: [] };
    vi.mocked(api.getBranchComparison).mockResolvedValue(comparison);
    vi.mocked(api.refreshRepository).mockResolvedValue({ ...sampleRepo, branchComparisonLoaded: false });
    render(<App />);
    await screen.findByRole("button", { name: "Merge origin/develop into origin/main" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getBranchComparison).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Merge origin/develop into origin/main" })).toBeEnabled();
    vi.mocked(api.getBranchComparison).mockResolvedValue({ ...comparison, developAheadMain: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Merge origin/develop into origin/main" })).not.toBeInTheDocument());
  });
  let reportLayoutWidth: (width: number) => void;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        reportLayoutWidth = (width) => this.callback([
          { contentRect: { width } } as ResizeObserverEntry
        ], this as unknown as ResizeObserver);
        reportLayoutWidth(900);
      }
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const productionRun: CiRun = {
    id: 41, attempt: 2, workflowName: "Deploy production", title: "Release search", number: 18,
    branch: "production", commit: "abcdef1234567890", status: "in_progress", conclusion: null,
    createdAt: "2026-10-05T10:00:00Z", startedAt: "2026-10-05T10:01:00Z", updatedAt: "2026-10-05T10:02:00Z",
    htmlUrl: "https://github.com/example/repo-one/actions/runs/41"
  };

  it("quickly watches main without switching views or duplicating an existing watch", async () => {
    const api = installApi();
    const watch = { id: "main", repoPath: sampleRepo.absolutePath, branch: "main" };
    vi.mocked(api.addCiWatch).mockResolvedValue([watch]);
    render(<App />);
    await screen.findByText("Working Tree");
    fireEvent.click(screen.getByRole("button", { name: "Watch main" }));
    await waitFor(() => expect(api.addCiWatch).toHaveBeenCalledWith({ repoPath: sampleRepo.absolutePath, branch: "main" }));
    expect(await screen.findByRole("button", { name: "Watching main" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Repositories" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Watching main" }));
    expect(api.addCiWatch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "CI Watch" }));
    expect(await within(screen.getByRole("tabpanel", { name: "CI Watch" })).findByText("No runs")).toBeVisible();
    expect(api.getCiRun).toHaveBeenCalledWith(sampleRepo.absolutePath, "main", undefined);
  });

  it("recognizes existing main workflow watches and reports quick-add failures", async () => {
    installApi({ ...defaultSettings, rootFolder: "C:/root", ciWatches: [{ id: "main-deploy", repoPath: sampleRepo.absolutePath, branch: "main", workflowId: 8 }] });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Watching main" })).toBeDisabled();
    cleanup();
    const api = installApi();
    vi.mocked(api.addCiWatch).mockRejectedValue(new Error("CI Watch requires a github.com origin remote."));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Watch main" }));
    expect(await screen.findByText("Could not watch main: CI Watch requires a github.com origin remote.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Watch main" })).not.toBeDisabled();
  });

  it("splits timing from run date and sorts every column while preserving expanded rows", async () => {
    const repoTwo = { ...sampleRepo, id: "c:/root/repo-two", name: "repo-two", absolutePath: "C:/root/repo-two", relativePath: "repo-two" };
    const watches = [{ id: "one", repoPath: sampleRepo.absolutePath, branch: "production" }, { id: "two", repoPath: repoTwo.absolutePath, branch: "main" }];
    const api = installApi({ ...defaultSettings, rootFolder: "C:/root", ciWatches: watches });
    vi.mocked(api.discoverRepositories).mockResolvedValue([repoTwo, sampleRepo]);
    vi.mocked(api.refreshRepository).mockImplementation(async (path) => path === repoTwo.absolutePath ? repoTwo : sampleRepo);
    vi.mocked(api.getCiRun).mockImplementation(async (path) => path === repoTwo.absolutePath ? { ...productionRun, id: 52, branch: "main", createdAt: "2026-10-05T11:00:00Z" } : productionRun);
    render(<App />);
    await screen.findByText("Working Tree");
    fireEvent.click(screen.getByRole("tab", { name: "CI Watch" }));
    const overview = screen.getByRole("tabpanel", { name: "CI Watch" });
    await waitFor(() => expect(within(overview).getAllByText("Running")).toHaveLength(2));
    function summaryNames() { return [...overview.querySelectorAll(".ci-summary-row")].map((row) => within(row as HTMLElement).getByRole("button", { name: /^repo-/ }).textContent); }
    expect(summaryNames()).toEqual(["repo-two", "repo-one"]);
    expect(within(overview).queryByText(/^Checked /)).not.toBeInTheDocument();
    const summary = overview.querySelector(".ci-summary-row")!;
    expect(summary.querySelectorAll("td")).toHaveLength(9);
    expect(summary.querySelectorAll("td")[6].textContent).toMatch(/\d+[hms]/);
    expect(summary.querySelectorAll("td")[7]).toHaveAttribute("title", new Date("2026-10-05T11:00:00Z").toLocaleString());
    fireEvent.click(within(overview).getByRole("button", { name: "Expand repo-one production latest run" }));
    await within(overview).findByText(/^Status last refreshed/);
    for (const label of ["Repository", "Branch", "Workflow", "Status", "Commit", "Timing", "When run"]) {
      const button = within(overview).getByRole("button", { name: `Sort by ${label}` });
      fireEvent.click(button);
      expect(button.closest("th")).toHaveAttribute("aria-sort", "ascending");
      if (label === "Repository") expect(summaryNames()).toEqual(["repo-one", "repo-two"]);
      fireEvent.click(button);
      expect(button.closest("th")).toHaveAttribute("aria-sort", "descending");
      if (label === "Repository") expect(summaryNames()).toEqual(["repo-two", "repo-one"]);
    }
    expect(within(overview).getByRole("button", { name: "Collapse repo-one production latest run" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Repositories" }));
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "CI Watch" })); });
    expect(within(overview).getByRole("button", { name: "Sort by When run" }).closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(within(overview).getByRole("button", { name: "Collapse repo-one production latest run" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows watches across repositories, expands jobs inline, and preserves both views' selections", async () => {
    const repoTwo = { ...sampleRepo, id: "c:/root/repo-two", name: "repo-two", absolutePath: "C:/root/repo-two", relativePath: "repo-two", hasUnstagedChanges: false, files: [] };
    const watches = [
      { id: "one", repoPath: sampleRepo.absolutePath, branch: "production", workflowId: 8, workflowName: "Deploy production" },
      { id: "two", repoPath: repoTwo.absolutePath, branch: "main", workflowId: 9, workflowName: "Build" }
    ];
    const api = installApi({ ...defaultSettings, rootFolder: "C:/root", ciWatches: watches });
    vi.mocked(api.discoverRepositories).mockResolvedValue([sampleRepo, repoTwo]);
    vi.mocked(api.refreshRepository).mockImplementation(async (repoPath) => repoPath === sampleRepo.absolutePath ? sampleRepo : repoTwo);
    vi.mocked(api.getCiRun).mockImplementation(async (repoPath) => repoPath === sampleRepo.absolutePath ? productionRun : { ...productionRun, id: 52, workflowName: "Build", branch: "main", status: "completed", conclusion: "success" });
    vi.mocked(api.getCiJobs).mockResolvedValue([{ id: 101, name: "Deploy", status: "in_progress", conclusion: null, startedAt: productionRun.startedAt, completedAt: null, htmlUrl: productionRun.htmlUrl, steps: [{ number: 1, name: "Upload release", status: "in_progress", conclusion: null }] }]);
    render(<App />);
    fireEvent.click(await screen.findByText("Project Files"));
    await screen.findByText("Repo One");
    fireEvent.click(screen.getByRole("tab", { name: "CI Watch" }));
    const overview = screen.getByRole("tabpanel", { name: "CI Watch" });
    await within(overview).findByText("Succeeded");
    expect(within(overview).getByRole("button", { name: "repo-one" })).toBeInTheDocument();
    expect(within(overview).getByRole("button", { name: "repo-two" })).toBeInTheDocument();
    expect(api.getCiRun).toHaveBeenCalledWith(sampleRepo.absolutePath, "production", 8);
    expect(api.getCiRun).toHaveBeenCalledWith(repoTwo.absolutePath, "main", 9);
    fireEvent.click(screen.getByRole("button", { name: "clean" }));
    expect(within(overview).getByRole("button", { name: "repo-one" })).toBeInTheDocument();
    fireEvent.click(within(overview).getByRole("button", { name: "Expand repo-one production Deploy production" }));
    expect(await within(overview).findByText("1. Upload release")).toBeInTheDocument();
    expect(api.getCiJobs).toHaveBeenCalledWith(sampleRepo.absolutePath, 41, 2);
    expect(within(overview).getByRole("button", { name: "repo-two" })).toBeInTheDocument();
    fireEvent.click(within(overview).getByRole("button", { name: "repo-one" }));
    expect(screen.getByRole("tab", { name: "Repositories" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Repo One")).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "CI Watch" })); });
    expect(within(overview).getByRole("button", { name: "Collapse repo-one production Deploy production" })).toHaveAttribute("aria-expanded", "true");
    expect(api.pull).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
  });

  it("adds a persistent branch/workflow watch and removes it", async () => {
    const watch = { id: "production", repoPath: sampleRepo.absolutePath, branch: "production", workflowId: 8, workflowName: "Deploy production" };
    const api = installApi();
    vi.mocked(api.addCiWatch).mockResolvedValue([watch]);
    vi.mocked(api.getCiRun).mockResolvedValue(productionRun);
    vi.mocked(api.getCiWorkflows).mockResolvedValue([{ id: 8, name: "Deploy production", path: ".github/workflows/deploy.yml", state: "active" }]);
    render(<App />);
    await screen.findByText("Working Tree");
    fireEvent.click(screen.getByRole("tab", { name: "CI Watch" }));
    fireEvent.click(screen.getByRole("button", { name: "Watch branch" }));
    await screen.findByRole("option", { name: /Deploy production/ });
    fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "production" } });
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
    await waitFor(() => expect(api.addCiWatch).toHaveBeenCalledWith({ repoPath: sampleRepo.absolutePath, branch: "production", workflowId: 8, workflowName: "Deploy production" }));
    expect(await screen.findByText("Running")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove watch for repo-one production Deploy production" }));
    await waitFor(() => expect(api.removeCiWatch).toHaveBeenCalledWith("production"));
    expect(await screen.findByText("No watched branches yet")).toBeVisible();
  });

  it("keeps old run data clearly unavailable after a failed refresh, then recovers", async () => {
    const api = installApi({ ...defaultSettings, rootFolder: "C:/root", ciWatches: [{ id: "one", repoPath: sampleRepo.absolutePath, branch: "production" }] });
    vi.mocked(api.getCiRun).mockResolvedValue(productionRun);
    render(<App />);
    await screen.findByText("Working Tree");
    fireEvent.click(screen.getByRole("tab", { name: "CI Watch" }));
    const overview = screen.getByRole("tabpanel", { name: "CI Watch" });
    await within(overview).findByText("Running");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh CI" })).not.toBeDisabled());
    vi.mocked(api.getCiRun).mockRejectedValue(new Error("Network offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh CI" }));
    expect(await within(overview).findByText("Unavailable")).toBeVisible();
    expect(within(overview).getByText("Previous run retained. Network offline")).toBeVisible();
    expect(within(overview).getByText("abcdef1")).toBeVisible();
    expect(within(overview).queryByText("Running")).not.toBeInTheDocument();
    vi.mocked(api.getCiRun).mockResolvedValue({ ...productionRun, status: "completed", conclusion: "success" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh CI" }));
    expect(await within(overview).findByText("Succeeded")).toBeVisible();
    expect(within(overview).queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it.each(["working", "untracked", "staged"] as const)("resizes the %s file list and displays full relative paths", async (mode) => {
    const api = installApi();
    const file = "new folder/nested/a-long-filename.txt";
    const repo = {
      ...sampleRepo,
      files: [{ ...sampleRepo.files[0], path: file, staged: mode === "staged", unstaged: mode === "working", untracked: mode === "untracked" }]
    };
    render(<DiffViewer repo={repo} mode={mode} />);
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledWith(repo.absolutePath, file, mode));
    expect(screen.getByRole("button", { name: /new folder\/nested\/a-long-filename.txt/ })).toBeInTheDocument();
    const resizer = screen.getByRole("separator", { name: "Resize file list" });
    expect(resizer).toHaveAttribute("aria-valuenow", "220");
    fireEvent.keyDown(resizer, { key: "ArrowRight", shiftKey: true });
    expect(resizer).toHaveAttribute("aria-valuenow", "270");
    expect(resizer.parentElement).toHaveStyle({ "--file-list-width": "270px" });
    fireEvent.keyDown(resizer, { key: "Home" });
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "160");
    fireEvent.keyDown(resizer, { key: "End" });
    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(resizer).toHaveAttribute("aria-valuenow", "646");
    act(() => reportLayoutWidth(600));
    expect(resizer).toHaveAttribute("aria-valuenow", "346");
    expect(resizer.parentElement).toHaveStyle({ "--file-list-width": "346px" });
  });

  it("drags the file divider without jumping and cleans up on capture loss and unmount", async () => {
    installApi();
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    });
    const view = render(<DiffViewer repo={sampleRepo} mode="working" />);
    await screen.findByText("new line");
    const resizer = screen.getByRole("separator", { name: "Resize file list" });
    resizer.setPointerCapture = vi.fn();
    resizer.hasPointerCapture = vi.fn().mockReturnValue(true);
    resizer.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(resizer, { pointerId: 2, clientX: 900 });
    expect(resizer).toHaveAttribute("aria-valuenow", "220");
    fireEvent.pointerMove(resizer, { pointerId: 1, clientX: 780 });
    expect(resizer).toHaveAttribute("aria-valuenow", "300");
    expect(document.body).toHaveClass("resizing-panels");
    fireEvent.pointerUp(resizer, { pointerId: 1 });
    expect(resizer.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(document.body).not.toHaveClass("resizing-panels");

    fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientX: 780 });
    fireEvent.lostPointerCapture(resizer, { pointerId: 1 });
    fireEvent.pointerMove(resizer, { pointerId: 1, clientX: 800 });
    expect(resizer).toHaveAttribute("aria-valuenow", "300");
    expect(document.body).not.toHaveClass("resizing-panels");
    fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientX: 780 });
    fireEvent.pointerCancel(resizer, { pointerId: 1 });
    expect(document.body).not.toHaveClass("resizing-panels");
    fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientX: 780 });
    view.unmount();
    expect(document.body).not.toHaveClass("resizing-panels");
  });

  it("renders discovered repos, detail tabs, diffs, project files, and commit dialog state", async () => {
    installApi();
    render(<App />);

    expect((await screen.findAllByText("repo-one")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Working Tree")).toBeInTheDocument();
    const resizer = screen.getByRole("separator", { name: "Resize repository list" });
    expect(resizer).toHaveAttribute("aria-orientation", "vertical");
    expect(resizer).toHaveAttribute("aria-valuenow", "355");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "335");
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

  it("runs npm update in a closeable output tab and prevents duplicate runs", async () => {
    const api = installApi();
    let commandListener: ((event: NpmCommandEvent) => void) | null = null;
    vi.mocked(api.onNpmCommandEvent).mockImplementation((callback) => {
      commandListener = callback;
      return () => undefined;
    });
    render(<App />);

    const updateButton = await screen.findByText("Update Dependencies");
    await screen.findByText("Original");
    await screen.findByText("new line");
    fireEvent.click(updateButton);

    await waitFor(() => expect(api.startNpmCommand).toHaveBeenCalledWith(sampleRepo.absolutePath, expect.any(String), "update"));
    const runId = vi.mocked(api.startNpmCommand).mock.calls[0][1];
    expect(updateButton).toBeDisabled();
    expect(await screen.findByText("npm update...")).toBeInTheDocument();

    act(() => {
      commandListener?.({ runId, repoPath: sampleRepo.absolutePath, type: "output", stream: "stdout", text: "updated 2 packages\n" });
    });
    expect(await screen.findByText(/updated 2 packages/)).toBeInTheDocument();
    act(() => {
      commandListener?.({ runId, repoPath: sampleRepo.absolutePath, type: "complete", command: "update", displayCommand: "npm update", exitCode: 0 });
    });

    await waitFor(() => expect(updateButton).not.toBeDisabled());
    expect(screen.getByText(/npm update exited with code 0\./)).toBeInTheDocument();
    fireEvent.click(updateButton);
    await waitFor(() => expect(api.startNpmCommand).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.startNpmCommand).mock.calls[1][1]).toBe(runId);
    expect(screen.queryByText(/npm update exited with code 0\./)).not.toBeInTheDocument();
    expect(screen.getAllByText("npm update...")).toHaveLength(1);

    act(() => {
      commandListener?.({ runId, repoPath: sampleRepo.absolutePath, type: "complete", command: "update", displayCommand: "npm update", exitCode: 0 });
    });
    await waitFor(() => expect(updateButton).not.toBeDisabled());
    fireEvent.click(screen.getAllByTitle("Close npm command output")[0]);
    expect(screen.queryByText(/npm update exited with code 0\./)).not.toBeInTheDocument();
  });

  it("runs the preferred verify script and hides verify when no script exists", async () => {
    const api = installApi();
    render(<App />);

    const verifyButton = await screen.findByText("Verify");
    fireEvent.click(verifyButton);
    await waitFor(() => expect(api.startNpmCommand).toHaveBeenCalledWith(sampleRepo.absolutePath, expect.any(String), "verify"));

    cleanup();
    const noScriptApi = installApi();
    vi.mocked(noScriptApi.getNpmVerifyScript).mockResolvedValue(null);
    render(<App />);

    await screen.findByText("Update Dependencies");
    await waitFor(() => expect(noScriptApi.getNpmVerifyScript).toHaveBeenCalledWith(sampleRepo.absolutePath));
    expect(screen.queryByText("Verify")).not.toBeInTheDocument();
  });

  it("opens settings on first run without a root folder", async () => {
    installApi({ ...defaultSettings, rootFolder: null });
    render(<App />);

    await waitFor(() => expect(screen.getByText("Settings")).toBeInTheDocument());
    expect(screen.getByText("Default root folder")).toBeInTheDocument();
  });
});
