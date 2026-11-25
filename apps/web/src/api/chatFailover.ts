import { type ChatStatus, parseStatus } from './chat';
import { apiRequest, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p15-chat-failover (docs/design/p15-chat-failover.md §7): the chat assistant's backup machines — which machine answers
 * and why, each chain machine's verdict, the pin / automatic failover controls and the recent switches (admins).
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface FailoverMachine {
  readonly workerId: string;
  readonly name: string;
  readonly role: 'primary' | 'backup';
  readonly position: number;
  readonly online: boolean;
  readonly connectedAt: string | null;
  readonly workerVersion: string | null;
  readonly eligible: boolean;
  /** offline | update_required | disabled_on_worker | engine_not_ready | engine_limited (null: can answer). */
  readonly issue: string | null;
  /** The master's sentence for the issue (English; the console says it by `issue`). */
  readonly message: string | null;
  readonly runtime: string | null;
  readonly fallback: boolean;
  readonly account: string | null;
  readonly answering: boolean;
}

export interface FailoverEvent {
  readonly id: string;
  /** failover | return | rerun | pin | unpin | force_primary | auto_off | auto_on */
  readonly kind: string;
  readonly from: { readonly id: string; readonly name: string } | null;
  readonly to: { readonly id: string; readonly name: string } | null;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly at: string;
}

export interface FailoverView {
  readonly status: ChatStatus;
  readonly auto: boolean;
  readonly stableSeconds: number;
  readonly pin: { readonly workerId: string; readonly name: string; readonly until: string } | null;
  readonly active: {
    readonly workerId: string;
    readonly name: string;
    readonly reason: string | null;
    readonly since: string;
  } | null;
  readonly chain: readonly FailoverMachine[];
  readonly events: readonly FailoverEvent[];
}

const ref = (v: unknown): { id: string; name: string } | null => {
  if (v === null || typeof v !== 'object') return null;
  const o = obj(v);
  return { id: str(o, 'id'), name: str(o, 'name') };
};

export function parseFailover(v: unknown): FailoverView {
  const o = obj(v);
  const pin = o.pin === null || typeof o.pin !== 'object' ? null : obj(o.pin);
  const active = o.active === null || typeof o.active !== 'object' ? null : obj(o.active);
  return {
    status: parseStatus(o.status),
    auto: o.auto !== false,
    stableSeconds: typeof o.stableSeconds === 'number' ? o.stableSeconds : 60,
    pin:
      pin === null
        ? null
        : { workerId: str(pin, 'workerId'), name: str(pin, 'name'), until: str(pin, 'until') },
    active:
      active === null
        ? null
        : {
            workerId: str(active, 'workerId'),
            name: str(active, 'name'),
            reason: nullableStr(active, 'reason'),
            since: str(active, 'since'),
          },
    chain: (Array.isArray(o.chain) ? o.chain : []).map((x: unknown) => {
      const c = obj(x);
      return {
        workerId: str(c, 'workerId'),
        name: str(c, 'name'),
        role: c.role === 'primary' ? ('primary' as const) : ('backup' as const),
        position: typeof c.position === 'number' ? c.position : 0,
        online: c.online === true,
        connectedAt: typeof c.connectedAt === 'string' ? c.connectedAt : null,
        workerVersion: typeof c.workerVersion === 'string' ? c.workerVersion : null,
        eligible: c.eligible === true,
        issue: typeof c.issue === 'string' ? c.issue : null,
        message: typeof c.message === 'string' ? c.message : null,
        runtime: typeof c.runtime === 'string' ? c.runtime : null,
        fallback: c.fallback === true,
        account: typeof c.account === 'string' ? c.account : null,
        answering: c.answering === true,
      };
    }),
    events: (Array.isArray(o.events) ? o.events : []).map((x: unknown) => {
      const e = obj(x);
      return {
        id: str(e, 'id'),
        kind: str(e, 'kind'),
        from: ref(e.from),
        to: ref(e.to),
        reason: typeof e.reason === 'string' ? e.reason : null,
        actor: typeof e.actor === 'string' ? e.actor : null,
        at: str(e, 'at'),
      };
    }),
  };
}

export function getFailover(opts: Opts = {}): Promise<FailoverView> {
  return apiRequest('GET', '/chat/failover', parseFailover, opts);
}

/** Force the chat back to the primary now (step-up; 409 primary_unavailable when it cannot answer). */
export function forcePrimary(opts: Opts = {}): Promise<FailoverView> {
  return apiRequest('POST', '/chat/failover/primary', parseFailover, { ...opts, body: {} });
}

export function pinMachine(workerId: string, minutes: number, opts: Opts = {}): Promise<FailoverView> {
  return apiRequest('PUT', '/chat/failover/pin', parseFailover, { ...opts, body: { workerId, minutes } });
}

export function unpinMachine(opts: Opts = {}): Promise<FailoverView> {
  return apiRequest('DELETE', '/chat/failover/pin', parseFailover, opts);
}

export function setAutoFailover(enabled: boolean, opts: Opts = {}): Promise<FailoverView> {
  return apiRequest('PUT', '/chat/failover/auto', parseFailover, { ...opts, body: { enabled } });
}
