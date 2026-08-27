import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const plugin = await readFile(new URL("../plugins/twg-agent.ts", import.meta.url), "utf8")
const powershellInstaller = await readFile(new URL("../install.ps1", import.meta.url), "utf8")
const posixInstaller = await readFile(new URL("../install.sh", import.meta.url), "utf8")

test("runtime update checks hand trusted newer bundles to the staged installer", () => {
  const updateCheck = plugin.slice(plugin.indexOf("async function runUpdateCheck"), plugin.indexOf("async function installedSkillStatus"))
  assert.match(updateCheck, /\["fetch", "--quiet"\]/)
  assert.doesNotMatch(updateCheck, /\["(?:checkout|clean|merge|pull|rebase|reset|restore|switch)"/)
  assert.match(updateCheck, /updateState\.restartRequired/)
  assert.match(updateCheck, /runBundleAutoUpdate\(pendingUpdate\.version, pendingUpdate\.origin, signal\)/)
  assert.match(plugin, /never removes an existing lock/)
  assert.match(plugin, /, 5_000\)/)
  assert.match(plugin, /Restart OpenCode to use it\./)
})

test("CLI auto-update uses the fixed self-updater and requests restart only after a version change", () => {
  const cliUpdate = plugin.slice(plugin.indexOf("async function runCliAutoUpdate"), plugin.indexOf("async function acquireUpdateLock"))
  assert.match(cliUpdate, /\["update", "--yes", "--refresh-skills"\]/)
  assert.match(cliUpdate, /Restart OpenCode to load refreshed TWG skills/)
  assert.match(cliUpdate, /installedVersion !== beforeCompatibility\.installedVersion/)
  assert.doesNotMatch(cliUpdate, /restartRequired = false/)
  assert.doesNotMatch(cliUpdate, /twg\.installVersion/)
})

test("TWG command execution is serialized against CLI replacement", () => {
  const commandExecution = plugin.slice(plugin.indexOf("const approvedLocalPaths"), plugin.indexOf("twg_cli_install:"))
  assert.match(commandExecution, /acquireCliMaintenanceLock\(\)/)
  assert.match(commandExecution, /releaseCliMaintenanceLock\(executionLock\)/)
  assert.ok(commandExecution.indexOf("acquireCliMaintenanceLock()") < commandExecution.indexOf("runProcess(resolved.executable"))
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
  assert.match(powershellInstaller, /function Get-FirstApplicationPath/)
  assert.match(powershellInstaller, /\$commands\[0\]\.Path/)
  assert.doesNotMatch(powershellInstaller, /Replace\(\$temporary,\s*\$Path,\s*\$null/)
  assert.match(posixInstaller, /publish_owned_version/)
  assert.match(posixInstaller, /managed_bootstrap_root/)
})

test("installers bootstrap a pinned CLI from Atlassian without login", () => {
  for (const installer of [powershellInstaller, posixInstaller]) {
    assert.match(installer, /https:\/\/teamwork-graph\.atlassian\.com\/cli/)
    assert.match(installer, /installVersion/)
    assert.match(installer, /skip.?login/is)
    assert.match(installer, /skip.?skills/is)
    assert.match(installer, /opencode/)
  }
  assert.match(posixInstaller, /bash -n/)
  assert.match(powershellInstaller, /newer than the tested range/)
  assert.match(posixInstaller, /newer than the tested range/)
})
