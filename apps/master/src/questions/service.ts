import { createHash, randomUUID } from 'node:crypto';
import {
  ASK_USER_FEATURE,
  type AssignedAskUser,
  QUESTION_LIMITS,
  QUESTION_SCHEMA_VERSION,
  type QuestionAnswer,
  type QuestionAskOp,
  QuestionAnswers,
  answerWithoutNote,
  type QuestionState,
  type QuestionStatusPayload,
  sameAnswers,
  type UserQuestion,
  type UserQuestionInput,
  UserQuestions,
  validateAnswers,
  withQuestionIds,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';
import type { NotificationDraft } from '../notifications/model.js';
import { projectRecipients } from '../notifications/recipients.js';
import type { WorkerSession } from '../workers/types.js';
import type { ActorContext } from '../workers/fleet.js';
import { titleColumns, titleOrDerived } from '../jobs/titles.js';

/**
 * p14-ask-user (docs/design/p14-ask-user.md): question sets to a person and their answers.
 *
 *  - **Job questions** — the agent of a running job asks over its live lease (QUESTION_REQUEST, fenced like
 *    SUBTASK_REQUEST); people who may message the job (`jobs.message`) answer on the job page; the worker's tool host
 *    long-polls `status` and hands the answer back to the blocked tool call.
 *  - **Assistant questions** — the Sohbet assistant's `ask_user` tool; only the conversation's owner answers, and the
 *    answer starts the next turn (ChatService.answerQuestion).
 *
 * Questions are untrusted data (agent / model text): validated with the protocol schema, stored as data, never put in a
 * notification. Answers are validated against the stored questions; a repeated identical answer is idempotent, a
 * different one is refused. A tick expires sets past their deadline and cancels those of ended jobs / attempts.
 */

const TERMINAL_JOB = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST'];
const ANSWER_LIMIT = { max: 30, windowMs: 10 * 60_000 } as const;

export interface QuestionView {
  readonly id: string;
  readonly source: 'job' | 'assistant';
  readonly jobId: string | null;
  readonly threadId: string | null;
  readonly project: string | null;
  readonly title: string | null;
  readonly questions: UserQuestion[];
  readonly state: QuestionState;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  /** p20-decisions: what the conversation settled (`settled_in_chat`); absent when none was given. */
  readonly closeNote?: string;
  readonly answers: QuestionAnswer[] | null;
  readonly answeredBy: { readonly id: string; readonly username: string } | null;
  readonly answeredAt: string | null;
  /** p18-plan-mode: a plan decision (keyed by plan, exempt from "one open card replaces the other"). */
  readonly planId?: string | null;
  readonly planItemKey?: string | null;
}

export interface PendingQuestion {
  readonly id: string;
  readonly source: 'job' | 'assistant';
  readonly jobId: string | null;
  readonly jobTitle: string | null;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly project: string | null;
  readonly title: string | null;
  /** The first question's prompt (agent text: render as text), clipped. */
  readonly prompt: string;
  readonly count: number;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  /**
   * p18-plan-mode W4: a plan decision ("Senden bekleyen" groups it under its plan; answered through the same row, the
   * plan updates live). Absent / null for every other question.
   */
  readonly plan?: {
    readonly id: string;
    readonly title: string;
    readonly itemKey: string | null;
    readonly itemTitle: string | null;
  } | null;
}

interface Row {
  id: string;
  source: 'job' | 'assistant';
  job_id: string | null;
  attempt_id: string | null;
  request_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  user_id: string | null;
  project: string | null;
  title: string | null;
  questions: unknown;
  state: QuestionState;
  created_at: Date;
  deadline_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
  close_note?: string | null;
  answers: unknown;
  answered_by: string | null;
  answered_at: Date | null;
  answered_by_name?: string | null;
  plan_id?: string | null;
  plan_item_key?: string | null;
}

const COLS = `q.id::text AS id, q.source, q.job_id::text AS job_id, q.attempt_id::text AS attempt_id,
  q.request_id::text AS request_id, q.thread_id::text AS thread_id, q.turn_id::text AS turn_id,
  q.user_id::text AS user_id, q.project, q.title, q.questions, q.state, q.created_at, q.deadline_at, q.closed_at,
  q.close_reason, q.close_note, q.answers, q.answered_by::text AS answered_by, q.answered_at,
  (SELECT u.username FROM users u WHERE u.id = q.answered_by) AS answered_by_name,
  q.plan_id::text AS plan_id, q.plan_item_key`;

const Stored = z.object({ v: z.literal(QUESTION_SCHEMA_VERSION), questions: UserQuestions });

function storedQuestions(raw: unknown): UserQuestion[] {
  const p = Stored.safeParse(raw);
  return p.success ? p.data.questions : [];
}

function storedAnswers(raw: unknown): QuestionAnswer[] | null {
  if (raw === null || raw === undefined) return null;
  const p = QuestionAnswers.safeParse(raw);
  return p.success ? p.data : null;
}

export function viewOf(r: Row): QuestionView {
  return {
    id: r.id,
    source: r.source,
    jobId: r.job_id,
    threadId: r.thread_id,
    project: r.project,
    title: r.title,
    questions: storedQuestions(r.questions),
    state: r.state,
    createdAt: r.created_at.toISOString(),
    deadlineAt: r.deadline_at?.toISOString() ?? null,
    closedAt: r.closed_at?.toISOString() ?? null,
    closeReason: r.close_reason,
    ...(typeof r.close_note === 'string' && r.close_note !== '' ? { closeNote: r.close_note } : {}),
    answers: storedAnswers(r.answers),
    answeredBy:
      r.answered_by === null ? null : { id: r.answered_by, username: r.answered_by_name ?? r.answered_by },
    answeredAt: r.answered_at?.toISOString() ?? null,
    ...(r.plan_id === null || r.plan_id === undefined
      ? {}
      : { planId: r.plan_id, planItemKey: r.plan_item_key ?? null }),
  };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Audit metadata of answers: ids, lengths and a short hash — never the text itself. */
function answerMeta(answers: readonly QuestionAnswer[]): Record<string, unknown> {
  const json = JSON.stringify(answers);
  return {
    answered: answers.map((a) => a.id),
    chars: json.length,
    sha256: createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 16),
  };
}

interface LiveJob {
  readonly jobId: string;
  readonly attemptId: string;
  readonly project: string;
  readonly title: string;
  readonly creatorType: string;
  readonly creatorId: string | null;
  /** When the attempt's run limit ends (a question never outlives it). */
  readonly runDeadline: Date | null;
}

type StatusBody = Omit<QuestionStatusPayload, 'attemptId' | 'epoch' | 'requestId'>;

const questionClosed = (state: string): HttpError =>
  new HttpError(409, 'question_closed', 'This question is already closed.', {}, {}, { state });

export interface QuestionServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly notify?: () => {
    notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
  } | null;
  readonly limiter?: {
    hit(b: string, k: string, n: number, ms: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  };
  /** Longest timeout a job question may have (default 24 h). */
  readonly maxTimeoutSec?: number;
  /**
   * p17-chat-flow: the conversations a job came from — a new job question is posted there as a card, and a change
   * (answered, closed) refreshes them. Absent / null: the job page and "Senden bekleyen" only. Never fails the ask.
   */
  readonly chat?: () => {
    jobQuestionAsked(jobId: string, questionId: string): Promise<unknown>;
    questionChanged(questionId: string): Promise<void>;
  } | null;
}

export class QuestionService {
  constructor(private readonly deps: QuestionServiceDeps) {}

  #now(): Date {
    return this.deps.clock();
  }

  // ------------------------------------------------------------------------------------------- assignment

  /**
   * ASSIGN_JOB `execution.askUser` for a job about to be placed on `workerId`: jobs that run an agent (no integration
   * step, no machine-admin job) on a worker advertising `ask-user-v1`.
   */
  async assignment(
    job: { readonly id: string; readonly spec: { readonly kind?: string | undefined } },
    workerId: string,
  ): Promise<AssignedAskUser | undefined> {
    if (job.spec.kind !== undefined) return undefined;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, ASK_USER_FEATURE],
    );
    if (rows[0]?.ok !== true) return undefined;
    return { maxTimeoutSec: this.deps.maxTimeoutSec ?? QUESTION_LIMITS.maxTimeoutSec };
  }

  // ------------------------------------------------------------------------------------------- job requests

  async onRequest(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'QUESTION_REQUEST' }>,
  ): Promise<void> {
    const p = message.payload;
    const reply = async (body: StatusBody): Promise<void> => {
      try {
        await session.send(
          'QUESTION_STATUS',
          { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId, ...body },
          { jobId: message.jobId },
        );
      } catch (err) {
        this.deps.log.warn({ err, jobId: message.jobId }, 'question status not sent (worker disconnected)');
      }
    };
    try {
      const live = await this.#liveJob(session.workerId, message.jobId, p.attemptId, p.epoch);
      if (live === null) {
        await this.deps.audit.record({
          actor: { type: 'worker', id: session.workerId },
          action: 'job.question.request',
          target: `job:${message.jobId.slice(0, 64)}`,
          outcome: 'denied',
          metadata: { op: p.op.kind, requestId: p.requestId, denial: 'stale_lease' },
        });
        await reply({
          state: 'refused',
          reason: 'stale_lease',
          detail: 'This is not the live lease of the asking job on this worker.',
        });
        return;
      }
      if (p.op.kind === 'ask') {
        await reply(await this.#ask(session.workerId, live, p.requestId, p.op));
      } else if (p.op.kind === 'status') {
        await reply(await this.#status(live.jobId, p.op.questionId));
      } else {
        await reply(await this.#cancel(live.jobId, p.op.questionId, 'withdrawn'));
      }
    } catch (err) {
      this.deps.log.error({ err, jobId: message.jobId }, 'question request failed');
      await reply({
        state: 'refused',
        reason: 'internal',
        detail: 'The request failed on the master; try again.',
      });
    }
  }

  async #liveJob(workerId: string, jobId: string, attemptId: string, epoch: number): Promise<LiveJob | null> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      title_stored: string | null;
      title_prompt: string | null;
      created_by_type: string;
      created_by_id: string | null;
      run_deadline: Date | null;
    }>(
      `SELECT j.id::text AS id, j.project, ${titleColumns()},
              j.created_by_type, j.created_by_id,
              -- p20-job-clock: a worker whose run clock stops while a question waits has no wall-clock run deadline.
              CASE WHEN w.features ? 'run-clock-v1' THEN NULL
                   ELSE a.started_at + make_interval(secs => COALESCE((j.spec->'limits'->>'maxDurationSec')::int, 0))
              END AS run_deadline
         FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id JOIN leases l ON l.job_id = j.id
         JOIN job_attempts a ON a.id = l.attempt_id
         LEFT JOIN workers w ON w.id = l.worker_id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [jobId, epoch, attemptId, workerId, this.#now()],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      jobId: r.id,
      attemptId,
      project: r.project,
      title: titleOrDerived(r),
      creatorType: r.created_by_type,
      creatorId: r.created_by_id,
      runDeadline: r.run_deadline,
    };
  }

  async #ask(workerId: string, job: LiveJob, requestId: string, op: QuestionAskOp): Promise<StatusBody> {
    // Idempotent per (job, request id): a retried ask returns the same set.
    const prior = await this.deps.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM user_questions WHERE job_id = $1 AND request_id = $2',
      [job.jobId, requestId],
    );
    const priorId = prior.rows[0]?.id;
    if (priorId !== undefined) return this.#status(job.jobId, priorId);
    const deny = async (reason: string, detail: string): Promise<StatusBody> => {
      await this.deps.audit.record({
        actor: { type: 'worker', id: workerId },
        action: 'job.question.ask',
        target: `job:${job.jobId}`,
        outcome: 'denied',
        metadata: { project: job.project, requestId, reason },
      });
      return { state: 'refused', reason, detail };
    };
    const json = JSON.stringify({ v: QUESTION_SCHEMA_VERSION, questions: op.questions });
    if (Buffer.byteLength(json, 'utf8') > QUESTION_LIMITS.maxSetBytes) {
      return deny('too_large', 'The questions are too long; ask fewer or shorter questions.');
    }
    const now = this.#now();
    const maxTimeout = this.deps.maxTimeoutSec ?? QUESTION_LIMITS.maxTimeoutSec;
    let deadline = new Date(now.getTime() + Math.min(op.timeoutSec, maxTimeout) * 1000);
    if (job.runDeadline !== null && job.runDeadline.getTime() > now.getTime() && job.runDeadline < deadline) {
      deadline = job.runDeadline;
    }
    const outcome = await withTransaction(this.deps.pool, async (tx) => {
      // One asker at a time per job (serialises the limits below).
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user_questions:${job.jobId}`]);
      const counts = await tx.query<{ open: number; total: number }>(
        `SELECT count(*) FILTER (WHERE state = 'pending')::int AS open, count(*)::int AS total
           FROM user_questions WHERE job_id = $1`,
        [job.jobId],
      );
      const c = counts.rows[0] ?? { open: 0, total: 0 };
      if (c.open >= QUESTION_LIMITS.maxOpenPerJob) return 'open' as const;
      if (c.total >= QUESTION_LIMITS.maxPerJob) return 'total' as const;
      const id = randomUUID();
      await tx.query(
        `INSERT INTO user_questions (id, source, job_id, attempt_id, request_id, project, title, questions, state,
                                     created_at, deadline_at)
         VALUES ($1, 'job', $2, $3, $4, $5, $6, $7, 'pending', $8, $9)`,
        [id, job.jobId, job.attemptId, requestId, job.project, op.title ?? null, json, now, deadline],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: workerId },
          action: 'job.question.ask',
          target: `job:${job.jobId}`,
          outcome: 'success',
          metadata: {
            project: job.project,
            questionId: id,
            requestId,
            questions: op.questions.length,
            kinds: op.questions.map((q) => q.kind),
            deadlineAt: deadline.toISOString(),
          },
        },
        tx,
      );
      return id;
    });
    if (outcome === 'open') {
      return deny(
        'open_question',
        'This job already has an open question; wait for its answer (wait_for_answer) before asking another.',
      );
    }
    if (outcome === 'total') {
      return deny(
        'limit',
        `At most ${String(QUESTION_LIMITS.maxPerJob)} questions per job; continue on your own judgement.`,
      );
    }
    await this.#notifyAsked(job, outcome);
    await this.#toChat(job.jobId, outcome);
    return { state: 'pending', questionId: outcome, deadlineAt: deadline.toISOString() };
  }

  /** p17-chat-flow: the question card in the conversations the job came from (a failure only loses the card). */
  async #toChat(jobId: string, questionId: string): Promise<void> {
    const chat = this.deps.chat?.() ?? null;
    if (chat === null) return;
    try {
      await chat.jobQuestionAsked(jobId, questionId);
    } catch (err) {
      this.deps.log.warn({ err, jobId }, 'question card for the conversation not posted');
    }
  }

  /** p17-chat-flow: conversations showing these job questions reload (never throws). */
  #changed(ids: readonly string[]): void {
    const chat = this.deps.chat?.() ?? null;
    if (chat === null) return;
    for (const id of ids) void chat.questionChanged(id).catch(() => undefined);
  }

  async #notifyAsked(job: LiveJob, questionId: string): Promise<void> {
    const notifier = this.deps.notify?.() ?? null;
    if (notifier === null) return;
    try {
      let recipients: string[];
      if (job.creatorType === 'user' && job.creatorId !== null) {
        const ok = await this.deps.pool.query<{ id: string }>(
          'SELECT id::text AS id FROM users WHERE id::text = $1 AND disabled_at IS NULL',
          [job.creatorId],
        );
        recipients = ok.rows.map((r) => r.id);
      } else {
        recipients = await projectRecipients(this.deps.pool, job.project, 'operator');
      }
      if (recipients.length === 0) return;
      // Never the agent's text: a question could be phrased as a phishing line. Title = the job's own prompt line.
      await notifier.notify(this.deps.pool, recipients, {
        kind: 'job.question',
        severity: 'warning',
        title: `A job in ${job.project} asks you a question`,
        body: `The agent of job “${clip(job.title === '' ? job.jobId.slice(0, 8) : job.title, 80)}” waits for your answer. Answer it on the job page; until then the agent waits (or continues on its own judgement when the question expires).`,
        link: `/jobs/${encodeURIComponent(job.jobId)}`,
        dedupeKey: `job.question:${questionId}`,
      });
    } catch (err) {
      this.deps.log.warn({ err, jobId: job.jobId }, 'question notification failed');
    }
  }

  async #status(jobId: string, questionId: string): Promise<StatusBody> {
    // Expire on read too (the tick may be behind).
    await this.#expire(questionId);
    const r = await this.#row(questionId);
    if (r?.job_id !== jobId) {
      return { state: 'refused', reason: 'not_found', detail: 'No such question in this job.' };
    }
    const v = viewOf(r);
    return {
      state: v.state,
      questionId: v.id,
      ...(v.deadlineAt === null || v.state !== 'pending' ? {} : { deadlineAt: v.deadlineAt }),
      // p19-plan-decide: workers before the note read a strict answer — the note travels inside the text.
      ...(v.state === 'answered' && v.answers !== null ? { answers: v.answers.map(answerWithoutNote) } : {}),
      ...(v.answeredBy === null ? {} : { answeredBy: clip(v.answeredBy.username, 64) }),
      ...(v.answeredAt === null ? {} : { answeredAt: v.answeredAt }),
      ...(v.closeReason === null || v.state === 'answered' ? {} : { reason: v.closeReason }),
    };
  }

  async #cancel(jobId: string, questionId: string, reason: string): Promise<StatusBody> {
    await this.deps.pool.query(
      `UPDATE user_questions SET state = 'cancelled', closed_at = $3, close_reason = $4
        WHERE id::text = $1 AND job_id::text = $2 AND state = 'pending'`,
      [questionId, jobId, this.#now(), reason],
    );
    return this.#status(jobId, questionId);
  }

  async #row(id: string, db: Queryable = this.deps.pool, lock = false): Promise<Row | null> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLS} FROM user_questions q WHERE q.id::text = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #expire(id: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE user_questions SET state = 'expired', closed_at = $2, close_reason = 'deadline'
        WHERE id::text = $1 AND state = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= $2`,
      [id, this.#now()],
    );
  }

  // ------------------------------------------------------------------------------------------- reads

  async forJob(jobId: string): Promise<QuestionView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM user_questions q WHERE q.job_id = $1 ORDER BY q.created_at DESC LIMIT 50`,
      [jobId],
    );
    return rows.map(viewOf);
  }

  /**
   * The question sets a conversation shows: the assistant's own, and (p17-chat-flow) the job questions posted into it
   * as cards (`meta.questionId` of a `job-question` note) — those stay job questions, answered through the job route.
   */
  async forThread(threadId: string): Promise<QuestionView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM user_questions q
        WHERE q.thread_id = $1
           OR (q.source = 'job' AND q.id::text IN (
                SELECT m.meta->>'questionId' FROM chat_messages m
                 WHERE m.thread_id = $1 AND m.meta->>'notice' = 'job-question'))
        ORDER BY q.created_at LIMIT 200`,
      [threadId],
    );
    return rows.map(viewOf);
  }

  /** Open question sets this subject may answer: job questions in projects with `jobs.message`, own conversations. */
  async pending(subject: Subject): Promise<PendingQuestion[]> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<
      Row & {
        title_stored: string | null;
        title_prompt: string | null;
        thread_title: string | null;
        thread_archived: boolean | null;
        plan_title: string | null;
        plan_item_title: string | null;
      }
    >(
      `SELECT ${COLS}, ${titleColumns()},
              t.title AS thread_title, (t.archived_at IS NOT NULL) AS thread_archived,
              pl.title AS plan_title, pi.title AS plan_item_title
         FROM user_questions q
         LEFT JOIN jobs j ON j.id = q.job_id
         LEFT JOIN job_titles jt ON jt.job_id = j.id
         LEFT JOIN chat_threads t ON t.id = q.thread_id
         LEFT JOIN chat_plans pl ON pl.id = q.plan_id
         LEFT JOIN chat_plan_items pi ON pi.plan_id = q.plan_id AND pi.key = q.plan_item_key AND pi.deleted_at IS NULL
        WHERE q.state = 'pending' AND (q.deadline_at IS NULL OR q.deadline_at > $2)
          AND (q.source = 'job' OR q.user_id::text = $1)
        ORDER BY q.created_at DESC LIMIT 200`,
      [subject.userId, now],
    );
    const out: PendingQuestion[] = [];
    for (const r of rows) {
      if (r.source === 'job') {
        if (r.project === null || !authorize(subject, 'jobs.message', { project: r.project }).allow) continue;
      } else if (r.thread_archived === true) continue;
      const qs = storedQuestions(r.questions);
      out.push({
        id: r.id,
        source: r.source,
        jobId: r.job_id,
        jobTitle: r.source === 'job' ? titleOrDerived(r) : null,
        threadId: r.thread_id,
        threadTitle: r.source === 'assistant' ? r.thread_title : null,
        project: r.project,
        title: r.title,
        prompt: clip((qs[0]?.prompt ?? '').replace(/\s+/g, ' ').trim(), 200),
        count: qs.length,
        createdAt: r.created_at.toISOString(),
        deadlineAt: r.deadline_at?.toISOString() ?? null,
        plan:
          r.plan_id == null || r.plan_title === null
            ? null
            : {
                id: r.plan_id,
                title: r.plan_title,
                itemKey: r.plan_item_key ?? null,
                itemTitle: r.plan_item_title,
              },
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- answers

  async #limit(userId: string): Promise<void> {
    const l = this.deps.limiter;
    if (l === undefined) return;
    const hit = await l.hit('question-answer-user', userId, ANSWER_LIMIT.max, ANSWER_LIMIT.windowMs);
    if (!hit.allowed) {
      throw new HttpError(
        429,
        'rate_limited',
        'Too many answers; try again later.',
        { 'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)) },
        {},
        { reason: 'question_answers' },
      );
    }
  }

  /**
   * Records the answer of one question set (in one statement: `WHERE state = 'pending'`). The same answer again returns
   * the stored set (`repeated`); a different answer to a closed set → 409 `question_closed`.
   */
  async #answer(
    actor: ActorContext,
    row: Row,
    raw: unknown,
    audit: { action: string; target: string; metadata: Record<string, unknown> },
  ): Promise<{ view: QuestionView; repeated: boolean }> {
    const questions = storedQuestions(row.questions);
    const check = validateAnswers(questions, raw);
    if (!check.ok) {
      throw new HttpError(
        400,
        'invalid_answer',
        'The answer does not fit the question.',
        {},
        {},
        { issue: check.issue, ...(check.questionId === null ? {} : { question: check.questionId }) },
      );
    }
    await this.#expire(row.id);
    const now = this.#now();
    const updated = await withTransaction(this.deps.pool, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `UPDATE user_questions SET state = 'answered', answers = $2, answered_by = $3, answered_at = $4, closed_at = $4
          WHERE id::text = $1 AND state = 'pending' RETURNING id::text AS id`,
        [row.id, JSON.stringify(check.answers), actor.userId, now],
      );
      if (res.rowCount === 1) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: audit.action,
            target: audit.target,
            outcome: 'success',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: { ...audit.metadata, questionId: row.id, ...answerMeta(check.answers) },
          },
          tx,
        );
      }
      return res.rowCount === 1;
    });
    const fresh = await this.#row(row.id);
    if (fresh === null) throw new HttpError(404, 'question_not_found', 'Question not found.');
    const view = viewOf(fresh);
    if (updated) return { view, repeated: false };
    if (view.state === 'answered' && view.answers !== null && sameAnswers(view.answers, check.answers)) {
      return { view, repeated: true };
    }
    throw questionClosed(view.state);
  }

  async answerJob(
    actor: ActorContext,
    jobId: string,
    questionId: string,
    raw: unknown,
  ): Promise<QuestionView> {
    const row = await this.#row(questionId);
    if (row?.job_id !== jobId) throw new HttpError(404, 'question_not_found', 'Question not found.');
    await this.#limit(actor.userId);
    const out = await this.#answer(actor, row, raw, {
      action: 'job.question.answer',
      target: `job:${jobId}`,
      metadata: { project: row.project, attemptId: row.attempt_id },
    });
    this.#changed([row.id]);
    return out.view;
  }

  // ------------------------------------------------------------------------------------------- assistant

  /** The assistant's `ask_user`: a new set in the conversation (an earlier open one is superseded). */
  async askInThread(
    c: { readonly userId: string; readonly threadId: string; readonly turnId: string },
    input: { readonly title?: string | undefined; readonly questions: readonly UserQuestionInput[] },
  ): Promise<QuestionView> {
    const questions = UserQuestions.parse(withQuestionIds(input.questions));
    const json = JSON.stringify({ v: QUESTION_SCHEMA_VERSION, questions });
    if (Buffer.byteLength(json, 'utf8') > QUESTION_LIMITS.maxSetBytes) {
      throw new HttpError(400, 'invalid_question', 'The questions are too long.');
    }
    const id = randomUUID();
    const now = this.#now();
    await withTransaction(this.deps.pool, async (tx) => {
      // p18-plan-mode: plan decisions are keyed by plan — a new ask_user card does not close them.
      await tx.query(
        `UPDATE user_questions SET state = 'cancelled', closed_at = $2, close_reason = 'superseded'
          WHERE thread_id = $1 AND state = 'pending' AND plan_id IS NULL`,
        [c.threadId, now],
      );
      await tx.query(
        `INSERT INTO user_questions (id, source, thread_id, turn_id, user_id, title, questions, state, created_at)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6, 'pending', $7)`,
        [id, c.threadId, c.turnId, c.userId, input.title ?? null, json, now],
      );
    });
    const r = await this.#row(id);
    if (r === null) throw new Error('question vanished');
    return viewOf(r);
  }

  /** The conversation owner's answer (the caller checked ownership and that no turn runs). */
  async answerThread(
    actor: ActorContext,
    threadId: string,
    questionId: string,
    raw: unknown,
  ): Promise<{ view: QuestionView; repeated: boolean }> {
    const row = await this.#row(questionId);
    if (row?.thread_id !== threadId || row.user_id !== actor.userId) {
      throw new HttpError(404, 'question_not_found', 'Question not found.');
    }
    await this.#limit(actor.userId);
    return this.#answer(actor, row, raw, {
      action: 'chat.question.answer',
      target: `chat-thread:${threadId}`,
      metadata: { turnId: row.turn_id },
    });
  }

  /** A normal message while a question is open: the person answered in prose (`superseded`). */
  async supersedeThread(threadId: string): Promise<number> {
    const r = await this.deps.pool.query(
      `UPDATE user_questions SET state = 'cancelled', closed_at = $2, close_reason = 'superseded'
        WHERE thread_id = $1 AND state = 'pending' AND plan_id IS NULL`,
      [threadId, this.#now()],
    );
    return r.rowCount ?? 0;
  }

  // ------------------------------------------------------------------------------------------- plan decisions

  /**
   * p18-plan-mode: a plan decision — one question of the assistant (`plan_ask_decision`) stored with its plan and item.
   * Not superseded by ask_user or a normal message; closed with its plan. `db`: inside the plan's transaction.
   */
  async askPlanDecision(
    c: { readonly userId: string; readonly threadId: string; readonly turnId: string | null },
    input: {
      readonly planId: string;
      readonly itemKey: string | null;
      readonly question: UserQuestionInput;
    },
    db: Queryable = this.deps.pool,
  ): Promise<string> {
    const questions = UserQuestions.parse(withQuestionIds([input.question]));
    const json = JSON.stringify({ v: QUESTION_SCHEMA_VERSION, questions });
    if (Buffer.byteLength(json, 'utf8') > QUESTION_LIMITS.maxSetBytes) {
      throw new HttpError(400, 'invalid_question', 'The questions are too long.');
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO user_questions (id, source, thread_id, turn_id, user_id, questions, state, created_at, plan_id,
                                   plan_item_key)
       VALUES ($1, 'assistant', $2, $3, $4, $5, 'pending',
               -- Decisions keep the order they were asked in (one clock tick apart at least).
               GREATEST($6::timestamptz, (SELECT max(created_at) + interval '1 millisecond' FROM user_questions
                                           WHERE plan_id = $7)),
               $7, $8)`,
      [id, c.threadId, c.turnId, c.userId, json, this.#now(), input.planId, input.itemKey],
    );
    return id;
  }

  /** p18-plan-mode: a plan's decisions (oldest first). */
  async forPlan(planId: string, db: Queryable = this.deps.pool): Promise<QuestionView[]> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLS} FROM user_questions q WHERE q.plan_id = $1 ORDER BY q.created_at LIMIT 100`,
      [planId],
    );
    return rows.map(viewOf);
  }

  /** p18-plan-mode: closes a plan's open decisions (the plan was cancelled, replaced or finished). */
  async closePlanDecisions(planId: string, reason: string, db: Queryable = this.deps.pool): Promise<number> {
    const r = await db.query(
      `UPDATE user_questions SET state = 'cancelled', closed_at = $2, close_reason = $3
        WHERE plan_id = $1 AND state = 'pending'`,
      [planId, this.#now(), reason],
    );
    return r.rowCount ?? 0;
  }

  /**
   * p19-plan-decide: one open decision of a plan closed because it was settled (or made moot) in the conversation —
   * `cancelled` with the reason. False when it is not an open decision of that plan.
   */
  async closePlanDecision(
    planId: string,
    questionId: string,
    reason: string,
    db: Queryable = this.deps.pool,
    /** p20-decisions: what was settled — the folded card shows it ("Sohbette karara bağlandı: <note>"). */
    note?: string,
  ): Promise<boolean> {
    const n = note?.trim() ?? '';
    const r = await db.query(
      `UPDATE user_questions SET state = 'cancelled', closed_at = $3, close_reason = $4, close_note = $5
        WHERE plan_id = $1 AND id::text = $2 AND state = 'pending'`,
      [planId, questionId, this.#now(), reason, n === '' ? null : clip(n, 500)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** p18-plan-mode: the plan a question of this conversation decides (null: not a plan decision). */
  async planOf(threadId: string, questionId: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ plan_id: string | null }>(
      `SELECT plan_id::text AS plan_id FROM user_questions WHERE id::text = $1 AND thread_id = $2`,
      [questionId, threadId],
    );
    return rows[0]?.plan_id ?? null;
  }

  // ------------------------------------------------------------------------------------------- tick

  /**
   * Expires pending sets past their deadline; cancels pending job sets whose job ended (`job_ended`) or whose attempt
   * is no longer the job's current one (`attempt_ended`). Returns how many sets were closed.
   */
  async tick(): Promise<number> {
    const now = this.#now();
    const expired = await this.deps.pool.query<{ id: string; job: boolean }>(
      `UPDATE user_questions SET state = 'expired', closed_at = $1, close_reason = 'deadline'
        WHERE state = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= $1
        RETURNING id::text AS id, (job_id IS NOT NULL) AS job`,
      [now],
    );
    const ended = await this.deps.pool.query<{ id: string }>(
      `UPDATE user_questions q
          SET state = 'cancelled', closed_at = $1,
              close_reason = CASE WHEN j.state::text = ANY($2::text[]) THEN 'job_ended' ELSE 'attempt_ended' END
         FROM jobs j
        WHERE q.state = 'pending' AND q.job_id = j.id
          AND (j.state::text = ANY($2::text[]) OR j.current_attempt_id IS DISTINCT FROM q.attempt_id)
        RETURNING q.id::text AS id`,
      [now, TERMINAL_JOB],
    );
    // p17-chat-flow: the job questions' cards in conversations show the new state.
    this.#changed([...expired.rows.filter((r) => r.job).map((r) => r.id), ...ended.rows.map((r) => r.id)]);
    return (expired.rowCount ?? 0) + (ended.rowCount ?? 0);
  }
}
