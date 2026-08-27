import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { link, lstat, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { Plugin, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import { registerTwgConfig } from "../src/config.ts"
import {
  assertKnownTwgEffects,
  classifyTwgCommand,
  displayTwgCommand,
  parseTwgCommandMetadata,
  validateTwgArguments,
  type TwgCommandEffects,
  type TwgCommandMetadata,
} from "../src/twg-command.ts"
import { extractTwgOutputFiles, runProcess, stopActiveProcesses, TwgArtifactStore, type SpawnResult } from "../src/twg-process.ts"
import {
  buildTwgEnvironment,
  canRunTwgCommands,
  evaluateRuntimeCompatibility,
  evaluateTwgCliCompatibility,
  parseBooleanSetting,
  parseCompatibilityManifest,
  parseIntervalMinutes,
  type CompatibilityManifest,
} from "../src/twg-runtime.ts"
import { isVersionNewer, latestReleasedChangelog } from "../src/update.ts"
import {
  TWG_AGENT_INSTALL_INSTRUCTIONS_URL,
  createTwgInstallerPlan,
  downloadOfficialInstaller,
  twgInstallerEnvironment,
  twgMaintenanceEnvironment,
} from "../src/twg-install.ts"

const pexec = promisify(execFile)
const bundleRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."))
const expectedOriginPath = join(bundleRoot, ".twg-update-origin")
const bundleHash = createHash("sha256").update(bundleRoot).digest("hex").slice(0, 16)
const updateLockPath = join(tmpdir(), `twg-agent-update-${bundleHash}.lock`)
const cliInstallLockPath = join(tmpdir(), `twg-cli-install-${createHash("sha256").update(homedir()).digest("hex").slice(0, 16)}.lock`)
const artifactRoot = join(tmpdir(), "twg-opencode-agent", `${process.pid}-${randomUUID()}`)
const twgEnv = buildTwgEnvironment()

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ASKPASS",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
    "SSH_ASKPASS",
  ]) {
    delete env[key]
  }
  return env
}

const gitEnv = sanitizedGitEnvironment()

async function git(args: string[], timeout = 60_000, signal?: AbortSignal): Promise<string> {
  const result = await pexec("git", ["-C", bundleRoot, ...args], {
    timeout,
    signal,
    env: gitEnv,
    maxBuffer: 2 * 1024 * 1024,
  })
  return result.stdout.trim()
}

export function executableCandidates(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const candidates = ["twg"]
  if (platform === "win32" && environment.LOCALAPPDATA) candidates.push(join(environment.LOCALAPPDATA, "Programs", "twg", "bin", "twg.exe"))
  else if (platform !== "win32") candidates.push(join(home, ".local", "bin", "twg"))
  return [...new Set(candidates)]
}

function assertCredentialFreeOrigin(value: string): void {
  if (!/^https?:\/\//i.test(value)) return
  const parsed = new URL(value)
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Git origin contains credentials, a query, or a fragment; configure a credential-free origin URL.")
  }
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

export async function canonicalExecutablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<string | undefined> {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) return await realpath(executable)
  const extensions = platform === "win32" ? (environmentValue(environment, "PATHEXT") ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const entry of (environmentValue(environment, "PATH") ?? "").split(delimiter).filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, "")
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" ? `${executable}${extension.toLowerCase()}` : executable)
      if (existsSync(candidate)) return await realpath(candidate)
    }
  }
  return undefined
}

function processText(result: SpawnResult, stream: "stdout" | "stderr"): string {
  return result[stream].text?.trim() ?? ""
}

function compactContract(metadata: TwgCommandMetadata): unknown {
  const output = metadata.output as (Record<string, unknown> & { agentFieldPresets?: Record<string, unknown> }) | undefined
  return {
    type: metadata.type,
    ver: metadata.ver,
    cmd: metadata.cmd,
    path: metadata.path,
    desc: metadata.desc,
    args: metadata.args,
    opts: metadata.opts,
    inheritedOpts: metadata.inheritedOpts,
    guards: metadata.guards,
    input: metadata.input,
    examples: metadata.examples ?? metadata.ex,
    tier: metadata.tier,
    enrichmentKind: metadata.enrichmentKind,
    enrichmentReason: metadata.enrichmentReason,
    output: output
      ? {
          largeOutputRisk: output.largeOutputRisk,
          recommendedSummary: output.recommendedSummary,
          recommendedAgentFields: output.recommendedAgentFields,
          recommendedView: output.recommendedView,
          presets: Object.keys(output.agentFieldPresets ?? {}),
          notes: output.notes,
        }
      : undefined,
  }
}

export function executionStatus(result: SpawnResult, effects: TwgCommandEffects): { status: string; retry: string; outcome: string } {
  const uncertainMutation = effects.remote !== "read"
    ? { retry: "read_current_state_before_retry", outcome: "mutation_outcome_unknown" }
    : effects.local === "write"
      ? { retry: "inspect_local_destination_before_retry", outcome: "local_write_outcome_unknown" }
      : null
  if (result.aborted) {
    return uncertainMutation
      ? { status: "aborted", ...uncertainMutation }
      : { status: "aborted", retry: "only_if_user_requests", outcome: "interrupted" }
  }
  if (result.timedOut) {
    return uncertainMutation
      ? { status: "timeout", ...uncertainMutation }
      : { status: "timeout", retry: "retry_with_a_larger_explicit_timeout_if_needed", outcome: "no_complete_result" }
  }
  if (result.spawnError) {
    return uncertainMutation
      ? { status: "runtime_error", ...uncertainMutation }
      : { status: "runtime_error", retry: "fix_runtime_before_retry", outcome: "not_started_or_unknown" }
  }
  if (result.exitCode === 0) return { status: "success", retry: "not_needed", outcome: "completed" }
  if (result.exitCode === 2) {
    return uncertainMutation
      ? { status: "validation_error", ...uncertainMutation }
      : { status: "validation_error", retry: "apply_error_repair_once", outcome: "rejected" }
  }
  if (result.exitCode === 3) {
    return uncertainMutation
      ? { status: "partial", ...uncertainMutation }
      : { status: "partial", retry: "use_returned_cursor_or_guidance", outcome: "partial_results_available" }
  }
  if (result.exitCode === 77) {
    return uncertainMutation
      ? { status: "authentication_required", ...uncertainMutation }
      : { status: "authentication_required", retry: "do_not_retry_unchanged", outcome: "not_authorized" }
  }
  return {
    status: "failed",
    retry: uncertainMutation?.retry ?? "follow_twg_error_guidance",
    outcome: uncertainMutation?.outcome ?? "failed",
  }
}

function defaultTimeout(command: string[], args: string[]): number {
  const path = command.join(" ")
  return path.startsWith("bitbucket pipeline ") && (["wait", "tail", "grep"].includes(command.at(-1) ?? "") || args.includes("--wait"))
    ? 15 * 60_000
    : 120_000
}

function validateInvocation(command: string[], args: string[]): void {
  if (command.length > 8) throw new Error("TWG command paths may contain at most 8 segments.")
  if (!command.every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment))) {
    throw new Error("TWG command must be an exact lowercase command path without arguments or options.")
  }
  if (args.length > 256) throw new Error("TWG invocation exceeds the 256-argument limit.")
  if (args.some((argument) => argument.length > 64 * 1024)) throw new Error("One TWG argument exceeds 64 KiB.")
  if (args.reduce((total, argument) => total + Buffer.byteLength(argument), 0) > 512 * 1024) {
    throw new Error("TWG arguments exceed the 512 KiB total limit; use a reviewed input file instead.")
  }
}

export const TwgAgentPlugin: Plugin = async ({ client }) => {
  let startupError: string | undefined
  let runningVersion = "unknown"
  let manifest: CompatibilityManifest
  let prompt: string
  try {
    runningVersion = (await readFile(join(bundleRoot, "VERSION"), "utf8")).trim()
    manifest = parseCompatibilityManifest(JSON.parse(await readFile(join(bundleRoot, "compatibility.json"), "utf8")))
    prompt = await readFile(join(bundleRoot, "agent", "twg.md"), "utf8")
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error)
    manifest = parseCompatibilityManifest({
      schemaVersion: 1,
      twgCli: { minimum: "1.2.5", maximumTestedExclusive: "1.3.0", installVersion: "1.2.6" },
      helpContractVersions: [1],
      opencode: { minimum: "1.18.23", maximumTestedExclusive: "2.0.0" },
      requiredFiles: ["VERSION"],
      requiredSkills: ["twg"],
    })
    prompt = "The TWG agent bundle is damaged. Use `twg_agent_status` and report its startup error; do not run TWG product commands."
  }

  const updateCheck = parseBooleanSetting(process.env.TWG_AGENT_UPDATE_CHECK, true)
  const signedCommits = parseBooleanSetting(process.env.TWG_AGENT_REQUIRE_SIGNED_COMMITS, false)
  const interval = parseIntervalMinutes(process.env.TWG_AGENT_UPDATE_CHECK_INTERVAL_MINUTES)
  const cliAutoUpdate = parseBooleanSetting(process.env.TWG_AGENT_CLI_AUTO_UPDATE, true)
  const cliUpdateInterval = parseIntervalMinutes(process.env.TWG_AGENT_CLI_UPDATE_INTERVAL_MINUTES, 360)
  const development = existsSync(join(bundleRoot, ".twg-development"))
  const artifactStore = new TwgArtifactStore()
  const metadataCache = new Map<string, Promise<TwgCommandMetadata>>()
  let executablePromise: Promise<{ executable: string; canonicalPath: string; identity: string; version: string }> | undefined
  let cliMaintenanceActive = false

  async function acquireCliMaintenanceLock(): Promise<{ handle: Awaited<ReturnType<typeof open>>; token: string }> {
    const token = randomUUID()
    try {
      const handle = await open(cliInstallLockPath, "wx", 0o600)
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }))
      return { handle, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Another OpenCode process is installing or updating TWG CLI. Wait for it to finish, then inspect the current state.")
      }
      throw error
    }
  }

  async function releaseCliMaintenanceLock(lock: { handle: Awaited<ReturnType<typeof open>>; token: string }): Promise<void> {
    await lock.handle.close().catch(() => undefined)
    try {
      const owner = JSON.parse(await readFile(cliInstallLockPath, "utf8")) as { token?: string }
      if (owner.token === lock.token) await unlink(cliInstallLockPath)
    } catch {
      // Never remove a lock that cannot be proven to belong to this operation.
    }
  }

  async function verifyExecutable(executable: string): Promise<{
    executable: string
    canonicalPath: string
    identity: string
    version: string
  }> {
    const result = await runProcess(executable, ["--version"], {
      timeoutMs: 10_000,
      env: twgEnv,
      inlineLimit: 64 * 1024,
      artifactRoot,
    })
    const version = processText(result, "stdout") || processText(result, "stderr")
    if (result.spawnError || result.exitCode !== 0 || !version) {
      throw new Error(result.spawnError ?? `${executable} --version exited with ${result.exitCode}`)
    }
    const canonicalPath = await canonicalExecutablePath(executable)
    if (!canonicalPath) throw new Error(`${executable} started but its executable path could not be resolved`)
    const info = await stat(canonicalPath)
    return { executable: canonicalPath, canonicalPath, identity: `${canonicalPath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, version }
  }

  async function resolveExecutable(): Promise<{ executable: string; canonicalPath: string; identity: string; version: string }> {
    if (executablePromise) return await executablePromise
    executablePromise = (async () => {
      const diagnostics: string[] = []
      let firstVerified: { executable: string; canonicalPath: string; identity: string; version: string } | undefined
      for (const executable of executableCandidates()) {
        try {
          const verified = await verifyExecutable(executable)
          firstVerified ??= verified
          const compatibility = evaluateTwgCliCompatibility(verified.version, manifest)
          if (canRunTwgCommands(compatibility)) return verified
          diagnostics.push(`${executable}: ${compatibility.message}`)
        } catch (error) {
          diagnostics.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (firstVerified) return firstVerified
      throw new Error(`TWG CLI resolution failed. ${diagnostics.join("; ")}`)
    })()
    try {
      return await executablePromise
    } catch (error) {
      executablePromise = undefined
      throw error
    }
  }

  async function currentExecutable(): Promise<{ executable: string; canonicalPath: string; identity: string; version: string }> {
    if (!executablePromise) return await resolveExecutable()
    const resolved = await executablePromise
    try {
      const info = await stat(resolved.canonicalPath)
      const identity = `${resolved.canonicalPath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
      if (identity === resolved.identity) return resolved
    } catch {}
    executablePromise = undefined
    metadataCache.clear()
    return await resolveExecutable()
  }

  async function commandMetadata(
    command: string[],
    signal?: AbortSignal,
  ): Promise<{ metadata: TwgCommandMetadata; identity: string }> {
    const resolved = await currentExecutable()
    const compatibility = evaluateTwgCliCompatibility(resolved.version, manifest)
    if (!canRunTwgCommands(compatibility)) throw new Error(compatibility.message)
    const key = `${resolved.identity}\0${resolved.version}\0${command.join("\0")}`
    let pending = metadataCache.get(key)
    if (!pending) {
      pending = (async () => {
        const result = await runProcess(resolved.executable, ["help", "describe", ...command, "-o", "json"], {
          timeoutMs: 10_000,
          signal,
          env: twgEnv,
          inlineLimit: 2 * 1024 * 1024,
          artifactRoot,
        })
        const stdout = processText(result, "stdout")
        if (result.exitCode !== 0 || !stdout) {
          throw new Error(processText(result, "stderr") || `No executable TWG contract found for ${command.join(" ")}.`)
        }
        const metadata = parseTwgCommandMetadata(JSON.parse(stdout), manifest.helpContractVersions)
        if (metadata.path.join(" ") !== command.join(" ")) {
          throw new Error(`TWG help resolved ${metadata.path.join(" ")} instead of requested ${command.join(" ")}.`)
        }
        return metadata
      })()
      metadataCache.set(key, pending)
    }
    try {
      return { metadata: await pending, identity: resolved.identity }
    } catch (error) {
      metadataCache.delete(key)
      throw error
    }
  }

  async function canonicalizeLocalEffects(effects: TwgCommandEffects): Promise<void> {
    for (const localPath of effects.paths) {
      if (localPath.path === "<command default>") continue
      try {
        localPath.absolutePath = await realpath(localPath.absolutePath)
        continue
      } catch {
        if (localPath.mode === "read") throw new Error(`Local input does not exist: ${localPath.absolutePath}`)
      }
      const tail: string[] = []
      let cursor = localPath.absolutePath
      while (true) {
        const entry = await lstat(cursor).catch(() => null)
        if (entry?.isSymbolicLink()) throw new Error(`Local output contains a dangling symbolic link: ${cursor}`)
        const parent = dirname(cursor)
        tail.unshift(basename(cursor))
        try {
          localPath.absolutePath = join(await realpath(parent), ...tail)
          break
        } catch {
          if (parent === cursor) throw new Error(`Could not resolve a safe parent for ${localPath.absolutePath}`)
          cursor = parent
        }
      }
    }
  }

  function pathWithin(root: string, candidate: string): boolean {
    const child = relative(root, candidate)
    return child === "" || (!child.startsWith("..") && !isAbsolute(child))
  }

  async function registerArtifacts(context: ToolContext, result: SpawnResult) {
    const records = []
    if (result.stdout.path) {
      const record = await artifactStore.register(context.sessionID, result.stdout.path, "process-stdout", true)
      if (record) records.push(record)
    }
    if (result.stderr.path) {
      const record = await artifactStore.register(context.sessionID, result.stderr.path, "process-stderr", true)
      if (record) records.push(record)
    }
    const stdout = result.stdout.text ?? ""
    const trustedTwgRoot = await realpath(join(tmpdir(), "twg")).catch(() => join(tmpdir(), "twg"))
    for (const output of extractTwgOutputFiles(stdout)) {
      const canonical = await realpath(output.path).catch(() => "")
      if (!canonical || !pathWithin(trustedTwgRoot, canonical)) continue
      const record = await artifactStore.register(context.sessionID, canonical, output.kind)
      if (record) records.push(record)
    }
    return records
  }

  type UpdateState = {
    checking: boolean
    lastAttemptAt?: string
    lastSuccessAt?: string
    blocked?: string
    error?: string
    availableVersion?: string
    availableRef?: string
  }
  const updateState: UpdateState = { checking: false }
  let lastNotifiedVersion: string | null = null

  async function showUpdateMessage(message: string): Promise<void> {
    try {
      await client.tui.showToast({ body: { title: "TWG Agent", message, variant: "info", duration: 20_000 } })
    } catch {
      await client.app.log({ body: { service: "twg-agent-update-check", level: "warn", message } }).catch(() => undefined)
    }
  }

  type CliUpdateState = {
    checking: boolean
    lastAttemptAt?: string
    lastSuccessAt?: string
    installedVersion?: string
    updatedFrom?: string
    restartRequired?: boolean
    error?: string
  }
  const cliUpdateState: CliUpdateState = { checking: false }
  let currentCliUpdate: Promise<void> | undefined
  let cliUpdateAbort: AbortController | undefined

  async function runCliAutoUpdate(): Promise<void> {
    if (!cliAutoUpdate.value || development || startupError || cliMaintenanceActive || cliUpdateState.checking) return
    cliMaintenanceActive = true
    let maintenanceLock: Awaited<ReturnType<typeof acquireCliMaintenanceLock>> | undefined
    cliUpdateState.checking = true
    cliUpdateState.lastAttemptAt = new Date().toISOString()
    cliUpdateState.error = undefined
    cliUpdateAbort = new AbortController()
    try {
      maintenanceLock = await acquireCliMaintenanceLock()
      const before = await currentExecutable()
      const beforeCompatibility = evaluateTwgCliCompatibility(before.version, manifest)
      if (!beforeCompatibility.installedVersion) throw new Error("Could not determine the installed TWG CLI version before update.")
      await assertUnlinkedInstallPaths([before.canonicalPath, ...skillInstallPaths()])
      const result = await runProcess(before.executable, ["update", "--yes", "--refresh-skills"], {
        env: twgMaintenanceEnvironment(twgEnv),
        timeoutMs: 10 * 60_000,
        signal: cliUpdateAbort.signal,
        inlineLimit: 256 * 1024,
        artifactRoot,
      })
      if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.aborted) {
        const detail = processText(result, "stderr") || processText(result, "stdout") || result.spawnError || `exit ${result.exitCode}`
        throw new Error(detail.slice(0, 4_096))
      }
      const after = await verifyExecutable(before.canonicalPath)
      const afterCompatibility = evaluateTwgCliCompatibility(after.version, manifest)
      if (!afterCompatibility.installedVersion) throw new Error("Could not determine the TWG CLI version after update.")
      executablePromise = Promise.resolve(after)
      metadataCache.clear()
      const skills = await installedSkillStatus()
      if (!skills.available) throw new Error("TWG CLI updated, but required OpenCode skills are unavailable after refresh.")
      cliUpdateState.lastSuccessAt = new Date().toISOString()
      cliUpdateState.installedVersion = afterCompatibility.installedVersion
      if (afterCompatibility.installedVersion !== beforeCompatibility.installedVersion) {
        cliUpdateState.updatedFrom = beforeCompatibility.installedVersion
        cliUpdateState.restartRequired = true
        await showUpdateMessage(
          `TWG CLI ${afterCompatibility.installedVersion} was available and has been installed. Restart OpenCode to load refreshed TWG skills.`,
        )
      }
    } catch (error) {
      cliUpdateState.error = error instanceof Error ? error.message : String(error)
      await client.app
        .log({ body: { service: "twg-cli-auto-update", level: "warn", message: `CLI auto-update skipped: ${cliUpdateState.error}` } })
        .catch(() => undefined)
    } finally {
      cliUpdateState.checking = false
      cliUpdateAbort = undefined
      cliMaintenanceActive = false
      if (maintenanceLock) await releaseCliMaintenanceLock(maintenanceLock)
    }
  }

  function startCliAutoUpdate(): void {
    if (currentCliUpdate) return
    currentCliUpdate = runCliAutoUpdate().finally(() => {
      currentCliUpdate = undefined
    })
  }

  async function acquireUpdateLock(): Promise<{ handle: Awaited<ReturnType<typeof open>>; token: string } | null> {
    try {
      const handle = await open(updateLockPath, "wx")
      return { handle, token: randomUUID() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // The short-lived installer owns stale-lock recovery. The runtime checker
      // never removes an existing lock, avoiding compare/unlink takeover races.
      return null
    }
  }

  let updateAbort: AbortController | undefined
  let currentUpdate: Promise<void> | undefined

  async function runUpdateCheck(): Promise<void> {
    if (!updateCheck.value || development || startupError || !existsSync(join(bundleRoot, ".git")) || updateState.checking) return
    const lock = await acquireUpdateLock().catch(() => null)
    if (!lock) return
    updateAbort = new AbortController()
    const signal = updateAbort.signal
    updateState.checking = true
    updateState.lastAttemptAt = new Date().toISOString()
    updateState.error = undefined
    try {
      await lock.handle.writeFile(JSON.stringify({ token: lock.token, pid: process.pid, updatedAt: updateState.lastAttemptAt }))
      const topLevel = await realpath(await git(["rev-parse", "--show-toplevel"], 60_000, signal))
      if (topLevel !== (await realpath(bundleRoot))) throw new Error("Git top-level does not match the installed bundle root")
      const before = await git(["rev-parse", "HEAD"], 60_000, signal)
      const beforeVersion = (await git(["show", `${before}:VERSION`], 60_000, signal)).trim()
      const expectedOrigin = (await readFile(expectedOriginPath, "utf8")).trim()
      const actualOrigin = await git(["remote", "get-url", "origin"], 60_000, signal)
      assertCredentialFreeOrigin(expectedOrigin)
      assertCredentialFreeOrigin(actualOrigin)
      const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 60_000, signal)
      if (!expectedOrigin || expectedOrigin !== actualOrigin || !upstream.startsWith("origin/")) {
        updateState.blocked = "configured Git origin or upstream does not match the installer-pinned origin"
        return
      }
      await git(["fetch", "--quiet"], 60_000, signal)
      const target = await git(["rev-parse", "@{u}"], 60_000, signal)
      if (before === target) {
        updateState.blocked = undefined
        updateState.availableVersion = undefined
        updateState.availableRef = undefined
        updateState.lastSuccessAt = new Date().toISOString()
        return
      }
      const targetVersion = (await git(["show", `${target}:VERSION`], 60_000, signal)).trim()
      if (!isVersionNewer(beforeVersion, targetVersion)) {
        updateState.blocked = `remote commit ${target.slice(0, 7)} does not advance VERSION beyond ${beforeVersion}`
        return
      }
      if (signedCommits.value) await git(["verify-commit", target], 60_000, signal)
      updateState.availableVersion = targetVersion
      updateState.availableRef = target
      updateState.blocked = undefined
      updateState.lastSuccessAt = new Date().toISOString()
      if (lastNotifiedVersion !== targetVersion) {
        lastNotifiedVersion = targetVersion
        await showUpdateMessage(`TWG agent ${targetVersion} is available. Re-run the installer to stage and activate it safely.`)
      }
    } catch (error) {
      updateState.error = error instanceof Error ? error.message : String(error)
      await client.app
        .log({ body: { service: "twg-agent-update-check", level: "warn", message: `update skipped: ${updateState.error}` } })
        .catch(() => undefined)
    } finally {
      updateState.checking = false
      updateAbort = undefined
      await lock.handle.close().catch(() => undefined)
      const quarantine = `${updateLockPath}.release-${process.pid}-${lock.token}`
      try {
        await rename(updateLockPath, quarantine)
        const owner = JSON.parse(await readFile(quarantine, "utf8")) as { token?: string }
        if (owner.token === lock.token) await unlink(quarantine)
        else {
          await link(quarantine, updateLockPath).catch(() => undefined)
          await unlink(quarantine).catch(() => undefined)
        }
      } catch {
        // A missing or replaced lock is never removed by token guesswork.
      }
    }
  }

  async function installedSkillStatus(): Promise<{
    available: boolean
    skills: Array<{ skill: string; available: boolean; paths: string[]; identities: string[] }>
  }> {
    const roots = [
      join(homedir(), ".config", "opencode", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".claude", "skills"),
    ]
    const skills = await Promise.all(manifest.requiredSkills.map(async (skill) => {
      const paths = []
      const identities = []
      for (const root of roots) {
        const rootInfo = await lstat(root).catch(() => null)
        const skillRoot = join(root, skill)
        const skillRootInfo = await lstat(skillRoot).catch(() => null)
        const path = join(root, skill, "SKILL.md")
        const info = await lstat(path).catch(() => null)
        if (
          rootInfo?.isDirectory() && !rootInfo.isSymbolicLink() &&
          skillRootInfo?.isDirectory() && !skillRootInfo.isSymbolicLink() &&
          info?.isFile() && !info.isSymbolicLink()
        ) {
          paths.push(path)
          identities.push(`${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`)
        }
      }
      return { skill, available: paths.length > 0, paths, identities }
    }))
    return { available: skills.every((skill) => skill.available), skills }
  }

  async function assertUnlinkedInstallPaths(paths: string[]): Promise<void> {
    for (const path of paths) {
      let cursor = path
      while (true) {
        const info = await lstat(cursor).catch(() => null)
        if (info?.isSymbolicLink()) throw new Error(`TWG installation path contains a symbolic link: ${cursor}`)
        const parent = dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
    }
  }

  function skillInstallPaths(): string[] {
    const roots = [
      join(homedir(), ".config", "opencode", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".claude", "skills"),
    ]
    return roots.flatMap((root) => manifest.requiredSkills.flatMap((skill) => [root, join(root, skill), join(root, skill, "SKILL.md")]))
  }

  async function agentStatus(): Promise<unknown> {
    let cli: unknown
    try {
      const resolved = await currentExecutable()
      cli = {
        available: true,
        executable: resolved.executable,
        version: resolved.version,
        compatibility: evaluateTwgCliCompatibility(resolved.version, manifest),
      }
    } catch (error) {
      cli = { available: false, error: error instanceof Error ? error.message : String(error) }
    }
    const diskVersion = await readFile(join(bundleRoot, "VERSION"), "utf8").then((value) => value.trim()).catch(() => "unknown")
    const openCodeResult = await runProcess("opencode", ["--version"], {
      timeoutMs: 10_000,
      env: process.env,
      inlineLimit: 64 * 1024,
      artifactRoot,
    })
    const openCodeCompatibility = evaluateRuntimeCompatibility(
      "OpenCode",
      processText(openCodeResult, "stdout") || processText(openCodeResult, "stderr") || undefined,
      manifest.opencode.minimum,
      manifest.opencode.maximumTestedExclusive,
    )
    return {
      bundleVersion: runningVersion,
      bundleDiskVersion: diskVersion,
      bundleUpdatePending: diskVersion !== runningVersion ? `Restart OpenCode to load bundle ${diskVersion}.` : undefined,
      bundleRoot,
      releasedChangelog: latestReleasedChangelog(await readFile(join(bundleRoot, "CHANGELOG.md"), "utf8").catch(() => "")),
      startupError,
      configurationErrors: [updateCheck.error, signedCommits.error, interval.error, cliAutoUpdate.error, cliUpdateInterval.error].filter(Boolean),
      updateCheckRequested: updateCheck.value,
      updateCheckEnabled: updateCheck.value && !development && !startupError && existsSync(join(bundleRoot, ".git")),
      updateCheckIntervalMinutes: interval.value,
      development,
      requireSignedCommits: signedCommits.value,
      update: updateState,
      cliAutoUpdateRequested: cliAutoUpdate.value,
      cliAutoUpdateEnabled: cliAutoUpdate.value && !development && !startupError,
      cliUpdateIntervalMinutes: cliUpdateInterval.value,
      cliUpdate: cliUpdateState,
      compatibility: manifest,
      openCodeCompatibility,
      skills: await installedSkillStatus(),
      twg: cli,
    }
  }

  function startUpdateCheck(): void {
    if (currentUpdate) return
    currentUpdate = runUpdateCheck().finally(() => {
      currentUpdate = undefined
    })
  }

  let initialTimer: NodeJS.Timeout | undefined
  let intervalTimer: NodeJS.Timeout | undefined
  let cliInitialTimer: NodeJS.Timeout | undefined
  let cliIntervalTimer: NodeJS.Timeout | undefined
  if (updateCheck.value && !development && !startupError) {
    initialTimer = setTimeout(startUpdateCheck, 1_000)
    initialTimer.unref()
    intervalTimer = setInterval(startUpdateCheck, interval.value * 60_000)
    intervalTimer.unref()
  }
  if (cliAutoUpdate.value && !development && !startupError) {
    cliInitialTimer = setTimeout(startCliAutoUpdate, 5_000)
    cliInitialTimer.unref()
    cliIntervalTimer = setInterval(startCliAutoUpdate, cliUpdateInterval.value * 60_000)
    cliIntervalTimer.unref()
  }

  return {
    config: async (config) => registerTwgConfig(config, { runningVersion, prompt }),
    tool: {
      twg_help: {
        description: "Search TWG help, inspect a namespace, discover an official skill reference, or return a cached compact contract for one exact executable command.",
        args: {
          action: z.enum(["search", "namespace", "describe", "discover-skills"]),
          terms: z.array(z.string()).max(12).default([]),
        },
        async execute(input: { action: "search" | "namespace" | "describe" | "discover-skills"; terms: string[] }, context: ToolContext) {
          if (input.action === "describe") {
            if (input.terms.length === 0) throw new Error("describe requires an exact executable command path")
            return JSON.stringify(compactContract((await commandMetadata(input.terms, context.abort)).metadata))
          }
          if (input.action === "discover-skills" && input.terms.length === 0) throw new Error("discover-skills requires an intent")
          const resolved = await currentExecutable()
          const args =
            input.action === "search"
              ? input.terms.length === 0
                ? ["help"]
                : ["help", ...input.terms, "--limit", "12", "--brief"]
              : input.action === "namespace"
                ? input.terms.length === 0
                  ? ["help"]
                  : ["help", "describe", ...input.terms]
                : ["help", "discover-skills", input.terms.join(" ")]
          const result = await runProcess(resolved.executable, args, {
            cwd: context.directory,
            env: twgEnv,
            timeoutMs: 15_000,
            signal: context.abort,
            inlineLimit: 256 * 1024,
            artifactRoot,
          })
          const effects: TwgCommandEffects = { remote: "read", local: "none", dryRun: false, reasons: ["local help"], paths: [] }
           const artifacts = await registerArtifacts(context, result)
          return JSON.stringify({
            ...executionStatus(result, effects),
            stdoutInline: result.stdout.text?.trim(),
            stderrInline: result.stderr.text?.trim(),
            artifacts: artifacts.map(({ id, kind, bytes, filename }) => ({ id, kind, bytes, filename })),
          })
        },
      } satisfies ToolDefinition,
      twg_run: {
        description: "Run one exact TWG executable command without a shell. Contracts are cached; remote and local effects are independently approved; results and retries are structured.",
        args: {
          command: z.array(z.string()).min(1).max(8),
          arguments: z.array(z.string()).max(256).default([]),
          timeoutMs: z.number().int().min(1_000).max(30 * 60_000).optional(),
        },
        async execute(
          input: { command: string[]; arguments: string[]; timeoutMs?: number },
          context: ToolContext,
        ) {
          if (startupError) throw new Error(`TWG agent bundle startup failed: ${startupError}`)
          validateInvocation(input.command, input.arguments)
          let described = await commandMetadata(input.command, context.abort)
          let resolved = await currentExecutable()
          if (resolved.identity !== described.identity) {
            described = await commandMetadata(input.command, context.abort)
            resolved = await currentExecutable()
            if (resolved.identity !== described.identity) throw new Error("TWG CLI changed during command validation; retry after it stabilizes.")
          }
          let metadata = described.metadata
          validateTwgArguments(input.arguments, metadata)
          const effects = classifyTwgCommand(input.arguments, metadata, context.directory)
          assertKnownTwgEffects(effects, metadata)
          const executionArguments = [...input.arguments]
          const display = displayTwgCommand(input.command, input.arguments)
          if (effects.remote !== "read") {
            await context.ask({
              permission: "twg_mutation",
              patterns: [display],
              always: [],
              metadata: {
                command: metadata.cmd,
                remoteEffect: effects.remote,
                localEffect: effects.local,
                dryRun: effects.dryRun,
                reasons: effects.reasons,
                paths: effects.paths.map(({ mode, option, absolutePath, overwrite }) => ({ mode, option, absolutePath, overwrite })),
              },
            })
          }
          if (effects.local !== "none") {
            const requestedPaths = effects.paths.map((path) => path.absolutePath)
            await context.ask({
              permission: "twg_local_access",
              patterns: effects.paths.length > 0 ? effects.paths.map((path) => `${display} -> ${path.absolutePath}`) : [display],
              always: [],
              metadata: {
                command: metadata.cmd,
                localEffect: effects.local,
                paths: effects.paths.map(({ mode, option, absolutePath, overwrite }) => ({ mode, option, absolutePath, overwrite })),
              },
            })
            await canonicalizeLocalEffects(effects)
            for (const path of effects.paths) {
              if (path.argumentIndex === undefined || path.path === "<command default>") continue
              executionArguments[path.argumentIndex] = path.inline
                ? `${executionArguments[path.argumentIndex].slice(0, executionArguments[path.argumentIndex].indexOf("=") + 1)}${path.absolutePath}`
                : path.absolutePath
            }
            if (effects.paths.some((path, index) => path.absolutePath !== requestedPaths[index])) {
              await context.ask({
                permission: "twg_local_access",
                patterns: effects.paths.map((path) => `${display} -> ${path.absolutePath}`),
                always: [],
                metadata: {
                  command: metadata.cmd,
                  localEffect: effects.local,
                  reason: "canonical path differs from the requested path",
                  paths: effects.paths.map(({ mode, option, absolutePath, overwrite }) => ({ mode, option, absolutePath, overwrite })),
                },
              })
            }
          }
          const approvedLocalPaths = effects.paths.map((path) => path.absolutePath)
          const executionLock = await acquireCliMaintenanceLock()
          try {
            resolved = await currentExecutable()
            if (resolved.identity !== described.identity) throw new Error("TWG CLI changed after approval; retry after it stabilizes.")
            if (effects.local !== "none") {
              await canonicalizeLocalEffects(effects)
              if (effects.paths.some((path, index) => path.absolutePath !== approvedLocalPaths[index])) {
                throw new Error("An approved local path changed before execution; refusing to run the command.")
              }
            }
            const result = await runProcess(resolved.executable, [...input.command, ...executionArguments], {
              cwd: context.directory,
              env: twgEnv,
              timeoutMs: input.timeoutMs ?? defaultTimeout(input.command, input.arguments),
              signal: context.abort,
              inlineLimit: 64 * 1024,
              artifactRoot,
            })
            const artifacts = await registerArtifacts(context, result)
            const compact = artifacts.find((artifact) => artifact.kind === "compact" && artifact.bytes <= 32 * 1024)
            const compactInline = compact ? await artifactStore.read(context.sessionID, compact.id, 32 * 1024) : undefined
            const status = executionStatus(result, effects)
            return {
              title: `${metadata.cmd}: ${status.status}`,
              output: JSON.stringify({
                ok: status.status === "success",
                ...status,
                command: metadata.cmd,
                tier: metadata.tier,
                effects,
                process: {
                  exitCode: result.exitCode,
                  signal: result.signal,
                  timedOut: result.timedOut,
                  aborted: result.aborted,
                  durationMs: result.durationMs,
                  stdoutBytes: result.stdout.bytes,
                  stderrBytes: result.stderr.bytes,
                },
                stdoutInline: result.stdout.text?.trim(),
                stderrInline: result.stderr.text?.trim(),
                compactInline: compactInline?.data,
                artifacts: artifacts.map(({ id, kind, bytes, filename }) => ({ id, kind, bytes, filename })),
              }),
              metadata: { command: metadata.cmd, status: status.status, tier: metadata.tier, artifacts: artifacts.length },
            }
          } finally {
            await releaseCliMaintenanceLock(executionLock)
          }
        },
      } satisfies ToolDefinition,
      twg_cli_install: {
        description: "Install a missing compatible TWG CLI and official OpenCode skills from Atlassian's fixed public installer without performing login or handling credentials.",
        args: {},
        async execute(_input: Record<string, never>, context: ToolContext) {
          if (cliMaintenanceActive) throw new Error("A TWG CLI installation or update is already running in this OpenCode session.")
          cliMaintenanceActive = true
          let maintenanceLock: Awaited<ReturnType<typeof acquireCliMaintenanceLock>>
          try {
            maintenanceLock = await acquireCliMaintenanceLock()
          } catch (error) {
            cliMaintenanceActive = false
            throw error
          }
          try {
          if (startupError) throw new Error(`TWG agent bundle startup failed: ${startupError}`)

          async function inspectCli() {
            try {
              const resolved = await currentExecutable()
              return { resolved, compatibility: evaluateTwgCliCompatibility(resolved.version, manifest) }
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error) }
            }
          }

          let inspection = await inspectCli()
          await assertUnlinkedInstallPaths(skillInstallPaths())
          let skillStatus = await installedSkillStatus()
          if (inspection.compatibility && canRunTwgCommands(inspection.compatibility) && skillStatus.available) {
            return JSON.stringify({
              status: "already_ready",
              executable: inspection.resolved?.executable,
              version: inspection.compatibility.installedVersion,
              skills: skillStatus,
            })
          }
          const approvedSnapshot = JSON.stringify({
            identity: inspection.resolved?.identity,
            status: inspection.compatibility?.status ?? "missing",
            skills: skillStatus.skills,
          })

          const approvalPlan = createTwgInstallerPlan(manifest.twgCli.installVersion, join(tmpdir(), "twg-official-installer"))
          const installBinary = !inspection.compatibility || !canRunTwgCommands(inspection.compatibility)
          if (installBinary) await assertUnlinkedInstallPaths([approvalPlan.executablePath])
          const approvedPlan = JSON.stringify({
            installerUrl: approvalPlan.installerUrl,
            executablePath: approvalPlan.executablePath,
            runner: approvalPlan.runner,
            kind: approvalPlan.kind,
          })
          await context.ask({
            permission: "twg_installation",
            patterns: [
              installBinary
                ? `Install TWG CLI ${manifest.twgCli.installVersion} to ${approvalPlan.executablePath} and install official OpenCode skills`
                : `Install official TWG OpenCode skills using ${inspection.resolved?.executable}`,
            ],
            always: [],
            metadata: {
              installBinary,
              version: manifest.twgCli.installVersion,
              installerUrl: approvalPlan.installerUrl,
              instructionsUrl: TWG_AGENT_INSTALL_INSTRUCTIONS_URL,
              executablePath: approvalPlan.executablePath,
              localPaths: [approvalPlan.executablePath, ...skillInstallPaths()],
              authentication: "skipped",
              skills: manifest.requiredSkills,
            },
          })

          inspection = await inspectCli()
          skillStatus = await installedSkillStatus()
          const currentSnapshot = JSON.stringify({
            identity: inspection.resolved?.identity,
            status: inspection.compatibility?.status ?? "missing",
            skills: skillStatus.skills,
          })
          if (currentSnapshot !== approvedSnapshot) {
            throw new Error("TWG CLI or skill state changed during installation approval; inspect the new state and retry.")
          }

          const requireSuccess = (result: SpawnResult, label: string): void => {
            if (result.exitCode === 0 && !result.spawnError && !result.timedOut && !result.aborted) return
            const detail = processText(result, "stderr") || processText(result, "stdout") || result.spawnError || `exit ${result.exitCode}`
            throw new Error(`${label} failed: ${detail.slice(0, 4_096)}`)
          }

          let resolved = inspection.resolved
          let installedBinary = false
          if (!inspection.compatibility || !canRunTwgCommands(inspection.compatibility)) {
            const installRoot = await mkdtemp(join(tmpdir(), "twg-cli-install-"))
            const installerPath = join(installRoot, process.platform === "win32" ? "install.ps1" : "install.sh")
            const plan = createTwgInstallerPlan(manifest.twgCli.installVersion, installerPath)
            if (JSON.stringify({
              installerUrl: plan.installerUrl,
              executablePath: plan.executablePath,
              runner: plan.runner,
              kind: plan.kind,
            }) !== approvedPlan) {
              throw new Error("The TWG installer plan changed after approval; refusing to continue.")
            }
            const installEnvironment = twgInstallerEnvironment(twgEnv, manifest.twgCli.installVersion)
            try {
              const content = await downloadOfficialInstaller(plan, context.abort)
              await writeFile(installerPath, content, { flag: "wx", mode: 0o600 })
              const beforeSpawn = await inspectCli()
              const beforeSpawnSkills = await installedSkillStatus()
              await assertUnlinkedInstallPaths([plan.executablePath, ...skillInstallPaths()])
              if (JSON.stringify({
                identity: beforeSpawn.resolved?.identity,
                status: beforeSpawn.compatibility?.status ?? "missing",
                skills: beforeSpawnSkills.skills,
              }) !== approvedSnapshot) {
                throw new Error("TWG CLI or skill state changed before installer execution; refusing to continue.")
              }
              if (plan.syntaxCheck) {
                const syntaxResult = await runProcess(plan.syntaxCheck.runner, plan.syntaxCheck.arguments, {
                  env: installEnvironment,
                  timeoutMs: 30_000,
                  signal: context.abort,
                  inlineLimit: 64 * 1024,
                  artifactRoot,
                })
                requireSuccess(syntaxResult, "Official TWG installer syntax validation")
              }
              const installResult = await runProcess(plan.runner, plan.arguments, {
                env: installEnvironment,
                timeoutMs: 10 * 60_000,
                signal: context.abort,
                inlineLimit: 256 * 1024,
                artifactRoot,
              })
              requireSuccess(installResult, "Official TWG CLI installer")
            } finally {
              await rm(installRoot, { recursive: true, force: true })
            }
            executablePromise = undefined
            metadataCache.clear()
            resolved = await verifyExecutable(plan.executablePath)
            const compatibility = evaluateTwgCliCompatibility(resolved.version, manifest)
            if (compatibility.status !== "compatible") throw new Error(`Installed CLI verification failed: ${compatibility.message}`)
            if (compatibility.installedVersion !== manifest.twgCli.installVersion) {
              throw new Error(`Official installer produced TWG CLI ${compatibility.installedVersion ?? "unknown"}; expected ${manifest.twgCli.installVersion}.`)
            }
            executablePromise = Promise.resolve(resolved)
            installedBinary = true
          }

          skillStatus = await installedSkillStatus()
          if (!skillStatus.available) {
            if (!resolved) throw new Error("TWG CLI was not available after installation.")
            await assertUnlinkedInstallPaths(skillInstallPaths())
            const skillResult = await runProcess(
              resolved.executable,
              ["skills", "install", "--agent", "opencode", "--yes", "--no-prune"],
              {
                cwd: context.directory,
                env: twgInstallerEnvironment(twgEnv, manifest.twgCli.installVersion),
                timeoutMs: 5 * 60_000,
                signal: context.abort,
                inlineLimit: 256 * 1024,
                artifactRoot,
              },
            )
            requireSuccess(skillResult, "Official TWG OpenCode skill installation")
            skillStatus = await installedSkillStatus()
            if (!skillStatus.available) throw new Error("TWG CLI completed skill installation, but required OpenCode skills are still unavailable.")
          }

          const verified = await currentExecutable()
          return JSON.stringify({
            status: "installed",
            installedBinary,
            executable: verified.executable,
            version: evaluateTwgCliCompatibility(verified.version, manifest).installedVersion,
            compatibility: evaluateTwgCliCompatibility(verified.version, manifest),
            skills: skillStatus,
            authentication: "not_performed",
            nextStep: "Run `twg login` in a terminal if authentication is not already configured, then run `twg doctor`.",
          })
          } finally {
            cliMaintenanceActive = false
            await releaseCliMaintenanceLock(maintenanceLock)
          }
        },
      } satisfies ToolDefinition,
      twg_artifact_read: {
        description: "Read only an artifact registered by a prior TWG tool call in this session, with strict size and JSON-field projection limits.",
        args: {
          id: z.string().uuid(),
          maxBytes: z.number().int().min(1_024).max(256 * 1024).default(32 * 1024),
          fields: z.array(z.string()).max(20).default([]),
        },
        async execute(input: { id: string; maxBytes: number; fields: string[] }, context: ToolContext) {
          return JSON.stringify(await artifactStore.read(context.sessionID, input.id, input.maxBytes, input.fields))
        },
      } satisfies ToolDefinition,
      twg_agent_status: {
        description: "Inspect cached TWG bundle, CLI compatibility, official OpenCode skill visibility, configuration, and non-blocking update-check state.",
        args: {},
        async execute() {
          return JSON.stringify(await agentStatus())
        },
      } satisfies ToolDefinition,
    },
    dispose: async () => {
      if (initialTimer) clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      if (cliInitialTimer) clearTimeout(cliInitialTimer)
      if (cliIntervalTimer) clearInterval(cliIntervalTimer)
      updateAbort?.abort()
      cliUpdateAbort?.abort()
      await stopActiveProcesses()
      await Promise.allSettled([currentUpdate, currentCliUpdate].filter((value): value is Promise<void> => Boolean(value)))
      await artifactStore.dispose()
      await rm(artifactRoot, { recursive: true, force: true })
    },
  }
}

export default TwgAgentPlugin
