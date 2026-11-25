import { isValidTimeZone, zonedParts, zonedToUtc } from '@remyral/protocol';
import {
  type ExprContext,
  type NodeComputation,
  SandboxPool,
  type SandboxResult,
} from '@remyral/workflow-expr';
import { nodeType } from '@remyral/workflow-nodes';

/**
 * The master-pure node executor of engine 2 (p14-workflow-engine §3.3, §3.4, §5.1 rule 2): it receives only a node's
 * config, its input values and the expression context, and returns a value on ports, a timer / wait / run request, or
 * an error code — no I/O. Expressions and data computations run in the sandbox thread pool (`@remyral/workflow-expr`,
 * hard 250 ms deadline per call); date arithmetic and merges are plain bounded code here. Being pure, re-executing a
 * node after a crash yields the same result (the context's `now` is the node run's scheduled time).
 */

export type PureOutcome =
  | {
      readonly kind: 'value';
      readonly ports: Record<string, unknown>;
      readonly config: Record<string, unknown>;
    }
  | { readonly kind: 'error'; readonly code: string; readonly position: number | null }
  /** delay / waitUntil: wait until `dueAt`, then emit on `out`. */
  | { readonly kind: 'timer'; readonly dueAt: Date; readonly config: Record<string, unknown> }
  | { readonly kind: 'approval'; readonly config: Record<string, unknown> }
  | { readonly kind: 'subWorkflow'; readonly config: Record<string, unknown> }
  | { readonly kind: 'stop'; readonly outputs: unknown; readonly config: Record<string, unknown> }
  | { readonly kind: 'fail'; readonly reason: string; readonly config: Record<string, unknown> }
  | { readonly kind: 'return'; readonly value: unknown; readonly config: Record<string, unknown> }
  /** forEach: the items to iterate. */
  | { readonly kind: 'group'; readonly items: unknown[]; readonly config: Record<string, unknown> }
  /** loop: whether the next iteration runs. */
  | { readonly kind: 'loop'; readonly continue: boolean }
  /** 14.2 control.waitWebhook: wait for a call of the node's resume URL (or its timeout). */
  | { readonly kind: 'webhookWait'; readonly config: Record<string, unknown> }
  /** 14.4 control.respond: the answer for the held webhook request (the input passes on `out`). */
  | { readonly kind: 'respond'; readonly config: Record<string, unknown> };

/** Bounds of the timer nodes (catalog: delay ≤ 30 days, waitUntil ≤ 90 days ahead). */
export const TIMER_LIMITS = { maxDelaySec: 30 * 24 * 3600, maxWaitUntilSec: 90 * 24 * 3600 } as const;

/** ISO 8601 duration (`P1DT2H`, days / hours / minutes / seconds) or seconds → seconds; null when invalid. */
export function durationSec(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (m === null) return null;
  const [, d = '0', h = '0', mi = '0', s = '0'] = m;
  return Number(d) * 86_400 + Number(h) * 3600 + Number(mi) * 60 + Number(s);
}

const UNIT_MS: Readonly<Record<string, number>> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

function instantOf(v: unknown, timezone: string | undefined): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  if (typeof v !== 'string' || v.length > 64) return null;
  // A wall time without an offset is read in the node's time zone.
  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (wall !== null && timezone !== undefined && timezone !== 'UTC') {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = wall;
    const at = zonedToUtc(
      { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) },
      timezone,
    );
    return new Date(at.getTime() + Number(s) * 1000);
  }
  const ms = Date.parse(
    wall !== null && wall[4] === undefined ? `${v}T00:00:00Z` : wall !== null ? `${v}Z` : v,
  );
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `yyyy-MM-dd HH:mm:ss` style patterns (yyyy, MM, dd, HH, mm, ss, SSS) in a time zone. */
export function formatInstant(at: Date, pattern: string, timezone: string): string {
  const w = timezone === 'UTC' ? null : zonedParts(at, timezone);
  const p = {
    yyyy: w?.year ?? at.getUTCFullYear(),
    MM: w?.month ?? at.getUTCMonth() + 1,
    dd: w?.day ?? at.getUTCDate(),
    HH: w?.hour ?? at.getUTCHours(),
    mm: w?.minute ?? at.getUTCMinutes(),
    ss: at.getUTCSeconds(),
    SSS: at.getUTCMilliseconds(),
  };
  return pattern.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (t) =>
    t === 'yyyy' ? pad(p.yyyy, 4) : t === 'SSS' ? pad(p.SSS, 3) : pad(p[t as 'MM']),
  );
}

function addCalendar(at: Date, amount: number, unit: 'months' | 'years', timezone: string): Date {
  const tz = timezone;
  const w = zonedParts(at, tz);
  const months = unit === 'years' ? amount * 12 : amount;
  const total = w.year * 12 + (w.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const res = zonedToUtc({ year, month, day: Math.min(w.day, lastDay), hour: w.hour, minute: w.minute }, tz);
  return new Date(res.getTime() + at.getUTCSeconds() * 1000 + at.getUTCMilliseconds());
}

/** data.dateTime on resolved config values. */
export function dateTime(config: Record<string, unknown>, now: string): PureOutcome {
  const tz = typeof config.timezone === 'string' ? config.timezone : 'UTC';
  if (!isValidTimeZone(tz)) return { kind: 'error', code: 'invalid_timezone', position: null };
  const op = config.operation;
  const err = (code: string): PureOutcome => ({ kind: 'error', code, position: null });
  const value = op === 'now' ? now : config.value;
  const at = instantOf(value, tz);
  if (at === null) return err('type_error');
  const done = (out: unknown): PureOutcome => ({ kind: 'value', ports: { out }, config });
  switch (op) {
    case 'now':
    case 'parse':
      return done(
        typeof config.format === 'string' ? formatInstant(at, config.format, tz) : at.toISOString(),
      );
    case 'format':
      return done(
        formatInstant(at, typeof config.format === 'string' ? config.format : 'yyyy-MM-dd HH:mm:ss', tz),
      );
    case 'add': {
      const amount = config.amount;
      const unit = typeof config.unit === 'string' ? config.unit : 'seconds';
      if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > 1e7)
        return err('type_error');
      if (unit === 'months' || unit === 'years') {
        if (!Number.isInteger(amount)) return err('type_error');
        return done(addCalendar(at, amount, unit, tz).toISOString());
      }
      const ms = UNIT_MS[unit];
      if (ms === undefined) return err('type_error');
      const r = new Date(at.getTime() + amount * ms);
      return Number.isFinite(r.getTime()) ? done(r.toISOString()) : err('out_of_range');
    }
    case 'diff': {
      const other = instantOf(config.other, tz);
      if (other === null) return err('type_error');
      const unit = typeof config.unit === 'string' ? config.unit : 'seconds';
      const delta = at.getTime() - other.getTime();
      if (unit === 'months' || unit === 'years') {
        const a = zonedParts(at, tz);
        const b = zonedParts(other, tz);
        const months = (a.year - b.year) * 12 + (a.month - b.month);
        return done(unit === 'years' ? Math.trunc(months / 12) : months);
      }
      const ms = UNIT_MS[unit];
      return ms === undefined ? err('type_error') : done(delta / ms);
    }
    default:
      return err('type_error');
  }
}

/** The inputs a node run receives from the engine. */
export interface PureInputs {
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly context: ExprContext;
  /** control.merge: the values of the incoming edges that delivered, with their source nodes. */
  readonly merged?: { readonly values: readonly unknown[]; readonly from: readonly string[] };
}

const failed = (r: Extract<SandboxResult, { ok: false }>): PureOutcome => ({
  kind: 'error',
  code: r.code,
  position: r.position,
});

export class PureExecutor {
  readonly #pool: SandboxPool;

  constructor(pool?: SandboxPool) {
    this.#pool = pool ?? new SandboxPool();
  }

  get sandbox(): SandboxPool {
    return this.#pool;
  }

  async close(): Promise<void> {
    await this.#pool.close();
  }

  /** Evaluates one expression or template (`POST /workflows/expressions/evaluate`). */
  evaluate(source: string, mode: 'expr' | 'template', context: ExprContext): Promise<SandboxResult> {
    return this.#pool.run({ op: 'eval', source, mode, context });
  }

  /**
   * 14.2: resolves the expression fields of an integration node's config in the sandbox (static fields stay literal);
   * the engine performs the side effect with the result.
   */
  async resolve(
    type: string,
    config: Readonly<Record<string, unknown>>,
    context: ExprContext,
  ): Promise<
    | { readonly ok: true; readonly config: Record<string, unknown> }
    | { readonly ok: false; readonly code: string; readonly position: number | null }
  > {
    const spec = nodeType(type);
    // 14.3: worker function nodes resolve their expression fields here too (the worker gets only values).
    if (spec?.placement !== 'integration' && (spec?.placement !== 'worker' || type === 'ai.step'))
      return { ok: false, code: 'node_type_unavailable', position: null };
    const r = await this.#pool.run({ op: 'node', type, config, fields: spec.fields, context });
    if (!r.ok) return { ok: false, code: r.code, position: r.position };
    return { ok: true, config: (r.value as NodeComputation).config };
  }

  async execute(p: PureInputs): Promise<PureOutcome> {
    // A trigger node emits the event that started the run (`$trigger`: the manual start's inputs and starter, or
    // the automation's event data — untrusted for webhook / GitHub / workflow / chat sources).
    if (p.type.startsWith('trigger.')) {
      return { kind: 'value', ports: { out: p.context.trigger ?? null }, config: {} };
    }
    const spec = nodeType(p.type);
    if (spec === undefined || spec.placement !== 'master')
      return { kind: 'error', code: 'node_type_unavailable', position: null };
    if (p.type === 'control.merge') {
      const combine = p.config.combine === 'object' ? 'object' : 'array';
      const m = p.merged ?? { values: [], from: [] };
      const out =
        combine === 'object'
          ? Object.fromEntries(m.from.map((f, i) => [f, m.values[i] ?? null]))
          : { values: m.values, from: m.from };
      return { kind: 'value', ports: { out }, config: { ...p.config } };
    }
    const r = await this.#pool.run({
      op: 'node',
      type: p.type,
      config: p.config,
      fields: spec.fields,
      context: p.context,
    });
    if (!r.ok) return failed(r);
    const c = r.value as NodeComputation;
    const config = c.config;
    switch (p.type) {
      case 'control.forEach':
        return { kind: 'group', items: (config.items as unknown[] | undefined) ?? [], config };
      case 'control.loop':
        return { kind: 'loop', continue: c.continue === true };
      case 'control.delay': {
        const s = durationSec(config.duration);
        if (s === null || s > TIMER_LIMITS.maxDelaySec)
          return { kind: 'error', code: 'out_of_range', position: null };
        return { kind: 'timer', dueAt: new Date(Date.parse(p.context.now) + s * 1000), config };
      }
      case 'control.waitUntil': {
        const at = typeof config.at === 'string' ? Date.parse(config.at) : NaN;
        if (!Number.isFinite(at)) return { kind: 'error', code: 'type_error', position: null };
        if (at - Date.parse(p.context.now) > TIMER_LIMITS.maxWaitUntilSec * 1000)
          return { kind: 'error', code: 'out_of_range', position: null };
        return { kind: 'timer', dueAt: new Date(at), config };
      }
      case 'control.approval':
        return { kind: 'approval', config };
      case 'control.subWorkflow':
        return { kind: 'subWorkflow', config };
      case 'control.waitWebhook':
        return { kind: 'webhookWait', config };
      case 'control.respond':
        return { kind: 'respond', config };
      case 'control.stop':
        return { kind: 'stop', outputs: config.outputs ?? null, config };
      case 'control.fail':
        return {
          kind: 'fail',
          reason:
            typeof config.reason === 'string'
              ? config.reason.slice(0, 1000)
              : JSON.stringify(config.reason ?? '').slice(0, 1000),
          config,
        };
      case 'control.return':
        return { kind: 'return', value: config.value ?? p.context.input ?? null, config };
      case 'data.dateTime':
        return dateTime(config, p.context.now);
      default:
        if (c.ports === undefined) return { kind: 'error', code: 'node_type_unavailable', position: null };
        return { kind: 'value', ports: c.ports, config };
    }
  }
}
