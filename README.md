# TWG OpenCode Agent

A permanently installed OpenCode agent for TWG and Atlassian workflows. It works from any folder and
specializes in Jira, Confluence, Rovo-connected knowledge, engineering work, status rollups,
ownership discovery, and operational context.

The agent does not replace `opencode.json`, change the default agent, vendor official TWG skills, or
store credentials.

---

## Quick start (Windows)

**Before you start:** install Git, Node.js/npm, and OpenCode. You also need TWG access to your intended
Atlassian tenant. If TWG CLI is missing, the installer bootstraps a compatible version from Atlassian's
official public installer without starting login.

### 1. Install

Paste this single line into PowerShell:

```powershell
$repo='https://github.com/magnusoverli/twg-opencode-agent.git'; $d="$env:TEMP\twg-opencode-agent"; if (Test-Path $d) { Remove-Item -Recurse -Force $d }; git clone $repo $d; if ($?) { powershell -ExecutionPolicy Bypass -File "$d\install.ps1" }
```

Already in a checkout of this repository? Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### 2. Run

Open a new terminal, then start OpenCode from any folder:

```powershell
opencode
```

Select `twg` from the agent selector, then run:

```text
/twg-version
```

### 3. Use it

Try one of these requests:

- `Show my current Jira work.`
- `Find the latest Confluence pages about the release plan.`
- `Who owns this repository and who should review a change?`
- `Catch me up on PROJ-123.`

Use `/twg-changelog` to see recent agent changes.

---

## Quick start (macOS / Linux)

**Before you start:** install Git, Node.js/npm, and OpenCode. You also need TWG access to your intended
Atlassian tenant. If TWG CLI is missing, the installer bootstraps a compatible version from Atlassian's
official public installer without starting login.

### 1. Install

Paste this single line into your terminal:

```bash
repo='https://github.com/magnusoverli/twg-opencode-agent.git'; d="${TMPDIR:-/tmp}/twg-opencode-agent"; rm -rf -- "$d" && git clone "$repo" "$d" && bash "$d/install.sh"
```

Already in a checkout of this repository? Run:

```bash
bash install.sh
```

### 2. Run

Open a new terminal, then start OpenCode from any folder:

```bash
opencode
```

Select `twg` from the agent selector and run `/twg-version`.

### 3. Use it

Ask for Jira, Confluence, engineering, ownership, status, or cross-product context in plain language.
Use `/twg-changelog` to see recent agent changes.

---

## Getting started

1. Confirm the command-line tools are available:

   ```bash
   git --version
   node --version
   npm --version
   opencode --version
   twg --version
   ```

2. Confirm TWG can access your tenant:

   ```bash
   twg whoami
   ```

   If this fails, complete your organization's normal TWG CLI authentication before using the agent.
   The installer does not run login or inspect credentials.

3. Start `opencode`, select the `twg` agent, and run `/twg-version`. It reports the agent version,
   OpenCode and TWG CLI compatibility, official skill visibility, and update-check status.

4. Ask a focused question. The agent uses direct product reads for known Jira keys, Confluence pages,
   repositories, and other exact targets. For broader work, it starts with bounded, count-first
   discovery and hydrates only selected results.

5. Review any approval prompt carefully. Remote changes and local file access are authorized
   independently. The agent verifies current state before a mutation and verifies the result afterward.

The `twg` agent is selectable but is not made the default, so existing OpenCode workflows remain
unchanged.

## Requirements

- OpenCode `>=1.18.23` and `<2.0.0`
- TWG CLI `>=1.2.5`; the manifest records a tested range, while newer releases use their live command contracts
- Git with access to GitHub
- Node.js and npm
- Access to the intended Atlassian tenant through the TWG CLI

The installer validates these versions, bootstraps pinned TWG CLI `1.2.6` from Atlassian when missing,
installs official TWG skills without pruning unrelated skills, verifies that the root `twg` skill is
visible to OpenCode, and smoke-tests the plugin before activation. CLI bootstrap does not authenticate;
run `twg login` in a terminal when needed.

## How it works

- Releases are staged under the user's application-data directory in versioned directories whose
  tracked runtime files are not updated in place.
- A small bootstrap plugin under the global OpenCode `plugins/` directory imports the active version.
- The plugin registers the selectable `twg` primary agent, guarded TWG tools, `/twg-version`, and
  `/twg-changelog`.
- `twg_cli_install` can repair a missing CLI from Atlassian's fixed public installer after explicit
  approval; it skips authentication and verifies the installed version and OpenCode skills.
- Official skills remain managed by `twg skills install`; this repository does not redistribute them.
- Exact command contracts come from versioned JSON returned by
  `twg help describe <command> -o json`, so the agent does not rely on a drifting command catalog.
- Large TWG results are copied into quota-limited, session-scoped artifacts and can be read through
  `twg_artifact_read` with bounded JSON field projection.

Installed release directories:

- Windows: `%LOCALAPPDATA%\opencode\bundles\twg-agent-versions`
- macOS/Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/bundles/twg-agent-versions`

## Safety model

Read-only TWG operations may run directly. Before changing Jira, Confluence, or another Atlassian
product, the agent reads current state, describes the exact target and effect, obtains explicit user
approval, executes the typed command, and verifies the result.

Local reads and writes require a separate approval for the canonical paths involved. Setup, login,
credential, manual update, and administrative configuration commands require an explicit request. The agent
cannot invoke TWG through a shell: `twg_run` validates exact live command metadata and fails closed
when command arguments or effects cannot be proven safe. Other host tools are denied for this agent.
CLI installation uses a separate approval and a fixed Atlassian HTTPS source; the model cannot supply
an installer URL, command, destination, or version.

## Updates

TWG CLI auto-update is enabled by default. Five seconds after startup and every six hours, the plugin
runs TWG's own updater and refreshes official skills. When the CLI version changes, OpenCode displays
a notification that the release was installed and asks for a restart so the refreshed skills load.
Newer CLI versions continue to use exact live command contracts; the manifest's maximum remains an
advisory tested boundary rather than blocking the new release.

CLI update settings:

- `TWG_AGENT_CLI_AUTO_UPDATE=false` disables automatic TWG CLI updates.
- `TWG_AGENT_CLI_UPDATE_INTERVAL_MINUTES=<n>` changes the interval; minimum 1 minute.

On startup and every 15 minutes, the plugin performs a locked, non-blocking check of its tracked
branch. It may fetch Git metadata, but it never changes tracked runtime files or activates an update.
When a newer version is available, OpenCode displays a notification.

To install an available update, rerun the same installer command from **Quick start**, then restart
OpenCode. The installer validates, stages, smoke-tests, and atomically activates the new version while
preserving the prior active version on failure.

Agent bundle update-check settings:

- `TWG_AGENT_UPDATE_CHECK=false` disables update checks.
- `TWG_AGENT_UPDATE_CHECK_INTERVAL_MINUTES=<n>` changes the interval; minimum 1 minute.
- `TWG_AGENT_REQUIRE_SIGNED_COMMITS=true` requires `git verify-commit` before reporting a release.

The installer pins a credential-free origin URL. Update checks refuse a redirected origin or a
non-`origin/*` upstream.

## Development

Install dependencies and verify the repository:

```powershell
npm install
npm run typecheck
npm test
```

Register the current checkout directly on Windows:

```powershell
.\install.ps1 -Development
```

Development registration writes an ignored `.twg-development` marker and disables update checks for
that checkout. Remove the marker to re-enable checks, or run the normal installer to return to
versioned runtime files.

For a release:

1. Move user-facing entries from `[Unreleased]` into a dated version section in `CHANGELOG.md`.
2. Bump `VERSION` using CalVer `YYYY.M.N`.
3. Run `npm run typecheck` and `npm test`.
4. Commit and push the release to the tracked branch.

## Uninstall

Remove `twg-agent-bootstrap.ts` from the global OpenCode `plugins/` directory. You can also remove the
`twg-agent-versions` directory. Official TWG skills and TWG authentication are managed separately and
remain installed.
