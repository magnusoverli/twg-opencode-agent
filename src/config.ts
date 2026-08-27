type OpenCodeConfig = {
  agent?: Record<string, unknown>
  command?: Record<string, unknown>
}

export function registerTwgConfig(
  config: OpenCodeConfig,
  opts: { runningVersion: string; prompt: string },
): void {
  config.agent ??= {}
  config.command ??= {}

  if (config.agent.twg !== undefined) throw new Error("Cannot register TWG agent: config.agent.twg already exists")
  if (config.command["twg-version"] !== undefined) throw new Error("Cannot register TWG agent: /twg-version already exists")
  if (config.command["twg-changelog"] !== undefined) throw new Error("Cannot register TWG agent: /twg-changelog already exists")

  config.agent.twg = {
    description: "TWG specialist for Atlassian products, Teamwork Graph, Rovo knowledge, and cross-product workflows.",
    mode: "primary",
    color: "accent",
    prompt: `${opts.prompt.trim()}\n\nRunning TWG agent bundle version: ${opts.runningVersion}.`,
    permission: {
      "*": "deny",
      skill: "allow",
      twg_help: "allow",
      twg_run: "allow",
      twg_cli_install: "allow",
      twg_artifact_read: "allow",
      twg_mutation: "ask",
      twg_local_access: "ask",
      twg_installation: "ask",
      twg_agent_status: "allow",
    },
  }

  config.command["twg-version"] = {
    description: "Show the running TWG agent bundle and CLI versions",
    agent: "twg",
    template: [
      "Call `twg_agent_status` and report the running TWG agent bundle version and TWG CLI version.",
      "Report a warning when `twg.compatibility.status` is `outdated` or `unknown`; treat `untested` as an advisory because live command contracts remain enabled.",
      "Report a warning when `openCodeCompatibility.status` is not `compatible`.",
      "Report a warning when `skills.available` is not true.",
      "If `twg.available` is false, say that an explicit install request can run the guarded official CLI bootstrap.",
      "If `bundleUpdatePending` is present, say that restarting OpenCode loads the on-disk bundle.",
      "If `cliUpdate.restartRequired` is true, say that restarting OpenCode loads the refreshed TWG skills.",
      "Report `cliUpdate.error` only when present.",
      "If `update.restartRequired` is true, say that restarting OpenCode loads the automatically installed TWG agent bundle.",
      "Point to `/twg-changelog` for release notes. Keep the answer to 1-3 short lines.",
    ].join("\n"),
  }

  config.command["twg-changelog"] = {
    description: "Show what's new in the TWG OpenCode agent",
    agent: "twg",
    template: [
      "Call `twg_agent_status` and use its `releasedChangelog` field.",
      "Show the latest 2-3 released versions and never include the Unreleased section.",
      "Use concise plain text grouped by version. If status reports a newer available version, say to rerun the installer.",
    ].join("\n"),
  }
}
