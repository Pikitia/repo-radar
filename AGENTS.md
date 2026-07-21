# Repo Radar

## Scope and precedence

Repo Radar is an independent Electron/React Windows desktop application for inspecting and operating on many local Git repositories. `AGENTS.md` is the repository-wide authority. A nearer nested `AGENTS.md` overrides it only for that subtree. Product requirements and design documents explain behavior but do not override safety rules here.

## Repository map

- `electron`: privileged Electron main/preload code, settings, Git discovery/status/diff/actions, and commit-message integration.
- `src`: sandboxed React renderer, state, types, and UI components.
- `tests/unit`, `tests/integration`, and `tests/ui`: Vitest suites.
- `tests/electron-smoke.mjs`: packaged/runtime Electron smoke test.
- `docs`: requirements, product/technical plan, and verification plan.
- `assets` and `scripts/generate-icon.mjs`: application icon sources/tooling.

## Setup and commands

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Use `npm run test:unit` or `npm run test:integration` for focused work. `npm run electron` builds Electron code and opens the desktop app; `npm run test:electron-smoke` launches Electron and may require a suitable Windows desktop environment. `npm run package` builds the Windows portable executable.

## Architecture and safety invariants

- Keep filesystem, Git, process spawning, settings, and external-open operations in the Electron main process. The renderer must use the typed preload API; keep `contextIsolation: true` and `nodeIntegration: false`.
- Validate repository/file paths against the selected root before privileged operations. Preserve `shell: false` and argument-array execution; do not construct shell commands from repository names, paths, commit messages, or file names.
- Treat scanned repositories as independent Git repositories, including nested-repository discovery. Never apply one repository's status, branch, scripts, or actions to another.
- Preserve explicit staged/unstaged/untracked distinctions and safety checks for commit, pull, push, sync, and version bump operations. Tests must use temporary fixture repositories, never real workspace repositories.
- Only open validated HTTP(S) URLs externally. Do not expose arbitrary IPC, filesystem reads, commands, credentials, or provider secrets to renderer content.
- Local relative TypeScript imports include `.js`; maintain shared API/type contracts across `electron`, `src/types`, and preload declarations.

## Generated files and packaging

Do not hand-edit `dist`, `dist-electron`, `release`, coverage output, or dependency directories. Regenerate icon files only through the existing script when requested.

Package deliverables only into `release/`. The handoff executable remains `release/Repo Radar 1.0.0.exe` unless the user explicitly requests a name/version change. Do not use alternate output folders or filenames. If release files are locked, stop and ask the user to close Repo Radar or the locking process; do not package elsewhere or copy around the lock.

Packaging opens/builds platform-specific tooling and should run only when requested. Do not change application version or artifact naming as an incidental edit.

## Validation and definition of done

Run focused tests during development, then type-check, lint, test, and build for cross-cutting changes. Git action/discovery changes require integration coverage; IPC/preload changes require contract checks on both main and renderer sides; packaging/runtime changes require the Electron smoke test when the environment supports it. Review the complete diff and report pre-existing or environment-specific failures separately.

## References

- `docs/requirements.md`
- `docs/product-spec.md`
- `docs/technical-plan.md`
- `docs/verification-plan.md`
- `prompts/build-repo-radar.md`
- `package.json` for authoritative scripts and packaging configuration.
