import assert from "node:assert/strict"
import test from "node:test"
import {
  buildTwgEnvironment,
  canRunTwgCommands,
  evaluateRuntimeCompatibility,
  evaluateTwgCliCompatibility,
  parseBooleanSetting,
  parseCompatibilityManifest,
  parseIntervalMinutes,
} from "../src/twg-runtime.ts"

const manifest = parseCompatibilityManifest({
  schemaVersion: 1,
  twgCli: { minimum: "1.2.5", maximumTestedExclusive: "1.3.0", installVersion: "1.2.6" },
  helpContractVersions: [1],
  opencode: { minimum: "1.18.23", maximumTestedExclusive: "2.0.0" },
  requiredFiles: ["VERSION"],
  requiredSkills: ["twg"],
})

test("evaluates the OpenCode runtime against an explicit range", () => {
  assert.equal(evaluateRuntimeCompatibility("OpenCode", "opencode 1.18.23", "1.18.23", "2.0.0").status, "compatible")
  assert.equal(evaluateRuntimeCompatibility("OpenCode", "2.0.0", "1.18.23", "2.0.0").status, "untested")
})

test("distinguishes compatible, outdated, untested, and unknown CLI versions", () => {
  assert.equal(evaluateTwgCliCompatibility("1.2.5", manifest).status, "compatible")
  assert.equal(evaluateTwgCliCompatibility("1.2.6-beta", manifest).status, "unknown")
  assert.equal(evaluateTwgCliCompatibility("1.2.4", manifest).status, "outdated")
  assert.equal(evaluateTwgCliCompatibility("1.3.0", manifest).status, "untested")
  assert.equal(evaluateTwgCliCompatibility("1.2.6.7", manifest).status, "unknown")
  assert.equal(evaluateTwgCliCompatibility("development", manifest).status, "unknown")
  assert.equal(canRunTwgCommands(evaluateTwgCliCompatibility("1.2.6", manifest)), true)
  assert.equal(canRunTwgCommands(evaluateTwgCliCompatibility("1.3.0", manifest)), true)
  assert.equal(canRunTwgCommands(evaluateTwgCliCompatibility("1.2.4", manifest)), false)
})

test("enables bounded agent output without overriding an explicit host setting", () => {
  assert.equal(buildTwgEnvironment({ PATH: "test" }).TWG_AGENT_DEFAULTS, "1")
  assert.equal(buildTwgEnvironment({ TWG_AGENT_DEFAULTS: "0" }).TWG_AGENT_DEFAULTS, "0")
})

test("strictly parses updater settings", () => {
  assert.deepEqual(parseBooleanSetting(" false ", true), { value: false })
  assert.equal(parseBooleanSetting("yes", true).error !== undefined, true)
  assert.deepEqual(parseIntervalMinutes("30"), { value: 30 })
  assert.equal(parseIntervalMinutes("Infinity").error !== undefined, true)
})

test("validates compatibility manifests", () => {
  assert.throws(() => parseCompatibilityManifest({ schemaVersion: 2 }), /Invalid input/)
  assert.throws(
    () => parseCompatibilityManifest({
      schemaVersion: 1,
      twgCli: { minimum: "1.2.5", maximumTestedExclusive: "1.3.0", installVersion: "1.3.0" },
      helpContractVersions: [1],
      opencode: { minimum: "1.18.23", maximumTestedExclusive: "2.0.0" },
      requiredFiles: ["VERSION"],
      requiredSkills: ["twg"],
    }),
    /installVersion/,
  )
})
