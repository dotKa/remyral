#Requires -Version 5.1
<#
.SYNOPSIS
  Remyral worker uninstaller for Windows - p2-service-windows.

.DESCRIPTION
    .\uninstall.ps1           stop (graceful: running jobs are cancelled) and delete the service,
                              remove %ProgramFiles%\RemyralWorker; KEEP %ProgramData%\RemyralWorker
                              (config, device key, state, workspaces, logs)
    .\uninstall.ps1 -Purge    also delete %ProgramData%\RemyralWorker (device key => re-pairing)

  Idempotent; -DryRun prints every action without changing anything.
#>
[CmdletBinding()]
param([switch]$Purge, [switch]$DryRun)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ServiceName = 'RemyralWorker'

function Get-RemyralUninstallPlan {
  param([Parameter(Mandatory)][hashtable]$Settings, [Parameter(Mandatory)][hashtable]$Probe)
  $actions = New-Object System.Collections.Generic.List[object]
  $notes = New-Object System.Collections.Generic.List[string]
  if (-not $Settings.DryRun -and -not (& $Probe.IsAdmin)) { throw 'run from an elevated PowerShell (Run as administrator), or use -DryRun' }
  $programDir = (& $Probe.ProgramFiles).TrimEnd([char]0x5C) + '\RemyralWorker'
  $dataRoot = (& $Probe.ProgramData).TrimEnd([char]0x5C) + '\RemyralWorker'

  # p2-signed-updates: the updater's scheduled task.
  if ($Probe.ContainsKey('TaskExists') -and (& $Probe.TaskExists 'RemyralWorkerUpdater')) {
    $actions.Add([pscustomobject]@{ Kind = 'Exec'; Text = 'schtasks.exe /Delete /TN RemyralWorkerUpdater /F'; Data = @{ File = 'schtasks.exe'; Args = @('/Delete', '/TN', 'RemyralWorkerUpdater', '/F') } })
  }
  # p5-machine-admin: the elevated broker's scheduled task.
  if ($Probe.ContainsKey('TaskExists') -and (& $Probe.TaskExists 'RemyralWorkerAdmin')) {
    $actions.Add([pscustomobject]@{ Kind = 'Exec'; Text = 'schtasks.exe /Delete /TN RemyralWorkerAdmin /F'; Data = @{ File = 'schtasks.exe'; Args = @('/Delete', '/TN', 'RemyralWorkerAdmin', '/F') } })
  }
  $svc = & $Probe.GetService $ServiceName
  if ($null -ne $svc) {
    if ($svc.State -ne 'Stopped') {
      $actions.Add([pscustomobject]@{ Kind = 'Stop'; Text = "Stop-Service $ServiceName"; Data = @{} })
    }
    $actions.Add([pscustomobject]@{ Kind = 'Exec'; Text = "sc.exe delete $ServiceName"; Data = @{ File = 'sc.exe'; Args = @('delete', $ServiceName) } })
  } else {
    $notes.Add('service not installed')
  }
  if (& $Probe.DirExists $programDir) {
    $actions.Add([pscustomobject]@{ Kind = 'Remove'; Text = "remove $programDir"; Data = @{ Path = $programDir } })
  }
  if ($Settings.Purge) {
    $workspaceRoot = & $Probe.ConfiguredWorkspaceRoot ($dataRoot + '\config.json')
    if (& $Probe.DirExists $dataRoot) {
      $actions.Add([pscustomobject]@{ Kind = 'Remove'; Text = "remove $dataRoot"; Data = @{ Path = $dataRoot } })
    }
    if ($workspaceRoot -and -not $workspaceRoot.StartsWith($dataRoot + '\') -and (& $Probe.DirExists $workspaceRoot)) {
      $notes.Add("custom workspace root $workspaceRoot was NOT removed; delete it yourself if no longer needed")
    }
    $notes.Add('purged: revoke the worker in the dashboard')
  } else {
    $notes.Add("kept $dataRoot (config, device key, state, workspaces, logs); use -Purge to remove it")
  }
  [pscustomobject]@{ Actions = $actions.ToArray(); Notes = $notes.ToArray() }
}

function Get-RemyralUninstallProbe {
  @{
    IsAdmin                 = { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    DirExists               = { param($p) Test-Path -LiteralPath $p -PathType Container }
    ProgramFiles            = { $env:ProgramFiles }
    ProgramData             = { $env:ProgramData }
    GetService              = {
      param($name)
      $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'"
      if ($null -eq $svc) { return $null }
      [pscustomobject]@{ State = $svc.State }
    }
    TaskExists              = {
      param($name)
      $null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)
    }
    ConfiguredWorkspaceRoot = {
      param($configPath)
      try { (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).workspaceRoot } catch { $null }
    }
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }

$plan = Get-RemyralUninstallPlan -Settings @{ Purge = [bool]$Purge; DryRun = [bool]$DryRun } -Probe (Get-RemyralUninstallProbe)
foreach ($a in $plan.Actions) {
  if ($DryRun) { Write-Output ("[dry-run] " + $a.Text); continue }
  Write-Output ("+ " + $a.Text)
  switch ($a.Kind) {
    # Stop-Service waits while shawl sends Ctrl-C and the daemon cancels its jobs (<= 60 s).
    'Stop' { Stop-Service -Name $ServiceName }
    'Exec' {
      $out = & $a.Data.File @($a.Data.Args) 2>&1
      if ($LASTEXITCODE -ne 0) { throw "$($a.Data.File) failed with exit code ${LASTEXITCODE}: $out" }
    }
    'Remove' { Remove-Item -LiteralPath $a.Data.Path -Recurse -Force }
  }
}
foreach ($n in $plan.Notes) { Write-Output $n }
if ($DryRun) { Write-Output '(dry-run: nothing was changed)' }
