import { execFile } from 'node:child_process';
import { uptime } from 'node:os';
import { defaultTreeKiller } from '@remyral/agent-adapters';

/**
 * p11-session-continuity (ADR-0042 §2, F1 safety): before a restarted worker resumes an attempt, nothing of the
 * previous run may still be running — a runtime process tree that outlived the crashed daemon (POSIX process groups
 * are detached; Windows has no parent-death kill) would otherwise work in the same workspace as the resumed run.
 *
 * The checkpoint record keeps the pid and spawn time of every runtime process the attempt started, and the machine's
 * boot time. After a reboot nothing can be left. On the same boot a recorded pid that is still alive is killed (tree)
 * only when its start time matches the recorded spawn time (a reused pid belongs to someone else); when that cannot be
 * established the attempt is not resumed (fail closed: the master falls back to its old reconciliation).
 */

export interface RecordedProcess {
  readonly pid: number;
  /** Wall-clock ms when the adapter reported the spawn. */
  readonly at: number;
}

export interface ProcessProbe {
  /** Wall-clock ms of the machine's boot. */
  bootAt(): number;
  alive(pid: number): boolean;
  /** Wall-clock ms the process started, or null when it cannot be read. */
  startedAt(pid: number): Promise<number | null>;
  killTree(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Reboot detection tolerance (clock adjustments, uptime granularity). */
const BOOT_TOLERANCE_MS = 120_000;
/** How far a process' start may be from the recorded spawn time to still be "ours". */
const START_TOLERANCE_MS = 5_000;

export function machineBootAt(): number {
  return Date.now() - Math.round(uptime() * 1000);
}

function run(cmd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

export function nodeProcessProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
  const killer = defaultTreeKiller(platform);
  return {
    bootAt: machineBootAt,
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    async startedAt(pid) {
      if (platform === 'win32') {
        const out = await run('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToString('o')`,
        ]);
        const t = out === null ? NaN : Date.parse(out.trim());
        return Number.isFinite(t) ? t : null;
      }
      const out = await run('ps', ['-o', 'etime=', '-p', String(pid)]);
      const secs = out === null ? null : parseEtime(out.trim());
      return secs === null ? null : Date.now() - secs * 1000;
    },
    killTree: (pid) => killer.kill(pid),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
      }),
  };
}

/** `ps -o etime` → seconds (`[[dd-]hh:]mm:ss`), null when unreadable. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (m === null) return null;
  const [, d, h, mm, ss] = m;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

/**
 * Makes sure no recorded process of the attempt still runs. Returns null when none is left (killed or gone), or the
 * reason the attempt must not be resumed.
 */
export async function clearLeftovers(
  processes: readonly RecordedProcess[],
  recordedBootAt: number,
  probe: ProcessProbe,
): Promise<{ problem: string | null; killed: number[] }> {
  const killed: number[] = [];
  if (Math.abs(probe.bootAt() - recordedBootAt) > BOOT_TOLERANCE_MS) return { problem: null, killed };
  for (const p of processes) {
    if (!Number.isInteger(p.pid) || p.pid <= 1 || !probe.alive(p.pid)) continue;
    const started = await probe.startedAt(p.pid);
    if (started === null) {
      return {
        problem: `a process of the previous run (pid ${String(p.pid)}) may still be running and could not be verified`,
        killed,
      };
    }
    if (Math.abs(started - p.at) > START_TOLERANCE_MS) continue; // the pid was reused by another process
    await probe.killTree(p.pid).catch(() => undefined);
    for (let i = 0; i < 50 && probe.alive(p.pid); i++) await probe.sleep(200);
    if (probe.alive(p.pid)) {
      return { problem: `a process of the previous run (pid ${String(p.pid)}) could not be stopped`, killed };
    }
    killed.push(p.pid);
  }
  return { problem: null, killed };
}
