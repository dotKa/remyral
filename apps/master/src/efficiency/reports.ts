import { isValidTimeZone, type Period, periodContaining, weeklySlot } from '@remyral/usage';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { loadSubject } from '../authz/authorizer.js';
import { mdText } from '../chat/watches.js';
import { type Role, visibleProjects } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { NotificationDraft } from '../notifications/model.js';
import type { UsageStore } from '../usage/store.js';
import type { Dashboard, EfficiencyService, Spend, TopJob } from './service.js';
import type { Suggestion } from './suggestions.js';
import { localTime, metricAmount, ON_EXCEEDED_TEXT, scopeText } from './text.js';

/**
 * p8-cost-efficiency §7 (docs/design/p8-cost-efficiency.md): the weekly cost & efficiency report. Every Monday 08:00 in
 * the user's time zone (per-user setting; on by default for owners and admins, opt-in for everyone else) the master
 * builds the report of the week before — what ran, what deployed, failures, spend against budgets, the costliest and
 * slowest jobs and the rule-based suggestions — from stored facts for the projects the user can see, stores it
 * (`efficiency_reports`, one per user and week), and delivers it as an in-app report page, a `report.weekly`
 * notification (e-mail / push only where the user switched them on) and, optionally, a note in one of the user's own
 * chat threads. No LLM call: every sentence is built from numbers, codes and identifiers.
 */

export const REPORT_HOUR = 8;
/** The scheduler looks at most this often (orchestrator ticks are more frequent). */
const TICK_MS = 60_000;
const MAX_USERS_PER_TICK = 50;

export interface ReportSettings {
  readonly timeZone: string;
  readonly weeklyEnabled: boolean;
  readonly chatThreadId: string | null;
  /** True when nothing is stored yet (the defaults apply). */
  readonly isDefault: boolean;
}

export interface WeeklyReportContent {
  readonly version: 1;
  readonly period: {
    readonly start: string;
    readonly end: string;
    readonly timeZone: string;
    readonly label: string;
  };
  readonly projects: readonly string[] | null;
  readonly ran: {
    readonly finished: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly byProject: readonly { project: string; succeeded: number; failed: number; cancelled: number }[];
  };
  readonly deployed: Awaited<ReturnType<EfficiencyService['deployments']>>;
  readonly failures: Awaited<ReturnType<EfficiencyService['failures']>>;
  readonly spend: Spend & {
    readonly previousWeekCostUsd: number;
    readonly previousWeekApiEquivalentUsd: number;
  };
  readonly budgets: readonly {
    id: string;
    name: string;
    scope: string;
    metric: string;
    used: string;
    limit: string;
    ratio: number;
    status: string;
    policy: string;
    windowEnd: string;
  }[];
  readonly topCostly: readonly TopJob[];
  readonly slowest: readonly TopJob[];
  readonly savings: Dashboard['savings'];
  readonly suggestions: readonly Suggestion[];
}

export interface ReportView {
  readonly id: string;
  readonly kind: 'weekly';
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly delivery: Record<string, unknown>;
  readonly content: WeeklyReportContent;
}

export interface ReportListItem {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly summary: string;
}

export interface ReportsDeps {
  readonly pool: Pool;
  readonly efficiency: EfficiencyService;
  readonly usage: UsageStore;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log?: FastifyBaseLogger;
  /** p5-notifications: stores the in-app notification and queues opted-in channels. */
  readonly notify?: () => {
    notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
  } | null;
  /** p5-ops-chat: post a note into one of the user's threads (and wake its stream). */
  readonly chat?: () => {
    addNote(
      db: Queryable,
      threadId: string,
      content: string,
      meta: Record<string, unknown>,
    ): Promise<unknown>;
    publish(threadId: string, message: unknown): void;
  } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReportSettingsInvalidError extends HttpError {
  constructor(readonly issues: readonly { path: string; code: string }[]) {
    super(400, 'report_settings_invalid', 'The report settings are invalid; see issues.');
    this.name = 'ReportSettingsInvalidError';
  }
}

function defaultsFor(role: Role): ReportSettings {
  return {
    timeZone: 'UTC',
    weeklyEnabled: role === 'owner' || role === 'admin',
    chatThreadId: null,
    isDefault: true,
  };
}

/** "12 Oct – 18 Oct 2026" for a week [start, end) on the wall clock of `timeZone`. */
export function weekLabel(p: Period, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' });
  const y = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric' });
  const last = new Date(p.end.getTime() - 1);
  return `${f.format(p.start)} – ${f.format(last)} ${y.format(last)}`;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** A one-line summary (notification body, report list). */
export function summaryLine(c: WeeklyReportContent): string {
  const ran = `${String(c.ran.finished)} jobs finished (${String(c.ran.succeeded)} succeeded, ${String(c.ran.failed)} failed)`;
  const spent = `${c.spend.costComplete ? '' : 'at least '}${usd(c.spend.costUsd)} API spend`;
  const eq =
    c.spend.subscriptionRecords > 0
      ? `, subscription usage worth ~${usd(c.spend.apiEquivalentUsd)} at API prices (estimate)`
      : '';
  const deployed = `${String(c.deployed.total)} deploy / ops actions`;
  const sug = c.suggestions.length === 0 ? '' : `, ${String(c.suggestions.length)} suggestions`;
  return `${ran}; ${spent}${eq}; ${deployed}${sug}.`;
}

/** Markdown for the chat note (names and ids escaped by the caller-supplied `md`). */
export function chatMarkdown(c: WeeklyReportContent, link: string, md: (s: string) => string): string {
  const lines = [
    `**Weekly cost & efficiency report — ${md(c.period.label)}** (${md(c.period.timeZone)})`,
    '',
    `- ${md(summaryLine(c))}`,
  ];
  for (const b of c.budgets.filter((x) => x.status === 'over' || x.status === 'warning').slice(0, 5)) {
    lines.push(
      `- Budget ${md(b.name)}: ${md(b.used)} of ${md(b.limit)} (${String(Math.round(b.ratio * 100))} %)`,
    );
  }
  for (const s of c.suggestions.slice(0, 3)) lines.push(`- Suggestion: ${md(s.title)}`);
  lines.push('', `Full report: ${link}`);
  return lines.join('\n');
}

export class ReportService {
  #lastTick = 0;

  constructor(private readonly deps: ReportsDeps) {}

  // ------------------------------------------------------------------------------------- settings

  async settings(userId: string): Promise<ReportSettings> {
    const { rows } = await this.deps.pool.query<{
      role: Role;
      time_zone: string | null;
      weekly_enabled: boolean | null;
      chat_thread_id: string | null;
    }>(
      `SELECT u.role, s.time_zone, s.weekly_enabled, s.chat_thread_id::text AS chat_thread_id
         FROM users u LEFT JOIN user_report_settings s ON s.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'not_found', 'User not found.', {}, {}, { reason: 'user' });
    if (r.time_zone === null || r.weekly_enabled === null) return defaultsFor(r.role);
    return {
      timeZone: r.time_zone,
      weeklyEnabled: r.weekly_enabled,
      chatThreadId: r.chat_thread_id,
      isDefault: false,
    };
  }

  async updateSettings(
    userId: string,
    input: { timeZone: string; weeklyEnabled: boolean; chatThreadId: string | null },
  ): Promise<ReportSettings> {
    const issues: { path: string; code: string }[] = [];
    if (!isValidTimeZone(input.timeZone)) issues.push({ path: 'timeZone', code: 'invalid' });
    if (input.chatThreadId !== null) {
      // Only one of the user's own, not archived threads (another user's thread is indistinguishable from none).
      const ok =
        UUID.test(input.chatThreadId) &&
        (
          await this.deps.pool.query(
            'SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2 AND archived_at IS NULL',
            [input.chatThreadId, userId],
          )
        ).rowCount === 1;
      if (!ok) issues.push({ path: 'chatThreadId', code: 'not_found' });
    }
    if (issues.length > 0) throw new ReportSettingsInvalidError(issues);
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO user_report_settings (user_id, time_zone, weekly_enabled, chat_thread_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET time_zone = $2, weekly_enabled = $3, chat_thread_id = $4, updated_at = $5`,
        [userId, input.timeZone, input.weeklyEnabled, input.chatThreadId, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'report.settings.update',
          target: `user:${userId}`,
          outcome: 'success',
          metadata: {
            timeZone: input.timeZone,
            weeklyEnabled: input.weeklyEnabled,
            chatThread: input.chatThreadId !== null,
          },
        },
        tx,
      );
    });
    return this.settings(userId);
  }

  // ------------------------------------------------------------------------------------- reading

  async list(userId: string, limit = 26): Promise<ReportListItem[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      period_start: Date;
      period_end: Date;
      time_zone: string;
      generated_at: Date;
      content: WeeklyReportContent;
    }>(
      `SELECT id::text AS id, period_start, period_end, time_zone, generated_at, content
         FROM efficiency_reports WHERE user_id = $1 ORDER BY period_start DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      periodStart: r.period_start.toISOString(),
      periodEnd: r.period_end.toISOString(),
      timeZone: r.time_zone,
      generatedAt: r.generated_at.toISOString(),
      summary: summaryLine(r.content),
    }));
  }

  /** One of the user's own reports (another user's report answers 404 exactly like a missing one). */
  async get(userId: string, id: string): Promise<ReportView> {
    if (!UUID.test(id))
      throw new HttpError(404, 'not_found', 'Report not found.', {}, {}, { reason: 'report' });
    const { rows } = await this.deps.pool.query<{
      id: string;
      period_start: Date;
      period_end: Date;
      time_zone: string;
      generated_at: Date;
      delivery: Record<string, unknown>;
      content: WeeklyReportContent;
    }>(
      `SELECT id::text AS id, period_start, period_end, time_zone, generated_at, delivery, content
         FROM efficiency_reports WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const r = rows[0];
    if (r === undefined)
      throw new HttpError(404, 'not_found', 'Report not found.', {}, {}, { reason: 'report' });
    return {
      id: r.id,
      kind: 'weekly',
      periodStart: r.period_start.toISOString(),
      periodEnd: r.period_end.toISOString(),
      timeZone: r.time_zone,
      generatedAt: r.generated_at.toISOString(),
      delivery: r.delivery,
      content: r.content,
    };
  }

  // ------------------------------------------------------------------------------------- building

  async #projectsOf(userId: string): Promise<{ role: Role; projects: readonly string[] | null } | null> {
    const { rows } = await this.deps.pool.query<{ id: string; role: Role; disabled_at: Date | null }>(
      'SELECT id::text AS id, role, disabled_at FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled_at !== null) return null;
    const subject = await loadSubject(this.deps.pool, { id: u.id, role: u.role });
    return { role: u.role, projects: visibleProjects(subject) };
  }

  /** Builds the report of `week` for the projects `projects` (null = all). Reads only. */
  async build(
    week: Period,
    timeZone: string,
    projects: readonly string[] | null,
  ): Promise<WeeklyReportContent> {
    const eff = this.deps.efficiency;
    const q = {
      from: week.start,
      to: week.end,
      projects,
      timeZone,
      grain: 'day' as const,
      dimension: 'project' as const,
    };
    const d = await eff.dashboard(q);
    const prevWeek = periodContaining('week', new Date(week.start.getTime() - 1), timeZone);
    const prev = await eff.dashboard({ ...q, from: prevWeek.start, to: prevWeek.end });
    const visible = (p: string | null): boolean => projects === null || (p !== null && projects.includes(p));
    const now = this.deps.clock();
    const budgets = (
      await this.deps.usage.evaluateBudgetsOfScopes(
        ['global', 'project', 'runtime', 'provider', 'worker'],
        now,
      )
    ).filter(({ budget }) =>
      budget.scope.type === 'project' ? visible(budget.scope.value) : projects === null,
    );
    return {
      version: 1,
      period: {
        start: week.start.toISOString(),
        end: week.end.toISOString(),
        timeZone,
        label: weekLabel(week, timeZone),
      },
      projects: projects === null ? null : [...projects],
      ran: {
        finished: d.outcomes.finished,
        succeeded: d.outcomes.succeeded,
        failed: d.outcomes.failed,
        cancelled: d.outcomes.cancelled,
        byProject: d.breakdown.rows
          .filter((r) => r.key !== null && r.succeeded + r.failed + r.cancelled > 0)
          .map((r) => ({
            project: r.label,
            succeeded: r.succeeded,
            failed: r.failed,
            cancelled: r.cancelled,
          }))
          .slice(0, 20),
      },
      deployed: await eff.deployments(q),
      failures: await eff.failures(q),
      spend: {
        ...d.totals,
        previousWeekCostUsd: prev.totals.costUsd,
        previousWeekApiEquivalentUsd: prev.totals.apiEquivalentUsd,
      },
      budgets: budgets.map(({ budget, evaluation }) => ({
        id: budget.id,
        name: budget.name,
        scope: scopeText(budget.scope),
        metric: budget.metric,
        used: metricAmount(budget.metric, evaluation.used),
        limit: metricAmount(budget.metric, budget.limit),
        ratio: evaluation.ratio,
        status: evaluation.status,
        policy: ON_EXCEEDED_TEXT[budget.onExceeded],
        windowEnd: localTime(evaluation.window.end, budget.timeZone),
      })),
      topCostly: d.topCostly.slice(0, 5),
      slowest: d.slowest.slice(0, 5),
      savings: d.savings,
      suggestions: (await eff.suggestions(projects)).slice(0, 10),
    };
  }

  /** The report the user would get for the last full week (or the week so far), without storing anything. */
  async preview(userId: string, which: 'last' | 'current'): Promise<WeeklyReportContent> {
    const who = await this.#projectsOf(userId);
    if (who === null) throw new HttpError(404, 'not_found', 'User not found.', {}, {}, { reason: 'user' });
    const { timeZone } = await this.settings(userId);
    const now = this.deps.clock();
    const week =
      which === 'last'
        ? weeklySlot(now, timeZone, 0).week
        : { start: periodContaining('week', now, timeZone).start, end: now };
    return this.build(week, timeZone, who.projects);
  }

  /**
   * Generates (once) and delivers the weekly report of `week` for `userId`. Idempotent: the unique
   * (user, kind, week) row decides; only the transaction that inserts it notifies and posts.
   */
  async generate(
    userId: string,
    week: Period,
    timeZone: string,
  ): Promise<{ id: string; created: boolean } | null> {
    const who = await this.#projectsOf(userId);
    if (who === null) return null;
    const content = await this.build(week, timeZone, who.projects);
    const settings = await this.settings(userId);
    const now = this.deps.clock();
    const posted: { threadId: string; message: unknown }[] = [];
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO efficiency_reports (user_id, kind, period_start, period_end, time_zone, content, generated_at)
         VALUES ($1, 'weekly', $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, kind, period_start) DO NOTHING RETURNING id::text AS id`,
        [userId, week.start, week.end, timeZone, JSON.stringify(content), now],
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        const { rows: existing } = await tx.query<{ id: string }>(
          `SELECT id::text AS id FROM efficiency_reports WHERE user_id = $1 AND kind = 'weekly' AND period_start = $2`,
          [userId, week.start],
        );
        return { id: existing[0]?.id ?? '', created: false };
      }
      const link = `/usage/reports/${id}`;
      const notifier = this.deps.notify?.() ?? null;
      const notified =
        notifier === null
          ? 0
          : await notifier.notify(tx, [userId], {
              kind: 'report.weekly',
              severity: 'info',
              title: `Weekly cost & efficiency report: ${content.period.label}`,
              body: summaryLine(content),
              link,
              dedupeKey: `report.weekly:${week.start.toISOString()}`,
            });
      let chatThreadId: string | null = null;
      const chat = this.deps.chat?.() ?? null;
      if (chat !== null && settings.chatThreadId !== null) {
        const own = await tx.query(
          'SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2 AND archived_at IS NULL',
          [settings.chatThreadId, userId],
        );
        if (own.rowCount === 1) {
          const message = await chat.addNote(tx, settings.chatThreadId, chatMarkdown(content, link, mdText), {
            notice: 'weekly-report',
            reportId: id,
          });
          posted.push({ threadId: settings.chatThreadId, message });
          chatThreadId = settings.chatThreadId;
        }
      }
      await tx.query('UPDATE efficiency_reports SET delivery = $2 WHERE id = $1', [
        id,
        JSON.stringify({ notification: notified > 0, chatThreadId }),
      ]);
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'reports' },
          action: 'report.weekly.generate',
          target: `user:${userId}`,
          outcome: 'success',
          metadata: {
            reportId: id,
            periodStart: week.start.toISOString(),
            timeZone,
            notified: notified > 0,
            chat: chatThreadId !== null,
            suggestions: content.suggestions.length,
          },
        },
        tx,
      );
      return { id, created: true };
    });
    const chat = this.deps.chat?.() ?? null;
    for (const p of posted) chat?.publish(p.threadId, p.message);
    return result;
  }

  /**
   * Scheduler (orchestrator tick step, self-throttled to once a minute): every user whose weekly report is on and whose
   * latest Monday 08:00 (own zone) has passed gets the report of the week before it, once. A master that was down at
   * 08:00 catches up on its next tick; only the latest week is generated (no backfill of older weeks).
   */
  async tick(force = false): Promise<number> {
    const nowMs = this.deps.clock().getTime();
    if (!force && nowMs - this.#lastTick < TICK_MS) return 0;
    this.#lastTick = nowMs;
    const now = new Date(nowMs);
    const { rows } = await this.deps.pool.query<{ id: string; time_zone: string | null }>(
      `SELECT u.id::text AS id, s.time_zone FROM users u LEFT JOIN user_report_settings s ON s.user_id = u.id
        WHERE u.disabled_at IS NULL AND u.kind = 'human' AND COALESCE(s.weekly_enabled, u.role IN ('owner', 'admin'))
        ORDER BY u.id`,
    );
    let created = 0;
    for (const u of rows) {
      if (created >= MAX_USERS_PER_TICK) break;
      const zone = u.time_zone !== null && isValidTimeZone(u.time_zone) ? u.time_zone : 'UTC';
      const { slot, week } = weeklySlot(now, zone, REPORT_HOUR);
      if (slot.getTime() > nowMs) continue;
      // Already reported — also when the user changed zone this week: a report whose week overlaps this one by
      // more than a day (e.g. the UTC week vs the Istanbul week) counts, so a week is never reported twice.
      const exists = await this.deps.pool.query(
        `SELECT 1 FROM efficiency_reports WHERE user_id = $1 AND kind = 'weekly'
            AND LEAST(period_end, $3) - GREATEST(period_start, $2) > interval '1 day'`,
        [u.id, week.start, week.end],
      );
      if (exists.rowCount === 1) continue;
      try {
        const r = await this.generate(u.id, week, zone);
        if (r?.created === true) created++;
      } catch (err) {
        this.deps.log?.warn({ err, userId: u.id }, 'weekly report generation failed');
      }
    }
    return created;
  }
}
