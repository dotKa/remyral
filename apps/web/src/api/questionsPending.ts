import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p14-ask-user: the pending question cards of the signed-in user (`GET /questions/pending`) — nav badge, home "Senden
 * bekleyenler". p14-web-perf-2: kept apart from `api/questions.ts` so that the home and the shell do not pull the
 * question schemas (zod) into their initial JS.
 */

export interface PendingQuestion {
  readonly id: string;
  readonly source: 'job' | 'assistant';
  readonly jobId: string | null;
  readonly jobTitle: string | null;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly project: string | null;
  readonly title: string | null;
  readonly prompt: string;
  readonly count: number;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  /** p18-plan-mode W4: a plan decision — its plan and item ("Senden bekleyen" groups it under the plan). */
  readonly plan?: {
    readonly id: string;
    readonly title: string;
    readonly itemKey: string | null;
    readonly itemTitle: string | null;
  } | null;
}

function planOf(v: unknown): NonNullable<PendingQuestion['plan']> | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string') return null;
  return {
    id: o.id,
    title: o.title,
    itemKey: typeof o.itemKey === 'string' ? o.itemKey : null,
    itemTitle: typeof o.itemTitle === 'string' ? o.itemTitle : null,
  };
}

function parsePending(v: unknown): PendingQuestion {
  const o = obj(v);
  const source = str(o, 'source');
  if (source !== 'job' && source !== 'assistant') throw new ShapeError('bad source');
  return {
    id: str(o, 'id'),
    source,
    jobId: nullableStr(o, 'jobId'),
    jobTitle: nullableStr(o, 'jobTitle'),
    threadId: nullableStr(o, 'threadId'),
    threadTitle: nullableStr(o, 'threadTitle'),
    project: nullableStr(o, 'project'),
    title: nullableStr(o, 'title'),
    prompt: str(o, 'prompt'),
    count: int(o, 'count'),
    createdAt: str(o, 'createdAt'),
    deadlineAt: nullableStr(o, 'deadlineAt'),
    plan: planOf(o.plan),
  };
}

export function listPendingQuestions(opts: RequestOptions = {}): Promise<PendingQuestion[]> {
  return apiRequest(
    'GET',
    '/questions/pending',
    (v) => {
      const a = obj(v).items;
      if (!Array.isArray(a)) throw new ShapeError('expected array at items');
      return a.map(parsePending);
    },
    opts,
  );
}
