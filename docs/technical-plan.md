# Repo Radar Technical Plan

## Recommended Project Structure

```text
repo-radar/
  package.json
  electron/
    main.ts
    preload.ts
    git/
      discovery.ts
      status.ts
      actions.ts
      diff.ts
      projectFiles.ts
    settings.ts
    aiCommit.ts
  src/
    app/
      App.tsx
      routes-or-layout.tsx
    components/
      RepoSidebar.tsx
      RepoDetail.tsx
      Toolbar.tsx
      DiffViewer.tsx
      CommitDialog.tsx
      SettingsDialog.tsx
      ProjectFilesViewer.tsx
    state/
      repoStore.ts
      settingsStore.ts
    types/
      repo.ts
      git.ts
      settings.ts
  tests/
    unit/
    integration/
  docs/
```

This structure may be adjusted to match the selected Electron starter, but keep the boundary clear:

- Electron main process owns filesystem, Git, process execution, settings persistence, and AI API calls.
- React renderer owns UI state and display.
- Preload exposes a typed, narrow API over Electron IPC.

## Git Command Strategy

Use local `git` commands via child process execution with:

- Explicit working directory.
- No shell interpolation for user-controlled paths.
- Timeouts for long-running commands.
- Captured stdout/stderr.
- Structured errors.

Recommended commands:

- Discovery:
  - filesystem traversal looking for `.git`.
- Branch/upstream:
  - `git rev-parse --abbrev-ref HEAD`
  - `git rev-parse --abbrev-ref --symbolic-full-name @{u}`
- Status:
  - `git status --porcelain=v2 --branch`
- Ahead/behind:
  - Parse `# branch.ab +N -M` from porcelain v2 after fetch.
- Fetch:
  - `git fetch --prune`
- Diffs:
  - `git diff -- <file>`
  - `git diff --staged -- <file>`
  - `git show --stat --oneline <commit>`
- Ahead commits:
  - `git log --oneline --decorate @{u}..HEAD`
- Pull:
  - `git pull`
  - Optional `--rebase` or `--no-rebase` based on settings.
- Push:
  - `git push`
- Commit:
  - `git add`
  - `git restore --staged`
  - `git commit -m`

Avoid destructive commands in v1.

## Status Model

Represent repository status with a structured model similar to:

```ts
type RepoStatus = {
  id: string;
  name: string;
  absolutePath: string;
  relativePath: string;
  parentGroup: string;
  branch: string | null;
  upstream: string | null;
  isDetachedHead: boolean;
  hasUnstagedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedFiles: boolean;
  ahead: number;
  behind: number;
  conflicts: string[];
  operationState: "idle" | "scanning" | "fetching" | "pulling" | "pushing" | "committing" | "error";
  warnings: GitWarning[];
  errors: GitError[];
};
```

Use stable repository IDs derived from normalized absolute paths.

## IPC API

Expose a typed preload API similar to:

```ts
window.repoRadar = {
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  chooseRootFolder(): Promise<string | null>;
  scanRepositories(root: string): Promise<RepoStatus[]>;
  refreshRepository(path: string): Promise<RepoStatus>;
  getDiff(path: string, file: string, mode: DiffMode): Promise<DiffResult>;
  getProjectFiles(path: string): Promise<ProjectFile[]>;
  readProjectFile(path: string, file: string): Promise<string>;
  stageFiles(path: string, files: string[]): Promise<RepoStatus>;
  unstageFiles(path: string, files: string[]): Promise<RepoStatus>;
  generateCommitMessage(path: string, files: string[]): Promise<string>;
  commit(path: string, message: string): Promise<RepoStatus>;
  pull(path: string): Promise<RepoStatus>;
  push(path: string): Promise<RepoStatus>;
  sync(path: string): Promise<RepoStatus>;
  openVSCode(path: string): Promise<void>;
  openExplorer(path: string): Promise<void>;
  openTerminal(path: string): Promise<void>;
  copyPath(path: string): Promise<void>;
  openRemote(path: string): Promise<void>;
};
```

## AI Commit Message Provider

Create an abstraction:

```ts
interface CommitMessageProvider {
  isAvailable(): Promise<boolean>;
  generate(input: CommitMessageInput): Promise<string>;
}
```

The implementation should support:

- No-provider fallback.
- OpenAI-compatible provider configured by settings or environment.
- Diff truncation and summarization for large changes.
- Redaction hooks for obvious secrets before sending text to a provider.

The AI provider should run from the Electron main process, not the renderer.

## Settings Persistence

Use a simple app settings store appropriate for Electron, such as:

- `electron-store`, or
- a JSON file under Electron's `app.getPath("userData")`.

Do not store plaintext API keys unless the implementation clearly documents this and there is no secure store available. Prefer environment variables or OS credential storage when practical.

## Packaging

Use a standard Electron packaging tool such as Electron Forge or electron-builder.

The build should produce a local Windows executable suitable for running directly. An installer is not required.

