# Repo Radar Requirements

## Product Goal

Repo Radar is a Windows desktop GUI for monitoring and managing Git status across many local projects at once. It is intended for users managing AI agents that may edit multiple repositories or folders in parallel.

The app should make it easy to see which repositories changed, which ones need pull/push work, review diffs, read project instructions, commit changes with AI-assisted messages, and open the repo in common local tools.

## Platform And Stack

- Target platform: Windows.
- Application stack: Electron + React + TypeScript.
- Git integration: use the local system Git installation through safe child process calls.
- Authentication: rely on existing Git configuration and Git Credential Manager.
- Packaging target: produce a local Windows executable. An installer is not required for v1.

## Settings

- The app must have a configurable default starting folder.
- On first launch, the user should be prompted to choose the starting folder if one is not already configured.
- The configured folder must be persisted between app launches.
- Settings must be accessible from the app UI.
- Settings must include:
  - Default root folder.
  - Whether to include nested repositories discovered inside another repository. Default: off.
  - Pull strategy for sync/pull where applicable. Default should match the user's Git configuration or VS Code-like behavior.

## Repository Discovery

- The app scans all subfolders of the configured root folder.
- It must ignore:
  - `node_modules`
  - folders whose names start with `.`
- A Git repository is detected by the presence of a `.git` directory or file.
- By default, once a repository is found, the scanner should not scan deeper inside that repository for nested repositories.
- If the `include nested repositories` setting is enabled, nested repositories and submodules may be included.
- The app must support manual refresh.
- Refresh behavior:
  - Re-scan local folders.
  - Read local Git status.
  - Fetch remotes for discovered repositories so ahead/behind data is current.
- Fetch failures must be shown as non-blocking repository warnings.

## Repository List

- The left side of the app must show all discovered repositories.
- Repositories should be grouped by parent folder.
- The list must support status filters:
  - All
  - Changed
  - Clean
  - Ahead
  - Behind
  - Diverged
  - Has errors
- Each repository row must show:
  - Repository name.
  - Relative path from the configured root folder.
  - Current branch.
  - Local changes indicator.
  - Ahead count.
  - Behind count.
  - Error or warning indicator when applicable.
- The list should be scannable and dense enough for many repositories.

## Repository Status

For each repository, the app must determine:

- Current branch name.
- Upstream branch, if configured.
- Whether the working tree has unstaged changes.
- Whether there are staged changes.
- Whether there are untracked files.
- Whether the current branch is ahead of upstream.
- Whether the current branch is behind upstream.
- Whether the branch has diverged from upstream.
- Whether the repository is in a risky or blocked state, such as:
  - Merge in progress.
  - Rebase in progress.
  - Cherry-pick in progress.
  - Conflicts present.
  - Detached HEAD.
  - Missing upstream.
  - Fetch/pull/push command failure.

## Selected Repository Detail Panel

Clicking a repository in the left list shows details on the right.

The detail panel must include:

- Toolbar actions:
  - Commit
  - Push
  - Pull
  - Sync
  - Refresh
  - Open in VS Code
  - Open in Explorer
  - Open terminal here
  - Copy path
  - Open remote URL in browser
- Status summary:
  - Branch.
  - Upstream.
  - Ahead/behind counts.
  - Working tree state.
  - Warnings/errors.
- Tabs for repository content:
  - Working Tree changes.
  - Staged changes.
  - Untracked files.
  - Ahead commits.
  - Project files.

Only tabs with content should be shown. For example, if there are no staged files, the Staged tab should be hidden.

The toolbar should enable and disable actions based on the current status and selected tab.

Examples:

- Commit enabled only when there are staged or unstaged local changes and no blocking Git operation is in progress.
- Push enabled only when the branch is ahead of upstream and no blocking Git operation is in progress.
- Pull enabled only when the branch is behind upstream and no blocking Git operation is in progress.
- Sync enabled on a loaded, checked-out branch with an upstream so it can fetch changes made on another machine. A paused upstream merge or rebase offers the review action.
- Open actions should remain available whenever the folder exists.

## Diff Review

- The app must show readable diffs for changed files.
- The Working Tree tab should show unstaged file changes.
- The Staged tab should show staged changes.
- The Untracked tab should show untracked files and their contents when practical.
- The Ahead Commits tab should show commits that exist locally but not on upstream, including commit subject, author, date, and changed files.
- The user should be able to select files and review their diffs.
- Binary files should be identified clearly instead of shown as broken text.

## Project Files Viewer

The Project Files tab should default to showing `README.md` when present.

It must provide read-only viewing for known project and agent instruction files, including:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `.github/copilot-instructions.md`
- `.cursor/rules/*`
- `.agents/*`
- `.codex/*`

Markdown files should be rendered in a readable way while preserving access to raw text if useful.

## Git Actions

All Git actions must run against the selected repository only.

### Commit

- The Commit button opens a commit dialog.
- The dialog must show staged and unstaged files.
- The dialog must allow the user to stage or unstage files.
- The dialog must require a commit message before committing.
- The dialog must detect and show issues that would block or complicate committing, such as:
  - Merge conflicts.
  - Rebase in progress.
  - No selected/staged files.
  - Git user name/email not configured.
- The dialog must support AI-generated commit messages from v1.
- AI-generated commit messages should be based on the current staged/selected changes.
- The user must be able to edit the generated message before committing.
- The app must not commit automatically without explicit user confirmation.

### AI Commit Messages

- The implementation should provide an AI commit message abstraction so the provider can be configured or replaced.
- v1 may use an OpenAI-compatible API if an API key is configured by environment variable or settings.
- If AI is unavailable, the UI should explain that message generation is unavailable and still allow manual commit messages.
- AI prompts must include enough diff context to produce a concise commit title and optional body.
- Large diffs must be summarized or truncated safely before being sent to the AI provider.
- Secrets should not intentionally be sent to the AI provider. The app should warn that generated messages use diff content.

### Pull

- Pull should fetch first, then pull the current branch from its upstream.
- Pull should follow the user's Git configuration for merge/rebase unless the app setting overrides it.
- Pull must show errors and conflict states clearly.

### Push

- Push should push the current branch to its configured upstream.
- If no upstream exists, the app should offer a safe explicit flow to set upstream and push.

### Sync

Sync should mimic VS Code's Git sync concept:

- Fetch first.
- If the branch is behind, pull from upstream.
- When a clone predates the first upstream commit, check out that commit and preserve local files. Keep the user's selections staged until the local files and configured integration policy allow the first save to proceed.
- Integrate the fetched commit from the local object database. When a rebase has no local commits to replay, preserve Git's fast-forward signature and strategy policies. Preview divergent merge paths without running the user's custom content drivers. Protect ignored files at relocated paths and account for Windows path casing. Before continuing a merge-preserving rebase, check queued picks, resets, and recreated merges for collisions and identify the affected path.
- If the branch is ahead, push to its configured destination.
- If the branch is both ahead and behind, pull first and then push if the pull succeeds.
- If Git has no configured reconciliation preference, use a merge for diverged branches.
- When fast-forward-only integration is in effect, stop on divergence before invoking the configured merge strategy. Account for the selected strategy and branch merge options when checking whether a merge would overwrite ignored files, including names with non-ASCII case differences on Windows.
- If a repository uses an external merge strategy and contains untracked or ignored files, direct the user to complete the merge in Git.
- Check the strategy's actual checkout paths even when the local branch is only behind. Check Git's alternate filenames for file/directory conflicts before starting or continuing a rebase. Name the endangered local file so the user can move it and retry.
- Direct the user to Git when a branch has multiple configured pull heads or a required rebase enables automatic branch-ref updates. Preserve the working tree, index and local branches, including changes selected in an open save prompt. A clean fast-forward can still proceed with automatic ref updates configured.
- Bind Sync to the branch displayed when the user clicks it. If another tool switches the checkout, ask the user to refresh.
- If a pull would overwrite local work, including a directory containing untracked files, show the branch, its staged changes and the remaining edits the user can include. Confirm the same branch, HEAD and staged state before committing and continuing Sync. If the checkout changes, require a fresh review.
- When a merge or rebase pauses on conflicts, open a review showing the changes from this computer and the incoming branch. Let the user resolve individual text conflicts, edit the result, or choose a whole version including a deletion.
- When a rebase recreates a merge, identify its first and second parents by commit hash and subject. Keep combined changes in the displayed parent order.
- Preserve unselected files when staging a deletion, including when a directory now occupies the deleted path. Identify untracked nested repositories in the commit prompt and leave their contents under their own Git history.
- A parent repository can record a changed submodule commit. Show separately when uncommitted work remains inside the submodule.
- Preserve literal conflict examples, documented marker lines, and edited underlined headings. Check submitted text against the original Git conflict even when an external editor already cleaned the working file. Require an explicit resolution when a remaining block could still be the real conflict. Offer whole-file choices for files with a declared non-UTF-8 working-tree encoding.
- Accept punctuation in renamed source-backed headings. Detect leftover diff3 ancestor markers at the file's configured marker width, including Git's constructed merge base during an apply-backend rebase.
- When Git recreates a merge without a saved conflict tree, check the marker labels for its actual merge base and rewritten parent before accepting edited or staged text.
- When a conflicted attributes file can change how other files are read or written, apply its resolution before reviewing the affected files. Opening the editor preserves a selected deletion until the user edits the contents.
- Recheck each file and its effective attributes before applying its resolution. On refresh, keep drafts for files whose conflict inputs are unchanged. Verify the expected staged changes before continuing Git and show staged paths, including submodule commits, when a review is reopened.
- Offer to skip an empty apply-backend rebase patch only when Git records a resolved conflict for the stopped patch. A blocked, unapplied commit must stay available. Require a fresh review if the replay order changes.
- After all choices are confirmed, stage the resolutions, continue the Git operation, review further conflicts if necessary, and push the current commit to its configured push destination. If that destination differs from the upstream, show both and ask before pushing. Report a missing upstream after fetching. A failed push leaves the completed work available locally for another Sync.
- Allow the user to close the review and return to the pending Git operation later.
- Keep keyboard focus inside each sync decision and return focus to its launcher when the decision closes. A background branch comparison must preserve the latest sync status. Opening a toolbar shortcut during Sync must keep other Git operations disabled until Sync finishes.
- If no upstream exists, prompt the user before setting upstream or pushing.
- Sync must never discard local changes.
- Check the configured push destination after pulling. An up-to-date destination needs no confirmation. When other refs are configured for push, Sync publishes only the reviewed branch. Refresh the upstream counts after publishing through a different remote or URL to the upstream branch name.
- Sync must never force-push in v1.

## Safety Constraints

v1 should not include destructive actions such as:

- Discard changes.
- Reset branch.
- Force push.
- Delete branch.
- Automated conflict resolution.

Stash, branch checkout, and conflict resolution may be future features but are out of scope for v1.

## Non-Functional Requirements

- The UI should remain responsive while scanning or running Git commands.
- Git operations should be cancellable where practical.
- Long-running operations should show progress or loading state.
- Git command output should be captured and shown in human-readable form.
- The app should handle many repositories without freezing.
- The app should be robust when repositories are deleted, moved, or corrupted between refreshes.
- The codebase should include unit and integration tests for Git parsing and actions.

