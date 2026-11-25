#Requires -Version 5.1
<#
.SYNOPSIS
  Creates or rotates the per-job Windows accounts of the Remyral worker (p9-windows-host-isolation).

.DESCRIPTION
  Host-restricted jobs on Windows run one at a time unless every concurrent attempt has its own account
  (T-SBX-4). This script, run as SYSTEM by the privileged helper's "Prepare" step (or by an administrator
  by hand), maintains a small pool of local accounts remyral-job-1..N:

    - local group remyral-job-slots; every slot account is a member (plus BUILTIN\Users, by SID);
    - a new random 36-character password for every account on every run (rotation); the password is
      stored only as a DPAPI LocalMachine blob in <StateDir>\remyral-job-<n>.cred, whose folder is
      readable by SYSTEM, Administrators and the worker service account only - never by a slot account;
    - group rights: "Log on as a batch job" (the job runner's LogonUser type); denied: interactive,
      remote desktop, network and service logon. The accounts are hidden from the sign-in screen;
    - worker service SID: SeAssignPrimaryTokenPrivilege and SeIncreaseQuotaPrivilege (CreateProcessAsUser
      in remyral-jobrun.ps1). Newly granted privileges reach the service only after it restarts;
    - the slot group may read (RX) the given directories (worker-managed runtimes and tools);
    - accounts above -Count (up to 16) are disabled, never left usable.
  Finally <StateDir>\slots.json lists the accounts with their SIDs and a new generation id; the worker
  re-runs its cross-access self-test for every new generation before it runs host jobs in parallel.

  -Remove deletes the accounts, the group, their rights and the state directory (uninstall).

  Output: the last stdout line is "remyral-job-slots <json>" with ok, generation, count and
  privilegesAdded (true = the worker service must restart before per-job accounts can be used).

  ASCII only, case-sensitive operators only (Windows PowerShell 5.1 on tr-TR; scripts/test/powershell-ascii.test.mjs).
  Design: docs/design/p9-windows-host-isolation.md. Ops: docs/ops/worker-sandbox.md.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [int]$Count = 4,
  [string]$StateDir,
  [string]$WorkerSid,
  # Directories the slot group may read, separated by '|' (never part of a Windows path; -File cannot pass arrays).
  [string]$ReadDirs = '',
  [switch]$Remove
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$MaxSlots = 16
$GroupName = 'remyral-job-slots'
$UserPrefix = 'remyral-job-'
$Entropy = [Text.Encoding]::ASCII.GetBytes('remana-job-slot-v1')
$SidSystem = 'S-1-5-18'
$SidAdmins = 'S-1-5-32-544'
$SidUsers = 'S-1-5-32-545'
$GroupRights = @('SeBatchLogonRight', 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight',
  'SeDenyNetworkLogonRight', 'SeDenyServiceLogonRight')
$WorkerRights = @('SeAssignPrimaryTokenPrivilege', 'SeIncreaseQuotaPrivilege')
$UserListKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class RemyralLsa
{
    [StructLayout(LayoutKind.Sequential)]
    struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

    [StructLayout(LayoutKind.Sequential)]
    struct LsaAttributes
    {
        public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
        public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
    }

    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LsaAttributes attrs, uint access, out IntPtr handle);
    [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, bool all, LsaString[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
    [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr p);
    [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);

    const uint POLICY_ALL_ACCESS = 0x000F0FFF;
    const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;

    static byte[] Sid(string sid)
    {
        SecurityIdentifier s = new SecurityIdentifier(sid);
        byte[] b = new byte[s.BinaryLength];
        s.GetBinaryForm(b, 0);
        return b;
    }

    static IntPtr Open()
    {
        LsaAttributes a = new LsaAttributes();
        a.Length = Marshal.SizeOf(typeof(LsaAttributes));
        IntPtr h;
        uint st = LsaOpenPolicy(IntPtr.Zero, ref a, POLICY_ALL_ACCESS, out h);
        if (st != 0) throw new InvalidOperationException("LsaOpenPolicy failed (Win32 error " + LsaNtStatusToWinError(st) + ")");
        return h;
    }

    public static string[] Rights(string sid)
    {
        IntPtr h = Open();
        try
        {
            IntPtr p; uint n;
            uint st = LsaEnumerateAccountRights(h, Sid(sid), out p, out n);
            if (st == STATUS_OBJECT_NAME_NOT_FOUND) return new string[0];
            if (st != 0) throw new InvalidOperationException("LsaEnumerateAccountRights failed (Win32 error " + LsaNtStatusToWinError(st) + ")");
            List<string> list = new List<string>();
            int size = Marshal.SizeOf(typeof(LsaString));
            for (int i = 0; i < n; i++)
            {
                LsaString s = (LsaString)Marshal.PtrToStructure(new IntPtr(p.ToInt64() + i * size), typeof(LsaString));
                list.Add(Marshal.PtrToStringUni(s.Buffer, s.Length / 2));
            }
            LsaFreeMemory(p);
            return list.ToArray();
        }
        finally { LsaClose(h); }
    }

    static void Change(string sid, string right, bool add)
    {
        IntPtr h = Open();
        LsaString[] r = new LsaString[1];
        r[0].Buffer = Marshal.StringToHGlobalUni(right);
        r[0].Length = (ushort)(right.Length * 2);
        r[0].MaximumLength = (ushort)(right.Length * 2 + 2);
        try
        {
            uint st = add ? LsaAddAccountRights(h, Sid(sid), r, 1) : LsaRemoveAccountRights(h, Sid(sid), false, r, 1);
            if (st != 0 && !(st == STATUS_OBJECT_NAME_NOT_FOUND && !add))
                throw new InvalidOperationException((add ? "LsaAddAccountRights(" : "LsaRemoveAccountRights(") + right + ") failed (Win32 error " + LsaNtStatusToWinError(st) + ")");
        }
        finally { Marshal.FreeHGlobal(r[0].Buffer); LsaClose(h); }
    }

    public static void Add(string sid, string right) { Change(sid, right, true); }
    public static void Remove(string sid, string right) { Change(sid, right, false); }
}
'@

function Write-SlotResult([hashtable]$Result) {
  [Console]::Out.WriteLine('remyral-job-slots ' + ($Result | ConvertTo-Json -Compress))
}

function Fail-Slots([string]$Code, [string]$Detail) {
  [Console]::Error.WriteLine("remyral-job-slots: $Detail")
  Write-SlotResult @{ ok = $false; code = $Code; detail = $Detail }
  exit 1
}

function Test-SidString([string]$Sid) {
  return ($Sid -cmatch '^S-1-5(-[0-9]{1,10}){1,14}$')
}

function Invoke-Icacls([string[]]$IcaclsArgs) {
  # A native command's stderr must not turn into a terminating error (Windows PowerShell 5.1 with Stop).
  $ErrorActionPreference = 'Continue'
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  $out = & $icacls @IcaclsArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls $($IcaclsArgs[0]) failed ($LASTEXITCODE): $out" }
}

function New-SlotPassword {
  $bytes = New-Object byte[] 27
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  # 36 base64 characters plus one of each character class (complexity policy).
  return ([Convert]::ToBase64String($bytes) + 'aZ7-')
}

function Get-SlotUser([string]$Name) {
  return (Get-LocalUser -Name $Name -ErrorAction SilentlyContinue)
}

function Add-ToGroupBySid([string]$GroupSid, [string]$Member) {
  try {
    Add-LocalGroupMember -SID $GroupSid -Member $Member -ErrorAction Stop
  } catch {
    if ($_.Exception.GetType().Name -cne 'MemberExistsException') { throw }
  }
}

try {
  Add-Type -TypeDefinition $source -Language CSharp | Out-Null
  Add-Type -AssemblyName System.Security
} catch {
  Fail-Slots 'compile_failed' "cannot compile the LSA helper (Add-Type): $($_.Exception.Message)"
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ($me.User.Value -ceq $SidSystem) -or (@($me.Groups | ForEach-Object { $_.Value }) -ccontains $SidAdmins)
if (-not $isAdmin) { Fail-Slots 'not_admin' 'must run as SYSTEM or an administrator' }
if (-not $StateDir) { Fail-Slots 'bad_arguments' '-StateDir is required' }
if (-not (Test-SidString $WorkerSid)) { Fail-Slots 'bad_arguments' "-WorkerSid is not a SID: $WorkerSid" }

if ($Remove) {
  try {
    $group = Get-LocalGroup -Name $GroupName -ErrorAction SilentlyContinue
    for ($i = 1; $i -le $MaxSlots; $i++) {
      $name = "$UserPrefix$i"
      $u = Get-SlotUser $name
      if ($null -ne $u) { Remove-LocalUser -SID $u.SID }
      if (Test-Path -LiteralPath $UserListKey) {
        Remove-ItemProperty -LiteralPath $UserListKey -Name $name -ErrorAction SilentlyContinue
      }
    }
    if ($null -ne $group) {
      foreach ($r in $GroupRights) { [RemyralLsa]::Remove($group.SID.Value, $r) }
      Remove-LocalGroup -SID $group.SID
    }
    foreach ($r in $WorkerRights) { [RemyralLsa]::Remove($WorkerSid, $r) }
    if (Test-Path -LiteralPath $StateDir) { Remove-Item -LiteralPath $StateDir -Recurse -Force }
    Write-SlotResult @{ ok = $true; removed = $true }
    exit 0
  } catch {
    Fail-Slots 'remove_failed' $_.Exception.Message
  }
}

if ($Count -lt 1 -or $Count -gt $MaxSlots) { Fail-Slots 'bad_arguments' "-Count must be 1..$MaxSlots" }

try {
  # Group.
  $group = Get-LocalGroup -Name $GroupName -ErrorAction SilentlyContinue
  if ($null -eq $group) {
    $group = New-LocalGroup -Name $GroupName -Description 'Remyral per-job accounts (managed by the worker)'
  }
  $groupSid = $group.SID.Value
  foreach ($r in $GroupRights) { [RemyralLsa]::Add($groupSid, $r) }

  # Worker service privileges for CreateProcessAsUser.
  $had = [RemyralLsa]::Rights($WorkerSid)
  $privilegesAdded = $false
  foreach ($r in $WorkerRights) {
    if (-not ($had -ccontains $r)) { $privilegesAdded = $true }
    [RemyralLsa]::Add($WorkerSid, $r)
  }

  # State dir: SYSTEM, Administrators, the worker service (read). Never a slot account.
  if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
  Invoke-Icacls @($StateDir, '/inheritance:r', '/grant:r', "*${SidSystem}:(OI)(CI)F", "*${SidAdmins}:(OI)(CI)F",
    "*${WorkerSid}:(OI)(CI)RX", '/Q')

  if (-not (Test-Path -LiteralPath $UserListKey)) { New-Item -Path $UserListKey -Force | Out-Null }

  $slots = @()
  for ($i = 1; $i -le $MaxSlots; $i++) {
    $name = "$UserPrefix$i"
    $u = Get-SlotUser $name
    if ($i -gt $Count) {
      if ($null -ne $u -and $u.Enabled) { Disable-LocalUser -SID $u.SID }
      $stale = Join-Path $StateDir "$name.cred"
      if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
      continue
    }
    $plain = New-SlotPassword
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    if ($null -eq $u) {
      $u = New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -UserMayNotChangePassword `
        -AccountNeverExpires -Description 'Remyral per-job account (no interactive logon)'
    } else {
      Set-LocalUser -SID $u.SID -Password $secure -PasswordNeverExpires $true -UserMayChangePassword $false `
        -AccountNeverExpires
      if (-not $u.Enabled) { Enable-LocalUser -SID $u.SID }
    }
    Add-ToGroupBySid $groupSid $name
    Add-ToGroupBySid $SidUsers $name
    New-ItemProperty -LiteralPath $UserListKey -Name $name -Value 0 -PropertyType DWord -Force | Out-Null

    $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::Unicode.GetBytes($plain), $Entropy,
      [Security.Cryptography.DataProtectionScope]::LocalMachine)
    $plain = $null
    $secure = $null
    $cred = Join-Path $StateDir "$name.cred"
    [IO.File]::WriteAllBytes("$cred.tmp", $blob)
    Move-Item -LiteralPath "$cred.tmp" -Destination $cred -Force
    $slots += [ordered]@{ index = $i; user = $name; sid = $u.SID.Value }
  }

  foreach ($d in $ReadDirs.Split('|')) {
    if ($d -and (Test-Path -LiteralPath $d -PathType Container)) {
      Invoke-Icacls @($d, '/grant', "*${groupSid}:(OI)(CI)RX", '/Q')
    }
  }

  $generation = [guid]::NewGuid().ToString()
  $state = [ordered]@{
    v = 1
    generation = $generation
    provisionedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    group = [ordered]@{ name = $GroupName; sid = $groupSid }
    workerSid = $WorkerSid
    slots = $slots
  }
  $json = $state | ConvertTo-Json -Depth 5 -Compress
  $file = Join-Path $StateDir 'slots.json'
  [IO.File]::WriteAllText("$file.tmp", $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath "$file.tmp" -Destination $file -Force
  Write-SlotResult @{ ok = $true; generation = $generation; count = $Count; privilegesAdded = $privilegesAdded }
  exit 0
} catch {
  Fail-Slots 'provision_failed' $_.Exception.Message
}
