import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResourceLimits } from '../types.js';
import { WINDOWS_JOBRUN_PS1, WINDOWS_JOBRUN_SHA256 } from './windows-jobrun.generated.js';

/**
 * Windows job runner (p5-sandbox-ops, replaces the never-built `remyral-jobrun.exe`).
 *
 * `infra/worker/windows/remyral-jobrun.ps1` is a Windows PowerShell 5.1 script that creates a Job Object through
 * `Add-Type` C# (KILL_ON_JOB_CLOSE, job memory, active processes, CPU rate hard cap), starts the runtime
 * suspended, assigns it, resumes it, forwards exactly the three standard handles, propagates the exit code and
 * terminates leftovers. It needs nothing beyond stock Windows (no compiler install, no unsigned binary), and its
 * text is embedded in the signed worker bundle (`windows-jobrun.generated.ts`):
 *
 *  1. `sandbox.windowsJobHelper` (a `.ps1` the owner placed; root/admin-owned config) — used as is;
 *  2. `<install dir>\remyral-jobrun.ps1` (installed by install.ps1 / the privileged Prepare, admin-owned) when its
 *     digest equals the embedded one;
 *  3. `<dataDir>\sandbox\remyral-jobrun.ps1`, written by the worker from the embedded text and re-verified before
 *     every launch (a job runs as the same account and could otherwise swap it for the next job).
 *
 * Every candidate must pass the script's own `-SelfTest` (a limited job running `cmd /c exit 7`) before host
 * profiles are offered; Constrained Language Mode, a GPO-enforced execution policy or a missing .NET compiler all
 * fail it and are reported instead of failing jobs. Verified on Windows 11 / PowerShell 5.1 / tr-TR (2026-10-14).
 */

export const JOBRUN_FILE = 'remyral-jobrun.ps1';
/** Exit code of the runner itself (bad spec, start failure); everything else is the runtime's. */
export const JOBRUN_START_FAILURE = 120;
export { WINDOWS_JOBRUN_PS1, WINDOWS_JOBRUN_SHA256 };

export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Fixed host flags; the script path and the spec file are the only arguments. */
export function jobRunnerArgs(script: string, specFile: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-SpecFile',
    specFile,
  ];
}

/** SHA-256 of a script's text with CRLF normalised (a checkout or copy may convert line endings). */
export function jobRunnerDigest(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** One argument quoted for CreateProcess / CommandLineToArgvW (the MSVCRT rules Node uses too). */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

const CMD_EXE = /(?:^|[\\/])cmd(?:\.exe)?$/i;

/**
 * The CreateProcess command line of `argv`. cmd.exe does not use the MSVCRT rules: `\"` is not an escaped quote to
 * it, so `cmd.exe /d /s /c <line>` (a shell line, e.g. a service command) is passed the way Node does for
 * `shell: true` — `/s /c "<line>"`, verbatim: cmd strips the outer quotes and runs the line exactly as written
 * (p19-service-quotes: `node -e "require('http')…"` reached node cut at its first space).
 */
export function windowsCommandLine(argv: readonly string[]): string {
  if (argv.length === 0) throw new RangeError('empty command line');
  for (const a of argv) if (a.includes('\0')) throw new RangeError('NUL in a command-line argument');
  const [file = '', ...rest] = argv;
  if (CMD_EXE.test(file) && rest.length >= 3) {
    const switches = rest.slice(0, -1);
    const line = rest[rest.length - 1] ?? '';
    const last = switches[switches.length - 1]?.toLowerCase();
    if (
      (last === '/c' || last === '/k') &&
      switches.every((s) => /^\/[a-z]$/i.test(s)) &&
      switches.some((s) => s.toLowerCase() === '/s')
    ) {
      return [quoteWindowsArg(file), ...switches, `"${line}"`].join(' ');
    }
  }
  return argv.map(quoteWindowsArg).join(' ');
}

export interface JobRunnerSpec {
  readonly v: 1;
  readonly commandLine: string;
  readonly cwd: string;
  readonly memoryBytes: number;
  readonly maxProcesses: number;
  readonly cpuRatePercent: number;
  /**
   * p9-windows-host-isolation: run the child as this per-job account (`remyral-job-<n>`); the job runner logs it on
   * with the password from `credentialFile` (DPAPI LocalMachine, written by the privileged Prepare).
   */
  readonly runAs?: { readonly user: string; readonly credentialFile: string };
}

/** The spec the runner reads (limits from `sandbox.limits`; CPU as a share of this machine). */
export function jobRunnerSpec(
  argv: readonly string[],
  cwd: string,
  limits: ResourceLimits,
  cpus: number = availableParallelism(),
): JobRunnerSpec {
  return {
    v: 1,
    commandLine: windowsCommandLine(argv),
    cwd,
    memoryBytes: Math.max(0, Math.floor(limits.memoryBytes)),
    maxProcesses: Math.max(0, Math.floor(limits.pids)),
    cpuRatePercent: Math.max(1, Math.min(100, Math.round((limits.cpus / Math.max(1, cpus)) * 100))),
  };
}

export type JobRunnerSource = 'config' | 'install' | 'data';

export interface JobRunnerState {
  /** Path of the runner script (absent: none usable). */
  readonly script?: string;
  readonly source?: JobRunnerSource;
  /** Self-test passed. */
  readonly verified: boolean;
  /** Machine-readable problem (`job_runner_missing`, `job_runner_selftest_failed`, …). */
  readonly code?: string;
  readonly detail?: string;
}

export type RunFile = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runFile: RunFile = (file, args, timeoutMs, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(env === undefined ? {} : { env }),
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/** Writes the embedded runner to `<dataDir>/sandbox/remyral-jobrun.ps1` (atomic) unless it is already exact. */
export async function materializeJobRunner(dataDir: string): Promise<string> {
  const target = join(dataDir, 'sandbox', JOBRUN_FILE);
  const have = await readText(target);
  if (have !== null && jobRunnerDigest(have) === WINDOWS_JOBRUN_SHA256) return target;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${String(process.pid)}.tmp`;
  await writeFile(tmp, WINDOWS_JOBRUN_PS1, { mode: 0o600 });
  await rename(tmp, target);
  return target;
}

/** True when the file at `path` is the embedded runner. */
export async function isEmbeddedJobRunner(path: string): Promise<boolean> {
  const text = await readText(path);
  return text !== null && jobRunnerDigest(text) === WINDOWS_JOBRUN_SHA256;
}

/** `-SelfTest`: a limited job running `cmd /c exit 7` must report `remyral-jobrun ok`. */
export async function selfTestJobRunner(
  script: string,
  run: RunFile = runFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail: string }> {
  const r = await run(
    powershellExe(env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfTest'],
    60_000,
  );
  const ok = r.code === 0 && /^remyral-jobrun ok \d+\s*$/.test(r.stdout);
  const detail = (ok ? r.stdout : `exit ${String(r.code)}: ${r.stderr || r.stdout}`).trim().slice(0, 280);
  return { ok, detail };
}

/** Finds (and for the data copy, writes) the runner, then self-tests it. Never throws. */
export async function locateJobRunner(opts: {
  readonly configured?: string | undefined;
  readonly installDir?: string | undefined;
  readonly dataDir: string;
  readonly run?: RunFile;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<JobRunnerState> {
  let script: string | undefined;
  let source: JobRunnerSource | undefined;
  try {
    if (opts.configured !== undefined) {
      if (!opts.configured.toLowerCase().endsWith('.ps1')) {
        return {
          verified: false,
          code: 'job_runner_unsupported',
          detail: `sandbox.windowsJobHelper must name the remyral-jobrun.ps1 job runner (got ${opts.configured})`,
        };
      }
      if ((await readText(opts.configured)) === null) {
        return {
          verified: false,
          code: 'job_runner_missing',
          detail: `sandbox.windowsJobHelper ${opts.configured} is not readable`,
        };
      }
      script = opts.configured;
      source = 'config';
    } else if (
      opts.installDir !== undefined &&
      (await isEmbeddedJobRunner(join(opts.installDir, JOBRUN_FILE)))
    ) {
      script = join(opts.installDir, JOBRUN_FILE);
      source = 'install';
    } else {
      script = await materializeJobRunner(opts.dataDir);
      source = 'data';
    }
  } catch (err) {
    return {
      verified: false,
      code: 'job_runner_missing',
      detail: `cannot write the job runner: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        280,
      ),
    };
  }
  const test = await selfTestJobRunner(script, opts.run, opts.env);
  return test.ok
    ? { script, source, verified: true, detail: `${source}: ${test.detail}` }
    : { script, source, verified: false, code: 'job_runner_selftest_failed', detail: test.detail };
}

/** Re-checks a worker-managed copy right before a launch (the job account could have replaced it). */
export async function assertJobRunnerIntact(state: JobRunnerState, dataDir: string): Promise<string> {
  if (state.script === undefined || !state.verified) throw new Error('no verified job runner');
  if (state.source === 'config') return state.script;
  if (await isEmbeddedJobRunner(state.script)) return state.script;
  if (state.source === 'data') return materializeJobRunner(dataDir);
  throw new Error(`${state.script} no longer matches the job runner of this worker release`);
}

// ------------------------------------------------------------------------------------------- ACLs

const SID = /^S-1-5(-\d{1,10}){1,14}$/;

/**
 * icacls arguments restricting a directory tree to SYSTEM, Administrators and the worker's own account
 * (protected DACL; children re-inherit). The worker owns the per-attempt dirs it creates, so it may do this.
 */
export function attemptAclArgs(dir: string, workerSid: string): string[] {
  if (!SID.test(workerSid)) throw new RangeError(`not a SID: ${workerSid}`);
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    `*${workerSid}:(OI)(CI)M`,
    '/Q',
  ];
}

export async function restrictAttemptAcl(
  dirs: readonly string[],
  workerSid: string,
  run: RunFile = runFile,
): Promise<void> {
  for (const dir of dirs) {
    const r = await run('icacls.exe', attemptAclArgs(dir, workerSid), 120_000);
    if (r.code !== 0) {
      throw new Error(
        `icacls ${dir} failed (${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      );
    }
  }
}
