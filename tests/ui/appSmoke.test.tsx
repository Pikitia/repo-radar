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
    databases: {
      setMcpReadAccess: vi.fn(),
      checkServerConnection: vi.fn().mockResolvedValue({ status: "verified" }),
      verifyTargets: vi.fn().mockResolvedValue([]), overview: vi.fn().mockResolvedValue({ profiles: [], servers: [], proposals: [], releases: [], rehearsals: [], activeRun: null, lastRun: null }),
      saveServerConnection: vi.fn(), getServerConnection: vi.fn(), saveServerCredentials: vi.fn(), discoverDatabases: vi.fn(), assignDatabases: vi.fn(), saveProfile: vi.fn(), saveCredentials: vi.fn(), inspect: vi.fn(), acceptIdentity: vi.fn(), compare: vi.fn(), importProposal: vi.fn(), sealRelease: vi.fn(), history: vi.fn(), createPlan: vi.fn(), runPlan: vi.fn(), rehearse: vi.fn(), exportLibrary: vi.fn(), importLibrary: vi.fn(), configureDiagnostics: vi.fn(), recordRestoreVerification: vi.fn()
    },
    getDatabaseMcpStatus: vi.fn().mockResolvedValue({ enabled: true, running: true, url: "http://127.0.0.1:47321/mcp" }),
    copyDatabaseMcpConfig: vi.fn().mockResolvedValue(undefined),
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
    commitAndSync: vi.fn(),
    confirmSyncPush: vi.fn(),
    getSyncConflictReview: vi.fn(),
    finishSync: vi.fn(),
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
  const pausedMerge: RepoStatus = {
    ...sampleRepo, ahead: 1, behind: 1, conflicts: ["guide.md", "logo.png"],
    errors: [{ code: "merge-in-progress", message: "Merge in progress." }]
  };

  it("keeps Git actions disabled when a shortcut finishes during a pending Sync", async () => {
    const api = installApi();
    const diverged = { ...sampleRepo, ahead: 1, behind: 1 };
    vi.mocked(api.refreshRepository).mockResolvedValue(diverged);
    let complete!: (status: RepoStatus) => void;
    vi.mocked(api.sync).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    render(<App />);
    const pull = await screen.findByRole("button", { name: "Pull" });
    await waitFor(() => expect(pull).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await screen.findByText("Opened VS Code.");
    expect(api.openVSCode).toHaveBeenCalledWith(sampleRepo.absolutePath);
    for (const name of ["Pull", "Push", "Commit", "Sync"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(api.pull).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => complete(diverged));
    await waitFor(() => expect(pull).toBeEnabled());
  });

  it("keeps keyboard focus inside each sync prompt and returns to the disabled-then-restored launcher", async () => {
    const api = installApi();
    const dirty = { ...sampleRepo, syncCommitRequired: "Overlapping edits", syncCommitGuard: { branch: "main", token: "initial" },
      files: [...sampleRepo.files, { ...sampleRepo.files[0], path: "child", submoduleChange: "contents" as const },
        { path: "nested/", kind: "untracked" as const, staged: false, unstaged: false, untracked: true, conflicted: false }] };
    const fork = { ...sampleRepo, syncPushReview: { token: "fork", upstream: "origin/main", destination: "fork/main" } };
    let initial!: (result: RepoStatus) => void;
    let commit!: (result: RepoStatus) => void;
    let merge!: (result: RepoStatus) => void;
    let push!: (result: RepoStatus) => void;
    vi.mocked(api.sync).mockImplementation(() => new Promise(resolve => { initial = resolve; }));
    vi.mocked(api.commitAndSync).mockImplementation(() => new Promise(resolve => { commit = resolve; }));
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({ token: "merge", operation: "merge", files: [] });
    vi.mocked(api.finishSync).mockImplementation(() => new Promise(resolve => { merge = resolve; }));
    vi.mocked(api.confirmSyncPush).mockImplementation(() => new Promise(resolve => { push = resolve; }));
    render(<App />);
    const launcher = await screen.findByRole("button", { name: "Sync" });
    await waitFor(() => expect(launcher).toBeEnabled());
    launcher.focus();
    fireEvent.click(launcher);
    expect(launcher).toBeDisabled();
    launcher.blur(); // Chromium blurs buttons when a pending action disables them.
    await act(async () => initial(dirty));

    function checkFocusCycle(dialog: HTMLElement, first: HTMLElement, last: HTMLElement) {
      expect(dialog).toHaveAttribute("open");
      expect(first).toHaveFocus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(last).toHaveFocus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(first).toHaveFocus();
    }
    function submitWhileBusy(dialog: HTMLElement, action: HTMLElement) {
      fireEvent.click(action);
      expect(dialog).toHaveAttribute("aria-busy", "true");
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(dialog).toHaveFocus();
      fireEvent.keyDown(dialog, { key: "Escape" });
      fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
      expect(dialog).toHaveAttribute("open");
    }

    const commitDialog = await screen.findByRole("dialog", { name: "Save local changes to sync" });
    const save = await within(commitDialog).findByRole("button", { name: "Commit and continue sync" });
    expect(within(commitDialog).getByRole("checkbox", { name: "nested/" })).toBeDisabled();
    expect(within(commitDialog).getByRole("checkbox", { name: "nested/" })).not.toBeChecked();
    expect(within(commitDialog).getByRole("checkbox", { name: /child.*Commit file changes inside this submodule/i })).toBeDisabled();
    expect(within(commitDialog).getByRole("checkbox", { name: "src/app.ts" })).toBeChecked();
    checkFocusCycle(commitDialog, within(commitDialog).getByRole("button", { name: "Close" }), save);
    submitWhileBusy(commitDialog, save);
    expect(api.commitAndSync).toHaveBeenCalledWith(sampleRepo.absolutePath, dirty.syncCommitGuard, ["src/app.ts"], expect.any(String));
    await act(async () => commit(pausedMerge));

    const mergeDialog = await screen.findByRole("dialog", { name: "Review merge" });
    const finish = await within(mergeDialog).findByRole("button", { name: "Finish sync and push" });
    checkFocusCycle(mergeDialog, within(mergeDialog).getByRole("button", { name: "Close" }), finish);
    submitWhileBusy(mergeDialog, finish);
    await act(async () => merge(fork));

    const forkDialog = await screen.findByRole("dialog", { name: "Confirm push destination" });
    const confirm = within(forkDialog).getByRole("button", { name: "Push to fork/main" });
    checkFocusCycle(forkDialog, within(forkDialog).getByRole("button", { name: "Cancel" }), confirm);
    submitWhileBusy(forkDialog, confirm);
    await act(async () => push(sampleRepo));
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("records a selected submodule commit and explains where its uncommitted changes stay", async () => {
    const api = installApi();
    const guard = { branch: "main", token: "submodule-review" };
    vi.mocked(api.sync).mockResolvedValue({ ...sampleRepo, syncCommitRequired: "Overlapping changes", syncCommitGuard: guard,
      files: [...sampleRepo.files, { ...sampleRepo.files[0], path: "child", submoduleChange: "commit-and-contents" }] });
    vi.mocked(api.commitAndSync).mockResolvedValue(sampleRepo);
    render(<App />);
    const sync = await screen.findByRole("button", { name: "Sync" });
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    const dialog = within(await screen.findByRole("dialog", { name: "Save local changes to sync" }));
    const child = await dialog.findByRole("checkbox", { name: /child.*Record the new submodule commit.*Uncommitted files stay/i });
    expect(child).toBeEnabled();
    expect(child).not.toBeChecked();
    fireEvent.click(child);
    fireEvent.click(dialog.getByRole("button", { name: "Commit and continue sync" }));
    await waitFor(() => expect(api.commitAndSync).toHaveBeenCalledWith(sampleRepo.absolutePath, guard, ["child"], expect.any(String)));
  });

  it("guides Sync through multiple text conflicts and a deletion before sending reviewed decisions", async () => {
    const api = installApi();
    vi.mocked(api.refreshRepository).mockResolvedValue({ ...sampleRepo, ahead: 1, behind: 1 });
    vi.mocked(api.sync).mockResolvedValue(pausedMerge);
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({
      operation: "merge", token: "reviewed",
      files: [
        { path: "guide.md", local: { exists: true, text: "local file" }, incoming: { exists: true, text: "incoming file" },
          mergedText: "clean local edit\r\n<<<<<<< HEAD\r\none\r\n=======\r\ntwo\r\n>>>>>>> incoming\r\nclean incoming edit\r\n<<<<<<< HEAD\r\nthree\r\n||||||| ancestor\r\nbase\r\n=======\r\nfour\r\n>>>>>>> incoming\r\nend" },
        { path: "logo.png", local: { exists: true, text: null }, incoming: { exists: false, text: null }, mergedText: null }
      ]
    });
    vi.mocked(api.finishSync).mockResolvedValue(sampleRepo);
    render(<App />);
    const sync = await screen.findByRole("button", { name: "Sync" });
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    const dialog = within(await screen.findByRole("dialog", { name: "Review merge" }));
    expect(api.sync).toHaveBeenCalledWith(sampleRepo.absolutePath, sampleRepo.branch);
    const finish = await dialog.findByRole("button", { name: "Finish sync and push" });
    expect(finish).toBeDisabled();
    expect(screen.queryByText("Sync complete.")).not.toBeInTheDocument();
    fireEvent.click(within(dialog.getByRole("region", { name: "Conflict 1" })).getByRole("button", { name: "Keep local change" }));
    fireEvent.click(dialog.getByRole("button", { name: "Edit merged text" }));
    const partial = (dialog.getByRole("textbox", { name: "Merged file contents" }) as HTMLTextAreaElement).value;
    expect(partial).toContain("clean local edit\none\nclean incoming edit\n<<<<<<< HEAD");
    expect(finish).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Discard text edits and return to choices" }));
    expect(within(dialog.getByRole("region", { name: "Conflict 1" })).getByRole("button", { name: "Keep local change" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog.getByRole("region", { name: "Conflict 2" })).getByRole("button", { name: "Keep incoming change" }));
    expect(finish).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Next unresolved file" }));
    expect(dialog.getByText("Preview unavailable for this file.")).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Use incoming deletion" }));
    fireEvent.click(finish);
    await waitFor(() => expect(api.finishSync).toHaveBeenCalledWith(sampleRepo.absolutePath, "reviewed", [
      { path: "guide.md", choice: "edited", text: "clean local edit\r\none\r\nclean incoming edit\r\nfour\r\nend" },
      { path: "logo.png", choice: "incoming" }
    ], false));
    expect(await screen.findByText("Sync complete.")).toBeVisible();
  });

  it("recovers edited text and preserves choices only for unchanged conflicts after a failed finish", async () => {
    const api = installApi();
    vi.mocked(api.refreshRepository).mockResolvedValue(pausedMerge);
    const guide = { path: "guide.md", identity: "same-guide", local: { exists: true, text: "left" },
      incoming: { exists: true, text: "right" }, mergedText: "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> incoming\n" };
    const binary = { path: "logo.png", local: { exists: true, text: null }, incoming: { exists: true, text: null }, mergedText: null };
    const original = { operation: "merge" as const, token: "before", files: [guide, binary] };
    vi.mocked(api.getSyncConflictReview).mockResolvedValueOnce(original).mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, token: "after", files: [{ ...binary, identity: "new-binary" }, guide] });
    vi.mocked(api.finishSync).mockRejectedValueOnce(new Error("Git is busy."))
      .mockRejectedValueOnce(new Error("The repository changed.")).mockResolvedValueOnce(sampleRepo);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review merge" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Review merge" }));
    const finish = () => dialog.getByRole("button", { name: "Finish sync and push" });
    fireEvent.click(await dialog.findByRole("button", { name: "Edit merged text" }));
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "Handwritten resolution\n" } });
    fireEvent.click(dialog.getByRole("button", { name: "Next unresolved file" }));
    fireEvent.click(dialog.getByRole("button", { name: "Keep incoming file" }));
    fireEvent.click(finish());
    await dialog.findByText("Review refreshed. Kept your choices for 2 unchanged files.");
    expect(dialog.getByRole("button", { name: "Keep incoming file" })).toHaveAttribute("aria-pressed", "true");
    expect(finish()).toBeEnabled();
    fireEvent.click(finish());
    await dialog.findByText("Review refreshed. Kept your choices for 1 unchanged file.");
    expect(dialog.getByRole("combobox")).toHaveDisplayValue("logo.png");
    expect(dialog.getByRole("button", { name: "Keep incoming file" })).toHaveAttribute("aria-pressed", "false");
    expect(finish()).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Keep local file" }));
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "1" } });
    expect(dialog.getByRole("textbox")).toHaveValue("Handwritten resolution\n");
    fireEvent.click(finish());
    await screen.findByText("Sync complete.");
    expect(api.finishSync).toHaveBeenLastCalledWith(sampleRepo.absolutePath, "after",
      [{ path: "logo.png", choice: "local" }, { path: "guide.md", choice: "edited", text: "Handwritten resolution\n" }], false);
  });

  it("applies attribute choices before reviewing dependent files and shows existing staged changes", async () => {
    const api = installApi();
    vi.mocked(api.refreshRepository).mockResolvedValue(pausedMerge);
    const sides = { local: { exists: true, text: "local" }, incoming: { exists: true, text: "incoming" }, mergedText: null };
    vi.mocked(api.getSyncConflictReview)
      .mockResolvedValueOnce({ token: "attributes", operation: "merge", hasDeferredFiles: true,
        files: [{ path: ".gitattributes", ...sides }], stagedPaths: ["separate.txt"] })
      .mockResolvedValueOnce({ token: "content", operation: "merge", files: [{ path: "note.txt", ...sides }] });
    vi.mocked(api.finishSync).mockResolvedValueOnce(pausedMerge).mockResolvedValueOnce(sampleRepo);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review merge" }));
    const first = await screen.findByRole("button", { name: "Apply choices and continue review" });
    expect(screen.queryByRole("button", { name: "Finish sync and push" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Already staged for this merge (1)"));
    expect(screen.getByText("separate.txt")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep local file" }));
    fireEvent.click(first);
    await screen.findByRole("option", { name: "note.txt" });
    expect(api.finishSync).toHaveBeenCalledWith(sampleRepo.absolutePath, "attributes", [{ path: ".gitattributes", choice: "local" }], false);
    fireEvent.click(screen.getByRole("button", { name: "Keep incoming file" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish sync and push" }));
    expect(await screen.findByText("Sync complete.")).toBeVisible();
  });

  it("leaves an empty rebase commit paused until the user explicitly skips it", async () => {
    const api = installApi();
    const paused = { ...pausedMerge, branch: null, upstream: null, isDetachedHead: true, conflicts: [],
      errors: [{ code: "rebase-in-progress", message: "Rebase in progress." }] };
    vi.mocked(api.refreshRepository).mockResolvedValue(paused);
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({ token: "empty", operation: "rebase", files: [], canSkipEmptyPatch: true });
    vi.mocked(api.finishSync).mockResolvedValue(sampleRepo);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review merge" }));
    expect(await screen.findByText(/Your choices leave this commit with no changes/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Finish sync and push" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(api.finishSync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip empty commit and continue sync" }));
    expect(await screen.findByText("Sync complete.")).toBeVisible();
    expect(api.finishSync).toHaveBeenCalledWith(sampleRepo.absolutePath, "empty", [], true);
  });

  it("resumes a paused rebase, reviews the next stop, and shows a push failure after completion", async () => {
    const api = installApi();
    const paused = { ...pausedMerge, branch: null, upstream: null, isDetachedHead: true,
      errors: [{ code: "rebase-in-progress", message: "Rebase in progress." }] };
    vi.mocked(api.refreshRepository).mockResolvedValue(paused);
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({
      token: "first", operation: "rebase", files: [{ path: "guide.md", local: { exists: true, text: "my work" },
        incoming: { exists: true, text: "updated branch" }, mergedText: "<<<<<<< HEAD\nupdated branch\n=======\nmy work\n>>>>>>> Local commit\n" }]
    });
    vi.mocked(api.finishSync).mockResolvedValueOnce(paused).mockRejectedValueOnce(new Error("Push rejected by remote."));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit merged text" }));
    const editor = screen.getByRole("textbox", { name: "Merged file contents" });
    expect((editor as HTMLTextAreaElement).value).toContain("<<<<<<< HEAD");
    expect(screen.getByRole("button", { name: "Finish sync and push" })).toBeDisabled();
    fireEvent.change(editor, { target: { value: "my combined work\n" } });
    expect(screen.getByRole("button", { name: "Finish sync and push" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(api.finishSync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep local change" }));
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({ token: "next", operation: "rebase", files: [] });
    fireEvent.click(screen.getByRole("button", { name: "Finish sync and push" }));
    await screen.findByText(/All conflicts have been staged/);
    expect(api.finishSync).toHaveBeenCalledWith(sampleRepo.absolutePath, "first", [{ path: "guide.md", choice: "edited", text: "my work" }], false);
    vi.mocked(api.refreshRepository).mockResolvedValue({ ...sampleRepo, ahead: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Finish sync and push" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Push rejected by remote.")).toBeVisible();
    expect(api.finishSync).toHaveBeenLastCalledWith(sampleRepo.absolutePath, "next", [], false);
    expect(api.refreshRepository).toHaveBeenLastCalledWith(sampleRepo.absolutePath, false);
    expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
    expect(screen.queryByText("Sync complete.")).not.toBeInTheDocument();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it("offers to commit overlapping local work and retries Sync only after a commit", async () => {
    const api = installApi();
    const dirty = { ...sampleRepo, behind: 1, files: [{ ...sampleRepo.files[0], path: "guide.md" }] };
    const guard = { branch: "main", token: "local-index" };
    const reason = "Your local changes to guide.md would be overwritten by merge.";
    vi.mocked(api.refreshRepository).mockResolvedValue(dirty);
    vi.mocked(api.sync).mockResolvedValue({ ...dirty, syncCommitRequired: reason, syncCommitGuard: guard });
    vi.mocked(api.commitAndSync).mockResolvedValue(pausedMerge);
    vi.mocked(api.getCommitPreview).mockResolvedValue({ blockers: [], staged: [], unstaged: ["guide.md"], untracked: [], aiAvailable: false, packageVersion: null });
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({ token: "after-commit", operation: "merge", files: [] });
    render(<App />);
    const sync = await screen.findByRole("button", { name: "Sync" });
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    const prompt = within(await screen.findByRole("dialog"));
    fireEvent.click(await prompt.findByText("Show Git’s explanation"));
    expect(prompt.getByText(reason)).toBeVisible();
    fireEvent.click(prompt.getByRole("button", { name: "Close" }));
    expect(api.commit).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(1);
    fireEvent.click(sync);
    const again = within(await screen.findByRole("dialog"));
    fireEvent.change(await again.findByPlaceholderText("Commit message"), { target: { value: "Keep my guide changes" } });
    expect(again.getByRole("checkbox", { name: "guide.md" })).toBeChecked();
    fireEvent.click(again.getByRole("button", { name: "Commit and continue sync" }));
    await screen.findByRole("dialog", { name: "Review merge" });
    expect(api.commitAndSync).toHaveBeenCalledWith(sampleRepo.absolutePath, guard, ["guide.md"], "Keep my guide changes");
    expect(api.commit).not.toHaveBeenCalled();
    expect(api.stageFiles).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(2);
    expect(api.push).not.toHaveBeenCalled();
  });

  it("requires a fresh choice after the checkout changes and independently selects the rest of a partially staged file", async () => {
    const api = installApi();
    const first = { ...sampleRepo, behind: 1, syncCommitRequired: "Local changes overlap.",
      syncCommitGuard: { branch: "main", token: "first" }, files: [{ ...sampleRepo.files[0], staged: true }] };
    const second = { ...first, branch: "develop", syncCommitRequired: "The branch changed. Review this checkout.",
      syncCommitGuard: { branch: "develop", token: "second" } };
    vi.mocked(api.sync).mockResolvedValue(first);
    vi.mocked(api.commitAndSync).mockResolvedValueOnce(second).mockResolvedValueOnce(sampleRepo);
    render(<App />);
    const sync = await screen.findByRole("button", { name: "Sync" });
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    let prompt = within(await screen.findByRole("dialog"));
    expect(await prompt.findByRole("list", { name: "Already staged" })).toHaveTextContent("src/app.ts");
    const remaining = prompt.getByRole("checkbox", { name: "src/app.ts" });
    expect(remaining).not.toBeChecked();
    fireEvent.click(remaining);
    fireEvent.click(prompt.getByRole("button", { name: "Commit and continue sync" }));
    await screen.findByText("repo-one · develop");
    prompt = within(screen.getByRole("dialog"));
    expect(await prompt.findByRole("checkbox", { name: "src/app.ts" })).not.toBeChecked();
    expect(api.commitAndSync).toHaveBeenCalledTimes(1);
    expect(api.commitAndSync).toHaveBeenCalledWith(sampleRepo.absolutePath, first.syncCommitGuard, ["src/app.ts"], expect.any(String));
    fireEvent.click(prompt.getByRole("button", { name: "Commit and continue sync" }));
    await waitFor(() => expect(api.commitAndSync).toHaveBeenLastCalledWith(sampleRepo.absolutePath, second.syncCommitGuard, [], expect.any(String)));
  });

  it("shows the configured fork after a merge and pushes only after an explicit destination choice", async () => {
    const api = installApi();
    const pending = { ...sampleRepo, ahead: 1, syncPushReview: { token: "fork-head", upstream: "origin/main", destination: "fork/main" } };
    vi.mocked(api.sync).mockResolvedValueOnce(pausedMerge).mockResolvedValueOnce(pending);
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({ token: "merge", operation: "merge", files: [] });
    vi.mocked(api.finishSync).mockResolvedValue(pending);
    vi.mocked(api.confirmSyncPush).mockResolvedValue({ ...sampleRepo, ahead: 1 });
    render(<App />);
    const sync = await screen.findByRole("button", { name: "Sync" });
    await waitFor(() => expect(sync).toBeEnabled());
    fireEvent.click(sync);
    fireEvent.click(await screen.findByRole("button", { name: "Finish sync and push" }));
    const prompt = within(await screen.findByRole("dialog", { name: "Confirm push destination" }));
    expect(prompt.getByText("origin/main")).toBeVisible();
    expect(prompt.getByText("fork/main")).toBeVisible();
    fireEvent.click(prompt.getByRole("button", { name: "Cancel" }));
    expect(api.confirmSyncPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    fireEvent.click(await screen.findByRole("button", { name: "Push to fork/main" }));
    await screen.findByText("Pushed to fork/main.");
    expect(api.confirmSyncPush).toHaveBeenCalledWith(sampleRepo.absolutePath, "fork-head");
  });

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

  it.each(["success", "failure"])("keeps completed sync when an older background comparison finishes with %s", async outcome => {
    const api = installApi();
    vi.mocked(api.refreshRepository).mockResolvedValue(pausedMerge);
    let finishBackground!: () => void;
    vi.mocked(api.getBranchComparison).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishBackground = () => outcome === "success" ? resolve(null) : reject(new Error("Older comparison failed"));
    }));
    vi.mocked(api.getSyncConflictReview).mockResolvedValue({ token: "staged", operation: "merge", files: [] });
    vi.mocked(api.finishSync).mockResolvedValue(sampleRepo);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish sync and push" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled());
    await act(async () => finishBackground());
    expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Review merge" })).not.toBeInTheDocument();
    expect(screen.getByText("Sync complete.")).toBeVisible();
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
