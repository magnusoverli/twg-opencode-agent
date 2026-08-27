import assert from "node:assert/strict"
import test from "node:test"
import { executionStatus } from "../plugins/twg-agent.ts"
import type { TwgCommandEffects } from "../src/twg-command.ts"
import type { SpawnResult } from "../src/twg-process.ts"

const mutation: TwgCommandEffects = { remote: "write", local: "none", dryRun: false, reasons: [], paths: [] }
const base: SpawnResult = {
  exitCode: null,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  stdout: { text: "", bytes: 0 },
  stderr: { text: "", bytes: 0 },
}

test("all abnormal mutation outcomes require state verification before retry", () => {
  for (const result of [
    { ...base, spawnError: "output quota exceeded" },
    { ...base, exitCode: 3 },
    { ...base, timedOut: true },
    { ...base, aborted: true },
  ]) {
    const status = executionStatus(result, mutation)
    assert.equal(status.retry, "read_current_state_before_retry")
    assert.equal(status.outcome, "mutation_outcome_unknown")
  }
})

test("abnormal local writes require destination inspection before retry", () => {
  const localWrite: TwgCommandEffects = { remote: "read", local: "write", dryRun: false, reasons: [], paths: [] }
  const status = executionStatus({ ...base, timedOut: true }, localWrite)
  assert.equal(status.retry, "inspect_local_destination_before_retry")
  assert.equal(status.outcome, "local_write_outcome_unknown")
})
