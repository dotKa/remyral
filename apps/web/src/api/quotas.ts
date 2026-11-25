import { apiRequest, int, nullableStr, obj, ShapeError, str, strArray } from './client';

/**
 * Typed wrappers for the quota routes (apps/master/src/quotas/routes.ts, docs/design/p4-quotas.md).
 * Messages are built by the master from identifiers; still rendered as text only.
 */

export interface QuotaPause {
  readonly id: string;
  readonly scope: 'worker_runtime' | 'account';
  readonly workerId: string | null;
  readonly runtime: string;
  readonly accountId: string | null;
  readonly workers: readonly string[];
  readonly pausedAt: string;
  readonly resumeAt: string;
}

export interface QuotaEvent {
  readonly id: string;
  readonly kind: string;
  readonly project: string | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly code: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface QuotaStatus {
  readonly policy: { readonly version: number; readonly policy: Record<string, unknown> };
  readonly projects: readonly {
    readonly project: string;
    readonly active: number;
    readonly maxConcurrent: number | null;
    readonly weight: number;
  }[];
  readonly runtimes: readonly {
    readonly runtime: string;
    readonly active: number;
    readonly maxConcurrent: number | null;
  }[];
  readonly accounts: readonly {
    readonly id: string;
    readonly runtime: string;
    readonly provider: string | null;
    readonly workers: readonly string[];
    readonly active: number;
    readonly maxConcurrent: number | null;
  }[];
  readonly pauses: readonly QuotaPause[];
  readonly holds: readonly {
    readonly project: string;
    readonly reason: string;
    readonly heldBy: string;
    readonly heldAt: string;
  }[];
  readonly budgets: readonly {
    readonly id: string;
    readonly name: string;
    readonly scope: { readonly type: string; readonly value: string | null };
    readonly metric: string;
    readonly status: string;
    readonly ratio: number;
    readonly complete: boolean;
    readonly enforcement: string;
  }[];
  readonly events: readonly QuotaEvent[];
}

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${key}`);
  return v;
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

export function parseQuotaStatus(body: unknown): QuotaStatus {
  const b = obj(body);
  const policy = obj(b.policy);
  return {
    policy: { version: int(policy, 'version'), policy: obj(policy.policy) },
    projects: arr(b, 'projects').map((x) => {
      const o = obj(x);
      return {
        project: str(o, 'project'),
        active: int(o, 'active'),
        maxConcurrent: nullableInt(o, 'maxConcurrent'),
        weight: num(o, 'weight'),
      };
    }),
    runtimes: arr(b, 'runtimes').map((x) => {
      const o = obj(x);
      return {
        runtime: str(o, 'runtime'),
        active: int(o, 'active'),
        maxConcurrent: nullableInt(o, 'maxConcurrent'),
      };
    }),
    accounts: arr(b, 'accounts').map((x) => {
      const o = obj(x);
      return {
        id: str(o, 'id'),
        runtime: str(o, 'runtime'),
        provider: nullableStr(o, 'provider'),
        workers: strArray(o, 'workers'),
        active: int(o, 'active'),
        maxConcurrent: nullableInt(o, 'maxConcurrent'),
      };
    }),
    pauses: arr(b, 'pauses').map((x) => {
      const o = obj(x);
      const scope = str(o, 'scope');
      if (scope !== 'worker_runtime' && scope !== 'account') throw new ShapeError('scope');
      return {
        id: str(o, 'id'),
        scope,
        workerId: nullableStr(o, 'workerId'),
        runtime: str(o, 'runtime'),
        accountId: nullableStr(o, 'accountId'),
        workers: strArray(o, 'workers'),
        pausedAt: str(o, 'pausedAt'),
        resumeAt: str(o, 'resumeAt'),
      };
    }),
    holds: arr(b, 'holds').map((x) => {
      const o = obj(x);
      return {
        project: str(o, 'project'),
        reason: str(o, 'reason'),
        heldBy: str(o, 'heldBy'),
        heldAt: str(o, 'heldAt'),
      };
    }),
    budgets: arr(b, 'budgets').map((x) => {
      const o = obj(x);
      const scope = obj(o.scope);
      return {
        id: str(o, 'id'),
        name: str(o, 'name'),
        scope: { type: str(scope, 'type'), value: nullableStr(scope, 'value') },
        metric: str(o, 'metric'),
        status: str(o, 'status'),
        ratio: num(o, 'ratio'),
        complete: o.complete === true,
        enforcement: str(o, 'enforcement'),
      };
    }),
    events: arr(b, 'events').map((x) => {
      const o = obj(x);
      return {
        id: str(o, 'id'),
        kind: str(o, 'kind'),
        project: nullableStr(o, 'project'),
        jobId: nullableStr(o, 'jobId'),
        workerId: nullableStr(o, 'workerId'),
        code: str(o, 'code'),
        message: str(o, 'message'),
        createdAt: str(o, 'createdAt'),
      };
    }),
  };
}

export function getQuotaStatus(): Promise<QuotaStatus> {
  return apiRequest('GET', '/quotas/status', parseQuotaStatus);
}

export function putQuotaPolicy(expectedVersion: number, policy: unknown, note?: string): Promise<number> {
  return apiRequest('PUT', '/quotas/policy', (b) => int(obj(b), 'version'), {
    body: { expectedVersion, policy, ...(note === undefined || note === '' ? {} : { note }) },
  });
}

export function resumePause(id: string): Promise<void> {
  return apiRequest('POST', `/quotas/pauses/${encodeURIComponent(id)}/resume`, () => undefined, { body: {} });
}

export interface KillResult {
  readonly cancelled: number;
  readonly cancelling: number;
  readonly skipped: number;
  readonly hold: boolean;
}

export function killProject(project: string, reason: string, hold: boolean): Promise<KillResult> {
  return apiRequest(
    'POST',
    `/projects/${encodeURIComponent(project)}/kill`,
    (b) => {
      const o = obj(b);
      return {
        cancelled: int(o, 'cancelled'),
        cancelling: int(o, 'cancelling'),
        skipped: int(o, 'skipped'),
        hold: o.hold === true,
      };
    },
    { body: { reason, hold } },
  );
}

export function releaseHold(project: string): Promise<void> {
  return apiRequest('DELETE', `/projects/${encodeURIComponent(project)}/kill`, () => undefined, { body: {} });
}
