import { execFile } from 'node:child_process';

/**
 * Platform strategy for owning a process tree (ADR-0012 rule 4).
 *
 * - POSIX: the child is spawned `detached`, i.e. as leader of a new process
 *   group (pgid = pid); signalling `-pid` reaches every descendant that did
 *   not deliberately leave the group (setsid/double-fork escapes are caught
 *   by the sandbox user + p3-sandbox, not here).
 * - Windows: `taskkill /PID <pid> /T /F` kills the tree by parent-pid walk.
 *   Windows has no graceful tree signal; graceful stop must be the runtime's
 *   native interrupt. KNOWN GAP: a descendant whose parent already exited is
 *   not reachable by /T. Job Objects (kill-on-close) are the planned
 *   improvement (needs a native helper; tracked in the design note).
 */
export interface ProcessTreeKiller {
  readonly kind: 'posix-process-group' | 'windows-taskkill' | 'container' | 'windows-job-object';
  /** Spawn the leader detached (own process group) — POSIX only. */
  readonly detached: boolean;
  /** Graceful signal to the whole tree. Returns false if not deliverable (gone, or unsupported on this platform). */
  signal(pid: number, signal: NodeJS.Signals): boolean;
  /** Forcefully kill the whole tree. Must not throw if the tree is already gone. */
  kill(pid: number): Promise<void>;
}

type KillFn = (pid: number, signal: NodeJS.Signals | number) => true;

/**
 * ESRCH: the group is gone. EPERM on a group signal means no member could be
 * signalled: POSIX kill() to a group succeeds if *any* member is signalled, and
 * every live member of a group we created runs as our user. macOS returns
 * EPERM for a group that contains only zombies (members already dead, not yet
 * reaped by launchd), so both mean "nothing of ours left to kill".
 */
function isNoSignallableMember(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err.code === 'ESRCH' || err.code === 'EPERM')
  );
}

export function posixTreeKiller(kill: KillFn = (pid, sig) => process.kill(pid, sig)): ProcessTreeKiller {
  const send = (pid: number, sig: NodeJS.Signals): boolean => {
    if (!Number.isInteger(pid) || pid <= 1) throw new RangeError(`refusing to signal pid ${String(pid)}`);
    try {
      kill(-pid, sig);
      return true;
    } catch (err) {
      if (isNoSignallableMember(err)) return false;
      throw err;
    }
  };
  return {
    kind: 'posix-process-group',
    detached: true,
    signal: send,
    kill: (pid) => {
      send(pid, 'SIGKILL');
      return Promise.resolve();
    },
  };
}

export type RunTaskkill = (args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>;

const runTaskkillDefault: RunTaskkill = (args) =>
  new Promise((resolve) => {
    execFile('taskkill', [...args], { windowsHide: true, timeout: 10_000 }, (err, _stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ exitCode: code, stderr });
    });
  });

/** taskkill exit code when the PID does not exist (already exited). */
const TASKKILL_NOT_FOUND = 128;

export function windowsTreeKiller(runTaskkill: RunTaskkill = runTaskkillDefault): ProcessTreeKiller {
  return {
    kind: 'windows-taskkill',
    detached: false,
    signal: () => false,
    kill: async (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) throw new RangeError(`refusing to kill pid ${String(pid)}`);
      const { exitCode, stderr } = await runTaskkill(['/PID', String(pid), '/T', '/F']);
      if (exitCode !== 0 && exitCode !== TASKKILL_NOT_FOUND) {
        throw new Error(`taskkill /PID ${String(pid)} /T /F failed (${String(exitCode)}): ${stderr.trim()}`);
      }
    },
  };
}

export function defaultTreeKiller(platform: NodeJS.Platform = process.platform): ProcessTreeKiller {
  return platform === 'win32' ? windowsTreeKiller() : posixTreeKiller();
}
