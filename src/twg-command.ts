import { resolve } from "node:path"
import { z } from "zod"

const commandOptionSchema = z
  .object({
    long: z.string().optional(),
    short: z.string().optional(),
    arg: z.string().optional(),
    desc: z.string().optional(),
    req: z.boolean().optional(),
    vari: z.boolean().optional(),
  })
  .passthrough()

const commandArgumentSchema = z
  .object({
    name: z.string(),
    desc: z.string().optional(),
    req: z.boolean().optional(),
    vari: z.boolean().optional(),
  })
  .passthrough()

export const twgCommandMetadataSchema = z
  .object({
    type: z.literal("cmd"),
    ver: z.number().int().positive(),
    path: z.array(z.string().min(1)).min(1),
    kind: z.string().min(1),
    cmd: z.string().min(1),
    group: z.string().optional(),
    tier: z.enum(["basic", "enriched"]).optional(),
    args: z.array(commandArgumentSchema).optional(),
    opts: z.array(commandOptionSchema).optional(),
    gopt: z.array(commandOptionSchema).optional(),
    inheritedOpts: z.array(commandOptionSchema).optional(),
    output: z
      .object({
        largeOutputRisk: z.string().optional(),
        recommendedSummary: z.string().optional(),
        recommendedAgentFields: z.string().optional(),
        recommendedView: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type TwgCommandMetadata = z.infer<typeof twgCommandMetadataSchema>

export type TwgLocalPath = {
  mode: "read" | "write"
  option: string
  path: string
  absolutePath: string
  overwrite: boolean
  argumentIndex?: number
  inline?: boolean
}

export type TwgCommandEffects = {
  remote: "read" | "write" | "control" | "unknown"
  local: "none" | "read" | "write"
  dryRun: boolean
  reasons: string[]
  paths: TwgLocalPath[]
}

const explicitWriteTokens = new Set([
  "add",
  "archive",
  "cancel",
  "clear",
  "clone",
  "complete",
  "convert",
  "copy",
  "create",
  "delete",
  "disable",
  "enable",
  "execute",
  "invite",
  "link",
  "move",
  "publish",
  "purge",
  "remove",
  "reopen",
  "replace",
  "rerun",
  "resolve",
  "restore",
  "run",
  "set",
  "star",
  "transition",
  "trigger",
  "unarchive",
  "unlink",
  "unstar",
  "untrash",
  "update",
  "upload",
  "watch",
  "write",
])

const readKinds = new Set([
  "access",
  "capabilities",
  "collaborators",
  "commits",
  "context",
  "deployments",
  "docs",
  "meetings",
  "people",
  "projection",
  "pull-requests",
  "resolve",
  "spaces",
  "user",
  "videos",
  "whoami",
])

const readOnlyGenericActions = new Set([
  "diff",
  "download",
  "export",
  "grep",
  "history",
  "me",
  "metadata",
  "priorities",
  "status",
  "statuses",
  "tail",
  "transitions",
  "types",
  "wait",
])

const exactReadPaths = new Set([
  "access",
  "capabilities",
  "collaborators",
  "commits",
  "deployments",
  "doctor",
  "notifications",
  "org-tree",
  "pr-tree",
  "recently-viewed",
  "resolve",
  "bitbucket repo contributors",
  "user-search",
  "whoami",
  "work-tree",
  "workitem-tree",
])

const localWriteOptions = new Set([
  "--destination",
  "--download-dir",
  "--out-dir",
  "--out",
  "--output-dir",
  "--output-directory",
  "--output-file",
  "--output-path",
  "--report-file",
  "--transcript-output-file",
])
const localReadOptions = new Set([
  "--body-file",
  "--context-file",
  "--data-file",
  "--edits-file",
  "--file",
  "--files-from",
  "--image",
  "--in",
  "--input-file",
  "--payload-file",
  "--prompt-file",
  "--repo-path",
  "--result-file",
  "--variables-file",
])

const agentGlobalOptions: Array<{ long: string; short?: string; arg: string; desc?: string; req?: boolean; vari?: boolean }> = [
  { long: "--api-version", arg: "<version>" },
  { long: "--site", arg: "<site>" },
  { long: "--output", short: "-o", arg: "<format>" },
  { long: "--output-summary", arg: "[level]" },
  { long: "--output-shape", arg: "<shape>" },
  { long: "--agent-fields", arg: "<fields>" },
  { long: "--select", arg: "<fields>" },
  { long: "--hydrate", arg: "<mode>" },
  { long: "--timeout-ms", arg: "<milliseconds>" },
]

function declaredOptions(metadata: TwgCommandMetadata) {
  return [...agentGlobalOptions, ...(metadata.gopt ?? []), ...(metadata.inheritedOpts ?? []), ...(metadata.opts ?? [])]
}

function optionValue(args: string[], index: number): { option: string; value?: string; inline: boolean } {
  const equals = args[index].indexOf("=")
  if (equals >= 0) return { option: args[index].slice(0, equals), value: args[index].slice(equals + 1), inline: true }
  return { option: args[index], value: args[index + 1], inline: false }
}

function localPaths(args: string[], metadata: TwgCommandMetadata, directory: string): TwgLocalPath[] {
  const options = declaredOptions(metadata)
  const optionAliases = new Map<string, (typeof options)[number]>()
  for (const option of options) {
    if (option.long) optionAliases.set(option.long, option)
    if (option.short) optionAliases.set(option.short, option)
  }
  const paths: TwgLocalPath[] = []
  const consumed = new Set<number>()
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("-")) continue
    const { option, value, inline } = optionValue(args, index)
    const declared = optionAliases.get(option)
    if (declared?.arg) {
      if (!inline) consumed.add(index + 1)
      if (declared.vari) {
        let valueIndex = inline ? index + 1 : index + 2
        while (valueIndex < args.length && !args[valueIndex].startsWith("-")) {
          consumed.add(valueIndex)
          valueIndex += 1
        }
      }
    }
    const description = `${declared?.long ?? option} ${declared?.arg ?? ""} ${declared?.desc ?? ""}`.toLowerCase()
    const isLocalPath =
      localWriteOptions.has(declared?.long ?? option) ||
      localReadOptions.has(declared?.long ?? option) ||
      /\blocal\b.{0,40}\b(file|path|directory|folder)\b/.test(description) ||
      (/\b(file|path|directory|folder)\b/.test(description) && /\b(upload|download|save|write|output|input|source|destination)\b/.test(description)) ||
      /^--(?:.+-)?files?$/.test(declared?.long ?? option) ||
      /--(output|input|body|edits|payload|variables|context|download)-(file|path|dir|directory)\b/.test(description)
    if (!isLocalPath) continue
    const mode = localWriteOptions.has(declared?.long ?? option) || /\b(save|write|download|output|destination)\b/.test(description)
      ? "write"
      : localReadOptions.has(declared?.long ?? option) || /\b(read|input|source|upload)\b/.test(description)
        ? "read"
        : "write"
    if (!value) continue
    const values = [{ value, argumentIndex: inline ? index : index + 1, inline }]
    if (declared?.vari) {
      let valueIndex = inline ? index + 1 : index + 2
      while (valueIndex < args.length && !args[valueIndex].startsWith("-")) {
        values.push({ value: args[valueIndex], argumentIndex: valueIndex, inline: false })
        valueIndex += 1
      }
    }
    for (const item of values) {
      paths.push({
        mode,
        option: declared?.long ?? option,
        path: item.value,
        absolutePath: resolve(directory, item.value),
        overwrite: mode === "write" && args.includes("--force"),
        argumentIndex: item.argumentIndex,
        inline: item.inline,
      })
    }
  }

  const positionals: Array<{ value: string; argumentIndex: number }> = []
  let optionsEnded = false
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!optionsEnded && value === "--") {
      optionsEnded = true
      continue
    }
    if (consumed.has(index)) continue
    if (!optionsEnded && value.startsWith("-") && value !== "-") continue
    positionals.push({ value, argumentIndex: index })
  }
  const positionalDefinitions = metadata.args ?? []
  for (let index = 0; index < positionals.length; index += 1) {
    const argument = positionalDefinitions[index] ?? (positionalDefinitions.at(-1)?.vari ? positionalDefinitions.at(-1) : undefined)
    if (!argument) break
    const description = `${argument.name} ${argument.desc ?? ""}`.toLowerCase()
    if (metadata.path.join(" ") === "visualize" && argument.name === "input") {
      try {
        const parsed = JSON.parse(positionals[index].value)
        if (parsed && typeof parsed === "object") continue
      } catch {}
    }
    if (
      !/\blocal\b.{0,40}\b(file|path|directory|folder)\b/.test(description) &&
      !(/\b(file|path|directory|folder)\b/.test(description) && /\b(upload|download|save|write|output|input|source|destination)\b/.test(description))
    ) continue
    const mode = /\b(save|write|download|output|destination)\b/.test(description) ? "write" : "read"
    const { value, argumentIndex } = positionals[index]
    paths.push({
      mode,
      option: `<${argument.name}>`,
      path: value,
      absolutePath: resolve(directory, value),
      overwrite: mode === "write" && args.includes("--force"),
      argumentIndex,
      inline: false,
    })
  }

  const path = metadata.path.join(" ")
  if (path.endsWith(" download") && !paths.some((item) => item.mode === "write")) {
    paths.push({ mode: "write", option: "download", path: "<command default>", absolutePath: directory, overwrite: false })
  }
  if (path === "visualize" && !paths.some((item) => item.mode === "write")) {
    paths.push({ mode: "write", option: "generated visualization", path: "<command default>", absolutePath: directory, overwrite: false })
  }
  if (path === "bitbucket repo contributors" && !paths.some((item) => item.mode === "read")) {
    paths.push({ mode: "read", option: "current checkout", path: "<command default>", absolutePath: directory, overwrite: false })
  }
  return paths
}

export function parseTwgCommandMetadata(value: unknown, supportedVersions: number[]): TwgCommandMetadata {
  const metadata = twgCommandMetadataSchema.parse(value)
  if (!supportedVersions.includes(metadata.ver)) {
    throw new Error(`Unsupported TWG help contract version ${metadata.ver}; supported: ${supportedVersions.join(", ")}`)
  }
  return metadata
}

export function validateTwgArguments(args: string[], metadata: TwgCommandMetadata): void {
  const options = declaredOptions(metadata)
  const aliases = new Map<string, (typeof options)[number]>()
  for (const option of options) {
    if (option.long) aliases.set(option.long, option)
    if (option.short) aliases.set(option.short, option)
  }

  const positionals: string[] = []
  const seenOptions = new Set<(typeof options)[number]>()
  let optionsEnded = false
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!optionsEnded && value === "--") {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const equals = value.indexOf("=")
      const name = equals >= 0 ? value.slice(0, equals) : value
      const option = aliases.get(name)
      if (!option) throw new Error(`Option ${name} is not declared by ${metadata.cmd}.`)
      seenOptions.add(option)
      if (option.arg) {
        const optionalValue = option.arg.startsWith("[")
        if (equals >= 0) {
          if (equals === value.length - 1) throw new Error(`Option ${name} requires ${option.arg}.`)
          if (option.vari) {
            while (index + 1 < args.length && !args[index + 1].startsWith("-")) index += 1
          }
        } else {
          if (index + 1 >= args.length || args[index + 1].startsWith("-")) {
            if (!optionalValue) throw new Error(`Option ${name} requires ${option.arg}.`)
          } else {
            index += 1
            if (option.vari) {
              while (index + 1 < args.length && !args[index + 1].startsWith("-")) index += 1
            }
          }
        }
      } else if (equals >= 0) {
        throw new Error(`Flag ${name} does not accept a value.`)
      }
      continue
    }
    positionals.push(value)
  }

  const declared = metadata.args ?? []
  const missingOptions = options.filter((option) => option.req && !seenOptions.has(option)).map((option) => option.long ?? option.short)
  if (missingOptions.length > 0) throw new Error(`${metadata.cmd} requires ${missingOptions.join(", ")}.`)
  const minimum = declared.filter((argument) => argument.req).length
  const variadic = declared.at(-1)?.vari === true
  if (positionals.length < minimum) throw new Error(`${metadata.cmd} requires at least ${minimum} positional argument(s).`)
  if (!variadic && positionals.length > declared.length) {
    throw new Error(`${metadata.cmd} accepts at most ${declared.length} positional argument(s).`)
  }
}

export function classifyTwgCommand(
  args: string[],
  metadata: TwgCommandMetadata,
  directory: string,
): TwgCommandEffects {
  const reasons: string[] = []
  const path = metadata.path.join(" ")
  const supportsDryRun = metadata.opts?.some((option) => option.long === "--dry-run") ?? false
  const dryRun = supportsDryRun && args.some((arg) => arg === "--dry-run" || arg.startsWith("--dry-run="))
  const paths = localPaths(args, metadata, directory)
  const clipboardRead = args.some((arg) => arg === "--from-clipboard" || arg.startsWith("--from-clipboard="))
  const local = paths.some((item) => item.mode === "write") ? "write" : paths.length || clipboardRead ? "read" : "none"

  let remote: TwgCommandEffects["remote"] = "unknown"
  if (metadata.group === "Control-Plane Commands" && !exactReadPaths.has(path)) {
    remote = "control"
    reasons.push("control-plane command requires explicit authorization")
  } else if (dryRun) {
    remote = "read"
    reasons.push("command-advertised dry run")
  } else if (path === "jira workitem transition") {
    const hasTransition = args.some((arg) => arg === "--transition-id" || arg.startsWith("--transition-id="))
    remote = hasTransition ? "write" : "read"
    reasons.push(hasTransition ? "transition id performs a state change" : "transition discovery without an id")
  } else if (exactReadPaths.has(path)) {
    remote = "read"
    reasons.push("exact read-only command path")
  } else {
    const kindTokens = metadata.kind.toLowerCase().split("-")
    if (kindTokens.some((token) => explicitWriteTokens.has(token))) {
      remote = "write"
      reasons.push(`write-classified metadata kind: ${metadata.kind}`)
    } else if (["get", "list", "query", "search", "read"].includes(kindTokens.at(-1) ?? "")) {
      remote = "read"
      reasons.push(`read-classified metadata kind: ${metadata.kind}`)
    } else if (readKinds.has(metadata.kind)) {
      remote = "read"
      reasons.push(`known read-only metadata kind: ${metadata.kind}`)
    } else if (metadata.kind === "resource" && readOnlyGenericActions.has(metadata.path.at(-1)?.toLowerCase() ?? "")) {
      remote = "read"
      reasons.push(`allowlisted generic read action: ${metadata.path.at(-1)}`)
    } else {
      const lastPathToken = metadata.path.at(-1)?.toLowerCase() ?? ""
      if (explicitWriteTokens.has(lastPathToken)) {
        remote = "write"
        reasons.push(`write-classified exact action: ${lastPathToken}`)
      } else {
        reasons.push(`generic or unknown metadata kind: ${metadata.kind}`)
      }
    }
  }

  if (clipboardRead) reasons.push("local clipboard read")
  if (paths.length > 0) reasons.push(`explicit local ${local} path access`)
  return { remote, local, dryRun, reasons, paths }
}

export function assertKnownTwgEffects(effects: TwgCommandEffects, metadata: TwgCommandMetadata): void {
  if (effects.remote === "unknown") {
    throw new Error(`Cannot prove the remote effect of ${metadata.cmd}; refusing to execute it.`)
  }
}

const sensitiveOptionPattern = /(api-key|authorization|body|comment|credential|description|edits|password|private-key|secret|token|variables-json)/i

export function displayTwgCommand(command: string[], args: string[], limit = 1_000): string {
  const rendered: string[] = ["twg", ...command]
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      rendered.push("<redacted>")
      redactNext = false
      continue
    }
    const [option] = arg.split("=", 1)
    if (sensitiveOptionPattern.test(option)) {
      rendered.push(arg.includes("=") ? `${option}=<redacted>` : option)
      redactNext = !arg.includes("=")
      continue
    }
    const bounded = arg.length > 120 ? `${arg.slice(0, 117)}...` : arg
    rendered.push(/^[A-Za-z0-9_./:@=+-]+$/.test(bounded) ? bounded : JSON.stringify(bounded))
  }
  const output = rendered.join(" ")
  return output.length > limit ? `${output.slice(0, limit - 3)}...` : output
}
