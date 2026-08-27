import { spawn, type ChildProcess } from "node:child_process"
import { constants, createWriteStream } from "node:fs"
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"

const DEFAULT_SPOOL_QUOTA = 64 * 1024 * 1024
const activeChildren = new Set<ChildProcess>()
const activeClosures = new Map<ChildProcess, Promise<void>>()

export type CapturedOutput = {
  text?: string
  path?: string
  bytes: number
}

export type SpawnResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  spawnError?: string
  durationMs: number
  stdout: CapturedOutput
  stderr: CapturedOutput
}

export type RunProcessOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  inlineLimit?: number
  artifactRoot?: string
  spoolQuota?: number
}

class OutputCollector {
  private readonly limit: number
  private readonly quota: number
  private readonly root: string
  private readonly label: string
  private chunks: Buffer[] = []
  private stream: ReturnType<typeof createWriteStream> | null = null
  private outputPath: string | undefined
  private streamError: Error | null = null
  private bytes = 0

  constructor(limit: number, quota: number, root: string, label: string) {
    this.limit = limit
    this.quota = quota
    this.root = root
    this.label = label
  }

  push(chunk: Buffer): "ok" | "pause" | "quota" {
    if (this.bytes + chunk.length > this.quota) return "quota"
    this.bytes += chunk.length
    if (!this.stream && this.bytes <= this.limit) {
      this.chunks.push(chunk)
      return "ok"
    }
    if (!this.stream) {
      this.outputPath = join(this.root, `${Date.now()}-${randomUUID()}-${this.label}.log`)
      this.stream = createWriteStream(this.outputPath, { flags: "wx", mode: 0o600 })
      this.stream.on("error", (error) => {
        this.streamError = error
      })
      for (const buffered of this.chunks) this.stream.write(buffered)
      this.chunks = []
    }
    return this.stream.write(chunk) ? "ok" : "pause"
  }

  onDrain(callback: () => void): void {
    this.stream?.once("drain", callback)
  }

  async finish(): Promise<CapturedOutput> {
    if (!this.stream) return { text: Buffer.concat(this.chunks).toString("utf8"), bytes: this.bytes }
    if (this.streamError) throw this.streamError
    await new Promise<void>((resolvePromise, reject) => {
      this.stream!.once("finish", resolvePromise)
      this.stream!.once("close", resolvePromise)
      this.stream!.once("error", reject)
      this.stream!.end()
    })
    if (this.streamError) throw this.streamError
    return { path: this.outputPath, bytes: this.bytes }
  }
}

function terminateProcessTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    })
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM")
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM")
  }
}

export async function runProcess(executable: string, args: string[], options: RunProcessOptions): Promise<SpawnResult> {
  const startedAt = Date.now()
  if (options.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      aborted: true,
      timedOut: false,
      durationMs: 0,
      stdout: { text: "", bytes: 0 },
      stderr: { text: "", bytes: 0 },
    }
  }
  const artifactRoot = options.artifactRoot ?? join(tmpdir(), "twg-opencode-agent")
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await chmod(artifactRoot, 0o700).catch(() => undefined)
  const inlineLimit = options.inlineLimit ?? 256 * 1024
  const quota = options.spoolQuota ?? DEFAULT_SPOOL_QUOTA
  const stdout = new OutputCollector(inlineLimit, quota, artifactRoot, "stdout")
  const stderr = new OutputCollector(inlineLimit, quota, artifactRoot, "stderr")

  return await new Promise<SpawnResult>((resolvePromise) => {
    let timedOut = false
    let aborted = false
    let settled = false
    let terminating = false
    let spawnError: string | undefined
    let forceTimer: NodeJS.Timeout | undefined
    let settlementTimer: NodeJS.Timeout | undefined
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    activeChildren.add(child)
    let closed!: () => void
    activeClosures.set(child, new Promise<void>((resolvePromise) => {
      closed = resolvePromise
    }))

    const settle = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
      if (settlementTimer) clearTimeout(settlementTimer)
      options.signal?.removeEventListener("abort", onAbort)
      try {
        const result = {
          exitCode,
          signal,
          timedOut,
          aborted,
          spawnError,
          durationMs: Date.now() - startedAt,
          stdout: await stdout.finish(),
          stderr: await stderr.finish(),
        }
        activeChildren.delete(child)
        activeClosures.delete(child)
        closed()
        resolvePromise(result)
      } catch (error) {
        const result = {
          exitCode,
          signal,
          timedOut,
          aborted,
          spawnError: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          stdout: { bytes: 0 },
          stderr: { bytes: 0 },
        }
        activeChildren.delete(child)
        activeClosures.delete(child)
        closed()
        resolvePromise(result)
      }
    }

    const terminate = (): void => {
      if (terminating) return
      terminating = true
      terminateProcessTree(child, false)
      forceTimer = setTimeout(() => terminateProcessTree(child, true), 2_000)
      forceTimer.unref()
      settlementTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        void settle(null, "SIGKILL")
      }, 7_000)
      settlementTimer.unref()
    }

    const capture = (collector: OutputCollector, stream: NodeJS.ReadableStream, chunk: Buffer): void => {
      const state = collector.push(chunk)
      if (state === "pause") {
        stream.pause()
        collector.onDrain(() => stream.resume())
      } else if (state === "quota") {
        spawnError = `TWG process output exceeded the ${quota}-byte per-stream quota.`
        terminate()
      }
    }
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, child.stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, child.stderr, chunk))
    child.once("error", (error) => {
      spawnError = error.message
    })

    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    timeout.unref()
    const onAbort = (): void => {
      aborted = true
      terminate()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    child.once("close", (exitCode, signal) => void settle(exitCode, signal))
  })
}

export async function stopActiveProcesses(): Promise<void> {
  const children = [...activeChildren]
  const closures = children.map((child) => activeClosures.get(child)).filter((value): value is Promise<void> => Boolean(value))
  for (const child of children) terminateProcessTree(child, true)
  if (closures.length === 0) return
  await Promise.race([
    Promise.allSettled(closures),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ])
}

function parseYamlString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return null
    }
  }
  return trimmed.replace(/^['"]|['"]$/g, "")
}

export function extractTwgOutputFiles(stdout: string): Array<{ kind: "stdout" | "compact"; path: string }> {
  const files: Array<{ kind: "stdout" | "compact"; path: string }> = []
  let inOutputFiles = false
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "output_files:") {
      inOutputFiles = true
      continue
    }
    if (!inOutputFiles) continue
    if (line && !/^\s/.test(line)) break
    const match = line.match(/^\s+(stdout|compact):\s*(.+)$/)
    if (!match) continue
    const path = parseYamlString(match[2])
    if (path) files.push({ kind: match[1] as "stdout" | "compact", path })
  }
  return files
}

export type ArtifactRecord = {
  id: string
  sessionID: string
  kind: string
  path: string
  bytes: number
  filename: string
  mtimeMs: number
}

function projectPath(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value
  if (Array.isArray(value)) return value.map((item) => projectPath(item, segments))
  if (!value || typeof value !== "object") return undefined
  const [head, ...tail] = segments
  return projectPath((value as Record<string, unknown>)[head], tail)
}

export class TwgArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>()
  private readonly rootPromise: Promise<string>
  private readonly totalQuota: number
  private readonly artifactQuota: number
  private readonly sessionQuota: number
  private readonly sessionBytes = new Map<string, number>()
  private totalBytes = 0

  constructor(totalQuota = 128 * 1024 * 1024, artifactQuota = 64 * 1024 * 1024, sessionQuota = 64 * 1024 * 1024) {
    this.totalQuota = totalQuota
    this.artifactQuota = artifactQuota
    this.sessionQuota = Math.min(sessionQuota, totalQuota)
    this.rootPromise = mkdtemp(join(tmpdir(), "twg-opencode-artifacts-")).then(async (root) => {
      await chmod(root, 0o700).catch(() => undefined)
      return root
    })
  }

  async register(sessionID: string, sourcePath: string, kind: string, removeSource = false): Promise<ArtifactRecord | null> {
    let reserved = 0
    let destination: string | undefined
    let canonicalSource: string | undefined
    try {
      canonicalSource = await realpath(sourcePath)
      const sourceInfo = await stat(canonicalSource)
      const usedBySession = this.sessionBytes.get(sessionID) ?? 0
      if (
        !sourceInfo.isFile() ||
        sourceInfo.size > this.artifactQuota ||
        this.totalBytes + sourceInfo.size > this.totalQuota ||
        usedBySession + sourceInfo.size > this.sessionQuota
      ) {
        if (removeSource) await unlink(canonicalSource).catch(() => undefined)
        return null
      }
      reserved = sourceInfo.size
      this.totalBytes += reserved
      this.sessionBytes.set(sessionID, usedBySession + reserved)
      const root = await this.rootPromise
      const id = randomUUID()
      destination = join(root, `${id}-${basename(canonicalSource)}`)
      await copyFile(canonicalSource, destination, constants.COPYFILE_EXCL)
      await chmod(destination, 0o600).catch(() => undefined)
      const info = await stat(destination)
      if (info.size !== reserved) throw new Error("Artifact source changed while it was being registered.")
      const record: ArtifactRecord = {
        id,
        sessionID,
        kind,
        path: destination,
        bytes: info.size,
        filename: basename(canonicalSource),
        mtimeMs: info.mtimeMs,
      }
      this.records.set(record.id, record)
      if (removeSource) await unlink(canonicalSource).catch(() => undefined)
      return record
    } catch {
      if (destination) await unlink(destination).catch(() => undefined)
      if (removeSource && canonicalSource) await unlink(canonicalSource).catch(() => undefined)
      if (reserved > 0) {
        this.totalBytes -= reserved
        const remaining = (this.sessionBytes.get(sessionID) ?? reserved) - reserved
        if (remaining > 0) this.sessionBytes.set(sessionID, remaining)
        else this.sessionBytes.delete(sessionID)
      }
      return null
    }
  }

  async read(
    sessionID: string,
    id: string,
    maxBytes: number,
    fields: string[] = [],
  ): Promise<{ artifact: Omit<ArtifactRecord, "path" | "sessionID" | "mtimeMs">; data?: unknown; error?: string }> {
    const record = this.records.get(id)
    if (!record || record.sessionID !== sessionID) throw new Error("Unknown TWG artifact id for this session.")
    if (fields.some((field) => !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field) || field.includes("__proto__"))) {
      throw new Error("Artifact fields must be safe dotted JSON paths.")
    }
    const info = await stat(record.path)
    if (info.size !== record.bytes || info.mtimeMs !== record.mtimeMs) throw new Error("TWG artifact changed after registration.")
    const artifact = { id: record.id, kind: record.kind, bytes: info.size, filename: record.filename }
    if (fields.length === 0 && info.size > maxBytes) {
      return { artifact, error: `Artifact exceeds ${maxBytes} bytes; request specific JSON fields or rerun TWG with --select.` }
    }
    if (fields.length > 0 && info.size > 8 * 1024 * 1024) {
      return { artifact, error: "Artifact exceeds the 8 MiB projection limit; rerun TWG with --select." }
    }
    const content = await readFile(record.path, "utf8")
    if (fields.length === 0) {
      try {
        return { artifact, data: JSON.parse(content) }
      } catch {
        return { artifact, data: content.slice(0, maxBytes) }
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return { artifact, error: "Field projection requires a JSON artifact." }
    }
    const data = Object.fromEntries(fields.map((field) => [field, projectPath(parsed, field.split("."))]))
    if (Buffer.byteLength(JSON.stringify(data)) > maxBytes) {
      return { artifact, error: `Projected result exceeds ${maxBytes} bytes; request fewer fields or rerun TWG with --select.` }
    }
    return { artifact, data }
  }

  async dispose(): Promise<void> {
    this.records.clear()
    this.sessionBytes.clear()
    this.totalBytes = 0
    await rm(await this.rootPromise, { recursive: true, force: true })
  }
}
