import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { NotificationService } from '../notifications/service.js';
import type { ActorContext } from '../workers/fleet.js';
import {
  claimDelivery,
  completeDelivery,
  type DeliveryRef,
  failDelivery,
  reapDeliveries,
  releaseDelivery,
} from './deliveries.js';
import {
  assessGoal,
  defaultOutcome,
  GOAL_PROGRESS_MS,
  type GoalAssessment,
  type GoalFacts,
  goalFingerprint,
  type GoalOrigin,
  type GoalOwner,
  type GoalPlanFact,
  type GoalRecordFact,
  type GoalState,
  goalText,
} from './goal-model.js';
import type { MessageView } from './store.js';
import { parseStepOutcome } from '@remyral/protocol';
import { attentionLine, attentionOf } from './flow-model.js';
import { attentionWords } from './job-result.js';
import { guessLanguage } from './watches.js';

/**
 * p20-outcome (docs/design/p20-outcome-contract.md): work must never sit idle — it either continues or asks for a
 * person's intervention. The goal ledger: every open goal born in a conversation — a job or
 * workflow run a card started, an approved plan, a watch — has one `chat_goals` row that says who moves it next; when
 * nobody does (the automatic recovery ran out, a cap was reached, the reevaluate time passed without progress, the
 * assistant is unreachable) the goal becomes ONE persistent intervention on "Senden bekleyen", notified once.
 *
 * Not a scheduler: a step of the orchestrator loop that adopts new records (`chat_goal_links`), reads their state from
 * the columns their own flows write (jobs, workflow_runs, chat_plans, chat_watches, chat_deliveries) and records the
 * result; hooks of those flows only make it sooner. A restart converges on the next pass.
 */

const BATCH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GOAL_STATES = ['open', 'done', 'intervention', 'cancelled'] as const;

/** What the goals need of the chat service. */
export interface GoalChat {
  idle(threadId: string): Promise<boolean>;
  status(): Promise<{ readonly available: boolean }>;
  send(
    actor: ActorContext,
    threadId: string,
    text: string,
    opts: { readonly goal: { readonly goalId: string }; readonly delivery?: DeliveryRef },
  ): Promise<{ turnId: string }>;
}

/** What the goals need of the plan service ("Devam ettir" / "Vazgeç" of a plan goal are the plan's own). */
export interface GoalPlans {
  resume(actor: ActorContext, planId: string): Promise<unknown>;
  cancel(actor: ActorContext, planId: string): Promise<unknown>;
}

/** What the goals need of the watch service ("Vazgeç" stops the goal's active watches). */
export interface GoalWatches {
  cancel(userId: string, watchId: string): Promise<unknown>;
}

export interface GoalDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly addMessage: (
    threadId: string,
    m: { role: 'assistant'; content: string; meta: Record<string, unknown> },
    tx: Queryable,
  ) => Promise<MessageView>;
  /** After commit: a note into the conversation's stream; `watch` makes its view reload (the goal changed). */
  readonly publish: (threadId: string, event: 'message' | 'watch', data: unknown) => void;
  readonly notifications: () => NotificationService | null;
  readonly chat: () => GoalChat | null;
  readonly plans: () => GoalPlans | null;
  readonly watches: () => GoalWatches | null;
}

export interface GoalView {
  readonly id: string;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly origin: { readonly kind: GoalOrigin; readonly id: string };
  readonly title: string;
  readonly outcomeCondition: string;
  readonly nextAction: string | null;
  readonly nextNote: string | null;
  readonly owner: GoalOwner;
  readonly blockedReason: string | null;
  readonly reevaluateAt: string | null;
  readonly state: GoalState;
  readonly detail: string | null;
  readonly userAction: string | null;
  readonly interventions: number;
  readonly links: { readonly kind: string; readonly id: string }[];
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly interventionAt: string | null;
  readonly closedAt: string | null;
}

interface GoalRow {
  id: string;
  user_id: string;
  thread_id: string | null;
  origin_kind: GoalOrigin;
  origin_id: string;
  title: string;
  outcome_condition: string;
  next_action: string | null;
  next_note: string | null;
  owner: GoalOwner;
  blocked_reason: string | null;
  reevaluate_at: Date | null;
  state: GoalState;
  detail: string | null;
  user_action: string | null;
  declared: boolean;
  episode: number;
  notified_episode: number;
  interventions: number;
  follow_ups: number;
  fingerprint: string | null;
  opened_at: Date;
  updated_at: Date;
  last_progress_at: Date;
  intervention_at: Date | null;
  closed_at: Date | null;
}

const GOAL_COLUMNS = `g.id::text AS id, g.user_id::text AS user_id, g.thread_id::text AS thread_id, g.origin_kind,
  g.origin_id::text AS origin_id, g.title, g.outcome_condition, g.next_action, g.next_note, g.owner, g.blocked_reason,
  g.reevaluate_at, g.state, g.detail, g.user_action, g.declared, g.episode, g.notified_episode, g.interventions,
  g.follow_ups, g.fingerprint, g.opened_at, g.updated_at, g.last_progress_at, g.intervention_at, g.closed_at`;

/** Where a turn came from (the message that started it): a plan / watch follow-up / goal resume turn names its record. */
interface TurnOrigin {
  readonly plan: string | null;
  readonly watch: string | null;
  readonly goal: string | null;
}

/** The intervention texts of the notification and the conversation note (plain; the card renders its own words). */
export function interventionNotice(
  lang: 'tr' | 'en',
  title: string,
  reason: string,
  detail: string | null,
): { title: string; body: string; note: string } {
  const tr = lang === 'tr';
  const why = reasonText(lang, reason);
  const d = detail === null ? '' : ` (${detail})`;
  return tr
    ? {
        title: `Müdahalen gerekiyor: ${title}`.slice(0, 200),
        body: `${why}${d}. Senden bekleyen sayfasından devam ettirebilir ya da vazgeçebilirsin.`.slice(
          0,
          1000,
        ),
        note: `Bu hedef kendi kendine ilerleyemiyor: ${why}${d}. "Senden bekleyen" sayfasında bir müdahale kartı açıldı — oradan devam ettirebilir ya da vazgeçebilirsin.`,
      }
    : {
        title: `Your intervention is needed: ${title}`.slice(0, 200),
        body: `${why}${d}. Resume it or give it up on the Needs you page.`.slice(0, 1000),
        note: `This goal cannot move on by itself: ${why}${d}. An intervention card is open on "Needs you" — resume it or give it up there.`,
      };
}

/** The coded reason in words (server side: notification and conversation note). */
export function reasonText(lang: 'tr' | 'en', reason: string): string {
  const tr = lang === 'tr';
  const [code, sub] = reason.split(':');
  switch (code) {
    case 'follow_up_cap':
      return tr
        ? 'otomatik devam sınırına ulaşıldı (6 saatte 3)'
        : 'the automatic follow-up limit was reached (3 in 6 hours)';
    case 'follow_up_window':
      return tr
        ? 'takip bitti ama devam turu zamanında başlamadı'
        : 'the watch ended but no follow-up turn started in time';
    case 'assistant_unavailable':
      return tr ? 'asistan şu an erişilemiyor' : 'the assistant is unreachable';
    case 'assistant_error':
      return tr ? 'asistan devam turunu başlatamadı' : 'the assistant could not start the follow-up turn';
    case 'budget':
      return tr
        ? 'harcama freni ya da günlük bütçe devamı durdurdu'
        : 'the cost brake or the daily budget stopped it';
    case 'job_failed':
      return tr
        ? 'iş başarısız oldu ve otomatik düzeltme kalmadı'
        : 'the job failed and no automatic fix is left';
    case 'run_failed':
      return tr ? 'workflow çalışması başarısız oldu' : 'the workflow run failed';
    case 'plan_stalled':
      return tr ? `plan durdu (${sub ?? '—'})` : `the plan stalled (${sub ?? '—'})`;
    case 'plan_item_failed':
      return tr ? 'bir plan maddesi denemelerini tüketti' : 'a plan item used up its retries';
    case 'no_progress':
      return tr ? 'beklenen sürede ilerleme olmadı' : 'nothing moved in the expected time';
    case 'check_due':
      return tr ? 'kendi kontrol zamanın geldi' : 'the time you set to look again has come';
    case 'assistant_declared':
      return tr ? 'asistan senden bir şey bekliyor' : 'the assistant needs something from you';
    default:
      return tr ? 'ilerleyemiyor' : 'it cannot move on';
  }
}

/**
 * p21-goal-check: the blocked reason of a goal whose assistant-set reevaluate time came. Instead of an intervention
 * card the assistant gets a goal continuation turn (at most {@link GOAL_AUTO_CHECKS} per goal); only after those it is
 * the user's card.
 */
export const GOAL_CHECK_REASON = 'check_due';
export const GOAL_AUTO_CHECKS = 2;

/** The system-written message of a goal resume turn ("Devam ettir", or the assistant's own check time). */
export function resumeText(
  lang: 'tr' | 'en',
  g: {
    readonly id: string;
    readonly title: string;
    readonly outcome: string;
    readonly reason: string | null;
    readonly nextNote?: string | null;
  },
  detail: string | null,
): string {
  const tr = lang === 'tr';
  const why = g.reason === null ? (tr ? 'durdu' : 'stopped') : reasonText(lang, g.reason);
  const d = detail === null ? '' : ` (${detail})`;
  if (g.reason === GOAL_CHECK_REASON) {
    // p21-goal-check: the assistant's own reevaluate time came — its turn, not the user's card.
    const step =
      g.nextNote === null || g.nextNote === undefined
        ? ''
        : tr
          ? ` Kaydettiğin sıradaki adım: ${g.nextNote}.`
          : ` The next step you recorded: ${g.nextNote}.`;
    return tr
      ? `Hedefe devam: ${g.title} — ${why}${d}.${step} Hedef kaydını oku (list_goals, goalId ${g.id}; sonuç koşulu: ${g.outcome}), şimdiki durumu okumalarla kontrol et (servis / iş durumu ve günlükleri) ve kullanıcıya sonucu yaz. Bitti ise goal_update ile kapat; daha beklemek gerekiyorsa goal_update ile yeni adımı ve süreyi yaz; düzeltme senin elinde değilse goal_update state intervention ile kullanıcının tam olarak ne yapması gerektiğini yaz. Kısa yaz.`
      : `Resume the goal: ${g.title} — ${why}${d}.${step} Read the goal (list_goals, goalId ${g.id}; outcome: ${g.outcome}), check where it stands now with reads (service / job state and logs) and tell the user the result. If it is done, close it with goal_update; if it needs more time, record the next step and time with goal_update; if the fix is not in your hands, call goal_update with state intervention and exactly what the user has to do. Be brief.`;
  }
  return tr
    ? `Hedefe devam: ${g.title} — ${why}${d}. Kullanıcı müdahale kartından "Devam ettir" dedi. Hedef kaydını oku (list_goals, goalId ${g.id}; sonuç koşulu: ${g.outcome}), nedenini okumalarla bul ve işe devam et; aynı yöntemi aynen tekrar deneme. İlerlediğinde goal_update ile sıradaki adımı yaz; düzeltme senin elinde değilse goal_update state intervention ile kullanıcının tam olarak ne yapması gerektiğini yaz. Kısa yaz.`
    : `Resume the goal: ${g.title} — ${why}${d}. The user pressed "Resume" on the intervention card. Read the goal (list_goals, goalId ${g.id}; outcome: ${g.outcome}), find out why with reads and carry on; do not repeat the same approach unchanged. When it moves, record the next step with goal_update; if the fix is not in your hands, call goal_update with state intervention and exactly what the user has to do. Be brief.`;
}

export class GoalLedger {
  #lastStep = 0;
  #since: Date | null = null;
  readonly #sending = new Set<string>();

  constructor(private readonly deps: GoalDeps) {}

  step(everyMs = 5_000): { name: string; run: () => Promise<number> } {
    return {
      name: 'chat-goals',
      run: async () => {
        const t = this.deps.clock().getTime();
        if (t - this.#lastStep < everyMs) return 0;
        this.#lastStep = t;
        return this.tick();
      },
    };
  }

  /** One pass: adopt new records, assess the live goals, send the resume turns the person asked for. */
  async tick(): Promise<number> {
    const now = this.deps.clock();
    const since = await this.#ledgerSince(now);
    let n = 0;
    try {
      n += await this.#discover(since, now);
    } catch (err) {
      this.deps.log.warn({ err }, 'goals not adopted');
    }
    let available = true;
    try {
      available = (await this.deps.chat()?.status())?.available ?? false;
    } catch {
      available = false;
    }
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM chat_goals WHERE state IN ('open', 'intervention') ORDER BY updated_at LIMIT 200`,
    );
    for (const r of rows) {
      try {
        if (await this.evaluate(r.id, available)) n++;
      } catch (err) {
        this.deps.log.warn({ err, goalId: r.id }, 'goal not assessed');
      }
    }
    try {
      n += await this.#sendResumes(now);
    } catch (err) {
      this.deps.log.warn({ err }, 'goal resumes not sent');
    }
    return n;
  }

  async #ledgerSince(now: Date): Promise<Date> {
    if (this.#since !== null) return this.#since;
    await this.deps.pool.query(
      `INSERT INTO chat_goal_ledger (id, since) VALUES (true, $1) ON CONFLICT (id) DO NOTHING`,
      [now],
    );
    const { rows } = await this.deps.pool.query<{ since: Date }>(`SELECT since FROM chat_goal_ledger`);
    this.#since = rows[0]?.since ?? now;
    return this.#since;
  }

  // ------------------------------------------------------------------------------------------------ adoption

  async #turnOrigin(db: Queryable, turnId: string | null): Promise<TurnOrigin> {
    if (turnId === null) return { plan: null, watch: null, goal: null };
    const { rows } = await db.query<{
      origin: string | null;
      plan: string | null;
      watch: string | null;
      goal: string | null;
    }>(
      `SELECT m.meta->>'origin' AS origin, m.meta->'plan'->>'id' AS plan, m.meta->'watch'->>'id' AS watch,
              m.meta->'goal'->>'id' AS goal
         FROM chat_turns t JOIN chat_messages m ON m.id = t.message_id WHERE t.id = $1`,
      [turnId],
    );
    const r = rows[0];
    return {
      plan: r?.origin === 'plan' ? r.plan : null,
      watch: r?.origin === 'watch' ? r.watch : null,
      goal: r?.origin === 'goal' ? r.goal : null,
    };
  }

  /** The live goal a record of this conversation belongs to (by what started it), or null for a new goal. */
  async #parentGoal(
    db: Queryable,
    threadId: string,
    o: TurnOrigin,
    targets: readonly { kind: string; id: string }[],
  ): Promise<string | null> {
    const live = async (sql: string, params: unknown[]): Promise<string | null> => {
      const { rows } = await db.query<{ id: string }>(sql, params);
      return rows[0]?.id ?? null;
    };
    for (const t of targets) {
      const g = await live(
        `SELECT g.id::text AS id FROM chat_goal_links l JOIN chat_goals g ON g.id = l.goal_id
          WHERE l.kind = $1 AND l.ref_id = $2 AND g.state IN ('open', 'intervention')`,
        [t.kind, t.id],
      );
      if (g !== null) return g;
    }
    const byLink = async (kind: string, id: string | null): Promise<string | null> =>
      id === null || !UUID.test(id)
        ? null
        : live(
            `SELECT g.id::text AS id FROM chat_goal_links l JOIN chat_goals g ON g.id = l.goal_id
              WHERE l.kind = $1 AND l.ref_id = $2 AND g.state IN ('open', 'intervention')`,
            [kind, id],
          );
    if (o.goal !== null && UUID.test(o.goal)) {
      const g = await live(
        `SELECT id::text AS id FROM chat_goals WHERE id = $1 AND state IN ('open', 'intervention')`,
        [o.goal],
      );
      if (g !== null) return g;
    }
    const fromWatch = await byLink('watch', o.watch);
    if (fromWatch !== null) return fromWatch;
    const fromPlan = await byLink('plan', o.plan);
    if (fromPlan !== null) return fromPlan;
    // The conversation's executing plan owns what is started in it.
    return live(
      `SELECT g.id::text AS id FROM chat_plans p
         JOIN chat_goal_links l ON l.kind = 'plan' AND l.ref_id = p.id
         JOIN chat_goals g ON g.id = l.goal_id AND g.state IN ('open', 'intervention')
        WHERE p.thread_id = $1 AND p.state IN ('approved', 'executing', 'paused')
        LIMIT 1`,
      [threadId],
    );
  }

  async #link(db: Queryable, goalId: string, kind: string, refId: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO chat_goal_links (kind, ref_id, goal_id, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, ref_id) DO NOTHING`,
      [kind, refId, goalId, now],
    );
    return (rowCount ?? 0) > 0;
  }

  async #create(
    db: Queryable,
    g: {
      userId: string;
      threadId: string | null;
      origin: GoalOrigin;
      originId: string;
      title: string;
      lang: 'tr' | 'en';
      openedAt: Date;
    },
    now: Date,
  ): Promise<string | null> {
    const title = goalText(g.title, 200) ?? g.origin;
    const owner: GoalOwner =
      g.origin === 'job'
        ? 'job'
        : g.origin === 'workflow_run'
          ? 'workflow'
          : g.origin === 'watch'
            ? 'system'
            : 'assistant';
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO chat_goals (id, user_id, thread_id, origin_kind, origin_id, title, outcome_condition, owner, state,
                               opened_at, updated_at, last_progress_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $9)
       ON CONFLICT (origin_kind, origin_id) DO NOTHING RETURNING id::text AS id`,
      [
        randomUUID(),
        g.userId,
        g.threadId,
        g.origin,
        g.originId,
        title,
        defaultOutcome(g.origin, g.lang, title),
        owner,
        g.openedAt,
        now,
      ],
    );
    const id = rows[0]?.id ?? null;
    if (id !== null) await this.#link(db, id, g.origin, g.originId, now);
    return id;
  }

  /** New records of conversations since the ledger started: plans, cards that started jobs / runs, watches, fix jobs. */
  async #discover(since: Date, now: Date): Promise<number> {
    let n = 0;
    const db = this.deps.pool;
    // Plans the person approved.
    const { rows: plans } = await db.query<{
      id: string;
      thread_id: string;
      user_id: string;
      title: string;
      goal: string;
      created_at: Date;
    }>(
      `SELECT p.id::text AS id, p.thread_id::text AS thread_id, p.user_id::text AS user_id, p.title, p.goal, p.created_at
         FROM chat_plans p
        WHERE p.state IN ('approved', 'executing', 'paused') AND p.updated_at >= $1
          AND NOT EXISTS (SELECT 1 FROM chat_goal_links l WHERE l.kind = 'plan' AND l.ref_id = p.id)
        ORDER BY p.updated_at LIMIT ${String(BATCH)}`,
      [since],
    );
    for (const p of plans) {
      const id = await this.#create(
        db,
        {
          userId: p.user_id,
          threadId: p.thread_id,
          origin: 'plan',
          originId: p.id,
          title: p.title,
          lang: guessLanguage([p.title, p.goal]),
          openedAt: p.created_at,
        },
        now,
      );
      if (id !== null) n++;
    }
    // Cards that started a job or a workflow run.
    const { rows: drafts } = await db.query<{
      id: string;
      thread_id: string;
      user_id: string;
      turn_id: string;
      kind: string;
      title: string;
      job_id: string | null;
      run_id: string | null;
      created_at: Date;
    }>(
      `SELECT d.id::text AS id, d.thread_id::text AS thread_id, d.user_id::text AS user_id, d.turn_id::text AS turn_id,
              d.kind, d.title,
              CASE WHEN d.kind <> 'job_action' AND d.result->>'jobId' ~* '^[0-9a-f-]{36}$' THEN d.result->>'jobId' END AS job_id,
              CASE WHEN d.result->>'runId' ~* '^[0-9a-f-]{36}$' THEN d.result->>'runId' END AS run_id,
              COALESCE(d.decided_at, d.created_at) AS created_at
         FROM chat_drafts d
        WHERE d.state = 'confirmed' AND COALESCE(d.decided_at, d.created_at) >= $1
          AND ((d.kind <> 'job_action' AND d.result->>'jobId' ~* '^[0-9a-f-]{36}$') OR d.result->>'runId' ~* '^[0-9a-f-]{36}$')
          AND NOT EXISTS (SELECT 1 FROM chat_goal_links l WHERE l.kind = 'draft' AND l.ref_id = d.id)
        ORDER BY COALESCE(d.decided_at, d.created_at) LIMIT ${String(BATCH)}`,
      [since],
    );
    for (const d of drafts) {
      const kind: 'job' | 'workflow_run' = d.job_id !== null ? 'job' : 'workflow_run';
      const refId = (d.job_id ?? d.run_id) as string;
      await withTransaction(this.deps.pool, async (tx) => {
        const origin = await this.#turnOrigin(tx, d.turn_id);
        const parent = await this.#parentGoal(tx, d.thread_id, origin, [{ kind, id: refId }]);
        const goalId =
          parent ??
          (await this.#create(
            tx,
            {
              userId: d.user_id,
              threadId: d.thread_id,
              origin: kind,
              originId: refId,
              title: d.title,
              lang: guessLanguage([d.title]),
              openedAt: d.created_at,
            },
            now,
          )) ??
          (
            await tx.query<{ id: string }>(
              `SELECT goal_id::text AS id FROM chat_goal_links WHERE kind = $1 AND ref_id = $2`,
              [kind, refId],
            )
          ).rows[0]?.id ??
          null;
        if (goalId === null) return;
        await this.#link(tx, goalId, 'draft', d.id, now);
        await this.#link(tx, goalId, kind, refId, now);
        n++;
      });
    }
    // Watches of conversations (a notify_when watch rides on its target's goal; a check watch may open its own).
    const { rows: watches } = await db.query<{
      id: string;
      thread_id: string;
      user_id: string;
      turn_id: string | null;
      label: string;
      target_kind: string;
      target_uuid: string | null;
      created_at: Date;
    }>(
      `SELECT w.id::text AS id, w.thread_id::text AS thread_id, w.user_id::text AS user_id, w.turn_id::text AS turn_id,
              w.label, w.target_kind, w.target_uuid::text AS target_uuid, w.created_at
         FROM chat_watches w
        WHERE w.thread_id IS NOT NULL AND w.created_at >= $1
          AND NOT EXISTS (SELECT 1 FROM chat_goal_links l WHERE l.kind = 'watch' AND l.ref_id = w.id)
        ORDER BY w.created_at LIMIT ${String(BATCH)}`,
      [since],
    );
    for (const w of watches) {
      await withTransaction(this.deps.pool, async (tx) => {
        const origin = await this.#turnOrigin(tx, w.turn_id);
        const targets =
          w.target_uuid === null
            ? []
            : w.target_kind === 'job' || w.target_kind === 'workflow_run' || w.target_kind === 'draft'
              ? [{ kind: w.target_kind, id: w.target_uuid }]
              : [];
        const parent = await this.#parentGoal(tx, w.thread_id, origin, targets);
        if (parent !== null) {
          if (await this.#link(tx, parent, 'watch', w.id, now)) n++;
          return;
        }
        // Only a check watch is a goal of its own (a plain notify_when is a notification of something else).
        if (w.target_kind !== 'check') {
          return;
        }
        const id = await this.#create(
          tx,
          {
            userId: w.user_id,
            threadId: w.thread_id,
            origin: 'watch',
            originId: w.id,
            title: w.label,
            lang: guessLanguage([w.label]),
            openedAt: w.created_at,
          },
          now,
        );
        if (id !== null) n++;
      });
    }
    // An auto-fix job of a goal's failed job belongs to the same goal.
    const { rows: fixes } = await db.query<{ goal_id: string; fix_job_id: string }>(
      `SELECT l.goal_id::text AS goal_id, f.fix_job_id::text AS fix_job_id
         FROM job_auto_fixes f JOIN chat_goal_links l ON l.kind = 'job' AND l.ref_id = f.source_job_id
        WHERE f.fix_job_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM chat_goal_links x WHERE x.kind = 'job' AND x.ref_id = f.fix_job_id)
        LIMIT ${String(BATCH)}`,
    );
    for (const f of fixes) if (await this.#link(db, f.goal_id, 'job', f.fix_job_id, now)) n++;
    return n;
  }

  // ------------------------------------------------------------------------------------------------ assessment

  async #goal(db: Queryable, id: string, lock = false): Promise<GoalRow | null> {
    const { rows } = await db.query<GoalRow>(
      `SELECT ${GOAL_COLUMNS} FROM chat_goals g WHERE g.id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #facts(db: Queryable, g: GoalRow, chatAvailable: boolean): Promise<GoalFacts> {
    const { rows: links } = await db.query<{ kind: string; ref_id: string }>(
      `SELECT kind, ref_id::text AS ref_id FROM chat_goal_links WHERE goal_id = $1`,
      [g.id],
    );
    const ids = (k: string): string[] => links.filter((l) => l.kind === k).map((l) => l.ref_id);
    const records: GoalRecordFact[] = [];
    const jobIds = ids('job');
    if (jobIds.length > 0) {
      const { rows } = await db.query<{
        id: string;
        state: string;
        created_at: Date;
        state_changed_at: Date;
        reason: string | null;
        summary: string | null;
      }>(
        `SELECT j.id::text AS id, j.state::text AS state, j.created_at, j.state_changed_at,
                (SELECT t.reason FROM job_transitions t WHERE t.job_id = j.id ORDER BY t.id DESC LIMIT 1) AS reason,
                (SELECT r.result ->> 'summary' FROM job_runs r WHERE r.job_id = j.id
                  ORDER BY r.created_at DESC, r.attempt_id DESC LIMIT 1) AS summary
           FROM jobs j WHERE j.id = ANY($1::uuid[])`,
        [jobIds],
      );
      for (const j of rows) {
        const phase: GoalRecordFact['phase'] =
          j.state === 'SUCCEEDED'
            ? 'succeeded'
            : j.state === 'FAILED'
              ? 'failed'
              : j.state === 'CANCELLED' || j.state === 'CANCELLING'
                ? 'cancelled'
                : j.state === 'AWAITING_APPROVAL' || j.state === 'PAUSED'
                  ? 'waiting_user'
                  : 'live';
        records.push({
          kind: 'job',
          id: j.id,
          createdAt: j.created_at,
          phase,
          endedAt: phase === 'live' || phase === 'waiting_user' ? null : j.state_changed_at,
          detail: goalText(phase === 'failed' ? (j.reason ?? j.summary) : j.summary, 300),
        });
        // p22-run-attention: succeeded, but its agent said it could not (fully) do the task.
        const said = phase === 'succeeded' ? parseStepOutcome(j.summary ?? '') : null;
        if (said !== null) {
          const last = records.at(-1);
          const lang = guessLanguage([g.title]);
          if (last !== undefined)
            records[records.length - 1] = {
              ...last,
              attention: true,
              detail: goalText(
                `${lang === 'tr' ? 'iş bitti ama dikkat istiyor' : 'the job finished but needs attention'}: ${attentionWords(said, lang)}`,
                300,
              ),
            };
        }
      }
    }
    const runIds = ids('workflow_run');
    if (runIds.length > 0) {
      const { rows } = await db.query<{
        id: string;
        state: string;
        created_at: Date;
        ended_at: Date | null;
        reason: string | null;
        attention: unknown;
      }>(
        `SELECT id::text AS id, state, created_at, ended_at, reason, attention FROM workflow_runs
          WHERE id = ANY($1::uuid[])`,
        [runIds],
      );
      for (const r of rows) {
        const phase: GoalRecordFact['phase'] =
          r.state === 'succeeded'
            ? 'succeeded'
            : r.state === 'failed'
              ? 'failed'
              : r.state === 'cancelled'
                ? 'cancelled'
                : r.state === 'awaiting_merge' || r.state === 'paused'
                  ? 'waiting_user'
                  : 'live';
        records.push({
          kind: 'workflow_run',
          id: r.id,
          createdAt: r.created_at,
          phase,
          endedAt: r.ended_at,
          detail: goalText(r.reason, 300),
        });
        // p22-run-attention: succeeded, but a step could not do its work — the goal is not met by it.
        const attention = phase === 'succeeded' ? attentionOf(r.attention) : [];
        if (attention.length > 0) {
          const lang = guessLanguage([g.title]);
          const last = records.at(-1);
          if (last !== undefined)
            records[records.length - 1] = {
              ...last,
              attention: true,
              detail: goalText(
                `${lang === 'tr' ? 'workflow başarılı bitti ama dikkat istiyor' : 'the run succeeded but needs attention'}: ${attentionLine(attention, lang)}`,
                300,
              ),
            };
        }
      }
    }
    const watchIds = ids('watch');
    if (watchIds.length > 0) {
      const { rows } = await db.query<{
        id: string;
        state: string;
        end_reason: string | null;
        follow_up: string | null;
        created_at: Date;
        ended_at: Date | null;
        expires_at: Date;
        summary: string | null;
        sent_at: Date | null;
        live: boolean;
      }>(
        `SELECT w.id::text AS id, w.state, w.end_reason, w.follow_up, w.created_at, w.ended_at, w.expires_at,
                w.last_check ->> 'summary' AS summary,
                (SELECT max(d.sent_at) FROM chat_deliveries d WHERE d.kind = 'watch' AND d.ref_id = w.id) AS sent_at,
                EXISTS (SELECT 1 FROM chat_deliveries d WHERE d.kind = 'watch' AND d.ref_id = w.id
                          AND d.state = 'claimed') AS live
           FROM chat_watches w WHERE w.id = ANY($1::uuid[]) AND w.target_kind = 'check'`,
        [watchIds],
      );
      for (const w of rows) {
        const phase: GoalRecordFact['phase'] =
          w.state === 'active'
            ? 'live'
            : w.state === 'done' && w.end_reason === 'fired'
              ? 'succeeded'
              : w.state === 'cancelled' || w.state === 'revoked'
                ? 'cancelled'
                : 'ended_unmet';
        const endWords =
          w.end_reason === 'expired'
            ? null
            : w.end_reason !== null && w.end_reason.startsWith('never:') && w.end_reason !== 'never:never'
              ? w.end_reason.slice('never:'.length)
              : null;
        records.push({
          kind: 'watch',
          id: w.id,
          createdAt: w.created_at,
          phase,
          endedAt: w.ended_at,
          detail: goalText(w.summary ?? endWords, 300),
          followUp: w.follow_up,
          followUpAt: w.sent_at,
          deliveryLive: w.live,
          expiresAt: w.expires_at,
        });
      }
    }
    let plan: GoalPlanFact | null = null;
    if (g.origin_kind === 'plan') {
      const { rows } = await db.query<{
        state: string;
        stalled: string | null;
        cont_due: boolean;
        updated_at: Date;
        capped: boolean;
        waits: boolean;
        live: boolean;
        last_turn: Date | null;
      }>(
        `SELECT p.state, p.stalled, p.cont_due, p.updated_at,
                EXISTS (SELECT 1 FROM chat_plan_items i WHERE i.plan_id = p.id AND i.deleted_at IS NULL
                          AND i.status = 'blocked' AND i.failures >= 3) AS capped,
                (EXISTS (SELECT 1 FROM user_questions q WHERE q.plan_id = p.id AND q.state = 'pending')
                 OR EXISTS (SELECT 1 FROM chat_drafts d WHERE d.thread_id = p.thread_id AND d.state = 'proposed'
                              AND d.expires_at > $2)
                 OR EXISTS (SELECT 1 FROM chat_plan_items i WHERE i.plan_id = p.id AND i.deleted_at IS NULL
                              AND i.owner = 'user' AND i.status IN ('pending', 'in_progress'))) AS waits,
                EXISTS (SELECT 1 FROM chat_deliveries d WHERE d.kind = 'plan' AND d.ref_id = p.id
                          AND d.state = 'claimed') AS live,
                (SELECT max(d.sent_at) FROM chat_deliveries d WHERE d.kind = 'plan' AND d.ref_id = p.id) AS last_turn
           FROM chat_plans p WHERE p.id = $1`,
        [g.origin_id, this.deps.clock()],
      );
      const p = rows[0];
      plan =
        p === undefined
          ? {
              state: 'cancelled',
              stalled: null,
              contDue: false,
              deliveryLive: false,
              itemCapped: false,
              waitsForUser: false,
              updatedAt: g.updated_at,
              lastTurnAt: null,
            }
          : {
              state: p.state,
              stalled: p.stalled,
              contDue: p.cont_due,
              deliveryLive: p.live,
              itemCapped: p.capped,
              waitsForUser: p.waits,
              updatedAt: p.updated_at,
              lastTurnAt: p.last_turn,
            };
    }
    return { origin: g.origin_kind, plan, records, chatAvailable, openedAt: g.opened_at };
  }

  /** Assesses one goal and records the result (the intervention, its notification and note once). */
  async evaluate(goalId: string, chatAvailable?: boolean): Promise<boolean> {
    const available =
      chatAvailable ??
      (await this.deps
        .chat()
        ?.status()
        .then((s) => s.available)
        .catch(() => false)) ??
      false;
    const now = this.deps.clock();
    let entered: { g: GoalRow; a: GoalAssessment; note: MessageView | null } | null = null;
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const g = await this.#goal(tx, goalId, true);
      if (g === null || (g.state !== 'open' && g.state !== 'intervention')) return false;
      const facts = await this.#facts(tx, g, available);
      const fingerprint = goalFingerprint(facts);
      let a = assessGoal(facts, now);
      if (g.declared && g.fingerprint === fingerprint) {
        // The assistant's own words stand until a record changes — except its own time running out.
        const overdue =
          g.state === 'open' &&
          g.owner === 'assistant' &&
          g.reevaluate_at !== null &&
          g.reevaluate_at.getTime() <= now.getTime();
        if (!overdue) return false;
        a = {
          state: 'intervention',
          owner: 'user',
          nextAction: 'user_action',
          blockedReason: available ? 'no_progress' : 'assistant_unavailable',
          reevaluateAt: null,
          detail: g.detail,
          resolvedBy: null,
          progressAt: g.last_progress_at,
        };
      }
      // p21-goal-check: the assistant's own time to look again ran out — give it the turn it asked for (bounded) before
      // the user gets a card. Only while the chat is reachable and the goal was the assistant's.
      let checkTurn = false;
      if (
        available &&
        a.state === 'intervention' &&
        a.blockedReason === 'no_progress' &&
        g.state === 'open' &&
        g.owner === 'assistant' &&
        g.reevaluate_at !== null &&
        g.reevaluate_at.getTime() <= now.getTime()
      ) {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM chat_deliveries WHERE kind = 'goal' AND key LIKE $1`,
          [`goal:${g.id}:check-%`],
        );
        if ((rows[0]?.n ?? 0) < GOAL_AUTO_CHECKS) {
          checkTurn = true;
          a = {
            state: 'open',
            owner: 'assistant',
            nextAction: 'resume',
            blockedReason: GOAL_CHECK_REASON,
            reevaluateAt: new Date(now.getTime() + GOAL_PROGRESS_MS),
            detail: g.detail,
            resolvedBy: null,
            progressAt: g.last_progress_at,
          };
        }
      }
      const same =
        a.state === g.state &&
        a.owner === g.owner &&
        a.nextAction === g.next_action &&
        a.blockedReason === g.blocked_reason &&
        (a.reevaluateAt?.getTime() ?? null) === (g.reevaluate_at?.getTime() ?? null) &&
        fingerprint === g.fingerprint &&
        !g.declared;
      if (same) return false;
      const entering = a.state === 'intervention' && g.state !== 'intervention';
      const closing = a.state === 'done' || a.state === 'cancelled';
      const notify = entering && g.notified_episode <= g.episode;
      const progressAt =
        a.progressAt.getTime() > g.last_progress_at.getTime() ? a.progressAt : g.last_progress_at;
      await tx.query(
        `UPDATE chat_goals SET state = $2, owner = $3, next_action = $4, blocked_reason = $5, reevaluate_at = $6,
                detail = COALESCE($7, detail), fingerprint = $8, declared = $17, updated_at = $9,
                last_progress_at = $10, closed_at = $11, resolved_by = $12,
                intervention_at = CASE WHEN $13 THEN $9 ELSE intervention_at END,
                interventions = interventions + CASE WHEN $13 THEN 1 ELSE 0 END,
                notified_episode = CASE WHEN $14 THEN episode + 1 ELSE notified_episode END,
                follow_ups = $15,
                next_note = CASE WHEN $16 AND NOT $17 THEN NULL ELSE next_note END,
                user_action = CASE WHEN $16 THEN NULL ELSE user_action END
          WHERE id = $1`,
        [
          g.id,
          a.state,
          a.owner,
          a.nextAction,
          a.blockedReason,
          a.reevaluateAt,
          a.detail,
          fingerprint,
          now,
          progressAt,
          closing ? now : null,
          a.resolvedBy,
          entering,
          notify,
          facts.records.filter((r) => r.followUp === 'sent').length,
          g.declared || a.state !== g.state,
          // A check turn holds until the assistant answers (its next step stays for the turn's text).
          checkTurn,
        ],
      );
      let note: MessageView | null = null;
      if (notify) note = await this.#interventionNotice(tx, g, a);
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat-goals' },
          action: entering ? 'chat.goal.intervention' : closing ? `chat.goal.${a.state}` : 'chat.goal.update',
          target: `chat-goal:${g.id}`,
          outcome: 'success',
          metadata: {
            userId: g.user_id,
            from: g.state,
            to: a.state,
            owner: a.owner,
            next: a.nextAction,
            reason: a.blockedReason,
          },
        },
        tx,
      );
      if (entering) entered = { g, a, note };
      return true;
    });
    if (entered !== null) {
      const e: { g: GoalRow; a: GoalAssessment; note: MessageView | null } = entered;
      if (e.g.thread_id !== null && e.note !== null) this.deps.publish(e.g.thread_id, 'message', e.note);
    }
    if (changed) {
      const g = await this.#goal(this.deps.pool, goalId);
      if (g?.thread_id != null) this.deps.publish(g.thread_id, 'watch', {});
    }
    return changed;
  }

  async #threadLang(db: Queryable, threadId: string | null, title: string): Promise<'tr' | 'en'> {
    if (threadId === null) return guessLanguage([title]);
    const { rows } = await db.query<{ content: string }>(
      `SELECT content FROM chat_messages WHERE thread_id = $1 AND role = 'user'
          AND COALESCE(meta->>'origin', 'user') = 'user' ORDER BY seq DESC LIMIT 3`,
      [threadId],
    );
    return guessLanguage([title, ...rows.map((r) => r.content)]);
  }

  /** Once per episode: the notification (not for a plan stall: the plan already said so) and the conversation note. */
  async #interventionNotice(tx: Queryable, g: GoalRow, a: GoalAssessment): Promise<MessageView | null> {
    const reason = a.blockedReason ?? 'no_progress';
    const lang = await this.#threadLang(tx, g.thread_id, g.title);
    const text = interventionNotice(lang, g.title, reason, a.detail ?? g.detail);
    const planOwn = reason.startsWith('plan_stalled') || reason === 'plan_item_failed';
    const svc = this.deps.notifications();
    if (svc !== null && !planOwn) {
      await svc.notify(tx, [g.user_id], {
        kind: 'chat.watch',
        severity: 'warning',
        title: text.title,
        body: text.body,
        link: `/needs#hedef=${g.id}`,
        dedupeKey: `chat.goal:${g.id}:${String(g.episode)}`,
      });
    }
    if (g.thread_id === null || planOwn) return null;
    try {
      return await this.deps.addMessage(
        g.thread_id,
        {
          role: 'assistant',
          content: text.note,
          meta: { notice: 'goal-intervention', goalId: g.id, reason, link: `/needs#hedef=${g.id}` },
        },
        tx,
      );
    } catch (err) {
      this.deps.log.debug({ err, goalId: g.id }, 'goal intervention note not recorded');
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ person

  async #own(userId: string, goalId: string): Promise<GoalRow> {
    const g = await this.#goal(this.deps.pool, goalId);
    if (g?.user_id !== userId) throw new HttpError(404, 'goal_not_found', 'Goal not found.');
    return g;
  }

  async #view(db: Queryable, g: GoalRow): Promise<GoalView> {
    const { rows: links } = await db.query<{ kind: string; ref_id: string }>(
      `SELECT kind, ref_id::text AS ref_id FROM chat_goal_links WHERE goal_id = $1 ORDER BY created_at`,
      [g.id],
    );
    const { rows: t } =
      g.thread_id === null
        ? { rows: [] }
        : await db.query<{ title: string | null }>(`SELECT title FROM chat_threads WHERE id = $1`, [
            g.thread_id,
          ]);
    return {
      id: g.id,
      threadId: g.thread_id,
      threadTitle: t[0]?.title ?? null,
      origin: { kind: g.origin_kind, id: g.origin_id },
      title: g.title,
      outcomeCondition: g.outcome_condition,
      nextAction: g.next_action,
      nextNote: g.next_note,
      owner: g.owner,
      blockedReason: g.blocked_reason,
      reevaluateAt: g.reevaluate_at?.toISOString() ?? null,
      state: g.state,
      detail: g.detail,
      userAction: g.user_action,
      interventions: g.interventions,
      links: links.map((l) => ({ kind: l.kind, id: l.ref_id })),
      openedAt: g.opened_at.toISOString(),
      updatedAt: g.updated_at.toISOString(),
      interventionAt: g.intervention_at?.toISOString() ?? null,
      closedAt: g.closed_at?.toISOString() ?? null,
    };
  }

  /** The caller's goals (default: the open and intervention ones), newest change first. */
  async list(
    userId: string,
    filter: { readonly state?: GoalState | 'live'; readonly threadId?: string } = {},
  ): Promise<GoalView[]> {
    const states =
      filter.state === undefined || filter.state === 'live' ? ['open', 'intervention'] : [filter.state];
    const { rows } = await this.deps.pool.query<GoalRow>(
      `SELECT ${GOAL_COLUMNS} FROM chat_goals g
        WHERE g.user_id = $1 AND g.state = ANY($2::text[]) AND ($3::uuid IS NULL OR g.thread_id = $3)
        ORDER BY g.updated_at DESC LIMIT 100`,
      [userId, states, filter.threadId ?? null],
    );
    const out: GoalView[] = [];
    for (const g of rows) out.push(await this.#view(this.deps.pool, g));
    return out;
  }

  async get(userId: string, goalId: string): Promise<GoalView> {
    return this.#view(this.deps.pool, await this.#own(userId, goalId));
  }

  /**
   * "Devam ettir": the goal is open again and the assistant owns it — a plan goal through the plan's own resume, any
   * other with one goal continuation turn (leased delivery). The derived assessment does not put it back before a
   * record changes or the assistant's time runs out (then it is a new episode, notified again).
   */
  async resume(actor: ActorContext, goalId: string): Promise<GoalView> {
    const g = await this.#own(actor.userId, goalId);
    if (g.state !== 'intervention' && g.state !== 'open')
      throw new HttpError(409, 'goal_closed', 'This goal is already closed.');
    const now = this.deps.clock();
    if (g.origin_kind === 'plan') {
      const plans = this.deps.plans();
      if (plans === null)
        throw new HttpError(409, 'goal_unavailable', 'This goal cannot be resumed right now.');
      await plans.resume(actor, g.origin_id);
    }
    const facts = await this.#facts(this.deps.pool, g, true);
    await this.deps.pool.query(
      `UPDATE chat_goals SET state = 'open', owner = 'assistant', next_action = $2, blocked_reason = NULL,
              reevaluate_at = $3, declared = true, fingerprint = $4, episode = GREATEST(episode, notified_episode),
              last_progress_at = $5, updated_at = $5, user_action = NULL
        WHERE id = $1`,
      [
        g.id,
        g.origin_kind === 'plan' ? 'plan_continue' : 'resume',
        new Date(now.getTime() + GOAL_PROGRESS_MS),
        goalFingerprint(facts),
        now,
      ],
    );
    await this.#audit('chat.goal.resume', actor, g.id, { from: g.state, reason: g.blocked_reason });
    if (g.origin_kind !== 'plan') void this.#sendResume(g.id);
    if (g.thread_id !== null) this.deps.publish(g.thread_id, 'watch', {});
    return this.get(actor.userId, g.id);
  }

  /** "Vazgeç": the goal is given up — a plan goal cancels its plan, any other stops its active watches. */
  async cancel(actor: ActorContext, goalId: string): Promise<GoalView> {
    const g = await this.#own(actor.userId, goalId);
    if (g.state !== 'intervention' && g.state !== 'open')
      throw new HttpError(409, 'goal_closed', 'This goal is already closed.');
    if (g.origin_kind === 'plan') {
      await this.deps
        .plans()
        ?.cancel(actor, g.origin_id)
        .catch((err: unknown) => {
          // Already ended: the goal closes anyway.
          this.deps.log.debug({ err, goalId }, 'plan of a cancelled goal not cancelled');
        });
    } else {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT w.id::text AS id FROM chat_goal_links l JOIN chat_watches w ON w.id = l.ref_id
          WHERE l.goal_id = $1 AND l.kind = 'watch' AND w.state = 'active'`,
        [g.id],
      );
      for (const w of rows)
        await this.deps
          .watches()
          ?.cancel(actor.userId, w.id)
          .catch(() => undefined);
    }
    await this.#close(g.id, 'cancelled', 'user');
    await this.#audit('chat.goal.cancel', actor, g.id, { from: g.state, reason: g.blocked_reason });
    if (g.thread_id !== null) this.deps.publish(g.thread_id, 'watch', {});
    return this.get(actor.userId, g.id);
  }

  async #close(
    goalId: string,
    state: 'done' | 'cancelled',
    by: 'user' | 'assistant' | 'cancel',
  ): Promise<void> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE chat_goals SET state = $2, resolved_by = $3, closed_at = $4, updated_at = $4, reevaluate_at = NULL,
              blocked_reason = NULL
        WHERE id = $1 AND state IN ('open', 'intervention')`,
      [goalId, state, by, now],
    );
  }

  async #audit(
    action: string,
    actor: ActorContext,
    goalId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit
      .record({
        actor: { type: 'user', id: actor.userId },
        action,
        target: `chat-goal:${goalId}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata,
      })
      .catch((err: unknown) => {
        this.deps.log.warn({ err, goalId }, 'goal audit not recorded');
      });
  }

  // ------------------------------------------------------------------------------------------------ resume turns

  /** Resume turns the person asked for that are not sent yet (busy conversation, assistant away, a lost claim). */
  async #sendResumes(now: Date): Promise<number> {
    for (const r of await reapDeliveries(this.deps.pool, 'goal', now))
      this.deps.log.info({ goalId: r.refId }, 'goal resume lease expired; taken up again');
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM chat_goals WHERE state = 'open' AND next_action = 'resume' ORDER BY updated_at LIMIT 20`,
    );
    let n = 0;
    for (const r of rows) if (await this.#sendResume(r.id)) n++;
    return n;
  }

  async #sendResume(goalId: string): Promise<boolean> {
    if (this.#sending.has(goalId)) return false;
    this.#sending.add(goalId);
    try {
      const chat = this.deps.chat();
      const g = await this.#goal(this.deps.pool, goalId);
      if (chat === null || g?.state !== 'open' || g.next_action !== 'resume' || g.thread_id === null)
        return false;
      if (!(await chat.idle(g.thread_id))) return false;
      const now = this.deps.clock();
      // p21-goal-check: each automatic check turn is its own delivery (`goal:<goal>:check-<n>`, bounded by count).
      const check = g.blocked_reason === GOAL_CHECK_REASON;
      const key = check
        ? `goal:${g.id}:check-${String(
            (
              await this.deps.pool.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM chat_deliveries WHERE kind = 'goal' AND key LIKE $1 AND state = 'sent'`,
                [`goal:${g.id}:check-%`],
              )
            ).rows[0]?.n ?? 0,
          )}`
        : `goal:${g.id}:${String(g.episode)}`;
      const claim = await claimDelivery(this.deps.pool, {
        key,
        kind: 'goal',
        refId: g.id,
        threadId: g.thread_id,
        now,
      });
      if (claim === null) {
        // Already sent for this episode (a replica, an earlier pass): the assistant has it.
        const { rows } = await this.deps.pool.query(
          `SELECT 1 FROM chat_deliveries WHERE key = $1 AND state = 'sent'`,
          [key],
        );
        if (rows.length > 0)
          await this.deps.pool.query(
            `UPDATE chat_goals SET next_action = 'assistant_turn' WHERE id = $1 AND next_action = 'resume'`,
            [g.id],
          );
        return false;
      }
      const lang = await this.#threadLang(this.deps.pool, g.thread_id, g.title);
      const text = resumeText(
        lang,
        {
          id: g.id,
          title: g.title,
          outcome: g.outcome_condition,
          reason: g.blocked_reason,
          nextNote: g.next_note,
        },
        g.detail,
      );
      let turnId: string;
      try {
        turnId = (
          await chat.send({ userId: g.user_id, ip: 'system', userAgent: null }, g.thread_id, text, {
            goal: { goalId: g.id },
            delivery: claim,
          })
        ).turnId;
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'error';
        if (code === 'delivery_superseded') return false;
        if (code === 'turn_in_progress' || code === 'rate_limited' || code === 'assistant_unavailable') {
          await releaseDelivery(this.deps.pool, claim, code, this.deps.clock());
          return false;
        }
        await failDelivery(
          this.deps.pool,
          claim,
          code === 'cost_brake_active' || code === 'budget_exceeded' ? 'budget' : 'error',
          this.deps.clock(),
        );
        await this.deps.pool.query(
          `UPDATE chat_goals SET next_action = 'assistant_turn', declared = false, reevaluate_at = $2 WHERE id = $1`,
          [g.id, this.deps.clock()],
        );
        return false;
      }
      await completeDelivery(this.deps.pool, claim, turnId, this.deps.clock()).catch((err: unknown) => {
        this.deps.log.warn({ err, goalId }, 'goal resume delivery not completed');
      });
      await this.deps.pool.query(
        `UPDATE chat_goals SET next_action = 'assistant_turn', updated_at = $2 WHERE id = $1`,
        [g.id, this.deps.clock()],
      );
      return true;
    } catch (err) {
      this.deps.log.warn({ err, goalId }, 'goal resume failed');
      return false;
    } finally {
      this.#sending.delete(goalId);
    }
  }

  // ------------------------------------------------------------------------------------------------ assistant

  /** list_goals: the goals of the turn's conversation (live by default; all = every conversation of the user). */
  async toolList(
    c: { readonly userId: string; readonly threadId: string },
    i: { readonly all?: boolean; readonly includeClosed?: boolean },
  ): Promise<{ goals: Record<string, unknown>[] }> {
    const { rows } = await this.deps.pool.query<GoalRow>(
      `SELECT ${GOAL_COLUMNS} FROM chat_goals g
        WHERE g.user_id = $1 AND ($2 OR g.thread_id = $3)
          AND ($4 OR g.state IN ('open', 'intervention'))
        ORDER BY g.updated_at DESC LIMIT 20`,
      [c.userId, i.all === true, c.threadId, i.includeClosed === true],
    );
    const goals: Record<string, unknown>[] = [];
    for (const g of rows) {
      const v = await this.#view(this.deps.pool, g);
      goals.push({
        goalId: v.id,
        title: v.title,
        state: v.state,
        outcomeCondition: v.outcomeCondition,
        owner: v.owner,
        nextAction: v.nextAction,
        nextNote: v.nextNote,
        blockedReason: v.blockedReason,
        detail: v.detail,
        userAction: v.userAction,
        reevaluateAt: v.reevaluateAt,
        interventions: v.interventions,
        origin: v.origin,
        links: v.links,
        ...(v.threadId === c.threadId ? {} : { threadId: v.threadId }),
      });
    }
    return { goals };
  }

  /**
   * goal_update: the assistant records the outcome condition, the next step and when to look again, or ends the goal
   * (done / cancelled) or declares the intervention with exactly what the person has to do. Only the turn user's goals
   * of this conversation.
   */
  async toolUpdate(
    c: { readonly userId: string; readonly threadId: string; readonly turnId: string },
    i: {
      readonly goalId: string;
      readonly outcomeCondition?: string;
      readonly nextStep?: string;
      readonly reevaluateInMinutes?: number;
      readonly state?: 'open' | 'done' | 'cancelled' | 'intervention';
      readonly reason?: string;
      readonly userAction?: string;
    },
  ): Promise<{ goalId: string; state: GoalState }> {
    const now = this.deps.clock();
    let entered: GoalRow | null = null;
    let note: MessageView | null = null;
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const g = await this.#goal(tx, i.goalId, true);
      if (g === null || g.user_id !== c.userId || g.thread_id !== c.threadId)
        throw new HttpError(404, 'goal_not_found', 'Goal not found.');
      if (g.state === 'done' || g.state === 'cancelled')
        throw new HttpError(409, 'goal_closed', 'This goal is already closed.');
      const outcome = goalText(i.outcomeCondition, 300);
      const next = goalText(i.nextStep, 300);
      const detail = goalText(i.reason, 500);
      const action = goalText(i.userAction, 300);
      const target = i.state ?? g.state;
      if (target === 'done' || target === 'cancelled') {
        await tx.query(
          `UPDATE chat_goals SET state = $2, resolved_by = 'assistant', closed_at = $3, updated_at = $3,
                  reevaluate_at = NULL, blocked_reason = NULL, detail = COALESCE($4, detail),
                  outcome_condition = COALESCE($5, outcome_condition)
            WHERE id = $1`,
          [g.id, target, now, detail, outcome],
        );
      } else if (target === 'intervention') {
        if (action === null)
          throw new HttpError(
            400,
            'goal_user_action_required',
            'An intervention needs what the user has to do.',
          );
        const entering = g.state !== 'intervention';
        const notify = entering && g.notified_episode <= g.episode;
        const facts = await this.#facts(tx, g, true);
        await tx.query(
          `UPDATE chat_goals SET state = 'intervention', owner = 'user', next_action = 'user_action',
                  blocked_reason = 'assistant_declared', reevaluate_at = NULL, detail = COALESCE($2, detail),
                  user_action = $3, next_note = COALESCE($4, next_note), outcome_condition = COALESCE($5, outcome_condition),
                  declared = true, fingerprint = $6, updated_at = $7,
                  intervention_at = CASE WHEN $8 THEN $7 ELSE intervention_at END,
                  interventions = interventions + CASE WHEN $8 THEN 1 ELSE 0 END,
                  notified_episode = CASE WHEN $9 THEN episode + 1 ELSE notified_episode END
            WHERE id = $1`,
          [g.id, detail, action, next, outcome, goalFingerprint(facts), now, entering, notify],
        );
        if (notify) {
          entered = g;
          note = await this.#interventionNotice(
            tx,
            { ...g, detail: detail ?? g.detail },
            {
              state: 'intervention',
              owner: 'user',
              nextAction: 'user_action',
              blockedReason: 'assistant_declared',
              reevaluateAt: null,
              detail: detail ?? g.detail,
              resolvedBy: null,
              progressAt: now,
            },
          );
        }
      } else {
        const minutes = Math.min(Math.max(i.reevaluateInMinutes ?? 30, 5), 24 * 60);
        const facts = await this.#facts(tx, g, true);
        await tx.query(
          `UPDATE chat_goals SET state = 'open', owner = 'assistant', next_action = 'assistant_step',
                  next_note = COALESCE($2, next_note), outcome_condition = COALESCE($3, outcome_condition),
                  reevaluate_at = $4, blocked_reason = NULL, declared = true, fingerprint = $5,
                  last_progress_at = $6, updated_at = $6, detail = COALESCE($7, detail)
            WHERE id = $1`,
          [
            g.id,
            next,
            outcome,
            new Date(now.getTime() + minutes * 60_000),
            goalFingerprint(facts),
            now,
            detail,
          ],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat-assistant' },
          action: 'chat.goal.assistant_update',
          target: `chat-goal:${g.id}`,
          outcome: 'success',
          metadata: { userId: c.userId, turnId: c.turnId, from: g.state, to: target },
        },
        tx,
      );
      return { goalId: g.id, state: target };
    });
    // Assigned inside the transaction callback (TypeScript narrows the `let` to its initial null).
    const e = entered as GoalRow | null;
    const m = note as MessageView | null;
    if (e !== null && e.thread_id !== null && m !== null) this.deps.publish(e.thread_id, 'message', m);
    this.deps.publish(c.threadId, 'watch', {});
    return out;
  }
}
