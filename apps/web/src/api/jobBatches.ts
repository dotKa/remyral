import { apiRequest, obj, type RequestOptions } from './client';

/**
 * p18-multi-project W5 (apps/master/src/jobs/batch-routes.ts): job fan-out batches — the same job in several projects,
 * one ordinary job per project ("Her projeye ayrı iş"). Lenient parsers: unknown fields are ignored, a member that does
 * not parse is left out.
 */

type Opts = Omit<RequestOptions, 'body'>;

export type BatchState = 'running' | 'done' | 'failed' | 'refused';

export interface BatchMember {
  readonly project: string;
  readonly position: number;
  readonly jobId: string | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  /** Null: refused, or a project whose jobs the reader cannot see. */
  readonly job: {
    readonly title: string | null;
    readonly state: string;
    readonly costUsd: number | null;
    readonly pullRequest: string | null;
    readonly link: string;
  } | null;
}

export interface JobBatch {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly source: 'console' | 'chat';
  readonly threadId: string | null;
  readonly prompt: string;
  readonly runtime: string;
  readonly members: readonly BatchMember[];
  readonly counts: {
    readonly total: number;
    readonly created: number;
    readonly refused: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly running: number;
  };
  readonly costUsd: number | null;
  readonly state: BatchState;
}

export interface BatchRequestBody {
  readonly projects: readonly string[];
  readonly spec: {
    readonly title: string;
    readonly prompt: string;
    readonly runtime: string;
    /** p18-leftovers: the composer's settings every job takes (absent: each project's defaults). */
    readonly model?: string;
    readonly sandboxProfile?: string;
    readonly approvalPolicy?: string;
    readonly maxDurationSec?: number;
  };
  /** p18-leftovers: per project — the branch to start from (the composer's base branch for its project). */
  readonly perProject?: Readonly<Record<string, { readonly baseRef?: string }>>;
}

export interface BatchPreflight {
  readonly ready: readonly {
    readonly project: string;
    readonly name: string;
    readonly kind: 'repository' | 'workspace';
    readonly waits: readonly string[];
    readonly repository: string | null;
  }[];
  readonly refused: readonly { readonly project: string; readonly code: string; readonly message: string }[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const ns = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const STATES: readonly BatchState[] = ['running', 'done', 'failed', 'refused'];

function parseMember(v: unknown): BatchMember | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.project !== 'string') return null;
  const r = o.refusal as Record<string, unknown> | null | undefined;
  const j = o.job as Record<string, unknown> | null | undefined;
  return {
    project: o.project,
    position: num(o.position),
    jobId: ns(o.jobId),
    refusal:
      r === null || r === undefined || typeof r !== 'object'
        ? null
        : { code: s(r.code, 'refused'), message: s(r.message) },
    job:
      j === null || j === undefined || typeof j !== 'object'
        ? null
        : {
            title: ns(j.title),
            state: s(j.state, 'UNKNOWN'),
            costUsd: typeof j.costUsd === 'number' ? j.costUsd : null,
            pullRequest:
              typeof j.pullRequest === 'string' && /^https:\/\//.test(j.pullRequest) ? j.pullRequest : null,
            link: s(j.link),
          },
  };
}

export function parseBatch(v: unknown): JobBatch {
  const o = obj(v);
  const c = (o.counts ?? {}) as Record<string, unknown>;
  return {
    id: s(o.id),
    title: s(o.title),
    createdAt: s(o.createdAt),
    source: o.source === 'chat' ? 'chat' : 'console',
    threadId: ns(o.threadId),
    prompt: s(o.prompt),
    runtime: s(o.runtime),
    members: (Array.isArray(o.members) ? o.members : []).flatMap((m) => {
      const x = parseMember(m);
      return x === null ? [] : [x];
    }),
    counts: {
      total: num(c.total),
      created: num(c.created),
      refused: num(c.refused),
      succeeded: num(c.succeeded),
      failed: num(c.failed),
      running: num(c.running),
    },
    costUsd: typeof o.costUsd === 'number' ? o.costUsd : null,
    state: STATES.includes(o.state as BatchState) ? (o.state as BatchState) : 'running',
  };
}

export function getJobBatch(id: string, opts: Opts = {}): Promise<JobBatch> {
  return apiRequest('GET', `/jobs/batches/${encodeURIComponent(id)}`, parseBatch, opts);
}

export function listJobBatches(opts: Opts = {}): Promise<JobBatch[]> {
  return apiRequest(
    'GET',
    '/jobs/batches?limit=50',
    (v) => (Array.isArray(obj(v).items) ? (obj(v).items as unknown[]) : []).map(parseBatch),
    opts,
  );
}

export function preflightJobBatch(body: BatchRequestBody, opts: Opts = {}): Promise<BatchPreflight> {
  return apiRequest(
    'POST',
    '/jobs/batches/preflight',
    (v) => {
      const o = obj(v);
      return {
        ready: (Array.isArray(o.ready) ? o.ready : []).flatMap((r) => {
          if (r === null || typeof r !== 'object') return [];
          const x = r as Record<string, unknown>;
          if (typeof x.project !== 'string') return [];
          return [
            {
              project: x.project,
              name: s(x.name, x.project),
              kind: x.kind === 'workspace' ? ('workspace' as const) : ('repository' as const),
              waits: Array.isArray(x.waits) ? x.waits.filter((w): w is string => typeof w === 'string') : [],
              repository: ns(x.repository),
            },
          ];
        }),
        refused: (Array.isArray(o.refused) ? o.refused : []).flatMap((r) => {
          if (r === null || typeof r !== 'object') return [];
          const x = r as Record<string, unknown>;
          return typeof x.project === 'string'
            ? [{ project: x.project, code: s(x.code, 'refused'), message: s(x.message) }]
            : [];
        }),
      };
    },
    { ...opts, body },
  );
}

export function submitJobBatch(
  body: BatchRequestBody,
  opts: Opts = {},
): Promise<{ batchId: string; created: number; refused: number }> {
  return apiRequest(
    'POST',
    '/jobs/batches',
    (v) => {
      const o = obj(v);
      return {
        batchId: s(o.batchId),
        created: Array.isArray(o.created) ? o.created.length : 0,
        refused: Array.isArray(o.refused) ? o.refused.length : 0,
      };
    },
    { ...opts, body },
  );
}
