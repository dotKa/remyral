import { CAPACITY_METRICS_FEATURE, RuntimeKind } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { fleetPeaks, recommendParallelism } from '../fleetview/capacity.js';
import { workerMemory } from '../fleetview/memory-rollup.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import { WORKER_ID_PATTERN } from '../workers/ids.js';
import {
  CAPACITY_TUNING,
  type CapacityMode,
  type ControllerContext,
  type ControllerState,
  decide,
  type Decision,
  EMPTY_STATE,
  HARD_MAX,
  hardwareCeiling,
  liveMargin,
  type LoadSample,
  type Reason,
  suggestionReasons,
  upperBound,
} from './controller.js';
import { OUTBOX_TOPIC_WORKER_CAPACITY, type WorkerCapacityOutboxPayload } from './outbox.js';

/**
 * p8-capacity-auto (docs/design/p8-capacity-auto.md §5): capacity modes, the controller loop and the history.
 *
 * Auto mode is enforced by the master: placement grants at most LEAST(reported, slots) leases (orchestrator
 * candidates), so a step takes effect at the next placement without a configuration generation, and a worker cannot
 * raise it. Entering auto (or a new max bound) writes the panel configuration's maxParallelJobs = max once (cause
 * `capacity`) so the worker has room; leaving auto writes the current slots back. A manual change of maxParallelJobs
 * anywhere else switches auto off (`capacityManualOverride`, called inside the configuration transaction).
 */

export const WORKER_CONFIG_FEATURE = 'worker-config-v1';
export const KEPT_EVENTS = 500;

export interface CapacityEventView {
  readonly id: string;
  readonly at: string;
  readonly kind: 'raise' | 'lower' | 'clamp' | 'suggest' | 'mode' | 'bounds' | 'override';
  readonly mode: CapacityMode;
  readonly from: number | null;
  readonly to: number | null;
  readonly reasons: readonly Reason[];
  readonly actor: { readonly type: 'user' | 'system'; readonly id: string | null };
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
  /** Auto: the lease cap in effect. */
  readonly slots: number | null;
  /** What runs: auto → slots ∩ reported; else the worker's reported value. */
  readonly effective: number | null;
  /** The panel configuration's maxParallelJobs (null: unmanaged). */
  readonly configured: number | null;
  readonly reportedMax: number | null;
  readonly hardwareCeiling: number | null;
  readonly upper: number;
  readonly managed: boolean;
  /** The worker sends the capacity metrics (`capacity-metrics-v1`). */
  readonly metricsSupported: boolean;
  readonly suggestion: { readonly value: number; readonly reasons: readonly Reason[] } | null;
  readonly lastDecision: {
    readonly at: string;
    readonly action: Decision['action'];
    readonly from: number;
    readonly to: number;
    readonly estimate: number | null;
    readonly reasons: readonly Reason[];
  } | null;
  readonly metrics: CapacityMetrics | null;
  readonly events: readonly CapacityEventView[];
}

interface CapacityRow {
  mode: CapacityMode;
  min_slots: number;
  max_slots: number;
  slots: number | null;
  state: Record<string, unknown>;
  last_decision: Record<string, unknown> | null;
  last_evaluated_at: Date | null;
}

interface WorkerFacts {
  id: string;
  approved: boolean;
  revoked: boolean;
  os: string | null;
  features: string[];
  cpuCount: number | null;
  memoryBytes: number | null;
  load: Record<string, unknown> | null;
  lastSeenAt: Date | null;
  reportedMax: number | null;
  configured: number | null;
  running: number;
  installed: RuntimeKind[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const opt = (v: unknown): number | undefined => num(v) ?? undefined;

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
}

function invalid(code: string, message: string): HttpError {
  return new HttpError(400, code, message);
}

/** The stored controller state, re-validated field by field (a malformed value is reset, never trusted). */
export function parseState(raw: unknown, slots: number | null): ControllerState {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const window = Array.isArray(r.window)
    ? r.window.flatMap((w: unknown) => {
        const o = w !== null && typeof w === 'object' ? (w as Record<string, unknown>) : {};
        const t = num(o.t);
        const e = num(o.e);
        return t === null || e === null || typeof o.h !== 'boolean' ? [] : [{ t, e, h: o.h }];
      })
    : [];
  return {
    ...EMPTY_STATE,
    slots,
    window: window.slice(-64),
    headroomSince: num(r.headroomSince),
    lastChangeAt: num(r.lastChangeAt),
    lastLowerAt: num(r.lastLowerAt),
    lastNotifiedAt: num(r.lastNotifiedAt),
    lastNotifiedValue: num(r.lastNotifiedValue),
  };
}

function storedState(s: ControllerState): Record<string, unknown> {
  const { slots: _slots, ...rest } = s;
  return rest;
}

/**
 * The latest HEARTBEAT load as a controller sample. CPU is not trusted from a Windows worker without
 * `capacity-metrics-v1` (it always sent 0); a macOS worker without it has no usable available-memory figure (free
 * pages only), so it has no sample at all. p8-capacity-windows-metrics: a memory reading of exactly 0 on a machine
 * whose total RAM is known is a failed reading (worker 1.0.26 on Windows sent 0 when its CIM query failed), not "no
 * memory left": it counts as unknown, so the free-memory fallback (or no sample) applies.
 */
export function sampleFrom(
  load: Record<string, unknown> | null,
  at: Date | null,
  os: string | null,
  features: readonly string[],
  memoryTotalBytes: number | null = null,
): LoadSample | null {
  if (load === null || at === null) return null;
  const metrics = features.includes(CAPACITY_METRICS_FEATURE);
  const memory = (v: unknown): number | null => {
    const n = num(v);
    return n === 0 && memoryTotalBytes !== null && memoryTotalBytes > 0 ? null : n;
  };
  const available =
    memory(load.memoryAvailableBytes) ?? (os === 'darwin' ? null : memory(load.memoryFreeBytes));
  if (available === null) return null;
  const cpu = num(load.cpuPercent);
  return {
    at: at.getTime(),
    cpuPercent: cpu === null || (os === 'win32' && !metrics) ? null : cpu,
    memoryAvailableBytes: available,
    swapInPerSec: opt(load.swapInPerSec),
    commitPercent: opt(load.commitPercent),
    memoryPressurePercent: opt(load.memoryPressurePercent),
    swapUsedBytes: opt(load.swapUsedBytes),
    swapTotalBytes: opt(load.swapTotalBytes),
  };
}

/** Out-of-memory / timeout classification of a failed attempt's JOB_RESULT (untrusted, numbers and codes only). */
export function classifyFailure(result: unknown): 'oom' | 'timeout' | null {
  const r = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const err = r.error !== null && typeof r.error === 'object' ? (r.error as Record<string, unknown>) : {};
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'max_duration_exceeded' || /timed?_?out|timeout/i.test(code)) return 'timeout';
  // 137: SIGKILL (Linux OOM killer); 0xC0000017 STATUS_NO_MEMORY (signed and unsigned).
  const exit = num(r.exitCode);
  if (exit === 137 || exit === -1073741801 || exit === 3221225495) return 'oom';
  if (/oom|out_of_memory|outofmemory|heap_out/i.test(code)) return 'oom';
  return null;
}

/**
 * Called inside a panel configuration transaction when maxParallelJobs changed for any cause but `capacity`: the
 * manual value wins — auto mode switches to manual (audited, in the history). Suggest mode stays (it changes
 * nothing by itself).
 */
export async function capacityManualOverride(
  tx: Queryable,
  deps: { readonly audit: AuditRecorder; readonly clock: () => Date },
  workerId: string,
  value: number,
  actor: ActorContext | null,
): Promise<boolean> {
  const now = deps.clock();
  const { rows } = await tx.query<{ slots: number | null }>(
    `SELECT slots FROM worker_capacity WHERE worker_id = $1 AND mode = 'auto' FOR UPDATE`,
    [workerId],
  );
  if (rows[0] !== undefined) {
    await tx.query(
      `UPDATE worker_capacity SET mode = 'manual', slots = NULL, state = '{}'::jsonb, last_decision = NULL,
              updated_at = $2, updated_by = $3
        WHERE worker_id = $1`,
      [workerId, now, actor?.userId ?? null],
    );
  }
  const row = rows[0];
  if (row === undefined) return false;
  const reasons: Reason[] = [
    {
      code: 'manual_override',
      text: `maxParallelJobs was set to ${String(value)} by hand: the manual value wins, automatic capacity is off`,
    },
  ];
  await insertEvent(tx, {
    workerId,
    at: now,
    kind: 'override',
    mode: 'manual',
    from: row.slots,
    to: value,
    reasons,
    metrics: null,
    actor,
  });
  await deps.audit.record(
    {
      actor: actor === null ? { type: 'system', id: 'worker-config' } : { type: 'user', id: actor.userId },
      action: 'worker.capacity.mode',
      target: workerId,
      outcome: 'success',
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      metadata: { from: 'auto', to: 'manual', reason: 'manual_override', value },
    },
    tx,
  );
  return true;
}

async function insertEvent(
  tx: Queryable,
  e: {
    workerId: string;
    at: Date;
    kind: CapacityEventView['kind'];
    mode: CapacityMode;
    from: number | null;
    to: number | null;
    reasons: readonly Reason[];
    metrics: Record<string, unknown> | null;
    actor: ActorContext | null;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO worker_capacity_events (worker_id, at, kind, mode, from_slots, to_slots, reasons, metrics,
                                         actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
    [
      e.workerId,
      e.at,
      e.kind,
      e.mode,
      e.from === null ? null : Math.min(HARD_MAX, e.from),
      e.to === null ? null : Math.min(HARD_MAX, e.to),
      JSON.stringify(e.reasons.slice(0, 16)),
      e.metrics === null ? null : JSON.stringify(e.metrics),
      e.actor === null ? 'system' : 'user',
      e.actor?.userId ?? null,
    ],
  );
  await tx.query(
    `DELETE FROM worker_capacity_events WHERE worker_id = $1 AND id < (
       SELECT id FROM worker_capacity_events WHERE worker_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
    [e.workerId, KEPT_EVENTS - 1],
  );
  return rows[0]?.id ?? '0';
}

export class CapacityService {
  #lastPass = 0;
  #running = false;

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      /** Writes the panel configuration's maxParallelJobs with cause `capacity` and delivers it. */
      readonly setConfiguredParallelism: (
        workerId: string,
        value: number,
        actor: ActorContext | null,
        note: string,
      ) => Promise<void>;
    },
  ) {}

  // ------------------------------------------------------------------------------------------------ reads

  async get(workerId: string): Promise<CapacityView> {
    const db = this.deps.pool;
    const w = await this.#facts(db, workerId);
    const row = await this.#row(db, workerId, false);
    const mode = row?.mode ?? 'manual';
    const ctx = await this.#context(db, w, row);
    const upper = upperBound(ctx);
    const last = row?.last_decision ?? null;
    const decisionOf = (d: Record<string, unknown> | null): CapacityView['lastDecision'] => {
      if (d === null || typeof d.at !== 'string') return null;
      const action = d.action;
      if (action !== 'raise' && action !== 'lower' && action !== 'clamp' && action !== 'hold') return null;
      return {
        at: d.at,
        action,
        from: num(d.from) ?? 0,
        to: num(d.to) ?? 0,
        estimate: num(d.estimate),
        reasons: reasonsOf(d.reasons),
      };
    };
    const suggestionValue = last === null ? null : num(last.suggestion);
    const s = ctx.sample;
    const slots = mode === 'auto' ? (row?.slots ?? null) : null;
    return {
      workerId,
      mode,
      min: row?.min_slots ?? 1,
      max: row?.max_slots ?? Math.max(1, Math.min(HARD_MAX, ctx.hardwareCeiling ?? w.reportedMax ?? 1)),
      slots,
      effective:
        slots === null
          ? w.reportedMax
          : w.reportedMax === null
            ? null
            : Math.min(slots, w.reportedMax, w.configured ?? HARD_MAX),
      configured: w.configured,
      reportedMax: w.reportedMax,
      hardwareCeiling: ctx.hardwareCeiling,
      upper,
      managed: w.configured !== null,
      metricsSupported: w.features.includes(CAPACITY_METRICS_FEATURE),
      suggestion:
        mode === 'suggest' && suggestionValue !== null
          ? {
              value: suggestionValue,
              reasons: suggestionReasons({ suggestion: suggestionValue, upper }, ctx),
            }
          : null,
      lastDecision: mode === 'manual' ? null : decisionOf(last),
      metrics: {
        at: s === null ? null : new Date(s.at).toISOString(),
        cpuPercent: s?.cpuPercent ?? null,
        memoryAvailableBytes: s?.memoryAvailableBytes ?? null,
        memoryTotalBytes: w.memoryBytes,
        swapUsedBytes: s?.swapUsedBytes ?? null,
        swapTotalBytes: s?.swapTotalBytes ?? null,
        swapInPerSec: s?.swapInPerSec ?? null,
        commitPercent: s?.commitPercent ?? null,
        memoryPressurePercent: s?.memoryPressurePercent ?? null,
        running: ctx.running,
        waiting: ctx.waiting,
        oomFailures: ctx.oomFailures,
        timeouts: ctx.timeouts,
        slowdownRatio: ctx.slowdownRatio,
      },
      events: await this.events(db, workerId),
    };
  }

  async events(db: Queryable, workerId: string, limit = 200): Promise<CapacityEventView[]> {
    const { rows } = await db.query<{
      id: string;
      at: Date;
      kind: CapacityEventView['kind'];
      mode: CapacityMode;
      from_slots: number | null;
      to_slots: number | null;
      reasons: unknown;
      actor_type: 'user' | 'system';
      actor_id: string | null;
    }>(
      `SELECT id::text AS id, at, kind, mode, from_slots, to_slots, reasons, actor_type, actor_id
         FROM worker_capacity_events WHERE worker_id = $1 ORDER BY id DESC LIMIT $2`,
      [workerId, limit],
    );
    return rows.reverse().map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      kind: r.kind,
      mode: r.mode,
      from: r.from_slots,
      to: r.to_slots,
      reasons: reasonsOf(r.reasons),
      // User ids are not exposed to viewers (the audit log has them).
      actor: { type: r.actor_type, id: null },
    }));
  }

  /** Mode + bounds per worker for the fleet overview (null: manual without a row). */
  async summaries(
    db: Queryable = this.deps.pool,
  ): Promise<
    Map<
      string,
      { mode: CapacityMode; slots: number | null; min: number; max: number; suggestion: number | null }
    >
  > {
    return capacitySummaries(db);
  }

  // ------------------------------------------------------------------------------------------------ writes

  /**
   * Admin + step-up (route): sets the mode and the bounds. Auto needs a panel-managed worker (the configuration
   * must be able to give it room). Entering auto starts at the value in effect (clamped to the bounds); leaving it
   * writes the current slots into the panel configuration first, so nothing jumps.
   */
  async set(
    workerId: string,
    input: { mode: CapacityMode; min: number; max: number },
    actor: ActorContext,
  ): Promise<CapacityView> {
    const { mode } = input;
    const min = Math.floor(input.min);
    const max = Math.floor(input.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > HARD_MAX || min > max) {
      throw invalid('invalid_bounds', `Bounds must satisfy 1 ≤ min ≤ max ≤ ${String(HARD_MAX)}.`);
    }
    const db = this.deps.pool;
    const w = await this.#facts(db, workerId);
    if (!w.approved || w.revoked) {
      throw new HttpError(
        409,
        'worker_not_enrolled',
        'Only approved, non-revoked workers can be configured.',
      );
    }
    const before = await this.#row(db, workerId, false);
    const fromMode = before?.mode ?? 'manual';
    if (mode === 'auto') {
      if (w.configured === null || !w.features.includes(WORKER_CONFIG_FEATURE)) {
        throw new HttpError(
          409,
          'worker_not_managed',
          'Automatic capacity needs a panel-managed worker: take over its configuration first (Configuration tab).',
          {},
          {},
          { reason: 'capacity' },
        );
      }
    }
    // Leaving auto: hand the current value to the panel configuration before the master's cap goes away.
    if (fromMode === 'auto' && mode !== 'auto' && before?.slots !== null && before?.slots !== undefined) {
      await this.deps.setConfiguredParallelism(
        workerId,
        before.slots,
        actor,
        `Capacity: ${mode} mode; keeps the automatic value ${String(before.slots)}`,
      );
    }
    const now = this.deps.clock();
    const result = await withTransaction(db, async (tx) => {
      const row = await this.#row(tx, workerId, true);
      const ctx = await this.#context(tx, w, row);
      const upper = upperBound({ ...ctx, min, max });
      const current =
        row?.mode === 'auto' && row.slots !== null ? row.slots : (w.reportedMax ?? w.configured ?? 1);
      const slots = mode === 'auto' ? Math.max(Math.min(min, upper), Math.min(current, upper)) : null;
      const state = row === null || row.mode !== mode ? EMPTY_STATE : parseState(row.state, row.slots);
      await tx.query(
        `INSERT INTO worker_capacity (worker_id, mode, min_slots, max_slots, slots, state, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (worker_id) DO UPDATE SET mode = EXCLUDED.mode, min_slots = EXCLUDED.min_slots,
           max_slots = EXCLUDED.max_slots, slots = EXCLUDED.slots, state = EXCLUDED.state,
           updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by,
           last_decision = CASE WHEN worker_capacity.mode = EXCLUDED.mode THEN worker_capacity.last_decision END`,
        [
          workerId,
          mode,
          min,
          max,
          slots,
          JSON.stringify(
            storedState({
              ...state,
              lastChangeAt: mode === 'auto' && slots !== current ? now.getTime() : state.lastChangeAt,
            }),
          ),
          now,
          actor.userId,
        ],
      );
      const modeChanged = fromMode !== mode;
      const boundsChanged = row === null || row.min_slots !== min || row.max_slots !== max;
      if (!modeChanged && !boundsChanged) return { changed: false, slots };
      const reasons: Reason[] = [
        {
          code: 'mode_change',
          text: modeChanged
            ? `mode ${fromMode} → ${mode}, bounds ${String(min)}–${String(max)}${slots === null ? '' : `, starts at ${String(slots)}`}`
            : `bounds ${String(row?.min_slots ?? 1)}–${String(row?.max_slots ?? max)} → ${String(min)}–${String(max)}${slots === null ? '' : `, now ${String(slots)}`}`,
        },
      ];
      await insertEvent(tx, {
        workerId,
        at: now,
        kind: modeChanged ? 'mode' : 'bounds',
        mode,
        from: row?.mode === 'auto' ? row.slots : (w.reportedMax ?? null),
        to: slots ?? w.reportedMax ?? null,
        reasons,
        metrics: null,
        actor,
      });
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'worker.capacity.mode',
          target: workerId,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { from: fromMode, to: mode, min, max, ...(slots === null ? {} : { slots }) },
        },
        tx,
      );
      return { changed: true, slots };
    });
    // Entering auto / a new max in auto: give the worker room up to the max (its own limit is then the bound).
    if (mode === 'auto' && w.configured !== max) {
      await this.deps.setConfiguredParallelism(
        workerId,
        max,
        actor,
        `Capacity: automatic ${String(min)}–${String(max)} (the master caps the jobs it sends; now ${String(result.slots ?? min)})`,
      );
    }
    return this.get(workerId);
  }

  // ------------------------------------------------------------------------------------------------ loop

  /** Orchestrator step: evaluates every suggest / auto machine once per `evaluateEveryMs`. Never throws. */
  async tick(): Promise<number> {
    const now = this.deps.clock().getTime();
    if (this.#running || now - this.#lastPass < CAPACITY_TUNING.evaluateEveryMs) return 0;
    this.#running = true;
    this.#lastPass = now;
    try {
      const { rows } = await this.deps.pool.query<{ worker_id: string }>(
        `SELECT c.worker_id FROM worker_capacity c JOIN workers w ON w.id = c.worker_id
          WHERE c.mode IN ('suggest', 'auto') AND w.archived_at IS NULL AND w.revoked_at IS NULL
          ORDER BY c.worker_id`,
      );
      let changed = 0;
      for (const r of rows) {
        try {
          const d = await this.evaluate(r.worker_id);
          if (d !== null && (d.action !== 'hold' || d.notify)) changed++;
        } catch (err) {
          this.deps.log.error({ err, workerId: r.worker_id }, 'capacity evaluation failed');
        }
      }
      return changed;
    } catch (err) {
      this.deps.log.error({ err }, 'capacity pass failed');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  /** One evaluation of one machine (row-locked: several masters never evaluate the same machine at once). */
  async evaluate(workerId: string): Promise<Decision | null> {
    const db = this.deps.pool;
    const w = await this.#facts(db, workerId);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<CapacityRow>(
        `SELECT mode, min_slots, max_slots, slots, state, last_decision, last_evaluated_at FROM worker_capacity
          WHERE worker_id = $1 FOR UPDATE SKIP LOCKED`,
        [workerId],
      );
      const row = rows[0];
      if (row === undefined || row.mode === 'manual') return null;
      const now = this.deps.clock();
      if (
        row.last_evaluated_at !== null &&
        now.getTime() - row.last_evaluated_at.getTime() < CAPACITY_TUNING.evaluateEveryMs - 2_000
      ) {
        return null;
      }
      const ctx = await this.#context(tx, w, row);
      const state = parseState(row.state, row.slots);
      const d = decide(state, ctx);
      const metrics = metricsSnapshot(ctx);
      await tx.query(
        `UPDATE worker_capacity SET slots = $2, state = $3, last_decision = $4, last_evaluated_at = $5
          WHERE worker_id = $1`,
        [
          workerId,
          row.mode === 'auto' ? d.to : row.slots,
          JSON.stringify(storedState(d.state)),
          JSON.stringify({
            at: now.toISOString(),
            action: d.action,
            from: d.from,
            to: d.to,
            upper: d.upper,
            estimate: d.estimate,
            suggestion: d.suggestion,
            reasons: d.reasons,
            metrics,
          }),
          now,
        ],
      );
      if (row.mode === 'auto' && d.action !== 'hold' && d.to !== d.from) {
        await insertEvent(tx, {
          workerId,
          at: now,
          kind: d.action,
          mode: 'auto',
          from: d.from,
          to: d.to,
          reasons: d.reasons,
          metrics,
          actor: null,
        });
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'capacity' },
            action: 'worker.capacity.change',
            target: workerId,
            outcome: 'success',
            metadata: {
              action: d.action,
              from: d.from,
              to: d.to,
              upper: d.upper,
              reasons: d.reasons.map((r) => r.code).join(','),
            },
          },
          tx,
        );
      }
      if (row.mode === 'suggest' && d.notify && d.suggestion !== null) {
        const eventId = await insertEvent(tx, {
          workerId,
          at: now,
          kind: 'suggest',
          mode: 'suggest',
          from: ctx.baseline,
          to: d.suggestion,
          reasons: [...suggestionReasons(d, ctx), ...d.reasons].slice(0, 8),
          metrics,
          actor: null,
        });
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'capacity' },
            action: 'worker.capacity.suggest',
            target: workerId,
            outcome: 'success',
            metadata: { from: ctx.baseline, to: d.suggestion, upper: d.upper },
          },
          tx,
        );
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
          OUTBOX_TOPIC_WORKER_CAPACITY,
          JSON.stringify({ workerId, eventId } satisfies WorkerCapacityOutboxPayload),
          now,
        ]);
      }
      return d;
    });
  }

  // ------------------------------------------------------------------------------------------------ facts

  async #row(db: Queryable, workerId: string, lock: boolean): Promise<CapacityRow | null> {
    const { rows } = await db.query<CapacityRow>(
      `SELECT mode, min_slots, max_slots, slots, state, last_decision, last_evaluated_at FROM worker_capacity
        WHERE worker_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [workerId],
    );
    return rows[0] ?? null;
  }

  async #facts(db: Queryable, workerId: string): Promise<WorkerFacts> {
    if (!WORKER_ID_PATTERN.test(workerId)) throw notFound();
    const { rows } = await db.query<{
      id: string;
      approved_at: Date | null;
      revoked_at: Date | null;
      facts: Record<string, unknown> | null;
      features: unknown;
      load: Record<string, unknown> | null;
      last_seen_at: Date | null;
      max_parallel_jobs: number | null;
      caps_known: boolean;
      configured: unknown;
      running: number;
      installed: string[] | null;
    }>(
      `SELECT w.id, w.approved_at, w.revoked_at, w.facts, w.features, w.load, w.last_seen_at, w.max_parallel_jobs,
              (w.capabilities_at IS NOT NULL AND w.connected_at IS NOT NULL AND w.capabilities_at >= w.connected_at)
                AS caps_known,
              v.spec->'maxParallelJobs' AS configured,
              (SELECT count(*)::int FROM leases l WHERE l.worker_id = w.id AND l.released_at IS NULL) AS running,
              (SELECT array_agg(r.runtime) FROM worker_runtimes r WHERE r.worker_id = w.id AND r.present AND r.installed)
                AS installed
         FROM workers w
         LEFT JOIN worker_configs c ON c.worker_id = w.id
         LEFT JOIN worker_config_versions v ON v.worker_id = w.id AND v.generation = c.generation
        WHERE w.id = $1`,
      [workerId],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    return {
      id: r.id,
      approved: r.approved_at !== null,
      revoked: r.revoked_at !== null,
      os: typeof r.facts?.os === 'string' ? r.facts.os : null,
      features: Array.isArray(r.features) ? r.features.filter((f): f is string => typeof f === 'string') : [],
      cpuCount: num(r.facts?.cpuCount),
      memoryBytes: num(r.facts?.memoryBytes),
      load: r.load,
      lastSeenAt: r.last_seen_at,
      reportedMax: r.max_parallel_jobs,
      configured: num(r.configured),
      running: r.running,
      installed: (r.installed ?? []).flatMap((x) => {
        const k = RuntimeKind.safeParse(x);
        return k.success ? [k.data] : [];
      }),
    };
  }

  async #context(db: Queryable, w: WorkerFacts, row: CapacityRow | null): Promise<ControllerContext> {
    const now = this.deps.clock().getTime();
    const memory = await workerMemory(db);
    const advice = recommendParallelism({
      cpuCount: w.cpuCount,
      memoryBytes: w.memoryBytes,
      installed: w.installed,
      measured: memory.get(w.id) ?? [],
      fleetPeaks: fleetPeaks(memory.values()),
    });
    const ceiling =
      advice === null
        ? null
        : hardwareCeiling({
            cpuCount: w.cpuCount,
            memoryBytes: w.memoryBytes,
            reserveBytes: advice.reserveBytes,
            peakBytes: advice.basis.peakBytes,
          });
    const state = row === null ? EMPTY_STATE : parseState(row.state, row.slots);
    const since = new Date(Math.max(now - CAPACITY_TUNING.trendWindowMs, state.lastChangeAt ?? 0));
    const failures = await db.query<{ result: unknown }>(
      `SELECT r.result FROM job_attempts a JOIN job_runs r ON r.attempt_id = a.id
        WHERE a.worker_id = $1 AND a.state = 'ended' AND a.outcome = 'failed' AND a.ended_at > $2
        ORDER BY a.ended_at DESC LIMIT 50`,
      [w.id, since],
    );
    let oomFailures = 0;
    let timeouts = 0;
    for (const f of failures.rows) {
      const c = classifyFailure(f.result);
      if (c === 'oom') oomFailures++;
      else if (c === 'timeout') timeouts++;
    }
    const waiting = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_schedule_status s JOIN jobs j ON j.id = s.job_id
        WHERE s.status = 'waiting' AND j.state = 'QUEUED'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.reasons) x
                       WHERE x->>'code' = 'no_free_slot' AND x->'workers' ? $1)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.reasons) x
                       WHERE x->>'code' <> 'no_free_slot' AND x->'workers' ? $1)`,
      [w.id],
    );
    const durations = await db.query<{
      recent: number | null;
      baseline: number | null;
      nr: number;
      nb: number;
    }>(
      `WITH d AS (
         SELECT extract(epoch FROM (a.ended_at - a.started_at)) AS sec,
                row_number() OVER (ORDER BY a.ended_at DESC) AS rn
           FROM job_attempts a
          WHERE a.worker_id = $1 AND a.state = 'ended' AND a.outcome = 'succeeded'
          ORDER BY a.ended_at DESC LIMIT 50)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sec) FILTER (WHERE rn <= 10) AS recent,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY sec) FILTER (WHERE rn > 10) AS baseline,
              count(*) FILTER (WHERE rn <= 10)::int AS nr, count(*) FILTER (WHERE rn > 10)::int AS nb FROM d`,
      [w.id],
    );
    const dr = durations.rows[0];
    const slowdownRatio =
      dr !== undefined &&
      dr.nr >= 5 &&
      dr.nb >= 10 &&
      dr.baseline !== null &&
      dr.recent !== null &&
      dr.baseline > 0
        ? dr.recent / dr.baseline
        : null;
    const mode = row?.mode ?? 'manual';
    const baseline = w.reportedMax ?? w.configured ?? 1;
    return {
      now,
      mode,
      min: row?.min_slots ?? 1,
      max: row?.max_slots ?? HARD_MAX,
      hardwareCeiling: ceiling,
      // Auto: the panel configuration says max, so what the worker reports is its local ceiling (if any) — a bound.
      // Suggest / manual: the reported value is the very thing a suggestion may propose to raise — not a bound.
      reportedMax: mode === 'auto' ? w.reportedMax : null,
      baseline: mode === 'auto' ? baseline : Math.min(baseline, w.configured ?? HARD_MAX),
      memoryTotalBytes: w.memoryBytes,
      marginBytes: liveMargin(w.memoryBytes),
      perJobBytes: advice?.perJobBytes ?? 1.5 * 2 ** 30,
      running: w.running,
      waiting: waiting.rows[0]?.n ?? 0,
      oomFailures,
      timeouts,
      slowdownRatio,
      sample: sampleFrom(w.load, w.lastSeenAt, w.os, w.features, w.memoryBytes),
    };
  }
}

function reasonsOf(raw: unknown): Reason[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: unknown) => {
    const o = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    return typeof o.code === 'string' && typeof o.text === 'string'
      ? [{ code: o.code as Reason['code'], text: o.text.slice(0, 300) }]
      : [];
  });
}

function metricsSnapshot(ctx: ControllerContext): Record<string, unknown> {
  const s = ctx.sample;
  return {
    cpuPercent: s?.cpuPercent ?? null,
    memoryAvailableBytes: s?.memoryAvailableBytes ?? null,
    swapInPerSec: s?.swapInPerSec ?? null,
    commitPercent: s?.commitPercent ?? null,
    memoryPressurePercent: s?.memoryPressurePercent ?? null,
    running: ctx.running,
    waiting: ctx.waiting,
    oomFailures: ctx.oomFailures,
    timeouts: ctx.timeouts,
  };
}

/** Mode summary per worker (fleet overview, Fleet list). */
export async function capacitySummaries(
  db: Queryable,
): Promise<
  Map<
    string,
    { mode: CapacityMode; slots: number | null; min: number; max: number; suggestion: number | null }
  >
> {
  const { rows } = await db.query<{
    worker_id: string;
    mode: CapacityMode;
    slots: number | null;
    min_slots: number;
    max_slots: number;
    suggestion: unknown;
  }>(
    `SELECT worker_id, mode, slots, min_slots, max_slots, last_decision->'suggestion' AS suggestion
       FROM worker_capacity WHERE mode <> 'manual'`,
  );
  return new Map(
    rows.map((r) => [
      r.worker_id,
      {
        mode: r.mode,
        slots: r.slots,
        min: r.min_slots,
        max: r.max_slots,
        suggestion: r.mode === 'suggest' ? num(r.suggestion) : null,
      },
    ]),
  );
}
