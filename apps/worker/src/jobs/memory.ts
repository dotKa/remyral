import { join } from 'node:path';
import type { JobResources } from '@remyral/protocol';
import { runProcess, type RunFn } from '../remote-ops/process.js';

/**
 * p6-capacity-advice (docs/design/p6-capacity-advice.md §2): peak memory of a job's process tree.
 *
 * Adapters report the pid of every process they start for a session (`SpawnContext.onProcessSpawned`). While at
 * least one attempt is tracked, one shared timer reads the host's process table (pid, parent pid, resident
 * memory) and, per attempt, sums the resident memory of its root processes and all their descendants. The
 * attempt's peak is the highest such sum; it is reported in JOB_RESULT.resources.
 *
 * Limits (stated, not hidden): sampling misses spikes shorter than the interval; a descendant that left the tree
 * (daemonised, re-parented after its parent died) is not counted; RSS / working set counts shared pages once per
 * process, so the sum over-estimates — the safe direction for a capacity recommendation. A `container` profile
 * runs the agent inside the engine's VM / namespace: only the local client would be seen, so the runner does not
 * measure it.
 */

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
}

/** Reads the host's process table; null when it cannot (the sample is skipped, never reported as zero). */
export type ProcessTableReader = () => Promise<readonly ProcRow[] | null>;

const isId = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** `ps -A -o pid= -o ppid= -o rss=` (macOS, Linux; RSS in KiB). Malformed lines are skipped. */
export function parsePsRss(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const [pid, ppid, kib] = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN)) as [
      number,
      number,
      number,
    ];
    if (!isId(pid) || !isId(ppid) || !isId(kib)) continue;
    rows.push({ pid, ppid, rssBytes: kib * 1024 });
  }
  return rows;
}

/** `pid,ppid,workingSetBytes` lines from the PowerShell query below (Windows). Malformed lines are skipped. */
export function parseWindowsProcessTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+),(\d+),(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const [pid, ppid, ws] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isId(pid) || !isId(ppid) || !isId(ws)) continue;
    rows.push({ pid, ppid, rssBytes: ws });
  }
  return rows;
}

/**
 * Sum of resident memory over `roots` and every descendant (each process once). Null when none of the roots is
 * in the table (the tree is gone: nothing to measure in this sample).
 */
export function treeRssBytes(rows: readonly ProcRow[], roots: Iterable<number>): number | null {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    if (r.ppid === r.pid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const root of roots) if (byPid.has(root) && root > 0) stack.push(root);
  if (stack.length === 0) return null;
  let total = 0;
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid)?.rssBytes ?? 0;
    // pid 0 (Windows "System Idle Process") is everybody's parent there; never descend from it.
    if (pid !== 0) for (const c of children.get(pid) ?? []) if (!seen.has(c)) stack.push(c);
  }
  return total;
}

const WINDOWS_QUERY =
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize }";

/** The host's process table through `ps` (POSIX) or PowerShell CIM (Windows; UNVERIFIED on a real host). */
export function osProcessTable(
  platform: NodeJS.Platform = process.platform,
  run: RunFn = runProcess,
  env: NodeJS.ProcessEnv = process.env,
): ProcessTableReader {
  if (platform === 'win32') {
    const sysRoot = env.SystemRoot ?? 'C:\\Windows';
    const ps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return async () => {
      const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], {
        env: { SystemRoot: sysRoot, ...(env.WINDIR === undefined ? {} : { WINDIR: env.WINDIR }) },
        cwd: sysRoot,
        timeoutMs: 20_000,
        maxBytes: 4 * 1024 * 1024,
      });
      if (r.exitCode !== 0 || r.timedOut) return null;
      const rows = parseWindowsProcessTable(r.stdout);
      return rows.length === 0 ? null : rows;
    };
  }
  return async () => {
    const r = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='], {
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/',
      timeoutMs: 10_000,
      maxBytes: 4 * 1024 * 1024,
    });
    if (r.exitCode !== 0 || r.timedOut) return null;
    const rows = parsePsRss(r.stdout);
    return rows.length === 0 ? null : rows;
  };
}

/** One attempt's measurement. */
export interface MemoryTrack {
  /** A process the session started (adapters call it through `SpawnContext.onProcessSpawned`). */
  addRoot(pid: number): void;
  /** Stops tracking; the measurement, or null when no sample saw the tree. Idempotent. */
  finish(): JobResources | null;
}

interface TrackState {
  readonly roots: Set<number>;
  peak: number;
  samples: number;
  done: boolean;
}

export interface MemorySamplerOptions {
  readonly read: ProcessTableReader;
  /** Default: 5 s on POSIX, 15 s on Windows (a PowerShell start is expensive). */
  readonly intervalMs?: number;
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** Shared sampler for every running attempt (one process-table read per tick, only while attempts run). */
export class ProcessMemorySampler {
  readonly #tracks = new Set<TrackState>();
  readonly #read: ProcessTableReader;
  readonly #intervalMs: number;
  readonly #setInterval: (fn: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  #timer: unknown = null;
  #busy = false;

  constructor(opts: MemorySamplerOptions) {
    this.#read = opts.read;
    this.#intervalMs = opts.intervalMs ?? (process.platform === 'win32' ? 15_000 : 5_000);
    this.#setInterval =
      opts.setInterval ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref();
        return t;
      });
    this.#clearInterval =
      opts.clearInterval ??
      ((h) => {
        clearInterval(h as NodeJS.Timeout);
      });
  }

  track(): MemoryTrack {
    const state: TrackState = { roots: new Set(), peak: 0, samples: 0, done: false };
    this.#tracks.add(state);
    this.#ensureTimer();
    return {
      addRoot: (pid) => {
        if (!state.done && Number.isSafeInteger(pid) && pid > 0) state.roots.add(pid);
      },
      finish: () => {
        if (!state.done) {
          state.done = true;
          this.#tracks.delete(state);
          if (this.#tracks.size === 0) this.#stopTimer();
        }
        return state.samples === 0 ? null : { peakMemoryBytes: state.peak, samples: state.samples };
      },
    };
  }

  /** One sample for every tracked attempt (the timer's tick; exposed for tests). Never throws. */
  async sample(): Promise<void> {
    if (this.#busy) return;
    const tracks = [...this.#tracks].filter((t) => t.roots.size > 0);
    if (tracks.length === 0) return;
    this.#busy = true;
    try {
      const rows = await this.#read().catch(() => null);
      if (rows === null) return;
      for (const t of tracks) {
        if (t.done) continue;
        const total = treeRssBytes(rows, t.roots);
        if (total === null) continue;
        t.samples += 1;
        if (total > t.peak) t.peak = Math.min(total, Number.MAX_SAFE_INTEGER);
      }
    } finally {
      this.#busy = false;
    }
  }

  /** Attempts tracked now (tests). */
  get tracked(): number {
    return this.#tracks.size;
  }

  #ensureTimer(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#setInterval(() => {
      void this.sample();
    }, this.#intervalMs);
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    this.#clearInterval(this.#timer);
    this.#timer = null;
  }
}
