import { windowBounds } from '@remyral/usage';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import type { CostBrakeMode, CostBrakeSettings } from '../security-policy/model.js';

/**
 * p16-ops-safety §4 (docs/design/p16-ops-safety.md): the model cost brake.
 *
 * Spend = the known dollars of API-billed model usage (jobs: reported + estimated from the price table, the usage
 * store's own numbers; the chat assistant: its turns' reported cost) in the UTC day and the UTC month. Ceilings: the
 * security policy's `costBrake.dailyUsd / monthlyUsd` for the whole installation, `cost_brake_projects` per project (job
 * spend of that project). At `warnPercent` and at 100 % the owners are told once per scope, window and level (audited);
 * the console shows a banner. In `block` mode an exceeded ceiling holds new non-urgent jobs (scope: everything / that
 * project) and refuses new assistant turns (global ceilings) until the window resets, the ceiling is raised or an owner
 * lifts the brake for 1–72 hours (audited). Subscription runs have no per-run dollars (ADR-0014) and never count.
 */

export type CostWindow = 'day' | 'month';
export type CeilingLevel = 'ok' | 'warning' | 'exceeded';

export interface CeilingState {
  /** 'global' or a project id. */
  readonly scope: string;
  readonly window: CostWindow;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly percent: number;
  readonly level: CeilingLevel;
  /** An owner's lift covers it now. */
  readonly lifted: boolean;
}

export interface CostLift {
  readonly id: string;
  readonly scope: string;
  readonly expiresAt: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface CostBrakeState {
  readonly mode: CostBrakeMode;
  readonly warnPercent: number;
  readonly ceilings: readonly CeilingState[];
  readonly lifts: readonly CostLift[];
  /** Exceeded, not lifted ceilings — in block mode these hold work. */
  readonly engaged: readonly CeilingState[];
  /** Block mode and something engaged: work is held / turns refused. */
  readonly blocking: boolean;
  readonly computedAt: string;
}

export interface ProjectCeiling {
  readonly project: string;
  readonly dailyUsd: number | null;
  readonly monthlyUsd: number | null;
  readonly updatedAt: string;
}

export interface CostBrakeDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly settings: () => Promise<CostBrakeSettings>;
  /** Known dollars of job usage in [from, to) — all projects, or one. */
  readonly jobSpend: (project: string | null, from: Date, to: Date) => Promise<number>;
  readonly notifications: () => NotificationService | null;
  /** How long a computed state is reused by admission and the chat (default 30 s; 0 in tests). */
  readonly cacheMs?: number;
}

export const MAX_LIFT_HOURS = 72;
const WINDOWS: readonly CostWindow[] = ['day', 'month'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function levelOf(spent: number, limit: number, warnPercent: number): CeilingLevel {
  if (spent >= limit) return 'exceeded';
  if (spent >= (limit * warnPercent) / 100) return 'warning';
  return 'ok';
}

export class CostBrakeService {
  readonly #cacheMs: number;
  #cached: { at: number; value: CostBrakeState } | null = null;

  constructor(private readonly deps: CostBrakeDeps) {
    this.#cacheMs = deps.cacheMs ?? 30_000;
  }

  invalidate(): void {
    this.#cached = null;
  }

  async #chatSpend(from: Date, to: Date): Promise<number> {
    const { rows } = await this.deps.pool.query<{ cost: string | null }>(
      'SELECT sum(cost_usd)::text AS cost FROM chat_turns WHERE created_at >= $1 AND created_at < $2',
      [from, to],
    );
    return Number(rows[0]?.cost ?? 0);
  }

  async projectCeilings(db: Queryable = this.deps.pool): Promise<ProjectCeiling[]> {
    const { rows } = await db.query<{
      project: string;
      daily_usd: string | null;
      monthly_usd: string | null;
      updated_at: Date;
    }>(
      'SELECT project, daily_usd::text, monthly_usd::text, updated_at FROM cost_brake_projects ORDER BY project',
    );
    return rows.map((r) => ({
      project: r.project,
      dailyUsd: r.daily_usd === null ? null : Number(r.daily_usd),
      monthlyUsd: r.monthly_usd === null ? null : Number(r.monthly_usd),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async #lifts(now: Date): Promise<CostLift[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      scope: string;
      expires_at: Date;
      reason: string;
      created_at: Date;
      username: string | null;
    }>(
      `SELECT l.id::text AS id, l.scope, l.expires_at, l.reason, l.created_at, u.username
         FROM cost_brake_lifts l LEFT JOIN users u ON u.id = l.created_by
        WHERE l.revoked_at IS NULL AND l.expires_at > $1 ORDER BY l.expires_at DESC`,
      [now],
    );
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      expiresAt: r.expires_at.toISOString(),
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      createdBy: r.username,
    }));
  }

  /** The brake now (fresh; {@link current} reuses it for `cacheMs`). */
  async compute(): Promise<CostBrakeState> {
    const now = this.deps.clock();
    const s = await this.deps.settings();
    const lifts = await this.#lifts(now);
    const liftedScopes = new Set(lifts.map((l) => l.scope));
    const ceilings: CeilingState[] = [];
    const add = (
      scope: string,
      window: CostWindow,
      start: Date,
      end: Date,
      spent: number,
      limit: number,
    ): void => {
      const level = levelOf(spent, limit, s.warnPercent);
      ceilings.push({
        scope,
        window,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        spentUsd: round2(spent),
        limitUsd: limit,
        percent: limit <= 0 ? 0 : Math.round((spent / limit) * 1000) / 10,
        level,
        lifted: liftedScopes.has('global') || liftedScopes.has(scope),
      });
    };
    for (const window of WINDOWS) {
      const limit = window === 'day' ? s.dailyUsd : s.monthlyUsd;
      if (limit === null) continue;
      const { start, end } = windowBounds(window, now);
      const spent = (await this.deps.jobSpend(null, start, end)) + (await this.#chatSpend(start, end));
      add('global', window, start, end, spent, limit);
    }
    for (const p of await this.projectCeilings()) {
      for (const window of WINDOWS) {
        const limit = window === 'day' ? p.dailyUsd : p.monthlyUsd;
        if (limit === null) continue;
        const { start, end } = windowBounds(window, now);
        add(p.project, window, start, end, await this.deps.jobSpend(p.project, start, end), limit);
      }
    }
    const engaged = ceilings.filter((c) => c.level === 'exceeded' && !c.lifted);
    const value: CostBrakeState = {
      mode: s.mode,
      warnPercent: s.warnPercent,
      ceilings,
      lifts,
      engaged,
      blocking: s.mode === 'block' && engaged.length > 0,
      computedAt: now.toISOString(),
    };
    this.#cached = { at: Date.now(), value };
    return value;
  }

  async current(): Promise<CostBrakeState> {
    const c = this.#cached;
    if (c !== null && Date.now() - c.at < this.#cacheMs) return c.value;
    return this.compute();
  }

  /**
   * Why a new non-urgent job of `project` must wait now (block mode, an exceeded global ceiling or one of the
   * project's, not lifted), or null.
   */
  async jobBlocked(project: string): Promise<CeilingState | null> {
    // Warn mode never holds anything: no spend is computed on the dispatch path.
    if ((await this.deps.settings()).mode !== 'block') return null;
    const st = await this.current();
    if (!st.blocking) return null;
    return st.engaged.find((c) => c.scope === 'global' || c.scope === project) ?? null;
  }

  /** Why a new assistant turn is refused now (block mode, an exceeded global ceiling, not lifted), or null. */
  async chatBlocked(): Promise<CeilingState | null> {
    if ((await this.deps.settings()).mode !== 'block') return null;
    const st = await this.current();
    if (!st.blocking) return null;
    return st.engaged.find((c) => c.scope === 'global') ?? null;
  }

  /**
   * Crossings since the last pass: one `cost_brake_events` row per (scope, window, window start, level) — the insert
   * that wins sends the `cost.brake` notification to the owners and the audit entry. Returns the new crossings.
   */
  async sweep(): Promise<number> {
    const st = await this.compute();
    let created = 0;
    for (const c of st.ceilings) {
      if (c.level === 'ok') continue;
      const levels: ('warning' | 'exceeded')[] =
        c.level === 'exceeded' ? ['warning', 'exceeded'] : ['warning'];
      for (const level of levels) {
        const won = await withTransaction(this.deps.pool, async (tx) => {
          const ins = await tx.query(
            `INSERT INTO cost_brake_events (scope, time_window, window_start, level, spent_usd, limit_usd, mode, raised_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
            [c.scope, c.window, c.windowStart, level, c.spentUsd, c.limitUsd, st.mode, this.deps.clock()],
          );
          if ((ins.rowCount ?? 0) === 0) return false;
          // Only the highest new level of a pass is announced (crossing straight to 100 % sends one message).
          if (level === 'warning' && c.level === 'exceeded') return true;
          await this.#announce(tx, c, level, st.mode);
          return true;
        });
        if (won) created += 1;
      }
    }
    return created;
  }

  async #announce(
    tx: Queryable,
    c: CeilingState,
    level: 'warning' | 'exceeded',
    mode: CostBrakeMode,
  ): Promise<void> {
    const where = c.scope === 'global' ? 'all model usage' : `project ${c.scope}`;
    const period = c.window === 'day' ? 'today (UTC)' : 'this month (UTC)';
    const amount = `$${c.spentUsd.toFixed(2)} of $${c.limitUsd.toFixed(2)}`;
    const effect =
      level === 'warning'
        ? 'Nothing is held yet.'
        : mode === 'block'
          ? c.scope === 'global'
            ? 'New non-urgent jobs wait and new assistant turns are refused until the window resets, the ceiling is raised or an owner lifts the brake.'
            : `New non-urgent jobs of ${c.scope} wait until the window resets, the ceiling is raised or an owner lifts the brake.`
          : 'The brake is in warn-only mode: nothing is held.';
    const n = this.deps.notifications();
    if (n !== null) {
      await n.notify(tx, await globalRecipients(tx, 'owner'), {
        kind: 'cost.brake',
        severity: level === 'exceeded' ? 'critical' : 'warning',
        title:
          level === 'exceeded'
            ? `Model spend ceiling reached: ${where} ${period}`
            : `Model spend at ${String(Math.floor(c.percent))} % of the ceiling: ${where} ${period}`,
        body: `${amount} spent ${period} on ${where}. ${effect} Settings → Operations safety → Cost brake.`,
        link: '/settings/ops-safety?tab=brake',
        dedupeKey: `cost.brake:${c.scope}:${c.window}:${c.windowStart}:${level}`,
      });
    }
    await this.deps.audit.record(
      {
        actor: { type: 'system', id: 'cost-brake' },
        action: level === 'exceeded' ? 'cost.brake.engaged' : 'cost.brake.warning',
        outcome: 'success',
        target: `cost-brake:${c.scope}`,
        metadata: {
          scope: c.scope,
          window: c.window,
          windowStart: c.windowStart,
          spentUsd: c.spentUsd,
          limitUsd: c.limitUsd,
          mode,
        },
      },
      tx,
    );
  }

  // ------------------------------------------------------------------------------------------------ owner actions

  /** Lifts the brake for `hours` (1–72) for everything or one project (owners; audited). */
  async lift(
    actor: { userId: string; ip: string | null; userAgent: string | null },
    input: { scope: string; hours: number; reason: string },
  ): Promise<CostLift> {
    if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > MAX_LIFT_HOURS) {
      throw new HttpError(
        400,
        'lift_hours_invalid',
        `Lift the brake for 1 to ${String(MAX_LIFT_HOURS)} hours.`,
        {},
        {},
        { max: MAX_LIFT_HOURS },
      );
    }
    const now = this.deps.clock();
    const expires = new Date(now.getTime() + input.hours * 3_600_000);
    const out = await withTransaction(this.deps.pool, async (tx) => {
      if (input.scope !== 'global') {
        const p = await tx.query('SELECT 1 FROM projects WHERE id = $1', [input.scope]);
        if ((p.rowCount ?? 0) === 0) throw new HttpError(404, 'not_found', 'Not found.');
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cost_brake_lifts (scope, expires_at, reason, created_at, created_by) VALUES ($1, $2, $3, $4, $5)
         RETURNING id::text AS id`,
        [input.scope, expires, input.reason.slice(0, 300), now, actor.userId],
      );
      const id = rows[0]?.id ?? '';
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'cost.brake.lift',
          outcome: 'success',
          target: `cost-brake:${input.scope}`,
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { liftId: id, hours: input.hours, expiresAt: expires.toISOString() },
        },
        tx,
      );
      return id;
    });
    this.invalidate();
    return {
      id: out,
      scope: input.scope,
      expiresAt: expires.toISOString(),
      reason: input.reason.slice(0, 300),
      createdAt: now.toISOString(),
      createdBy: null,
    };
  }

  /** Ends a lift early (owners; audited). */
  async endLift(
    actor: { userId: string; ip: string | null; userAgent: string | null },
    id: string,
  ): Promise<void> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await tx.query<{ scope: string }>(
        `UPDATE cost_brake_lifts SET revoked_at = $2, revoked_by = $3
          WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2 RETURNING scope`,
        [id, now, actor.userId],
      );
      const row = r.rows[0];
      if (row === undefined) throw new HttpError(404, 'not_found', 'Not found.');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'cost.brake.lift.end',
          outcome: 'success',
          target: `cost-brake:${row.scope}`,
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { liftId: id },
        },
        tx,
      );
    });
    this.invalidate();
  }

  /** Sets (or with both null removes) a project's ceilings (owners; audited). */
  async setProjectCeiling(
    actor: { userId: string; ip: string | null; userAgent: string | null },
    project: string,
    input: { dailyUsd: number | null; monthlyUsd: number | null },
  ): Promise<ProjectCeiling | null> {
    const now = this.deps.clock();
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const p = await tx.query('SELECT 1 FROM projects WHERE id = $1', [project]);
      if ((p.rowCount ?? 0) === 0) throw new HttpError(404, 'not_found', 'Not found.');
      if (input.dailyUsd === null && input.monthlyUsd === null) {
        await tx.query('DELETE FROM cost_brake_projects WHERE project = $1', [project]);
      } else {
        await tx.query(
          `INSERT INTO cost_brake_projects (project, daily_usd, monthly_usd, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project) DO UPDATE SET daily_usd = EXCLUDED.daily_usd, monthly_usd = EXCLUDED.monthly_usd,
                                               updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [project, input.dailyUsd, input.monthlyUsd, now, actor.userId],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'cost.brake.project',
          outcome: 'success',
          target: `cost-brake:${project}`,
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { dailyUsd: input.dailyUsd, monthlyUsd: input.monthlyUsd },
        },
        tx,
      );
      return (await this.projectCeilings(tx)).find((c) => c.project === project) ?? null;
    });
    this.invalidate();
    return out;
  }
}
