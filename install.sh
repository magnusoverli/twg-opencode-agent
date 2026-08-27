#!/usr/bin/env bash
set -euo pipefail

development=false
skip_dependencies=false
skip_twg_skills=false
repo_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --development) development=true ;;
    --skip-dependencies) skip_dependencies=true ;;
    --skip-twg-skills) skip_twg_skills=true ;;
    --repo-url)
      if [[ $# -lt 2 ]] || [[ -z "$2" ]] || [[ "$2" == -* ]]; then
        echo "--repo-url requires a non-option value." >&2
        exit 2
      fi
      repo_url="$2"
      shift
      ;;
    --) shift; [[ $# -eq 0 ]] || { echo "Unexpected positional argument: $1" >&2; exit 2; }; break ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/bundles/twg-agent"
versions_dir="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/bundles/twg-agent-versions"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
bootstrap_relative="plugins/twg-agent-bootstrap.ts"
bootstrap_path="$config_dir/$bootstrap_relative"
managed_marker='// Managed by twg-opencode-agent installer.'
supported_help_contract=1
selected_minimum=""
selected_maximum=""
selected_opencode_minimum=""
selected_opencode_maximum=""
required_skills=()
stage_dir=""
stage_checkout=""
stage_token=""
pending_version_dir=""
pending_version_token=""
activation_succeeded=false
held_lock_paths=()
held_lock_tokens=()
development_marker_path=""
development_marker_backup=""
development_marker_backup_ready=false
development_marker_existed=false
development_marker_rollback_pending=false

die() {
  echo "$*" >&2
  exit 1
}

git_output() {
  local output
  if ! output="$(git "$@")"; then
    die "git command failed: git $*"
  fi
  printf '%s' "$output"
}

optional_origin() {
  local repository="$1" output status
  set +e
  output="$(git -C "$repository" config --get remote.origin.url)"
  status=$?
  set -e
  case "$status" in
    0) printf '%s' "$output" ;;
    1) printf '' ;;
    *) die "Could not inspect remote.origin.url in $repository (git exit $status)." ;;
  esac
}

validate_repo_url() {
  node - "$1" <<'NODE'
const value = process.argv[2]
if (!value || value !== value.trim()) throw new Error("repository URL must be non-empty and have no surrounding whitespace")
if (value.startsWith("-")) throw new Error("repository URL looks like a command-line option")
if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("repository URL contains control characters")
if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
  const parsed = new URL(value)
  if (parsed.search || parsed.hash) throw new Error("repository URL query strings and fragments are not accepted")
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.username || parsed.password)) {
    throw new Error("credential-bearing HTTP(S) repository URLs are not accepted")
  }
  if (parsed.password) throw new Error("repository URLs containing a password are not accepted")
} else if (/^[^/@\s:]+:[^@\s]+@/.test(value)) {
  throw new Error("credential-bearing repository URLs are not accepted")
}
NODE
}

load_manifest() {
  local root="$1" output line kind value
  if ! output="$(node - "$root" "$supported_help_contract" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const requestedRoot = path.resolve(process.argv[2])
const rootInfo = fs.lstatSync(requestedRoot)
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("bundle root must be a regular directory")
const root = fs.realpathSync(requestedRoot)
const supportedContract = Number(process.argv[3])
const bundleFile = relative => {
  const segments = relative.split(/[\\/]/)
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`unsafe bundle file path: ${relative}`)
  }
  let candidate = root
  for (let index = 0; index < segments.length; index++) {
    candidate = path.join(candidate, segments[index])
    const info = fs.lstatSync(candidate)
    if (info.isSymbolicLink()) throw new Error(`bundle file path contains a filesystem link: ${relative}`)
    if (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`bundle file path contains a non-regular component: ${relative}`)
    }
  }
  const physical = fs.realpathSync(candidate)
  const fromRoot = path.relative(root, physical)
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`bundle file is not physically inside the bundle: ${relative}`)
  }
  return candidate
}
const manifestPath = bundleFile("compatibility.json")
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
} catch (error) {
  throw new Error(`invalid compatibility.json: ${error.message}`)
}
const semver = /^\d+\.\d+\.\d+$/
if (manifest.schemaVersion !== 1) throw new Error(`unsupported compatibility schemaVersion ${manifest.schemaVersion}`)
if (!manifest.twgCli || !semver.test(manifest.twgCli.minimum) || !semver.test(manifest.twgCli.maximumTestedExclusive)) {
  throw new Error("compatibility.json must declare semantic TWG CLI minimum and maximumTestedExclusive versions")
}
const parts = value => value.split(".").map(Number)
const compare = (a, b) => {
  const left = parts(a); const right = parts(b)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}
if (compare(manifest.twgCli.minimum, manifest.twgCli.maximumTestedExclusive) >= 0) {
  throw new Error("compatibility.json has an empty or inverted TWG CLI version range")
}
if (!manifest.opencode || !semver.test(manifest.opencode.minimum) || !semver.test(manifest.opencode.maximumTestedExclusive)) {
  throw new Error("compatibility.json must declare semantic OpenCode minimum and maximumTestedExclusive versions")
}
if (compare(manifest.opencode.minimum, manifest.opencode.maximumTestedExclusive) >= 0) {
  throw new Error("compatibility.json has an empty or inverted OpenCode version range")
}
if (!Array.isArray(manifest.helpContractVersions) || !manifest.helpContractVersions.includes(supportedContract)) {
  throw new Error(`bundle does not declare required help contract version ${supportedContract}`)
}
if (manifest.helpContractVersions.some(value => !Number.isInteger(value))) {
  throw new Error("compatibility.json helpContractVersions must contain only integers")
}
if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.length === 0) {
  throw new Error("compatibility.json must declare requiredFiles")
}
if (!manifest.requiredFiles.includes("src/update.ts")) throw new Error("compatibility.json requiredFiles must include src/update.ts")
for (const relative of manifest.requiredFiles) {
  if (typeof relative !== "string" || !relative || relative.includes("\n") || relative.includes("\r") || path.isAbsolute(relative)) {
    throw new Error(`unsafe requiredFiles path: ${JSON.stringify(relative)}`)
  }
  const segments = relative.split(/[\\/]/)
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`unsafe requiredFiles path: ${relative}`)
  }
  bundleFile(relative)
}
if (!Array.isArray(manifest.requiredSkills) || !manifest.requiredSkills.includes("twg")) {
  throw new Error('compatibility.json must include the official root skill "twg"')
}
for (const skill of manifest.requiredSkills) {
  if (typeof skill !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) throw new Error(`invalid required skill name: ${skill}`)
}
console.log(`minimum\t${manifest.twgCli.minimum}`)
console.log(`maximum\t${manifest.twgCli.maximumTestedExclusive}`)
console.log(`opencodeMinimum\t${manifest.opencode.minimum}`)
console.log(`opencodeMaximum\t${manifest.opencode.maximumTestedExclusive}`)
for (const skill of manifest.requiredSkills) console.log(`skill\t${skill}`)
NODE
)"; then
    die "Bundle compatibility validation failed for $root."
  fi
  selected_minimum=""
  selected_maximum=""
  selected_opencode_minimum=""
  selected_opencode_maximum=""
  required_skills=()
  while IFS=$'\t' read -r kind value; do
    case "$kind" in
      minimum) selected_minimum="$value" ;;
      maximum) selected_maximum="$value" ;;
      opencodeMinimum) selected_opencode_minimum="$value" ;;
      opencodeMaximum) selected_opencode_maximum="$value" ;;
      skill) required_skills+=("$value") ;;
      *) die "Unexpected compatibility parser output." ;;
    esac
  done <<< "$output"
  [[ -n "$selected_minimum" && -n "$selected_maximum" && -n "$selected_opencode_minimum" && -n "$selected_opencode_maximum" && ${#required_skills[@]} -gt 0 ]] || die "Incomplete compatibility manifest in $root."
}

version_in_range() {
  node - "$1" "$2" "$3" <<'NODE'
const [installed, minimum, maximum] = process.argv.slice(2)
const parts = value => value.split(".").map(Number)
const compare = (leftValue, rightValue) => {
  const left = parts(leftValue); const right = parts(rightValue)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}
if (compare(installed, minimum) < 0 || compare(installed, maximum) >= 0) process.exit(1)
NODE
}

verify_required_skills() {
  local skill metadata universal_root opencode_root claude_root candidate installed_skill safe index directory
  local -a skill_anchors skill_roots
  universal_root="$HOME/.agents/skills"
  opencode_root="$config_dir/skills"
  claude_root="$HOME/.claude/skills"
  skill_anchors=("$HOME/.agents" "$config_dir" "$HOME/.claude")
  skill_roots=("$universal_root" "$opencode_root" "$claude_root")
  for skill in "${required_skills[@]}"; do
    installed_skill=""
    for index in "${!skill_roots[@]}"; do
      candidate="${skill_roots[$index]}/$skill/SKILL.md"
      [[ -f "$candidate" && -r "$candidate" && ! -L "$candidate" ]] || continue
      safe=true
      for directory in "${skill_anchors[$index]}" "${skill_roots[$index]}" "${skill_roots[$index]}/$skill"; do
        if [[ ! -d "$directory" || -L "$directory" ]]; then safe=false; break; fi
      done
      if $safe; then installed_skill="$candidate"; break; fi
    done
    if [[ -z "$installed_skill" ]]; then
      die "Required skill '$skill' is not installed as a regular, non-linked SKILL.md file. Checked: $universal_root/$skill/SKILL.md, $opencode_root/$skill/SKILL.md, and $claude_root/$skill/SKILL.md"
    fi

    # File availability is authoritative; CLI help is a secondary content/name integrity check.
    if ! metadata="$("$twg_bin" help describe "skill:$skill" -o json)"; then
      die "Installed skill '$skill' exists at '$installed_skill', but CLI help metadata is unavailable."
    fi
    if ! printf '%s' "$metadata" | node -e '
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => value += chunk);
      process.stdin.on("end", () => {
        const metadata = JSON.parse(value);
        if (metadata.kind !== "skill_help" || metadata.name !== process.argv[1]) process.exit(1);
      });
    ' "$skill"; then
      die "The required TWG skill '$skill' returned unexpected help metadata."
    fi
  done
}

assert_checkout_trust() {
  local checkout="$1" trusted="$2" check_pin="$3" require_clean="$4"
  local actual upstream status pin
  actual="$(git_output -C "$checkout" remote get-url origin)"
  validate_repo_url "$actual"
  [[ "$actual" == "$trusted" ]] || die "Checkout origin '$actual' does not match trusted origin '$trusted'."
  if [[ "$check_pin" == true && -f "$checkout/.twg-update-origin" ]]; then
    pin="$(cat "$checkout/.twg-update-origin")"
    validate_repo_url "$pin"
    [[ "$pin" == "$actual" ]] || die "Installed origin pin '$pin' does not match '$actual'."
  fi
  upstream="$(git_output -C "$checkout" rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
  [[ "$upstream" == origin/* ]] || die "Checkout upstream '$upstream' is not trusted; expected origin/<branch>."
  if [[ "$require_clean" == true ]]; then
    status="$(git_output -C "$checkout" status --porcelain --untracked-files=all)"
    [[ -z "$status" ]] || { printf 'The installed checkout has local changes and was not changed:\n%s\n' "$status" >&2; exit 1; }
  fi
  printf '%s' "${upstream#origin/}"
}

assert_bootstrap_available() {
  local plugins_dir tracked exclude_path first_line
  plugins_dir="$(dirname "$bootstrap_path")"
  if [[ -e "$plugins_dir" ]] && [[ ! -d "$plugins_dir" || -L "$plugins_dir" ]]; then
    die "$plugins_dir is not a regular directory; refusing to write the bootstrap."
  fi
  if [[ -d "$plugins_dir" && ! -w "$plugins_dir" ]]; then die "$plugins_dir is not writable."; fi
  if [[ -e "$bootstrap_path" || -L "$bootstrap_path" ]]; then
    [[ -f "$bootstrap_path" && ! -L "$bootstrap_path" ]] || die "$bootstrap_path is not a regular installer-owned file."
    [[ -w "$bootstrap_path" ]] || die "$bootstrap_path is not writable."
    IFS= read -r first_line < "$bootstrap_path" || true
    [[ "$first_line" == "$managed_marker" ]] || die "$bootstrap_path exists and is not managed by this installer."
  fi
  if [[ -e "$config_dir/.git" ]]; then
    tracked="$(git_output -C "$config_dir" ls-files -- "$bootstrap_relative")"
    [[ -z "$tracked" ]] || die "$bootstrap_relative is tracked by the existing OpenCode config repository; refusing to overwrite it."
    exclude_path="$(git_output -C "$config_dir" rev-parse --path-format=absolute --git-path info/exclude)"
    if [[ -e "$exclude_path" || -L "$exclude_path" ]]; then
      [[ -f "$exclude_path" && ! -L "$exclude_path" ]] || die "$exclude_path is not a regular file; refusing to modify it."
      [[ -w "$exclude_path" ]] || die "$exclude_path is not writable."
    fi
  fi
}

atomic_write() {
  local destination="$1" content="$2" parent temporary
  parent="$(dirname "$destination")"
  mkdir -p "$parent" || return 1
  temporary="$(mktemp "$parent/.twg-installer.XXXXXX")" || return 1
  if ! printf '%s' "$content" > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  if ! mv -f -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    return 1
  fi
}

atomic_append_line() {
  if ! node - "$1" "$2" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const destination = process.argv[2]
const line = process.argv[3]
fs.mkdirSync(path.dirname(destination), { recursive: true })
const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : Buffer.alloc(0)
const separator = existing.length > 0 && existing[existing.length - 1] !== 10 ? Buffer.from("\n") : Buffer.alloc(0)
const temporary = path.join(path.dirname(destination), `.twg-installer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
try {
  fs.writeFileSync(temporary, Buffer.concat([existing, separator, Buffer.from(`${line}\n`)]), { flag: "wx" })
  fs.renameSync(temporary, destination)
} finally {
  try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
}
NODE
  then
    return 1
  fi
}

canonical_bundle_info() {
  node - "$1" <<'NODE'
const fs = require("node:fs")
const { createHash } = require("node:crypto")
const { tmpdir } = require("node:os")
const { basename, dirname, join, resolve } = require("node:path")
const physicalPath = value => {
  let current = resolve(value)
  const suffix = []
  while (true) {
    try { return resolve(fs.realpathSync(current), ...suffix) }
    catch (error) {
      if (error.code !== "ENOENT") throw error
      try {
        fs.lstatSync(current)
        throw error
      } catch (entryError) {
        if (entryError === error || entryError.code !== "ENOENT") throw entryError
      }
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(basename(current))
      current = parent
    }
  }
}
const root = physicalPath(process.argv[2])
const hash = createHash("sha256").update(root).digest("hex").slice(0, 16)
console.log(`${root}\t${join(tmpdir(), `twg-agent-update-${hash}.lock`)}`)
NODE
}

acquire_update_lock() {
  local bundle="$1" info root lock_path token output existing
  info="$(canonical_bundle_info "$bundle")"
  IFS=$'\t' read -r root lock_path <<< "$info"
  for existing in "${held_lock_paths[@]}"; do [[ "$existing" != "$lock_path" ]] || return; done
  token="$(node -e 'console.log(require("node:crypto").randomUUID())')"
  if ! output="$(node - "$lock_path" "$token" "$$" <<'NODE'
const fs = require("node:fs")
const lockPath = process.argv[2]
const token = process.argv[3]
const pid = Number(process.argv[4])
const payload = JSON.stringify({ token, pid, updatedAt: new Date().toISOString() })
const staleEmptyMs = 5 * 60 * 1000
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`
const restore = quarantine => {
  try {
    fs.linkSync(quarantine, lockPath)
    fs.unlinkSync(quarantine)
  } catch {}
}
function live(ownerPid) {
  try { process.kill(ownerPid, 0); return true }
  catch (error) { if (error.code === "ESRCH") return false; return true }
}
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" })
    console.log("acquired")
    process.exit(0)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  const observedInfo = fs.statSync(lockPath, { bigint: true })
  const observed = fs.readFileSync(lockPath)
  let owner
  try { owner = JSON.parse(observed.toString("utf8")) } catch {}
  const valid = owner && typeof owner.token === "string" && owner.token && Number.isInteger(owner.pid) && owner.pid > 0
  if (valid) {
    if (live(owner.pid)) throw new Error(`update lock is owned by live process ${owner.pid}`)
  } else if (observed.length !== 0 || Date.now() - Number(observedInfo.mtimeMs) < staleEmptyMs) {
    throw new Error(`update lock ${lockPath} is malformed or may still be initializing; refusing unsafe takeover`)
  }
  const quarantine = `${lockPath}.stale-${pid}-${token}-${attempt}`
  fs.renameSync(lockPath, quarantine)
  const quarantinedInfo = fs.statSync(quarantine, { bigint: true })
  const quarantined = fs.readFileSync(quarantine)
  if (identity(quarantinedInfo) !== identity(observedInfo) || !quarantined.equals(observed)) {
    restore(quarantine)
    throw new Error("update lock changed ownership during stale-lock quarantine; refusing takeover")
  }
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" })
  } catch (error) {
    fs.unlinkSync(quarantine)
    if (error.code === "EEXIST") continue
    throw error
  }
  fs.unlinkSync(quarantine)
  console.log("acquired")
  process.exit(0)
}
throw new Error(`could not acquire update lock ${lockPath}`)
NODE
)"; then
    die "Could not acquire TWG update lock for $root."
  fi
  [[ "$output" == "acquired" ]] || die "Unexpected update-lock result for $root."
  held_lock_paths+=("$lock_path")
  held_lock_tokens+=("$token")
}

release_update_locks() {
  local index
  for ((index=${#held_lock_paths[@]}-1; index>=0; index--)); do
    node - "${held_lock_paths[$index]}" "${held_lock_tokens[$index]}" <<'NODE' || true
const fs = require("node:fs")
const lockPath = process.argv[2]
const token = process.argv[3]
const quarantine = `${lockPath}.release-${process.pid}-${token}`
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`
const restore = () => {
  try {
    fs.linkSync(quarantine, lockPath)
    fs.unlinkSync(quarantine)
  } catch {}
}
let observedInfo, observed
try {
  observedInfo = fs.statSync(lockPath, { bigint: true })
  observed = fs.readFileSync(lockPath)
  const owner = JSON.parse(observed.toString("utf8"))
  if (owner.token !== token) process.exit(0)
} catch { process.exit(0) }
try { fs.renameSync(lockPath, quarantine) }
catch (error) { if (error.code === "ENOENT") process.exit(0); throw error }
const quarantinedInfo = fs.statSync(quarantine, { bigint: true })
const quarantined = fs.readFileSync(quarantine)
if (identity(quarantinedInfo) !== identity(observedInfo) || !quarantined.equals(observed)) {
  restore()
  process.exit(0)
}
let owner
try { owner = JSON.parse(quarantined.toString("utf8")) } catch {}
if (owner?.token === token) fs.unlinkSync(quarantine); else restore()
NODE
  done
  held_lock_paths=()
  held_lock_tokens=()
}

managed_bootstrap_root() {
  if [[ -L "$bootstrap_path" || ( -e "$bootstrap_path" && ! -f "$bootstrap_path" ) ]]; then
    echo "$bootstrap_path is not a regular managed bootstrap file." >&2
    return 1
  fi
  [[ -f "$bootstrap_path" ]] || return 0
  node - "$bootstrap_path" "$managed_marker" <<'NODE'
const fs = require("node:fs")
const { dirname, join, resolve } = require("node:path")
const { fileURLToPath } = require("node:url")
const bootstrap = process.argv[2]
const marker = process.argv[3]
const content = fs.readFileSync(bootstrap, "utf8")
const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const match = content.match(new RegExp(`^${escaped}\\r?\\nexport \\{ default \\} from \"([^\"\\r\\n]+)\"\\r?\\n?$`))
if (!match) throw new Error("managed bootstrap content is invalid")
const uri = new URL(match[1])
if (uri.protocol !== "file:") throw new Error("managed bootstrap target is not a local file URI")
const plugin = resolve(fileURLToPath(uri))
const lexicalRoot = resolve(dirname(plugin), "..")
if (plugin !== join(lexicalRoot, "plugins", "twg-agent.ts")) throw new Error("managed bootstrap target is not a bundle plugin path")
for (const [component, directory] of [[lexicalRoot, true], [join(lexicalRoot, "plugins"), true], [plugin, false]]) {
  if (!fs.existsSync(component)) continue
  const info = fs.lstatSync(component)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error(`unsafe managed bootstrap target: ${component}`)
}
const root = fs.existsSync(lexicalRoot) ? fs.realpathSync(lexicalRoot) : lexicalRoot
if (!fs.existsSync(plugin)) {
  console.error(`Managed bootstrap target ${plugin} is missing; its canonical updater lock will still be held while the installer repairs the bootstrap.`)
} else if (fs.realpathSync(plugin) !== join(root, "plugins", "twg-agent.ts")) {
  throw new Error("managed bootstrap target is not physically inside its bundle root")
}
console.log(root)
NODE
}

create_owned_stage() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const stage = process.argv[2]
const token = process.argv[3]
fs.mkdirSync(stage)
const marker = JSON.stringify({ owner: "twg-opencode-agent-installer-stage", token, createdAt: new Date().toISOString() })
fs.writeFileSync(path.join(stage, ".twg-installer-stage.json"), `${marker}\n`, { flag: "wx" })
NODE
}

remove_owned_stage() {
  local path="$1" expected_token="$2" marker owner token
  [[ "$(dirname "$path")" == "$versions_dir" && "$(basename "$path")" == .stage-* && -d "$path" && ! -L "$path" ]] || return 0
  marker="$path/.twg-installer-stage.json"
  [[ -f "$marker" && ! -L "$marker" ]] || return 0
  if ! IFS=$'\t' read -r owner token < <(node - "$marker" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
console.log(`${value.owner ?? ""}\t${value.token ?? ""}`)
NODE
  ); then return 0; fi
  [[ "$owner" == "twg-opencode-agent-installer-stage" && "$token" == "$expected_token" ]] || return 0
  rm -rf -- "$path"
}

publish_owned_version() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const source = process.argv[2]
const destination = process.argv[3]
const token = process.argv[4]
const markerName = ".twg-installer-version.json"
const sourceInfo = fs.lstatSync(source)
if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("staged checkout is not a regular directory")
const markerInfo = fs.lstatSync(path.join(source, markerName))
if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error("staged checkout ownership marker is not a regular file")
const markerContent = fs.readFileSync(path.join(source, markerName))
const marker = JSON.parse(markerContent.toString("utf8"))
if (marker.owner !== "twg-opencode-agent-installer" || marker.token !== token) throw new Error("staged checkout ownership marker does not match")
fs.mkdirSync(destination)
fs.writeFileSync(path.join(destination, markerName), markerContent, { flag: "wx" })
for (const name of fs.readdirSync(source)) {
  if (name === markerName) continue
  fs.cpSync(path.join(source, name), path.join(destination, name), {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
}
NODE
}

smoke_import_plugin() {
  local plugin_url
  plugin_url="$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' -- "$1/plugins/twg-agent.ts")"
  node --experimental-strip-types --input-type=module -e \
    'import(process.argv[1]).then(m=>{if(typeof m.default!==process.argv[2])process.exit(1)})' \
    -- "$plugin_url" function
}

remove_owned_version() {
  local path="$1" expected_token="${2:-}" marker owner token managed_root
  [[ "$(dirname "$path")" == "$versions_dir" && "$(basename "$path")" == version-* && -d "$path" && ! -L "$path" ]] || return 0
  marker="$path/.twg-installer-version.json"
  [[ -f "$marker" && ! -L "$marker" ]] || return 0
  if ! IFS=$'\t' read -r owner token < <(node - "$marker" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
console.log(`${value.owner ?? ""}\t${value.token ?? ""}`)
NODE
); then return 0; fi
  [[ "$owner" == "twg-opencode-agent-installer" ]] || return 0
  [[ -z "$expected_token" || "$token" == "$expected_token" ]] || return 0
  if ! managed_root="$(managed_bootstrap_root)"; then
    echo "Warning: could not verify the managed bootstrap target; preserving installer-owned version $path." >&2
    return 0
  fi
  [[ -z "$managed_root" || "$managed_root" != "$path" ]] || return 0
  rm -rf -- "$path"
}

remove_old_installer_versions() {
  local active="$1" protected="${2:-}" old
  while IFS= read -r old; do
    [[ -n "$old" ]] && remove_owned_version "$old"
  done < <(node - "$versions_dir" "$active" "$protected" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const root = process.argv[2]
const active = path.resolve(process.argv[3])
const protectedPath = process.argv[4] ? path.resolve(process.argv[4]) : ""
if (!fs.existsSync(root)) process.exit(0)
const owned = []
for (const name of fs.readdirSync(root)) {
  if (!name.startsWith("version-")) continue
  const directory = path.join(root, name)
  if (path.resolve(directory) === active || path.resolve(directory) === protectedPath) continue
  try {
    const info = fs.lstatSync(directory)
    const markerInfo = fs.lstatSync(path.join(directory, ".twg-installer-version.json"))
    const marker = JSON.parse(fs.readFileSync(path.join(directory, ".twg-installer-version.json"), "utf8"))
    if (info.isDirectory() && !info.isSymbolicLink() && markerInfo.isFile() && !markerInfo.isSymbolicLink() && marker.owner === "twg-opencode-agent-installer") {
      owned.push({ directory, time: info.mtimeMs })
    }
  } catch {}
}
owned.sort((left, right) => right.time - left.time)
for (const entry of owned.slice(2)) console.log(entry.directory)
NODE
)
}

rollback_development_marker() {
  [[ "$development_marker_rollback_pending" == true ]] || return 0
  if $development_marker_existed; then
    if $development_marker_backup_ready; then
      if [[ -z "$development_marker_backup" || ! -f "$development_marker_backup" || -L "$development_marker_backup" ]] ||
         ! mv -f -- "$development_marker_backup" "$development_marker_path"; then
        echo "Warning: could not restore the prior development marker at $development_marker_path; preserving backup $development_marker_backup." >&2
        return 1
      fi
      development_marker_backup=""
      development_marker_backup_ready=false
    elif [[ -n "$development_marker_backup" ]]; then
      rm -f -- "$development_marker_backup" || return 1
      development_marker_backup=""
    fi
  elif [[ -e "$development_marker_path" || -L "$development_marker_path" ]]; then
    if [[ ! -f "$development_marker_path" || -L "$development_marker_path" ]] || ! rm -f -- "$development_marker_path"; then
      echo "Warning: could not safely remove the new development marker at $development_marker_path." >&2
      return 1
    fi
  fi
  development_marker_rollback_pending=false
}

cleanup_installer() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  rollback_development_marker
  if [[ "$development_marker_rollback_pending" != true && -n "$development_marker_backup" &&
        -f "$development_marker_backup" && ! -L "$development_marker_backup" ]]; then
    rm -f -- "$development_marker_backup"
  fi
  if [[ -n "$stage_dir" && -n "$stage_token" ]]; then
    remove_owned_stage "$stage_dir" "$stage_token"
  fi
  if [[ "$activation_succeeded" != true && -n "$pending_version_dir" ]]; then
    remove_owned_version "$pending_version_dir" "$pending_version_token"
  fi
  release_update_locks
  exit "$status"
}

command -v git >/dev/null 2>&1 || die "git was not found on PATH."
command -v node >/dev/null 2>&1 || die "node was not found on PATH. Install Node.js, then re-run."
command -v npm >/dev/null 2>&1 || die "npm was not found on PATH. Install Node.js/npm, then re-run."
node --version
npm --version
trap cleanup_installer EXIT
trap 'exit 130' INT TERM

installation_info="$(canonical_bundle_info "$versions_dir")"
IFS=$'\t' read -r versions_dir _installation_lock_path <<< "$installation_info"
acquire_update_lock "$versions_dir"
mkdir -p "$versions_dir"
[[ -d "$versions_dir" && ! -L "$versions_dir" ]] || die "$versions_dir is not a regular versions directory."
versions_info="$(canonical_bundle_info "$versions_dir")"
IFS=$'\t' read -r versions_dir _versions_lock_path <<< "$versions_info"
install_info="$(canonical_bundle_info "$install_dir")"
IFS=$'\t' read -r install_dir _install_lock_path <<< "$install_info"

# Validate this installer source before it can select or replace the active runtime checkout.
load_manifest "$script_root"
assert_bootstrap_available
active_root="$(managed_bootstrap_root)"
if [[ -n "$active_root" ]]; then
  active_info="$(canonical_bundle_info "$active_root")"
  IFS=$'\t' read -r active_root _active_lock_path <<< "$active_info"
  acquire_update_lock "$active_root"
fi

if twg_candidate="$(command -v twg)"; then
  twg_bin="$twg_candidate"
elif [[ -x "${HOME}/.local/bin/twg" ]]; then
  twg_bin="${HOME}/.local/bin/twg"
else
  die "TWG CLI was not found. Install TWG, then re-run."
fi
if opencode_candidate="$(command -v opencode)"; then
  opencode_bin="$opencode_candidate"
else
  die "OpenCode executable was not found on PATH. Install OpenCode, open a new terminal, and re-run."
fi

bundle_root="$script_root"
if ! $development; then
  existing_root=""
  if [[ -n "$active_root" && ( -d "$active_root/.git" || -f "$active_root/.git" ) ]]; then
    existing_root="$active_root"
  elif [[ -d "$install_dir/.git" || -f "$install_dir/.git" ]]; then
    existing_root="$install_dir"
  fi
  if [[ -z "$repo_url" ]]; then
    if [[ -e "$script_root/.git" ]]; then repo_url="$(optional_origin "$script_root")"; fi
    if [[ -z "$repo_url" && -n "$existing_root" && -f "$existing_root/.twg-update-origin" ]]; then
      repo_url="$(cat "$existing_root/.twg-update-origin")"
    fi
  fi
  [[ -n "$repo_url" ]] || die "No repository URL was found. Pass --repo-url or use --development."
  validate_repo_url "$repo_url"

  branch=""
  if [[ -n "$existing_root" ]]; then
    branch="$(assert_checkout_trust "$existing_root" "$repo_url" true true)"
    git check-ref-format --branch "$branch" >/dev/null
  fi

  stage_token="$(node -e 'console.log(require("node:crypto").randomUUID())')"
  stage_dir="$versions_dir/.stage-$$-${RANDOM}${RANDOM}"
  create_owned_stage "$stage_dir" "$stage_token"
  stage_checkout="$stage_dir/checkout"
  echo "Preparing and validating a staged TWG agent checkout at $stage_checkout ..."
  clone_args=(clone --quiet)
  if [[ -n "$branch" ]]; then clone_args+=(--branch "$branch" --single-branch); fi
  clone_args+=(-- "$repo_url" "$stage_checkout")
  git "${clone_args[@]}"
  assert_checkout_trust "$stage_checkout" "$repo_url" false false >/dev/null
  load_manifest "$stage_checkout"
  bundle_root="$stage_checkout"
fi

if ! opencode_version_output="$("$opencode_bin" --version)"; then
  die "$opencode_bin --version failed."
fi
printf '%s\n' "$opencode_version_output"
if [[ "$opencode_version_output" =~ (^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)[-+] ]]; then
  die "OpenCode must report a release semantic version without prerelease or build metadata."
elif [[ "$opencode_version_output" =~ (^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)($|[^0-9]) ]]; then
  opencode_version="${BASH_REMATCH[2]}"
else
  die "Could not determine the OpenCode semantic version."
fi
version_in_range "$opencode_version" "$selected_opencode_minimum" "$selected_opencode_maximum" || die "OpenCode $opencode_version is outside the supported range >=$selected_opencode_minimum and <$selected_opencode_maximum."

twg_version_output="$("$twg_bin" --version)"
printf '%s\n' "$twg_version_output"
if [[ "$twg_version_output" =~ (^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)[-+] ]]; then
  die "TWG CLI must report a release semantic version without prerelease or build metadata."
elif [[ "$twg_version_output" =~ (^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)($|[^0-9]) ]]; then
  twg_version="${BASH_REMATCH[2]}"
else
  die "Could not determine the TWG CLI semantic version."
fi
version_in_range "$twg_version" "$selected_minimum" "$selected_maximum" || die "TWG CLI $twg_version is outside the supported range >=$selected_minimum and <$selected_maximum."

if ! $skip_twg_skills; then
  echo "Installing official TWG skills without pruning custom twg-* directories ..."
  "$twg_bin" skills install --yes --no-prune
else
  echo "Skipping TWG skill installation; verifying existing OpenCode-visible skill files ..."
fi
verify_required_skills

if ! $skip_dependencies; then
  if $development; then (cd "$bundle_root" && npm install)
  else (cd "$bundle_root" && npm ci --omit=dev)
  fi
fi
smoke_import_plugin "$bundle_root"

if [[ -e "$config_dir/.git" ]]; then
  exclude_path="$(git_output -C "$config_dir" rev-parse --path-format=absolute --git-path info/exclude)"
  if [[ ! -f "$exclude_path" ]] || ! grep -Fxq "$bootstrap_relative" "$exclude_path"; then
    atomic_append_line "$exclude_path" "$bootstrap_relative"
  fi
fi

if $development; then
  bundle_info="$(canonical_bundle_info "$bundle_root")"
  IFS=$'\t' read -r bundle_root _bundle_lock_path <<< "$bundle_info"
  if [[ -z "$active_root" || "$bundle_root" != "$active_root" ]]; then acquire_update_lock "$bundle_root"; fi
  development_marker_path="$bundle_root/.twg-development"
  if [[ -f "$development_marker_path" && ! -L "$development_marker_path" ]]; then
    development_marker_existed=true
    development_marker_rollback_pending=true
    development_marker_backup="$(mktemp "$(dirname "$development_marker_path")/.twg-development.backup.XXXXXX")"
    cp -- "$development_marker_path" "$development_marker_backup"
    development_marker_backup_ready=true
  elif [[ -e "$development_marker_path" || -L "$development_marker_path" ]]; then
    die "$development_marker_path is not a regular development marker."
  else
    development_marker_rollback_pending=true
  fi
  atomic_write "$development_marker_path" $'Development checkout: update checks disabled.\n'
  plugin_url="$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' -- "$bundle_root/plugins/twg-agent.ts")"
  trap '' INT TERM
  bootstrap_status=0
  atomic_write "$bootstrap_path" "$managed_marker"$'\n''export { default } from "'"$plugin_url"$'"\n' || bootstrap_status=$?
  if [[ "$bootstrap_status" -eq 0 ]]; then
    development_marker_rollback_pending=false
    if [[ -n "$development_marker_backup" ]]; then
      rm -f -- "$development_marker_backup"
      development_marker_backup=""
      development_marker_backup_ready=false
    fi
  else
    rollback_development_marker || true
  fi
  trap 'exit 130' INT TERM
  if [[ "$bootstrap_status" -ne 0 ]]; then
    die "Could not atomically activate the development checkout."
  fi
  activation_succeeded=true
else
  [[ ! -e "$stage_checkout/.twg-development" ]] || die "The staged repository unexpectedly contains .twg-development; refusing to activate it."
  atomic_write "$stage_checkout/.twg-update-origin" "$repo_url"$'\n'
  version="$(cat "$stage_checkout/VERSION")"
  [[ "$version" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ ]] || die "Invalid bundle VERSION '$version'."
  head="$(git_output -C "$stage_checkout" rev-parse --short=12 HEAD)"
  pending_version_token="$(node -e 'console.log(require("node:crypto").randomUUID())')"
  pending_version_dir="$versions_dir/version-$version-$head-${pending_version_token:0:8}"
  info_exclude="$(git_output -C "$stage_checkout" rev-parse --path-format=absolute --git-path info/exclude)"
  if [[ ! -f "$info_exclude" ]] || ! grep -Fxq '.twg-installer-version.json' "$info_exclude"; then
    atomic_append_line "$info_exclude" '.twg-installer-version.json'
  fi
  version_marker="$(node -e 'console.log(JSON.stringify({ owner: "twg-opencode-agent-installer", token: process.argv[1], createdAt: new Date().toISOString() }))' "$pending_version_token")"
  atomic_write "$stage_checkout/.twg-installer-version.json" "$version_marker"$'\n'
  load_manifest "$stage_checkout"
  smoke_import_plugin "$stage_checkout"
  stage_status="$(git_output -C "$stage_checkout" status --porcelain --untracked-files=all)"
  [[ -z "$stage_status" ]] || { printf 'The staged checkout became dirty; the active checkout was not changed:\n%s\n' "$stage_status" >&2; exit 1; }

  publish_owned_version "$stage_checkout" "$pending_version_dir" "$pending_version_token"
  assert_checkout_trust "$pending_version_dir" "$repo_url" false false >/dev/null
  load_manifest "$pending_version_dir"
  smoke_import_plugin "$pending_version_dir"
  published_status="$(git_output -C "$pending_version_dir" status --porcelain --untracked-files=all)"
  [[ -z "$published_status" ]] || { printf 'The published checkout is not clean; the active checkout was not changed:\n%s\n' "$published_status" >&2; exit 1; }
  bundle_info="$(canonical_bundle_info "$pending_version_dir")"
  IFS=$'\t' read -r bundle_root _bundle_lock_path <<< "$bundle_info"
  acquire_update_lock "$bundle_root"
  plugin_url="$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' -- "$bundle_root/plugins/twg-agent.ts")"
  atomic_write "$bootstrap_path" "$managed_marker"$'\n''export { default } from "'"$plugin_url"$'"\n'
  activation_succeeded=true
  if ! remove_old_installer_versions "$bundle_root" "$active_root"; then
    echo "Warning: installed successfully, but old version cleanup failed." >&2
  fi
fi

echo
echo "TWG agent installed from $bundle_root"
echo "Bootstrap: $bootstrap_path"
echo "Quit and restart OpenCode, select the twg agent, then run /twg-version."
