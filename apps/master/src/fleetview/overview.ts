import { profileFacts } from '../queue/facts.js';
import { DEFAULT_URGENT_RESERVE } from '@remyral/scheduler';
import {
  DISK_HYGIENE_FEATURE,
  DiskHygieneReport,
  type PackageCacheReport,
  RuntimeKind,
  type RuntimePolicyDocument,
} from '@remyral/protocol';
import { storedCacheReport } from '../package-caches/service.js';
import type { Queryable } from '../db/pool.js';
import {
  type CapacityAdvice,
  fleetPeaks,
  type ParallelismView,
  parallelismView,
  recommendParallelism,
} from './capacity.js';
import { workerMemory } from './memory-rollup.js';
import { capacitySummaries } from '../capacity/service.js';
import { cachedVerifiedIndex, overlaidCapabilities } from '../capability-evidence/overlay.js';

/**
 * p5-fleet-ui fleet overview (docs/design/p5-fleet-ui.md §2): one read model per worker for the Fleet screen —
 * capacity (the master's own lease count vs the reported slots), sandbox readiness, tools, network group,
 * runtime policy sync, release/update state — and the runtime × worker compatibility matrix with the reason
 * text, computed from the same facts placement and the worker's runtime gate use. Read only.
 */

export type CompatStatus =
  | 'ready'
  | 'degraded'
  | 'not_installed'
  | 'not_allowed'
  | 'pin_mismatch'
  | 'not_authenticated'
  | 'unverified'
  | 'unsupported'
  | 'unknown';

export interface CompatCell {
  readonly runtime: RuntimeKind;
  readonly status: CompatStatus;
  readonly version: string | null;
  readonly reason: string;
  /** p14-i18n-reasons: `cause` of the status (REASON_CAUSES), so the console never reads the English `reason`. */
  readonly params?: { readonly cause: string };
}

export interface RuntimeFact {
  readonly runtime: string;
  readonly version: string;
  readonly installed: boolean;
  readonly authenticated: string;
  readonly pinStatus: string;
  readonly pinnedVersion: string | null;
  readonly capabilities: Readonly<Record<string, { status?: unknown }>>;
}

/** Capabilities every job needs (approval unless the job denies sensitive actions; p4-orchestration §3). */
const REQUIRED = ['streaming', 'cancel', 'approval'] as const;

/** Pure: one matrix cell (exported for unit tests). */
export function compatibility(
  runtime: RuntimeKind,
  facts: { readonly capabilitiesKnown: boolean; readonly runtimes: readonly RuntimeFact[] },
  policy: {
    readonly name: string;
    readonly version: number;
    readonly document: RuntimePolicyDocument;
  } | null,
  /**
   * p14-login-status-consistency: how the machine's jobs authenticate this runtime (its applied `runtimeAuth`
   * mode, `none` = nothing configured); undefined when the machine never reported a configuration.
   */
  jobAuth?: 'local-login' | 'secret-ref' | 'none',
): CompatCell {
  if (!facts.capabilitiesKnown) {
    return { runtime, status: 'unknown', version: null, reason: 'no capabilities reported yet' };
  }
  const r = facts.runtimes.find((x) => x.runtime === runtime && x.installed);
  if (r === undefined) {
    return {
      runtime,
      status: 'not_installed',
      version: null,
      reason: `${runtime} is not installed on this worker`,
    };
  }
  const rule = policy?.document.runtimes[runtime];
  if (policy !== null && rule === undefined) {
    return {
      runtime,
      status: 'not_allowed',
      version: r.version,
      reason: `not allowed by runtime policy ${policy.name} v${String(policy.version)}`,
    };
  }
  let degraded: string | null = null;
  if (r.pinStatus !== 'match') {
    const pinned = r.pinnedVersion ?? rule?.version ?? 'the pinned version';
    if (rule?.allowUnpinned === true) {
      degraded = `runs unpinned ${r.version} (pinned ${pinned}; allowUnpinned)`;
    } else {
      return {
        runtime,
        status: 'pin_mismatch',
        version: r.version,
        reason: `installed ${r.version}, pinned ${pinned} (ADR-0012): install the pinned version`,
      };
    }
  }
  if (r.authenticated === 'no') {
    // p14-login-status-consistency: say why — a subscription login does not help jobs that use an API key or no
    // sign-in method at all (the worker then treats the runtime as an unbound key, whatever its login says).
    return {
      runtime,
      status: 'not_authenticated',
      version: r.version,
      ...(jobAuth === 'none'
        ? { params: { cause: 'no_job_auth' } }
        : jobAuth === 'secret-ref'
          ? { params: { cause: 'job_auth_secret_ref' } }
          : {}),
      reason:
        jobAuth === 'none'
          ? 'not authenticated: no sign-in method is configured for jobs on this machine (runtimeAuth not set), so jobs do not use its subscription login — choose the subscription login (local-login) or an API key in Machine → Configuration'
          : jobAuth === 'secret-ref'
            ? 'not authenticated: jobs on this machine use an API key (secret-ref) that is not available there, not its subscription login — bind the key or choose the subscription login (local-login) in Machine → Configuration'
            : 'not authenticated (configure runtimeAuth, or log in again: Remote operations → Log in)',
    };
  }
  const caps = REQUIRED.map((name) => ({
    name,
    status: typeof r.capabilities[name]?.status === 'string' ? r.capabilities[name].status : 'unknown',
  }));
  const unsupported = caps.filter((c) => c.status === 'unsupported' || c.status === 'unknown');
  if (unsupported.length > 0) {
    return {
      runtime,
      status: 'unsupported',
      version: r.version,
      reason: `capability ${unsupported.map((c) => `${c.name}=${c.status}`).join(', ')}`,
    };
  }
  const unverified = caps.filter((c) => c.status === 'unverified');
  if (unverified.length > 0 && rule?.allowUnverified !== true) {
    return {
      runtime,
      status: 'unverified',
      version: r.version,
      reason: `capability ${unverified.map((c) => c.name).join(', ')} unverified on this OS/version (no live run has proven it yet): prove it with Machine → Runtimes → Verify, or allow it in Settings → Runtimes → ${policy?.name ?? 'default'} → Allow unverified`,
    };
  }
  const notes = [
    degraded,
    unverified.length > 0
      ? `${unverified.map((c) => c.name).join(', ')} unverified (allowUnverified; Machine → Runtimes → Verify proves them)`
      : null,
    caps.some((c) => c.status === 'degraded') ? 'some capabilities degraded' : null,
  ].filter((x): x is string => x !== null);
  return notes.length > 0
    ? { runtime, status: 'degraded', version: r.version, reason: notes.join('; ') }
    : { runtime, status: 'ready', version: r.version, reason: 'ready' };
}

/**
 * Network group for the "map" view from the last connection address: the /24 (IPv4) or /64 (IPv6), marked
 * private or public. Only the group is exposed, never the address.
 */
export function networkGroup(ip: string | null): { readonly key: string; readonly label: string } {
  if (ip === null || ip === '') return { key: 'unknown', label: 'Unknown network' };
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    const net = `${String(a)}.${String(b)}.${String(c)}.0/24`;
    const kind =
      a === 127
        ? 'loopback'
        : a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
          ? 'private'
          : a === 100 && b >= 64 && b <= 127
            ? 'CGNAT / tailnet'
            : 'public';
    return { key: net, label: `${net} (${kind})` };
  }
  if (ip.includes(':')) {
    const parts = ip.split('%')[0]?.split(':') ?? [];
    const prefix = parts.slice(0, 4).join(':');
    const kind = /^f[cd]/i.test(ip)
      ? 'unique local'
      : /^fe80/i.test(ip)
        ? 'link local'
        : ip === '::1'
          ? 'loopback'
          : 'public';
    return { key: `${prefix}::/64`, label: `${prefix}::/64 (${kind})` };
  }
  return { key: 'unknown', label: 'Unknown network' };
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
      /** p17-worker-managed: the attempt id (diagnostics link), the version it started from and the updater's line. */
      readonly id: string;
      readonly fromVersion: string;
      readonly detail: string | null;
      readonly rollback: boolean;
      readonly hasDiagnostics: boolean;
    } | null;
    /**
     * p17-worker-managed: the version this machine ran before its current one (the target of "Önceki sürüme geri dön"),
     * when that release is still stored on the master; null otherwise.
     */
    readonly previousVersion: string | null;
  };
  readonly compatibility: readonly CompatCell[];
  /** p6-capacity-advice: which parallelism is in effect and why (panel vs the worker's local file). */
  readonly parallelism: ParallelismView;
  /** p6-capacity-advice: recommended parallel jobs from CPUs, RAM and measured peaks (null: facts unknown). */
  readonly advice: CapacityAdvice | null;
  /** p8-capacity-auto: suggest / auto mode with its bounds and current value (null: manual). */
  readonly capacityMode: {
    readonly mode: 'manual' | 'suggest' | 'auto';
    readonly slots: number | null;
    readonly min: number;
    readonly max: number;
    readonly suggestion: number | null;
  } | null;
  /**
   * p6-warm-caches: the worker's last CAPABILITIES.packageCaches (limit, sizes per project and package manager, last
   * eviction) and when it was reported; null for workers that never reported one (older releases).
   */
  readonly packageCaches: (PackageCacheReport & { readonly reportedAt: string }) | null;
  /**
   * p17-disk-selfclean: whether the worker cleans its own disk space (`disk-hygiene-v1`: the "Şimdi temizle" button)
   * and its last CAPABILITIES.diskHygiene (last run, next runs, what uses the space when it stayed low).
   */
  readonly diskHygiene: {
    readonly supported: boolean;
    readonly report: (DiskHygieneReport & { readonly reportedAt: string }) | null;
  };
  /**
   * p9-queue-priority: per-profile slots as the worker reports them (`profile-slots-v1`; null: not reported), the
   * profiles that run alone, running jobs per profile and the slots kept for urgent (Acil) jobs.
   */
  readonly queue: {
    readonly profileSlots: Readonly<Record<string, number>> | null;
    readonly exclusiveProfiles: readonly string[];
    readonly profileRunning: Readonly<Record<string, number>>;
    readonly urgentReserve: number;
    /** p11-fixes-a: no admin setting — the default reserve applies only from 3 usable slots on. */
    readonly urgentReserveAuto: boolean;
  };
}

interface Row {
  id: string;
  state: string;
  last_ip: string | null;
  sandbox_profiles: string[];
  sandbox_readiness: { profile?: unknown; ready?: unknown; runtimes?: unknown; reason?: unknown }[] | null;
  tools: { name?: unknown; version?: unknown }[];
  load: {
    cpuPercent: number;
    memoryFreeBytes: number;
    diskFreeBytes: number;
    workspaceDisk?: { freeBytes: number; minFreeBytes: number };
  } | null;
  max_parallel_jobs: number | null;
  capabilities_at: Date | null;
  caps_known: boolean;
  active: number;
  channel: string | null;
  target_version: string | null;
  runtimes: {
    runtime: string;
    version: string;
    installed: boolean;
    authenticated: string;
    pin_status: string;
    pinned_version: string | null;
    capabilities: Record<string, { status?: unknown }>;
    /** p17-runtime-verify: what the worker reports for evidence (null: an older worker). */
    adapter_version?: string | null;
    evidence_version?: string | null;
    declared?: Record<string, unknown> | null;
  }[];
  attempt: {
    id: string;
    to_version: string;
    from_version: string;
    status: string;
    reason: string | null;
    detail: string | null;
    rollback: boolean;
    has_diagnostics: boolean;
    at: string;
  } | null;
  previous_version: string | null;
  facts: Record<string, unknown> | null;
  config_report: unknown;
  config_generation: number | null;
  configured_max: unknown;
  package_caches: unknown;
  package_caches_at: Date | null;
  disk_hygiene: unknown;
  disk_hygiene_at: Date | null;
  features: unknown;
  profile_concurrency: unknown;
  exclusive_profiles: unknown;
  urgent_reserve: number | null;
  profile_running: Record<string, number> | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The parts of the stored worker config report this view needs (a malformed report counts as none). */
/** p14-login-status-consistency: the applied auth mode of one runtime from the worker's config report. */
export function jobAuthOf(raw: unknown, runtime: string): 'local-login' | 'secret-ref' | 'none' | undefined {
  const eff = rec(rec(raw)?.effective);
  if (eff === null) return undefined;
  const mode = rec(eff.runtimeAuth)?.[runtime];
  return mode === 'local-login' || mode === 'secret-ref' ? mode : mode === undefined ? 'none' : undefined;
}

function reportFacts(
  raw: unknown,
): { source: 'panel' | 'local'; generation: number; ceiling: number | null } | null {
  const r = rec(raw);
  if (r === null) return null;
  const source = r.source === 'panel' || r.source === 'local' ? r.source : null;
  const generation = num(r.generation);
  if (source === null || generation === null) return null;
  return { source, generation, ceiling: num(rec(r.ceiling)?.maxParallelJobs) };
}

export interface PolicyView {
  readonly assignedPolicy: string | null;
  readonly inSync: boolean;
  readonly effective: {
    readonly policy: string;
    readonly version: number;
    readonly stage: string;
    readonly document: RuntimePolicyDocument;
  } | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** p9-queue-priority: the machine list's per-profile slot facts (re-validated through profileFacts). */
function queueFacts(r: Row): WorkerOverview['queue'] {
  const f = profileFacts(r.features, r.profile_concurrency, r.exclusive_profiles, r.profile_running);
  const slots = f.profileConcurrency;
  return {
    profileSlots:
      slots === undefined
        ? null
        : Object.fromEntries(Object.entries(slots).filter((e): e is [string, number] => e[1] !== undefined)),
    exclusiveProfiles: f.exclusiveProfiles ?? [],
    profileRunning: r.profile_running ?? {},
    urgentReserve: r.urgent_reserve ?? DEFAULT_URGENT_RESERVE,
    urgentReserveAuto: r.urgent_reserve === null,
  };
}

export async function fleetOverview(
  db: Queryable,
  policyOf: (workerId: string) => Promise<PolicyView>,
): Promise<WorkerOverview[]> {
  const { rows } = await db.query<Row>(
    `SELECT w.id, w.state, w.last_ip, w.sandbox_profiles, w.sandbox_readiness, w.tools, w.load, w.max_parallel_jobs,
            w.capabilities_at,
            (w.capabilities_at IS NOT NULL AND w.connected_at IS NOT NULL AND w.capabilities_at >= w.connected_at)
              AS caps_known,
            (SELECT count(*)::int FROM leases l WHERE l.worker_id = w.id AND l.released_at IS NULL) AS active,
            t.channel, t.target_version,
            COALESCE((SELECT json_agg(json_build_object('runtime', r.runtime, 'version', r.version,
                        'installed', r.installed, 'authenticated', r.authenticated, 'pin_status', r.pin_status,
                        'pinned_version', r.pinned_version, 'capabilities', r.capabilities,
                        'adapter_version', r.adapter_version, 'declared', r.declared_capabilities,
                        'evidence_version', r.evidence_version))
                        FROM worker_runtimes r WHERE r.worker_id = w.id AND r.present), '[]'::json) AS runtimes,
            (SELECT json_build_object('id', a.id, 'to_version', a.to_version, 'from_version', a.from_version,
                                      'status', a.status, 'reason', a.reason, 'detail', a.detail,
                                      'rollback', a.rollback, 'has_diagnostics', a.diagnostics IS NOT NULL,
                                      'at', COALESCE(a.finished_at, a.updated_at))
               FROM worker_update_attempts a WHERE a.worker_id = w.id ORDER BY a.created_at DESC LIMIT 1) AS attempt,
            (SELECT a.from_version FROM worker_update_attempts a JOIN worker_releases rel ON rel.version = a.from_version
              WHERE a.worker_id = w.id AND a.status = 'succeeded' AND a.to_version = w.worker_version
                AND a.from_version <> w.worker_version
              ORDER BY a.created_at DESC LIMIT 1) AS previous_version,
            w.facts, w.config_report, c.generation AS config_generation, v.spec->'maxParallelJobs' AS configured_max,
            w.package_caches, w.package_caches_at, w.disk_hygiene, w.disk_hygiene_at,
            w.features, w.profile_concurrency, w.exclusive_profiles, w.urgent_reserve,
            (SELECT json_object_agg(x.profile, x.n) FROM (
               SELECT COALESCE(j.spec->>'sandboxProfile', 'container') AS profile, count(*)::int AS n
                 FROM leases l JOIN jobs j ON j.id = l.job_id
                WHERE l.worker_id = w.id AND l.released_at IS NULL GROUP BY 1) x) AS profile_running
       FROM workers w LEFT JOIN worker_update_targets t ON t.worker_id = w.id
       LEFT JOIN worker_configs c ON c.worker_id = w.id
       LEFT JOIN worker_config_versions v ON v.worker_id = w.id AND v.generation = c.generation
      WHERE w.state <> 'pending' AND w.archived_at IS NULL
      ORDER BY w.display_name, w.id`,
  );
  // p14-web-perf (docs/design/p14-web-perf.md §6): memory, capacity modes and every machine's runtime policy are
  // independent reads — they run in parallel instead of one machine after the other (the Machines screen polls this
  // every 5 s, the home every 30 s). The output order (the query's) is unchanged.
  const [memory, modes, policies, verified] = await Promise.all([
    workerMemory(db),
    capacitySummaries(db),
    Promise.all(rows.map((r) => (r.state === 'quarantined' ? Promise.resolve(null) : policyOf(r.id)))),
    // p17-runtime-verify: master-side evidence lifts `unverified` capabilities of the exact tuple (cached; this route
    // is polled every few seconds and the index changes only when evidence is stored).
    cachedVerifiedIndex(db),
  ]);
  const fleet = fleetPeaks(memory.values());
  const out: WorkerOverview[] = [];
  for (const [i, r] of rows.entries()) {
    const quarantined = r.state === 'quarantined';
    const p = quarantined ? null : (policies[i] ?? null);
    const os = typeof r.facts?.os === 'string' ? r.facts.os : null;
    const arch = typeof r.facts?.arch === 'string' ? r.facts.arch : null;
    const runtimes: RuntimeFact[] = r.runtimes.map((x) => ({
      runtime: x.runtime,
      version: x.version,
      installed: x.installed,
      authenticated: x.authenticated,
      pinStatus: x.pin_status,
      pinnedVersion: x.pinned_version,
      capabilities: overlaidCapabilities(
        {
          runtime: x.runtime,
          version: x.version,
          os,
          arch,
          adapterVersion: x.adapter_version ?? null,
          evidenceVersion: x.evidence_version ?? null,
          declared: x.declared ?? null,
          capabilities: x.capabilities,
        },
        verified,
      ),
    }));
    const eff = p?.effective ?? null;
    out.push({
      id: r.id,
      capacity: { running: r.active, max: r.max_parallel_jobs },
      queue: queueFacts(r),
      capabilitiesAt: r.capabilities_at === null ? null : r.capabilities_at.toISOString(),
      sandboxProfiles: r.sandbox_profiles,
      sandboxReadiness: (r.sandbox_readiness ?? []).flatMap((s) => {
        const profile = str(s.profile);
        if (profile === null || typeof s.ready !== 'boolean') return [];
        return [
          {
            profile,
            ready: s.ready,
            runtimes: Array.isArray(s.runtimes)
              ? s.runtimes.filter((x): x is string => typeof x === 'string')
              : null,
            reason: str(s.reason),
          },
        ];
      }),
      tools: r.tools.flatMap((t) => {
        const name = str(t.name);
        return name === null ? [] : [{ name, version: str(t.version) ?? '' }];
      }),
      load: r.load,
      network: networkGroup(r.last_ip),
      runtimePolicy: {
        assigned: p?.assignedPolicy ?? null,
        effective: eff?.policy ?? null,
        version: eff?.version ?? null,
        stage: eff?.stage ?? null,
        inSync: p?.inSync ?? false,
      },
      release: {
        channel: r.channel ?? 'stable',
        targetVersion: r.target_version,
        lastAttempt:
          r.attempt === null
            ? null
            : {
                toVersion: r.attempt.to_version,
                status: r.attempt.status,
                reason: r.attempt.reason,
                at: new Date(r.attempt.at).toISOString(),
                id: r.attempt.id,
                fromVersion: r.attempt.from_version,
                detail: r.attempt.detail,
                rollback: r.attempt.rollback,
                hasDiagnostics: r.attempt.has_diagnostics,
              },
        previousVersion: r.previous_version,
      },
      compatibility: RuntimeKind.options.map((rt) =>
        compatibility(
          rt,
          { capabilitiesKnown: r.capabilities_at !== null, runtimes },
          eff === null ? null : { name: eff.policy, version: eff.version, document: eff.document },
          jobAuthOf(r.config_report, rt),
        ),
      ),
      parallelism: parallelismView({
        effective: r.max_parallel_jobs,
        configured:
          r.config_generation === null || num(r.configured_max) === null
            ? null
            : { generation: r.config_generation, maxParallelJobs: num(r.configured_max) ?? 0 },
        report: reportFacts(r.config_report),
      }),
      advice: recommendParallelism({
        cpuCount: num(r.facts?.cpuCount),
        memoryBytes: num(r.facts?.memoryBytes),
        installed: runtimes.flatMap((x) => {
          const k = RuntimeKind.safeParse(x.runtime);
          return x.installed && k.success ? [k.data] : [];
        }),
        measured: memory.get(r.id) ?? [],
        fleetPeaks: fleet,
      }),
      capacityMode: modes.get(r.id) ?? null,
      packageCaches: (() => {
        const report = storedCacheReport(r.package_caches);
        return report === null || r.package_caches_at === null
          ? null
          : { ...report, reportedAt: r.package_caches_at.toISOString() };
      })(),
      diskHygiene: storedDiskHygiene(r.features, r.disk_hygiene, r.disk_hygiene_at),
    });
  }
  return out;
}

/** Worker lifecycle events shown on the Fleet timeline (audit actions; metadata limited to these keys). */
const HISTORY_ACTIONS = [
  'worker.pairing.request',
  'worker.approve',
  'worker.deny',
  'worker.session.start',
  'worker.session.end',
  'worker.drain',
  'worker.revoke',
  'worker.archive',
  'worker.unarchive',
  'worker.rename',
  'worker.rotate.request',
  'worker.rotate',
  'worker.rotate.approve',
  'worker.runtime_policy.assign',
  'worker.update.offer',
  'worker.update.target',
] as const;
const SAFE_KEYS = [
  'reason',
  'code',
  'workerVersion',
  'protocolVersion',
  'policy',
  'version',
  'toVersion',
  'channel',
  // p15-chat-cards-scroll: a rename's old and new machine name.
  'from',
  'to',
];

export interface HistoryEntry {
  readonly at: string;
  readonly action: string;
  readonly outcome: string;
  readonly actor: { readonly type: string; readonly id: string | null };
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export async function workerHistory(db: Queryable, workerId: string, limit = 100): Promise<HistoryEntry[]> {
  const { rows } = await db.query<{
    occurred_at: Date;
    action: string;
    outcome: string;
    actor_type: string;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT occurred_at, action, outcome, actor_type, actor_id, metadata FROM audit_events
      WHERE target IN ($1, $2) AND action = ANY($3) ORDER BY id DESC LIMIT $4`,
    [workerId, `worker:${workerId}`, [...HISTORY_ACTIONS], limit],
  );
  return rows.map((r) => {
    const detail: Record<string, string | number | boolean> = {};
    for (const k of SAFE_KEYS) {
      const v = r.metadata[k];
      if (typeof v === 'string') detail[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') detail[k] = v;
    }
    return {
      at: r.occurred_at.toISOString(),
      action: r.action,
      outcome: r.outcome,
      actor: { type: r.actor_type, id: r.actor_type === 'user' ? null : r.actor_id },
      detail,
    };
  });
}

/** p17-disk-selfclean: the stored CAPABILITIES.diskHygiene, re-validated (a malformed report counts as none). */
export function storedDiskHygiene(
  features: unknown,
  raw: unknown,
  at: Date | null,
): WorkerOverview['diskHygiene'] {
  const supported = Array.isArray(features) && features.includes(DISK_HYGIENE_FEATURE);
  const parsed = raw === null || raw === undefined ? null : DiskHygieneReport.safeParse(raw);
  return {
    supported,
    report: parsed?.success === true && at !== null ? { ...parsed.data, reportedAt: at.toISOString() } : null,
  };
}
