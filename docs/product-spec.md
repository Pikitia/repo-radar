# Repo Radar Product Spec

## Primary User

The primary user is a developer coordinating work across multiple local repositories, especially when one or more AI agents may be modifying files in different project folders.

The app is for repeated operational use, not for a marketing-style presentation. The interface should be dense, clear, and fast to scan.

## Main Layout

Use a two-panel desktop layout:

- Left sidebar: repository discovery, grouping, filters, and status list.
- Right workspace: selected repository detail, toolbar, status summary, diffs, commits, and project files.

Avoid large hero sections, decorative cards, or oversized explanatory UI. Prioritize compact controls and clear status indicators.

## Left Sidebar

The sidebar should include:

- Root folder display with a Settings button.
- Refresh All button.
- Status filter segmented control or compact filter list.
- Grouped repository list.

Repository rows should be stable in height and visually scannable. Each row should show compact indicators for:

- Branch.
- Dirty state.
- Ahead count.
- Behind count.
- Warning/error state.

Suggested labels:

- `Clean`
- `Changed`
- `+N` for ahead.
- `-N` for behind.
- `Diverged` when both ahead and behind.
- `Error` for blocked or failed status.

## Right Panel

When no repository is selected, show a quiet empty state that asks the user to select a repository or configure a root folder.

When a repository is selected, show:

- Header with repository name and path.
- Toolbar.
- Status strip.
- Content tabs.

## Toolbar Behavior

Toolbar buttons:

- Commit
- Pull
- Push
- Sync
- Refresh
- Open in VS Code
- Open in Explorer
- Open terminal
- Copy path
- Open remote

Buttons should be disabled with a tooltip when the current status makes the action invalid.

Examples:

- `Commit` disabled when there are no local changes.
- `Pull` disabled when there is no upstream or no behind count.
- `Push` disabled when there is no upstream or no ahead count.
- `Sync` disabled when there is no upstream, unless the app offers an explicit setup flow.

## Tabs

The detail area should show only tabs that have content:

- Working Tree
- Staged
- Untracked
- Ahead Commits
- Project Files

`Project Files` should always be available when the selected repository has at least one known project file.

If a repository has no changes and no ahead commits, the detail panel should still show status and Project Files when available.

## Diff Experience

The diff viewer should support:

- File list for the selected change category.
- Per-file diff display.
- Clear treatment of added, modified, deleted, renamed, and binary files.
- Monospace diff rendering.
- Helpful empty states.

The first changed file should be selected automatically when opening a diff tab.

## Commit Dialog

The commit dialog should include:

- File list grouped by staged and unstaged.
- Stage/unstage controls.
- Commit message field.
- Generate AI message button.
- Blocking issue area.
- Commit confirmation button.

The app should allow a workflow where the user selects files, stages them, generates a message, edits it, and commits.

The commit dialog should never hide Git errors. If commit fails, show the error and keep the dialog open.

## AI Commit Message UX

The Generate AI Message button should:

- Be disabled if no files are selected/staged.
- Show loading state while generating.
- Fill the commit message field with the suggested message.
- Let the user edit the message before commit.
- Show a clear unavailable state if no AI provider or key is configured.

Recommended output format:

```text
Short imperative summary

Optional body with one or two bullets when useful.
```

## Settings Screen

Settings should include:

- Default root folder picker.
- Include nested repositories toggle.
- Pull strategy selector:
  - Use Git config
  - Merge
  - Rebase
- AI commit message provider settings:
  - Provider type
  - API key source
  - Model name
- About/debug area:
  - Git executable path.
  - App version.

Sensitive values such as API keys should not be displayed in plain text after entry.

## Error Handling

Errors should be shown near the thing they affect:

- Repo scan errors in the sidebar/status row.
- Git action errors in the selected repo detail panel.
- Commit errors in the commit dialog.
- Global settings errors in settings.

The user should be able to continue using unaffected repositories when one repository has errors.

## Visual Tone

Repo Radar should feel like a calm operations console:

- Compact.
- Trustworthy.
- Keyboard and mouse friendly.
- Clear about risk.
- Useful with many repositories on screen.

