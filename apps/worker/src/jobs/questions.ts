import { randomUUID } from 'node:crypto';
import type { AskUserToolHost } from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  answersText,
  type AssignedAskUser,
  QUESTION_LIMITS,
  type QuestionRequestOp,
  type QuestionRequestPayload,
  type QuestionStatusPayload,
  type UserQuestion,
  UserQuestions,
  withQuestionIds,
} from '@remyral/protocol';

/**
 * Worker side of a job's question tools (p14-ask-user, docs/design/p14-ask-user.md §4): `ask_user` becomes one
 * QUESTION_REQUEST `ask` over the job's live lease (retried with the same request id, so the master creates the
 * question set once), then a long poll — `status` every few seconds until the set is answered, expired or cancelled,
 * or the call's `waitSec` ran out (the agent is then told to call `wait_for_answer`). When the job ends every blocked
 * call answers at once and new calls are refused.
 *
 * Nothing here widens what the master allows: the master validates the questions again, bounds the deadline, decides
 * who may answer and validates the answers.
 */

export interface QuestionChannel {
  request(jobId: string, payload: QuestionRequestPayload): Promise<void>;
}

export interface JobQuestionsDeps {
  readonly channel: QuestionChannel;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: () => number;
  readonly assigned: AssignedAskUser;
  readonly logger: Logger;
  /** How long one QUESTION_STATUS may take (default 30 s). */
  readonly answerTimeoutMs?: number;
  /** Poll period while waiting (default 3 s). */
  readonly pollMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  /**
   * p20-job-clock: a tool call starts (`true`) / stops (`false`) waiting for a person's answer — the runner stops the
   * job's run clock in between (`key` is unique per blocked call). Called in pairs; never throws into the tool call.
   */
  readonly onWait?: (key: string, waiting: boolean) => void;
}

type Outcome = { readonly ok: boolean; readonly text: string };
const OPEN = new Set(['pending']);

export class JobQuestions implements AskUserToolHost {
  readonly #d: JobQuestionsDeps;
  readonly #log: Logger;
  readonly #pending = new Map<string, (p: QuestionStatusPayload | null) => void>();
  /** Question set id → its questions (the answers are rendered with the prompts). */
  readonly #asked = new Map<string, readonly UserQuestion[]>();
  #ended = false;
  #wake: (() => void) | null = null;

  constructor(d: JobQuestionsDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'questions', jobId: d.jobId });
  }

  /** Routes a QUESTION_STATUS; false when no request of this job waits for it. */
  onStatus(p: QuestionStatusPayload): boolean {
    if (p.attemptId !== this.#d.attemptId) return false;
    const resolveFn = this.#pending.get(p.requestId);
    if (resolveFn === undefined) return false;
    resolveFn(p);
    return true;
  }

  /** The job ends: pending calls answer at once, new ones are refused. */
  end(): void {
    this.#ended = true;
    for (const r of this.#pending.values()) r(null);
    this.#pending.clear();
    this.#wake?.();
  }

  #isEnded(): boolean {
    return this.#ended;
  }

  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.#d.sleep !== undefined) return this.#d.sleep(ms, signal);
    return new Promise((res) => {
      const done = (): void => {
        clearTimeout(t);
        this.#wake = null;
        res();
      };
      const t = setTimeout(done, ms);
      t.unref();
      this.#wake = done;
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async #send(
    op: QuestionRequestOp,
    requestId: string = randomUUID(),
  ): Promise<QuestionStatusPayload | null> {
    if (this.#ended) return null;
    const answer = new Promise<QuestionStatusPayload | null>((res) => {
      const timer = setTimeout(() => {
        res(null);
      }, this.#d.answerTimeoutMs ?? 30_000);
      timer.unref();
      this.#pending.set(requestId, (p) => {
        clearTimeout(timer);
        res(p);
      });
    });
    try {
      await this.#d.channel.request(this.#d.jobId, {
        attemptId: this.#d.attemptId as QuestionRequestPayload['attemptId'],
        epoch: this.#d.epoch(),
        requestId,
        op,
      });
      return await answer;
    } catch (err) {
      this.#log.warn('question request not sent', { err: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      this.#pending.delete(requestId);
    }
  }

  async ask(args: Parameters<AskUserToolHost['ask']>[0], signal?: AbortSignal): Promise<Outcome> {
    if (this.#ended) return { ok: false, text: 'The job is ending; the question was not sent.' };
    const parsed = UserQuestions.safeParse(withQuestionIds(args.questions));
    if (!parsed.success) return { ok: false, text: 'invalid questions (ids must be unique)' };
    const questions = parsed.data;
    const timeoutSec = Math.min(
      args.timeoutSec ?? QUESTION_LIMITS.defaultTimeoutSec,
      this.#d.assigned.maxTimeoutSec,
    );
    const op: QuestionRequestOp = {
      kind: 'ask',
      ...(args.title === undefined ? {} : { title: args.title }),
      questions,
      timeoutSec,
    };
    // One request id for the ask and its retries: the master creates the set once (idempotent per job + request id).
    const requestId = randomUUID();
    let created: QuestionStatusPayload | null = null;
    for (let i = 0; i < 3 && created === null && !this.#isEnded() && signal?.aborted !== true; i++) {
      created = await this.#send(op, requestId);
    }
    if (created === null) return this.#noAnswer();
    if (created.state === 'refused' || created.questionId === undefined)
      return this.#format(created, questions);
    this.#asked.set(created.questionId, questions);
    this.#log.info('question asked', { questionId: created.questionId, questions: questions.length });
    return this.#waitFor(created.questionId, args.waitSec, signal, created);
  }

  async wait(questionId: string, waitSec: number | undefined, signal?: AbortSignal): Promise<Outcome> {
    return this.#waitFor(questionId, waitSec, signal, null);
  }

  async #waitFor(
    questionId: string,
    waitSec: number | undefined,
    signal: AbortSignal | undefined,
    first: QuestionStatusPayload | null,
  ): Promise<Outcome> {
    // p20-job-clock: the whole long poll is a human wait (the run clock stands still until the call returns).
    const key = `${questionId}:${randomUUID()}`;
    this.#signalWait(key, true);
    try {
      return await this.#poll(questionId, waitSec, signal, first);
    } finally {
      this.#signalWait(key, false);
    }
  }

  #signalWait(key: string, waiting: boolean): void {
    try {
      this.#d.onWait?.(key, waiting);
    } catch (err) {
      this.#log.warn('question wait hook failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  async #poll(
    questionId: string,
    waitSec: number | undefined,
    signal: AbortSignal | undefined,
    first: QuestionStatusPayload | null,
  ): Promise<Outcome> {
    const now = this.#d.now ?? Date.now;
    const budget = Math.min(waitSec ?? QUESTION_LIMITS.defaultWaitSec, QUESTION_LIMITS.maxWaitSec) * 1000;
    const deadline = now() + budget;
    let last = first;
    for (;;) {
      if (last === null) {
        const s = await this.#send({ kind: 'status', questionId });
        if (s === null) return this.#noAnswer(questionId);
        last = s;
      }
      if (!OPEN.has(last.state)) break;
      if (this.#ended) return { ok: false, text: 'The job is ending; the question is withdrawn.' };
      if (now() >= deadline || signal?.aborted === true) {
        return {
          ok: true,
          text:
            `No answer yet to question ${questionId}${last.deadlineAt === undefined ? '' : ` (open until ${last.deadlineAt})`}. ` +
            `Call wait_for_answer with questionId "${questionId}" to keep waiting, or continue with other work first.`,
        };
      }
      await this.#sleep(Math.min(this.#d.pollMs ?? 3_000, Math.max(0, deadline - now())), signal);
      last = null;
    }
    return this.#format(last, this.#asked.get(questionId) ?? null);
  }

  #noAnswer(questionId?: string): Outcome {
    if (this.#ended) return { ok: false, text: 'The job is ending; the question was not sent.' };
    return {
      ok: false,
      text:
        'The platform did not answer in time (connection to the master interrupted?).' +
        (questionId === undefined
          ? ' Try again.'
          : ` The question ${questionId} stays open; call wait_for_answer again.`),
    };
  }

  #format(s: QuestionStatusPayload, questions: readonly UserQuestion[] | null): Outcome {
    switch (s.state) {
      case 'refused':
        return {
          ok: false,
          text: `Refused (${s.reason ?? 'refused'}): ${s.detail ?? 'the platform did not accept this question.'}`,
        };
      case 'answered': {
        const by = s.answeredBy === undefined ? 'The user' : s.answeredBy;
        const body =
          questions === null || s.answers === undefined
            ? JSON.stringify(s.answers ?? [])
            : answersText(questions, s.answers);
        return { ok: true, text: `${by} answered question ${s.questionId ?? ''}:\n${body}` };
      }
      case 'expired':
        return {
          ok: true,
          text:
            `No answer: question ${s.questionId ?? ''} expired without an answer. Continue with your own best ` +
            'judgement and say in your result what you assumed.',
        };
      case 'cancelled':
        return {
          ok: true,
          text:
            `No answer: question ${s.questionId ?? ''} was withdrawn (${s.reason ?? 'cancelled'}). Continue with ` +
            'your own best judgement and say what you assumed.',
        };
      case 'pending':
        return { ok: true, text: `Question ${s.questionId ?? ''} is still open.` };
    }
  }
}
