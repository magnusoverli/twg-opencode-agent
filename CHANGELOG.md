# Changelog

All user-visible changes to the TWG OpenCode agent are recorded here. The bundle uses CalVer
`YYYY.M.N`.

## [Unreleased]

### Changed

- Removed references to unrelated OpenCode bundles so this package is documented as fully standalone.
- The README now starts with exact public GitHub install commands for Windows and macOS/Linux plus a guided getting-started section.
- TWG execution now uses cached exact command contracts, separate help/run/artifact tools, independent remote and local approvals, structured retry outcomes, and deterministic count-first routing.
- Large TWG results now use quota-limited session artifacts with integrity checks and bounded JSON field projection.
- Installation now stages versioned runtime files without in-place updates, validates dependencies and official skills, smoke-tests the plugin, and atomically activates releases without pruning unrelated skills.
- Update checks are now non-blocking and notification-only, share an ownership lock with installers, pin credential-free origins, and can require signed commits.
- `/twg-version` now reports explicit CLI compatibility, skill availability, update-check state, and startup configuration errors.

### Fixed

- Ambiguous command effects, nested `resolve` mutations, downloads, output-path aliases, timeouts, and changed executable identities now fail closed instead of bypassing approval.

## [2026.8.1] - 2026-08-26

### Added

- Initial standalone `twg` primary agent for Atlassian, Jira, and Confluence workflows.
- Independent Git auto-update checks with restart notifications and changelog state.
- Non-destructive Windows and POSIX installers that coexist with other OpenCode bundles.
- `/twg-version` and `/twg-changelog` commands.
