import { randomUUID } from 'node:crypto';
import { defaultTimeZone } from '../schedules/zone.js';
import { messagesFor } from '@remyral/i18n/all';
import {
  deriveJobTitle,
  JOB_TITLE_MAX,
  normalizeJobTitle,
  WATCH_CHECK_LIMITS,
  WATCH_CONDITIONS,
  WATCH_TARGETS,
  type WatchCheckCondition,
  type WatchCheckView,
  type WatchCondition,
  type WatchTarget,
  type WatchThen,
  parseStepOutcome,
  type StepOutcome,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Role } from '../auth/users.js';
import { loadSubject } from '../authz/authorizer.js';
import { type Action, authorize, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { NotificationService } from '../notifications/service.js';
import type { ChatStore, MessageView } from './store.js';
import { detailsView, storedDetails } from '../approvals/details.js';
import { conditionText, hasHttpPhase, oneLine } from './watch-check-model.js';
import { GOAL_GRANT_TTL_MS } from './goal-grants.js';
import { checkLink, type WatchChecks, WatchCheckError } from './watch-checks.js';
import { attentionLine, resultMeta, type RunResult, workflowRunResult } from './flow-model.js';
import { attentionWords, deliveredLine } from './job-result.js';
import type { OutputReportView } from '../workspaces/output-limits.js';

/**
 * Chat watches (p6-chat-notify, docs/design/p6-chat-notify.md): "let me know when X happens" from the ops chat.
 *
 * A watch belongs to ONE user and notifies only that user — there is no recipient, address or URL anywhere in it.
 * It follows one resource the user can read (checked when it is created and again every time it fires) on
 * conditions from a fixed enum. An orchestrator tick step evaluates the active watches against the database
 * (restart-safe, several replicas: the watch row is locked with SKIP LOCKED and every occurrence is recorded once
 * in `chat_watch_fires`). When one fires, the same transaction posts a short note into the originating thread
 * (the thread's language) and stores a `chat.watch` notification for the user (in-app always; e-mail / webhook
 * where the user enabled that kind). `sendNote` is the immediate variant ("send me this now", kind `chat.note`).
 *
 * p15-watches (Takipler, docs/design/p15-watches.md): kind `check` — a typed condition the master evaluates itself
 * ({@link WatchChecks}: SQL on database events, function jobs on workers for external checks). Same table, list,
 * cancel, cap and channels; `createCheck` registers one and runs its dry test.
 */

export type WatchState = 'active' | 'done' | 'cancelled' | 'expired' | 'revoked';
export type WatchRepeat = 'once' | 'every';
export type WatchLanguage = 'tr' | 'en';
/** What a draft watch becomes once its card is confirmed. */
type BoundKind = Exclude<WatchTarget, 'draft'>;
/** Every stored kind: the notify_when targets and p15-watches `check`. */
export type WatchKind = WatchTarget | 'check';

/** p15-watches: what a `check` watch shows besides the common fields. */
export interface WatchCheckDetails {
  readonly kind: WatchCheckCondition['kind'];
  readonly condition: WatchCheckCondition;
  /** The condition as one sentence in the watch's language. */
  readonly summary: string;
  /** `event`: evaluated when its rows change; `poll`: a worker checks it every `everySec` (with backoff). */
  readonly mode: 'event' | 'poll';
  readonly everySec: number | null;
  readonly lastCheck: WatchCheckView | null;
  /** Null: on the next event (or right now, while a check runs). */
  readonly nextCheckAt: string | null;
  /** A check job runs right now. */
  readonly checking: boolean;
  readonly checks: number;
  readonly result: { readonly summary: string; readonly value: unknown; readonly url: string | null } | null;
  readonly then: WatchThen | null;
}

export interface WatchView {
  readonly id: string;
  readonly threadId: string | null;
  readonly target: { readonly kind: WatchKind; readonly id: string };
  readonly label: string;
  readonly project: string | null;
  readonly conditions: readonly WatchCondition[];
  readonly repeat: WatchRepeat;
  readonly language: WatchLanguage;
  readonly state: WatchState;
  readonly endReason: string | null;
  readonly fireCount: number;
  readonly lastFiredAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  /** Console page of the watched resource. */
  readonly link: string;
  /** p15-watches: the condition, last and next check of a `check` watch (null for the other kinds). */
  readonly check: WatchCheckDetails | null;
  /**
   * p20-quick: the originating conversation's title (only when asked: `list({ threadTitles: true })`, for the home's /
   * "Senden bekleyenler"'s "Bekleniyor" rows; null: no conversation or it is gone).
   */
  readonly threadTitle?: string | null;
}

export interface WatchCaller {
  readonly userId: string;
  readonly subject: Subject;
  readonly threadId: string | null;
  readonly turnId: string | null;
  /**
   * p22-watch-next-step: when the person's own message behind this watch's next step was written (the turn's own, or
   * the one a continuation inherits); absent/null: its follow-up's drafts stay cards.
   */
  readonly nextStepConsentAt?: Date | null | undefined;
}

export interface WatchInput {
  readonly target: WatchTarget;
  readonly id: string;
  readonly on?: readonly WatchCondition[] | undefined;
  readonly repeat?: WatchRepeat | undefined;
  readonly expiresInHours?: number | undefined;
  readonly language?: WatchLanguage | undefined;
  /** p22-watch-next-step: what the assistant does once it ends (it is woken with it). */
  readonly nextStep?: string | undefined;
}

/** p15-watches: `create_watch`. */
export interface CheckInput {
  readonly condition: WatchCheckCondition;
  readonly label?: string | undefined;
  readonly timeoutMinutes?: number | undefined;
  readonly checkEverySec?: number | undefined;
  readonly then?: WatchThen | undefined;
  readonly language?: WatchLanguage | undefined;
  /** p22-watch-next-step: what the assistant does once it ends (it is woken with it). */
  readonly nextStep?: string | undefined;
}

export interface CheckCreated {
  readonly watch: WatchView;
  readonly updated: boolean;
  /** The check run right away (null: none could run yet, e.g. the user's check jobs are all busy). */
  readonly dryTest: WatchCheckView | null;
  /** A remote check of the dry test is still running (its result arrives in the list / the conversation). */
  readonly pending: boolean;
}

export class WatchError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

export interface ChatWatchDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly store: ChatStore;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly notifications: () => NotificationService | null;
  /** After commit: stream the posted thread note (and a `watch` refresh) to the thread's open views. */
  readonly publish?: (threadId: string, message: MessageView | null) => void;
  /** p15-watches: the engine of `check` watches (absent: create_watch answers "unavailable"). */
  readonly checks?: WatchChecks;
  /** p18-outputs-delivery: what became of a workspace job's `out/` (the zipped-delivery line of its end note). */
  readonly outputReport?: (jobId: string) => Promise<OutputReportView | null>;
}

export const DEFAULT_WATCH_TTL_HOURS = 168;
export const MAX_WATCH_TTL_HOURS = 720;
export const MAX_ACTIVE_WATCHES_PER_USER = 25;
/** An "every time" watch stops after this many deliveries (a runaway automation must not flood the user). */
export const MAX_WATCH_FIRES = 200;
export const NOTES_PER_HOUR = 10;
/** Ended watches are kept this long for the list, then pruned. */
const ENDED_RETENTION_MS = 30 * 24 * 3600_000;
const BATCH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_ID = /^wrk_[a-z2-7]{26}$/;

/** Conditions each kind takes, and the default when the user names none. */
export const WATCH_RULES: Readonly<
  Record<
    BoundKind,
    {
      readonly allowed: readonly WatchCondition[];
      readonly defaults: readonly WatchCondition[];
      readonly every: boolean;
      readonly action: Action;
    }
  >
> = {
  job: {
    allowed: ['finished', 'succeeded', 'failed', 'cancelled', 'approval_requested'],
    defaults: ['finished'],
    every: false,
    action: 'jobs.read',
  },
  workflow_run: {
    allowed: ['finished', 'succeeded', 'failed', 'cancelled'],
    defaults: ['finished'],
    every: false,
    action: 'workflows.read',
  },
  automation: {
    allowed: ['finished', 'succeeded', 'failed', 'cancelled'],
    defaults: ['finished'],
    every: true,
    action: 'automations.read',
  },
  ops_action: {
    allowed: ['finished', 'succeeded', 'failed', 'decided'],
    defaults: ['finished'],
    every: false,
    action: 'deploy.read',
  },
  approval: { allowed: ['decided'], defaults: ['decided'], every: false, action: 'approvals.read' },
  worker: { allowed: ['online', 'offline'], defaults: [], every: true, action: 'workers.read' },
  // p8-uptime: a monitor going down / up again (changes while it flaps are recorded, not told).
  monitor: { allowed: ['down', 'up'], defaults: [], every: true, action: 'uptime.read' },
};

/** Draft kinds a watch can follow until confirmed, and what they become. */
const DRAFT_BINDS: Readonly<Record<string, BoundKind>> = {
  job: 'job',
  machine_task: 'job',
  tool_install: 'job',
  workflow_run: 'workflow_run',
  ops_action: 'ops_action',
  automation: 'automation',
  automation_change: 'job',
  monitor: 'monitor',
};

export function watchLink(kind: WatchKind, id: string, threadId: string | null): string {
  const e = encodeURIComponent(id);
  switch (kind) {
    case 'job':
      return `/jobs/${e}`;
    case 'workflow_run':
      return `/jobs/workflows/${e}`;
    case 'automation':
      return `/automations/${e}?tab=runs`;
    case 'ops_action':
      return `/deploys/${e}`;
    case 'approval':
      return `/approvals/${e}`;
    case 'worker':
      return `/machines/${e}`;
    case 'monitor':
      return `/uptime/${e}`;
    case 'draft':
    case 'check':
      return threadId === null ? '/chat' : `/chat/${encodeURIComponent(threadId)}`;
  }
}

/** Plain text that renders literally in the chat's Markdown (labels may come from prompts or names). */
export function mdText(s: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return flat.replace(/[\\`*_[\]()<>#!|~]/g, (c) => `\\${c}`);
}

const clip = (s: string, n: number): string =>
  Array.from(s).length > n
    ? `${Array.from(s)
        .slice(0, n - 1)
        .join('')}…`
    : s;

/**
 * Console links of a note leave the Markdown (the chat renders only absolute links there) and travel in the
 * message meta, where the console renders them as in-app links: `[label](/path)` → `{label, href}`.
 */
export function splitLinks(text: string): { text: string; links: { label: string; href: string }[] } {
  const links: { label: string; href: string }[] = [];
  const rest = text.replace(
    / ?(?:· )?\[([^\]\n]{1,80})\]\((\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500})\)/g,
    (_, label: string, href: string) => {
      links.push({ label, href });
      return '';
    },
  );
  return { text: rest.trim(), links };
}

/** A thread's language from the user's last messages (Turkish letters or common words), else English. */
export function guessLanguage(texts: readonly string[]): WatchLanguage {
  const t = texts.join(' ').toLowerCase();
  if (/[çğış]/.test(t)) return 'tr';
  if (/\b(haber|ver|bitince|olunca|bana|bunu|mı|mi|iş|işi|lütfen|göster|iptal|gönder)\b/.test(t)) return 'tr';
  return 'en';
}

interface WatchRow {
  id: string;
  user_id: string;
  thread_id: string | null;
  target_kind: WatchKind;
  target_uuid: string | null;
  target_ref: string | null;
  project: string | null;
  label: string;
  conditions: WatchCondition[];
  repeat: WatchRepeat;
  language: WatchLanguage;
  state: WatchState;
  end_reason: string | null;
  cursor: Record<string, unknown>;
  fire_count: number;
  last_fired_at: Date | null;
  created_at: Date;
  expires_at: Date;
  ended_at: Date | null;
  // p15-watches (kind check).
  spec: WatchCheckCondition | null;
  then_action: WatchThen | null;
  every_sec: number | null;
  next_check_at: Date | null;
  pending_job_id: string | null;
  check_count: number;
  last_check: WatchCheckView | null;
  result: { summary: string; value: unknown; url: string | null } | null;
}

/** p22-watch-next-step: the stored next step (one line, at most 500 characters; empty = none). */
export function nextStepOf(s: string | undefined): string | null {
  if (s === undefined) return null;
  const one = oneLine(s.replace(/\s+/g, ' '), 500).trim();
  return one === '' ? null : one;
}

/**
 * p22-watch-next-step: the person's consent a follow-up of watch `watchId` carries — when the message behind its next
 * step was written, while it is younger than GOAL_GRANT_TTL_MS; else null (its drafts stay cards).
 */
export async function nextStepConsent(
  db: Queryable,
  watchId: string,
  userId: string,
  now: Date,
): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `SELECT next_step_consent_at AS at FROM chat_watches
      WHERE id = $1::uuid AND user_id = $2::uuid AND next_step IS NOT NULL`,
    [watchId, userId],
  );
  const at = rows[0]?.at ?? null;
  return consentHolds(at, now) ? at : null;
}

/** p22-watch-next-step / p22-slow-tools: a person's consent still holds (younger than GOAL_GRANT_TTL_MS). */
export function consentHolds(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() < GOAL_GRANT_TTL_MS;
}

const COLS = `id::text AS id, user_id::text AS user_id, thread_id::text AS thread_id, target_kind,
  target_uuid::text AS target_uuid, target_ref, project, label, conditions, repeat, language, state, end_reason,
  cursor, fire_count, last_fired_at, created_at, expires_at, ended_at, spec, then_action, every_sec, next_check_at,
  pending_job_id::text AS pending_job_id, check_count, last_check, result`;

function checkDetails(r: WatchRow): WatchCheckDetails | null {
  if (r.target_kind !== 'check' || r.spec === null) return null;
  const polled = r.spec.kind === 'http' || r.spec.kind === 'worker_probe';
  const machine =
    r.spec.kind === 'machine' || r.spec.kind === 'worker_probe'
      ? typeof r.cursor.machineName === 'string'
        ? r.cursor.machineName
        : undefined
      : undefined;
  return {
    kind: r.spec.kind,
    condition: r.spec,
    summary: conditionText(messagesFor(r.language).watches, r.spec, machine === undefined ? {} : { machine }),
    mode: polled ? 'poll' : 'event',
    everySec: r.every_sec,
    lastCheck: r.last_check,
    nextCheckAt:
      r.state !== 'active' || r.pending_job_id !== null || (!polled && !hasHttpPhase(r.spec))
        ? null
        : (r.next_check_at?.toISOString() ?? null),
    checking: r.pending_job_id !== null,
    checks: r.check_count,
    result: r.result,
    then: r.then_action,
  };
}

function targetId(r: Pick<WatchRow, 'target_uuid' | 'target_ref'>): string {
  return r.target_uuid ?? r.target_ref ?? '';
}

function view(r: WatchRow): WatchView {
  return {
    id: r.id,
    threadId: r.thread_id,
    target: { kind: r.target_kind, id: targetId(r) },
    label: r.label,
    project: r.project,
    conditions: r.conditions,
    repeat: r.repeat,
    language: r.language,
    state: r.state,
    endReason: r.end_reason,
    fireCount: r.fire_count,
    lastFiredAt: r.last_fired_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    endedAt: r.ended_at?.toISOString() ?? null,
    link:
      r.target_kind === 'check' && r.spec !== null
        ? checkLink(r.spec, r.thread_id)
        : watchLink(r.target_kind, targetId(r), r.thread_id),
    check: checkDetails(r),
  };
}

/** What a resource looks like to a watch: its project (null = global), a label, and its current state. */
interface Resolved {
  readonly kind: WatchTarget;
  readonly uuid: string | null;
  readonly ref: string | null;
  readonly project: string | null;
  readonly label: string;
  readonly state: string;
  /** For drafts: the kind it becomes. */
  readonly binds?: BoundKind;
  readonly up?: boolean;
  /** p15-merge-approvals item 3: the label in the watch's language (jobs: "İş 0a1b2c3d · <short title>"). */
  readonly localLabel?: (language: WatchLanguage) => string;
}

/** Longest title in a job watch label: the job title limit (p15-job-titles). */
export const JOB_LABEL_TITLE_MAX = JOB_TITLE_MAX;

/**
 * p15-merge-approvals item 3, p15-job-titles: a job's title for watch labels — its stored title (`job_titles`, or a
 * sub-job's own title) if it has one, else the title derived from its prompt (`deriveJobTitle`); "" without either.
 */
export function shortJobTitle(title: string | null, prompt: string | null): string {
  const own = normalizeJobTitle(title);
  if (own !== null) return own;
  if (prompt === null || prompt.trim() === '') return '';
  return deriveJobTitle(prompt);
}

/** A job watch's label in `language`. */
export function jobWatchLabel(jobId: string, title: string, language: WatchLanguage): string {
  return messagesFor(language).watches.jobLabel({ short: jobId.slice(0, 8), title });
}

/** One thing that happened to a watched resource. */
interface Occurrence {
  readonly key: string;
  readonly deliver: boolean;
  readonly note: Note | null;
  /** A step on the way (a job's approval request): a one-shot watch keeps going after it. */
  readonly progress?: boolean;
  /**
   * p15-chat-cards-scroll: a job's end — the thread note carries the job id, its outcome and the agent's result
   * summary (`meta.jobId` / `jobOutcome` / `jobSummary`), so the console draws the job result card from fresh data.
   */
  readonly job?: {
    readonly id: string;
    readonly outcome: Outcome;
    readonly summary: string | null;
    /** p22-run-attention: the agent's `OUTCOME:` line of a succeeded job (absent: none). */
    readonly attention?: StepOutcome;
  };
  /** p17-chat-flow: a workflow run's end — the note carries the result card's facts (`meta.workflowResult`). */
  readonly workflow?: RunResult;
}

/** The longest agent summary a job note carries (the card shows one or two lines; the job page has the rest). */
const JOB_SUMMARY_MAX = 400;

interface Note {
  readonly severity: 'info' | 'warning';
  readonly title: Record<WatchLanguage, string>;
  /** Markdown for the thread (escaped labels, console-relative links). */
  readonly text: Record<WatchLanguage, string>;
  /** Plain text for the notification body. */
  readonly body: Record<WatchLanguage, string>;
  readonly link: string;
}

type Outcome = 'succeeded' | 'failed' | 'cancelled';

const matches = (conditions: readonly WatchCondition[], outcome: Outcome): boolean =>
  conditions.includes('finished') || conditions.includes(outcome);

const OUTCOME_WORD: Record<WatchLanguage, Record<Outcome, string>> = {
  tr: { succeeded: 'başarıyla bitti', failed: 'başarısız oldu', cancelled: 'iptal edildi' },
  en: { succeeded: 'succeeded', failed: 'failed', cancelled: 'was cancelled' },
};

const UP_STATES = new Set(['online', 'busy', 'draining', 'updating']);

export class ChatWatchService {
  #lastStep = 0;

  constructor(private readonly deps: ChatWatchDeps) {}

  #now(): Date {
    return this.deps.clock();
  }

  // ---------------------------------------------------------------------------------------------- create

  /** Registers (or updates) a watch for `caller` alone, after checking the caller may read the target. */
  async create(
    caller: WatchCaller,
    input: WatchInput,
  ): Promise<{ watch: WatchView; updated: boolean; currentState: string }> {
    if (!(WATCH_TARGETS as readonly string[]).includes(input.target)) {
      throw new WatchError('invalid', 'Unknown watch target.');
    }
    const r = await this.#resolve(this.deps.pool, input.target, input.id, caller.userId);
    if (r === null) throw new WatchError('not_found', 'Nothing to watch with that id.');
    const bound: BoundKind = r.kind === 'draft' ? (r.binds as BoundKind) : r.kind;
    const rule = WATCH_RULES[bound];
    if (r.project !== null || r.kind === 'worker') {
      const d = authorize(
        caller.subject,
        rule.action,
        r.project === null ? undefined : { project: r.project },
      );
      if (!d.allow) {
        // Invisible and forbidden look the same: nothing is revealed about resources the user cannot read.
        throw new WatchError('not_found', 'Nothing to watch with that id.');
      }
    }
    if (r.kind === 'draft' && r.state !== 'proposed') {
      throw new WatchError('invalid', `The draft card is already ${r.state}; watch what it created instead.`);
    }
    const on = [...new Set(input.on ?? [])];
    for (const c of on) {
      if (!(WATCH_CONDITIONS as readonly string[]).includes(c) || !rule.allowed.includes(c)) {
        throw new WatchError(
          'invalid',
          `A ${bound.replace('_', ' ')} watch takes: ${rule.allowed.join(', ')} (not ${c}).`,
        );
      }
    }
    let conditions: WatchCondition[] = on.length > 0 ? on : [...rule.defaults];
    if (conditions.length === 0) {
      if (r.kind === 'monitor') conditions = r.up === false ? ['up'] : ['down'];
      else conditions = r.up === false ? ['online'] : ['offline'];
    }
    const repeat: WatchRepeat = input.repeat ?? 'once';
    if (repeat === 'every' && !rule.every) {
      throw new WatchError(
        'invalid',
        '"every" is only for automations, machines and monitors; this one fires once.',
      );
    }
    const hours = input.expiresInHours ?? DEFAULT_WATCH_TTL_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_WATCH_TTL_HOURS) {
      throw new WatchError('invalid', `expiresInHours must be 1–${String(MAX_WATCH_TTL_HOURS)}.`);
    }
    const language = input.language ?? (await this.#language(caller.userId, caller.threadId));
    const now = this.#now();
    const expires = new Date(now.getTime() + hours * 3600_000);
    const cursor = r.kind === 'worker' || r.kind === 'monitor' ? { up: r.up === true, flips: 0 } : {};
    return withTransaction(this.deps.pool, async (tx) => {
      // Serialise one user's creations (the active-watch cap).
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);
      const { rows } = await tx.query<WatchRow & { inserted: boolean }>(
        `INSERT INTO chat_watches (id, user_id, thread_id, turn_id, target_kind, target_uuid, target_ref, project, label,
                                   conditions, repeat, language, state, cursor, created_at, updated_at, expires_at,
                                   next_step, next_step_consent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13, $14, $14, $15, $16, $17)
         ON CONFLICT (user_id, COALESCE(thread_id, '00000000-0000-0000-0000-000000000000'::uuid), target_kind,
                      COALESCE(target_uuid::text, target_ref)) WHERE state = 'active'
         DO UPDATE SET conditions = EXCLUDED.conditions, repeat = EXCLUDED.repeat, language = EXCLUDED.language,
                       expires_at = EXCLUDED.expires_at, label = EXCLUDED.label, updated_at = EXCLUDED.updated_at,
                       next_step = COALESCE(EXCLUDED.next_step, chat_watches.next_step),
                       next_step_consent_at = CASE WHEN EXCLUDED.next_step IS NULL THEN chat_watches.next_step_consent_at
                                                   ELSE EXCLUDED.next_step_consent_at END
         RETURNING ${COLS}, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          caller.userId,
          caller.threadId,
          caller.turnId,
          r.kind,
          r.uuid,
          r.ref,
          r.project,
          clip(r.localLabel?.(language) ?? r.label, 200),
          conditions,
          repeat,
          language,
          JSON.stringify(cursor),
          now,
          expires,
          nextStepOf(input.nextStep),
          nextStepOf(input.nextStep) === null ? null : (caller.nextStepConsentAt ?? null),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('watch not stored');
      if (row.inserted) {
        const { rows: n } = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM chat_watches WHERE user_id = $1 AND state = 'active'",
          [caller.userId],
        );
        if ((n[0]?.n ?? 0) > MAX_ACTIVE_WATCHES_PER_USER) {
          throw new WatchError(
            'limit',
            `At most ${String(MAX_ACTIVE_WATCHES_PER_USER)} active watches per user; cancel one first.`,
          );
        }
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: caller.userId },
          action: row.inserted ? 'chat.watch.create' : 'chat.watch.update',
          target: `chat-watch:${row.id}`,
          outcome: 'success',
          metadata: {
            targetKind: r.kind,
            targetId: targetId(row),
            project: r.project,
            conditions,
            repeat,
            expiresAt: expires.toISOString(),
            threadId: caller.threadId,
          },
        },
        tx,
      );
      return { watch: view(row), updated: !row.inserted, currentState: r.state };
    });
  }

  /**
   * p15-watches: the language of a watch's notes when the assistant names none — the user's console language
   * (Settings → language), and only when they never chose one, a guess from the conversation.
   */
  async #language(userId: string, threadId: string | null): Promise<WatchLanguage> {
    const { rows } = await this.deps.pool.query<{ locale: string | null }>(
      'SELECT locale FROM users WHERE id = $1',
      [userId],
    );
    const l = rows[0]?.locale;
    if (l === 'tr' || l === 'en') return l;
    return this.#threadLanguage(threadId);
  }

  async #threadLanguage(threadId: string | null): Promise<WatchLanguage> {
    if (threadId === null) return 'en';
    const { rows } = await this.deps.pool.query<{ content: string }>(
      `SELECT content FROM chat_messages WHERE thread_id = $1 AND role = 'user' ORDER BY seq DESC LIMIT 3`,
      [threadId],
    );
    return guessLanguage(rows.map((r) => r.content.slice(0, 2000)));
  }

  /** The resource behind a target id (null: no such thing). Drafts: only the user's own. */
  async #resolve(db: Queryable, kind: WatchTarget, id: string, userId: string): Promise<Resolved | null> {
    if (kind !== 'worker' && !UUID.test(id)) return null;
    const short = id.slice(0, 8);
    switch (kind) {
      case 'job': {
        const { rows } = await db.query<{
          project: string;
          prompt: string | null;
          title: string | null;
          state: string;
        }>(
          `SELECT j.project, left(j.spec->>'prompt', 2000) AS prompt, COALESCE(jt.title, s.title) AS title,
                  j.state::text AS state
             FROM jobs j LEFT JOIN job_subtasks s ON s.child_job_id = j.id
             LEFT JOIN job_titles jt ON jt.job_id = j.id WHERE j.id = $1`,
          [id],
        );
        const j = rows[0];
        if (j === undefined) return null;
        const title = shortJobTitle(j.title, j.prompt);
        return {
          kind,
          uuid: id,
          ref: null,
          project: j.project,
          label: jobWatchLabel(id, title, 'en'),
          localLabel: (language) => jobWatchLabel(id, title, language),
          state: j.state,
        };
      }
      case 'workflow_run': {
        const { rows } = await db.query<{ project: string; name: string; state: string }>(
          'SELECT project, name, state FROM workflow_runs WHERE id = $1',
          [id],
        );
        const w = rows[0];
        if (w === undefined) return null;
        return {
          kind,
          uuid: id,
          ref: null,
          project: w.project,
          label: `Workflow run ${short}: ${clip(w.name, 80)}`,
          state: w.state,
        };
      }
      case 'automation': {
        const { rows } = await db.query<{ project: string; name: string; state: string }>(
          "SELECT project, name, state FROM automations WHERE id = $1 AND state <> 'deleted'",
          [id],
        );
        const a = rows[0];
        if (a === undefined) return null;
        return {
          kind,
          uuid: id,
          ref: null,
          project: a.project,
          label: `Automation: ${clip(a.name, 100)}`,
          state: a.state,
        };
      }
      case 'ops_action': {
        const { rows } = await db.query<{ project: string; kind: string; env: string | null; state: string }>(
          'SELECT project, kind, env, state FROM ops_actions WHERE id = $1',
          [id],
        );
        const o = rows[0];
        if (o === undefined) return null;
        return {
          kind,
          uuid: id,
          ref: null,
          project: o.project,
          label: `${o.kind}${o.env === null ? '' : ` (${o.env})`} ${short}`,
          state: o.state,
        };
      }
      case 'approval': {
        const { rows } = await db.query<{ project: string; action: string; status: string; job_id: string }>(
          `SELECT j.project, a.action, a.status, a.job_id::text AS job_id
             FROM approval_requests a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`,
          [id],
        );
        const a = rows[0];
        if (a === undefined) return null;
        return {
          kind,
          uuid: id,
          ref: null,
          project: a.project,
          label: `Approval ${short} (${a.action}, job ${a.job_id.slice(0, 8)})`,
          state: a.status,
        };
      }
      case 'worker': {
        const { rows } = await db.query<{ id: string; display_name: string; state: string }>(
          `SELECT id, display_name, state FROM workers
            WHERE (id = $1 OR lower(display_name) = lower($1)) AND state NOT IN ('pending', 'quarantined')
            ORDER BY (id = $1) DESC LIMIT 2`,
          [id],
        );
        const w = rows[0];
        if (w === undefined) return null;
        if (rows.length > 1 && w.id !== id) {
          throw new WatchError('invalid', 'Several machines have that name; use the machine id.');
        }
        if (!WORKER_ID.test(w.id)) return null;
        return {
          kind,
          uuid: null,
          ref: w.id,
          project: null,
          label: `Machine ${clip(w.display_name, 100)}`,
          state: w.state,
          up: UP_STATES.has(w.state),
        };
      }
      case 'monitor': {
        const { rows } = await db.query<{
          id: string;
          project: string;
          name: string;
          status: string;
          paused: boolean;
        }>('SELECT id::text AS id, project, name, status, paused FROM uptime_monitors WHERE id = $1', [id]);
        const m = rows[0];
        if (m === undefined) return null;
        return {
          kind,
          uuid: m.id,
          ref: null,
          project: m.project,
          label: `Monitor ${clip(m.name, 100)}`,
          state: m.paused ? 'paused' : m.status,
          up: !(m.status === 'down' && !m.paused),
        };
      }
      case 'draft': {
        const { rows } = await db.query<{
          kind: string;
          project: string | null;
          state: string;
          title: string;
          expires_at: Date;
          payload: Record<string, unknown>;
        }>(
          'SELECT kind, project, state, title, expires_at, payload FROM chat_drafts WHERE id = $1 AND user_id = $2',
          [id, userId],
        );
        const d = rows[0];
        if (d === undefined) return null;
        const binds = DRAFT_BINDS[d.kind];
        if (binds === undefined || (d.kind === 'automation_change' && d.payload.action !== 'run_now')) {
          throw new WatchError('invalid', 'This card creates nothing that can be watched.');
        }
        const expired = d.state === 'proposed' && d.expires_at.getTime() <= this.#now().getTime();
        return {
          kind,
          uuid: id,
          ref: null,
          project: d.project,
          label: `Card: ${clip(d.title, 120)}`,
          state: expired ? 'expired' : d.state,
          binds,
        };
      }
    }
  }

  // ------------------------------------------------------------------------------- p15-watches: create_watch

  /**
   * Registers (or, for the same condition in the same conversation, updates) a `check` watch for `caller` alone,
   * then runs its dry test: one evaluation now (SQL, or a check job on a worker waited for up to 25 s). A condition
   * that is already met is delivered at once.
   */
  async createCheck(caller: WatchCaller, input: CheckInput): Promise<CheckCreated> {
    const checks = this.deps.checks;
    if (checks === undefined) throw new WatchError('invalid', 'Watches with checks are not available.');
    let resolved: Awaited<ReturnType<WatchChecks['resolve']>>;
    try {
      resolved = await checks.resolve(caller.subject, input.condition);
    } catch (err) {
      if (err instanceof WatchCheckError)
        throw new WatchError(
          err.code === 'not_found' ? 'not_found' : err.code === 'forbidden' ? 'forbidden' : 'invalid',
          err.message,
        );
      throw err;
    }
    const then = input.then;
    if (then !== undefined) await this.#checkThen(caller, then);
    const minutes = input.timeoutMinutes ?? WATCH_CHECK_LIMITS.defaultTimeoutMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < WATCH_CHECK_LIMITS.minTimeoutMinutes ||
      minutes > WATCH_CHECK_LIMITS.maxTimeoutMinutes
    )
      throw new WatchError(
        'invalid',
        `timeoutMinutes must be ${String(WATCH_CHECK_LIMITS.minTimeoutMinutes)}–${String(WATCH_CHECK_LIMITS.maxTimeoutMinutes)}.`,
      );
    const polled = checks.polled(resolved.spec);
    const every = Math.min(
      Math.max(input.checkEverySec ?? WATCH_CHECK_LIMITS.defaultEverySec, WATCH_CHECK_LIMITS.minEverySec),
      WATCH_CHECK_LIMITS.maxEverySec,
    );
    const language = input.language ?? (await this.#language(caller.userId, caller.threadId));
    const label = clip(
      oneLine(input.label ?? checks.describe(resolved, language), WATCH_CHECK_LIMITS.maxLabel),
      200,
    );
    const now = this.#now();
    const expires = new Date(now.getTime() + minutes * 60_000);
    const ref = checks.ref(resolved.spec);
    const subject = checks.subjectOf(resolved.spec);
    const cursor = resolved.machineName === null ? {} : { machineName: resolved.machineName };
    const usesEvery = polled || hasHttpPhase(resolved.spec);
    const out = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);
      const { rows } = await tx.query<WatchRow & { inserted: boolean }>(
        `INSERT INTO chat_watches (id, user_id, thread_id, turn_id, target_kind, target_uuid, target_ref, project, label,
                                   conditions, repeat, language, state, cursor, created_at, updated_at, expires_at,
                                   spec, then_action, subject, every_sec, next_check_at, next_step,
                                   next_step_consent_at)
         VALUES ($1, $2, $3, $4, 'check', NULL, $5, $6, $7, '{met}', 'once', $8, 'active', $9, $10, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (user_id, COALESCE(thread_id, '00000000-0000-0000-0000-000000000000'::uuid), target_kind,
                      COALESCE(target_uuid::text, target_ref)) WHERE state = 'active'
         DO UPDATE SET label = EXCLUDED.label, language = EXCLUDED.language, expires_at = EXCLUDED.expires_at,
                       then_action = EXCLUDED.then_action, every_sec = EXCLUDED.every_sec,
                       next_check_at = CASE WHEN chat_watches.pending_job_id IS NULL THEN EXCLUDED.next_check_at
                                            ELSE chat_watches.next_check_at END,
                       unmet_streak = 0, updated_at = EXCLUDED.updated_at,
                       next_step = COALESCE(EXCLUDED.next_step, chat_watches.next_step),
                       next_step_consent_at = CASE WHEN EXCLUDED.next_step IS NULL THEN chat_watches.next_step_consent_at
                                                   ELSE EXCLUDED.next_step_consent_at END
         RETURNING ${COLS}, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          caller.userId,
          caller.threadId,
          caller.turnId,
          ref,
          resolved.project,
          label,
          language,
          JSON.stringify(cursor),
          now,
          expires,
          JSON.stringify(resolved.spec),
          then === undefined ? null : JSON.stringify(then),
          subject,
          usesEvery ? every : null,
          polled ? now : null,
          nextStepOf(input.nextStep),
          nextStepOf(input.nextStep) === null ? null : (caller.nextStepConsentAt ?? null),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('watch not stored');
      if (row.inserted) {
        const { rows: n } = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM chat_watches WHERE user_id = $1 AND state = 'active'",
          [caller.userId],
        );
        if ((n[0]?.n ?? 0) > MAX_ACTIVE_WATCHES_PER_USER) {
          throw new WatchError(
            'limit',
            `At most ${String(MAX_ACTIVE_WATCHES_PER_USER)} active watches per user; cancel one first.`,
          );
        }
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: caller.userId },
          action: row.inserted ? 'chat.watch.create' : 'chat.watch.update',
          target: `chat-watch:${row.id}`,
          outcome: 'success',
          // The condition's kind and ids only (no URL, no expression).
          metadata: {
            targetKind: 'check',
            checkKind: resolved.spec.kind,
            project: resolved.project,
            subject,
            polled,
            everySec: usesEvery ? every : null,
            then: then?.action ?? null,
            expiresAt: expires.toISOString(),
            threadId: caller.threadId,
          },
        },
        tx,
      );
      return { id: row.id, inserted: row.inserted };
    });
    void checks.listen();
    const dry = await checks.dryTest(out.id);
    const { rows } = await this.deps.pool.query<WatchRow>(`SELECT ${COLS} FROM chat_watches WHERE id = $1`, [
      out.id,
    ]);
    const r = rows[0];
    if (r === undefined) throw new Error('watch vanished');
    if (r.thread_id !== null) this.#publish(r.thread_id, null);
    return { watch: view(r), updated: !out.inserted, dryTest: r.last_check, pending: dry.pending };
  }

  /** The `then` card must be one the user could draft now (re-checked when it is prepared). */
  async #checkThen(caller: WatchCaller, then: WatchThen): Promise<void> {
    if (then.action === 'deploy') {
      // p19-watch-deploy: the card is draft_deploy's (its own checks run again when it is prepared).
      const { rows } = await this.deps.pool.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [
        then.project,
      ]);
      if (
        rows[0] === undefined ||
        !authorize(caller.subject, 'projects.read', { project: then.project }).allow
      )
        throw new WatchError('not_found', `Project ${then.project} not found.`);
      if (!authorize(caller.subject, 'deploy.request', { project: then.project }).allow)
        throw new WatchError('forbidden', 'Requesting a deploy needs the operator role in that project.');
      return;
    }
    if (then.action === 'job_message') {
      const { rows } = await this.deps.pool.query<{ project: string }>(
        'SELECT project FROM jobs WHERE id = $1',
        [then.jobId],
      );
      const p = rows[0]?.project;
      if (p === undefined || !authorize(caller.subject, 'jobs.read', { project: p }).allow)
        throw new WatchError('not_found', 'The job of the follow-up message was not found.');
      if (!authorize(caller.subject, 'jobs.message', { project: p }).allow)
        throw new WatchError(
          'forbidden',
          'Messaging that job’s agent needs the operator role in its project.',
        );
      return;
    }
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM workflow_definitions WHERE id = $1',
      [then.workflowId],
    );
    const p = rows[0]?.project;
    if (p === undefined || !authorize(caller.subject, 'workflows.read', { project: p }).allow)
      throw new WatchError('not_found', 'The workflow of the follow-up run was not found.');
    if (!authorize(caller.subject, 'workflows.run', { project: p }).allow)
      throw new WatchError('forbidden', 'Starting that workflow needs the operator role in its project.');
  }

  // ------------------------------------------------------------------------------------- list / cancel

  async list(
    userId: string,
    opts: { threadId?: string | null; includeEnded?: boolean; limit?: number; threadTitles?: boolean } = {},
  ): Promise<WatchView[]> {
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (opts.threadId !== undefined && opts.threadId !== null) {
      params.push(opts.threadId);
      where += ` AND thread_id = $${String(params.length)}`;
    }
    if (opts.includeEnded !== true) where += " AND state = 'active'";
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    const { rows } = await this.deps.pool.query<WatchRow>(
      `SELECT ${COLS} FROM chat_watches WHERE ${where}
        ORDER BY (state = 'active') DESC, created_at DESC LIMIT $${String(params.length)}`,
      params,
    );
    const views = rows.map(view);
    if (opts.threadTitles !== true) return views;
    // p20-quick: the titles of the user's OWN conversations only (a watch never names another user's thread).
    const ids = [...new Set(views.flatMap((w) => (w.threadId === null ? [] : [w.threadId])))];
    const titles = new Map<string, string>();
    if (ids.length > 0) {
      const { rows: t } = await this.deps.pool.query<{ id: string; title: string }>(
        'SELECT id::text AS id, title FROM chat_threads WHERE user_id = $1 AND id = ANY($2::uuid[])',
        [userId, ids],
      );
      for (const r of t) titles.set(r.id, r.title);
    }
    return views.map((w) => ({
      ...w,
      threadTitle: w.threadId === null ? null : (titles.get(w.threadId) ?? null),
    }));
  }

  /** Cancels one of the user's own active watches (another user's id is "not found"). */
  async cancel(userId: string, watchId: string): Promise<WatchView> {
    if (!UUID.test(watchId)) throw new WatchError('not_found', 'Watch not found.');
    const out = await this.#cancelWhere(userId, 'id = $2', [watchId]);
    const w = out[0];
    if (w === undefined) {
      const { rows } = await this.deps.pool.query<WatchRow>(
        `SELECT ${COLS} FROM chat_watches WHERE id = $1 AND user_id = $2`,
        [watchId, userId],
      );
      if (rows[0] === undefined) throw new WatchError('not_found', 'Watch not found.');
      throw new WatchError('invalid', `The watch is already ${rows[0].state}.`);
    }
    return w;
  }

  /** Cancels every active watch of the user in one thread. */
  async cancelThread(userId: string, threadId: string): Promise<WatchView[]> {
    return this.#cancelWhere(userId, 'thread_id = $2', [threadId]);
  }

  async #cancelWhere(userId: string, cond: string, params: unknown[]): Promise<WatchView[]> {
    const now = this.#now();
    const pending: string[] = [];
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<WatchRow>(
        `UPDATE chat_watches SET state = 'cancelled', end_reason = 'cancelled', ended_at = $${String(params.length + 2)},
                updated_at = $${String(params.length + 2)}
          WHERE user_id = $1 AND state = 'active' AND ${cond} RETURNING ${COLS}`,
        [userId, ...params, now],
      );
      for (const r of rows) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'chat.watch.cancel',
            target: `chat-watch:${r.id}`,
            outcome: 'success',
            metadata: { targetKind: r.target_kind, targetId: targetId(r) },
          },
          tx,
        );
        if (r.pending_job_id !== null) pending.push(r.pending_job_id);
      }
      return rows.map(view);
    });
    for (const j of pending) await this.deps.checks?.cancelCheckJob(j);
    return out;
  }

  // ------------------------------------------------------------------------------------------ note now

  /**
   * "Send me this now": a `chat.note` notification to the caller alone (in-app; e-mail / webhook where the caller
   * enabled that kind). At most NOTES_PER_HOUR per user. Returns where it goes.
   */
  async sendNote(
    caller: WatchCaller,
    note: { title: string; message: string },
  ): Promise<{
    notificationId: string | null;
    channels: { inApp: 'sent'; email: string; webhook: string };
  }> {
    const svc = this.deps.notifications();
    if (svc === null) throw new WatchError('invalid', 'Notifications are not available.');
    const now = this.#now();
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [caller.userId]);
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications
          WHERE recipient_id = $1 AND kind = 'chat.note' AND created_at > $2`,
        [caller.userId, new Date(now.getTime() - 3600_000)],
      );
      if ((rows[0]?.n ?? 0) >= NOTES_PER_HOUR) {
        throw new WatchError('limit', `At most ${String(NOTES_PER_HOUR)} notes per hour; try again later.`);
      }
      const key = `chat.note:${randomUUID()}`;
      await svc.notify(tx, [caller.userId], {
        kind: 'chat.note',
        severity: 'info',
        title: note.title,
        body: note.message,
        link: caller.threadId === null ? '/chat' : `/chat/${caller.threadId}`,
        dedupeKey: key,
      });
      const { rows: n } = await tx.query<{ id: string }>(
        'SELECT id::text AS id FROM notifications WHERE recipient_id = $1 AND dedupe_key = $2',
        [caller.userId, key],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: caller.userId },
          action: 'chat.note.send',
          target: `user:${caller.userId}`,
          outcome: 'success',
          // No content: the note is the user's own text to themselves.
          metadata: { threadId: caller.threadId, notificationId: n[0]?.id ?? null },
        },
        tx,
      );
      return n[0]?.id ?? null;
    });
    return { notificationId: id, channels: await this.channels(caller.userId, 'chat.note') };
  }

  /** Where a notification of `kind` reaches the user: in-app always; e-mail / webhook by their settings. */
  async channels(
    userId: string,
    kind: 'chat.note' | 'chat.watch',
  ): Promise<{ inApp: 'sent'; email: string; webhook: string; push: string }> {
    const svc = this.deps.notifications();
    if (svc === null) {
      return { inApp: 'sent', email: 'not_configured', webhook: 'not_configured', push: 'not_configured' };
    }
    const p = await svc.preferences(userId);
    const k = p.kinds.find((x) => x.kind === kind);
    const state = (available: boolean, target: string | null, enabled: boolean): string =>
      !available ? 'not_configured' : target === null ? 'no_address' : enabled ? 'queued' : 'off';
    return {
      inApp: 'sent',
      email: state(p.channels.email.available, p.channels.email.address, k?.email === true),
      webhook: state(p.channels.webhook.available, p.channels.webhook.url, k?.webhook === true),
      // p8-pwa: push "address" = at least one registered device (Settings → Devices).
      push: state(p.channels.push.available, p.channels.push.devices > 0 ? 'device' : null, k?.push === true),
    };
  }

  // ---------------------------------------------------------------------------------------------- tick

  /** The orchestrator tick step (evaluated at most every `everyMs`, default 5 s). */
  step(everyMs = 5_000): { name: string; run: () => Promise<number> } {
    return {
      name: 'chat-watches',
      run: async () => {
        const t = this.#now().getTime();
        if (t - this.#lastStep < everyMs) return 0;
        this.#lastStep = t;
        return this.tick();
      },
    };
  }

  /** One pass: expire, then evaluate every watch whose resource may have moved. Returns the watches handled. */
  async tick(): Promise<number> {
    const now = this.#now();
    let n = await this.#expire(now);
    // p15-watches: due polls, stuck check jobs and (at boot / after a reconnect) one reconcile of event watches.
    if (this.deps.checks !== undefined) n += await this.deps.checks.tick();
    for (const id of await this.#candidates(now)) {
      try {
        if (await this.#evaluate(id)) n++;
      } catch (err) {
        this.deps.log.error({ err, watchId: id }, 'chat watch evaluation failed');
      }
    }
    await this.deps.pool.query(
      `DELETE FROM chat_watches WHERE id IN (
         SELECT id FROM chat_watches WHERE state <> 'active' AND ended_at < $1 LIMIT 500)`,
      [new Date(now.getTime() - ENDED_RETENTION_MS)],
    );
    return n;
  }

  async #expire(now: Date): Promise<number> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const pending: string[] = [];
    const n = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<WatchRow>(
        `UPDATE chat_watches SET state = 'expired', end_reason = 'expired', ended_at = $1, updated_at = $1
          WHERE id IN (SELECT id FROM chat_watches WHERE state = 'active' AND expires_at <= $1
                        ORDER BY expires_at LIMIT ${String(BATCH)} FOR UPDATE SKIP LOCKED)
          RETURNING ${COLS}`,
        [now],
      );
      for (const r of rows) {
        if (r.target_kind === 'check') {
          // p15-watches: "it did not happen" with the last check, in the conversation and as a notification.
          if (r.pending_job_id !== null) pending.push(r.pending_job_id);
          const t = messagesFor(r.language).watches;
          const last =
            r.last_check === null
              ? t.delivery.timeoutNever
              : `${r.last_check.summary} ${t.delivery.at({ when: await wallClock(tx, r.user_id, r.last_check.at) })}`;
          await this.deps.notifications()?.notify(tx, [r.user_id], {
            kind: 'chat.watch',
            severity: 'warning',
            title: t.delivery.timeoutTitle({ label: r.label }),
            body: `${r.label}: ${last}`,
            link: r.spec === null ? watchLink('check', '', r.thread_id) : checkLink(r.spec, r.thread_id),
            dedupeKey: `chat.watch:${r.id}:timeout`,
          });
          if (r.thread_id === null) continue;
          const message = await this.deps.store.addMessage(
            r.thread_id,
            {
              role: 'assistant',
              content: t.delivery.timeoutText({ label: mdText(r.label), last: mdText(last) }),
              meta: { notice: 'chat-watch', watchId: r.id, event: 'expired' },
            },
            tx,
          );
          posted.push({ threadId: r.thread_id, message });
          continue;
        }
        if (r.thread_id === null) continue;
        const text =
          r.language === 'tr'
            ? `İzleme süresi doldu, artık izlemiyorum: ${mdText(r.label)}.`
            : `Stopped watching ${mdText(r.label)}: the watch expired.`;
        const message = await this.deps.store.addMessage(
          r.thread_id,
          {
            role: 'assistant',
            content: text,
            meta: { notice: 'chat-watch', watchId: r.id, event: 'expired' },
          },
          tx,
        );
        posted.push({ threadId: r.thread_id, message });
      }
      return rows.length;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    for (const j of pending) await this.deps.checks?.cancelCheckJob(j);
    return n;
  }

  /** Active watches whose target reached a state worth a look (set-based; the evaluation re-reads everything). */
  async #candidates(now: Date): Promise<string[]> {
    const q = async (sql: string, params: unknown[] = []): Promise<string[]> =>
      (await this.deps.pool.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
    const lim = `LIMIT ${String(BATCH)}`;
    const ids = await Promise.all([
      q(`SELECT w.id::text AS id FROM chat_watches w JOIN jobs j ON j.id = w.target_uuid
          WHERE w.state = 'active' AND w.target_kind = 'job'
            AND (j.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST')
                 OR ('approval_requested' = ANY (w.conditions) AND EXISTS (
                      SELECT 1 FROM approval_requests a WHERE a.job_id = j.id
                         AND (a.status = 'pending' OR a.created_at >= w.created_at)
                         AND NOT EXISTS (SELECT 1 FROM chat_watch_fires f
                                          WHERE f.watch_id = w.id AND f.occurrence = 'approval:' || a.id::text)))
                 -- p10-approval-pause: "still waiting" once per stale request, "paused" once per pause episode.
                 OR ('approval_requested' = ANY (w.conditions) AND EXISTS (
                      SELECT 1 FROM approval_requests a WHERE a.job_id = j.id AND a.status = 'pending'
                         AND a.stale_at IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM chat_watch_fires f
                                          WHERE f.watch_id = w.id AND f.occurrence = 'stale:' || a.id::text)))
                 OR ('approval_requested' = ANY (w.conditions) AND j.state = 'PAUSED' AND EXISTS (
                      SELECT 1 FROM job_pauses p WHERE p.job_id = j.id AND p.ended_at IS NULL
                         AND p.paused_at IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM chat_watch_fires f
                                          WHERE f.watch_id = w.id AND f.occurrence = 'paused:' || p.id::text))))
          ${lim}`),
      q(`SELECT w.id::text AS id FROM chat_watches w JOIN workflow_runs r ON r.id = w.target_uuid
          WHERE w.state = 'active' AND w.target_kind = 'workflow_run' AND r.state IN ('succeeded', 'failed', 'cancelled')
          ${lim}`),
      q(`SELECT w.id::text AS id FROM chat_watches w JOIN automations a ON a.id = w.target_uuid
          WHERE w.state = 'active' AND w.target_kind = 'automation'
            AND (a.state = 'deleted' OR EXISTS (
                 SELECT 1 FROM automation_runs r WHERE r.automation_id = a.id
                    AND r.state IN ('succeeded', 'failed', 'cancelled', 'error')
                    AND COALESCE(r.finished_at, r.created_at) >= w.created_at
                    AND NOT EXISTS (SELECT 1 FROM chat_watch_fires f
                                     WHERE f.watch_id = w.id AND f.occurrence = 'run:' || r.id::text)))
          ${lim}`),
      q(`SELECT w.id::text AS id FROM chat_watches w JOIN ops_actions o ON o.id = w.target_uuid
          WHERE w.state = 'active' AND w.target_kind = 'ops_action'
            AND (o.state IN ('succeeded', 'failed', 'refused', 'denied', 'expired')
                 OR ('decided' = ANY (w.conditions) AND o.decided_at IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM chat_watch_fires f
                                      WHERE f.watch_id = w.id AND f.occurrence = 'decided')))
          ${lim}`),
      q(`SELECT w.id::text AS id FROM chat_watches w JOIN approval_requests a ON a.id = w.target_uuid
          WHERE w.state = 'active' AND w.target_kind = 'approval' AND a.status <> 'pending' ${lim}`),
      q(`SELECT w.id::text AS id FROM chat_watches w LEFT JOIN workers k ON k.id = w.target_ref
          WHERE w.state = 'active' AND w.target_kind = 'worker'
            AND (k.id IS NULL OR k.state IN ('quarantined', 'pending')
                 OR (k.state IN ('online', 'busy', 'draining', 'updating'))
                    IS DISTINCT FROM COALESCE((w.cursor->>'up')::boolean, true))
          ${lim}`),
      q(`SELECT w.id::text AS id FROM chat_watches w LEFT JOIN uptime_monitors m ON m.id = w.target_uuid
          WHERE w.state = 'active' AND w.target_kind = 'monitor'
            AND (m.id IS NULL
                 OR (NOT (m.status = 'down' AND NOT m.paused)) IS DISTINCT FROM COALESCE((w.cursor->>'up')::boolean, true))
          ${lim}`),
      q(
        `SELECT w.id::text AS id FROM chat_watches w LEFT JOIN chat_drafts d ON d.id = w.target_uuid AND d.user_id = w.user_id
          WHERE w.state = 'active' AND w.target_kind = 'draft'
            AND (d.id IS NULL OR d.state <> 'proposed' OR d.expires_at <= $1)
          ${lim}`,
        [now],
      ),
    ]);
    return [...new Set(ids.flat())];
  }

  async #activeSubject(db: Queryable, userId: string): Promise<Subject | null> {
    const { rows } = await db.query<{ id: string; role: Role; disabled_at: Date | null }>(
      'SELECT id::text AS id, role, disabled_at FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled_at !== null) return null;
    return loadSubject(db, { id: u.id, role: u.role });
  }

  /** Evaluates one watch in its own transaction. True when something was delivered or the watch ended. */
  async #evaluate(watchId: string): Promise<boolean> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<WatchRow>(
        `SELECT ${COLS} FROM chat_watches WHERE id = $1 AND state = 'active' FOR UPDATE SKIP LOCKED`,
        [watchId],
      );
      const w = rows[0];
      if (w === undefined) return false;
      const now = this.#now();
      const end = async (state: WatchState, reason: string, note?: Record<WatchLanguage, string>) => {
        await tx.query(
          `UPDATE chat_watches SET state = $2, end_reason = $3, ended_at = $4, updated_at = $4 WHERE id = $1`,
          [w.id, state, reason.slice(0, 300), now],
        );
        if (note !== undefined && w.thread_id !== null) {
          const message = await this.deps.store.addMessage(
            w.thread_id,
            {
              role: 'assistant',
              content: note[w.language],
              meta: { notice: 'chat-watch', watchId: w.id, event: reason },
            },
            tx,
          );
          posted.push({ threadId: w.thread_id, message });
        }
        return true;
      };
      const subject = await this.#activeSubject(tx, w.user_id);
      if (subject === null) return end('revoked', 'user_disabled');

      // A draft card: follow what confirming it created.
      if (w.target_kind === 'draft') return this.#bindDraft(tx, w, now, end);
      // p15-watches: check watches are evaluated by WatchChecks.
      if (w.target_kind === 'check') return false;

      const rule = WATCH_RULES[w.target_kind];
      const r = await this.#resolve(tx, w.target_kind, targetId(w), w.user_id).catch(() => null);
      if (r === null) {
        return end('done', 'target_gone', {
          tr: `${mdText(w.label)} artık bulunamıyor; izlemeyi bitirdim.`,
          en: `${mdText(w.label)} is gone; I stopped watching it.`,
        });
      }
      const allowed = authorize(
        subject,
        rule.action,
        r.project === null ? undefined : { project: r.project },
      );
      if (!allowed.allow) {
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'chat-watches' },
            action: 'chat.watch.revoke',
            target: `chat-watch:${w.id}`,
            outcome: 'denied',
            metadata: { reason: 'access_lost', targetKind: w.target_kind },
          },
          tx,
        );
        return end('revoked', 'access_lost', {
          tr: 'Bir izlemeyi durdurdum: izlenen kayda artık erişimin yok.',
          en: 'I stopped a watch: you no longer have access to what it followed.',
        });
      }

      const { occurrences, finish, cursor } = await this.#occurrences(tx, w);
      let delivered = 0;
      let fireCount = w.fire_count;
      let ended: { state: WatchState; reason: string } | null = finish;
      for (const o of occurrences) {
        const { rowCount } = await tx.query(
          `INSERT INTO chat_watch_fires (watch_id, occurrence, delivered, fired_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [w.id, o.key, o.deliver, now],
        );
        if ((rowCount ?? 0) === 0 || !o.deliver || o.note === null) continue;
        const message = await this.#deliver(tx, w, o);
        if (message !== null && w.thread_id !== null) posted.push({ threadId: w.thread_id, message });
        delivered++;
        fireCount++;
        if (w.repeat === 'once' && o.progress !== true) {
          // p22-run-attention: a run that needs attention keeps its reason (the follow-up hands it to the assistant).
          ended = finish?.reason === 'attention' ? finish : { state: 'done', reason: 'fired' };
          break;
        }
        if (fireCount >= MAX_WATCH_FIRES) {
          ended = { state: 'done', reason: 'fire_limit' };
          break;
        }
      }
      await tx.query(
        `UPDATE chat_watches SET fire_count = $2, last_fired_at = CASE WHEN $3 THEN $4 ELSE last_fired_at END,
                cursor = $5, updated_at = $4 WHERE id = $1`,
        [w.id, fireCount, delivered > 0, now, JSON.stringify(cursor ?? w.cursor)],
      );
      if (ended !== null) await end(ended.state, ended.reason);
      return delivered > 0 || ended !== null || occurrences.length > 0;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return changed;
  }

  async #bindDraft(
    tx: Queryable,
    w: WatchRow,
    now: Date,
    end: (state: WatchState, reason: string, note?: Record<WatchLanguage, string>) => Promise<boolean>,
  ): Promise<boolean> {
    const { rows } = await tx.query<{
      kind: string;
      state: string;
      expires_at: Date;
      result: Record<string, unknown> | null;
    }>('SELECT kind, state, expires_at, result FROM chat_drafts WHERE id = $1 AND user_id = $2', [
      w.target_uuid,
      w.user_id,
    ]);
    const d = rows[0];
    if (d === undefined || d.state !== 'confirmed') {
      if (d !== undefined && d.state === 'proposed' && d.expires_at.getTime() > now.getTime()) return false;
      const why = d === undefined ? 'deleted' : d.state === 'proposed' ? 'expired' : d.state;
      return end('done', `draft_${why}`, {
        tr: `Kart onaylanmadı (${why}); ${mdText(w.label)} için izlemeyi bıraktım.`,
        en: `The card was not confirmed (${why}); I stopped watching ${mdText(w.label)}.`,
      });
    }
    const res = d.result ?? {};
    const str = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
    let kind: BoundKind | null = null;
    let id: string | null = null;
    if (d.kind === 'workflow_run' && str(res.runId) !== null) [kind, id] = ['workflow_run', str(res.runId)];
    else if (d.kind === 'ops_action' && str(res.actionId) !== null)
      [kind, id] = ['ops_action', str(res.actionId)];
    else if (d.kind === 'automation' && str(res.automationId) !== null)
      [kind, id] = ['automation', str(res.automationId)];
    else if (d.kind === 'monitor' && str(res.monitorId) !== null)
      [kind, id] = ['monitor', str(res.monitorId)];
    else if (str(res.jobId) !== null) [kind, id] = ['job', str(res.jobId)];
    if (kind === null || id === null) {
      return end('done', 'draft_nothing_to_watch', {
        tr: `Onaylanan kart izlenebilecek bir şey oluşturmadı; ${mdText(w.label)} için izlemeyi bıraktım.`,
        en: `The confirmed card created nothing to watch; I stopped watching ${mdText(w.label)}.`,
      });
    }
    const r = await this.#resolve(tx, kind, id, w.user_id);
    if (r === null) return end('done', 'target_gone');
    // Conditions stay what the user asked; drop those the bound kind does not take.
    const rule = WATCH_RULES[kind];
    let conditions = w.conditions.filter((c) => rule.allowed.includes(c));
    if (conditions.length === 0) conditions = [...rule.defaults];
    const { rowCount } = await tx.query(
      `UPDATE chat_watches SET target_kind = $2, target_uuid = $3, project = $4, label = $5, conditions = $6,
              repeat = CASE WHEN $7 THEN repeat ELSE 'once' END, updated_at = $8
        WHERE id = $1 AND NOT EXISTS (
          SELECT 1 FROM chat_watches o WHERE o.id <> $1 AND o.state = 'active' AND o.user_id = $9
             AND o.thread_id IS NOT DISTINCT FROM $10 AND o.target_kind = $2 AND o.target_uuid = $3)`,
      [
        w.id,
        kind,
        id,
        r.project,
        clip(r.localLabel?.(w.language) ?? r.label, 200),
        conditions,
        rule.every,
        now,
        w.user_id,
        w.thread_id,
      ],
    );
    // Already watched under its own id (the user asked twice): this one is redundant.
    if ((rowCount ?? 0) === 0) return end('done', 'duplicate');
    return true;
  }

  /** The occurrences of a watch's target not yet recorded, and whether the watch ends afterwards. */
  async #occurrences(
    tx: Queryable,
    w: WatchRow,
  ): Promise<{
    occurrences: Occurrence[];
    finish: { state: WatchState; reason: string } | null;
    cursor?: Record<string, unknown>;
  }> {
    const id = targetId(w);
    const short = id.slice(0, 8);
    const label = mdText(w.label);
    const link = watchLink(w.target_kind, id, w.thread_id);
    const finished = (
      outcome: Outcome,
      what: Record<WatchLanguage, string>,
      extra: Record<WatchLanguage, string> = { tr: '', en: '' },
      plainExtra: Record<WatchLanguage, string> = { tr: '', en: '' },
    ): Occurrence => ({
      key: 'end',
      deliver: matches(w.conditions, outcome),
      note: {
        severity: outcome === 'succeeded' ? 'info' : 'warning',
        title: {
          tr: `${what.tr} ${OUTCOME_WORD.tr[outcome]}`,
          en: `${what.en} ${OUTCOME_WORD.en[outcome]}`,
        },
        text: {
          tr: `**${what.tr} ${OUTCOME_WORD.tr[outcome]}:** ${label}. [Aç](${link})${extra.tr}`,
          en: `**${what.en} ${OUTCOME_WORD.en[outcome]}:** ${label}. [Open](${link})${extra.en}`,
        },
        body: { tr: `${w.label}.${plainExtra.tr}`, en: `${w.label}.${plainExtra.en}` },
        link,
      },
    });
    const seen = async (prefix: string): Promise<Set<string>> => {
      const { rows } = await tx.query<{ occurrence: string }>(
        'SELECT occurrence FROM chat_watch_fires WHERE watch_id = $1 AND occurrence LIKE $2',
        [w.id, `${prefix}:%`],
      );
      return new Set(rows.map((r) => r.occurrence));
    };
    const done = { state: 'done' as const, reason: 'finished' };

    switch (w.target_kind) {
      case 'job': {
        const out: Occurrence[] = [];
        if (w.conditions.includes('approval_requested')) {
          const known = await seen('approval');
          const { rows } = await tx.query<{
            id: string;
            action: string;
            created_at: Date;
            summary: string;
            details: unknown;
          }>(
            `SELECT id::text AS id, action, created_at, summary, details FROM approval_requests
              WHERE job_id = $1 AND (status = 'pending' OR created_at >= $2) ORDER BY created_at LIMIT 20`,
            [id, w.created_at],
          );
          for (const a of rows) {
            if (known.has(`approval:${a.id}`)) continue;
            const alink = `/approvals/${a.id}`;
            // p10-approval-readable: what it is about — the agent's own (unverified) words or the command, one line.
            const head = detailsView(storedDetails(a.details), a.summary).headline;
            const about =
              head.source === 'summary'
                ? null
                : {
                    tr:
                      head.source === 'agent'
                        ? `Ajanın açıklaması (doğrulanmadı): “${mdText(head.text)}”`
                        : `Komut: ${mdText(head.text)}`,
                    en:
                      head.source === 'agent'
                        ? `The agent says (unverified): “${mdText(head.text)}”`
                        : `Command: ${mdText(head.text)}`,
                  };
            out.push({
              key: `approval:${a.id}`,
              progress: true,
              deliver: true,
              note: {
                severity: 'warning',
                title: { tr: `Onay bekleniyor: iş ${short}`, en: `Approval needed: job ${short}` },
                text: {
                  tr: `**Onay bekleniyor:** ${label} bir onay istiyor (${mdText(a.action)}).${about === null ? '' : ` ${about.tr}`} [Onayı aç](${alink})`,
                  en: `**Approval needed:** ${label} asks for an approval (${mdText(a.action)}).${about === null ? '' : ` ${about.en}`} [Open the approval](${alink})`,
                },
                body: {
                  tr: `${w.label} bir onay istiyor (${a.action}).`,
                  en: `${w.label} asks for an approval (${a.action}).`,
                },
                link: alink,
              },
            });
          }
          // p10-approval-pause: once per stale request and once per pause episode.
          const staleSeen = await seen('stale');
          const { rows: stale } = await tx.query<{ id: string; action: string }>(
            `SELECT id::text AS id, action FROM approval_requests
              WHERE job_id = $1 AND status = 'pending' AND stale_at IS NOT NULL ORDER BY created_at LIMIT 20`,
            [id],
          );
          for (const a of stale) {
            if (staleSeen.has(`stale:${a.id}`)) continue;
            const alink = `/approvals/${a.id}`;
            out.push({
              key: `stale:${a.id}`,
              progress: true,
              deliver: true,
              note: {
                severity: 'warning',
                title: {
                  tr: `Onayın hala bekleniyor: iş ${short}`,
                  en: `Still waiting for your approval: job ${short}`,
                },
                text: {
                  tr: `**Onayın hala bekleniyor:** ${label} bir süredir ${mdText(a.action)} için karar bekliyor. Karar verilmezse iş duraklatılır (makine boşalır, hiçbir şey kaybolmaz). [Onayı aç](${alink})`,
                  en: `**Still waiting for your approval:** ${label} has been waiting for a decision on ${mdText(a.action)}. If nobody decides it is paused (its machine is freed, nothing is lost). [Open the approval](${alink})`,
                },
                body: {
                  tr: `${w.label} hala ${a.action} için onay bekliyor.`,
                  en: `${w.label} is still waiting for approval of ${a.action}.`,
                },
                link: alink,
              },
            });
          }
          const pausedSeen = await seen('paused');
          const { rows: paused } = await tx.query<{ id: string; action: string; retain_until: Date }>(
            `SELECT p.id::text AS id, r.action, p.retain_until FROM job_pauses p
               JOIN approval_requests r ON r.id = p.request_id JOIN jobs j ON j.id = p.job_id
              WHERE p.job_id = $1 AND p.ended_at IS NULL AND p.paused_at IS NOT NULL AND j.state = 'PAUSED'
              LIMIT 5`,
            [id],
          );
          for (const p of paused) {
            if (pausedSeen.has(`paused:${p.id}`)) continue;
            out.push({
              key: `paused:${p.id}`,
              progress: true,
              deliver: true,
              note: {
                severity: 'warning',
                title: { tr: `İş duraklatıldı: ${short}`, en: `Job paused: ${short}` },
                text: {
                  tr: `**İş onay beklerken duraklatıldı:** ${label} (${mdText(p.action)}). Makine boşaldı, çalışma alanı ${p.retain_until.toISOString().slice(0, 10)} tarihine kadar saklanıyor; onaylar ya da reddedersen kaldığı yerden devam eder. [Aç](${link})`,
                  en: `**Paused while waiting for approval:** ${label} (${mdText(p.action)}). Its machine slot is free and its workspace is kept until ${p.retain_until.toISOString().slice(0, 10)}; approve or deny and it continues where it stopped. [Open](${link})`,
                },
                body: {
                  tr: `${w.label} onay beklerken duraklatıldı.`,
                  en: `${w.label} was paused while waiting for approval.`,
                },
                link,
              },
            });
          }
        }
        const { rows } = await tx.query<{ state: string; url: string | null; summary: string | null }>(
          `SELECT j.state::text AS state, d.url,
                  (SELECT r.result->>'summary' FROM job_runs r WHERE r.job_id = j.id
                    ORDER BY r.created_at DESC, r.attempt_id DESC LIMIT 1) AS summary
             FROM jobs j LEFT JOIN job_deploy_on_success d ON d.job_id = j.id
            WHERE j.id = $1`,
          [id],
        );
        const j = rows[0];
        const outcome: Outcome | null =
          j?.state === 'SUCCEEDED'
            ? 'succeeded'
            : j?.state === 'FAILED' || j?.state === 'LOST'
              ? 'failed'
              : j?.state === 'CANCELLED'
                ? 'cancelled'
                : null;
        if (outcome === null) return { occurrences: out, finish: null };
        const url =
          j?.url !== null && j?.url !== undefined && /^https:\/\/\S{1,2000}$/.test(j.url) ? j.url : null;
        // p6-outputs: what a succeeded job produced is browsable on the Outputs screen.
        const outputs = `/outputs?job=${encodeURIComponent(id)}`;
        const more =
          outcome === 'succeeded'
            ? { tr: ` · [Çıktılar](${outputs})`, en: ` · [Outputs](${outputs})` }
            : { tr: '', en: '' };
        const summary = typeof j?.summary === 'string' ? j.summary.trim().slice(0, JOB_SUMMARY_MAX) : '';
        // p18-outputs-delivery: files partly delivered in out-rest.zip are said in the end note and notification.
        const report =
          outcome === 'succeeded' && this.deps.outputReport !== undefined
            ? await this.deps.outputReport(id).catch(() => null)
            : null;
        const zipped = { tr: deliveredLine(report, 'tr'), en: deliveredLine(report, 'en') };
        const zipNote = (lang: WatchLanguage): string => {
          const line = zipped[lang];
          return line === null ? '' : `\n\n${mdText(line)}`;
        };
        const end = (o: Occurrence): Occurrence => ({
          ...o,
          job: { id, outcome, summary: summary === '' ? null : summary },
        });
        out.push(
          end(
            finished(
              outcome,
              { tr: 'İş', en: 'Job' },
              url === null
                ? { tr: `${more.tr}${zipNote('tr')}`, en: `${more.en}${zipNote('en')}` }
                : {
                    tr: `${more.tr} · Canlı adres: [${url}](${url})${zipNote('tr')}`,
                    en: `${more.en} · Live: [${url}](${url})${zipNote('en')}`,
                  },
              {
                tr: `${url === null ? '' : ` Canlı adres: ${url}`}${zipped.tr === null ? '' : ` ${zipped.tr}`}`,
                en: `${url === null ? '' : ` Live: ${url}`}${zipped.en === null ? '' : ` ${zipped.en}`}`,
              },
            ),
          ),
        );
        // p22-run-attention: succeeded, but the agent said it could not (fully) do the task.
        const attention = outcome === 'succeeded' ? parseStepOutcome(j?.summary ?? '') : null;
        if (attention !== null) {
          const last = out.at(-1);
          if (last?.note != null) {
            const why = { tr: attentionWords(attention, 'tr'), en: attentionWords(attention, 'en') };
            out[out.length - 1] = {
              ...last,
              job: { id, outcome, summary: summary === '' ? null : summary, attention },
              note: {
                ...last.note,
                severity: 'warning',
                title: { tr: 'İş bitti, dikkat istiyor', en: 'Job finished, needs attention' },
                text: {
                  tr: `**İş bitti ama dikkat istiyor:** ${label}. [Aç](${link}) — ${mdText(why.tr)}${zipNote('tr')}`,
                  en: `**Job finished but needs attention:** ${label}. [Open](${link}) — ${mdText(why.en)}${zipNote('en')}`,
                },
                body: { tr: `${w.label}. ${why.tr}`, en: `${w.label}. ${why.en}` },
              },
            };
          }
          return { occurrences: out, finish: { state: 'done', reason: 'attention' } };
        }
        return { occurrences: out, finish: done };
      }
      case 'workflow_run': {
        const { rows } = await tx.query<{ state: string }>('SELECT state FROM workflow_runs WHERE id = $1', [
          id,
        ]);
        const s = rows[0]?.state;
        if (s !== 'succeeded' && s !== 'failed' && s !== 'cancelled')
          return { occurrences: [], finish: null };
        const end = finished(s, { tr: 'Workflow', en: 'Workflow run' });
        // p17-chat-flow: the result card (state, steps, duration, a bounded summary of the last step's output).
        const result = await workflowRunResult(tx, id).catch(() => null);
        if (result === null) return { occurrences: [end], finish: done };
        if (result.attention.length > 0) {
          // p22-run-attention: succeeded, but a step could not do its work — said as such, and the watch ends with
          // reason `attention` (the follow-up hands the conversation back to the assistant).
          const why = {
            tr: attentionLine(result.attention, 'tr'),
            en: attentionLine(result.attention, 'en'),
          };
          return {
            occurrences: [
              {
                ...end,
                workflow: result,
                note: {
                  link,
                  severity: 'warning',
                  title: {
                    tr: 'Workflow bitti, dikkat istiyor',
                    en: 'Workflow run finished, needs attention',
                  },
                  text: {
                    tr: `**Workflow bitti ama dikkat istiyor:** ${label}. [Aç](${link}) — ${mdText(why.tr)}`,
                    en: `**Workflow run finished but needs attention:** ${label}. [Open](${link}) — ${mdText(why.en)}`,
                  },
                  body: { tr: `${w.label}. ${why.tr}`, en: `${w.label}. ${why.en}` },
                },
              },
            ],
            finish: { state: 'done', reason: 'attention' },
          };
        }
        return { occurrences: [{ ...end, workflow: result }], finish: done };
      }
      case 'automation': {
        const { rows: a } = await tx.query<{ state: string }>('SELECT state FROM automations WHERE id = $1', [
          id,
        ]);
        if (a[0] === undefined || a[0].state === 'deleted') {
          return { occurrences: [], finish: { state: 'done', reason: 'automation_deleted' } };
        }
        const known = await seen('run');
        const { rows } = await tx.query<{ id: string; state: string; job_id: string | null }>(
          `SELECT id::text AS id, state, job_id::text AS job_id FROM automation_runs
            WHERE automation_id = $1 AND state IN ('succeeded', 'failed', 'cancelled', 'error')
              AND COALESCE(finished_at, created_at) >= $2
            ORDER BY COALESCE(finished_at, created_at), id LIMIT 50`,
          [id, w.created_at],
        );
        const out: Occurrence[] = [];
        for (const r of rows) {
          if (known.has(`run:${r.id}`)) continue;
          const outcome: Outcome =
            r.state === 'succeeded' ? 'succeeded' : r.state === 'cancelled' ? 'cancelled' : 'failed';
          const job =
            r.job_id === null
              ? { tr: '', en: '' }
              : {
                  tr: ` · [İş ${r.job_id.slice(0, 8)}](/jobs/${r.job_id})`,
                  en: ` · [Job ${r.job_id.slice(0, 8)}](/jobs/${r.job_id})`,
                };
          out.push({
            ...finished(outcome, { tr: 'Otomasyon çalıştırması', en: 'Automation run' }, job),
            key: `run:${r.id}`,
          });
        }
        return { occurrences: out, finish: null };
      }
      case 'ops_action': {
        const { rows } = await tx.query<{ state: string; decided_at: Date | null; url: string | null }>(
          "SELECT state, decided_at, result->>'url' AS url FROM ops_actions WHERE id = $1",
          [id],
        );
        const o = rows[0];
        if (o === undefined) return { occurrences: [], finish: null };
        const out: Occurrence[] = [];
        let decidedNow = false;
        if (w.conditions.includes('decided') && o.decided_at !== null) {
          const known = await tx.query(
            "SELECT 1 FROM chat_watch_fires WHERE watch_id = $1 AND occurrence = 'decided'",
            [w.id],
          );
          if ((known.rowCount ?? 0) === 0) {
            const approved = o.state !== 'denied';
            decidedNow = true;
            out.push({
              key: 'decided',
              deliver: true,
              note: {
                severity: approved ? 'info' : 'warning',
                title: {
                  tr: approved ? 'Deploy onaylandı' : 'Deploy reddedildi',
                  en: approved ? 'Deploy approved' : 'Deploy denied',
                },
                text: {
                  tr: `**${approved ? 'Onaylandı' : 'Reddedildi'}:** ${label}. [Aç](${link})`,
                  en: `**${approved ? 'Approved' : 'Denied'}:** ${label}. [Open](${link})`,
                },
                body: { tr: `${w.label}.`, en: `${w.label}.` },
                link,
              },
            });
          }
        }
        const terminal = ['succeeded', 'failed', 'refused', 'denied', 'expired'];
        if (!terminal.includes(o.state)) return { occurrences: out, finish: null };
        const outcome: Outcome = o.state === 'succeeded' ? 'succeeded' : 'failed';
        const url = o.url !== null && /^https:\/\/\S{1,2000}$/.test(o.url) ? o.url : null;
        const end = finished(
          outcome,
          { tr: 'Deploy', en: 'Deploy' },
          url === null
            ? undefined
            : { tr: ` · Canlı adres: [${url}](${url})`, en: ` · Live: [${url}](${url})` },
          url === null ? undefined : { tr: ` Canlı adres: ${url}`, en: ` Live: ${url}` },
        );
        // A denial already told as "denied" is not told again as "failed".
        out.push(decidedNow && o.state === 'denied' ? { ...end, deliver: false } : end);
        return { occurrences: out, finish: done };
      }
      case 'approval': {
        const { rows } = await tx.query<{ status: string }>(
          'SELECT status FROM approval_requests WHERE id = $1',
          [id],
        );
        const s = rows[0]?.status;
        if (s === undefined || s === 'pending') return { occurrences: [], finish: null };
        const word: Record<WatchLanguage, Record<string, string>> = {
          tr: {
            approved: 'onaylandı',
            denied: 'reddedildi',
            expired: 'süresi doldu',
            cancelled: 'iptal edildi',
          },
          en: { approved: 'approved', denied: 'denied', expired: 'expired', cancelled: 'cancelled' },
        };
        return {
          occurrences: [
            {
              key: 'end',
              deliver: true,
              note: {
                severity: s === 'approved' ? 'info' : 'warning',
                title: { tr: `Onay ${word.tr[s] ?? s}`, en: `Approval ${word.en[s] ?? s}` },
                text: {
                  tr: `**Onay ${word.tr[s] ?? s}:** ${label}. [Aç](${link})`,
                  en: `**Approval ${word.en[s] ?? s}:** ${label}. [Open](${link})`,
                },
                body: { tr: `${w.label}.`, en: `${w.label}.` },
                link,
              },
            },
          ],
          finish: done,
        };
      }
      case 'worker': {
        const { rows } = await tx.query<{ state: string; display_name: string }>(
          'SELECT state, display_name FROM workers WHERE id = $1',
          [id],
        );
        const k = rows[0];
        if (k === undefined || k.state === 'quarantined' || k.state === 'pending') {
          return { occurrences: [], finish: { state: 'done', reason: 'worker_removed' } };
        }
        const up = UP_STATES.has(k.state);
        const before = w.cursor.up !== false;
        if (up === before) return { occurrences: [], finish: null };
        const flips = (typeof w.cursor.flips === 'number' ? w.cursor.flips : 0) + 1;
        const cond: WatchCondition = up ? 'online' : 'offline';
        return {
          occurrences: [
            {
              key: `flip:${String(flips)}`,
              deliver: w.conditions.includes(cond),
              note: {
                severity: up ? 'info' : 'warning',
                title: {
                  tr: `Makine ${up ? 'çevrimiçi' : 'çevrimdışı'}: ${k.display_name}`,
                  en: `Machine ${up ? 'online' : 'offline'}: ${k.display_name}`,
                },
                text: {
                  tr: `**Makine ${up ? 'çevrimiçi' : 'çevrimdışı'}:** ${label}. [Makineyi aç](${link})`,
                  en: `**Machine ${up ? 'online' : 'offline'}:** ${label}. [Open the machine](${link})`,
                },
                body: { tr: `${w.label} (${k.state}).`, en: `${w.label} (${k.state}).` },
                link,
              },
            },
          ],
          finish: null,
          cursor: { up, flips },
        };
      }
      case 'monitor': {
        const { rows } = await tx.query<{
          name: string;
          status: string;
          paused: boolean;
          flapping: boolean;
          last_error: string | null;
        }>('SELECT name, status, paused, flapping, last_error FROM uptime_monitors WHERE id = $1', [id]);
        const m = rows[0];
        if (m === undefined) return { occurrences: [], finish: { state: 'done', reason: 'monitor_removed' } };
        const up = !(m.status === 'down' && !m.paused);
        const before = w.cursor.up !== false;
        if (up === before) return { occurrences: [], finish: null };
        const flips = (typeof w.cursor.flips === 'number' ? w.cursor.flips : 0) + 1;
        const cond: WatchCondition = up ? 'up' : 'down';
        const cause = !up && m.last_error !== null ? ` (${m.last_error.replace(/_/g, ' ')})` : '';
        return {
          occurrences: [
            {
              key: `flip:${String(flips)}`,
              // A flapping monitor's changes are recorded, not told (src/uptime/state.ts).
              deliver: w.conditions.includes(cond) && !m.flapping,
              note: {
                severity: up ? 'info' : 'warning',
                title: {
                  tr: `${up ? 'Tekrar ayakta' : 'Erişilemiyor'}: ${m.name}`,
                  en: `${up ? 'Up again' : 'Down'}: ${m.name}`,
                },
                text: {
                  tr: `**${up ? 'Tekrar ayakta' : 'Erişilemiyor'}:** ${label}${cause}. [Monitörü aç](${link})`,
                  en: `**${up ? 'Up again' : 'Down'}:** ${label}${cause}. [Open the monitor](${link})`,
                },
                body: { tr: `${w.label}${cause}.`, en: `${w.label}${cause}.` },
                link,
              },
            },
          ],
          finish: null,
          cursor: { up, flips },
        };
      }
      case 'draft':
      case 'check':
        return { occurrences: [], finish: null };
    }
  }

  /** Thread note + notification for the watch's owner (the only recipient there is), in one transaction. */
  async #deliver(tx: Queryable, w: WatchRow, o: Occurrence): Promise<MessageView | null> {
    const note = o.note;
    if (note === null) return null;
    const lang = w.language;
    const svc = this.deps.notifications();
    if (svc !== null) {
      await svc.notify(tx, [w.user_id], {
        kind: 'chat.watch',
        severity: note.severity,
        title: note.title[lang],
        body: note.body[lang],
        link: note.link,
        dedupeKey: `chat.watch:${w.id}:${o.key}`,
      });
    }
    await this.deps.audit.record(
      {
        actor: { type: 'system', id: 'chat-watches' },
        action: 'chat.watch.fire',
        target: `chat-watch:${w.id}`,
        outcome: 'success',
        metadata: {
          userId: w.user_id,
          targetKind: w.target_kind,
          targetId: targetId(w),
          occurrence: o.key,
          threadId: w.thread_id,
        },
      },
      tx,
    );
    if (w.thread_id === null) return null;
    const { text, links } = splitLinks(note.text[lang]);
    return this.deps.store.addMessage(
      w.thread_id,
      {
        role: 'assistant',
        content: text,
        meta: {
          notice: 'chat-watch',
          watchId: w.id,
          event: o.key,
          link: note.link,
          links,
          ...(o.job === undefined
            ? {}
            : {
                jobId: o.job.id,
                jobOutcome: o.job.outcome,
                jobSummary: o.job.summary,
                ...(o.job.attention === undefined ? {} : { jobAttention: o.job.attention }),
              }),
          ...(o.workflow === undefined ? {} : { workflowResult: resultMeta(o.workflow) }),
        },
      },
      tx,
    );
  }

  #publish(threadId: string, message: MessageView | null): void {
    try {
      this.deps.publish?.(threadId, message);
    } catch (err) {
      this.deps.log.debug({ err, threadId }, 'chat watch: stream publish failed');
    }
  }
}

/** p19-watch-follow-up: an instant as wall-clock time in the user's zone (their report settings', else UTC). */
async function wallClock(db: Queryable, userId: string, iso: string): Promise<string> {
  const zone = await defaultTimeZone(db, userId).catch(() => 'UTC');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${zone === 'UTC' ? ' UTC' : ''}`;
}
