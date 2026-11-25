import { execFile } from 'node:child_process';
import type { ProcessTreeKiller } from '@remyral/agent-adapters';
import { SandboxRequestError } from '../errors.js';
import type { ResourceLimits } from '../types.js';

/**
 * Host-native resource limits (T-SBX-5).
 *
 * POSIX: rlimits applied by a tiny `/bin/sh` prelude that `exec`s the runtime, so
 * the limits are inherited by the whole tree:
 *   - `ulimit -n` open files, `ulimit -f` file size, `ulimit -c 0` no core dumps;
 *   - `ulimit -u` (dash: `-p`) processes — RLIMIT_NPROC counts *all* processes of the worker
 *     user, which is the dedicated user, so it bounds the job plus the worker.
 *   Memory and CPU are NOT enforceable with rlimits for Node-based runtimes
 *   (RLIMIT_AS breaks V8's reservations; macOS ignores it). Residual risk; Linux
 *   hosts should use the container profile (cgroups).
 *   `ulimit -f` units: 1024-byte blocks with macOS /bin/sh (bash 3.2; verified),
 *   512-byte blocks with Linux dash (UNVERIFIED on the Pi).
 *
 * Windows (p5-sandbox-ops): a Job Object created by the `remyral-jobrun.ps1` job runner (windows-jobrun.ts):
 * KILL_ON_JOB_CLOSE, ACTIVE_PROCESS, JOB_MEMORY and a CPU rate hard cap; the runtime is started suspended,
 * assigned, resumed and waited for. Killing the runner closes the job handle, which kills every process in the
 * job (including ones whose parent already exited — the gap of `taskkill /T`). Verified on a real Windows 11
 * (PowerShell 5.1, tr-TR) on 2026-10-14: memory and process limits, exit code, stdio, tree kill on cancel.
 */

export function posixLimitsPrelude(limits: ResourceLimits, platform: NodeJS.Platform): string[] {
  const block = platform === 'darwin' ? 1024 : 512;
  const n = (v: number, field: string): string => {
    if (!Number.isFinite(v) || v < 1) throw new SandboxRequestError(`limits.${field}`, String(v));
    return String(Math.floor(v));
  };
  const script = [
    `ulimit -c 0`,
    `ulimit -n ${n(limits.openFiles, 'openFiles')}`,
    `ulimit -f ${n(Math.max(1, Math.floor(limits.fileSizeBytes / block)), 'fileSizeBytes')}`,
    // bash / zsh / ksh name RLIMIT_NPROC `-u`; dash (Debian / Ubuntu /bin/sh) only knows `-p` and rejects `-u`
    // ("Illegal option -u", exit 2), which failed every host job there. bash never reaches `-p` (its pipe size).
    `{ ulimit -u ${n(limits.pids, 'pids')} 2>/dev/null || ulimit -p ${n(limits.pids, 'pids')}; }`,
    'exec "$@"',
  ].join(' && ');
  // argv: /bin/sh -c '<script>' remyral-limits <command> <args...>
  return ['/bin/sh', '-c', script, 'remyral-limits'];
}

export type RunTaskkill = (args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>;

const runTaskkill: RunTaskkill = (args) =>
  new Promise((resolve) => {
    execFile('taskkill', [...args], { windowsHide: true, timeout: 10_000 }, (err, _o, stderr) => {
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr });
    });
  });

/**
 * Tree killer for a process started through the job runner: killing the runner closes the job handle
 * (KILL_ON_JOB_CLOSE); `/T` additionally reaches children if the runner misbehaves. Verified on Windows 11.
 */
export function windowsJobObjectKiller(
  taskkill: RunTaskkill = runTaskkill,
  opts: { readonly tree?: boolean } = {},
): ProcessTreeKiller {
  // p9-windows-host-isolation: a runtime started as a per-job account cannot be opened by the worker account, so
  // `/T` would fail on it; killing the runner (the worker's own process) closes the job, which ends them all.
  const tree = opts.tree ?? true;
  return {
    kind: 'windows-job-object',
    detached: false,
    signal: () => false,
    kill: async (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) throw new RangeError(`refusing to kill pid ${String(pid)}`);
      const r = await taskkill(tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F']);
      if (r.exitCode !== 0 && r.exitCode !== 128) {
        throw new Error(`taskkill failed (${String(r.exitCode)}): ${r.stderr.trim()}`);
      }
    },
  };
}
