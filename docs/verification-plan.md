# Repo Radar Verification Plan

The implementation agent must verify Repo Radar before considering the work complete.

## Unit Tests

Add unit tests for:

- Parsing `git status --porcelain=v2 --branch`.
- Mapping status into sidebar indicators.
- Enabling/disabling toolbar actions.
- Detecting blocked states:
  - Conflicts.
  - Detached HEAD.
  - Missing upstream.
  - Merge/rebase in progress.
- Project file discovery.
- AI commit prompt construction and diff truncation.

## Integration Tests

Create temporary Git repositories during tests and verify:

- Clean repository detection.
- Unstaged changes detection.
- Staged changes detection.
- Untracked files detection.
- Ahead commits detection.
- Behind commits detection using a temporary bare remote.
- Diverged branch detection.
- Fetch failure handling.
- Commit flow against a temp repo.
- Push/pull/sync behavior against a temp bare remote.

Integration tests should avoid touching real user repositories.

## UI Smoke Tests

Use Playwright or the chosen Electron test runner to verify:

- App launches.
- First-run root folder setting can be configured.
- Repository list renders discovered repos.
- Status filters work.
- Selecting a repo updates the detail panel.
- Tabs appear only when relevant content exists.
- Diff viewer renders changed files.
- Project Files defaults to `README.md` when present.
- Commit dialog opens and validates missing commit messages.
- Toolbar buttons enable/disable based on status.

## Manual Verification Checklist

The implementation agent must run the app and manually verify:

- A root folder can be selected and persisted after restart.
- Multiple repositories are discovered under the root folder.
- `node_modules` and dot-prefixed folders are ignored during scanning.
- Refresh fetches remotes and updates ahead/behind counts.
- VS Code opens for a selected repo.
- Explorer opens for a selected repo.
- Terminal opens for a selected repo.
- Copy path copies the selected repo path.
- Open remote opens the configured remote URL.
- README and known agent files are displayed read-only.
- AI commit message generation works when configured.
- Manual commit still works when AI is not configured.

## Build Verification

The agent must run:

- Type checking.
- Linting, if configured.
- Unit tests.
- Integration tests.
- UI smoke tests, if feasible in the environment.
- Production build/package command.

The final response from the implementation agent must include:

- Commands run.
- Test results.
- Path to the produced Windows executable.
- Any limitations or skipped verification steps.

