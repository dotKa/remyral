import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p8-capacity-auto (apps/master/src/capacity/routes.ts, docs/design/p8-capacity-auto.md): a machine's capacity mode
 * (manual / suggest / auto), its bounds, the live measurements, the controller's last decision and the history of
 * every change. Reason texts are built by the master from numbers only: render as text.
 */

type Opts = Omit<RequestOptions, 'body'>;

export type CapacityMode = 'manual' | 'suggest' | 'auto';
export const CAPACITY_MODES: readonly CapacityMode[] = ['manual', 'suggest', 'auto'];

export interface CapacityReason {
  readonly code: string;
  readonly text: string;
}

export type CapacityEventKind = 'raise' | 'lower' | 'clamp' | 'suggest' | 'mode' | 'bounds' | 'override';

export interface CapacityEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: CapacityEventKind;
  readonly mode: CapacityMode;
  readonly from: number | null;
  readonly to: number | null;
  readonly reasons: readonly CapacityReason[];
  readonly actorType: 'user' | 'system';
}

export interface CapacityMetrics {
  readonly at: string | null;
  readonly cpuPercent: number | null;
  readonly memoryAvailableBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  readonly swapTotalBytes: number | null;
  readonly swapInPerSec: number | null;
  readonly commitPercent: number | null;
  readonly memoryPressurePercent: number | null;
  readonly running: number;
  readonly waiting: number;
  readonly oomFailures: number;
  readonly timeouts: number;
  readonly slowdownRatio: number | null;
}

export interface CapacityView {
  readonly workerId: string;
  readonly mode: CapacityMode;
  readonly min: number;
  readonly max: number;
  readonly slots: number | null;
  readonly effective: number | null;
  readonly configured: number | null;
  readonly reportedMax: number | null;
  readonly hardwareCeiling: number | null;
  readonly upper: number;
  readonly managed: boolean;
  readonly metricsSupported: boolean;
  readonly suggestion: { readonly value: number; readonly reasons: readonly CapacityReason[] } | null;
  readonly lastDecision: {
    readonly at: string;
    readonly action: 'raise' | 'lower' | 'clamp' | 'hold';
    readonly from: number;
    readonly to: number;
    readonly estimate: number | null;
    readonly reasons: readonly CapacityReason[];
  } | null;
  readonly metrics: CapacityMetrics | null;
  readonly events: readonly CapacityEvent[];
}

function nInt(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(`expected integer at ${key}`);
  return v;
}

function nNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${key}`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = str(o, key);
  if (!(allowed as readonly string[]).includes(v)) throw new ShapeError(`unexpected ${key}`);
  return v as T;
}

function reasons(v: unknown): CapacityReason[] {
  if (!Array.isArray(v)) throw new ShapeError('expected reasons array');
  return v.map((r) => {
    const o = obj(r);
    return { code: str(o, 'code'), text: str(o, 'text') };
  });
}

const KINDS: readonly CapacityEventKind[] = [
  'raise',
  'lower',
  'clamp',
  'suggest',
  'mode',
  'bounds',
  'override',
];

export function parseCapacity(v: unknown): CapacityView {
  const o = obj(v);
  const s = o.suggestion === null ? null : obj(o.suggestion);
  const d = o.lastDecision === null ? null : obj(o.lastDecision);
  const m = o.metrics === null ? null : obj(o.metrics);
  if (!Array.isArray(o.events)) throw new ShapeError('expected events');
  return {
    workerId: str(o, 'workerId'),
    mode: oneOf(o, 'mode', CAPACITY_MODES),
    min: int(o, 'min'),
    max: int(o, 'max'),
    slots: nInt(o, 'slots'),
    effective: nInt(o, 'effective'),
    configured: nInt(o, 'configured'),
    reportedMax: nInt(o, 'reportedMax'),
    hardwareCeiling: nInt(o, 'hardwareCeiling'),
    upper: int(o, 'upper'),
    managed: bool(o, 'managed'),
    metricsSupported: bool(o, 'metricsSupported'),
    suggestion: s === null ? null : { value: int(s, 'value'), reasons: reasons(s.reasons) },
    lastDecision:
      d === null
        ? null
        : {
            at: str(d, 'at'),
            action: oneOf(d, 'action', ['raise', 'lower', 'clamp', 'hold'] as const),
            from: int(d, 'from'),
            to: int(d, 'to'),
            estimate: nInt(d, 'estimate'),
            reasons: reasons(d.reasons),
          },
    metrics:
      m === null
        ? null
        : {
            at: nullableStr(m, 'at'),
            cpuPercent: nNum(m, 'cpuPercent'),
            memoryAvailableBytes: nNum(m, 'memoryAvailableBytes'),
            memoryTotalBytes: nNum(m, 'memoryTotalBytes'),
            swapUsedBytes: nNum(m, 'swapUsedBytes'),
            swapTotalBytes: nNum(m, 'swapTotalBytes'),
            swapInPerSec: nNum(m, 'swapInPerSec'),
            commitPercent: nNum(m, 'commitPercent'),
            memoryPressurePercent: nNum(m, 'memoryPressurePercent'),
            running: int(m, 'running'),
            waiting: int(m, 'waiting'),
            oomFailures: int(m, 'oomFailures'),
            timeouts: int(m, 'timeouts'),
            slowdownRatio: nNum(m, 'slowdownRatio'),
          },
    events: o.events.map((e) => {
      const eo = obj(e);
      const actor = obj(eo.actor);
      return {
        id: str(eo, 'id'),
        at: str(eo, 'at'),
        kind: oneOf(eo, 'kind', KINDS),
        mode: oneOf(eo, 'mode', CAPACITY_MODES),
        from: nInt(eo, 'from'),
        to: nInt(eo, 'to'),
        reasons: reasons(eo.reasons),
        actorType: oneOf(actor, 'type', ['user', 'system'] as const),
      };
    }),
  };
}

export function getCapacity(workerId: string, opts: Opts = {}): Promise<CapacityView> {
  return apiRequest('GET', `/workers/${encodeURIComponent(workerId)}/capacity`, parseCapacity, opts);
}

export function setCapacity(
  workerId: string,
  body: { readonly mode: CapacityMode; readonly min: number; readonly max: number },
  opts: Opts = {},
): Promise<CapacityView> {
  return apiRequest('PUT', `/workers/${encodeURIComponent(workerId)}/capacity`, parseCapacity, {
    ...opts,
    body,
  });
}
