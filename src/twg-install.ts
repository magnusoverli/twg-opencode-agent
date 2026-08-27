import { homedir } from "node:os"
import { posix, win32 } from "node:path"

export const TWG_INSTALL_BASE_URL = "https://teamwork-graph.atlassian.com/cli"
export const TWG_AGENT_INSTALL_INSTRUCTIONS_URL = `${TWG_INSTALL_BASE_URL}/AGENTS.md`
export const MAX_INSTALLER_BYTES = 1024 * 1024

export type TwgInstallerPlan = {
  kind: "powershell" | "bash"
  installerUrl: string
  executablePath: string
  runner: string
  arguments: string[]
  syntaxCheck?: { runner: string; arguments: string[] }
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

export function createTwgInstallerPlan(
  version: string,
  installerPath: string,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): TwgInstallerPlan {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid pinned TWG CLI install version: ${version}`)
  const common = ["--version", version, "--skip-login", "--skip-skills", "--yes", "--plugin", "opencode"]
  if (platform === "win32") {
    const localAppData = environmentValue(environment, "LOCALAPPDATA")
    const systemRoot = environmentValue(environment, "SystemRoot") ?? environmentValue(environment, "WINDIR")
    if (!localAppData) throw new Error("LOCALAPPDATA is required to install TWG CLI on Windows.")
    if (!systemRoot) throw new Error("SystemRoot is required to invoke the Windows PowerShell installer safely.")
    return {
      kind: "powershell",
      installerUrl: `${TWG_INSTALL_BASE_URL}/install.ps1`,
      executablePath: win32.join(localAppData, "Programs", "twg", "bin", "twg.exe"),
      runner: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installerPath,
        "-Version",
        version,
        "-SkipLogin",
        "-SkipSkills",
        "-Yes",
        "-Plugin",
        "opencode",
      ],
    }
  }
  if (platform === "darwin" || platform === "linux") {
    return {
      kind: "bash",
      installerUrl: `${TWG_INSTALL_BASE_URL}/install`,
      executablePath: posix.join(home, ".local", "bin", "twg"),
      runner: "/bin/bash",
      arguments: [installerPath, ...common],
      syntaxCheck: { runner: "/bin/bash", arguments: ["-n", installerPath] },
    }
  }
  throw new Error(`TWG CLI installation is not supported on ${platform}.`)
}

export function validateOfficialInstaller(content: Uint8Array, kind: TwgInstallerPlan["kind"]): void {
  if (content.byteLength === 0 || content.byteLength > MAX_INSTALLER_BYTES) {
    throw new Error(`Official TWG installer must be between 1 and ${MAX_INSTALLER_BYTES} bytes.`)
  }
  const text = Buffer.from(content).toString("utf8")
  const markers = kind === "powershell"
    ? ["Param(", "SHA256SUMS-", "SkipLogin", "SkipSkills", "setup finalize"]
    : ["#!/usr/bin/env bash", "SHA256SUMS-", "--skip-login", "--skip-skills", "setup finalize"]
  if (!markers.every((marker) => text.includes(marker))) {
    throw new Error("The official TWG installer response did not match the expected installer structure.")
  }
}

export async function downloadOfficialInstaller(
  plan: TwgInstallerPlan,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await request(plan.installerUrl, {
    method: "GET",
    redirect: "error",
    signal,
    headers: { accept: "text/plain" },
  })
  if (!response.ok) throw new Error(`Official TWG installer download failed with HTTP ${response.status}.`)
  if (response.url !== plan.installerUrl) throw new Error("Official TWG installer download resolved to an unexpected URL.")
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INSTALLER_BYTES) {
    throw new Error(`Official TWG installer exceeds the ${MAX_INSTALLER_BYTES}-byte limit.`)
  }
  if (!response.body) throw new Error("Official TWG installer response had no body.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > MAX_INSTALLER_BYTES) {
      await reader.cancel()
      throw new Error(`Official TWG installer exceeds the ${MAX_INSTALLER_BYTES}-byte limit.`)
    }
    chunks.push(chunk.value)
  }
  const content = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  validateOfficialInstaller(content, plan.kind)
  return content
}

export function twgMaintenanceEnvironment(
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "appdata",
    "home",
    "http_proxy",
    "https_proxy",
    "lang",
    "lc_all",
    "localappdata",
    "node_extra_ca_certs",
    "no_proxy",
    "processor_architecture",
    "processor_architew6432",
    "programfiles",
    "programfiles(x86)",
    "shell",
    "ssl_cert_dir",
    "ssl_cert_file",
    "systemroot",
    "temp",
    "term",
    "tmp",
    "tmpdir",
    "twg_config_dir",
    "userprofile",
    "windir",
    "xdg_config_home",
    "xdg_data_home",
  ])
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(environment)) {
    if (allowed.has(key.toLowerCase())) result[key] = value
  }
  if (platform === "win32") {
    const systemRoot = environmentValue(environment, "SystemRoot") ?? environmentValue(environment, "WINDIR")
    if (!systemRoot) throw new Error("SystemRoot is required to build a safe TWG installer environment.")
    result.PATH = [
      win32.join(systemRoot, "System32"),
      systemRoot,
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";")
    result.COMSPEC = win32.join(systemRoot, "System32", "cmd.exe")
  } else {
    result.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
  }
  result.DO_NOT_TRACK = "1"
  return result
}

export function twgInstallerEnvironment(
  environment: NodeJS.ProcessEnv,
  version: string,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const result = twgMaintenanceEnvironment(environment, platform)
  result.TWG_INSTALL_BASE_URL = TWG_INSTALL_BASE_URL
  result.TWG_VERSION = version
  return result
}
