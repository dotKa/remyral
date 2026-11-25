import { statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg } from 'node:os';
import type { AppliedRuntimePolicy, WorkerToMaster } from '@remyral/protocol';
import type { ProbeReport } from '../probe/report.js';
import { createPressureReader, type PressureFigures, type PressureReader } from './pressure.js';

export type CapabilitiesPayload = Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'];
export type LoadSample = Extract<WorkerToMaster, { type: 'HEARTBEAT' }>['payload']['load'];

/**
 * CAPABILITIES from a probe report (p2-heartbeat-caps): every probed runtime with
 * its truthful capability record (ADR-0008) plus pin status (ADR-0012), the
 * sandbox profiles that are *ready* (not merely available), and found tools.
 */
export function capabilitiesFromProbe(
  report: ProbeReport,
  maxParallelJobs: number,
  /** p3-runtime-policy: the policy the probe's pins came from (reported so the master can detect drift). */
  runtimePolicy?: AppliedRuntimePolicy,
): CapabilitiesPayload {
  return {
    ...(runtimePolicy === undefined ? {} : { runtimePolicy }),
    runtimes: report.runtimes.map((r) => ({
      ...r.capabilities,
      pinnedVersion: r.pin,
      pinStatus: r.pinStatus,
    })),
    sandboxProfiles: report.sandboxProfiles.filter((p) => p.ready).map((p) => p.profile),
    maxParallelJobs,
    tools: report.tools
      .filter((t) => t.found)
      .map((t) => ({ name: t.name, version: (t.version ?? 'unknown').slice(0, 64) })),
  };
}

export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

/** Busy and total CPU time summed over all cores. */
export function cpuTotals(list: readonly { readonly times: CpuTimes }[]): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of list) {
    const t = c.times;
    const sum = t.user + t.nice + t.sys + t.idle + t.irq;
    total += sum;
    busy += sum - t.idle;
  }
  return { busy, total };
}

/** CPU percent between two `os.cpus()` snapshots; null when no time passed (or a counter went backwards). */
export function cpuPercentBetween(
  prev: { busy: number; total: number },
  next: { busy: number; total: number },
): number | null {
  const dt = next.total - prev.total;
  const db = next.busy - prev.busy;
  if (!(dt > 0) || db < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (db / dt) * 100)) * 10) / 10;
}

export interface LoadSamplerDeps {
  readonly dir: string;
  readonly platform?: NodeJS.Platform;
  readonly cpus?: () => readonly { readonly times: CpuTimes }[];
  readonly loadavg?: () => readonly number[];
  readonly freemem?: () => number;
  readonly statfs?: (dir: string) => Promise<{ bavail: number; bsize: number }>;
  /** p8-capacity-auto memory pressure figures (default: the OS reader in pressure.ts). */
  readonly pressure?: PressureReader;
  /**
   * p15-merge-approvals item 4: the workspace root and the minimum free space the worker keeps there (read on every
   * sample: the panel can change `workspace.minFreeBytes` at run time). Absent: no `workspaceDisk` in the sample.
   */
  readonly workspace?: { readonly dir: string; readonly minFreeBytes: () => number };
}

export type LoadSampler = () => Promise<LoadSample>;

/**
 * Host load for HEARTBEAT (p2-heartbeat-caps, extended by p8-capacity-auto). CPU is the busy share of `os.cpus()`
 * time between two consecutive samples — on every OS, Windows included (older builds sent the load average, which
 * Node reports as 0 there). The first snapshot is taken when the sampler is created; when no CPU time passed since
 * (the first heartbeat right after start), POSIX falls back to the 1-minute load average per core and Windows to
 * 0. Disk is the free space of `dir`. The optional memory pressure figures come from `pressure.ts`; a failed read
 * leaves them out. Concurrent calls share one sample (no overlapping reads). Never throws.
 */
export function createLoadSampler(deps: LoadSamplerDeps): LoadSampler {
  const platform = deps.platform ?? process.platform;
  const readCpus = deps.cpus ?? cpus;
  const readLoadavg = deps.loadavg ?? loadavg;
  const readFree = deps.freemem ?? freemem;
  const readStatfs = deps.statfs ?? statfs;
  const pressure = deps.pressure ?? createPressureReader({ platform });
  const snapshot = (): { busy: number; total: number } | null => {
    try {
      return cpuTotals(readCpus());
    } catch {
      return null;
    }
  };
  let prev = snapshot();
  let inflight: Promise<LoadSample> | null = null;

  const sample = async (): Promise<LoadSample> => {
    const next = snapshot();
    let cpuPercent: number | null = prev !== null && next !== null ? cpuPercentBetween(prev, next) : null;
    if (next !== null) prev = next;
    if (cpuPercent === null) {
      const cores = Math.max(1, next === null ? 1 : readCpus().length);
      const avg = platform === 'win32' ? 0 : (readLoadavg()[0] ?? 0);
      cpuPercent = Math.round(Math.min(100, Math.max(0, (avg / cores) * 100)) * 10) / 10;
    }
    let diskFreeBytes: number;
    try {
      const s = await readStatfs(deps.dir);
      diskFreeBytes = Math.max(0, Math.floor(s.bavail * s.bsize));
    } catch {
      diskFreeBytes = 0;
    }
    let workspaceDisk: { freeBytes: number; minFreeBytes: number } | null = null;
    if (deps.workspace !== undefined) {
      try {
        const s = await readStatfs(deps.workspace.dir);
        workspaceDisk = {
          freeBytes: Math.min(Math.max(0, Math.floor(s.bavail * s.bsize)), Number.MAX_SAFE_INTEGER),
          minFreeBytes: Math.min(
            Math.max(0, Math.floor(deps.workspace.minFreeBytes())),
            Number.MAX_SAFE_INTEGER,
          ),
        };
      } catch {
        // Not created yet / not readable: say nothing rather than a false "full".
      }
    }
    let figures: PressureFigures;
    try {
      figures = await pressure();
    } catch {
      figures = {};
    }
    let free: number;
    try {
      free = Math.max(0, Math.floor(readFree()));
    } catch {
      free = 0;
    }
    return {
      cpuPercent,
      memoryFreeBytes: Math.min(free, Number.MAX_SAFE_INTEGER),
      diskFreeBytes: Math.min(diskFreeBytes, Number.MAX_SAFE_INTEGER),
      ...figures,
      ...(workspaceDisk === null ? {} : { workspaceDisk }),
    };
  };

  return () => {
    inflight ??= sample().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

/** One-off sample (no CPU history: load average on POSIX). Kept for callers without a long-lived sampler. */
export async function sampleLoad(dir: string): Promise<LoadSample> {
  return createLoadSampler({ dir })();
}
