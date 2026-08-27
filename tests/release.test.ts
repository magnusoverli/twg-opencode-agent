import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("VERSION has a matching released changelog section", async () => {
  const version = (await readFile(new URL("../VERSION", import.meta.url), "utf8")).trim()
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8")
  assert.match(version, /^\d{4}\.\d+\.\d+$/)
  assert.match(changelog, new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m"))
})
