import assert from "node:assert/strict"
import test from "node:test"
import { isVersionNewer, latestReleasedChangelog } from "../src/update.ts"

test("release versions must strictly advance CalVer", () => {
  assert.equal(isVersionNewer("2026.8.1", "2026.8.2"), true)
  assert.equal(isVersionNewer("2026.8.2", "2026.9.1"), true)
  assert.equal(isVersionNewer("2026.8.2", "2027.1.1"), true)
  assert.equal(isVersionNewer("2026.8.2", "2026.8.2"), false)
  assert.equal(isVersionNewer("2026.8.2", "2026.8.1"), false)
  assert.equal(isVersionNewer("2026.8.2", "invalid"), false)
})

test("changelog projection excludes Unreleased and bounds releases", () => {
  const markdown = "# Changelog\n\n## [Unreleased]\n\n- hidden\n\n## [2026.8.2]\n\n- newest\n\n## [2026.8.1]\n\n- older\n"
  assert.equal(latestReleasedChangelog(markdown, 1), "## [2026.8.2]\n\n- newest")
})
