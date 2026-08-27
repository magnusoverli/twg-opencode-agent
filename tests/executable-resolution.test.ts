import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { canonicalExecutablePath, executableCandidates } from "../plugins/twg-agent.ts"

test("includes conventional user-local TWG executable fallbacks", () => {
  assert.deepEqual(
    executableCandidates("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test"),
    ["twg", join("C:\\Users\\test\\AppData\\Local", "Programs", "twg", "bin", "twg.exe")],
  )
  assert.deepEqual(
    executableCandidates("linux", {}, "/home/test"),
    ["twg", join("/home/test", ".local", "bin", "twg")],
  )
})

test("resolves Windows PATH regardless of environment key casing", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-resolution-"))
  const executable = join(root, "twg.exe")
  try {
    await writeFile(executable, "test")
    assert.equal(
      await canonicalExecutablePath("twg", { Path: root, PATHEXT: ".EXE" }, "win32"),
      await realpath(executable),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not treat an unresolved bare command as a verifiable file", async () => {
  assert.equal(await canonicalExecutablePath("twg-not-present", { PATH: "" }, process.platform), undefined)
})
