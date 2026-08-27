<#
.SYNOPSIS
  Install or update the TWG agent beside existing global OpenCode bundles.
.DESCRIPTION
  Validates the bundle, tools, official TWG skills, Git trust boundary, and bootstrap ownership
  before atomically switching the managed bootstrap. Normal installs keep tracked runtime files in versioned
  directories, and the active checkout is never moved away during installation.
.PARAMETER RepoUrl
  Private Git repository URL. Defaults to this checkout's origin URL or the installed origin pin.
.PARAMETER Development
  Register this checkout directly and disable its update checker.
.PARAMETER SkipDependencies
  Do not install npm dependencies. The selected bundle must already have its runtime dependencies.
.PARAMETER SkipTwgSkills
  Do not reinstall official TWG skills. Required OpenCode-visible skill files are still verified.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string] $RepoUrl,
  [switch] $Development,
  [switch] $SkipDependencies,
  [switch] $SkipTwgSkills
)

$ErrorActionPreference = 'Stop'
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { $HOME }
if ([string]::IsNullOrWhiteSpace($HomeDir)) { throw 'Could not determine the user home directory.' }
$ConfigBase = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HomeDir '.config' }
$InstallDir = Join-Path $env:LOCALAPPDATA 'opencode\bundles\twg-agent'
$VersionsDir = Join-Path $env:LOCALAPPDATA 'opencode\bundles\twg-agent-versions'
$ConfigDir = Join-Path $ConfigBase 'opencode'
$BootstrapRelativePath = 'plugins/twg-agent-bootstrap.ts'
$BootstrapPath = Join-Path $ConfigDir 'plugins\twg-agent-bootstrap.ts'
$ManagedMarker = '// Managed by twg-opencode-agent installer.'
$SupportedHelpContractVersion = 1

function Invoke-Git {
  param([Parameter(Mandatory)][string[]] $GitArgs)
  & git @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

function Invoke-GitOutput {
  param([Parameter(Mandatory)][string[]] $GitArgs)
  $output = & git @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
  return ($output -join "`n").Trim()
}

function Get-OptionalGitConfig {
  param(
    [Parameter(Mandatory)][string] $Repository,
    [Parameter(Mandatory)][string] $Key
  )
  $output = & git -C $Repository config --get $Key
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) { return ($output -join "`n").Trim() }
  if ($exitCode -eq 1) { return '' }
  throw "git config --get $Key failed with exit code $exitCode"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string] $Command,
    [Parameter(Mandatory)][string[]] $Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory)][string] $Script,
    [string[]] $Arguments = @()
  )
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  $launcher = 'const a=process.argv.splice(1,2);eval(Buffer.from(a[0],a[1]).toString())'
  $output = @(& node -e $launcher -- $encoded base64 @Arguments)
  if ($LASTEXITCODE -ne 0) { throw "Node filesystem operation failed with exit code $LASTEXITCODE." }
  return ($output -join "`n").Trim()
}

function Write-AtomicText {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Content
  )
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $temporary = Join-Path $parent ('.twg-installer-' + [IO.Path]::GetRandomFileName())
  $backup = "$temporary.backup"
  try {
    [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [IO.File]::Replace($temporary, $Path, $backup, $true)
    }
    else {
      [IO.File]::Move($temporary, $Path)
    }
  }
  finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  }
}

function Test-RepositoryUrl {
  param([Parameter(Mandatory)][string] $Value)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim()) {
    throw 'The repository URL must be a non-empty value without surrounding whitespace.'
  }
  if ($Value.StartsWith('-')) { throw "Repository URL '$Value' looks like a command-line option." }
  if ($Value -match '[\x00-\x1f\x7f]') { throw 'The repository URL contains control characters.' }

  $uri = $null
  if ([Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -ne 'file') {
    if ($uri.Query -or $uri.Fragment) {
      throw 'Repository URLs with query strings or fragments are not accepted because they may contain credentials.'
    }
    if (($uri.Scheme -in @('http', 'https')) -and $uri.UserInfo) {
      throw 'Credential-bearing HTTP(S) repository URLs are not accepted. Configure credentials outside the URL.'
    }
    if ($uri.UserInfo -match ':') {
      throw 'Repository URLs containing a password are not accepted. Configure credentials outside the URL.'
    }
  }
  elseif ($Value -match '^[^/@\s:]+:[^@\s]+@') {
    throw 'Credential-bearing repository URLs are not accepted. Configure credentials outside the URL.'
  }
}

function Read-CompatibilityManifest {
  param([Parameter(Mandatory)][string] $Root)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $rootItem = Get-Item -Force -LiteralPath $rootFull -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Invalid TWG agent bundle: $Root must be a regular directory."
  }
  $rootPrefix = $rootFull + [IO.Path]::DirectorySeparatorChar

  function Assert-RegularBundleFile {
    param([Parameter(Mandatory)][string] $RelativePath)
    $segments = @($RelativePath -split '[\\/]')
    $current = $rootFull
    for ($index = 0; $index -lt $segments.Count; $index++) {
      $current = Join-Path $current $segments[$index]
      try { $item = Get-Item -Force -LiteralPath $current -ErrorAction Stop }
      catch { throw "Invalid TWG agent bundle: required file '$RelativePath' is missing or non-regular." }
      $isLeaf = $index -eq $segments.Count - 1
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          ($isLeaf -and $item.PSIsContainer) -or
          (-not $isLeaf -and -not $item.PSIsContainer)) {
        throw "Invalid TWG agent bundle: file '$RelativePath' contains a linked or non-regular path component."
      }
    }
    $physical = [IO.Path]::GetFullPath($current)
    if (-not $physical.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Invalid TWG agent bundle: file '$RelativePath' is not physically inside the bundle."
    }
    return $physical
  }

  $manifestPath = Assert-RegularBundleFile 'compatibility.json'
  try { $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json }
  catch { throw "Invalid compatibility.json in ${Root}: $($_.Exception.Message)" }

  if ($manifest.schemaVersion -isnot [int] -or $manifest.schemaVersion -ne 1) {
    throw "Unsupported compatibility.json schemaVersion '$($manifest.schemaVersion)'."
  }
  if (-not $manifest.twgCli -or
      $manifest.twgCli.minimum -isnot [string] -or
      $manifest.twgCli.maximumTestedExclusive -isnot [string] -or
      $manifest.twgCli.installVersion -isnot [string] -or
      $manifest.twgCli.minimum -notmatch '^\d+\.\d+\.\d+$' -or
      $manifest.twgCli.maximumTestedExclusive -notmatch '^\d+\.\d+\.\d+$' -or
      $manifest.twgCli.installVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw 'compatibility.json must declare semantic twgCli.minimum, maximumTestedExclusive, and installVersion versions.'
  }
  $minimum = [version]$manifest.twgCli.minimum
  $maximum = [version]$manifest.twgCli.maximumTestedExclusive
  $installVersion = [version]$manifest.twgCli.installVersion
  if ($minimum -ge $maximum) { throw 'compatibility.json has an empty or inverted TWG CLI version range.' }
  if ($installVersion -lt $minimum -or $installVersion -ge $maximum) {
    throw 'compatibility.json twgCli.installVersion must be inside the compatible range.'
  }
  if (-not $manifest.opencode -or
      $manifest.opencode.minimum -isnot [string] -or
      $manifest.opencode.maximumTestedExclusive -isnot [string] -or
      $manifest.opencode.minimum -notmatch '^\d+\.\d+\.\d+$' -or
      $manifest.opencode.maximumTestedExclusive -notmatch '^\d+\.\d+\.\d+$') {
    throw 'compatibility.json must declare semantic opencode.minimum and opencode.maximumTestedExclusive versions.'
  }
  if ([version]$manifest.opencode.minimum -ge [version]$manifest.opencode.maximumTestedExclusive) {
    throw 'compatibility.json has an empty or inverted OpenCode version range.'
  }

  if ($manifest.helpContractVersions -isnot [array]) { throw 'compatibility.json helpContractVersions must be an array.' }
  $contracts = @($manifest.helpContractVersions)
  if (@($contracts | Where-Object { $_ -isnot [int] }).Count -gt 0) {
    throw 'compatibility.json helpContractVersions must contain only integers.'
  }
  if ($contracts.Count -eq 0 -or $contracts -notcontains $SupportedHelpContractVersion) {
    throw "This installer requires help contract version $SupportedHelpContractVersion, which the bundle does not declare."
  }
  if ($manifest.requiredFiles -isnot [array]) { throw 'compatibility.json requiredFiles must be an array.' }
  $requiredFiles = @($manifest.requiredFiles)
  if ($requiredFiles.Count -eq 0) { throw 'compatibility.json must declare at least one required file.' }
  if ($requiredFiles -notcontains 'src/update.ts') { throw 'compatibility.json requiredFiles must include src/update.ts.' }
  foreach ($relativePath in $requiredFiles) {
    if ($relativePath -isnot [string] -or [string]::IsNullOrWhiteSpace($relativePath) -or
        $relativePath -match '[\r\n]' -or
        [IO.Path]::IsPathRooted($relativePath) -or
        @($relativePath -split '[\\/]' | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0) {
      throw "compatibility.json contains an unsafe requiredFiles path: '$relativePath'"
    }
    Assert-RegularBundleFile $relativePath | Out-Null
  }

  if ($manifest.requiredSkills -isnot [array]) { throw 'compatibility.json requiredSkills must be an array.' }
  $requiredSkills = @($manifest.requiredSkills)
  if ($requiredSkills.Count -eq 0 -or $requiredSkills -notcontains 'twg') {
    throw 'compatibility.json must include the official root skill "twg" in requiredSkills.'
  }
  foreach ($skill in $requiredSkills) {
    if ($skill -isnot [string] -or $skill -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
      throw "compatibility.json contains an invalid required skill name: '$skill'"
    }
  }
  return $manifest
}

function Assert-CliCompatibility {
  param(
    [Parameter(Mandatory)][string] $TwgPath,
    [Parameter(Mandatory)] $Manifest
  )
  $versionOutput = @(& $TwgPath --version)
  if ($LASTEXITCODE -ne 0) { throw "$TwgPath --version failed with exit code $LASTEXITCODE" }
  $versionText = ($versionOutput -join "`n").Trim()
  Write-Host $versionText
  if ($versionText -match '(?:^|[^0-9])\d+\.\d+\.\d+[-+]') {
    throw 'TWG CLI must report a release semantic version without prerelease or build metadata.'
  }
  $match = [regex]::Match($versionText, '(?:^|[^0-9A-Za-z.+-])(\d+\.\d+\.\d+)(?:$|[^0-9A-Za-z.+-])')
  if (-not $match.Success) { throw 'Could not determine the TWG CLI semantic version.' }
  $installed = [version]$match.Groups[1].Value
  $minimum = [version]$Manifest.twgCli.minimum
  $maximum = [version]$Manifest.twgCli.maximumTestedExclusive
  if ($installed -lt $minimum) { throw "TWG CLI $installed is older than required version $minimum." }
  if ($installed -ge $maximum) { Write-Warning "TWG CLI $installed is newer than the tested range below $maximum; continuing with live command contracts." }
}

function Assert-OpenCodeCompatibility {
  param(
    [Parameter(Mandatory)][string] $OpenCodePath,
    [Parameter(Mandatory)] $Manifest
  )
  $versionOutput = @(& $OpenCodePath --version)
  if ($LASTEXITCODE -ne 0) { throw "$OpenCodePath --version failed with exit code $LASTEXITCODE" }
  $versionText = ($versionOutput -join "`n").Trim()
  Write-Host $versionText
  if ($versionText -match '(?:^|[^0-9])\d+\.\d+\.\d+[-+]') {
    throw 'OpenCode must report a release semantic version without prerelease or build metadata.'
  }
  $match = [regex]::Match($versionText, '(?:^|[^0-9A-Za-z.+-])(\d+\.\d+\.\d+)(?:$|[^0-9A-Za-z.+-])')
  if (-not $match.Success) { throw 'Could not determine the OpenCode semantic version.' }
  $installed = [version]$match.Groups[1].Value
  $minimum = [version]$Manifest.opencode.minimum
  $maximum = [version]$Manifest.opencode.maximumTestedExclusive
  if ($installed -lt $minimum -or $installed -ge $maximum) {
    throw "OpenCode $installed is outside the supported range >=$minimum and <$maximum."
  }
}

function Get-FirstApplicationPath {
  param([Parameter(Mandatory)][string] $Name)
  $commands = @(Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
  if ($commands.Count -eq 0) { return $null }
  $path = $commands[0].Path
  if ([string]::IsNullOrWhiteSpace($path)) { $path = $commands[0].Source }
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return [IO.Path]::GetFullPath([string]$path)
}

function Install-OfficialTwgCli {
  param([Parameter(Mandatory)][string] $Version)
  $baseUrl = 'https://teamwork-graph.atlassian.com/cli'
  $installerPath = Join-Path ([IO.Path]::GetTempPath()) ("twg-install-$PID-$([Guid]::NewGuid().ToString('N')).ps1")
  $priorBaseUrl = $env:TWG_INSTALL_BASE_URL
  $priorVersion = $env:TWG_VERSION
  $priorDoNotTrack = $env:DO_NOT_TRACK
  $priorToken = $env:TWG_TOKEN
  $priorUser = $env:TWG_USER
  $priorPat = $env:TWG_INSTALLER_PAT
  $priorPath = $env:PATH
  try {
    $curlPath = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (-not (Test-Path -LiteralPath $curlPath -PathType Leaf)) { throw 'System curl.exe is required to bootstrap TWG CLI from the official Atlassian installer.' }
    Write-Host "TWG CLI was not found; installing supported version $Version from $baseUrl/install.ps1 ..."
    Invoke-Checked $curlPath @('-fsS', '--max-redirs', '0', '--max-filesize', '1048576', '--proto', '=https', '--tlsv1.2', "$baseUrl/install.ps1", '-o', $installerPath)
    $installerInfo = Get-Item -LiteralPath $installerPath
    if ($installerInfo.Length -le 0 -or $installerInfo.Length -gt 1MB) { throw 'Official TWG installer has an invalid size.' }
    $installerText = [IO.File]::ReadAllText($installerPath)
    foreach ($marker in @('Param(', 'SHA256SUMS-', 'SkipLogin', 'SkipSkills', 'setup finalize')) {
      if (-not $installerText.Contains($marker)) { throw 'Official TWG installer response did not match the expected structure.' }
    }
    $env:TWG_INSTALL_BASE_URL = $baseUrl
    $env:TWG_VERSION = $Version
    $env:DO_NOT_TRACK = '1'
    $env:PATH = @(
      (Join-Path $env:SystemRoot 'System32'),
      $env:SystemRoot,
      (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
    ) -join ';'
    Remove-Item -Path @('Env:TWG_TOKEN', 'Env:TWG_USER', 'Env:TWG_INSTALLER_PAT') -ErrorAction SilentlyContinue
    $powershellPath = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) { throw 'Could not resolve the current Windows PowerShell executable.' }
    Invoke-Checked $powershellPath @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installerPath,
      '-Version', $Version, '-SkipLogin', '-SkipSkills', '-Yes', '-Plugin', 'opencode'
    )
  }
  finally {
    if ($null -eq $priorBaseUrl) { Remove-Item Env:TWG_INSTALL_BASE_URL -ErrorAction SilentlyContinue }
    else { $env:TWG_INSTALL_BASE_URL = $priorBaseUrl }
    if ($null -eq $priorVersion) { Remove-Item Env:TWG_VERSION -ErrorAction SilentlyContinue }
    else { $env:TWG_VERSION = $priorVersion }
    if ($null -eq $priorDoNotTrack) { Remove-Item Env:DO_NOT_TRACK -ErrorAction SilentlyContinue }
    else { $env:DO_NOT_TRACK = $priorDoNotTrack }
    if ($null -eq $priorToken) { Remove-Item Env:TWG_TOKEN -ErrorAction SilentlyContinue } else { $env:TWG_TOKEN = $priorToken }
    if ($null -eq $priorUser) { Remove-Item Env:TWG_USER -ErrorAction SilentlyContinue } else { $env:TWG_USER = $priorUser }
    if ($null -eq $priorPat) { Remove-Item Env:TWG_INSTALLER_PAT -ErrorAction SilentlyContinue } else { $env:TWG_INSTALLER_PAT = $priorPat }
    $env:PATH = $priorPath
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-UnlinkedPathComponents {
  param([Parameter(Mandatory)][string] $Path)
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -Force -LiteralPath $cursor
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "TWG installation path contains a reparse point: $cursor"
      }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Assert-SafeSkillDestinations {
  param([Parameter(Mandatory)][object[]] $Skills)
  $roots = @(
    (Join-Path $HomeDir '.agents\skills'),
    (Join-Path $ConfigDir 'skills'),
    (Join-Path $HomeDir '.claude\skills')
  )
  foreach ($root in $roots) {
    Assert-UnlinkedPathComponents $root
    foreach ($skill in $Skills) {
      Assert-UnlinkedPathComponents (Join-Path $root $skill)
      Assert-UnlinkedPathComponents (Join-Path (Join-Path $root $skill) 'SKILL.md')
    }
  }
}

function Assert-RequiredSkills {
  param(
    [Parameter(Mandatory)][string] $TwgPath,
    [Parameter(Mandatory)][object[]] $Skills
  )
  foreach ($skill in $Skills) {
    $candidates = @(
      @{
        Directories = @((Join-Path $HomeDir '.agents'), (Join-Path $HomeDir '.agents\skills'), (Join-Path $HomeDir ".agents\skills\$skill"))
        Path = Join-Path $HomeDir ".agents\skills\$skill\SKILL.md"
      },
      @{
        Directories = @($ConfigDir, (Join-Path $ConfigDir 'skills'), (Join-Path $ConfigDir "skills\$skill"))
        Path = Join-Path $ConfigDir "skills\$skill\SKILL.md"
      },
      @{
        Directories = @((Join-Path $HomeDir '.claude'), (Join-Path $HomeDir '.claude\skills'), (Join-Path $HomeDir ".claude\skills\$skill"))
        Path = Join-Path $HomeDir ".claude\skills\$skill\SKILL.md"
      }
    )
    $installedSkill = $null
    foreach ($candidate in $candidates) {
      if (-not (Test-Path -LiteralPath $candidate.Path -PathType Leaf)) { continue }
      $safe = $true
      foreach ($path in @($candidate.Directories) + @($candidate.Path)) {
        $item = Get-Item -Force -LiteralPath $path
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($path -ne $candidate.Path -and -not $item.PSIsContainer) -or
            ($path -eq $candidate.Path -and $item.PSIsContainer)) {
          $safe = $false
          break
        }
      }
      if ($safe) {
        try {
          $stream = [IO.File]::OpenRead($candidate.Path)
          $stream.Dispose()
        }
        catch { $safe = $false }
      }
      if ($safe) {
        $installedSkill = $candidate.Path
        break
      }
    }
    if (-not $installedSkill) {
      $checked = ($candidates | ForEach-Object { $_.Path }) -join "`n  "
      throw "Required skill '$skill' is not installed as a regular, non-linked SKILL.md file in an OpenCode-visible location. Checked:`n  $checked"
    }

    # File availability is authoritative; CLI help is a secondary content/name integrity check.
    $output = @(& $TwgPath help describe "skill:$skill" -o json)
    if ($LASTEXITCODE -ne 0) { throw "Installed skill '$skill' exists at '$installedSkill', but CLI help metadata is unavailable." }
    try { $metadata = ($output -join "`n") | ConvertFrom-Json }
    catch { throw "The required TWG skill '$skill' returned invalid help metadata." }
    if ($metadata.kind -ne 'skill_help' -or $metadata.name -ne $skill) {
      throw "The required TWG skill '$skill' returned unexpected help metadata."
    }
  }
}

function Get-CanonicalBundleInfo {
  param([Parameter(Mandatory)][string] $Path)
  $script = @'
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");
const physicalPath = value => {
  let current = resolve(value);
  const suffix = [];
  while (true) {
    try { return resolve(fs.realpathSync(current), ...suffix); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        fs.lstatSync(current);
        throw error;
      } catch (entryError) {
        if (entryError === error || entryError.code !== "ENOENT") throw entryError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
};
const root = physicalPath(process.argv[1]);
const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
console.log(JSON.stringify({ root, lockPath: join(tmpdir(), `twg-agent-update-${hash}.lock`) }));
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
  $launcher = 'const a=process.argv.splice(1,2);eval(Buffer.from(a[0],a[1]).toString())'
  $output = @(& node -e $launcher -- $encoded base64 $Path)
  if ($LASTEXITCODE -ne 0) { throw "Could not normalize bundle path '$Path'." }
  return (($output -join "`n") | ConvertFrom-Json)
}

function Acquire-UpdateLock {
  param([Parameter(Mandatory)][string] $BundlePath)
  $info = Get-CanonicalBundleInfo $BundlePath
  $token = [Guid]::NewGuid().ToString('D')
  $script = @'
const fs = require("node:fs");
const lockPath = process.argv[1];
const token = process.argv[2];
const pid = Number(process.argv[3]);
const payload = JSON.stringify({ token, pid, updatedAt: new Date().toISOString() });
const staleEmptyMs = 5 * 60 * 1000;
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
const restore = quarantine => {
  try {
    fs.linkSync(quarantine, lockPath);
    fs.unlinkSync(quarantine);
  } catch {}
};
const live = ownerPid => {
  try { process.kill(ownerPid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    console.log("acquired");
    process.exit(0);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const observedInfo = fs.statSync(lockPath, { bigint: true });
  const observed = fs.readFileSync(lockPath);
  let owner;
  try { owner = JSON.parse(observed.toString("utf8")); } catch {}
  const valid = owner && typeof owner.token === "string" && owner.token && Number.isInteger(owner.pid) && owner.pid > 0;
  if (valid) {
    if (live(owner.pid)) throw new Error(`update lock is owned by live process ${owner.pid}`);
  } else if (observed.length !== 0 || Date.now() - Number(observedInfo.mtimeMs) < staleEmptyMs) {
    throw new Error(`update lock ${lockPath} is malformed or may still be initializing; refusing unsafe takeover`);
  }
  const quarantine = `${lockPath}.stale-${pid}-${token}-${attempt}`;
  fs.renameSync(lockPath, quarantine);
  const quarantinedInfo = fs.statSync(quarantine, { bigint: true });
  const quarantined = fs.readFileSync(quarantine);
  if (identity(quarantinedInfo) !== identity(observedInfo) || !quarantined.equals(observed)) {
    restore(quarantine);
    throw new Error("update lock changed ownership during stale-lock quarantine; refusing takeover");
  }
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
  } catch (error) {
    fs.unlinkSync(quarantine);
    if (error.code === "EEXIST") continue;
    throw error;
  }
  fs.unlinkSync(quarantine);
  console.log("acquired");
  process.exit(0);
}
throw new Error(`could not acquire update lock ${lockPath}`);
'@
  $result = Invoke-NodeScript -Script $script -Arguments @($info.lockPath, $token, [string]$PID)
  if ($result -ne 'acquired') { throw "Unexpected update-lock result for '$($info.root)'." }
  return [pscustomobject]@{ Path = $info.lockPath; Token = $token; Root = $info.root }
}

function Release-UpdateLock {
  param($Lock)
  if (-not $Lock) { return }
  $script = @'
const fs = require("node:fs");
const lockPath = process.argv[1];
const token = process.argv[2];
const quarantine = `${lockPath}.release-${process.pid}-${token}`;
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
const restore = () => {
  try {
    fs.linkSync(quarantine, lockPath);
    fs.unlinkSync(quarantine);
  } catch {}
};
let observedInfo, observed;
try {
  observedInfo = fs.statSync(lockPath, { bigint: true });
  observed = fs.readFileSync(lockPath);
  const owner = JSON.parse(observed.toString("utf8"));
  if (owner.token !== token) process.exit(0);
} catch { process.exit(0); }
try { fs.renameSync(lockPath, quarantine); }
catch (error) { if (error.code === "ENOENT") process.exit(0); throw error; }
const quarantinedInfo = fs.statSync(quarantine, { bigint: true });
const quarantined = fs.readFileSync(quarantine);
if (identity(quarantinedInfo) !== identity(observedInfo) || !quarantined.equals(observed)) {
  restore();
  process.exit(0);
}
let owner;
try { owner = JSON.parse(quarantined.toString("utf8")); } catch {}
if (owner?.token === token) fs.unlinkSync(quarantine); else restore();
'@
  try { Invoke-NodeScript -Script $script -Arguments @($Lock.Path, $Lock.Token) | Out-Null }
  catch { Write-Warning "Could not safely release update lock '$($Lock.Path)'." }
}

function Invoke-PluginSmokeImport {
  param([Parameter(Mandatory)][string] $Root)
  $pluginPath = Join-Path $Root 'plugins\twg-agent.ts'
  $pluginUri = ([Uri]$pluginPath).AbsoluteUri
  $script = 'import(process.argv[1]).then(m=>{if(typeof m.default!==process.argv[2])process.exit(1)})'
  Invoke-Checked 'node' @('--experimental-strip-types', '--input-type=module', '-e', $script, '--', $pluginUri, 'function')
}

function Get-ManagedBootstrapRoot {
  if (-not (Test-Path -LiteralPath $BootstrapPath)) { return $null }
  $bootstrapItem = Get-Item -Force -LiteralPath $BootstrapPath
  if ($bootstrapItem.PSIsContainer -or ($bootstrapItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$BootstrapPath is not a regular managed bootstrap file."
  }
  $content = [IO.File]::ReadAllText($BootstrapPath)
  $pattern = '^' + [regex]::Escape($ManagedMarker) + '\r?\nexport \{ default \} from "([^"\r\n]+)"\r?\n?$'
  $match = [regex]::Match($content, $pattern)
  if (-not $match.Success) { throw "$BootstrapPath has invalid managed bootstrap content." }
  $uri = $null
  if (-not [Uri]::TryCreate($match.Groups[1].Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'file') {
    throw "$BootstrapPath does not contain a valid local plugin file URI."
  }
  $pluginPath = [IO.Path]::GetFullPath($uri.LocalPath)
  $lexicalRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $pluginPath) '..'))
  $lexicalPluginsPath = Join-Path $lexicalRoot 'plugins'
  $lexicalExpectedPlugin = [IO.Path]::GetFullPath((Join-Path $lexicalPluginsPath 'twg-agent.ts'))
  if (-not $lexicalExpectedPlugin.Equals($pluginPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Managed bootstrap target is not a bundle plugin path.' }
  foreach ($component in @(
    @{ Path = $lexicalRoot; Container = $true },
    @{ Path = $lexicalPluginsPath; Container = $true },
    @{ Path = $pluginPath; Container = $false }
  )) {
    if (-not (Test-Path -LiteralPath $component.Path)) { continue }
    $item = Get-Item -Force -LiteralPath $component.Path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $component.Container) {
      throw "Managed bootstrap path component '$($component.Path)' is non-regular or a reparse point."
    }
  }
  $root = (Get-CanonicalBundleInfo $lexicalRoot).root
  if (-not (Test-Path -LiteralPath $pluginPath)) {
    Write-Warning "Managed bootstrap target '$pluginPath' is missing; its canonical updater lock will still be held while the installer repairs the bootstrap."
    return $root
  }
  $physicalPlugin = (Get-CanonicalBundleInfo $pluginPath).root
  $expectedPlugin = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'plugins') 'twg-agent.ts'))
  if (-not $expectedPlugin.Equals($physicalPlugin, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Managed bootstrap target is not physically inside its bundle root.'
  }
  return $root
}

function New-InstallerOwnedStage {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Token
  )
  $script = @'
const fs = require("node:fs");
const path = require("node:path");
const stage = process.argv[1];
const token = process.argv[2];
fs.mkdirSync(stage);
const marker = JSON.stringify({ owner: "twg-opencode-agent-installer-stage", token, createdAt: new Date().toISOString() });
fs.writeFileSync(path.join(stage, ".twg-installer-stage.json"), `${marker}\n`, { flag: "wx" });
'@
  Invoke-NodeScript -Script $script -Arguments @($Path, $Token) | Out-Null
}

function Remove-InstallerOwnedStage {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $ExpectedToken
  )
  $fullPath = [IO.Path]::GetFullPath($Path)
  if ([IO.Path]::GetFullPath((Split-Path -Parent $fullPath)) -ne [IO.Path]::GetFullPath($VersionsDir) -or
      -not (Split-Path -Leaf $fullPath).StartsWith('.stage-') -or
      -not (Test-Path -LiteralPath $fullPath -PathType Container) -or
      ((Get-Item -Force -LiteralPath $fullPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  $markerPath = Join-Path $fullPath '.twg-installer-stage.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
      ((Get-Item -Force -LiteralPath $markerPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  try { $marker = [IO.File]::ReadAllText($markerPath) | ConvertFrom-Json }
  catch { return }
  if ($marker.owner -ne 'twg-opencode-agent-installer-stage' -or $marker.token -ne $ExpectedToken) { return }
  Remove-Item -LiteralPath $fullPath -Recurse -Force
}

function Publish-InstallerVersion {
  param(
    [Parameter(Mandatory)][string] $Source,
    [Parameter(Mandatory)][string] $Destination,
    [Parameter(Mandatory)][string] $ExpectedToken
  )
  $script = @'
const fs = require("node:fs");
const path = require("node:path");
const source = process.argv[1];
const destination = process.argv[2];
const token = process.argv[3];
const markerName = ".twg-installer-version.json";
const sourceInfo = fs.lstatSync(source);
if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("staged checkout is not a regular directory");
const markerInfo = fs.lstatSync(path.join(source, markerName));
if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error("staged checkout ownership marker is not a regular file");
const markerContent = fs.readFileSync(path.join(source, markerName));
const marker = JSON.parse(markerContent.toString("utf8"));
if (marker.owner !== "twg-opencode-agent-installer" || marker.token !== token) throw new Error("staged checkout ownership marker does not match");
fs.mkdirSync(destination);
fs.writeFileSync(path.join(destination, markerName), markerContent, { flag: "wx" });
for (const name of fs.readdirSync(source)) {
  if (name === markerName) continue;
  fs.cpSync(path.join(source, name), path.join(destination, name), {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}
'@
  Invoke-NodeScript -Script $script -Arguments @($Source, $Destination, $ExpectedToken) | Out-Null
}

function Remove-InstallerOwnedVersion {
  param(
    [Parameter(Mandatory)][string] $Path,
    [string] $ExpectedToken
  )
  $fullPath = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath((Split-Path -Parent $fullPath))
  if ($parent -ne [IO.Path]::GetFullPath($VersionsDir) -or
      -not (Split-Path -Leaf $fullPath).StartsWith('version-')) { throw "Refusing to remove non-version path '$Path'." }
  $markerPath = Join-Path $fullPath '.twg-installer-version.json'
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container) -or
      ((Get-Item -Force -LiteralPath $fullPath).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
      ((Get-Item -Force -LiteralPath $markerPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  try { $marker = [IO.File]::ReadAllText($markerPath) | ConvertFrom-Json }
  catch { return }
  if ($marker.owner -ne 'twg-opencode-agent-installer' -or ($ExpectedToken -and $marker.token -ne $ExpectedToken)) { return }
  try { $managedRoot = Get-ManagedBootstrapRoot }
  catch {
    Write-Warning "Could not verify the managed bootstrap target; preserving installer-owned version '$fullPath'."
    return
  }
  if ($managedRoot -and
      [IO.Path]::GetFullPath($managedRoot).Equals($fullPath, [StringComparison]::OrdinalIgnoreCase)) { return }
  Remove-Item -LiteralPath $fullPath -Recurse -Force
}

function Remove-OldInstallerVersions {
  param(
    [Parameter(Mandatory)][string] $ActivePath,
    [string] $ProtectedPath
  )
  if (-not (Test-Path -LiteralPath $VersionsDir -PathType Container)) { return }
  $activeFull = [IO.Path]::GetFullPath($ActivePath)
  $protectedFull = if ($ProtectedPath) { [IO.Path]::GetFullPath($ProtectedPath) } else { $null }
  $owned = @(Get-ChildItem -LiteralPath $VersionsDir -Directory | Where-Object {
    if (-not $_.Name.StartsWith('version-')) { return $false }
    $markerPath = Join-Path $_.FullName '.twg-installer-version.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
    try { ([IO.File]::ReadAllText($markerPath) | ConvertFrom-Json).owner -eq 'twg-opencode-agent-installer' }
    catch { $false }
  } | Where-Object {
    $candidate = [IO.Path]::GetFullPath($_.FullName)
    $candidate -ne $activeFull -and $candidate -ne $protectedFull
  } | Sort-Object LastWriteTimeUtc -Descending)
  foreach ($old in @($owned | Select-Object -Skip 2)) { Remove-InstallerOwnedVersion $old.FullName }
}

function Assert-CheckoutTrust {
  param(
    [Parameter(Mandatory)][string] $Checkout,
    [Parameter(Mandatory)][string] $TrustedOrigin,
    [switch] $CheckPin,
    [switch] $RequireClean
  )
  $actualOrigin = Invoke-GitOutput @('-C', $Checkout, 'remote', 'get-url', 'origin')
  Test-RepositoryUrl $actualOrigin
  if ($actualOrigin -ne $TrustedOrigin) {
    throw "Checkout origin '$actualOrigin' does not match trusted origin '$TrustedOrigin'."
  }
  if ($CheckPin) {
    $pinPath = Join-Path $Checkout '.twg-update-origin'
    if (Test-Path -LiteralPath $pinPath -PathType Leaf) {
      $pin = [IO.File]::ReadAllText($pinPath).Trim()
      Test-RepositoryUrl $pin
      if ($pin -ne $actualOrigin) { throw "Installed origin pin '$pin' does not match '$actualOrigin'." }
    }
  }
  $upstream = Invoke-GitOutput @('-C', $Checkout, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  if (-not $upstream.StartsWith('origin/')) { throw "Checkout upstream '$upstream' is not trusted; expected origin/<branch>." }
  if ($RequireClean) {
    $status = Invoke-GitOutput @('-C', $Checkout, 'status', '--porcelain', '--untracked-files=all')
    if ($status) { throw "The installed TWG agent has local changes. The active checkout was not changed:`n$status" }
  }
  return $upstream.Substring('origin/'.Length)
}

function Assert-BootstrapAvailable {
  $pluginsDir = Split-Path -Parent $BootstrapPath
  if (Test-Path -LiteralPath $pluginsDir) {
    $pluginsItem = Get-Item -Force -LiteralPath $pluginsDir
    if (-not $pluginsItem.PSIsContainer -or ($pluginsItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$pluginsDir is not a regular directory; refusing to write the bootstrap."
    }
    if ($pluginsItem.Attributes -band [IO.FileAttributes]::ReadOnly) { throw "$pluginsDir is read-only." }
  }
  if (Test-Path -LiteralPath $BootstrapPath) {
    $item = Get-Item -Force -LiteralPath $BootstrapPath
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$BootstrapPath is not a regular installer-owned file."
    }
    if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) { throw "$BootstrapPath is read-only." }
    $current = [IO.File]::ReadAllText($BootstrapPath)
    if (-not $current.StartsWith("$ManagedMarker`n") -and -not $current.StartsWith("$ManagedMarker`r`n")) {
      throw "$BootstrapPath already exists and is not managed by this installer."
    }
  }
  if (Test-Path -LiteralPath (Join-Path $ConfigDir '.git')) {
    $tracked = Invoke-GitOutput @('-C', $ConfigDir, 'ls-files', '--', $BootstrapRelativePath)
    if ($tracked) { throw "$BootstrapRelativePath is tracked by the existing OpenCode config repository; refusing to overwrite it." }
    $exclude = Invoke-GitOutput @('-C', $ConfigDir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
    if (Test-Path -LiteralPath $exclude) {
      $excludeItem = Get-Item -Force -LiteralPath $exclude
      if ($excludeItem.PSIsContainer -or ($excludeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$exclude is not a regular file; refusing to modify it."
      }
      if ($excludeItem.Attributes -band [IO.FileAttributes]::ReadOnly) { throw "$exclude is read-only." }
    }
  }
}

foreach ($command in @('git', 'node', 'npm')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "$command was not found on PATH. Install Git and Node.js/npm, open a new terminal, and re-run."
  }
}
Invoke-Checked 'node' @('--version')
Invoke-Checked 'npm' @('--version')

$BundleRoot = $null
$SelectedManifest = $null
$ActiveRoot = $null
$StageDir = $null
$StageCheckout = $null
$StageToken = $null
$PendingVersionDir = $null
$PendingVersionToken = $null
$ActivationSucceeded = $false
$HeldLocks = [Collections.Generic.List[object]]::new()

try {
  # Serialize the entire ownership domain, including first installs that have no active bootstrap yet.
  $installationLock = Acquire-UpdateLock $VersionsDir
  $HeldLocks.Add($installationLock)
  $VersionsDir = $installationLock.Root
  if (-not (Test-Path -LiteralPath $VersionsDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $VersionsDir | Out-Null
  }
  $versionsItem = Get-Item -Force -LiteralPath $VersionsDir
  if (-not $versionsItem.PSIsContainer -or ($versionsItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$VersionsDir is not a regular versions directory."
  }
  $VersionsDir = (Get-CanonicalBundleInfo $VersionsDir).root
  $InstallDir = (Get-CanonicalBundleInfo $InstallDir).root

  # Validate the installer source before trusting it to select or replace a runtime bundle.
  $sourceManifest = Read-CompatibilityManifest $PSScriptRoot
  Assert-BootstrapAvailable
  $ActiveRoot = Get-ManagedBootstrapRoot
  if ($ActiveRoot) { $HeldLocks.Add((Acquire-UpdateLock $ActiveRoot)) }

  $twgPath = Get-FirstApplicationPath 'twg'
  $twgBootstrapped = $false
  if (-not $twgPath) {
    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\twg\bin\twg.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { $twgPath = $fallback }
  }
  $opencodePath = Get-FirstApplicationPath 'opencode'
  if (-not $opencodePath) { throw 'OpenCode executable was not found on PATH. Install OpenCode, open a new terminal, and re-run.' }

  $BundleRoot = $PSScriptRoot
  $SelectedManifest = $sourceManifest

  if (-not $Development) {
    $existingRoot = if ($ActiveRoot -and (Test-Path -LiteralPath (Join-Path $ActiveRoot '.git'))) {
      $ActiveRoot
    }
    elseif (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) { $InstallDir }
    else { $null }

    if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
      if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git')) {
        $RepoUrl = Get-OptionalGitConfig -Repository $PSScriptRoot -Key 'remote.origin.url'
      }
      if ([string]::IsNullOrWhiteSpace($RepoUrl) -and $existingRoot) {
        $pinPath = Join-Path $existingRoot '.twg-update-origin'
        if (Test-Path -LiteralPath $pinPath -PathType Leaf) { $RepoUrl = [IO.File]::ReadAllText($pinPath).Trim() }
      }
    }
    if ([string]::IsNullOrWhiteSpace($RepoUrl)) { throw 'No repository URL was found. Use -RepoUrl or -Development.' }
    Test-RepositoryUrl $RepoUrl

    $branch = $null
    if ($existingRoot) {
      $branch = Assert-CheckoutTrust -Checkout $existingRoot -TrustedOrigin $RepoUrl -CheckPin -RequireClean
      Invoke-Git @('check-ref-format', '--branch', $branch)
    }

    $StageToken = [Guid]::NewGuid().ToString('D')
    $StageDir = Join-Path $VersionsDir ('.stage-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
    New-InstallerOwnedStage -Path $StageDir -Token $StageToken
    $StageCheckout = Join-Path $StageDir 'checkout'
    Write-Host "Preparing and validating a staged TWG agent checkout at $StageCheckout ..."
    $cloneArgs = @('clone', '--quiet')
    if ($branch) { $cloneArgs += @('--branch', $branch, '--single-branch') }
    $cloneArgs += @('--', $RepoUrl, $StageCheckout)
    Invoke-Git $cloneArgs
    Assert-CheckoutTrust -Checkout $StageCheckout -TrustedOrigin $RepoUrl | Out-Null
    $SelectedManifest = Read-CompatibilityManifest $StageCheckout
    $BundleRoot = $StageCheckout
  }

  Assert-OpenCodeCompatibility -OpenCodePath $opencodePath -Manifest $SelectedManifest
  if (-not $twgPath) {
    Assert-UnlinkedPathComponents (Join-Path $env:LOCALAPPDATA 'Programs\twg\bin\twg.exe')
    Install-OfficialTwgCli -Version $SelectedManifest.twgCli.installVersion
    $twgBootstrapped = $true
    $twgPath = Join-Path $env:LOCALAPPDATA 'Programs\twg\bin\twg.exe'
    if (-not (Test-Path -LiteralPath $twgPath -PathType Leaf)) {
      throw 'The official TWG installer completed without creating the expected executable.'
    }
  }
  Assert-CliCompatibility -TwgPath $twgPath -Manifest $SelectedManifest
  if ($twgBootstrapped) {
    $installedText = ((@(& $twgPath --version)) -join "`n").Trim()
    $installedMatch = [regex]::Match($installedText, '(?:^|[^0-9A-Za-z.+-])(\d+\.\d+\.\d+)(?:$|[^0-9A-Za-z.+-])')
    if (-not $installedMatch.Success -or $installedMatch.Groups[1].Value -ne $SelectedManifest.twgCli.installVersion) {
      throw "Official installer did not produce pinned TWG CLI $($SelectedManifest.twgCli.installVersion)."
    }
  }
  Assert-SafeSkillDestinations -Skills @($SelectedManifest.requiredSkills)
  if (-not $SkipTwgSkills) {
    Write-Host 'Installing official TWG skills without pruning custom twg-* directories ...'
    Invoke-Checked $twgPath @('skills', 'install', '--yes', '--no-prune')
  }
  else { Write-Host 'Skipping TWG skill installation; verifying existing OpenCode-visible skill files ...' }
  Assert-RequiredSkills -TwgPath $twgPath -Skills @($SelectedManifest.requiredSkills)

  if (-not $SkipDependencies) {
    Push-Location $BundleRoot
    try {
      if ($Development) { Invoke-Checked 'npm' @('install') }
      else { Invoke-Checked 'npm' @('ci', '--omit=dev') }
    }
    finally { Pop-Location }
  }
  Invoke-PluginSmokeImport $BundleRoot

  if (Test-Path -LiteralPath (Join-Path $ConfigDir '.git')) {
    $excludePath = Invoke-GitOutput @('-C', $ConfigDir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
    $existing = if (Test-Path -LiteralPath $excludePath -PathType Leaf) { [IO.File]::ReadAllText($excludePath) } else { '' }
    if (($existing -split "`r?`n") -notcontains $BootstrapRelativePath) {
      $separator = if ($existing -and -not $existing.EndsWith("`n")) { "`n" } else { '' }
      Write-AtomicText -Path $excludePath -Content "$existing$separator$BootstrapRelativePath`n"
    }
  }

  if ($Development) {
    $BundleRoot = (Get-CanonicalBundleInfo $BundleRoot).root
    if (-not $ActiveRoot -or $BundleRoot -ne (Get-CanonicalBundleInfo $ActiveRoot).root) {
      $HeldLocks.Add((Acquire-UpdateLock $BundleRoot))
    }
    $markerPath = Join-Path $BundleRoot '.twg-development'
    $markerItem = Get-Item -Force -LiteralPath $markerPath -ErrorAction SilentlyContinue
    if ($markerItem -and ($markerItem.PSIsContainer -or ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
      throw "$markerPath is not a regular development marker."
    }
    $markerExisted = $null -ne $markerItem
    $markerBefore = if ($markerExisted) { [IO.File]::ReadAllText($markerPath) } else { $null }
    try {
      Write-AtomicText -Path $markerPath -Content "Development checkout: update checks disabled.`n"
      $pluginUri = ([Uri](Join-Path $BundleRoot 'plugins\twg-agent.ts')).AbsoluteUri
      Write-AtomicText -Path $BootstrapPath -Content "$ManagedMarker`nexport { default } from `"$pluginUri`"`n"
      $ActivationSucceeded = $true
    }
    catch {
      if ($markerExisted) { Write-AtomicText -Path $markerPath -Content $markerBefore }
      elseif (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force }
      throw
    }
  }
  else {
    if (Test-Path -LiteralPath (Join-Path $StageCheckout '.twg-development')) {
      throw 'The staged repository unexpectedly contains .twg-development; refusing to activate it.'
    }
    Write-AtomicText -Path (Join-Path $StageCheckout '.twg-update-origin') -Content "$RepoUrl`n"
    $PendingVersionToken = [Guid]::NewGuid().ToString('D')
    $version = [IO.File]::ReadAllText((Join-Path $StageCheckout 'VERSION')).Trim()
    if ($version -notmatch '^\d{4}\.\d+\.\d+$') { throw "Invalid bundle VERSION '$version'." }
    $head = Invoke-GitOutput @('-C', $StageCheckout, 'rev-parse', '--short=12', 'HEAD')
    $finalName = "version-$version-$head-$($PendingVersionToken.Substring(0, 8))"
    $PendingVersionDir = Join-Path $VersionsDir $finalName
    $infoExclude = Invoke-GitOutput @('-C', $StageCheckout, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
    $infoExisting = if (Test-Path -LiteralPath $infoExclude -PathType Leaf) { [IO.File]::ReadAllText($infoExclude) } else { '' }
    if (($infoExisting -split "`r?`n") -notcontains '.twg-installer-version.json') {
      $separator = if ($infoExisting -and -not $infoExisting.EndsWith("`n")) { "`n" } else { '' }
      Write-AtomicText -Path $infoExclude -Content "$infoExisting$separator.twg-installer-version.json`n"
    }
    $versionMarker = @{ owner = 'twg-opencode-agent-installer'; token = $PendingVersionToken; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
    Write-AtomicText -Path (Join-Path $StageCheckout '.twg-installer-version.json') -Content "$versionMarker`n"
    Read-CompatibilityManifest $StageCheckout | Out-Null
    Invoke-PluginSmokeImport $StageCheckout
    $stageStatus = Invoke-GitOutput @('-C', $StageCheckout, 'status', '--porcelain', '--untracked-files=all')
    if ($stageStatus) { throw "The staged checkout became dirty during preparation; the active checkout was not changed:`n$stageStatus" }

    Publish-InstallerVersion -Source $StageCheckout -Destination $PendingVersionDir -ExpectedToken $PendingVersionToken
    Assert-CheckoutTrust -Checkout $PendingVersionDir -TrustedOrigin $RepoUrl | Out-Null
    Read-CompatibilityManifest $PendingVersionDir | Out-Null
    Invoke-PluginSmokeImport $PendingVersionDir
    $publishedStatus = Invoke-GitOutput @('-C', $PendingVersionDir, 'status', '--porcelain', '--untracked-files=all')
    if ($publishedStatus) { throw "The published checkout is not clean; the active checkout was not changed:`n$publishedStatus" }
    $BundleRoot = (Get-CanonicalBundleInfo $PendingVersionDir).root
    $HeldLocks.Add((Acquire-UpdateLock $BundleRoot))
    $pluginUri = ([Uri](Join-Path $BundleRoot 'plugins\twg-agent.ts')).AbsoluteUri
    Write-AtomicText -Path $BootstrapPath -Content "$ManagedMarker`nexport { default } from `"$pluginUri`"`n"
    $ActivationSucceeded = $true
    try { Remove-OldInstallerVersions -ActivePath $BundleRoot -ProtectedPath $ActiveRoot }
    catch { Write-Warning "Installed successfully, but old version cleanup failed: $($_.Exception.Message)" }
  }

  Write-Host ''
  Write-Host "TWG agent installed from $BundleRoot" -ForegroundColor Green
  Write-Host "Bootstrap: $BootstrapPath"
  Write-Host 'Quit and restart OpenCode, then select the twg agent. Run /twg-version to verify it.'
}
finally {
  if ($StageDir -and $StageToken) {
    try { Remove-InstallerOwnedStage -Path $StageDir -ExpectedToken $StageToken }
    catch { Write-Warning "Could not safely clean staged checkout '$StageDir': $($_.Exception.Message)" }
  }
  if (-not $ActivationSucceeded -and $PendingVersionDir) {
    try { Remove-InstallerOwnedVersion -Path $PendingVersionDir -ExpectedToken $PendingVersionToken }
    catch { Write-Warning "Could not safely clean pending version '$PendingVersionDir': $($_.Exception.Message)" }
  }
  for ($index = $HeldLocks.Count - 1; $index -ge 0; $index--) { Release-UpdateLock $HeldLocks[$index] }
}
