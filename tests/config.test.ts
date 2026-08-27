import assert from "node:assert/strict"
import test from "node:test"
import { registerTwgConfig } from "../src/config.ts"

test("registers a selectable primary agent without changing the default", () => {
  const config: any = { default_agent: "existing-primary", agent: { existing: { mode: "primary" } } }
  registerTwgConfig(config, {
    runningVersion: "2026.8.1",
    prompt: "Use TWG safely.",
  })

  assert.equal(config.default_agent, "existing-primary")
  assert.equal(config.agent.existing.mode, "primary")
  assert.equal(config.agent.twg.mode, "primary")
  assert.match(config.agent.twg.prompt, /2026\.8\.1/)
  assert.match(config.agent.twg.description, /cross-product workflows/)
  assert.equal(config.agent.twg.permission["*"], "deny")
  assert.equal(config.agent.twg.permission.twg_help, "allow")
  assert.equal(config.agent.twg.permission.twg_run, "allow")
  assert.equal(config.agent.twg.permission.twg_cli_install, "allow")
  assert.equal(config.agent.twg.permission.twg_artifact_read, "allow")
  assert.equal(config.agent.twg.permission.twg_mutation, "ask")
  assert.equal(config.agent.twg.permission.twg_local_access, "ask")
  assert.equal(config.agent.twg.permission.twg_installation, "ask")
  assert.equal(config.agent.twg.permission.read, undefined)
})

test("registers version and changelog commands", () => {
  const config: any = {}
  registerTwgConfig(config, { runningVersion: "1", prompt: "Prompt" })

  assert.equal(config.command["twg-version"].agent, "twg")
  assert.match(config.command["twg-version"].template, /twg_agent_status/)
  assert.match(config.command["twg-version"].template, /compatibility\.status/)
  assert.match(config.command["twg-version"].template, /skills\.available/)
  assert.match(config.command["twg-version"].template, /explicit install request/)
  assert.match(config.command["twg-version"].template, /cliUpdate\.restartRequired/)
  assert.doesNotMatch(config.command["twg-version"].template, /\$ARGUMENTS/)
  assert.equal(config.command["twg-changelog"].agent, "twg")
  assert.match(config.command["twg-changelog"].template, /releasedChangelog/)
  assert.doesNotMatch(config.command["twg-changelog"].template, /\$ARGUMENTS/)
})

test("refuses to overwrite an existing agent or command", () => {
  assert.throws(
    () => registerTwgConfig({ agent: { twg: {} } }, { runningVersion: "1", prompt: "Prompt" }),
    /already exists/,
  )
  assert.throws(
    () => registerTwgConfig({ command: { "twg-version": {} } }, { runningVersion: "1", prompt: "Prompt" }),
    /already exists/,
  )
})
