# CI Watch

CI Watch is a permanent main-view tab beside Repositories. The repository sidebar
stays visible. It shows watches across all discovered repositories, independent of
the sidebar's selection or local branch checkout. Clicking a repository name returns
to its repository view. Switching views preserves repository tabs and expanded runs.

Use **Watch branch** to choose a repository, enter a remote branch name, and optionally
select a workflow. Choose the deployment workflow for production monitoring. The
default explicitly shows the latest run on the branch from any workflow; its status
is not a claim about the deployed environment. Add separate watches for additional
workflows on the same branch. Watches persist in the existing local settings and
duplicate repository/branch/workflow watches are ignored.

The compact overview has separate Repository, Branch, Workflow, Status, Commit,
Timing (elapsed duration), and When run (run creation date/time) columns. Click any
data-column heading to switch between ascending and descending order. Newest runs
appear first by default; missing timing, date, and commit values stay last in either
direction. Sorting and expanded runs survive view changes. Full dates remain in
tooltips, and the last status-refresh time is in the status tooltip and expanded run
details rather than the main row. At narrow widths the table scrolls horizontally.
Expand any run for all jobs and steps, plus
validated external links to GitHub. Queued, running, waiting for approval, failed,
cancelled, and succeeded states remain distinct. No matching run and access/network
errors remain distinct. After a failed refresh, previous data stays visible with an
Unavailable status and its original check time.

The Repositories view includes **Watch main** beside the selected repository's
heading. It adds a latest-run watch for lowercase `main`, stays in the repository
view, and uses the existing validated/persisted watch operation. It reads **Watching
main** when any watch for that repository's `main` branch already exists. It never
switches the local checkout.

CI checks are independent of Git fetch, pull, push, checkout, staging, and commits.
With automatic refresh enabled in Settings, the open CI Watch view checks every
30 seconds (or the configured interval if shorter); in the background it uses the
configured repository interval. A zero interval disables automatic checks. Refresh
CI and entering the view still perform a check. Up to four watches refresh at once.
Job/step details load only for expanded rows and update after successful run checks.

## Ownership and contracts

- Electron main validates real repository/root paths, including symlinks and nested
  repositories, reads origin through argument-array Git calls, authenticates GitHub
  requests, paginates workflows/jobs, and stores watches in `AppSettings.ciWatches`.
- Preload exposes only typed `addCiWatch`, `removeCiWatch`, `getCiWorkflows`,
  `getCiRun`, and `getCiJobs` methods. The renderer receives no new credentials.
- React owns view selection, expanded rows, display state, and polling. Request
  generations discard results from a previous root/watch list. Discovery determines
  which saved watches belong in the current overview; switching roots retains other
  roots' watches without querying them.
- Workflow queries use branch plus an optional numeric workflow ID. Run details use
  numeric run ID and attempt so reruns show their own jobs. GitHub access uses the
  existing token configuration and HTTP(S) external-open validation.

## Change target

Implementation base: `96b0a605ce16ad6a59529014039df761d24ee30d`.
The working tree was clean before the original CI Watch implementation. The compact
rows, sorting, and quick-main-watch refinement includes that existing feature work;
no unrelated changes were present or excluded.
Scope: the accepted CI Watch view, its persistent watch configuration, typed IPC,
GitHub reads, and focused coverage. Application version and packaging are outside
this change.

## Verification

- Type-check, lint, production build, and the full Vitest suite passed (71 tests).
- The final CI integration run passed all eight cases, including the added folder
  alias regression, branch/workflow targeting, repository isolation, persisted
  watches, rerun jobs/steps, pagination, and root/symlink validation.
- The real Electron smoke test passed with isolated temporary repositories/settings
  and deterministic GitHub responses. It covers navigation, watch creation and
  removal, quick-main addition, sorting every data column, rows under 44 pixels at
  normal/minimum window sizes, separate timing/date cells, persistence after reload,
  expanded jobs, preserved view state, root rejection, and an unchanged checkout/
  working tree. The renderer required running this test outside the restricted
  sandbox.
- Screenshots were inspected at the normal and minimum supported window widths.
- Live authenticated GitHub requests were not exercised; provider responses in tests
  are fixtures. A pre-existing React act warning remains in the npm-output UI test.

## Deployment

On 6 October 2026, the user requested deployment of the compact-row, sorting, and
quick-main-watch refinements. `npm run package` passed and updated
`release/Repo Radar 1.0.0.exe` with the existing application version and artifact name.
The full Electron smoke test also passed against `release/win-unpacked/Repo Radar.exe`,
using isolated settings/repositories and deterministic provider responses.
