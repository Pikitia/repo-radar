# Build Prompt: Repo Radar

You are an AI coding agent building Repo Radar in this repository.

Repo Radar is a Windows desktop GUI app for monitoring and managing Git status across multiple local repositories. Build it with Electron + React + TypeScript.

Read these files first:

- `docs/requirements.md`
- `docs/product-spec.md`
- `docs/technical-plan.md`
- `docs/verification-plan.md`

## Mission

Implement the full v1 app described in the docs, then verify that it works.

The finished app must:

- Run as an Electron desktop app on Windows.
- Let the user configure and persist a default root folder.
- Recursively discover Git repositories under that root folder.
- Ignore `node_modules` and dot-prefixed folders.
- Show all discovered repositories in a grouped left sidebar.
- Show branch, dirty state, ahead count, behind count, and warnings/errors per repo.
- Fetch remotes on refresh.
- Show selected repository details on the right.
- Provide toolbar actions for commit, pull, push, sync, refresh, VS Code, Explorer, terminal, copy path, and open remote.
- Provide tabbed views for Working Tree, Staged, Untracked, Ahead Commits, and Project Files.
- Hide tabs that have no content, except Project Files when known files exist.
- Render diffs for changed files.
- Read and display `README.md` and known agent/project instruction files as read-only content.
- Open a commit dialog with staged and unstaged files.
- Detect commit blockers before committing.
- Support AI-generated commit messages from v1 through a provider abstraction.
- Continue to support manual commit messages if AI is unavailable.
- Implement VS Code-like Sync: fetch, pull if behind, then push if ahead; never force-push or discard local changes.
- Avoid destructive Git operations in v1.
- Produce a local Windows executable. An installer is not required.

## Implementation Guidance

Use local Git through child process calls from Electron's main process. Do not run Git commands through string-built shell commands with untrusted paths. Use explicit working directories and argument arrays.

Keep the Electron main process responsible for:

- Filesystem access.
- Git discovery and commands.
- Settings persistence.
- AI provider calls.
- Opening external tools.

Keep the React renderer responsible for:

- Layout.
- Repository list.
- Filters.
- Detail panel.
- Dialogs.
- Diff and project file display.

Expose a narrow typed IPC API through preload.

Make the UI compact and operational. This is a desktop tool for repeated use, not a landing page.

## AI Commit Messages

Implement an AI commit message provider abstraction.

The app should support an OpenAI-compatible provider configured by settings or environment. If no provider is configured, the Generate AI Message button should show a clear unavailable state and manual commit should remain fully usable.

The generated commit message must be editable before commit.

Be careful with large diffs:

- Limit the amount of diff text sent.
- Summarize file names and change stats where useful.
- Warn or document that diff content may be sent to the AI provider.

## Verification Requirements

Before finishing, perform the verification described in `docs/verification-plan.md`.

At minimum, run:

- Type checking.
- Unit tests.
- Integration tests with temporary Git repositories.
- UI smoke tests if feasible.
- Production package/build command.

Create temporary test repositories for integration tests. Do not use real user repositories as test fixtures.

The final answer must include:

- Summary of what was built.
- Verification commands run and whether they passed.
- Path to the produced executable.
- Any limitations, skipped checks, or follow-up work.

Do not claim verification succeeded unless you actually ran it.

