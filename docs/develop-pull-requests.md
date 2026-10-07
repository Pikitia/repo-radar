# Merge origin/develop into origin/main

The merge icon beside the repository toolbar's other icon buttons appears when the remote Develop/Main comparison has loaded, both origin branches exist, and origin/develop contains commits absent from origin/main. Refresh repositories to fetch the latest remote comparison.

Click the icon to fetch origin and review a confirmation showing the repository, remote commit IDs, direction and commit count. Cancel performs no GitHub writes. Confirm creates or reuses an open GitHub pull request from develop into main and enables GitHub auto-merge. If GitHub already reports clean merge eligibility and successful checks, Repo Radar merges with a guard against changes to the confirmed develop commit.

The source is always origin/develop. Local develop, the current checkout, staged files and uncommitted changes are never pushed or changed by this action. The resulting merge updates main on GitHub; local main is updated through the normal fetch/pull actions.

## GitHub setup

- Origin must point to github.com. Other Git hosting providers are not supported by this integration.
- In Repo Radar Settings, configure a fine-grained GitHub token with access to the target repository, **Pull requests → Read and write**, **Contents → Read and write**, and **Commit statuses → Read-only**. Existing Actions monitoring also needs **Actions → Read-only**. The user verified that adding Commit statuses read access resolved the merge-phase permission error with their existing fine-grained token. Environment mode uses GITHUB_TOKEN or GH_TOKEN.
- In GitHub repository Settings, enable **Allow auto-merge** and **Allow merge commits**. Merge commits preserve the shared history of these long-lived branches.
- Protect main with the required status checks and reviews you want GitHub to wait for. Auto-merge follows GitHub's required checks and review rules and continues after Repo Radar closes. Future pushes to develop while auto-merge waits are included by GitHub.

GitHub controls authorization and branch rules. Repo Radar does not override branch protections, force push, resolve conflicts or alter repository settings. If GitHub cannot enable or perform the merge, the dialog retains the PR link and explains the next action. Retrying reuses the open PR. An uncertain network response requires checking the PR in GitHub before retrying.

If PR creation succeeds but GitHub reports "Resource not accessible by personal access token" during the merge phase, first check **Commit statuses → Read-only** and **Contents → Read and write**, as well as repository access and any required organisation approval. GitHub does not offer a Checks permission for fine-grained personal tokens and [lists direct Checks API access as unsupported](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations). That limitation did not prevent the user’s verified flow after granting Commit statuses read access; this does not establish compatibility with every third-party check provider. The current error can also originate from a merge mutation, so this message alone does not identify the precise rejected GraphQL field or operation. Check the existing PR before retrying; retries reuse an open develop-to-main PR.

All app buttons have native hover tooltips. Repository icon actions also have accessible names.

## Verification

Temporary Git fixtures cover remote eligibility, pruning, unchanged local state, changed commit guards, root/path validation and unsupported origins. Mocked GitHub responses cover creating/reusing PRs, pending/failing checks, successful checked merges, draft PRs, disabled auto-merge, permissions and errors. Renderer tests cover confirmation, cancellation, fresh previews and duplicate submission prevention; preload tests cover both typed IPC channels.

A real GitHub check-to-auto-merge run requires a test repository with the settings above. Automated checks do not create or merge PRs in real repositories.

## Production package

On 8 October 2026, the user requested the production update after closing Repo Radar. `npm run package` passed and rebuilt `release/Repo Radar 1.0.0.exe` using the existing application version and artifact name. The full Electron smoke test also passed against `release/win-unpacked/Repo Radar.exe`, including both new pull request IPC channels' root validation, with isolated settings, temporary repositories and mocked provider responses.
