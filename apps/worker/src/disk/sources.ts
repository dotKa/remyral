import { type DiskHygieneCategory, workfilesEffectiveExpiry } from '@remyral/protocol';
import { pathApi } from '../config/paths.js';
import type { HygieneFs } from './fs.js';

/**
 * p17-disk-selfclean: what the disk hygiene may delete, per category. Each source lists *candidates* — things the
 * worker itself created and can recreate — with their size and age; the engine (hygiene.ts) removes them oldest first.
 *
 * `light` candidates are always safe to drop (the daily run removes them whatever the free space); the others go only
 * while free space is below the target. A source never lists something in use: a running / parked / recoverable job's
 * directories, a pinned or unexpired kept directory, the active runtime version or one of a runtime with a running job,
 * a package cache an attempt holds, a staged release while an update is in flight.
 */

export interface Candidate {
  readonly category: DiskHygieneCategory;
  /** For the worker log: a worker-owned path or ids (never user file names below it). */
  readonly label: string;
  readonly bytes: number;
  /** Age key (ms since the epoch): older first. */
  readonly at: number;
  /** Always safe to drop (the daily light run removes it too). */
  readonly light: boolean;
  /** Removes it; resolves the bytes freed (false: it was gone or became protected — nothing freed). */
  remove(): Promise<number | false>;
}

export interface HygieneSource {
  readonly category: DiskHygieneCategory;
  collect(now: Date): Promise<Candidate[]>;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A job / attempt id segment as the workspace writes it (workspace/ids.ts). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

async function sizeOf(fs: HygieneFs, path: string): Promise<number> {
  return (await fs.treeSize(path)).bytes;
}

function removal(fs: HygieneFs, path: string, bytes: number): () => Promise<number> {
  return async () => {
    await fs.remove(path);
    return bytes;
  };
}

// ------------------------------------------------------------------------------------------------------- temp

export interface TempSourceOptions {
  readonly fs: HygieneFs;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  /** Jobs this worker runs or is admitting now (their attempt directories stay). */
  readonly activeJobs: () => ReadonlySet<string>;
  /** A leftover must be at least this old (default 1 hour). */
  readonly minAgeMs?: number;
}

/**
 * Temporary directories of finished jobs and other leftovers, all `light`:
 *  - `<workspaceRoot>/sandboxes/<jobId>/` — an attempt's private dir (git view, runtime state, tmp) that its end did not
 *    remove (a crash, a kill). Never one of an active job, a parked attempt (`.remyral/parked/<jobId>.json`), a
 *    recoverable one (`.remyral/continuity/<jobId>.json`), a service's (`svc-*`), an IDE workspace's (`ide-*`, p19-ide)
 *    or a dot entry; only when nothing in
 *    it changed for `minAgeMs`.
 *  - `<dataDir>/caches/.trash/*` — package caches evicted but not yet deleted.
 *  - `<dataDir>/runtime-verify/<runtime>/*` — scratch installs of runtime verifications older than 6 hours.
 */
export function tempSource(o: TempSourceOptions): HygieneSource {
  const p = pathApi(o.fs.platform);
  const minAge = o.minAgeMs ?? HOUR;
  return {
    category: 'temp',
    async collect(now) {
      const out: Candidate[] = [];
      const protectedJobs = new Set(o.activeJobs());
      for (const sub of ['parked', 'continuity']) {
        for (const e of await o.fs.list(p.join(o.workspaceRoot, '.remyral', sub))) {
          // A record of either store keeps every directory of its job (a broken one too: the runner decides).
          if (e.name.endsWith('.json')) protectedJobs.add(e.name.slice(0, -'.json'.length));
        }
      }
      const sandboxes = p.join(o.workspaceRoot, 'sandboxes');
      for (const job of await o.fs.list(sandboxes)) {
        if (
          job.kind !== 'dir' ||
          !SEGMENT.test(job.name) ||
          job.name.startsWith('svc-') ||
          job.name.startsWith('ide-')
        )
          continue;
        if (protectedJobs.has(job.name)) continue;
        const dir = p.join(sandboxes, job.name);
        const children = await o.fs.list(dir);
        const newest = Math.max(job.mtimeMs, ...children.map((c) => c.mtimeMs));
        if (now.getTime() - newest < minAge) continue;
        const bytes = await sizeOf(o.fs, dir);
        out.push({
          category: 'temp',
          label: `sandboxes/${job.name}`,
          bytes,
          at: newest,
          light: true,
          remove: removal(o.fs, dir, bytes),
        });
      }
      const trash = p.join(o.dataDir, 'caches', '.trash');
      for (const e of await o.fs.list(trash)) {
        const path = p.join(trash, e.name);
        const bytes = e.kind === 'file' ? e.size : await sizeOf(o.fs, path);
        out.push({
          category: 'temp',
          label: `caches/.trash/${e.name}`,
          bytes,
          at: e.mtimeMs,
          light: true,
          remove: removal(o.fs, path, bytes),
        });
      }
      const verify = p.join(o.dataDir, 'runtime-verify');
      for (const rt of await o.fs.list(verify)) {
        if (rt.kind !== 'dir') continue;
        for (const e of await o.fs.list(p.join(verify, rt.name))) {
          if (now.getTime() - e.mtimeMs < 6 * HOUR) continue;
          const path = p.join(verify, rt.name, e.name);
          const bytes = e.kind === 'file' ? e.size : await sizeOf(o.fs, path);
          out.push({
            category: 'temp',
            label: `runtime-verify/${rt.name}/${e.name}`,
            bytes,
            at: e.mtimeMs,
            light: true,
            remove: removal(o.fs, path, bytes),
          });
        }
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------------------------- logs

/**
 * A rotated generation of a log file — never the file being written:
 *  - `worker.log.1`, `boot.log.2`, `updater.log.1.gz`, `x.log.old` (the worker's own and logrotate / newsyslog style);
 *  - `remyral-worker_r2026-10-24_10-00-00.log` (shawl / flexi_logger on Windows; `_rCURRENT.log` is the live one).
 */
export function isRotatedLog(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return false;
  if (/\.log\.(?:\d{1,4}|old)(?:\.gz)?$/.test(name)) return true;
  return /_r\d[\d_.-]*\.log$/.test(name);
}

/**
 * A log the pre-rename service wrote and a Remyral worker never writes again: on Windows the shawl output of the
 * `RemanaWorker` service, `remana-worker_rCURRENT.log` and its generations `remana-worker_r<date>.log`, left in the
 * logs dir the cut-over moved (`C:\ProgramData\RemyralWorker\logs`). Only this exact prefix; always removable.
 */
export function isPreRenameLog(name: string): boolean {
  return /^remana-worker_r(?:CURRENT|\d[\d_.-]*)\.log$/.test(name);
}

export interface LogsSourceOptions {
  readonly fs: HygieneFs;
  /** The worker's own log dirs: `<dataDir>/logs` and, where it exists, the service wrapper's log dir. */
  readonly dirs: readonly string[];
  /** Rotated generations kept in all (bytes, newest first) by the light run. Default 64 MiB. */
  readonly capBytes?: number;
  /** Rotated generations older than this are dropped by the light run. Default 30 days. */
  readonly maxAgeMs?: number;
}

/**
 * Rotated logs: beyond the cap or the age `light`, every other rotated generation only while space is low. Leftover
 * pre-rename logs (isPreRenameLog) in the same dirs count as rotated generations and are always `light`. Only the
 * files directly in `dirs` are looked at.
 */
export function logsSource(o: LogsSourceOptions): HygieneSource {
  const p = pathApi(o.fs.platform);
  const cap = o.capBytes ?? 64 * 1024 ** 2;
  const maxAge = o.maxAgeMs ?? 30 * DAY;
  return {
    category: 'logs',
    async collect(now) {
      const rotated: { dir: string; name: string; size: number; mtimeMs: number; preRename: boolean }[] = [];
      for (const dir of o.dirs) {
        for (const e of await o.fs.list(dir)) {
          if (e.kind !== 'file') continue;
          const preRename = isPreRenameLog(e.name);
          if (preRename || isRotatedLog(e.name)) rotated.push({ dir, ...e, preRename });
        }
      }
      rotated.sort((a, b) => b.mtimeMs - a.mtimeMs);
      let kept = 0;
      return rotated.map((r) => {
        kept += r.size;
        const light = r.preRename || kept > cap || now.getTime() - r.mtimeMs > maxAge;
        const path = p.join(r.dir, r.name);
        return {
          category: 'logs' as const,
          label: `logs/${r.name}`,
          bytes: r.size,
          at: r.mtimeMs,
          light,
          remove: removal(o.fs, path, r.size),
        };
      });
    },
  };
}

// --------------------------------------------------------------------------------------------------- releases

export interface ReleasesSourceOptions {
  readonly fs: HygieneFs;
  /** `<dataDir>/updates/staged` (update/layout.ts). */
  readonly stagedDir: string;
  /**
   * The version an activation request (`updates/request.json`) names while the privileged updater may still read its
   * staged files — null when there is none or it names the version running now (already activated: the updater's
   * health check and rollback use the install dir's `versions/`, never the staged copy).
   */
  readonly pending: () => Promise<string | null>;
  /** An update is being downloaded, staged or activated now. */
  readonly busy: () => boolean;
}

/**
 * Staged release downloads in the data dir (`updates/staged/<version>/`), `light` — never while an update is in flight,
 * never the one a pending activation request names. The install dir's `versions/` (current + previous for rollback) is
 * root / admin owned and read-only for the worker: the privileged updater prunes it itself.
 */
export function releasesSource(o: ReleasesSourceOptions): HygieneSource {
  const p = pathApi(o.fs.platform);
  return {
    category: 'releases',
    async collect() {
      if (o.busy()) return [];
      const pending = await o.pending();
      const out: Candidate[] = [];
      for (const e of await o.fs.list(o.stagedDir)) {
        if (e.kind !== 'dir' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(e.name) || e.name === pending)
          continue;
        const path = p.join(o.stagedDir, e.name);
        const bytes = await sizeOf(o.fs, path);
        out.push({
          category: 'releases',
          label: `updates/staged/${e.name}`,
          bytes,
          at: e.mtimeMs,
          light: true,
          remove: async () => {
            // Re-checked right before: an update may have started since the listing.
            if (o.busy() || (await o.pending()) === e.name) return false;
            await o.fs.remove(path);
            return bytes;
          },
        });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------------------- workspaces

export interface KeptPort {
  list(): readonly {
    readonly jobId: string;
    readonly attemptId: string;
    readonly sizeBytes: number;
    readonly expiresAt: string;
    readonly pinnedUntil: string | null;
  }[];
  /** Removes it and tells the master (`expired`). */
  remove(jobId: string, attemptId: string): Promise<boolean>;
}

export interface RetainedPort {
  list(): Promise<
    readonly { readonly jobId: string; readonly attemptId: string; readonly retainedAt: string }[]
  >;
  /** `<workspaceRoot>/jobs/<jobId>/<attemptId>` */
  dir(jobId: string, attemptId: string): string;
  remove(jobId: string, attemptId: string): Promise<boolean>;
}

export interface WorkspacesSourceOptions {
  readonly fs: HygieneFs;
  readonly kept?: KeptPort | null;
  readonly retained?: RetainedPort | null;
  readonly activeJobs: () => ReadonlySet<string>;
}

/**
 * Working directories of finished jobs, only while space is low:
 *  - kept directories of workspace jobs past their retention (expiry and pin both over) — the hourly sweep waits a
 *    day of grace for the master; a low disk does not;
 *  - failed / cancelled worktrees kept for inspection (`workspace.retainFailed`), oldest first.
 * Never one of a running job, never a pinned one or one whose retention has not ended.
 */
export function workspacesSource(o: WorkspacesSourceOptions): HygieneSource {
  return {
    category: 'workspaces',
    async collect(now) {
      const out: Candidate[] = [];
      const active = o.activeJobs();
      const kept = o.kept;
      if (kept !== undefined && kept !== null) {
        for (const r of kept.list()) {
          const until = workfilesEffectiveExpiry(r);
          // NaN (an unreadable date) never counts as expired.
          if (!(until <= now.getTime()) || active.has(r.jobId)) continue;
          out.push({
            category: 'workspaces',
            label: `kept/${r.jobId}/${r.attemptId}`,
            bytes: r.sizeBytes,
            at: until,
            light: false,
            remove: async () => ((await kept.remove(r.jobId, r.attemptId)) ? r.sizeBytes : false),
          });
        }
      }
      const retained = o.retained;
      if (retained !== undefined && retained !== null) {
        for (const r of await retained.list()) {
          if (active.has(r.jobId)) continue;
          const bytes = await sizeOf(o.fs, retained.dir(r.jobId, r.attemptId));
          const at = Date.parse(r.retainedAt);
          out.push({
            category: 'workspaces',
            label: `jobs/${r.jobId}/${r.attemptId} (failed, kept for inspection)`,
            bytes,
            // After the expired kept directories (those come first at the same age).
            at: Number.isNaN(at) ? 0 : at,
            light: false,
            remove: async () => ((await retained.remove(r.jobId, r.attemptId)) ? bytes : false),
          });
        }
      }
      return out;
    },
  };
}

// --------------------------------------------------------------------------------------------------- runtimes

export interface RuntimesPort {
  /** Every worker-managed install. */
  installs(): readonly {
    readonly runtime: string;
    readonly version: string;
    readonly installedAt: string;
    readonly active: boolean;
    readonly dir: string;
  }[];
  /** A job of the runtime runs now, or the installer is changing it. */
  busy(runtime: string): boolean;
  remove(runtime: string, version: string): Promise<void>;
}

/**
 * Inactive managed runtime versions (`<dataDir>/runtimes/<runtime>/<version>/`): the newest inactive one per runtime
 * (the quick rollback) only while space is low, older ones `light`. Never the active version, never one of a runtime
 * with a running job; every removed version can be installed again from the pinned set.
 */
export function runtimesSource(o: {
  readonly fs: HygieneFs;
  readonly runtimes: RuntimesPort;
}): HygieneSource {
  return {
    category: 'runtimes',
    async collect() {
      const out: Candidate[] = [];
      const byRuntime = new Map<string, ReturnType<RuntimesPort['installs']>[number][]>();
      for (const i of o.runtimes.installs()) {
        if (i.active) continue;
        byRuntime.set(i.runtime, [...(byRuntime.get(i.runtime) ?? []), i]);
      }
      for (const [runtime, list] of byRuntime) {
        if (o.runtimes.busy(runtime)) continue;
        list.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
        for (const [n, i] of list.entries()) {
          const bytes = await sizeOf(o.fs, i.dir);
          const at = Date.parse(i.installedAt);
          out.push({
            category: 'runtimes',
            label: `runtimes/${runtime}/${i.version}`,
            bytes,
            at: Number.isNaN(at) ? 0 : at,
            light: n > 0,
            remove: async () => {
              if (o.runtimes.busy(runtime)) return false;
              await o.runtimes.remove(runtime, i.version);
              return bytes;
            },
          });
        }
      }
      return out;
    },
  };
}

// --------------------------------------------------------------------------------------------- package caches

export interface PackageCachesPort {
  /** Project caches no attempt holds now (sizes from a fresh scan). */
  candidates(): Promise<readonly { key: string; bytes: number; lastUsedAt: Date }[]>;
  /** Evicts one (false: it is in use now / gone). */
  evict(key: string): Promise<number | false>;
}

/** The worker's shared package caches (LRU per project), only while space is low; never one an attempt holds. */
export function packageCachesSource(o: { readonly caches: PackageCachesPort }): HygieneSource {
  return {
    category: 'packageCaches',
    async collect() {
      return (await o.caches.candidates()).map((c) => ({
        category: 'packageCaches' as const,
        label: `caches/host/${c.key}`,
        bytes: c.bytes,
        at: c.lastUsedAt.getTime(),
        light: false,
        remove: () => o.caches.evict(c.key),
      }));
    },
  };
}
