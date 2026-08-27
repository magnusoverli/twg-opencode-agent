import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const plugin = await readFile(new URL("../plugins/twg-agent.ts", import.meta.url), "utf8")
const powershellInstaller = await readFile(new URL("../install.ps1", import.meta.url), "utf8")
const posixInstaller = await readFile(new URL("../install.sh", import.meta.url), "utf8")

test("runtime update checks fetch without changing tracked checkout files", () => {
  const updateCheck = plugin.slice(plugin.indexOf("async function runUpdateCheck"), plugin.indexOf("async function installedSkillStatus"))
  assert.match(updateCheck, /\["fetch", "--quiet"\]/)
  assert.doesNotMatch(updateCheck, /\["(?:checkout|clean|merge|pull|rebase|reset|restore|switch)"/)
  assert.match(plugin, /never removes an existing lock/)
})

test("installers retain atomic activation and no-prune safety invariants", () => {
  for (const installer of [powershellInstaller, posixInstaller]) {
    assert.match(installer, /--no-prune/)
    assert.match(installer, /twg-installer-stage/)
    assert.match(installer, /twg-installer-version/)
    assert.match(installer, /opencode.*--version|--version.*opencode/is)
  }
  assert.match(powershellInstaller, /Publish-InstallerVersion/)
  assert.match(powershellInstaller, /Get-ManagedBootstrapRoot/)
  assert.match(posixInstaller, /publish_owned_version/)
  assert.match(posixInstaller, /managed_bootstrap_root/)
})
