import { randomUUID } from 'node:crypto';
import { messagesFor } from '@remyral/i18n/all';
import {
  type FunctionEgress,
  type FunctionResult,
  type FunctionSpec,
  WATCH_CHECK_LIMITS,
  WATCH_CHECKS_FEATURE,
  type WatchCheckCondition,
  type WatchCheckKind,
  type WatchCheckView,
  type WatchThen,
} from '@remyral/protocol';
import { checkSource } from '@remyral/workflow-expr';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Role } from '../auth/users.js';
import { loadSubject } from '../authz/authorizer.js';
import { type Action, authorize, type Subject } from '../authz/model.js';
import { type Pool, type PoolClient, type Queryable, withTransaction } from '../db/pool.js';
import type { NotificationService } from '../notifications/service.js';
import { functionFailure, readFunctionResult } from '../workflows/v2/functions.js';
import type { ChatStore, MessageView } from './store.js';
import type { ThenOutcome } from './watch-then.js';
import {
  checkJobSpec,
  conditionRef,
  conditionText,
  globToLike,
  hasHttpPhase,
  httpCheckSpec,
  isPolled,
  type JsonataEval,
  judgeHttp,
  nextDelaySec,
  oneLine,
  probeCheckSpec,
  safeUrl,
  subjectOf,
  valueText,
  WatchCheckRefusal,
  type WatchLang,
  type WatchTexts,
} from './watch-check-model.js';

/**
 * p15-watches — Takipler (docs/design/p15-watches.md): the engine of `check` watches. A check watch is a `chat_watches`
 * row of kind `check` with a typed condition. Event conditions are evaluated when the database triggers of migration
 * 0119 notify `remana_watch` with the watch's subject (a dedicated LISTEN connection; one reconcile pass at boot, after
 * every reconnect and — only while the listener is down — every 30 s). `http` / `worker_probe` (and the HTTP phase of
 * `preview_up` / `service_url`) run as `function` jobs on workers on a backoff schedule; a check job's end wakes its
 * watch through the jobs trigger. The master never connects to a checked host and never starts an assistant turn:
 * notes are rendered from the i18n templates.
 */

export const WATCH_CHANNEL = 'remana_watch';

/** p15-services hand-off: a managed service's current URL (null: unknown or not visible to the subject). */
export interface ServiceUrlSource {
  resolve(
    subject: Subject,
    serviceId: string,
  ): Promise<{
    project: string;
    label: string;
    url: string | null;
    up: boolean;
    /** p19-watch-follow-up: the service is down for good (gave up, refused, expired or stopped). */
    ended?: { state: string; detail: string | null; exitCode?: number | null } | undefined;
  } | null>;
}

/** Creates / cancels the function jobs of remote checks (JobStore + orchestrator in production). */
export interface CheckJobs {
  create(input: {
    readonly project: string;
    readonly spec: Record<string, unknown>;
    readonly userId: string;
    /** Runs in the job's creation transaction (links the job to the watch; throws to abort). */
    readonly withinCreate: (tx: Queryable, jobId: string) => Promise<void>;
  }): Promise<string>;
  cancel(jobId: string, reason: string): Promise<void>;
}

/**
 * Prepares the `then` card in the conversation (the assistant's draft tools, called by the master) and, for
 * `mode: auto`, runs it through the chat's direct path when the security policy allows it (p15-watch-autorun,
 * `WatchThenRunner`).
 */
export type ThenRunner = (
  caller: {
    readonly userId: string;
    readonly subject: Subject;
    readonly threadId: string;
    readonly turnId: string;
    readonly watchId: string;
  },
  then: WatchThen,
) => Promise<ThenOutcome>;

export interface WatchChecksDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly store: ChatStore;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly notifications: () => NotificationService | null;
  readonly publish?: ((threadId: string, message: MessageView | null) => void) | undefined;
  readonly jobs?: (() => CheckJobs | null) | undefined;
  readonly egress?: (() => { effective(project: string): Promise<FunctionEgress> } | null) | undefined;
  readonly jsonata?: JsonataEval | undefined;
  readonly services?: (() => ServiceUrlSource | null) | undefined;
  readonly then?: (() => ThenRunner | null) | undefined;
  /** Waits of the dry test (tests inject a fake). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly dryWaitMs?: number | undefined;
  /** A check job no machine took within this is cancelled (default 600 s). */
  readonly queueTimeoutSec?: number | undefined;
  /** Reconcile interval while the listener is down (default 30 s). */
  readonly reconcileMs?: number | undefined;
}

export class WatchCheckError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export interface CheckRow {
  id: string;
  user_id: string;
  thread_id: string | null;
  turn_id: string | null;
  project: string | null;
  label: string;
  language: WatchLang;
  state: string;
  spec: WatchCheckCondition;
  then_action: WatchThen | null;
  subject: string | null;
  every_sec: number | null;
  next_check_at: Date | null;
  pending_job_id: string | null;
  check_count: number;
  unmet_streak: number;
  last_check: WatchCheckView | null;
  result: unknown;
  cursor: Record<string, unknown>;
  created_at: Date;
  expires_at: Date;
}

const CHECK_COLS = `id::text AS id, user_id::text AS user_id, thread_id::text AS thread_id, turn_id::text AS turn_id,
  project, label, language, state, spec, then_action, subject, every_sec, next_check_at,
  pending_job_id::text AS pending_job_id, check_count, unmet_streak, last_check, result, cursor, created_at, expires_at`;

const UP_STATES = new Set(['online', 'busy', 'draining', 'updating']);
const TERMINAL_JOB = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const WAITING_JOB = new Set(['DRAFT', 'QUEUED', 'BLOCKED', 'RESERVED', 'RETRY_WAIT']);
const WORKER_ID = /^wrk_[a-z2-7]{26}$/;
const RETRY_LOCKED = 20;

/** What one evaluation found. */
interface Outcome {
  readonly met: boolean;
  readonly say: (t: WatchTexts) => string;
  readonly value?: unknown;
  readonly url?: string | null;
  readonly error?: string | null;
  readonly workerId?: string | null;
  readonly jobId?: string | null;
  /** The watch can never be met: end it (`never`: the target ended without it; `refused`: the check is refused). */
  readonly end?: 'never' | 'refused' | 'gone';
  /** Event conditions met in SQL that still need a worker's HTTP check of this URL. */
  readonly httpPhase?: { readonly url: string; readonly project: string };
  readonly cursor?: Record<string, unknown>;
}

/** The plan of a remote check, executed after the evaluation transaction committed. */
interface RemotePlan {
  readonly project: string;
  readonly fn: FunctionSpec;
  readonly workerId: string | null;
}

export type EvalMode = WatchCheckView['mode'];
export type EvalResult = 'skipped' | 'locked' | 'pending' | 'unmet' | 'fired' | 'ended' | 'started';

export interface ResolvedCheck {
  readonly spec: WatchCheckCondition;
  readonly project: string | null;
  readonly machineName: string | null;
}

/** Plain text that renders literally in the chat's Markdown (labels come from people and agents). */
function md(s: string): string {
  return oneLine(s, 1000).replace(/[\\`*_[\]()<>#!|~]/g, (c) => `\\${c}`);
}

/** The read permission a condition needs (re-checked at every evaluation), and whether it starts check jobs. */
function needs(spec: WatchCheckCondition): { action: Action | null; remote: boolean } {
  switch (spec.kind) {
    case 'job_state':
    case 'job_event':
    case 'job_output':
      return { action: 'jobs.read', remote: false };
    case 'preview_up':
      return { action: 'previews.read', remote: spec.http === true };
    case 'http':
    case 'worker_probe':
      return { action: 'jobs.create', remote: true };
    case 'machine':
      return { action: 'workers.read', remote: false };
    case 'workflow_run':
      return { action: 'workflows.read', remote: false };
    case 'service_url':
      // The source authorizes; the HTTP phase starts check jobs in the service's project.
      return { action: null, remote: spec.http === true };
  }
}

/** The console page of what a watch follows. */
export function checkLink(spec: WatchCheckCondition, threadId: string | null): string {
  const e = encodeURIComponent;
  switch (spec.kind) {
    case 'job_state':
    case 'job_event':
      return `/jobs/${e(spec.jobId)}`;
    case 'job_output':
      return `/outputs?job=${e(spec.jobId)}`;
    case 'preview_up':
      return spec.jobId !== undefined ? `/jobs/${e(spec.jobId)}` : '/outputs';
    case 'machine':
    case 'worker_probe':
      return `/machines/${e(spec.workerId)}`;
    case 'workflow_run':
      return `/jobs/workflows/${e(spec.runId)}`;
    case 'http':
    case 'service_url':
      return threadId === null ? '/chat' : `/chat/${e(threadId)}`;
  }
}

export class WatchChecks {
  readonly #listener: WatchListener;
  #reconcileDue = true;
  #lastReconcile = 0;

  constructor(private readonly deps: WatchChecksDeps) {
    this.#listener = new WatchListener({
      pool: deps.pool,
      log: deps.log,
      onConnected: () => {
        this.#reconcileDue = true;
      },
      onPayload: (p) => this.#onPayload(p),
    });
  }

  #now(): Date {
    return this.deps.clock();
  }

  get listening(): boolean {
    return this.#listener.listening;
  }

  /** Starts the LISTEN connection (idempotent; failures are logged and retried). */
  listen(): Promise<void> {
    return this.#listener.start();
  }

  async stop(): Promise<void> {
    await this.#listener.stop();
  }

  /** In-process wake-up of a subject (e.g. `service:<id>` from the services module). */
  wakeSubject(subject: string): void {
    this.#listener.enqueue(subject);
  }

  /** Resolves when the queued wake-ups were evaluated (tests). */
  idle(): Promise<void> {
    return this.#listener.idle();
  }

  // ------------------------------------------------------------------------------------------------- resolve

  /**
   * Validates a condition for `subject` and resolves names: machine names to ids, the project of the followed
   * resource. Throws {@link WatchCheckError} (invisible and forbidden look the same: not_found).
   */
  async resolve(subject: Subject, raw: WatchCheckCondition): Promise<ResolvedCheck> {
    const db = this.deps.pool;
    const nf = (what: string): never => {
      throw new WatchCheckError('not_found', `${what} not found.`);
    };
    const may = (action: Action, project: string | undefined): boolean =>
      authorize(subject, action, project === undefined ? undefined : { project }).allow;
    let spec = raw;
    let project: string | null = null;
    let machineName: string | null = null;
    const jobProject = async (jobId: string): Promise<string> => {
      const { rows } = await db.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [jobId]);
      const p = rows[0]?.project;
      if (p === undefined || !may('jobs.read', p)) return nf('Job');
      return p;
    };
    const worker = async (ref: string): Promise<{ id: string; name: string; features: string[] }> => {
      const { rows } = await db.query<{ id: string; display_name: string; features: unknown }>(
        `SELECT id, display_name, features FROM workers
          WHERE (id = $1 OR lower(display_name) = lower($1)) AND state NOT IN ('pending', 'quarantined')
          ORDER BY (id = $1) DESC LIMIT 2`,
        [ref],
      );
      const w = rows[0];
      if (w === undefined || !WORKER_ID.test(w.id)) return nf('Machine');
      if (rows.length > 1 && w.id !== ref)
        throw new WatchCheckError('invalid', 'Several machines have that name; use the machine id.');
      return {
        id: w.id,
        name: w.display_name,
        features: Array.isArray(w.features)
          ? w.features.filter((f): f is string => typeof f === 'string')
          : [],
      };
    };
    const requireCreate = (p: string): void => {
      if (!may('jobs.create', p))
        throw new WatchCheckError(
          'forbidden',
          `Checks from a machine run as small jobs in project ${p}: that needs the operator role there.`,
        );
    };
    switch (raw.kind) {
      case 'job_state':
      case 'job_event':
      case 'job_output':
        project = await jobProject(raw.jobId);
        break;
      case 'preview_up': {
        if (raw.jobId !== undefined) project = await jobProject(raw.jobId);
        else if (raw.tunnelId !== undefined) {
          const { rows } = await db.query<{ project: string }>(
            'SELECT project FROM preview_tunnels WHERE id = $1',
            [raw.tunnelId],
          );
          project = rows[0]?.project ?? nf('Preview link');
        } else {
          const { rows } = await db.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [
            raw.project,
          ]);
          if (rows[0] === undefined) nf('Project');
          project = String(raw.project);
        }
        if (!may('previews.read', project)) nf('Preview link');
        if (raw.http === true) requireCreate(project);
        break;
      }
      case 'http': {
        const { rows } = await db.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [
          raw.project,
        ]);
        if (rows[0] === undefined || !may('jobs.read', raw.project)) nf('Project');
        requireCreate(raw.project);
        project = raw.project;
        // Refused targets are refused now, not at the first check.
        await this.#httpSpec(raw.project, raw.url, raw.method ?? 'GET', 'watch-validate').catch(
          (err: unknown) => {
            if (err instanceof WatchCheckRefusal) throw new WatchCheckError('invalid', err.message);
            throw err;
          },
        );
        if (raw.workerId !== undefined) {
          const w = await worker(raw.workerId);
          spec = { ...raw, workerId: w.id };
          machineName = w.name;
        }
        break;
      }
      case 'worker_probe': {
        const { rows } = await db.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [
          raw.project,
        ]);
        if (rows[0] === undefined || !may('jobs.read', raw.project)) nf('Project');
        requireCreate(raw.project);
        project = raw.project;
        const w = await worker(raw.workerId);
        if (!w.features.includes(WATCH_CHECKS_FEATURE))
          throw new WatchCheckError(
            'invalid',
            `Machine ${w.name} cannot run port checks yet (it needs a worker release with ${WATCH_CHECKS_FEATURE}); update the machine, or check a public URL with kind http.`,
          );
        spec = { ...raw, workerId: w.id };
        machineName = w.name;
        break;
      }
      case 'machine': {
        if (!may('workers.read', undefined)) nf('Machine');
        const w = await worker(raw.workerId);
        spec = { ...raw, workerId: w.id };
        machineName = w.name;
        break;
      }
      case 'workflow_run': {
        const { rows } = await db.query<{ project: string }>(
          'SELECT project FROM workflow_runs WHERE id = $1',
          [raw.runId],
        );
        const p = rows[0]?.project;
        if (p === undefined || !may('workflows.read', p)) nf('Workflow run');
        project = p ?? null;
        break;
      }
      case 'service_url': {
        const src = this.deps.services?.() ?? null;
        if (src === null)
          throw new WatchCheckError(
            'unavailable',
            'Managed services are not available yet; watch the preview link with preview_up instead.',
          );
        const s = await src.resolve(subject, raw.serviceId);
        if (s === null) nf('Service');
        project = s?.project ?? null;
        if (raw.http === true && project !== null) requireCreate(project);
        break;
      }
    }
    for (const src of jsonataOf(spec)) {
      const bad = checkSource(src, 'expr');
      if (bad !== null)
        throw new WatchCheckError(
          'invalid',
          `The JSONata expression does not compile (${bad.code}); fix it.`,
        );
    }
    return { spec, project, machineName };
  }

  /** The watch's label when the assistant names none, and the condition sentence. */
  describe(r: ResolvedCheck, lang: WatchLang): string {
    return conditionText(messagesFor(lang).watches, r.spec, {
      ...(r.machineName === null ? {} : { machine: r.machineName }),
    });
  }

  /** The digest that makes the same condition in the same conversation the same watch. */
  ref(spec: WatchCheckCondition): string {
    return conditionRef(spec);
  }

  subjectOf(spec: WatchCheckCondition): string | null {
    return subjectOf(spec);
  }

  /** Whether the condition is polled from the start. */
  polled(spec: WatchCheckCondition): boolean {
    return isPolled(spec);
  }

  // ------------------------------------------------------------------------------------------------- dry test

  /**
   * The dry test right after creation: one evaluation now; a remote check is waited for up to `dryWaitMs`. Returns
   * the watch row afterwards (its `last_check`, and whether it already fired or ended).
   */
  async dryTest(watchId: string): Promise<{ row: CheckRow | null; pending: boolean }> {
    await this.evaluate(watchId, 'dry');
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const until = Date.now() + (this.deps.dryWaitMs ?? WATCH_CHECK_LIMITS.dryWaitMs);
    let row = await this.#row(watchId);
    while (row !== null && row.state === 'active' && row.pending_job_id !== null && Date.now() < until) {
      const { rows } = await this.deps.pool.query<{ state: string }>(
        'SELECT state::text AS state FROM jobs WHERE id = $1',
        [row.pending_job_id],
      );
      const s = rows[0]?.state;
      if (s === undefined || TERMINAL_JOB.has(s)) {
        await this.evaluate(watchId, 'dry');
        row = await this.#row(watchId);
        break;
      }
      await sleep(400);
      row = await this.#row(watchId);
    }
    return { row, pending: row?.state === 'active' && row.pending_job_id !== null };
  }

  async #row(id: string, db: Queryable = this.deps.pool): Promise<CheckRow | null> {
    const { rows } = await db.query<CheckRow>(
      `SELECT ${CHECK_COLS} FROM chat_watches WHERE id = $1 AND target_kind = 'check'`,
      [id],
    );
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------------------------------------------- evaluate

  /**
   * Evaluates one check watch: locks it (SKIP LOCKED), re-authorizes its owner, consumes a finished check job or
   * evaluates the condition in SQL, records the check, and fires / schedules / ends it — all in one transaction. A
   * remote check it decided to start is created after the commit (linked to the watch inside the job's creation).
   */
  async evaluate(watchId: string, mode: EvalMode): Promise<EvalResult> {
    const posted: { threadId: string; message: MessageView }[] = [];
    // Work done after the commit (set inside the transaction).
    const after: { remote: RemotePlan | null; cancelJob: string | null; then: CheckRow | null } = {
      remote: null,
      cancelJob: null,
      then: null,
    };
    const result = await withTransaction(this.deps.pool, async (tx): Promise<EvalResult> => {
      const { rows } = await tx.query<CheckRow>(
        `SELECT ${CHECK_COLS} FROM chat_watches WHERE id = $1 AND state = 'active' AND target_kind = 'check'
          FOR UPDATE SKIP LOCKED`,
        [watchId],
      );
      const w = rows[0];
      if (w === undefined) {
        const { rows: s } = await tx.query<{ state: string }>(
          `SELECT state FROM chat_watches WHERE id = $1 AND target_kind = 'check'`,
          [watchId],
        );
        return s[0]?.state === 'active' ? 'locked' : 'skipped';
      }
      const now = this.#now();
      const t = messagesFor(w.language).watches;
      const subject = await this.#activeSubject(tx, w.user_id);
      if (subject === null) {
        await this.#end(tx, w, now, 'revoked', 'user_disabled', null, posted);
        after.cancelJob = w.pending_job_id;
        return 'ended';
      }
      if (!this.#allowed(subject, w)) {
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'chat-watches' },
            action: 'chat.watch.revoke',
            target: `chat-watch:${w.id}`,
            outcome: 'denied',
            metadata: { reason: 'access_lost', targetKind: 'check', checkKind: w.spec.kind },
          },
          tx,
        );
        await this.#end(tx, w, now, 'revoked', 'access_lost', t.delivery.accessLost, posted);
        after.cancelJob = w.pending_job_id;
        return 'ended';
      }

      let outcome: Outcome;
      if (w.pending_job_id !== null) {
        const job = await this.#job(tx, w.pending_job_id);
        if (job !== null && !TERMINAL_JOB.has(job.state)) {
          const queueSec = this.deps.queueTimeoutSec ?? 600;
          const stuck =
            WAITING_JOB.has(job.state) &&
            now.getTime() - job.created_at.getTime() >= queueSec * 1000 &&
            !job.acked;
          if (!stuck) return 'pending';
          after.cancelJob = w.pending_job_id;
          outcome = {
            met: false,
            say: (x) => x.summary.noWorker,
            error: 'no_worker',
            jobId: w.pending_job_id,
          };
        } else {
          outcome =
            job === null
              ? {
                  met: false,
                  say: (x) => x.summary.checkFailed({ code: 'job_missing' }),
                  error: 'job_missing',
                }
              : await this.#remoteOutcome(tx, w, w.pending_job_id, job.state);
        }
        await tx.query('UPDATE chat_watches SET pending_job_id = NULL WHERE id = $1', [w.id]);
      } else if (isPolled(w.spec)) {
        const due = mode === 'dry' || w.next_check_at === null || w.next_check_at.getTime() <= now.getTime();
        if (!due) return 'unmet';
        after.remote = await this.#plan(tx, w, now, posted);
        return after.remote === null ? 'unmet' : 'started';
      } else {
        outcome = await this.#local(tx, w, subject);
      }

      // An event condition that is met in SQL but needs a worker's HTTP check of its URL first.
      if (outcome.met && outcome.httpPhase !== undefined) {
        const plan = await this.#httpPhasePlan(tx, w, outcome.httpPhase, now, mode);
        if (plan === 'refused') {
          outcome = {
            ...outcome,
            met: false,
            say: (x) => x.summary.refused({ code: 'egress_refused' }),
            end: 'refused',
            error: 'egress_refused',
          };
        } else {
          after.remote = plan;
          // Remember what SQL saw; the delivery waits for the worker's answer.
          await this.#record(tx, w, { ...outcome, met: false }, mode, now);
          return plan === null ? 'unmet' : 'started';
        }
      }
      await this.#record(tx, w, outcome, mode, now);
      if (outcome.end !== undefined) {
        const reason = oneLine(outcome.say(t), 300);
        const text =
          outcome.end === 'gone'
            ? t.delivery.goneText({ label: md(w.label) })
            : t.delivery.refusedText({ label: md(w.label), reason: md(reason) });
        await this.#end(
          tx,
          w,
          now,
          'done',
          outcome.end === 'refused' ? `check_refused:${outcome.error ?? 'refused'}` : `never:${outcome.end}`,
          text,
          posted,
          { title: t.delivery.refusedTitle({ label: w.label }), body: `${w.label}: ${reason}` },
        );
        return 'ended';
      }
      if (outcome.met) {
        const fired = await this.#fire(tx, w, outcome, now, posted);
        if (fired && w.then_action !== null) after.then = w;
        return fired ? 'fired' : 'skipped';
      }
      if (w.check_count + 1 >= WATCH_CHECK_LIMITS.maxChecks) {
        const last = oneLine(outcome.say(t), 300);
        await this.#end(
          tx,
          w,
          now,
          'done',
          'check_limit',
          t.delivery.limitText({ label: md(w.label), last: md(last) }),
          posted,
          {
            title: t.delivery.timeoutTitle({ label: w.label }),
            body: `${w.label}: ${last}`,
          },
        );
        return 'ended';
      }
      // Remote checks (and the HTTP phase) poll again with backoff; event conditions wait for the next event.
      const polledNow = isPolled(w.spec) || (hasHttpPhase(w.spec) && outcome.jobId !== undefined);
      if (polledNow) {
        const delay = nextDelaySec(w.every_sec ?? WATCH_CHECK_LIMITS.defaultEverySec, w.unmet_streak);
        await tx.query(
          `UPDATE chat_watches SET unmet_streak = unmet_streak + 1, next_check_at = $2, updated_at = $3 WHERE id = $1`,
          [w.id, new Date(now.getTime() + delay * 1000), now],
        );
      }
      return 'unmet';
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    if (after.cancelJob !== null)
      await this.#cancelJob(after.cancelJob, 'the watch no longer needs this check');
    if (after.remote !== null) await this.#startRemote(watchId, after.remote);
    if (after.then !== null) await this.#then(after.then);
    return result;
  }

  #allowed(subject: Subject, w: CheckRow): boolean {
    const n = needs(w.spec);
    const p = w.project === null ? undefined : { project: w.project };
    if (n.action !== null && !authorize(subject, n.action, n.action === 'workers.read' ? undefined : p).allow)
      return false;
    if (n.remote && w.project !== null && !authorize(subject, 'jobs.create', p).allow) return false;
    return true;
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

  async #job(db: Queryable, id: string): Promise<{ state: string; created_at: Date; acked: boolean } | null> {
    const { rows } = await db.query<{ state: string; created_at: Date; acked: boolean }>(
      `SELECT j.state::text AS state, j.created_at,
              EXISTS (SELECT 1 FROM job_transitions t WHERE t.job_id = j.id AND t.trigger = 'lease_acked') AS acked
         FROM jobs j WHERE j.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------------------------- local (SQL)

  /** Evaluates an event condition against the database (no worker, no network, no AI). */
  async #local(tx: Queryable, w: CheckRow, subject: Subject): Promise<Outcome> {
    const s = w.spec;
    switch (s.kind) {
      case 'job_state': {
        const { rows } = await tx.query<{
          state: string;
          approval: boolean;
          question: boolean;
          merged: boolean;
        }>(
          `SELECT j.state::text AS state,
                  EXISTS (SELECT 1 FROM approval_requests a WHERE a.job_id = j.id AND a.status = 'pending') AS approval,
                  EXISTS (SELECT 1 FROM user_questions q WHERE q.job_id = j.id AND q.state = 'pending') AS question,
                  EXISTS (SELECT 1 FROM job_git g WHERE g.job_id = j.id AND g.merged_sha IS NOT NULL) AS merged
             FROM jobs j WHERE j.id = $1`,
          [s.jobId],
        );
        const j = rows[0];
        if (j === undefined) return { met: false, say: (t) => t.summary.gone, end: 'gone' };
        const st = j.state;
        const failed = st === 'FAILED' || st === 'LOST';
        const needsYou = st === 'AWAITING_APPROVAL' || st === 'PAUSED' || j.approval || j.question;
        const hit =
          (s.states.includes('finished') && (TERMINAL_JOB.has(st) || st === 'LOST')) ||
          (s.states.includes('succeeded') && st === 'SUCCEEDED') ||
          (s.states.includes('failed') && failed) ||
          (s.states.includes('cancelled') && st === 'CANCELLED') ||
          (s.states.includes('running') && st === 'RUNNING') ||
          (s.states.includes('needs_you') && needsYou) ||
          // p19-watch-deploy: the merge moves the job (SUCCEEDED) in the same transaction, so the change notifies.
          (s.states.includes('merged') && j.merged);
        const say = (t: WatchTexts): string =>
          needsYou && s.states.includes('needs_you')
            ? t.summary.jobNeedsYou
            : j.merged && s.states.includes('merged')
              ? t.summary.jobMerged
              : t.summary.jobState({ state: st });
        if (hit) return { met: true, say, value: { state: st } };
        if (TERMINAL_JOB.has(st)) return { met: false, say, end: 'never' };
        return { met: false, say };
      }
      case 'job_event': {
        const from = typeof w.cursor.lastEventId === 'number' ? w.cursor.lastEventId : 0;
        const { rows: top } = await tx.query<{ max: string | null; state: string }>(
          `SELECT (SELECT max(id) FROM job_events WHERE job_id = $1)::text AS max, state::text AS state
             FROM jobs WHERE id = $1`,
          [s.jobId],
        );
        if (top[0] === undefined) return { met: false, say: (t) => t.summary.gone, end: 'gone' };
        const upTo = top[0].max === null ? 0 : Number(top[0].max);
        const { rows } = await tx.query<{ id: string; kind: string; line: string }>(
          `SELECT id::text AS id, kind,
                  concat_ws(' ', payload->>'text', payload->>'inputSummary', payload->>'outputSummary',
                            payload->>'message', payload->>'description', payload->>'phase', payload->>'toolName',
                            payload->>'code', payload->>'name') AS line
             FROM job_events
            WHERE job_id = $1 AND id > $2 AND id <= $3 AND ($4::text[] IS NULL OR kind = ANY ($4::text[]))
              AND strpos(lower(concat_ws(' ', payload->>'text', payload->>'inputSummary', payload->>'outputSummary',
                            payload->>'message', payload->>'description', payload->>'phase', payload->>'toolName',
                            payload->>'code', payload->>'name')), lower($5)) > 0
            ORDER BY id LIMIT 1`,
          [s.jobId, from, upTo, s.eventKinds ?? null, s.contains],
        );
        const hit = rows[0];
        if (hit !== undefined) {
          const line = excerpt(hit.line, s.contains);
          return {
            met: true,
            say: (t) => t.summary.eventFound({ line }),
            value: { line, kind: hit.kind },
            cursor: { ...w.cursor, lastEventId: Number(hit.id) },
          };
        }
        const say = (t: WatchTexts): string => t.summary.eventNone({ text: oneLine(s.contains, 80) });
        const cursor = { ...w.cursor, lastEventId: upTo };
        if (TERMINAL_JOB.has(top[0].state)) return { met: false, say, end: 'never', cursor };
        return { met: false, say, cursor };
      }
      case 'job_output': {
        const { rows } = await tx.query<{ name: string | null; state: string }>(
          `SELECT j.state::text AS state,
                  (SELECT a.name FROM job_artifacts a WHERE a.job_id = j.id AND a.kind = 'output'
                      AND ($2::text IS NULL OR a.name LIKE $2 ESCAPE '\\') ORDER BY a.created_at LIMIT 1) AS name
             FROM jobs j WHERE j.id = $1`,
          [s.jobId, s.name === undefined ? null : globToLike(s.name)],
        );
        const j = rows[0];
        if (j === undefined) return { met: false, say: (t) => t.summary.gone, end: 'gone' };
        if (j.name !== null) {
          const name = oneLine(j.name, 200);
          return { met: true, say: (t) => t.summary.outputFound({ name }), value: { name } };
        }
        const say = (t: WatchTexts): string => t.summary.outputNone;
        return TERMINAL_JOB.has(j.state) ? { met: false, say, end: 'never' } : { met: false, say };
      }
      case 'preview_up': {
        const where =
          s.tunnelId !== undefined
            ? { sql: 'id = $1', params: [s.tunnelId] }
            : s.jobId !== undefined
              ? { sql: 'job_id = $1', params: [s.jobId] }
              : { sql: 'project = $1 AND name = $2', params: [s.project, s.name] };
        const { rows } = await tx.query<{
          hostname: string;
          state: string;
          connector_state: string | null;
          project: string;
        }>(
          `SELECT hostname, state, connector_state, project FROM preview_tunnels
            WHERE ${where.sql} AND state NOT IN ('closed', 'failed')
            ORDER BY (state = 'active' AND connector_state = 'running') DESC, created_at DESC LIMIT 1`,
          where.params,
        );
        const p = rows[0];
        if (p === undefined) {
          const say = (t: WatchTexts): string => t.summary.tunnelNone;
          if (s.jobId !== undefined) {
            const { rows: j } = await tx.query<{ state: string }>(
              'SELECT state::text AS state FROM jobs WHERE id = $1',
              [s.jobId],
            );
            if (j[0] === undefined) return { met: false, say: (t) => t.summary.gone, end: 'gone' };
            if (TERMINAL_JOB.has(j[0].state)) return { met: false, say, end: 'never' };
          }
          return { met: false, say };
        }
        const url = safeUrl(`https://${p.hostname}`);
        if (p.state !== 'active' || p.connector_state !== 'running' || url === null) {
          const state = p.connector_state ?? p.state;
          return { met: false, say: (t) => t.summary.tunnelNotRunning({ state }) };
        }
        const up: Outcome = { met: true, say: (t) => t.summary.tunnelUp({ url }), url, value: { url } };
        return s.http === true ? { ...up, httpPhase: { url, project: p.project } } : up;
      }
      case 'machine': {
        const { rows } = await tx.query<{ state: string; ready: boolean }>(
          `SELECT w.state,
                  EXISTS (SELECT 1 FROM worker_runtimes r WHERE r.worker_id = w.id AND r.runtime = $2 AND r.present
                             AND r.installed AND r.authenticated = 'yes') AS ready
             FROM workers w WHERE w.id = $1`,
          [s.workerId, s.runtime ?? ''],
        );
        const m = rows[0];
        if (m === undefined || m.state === 'quarantined' || m.state === 'pending')
          return { met: false, say: (t) => t.summary.gone, end: 'gone' };
        if (s.state === 'runtime_ready') {
          const runtime = String(s.runtime);
          return m.ready
            ? { met: true, say: (t) => t.summary.runtimeReady({ runtime }), value: { runtime, ready: true } }
            : { met: false, say: (t) => t.summary.runtimeNotReady({ runtime }) };
        }
        const up = UP_STATES.has(m.state);
        const state = m.state;
        return {
          met: s.state === 'online' ? up : !up,
          say: (t) => t.summary.machine({ state }),
          value: { state },
        };
      }
      case 'workflow_run': {
        const { rows } = await tx.query<{ state: string; waiting: boolean; node: string | null }>(
          `SELECT r.state,
                  EXISTS (SELECT 1 FROM workflow_node_runs n WHERE n.run_id = r.id AND n.state = 'waiting') AS waiting,
                  (SELECT n.state FROM workflow_node_runs n WHERE n.run_id = r.id AND n.node_id = $2
                     ORDER BY n.attempt DESC, n.id DESC LIMIT 1) AS node
             FROM workflow_runs r WHERE r.id = $1`,
          [s.runId, s.nodeId ?? ''],
        );
        const r = rows[0];
        if (r === undefined) return { met: false, say: (t) => t.summary.gone, end: 'gone' };
        const runDone = ['succeeded', 'failed', 'cancelled'].includes(r.state);
        if (s.nodeId !== undefined) {
          const node = s.nodeId;
          const st = r.node;
          if (st === null) {
            const say = (t: WatchTexts): string => t.summary.runNodeNone({ node });
            return runDone ? { met: false, say, end: 'never' } : { met: false, say };
          }
          const hit =
            (s.states.includes('finished') && ['succeeded', 'failed', 'cancelled', 'skipped'].includes(st)) ||
            (s.states as readonly string[]).includes(st);
          const say = (t: WatchTexts): string => t.summary.runNode({ node, state: st });
          if (hit) return { met: true, say, value: { node, state: st } };
          return runDone ? { met: false, say, end: 'never' } : { met: false, say };
        }
        const st = r.state;
        const hit =
          (s.states.includes('finished') && runDone) ||
          (s.states as readonly string[]).includes(st) ||
          (s.states.includes('waiting') && r.waiting);
        const say = (t: WatchTexts): string => t.summary.run({ state: st });
        if (hit) return { met: true, say, value: { state: st } };
        return runDone ? { met: false, say, end: 'never' } : { met: false, say };
      }
      case 'service_url': {
        const src = this.deps.services?.() ?? null;
        const svc = src === null ? null : await src.resolve(subject, s.serviceId);
        if (svc === null) return { met: false, say: (t) => t.summary.gone, end: 'gone' };
        const url = safeUrl(svc.url);
        // p19-watch-follow-up: a service that gave up never comes up by itself — the watch ends now (and the
        // conversation's assistant carries on), not after hours of "not up yet".
        const ended = svc.ended;
        if (s.exited === true) {
          // p21-service-exit: a one-shot command — met once it ended, with how it ended.
          if (ended === undefined) return { met: false, say: (t) => t.summary.serviceRunning };
          const code = ended.exitCode ?? null;
          return {
            met: true,
            say: (t) =>
              t.summary.serviceExited({
                state: ended.state,
                code: code === null ? '—' : String(code),
                detail: oneLine(ended.detail ?? '', 200),
              }),
            value: { state: ended.state, exitCode: code },
          };
        }
        if (ended !== undefined)
          return {
            met: false,
            say: (t) =>
              t.summary.serviceEnded({ state: ended.state, detail: oneLine(ended.detail ?? '', 200) }),
            end: 'never',
          };
        if (!svc.up || url === null) return { met: false, say: (t) => t.summary.serviceDown };
        const up: Outcome = { met: true, say: (t) => t.summary.serviceUp({ url }), url, value: { url } };
        return s.http === true ? { ...up, httpPhase: { url, project: svc.project } } : up;
      }
      case 'http':
      case 'worker_probe':
        return { met: false, say: (t) => t.summary.queued };
    }
  }

  // ------------------------------------------------------------------------------------------- remote checks

  async #httpSpec(project: string, url: string, method: 'GET' | 'HEAD', key: string): Promise<FunctionSpec> {
    const egress = (await this.deps.egress?.()?.effective(project)) ?? { mode: 'open' as const, hosts: [] };
    return httpCheckSpec({ url, method, key, egress });
  }

  /** The remote check to start now for a polled condition, or null (capacity: try again later). */
  async #plan(
    tx: Queryable,
    w: CheckRow,
    now: Date,
    posted: { threadId: string; message: MessageView }[],
  ): Promise<RemotePlan | null> {
    const s = w.spec;
    const key = `watch-${w.id.slice(0, 18)}-${String(w.check_count + 1)}`;
    if (!(await this.#capacity(tx, w, now))) return null;
    if (s.kind === 'http') {
      try {
        const fn = await this.#httpSpec(s.project, s.url, s.method ?? 'GET', key);
        return { project: s.project, fn, workerId: s.workerId ?? null };
      } catch (err) {
        if (!(err instanceof WatchCheckRefusal)) throw err;
        await this.#refuse(tx, w, now, err.code, posted);
        return null;
      }
    }
    if (s.kind === 'worker_probe')
      return { project: s.project, fn: probeCheckSpec(s.probe, key), workerId: s.workerId };
    return null;
  }

  /** At most `maxInFlightPerUser` check jobs of one user at once; otherwise the check moves to the next slot. */
  async #capacity(tx: Queryable, w: CheckRow, now: Date): Promise<boolean> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chat_watches
        WHERE user_id = $1 AND state = 'active' AND pending_job_id IS NOT NULL AND id <> $2`,
      [w.user_id, w.id],
    );
    if ((rows[0]?.n ?? 0) < WATCH_CHECK_LIMITS.maxInFlightPerUser) {
      // Claim the slot: a crash before the job exists retries after the claim.
      await tx.query('UPDATE chat_watches SET next_check_at = $2, updated_at = $3 WHERE id = $1', [
        w.id,
        new Date(now.getTime() + 120_000),
        now,
      ]);
      return true;
    }
    await tx.query('UPDATE chat_watches SET next_check_at = $2, updated_at = $3 WHERE id = $1', [
      w.id,
      new Date(now.getTime() + (w.every_sec ?? WATCH_CHECK_LIMITS.defaultEverySec) * 1000),
      now,
    ]);
    return false;
  }

  /** The HTTP phase of an event condition: start a check now when due, or wait for the next slot. */
  async #httpPhasePlan(
    tx: Queryable,
    w: CheckRow,
    phase: { url: string; project: string },
    now: Date,
    mode: EvalMode,
  ): Promise<RemotePlan | null | 'refused'> {
    const due = mode === 'dry' || w.next_check_at === null || w.next_check_at.getTime() <= now.getTime();
    if (!due) return null;
    const key = `watch-${w.id.slice(0, 18)}-${String(w.check_count + 1)}`;
    let fn: FunctionSpec;
    try {
      fn = await this.#httpSpec(phase.project, phase.url, 'GET', key);
    } catch (err) {
      if (err instanceof WatchCheckRefusal) return 'refused';
      throw err;
    }
    if (!(await this.#capacity(tx, w, now))) return null;
    return { project: phase.project, fn, workerId: null };
  }

  async #refuse(
    tx: Queryable,
    w: CheckRow,
    now: Date,
    code: string,
    posted: { threadId: string; message: MessageView }[],
  ): Promise<void> {
    const t = messagesFor(w.language).watches;
    const reason = t.summary.refused({ code });
    await this.#record(tx, w, { met: false, say: () => reason, error: code }, 'poll', now);
    await this.#end(
      tx,
      w,
      now,
      'done',
      `check_refused:${code}`,
      t.delivery.refusedText({ label: md(w.label), reason: md(reason) }),
      posted,
      { title: t.delivery.refusedTitle({ label: w.label }), body: `${w.label}: ${reason}` },
    );
  }

  /** Creates the check's function job as the watch's owner; the job is linked to the watch in its creation. */
  async #startRemote(watchId: string, plan: RemotePlan): Promise<void> {
    const jobs = this.deps.jobs?.() ?? null;
    if (jobs === null) {
      this.deps.log.warn({ watchId }, 'watch check: no job store; the remote check waits');
      return;
    }
    const w = await this.#row(watchId);
    if (w === null || w.state !== 'active') return;
    try {
      await jobs.create({
        project: plan.project,
        spec: checkJobSpec({ project: plan.project, watchId, fn: plan.fn, workerId: plan.workerId }),
        userId: w.user_id,
        withinCreate: async (tx, jobId) => {
          const u = await tx.query(
            `UPDATE chat_watches SET pending_job_id = $2, updated_at = $3
              WHERE id = $1 AND state = 'active' AND pending_job_id IS NULL`,
            [watchId, jobId, this.#now()],
          );
          if (u.rowCount !== 1) throw new CheckAlreadyRunning();
        },
      });
    } catch (err) {
      if (err instanceof CheckAlreadyRunning) return;
      // A refused job (invalid spec, project rules): record it and try again on the next slot.
      const code =
        err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'job_refused';
      this.deps.log.warn({ err, watchId }, 'watch check job could not be created');
      await withTransaction(this.deps.pool, async (tx) => {
        const r = await this.#row(watchId, tx);
        if (r === null || r.state !== 'active') return;
        const now = this.#now();
        await this.#record(
          tx,
          r,
          {
            met: false,
            say: (t) => t.summary.checkFailed({ code: oneLine(code, 40) }),
            error: 'job_refused',
          },
          'poll',
          now,
        );
        const delay = nextDelaySec(r.every_sec ?? WATCH_CHECK_LIMITS.defaultEverySec, r.unmet_streak);
        await tx.query(
          `UPDATE chat_watches SET unmet_streak = unmet_streak + 1, next_check_at = $2 WHERE id = $1`,
          [watchId, new Date(now.getTime() + delay * 1000)],
        );
      });
    }
  }

  async #cancelJob(jobId: string, reason: string): Promise<void> {
    try {
      await this.deps.jobs?.()?.cancel(jobId, reason);
    } catch (err) {
      this.deps.log.debug({ err, jobId }, 'watch check job cancel failed');
    }
  }

  /** Public for ChatWatchService: a watch ended elsewhere (cancel, expiry) no longer needs its check job. */
  async cancelCheckJob(jobId: string | null): Promise<void> {
    if (jobId !== null) await this.#cancelJob(jobId, 'the watch ended');
  }

  /** What a finished check job says about the condition. */
  async #remoteOutcome(tx: Queryable, w: CheckRow, jobId: string, state: string): Promise<Outcome> {
    const { rows: att } = await tx.query<{ worker_id: string | null }>(
      'SELECT worker_id FROM job_attempts WHERE job_id = $1 ORDER BY started_at DESC NULLS LAST LIMIT 1',
      [jobId],
    );
    const workerId = att[0]?.worker_id ?? null;
    const base = { jobId, workerId };
    if (state === 'CANCELLED')
      return { ...base, met: false, say: (t) => t.summary.noWorker, error: 'no_worker' };
    if (state === 'FAILED') {
      const f = await functionFailure(tx, jobId);
      if (!f.retryable)
        return {
          ...base,
          met: false,
          say: (t) => t.summary.refused({ code: f.code }),
          error: f.code,
          end: 'refused',
        };
      if (f.code === 'no_worker')
        return { ...base, met: false, say: (t) => t.summary.noWorker, error: 'no_worker' };
      return { ...base, met: false, say: (t) => t.summary.unreachable({ code: f.code }), error: f.code };
    }
    const r: FunctionResult | null = await readFunctionResult(tx, jobId);
    if (r === null)
      return {
        ...base,
        met: false,
        say: (t) => t.summary.checkFailed({ code: 'no_result' }),
        error: 'no_result',
      };
    const s = w.spec;
    const expect =
      s.kind === 'http'
        ? s.expect
        : s.kind === 'worker_probe' && s.probe.type === 'http'
          ? s.probe.expect
          : undefined;
    const jsonata: JsonataEval =
      this.deps.jsonata ?? (() => Promise.resolve({ ok: false as const, code: 'expr_unavailable' }));
    const phaseUrl =
      s.kind === 'preview_up' || s.kind === 'service_url'
        ? safeUrl((w.last_check?.value as { url?: unknown } | undefined)?.url)
        : null;
    if (r.type === 'http') {
      const j = await judgeHttp(
        expect,
        { status: r.status, headers: r.headers, body: r.body, durationMs: r.durationMs },
        jsonata,
      );
      if (!j.met)
        return {
          ...base,
          met: false,
          say: j.say,
          ...(j.refused === undefined ? {} : { end: 'refused' as const, error: j.refused }),
        };
      return phaseUrl !== null
        ? {
            ...base,
            met: true,
            say: (t) => t.summary.tunnelUp({ url: phaseUrl }),
            url: phaseUrl,
            value: { url: phaseUrl, status: r.status },
          }
        : { ...base, met: true, say: j.say, value: j.value };
    }
    if (r.type === 'probe') {
      const port = s.kind === 'worker_probe' ? s.probe.port : 0;
      if (!r.reachable) {
        const code = r.error ?? 'unreachable';
        return { ...base, met: false, say: (t) => t.summary.portClosed({ port, code }), error: code };
      }
      if (r.kind === 'tcp')
        return {
          ...base,
          met: true,
          say: (t) => t.summary.portOpen({ port, ms: r.durationMs }),
          value: { port, open: true },
        };
      const j = await judgeHttp(
        expect,
        { status: r.status ?? 0, headers: r.headers ?? {}, body: r.body, durationMs: r.durationMs },
        jsonata,
      );
      if (!j.met)
        return {
          ...base,
          met: false,
          say: j.say,
          ...(j.refused === undefined ? {} : { end: 'refused' as const, error: j.refused }),
        };
      return { ...base, met: true, say: j.say, value: j.value };
    }
    return {
      ...base,
      met: false,
      say: (t) => t.summary.checkFailed({ code: 'result_invalid' }),
      error: 'result_invalid',
    };
  }

  // -------------------------------------------------------------------------------------- record / end / fire

  /** Stores the check on the watch; a history row only when the result changed (at most 20 per watch). */
  async #record(tx: Queryable, w: CheckRow, o: Outcome, mode: EvalMode, now: Date): Promise<void> {
    const summary = oneLine(o.say(messagesFor(w.language).watches), 500);
    const view: WatchCheckView = {
      at: now.toISOString(),
      met: o.met,
      summary,
      mode,
      ...(o.value === undefined ? {} : { value: o.value }),
      workerId: o.workerId ?? null,
      error: o.error ?? null,
    };
    await tx.query(
      `UPDATE chat_watches SET last_check = $2, check_count = check_count + 1, cursor = $3, updated_at = $4
        WHERE id = $1`,
      [w.id, JSON.stringify(view), JSON.stringify(o.cursor ?? w.cursor), now],
    );
    const changed = w.last_check === null || w.last_check.summary !== summary || w.last_check.met !== o.met;
    if (!changed) return;
    await tx.query(
      `INSERT INTO chat_watch_checks (watch_id, at, mode, met, summary, value, error, job_id, worker_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        w.id,
        now,
        mode,
        o.met,
        summary,
        o.value === undefined ? null : JSON.stringify(o.value),
        o.error !== undefined && o.error !== null && /^[a-z_]{1,80}$/.test(o.error) ? o.error : null,
        o.jobId ?? null,
        o.workerId ?? null,
      ],
    );
    await tx.query(
      `DELETE FROM chat_watch_checks WHERE watch_id = $1 AND id NOT IN (
         SELECT id FROM chat_watch_checks WHERE watch_id = $1 ORDER BY id DESC LIMIT 20)`,
      [w.id],
    );
  }

  /** Ends a watch (state + reason) with an optional thread note and notification. */
  async #end(
    tx: Queryable,
    w: CheckRow,
    now: Date,
    state: 'done' | 'revoked',
    reason: string,
    note: string | null,
    posted: { threadId: string; message: MessageView }[],
    notify?: { title: string; body: string },
  ): Promise<void> {
    await tx.query(
      `UPDATE chat_watches SET state = $2, end_reason = $3, ended_at = $4, updated_at = $4, next_check_at = NULL
        WHERE id = $1`,
      [w.id, state, reason.slice(0, 300), now],
    );
    if (notify !== undefined) {
      await this.deps.notifications()?.notify(tx, [w.user_id], {
        kind: 'chat.watch',
        severity: 'warning',
        title: notify.title,
        body: notify.body,
        link: checkLink(w.spec, w.thread_id),
        dedupeKey: `chat.watch:${w.id}:end`,
      });
    }
    if (note !== null && w.thread_id !== null) {
      const message = await this.deps.store.addMessage(
        w.thread_id,
        {
          role: 'assistant',
          content: note,
          meta: { notice: 'chat-watch', watchId: w.id, event: reason.split(':')[0] },
        },
        tx,
      );
      posted.push({ threadId: w.thread_id, message });
    }
  }

  /** Exactly once: the `met` fire row, the end of the watch, the note and the notification in one transaction. */
  async #fire(
    tx: Queryable,
    w: CheckRow,
    o: Outcome,
    now: Date,
    posted: { threadId: string; message: MessageView }[],
  ): Promise<boolean> {
    const ins = await tx.query(
      `INSERT INTO chat_watch_fires (watch_id, occurrence, delivered, fired_at) VALUES ($1, 'met', true, $2)
       ON CONFLICT DO NOTHING`,
      [w.id, now],
    );
    if ((ins.rowCount ?? 0) === 0) return false;
    const t = messagesFor(w.language).watches;
    const summary = oneLine(o.say(t), 300);
    const value = o.value === undefined ? null : o.value;
    await tx.query(
      `UPDATE chat_watches SET state = 'done', end_reason = 'fired', ended_at = $2, updated_at = $2, next_check_at = NULL,
              pending_job_id = NULL, fire_count = fire_count + 1, last_fired_at = $2, result = $3
        WHERE id = $1`,
      [w.id, now, JSON.stringify({ summary, value, url: o.url ?? null })],
    );
    const link = checkLink(w.spec, w.thread_id);
    const url = o.url ?? null;
    const extra =
      url === null && value !== null && !isTrivialValue(value) ? ` · ${md(valueText(value))}` : '';
    const detail = `${md(summary)}${extra}${url === null ? '' : ` [${url}](${url})`}`;
    const text = t.delivery.metText({ label: md(w.label), detail });
    await this.deps.notifications()?.notify(tx, [w.user_id], {
      kind: 'chat.watch',
      severity: 'info',
      title: t.delivery.metTitle({ label: w.label }),
      body: `${w.label}. ${summary}${url === null ? '' : ` ${url}`}`,
      link,
      dedupeKey: `chat.watch:${w.id}:met`,
    });
    await this.deps.audit.record(
      {
        actor: { type: 'system', id: 'chat-watches' },
        action: 'chat.watch.fire',
        target: `chat-watch:${w.id}`,
        outcome: 'success',
        metadata: {
          userId: w.user_id,
          targetKind: 'check',
          checkKind: w.spec.kind,
          occurrence: 'met',
          threadId: w.thread_id,
          checks: w.check_count + 1,
        },
      },
      tx,
    );
    if (w.thread_id !== null) {
      const message = await this.deps.store.addMessage(
        w.thread_id,
        {
          role: 'assistant',
          content: text,
          meta: {
            notice: 'chat-watch',
            watchId: w.id,
            event: 'met',
            link,
            links: [{ label: t.delivery.open, href: link }],
            ...(url === null ? {} : { url }),
          },
        },
        tx,
      );
      posted.push({ threadId: w.thread_id, message });
    }
    return true;
  }

  /**
   * The `then` step, after the fire committed (the assistant's draft tool code, not the model): runs it at once for
   * `mode: auto` where the security policy allows it (p15-watch-autorun), else prepares its card. Called once per fire
   * — only by the evaluation whose transaction recorded the fire (`chat_watch_fires`, row locked SKIP LOCKED).
   */
  async #then(w: CheckRow): Promise<void> {
    const runner = this.deps.then?.() ?? null;
    const action = w.then_action;
    if (runner === null || action === null || w.thread_id === null) return;
    const t = messagesFor(w.language).watches;
    let text: string;
    let draftId: string | null = null;
    let ran: { title: string; link: string | null } | null = null;
    try {
      // The owner as they are now: a disabled account or a lost permission refuses below (the draft tool and the
      // confirmation both re-check the role for the project).
      const subject = await this.#activeSubject(this.deps.pool, w.user_id);
      if (subject === null) return;
      const out = await runner(
        {
          userId: w.user_id,
          subject,
          threadId: w.thread_id,
          turnId: w.turn_id ?? randomUUID(),
          watchId: w.id,
        },
        action,
      );
      if (!out.ok) text = t.delivery.thenFailed({ reason: md(out.message) });
      else {
        draftId = out.draftId;
        if (out.executed) {
          text =
            out.action === 'workflow_run'
              ? t.delivery.thenRanWorkflow({ name: md(out.name) })
              : out.action === 'deploy'
                ? t.delivery.thenRanDeploy({ name: md(out.name) })
                : t.delivery.thenSentMessage;
          ran = {
            title:
              out.action === 'workflow_run'
                ? t.delivery.thenRanTitle({ name: out.name })
                : out.action === 'deploy'
                  ? t.delivery.thenRanDeployTitle({ name: out.name })
                  : t.delivery.thenSentTitle({ label: w.label }),
            link: out.link,
          };
        } else
          text =
            out.why === 'ask'
              ? t.delivery.thenReady
              : out.why === 'needs_code'
                ? t.delivery.thenReadyCode
                : out.why === 'cards_required'
                  ? t.delivery.thenReadyPolicy
                  : t.delivery.thenNotRun({ reason: md(out.message ?? out.why) });
      }
    } catch (err) {
      this.deps.log.warn({ err, watchId: w.id }, 'watch then step failed');
      text = t.delivery.thenFailed({ reason: 'error' });
    }
    const threadId = w.thread_id;
    const link = ran?.link ?? null;
    const message = await withTransaction(this.deps.pool, async (tx) => {
      if (ran !== null)
        await this.deps.notifications()?.notify(tx, [w.user_id], {
          kind: 'chat.watch',
          severity: 'info',
          title: ran.title,
          body: oneLine(text.replace(/\*\*/g, ''), 500),
          link: link ?? `/chat/${threadId}`,
          dedupeKey: `chat.watch:${w.id}:then`,
        });
      return this.deps.store.addMessage(
        threadId,
        {
          role: 'assistant',
          content: text,
          meta: {
            notice: 'chat-watch',
            watchId: w.id,
            event: 'then',
            ...(draftId === null ? {} : { draftId }),
            ...(ran === null ? {} : { executed: true }),
            ...(link === null ? {} : { link, links: [{ label: t.delivery.openRun, href: link }] }),
          },
        },
        tx,
      );
    });
    this.#publish(threadId, message);
  }

  #publish(threadId: string, message: MessageView | null): void {
    try {
      this.deps.publish?.(threadId, message);
    } catch (err) {
      this.deps.log.debug({ err, threadId }, 'watch check: stream publish failed');
    }
  }

  // ---------------------------------------------------------------------------------------------- tick / events

  /**
   * The tick part of check watches: due polls, check jobs no machine took (queue timeout), and — at boot, after a
   * reconnect, or every 30 s only while the listener is down — one reconcile pass over event watches.
   */
  async tick(): Promise<number> {
    void this.listen();
    const now = this.#now();
    let n = 0;
    const q = async (sql: string, params: unknown[]): Promise<string[]> =>
      (await this.deps.pool.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
    const due = await q(
      `SELECT id::text AS id FROM chat_watches
        WHERE state = 'active' AND target_kind = 'check' AND pending_job_id IS NULL AND next_check_at <= $1
        ORDER BY next_check_at LIMIT 20`,
      [now],
    );
    const queueSec = this.deps.queueTimeoutSec ?? 600;
    const stuck = await q(
      `SELECT w.id::text AS id FROM chat_watches w JOIN jobs j ON j.id = w.pending_job_id
        WHERE w.state = 'active' AND w.target_kind = 'check'
          AND ((j.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND $2::boolean)
               OR (j.state IN ('DRAFT', 'QUEUED', 'BLOCKED', 'RESERVED', 'RETRY_WAIT') AND j.created_at <= $1))
        LIMIT 50`,
      [new Date(now.getTime() - queueSec * 1000), !this.listening],
    );
    let reconcile: string[] = [];
    const every = this.deps.reconcileMs ?? 30_000;
    if (this.#reconcileDue || (!this.listening && now.getTime() - this.#lastReconcile >= every)) {
      this.#reconcileDue = false;
      this.#lastReconcile = now.getTime();
      reconcile = await q(
        `SELECT id::text AS id FROM chat_watches
          WHERE state = 'active' AND target_kind = 'check' AND subject IS NOT NULL AND pending_job_id IS NULL
          ORDER BY created_at LIMIT 200`,
        [],
      );
    }
    for (const [ids, mode] of [
      [due, 'poll'],
      [stuck, 'poll'],
      [reconcile, 'reconcile'],
    ] as const) {
      for (const id of ids) {
        try {
          const r = await this.evaluate(id, mode);
          if (r !== 'skipped' && r !== 'pending') n++;
        } catch (err) {
          this.deps.log.error({ err, watchId: id }, 'watch check evaluation failed');
        }
      }
    }
    return n;
  }

  /** A `remana_watch` notification: `check:<jobId>` (a check job changed) or a subject. */
  async #onPayload(payload: string): Promise<'retry' | 'done'> {
    const check = /^check:([0-9a-f-]{36})$/i.exec(payload);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      check === null
        ? `SELECT id::text AS id FROM chat_watches WHERE state = 'active' AND target_kind = 'check' AND subject = $1`
        : `SELECT id::text AS id FROM chat_watches WHERE state = 'active' AND target_kind = 'check' AND pending_job_id = $1::uuid`,
      [check === null ? payload : check[1]],
    );
    let retry = false;
    for (const r of rows) {
      try {
        if ((await this.evaluate(r.id, 'event')) === 'locked') retry = true;
      } catch (err) {
        this.deps.log.error({ err, watchId: r.id }, 'watch check evaluation failed');
      }
    }
    return retry ? 'retry' : 'done';
  }
}

class CheckAlreadyRunning extends Error {}

function jsonataOf(spec: WatchCheckCondition): string[] {
  if (spec.kind === 'http' && spec.expect?.jsonata !== undefined) return [spec.expect.jsonata];
  if (spec.kind === 'worker_probe' && spec.probe.type === 'http' && spec.probe.expect?.jsonata !== undefined)
    return [spec.probe.expect.jsonata];
  return [];
}

function isTrivialValue(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const keys = Object.keys(v);
  return keys.every((k) =>
    ['status', 'state', 'name', 'url', 'line', 'kind', 'port', 'open', 'runtime', 'ready', 'node'].includes(
      k,
    ),
  );
}

/** ±120 characters of untrusted text around the first match, one line. */
function excerpt(line: string, needle: string): string {
  const flat = oneLine(line, 4000);
  const i = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0 || flat.length <= 240) return oneLine(flat, 240);
  const from = Math.max(0, i - 100);
  return oneLine(`${from > 0 ? '…' : ''}${flat.slice(from, from + 220)}`, 240);
}

/** Kinds as the console lists them. */
export function checkKindOf(spec: WatchCheckCondition | null): WatchCheckKind | null {
  return spec?.kind ?? null;
}

// ---------------------------------------------------------------------------------------------------- listener

/**
 * One LISTEN connection on `remana_watch` per master. Payloads are queued (deduplicated) and evaluated one after the
 * other; a watch locked by a concurrent evaluation is retried shortly (its event may have committed after the other
 * evaluation read the rows). Reconnects after errors; `onConnected` asks the engine for one reconcile pass.
 */
class WatchListener {
  #client: PoolClient | null = null;
  #starting: Promise<void> | null = null;
  #stopped = false;
  #retry: NodeJS.Timeout | null = null;
  readonly #queue = new Set<string>();
  readonly #attempts = new Map<string, number>();
  #draining: Promise<void> | null = null;
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly o: {
      readonly pool: Pool;
      readonly log: FastifyBaseLogger;
      readonly onConnected: () => void;
      readonly onPayload: (payload: string) => Promise<'retry' | 'done'>;
    },
  ) {}

  get listening(): boolean {
    return this.#client !== null;
  }

  start(): Promise<void> {
    if (this.#client !== null || this.#stopped) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.o.pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel === WATCH_CHANNEL && msg.payload !== undefined) this.enqueue(msg.payload);
      });
      client.on('error', (err) => {
        this.o.log.warn({ err }, 'watch listener connection failed; reconnecting');
        this.#drop(true);
      });
      await client.query(`LISTEN ${WATCH_CHANNEL}`);
      if (this.#stopped) {
        client.release();
        return;
      }
      this.#client = client;
      this.o.onConnected();
    } catch (err) {
      this.o.log.warn({ err }, 'watch listener could not start; watches fall back to the reconcile pass');
      client?.release(true);
      this.#schedule();
    }
  }

  #drop(broken: boolean): void {
    const c = this.#client;
    this.#client = null;
    c?.removeAllListeners('notification');
    c?.release(broken);
    if (!this.#stopped) this.#schedule();
  }

  #schedule(): void {
    if (this.#retry !== null || this.#stopped) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.start();
    }, 5_000);
    this.#retry.unref();
  }

  enqueue(payload: string): void {
    if (this.#stopped || payload.length > 260) return;
    this.#queue.add(payload);
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
      if (this.#queue.size > 0 && !this.#stopped) this.enqueue([...this.#queue][0] ?? '');
    });
  }

  async #drain(): Promise<void> {
    while (this.#queue.size > 0 && !this.#stopped) {
      const p = [...this.#queue][0] as string;
      this.#queue.delete(p);
      try {
        const r = await this.o.onPayload(p);
        if (r === 'retry') {
          const n = (this.#attempts.get(p) ?? 0) + 1;
          if (n <= RETRY_LOCKED) {
            this.#attempts.set(p, n);
            const t = setTimeout(() => {
              this.#timers.delete(t);
              this.enqueue(p);
            }, 150);
            t.unref();
            this.#timers.add(t);
          } else this.#attempts.delete(p);
        } else this.#attempts.delete(p);
      } catch (err) {
        this.o.log.error({ err, payload: p }, 'watch wake-up failed');
      }
    }
  }

  async idle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (this.#draining === null && this.#queue.size === 0 && this.#timers.size === 0) return;
      await (this.#draining ?? new Promise((r) => setTimeout(r, 20)));
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#queue.clear();
    await this.#starting;
    await this.#draining;
    const c = this.#client;
    this.#client = null;
    if (c !== null) {
      await c.query(`UNLISTEN ${WATCH_CHANNEL}`).catch(() => undefined);
      c.removeAllListeners('notification');
      c.release();
    }
  }
}
