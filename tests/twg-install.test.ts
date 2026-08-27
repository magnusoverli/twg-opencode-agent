import assert from "node:assert/strict"
import { posix, win32 } from "node:path"
import test from "node:test"
import {
  TWG_AGENT_INSTALL_INSTRUCTIONS_URL,
  TWG_INSTALL_BASE_URL,
  MAX_INSTALLER_BYTES,
  createTwgInstallerPlan,
  downloadOfficialInstaller,
  twgInstallerEnvironment,
  twgMaintenanceEnvironment,
  validateOfficialInstaller,
} from "../src/twg-install.ts"

test("builds fixed official installer plans without caller-controlled sources", () => {
  const windows = createTwgInstallerPlan(
    "1.2.6",
    "C:\\Temp\\twg-install.ps1",
    "win32",
    { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", SystemRoot: "C:\\Windows" },
    "C:\\Users\\test",
  )
  assert.equal(windows.installerUrl, `${TWG_INSTALL_BASE_URL}/install.ps1`)
  assert.equal(windows.runner, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  assert.equal(windows.executablePath, win32.join("C:\\Users\\test\\AppData\\Local", "Programs", "twg", "bin", "twg.exe"))
  assert.deepEqual(windows.arguments.slice(-7), ["-Version", "1.2.6", "-SkipLogin", "-SkipSkills", "-Yes", "-Plugin", "opencode"])

  const linux = createTwgInstallerPlan("1.2.6", "/tmp/install.sh", "linux", {}, "/home/test")
  assert.equal(linux.installerUrl, `${TWG_INSTALL_BASE_URL}/install`)
  assert.equal(linux.executablePath, posix.join("/home/test", ".local", "bin", "twg"))
  assert.deepEqual(linux.syntaxCheck, { runner: "/bin/bash", arguments: ["-n", "/tmp/install.sh"] })
  assert.equal(TWG_AGENT_INSTALL_INSTRUCTIONS_URL, `${TWG_INSTALL_BASE_URL}/AGENTS.md`)
})

test("validates expected official installer structure and rejects unrelated content", () => {
  validateOfficialInstaller(
    Buffer.from("Param( $SkipLogin, $SkipSkills )\n# SHA256SUMS-\n# setup finalize"),
    "powershell",
  )
  validateOfficialInstaller(
    Buffer.from("#!/usr/bin/env bash\n# SHA256SUMS- --skip-login --skip-skills setup finalize"),
    "bash",
  )
  assert.throws(() => validateOfficialInstaller(Buffer.from("<html>not an installer</html>"), "bash"), /expected installer structure/)
})

test("pins installer source and removes unrelated or credential-bearing environment values", () => {
  assert.deepEqual(twgInstallerEnvironment({ TWG_INSTALL_BASE_URL: "https://example.invalid", PATH: "unsafe", TWG_TOKEN: "secret", KEEP: "no" }, "1.2.6", "linux"), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    DO_NOT_TRACK: "1",
    TWG_INSTALL_BASE_URL: TWG_INSTALL_BASE_URL,
    TWG_VERSION: "1.2.6",
  })
  assert.deepEqual(twgMaintenanceEnvironment({ PATH: "unsafe", TWG_TOKEN: "secret" }, "linux"), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    DO_NOT_TRACK: "1",
  })
})

test("downloads installer responses with a streaming size limit and no redirects", async () => {
  const plan = createTwgInstallerPlan("1.2.6", "/tmp/install.sh", "linux", {}, "/home/test")
  const installer = Buffer.from("#!/usr/bin/env bash\n# SHA256SUMS- --skip-login --skip-skills setup finalize")
  const response = (body: Uint8Array, url = plan.installerUrl) => ({
    ok: true,
    status: 200,
    url,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close() } }),
  }) as Response

  assert.deepEqual(
    await downloadOfficialInstaller(plan, undefined, async () => response(installer)),
    new Uint8Array(installer),
  )
  await assert.rejects(
    downloadOfficialInstaller(plan, undefined, async () => response(new Uint8Array(MAX_INSTALLER_BYTES + 1))),
    /exceeds/,
  )
  await assert.rejects(
    downloadOfficialInstaller(plan, undefined, async () => response(installer, "https://example.invalid/install")),
    /unexpected URL/,
  )
})
