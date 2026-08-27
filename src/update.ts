export function isVersionNewer(current: string, candidate: string): boolean {
  const parse = (value: string) => {
    if (!/^\d{4}\.\d+\.\d+$/.test(value)) return null
    return value.split(".").map(Number)
  }
  const currentParts = parse(current)
  const candidateParts = parse(candidate)
  if (!currentParts || !candidateParts) return false

  for (let index = 0; index < currentParts.length; index += 1) {
    if (candidateParts[index] > currentParts[index]) return true
    if (candidateParts[index] < currentParts[index]) return false
  }
  return false
}

export function latestReleasedChangelog(markdown: string, limit = 3): string {
  const sections = markdown.split(/(?=^## \[)/m)
  return sections
    .filter((section) => /^## \[(?!Unreleased\])[^\]]+\]/.test(section))
    .slice(0, limit)
    .join("")
    .trim()
}
