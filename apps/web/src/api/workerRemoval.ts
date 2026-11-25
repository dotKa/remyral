import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * p17-worker-managed Part 3: removing a worker from its machine (apps/master/src/worker-removal/routes.ts) — a signed
 * uninstall through the machine's privileged helper, then revoke; queued for an offline machine.
 */

export type RemovalState = 'requested' | 'sent' | 'done' | 'refused' | 'failed' | 'cancelled';

export interface RemovalRecord {
  readonly id: string;
  readonly purge: boolean;
  readonly state: RemovalState;
  readonly opId: string | null;
  readonly opState: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
}

export interface RemovalView {
  readonly workerId: string;
  readonly os: string | null;
  readonly supported: boolean;
  readonly connected: boolean;
  readonly revoked: boolean;
  readonly removal: RemovalRecord | null;
  readonly manual: readonly string[];
}

type Opts = Omit<RequestOptions, 'body'>;

const STATES = new Set(['requested', 'sent', 'done', 'refused', 'failed', 'cancelled']);

function parse(v: unknown): RemovalView {
  const o = obj(v);
  if (typeof o.supported !== 'boolean' || !Array.isArray(o.manual)) throw new ShapeError('removal');
  const r = o.removal === null || o.removal === undefined ? null : obj(o.removal);
  if (r !== null && (typeof r.state !== 'string' || !STATES.has(r.state)))
    throw new ShapeError('removal state');
  return {
    workerId: typeof o.workerId === 'string' ? o.workerId : '',
    os: typeof o.os === 'string' ? o.os : null,
    supported: o.supported,
    connected: o.connected === true,
    revoked: o.revoked === true,
    removal: r === null ? null : (r as unknown as RemovalRecord),
    manual: o.manual.filter((x): x is string => typeof x === 'string'),
  };
}

const path = (id: string) => `/workers/${encodeURIComponent(id)}/remove`;

export function getRemoval(workerId: string, opts: Opts = {}): Promise<RemovalView> {
  return apiRequest('GET', path(workerId), parse, opts);
}

/** Admin, always-fresh step-up: drain, then the signed uninstall (now, or when the machine connects), then revoke. */
export function requestRemoval(workerId: string, purge: boolean, opts: Opts = {}): Promise<RemovalView> {
  return apiRequest('POST', path(workerId), parse, { ...opts, body: { purge } });
}

/** A removal that has not reached the machine yet. */
export function cancelRemoval(workerId: string, opts: Opts = {}): Promise<RemovalView> {
  return apiRequest('DELETE', path(workerId), parse, opts);
}
