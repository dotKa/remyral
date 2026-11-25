import { apiRequest, int, obj, type RequestOptions } from './client';

/**
 * p15-auto-mode: what the platform did by itself for a job (`GET /jobs/:id/autonomy`) and the 24-hour failure digest
 * (`GET /autonomy/digest`).
 */

export type AutoDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface AutoEvent {
  readonly id: string;
  readonly kind: string;
  readonly detail: AutoDetail;
  readonly at: string;
}

export interface JobAutonomy {
  readonly retry: {
    readonly used: number;
    readonly max: number;
    readonly cause: string;
    readonly retryAt: string | null;
    readonly waiting: boolean;
  } | null;
  readonly fix: {
    readonly fixJobId: string | null;
    readonly state: string;
    readonly reason: string | null;
  } | null;
  readonly fixOf: string | null;
  /** p22-conflict-resolve: this job's conflict-resolution job, the job this one resolves, and whether one applies now. */
  readonly conflictResolve: {
    readonly resolveJobId: string | null;
    readonly state: string;
    readonly prClosed: boolean;
  } | null;
  readonly conflictResolveOf: string | null;
  readonly conflictResolvable: boolean;
  readonly events: readonly AutoEvent[];
}

export interface FailureDigest {
  readonly since: string;
  readonly failed: number;
  readonly healed: number;
  readonly waiting: number;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function detail(v: unknown): AutoDetail {
  const o = obj(v);
  return Object.fromEntries(
    Object.entries(o).filter(
      ([, x]) => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean',
    ),
  ) as AutoDetail;
}

export function parseJobAutonomy(v: unknown): JobAutonomy {
  const o = obj(v);
  const r = o.retry === null || o.retry === undefined ? null : obj(o.retry);
  const f = o.fix === null || o.fix === undefined ? null : obj(o.fix);
  const events = Array.isArray(o.events) ? o.events : [];
  const c = o.conflictResolve === null || o.conflictResolve === undefined ? null : obj(o.conflictResolve);
  return {
    retry:
      r === null
        ? null
        : {
            used: int(r, 'used'),
            max: int(r, 'max'),
            cause: text(r.cause) ?? '',
            retryAt: text(r.retryAt),
            waiting: r.waiting === true,
          },
    fix:
      f === null ? null : { fixJobId: text(f.fixJobId), state: text(f.state) ?? '', reason: text(f.reason) },
    fixOf: text(o.fixOf),
    conflictResolve:
      c === null
        ? null
        : { resolveJobId: text(c.resolveJobId), state: text(c.state) ?? '', prClosed: c.prClosed === true },
    conflictResolveOf: text(o.conflictResolveOf),
    conflictResolvable: o.conflictResolvable === true,
    events: events.map((x) => {
      const e = obj(x);
      return {
        id: text(e.id) ?? '',
        kind: text(e.kind) ?? '',
        detail: detail(e.detail ?? {}),
        at: text(e.at) ?? '',
      };
    }),
  };
}

export function parseFailureDigest(v: unknown): FailureDigest {
  const o = obj(v);
  return {
    since: text(o.since) ?? '',
    failed: int(o, 'failed'),
    healed: int(o, 'healed'),
    waiting: int(o, 'waiting'),
  };
}

export function getJobAutonomy(jobId: string, opts: RequestOptions = {}): Promise<JobAutonomy> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/autonomy`, parseJobAutonomy, opts);
}

/** p22-conflict-resolve: "Çakışmayı çöz" — a new job carries the conflicting result onto the current target. */
export function resolveJobConflicts(
  jobId: string,
  opts: RequestOptions = {},
): Promise<{ readonly jobId: string }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/resolve-conflicts`,
    (v) => ({ jobId: text(obj(v).jobId) ?? '' }),
    opts,
  );
}

export function getFailureDigest(opts: RequestOptions = {}): Promise<FailureDigest> {
  return apiRequest('GET', '/autonomy/digest', parseFailureDigest, opts);
}
