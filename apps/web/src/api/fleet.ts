import { parseQueueFacts, type WorkerQueueFacts } from './fleet-queue';
import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { type ReasonParams, reasonParamsField } from '../lib/reasons';

/**
 * p5-fleet-ui read models (apps/master/src/fleetview/routes.ts, docs/design/p5-fleet-ui.md): the fleet
 * overview with the compatibility matrix and one worker's lifecycle timeline. Reasons are text from the
 * master (built from worker reports): render as text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface CompatCell {
  readonly runtime: string;
  readonly status: string;
  readonly version: string | null;
  readonly reason: string;
  /** p14-i18n-reasons: the status's params (`cause` picks the sentence variant); absent from older masters. */
  readonly params?: ReasonParams;
}

/**
 * p6-capacity-advice: which parallelism the machine runs and why (master `fleetview/capacity.ts`):
 * `panel` = the panel value is in effect; `local_ceiling` = the machine's local file caps the panel value;
 * `pending` = the panel value is not applied yet; `local_file` = not managed from the panel; `unknown` = no report.
 */
export type ParallelismState = 'panel' | 'local_ceiling' | 'pending' | 'local_file' | 'unknown';

export interface Parallelism {
  readonly effective: number | null;
  readonly configured: number | null;
  readonly localCeiling: number | null;
  readonly state: ParallelismState;
}

export interface RuntimePeak {
  readonly runtime: string;
  readonly peakBytes: number;
  readonly perJobBytes: number;
  readonly source: 'measured' | 'fleet' | 'default';
  readonly attempts: number;
}

/** p6-capacity-advice: recommended parallel jobs from CPUs, RAM and the runtimes' peak memory. */
export interface CapacityAdvice {
  readonly recommended: number;
  readonly limitedBy: 'cpu' | 'memory';
  readonly cpuCount: number;
  readonly memoryBytes: number;
  readonly reserveBytes: number;
  readonly perJobBytes: number;
  readonly byCpu: number;
  readonly byMemory: number;
  readonly basis: RuntimePeak;
  readonly runtimes: readonly RuntimePeak[];
}

export interface WorkerOverview {
  readonly id: string;
  readonly capacity: { readonly running: number; readonly max: number | null };
  readonly capabilitiesAt: string | null;
  readonly sandboxProfiles: readonly string[];
  readonly sandboxReadiness: readonly {
    readonly profile: string;
    readonly ready: boolean;
    readonly runtimes: readonly string[] | null;
    readonly reason: string | null;
  }[];
  readonly tools: readonly { readonly name: string; readonly version: string }[];
  readonly load: {
    readonly cpuPercent: number;
    readonly memoryFreeBytes: number;
    readonly diskFreeBytes: number;
    /** p15-merge-approvals item 4: free disk vs. the minimum under the workspace root (absent: older workers). */
    readonly workspaceDisk?: { readonly freeBytes: number; readonly minFreeBytes: number };
  } | null;
  readonly network: { readonly key: string; readonly label: string };
  readonly runtimePolicy: {
    readonly assigned: string | null;
    readonly effective: string | null;
    readonly version: number | null;
    readonly stage: string | null;
    readonly inSync: boolean;
  };
  readonly release: {
    readonly channel: string;
    readonly targetVersion: string | null;
    readonly lastAttempt: {
      readonly toVersion: string;
      readonly status: string;
      readonly reason: string | null;
      readonly at: string;
      /** p17-worker-managed (null / false from an older master): attempt id, start version, the updater's line. */
      readonly id?: string | null;
      readonly fromVersion?: string | null;
      readonly detail?: string | null;
      readonly rollback?: boolean;
      readonly hasDiagnostics?: boolean;
    } | null;
    /** p17-worker-managed: the version before the current one, still stored on the master (rollback target). */
    readonly previousVersion?: string | null;
  };
  readonly compatibility: readonly CompatCell[];
  /** Absent from masters before p6-capacity-advice. */
  readonly parallelism: Parallelism | null;
  readonly advice: CapacityAdvice | null;
  /** p8-capacity-auto: suggest / auto mode (null: manual, or a master before p8-capacity-auto). */
  readonly capacityMode: CapacityModeSummary | null;
  /** p6-warm-caches: shared package caches as last reported; null before the worker release that reports them. */
  readonly packageCaches: PackageCaches | null;
  /** p17-disk-selfclean: the worker's own disk cleanup (supported: "Şimdi temizle"; report: null before one). */
  readonly diskHygiene: DiskHygiene;
  /** p9-queue-priority: per-profile slots and the urgent reserve (null: a master before p9-queue-priority). */
  readonly queue: WorkerQueueFacts | null;
}

/** p8-capacity-auto: the machine's capacity mode as the Fleet list shows it. */
export interface CapacityModeSummary {
  readonly mode: 'manual' | 'suggest' | 'auto';
  readonly slots: number | null;
  readonly min: number;
  readonly max: number;
  readonly suggestion: number | null;
}

function parseCapacityMode(v: unknown): CapacityModeSummary | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const mode = str(o, 'mode');
  if (mode !== 'manual' && mode !== 'suggest' && mode !== 'auto') throw new ShapeError('unexpected mode');
  return {
    mode,
    slots: nullableInt(o, 'slots'),
    min: int(o, 'min'),
    max: int(o, 'max'),
    suggestion: nullableInt(o, 'suggestion'),
  };
}

/** p6-warm-caches (ADR-0029): a machine's shared package caches (sizes and project ids only). */
export interface PackageCaches {
  readonly enabled: boolean;
  readonly disabledReason: 'local_config' | 'limit_zero' | null;
  readonly maxBytes: number;
  readonly usedBytes: number;
  readonly projects: readonly {
    readonly projectId: string;
    readonly bytes: number;
    readonly lastUsedAt: string;
    readonly inUse: boolean;
    readonly managers: readonly { readonly manager: string; readonly bytes: number }[];
  }[];
  readonly truncated: boolean;
  readonly scannedAt: string | null;
  readonly lastEviction: { readonly at: string; readonly projects: number; readonly bytes: number } | null;
  readonly reportedAt: string;
}

/** p17-disk-selfclean: what a disk cleanup may delete, in the order a low-disk run uses them. */
export const DISK_HYGIENE_CATEGORIES = [
  'temp',
  'logs',
  'releases',
  'workspaces',
  'runtimes',
  'packageCaches',
] as const;
export type DiskHygieneCategory = (typeof DISK_HYGIENE_CATEGORIES)[number];

export interface DiskHygieneRun {
  readonly trigger: 'low_disk' | 'daily' | 'manual';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly freeBefore: number | null;
  readonly freeAfter: number | null;
  readonly freedBytes: number;
  readonly freed: readonly {
    readonly category: DiskHygieneCategory;
    readonly bytes: number;
    readonly items: number;
  }[];
  readonly stillLow: boolean;
  readonly errors: number;
  /** p17-worker-managed: items another account owns, left in place (0 from an older worker). */
  readonly skipped: number;
}

export interface DiskUsageEntry {
  /** A directory name the worker itself creates, `workspace-root` or `other` (never a user file name). */
  readonly name: string;
  readonly bytes: number;
}

/** p17-disk-selfclean: CAPABILITIES.diskHygiene as the master stored it. */
export interface DiskHygieneReport {
  readonly enabled: boolean;
  readonly thresholdBytes: number;
  readonly marginBytes: number;
  readonly targetBytes: number;
  readonly freeBytes: number | null;
  readonly checkedAt: string | null;
  readonly running: boolean;
  readonly lastRun: DiskHygieneRun | null;
  readonly nextLowDiskAt: string | null;
  readonly nextDailyAt: string | null;
  readonly usage: {
    readonly at: string;
    readonly dataDir: readonly DiskUsageEntry[];
    readonly workspaceRoot: readonly DiskUsageEntry[];
    readonly partial: boolean;
  } | null;
  readonly reportedAt: string;
}

export interface DiskHygiene {
  readonly supported: boolean;
  readonly report: DiskHygieneReport | null;
}

export interface HistoryEntry {
  readonly at: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorType: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number') throw new ShapeError(`expected number at ${key}`);
  return v;
}

/** p15-merge-approvals item 4 (lenient: older masters/workers omit it). */
function workspaceDisk(v: unknown): {
  readonly workspaceDisk?: { readonly freeBytes: number; readonly minFreeBytes: number };
} {
  if (typeof v !== 'object' || v === null) return {};
  const o = v as Record<string, unknown>;
  return typeof o.freeBytes === 'number' && typeof o.minFreeBytes === 'number'
    ? { workspaceDisk: { freeBytes: o.freeBytes, minFreeBytes: o.minFreeBytes } }
    : {};
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

const PARALLELISM_STATES: readonly ParallelismState[] = [
  'panel',
  'local_ceiling',
  'pending',
  'local_file',
  'unknown',
];

function parseParallelism(v: unknown): Parallelism | null {
  if (v === undefined || v === null) return null;
  const o = obj(v);
  const state = PARALLELISM_STATES.find((s) => s === o.state);
  if (state === undefined) throw new ShapeError('expected a parallelism state');
  return {
    effective: nullableInt(o, 'effective'),
    configured: nullableInt(o, 'configured'),
    localCeiling: nullableInt(o, 'localCeiling'),
    state,
  };
}

function parsePeak(v: unknown): RuntimePeak {
  const o = obj(v);
  const source = o.source === 'measured' || o.source === 'fleet' || o.source === 'default' ? o.source : null;
  if (source === null) throw new ShapeError('expected a peak source');
  return {
    runtime: str(o, 'runtime'),
    peakBytes: num(o, 'peakBytes'),
    perJobBytes: num(o, 'perJobBytes'),
    source,
    attempts: int(o, 'attempts'),
  };
}

function parseAdvice(v: unknown): CapacityAdvice | null {
  if (v === undefined || v === null) return null;
  const o = obj(v);
  if (o.limitedBy !== 'cpu' && o.limitedBy !== 'memory') throw new ShapeError('expected limitedBy');
  return {
    recommended: int(o, 'recommended'),
    limitedBy: o.limitedBy,
    cpuCount: int(o, 'cpuCount'),
    memoryBytes: num(o, 'memoryBytes'),
    reserveBytes: num(o, 'reserveBytes'),
    perJobBytes: num(o, 'perJobBytes'),
    byCpu: int(o, 'byCpu'),
    byMemory: int(o, 'byMemory'),
    basis: parsePeak(o.basis),
    runtimes: arr(o, 'runtimes').map(parsePeak),
  };
}

function parsePackageCaches(v: unknown): PackageCaches | null {
  if (v === undefined || v === null) return null;
  const o = obj(v);
  const ev = o.lastEviction === undefined || o.lastEviction === null ? null : obj(o.lastEviction);
  return {
    enabled: bool(o, 'enabled'),
    disabledReason:
      o.disabledReason === 'local_config' || o.disabledReason === 'limit_zero' ? o.disabledReason : null,
    maxBytes: num(o, 'maxBytes'),
    usedBytes: num(o, 'usedBytes'),
    projects: arr(o, 'projects').map((x) => {
      const p = obj(x);
      return {
        projectId: str(p, 'projectId'),
        bytes: num(p, 'bytes'),
        lastUsedAt: str(p, 'lastUsedAt'),
        inUse: bool(p, 'inUse'),
        managers: arr(p, 'managers').map((m) => {
          const mo = obj(m);
          return { manager: str(mo, 'manager'), bytes: num(mo, 'bytes') };
        }),
      };
    }),
    truncated: o.truncated === true,
    scannedAt: nullableStr(o, 'scannedAt'),
    lastEviction:
      ev === null ? null : { at: str(ev, 'at'), projects: int(ev, 'projects'), bytes: num(ev, 'bytes') },
    reportedAt: str(o, 'reportedAt'),
  };
}

function nullableNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') throw new ShapeError(`expected number at ${key}`);
  return v;
}

function parseHygieneRun(v: unknown): DiskHygieneRun | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const trigger = str(o, 'trigger');
  if (trigger !== 'low_disk' && trigger !== 'daily' && trigger !== 'manual')
    throw new ShapeError('unexpected trigger');
  return {
    trigger,
    startedAt: str(o, 'startedAt'),
    finishedAt: str(o, 'finishedAt'),
    freeBefore: nullableNum(o, 'freeBefore'),
    freeAfter: nullableNum(o, 'freeAfter'),
    freedBytes: num(o, 'freedBytes'),
    freed: arr(o, 'freed').flatMap((x) => {
      const f = obj(x);
      const category = str(f, 'category');
      return (DISK_HYGIENE_CATEGORIES as readonly string[]).includes(category)
        ? [{ category: category as DiskHygieneCategory, bytes: num(f, 'bytes'), items: int(f, 'items') }]
        : [];
    }),
    stillLow: bool(o, 'stillLow'),
    errors: int(o, 'errors'),
    skipped: typeof o.skipped === 'number' ? o.skipped : 0,
  };
}

function parseUsageEntries(v: unknown): DiskUsageEntry[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const e = obj(x);
    return { name: str(e, 'name'), bytes: num(e, 'bytes') };
  });
}

/** p17-disk-selfclean (lenient: older masters omit it). */
function parseDiskHygiene(v: unknown): DiskHygiene {
  if (v === null || v === undefined) return { supported: false, report: null };
  const o = obj(v);
  const r = o.report === null || o.report === undefined ? null : obj(o.report);
  const usage = r === null || r.usage === null || r.usage === undefined ? null : obj(r.usage);
  return {
    supported: o.supported === true,
    report:
      r === null
        ? null
        : {
            enabled: bool(r, 'enabled'),
            thresholdBytes: num(r, 'thresholdBytes'),
            marginBytes: num(r, 'marginBytes'),
            targetBytes: num(r, 'targetBytes'),
            freeBytes: nullableNum(r, 'freeBytes'),
            checkedAt: nullableStr(r, 'checkedAt'),
            running: r.running === true,
            lastRun: parseHygieneRun(r.lastRun),
            nextLowDiskAt: nullableStr(r, 'nextLowDiskAt'),
            nextDailyAt: nullableStr(r, 'nextDailyAt'),
            usage:
              usage === null
                ? null
                : {
                    at: str(usage, 'at'),
                    dataDir: parseUsageEntries(usage.dataDir),
                    workspaceRoot: parseUsageEntries(usage.workspaceRoot),
                    partial: usage.partial === true,
                  },
            reportedAt: str(r, 'reportedAt'),
          },
  };
}

export function parseOverview(body: unknown): WorkerOverview[] {
  return arr(obj(body), 'workers').map((x) => {
    const o = obj(x);
    const cap = obj(o.capacity);
    const load = o.load === null ? null : obj(o.load);
    const net = obj(o.network);
    const pol = obj(o.runtimePolicy);
    const rel = obj(o.release);
    const last = rel.lastAttempt === null ? null : obj(rel.lastAttempt);
    return {
      id: str(o, 'id'),
      capacity: { running: int(cap, 'running'), max: nullableInt(cap, 'max') },
      capabilitiesAt: nullableStr(o, 'capabilitiesAt'),
      sandboxProfiles: arr(o, 'sandboxProfiles').map((p) => (typeof p === 'string' ? p : '')),
      sandboxReadiness: arr(o, 'sandboxReadiness').map((s) => {
        const so = obj(s);
        return {
          profile: str(so, 'profile'),
          ready: bool(so, 'ready'),
          runtimes:
            so.runtimes === null ? null : arr(so, 'runtimes').map((r) => (typeof r === 'string' ? r : '')),
          reason: nullableStr(so, 'reason'),
        };
      }),
      tools: arr(o, 'tools').map((t) => {
        const to = obj(t);
        return { name: str(to, 'name'), version: str(to, 'version') };
      }),
      load:
        load === null
          ? null
          : {
              cpuPercent: num(load, 'cpuPercent'),
              memoryFreeBytes: num(load, 'memoryFreeBytes'),
              diskFreeBytes: num(load, 'diskFreeBytes'),
              ...workspaceDisk(load.workspaceDisk),
            },
      network: { key: str(net, 'key'), label: str(net, 'label') },
      runtimePolicy: {
        assigned: nullableStr(pol, 'assigned'),
        effective: nullableStr(pol, 'effective'),
        version: nullableInt(pol, 'version'),
        stage: nullableStr(pol, 'stage'),
        inSync: bool(pol, 'inSync'),
      },
      release: {
        channel: str(rel, 'channel'),
        targetVersion: nullableStr(rel, 'targetVersion'),
        lastAttempt:
          last === null
            ? null
            : {
                toVersion: str(last, 'toVersion'),
                status: str(last, 'status'),
                reason: nullableStr(last, 'reason'),
                at: str(last, 'at'),
                // Tolerant: a master before p17-worker-managed sends none of these.
                id: typeof last.id === 'string' ? last.id : null,
                fromVersion: typeof last.fromVersion === 'string' ? last.fromVersion : null,
                detail: typeof last.detail === 'string' ? last.detail : null,
                rollback: last.rollback === true,
                hasDiagnostics: last.hasDiagnostics === true,
              },
        previousVersion: typeof rel.previousVersion === 'string' ? rel.previousVersion : null,
      },
      compatibility: arr(o, 'compatibility').map((c) => {
        const co = obj(c);
        return {
          runtime: str(co, 'runtime'),
          status: str(co, 'status'),
          version: nullableStr(co, 'version'),
          reason: str(co, 'reason'),
          ...reasonParamsField(co.params),
        };
      }),
      parallelism: parseParallelism(o.parallelism),
      advice: parseAdvice(o.advice),
      capacityMode: parseCapacityMode(o.capacityMode),
      packageCaches: parsePackageCaches(o.packageCaches),
      diskHygiene: parseDiskHygiene(o.diskHygiene),
      queue: parseQueueFacts(o.queue),
    };
  });
}

export function getFleetOverview(opts: Opts = {}): Promise<WorkerOverview[]> {
  return apiRequest('GET', '/fleet/overview', parseOverview, opts);
}

export function getWorkerHistory(id: string, opts: Opts = {}): Promise<HistoryEntry[]> {
  return apiRequest(
    'GET',
    `/workers/${encodeURIComponent(id)}/history`,
    (v) =>
      arr(obj(v), 'items').map((x) => {
        const o = obj(x);
        const d = obj(o.detail);
        const detail: Record<string, string | number | boolean> = {};
        for (const [k, val] of Object.entries(d)) {
          if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') detail[k] = val;
        }
        return {
          at: str(o, 'at'),
          action: str(o, 'action'),
          outcome: str(o, 'outcome'),
          actorType: str(obj(o.actor), 'type'),
          detail,
        };
      }),
    opts,
  );
}
