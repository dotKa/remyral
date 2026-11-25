import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { NotificationDraft, Severity } from '../notifications/model.js';
import { globalRecipients } from '../notifications/recipients.js';
import {
  ALERT_RULES,
  type AlertRule,
  type AlertThresholds,
  alertLink,
  type BudgetSample,
  type Condition,
  DEFAULT_THRESHOLDS,
  RULE_TITLE,
  RULES,
} from './rules.js';

/**
 * Alert evaluator (p6-alerts, docs/design/p6-observability.md §6): works without any external Prometheus.
 * Every `intervalMs` it evaluates the rules against Postgres and reconciles them with `alert_states`:
 *
 * - **fire**: a new instance → `firing`, one `alert` notification to owners/admins (in-app + their opted-in
 *   e-mail/webhook through the p5-notifications delivery queue), audited.
 * - **dedupe**: the notification dedupe key is `alert:<rule>:<instance>:<episode>:<event>`, so a repeated
 *   evaluation (or a second master replica) never notifies twice; the pass runs under an advisory lock.
 * - **escalate**: warning → critical while firing notifies once more (`…:critical`).
 * - **resolve**: a firing instance whose condition no longer holds → `resolved`, one notification.
 * - **cooldown**: an instance that fires again within `cooldownMs` of resolving re-opens the *same*
 *   episode silently (no flapping storm) — and that episode's later resolution is not announced twice;
 *   after the cooldown it is a new episode and notifies again.
 * - **resolve hysteresis** (p22-ops-hygiene): a firing instance resolves only after its condition stayed clear for
 *   `resolveAfterMs` (default 15 min; `alert_states.clear_since`); a condition that comes back before resolves nothing
 *   and notifies nothing (the queue backlog / failure spike alarms flapped 100 times in two weeks).
 *
 * A rule that throws is skipped for the pass (its firing instances are kept, never falsely resolved).
 */
export interface AlertNotifier {
  notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
}

export type AlertEventKind = 'fired' | 'resolved' | 'escalated';

export interface AlertEvent {
  readonly kind: AlertEventKind;
  readonly rule: AlertRule;
  readonly instance: string;
  readonly severity: Severity;
  readonly episode: number;
  readonly details: Readonly<Record<string, number | string>>;
  readonly at: Date;
}

export interface AlertEvaluatorDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly notifications: AlertNotifier;
  readonly clock?: () => Date;
  readonly log?: FastifyBaseLogger;
  readonly thresholds?: Partial<AlertThresholds>;
  /** Default 30 min. */
  readonly cooldownMs?: number;
  /** p22-ops-hygiene: how long a condition must stay clear before its alert resolves. Default 15 min; 0: at once. */
  readonly resolveAfterMs?: number;
  /** Enabled budgets evaluated now (UsageStore); none when absent. */
  readonly budgets?: () => Promise<readonly BudgetSample[]>;
  /** Observers of committed alert events (p6-agentmagnify, metrics). Errors are logged and ignored. */
  readonly listeners?: readonly ((e: AlertEvent) => void)[];
}

export interface EvaluationReport {
  readonly fired: string[];
  readonly resolved: string[];
  readonly escalated: string[];
  readonly failedRules: AlertRule[];
}

interface StateRow {
  rule: AlertRule;
  instance: string;
  status: 'firing' | 'resolved';
  severity: Severity;
  episode: number;
  resolved_at: Date | null;
  clear_since: Date | null;
}

/** p22-ops-hygiene: default time a condition must stay clear before its alert resolves. */
export const DEFAULT_RESOLVE_AFTER_MS = 15 * 60_000;

/**
 * p22-ops-hygiene: what a pass does with a *firing* instance whose condition was not found (pure; unit-tested).
 * `start-clear`: remember when it went clear; `wait`: still inside the hold; `resolve`: clear for long enough.
 */
export function clearDecision(
  clearSince: Date | null,
  now: Date,
  resolveAfterMs: number,
): 'start-clear' | 'wait' | 'resolve' {
  if (resolveAfterMs <= 0) return 'resolve';
  if (clearSince === null) return 'start-clear';
  return now.getTime() - clearSince.getTime() >= resolveAfterMs ? 'resolve' : 'wait';
}

/** Whether a resolved instance that fires again re-opens its episode silently (inside the cooldown). */
export function withinCooldown(resolvedAt: Date | null, now: Date, cooldownMs: number): boolean {
  return resolvedAt !== null && now.getTime() - resolvedAt.getTime() < cooldownMs;
}

const LOCK = "hashtext('remyral-alert-evaluator')";
const RANK: Readonly<Record<Severity, number>> = { info: 0, warning: 1, critical: 2 };

function describe(c: { instance: string; details: Readonly<Record<string, number | string>> }): string {
  const parts = Object.entries(c.details).map(([k, v]) => `${k}=${String(v)}`);
  return [`instance=${c.instance}`, ...parts].join(', ');
}

export class AlertEvaluator {
  readonly #d: AlertEvaluatorDeps;
  readonly #now: () => Date;
  readonly #t: AlertThresholds;
  readonly #cooldownMs: number;
  readonly #resolveAfterMs: number;

  constructor(deps: AlertEvaluatorDeps) {
    this.#d = deps;
    this.#now = deps.clock ?? (() => new Date());
    this.#t = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
    this.#cooldownMs = deps.cooldownMs ?? 30 * 60_000;
    this.#resolveAfterMs = deps.resolveAfterMs ?? DEFAULT_RESOLVE_AFTER_MS;
  }

  /** Currently firing alerts (tests, diagnostics). */
  async firing(): Promise<{ rule: AlertRule; instance: string; severity: Severity }[]> {
    const { rows } = await this.#d.pool.query<{ rule: AlertRule; instance: string; severity: Severity }>(
      "SELECT rule, instance, severity FROM alert_states WHERE status = 'firing' ORDER BY rule, instance",
    );
    return rows;
  }

  async evaluate(): Promise<EvaluationReport> {
    const now = this.#now();
    const report: EvaluationReport = { fired: [], resolved: [], escalated: [], failedRules: [] };
    const events: AlertEvent[] = [];
    await withTransaction(this.#d.pool, async (tx) => {
      const { rows: lock } = await tx.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(${LOCK}) AS ok`,
      );
      if (lock[0]?.ok !== true) return;
      const conditions = new Map<string, Condition>();
      const evaluated = new Set<AlertRule>();
      for (const rule of ALERT_RULES) {
        // A savepoint per rule: a failing query must not abort the whole pass's transaction.
        await tx.query('SAVEPOINT alert_rule');
        try {
          const found = await RULES[rule]({
            db: tx,
            now,
            t: this.#t,
            budgets: this.#d.budgets ?? (() => Promise.resolve([])),
          });
          await tx.query('RELEASE SAVEPOINT alert_rule');
          for (const c of found) conditions.set(`${c.rule}|${c.instance}`, c);
          evaluated.add(rule);
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT alert_rule');
          report.failedRules.push(rule);
          this.#d.log?.warn({ err, rule }, 'alert rule evaluation failed; its alerts are left unchanged');
        }
      }
      const { rows: states } = await tx.query<StateRow>(
        'SELECT rule, instance, status, severity, episode, resolved_at, clear_since FROM alert_states FOR UPDATE',
      );
      const byKey = new Map(states.map((s) => [`${s.rule}|${s.instance}`, s]));
      let recipients: string[] | null = null;
      const send = async (event: AlertEvent): Promise<void> => {
        recipients ??= await globalRecipients(tx, 'admin');
        const title =
          event.kind === 'resolved'
            ? `Resolved: ${RULE_TITLE[event.rule]}`
            : `${event.severity === 'critical' ? 'CRITICAL' : 'Alarm'}: ${RULE_TITLE[event.rule]}`;
        await this.#d.notifications.notify(tx, recipients, {
          kind: 'alert',
          severity: event.kind === 'resolved' ? 'info' : event.severity,
          title,
          body: describe(event),
          link: alertLink(event.rule, event.instance),
          dedupeKey: `alert:${event.rule}:${event.instance}:${String(event.episode)}:${event.kind === 'escalated' ? event.severity : event.kind}`,
        });
        await this.#d.audit.record(
          {
            actor: { type: 'system', id: 'alerts' },
            action:
              event.kind === 'resolved'
                ? 'alert.resolve'
                : event.kind === 'fired'
                  ? 'alert.fire'
                  : 'alert.escalate',
            target: `alert:${event.rule}:${event.instance}`,
            outcome: 'success',
            metadata: { severity: event.severity, episode: event.episode, ...event.details },
          },
          tx,
        );
        events.push(event);
      };

      for (const [key, c] of conditions) {
        const s = byKey.get(key);
        const details = JSON.stringify(c.details);
        if (s === undefined) {
          await tx.query(
            `INSERT INTO alert_states (rule, instance, status, severity, episode, fired_at, last_evaluated_at, details)
             VALUES ($1, $2, 'firing', $3, 1, $4, $4, $5)`,
            [c.rule, c.instance, c.severity, now, details],
          );
          await send({ ...c, kind: 'fired', episode: 1, at: now });
          report.fired.push(key);
        } else if (s.status === 'resolved') {
          const silent = withinCooldown(s.resolved_at, now, this.#cooldownMs);
          const episode = silent ? s.episode : s.episode + 1;
          await tx.query(
            `UPDATE alert_states SET status = 'firing', severity = $3, episode = $4, fired_at = $5,
                    resolved_at = NULL, clear_since = NULL, last_evaluated_at = $5, details = $6
              WHERE rule = $1 AND instance = $2`,
            [c.rule, c.instance, c.severity, episode, now, details],
          );
          if (!silent) {
            await send({ ...c, kind: 'fired', episode, at: now });
            report.fired.push(key);
          }
        } else {
          const escalate = RANK[c.severity] > RANK[s.severity];
          await tx.query(
            `UPDATE alert_states SET severity = $3, last_evaluated_at = $4, details = $5, clear_since = NULL
              WHERE rule = $1 AND instance = $2`,
            [c.rule, c.instance, RANK[c.severity] > RANK[s.severity] ? c.severity : s.severity, now, details],
          );
          if (escalate) {
            await send({ ...c, kind: 'escalated', episode: s.episode, at: now });
            report.escalated.push(key);
          }
        }
      }
      for (const s of states) {
        const key = `${s.rule}|${s.instance}`;
        if (s.status !== 'firing' || conditions.has(key) || !evaluated.has(s.rule)) continue;
        const decision = clearDecision(s.clear_since, now, this.#resolveAfterMs);
        if (decision !== 'resolve') {
          // Clear, but not for long enough yet: no notification (a condition that comes back resolves nothing).
          await tx.query(
            `UPDATE alert_states SET last_evaluated_at = $3, clear_since = COALESCE(clear_since, $3)
              WHERE rule = $1 AND instance = $2`,
            [s.rule, s.instance, now],
          );
          continue;
        }
        await tx.query(
          `UPDATE alert_states SET status = 'resolved', resolved_at = $3, last_evaluated_at = $3, clear_since = NULL
            WHERE rule = $1 AND instance = $2`,
          [s.rule, s.instance, now],
        );
        await send({
          rule: s.rule,
          instance: s.instance,
          severity: s.severity,
          episode: s.episode,
          details: {},
          kind: 'resolved',
          at: now,
        });
        report.resolved.push(key);
      }
    });
    for (const e of events) {
      for (const l of this.#d.listeners ?? []) {
        try {
          l(e);
        } catch (err) {
          this.#d.log?.warn({ err }, 'alert listener failed');
        }
      }
    }
    return report;
  }

  /** Background loop; returns a stop function. Errors are reported, never thrown. */
  start(intervalMs: number, onError: (err: unknown) => void): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.evaluate()
        .catch(onError)
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}
