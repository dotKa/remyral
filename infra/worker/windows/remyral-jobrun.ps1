#Requires -Version 5.1
<#
.SYNOPSIS
  Remyral job runner for Windows host profiles (p5-sandbox-ops, ADR-0007 / ADR-0019).

.DESCRIPTION
  Starts one runtime process inside a Windows Job Object and waits for it. Needs nothing beyond stock
  Windows: the Job Object API is called through Add-Type C# (compiled in memory by the .NET Framework
  that ships with Windows PowerShell 5.1); there is no native binary to build, sign or install.

  The job object gets:
    - KILL_ON_JOB_CLOSE: when this script ends - normally, killed by the worker (taskkill /F) or by a
      crash - Windows kills every process in the job, also ones whose parent already exited;
    - JOB_MEMORY: committed memory of all processes together (sandbox.limits.memoryBytes);
    - ACTIVE_PROCESS: number of processes alive at once (sandbox.limits.pids);
    - CPU rate hard cap (sandbox.limits.cpus as a share of the machine);
    - DIE_ON_UNHANDLED_EXCEPTION: no error dialog keeps a crashed process alive.
  The child is created suspended, assigned to the job, then resumed, so it never runs outside the job.
  It inherits exactly the three standard handles of this script (the worker's pipes) - nothing else -
  so the runtime's output goes straight to the worker without passing through PowerShell. The child's
  exit code becomes this script's exit code; when it exits, whatever it left behind in the job is
  terminated.

  The worker writes a spec file (JSON) and starts:
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File remyral-jobrun.ps1 -SpecFile <file>
  Spec: { "v": 1, "commandLine": "<quoted command line>", "cwd": "<dir>", "memoryBytes": <n>,
          "maxProcesses": <n>, "cpuRatePercent": <1..100>,
          "runAs": { "user": "remyral-job-<n>", "credentialFile": "<file>" } }   (runAs optional)
  The spec file is deleted as soon as it has been read.

  runAs (p9-windows-host-isolation): the child runs as one of the per-job local accounts the privileged
  Prepare created (remyral-job-1..N), not as the worker account. The account's random password is read from
  its credential file (DPAPI LocalMachine, readable only by SYSTEM, Administrators and the worker service)
  and used once for LogonUser(LOGON32_LOGON_BATCH); the child is created with CreateProcessAsUser (the worker
  service holds SeAssignPrimaryTokenPrivilege and SeIncreaseQuotaPrivilege, granted by the same Prepare step)
  on its own non-interactive window station (lpDesktop ""), suspended, assigned to the job, resumed. The job
  object stays with this script (the worker account): kill-on-close still ends every process of the job.

  Without runAs (p22-worker-limits, backlog p9-windows-worker-token-privileges): the child still runs as the
  worker account, but never with the service token's privileges. The script opens its own primary token,
  derives a restricted copy with CreateRestrictedToken(DISABLE_MAX_PRIVILEGE) - every privilege deleted except
  SeChangeNotifyPrivilege (SeImpersonate, SeAssignPrimaryToken, SeIncreaseQuota ... are gone, not merely
  disabled, so the child cannot re-enable them) - and starts the child with CreateProcessAsUser on that token
  (a restricted version of the caller's own primary token needs no SeAssignPrimaryTokenPrivilege). Same account,
  same window station, same groups and integrity level. The self-test checks that the restricted token holds no
  privilege besides SeChangeNotifyPrivilege and fails otherwise (the host profile is then not ready).

  -SelfTest runs cmd.exe /c exit 7 inside a limited job and prints "remyral-jobrun ok <version>" when
  everything works (used by the worker's readiness check and by the sandbox "Prepare" operation).

  Exit codes: the child's, or 120 (bad spec / start failure; the reason is on stderr).

  ASCII only, case-sensitive operators only (Windows PowerShell 5.1 on tr-TR; scripts/test/powershell-ascii.test.mjs).
  Design: docs/design/p5-sandbox-ops.md. Ops: docs/ops/worker-sandbox.md.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$SpecFile,
  [switch]$SelfTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RemyralJobRunVersion = '3'
$StartFailureExit = 120

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class RemyralJobRun
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CpuRate
    {
        public uint ControlFlags;
        public uint Rate;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CompletionPort
    {
        public IntPtr CompletionKey;
        public IntPtr Port;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, IntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key, out IntPtr overlapped, uint millis);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint millis);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUserW(IntPtr token, string app, System.Text.StringBuilder commandLine, IntPtr procAttr,
        IntPtr threadAttr, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup,
        out ProcessInformation info);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LogonUserW(string user, string domain, IntPtr password, int logonType, int provider, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableSidCount, IntPtr sidsToDisable,
        uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictedSidCount, IntPtr sidsToRestrict,
        out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returnLength);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint length,
        IntPtr previous, IntPtr returnLength);

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct TokenPrivilege
    {
        public uint Count;
        public long Luid;
        public uint Attributes;
    }

    const uint LIMIT_ACTIVE_PROCESS = 0x8;
    const uint LIMIT_JOB_MEMORY = 0x200;
    const uint LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
    const uint LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int CLASS_ASSOCIATE_COMPLETION_PORT = 7;
    const int CLASS_EXTENDED_LIMIT = 9;
    const int CLASS_CPU_RATE = 15;
    const uint CPU_RATE_ENABLE = 0x1;
    const uint CPU_RATE_HARD_CAP = 0x4;
    const uint MSG_ACTIVE_PROCESS_LIMIT = 3;
    const uint MSG_JOB_MEMORY_LIMIT = 10;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint HANDLE_FLAG_INHERIT = 0x1;
    const uint WAIT_OBJECT_0 = 0;
    const int LOGON32_LOGON_BATCH = 4;
    const int LOGON32_PROVIDER_DEFAULT = 0;
    const uint TOKEN_ADJUST_PRIVILEGES = 0x20;
    const uint TOKEN_QUERY = 0x8;
    const uint TOKEN_ASSIGN_PRIMARY = 0x1;
    const uint TOKEN_DUPLICATE = 0x2;
    const uint TOKEN_ADJUST_DEFAULT = 0x80;
    const uint DISABLE_MAX_PRIVILEGE = 0x1;
    const int TOKEN_INFORMATION_PRIVILEGES = 3;
    const uint SE_PRIVILEGE_ENABLED = 0x2;
    const int ERROR_NOT_ALL_ASSIGNED = 1300;
    static readonly IntPtr ATTRIBUTE_HANDLE_LIST = (IntPtr)0x20002;

    /** A note for the worker's log (stderr of the job, at most once per kind). */
    static void Note(string text)
    {
        try { Console.Error.WriteLine("remyral-jobrun: " + text); Console.Error.Flush(); } catch (Exception) { }
    }

    static Exception Fail(string what)
    {
        return new InvalidOperationException(what + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
    }

    static void SetInfo<T>(IntPtr job, int infoClass, T value)
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(value, p, false);
            if (!SetInformationJobObject(job, infoClass, p, (uint)size)) throw Fail("SetInformationJobObject(" + infoClass + ")");
        }
        finally { Marshal.FreeHGlobal(p); }
    }

    /** Creates the limited job and its completion port (limit notifications). */
    public static IntPtr[] CreateLimitedJob(long memoryBytes, int maxProcesses, int cpuRatePercent)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Fail("CreateJobObject");
        ExtendedLimit ext = new ExtendedLimit();
        ext.Basic.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if (memoryBytes > 0)
        {
            ext.Basic.LimitFlags |= LIMIT_JOB_MEMORY;
            ext.JobMemoryLimit = new UIntPtr((ulong)memoryBytes);
        }
        if (maxProcesses > 0)
        {
            ext.Basic.LimitFlags |= LIMIT_ACTIVE_PROCESS;
            ext.Basic.ActiveProcessLimit = (uint)maxProcesses;
        }
        SetInfo(job, CLASS_EXTENDED_LIMIT, ext);
        if (cpuRatePercent > 0 && cpuRatePercent < 100)
        {
            CpuRate rate = new CpuRate();
            rate.ControlFlags = CPU_RATE_ENABLE | CPU_RATE_HARD_CAP;
            rate.Rate = (uint)(cpuRatePercent * 100);
            SetInfo(job, CLASS_CPU_RATE, rate);
        }
        IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
        if (port == IntPtr.Zero) throw Fail("CreateIoCompletionPort");
        CompletionPort assoc = new CompletionPort();
        assoc.CompletionKey = job;
        assoc.Port = port;
        SetInfo(job, CLASS_ASSOCIATE_COMPLETION_PORT, assoc);
        return new IntPtr[] { job, port };
    }

    /** Enables a privilege the worker service holds (CreateProcessAsUser needs both of runAs). */
    static void EnablePrivilege(string name)
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token)) throw Fail("OpenProcessToken");
        try
        {
            long luid;
            if (!LookupPrivilegeValueW(null, name, out luid)) throw Fail("LookupPrivilegeValue(" + name + ")");
            TokenPrivilege tp = new TokenPrivilege();
            tp.Count = 1;
            tp.Luid = luid;
            tp.Attributes = SE_PRIVILEGE_ENABLED;
            if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) throw Fail("AdjustTokenPrivileges(" + name + ")");
            if (Marshal.GetLastWin32Error() == ERROR_NOT_ALL_ASSIGNED)
                throw new InvalidOperationException("the worker account does not hold " + name +
                    " (run Sandbox > Prepare with the privileged helper, then let the worker restart)");
        }
        finally { CloseHandle(token); }
    }

    /** LogonUser(BATCH) of a per-job account; the UTF-16 password buffer is wiped before returning. */
    static IntPtr LogonJobUser(string user, byte[] passwordUtf16)
    {
        int n = passwordUtf16.Length;
        IntPtr pw = Marshal.AllocHGlobal(n + 2);
        try
        {
            Marshal.Copy(passwordUtf16, 0, pw, n);
            Marshal.WriteInt16(pw, n, 0);
            IntPtr token;
            if (!LogonUserW(user, ".", pw, LOGON32_LOGON_BATCH, LOGON32_PROVIDER_DEFAULT, out token)) throw Fail("LogonUser(" + user + ")");
            return token;
        }
        finally
        {
            for (int i = 0; i < n + 2; i++) Marshal.WriteByte(pw, i, 0);
            Marshal.FreeHGlobal(pw);
            Array.Clear(passwordUtf16, 0, n);
        }
    }

    /** Run as a per-job account (p9-windows-host-isolation); the job object stays with this process. */
    public static int RunAs(string commandLine, string cwd, long memoryBytes, int maxProcesses, int cpuRatePercent,
        string user, byte[] passwordUtf16)
    {
        EnablePrivilege("SeAssignPrimaryTokenPrivilege");
        EnablePrivilege("SeIncreaseQuotaPrivilege");
        IntPtr token = LogonJobUser(user, passwordUtf16);
        try { return RunWith(token, true, commandLine, cwd, memoryBytes, maxProcesses, cpuRatePercent); }
        finally { CloseHandle(token); }
    }

    /**
     * The worker account's own primary token without its privileges (p9-windows-worker-token-privileges):
     * CreateRestrictedToken(DISABLE_MAX_PRIVILEGE) deletes every privilege except SeChangeNotifyPrivilege.
     */
    static IntPtr StrippedOwnToken()
    {
        IntPtr own;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out own))
            throw Fail("OpenProcessToken");
        try
        {
            IntPtr restricted;
            if (!CreateRestrictedToken(own, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted))
                throw Fail("CreateRestrictedToken");
            return restricted;
        }
        finally { CloseHandle(own); }
    }

    /** LUIDs of the privileges a token still holds (GetTokenInformation(TokenPrivileges)). */
    static List<long> TokenPrivilegeLuids(IntPtr token)
    {
        uint needed;
        GetTokenInformation(token, TOKEN_INFORMATION_PRIVILEGES, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw Fail("GetTokenInformation(size)");
        IntPtr buf = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!GetTokenInformation(token, TOKEN_INFORMATION_PRIVILEGES, buf, needed, out needed)) throw Fail("GetTokenInformation");
            // TOKEN_PRIVILEGES: DWORD PrivilegeCount, then LUID_AND_ATTRIBUTES[] (LUID 8 bytes + DWORD, 4-byte packed).
            int count = Marshal.ReadInt32(buf, 0);
            List<long> luids = new List<long>();
            for (int i = 0; i < count; i++) luids.Add(Marshal.ReadInt64(buf, 4 + i * 12));
            return luids;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    /** Self-test: the privileges the stripped token still holds besides SeChangeNotifyPrivilege (expected: none). */
    public static int ExtraPrivilegesOfStrippedToken()
    {
        IntPtr token = StrippedOwnToken();
        try
        {
            long changeNotify;
            if (!LookupPrivilegeValueW(null, "SeChangeNotifyPrivilege", out changeNotify)) throw Fail("LookupPrivilegeValue(SeChangeNotifyPrivilege)");
            int extra = 0;
            foreach (long luid in TokenPrivilegeLuids(token)) if (luid != changeNotify) extra++;
            return extra;
        }
        finally { CloseHandle(token); }
    }

    /** Run as the worker account, with the privilege-stripped token (never the service token itself). */
    public static int Run(string commandLine, string cwd, long memoryBytes, int maxProcesses, int cpuRatePercent)
    {
        IntPtr token = StrippedOwnToken();
        try { return RunWith(token, false, commandLine, cwd, memoryBytes, maxProcesses, cpuRatePercent); }
        finally { CloseHandle(token); }
    }

    /**
     * Starts commandLine suspended with userToken (a per-job account's logon token, or the worker's own stripped
     * token), assigns it to the job, resumes it and waits. Returns its exit code; whatever is left in the job
     * afterwards is terminated.
     */
    static int RunWith(IntPtr userToken, bool otherAccount, string commandLine, string cwd, long memoryBytes, int maxProcesses, int cpuRatePercent)
    {
        IntPtr[] jp = CreateLimitedJob(memoryBytes, maxProcesses, cpuRatePercent);
        IntPtr job = jp[0], port = jp[1];

        // Inherit exactly the standard handles (deduplicated; stdout and stderr may be the same pipe).
        List<IntPtr> handles = new List<IntPtr>();
        IntPtr[] std = new IntPtr[3];
        for (int i = 0; i < 3; i++)
        {
            IntPtr h = GetStdHandle(-10 - i);
            std[i] = h;
            if (h == IntPtr.Zero || h == new IntPtr(-1)) continue;
            if (!SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) continue;
            if (!handles.Contains(h)) handles.Add(h);
        }

        StartupInfoEx si = new StartupInfoEx();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = std[0];
        si.StartupInfo.hStdOutput = std[1];
        si.StartupInfo.hStdError = std[2];
        // Another account cannot use the service's window station: let Windows pick the one of the new logon session.
        if (otherAccount) si.StartupInfo.lpDesktop = "";

        IntPtr attrList = IntPtr.Zero, handleArray = IntPtr.Zero;
        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        if (handles.Count > 0)
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attrList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size)) throw Fail("InitializeProcThreadAttributeList");
            handleArray = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
            for (int i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(handleArray, i * IntPtr.Size, handles[i]);
            if (!UpdateProcThreadAttribute(attrList, 0, ATTRIBUTE_HANDLE_LIST, handleArray, (IntPtr)(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero))
                throw Fail("UpdateProcThreadAttribute");
            si.lpAttributeList = attrList;
            flags |= EXTENDED_STARTUPINFO_PRESENT;
        }

        ProcessInformation pi;
        try
        {
            System.Text.StringBuilder cl = new System.Text.StringBuilder(commandLine, commandLine.Length + 1);
            if (!CreateProcessAsUserW(userToken, null, cl, IntPtr.Zero, IntPtr.Zero, handles.Count > 0, flags, IntPtr.Zero, cwd, ref si, out pi))
                throw Fail("CreateProcessAsUser");
        }
        finally
        {
            if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }
            if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
        }

        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            // Never let it run outside the job.
            TerminateProcess(pi.hProcess, 1);
            throw Fail("AssignProcessToJobObject");
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);

        bool memoryNoted = false, processesNoted = false;
        while (WaitForSingleObject(pi.hProcess, 0) != WAIT_OBJECT_0)
        {
            uint msg; IntPtr key, overlapped;
            if (GetQueuedCompletionStatus(port, out msg, out key, out overlapped, 200))
            {
                if (msg == MSG_JOB_MEMORY_LIMIT && !memoryNoted)
                {
                    memoryNoted = true;
                    Note("job memory limit reached (" + memoryBytes + " bytes)");
                }
                else if (msg == MSG_ACTIVE_PROCESS_LIMIT && !processesNoted)
                {
                    processesNoted = true;
                    Note("job process limit reached (" + maxProcesses + " processes)");
                }
            }
        }
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
        CloseHandle(pi.hProcess);
        // Leftovers of the runtime (the POSIX runner kills the process group the same way).
        TerminateJobObject(job, 1);
        CloseHandle(port);
        CloseHandle(job);
        return unchecked((int)code);
    }
}
'@

function Write-RemyralNote([string]$Text) {
  [Console]::Error.WriteLine("remyral-jobrun: $Text")
}

try {
  Add-Type -TypeDefinition $source -Language CSharp | Out-Null
} catch {
  Write-RemyralNote "cannot compile the job object helper (Add-Type): $($_.Exception.Message)"
  exit $StartFailureExit
}

if ($SelfTest) {
  try {
    $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $code = [RemyralJobRun]::Run(('"' + $cmd + '" /d /c exit 7'), [Environment]::CurrentDirectory, 268435456, 8, 50)
    if ($code -ne 7) { Write-RemyralNote "self-test: expected exit code 7, got $code"; exit 1 }
    $extra = [RemyralJobRun]::ExtraPrivilegesOfStrippedToken()
    if ($extra -ne 0) { Write-RemyralNote "self-test: the stripped token still holds $extra privilege(s) besides SeChangeNotifyPrivilege"; exit 1 }
    [Console]::Out.WriteLine("remyral-jobrun ok $RemyralJobRunVersion")
    exit 0
  } catch {
    Write-RemyralNote "self-test failed: $($_.Exception.Message)"
    exit 1
  }
}

if (-not $SpecFile) { Write-RemyralNote 'usage: remyral-jobrun.ps1 -SpecFile <file> | -SelfTest'; exit $StartFailureExit }
try {
  $text = [IO.File]::ReadAllText($SpecFile)
  Remove-Item -LiteralPath $SpecFile -Force -ErrorAction SilentlyContinue
  $spec = $text | ConvertFrom-Json
  if ($spec.v -ne 1) { throw "unsupported spec version $($spec.v)" }
  $commandLine = [string]$spec.commandLine
  if ($commandLine.Length -lt 1 -or $commandLine.Length -gt 32000) { throw 'commandLine must be 1..32000 characters' }
  $cwd = [string]$spec.cwd
  if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { throw "cwd does not exist: $cwd" }
  $memory = [long]$spec.memoryBytes
  $processes = [int]$spec.maxProcesses
  $cpu = [int]$spec.cpuRatePercent
  if ($memory -lt 0 -or $processes -lt 0 -or $cpu -lt 0 -or $cpu -gt 100) { throw 'limits out of range' }
  $runAsUser = $null
  $runAsPassword = $null
  if (($spec.PSObject.Properties.Name -ccontains 'runAs') -and ($null -ne $spec.runAs)) {
    $runAsUser = [string]$spec.runAs.user
    # Only the accounts the privileged Prepare creates; never an arbitrary account from a spec.
    if ($runAsUser -cnotmatch '^remyral-job-[1-9][0-9]?$') { throw "runAs.user is not a per-job account: $runAsUser" }
    $credFile = [string]$spec.runAs.credentialFile
    Add-Type -AssemblyName System.Security
    $entropy = [Text.Encoding]::ASCII.GetBytes('remana-job-slot-v1')
    $runAsPassword = [Security.Cryptography.ProtectedData]::Unprotect(
      [IO.File]::ReadAllBytes($credFile), $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  }
} catch {
  Write-RemyralNote "bad spec: $($_.Exception.Message)"
  exit $StartFailureExit
}

# PowerShell adds its own module path to its environment; the runtime gets the worker's environment only.
[Environment]::SetEnvironmentVariable('PSModulePath', $null)

try {
  if ($null -ne $runAsUser) {
    $code = [RemyralJobRun]::RunAs($commandLine, $cwd, $memory, $processes, $cpu, $runAsUser, $runAsPassword)
  } else {
    $code = [RemyralJobRun]::Run($commandLine, $cwd, $memory, $processes, $cpu)
  }
} catch {
  Write-RemyralNote "start failed: $($_.Exception.Message)"
  exit $StartFailureExit
}
exit $code
