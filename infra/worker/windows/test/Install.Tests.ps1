#Requires -Version 5.1
<#
  Plan tests for install.ps1 / uninstall.ps1 with fake probes - no Windows, no admin, no
  service changes needed. Plain assertions (no Pester dependency) so it runs on Windows
  PowerShell 5.1 and on PowerShell 7 (e.g. `infra/worker/windows/test/run-tests.sh`, which
  uses the mcr.microsoft.com/powershell image). Exits 1 on the first failure.
#>
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$script:passed = 0

function Assert-True([bool]$Condition, [string]$What) {
  if (-not $Condition) { Write-Output "FAIL $What"; exit 1 }
  $script:passed++
  Write-Output "PASS $What"
}
function Assert-Equal($Expected, $Actual, [string]$What) {
  Assert-True ($Expected -ceq $Actual) "$What (expected '$Expected', got '$Actual')"
}
function Assert-Throws([scriptblock]$Block, [string]$Pattern, [string]$What) {
  try { & $Block; Assert-True $false "$What (did not throw)" }
  catch { Assert-True ($_.Exception.Message -match $Pattern) "$What ($($_.Exception.Message))" }
}

# --- 1. Syntax, and nothing that Windows PowerShell 5.1 cannot parse ------------------------
foreach ($file in @('install.ps1', 'uninstall.ps1', 'test\Install.Tests.ps1')) {
  $path = Join-Path $root ($file -replace '\\', [IO.Path]::DirectorySeparatorChar)
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert-Equal 0 $errors.Count "$file parses without errors"
  $ps7only = $ast.FindAll({
      param($n)
      $t = $n.GetType().Name
      ($t -eq 'TernaryExpressionAst') -or ($t -eq 'PipelineChainAst') -or
      ($t -eq 'BinaryExpressionAst' -and "$($n.Operator)" -eq 'QuestionQuestion') -or
      ($t -eq 'AssignmentStatementAst' -and "$($n.Operator)" -eq 'QuestionQuestionEquals')
    }, $true)
  Assert-Equal 0 @($ps7only).Count "$file uses no PowerShell 7-only operators (?:, ??, &&, ||)"
}

. (Join-Path $root 'install.ps1')
. (Join-Path $root 'uninstall.ps1')

# --- 2. Service SID and command-line quoting ----------------------------------------------
Assert-Equal 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' (Get-RemyralServiceSid 'TrustedInstaller') 'service SID algorithm matches the well-known TrustedInstaller SID'
Assert-Equal 'S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060' (Get-RemyralServiceSid 'RemyralWorker') 'RemyralWorker service SID'
Assert-Equal 'a "b c" "d\"e" "f g\\"' (ConvertTo-RemyralCommandLine @('a', 'b c', 'd"e', 'f g\')) 'CommandLineToArgvW quoting (spaces, quotes, trailing backslash)'
Assert-Equal '""' (ConvertTo-RemyralCommandLine @('')) 'empty argument is quoted'

# --- Fakes -----------------------------------------------------------------------------------
$bundleHash = 'ab' * 32
# Closures are built inside a function: GetNewClosure() at script scope would capture the dot-sourced
# installer's parameters too, and Windows PowerShell 5.1 refuses to copy $MaxParallelJobs (ValidateRange)
# while it holds its unset value 0.
function New-ConstFn($Value) { { param($x) $Value }.GetNewClosure() }
function New-ServiceFn([string]$PathName, [string]$StartName) {
  { param($n) [pscustomobject]@{ PathName = $PathName; StartName = $StartName; State = 'Running' } }.GetNewClosure()
}

function New-Closure([scriptblock]$Block, [hashtable]$Vars) {
  foreach ($k in $Vars.Keys) { Set-Variable -Name $k -Value $Vars[$k] }
  $Block.GetNewClosure()
}

function New-FakeProbe([hashtable]$Override = @{}) {
  $p = @{
    IsAdmin        = { $true }
    FileExists     = { param($x) $x -eq 'C:\dl\remyral-worker.mjs' }
    DirExists      = { param($x) $false }
    FileHash       = { param($x) if ($x -eq 'C:\dl\remyral-worker.mjs') { $bundleHash } else { $null } }
    ReadText       = { param($x) $null }
    FindNode       = { 'C:\Program Files\nodejs\node.exe' }
    PrivateNodeDirs = { param($r) @() }
    NodeVersion    = { param($x) 'v24.19.0' }
    NodeWritableBy = { param($x, $sids) $null }
    ProgramFiles   = { 'C:\Program Files' }
    ProgramData    = { 'C:\ProgramData' }
    TempDir        = { 'C:\Temp\' }
    GetService     = { param($n) $null }
  }
  foreach ($k in $Override.Keys) { $p[$k] = $Override[$k] }
  $p
}
function New-Settings([hashtable]$Override = @{}) {
  $s = @{ Bundle = 'C:\dl\remyral-worker.mjs'; BundleSha256 = $bundleHash; MasterUrl = 'wss://m.example.com/v1/worker'; MaxParallelJobs = 1; DryRun = $false }
  foreach ($k in $Override.Keys) { $s[$k] = $Override[$k] }
  $s
}
function Get-Kinds($Plan) { @($Plan.Actions | ForEach-Object { $_.Kind }) -join ',' }
function Get-Texts($Plan) { @($Plan.Actions | ForEach-Object { $_.Text }) }

# --- 3. Fresh install ------------------------------------------------------------------------
$plan = Get-RemyralInstallPlan -Settings (New-Settings) -Probe (New-FakeProbe)
Assert-Equal 'Mkdir,Copy,Download,InstallShawl,WriteFile,Mkdir,Mkdir,Mkdir,Mkdir,WriteFile,CimCreate,Exec,Exec,Exec,Exec,Exec,Exec,Exec,Exec,Exec,Exec,Service' (Get-Kinds $plan) 'fresh install: action sequence (service before the ACLs that name its SID)'
$texts = Get-Texts $plan
$sid = 'S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *$($sid):(RX)") 'data root: inheritance removed, SYSTEM + Administrators full, service read only'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker\config.json /grant:r *$($sid):(R)") 'config: service may read, not write'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker\data /grant:r *$($sid):(OI)(CI)M") 'data dir (device key, state): service modify'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker\logs /grant:r *$($sid):(OI)(CI)M") 'logs: service modify'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker\workspaces /grant:r *$($sid):(OI)(CI)M") 'workspaces: service modify'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker\data /setowner *$($sid) /T /C /Q") 'data dir: owned by the service (pre-rename owner taken back)'
Assert-True ($texts -contains "icacls C:\ProgramData\RemyralWorker\workspaces /setowner *$($sid) /T /C /Q") 'workspaces: owned by the service'
Assert-True ($texts -contains 'sc.exe failure RemyralWorker reset= 86400 actions= restart/10000/restart/30000/restart/60000') 'SCM recovery actions restart the wrapper'
Assert-True ($texts -contains 'sc.exe failureflag RemyralWorker 0') 'failureflag 0: exit 78 is not "recovered" by the SCM'
Assert-True ($texts -contains 'sc.exe config RemyralWorker start= delayed-auto') 'delayed automatic start at boot'
Assert-True ($texts -contains 'sc.exe sidtype RemyralWorker unrestricted') 'unrestricted service SID (virtual account)'
$create = $plan.Actions | Where-Object { $_.Kind -eq 'CimCreate' }
Assert-Equal 'NT SERVICE\RemyralWorker' $create.Data.StartName 'runs as the virtual service account'
$cmd = $create.Data.PathName
Assert-True $cmd.StartsWith('"C:\Program Files\RemyralWorker\shawl.exe" run --name RemyralWorker --cwd C:\ProgramData\RemyralWorker\data') 'ImagePath starts with the quoted shawl path'
Assert-True ($cmd -match ' --stop-timeout 60000 --restart-if-not 0,78 --restart-delay 10000 --kill-process-tree ') 'graceful stop timeout 60 s; restart unless 0 or 78; process tree killed'
Assert-True ($cmd -match ' --log-dir C:\\ProgramData\\RemyralWorker\\logs --log-as shawl --log-cmd-as remyral-worker ') 'file logging in the ACLd log dir'
Assert-True $cmd.EndsWith(' -- "C:\Program Files\nodejs\node.exe" "C:\Program Files\RemyralWorker\remyral-worker.mjs" run --config C:\ProgramData\RemyralWorker\config.json') 'runs node + bundle with the system config'
$config = ($plan.Actions | Where-Object { $_.Kind -eq 'WriteFile' -and $_.Data.Path -like '*config.json' }).Data.Content | ConvertFrom-Json
Assert-Equal 'wss://m.example.com/v1/worker' $config.masterUrl 'config: master URL'
Assert-True (-not ($config.PSObject.Properties.Name -contains 'dataDir')) 'config: no dataDir (the daemon default is the data dir)'
Assert-Equal 'C:\ProgramData\RemyralWorker\workspaces' $config.workspaceRoot 'config: workspace root under the worker-owned root'
Assert-Equal 'NT SERVICE\RemyralWorker' $config.sandbox.workerUser 'config: sandbox.workerUser = the service account (p5-sandbox-ops)'
Assert-True (@($plan.Warnings | Where-Object { $_ -match 'remyral-jobrun.ps1 not given' }).Count -gt 0) 'no job runner in the kit: warned, the worker uses its embedded copy'

# --- 3b. p5-sandbox-ops: the job runner is installed next to the worker --------------------------
$jrProbe = New-FakeProbe @{
  FileExists = { param($x) $x -eq 'C:\dl\remyral-worker.mjs' -or $x -eq 'C:\dl\remyral-jobrun.ps1' }
  FileHash   = { param($x) if ($x -eq 'C:\dl\remyral-worker.mjs') { $bundleHash } elseif ($x -eq 'C:\dl\remyral-jobrun.ps1') { 'cd' * 32 } else { $null } }
}
$jr = Get-RemyralInstallPlan -Settings (New-Settings @{ JobRunner = 'C:\dl\remyral-jobrun.ps1' }) -Probe $jrProbe
Assert-True ((Get-Texts $jr) -contains 'copy C:\dl\remyral-jobrun.ps1 -> C:\Program Files\RemyralWorker\remyral-jobrun.ps1') 'job runner copied into the admin-owned program dir'
$jrSame = Get-RemyralInstallPlan -Settings (New-Settings @{ JobRunner = 'C:\dl\remyral-jobrun.ps1' }) -Probe (New-FakeProbe @{
  FileExists = { param($x) $x -eq 'C:\dl\remyral-worker.mjs' -or $x -eq 'C:\dl\remyral-jobrun.ps1' }
  FileHash   = { param($x) if ($x -eq 'C:\dl\remyral-worker.mjs') { $bundleHash } else { 'cd' * 32 } }
})
Assert-True (@(Get-Texts $jrSame | Where-Object { $_ -match 'remyral-jobrun' }).Count -eq 0) 'an identical job runner is not copied again'
$jrTokens = $null; $jrErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'remyral-jobrun.ps1'), [ref]$jrTokens, [ref]$jrErrors)
Assert-Equal 0 $jrErrors.Count 'remyral-jobrun.ps1 parses without errors'
$shawl = $plan.Actions | Where-Object { $_.Kind -eq 'InstallShawl' }
Assert-Equal 'f883c5d09c9beae2efaeabd8513e7d3f57cd1d0864cec3df4f4a7b6ee904351c' $shawl.Data.ZipSha256 'shawl zip pinned by SHA-256'
Assert-Equal '0985555b71e7f943b8f3fc639952a9890aa62e66617942a2d0996985fe8e7c6d' $shawl.Data.ExeSha256 'shawl.exe pinned by SHA-256'
Assert-Equal 'Start' $plan.Actions[-1].Data.Op 'fresh install starts the service'

# --- 4. Re-run on an up-to-date machine: only idempotent ACL/recovery steps ----------------------
$installedCmd = $cmd
$cli = "@echo off`r`nrem remyral-worker CLI wrapper (installed by infra/worker/windows/install.ps1)`r`n`"C:\Program Files\nodejs\node.exe`" `"C:\Program Files\RemyralWorker\remyral-worker.mjs`" %*`r`n"
$upToDate = New-FakeProbe @{
  DirExists  = { param($x) $true }
  FileExists = { param($x) $true }
  FileHash   = { param($x) if ($x -like '*shawl.exe') { '0985555b71e7f943b8f3fc639952a9890aa62e66617942a2d0996985fe8e7c6d' } else { $bundleHash } }
  ReadText   = New-ConstFn $cli
  GetService = New-ServiceFn $installedCmd 'NT SERVICE\RemyralWorker'
}
$rerun = Get-RemyralInstallPlan -Settings (New-Settings) -Probe $upToDate
Assert-Equal 'Exec,Exec,Exec,Exec,Exec,Exec,Exec,Exec,Exec,Exec' (Get-Kinds $rerun) 're-run: no copies, no service changes, no restart'
Assert-True ($rerun.Warnings -contains 'config exists and was NOT changed (edit it, or pass -ReplaceConfig)') 're-run: existing config kept'
# Local ceiling of machine administration: -NoMachineAdmin / -AllowMachineAdmin on an existing config (only that key,
# through the updater, then a restart) and in a new config.
$veto = Get-RemyralInstallPlan -Settings (New-Settings @{ MachineAdmin = 'forbid' }) -Probe $upToDate
$ceil = @($veto.Actions | Where-Object { $_.Text -like 'node *machine-admin-ceiling*' })
Assert-Equal 1 $ceil.Count 'machine-admin ceiling: one updater step on an existing config'
Assert-Equal 'C:\Program Files\RemyralWorker\remyral-worker-updater.mjs,machine-admin-ceiling,forbid,--config,C:\ProgramData\RemyralWorker\config.json' ($ceil[0].Data.Args -join ',') 'machine-admin ceiling: forbid, system config'
Assert-Equal 'Restart' $veto.Actions[-1].Data.Op 'machine-admin ceiling: the service is restarted to read it'
$allowNew = Get-RemyralInstallPlan -Settings (New-Settings @{ MachineAdmin = 'allow' }) -Probe (New-FakeProbe)
$allowCfg = ($allowNew.Actions | Where-Object { $_.Kind -eq 'WriteFile' -and $_.Data.Path -like '*config.json' }).Data.Content | ConvertFrom-Json
Assert-Equal $true $allowCfg.localCeiling.allowMachineAdmin 'machine-admin ceiling: written into a new config'
Assert-Equal 1 $allowCfg.localCeiling.maxParallelJobs 'machine-admin ceiling: next to the parallelism ceiling'
Assert-True (-not ((Get-Texts $plan) -match 'machine-admin-ceiling')) 'machine-admin ceiling: nothing without a flag'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ MachineAdmin = 'maybe' }) -Probe (New-FakeProbe) } 'MachineAdmin must be' 'machine-admin ceiling: only allow / forbid'

# --- 5. New bundle on a running service -> copy + restart; changed account -> Change -----------------
$newBundle = New-FakeProbe @{
  DirExists  = { param($x) $true }
  FileExists = { param($x) $true }
  FileHash   = { param($x) if ($x -like '*shawl.exe') { '0985555b71e7f943b8f3fc639952a9890aa62e66617942a2d0996985fe8e7c6d' } elseif ($x -eq 'C:\dl\remyral-worker.mjs') { $bundleHash } else { 'cd' * 32 } }
  ReadText   = New-ConstFn $cli
  GetService = New-ServiceFn $installedCmd 'LocalSystem'
}
$upd = Get-RemyralInstallPlan -Settings (New-Settings) -Probe $newBundle
Assert-True ((Get-Kinds $upd) -match '^Copy,') 'update: bundle copied'
Assert-True ((Get-Kinds $upd) -match 'CimChange') 'update: a service running as LocalSystem is switched to the virtual account'
Assert-Equal 'Restart' $upd.Actions[-1].Data.Op 'update: running service restarted'

# --- 6. Validation --------------------------------------------------------------------------------
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ MasterUrl = 'http://m.example.com' }) -Probe (New-FakeProbe) } 'must start with wss://' 'http master URL rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ BundleSha256 = '00' * 32 }) -Probe (New-FakeProbe) } 'SHA-256 mismatch' 'bundle hash mismatch rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ Bundle = 'C:\nope.mjs' }) -Probe (New-FakeProbe) } 'bundle not found' 'missing bundle rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ Node = 'C:\tools\node.exe' }) -Probe (New-FakeProbe @{ NodeVersion = { param($x) 'v22.1.0' } }) } 'Node.js 24 is required' 'explicit -Node 22 rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings) -Probe (New-FakeProbe @{ NodeVersion = { param($x) 'v22.1.0' } }) } 'pin.env is missing' 'system Node 22 and no pin: refused with a hint'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings) -Probe (New-FakeProbe @{ IsAdmin = { $false } }) } 'elevated' 'non-admin real install rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ WorkspaceRoot = 'C:\Users\me\work' }) -Probe (New-FakeProbe) } "user's profile" 'workspace inside a user profile rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ Node = 'C:\Users\me\AppData\Local\nvm\v24\node.exe' }) -Probe (New-FakeProbe) } 'inside a user profile' 'per-user Node rejected'
$writable = New-FakeProbe @{ NodeWritableBy = { param($x, $sids) 'C:\tools\node is writable by BUILTIN\Users (Modify)' } }
$explicitNode = @{ Node = 'C:\tools\node.exe' }
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings $explicitNode) -Probe $writable } 'unsafe Node location' 'user-writable -Node rejected'
$accepted = Get-RemyralInstallPlan -Settings (New-Settings @{ Node = 'C:\tools\node.exe'; AllowUnsafeNode = $true }) -Probe $writable
Assert-True (@($accepted.Warnings | Where-Object { $_ -like 'unsafe Node location accepted*' }).Count -eq 1) '-AllowUnsafeNode turns it into a warning'
$dry = Get-RemyralInstallPlan -Settings (New-Settings @{ Node = 'C:\tools\node.exe'; DryRun = $true }) -Probe (New-FakeProbe @{ IsAdmin = { $false }; NodeWritableBy = { param($x, $sids) 'writable' } })
Assert-True (@($dry.Warnings | Where-Object { $_ -like '*a real install would STOP here' }).Count -eq 1) 'dry-run as non-admin reports the Node problem and still plans'

# --- 7. No config and no master URL: installed but not started, no config ACL ---------------------
$noCfg = Get-RemyralInstallPlan -Settings (New-Settings @{ MasterUrl = $null }) -Probe (New-FakeProbe)
Assert-True (-not ((Get-Kinds $noCfg) -match 'Service')) 'no config: not started'
Assert-True (-not (@(Get-Texts $noCfg) -match 'config\.json /grant')) 'no config: no config ACL'
Assert-True ($noCfg.Warnings -contains 'not starting: no config') 'no config: says why'

# --- 8. Custom workspace root outside the data root gets its own protected ACL --------------------
$custom = Get-RemyralInstallPlan -Settings (New-Settings @{ WorkspaceRoot = 'D:\RemyralWork' }) -Probe (New-FakeProbe)
Assert-True ((Get-Texts $custom) -contains "icacls D:\RemyralWork /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *$($sid):(OI)(CI)M") 'custom workspace root: protected ACL'

# --- 9. Dry-run executor prints and executes nothing ---------------------------------------------
$printed = @(Invoke-RemyralPlan -Plan $plan -DryRun 3>$null)
Assert-Equal $plan.Actions.Count $printed.Count 'dry-run prints one line per action'
Assert-True (@($printed | Where-Object { $_ -notlike '`[dry-run`] *' }).Count -eq 0) 'every dry-run line is marked [dry-run]'

# --- 10. Uninstall plan ---------------------------------------------------------------------------
$uProbe = @{
  IsAdmin = { $true }; DirExists = { param($p) $true }; ProgramFiles = { 'C:\Program Files' }; ProgramData = { 'C:\ProgramData' }
  GetService = { param($n) [pscustomobject]@{ State = 'Running' } }
  ConfiguredWorkspaceRoot = { param($p) 'D:\RemyralWork' }
}
$u = Get-RemyralUninstallPlan -Settings @{ Purge = $false; DryRun = $false } -Probe $uProbe
Assert-Equal 'Stop-Service RemyralWorker|sc.exe delete RemyralWorker|remove C:\Program Files\RemyralWorker' (@($u.Actions | ForEach-Object { $_.Text }) -join '|') 'uninstall: graceful stop, delete, program files; data kept'
$up = Get-RemyralUninstallPlan -Settings @{ Purge = $true; DryRun = $false } -Probe $uProbe
Assert-True (@($up.Actions | ForEach-Object { $_.Text }) -contains 'remove C:\ProgramData\RemyralWorker') 'purge removes the data root'
Assert-True (@($up.Notes | Where-Object { $_ -like 'custom workspace root D:\RemyralWork was NOT removed*' }).Count -eq 1) 'purge leaves a custom workspace root and says so'
$gone = Get-RemyralUninstallPlan -Settings @{ Purge = $true; DryRun = $false } -Probe @{
  IsAdmin = { $true }; DirExists = { param($p) $false }; ProgramFiles = { 'C:\Program Files' }; ProgramData = { 'C:\ProgramData' }
  GetService = { param($n) $null }; ConfiguredWorkspaceRoot = { param($p) $null }
}
Assert-Equal 0 $gone.Actions.Count 'uninstall on a clean machine does nothing (idempotent)'

# --- 11. Signed install + updater scheduled task (p2-signed-updates) --------------------------------
$signedFiles = @('C:\dl\remyral-worker.mjs', 'C:\dl\manifest.json', 'C:\dl\manifest.sig.json', 'C:\dl\remyral-worker-updater.mjs')
$signedProbe = New-FakeProbe @{
  FileExists = New-Closure { param($x) $signedFiles -contains $x } @{ signedFiles = $signedFiles }
  FileHash   = { param($x) if ($x -eq 'C:\dl\remyral-worker.mjs') { $bundleHash } elseif ($x -eq 'C:\dl\remyral-worker-updater.mjs') { 'ef' * 32 } else { $null } }
}
$signedSettings = @{ BundleSha256 = $null; Manifest = 'C:\dl\manifest.json'; Signature = 'C:\dl\manifest.sig.json'; Updater = 'C:\dl\remyral-worker-updater.mjs'; ReleasePublicKey = ('A' * 43) }
$signed = Get-RemyralInstallPlan -Settings (New-Settings $signedSettings) -Probe $signedProbe
$st = Get-Texts $signed
Assert-True ($st -contains 'mkdir C:\Program Files\RemyralWorker\versions') 'signed: versions dir'
Assert-True ($st -contains 'mkdir C:\Program Files\RemyralWorker\state') 'signed: updater state dir'
Assert-True ($st -contains 'copy C:\dl\remyral-worker-updater.mjs -> C:\Program Files\RemyralWorker\remyral-worker-updater.mjs') 'signed: updater installed under Program Files'
Assert-True ($st -contains 'node "C:\Program Files\RemyralWorker\remyral-worker-updater.mjs" adopt --install-dir "C:\Program Files\RemyralWorker" --bundle C:\dl\remyral-worker.mjs --manifest C:\dl\manifest.json --signature C:\dl\manifest.sig.json') 'signed: bundle verified and activated by the updater'
Assert-True (-not ($st -contains 'copy C:\dl\remyral-worker.mjs -> C:\Program Files\RemyralWorker\remyral-worker.mjs')) 'signed: no unverified copy of the bundle'
$adopt = $signed.Actions | Where-Object { $_.Text -like 'node *adopt*' }
Assert-Equal 'C:\Program Files\nodejs\node.exe' $adopt.Data.File 'signed: adopt runs with the checked Node'
$task = @($signed.Actions | Where-Object { $_.Kind -eq 'Task' })
Assert-Equal 2 $task.Count 'signed: updater and admin scheduled tasks (SYSTEM, every minute) via Register-ScheduledTask'
Assert-Equal 'RemyralWorkerUpdater' $task[0].Data.Name 'signed: task name'
Assert-Equal 'C:\Program Files\nodejs\node.exe' $task[0].Data.Execute 'signed: task runs the checked Node'
Assert-True ($task[0].Data.Argument -like '*apply --config C:\ProgramData\RemyralWorker\config.json*') 'signed: task runs `apply` with the system config'
Assert-Equal 'RemyralWorkerAdmin' $task[1].Data.Name 'machine-admin: broker task name'
Assert-True ($task[1].Data.Argument -clike '*remyral-worker-updater.mjs*admin-session --config C:\ProgramData\RemyralWorker\config.json*') 'machine-admin: task runs admin-session with the system config'
Assert-Equal 780 $task[1].Data.LimitMinutes 'machine-admin: a session may run up to 13 h'
$bind = @($signed.Actions | Where-Object { $_.Kind -eq 'Bind' })
Assert-Equal 1 $bind.Count 'helper binding: one admin-bind step'
Assert-Equal 'Bind' $signed.Actions[-1].Kind 'helper binding: after the service start (an enrolled worker is bound; a new one later)'
Assert-Equal 'C:\Program Files\RemyralWorker\remyral-worker-updater.mjs,admin-bind,--if-unbound,--config,C:\ProgramData\RemyralWorker\config.json' ($bind[0].Data.Args -join ',') 'helper binding: installer mode, system config'
Assert-Equal 'C:\Program Files\nodejs\node.exe' $bind[0].Data.File 'helper binding: runs with the checked Node'
$signedCfg = ($signed.Actions | Where-Object { $_.Kind -eq 'WriteFile' -and $_.Data.Path -like '*config.json' }).Data.Content | ConvertFrom-Json
Assert-Equal ('A' * 43) $signedCfg.updates.releaseKeys[0] 'signed: release key written to the new config'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ Manifest = 'C:\dl\manifest.json'; Signature = 'C:\dl\manifest.sig.json' }) -Probe $signedProbe } 'needs remyral-worker-updater.mjs' 'signed install without the updater rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings ($signedSettings + @{})) -Probe (New-FakeProbe) } 'must both name existing files' 'missing manifest rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ Updater = 'C:\dl\remyral-worker-updater.mjs'; ReleasePublicKey = 'short' }) -Probe $signedProbe } 'ReleasePublicKey' 'malformed release key rejected'
$uTask = $uProbe.Clone()
$uTask.TaskExists = { param($n) $n -eq 'RemyralWorkerUpdater' }
$ut = Get-RemyralUninstallPlan -Settings @{ Purge = $false; DryRun = $false } -Probe $uTask
Assert-Equal 'schtasks.exe /Delete /TN RemyralWorkerUpdater /F' $ut.Actions[0].Text 'uninstall removes the updater task first'
$uTask.TaskExists = { param($n) $true }
$ut2 = Get-RemyralUninstallPlan -Settings @{ Purge = $false; DryRun = $false } -Probe $uTask
Assert-Equal 'schtasks.exe /Delete /TN RemyralWorkerAdmin /F' $ut2.Actions[1].Text 'uninstall removes the machine-admin task too'

# --- 12. Pinned private Node (p5-worker-onboarding) -------------------------------------------------
$pinText = [IO.File]::ReadAllText((Join-Path (Split-Path -Parent $root) ('node' + [IO.Path]::DirectorySeparatorChar + 'pin.env')))
$pin = ConvertFrom-RemyralPin $pinText
Assert-True ($pin.NODE_VERSION -match '^24\.\d+\.\d+$') "shipped pin.env parses (Node $($pin.NODE_VERSION))"
Assert-True ($pin.NODE_SHA256_win_x64 -match '^[0-9a-f]{64}$') 'pin.env has the win-x64 zip hash'
Assert-Throws { ConvertFrom-RemyralPin "NODE_VERSION=22.1.0`nNODE_DIST_URL=https://nodejs.org/dist`nNODE_SHASUMS256_SHA256=$('a' * 64)`nNODE_SHA256_win_x64=$('b' * 64)" } 'needs Node 24' 'a pin of another major is refused'
Assert-Throws { ConvertFrom-RemyralPin 'NODE_VERSION=24.1.0' } 'no valid NODE_DIST_URL' 'an incomplete pin is refused'
$nodeName = "node-v$($pin.NODE_VERSION)-win-x64"
$privNodeExe = "C:\Program Files\RemyralWorker\node\$nodeName\node.exe"
# a) no Node on PATH -> download + verify + extract, service and CLI use the private node
$noNode = New-FakeProbe @{ FindNode = { $null } }
$pv = Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin }) -Probe $noNode
$inst = @($pv.Actions | Where-Object { $_.Kind -eq 'InstallNode' })
Assert-Equal 1 $inst.Count 'no Node: one InstallNode action'
Assert-Equal 'Mkdir,InstallNode' ((@($pv.Actions | Select-Object -First 2 | ForEach-Object { $_.Kind })) -join ',') 'Node is installed right after the program dir, before anything runs node'
Assert-Equal "https://nodejs.org/dist/v$($pin.NODE_VERSION)" $inst[0].Data.Base 'downloads from the pinned nodejs.org release dir'
Assert-Equal $pin.NODE_SHA256_win_x64 $inst[0].Data.Sha256 'zip hash = pin'
Assert-Equal $pin.NODE_SHASUMS256_SHA256 $inst[0].Data.ShasumsSha256 'SHASUMS256.txt hash = pin'
Assert-Equal "C:\Program Files\RemyralWorker\node\$nodeName" $inst[0].Data.Dest 'installed under Program Files (admin-writable only), not on PATH'
Assert-Equal $privNodeExe $pv.NodePath 'plan uses the private node'
$pvCreate = $pv.Actions | Where-Object { $_.Kind -eq 'CimCreate' }
Assert-True ($pvCreate.Data.PathName -like "* -- `"$privNodeExe`" *") 'service command line runs the private node'
Assert-True (@($pv.Warnings | Where-Object { $_ -like 'no Node.js 24 on PATH: using the pinned private Node*' }).Count -eq 1) 'says why the private Node is used'
Assert-True (-not ((Get-Kinds $pv) -match 'PruneNode')) 'fresh machine: nothing to prune'
# b) a Node 22 on PATH is left alone; the pinned Node is installed next to it
$pv22 = Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin }) -Probe (New-FakeProbe @{ NodeVersion = { param($x) 'v22.1.0' } })
Assert-Equal $privNodeExe $pv22.NodePath 'system Node 22: private Node used instead'
# c) private node already installed at the pin -> no download (idempotent re-run)
$installed = New-FakeProbe @{
  FindNode   = { $null }
  PrivateNodeDirs = New-Closure { param($r) @($nodeName) } @{ nodeName = $nodeName }
  FileExists = New-Closure { param($x) ($x -eq 'C:\dl\remyral-worker.mjs') -or ($x -eq $privNodeExe) } @{ privNodeExe = $privNodeExe }
  ReadText   = New-Closure { param($x) if ($x -like '*\.remyral-sha256') { "$($pin.NODE_SHA256_win_x64)`n" } else { $null } } @{ pin = $pin }
}
$again = Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin }) -Probe $installed
Assert-True (-not ((Get-Kinds $again) -match 'InstallNode|PruneNode')) 'pinned private Node present: not downloaded again, nothing pruned'
Assert-Equal $privNodeExe $again.NodePath 'pinned private Node present: used'
# d) an older private Node (pin moved) -> new one installed, old ones pruned after the service change
$older = New-FakeProbe @{
  FindNode  = { 'C:\Program Files\nodejs\node.exe' }
  PrivateNodeDirs = { param($r) @('node-v24.0.0-win-x64') }
}
$up = Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin }) -Probe $older
Assert-True ((Get-Kinds $up) -match 'InstallNode') 'managed private Node is kept at the pin even if a system Node exists'
$prune = @($up.Actions | Where-Object { $_.Kind -eq 'PruneNode' })
Assert-Equal $nodeName $prune[0].Data.Keep 'old private Node versions pruned, the new one kept'
# e) -PrivateNode forces it; -Node and -PrivateNode conflict; mirrors must be https
$forced = Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin; PrivateNode = $true; NodeDistUrl = 'https://mirror.example/node/' }) -Probe (New-FakeProbe)
Assert-Equal "https://mirror.example/node/v$($pin.NODE_VERSION)" (@($forced.Actions | Where-Object { $_.Kind -eq 'InstallNode' })[0].Data.Base) '-PrivateNode with a mirror'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin; PrivateNode = $true; Node = 'C:\x\node.exe' }) -Probe (New-FakeProbe) } 'exclude each other' '-Node with -PrivateNode rejected'
Assert-Throws { Get-RemyralInstallPlan -Settings (New-Settings @{ NodePin = $pin; NodeDistUrl = 'http://mirror.example/' }) -Probe (New-FakeProbe) } 'must be https' 'plain http mirror rejected'
# f) the config written by the installer is minimal: master + paths (the rest comes from the dashboard)
$minimal = Get-RemyralInstallPlan -Settings (New-Settings @{ MaxParallelJobs = 0 }) -Probe (New-FakeProbe)
$mc = ($minimal.Actions | Where-Object { $_.Kind -eq 'WriteFile' -and $_.Data.Path -like '*config.json' }).Data.Content | ConvertFrom-Json
Assert-Equal 'masterUrl,sandbox,workspaceRoot' ((@($mc.PSObject.Properties | ForEach-Object { $_.Name }) | Sort-Object) -join ',') 'minimal config: masterUrl + paths + the dedicated account (p5-sandbox-ops)'

# --- 13. Installer kit checksums ---------------------------------------------------------------------
$kit = Join-Path ([IO.Path]::GetTempPath()) ('remyral-kit-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path (Join-Path $kit 'node') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $kit 'install.ps1'), 'x')
[IO.File]::WriteAllText((Join-Path $kit ('node' + [IO.Path]::DirectorySeparatorChar + 'pin.env')), 'y')
$hashOf = { param($p) if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { 'missing' } }
$hx = & $hashOf (Join-Path $kit 'install.ps1')
$hy = & $hashOf (Join-Path $kit ('node' + [IO.Path]::DirectorySeparatorChar + 'pin.env'))
[IO.File]::WriteAllText((Join-Path $kit 'SHA256SUMS'), "$hx  install.ps1`n$hy  node/pin.env`n")
Assert-Equal 0 @(Test-RemyralKitChecksums -Dir $kit -Hash $hashOf).Count 'kit checksums: intact kit passes'
[IO.File]::WriteAllText((Join-Path $kit 'install.ps1'), 'tampered')
Assert-Equal 1 @(Test-RemyralKitChecksums -Dir $kit -Hash $hashOf).Count 'kit checksums: a changed file is reported'
[IO.File]::WriteAllText((Join-Path $kit 'SHA256SUMS'), "$hx  ../outside.ps1`n")
Assert-True (@(Test-RemyralKitChecksums -Dir $kit -Hash $hashOf)[0] -like 'malformed line*') 'kit checksums: paths leaving the kit are refused'
Remove-Item -LiteralPath $kit -Recurse -Force

Write-Output "ALL PASSED ($script:passed assertions)"
