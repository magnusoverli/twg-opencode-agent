import { z } from "zod"

const semanticVersion = z.string().regex(/^\d+\.\d+\.\d+$/)

export const compatibilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  twgCli: z.object({ minimum: semanticVersion, maximumTestedExclusive: semanticVersion }),
  helpContractVersions: z.array(z.number().int().positive()).min(1),
  opencode: z.object({ minimum: semanticVersion, maximumTestedExclusive: semanticVersion }),
  requiredFiles: z.array(z.string().min(1)).min(1),
  requiredSkills: z.array(z.string().min(1)).min(1),
})

export type CompatibilityManifest = z.infer<typeof compatibilityManifestSchema>

export function parseCompatibilityManifest(value: unknown): CompatibilityManifest {
  return compatibilityManifestSchema.parse(value)
}

type ParsedVersion = [major: number, minor: number, patch: number]

export type TwgCliCompatibility = {
  status: "compatible" | "outdated" | "untested" | "unknown"
  minimumVersion: string
  maximumTestedExclusive: string
  installedVersion?: string
  message: string
}

export type RuntimeCompatibility = {
  status: "compatible" | "outdated" | "untested" | "unknown"
  minimumVersion: string
  maximumTestedExclusive: string
  installedVersion?: string
  message: string
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?![0-9A-Za-z+-])/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export function evaluateTwgCliCompatibility(
  versionOutput: string | undefined,
  manifest: CompatibilityManifest,
): TwgCliCompatibility {
  const installed = versionOutput ? parseVersion(versionOutput) : null
  const minimum = parseVersion(manifest.twgCli.minimum)
  const maximum = parseVersion(manifest.twgCli.maximumTestedExclusive)
  const base = {
    minimumVersion: manifest.twgCli.minimum,
    maximumTestedExclusive: manifest.twgCli.maximumTestedExclusive,
  }
  if (!installed || !minimum || !maximum) {
    return { status: "unknown", ...base, message: "Could not determine TWG CLI compatibility." }
  }

  const installedVersion = installed.join(".")
  if (compareVersions(installed, minimum) < 0) {
    return {
      status: "outdated",
      ...base,
      installedVersion,
      message: `TWG CLI ${installedVersion} is too old; install ${manifest.twgCli.minimum} or newer.`,
    }
  }
  if (compareVersions(installed, maximum) >= 0) {
    return {
      status: "untested",
      ...base,
      installedVersion,
      message: `TWG CLI ${installedVersion} is outside the tested range below ${manifest.twgCli.maximumTestedExclusive}.`,
    }
  }
  return { status: "compatible", ...base, installedVersion, message: `TWG CLI ${installedVersion} is supported.` }
}

export function evaluateRuntimeCompatibility(
  label: string,
  versionOutput: string | undefined,
  minimumVersion: string,
  maximumTestedExclusive: string,
): RuntimeCompatibility {
  const installed = versionOutput ? parseVersion(versionOutput) : null
  const minimum = parseVersion(minimumVersion)
  const maximum = parseVersion(maximumTestedExclusive)
  const base = { minimumVersion, maximumTestedExclusive }
  if (!installed || !minimum || !maximum) {
    return { status: "unknown", ...base, message: `Could not determine ${label} compatibility.` }
  }
  const installedVersion = installed.join(".")
  if (compareVersions(installed, minimum) < 0) {
    return { status: "outdated", ...base, installedVersion, message: `${label} ${installedVersion} is too old; install ${minimumVersion} or newer.` }
  }
  if (compareVersions(installed, maximum) >= 0) {
    return { status: "untested", ...base, installedVersion, message: `${label} ${installedVersion} is outside the tested range below ${maximumTestedExclusive}.` }
  }
  return { status: "compatible", ...base, installedVersion, message: `${label} ${installedVersion} is supported.` }
}

export function buildTwgEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, TWG_AGENT_DEFAULTS: env.TWG_AGENT_DEFAULTS ?? "1" }
}

export function parseBooleanSetting(value: string | undefined, fallback: boolean): { value: boolean; error?: string } {
  if (value === undefined) return { value: fallback }
  const normalized = value.trim().toLowerCase()
  if (normalized === "true") return { value: true }
  if (normalized === "false") return { value: false }
  return { value: fallback, error: `Expected true or false, received ${JSON.stringify(value)}.` }
}

export function parseIntervalMinutes(
  value: string | undefined,
  fallback = 15,
): { value: number; error?: string } {
  if (value === undefined) return { value: fallback }
  const parsed = Number(value.trim())
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 24 * 60) return { value: parsed }
  return { value: fallback, error: `Expected a finite interval from 1 to 1440 minutes, received ${JSON.stringify(value)}.` }
}
