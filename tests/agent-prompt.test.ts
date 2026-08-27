import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const prompt = await readFile(new URL("../agent/twg.md", import.meta.url), "utf8")

test("routes unfamiliar TWG requests through bounded skill and command discovery", () => {
  assert.match(prompt, /twg_help/)
  assert.match(prompt, /discover-skills/)
  assert.match(prompt, /do not\s+rediscover unless the user's intent changes/)
})

test("defines the canonical tool command shape and requires live contracts for unfamiliar grammar", () => {
  assert.match(prompt, /\["jira", "workitem", "get"\]/)
  assert.match(prompt, /without `twg`/)
  assert.match(prompt, /action:"describe"/)
  assert.match(prompt, /only its returned contract/)
})

test("requires bounded agent output and search hydration", () => {
  assert.match(prompt, /counts/)
  assert.match(prompt, /compactInline/)
  assert.match(prompt, /twg_artifact_read/)
  assert.match(prompt, /native reads supply/)
})

test("preserves mutation and control-plane safety without duplicating product documentation", () => {
  assert.match(prompt, /obtain explicit user approval/)
  assert.match(prompt, /Do not run setup, login, authentication, install, update, upkeep/)
  assert.match(prompt, /Local file access/)
  assert.match(prompt, /twg_cli_install/)
  assert.match(prompt, /never performs login/)
  assert.match(prompt, /automatically runs TWG's own updater/)
})
