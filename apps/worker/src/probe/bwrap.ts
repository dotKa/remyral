import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { access, constants } from 'node:fs/promises';

/**
 * Real user-namespace check for the Linux `runtime-sandbox` profile (Codex / Claude Code use bubblewrap).
 *
 * docs/compat/handson-2026-10-13.md finding 2: inside a container with Docker's default seccomp profile
 * `bwrap` is installed but cannot create a namespace (`bwrap: No permissions to create new namespace`), yet
 * the probe reported `runtime-sandbox` as available. A bwrap binary on PATH proves nothing; running it
 * does. `bwrap --unshare-user --ro-bind / / true` is the smallest invocation that needs exactly what the
 * runtimes need (an unprivileged user namespace plus a mount namespace).
 */
export const BWRAP_NAMESPACE_CHECK_ARGS: readonly string[] = [
  '--unshare-user',
  '--ro-bind',
  '/',
  '/',
  'true',
];

export interface NamespaceCheck {
  /** true: namespaces work; false: bwrap ran and was refused; null: could not be checked (no bwrap). */
  readonly usable: boolean | null;
  /** Short, non-secret explanation for the operator. */
  readonly detail: string;
}

export interface ExecLike {
  (
    file: string,
    args: readonly string[],
    opts: { timeoutMs: number },
  ): Promise<{ exitCode: number | null; stderr: string; timedOut?: boolean; spawnError?: string }>;
}

/** Runs the namespace check with `bwrapPath` (null = bubblewrap not found). Never throws. */
export async function checkBwrapNamespaces(
  exec: ExecLike,
  bwrapPath: string | null,
  platform: string,
): Promise<NamespaceCheck> {
  if (platform !== 'linux') return { usable: null, detail: 'bubblewrap is only used on Linux' };
  if (bwrapPath === null) {
    return {
      usable: null,
      detail:
        'bubblewrap (bwrap) not on PATH: user namespaces could not be verified; install bubblewrap so the worker can check them',
    };
  }
  try {
    const r = await exec(bwrapPath, BWRAP_NAMESPACE_CHECK_ARGS, { timeoutMs: 5_000 });
    if (r.exitCode === 0) return { usable: true, detail: 'bwrap created a user + mount namespace' };
    const reason = r.timedOut === true ? 'timed out' : (r.stderr.trim().split('\n')[0] ?? '').slice(0, 160);
    return {
      usable: false,
      detail: `bwrap cannot create namespaces here (${reason || `exit ${String(r.exitCode)}`}); e.g. a container with the default seccomp profile, or kernel.unprivileged_userns_clone=0`,
    };
  } catch (error) {
    return {
      usable: false,
      detail: `bwrap check failed: ${error instanceof Error ? error.message : 'error'}`,
    };
  }
}

/** `child_process.execFile` adapter for {@link checkBwrapNamespaces} (minimal env, no shell). */
export const nodeExec: ExecLike = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, windowsHide: true },
      (error, _stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({
          exitCode: code,
          stderr,
          timedOut: error?.killed === true,
          ...(error !== null && typeof error.code === 'string' ? { spawnError: error.code } : {}),
        });
      },
    );
  });

/** First executable `bwrap` on PATH (Linux), or null. */
export async function findBwrap(pathEnv = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'bwrap');
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}
