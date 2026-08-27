# Changelog

All user-visible changes to the TWG OpenCode agent are recorded here. The bundle uses CalVer
`YYYY.M.N`.

## [Unreleased]

## [2026.8.3] - 2026-08-27

### Changed

- Detected trusted TWG agent bundle updates now install automatically and show a five-second restart notification.
- Update status now distinguishes automatic bundle staging from an actual installer failure.
- TWG CLI now updates automatically through its own updater, refreshes official skills, accepts newer releases through live command contracts, and notifies users to restart OpenCode after a version change.
- TWG tool guidance now explicitly separates the command path from arguments and requires live contracts for unfamiliar grammar.
- First-time bundle installs and explicitly approved runtime repairs can now bootstrap a pinned compatible TWG CLI and official OpenCode skills from Atlassian without handling authentication.
- Removed references to unrelated OpenCode bundles so this package is documented as fully standalone.
- The README now starts with exact public GitHub install commands for Windows and macOS/Linux plus a guided getting-started section.
- TWG execution now uses cached exact command contracts, separate help/run/artifact tools, independent remote and local approvals, structured retry outcomes, and deterministic count-first routing.
- Large TWG results now use quota-limited session artifacts with integrity checks and bounded JSON field projection.
- Installation now stages versioned runtime files without in-place updates, validates dependencies and official skills, smoke-tests the plugin, and atomically activates releases without pruning unrelated skills.
- Update checks are non-blocking, share an ownership lock with installers, pin credential-free origins, and can require signed commits.
- `/twg-version` now reports explicit CLI compatibility, skill availability, update-check state, and startup configuration errors.

### Fixed

- `twg_run` and command-contract lookup now accept the documented `twg <command>` form instead of resolving it as a help command.
- Published the command-path normalization fix in a new bundle version so installed agents can receive it.
- TWG CLI discovery now falls back to conventional user-local install paths when a PATH launch cannot be canonicalized, including on macOS and Linux.
- The Windows installer now handles multiple OpenCode or TWG executables on `PATH` and atomically replaces existing installer-managed files with a valid backup path.
- Ambiguous command effects, nested `resolve` mutations, downloads, output-path aliases, timeouts, and changed executable identities now fail closed instead of bypassing approval.

## [2026.8.2] - 2026-08-27

### Fixed

- Published the TWG command-path normalization fix so installed agents can receive it.

## [2026.8.1] - 2026-08-26

### Added

- Initial standalone `twg` primary agent for Atlassian, Jira, and Confluence workflows.
- Independent Git auto-update checks with restart notifications and changelog state.
- Non-destructive Windows and POSIX installers that coexist with other OpenCode bundles.
- `/twg-version` and `/twg-changelog` commands.
