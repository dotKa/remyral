import {
  type QuestionAnswer,
  QuestionAnswers,
  type QuestionState,
  type UserQuestion,
  UserQuestions,
} from '@remyral/protocol/questions';
import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p14-ask-user (docs/design/p14-ask-user.md): question cards — asked by a job's agent (`ask_user` in-job tool) or by
 * the Sohbet assistant. Prompts, labels and descriptions are agent / model text: render as text only, never HTML.
 */

export type { QuestionAnswer, UserQuestion };
// p14-web-perf-2: the pending list lives apart (no zod schemas in the home / nav badges).
export { listPendingQuestions, type PendingQuestion } from './questionsPending';

export interface QuestionSet {
  readonly id: string;
  readonly source: 'job' | 'assistant';
  readonly jobId: string | null;
  readonly threadId: string | null;
  readonly project: string | null;
  readonly title: string | null;
  readonly questions: readonly UserQuestion[];
  readonly state: QuestionState;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  /** p20-decisions: what the conversation settled when a plan decision was closed in the chat (`settled_in_chat`). */
  readonly closeNote?: string;
  readonly answers: readonly QuestionAnswer[] | null;
  readonly answeredBy: { readonly id: string; readonly username: string } | null;
  readonly answeredAt: string | null;
  /** p18-plan-mode: a plan decision (answered without starting a turn); null / absent: not one. */
  readonly planId?: string | null;
  readonly planItemKey?: string | null;
}

const STATES = new Set(['pending', 'answered', 'expired', 'cancelled']);

export function parseQuestionSet(v: unknown): QuestionSet {
  const o = obj(v);
  const source = str(o, 'source');
  if (source !== 'job' && source !== 'assistant') throw new ShapeError('bad source');
  const state = str(o, 'state');
  if (!STATES.has(state)) throw new ShapeError('bad state');
  const qs = UserQuestions.safeParse(o.questions);
  const answers = o.answers === null || o.answers === undefined ? null : QuestionAnswers.safeParse(o.answers);
  const by = o.answeredBy === null || o.answeredBy === undefined ? null : obj(o.answeredBy);
  return {
    id: str(o, 'id'),
    source,
    jobId: nullableStr(o, 'jobId'),
    threadId: nullableStr(o, 'threadId'),
    project: nullableStr(o, 'project'),
    title: nullableStr(o, 'title'),
    questions: qs.success ? qs.data : [],
    state: state as QuestionState,
    createdAt: str(o, 'createdAt'),
    deadlineAt: nullableStr(o, 'deadlineAt'),
    closedAt: nullableStr(o, 'closedAt'),
    closeReason: nullableStr(o, 'closeReason'),
    ...(typeof o.closeNote === 'string' && o.closeNote !== '' ? { closeNote: o.closeNote } : {}),
    answers: answers === null ? null : answers.success ? answers.data : null,
    answeredBy: by === null ? null : { id: str(by, 'id'), username: str(by, 'username') },
    answeredAt: nullableStr(o, 'answeredAt'),
    ...(typeof o.planId === 'string'
      ? { planId: o.planId, planItemKey: typeof o.planItemKey === 'string' ? o.planItemKey : null }
      : {}),
  };
}

function list<T>(v: unknown, key: string, parse: (x: unknown) => T): T[] {
  const a = obj(v)[key];
  if (!Array.isArray(a)) throw new ShapeError(`expected array at ${key}`);
  return a.map(parse);
}

export function listJobQuestions(jobId: string, opts: RequestOptions = {}): Promise<QuestionSet[]> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/questions`,
    (v) => list(v, 'questions', parseQuestionSet),
    opts,
  );
}

export function answerJobQuestion(
  jobId: string,
  questionId: string,
  answers: readonly QuestionAnswer[],
): Promise<QuestionSet> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/questions/${encodeURIComponent(questionId)}/answer`,
    (v) => parseQuestionSet(obj(v).question),
    { body: { answers } },
  );
}

export function answerChatQuestion(
  threadId: string,
  questionId: string,
  answers: readonly QuestionAnswer[],
): Promise<{ question: QuestionSet; turnId: string | null }> {
  return apiRequest(
    'POST',
    `/chat/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/answer`,
    (v) => ({ question: parseQuestionSet(obj(v).question), turnId: nullableStr(obj(v), 'turnId') }),
    { body: { answers } },
  );
}

/** The question sets of a thread detail (`questions`, older masters: none). */
export function threadQuestions(v: unknown): QuestionSet[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    try {
      return [parseQuestionSet(x)];
    } catch {
      return [];
    }
  });
}
