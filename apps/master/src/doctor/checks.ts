import { DiskHygieneReport, type DoctorFinding, type DoctorSeverity } from '@remyral/protocol';
import { loadMigrations } from '../db/migrate.js';
import type { Pool } from '../db/pool.js';
import type { RedisClient } from '../redis.js';
import type { LogStore } from '../system/logs.js';
import type { SystemStatus } from '../system/status.js';

/**
 * p16-doctor (docs/design/p16-doctor.md §2): the master's named checks. Each check reads what the master already has
 * (Postgres, Redis, the status snapshot, the expiry registry, the cost brake, the chat routing, the log store) and
 * returns findings — one `ok` finding when nothing is wrong, else one finding per problem (capped per check) with a
 * severity, the English text, a suggested fix and the console page or guide section that fixes it. A check that throws
 * becomes one `check_failed` finding; it never fails the run.
 *
 * `light` checks (the daily run) call nothing outside the master; the full run adds the integrations' last tests, the
 * machines' runtime / sandbox / git / release state, the version feed, the clock skew and error bursts.
 */

export interface ExpiryItemView {
  readonly id: string;
  readonly label: string;
  readonly name: string | null;
  readonly dueAt: string | null;
  readonly daysLeft: number | null;
  readonly state: string;
  readonly basis: string;
}

export interface DoctorSources {
  readonly pool: Pool;
  readonly redis: Pick<RedisClient, 'ping'>;
  readonly clock: () => Date;
  readonly status: () => Promise<SystemStatus | null>;
  readonly expiry: () => Promise<readonly ExpiryItemView[] | null>;
  readonly costBrake: () => Promise<{
    readonly mode: string;
    readonly blocking: boolean;
    readonly engaged: readonly { scope: string; window: string; percent: number; level: string }[];
  } | null>;
  readonly chat: () => Promise<Record<string, unknown> | null>;
  readonly backups: () => Promise<{
    readonly health: {
      readonly state: string;
      readonly reasons: readonly { level: string; code: string; message: string }[];
    };
  } | null>;
  readonly logs: () => LogStore | null;
  /**
   * p17-object-storage: where blobs go and whether that store answers (a HEAD of a key that does not exist: 404 =
   * reachable and authorised), the local blob directory's free space and the bytes still in Postgres. Absent: skipped.
   */
  readonly storage?: () => Promise<{
    readonly mode: 'local' | 's3';
    readonly problem: string | null;
    readonly probe: { readonly ok: boolean; readonly error: string | null; readonly ms: number } | null;
    readonly local: { readonly freeBytes: number | null; readonly totalBytes: number | null };
    readonly legacyBytes: number;
  } | null>;
  /** The migrations shipped with this build (default: apps/master/migrations). */
  readonly migrationsDir?: string;
}

export interface CheckSpec {
  readonly id: string;
  readonly light: boolean;
  readonly run: (s: DoctorSources) => Promise<DoctorFinding[]>;
}

const GUIDE = 'docs/guide/tr/tanilama.md';
const MAX_PER_CHECK = 12;

function f(
  check: string,
  code: string,
  severity: DoctorSeverity,
  message: string,
  extra: { fix?: string; docs?: string; params?: DoctorFinding['params']; subject?: string } = {},
): DoctorFinding {
  return {
    check,
    code,
    severity,
    message: message.slice(0, 500),
    ...(extra.fix === undefined ? {} : { fix: extra.fix.slice(0, 500) }),
    ...(extra.docs === undefined ? {} : { docs: extra.docs }),
    ...(extra.params === undefined ? {} : { params: extra.params }),
    ...(extra.subject === undefined ? {} : { subject: extra.subject.slice(0, 120) }),
  };
}

const ok = (check: string, message: string, params?: DoctorFinding['params']): DoctorFinding[] => [
  f(check, 'ok', 'ok', message, params === undefined ? {} : { params }),
];

/** At most MAX_PER_CHECK findings; the rest summarised in the last one. */
function capped(check: string, list: DoctorFinding[]): DoctorFinding[] {
  if (list.length <= MAX_PER_CHECK) return list;
  const rest = list.length - (MAX_PER_CHECK - 1);
  const worst = list.slice(MAX_PER_CHECK - 1).some((x) => x.severity === 'error') ? 'error' : 'warning';
  return [
    ...list.slice(0, MAX_PER_CHECK - 1),
    f(check, 'more', worst, `${String(rest)} more of the same kind`, { params: { n: rest } }),
  ];
}

async function timed<T>(p: () => Promise<T>, ms: number): Promise<{ v: T; ms: number }> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const v = await Promise.race([
      p(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, ms);
      }),
    ]);
    return { v, ms: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

const errName = (e: unknown): string =>
  e instanceof Error && e.message === 'timeout' ? 'timeout' : 'unreachable';

const ageMin = (now: Date, d: Date | null): number =>
  d === null ? 0 : Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));

/** Numeric-aware version comparison (`1.0.74` > `1.0.9`); null when either is not a dotted version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (pa === null || pb === null) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------ control plane

const dbReachable: CheckSpec = {
  id: 'db.reachable',
  light: true,
  async run(s) {
    try {
      const r = await timed(() => s.pool.query('SELECT 1'), 3_000);
      if (r.ms > 500)
        return [
          f('db.reachable', 'slow', 'warning', `Postgres answered in ${String(r.ms)} ms (slow)`, {
            fix: 'Check the database host load, connections and disk; see Ayarlar → Sistem durumu.',
            docs: '/settings/system',
            params: { ms: r.ms },
          }),
        ];
      return ok('db.reachable', `Postgres answers (${String(r.ms)} ms)`, { ms: r.ms });
    } catch (e) {
      return [
        f('db.reachable', errName(e), 'error', 'Postgres does not answer', {
          fix: 'Check that the database container runs and DATABASE_URL points at it.',
          docs: `${GUIDE}#veritabani`,
        }),
      ];
    }
  },
};

const redisReachable: CheckSpec = {
  id: 'redis.reachable',
  light: true,
  async run(s) {
    try {
      const r = await timed(() => s.redis.ping(), 3_000);
      if (r.ms > 500)
        return [
          f('redis.reachable', 'slow', 'warning', `Redis answered in ${String(r.ms)} ms (slow)`, {
            fix: 'Check the Redis container memory and the host load.',
            docs: '/settings/system',
            params: { ms: r.ms },
          }),
        ];
      return ok('redis.reachable', `Redis answers (${String(r.ms)} ms)`, { ms: r.ms });
    } catch (e) {
      return [
        f('redis.reachable', errName(e), 'error', 'Redis does not answer', {
          fix: 'Check that the Redis container runs and REDIS_URL points at it.',
          docs: `${GUIDE}#redis`,
        }),
      ];
    }
  },
};

const migrations: CheckSpec = {
  id: 'db.migrations',
  light: true,
  async run(s) {
    const files = await loadMigrations(s.migrationsDir);
    const { rows } = await s.pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const shipped = new Set(files.map((m) => m.version));
    const pending = files.filter((m) => !applied.has(m.version)).map((m) => m.version);
    const unknown = rows.map((r) => r.version).filter((v) => !shipped.has(v));
    const out: DoctorFinding[] = [];
    if (pending.length > 0)
      out.push(
        f(
          'db.migrations',
          'pending',
          'error',
          `${String(pending.length)} database migration(s) not applied (${pending.slice(0, 5).join(', ')})`,
          {
            fix: 'Restart the master: it applies pending migrations at start. If it fails, its log says which one.',
            docs: `${GUIDE}#gocler`,
            params: { n: pending.length, first: pending[0] ?? '' },
          },
        ),
      );
    if (unknown.length > 0)
      out.push(
        f(
          'db.migrations',
          'newer_database',
          'warning',
          `The database has ${String(unknown.length)} migration(s) this master does not know (a newer release ran here)`,
          {
            fix: 'Deploy the release that matches the database; downgrading the master is not supported.',
            docs: `${GUIDE}#gocler`,
            params: { n: unknown.length },
          },
        ),
      );
    const latest = files.at(-1)?.version ?? '';
    return out.length > 0
      ? out
      : ok('db.migrations', `All migrations applied (latest ${latest})`, { latest });
  },
};

const disk: CheckSpec = {
  id: 'disk',
  light: true,
  async run(s) {
    const st = await s.status();
    if (st === null || st.disk.length === 0)
      return [f('disk', 'unknown', 'info', 'Disk use is not measurable here')];
    const out: DoctorFinding[] = [];
    for (const d of st.disk) {
      if (d.state === 'ok') continue;
      out.push(
        f(
          'disk',
          d.state === 'failing' ? 'full' : 'low',
          d.state === 'failing' ? 'error' : 'warning',
          `${d.id === 'data' ? 'Host data volume' : 'Docker disk'} is ${String(d.usedPercent)} % full`,
          {
            fix:
              d.id === 'data'
                ? 'Free space on the host data volume (old backups, logs) or grow the disk.'
                : 'Remove unused Docker images and build cache on the host (docker system prune) or grow the disk.',
            docs: `${GUIDE}#disk`,
            params: { disk: d.id, percent: d.usedPercent, freeBytes: d.freeBytes },
            subject: d.id,
          },
        ),
      );
    }
    return out.length > 0 ? out : ok('disk', 'Enough free disk on the master host');
  },
};

/** p17-object-storage: the blob store answers; enough room in the local blob directory; nothing left in Postgres. */
const storage: CheckSpec = {
  id: 'storage',
  light: false,
  async run(s) {
    const st = s.storage === undefined ? null : await s.storage();
    if (st === null) return [f('storage', 'unknown', 'info', 'Storage is not measurable here')];
    const out: DoctorFinding[] = [];
    const docs = 'docs/guide/tr/depolama.md';
    if (st.mode === 's3' && st.problem !== null) {
      out.push(
        f('storage', 'unusable', 'error', `Object storage is selected but not usable: ${st.problem}`, {
          fix: 'Enter the bucket settings and keys again in Settings → Integrations → Storage, or switch to local disk.',
          docs,
        }),
      );
    } else if (st.probe !== null && !st.probe.ok) {
      out.push(
        f(
          'storage',
          'unreachable',
          'error',
          `Object storage does not answer (${st.probe.error ?? 'error'})`,
          {
            fix: 'Run "Test connection" in Settings → Integrations → Storage; check the endpoint, the keys and the bucket policy.',
            docs,
            params: { error: st.probe.error ?? 'error' },
          },
        ),
      );
    }
    const free = st.local.freeBytes;
    const total = st.local.totalBytes;
    if (free !== null && total !== null && total > 0) {
      const pct = Math.round(((total - free) / total) * 100);
      const gib = 1024 * 1024 * 1024;
      if (st.mode === 'local' && (free < 2 * gib || pct >= 95)) {
        out.push(
          f(
            'storage',
            'local_full',
            'error',
            `The blob directory has ${String(Math.round(free / (1024 * 1024)))} MiB free`,
            {
              fix: 'Grow the blob volume, lower the retention of projects, or move outputs to object storage.',
              docs,
              params: { freeMiB: Math.round(free / (1024 * 1024)), percent: pct },
            },
          ),
        );
      } else if (st.mode === 'local' && (free < 10 * gib || pct >= 85)) {
        out.push(
          f(
            'storage',
            'local_low',
            'warning',
            `The blob directory has ${String(Math.round(free / (1024 * 1024)))} MiB free`,
            {
              fix: 'Plan more room for large outputs (grow the volume, retention per project, or object storage).',
              docs,
              params: { freeMiB: Math.round(free / (1024 * 1024)), percent: pct },
            },
          ),
        );
      }
    }
    if (st.legacyBytes > 0) {
      out.push(
        f(
          'storage',
          'legacy_bytes',
          'info',
          `${String(Math.round(st.legacyBytes / (1024 * 1024)))} MiB of files are still in the database`,
          {
            fix: 'Run `remyral-master blobs:migrate` on the master (it moves them to the blob store and verifies each one).',
            docs,
            params: { mib: Math.round(st.legacyBytes / (1024 * 1024)) },
          },
        ),
      );
    }
    return out.length > 0
      ? out
      : ok(
          'storage',
          st.mode === 's3' ? 'Object storage answers' : 'The blob directory has enough free disk',
          {
            mode: st.mode,
          },
        );
  },
};

const web: CheckSpec = {
  id: 'master.web',
  light: true,
  async run(s) {
    const st = await s.status();
    const w = st?.components.find((c) => c.id === 'web');
    if (w === undefined || w.state === 'unknown')
      return [
        f('master.web', 'not_probed', 'info', 'The web container is not probed (STATUS_WEB_URL unset)'),
      ];
    if (w.state === 'failing')
      return [
        f('master.web', 'failing', 'error', `The web container does not answer (${w.code ?? 'failing'})`, {
          fix: 'Check the web container in Coolify (restart it) and the proxy network.',
          docs: '/settings/system',
          params: { code: w.code ?? '' },
        }),
      ];
    return ok('master.web', 'The web container answers');
  },
};

// ------------------------------------------------------------------------------------------------ queue

const queueBacklog: CheckSpec = {
  id: 'queue.backlog',
  light: true,
  async run(s) {
    const st = await s.status();
    const q = st?.queue ?? null;
    if (q === null) return [f('queue.backlog', 'unknown', 'info', 'The queue could not be read')];
    const min = Math.round(q.oldestQueuedSec / 60);
    if (q.queued > 0 && q.oldestQueuedSec >= 300)
      return [
        f(
          'queue.backlog',
          'waiting',
          q.oldestQueuedSec >= 3600 ? 'error' : 'warning',
          `${String(q.queued)} job(s) queued; the oldest waits for ${String(min)} min`,
          {
            fix: "Check that a machine with the job's runtime and sandbox is online and has free slots (Makineler); the job page says why it waits.",
            docs: q.oldestQueuedJobId === null ? '/machines' : `/jobs/${q.oldestQueuedJobId}`,
            params: { n: q.queued, minutes: min },
            ...(q.oldestQueuedJobId === null ? {} : { subject: q.oldestQueuedJobId }),
          },
        ),
      ];
    return ok('queue.backlog', `${String(q.queued)} queued, ${String(q.running)} running`, {
      queued: q.queued,
      running: q.running,
    });
  },
};

const queueStuck: CheckSpec = {
  id: 'queue.stuck',
  light: true,
  async run(s) {
    const now = s.clock();
    const { rows } = await s.pool.query<{ id: string; state: string; since: Date; expired: Date | null }>(
      `SELECT j.id, j.state::text AS state, j.state_changed_at AS since, l.expires_at AS expired
         FROM jobs j
         LEFT JOIN leases l ON l.job_id = j.id AND l.released_at IS NULL
        WHERE j.state IN ('RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'CANCELLING')
          AND ((l.id IS NOT NULL AND l.expires_at < $1::timestamptz - interval '2 minutes')
               OR (l.id IS NULL AND j.state IN ('RESERVED', 'STARTING', 'RUNNING')
                   AND j.state_changed_at < $1::timestamptz - interval '10 minutes')
               OR (j.state = 'CANCELLING' AND j.state_changed_at < $1::timestamptz - interval '30 minutes'))
        ORDER BY j.state_changed_at LIMIT 50`,
      [now],
    );
    if (rows.length === 0) return ok('queue.stuck', 'No job is stuck');
    return capped(
      'queue.stuck',
      rows.map((r) =>
        f(
          'queue.stuck',
          r.expired === null ? 'no_lease' : 'lease_expired',
          'warning',
          `Job ${r.id} is ${r.state} for ${String(ageMin(now, r.since))} min ${r.expired === null ? 'without a lease' : 'with an expired lease'}`,
          {
            fix: 'The lease sweeper should requeue it; if it stays, check its machine (offline?) and cancel or retry the job from its page.',
            docs: `/jobs/${r.id}`,
            params: { state: r.state, minutes: ageMin(now, r.since) },
            subject: r.id,
          },
        ),
      ),
    );
  },
};

const approvalOrphans: CheckSpec = {
  id: 'queue.approval_orphan',
  light: true,
  async run(s) {
    const now = s.clock();
    const { rows } = await s.pool.query<{ id: string; since: Date }>(
      `SELECT j.id, j.state_changed_at AS since FROM jobs j
        WHERE j.state = 'AWAITING_APPROVAL' AND j.state_changed_at < $1::timestamptz - interval '30 minutes'
          AND NOT EXISTS (SELECT 1 FROM approval_requests a WHERE a.job_id = j.id AND a.status = 'pending')
        ORDER BY j.state_changed_at LIMIT 50`,
      [now],
    );
    if (rows.length === 0)
      return ok('queue.approval_orphan', 'Every job waiting for approval has something to decide');
    return capped(
      'queue.approval_orphan',
      rows.map((r) =>
        f(
          'queue.approval_orphan',
          'nothing_to_decide',
          'warning',
          `Job ${r.id} waits for an approval for ${String(ageMin(now, r.since))} min, but no approval request is open`,
          {
            fix: 'Open the job: approve or reject its result there, or cancel it. Report it if no button helps.',
            docs: `/jobs/${r.id}`,
            params: { minutes: ageMin(now, r.since) },
            subject: r.id,
          },
        ),
      ),
    );
  },
};

const leasesExpired: CheckSpec = {
  id: 'queue.leases_expired',
  light: true,
  async run(s) {
    const { rows } = await s.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL AND expires_at < $1::timestamptz - interval '2 minutes'`,
      [s.clock()],
    );
    const n = rows[0]?.n ?? 0;
    if (n === 0) return ok('queue.leases_expired', 'No expired lease is left open');
    return [
      f('queue.leases_expired', 'open', 'warning', `${String(n)} expired lease(s) are still open`, {
        fix: 'The lease sweeper releases them every few seconds; if the number stays, the master log (component orchestrator) says why.',
        docs: '/settings/system?tab=logs',
        params: { n },
      }),
    ];
  },
};

// ------------------------------------------------------------------------------------------------ machines

interface WorkerRow {
  id: string;
  name: string;
  state: string;
  last_seen_at: Date | null;
  worker_version: string;
  load: { workspaceDisk?: { freeBytes: number; minFreeBytes: number } } | null;
  sandbox_status: { profiles?: { profile: string; ready: boolean; reason?: string }[] } | null;
  git_readiness: {
    git?: { present?: boolean };
    problems?: { code: string; severity: string; fix?: string }[];
  } | null;
  clock_skew_ms: number | null;
  clock_skew_at: Date | null;
  disk_hygiene: unknown;
}

async function workers(s: DoctorSources): Promise<WorkerRow[]> {
  const { rows } = await s.pool.query<WorkerRow>(
    `SELECT id, COALESCE(label, display_name) AS name, state, last_seen_at, worker_version, load, sandbox_status,
            git_readiness, clock_skew_ms, clock_skew_at, disk_hygiene
       FROM workers
      WHERE state NOT IN ('pending', 'quarantined') AND archived_at IS NULL
      ORDER BY id`,
  );
  return rows;
}

const machineLink = (id: string, tab?: string): string =>
  `/machines/${id}${tab === undefined ? '' : `?tab=${tab}`}`;

const workersOffline: CheckSpec = {
  id: 'workers.offline',
  light: true,
  async run(s) {
    const now = s.clock();
    const all = await workers(s);
    if (all.length === 0)
      return [
        f('workers.offline', 'none', 'warning', 'No machine is paired: jobs cannot run', {
          fix: 'Add a machine in Makineler → Makine ekle and approve its pairing.',
          docs: '/machines',
        }),
      ];
    const off = all.filter(
      (w) =>
        w.state === 'offline' ||
        w.last_seen_at === null ||
        now.getTime() - w.last_seen_at.getTime() > 120_000,
    );
    if (off.length === 0)
      return ok('workers.offline', `All ${String(all.length)} machine(s) are online`, { n: all.length });
    const out = off.map((w) =>
      f(
        'workers.offline',
        'offline',
        off.length === all.length ? 'error' : 'warning',
        `Machine ${w.name} is offline${w.last_seen_at === null ? '' : ` (last seen ${String(ageMin(now, w.last_seen_at))} min ago)`}`,
        {
          fix: 'Check the machine is on and online; run `remyral-worker doctor` on it (it works without the master) and restart the worker service.',
          docs: machineLink(w.id),
          params: { name: w.name, minutes: ageMin(now, w.last_seen_at) },
          subject: w.id,
        },
      ),
    );
    return capped('workers.offline', out);
  },
};

const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** p17-disk-selfclean: the largest top-level directory of a still-low worker's usage report. */
function largestUsage(usage: DiskHygieneReport['usage']): { name: string; bytes: number } | null {
  if (usage === null) return null;
  const all = [
    ...usage.dataDir.filter((e) => e.name !== 'workspace-root'),
    ...usage.workspaceRoot.map((e) => ({ name: `workspace/${e.name}`, bytes: e.bytes })),
  ];
  const top = all.sort((a, b) => b.bytes - a.bytes)[0];
  return top === undefined ? null : top;
}

const workersDisk: CheckSpec = {
  id: 'workers.disk',
  light: true,
  async run(s) {
    const out: DoctorFinding[] = [];
    for (const w of await workers(s)) {
      const d = w.load?.workspaceDisk;
      if (d === undefined) continue;
      // p17-disk-selfclean: a worker that cleaned its own disk and is still low says what uses the space.
      const hygiene = DiskHygieneReport.safeParse(w.disk_hygiene);
      const run = hygiene.success ? hygiene.data.lastRun : null;
      const largest = hygiene.success ? largestUsage(hygiene.data.usage) : null;
      if (d.freeBytes < d.minFreeBytes && run?.stillLow === true && largest !== null)
        out.push(
          f(
            'workers.disk',
            'disk_low_after_cleanup',
            'error',
            `Machine ${w.name} is below its minimum free disk even after its own cleanup (${String(mib(run.freedBytes))} MiB freed); the most space is used by ${largest.name} (${String(mib(largest.bytes))} MiB)`,
            {
              fix: 'The worker removed everything it may (caches, old versions, logs, expired files). See the machine page for the space per directory; free space outside the worker data or grow the disk, or lower workspace.minFreeBytes.',
              docs: machineLink(w.id),
              params: {
                name: w.name,
                freedMiB: mib(run.freedBytes),
                largest: largest.name,
                largestMiB: mib(largest.bytes),
              },
              subject: w.id,
            },
          ),
        );
      else if (d.freeBytes < d.minFreeBytes)
        out.push(
          f(
            'workers.disk',
            'disk_low',
            'error',
            `Machine ${w.name} is below its minimum free disk: no job is placed there`,
            {
              fix: 'Run the cleanup on the machine page (Disk cleanup → Clean now), free space under the workspace root (Makineler → Dosyalar: kept working directories) or lower workspace.minFreeBytes.',
              docs: machineLink(w.id),
              params: { name: w.name, freeBytes: d.freeBytes, minFreeBytes: d.minFreeBytes },
              subject: w.id,
            },
          ),
        );
      else if (d.freeBytes < d.minFreeBytes * 2)
        out.push(
          f('workers.disk', 'disk_tight', 'warning', `Machine ${w.name} is close to its minimum free disk`, {
            fix: 'Free space under the workspace root before jobs are refused.',
            docs: machineLink(w.id),
            params: { name: w.name, freeBytes: d.freeBytes, minFreeBytes: d.minFreeBytes },
            subject: w.id,
          }),
        );
    }
    return out.length > 0
      ? capped('workers.disk', out)
      : ok('workers.disk', 'Every machine has enough free disk');
  },
};

const workersOutdated: CheckSpec = {
  id: 'workers.outdated',
  light: false,
  async run(s) {
    const { rows } = await s.pool.query<{ version: string }>(
      "SELECT version FROM worker_release_channels WHERE channel = 'stable'",
    );
    const stable = rows[0]?.version ?? null;
    if (stable === null)
      return [f('workers.outdated', 'no_release', 'info', 'No stable worker release is published')];
    const out: DoctorFinding[] = [];
    for (const w of await workers(s)) {
      const c = compareVersions(w.worker_version, stable);
      if (c !== null && c < 0)
        out.push(
          f(
            'workers.outdated',
            'outdated',
            'info',
            `Machine ${w.name} runs worker ${w.worker_version}; ${stable} is released`,
            {
              fix: 'The machine updates itself when the rollout reaches it; see Ayarlar → Worker sürümleri.',
              docs: '/settings/releases',
              params: { name: w.name, version: w.worker_version, stable },
              subject: w.id,
            },
          ),
        );
    }
    return out.length > 0
      ? capped('workers.outdated', out)
      : ok('workers.outdated', `Every machine runs the released worker (${stable})`, { stable });
  },
};

const workersLogin: CheckSpec = {
  id: 'workers.login',
  light: false,
  async run(s) {
    const { rows } = await s.pool.query<{ id: string; name: string; runtime: string }>(
      `SELECT DISTINCT w.id, COALESCE(w.label, w.display_name) AS name, r.runtime
         FROM worker_runtimes r JOIN workers w ON w.id = r.worker_id
        WHERE r.present AND r.installed AND r.authenticated = 'no'
          AND w.state NOT IN ('pending', 'quarantined') AND w.archived_at IS NULL
        ORDER BY w.id, r.runtime LIMIT 60`,
    );
    if (rows.length === 0) return ok('workers.login', 'Every installed runtime is signed in');
    return capped(
      'workers.login',
      rows.map((r) =>
        f(
          'workers.login',
          'not_signed_in',
          'warning',
          `${r.runtime} on ${r.name} is installed but not signed in`,
          {
            fix: 'Sign it in from Makineler → <makine> → Çalıştırıcılar (Giriş yap) or give it an API key credential.',
            docs: machineLink(r.id, 'runtimes'),
            params: { name: r.name, runtime: r.runtime },
            subject: `${r.id}:${r.runtime}`,
          },
        ),
      ),
    );
  },
};

const workersSandbox: CheckSpec = {
  id: 'workers.sandbox',
  light: false,
  async run(s) {
    const out: DoctorFinding[] = [];
    for (const w of await workers(s)) {
      const profiles = w.sandbox_status?.profiles ?? null;
      if (profiles === null || profiles.length === 0) continue;
      if (!profiles.some((p) => p.ready))
        out.push(
          f('workers.sandbox', 'none_ready', 'error', `No sandbox profile is ready on ${w.name}`, {
            fix: 'Open Makineler → <makine> → Sandbox & policy and run "Hazırla" (prepare).',
            docs: machineLink(w.id, 'sandbox'),
            params: { name: w.name },
            subject: w.id,
          }),
        );
    }
    return out.length > 0
      ? capped('workers.sandbox', out)
      : ok('workers.sandbox', 'Every machine has a ready sandbox profile');
  },
};

const workersGit: CheckSpec = {
  id: 'workers.git',
  light: false,
  async run(s) {
    const out: DoctorFinding[] = [];
    for (const w of await workers(s)) {
      const g = w.git_readiness;
      if (g === null) continue;
      if (g.git?.present === false)
        out.push(
          f(
            'workers.git',
            'git_missing',
            'error',
            `git is not installed on ${w.name}: repository jobs cannot run`,
            {
              fix: 'Install git (Makineler → <makine> → Araçlar: MinGit on Windows) or set gitBinary.',
              docs: machineLink(w.id, 'tools'),
              params: { name: w.name },
              subject: w.id,
            },
          ),
        );
      const blocking = (g.problems ?? []).filter((p) => p.severity === 'blocking');
      if (blocking.length > 0)
        out.push(
          f(
            'workers.git',
            'git_problems',
            'warning',
            `git on ${w.name} has ${String(blocking.length)} blocking problem(s) (${blocking.map((p) => p.code).join(', ')})`,
            {
              fix: 'Open Makineler → <makine> → Git and press "Düzelt" (safe fixes), or follow the listed steps.',
              docs: machineLink(w.id, 'git'),
              params: {
                name: w.name,
                n: blocking.length,
                codes: blocking
                  .map((p) => p.code)
                  .join(', ')
                  .slice(0, 200),
              },
              subject: w.id,
            },
          ),
        );
    }
    return out.length > 0 ? capped('workers.git', out) : ok('workers.git', 'git is ready on every machine');
  },
};

/** Worker clock against the master's (heartbeat timestamp; network latency included). */
export const SKEW_WARN_MS = 60_000;
export const SKEW_ERROR_MS = 120_000;

const workersClock: CheckSpec = {
  id: 'workers.clock',
  light: true,
  async run(s) {
    const now = s.clock();
    const out: DoctorFinding[] = [];
    for (const w of await workers(s)) {
      if (w.clock_skew_ms === null || w.clock_skew_at === null) continue;
      if (now.getTime() - w.clock_skew_at.getTime() > 30 * 60_000) continue;
      const abs = Math.abs(w.clock_skew_ms);
      if (abs < SKEW_WARN_MS) continue;
      const sec = Math.round(w.clock_skew_ms / 1000);
      out.push(
        f(
          'workers.clock',
          'skew',
          abs >= SKEW_ERROR_MS ? 'error' : 'warning',
          `The clock of ${w.name} is ${String(Math.abs(sec))} s ${sec > 0 ? 'behind' : 'ahead of'} the master`,
          {
            fix: 'Turn on automatic time sync (NTP) on the machine: leases, signed commands and logins depend on the clock.',
            docs: `${GUIDE}#saat`,
            params: { name: w.name, seconds: sec },
            subject: w.id,
          },
        ),
      );
    }
    return out.length > 0
      ? capped('workers.clock', out)
      : ok('workers.clock', 'Machine clocks agree with the master');
  },
};

// ------------------------------------------------------------------------------------------------ keys, integrations

const expiry: CheckSpec = {
  id: 'expiry',
  light: true,
  async run(s) {
    const items = await s.expiry();
    if (items === null)
      return [f('expiry', 'unknown', 'info', 'Key and certificate expiry is not available')];
    const out: DoctorFinding[] = [];
    for (const i of items) {
      const sev: DoctorSeverity | null =
        i.state === 'expired'
          ? 'error'
          : i.state === 'urgent'
            ? 'warning'
            : i.state === 'soon'
              ? 'info'
              : null;
      if (sev === null) continue;
      const what = i.name === null ? i.label : `${i.label} (${i.name})`;
      out.push(
        f(
          'expiry',
          i.state,
          sev,
          i.state === 'expired'
            ? `${what} ${i.basis === 'expires' ? 'has expired' : 'is overdue for rotation'}`
            : `${what} ${i.basis === 'expires' ? 'expires' : 'is due for rotation'} in ${String(i.daysLeft ?? 0)} day(s)`,
          {
            fix: 'Rotate it with its runbook (Ayarlar → Operasyon güvenliği → Anahtarlar ve süreler names it) and stamp "rotated".',
            docs: '/settings/ops-safety',
            params: { what: what.slice(0, 120), days: i.daysLeft ?? 0, dueAt: i.dueAt ?? '' },
            subject: i.id,
          },
        ),
      );
    }
    return out.length > 0 ? capped('expiry', out) : ok('expiry', 'No key, token or certificate expires soon');
  },
};

const integrations: CheckSpec = {
  id: 'integrations',
  light: false,
  async run(s) {
    const st = await s.status();
    const i = st?.integrations ?? null;
    // p16-git-providers: GitLab / Bitbucket connections and their last test (their token expiry is in `expiry`).
    const { rows: hosts } = await s.pool.query<{
      id: string;
      kind: string;
      label: string;
      ok: boolean | null;
      code: string | null;
    }>(
      `SELECT id::text AS id, kind, label, (last_test->>'ok')::boolean AS ok, last_test->>'code' AS code
         FROM git_host_connections ORDER BY label LIMIT 40`,
    );
    if (i === null && hosts.length === 0)
      return [f('integrations', 'none', 'info', 'No integration is connected')];
    const out: DoctorFinding[] = [];
    for (const g of hosts)
      if (g.ok === false)
        out.push(
          f(
            'integrations',
            'git_host_failing',
            'warning',
            `${g.kind === 'gitlab' ? 'GitLab' : 'Bitbucket'} connection ${g.label} failed its last test (${g.code ?? 'failed'})`,
            {
              fix: 'Test it again in Ayarlar → Entegrasyonlar; replace the token if it was revoked or lacks a scope.',
              docs: '/settings/integrations',
              params: { label: g.label, kind: g.kind, code: g.code ?? '' },
              subject: `githost:${g.id}`,
            },
          ),
        );
    if (i === null)
      return out.length > 0 ? out : ok('integrations', 'Connected integrations passed their last tests');
    for (const c of i.coolify)
      if (!c.usable || c.lastTestOk === false)
        out.push(
          f(
            'integrations',
            'coolify_failing',
            'warning',
            `Coolify connection ${c.label} ${c.usable ? 'failed its last test' : 'is not usable'}`,
            {
              fix: 'Test it again in Ayarlar → Entegrasyonlar → Coolify; replace the token if it was revoked.',
              docs: '/settings/integrations',
              params: { label: c.label },
              subject: `coolify:${c.id}`,
            },
          ),
        );
    if (i.cloudflare !== null && (!i.cloudflare.usable || i.cloudflare.lastTestOk === false))
      out.push(
        f('integrations', 'cloudflare_failing', 'warning', 'The Cloudflare token failed its last test', {
          fix: 'Test it in Ayarlar → Entegrasyonlar → Cloudflare; create a new token if it expired.',
          docs: '/settings/integrations',
          subject: 'cloudflare',
        }),
      );
    if (
      i.github !== null &&
      i.github.connected &&
      (i.github.keyUsable === false || i.github.missingPermissions > 0)
    )
      out.push(
        f(
          'integrations',
          'github_failing',
          'warning',
          i.github.keyUsable === false
            ? 'The GitHub App key cannot be used'
            : `The GitHub App misses ${String(i.github.missingPermissions)} permission(s)`,
          {
            fix: 'Open Ayarlar → Entegrasyonlar → GitHub: upload the key again or accept the requested permissions on GitHub.',
            docs: '/settings/integrations',
            params: { missing: i.github.missingPermissions },
            subject: 'github',
          },
        ),
      );
    return out.length > 0 ? out : ok('integrations', 'Connected integrations passed their last tests');
  },
};

const versionFeed: CheckSpec = {
  id: 'version_feed',
  light: false,
  async run(s) {
    const v = (await s.status())?.versionFeed ?? null;
    if (v === null || !v.enabled) return [f('version_feed', 'off', 'info', 'The version feed is off')];
    if (v.failing > 0)
      return [
        f(
          'version_feed',
          'failing',
          'info',
          `${String(v.failing)} of ${String(v.items)} version sources failed their last check`,
          {
            fix: 'Usually temporary (the source was down); if it stays, the master cannot reach the internet (proxy, DNS).',
            docs: '/settings/system',
            params: { failing: v.failing, items: v.items },
          },
        ),
      ];
    return ok('version_feed', 'The version feed is current');
  },
};

const backups: CheckSpec = {
  id: 'backups',
  light: true,
  async run(s) {
    const b = await s.backups();
    if (b === null || b.health.state === 'not_configured')
      return [
        f('backups', 'not_configured', 'warning', 'Backups are not configured', {
          fix: 'Set up the backup service (docs/ops/backup-restore.md); without it a lost disk loses everything.',
          docs: '/settings/backups',
        }),
      ];
    const out = b.health.reasons
      .filter((r) => r.level !== 'info' || b.health.state !== 'ok')
      .map((r) =>
        f(
          'backups',
          r.code.replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'problem',
          r.level === 'failing' ? 'error' : r.level === 'warning' ? 'warning' : 'info',
          r.message,
          {
            fix: 'Open Ayarlar → Yedekler: the reason and the runbook are there.',
            docs: '/settings/backups',
            subject: r.code.slice(0, 120),
          },
        ),
      );
    if (out.length === 0 && b.health.state === 'ok') return ok('backups', 'Backups are current');
    return out.length > 0
      ? capped('backups', out)
      : [
          f('backups', b.health.state, 'warning', `Backups: ${b.health.state}`, {
            docs: '/settings/backups',
          }),
        ];
  },
};

const machineOf = (r: Record<string, unknown>, none: string): string =>
  typeof r.answeringMachine === 'string' ? r.answeringMachine : none;

const chat: CheckSpec = {
  id: 'chat.assistant',
  light: true,
  async run(s) {
    const r = await s.chat();
    if (r === null)
      return [f('chat.assistant', 'unknown', 'info', 'The chat assistant routing is not available')];
    if (r.available !== true)
      return [
        f(
          'chat.assistant',
          'unavailable',
          'error',
          `The chat assistant cannot answer${typeof r.unavailableReason === 'string' ? `: ${r.unavailableReason}` : ''}`,
          {
            fix: 'Pick a connected machine with a signed-in runtime in Ayarlar → Sohbet (Sohbet makinesi).',
            docs: '/settings/chat',
          },
        ),
      ];
    const backupsList = Array.isArray(r.backupMachines)
      ? (r.backupMachines as { name?: unknown; canAnswer?: unknown }[])
      : [];
    if (backupsList.length === 0 || !backupsList.some((m) => m.canAnswer === true))
      return [
        f(
          'chat.assistant',
          'no_failover',
          'info',
          `The chat runs on ${machineOf(r, '?')} with no ready backup machine`,
          {
            fix: 'Add a backup machine in Ayarlar → Sohbet so the chat moves when the main one goes offline.',
            docs: '/settings/chat',
            params: { machine: machineOf(r, '') },
          },
        ),
      ];
    return ok('chat.assistant', `The chat answers on ${machineOf(r, '?')} with a ready backup`, {
      machine: machineOf(r, ''),
    });
  },
};

const webhooks: CheckSpec = {
  id: 'webhooks.disabled',
  light: true,
  async run(s) {
    const { rows } = await s.pool.query<{ id: string; name: string }>(
      "SELECT id::text AS id, name FROM webhook_subscriptions WHERE state = 'disabled' ORDER BY name LIMIT 40",
    );
    if (rows.length === 0) return ok('webhooks.disabled', 'No webhook was turned off');
    return capped(
      'webhooks.disabled',
      rows.map((w) =>
        f(
          'webhooks.disabled',
          'auto_disabled',
          'warning',
          `Webhook ${w.name} was turned off after repeated failures`,
          {
            fix: 'Fix the receiver, then resume it in Ayarlar → Webhook’lar (the delivery log shows the errors).',
            docs: '/settings/webhooks',
            params: { name: w.name },
            subject: w.id,
          },
        ),
      ),
    );
  },
};

const costBrake: CheckSpec = {
  id: 'cost.brake',
  light: true,
  async run(s) {
    const b = await s.costBrake();
    if (b === null) return [f('cost.brake', 'unknown', 'info', 'The cost brake is not available')];
    if (b.engaged.length === 0) return ok('cost.brake', 'The cost brake is not engaged', { mode: b.mode });
    return b.engaged.slice(0, MAX_PER_CHECK).map((e) =>
      f(
        'cost.brake',
        b.blocking ? 'blocking' : 'engaged',
        b.blocking ? 'error' : 'warning',
        `Model spend of ${e.scope === 'global' ? 'the installation' : e.scope} reached ${String(Math.round(e.percent))} % of its ${e.window} ceiling${b.blocking ? ': new non-urgent jobs wait' : ''}`,
        {
          fix: 'An owner lifts it for some hours in Ayarlar → Operasyon güvenliği → Maliyet freni, or raises the ceiling.',
          docs: '/settings/ops-safety?tab=brake',
          params: { scope: e.scope, window: e.window, percent: Math.round(e.percent) },
          subject: `${e.scope}:${e.window}`,
        },
      ),
    );
  },
};

const errorBurst: CheckSpec = {
  id: 'errors.burst',
  light: false,
  async run(s) {
    const store = s.logs();
    const st = await s.status();
    const out: DoctorFinding[] = [];
    if (st?.errors != null && st.errors.http5xx > 0)
      out.push(
        f(
          'errors.burst',
          'http_5xx',
          st.errors.http5xx >= 50 ? 'error' : 'warning',
          `${String(st.errors.http5xx)} server error(s) (HTTP 5xx) in the last ${String(st.errors.windowMinutes)} min`,
          {
            fix: 'Search the master log for level error in Ayarlar → Sistem durumu → Kayıtlar.',
            docs: '/settings/system?tab=logs',
            params: { n: st.errors.http5xx, minutes: st.errors.windowMinutes },
          },
        ),
      );
    if (store !== null && store.enabled) {
      const now = s.clock();
      const res = await store.search({
        level: 'error',
        since: new Date(now.getTime() - 3_600_000),
        until: now,
        limit: 500,
      });
      const n = res.lines.length;
      if (n >= 20) {
        const by = new Map<string, number>();
        for (const l of res.lines) by.set(l.component ?? 'other', (by.get(l.component ?? 'other') ?? 0) + 1);
        const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        out.push(
          f(
            'errors.burst',
            'log_errors',
            n >= 200 ? 'error' : 'warning',
            `${n >= 500 ? '500+' : String(n)} error lines in the master log in the last hour (most: ${top.map(([c, k]) => `${c} ${String(k)}`).join(', ')})`,
            {
              fix: 'Open Ayarlar → Sistem durumu → Kayıtlar, filter level error and the component above.',
              docs: '/settings/system?tab=logs',
              params: { n, top: top.map(([c]) => c).join(', ') },
            },
          ),
        );
      }
    }
    return out.length > 0 ? out : ok('errors.burst', 'No error burst in the last hour');
  },
};

/** Every check in the order the console lists them. */
export const MASTER_CHECKS: readonly CheckSpec[] = [
  dbReachable,
  redisReachable,
  migrations,
  disk,
  storage,
  web,
  queueBacklog,
  queueStuck,
  approvalOrphans,
  leasesExpired,
  workersOffline,
  workersDisk,
  workersClock,
  workersOutdated,
  workersLogin,
  workersSandbox,
  workersGit,
  expiry,
  integrations,
  chat,
  versionFeed,
  backups,
  errorBurst,
  webhooks,
  costBrake,
];

/** Runs the checks of a scope; a check that throws (or takes longer than 10 s) becomes a `check_failed` finding. */
export async function runChecks(s: DoctorSources, scope: 'full' | 'light'): Promise<DoctorFinding[]> {
  const specs = MASTER_CHECKS.filter((c) => scope === 'full' || c.light);
  const results = await Promise.all(
    specs.map(async (c) => {
      try {
        return (await timed(() => c.run(s), 10_000)).v;
      } catch (e) {
        return [
          f(
            c.id,
            'check_failed',
            'info',
            `The check could not run (${e instanceof Error && e.message === 'timeout' ? 'timeout' : 'error'})`,
            {
              docs: `${GUIDE}#kontroller`,
            },
          ),
        ];
      }
    }),
  );
  return results.flat();
}
