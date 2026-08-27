# Working on the TWG OpenCode agent

Add a concise, user-facing line under `## [Unreleased]` in `CHANGELOG.md` for every noticeable
change.

Do not vendor TWG skills or credentials. The installer obtains official skills through the TWG CLI,
and authentication remains managed by TWG outside this repository.

After changing `plugins/` or `src/`, run `npm run typecheck` and `npm test`.
