#Requires -Version 5.1
<#
.SYNOPSIS
  Remyral worker installer for Windows 10/11 (x64; arm64 via x64 emulation of the wrapper) -
  p2-service-windows.

.DESCRIPTION
  Installs the worker as the Windows service "RemyralWorker", running as the virtual service
  account NT SERVICE\RemyralWorker, wrapped by shawl (pinned v1.9.0, SHA-256 verified), with
  restart-on-failure, SCM recovery actions, file logging and an ACL'd data root under
  %ProgramData%\RemyralWorker (SYSTEM, Administrators and the service account only).

  The script first builds a PLAN (a list of actions) from read-only probes, then executes it.
  -DryRun prints the plan and changes nothing. Running it again only re-applies idempotent
  steps (ACLs, recovery settings) and changes what differs.

    .\install.ps1 -DryRun -Bundle .\remyral-worker.mjs -MasterUrl wss://master.example.com/v1/worker
    .\install.ps1 -Bundle .\remyral-worker.mjs -BundleSha256 <hex> -MasterUrl wss://master.example.com/v1/worker
    .\install.ps1 -Bundle .\remyral-worker.mjs -Manifest .\manifest.json -Signature .\manifest.sig.json -MasterUrl ...

  Signed releases (p2-signed-updates): with -Manifest/-Signature the bundle is verified against the
  release key by remyral-worker-updater.mjs and installed through it (versions\ layout, downgrade
  refused); the updater is registered as the scheduled task "RemyralWorkerUpdater" (SYSTEM).

  Installer kit (Fleet > Add machine, p5-worker-onboarding): everything sits next to this script, so
    .\install.ps1 -MasterUrl wss://master.example.com/v1/worker
  is enough. SHA256SUMS of the kit is checked first, the signed release is picked up automatically, and
  without a usable Node 24 the pinned one (node\pin.env) is downloaded from nodejs.org, checked against
  the pinned SHA-256 of SHASUMS256.txt and of the zip, and unpacked privately under
  %ProgramFiles%\RemyralWorker\node (the system Node and PATH are never touched).

  Design: docs/design/p2-service-install.md, docs/design/p5-worker-onboarding.md
  Owner guide: docs/ops/worker-install.md
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Bundle,
  [string]$BundleSha256,
  [string]$Node,
  # p5-worker-onboarding: always use the pinned private Node; mirror of https://nodejs.org/dist.
  [switch]$PrivateNode,
  [string]$NodeDistUrl,
  [string]$MasterUrl,
  [string]$WorkspaceRoot,
  # Optional local hard ceiling written to a NEW config (localCeiling, ADR-0015); normally set from the dashboard.
  [ValidateRange(1, 64)][int]$MaxParallelJobs,
  # Local ceiling of AI machine administration (localCeiling.allowMachineAdmin): -AllowMachineAdmin = explicit opt-in
  # (true), -NoMachineAdmin = local veto (false; refused whatever the dashboard says). Without either the key is not
  # written (the dashboard decides). Both also change an existing config (only that key). docs/ops/machine-admin.md
  [switch]$AllowMachineAdmin,
  [switch]$NoMachineAdmin,
  # Offline install: a local copy of the pinned shawl release zip (otherwise downloaded).
  [string]$ShawlZip,
  # p2-signed-updates: signed release manifest + signature, the privileged updater, release keys.
  [string]$Manifest,
  [string]$Signature,
  [string]$Updater,
  [string]$ReleasePublicKey,
  [switch]$ReplaceConfig,
  [switch]$NoStart,
  [switch]$AllowUnsafeNode,
  [switch]$DryRun
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# --- Constants (kept in sync with apps/worker/src/service/definitions.ts by tests) -----------
$ServiceName = 'RemyralWorker'
$ServiceAccount = 'NT SERVICE\RemyralWorker'
$DisplayName = 'Remyral Worker'
$NodeMajor = 24
$StopTimeoutMs = 60000
$RestartDelayMs = 10000
$NoRestartExitCodes = '0,78'
# p2-signed-updates: the privileged updater runs as SYSTEM from a scheduled task (Windows has no
# path-triggered service start); it polls the worker's activation request once a minute.
$UpdaterTaskName = 'RemyralWorkerUpdater'
# p5-machine-admin (ADR-0021): the elevated broker of AI machine administration, started by the same updater
# bundle as SYSTEM for a master-signed session request of a running machine-admin job; idle runs exit at once.
$AdminTaskName = 'RemyralWorkerAdmin'
$AdminTaskLimitMinutes = 780

$ShawlVersion = '1.9.0'
$ShawlZipUrl = 'https://github.com/mtkennerly/shawl/releases/download/v1.9.0/shawl-v1.9.0-win64.zip'
$ShawlZipSha256 = 'f883c5d09c9beae2efaeabd8513e7d3f57cd1d0864cec3df4f4a7b6ee904351c'
$ShawlExeSha256 = '0985555b71e7f943b8f3fc639952a9890aa62e66617942a2d0996985fe8e7c6d'

# Well-known SIDs (names are localized, SIDs are not).
$SidSystem = 'S-1-5-18'
$SidAdministrators = 'S-1-5-32-544'
# Principals that must never be able to modify node.exe / its directory.
$SidsUntrusted = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4')  # Everyone, Authenticated Users, Users, INTERACTIVE

function Get-RemyralServiceSid {
  <# Service SID (S-1-5-80-...): SHA-1 of the upper-cased service name in UTF-16LE, as five
     little-endian UInt32 - the same value `sc.exe showsid` prints. Usable before the service exists. #>
  param([Parameter(Mandatory)][string]$Name)
  $sha = [Security.Cryptography.SHA1]::Create()
  try { $hash = $sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant())) } finally { $sha.Dispose() }
  $parts = for ($i = 0; $i -lt 20; $i += 4) { [BitConverter]::ToUInt32($hash, $i) }
  'S-1-5-80-' + ($parts -join '-')
}

function Join-RemyralPath {
  <# Windows path join that behaves the same under pwsh on Linux (tests) and on Windows. #>
  param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Child)
  $Parent.TrimEnd([char]0x5C) + [char]0x5C + $Child
}

function Get-RemyralLayout {
  param([Parameter(Mandatory)][string]$ProgramFiles, [Parameter(Mandatory)][string]$ProgramData, [string]$WorkspaceRoot)
  $pf = Join-RemyralPath $ProgramFiles 'RemyralWorker'
  $pd = Join-RemyralPath $ProgramData 'RemyralWorker'
  $ws = if ($WorkspaceRoot) { $WorkspaceRoot } else { Join-RemyralPath $pd 'workspaces' }
  [pscustomobject]@{
    ProgramDir = $pf
    BundlePath = Join-RemyralPath $pf 'remyral-worker.mjs'
    ShawlPath  = Join-RemyralPath $pf 'shawl.exe'
    CliPath    = Join-RemyralPath $pf 'remyral-worker.cmd'
    UpdaterPath = Join-RemyralPath $pf 'remyral-worker-updater.mjs'
    JobRunnerPath = Join-RemyralPath $pf 'remyral-jobrun.ps1'
    VersionsDir = Join-RemyralPath $pf 'versions'
    StateDir   = Join-RemyralPath $pf 'state'
    DataRoot   = $pd
    ConfigPath = Join-RemyralPath $pd 'config.json'
    DataDir    = Join-RemyralPath $pd 'data'
    Workspaces = $ws
    LogDir     = Join-RemyralPath $pd 'logs'
  }
}

function ConvertTo-RemyralCommandLine {
  <# Windows command-line quoting (CommandLineToArgvW rules) for the service ImagePath. #>
  param([string[]]$Arguments)
  $quoted = foreach ($a in $Arguments) {
    if ($a -ne '' -and $a -cnotmatch '[\s"]') { $a; continue }
    $s = '"'
    $backslashes = 0
    foreach ($ch in $a.ToCharArray()) {
      if ($ch -eq '\') { $backslashes++; continue }
      if ($ch -eq '"') { $s += ('\' * ($backslashes * 2 + 1)) + '"'; $backslashes = 0; continue }
      $s += ('\' * $backslashes) + $ch
      $backslashes = 0
    }
    $s + ('\' * ($backslashes * 2)) + '"'
  }
  $quoted -join ' '
}

function Get-RemyralServiceCommandLine {
  param([Parameter(Mandatory)]$Layout, [Parameter(Mandatory)][string]$NodePath)
  $argv = @(
    $Layout.ShawlPath, 'run', '--name', $ServiceName,
    '--cwd', $Layout.DataDir,
    # Ctrl-C (Node: SIGINT) -> the daemon cancels jobs and exits 0; killed after the timeout.
    '--stop-timeout', "$StopTimeoutMs",
    # Restart on crashes; not after a clean stop (0) or a configuration error (78).
    '--restart-if-not', $NoRestartExitCodes,
    '--restart-delay', "$RestartDelayMs",
    '--kill-process-tree',
    '--log-dir', $Layout.LogDir, '--log-as', 'shawl', '--log-cmd-as', 'remyral-worker',
    '--log-rotate', 'bytes=10485760', '--log-retain', '5',
    '--env', 'NODE_ENV=production',
    '--',
    $NodePath, $Layout.BundlePath, 'run', '--config', $Layout.ConfigPath
  )
  ConvertTo-RemyralCommandLine $argv
}

function ConvertFrom-RemyralPin {
  <# Parses node\pin.env (KEY=value lines; comments and blanks ignored) into a hashtable. The file is
     data, never executed. #>
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $pin = @{}
  foreach ($line in ($Text -csplit "`r?`n")) {
    if ($line -cmatch '^([A-Za-z0-9_]+)=([A-Za-z0-9._:/-]+)$') { $pin[$Matches[1]] = $Matches[2] }
  }
  foreach ($k in @('NODE_VERSION', 'NODE_DIST_URL', 'NODE_SHASUMS256_SHA256', 'NODE_SHA256_win_x64')) {
    if (-not $pin.ContainsKey($k)) { throw "node\pin.env has no valid $k" }
  }
  if ($pin.NODE_VERSION -cnotmatch "^$NodeMajor\.\d+\.\d+$") { throw "node\pin.env pins Node $($pin.NODE_VERSION); the worker needs Node $NodeMajor" }
  $pin
}

function Test-RemyralKitChecksums {
  <# Installer kit: every file listed in SHA256SUMS ("<hex>  <relative/path>") must match. Returns the
     list of problems (empty = ok). #>
  param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][scriptblock]$Hash)
  $problems = New-Object System.Collections.Generic.List[string]
  $sums = Join-Path $Dir 'SHA256SUMS'
  foreach ($line in [IO.File]::ReadAllLines($sums)) {
    if ($line -eq '') { continue }
    if ($line -cnotmatch '^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$' -or $Matches[2] -cmatch '(^|/)\.\.(/|$)') { $problems.Add("malformed line: $line"); continue }
    $expected = $Matches[1]
    $file = Join-Path $Dir ($Matches[2] -creplace '/', [IO.Path]::DirectorySeparatorChar)
    $actual = & $Hash $file
    if ($actual -ne $expected) { $problems.Add("$($Matches[2]): expected $expected, got $actual") }
  }
  $problems.ToArray()
}

function Set-RemyralServiceAccount {
  <# Runs the service as its virtual account. sc.exe accepts NT SERVICE\<name> for an existing service
     without a password (Win32_Service.Create/Change do not). #>
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Account)
  $out = & sc.exe config $Name obj= $Account 2>&1
  if ($LASTEXITCODE -ne 0) { throw "sc.exe config $Name obj= $Account failed with exit code ${LASTEXITCODE}: $out" }
}

function New-RemyralAction {
  param([Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][string]$Text, [hashtable]$Data = @{})
  [pscustomobject]@{ Kind = $Kind; Text = $Text; Data = $Data }
}

function Get-RemyralInstallPlan {
  <#
    Pure planning: every input comes from $Settings and the $Probe scriptblocks, so the plan
    is unit-tested with fakes (infra/worker/windows/test/Install.Tests.ps1). Throws on
    validation errors; returns the ordered action list.
  #>
  param([Parameter(Mandatory)][hashtable]$Settings, [Parameter(Mandatory)][hashtable]$Probe)
  $actions = New-Object System.Collections.Generic.List[object]
  $warnings = New-Object System.Collections.Generic.List[string]
  # Every setting present (StrictMode treats a missing hashtable key as an error).
  $s = @{
    Bundle = $null; BundleSha256 = $null; Node = $null; MasterUrl = $null; WorkspaceRoot = $null
    MaxParallelJobs = 0; ShawlZip = $null; ReplaceConfig = $false; NoStart = $false
    PrivateNode = $false; NodeDistUrl = $null; NodePin = $null
    AllowUnsafeNode = $false; DryRun = $false
    Manifest = $null; Signature = $null; Updater = $null; ReleasePublicKey = $null
    JobRunner = $null; MachineAdmin = $null
  }
  foreach ($k in $Settings.Keys) {
    if (-not $s.ContainsKey($k)) { throw "unknown setting $k" }
    $s[$k] = $Settings[$k]
  }

  if (-not $s.DryRun -and -not (& $Probe.IsAdmin)) { throw 'run from an elevated PowerShell (Run as administrator), or use -DryRun' }
  if ($s.MasterUrl) {
    if ($s.MasterUrl -cmatch '^ws://(127\.0\.0\.1|localhost|\[::1\])([:/]|$)') { $warnings.Add('plain ws:// is for local development only') }
    elseif ($s.MasterUrl -cnotmatch '^wss://') { throw "-MasterUrl must start with wss:// (got: $($s.MasterUrl))" }
  }
  if ($s.Node -and $s.PrivateNode) { throw '-Node and -PrivateNode exclude each other' }
  if ($s.MachineAdmin -and $s.MachineAdmin -cnotin @('allow', 'forbid')) { throw "MachineAdmin must be allow or forbid (got: $($s.MachineAdmin))" }
  if ($s.NodeDistUrl -and $s.NodeDistUrl -cnotmatch '^(https://|http://(127\.0\.0\.1|localhost)([:/]|$))') { throw '-NodeDistUrl must be https:// (plain http only for a local mirror)' }
  if ($s.WorkspaceRoot) {
    if ($s.WorkspaceRoot -cnotmatch '^[A-Za-z]:\\') { throw '-WorkspaceRoot must be an absolute path like D:\RemyralWork' }
    if ($s.WorkspaceRoot -cmatch '^[A-Za-z]:\\[Uu][Ss][Ee][Rr][Ss]\\') { throw "-WorkspaceRoot may not be inside a user's profile (ADR-0007: worker-owned root)" }
  }

  # Bundle
  if (-not $s.Bundle -or -not (& $Probe.FileExists $s.Bundle)) { throw 'worker bundle not found; pass -Bundle (build it with: pnpm --filter @remyral/worker bundle)' }
  $bundleHash = & $Probe.FileHash $s.Bundle
  if ($s.BundleSha256) {
    if ($bundleHash -ne $s.BundleSha256.ToLowerInvariant()) { throw "bundle SHA-256 mismatch: expected $($s.BundleSha256), got $bundleHash" }
  } elseif (-not $s.Manifest) {
    $warnings.Add('neither -Manifest/-Signature nor -BundleSha256 given: bundle integrity not verified')
  }
  if ($s.Manifest -or $s.Signature) {
    if (-not ($s.Manifest -and $s.Signature -and (& $Probe.FileExists $s.Manifest) -and (& $Probe.FileExists $s.Signature))) {
      throw '-Manifest and -Signature must both name existing files'
    }
    if (-not $s.Updater) { throw 'a signed install needs remyral-worker-updater.mjs (pass -Updater)' }
  }
  if ($s.Updater -and -not (& $Probe.FileExists $s.Updater)) { throw "updater not found: $($s.Updater)" }
  if ($s.ReleasePublicKey -and $s.ReleasePublicKey -cnotmatch '^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})?$') {
    throw '-ReleasePublicKey must be one or two base64url Ed25519 public keys, comma-separated'
  }
  if (-not $s.Updater) { $warnings.Add('remyral-worker-updater.mjs not given: automatic updates will not be possible on this machine') }

  $layout = Get-RemyralLayout -ProgramFiles (& $Probe.ProgramFiles) -ProgramData (& $Probe.ProgramData) -WorkspaceRoot $s.WorkspaceRoot

  # Node 24, installed for all users and not modifiable by non-admins (T-SUP-2). Order: -Node; the
  # private pinned Node if this installer manages one (kept at the pin = upgrade/repair); a usable Node
  # 24 on PATH; otherwise the pinned Node (node\pin.env) under %ProgramFiles%\RemyralWorker\node.
  $nodeProblemOf = {
    param([string]$path)
    $v = & $Probe.NodeVersion $path
    if ($v -cnotmatch "^v$NodeMajor\.") { return "Node.js $NodeMajor is required (found '$v' at $path)" }
    if ($path -cmatch '^[A-Za-z]:\\[Uu][Ss][Ee][Rr][Ss]\\') { return "$path is inside a user profile (per-user install, nvm-windows?)" }
    $w = & $Probe.NodeWritableBy $path $SidsUntrusted
    if ($w) { return "unsafe Node location: $w" }
    $null
  }
  $nodePath = $s.Node
  $privateRoot = Join-RemyralPath $layout.ProgramDir 'node'
  $installNode = $null
  $usingPrivateNode = $false
  $privateDirs = @()
  if ($nodePath) {
    $nodeProblem = & $nodeProblemOf $nodePath
    if ($nodeProblem -clike 'Node.js*') { throw $nodeProblem }
    if ($nodeProblem) {
      if ($s.AllowUnsafeNode) { $warnings.Add("unsafe Node location accepted: $nodeProblem") }
      elseif ($s.DryRun) { $warnings.Add("$nodeProblem - a real install would STOP here") }
      else { throw "$nodeProblem (install Node for all users under Program Files, drop -Node for the pinned private Node, or pass -AllowUnsafeNode)" }
    }
  } else {
    $privateDirs = @(& $Probe.PrivateNodeDirs $privateRoot)
    $usingPrivateNode = $s.PrivateNode -or ($privateDirs.Count -gt 0)
    if (-not $usingPrivateNode) {
      $found = & $Probe.FindNode
      $why = if ($found) { & $nodeProblemOf $found } else { "no Node.js $NodeMajor on PATH" }
      if ($why) {
        $warnings.Add("${why}: using the pinned private Node (the system Node is left alone)")
        $usingPrivateNode = $true
      } else { $nodePath = $found }
    }
    if ($usingPrivateNode) {
      if (-not $s.NodePin) { throw "Node.js $NodeMajor is needed but node\pin.env is missing (use the installer kit from the dashboard, or pass -Node)" }
      $pin = $s.NodePin
      $name = "node-v$($pin.NODE_VERSION)-win-x64"
      $dir = Join-RemyralPath $privateRoot $name
      $nodePath = Join-RemyralPath $dir 'node.exe'
      $expected = $pin.NODE_SHA256_win_x64
      $marker = & $Probe.ReadText (Join-RemyralPath $dir '.remyral-sha256')
      if (-not ((& $Probe.FileExists $nodePath) -and $marker -and $marker.Trim() -eq $expected)) {
        $dist = if ($s.NodeDistUrl) { $s.NodeDistUrl } else { $pin.NODE_DIST_URL }
        $dist = $dist.TrimEnd('/')
        if ($dist -cnotmatch '^https://') { $warnings.Add("Node mirror $dist is not https; integrity is still enforced by the pinned hashes") }
        $installNode = New-RemyralAction InstallNode "download $dist/v$($pin.NODE_VERSION)/{SHASUMS256.txt,$name.zip}; verify SHASUMS256.txt (pinned sha256 $($pin.NODE_SHASUMS256_SHA256)) and $name.zip (sha256 $expected); extract -> $dir" @{
          Base = "$dist/v$($pin.NODE_VERSION)"; Name = $name; Root = $privateRoot; Dest = $dir
          ShasumsSha256 = $pin.NODE_SHASUMS256_SHA256; Sha256 = $expected; Version = $pin.NODE_VERSION; TempDir = (& $Probe.TempDir)
        }
      }
    }
  }

  $serviceSid = Get-RemyralServiceSid $ServiceName
  $changedCode = $false

  # Program files (inherited ACL: Administrators/SYSTEM full, Users read & execute).
  if (-not (& $Probe.DirExists $layout.ProgramDir)) { $actions.Add((New-RemyralAction Mkdir "mkdir $($layout.ProgramDir)" @{ Path = $layout.ProgramDir })) }
  if ($installNode) {
    $actions.Add($installNode)
    $changedCode = $true
  }
  if ($s.Updater) {
    foreach ($dir in @($layout.VersionsDir, $layout.StateDir)) {
      if (-not (& $Probe.DirExists $dir)) { $actions.Add((New-RemyralAction Mkdir "mkdir $dir" @{ Path = $dir })) }
    }
    if ((& $Probe.FileHash $layout.UpdaterPath) -ne (& $Probe.FileHash $s.Updater)) {
      $actions.Add((New-RemyralAction Copy "copy $($s.Updater) -> $($layout.UpdaterPath)" @{ From = $s.Updater; To = $layout.UpdaterPath }))
      $changedCode = $true
    }
  }
  # p5-sandbox-ops: the Windows job runner (Job Object via Add-Type C#) next to the worker, admin-owned. The worker
  # also carries it embedded and verifies this copy against it before use.
  if ($s.JobRunner) {
    if (-not (& $Probe.FileExists $s.JobRunner)) { throw "job runner not found: $($s.JobRunner)" }
    if ((& $Probe.FileHash $layout.JobRunnerPath) -ne (& $Probe.FileHash $s.JobRunner)) {
      $actions.Add((New-RemyralAction Copy "copy $($s.JobRunner) -> $($layout.JobRunnerPath)" @{ From = $s.JobRunner; To = $layout.JobRunnerPath }))
    }
  } else {
    $warnings.Add('remyral-jobrun.ps1 not given: the worker writes its embedded job runner into its data dir instead')
  }
  if ((& $Probe.FileHash $layout.BundlePath) -ne $bundleHash) {
    if ($s.Manifest) {
      # Verified by the updater (pinned/configured release keys), previous version kept, atomic switch.
      $argv = @($layout.UpdaterPath, 'adopt', '--install-dir', $layout.ProgramDir, '--bundle', $s.Bundle, '--manifest', $s.Manifest, '--signature', $s.Signature)
      if (& $Probe.FileExists $layout.ConfigPath) { $argv += @('--config', $layout.ConfigPath) }
      $actions.Add((New-RemyralAction Exec ("node " + (ConvertTo-RemyralCommandLine $argv)) @{ File = $nodePath; Args = $argv }))
    } else {
      $actions.Add((New-RemyralAction Copy "copy $($s.Bundle) -> $($layout.BundlePath)" @{ From = $s.Bundle; To = $layout.BundlePath }))
    }
    $changedCode = $true
  }
  if ((& $Probe.FileHash $layout.ShawlPath) -ne $ShawlExeSha256) {
    $zip = $s.ShawlZip
    if (-not $zip) {
      $zip = Join-RemyralPath (& $Probe.TempDir) "shawl-v$ShawlVersion-win64.zip"
      $actions.Add((New-RemyralAction Download "download $ShawlZipUrl -> $zip" @{ Url = $ShawlZipUrl; To = $zip }))
    }
    $actions.Add((New-RemyralAction InstallShawl "verify $zip (sha256 $ShawlZipSha256), extract shawl.exe (sha256 $ShawlExeSha256) -> $($layout.ShawlPath)" @{ Zip = $zip; To = $layout.ShawlPath; ZipSha256 = $ShawlZipSha256; ExeSha256 = $ShawlExeSha256 }))
    $changedCode = $true
  }
  $cli = "@echo off`r`nrem remyral-worker CLI wrapper (installed by infra/worker/windows/install.ps1)`r`n`"$nodePath`" `"$($layout.BundlePath)`" %*`r`n"
  if ((& $Probe.ReadText $layout.CliPath) -ne $cli) {
    $actions.Add((New-RemyralAction WriteFile "write $($layout.CliPath)" @{ Path = $layout.CliPath; Content = $cli }))
  }

  # Data root, ACL'd: SYSTEM + Administrators full; the service SID only what it needs.
  foreach ($dir in @($layout.DataRoot, $layout.DataDir, $layout.Workspaces, $layout.LogDir)) {
    if (-not (& $Probe.DirExists $dir)) { $actions.Add((New-RemyralAction Mkdir "mkdir $dir" @{ Path = $dir })) }
  }

  # Config (never overwritten without -ReplaceConfig).
  $haveConfig = & $Probe.FileExists $layout.ConfigPath
  if ($haveConfig -and -not $s.ReplaceConfig) {
    if ($s.MasterUrl) { $warnings.Add('config exists and was NOT changed (edit it, or pass -ReplaceConfig)') }
    # -AllowMachineAdmin / -NoMachineAdmin also apply to an existing config: only that key changes (validated by the
    # updater before it writes, in place so the file keeps its ACL); the service is restarted to read it.
    if ($s.MachineAdmin) {
      if (-not ($s.Updater -or (& $Probe.FileExists $layout.UpdaterPath))) {
        throw "-AllowMachineAdmin / -NoMachineAdmin on an existing config need remyral-worker-updater.mjs (or set localCeiling.allowMachineAdmin in $($layout.ConfigPath) by hand)"
      }
      $ceilArgs = @($layout.UpdaterPath, 'machine-admin-ceiling', $s.MachineAdmin, '--config', $layout.ConfigPath)
      $actions.Add((New-RemyralAction Exec ("node " + (ConvertTo-RemyralCommandLine $ceilArgs)) @{ File = $nodePath; Args = $ceilArgs }))
      $changedCode = $true
    }
  } elseif ($s.MasterUrl) {
    # Minimal local config (p5-worker-onboarding): master + paths; the rest is a worker default or
    # comes from the dashboard.
    $config = [ordered]@{
      masterUrl     = $s.MasterUrl
      workspaceRoot = $layout.Workspaces
      # p5-sandbox-ops: the dedicated account this installer runs the service as (a machine fact).
      sandbox       = [ordered]@{ workerUser = $ServiceAccount }
    }
    # dataDir is not written: the worker's default for %ProgramData%\RemyralWorker\config.json is DataDir.
    # Optional local hard ceiling (ADR-0015): the panel can lower parallelism, never raise it above this.
    $ceiling = [ordered]@{}
    if ([int]$s.MaxParallelJobs -gt 0) { $ceiling.maxParallelJobs = [int]$s.MaxParallelJobs }
    if ($s.MachineAdmin) { $ceiling.allowMachineAdmin = ($s.MachineAdmin -ceq 'allow') }
    if ($ceiling.Count -gt 0) { $config.localCeiling = $ceiling }
    if ($s.ReleasePublicKey) { $config.updates = [ordered]@{ releaseKeys = @($s.ReleasePublicKey -csplit ',') } }
    $json = ($config | ConvertTo-Json -Depth 3) -creplace "`r`n", "`n"
    $actions.Add((New-RemyralAction WriteFile "write $($layout.ConfigPath)`n$json" @{ Path = $layout.ConfigPath; Content = "$json`n" }))
    $haveConfig = $true
    $changedCode = $true
  } else {
    $warnings.Add("no config yet: pass -MasterUrl, or create $($layout.ConfigPath) and re-run")
  }

  # Service
  $commandLine = Get-RemyralServiceCommandLine -Layout $layout -NodePath $nodePath
  $svc = & $Probe.GetService $ServiceName
  $changedService = $false
  if ($null -eq $svc) {
    $actions.Add((New-RemyralAction CimCreate "Win32_Service.Create(Name=$ServiceName, StartName=$ServiceAccount, PathName=$commandLine)" @{
          Name = $ServiceName; DisplayName = $DisplayName; PathName = $commandLine; StartName = $ServiceAccount }))
    $changedService = $true
  } elseif ($svc.PathName -ne $commandLine -or $svc.StartName -ne $ServiceAccount) {
    $actions.Add((New-RemyralAction CimChange "Win32_Service.Change(Name=$ServiceName, StartName=$ServiceAccount, PathName=$commandLine)" @{
          Name = $ServiceName; PathName = $commandLine; StartName = $ServiceAccount }))
    $changedService = $true
  }
  $sc = {
    param([string[]]$argv)
    New-RemyralAction Exec ("sc.exe " + ($argv -join ' ')) @{ File = 'sc.exe'; Args = $argv }
  }
  $actions.Add((& $sc @('description', $ServiceName, 'Remyral worker (docs/ops/worker-install.md)')))
  $actions.Add((& $sc @('config', $ServiceName, 'start=', 'delayed-auto')))
  $actions.Add((& $sc @('sidtype', $ServiceName, 'unrestricted')))
  # The SCM restarts shawl itself if it dies; shawl restarts node. failureflag 0: a stop with a
  # service-specific error (exit 78 reported by shawl) is NOT treated as a failure to recover from.
  $actions.Add((& $sc @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000')))
  $actions.Add((& $sc @('failureflag', $ServiceName, '0')))

  # ACLs (idempotent; applied on every run). Names are given as SIDs (localization-proof). They come
  # after the service exists: icacls cannot map the NT SERVICE\<name> SID before the SCM knows the
  # service ("No mapping between account names and security IDs was done").
  $acl = {
    param($path, [string[]]$grants, [switch]$protect)
    $argv = @($path)
    if ($protect) { $argv += '/inheritance:r' }
    $argv += '/grant:r'
    $argv += $grants
    New-RemyralAction Exec ("icacls " + (ConvertTo-RemyralCommandLine $argv)) @{ File = 'icacls.exe'; Args = $argv }
  }
  $actions.Add((& $acl $layout.DataRoot @("*$($SidSystem):(OI)(CI)F", "*$($SidAdministrators):(OI)(CI)F", "*$($serviceSid):(RX)") -protect))
  if ($haveConfig) { $actions.Add((& $acl $layout.ConfigPath @("*$($serviceSid):(R)"))) }
  foreach ($dir in @($layout.DataDir, $layout.LogDir)) {
    $actions.Add((& $acl $dir @("*$($serviceSid):(OI)(CI)M")))
  }
  if ($layout.Workspaces.StartsWith($layout.DataRoot + '\')) {
    $actions.Add((& $acl $layout.Workspaces @("*$($serviceSid):(OI)(CI)M")))
  } else {
    $actions.Add((& $acl $layout.Workspaces @("*$($SidSystem):(OI)(CI)F", "*$($SidAdministrators):(OI)(CI)F", "*$($serviceSid):(OI)(CI)M") -protect))
  }
  # p22-harness-gaps: the service owns its data and workspace trees. Folders a pre-rename service (RemanaWorker) made
  # kept that account as owner; the worker then could not change their ACLs (lending a subscription account folder to
  # a per-job account failed "icacls ... Access is denied", DESKTOP 2026-11-02). /C: keep going past a locked file.
  foreach ($dir in @($layout.DataDir, $layout.Workspaces)) {
    $own = @($dir, '/setowner', "*$serviceSid", '/T', '/C', '/Q')
    $actions.Add((New-RemyralAction Exec ("icacls " + (ConvertTo-RemyralCommandLine $own)) @{ File = 'icacls.exe'; Args = $own }))
  }

  # p2-signed-updates: the updater as a SYSTEM scheduled task (re-created idempotently with /F).
  if ($s.Updater -and $haveConfig) {
    # Register-ScheduledTask, not schtasks.exe: Windows PowerShell 5.1 mangles the embedded quotes of a
    # /TR value when it passes arguments to a native command.
    $taskArgs = ConvertTo-RemyralCommandLine @($layout.UpdaterPath, 'apply', '--config', $layout.ConfigPath)
    $actions.Add((New-RemyralAction Task "Register-ScheduledTask $UpdaterTaskName (SYSTEM, every minute): $nodePath $taskArgs" @{
          Name = $UpdaterTaskName; Execute = $nodePath; Argument = $taskArgs }))
    # p5-machine-admin: one admin session at a time (IgnoreNew), each at most 13 h (the session grant is <= 12 h).
    $adminArgs = ConvertTo-RemyralCommandLine @($layout.UpdaterPath, 'admin-session', '--config', $layout.ConfigPath)
    $actions.Add((New-RemyralAction Task "Register-ScheduledTask $AdminTaskName (SYSTEM, every minute, machine-admin sessions): $nodePath $adminArgs" @{
          Name = $AdminTaskName; Execute = $nodePath; Argument = $adminArgs; LimitMinutes = $AdminTaskLimitMinutes }))
  }

  # The service now points at the active Node; older private Node versions can go.
  if ($usingPrivateNode) {
    $keep = $nodePath.Substring(0, $nodePath.LastIndexOf([char]0x5C))
    $keep = $keep.Substring($keep.LastIndexOf([char]0x5C) + 1)
    if (@($privateDirs | Where-Object { $_ -ne $keep }).Count -gt 0) {
      $actions.Add((New-RemyralAction PruneNode "remove Node versions under $privateRoot other than $keep" @{ Root = $privateRoot; Keep = $keep }))
    }
  }

  # Start / restart
  if (-not $haveConfig) {
    $warnings.Add('not starting: no config')
  } elseif ($s.NoStart) {
    $warnings.Add('-NoStart: not starting')
  } elseif ($null -ne $svc -and $svc.State -eq 'Running') {
    if ($changedCode -or $changedService) { $actions.Add((New-RemyralAction Service "Restart-Service $ServiceName" @{ Op = 'Restart' })) }
  } else {
    $actions.Add((New-RemyralAction Service "Start-Service $ServiceName" @{ Op = 'Start' }))
  }

  # Security fix (helper binding): the SYSTEM helper serves exactly one worker id, recorded admin-owned in
  # state\admin-binding.json. An enrolled worker (a re-run on an existing install) is bound here, once; a new machine is
  # bound after its approval (see the Done text). Never changes an existing binding; a failure is only a warning.
  if ($s.Updater -and $haveConfig) {
    $bindArgs = @($layout.UpdaterPath, 'admin-bind', '--if-unbound', '--config', $layout.ConfigPath)
    $actions.Add((New-RemyralAction Bind ("node " + (ConvertTo-RemyralCommandLine $bindArgs)) @{ File = $nodePath; Args = $bindArgs }))
  }

  [pscustomobject]@{ Actions = $actions.ToArray(); Warnings = $warnings.ToArray(); Layout = $layout; NodePath = $nodePath; ServiceSid = $serviceSid }
}

# --- Real probes (read-only) -------------------------------------------------------------
function Get-RemyralSystemProbe {
  @{
    IsAdmin        = { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    FileExists     = { param($p) Test-Path -LiteralPath $p -PathType Leaf }
    DirExists      = { param($p) Test-Path -LiteralPath $p -PathType Container }
    FileHash       = { param($p) if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null } }
    ReadText       = { param($p) if (Test-Path -LiteralPath $p -PathType Leaf) { [IO.File]::ReadAllText($p) } else { $null } }
    FindNode       = { $c = Get-Command node.exe -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { $null } }
    PrivateNodeDirs = { param($r) if (Test-Path -LiteralPath $r -PathType Container) { @(Get-ChildItem -LiteralPath $r -Directory -Force | Where-Object { $_.Name -clike 'node-v*' } | ForEach-Object { $_.Name }) } else { @() } }
    NodeVersion    = { param($p) try { (& $p --version) 2>$null } catch { $null } }
    NodeWritableBy = {
      param($p, [string[]]$sids)
      $writeMask = [int]([Security.AccessControl.FileSystemRights]'Write, Delete, ChangePermissions, TakeOwnership')
      foreach ($target in @($p, (Split-Path -Parent $p))) {
        foreach ($rule in (Get-Acl -LiteralPath $target).Access) {
          if ($rule.AccessControlType -ne 'Allow') { continue }
          try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
          if ($sids -contains $sid -and (([int]$rule.FileSystemRights) -band $writeMask)) {
            return "$target is writable by $($rule.IdentityReference) ($($rule.FileSystemRights))"
          }
        }
      }
      $null
    }
    ProgramFiles   = { $env:ProgramFiles }
    ProgramData    = { $env:ProgramData }
    TempDir        = { [IO.Path]::GetTempPath() }
    GetService     = {
      param($name)
      $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'"
      if ($null -eq $svc) { return $null }
      [pscustomobject]@{ PathName = $svc.PathName; StartName = $svc.StartName; State = $svc.State }
    }
  }
}

# --- Executor -----------------------------------------------------------------------------
function Invoke-RemyralPlan {
  param([Parameter(Mandatory)]$Plan, [switch]$DryRun)
  foreach ($w in $Plan.Warnings) { Write-Warning $w }
  foreach ($a in $Plan.Actions) {
    if ($DryRun) { Write-Output ("[dry-run] " + $a.Text); continue }
    Write-Output ("+ " + ($a.Text -csplit "`n")[0])
    $d = $a.Data
    switch ($a.Kind) {
      'Mkdir' { New-Item -ItemType Directory -Path $d.Path -Force | Out-Null }
      'Copy' { Copy-Item -LiteralPath $d.From -Destination $d.To -Force }
      'WriteFile' { [IO.File]::WriteAllText($d.Path, $d.Content, (New-Object Text.UTF8Encoding $false)) }
      'Download' {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $d.Url -OutFile $d.To -UseBasicParsing
      }
      'InstallShawl' {
        $zipHash = (Get-FileHash -LiteralPath $d.Zip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($zipHash -ne $d.ZipSha256) { throw "shawl zip SHA-256 mismatch: expected $($d.ZipSha256), got $zipHash" }
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("remyral-shawl-" + [guid]::NewGuid())
        try {
          Expand-Archive -LiteralPath $d.Zip -DestinationPath $tmp
          $exe = Join-Path $tmp 'shawl.exe'
          $exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($exeHash -ne $d.ExeSha256) { throw "shawl.exe SHA-256 mismatch: expected $($d.ExeSha256), got $exeHash" }
          Copy-Item -LiteralPath $exe -Destination $d.To -Force
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
      }
      'InstallNode' {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $tmp = Join-Path $d.TempDir ("remyral-node-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        try {
          $sums = Join-Path $tmp 'SHASUMS256.txt'
          Invoke-WebRequest -Uri "$($d.Base)/SHASUMS256.txt" -OutFile $sums -UseBasicParsing
          $h = (Get-FileHash -LiteralPath $sums -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($h -ne $d.ShasumsSha256) { throw "SHASUMS256.txt has sha256 $h, pinned $($d.ShasumsSha256) - refusing (tampered mirror or wrong pin)" }
          $line = @([IO.File]::ReadAllLines($sums) | Where-Object { $_ -cmatch "^([0-9a-f]{64})  $([regex]::Escape($d.Name)).zip$" })
          if ($line.Count -ne 1 -or $line[0].Substring(0, 64) -ne $d.Sha256) { throw "SHASUMS256.txt does not list $($d.Name).zip with the pinned sha256 $($d.Sha256)" }
          $zip = Join-Path $tmp "$($d.Name).zip"
          Invoke-WebRequest -Uri "$($d.Base)/$($d.Name).zip" -OutFile $zip -UseBasicParsing
          $h = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($h -ne $d.Sha256) { throw "$($d.Name).zip has sha256 $h, expected $($d.Sha256) - refusing" }
          New-Item -ItemType Directory -Path $d.Root -Force | Out-Null
          $staging = Join-Path $d.Root (".staging-" + [guid]::NewGuid())
          Expand-Archive -LiteralPath $zip -DestinationPath $staging
          $unpacked = Join-Path $staging $d.Name
          if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'node.exe') -PathType Leaf)) { throw "$($d.Name).zip does not contain $($d.Name)\node.exe" }
          [IO.File]::WriteAllText((Join-Path $unpacked '.remyral-sha256'), "$($d.Sha256)`n", (New-Object Text.UTF8Encoding $false))
          if (Test-Path -LiteralPath $d.Dest) { Remove-Item -LiteralPath $d.Dest -Recurse -Force }
          Move-Item -LiteralPath $unpacked -Destination $d.Dest
          Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
          $v = (& (Join-Path $d.Dest 'node.exe') --version) 2>$null
          if ($v -ne "v$($d.Version)") { throw "the private Node does not run (got '$v')" }
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
      }
      'PruneNode' {
        foreach ($old in @(Get-ChildItem -LiteralPath $d.Root -Directory -Force | Where-Object { $_.Name -ne $d.Keep })) {
          Remove-Item -LiteralPath $old.FullName -Recurse -Force
        }
      }
      'Exec' {
        $out = & $d.File @($d.Args) 2>&1
        if ($LASTEXITCODE -ne 0) { throw "$($d.File) failed with exit code ${LASTEXITCODE}: $out" }
      }
      'CimCreate' {
        # A virtual account (NT SERVICE\<name>) only exists once the service does: Win32_Service.Create
        # refuses it (22, invalid service account). Create as LocalSystem, then switch the account.
        $r = Invoke-CimMethod -ClassName Win32_Service -MethodName Create -Arguments @{
          Name = $d.Name; DisplayName = $d.DisplayName; PathName = $d.PathName; ServiceType = [byte]16
          ErrorControl = [byte]1; StartMode = 'Automatic'; DesktopInteract = $false; StartName = 'LocalSystem'
        }
        if ($r.ReturnValue -ne 0) { throw "Win32_Service.Create failed with $($r.ReturnValue)" }
        Set-RemyralServiceAccount -Name $d.Name -Account $d.StartName
      }
      'CimChange' {
        $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$($d.Name)'"
        $r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{ PathName = $d.PathName }
        if ($r.ReturnValue -ne 0) { throw "Win32_Service.Change failed with $($r.ReturnValue)" }
        if ($svc.StartName -ne $d.StartName) { Set-RemyralServiceAccount -Name $d.Name -Account $d.StartName }
      }
      'Task' {
        $action = New-ScheduledTaskAction -Execute $d.Execute -Argument $d.Argument
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
        $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
        $limit = 30
        if ($d.ContainsKey('LimitMinutes')) { $limit = [int]$d.LimitMinutes }
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $limit) -StartWhenAvailable
        Register-ScheduledTask -TaskName $d.Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
      }
      'Service' {
        if ($d.Op -eq 'Restart') { Restart-Service -Name $ServiceName } else { Start-Service -Name $ServiceName }
      }
      'Bind' {
        # Never fails the install: Windows PowerShell 5.1 turns a native command's stderr into a terminating error
        # under ErrorActionPreference Stop, so a crash or a config problem is caught and reported as a warning.
        $code = 0
        try { $out = & $d.File @($d.Args) 2>&1; $code = $LASTEXITCODE } catch { $out = $_.Exception.Message; $code = -1 }
        if ($code -ne 0) { Write-Warning "admin-bind failed (exit code ${code}): $out" } else { Write-Output $out }
      }
      default { throw "unknown action kind $($a.Kind)" }
    }
  }
}

# Dot-sourcing (tests) only defines the functions above.
if ($MyInvocation.InvocationName -eq '.') { return }

# Installer kit (p5-worker-onboarding): a partial or altered copy is refused before anything changes.
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS') -PathType Leaf) {
  $bad = @(Test-RemyralKitChecksums -Dir $PSScriptRoot -Hash { param($p) if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { 'missing' } })
  if ($bad.Count -gt 0) { throw ("installer kit files do not match SHA256SUMS; download the kit again:`n  " + ($bad -join "`n  ")) }
  Write-Output '==> installer kit checksums verified (SHA256SUMS)'
}
$nodePin = $null
foreach ($candidate in @((Join-Path $PSScriptRoot 'node\pin.env'), (Join-Path $PSScriptRoot '..\node\pin.env'))) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nodePin = ConvertFrom-RemyralPin ([IO.File]::ReadAllText($candidate)); break }
}
$settings = @{
  Bundle = $Bundle; BundleSha256 = $BundleSha256; Node = $Node; MasterUrl = $MasterUrl
  PrivateNode = [bool]$PrivateNode; NodeDistUrl = $NodeDistUrl; NodePin = $nodePin
  WorkspaceRoot = $WorkspaceRoot; MaxParallelJobs = $MaxParallelJobs; ShawlZip = $ShawlZip
  ReplaceConfig = [bool]$ReplaceConfig; NoStart = [bool]$NoStart; AllowUnsafeNode = [bool]$AllowUnsafeNode; DryRun = [bool]$DryRun
  Manifest = $Manifest; Signature = $Signature; Updater = $Updater; ReleasePublicKey = $ReleasePublicKey
  JobRunner = $null; MachineAdmin = $null
}
if ($AllowMachineAdmin -and $NoMachineAdmin) { throw '-AllowMachineAdmin and -NoMachineAdmin exclude each other' }
if ($AllowMachineAdmin) { $settings.MachineAdmin = 'allow' }
if ($NoMachineAdmin) { $settings.MachineAdmin = 'forbid' }
foreach ($k in @('Manifest', 'Signature', 'Updater')) {
  if ($settings[$k] -and -not [IO.Path]::IsPathRooted($settings[$k])) { $settings[$k] = Join-Path (Get-Location) $settings[$k] }
}
if ($Bundle -and -not [IO.Path]::IsPathRooted($Bundle)) { $settings.Bundle = Join-Path (Get-Location) $Bundle }
if (-not $settings.Bundle) {
  $candidate = Join-Path $PSScriptRoot 'remyral-worker.mjs'
  if (Test-Path -LiteralPath $candidate) { $settings.Bundle = $candidate }
}
if (-not $settings.Manifest -and -not $settings.Signature -and $settings.Bundle) {
  # A kit ships the signed release next to the bundle: install it through the verifying updater.
  $dir = Split-Path -Parent $settings.Bundle
  if ((Test-Path -LiteralPath (Join-Path $dir 'manifest.json')) -and (Test-Path -LiteralPath (Join-Path $dir 'manifest.sig.json'))) {
    $settings.Manifest = Join-Path $dir 'manifest.json'
    $settings.Signature = Join-Path $dir 'manifest.sig.json'
  }
}
$candidate = Join-Path $PSScriptRoot 'remyral-jobrun.ps1'
if (Test-Path -LiteralPath $candidate -PathType Leaf) { $settings.JobRunner = $candidate }
if (-not $settings.Updater -and $settings.Bundle) {
  $candidate = Join-Path (Split-Path -Parent $settings.Bundle) 'remyral-worker-updater.mjs'
  if (Test-Path -LiteralPath $candidate) { $settings.Updater = $candidate }
}

# A worker installed before the Remyral rename (service RemanaWorker) is not migrated by this kit any more (Remyral cut-over
# cleanup): refuse before anything changes. The 1.1.1 kit still migrates it in place.
if ((Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'RemanaWorker\remana-worker.mjs')) -or (Get-Service -Name 'RemanaWorker' -ErrorAction SilentlyContinue)) {
  throw 'a worker installed before the Remyral rename (service RemanaWorker) is on this machine. This installer no longer migrates it: run the installer kit of worker 1.1.1 instead (console: /v1/worker/install/1.1.1/windows/...); it migrates the worker in place and the worker then updates itself'
}

$installStartedUtc = [DateTime]::UtcNow
$plan = Get-RemyralInstallPlan -Settings $settings -Probe (Get-RemyralSystemProbe)
Write-Output "==> node $($plan.NodePath); service $ServiceName as $ServiceAccount ($($plan.ServiceSid))"
Invoke-RemyralPlan -Plan $plan -DryRun:$DryRun
$note = if ($DryRun) { ' (dry-run: nothing was changed)' } else { '' }
Write-Output @"

Done$note.
  Status:     remyral-worker service status        (or: Get-Service $ServiceName; sc.exe queryex $ServiceName)
  Logs:       $($plan.Layout.LogDir)\remyral-worker_rCURRENT.log   (wrapper: shawl_rCURRENT.log)
              Service start/stop/crash events: Event Viewer > Windows Logs > System (source: Service Control Manager)
  Pairing:    Select-String pairingCode "$($plan.Layout.LogDir)\remyral-worker_rCURRENT.log" - then approve in the
              dashboard and compare the fingerprint (docs/ops/worker-pairing.md)
  CLI:        "$($plan.Layout.CliPath)" service status
  Updates:    node "$($plan.Layout.UpdaterPath)" status   (signed auto-update; docs/ops/worker-updates.md)
  Machine admin: once the machine is approved (only if you use machine administration), elevated:
              & "$($plan.NodePath)" "$($plan.Layout.UpdaterPath)" admin-bind   (docs/ops/machine-admin.md)
  Uninstall:  $PSScriptRoot\uninstall.ps1 [-Purge]
"@

# Like the Linux installer: wait briefly for the worker's first pairing request and print what to compare.
if (-not $DryRun -and -not $NoStart) {
  $log = Join-Path $plan.Layout.LogDir 'remyral-worker_rCURRENT.log'
  $pairing = $null
  for ($i = 0; $i -lt 30 -and -not $pairing; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path -LiteralPath $log) {
      $pairing = Get-Content -LiteralPath $log -Tail 200 -ErrorAction SilentlyContinue |
        Where-Object { $_ -clike '*"pairingCode"*' } | Select-Object -Last 1
    }
  }
  if ($pairing) {
    $entry = $pairing | ConvertFrom-Json
    # Only a request logged by this run counts: an enrolled worker never logs a new one, and an older line
    # in the same log would show a stale code.
    $loggedAt = if ($entry.ts -is [DateTime]) { $entry.ts.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$entry.ts, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
    if ($loggedAt -lt $installStartedUtc.AddSeconds(-5)) { $pairing = $null }
  }
  if ($pairing) {
    Write-Output @"

Approve this machine: dashboard > Fleet > Waiting for approval
  Pairing code: $($entry.pairingCode)
  Fingerprint:  $($entry.fingerprint)
"@
  } elseif (Test-Path -LiteralPath $log) {
    Write-Output "`nNo pairing request yet (already approved, or still starting). Check: Select-String pairingCode `"$log`""
  }
}
