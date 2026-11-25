import { createLogger, Redactor } from '@remyral/observability';
import type { QuestionRequestPayload, QuestionStatusPayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { JobQuestions } from '../src/jobs/questions.js';

/** p14-ask-user: the worker's question tool host (long poll over QUESTION_REQUEST / QUESTION_STATUS). */

const logger = createLogger({ level: 'error', redactor: new Redactor(), sink: () => undefined });
const ATTEMPT = '00000000-0000-4000-8000-0000000000a1';
const QID = '00000000-0000-4000-8000-0000000000b1';
const question = {
  prompt: 'Which environment?',
  kind: 'single' as const,
  options: [{ label: 'preview' }, { label: 'production' }],
};

type Answer = (
  p: QuestionRequestPayload,
  n: number,
) => Omit<QuestionStatusPayload, 'attemptId' | 'epoch' | 'requestId'> | null;

function host(
  answer: Answer,
  over: { maxTimeoutSec?: number; onWait?: (key: string, waiting: boolean) => void } = {},
) {
  const sent: QuestionRequestPayload[] = [];
  let now = 0;
  const q: JobQuestions = new JobQuestions({
    channel: {
      request: (_jobId, p) => {
        sent.push(p);
        const body = answer(p, sent.length);
        if (body !== null) {
          queueMicrotask(() => {
            q.onStatus({
              attemptId: p.attemptId,
              epoch: p.epoch,
              requestId: p.requestId,
              ...body,
            });
          });
        }
        return Promise.resolve();
      },
    },
    jobId: 'job-1',
    attemptId: ATTEMPT,
    epoch: () => 3,
    assigned: { maxTimeoutSec: over.maxTimeoutSec ?? 3600 },
    logger,
    answerTimeoutMs: 50,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
    ...(over.onWait === undefined ? {} : { onWait: over.onWait }),
  });
  return { q, sent };
}

describe('JobQuestions', () => {
  it('asks (ids assigned, timeout capped by the master), polls until answered, renders the answer', async () => {
    const { q, sent } = host(
      (p, n) => {
        if (p.op.kind === 'ask') return { state: 'pending', questionId: QID };
        return n < 4
          ? { state: 'pending', questionId: QID }
          : {
              state: 'answered',
              questionId: QID,
              answers: [{ id: 'q1', choices: ['preview'] }],
              answeredBy: 'alex',
            };
      },
      { maxTimeoutSec: 600 },
    );
    const out = await q.ask({ questions: [question], timeoutSec: 7200 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('alex answered');
    expect(out.text).toContain('[q1] Which environment?');
    expect(out.text).toContain('→ preview');
    const op = sent[0]?.op;
    expect(op).toMatchObject({ kind: 'ask', timeoutSec: 600, questions: [{ id: 'q1' }] });
    expect(sent.slice(1).every((p) => p.op.kind === 'status')).toBe(true);
  });

  it('returns "still open" after waitSec and wait_for_answer keeps waiting; expiry is "no answer"', async () => {
    const { q } = host((p) =>
      p.op.kind === 'ask' ? { state: 'pending', questionId: QID } : { state: 'pending', questionId: QID },
    );
    const out = await q.ask({ questions: [question], waitSec: 10 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain(`wait_for_answer with questionId "${QID}"`);
    const { q: q2 } = host(() => ({ state: 'expired', questionId: QID, reason: 'deadline' }));
    const late = await q2.wait(QID, 30);
    expect(late.text).toContain('No answer');
    expect(late.text).toContain('own best judgement');
  });

  it('a refused ask is reported; a lost answer retries the ask with the same request id', async () => {
    const { q } = host(() => ({ state: 'refused', reason: 'open_question', detail: 'already open' }));
    expect(await q.ask({ questions: [question] })).toEqual({
      ok: false,
      text: 'Refused (open_question): already open',
    });
    const { q: q2, sent } = host((p, n) =>
      n === 1 ? null : p.op.kind === 'ask' ? { state: 'expired', questionId: QID } : null,
    );
    const out = await q2.ask({ questions: [question] });
    expect(out.text).toContain('No answer');
    expect(sent[0]?.requestId).toBe(sent[1]?.requestId);
  });

  it('job end: blocked calls answer at once, new calls are refused, statuses of other attempts are ignored', async () => {
    const { q } = host(() => null);
    const pending = q.ask({ questions: [question] });
    q.end();
    expect((await pending).ok).toBe(false);
    expect((await q.ask({ questions: [question] })).text).toContain('job is ending');
    expect(
      q.onStatus({
        attemptId: '00000000-0000-4000-8000-0000000000ff',
        epoch: 3,
        requestId: 'x',
        state: 'pending',
      } as never),
    ).toBe(false);
  });

  it('refuses duplicate question ids', async () => {
    const { q, sent } = host(() => ({ state: 'pending', questionId: QID }));
    const out = await q.ask({
      questions: [
        { ...question, id: 'a' },
        { ...question, id: 'a' },
      ],
    });
    expect(out.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('p20-job-clock: the long poll is one human wait (start / end in pairs, also on the job end)', async () => {
    const waits: [string, boolean][] = [];
    const onWait = (key: string, waiting: boolean): void => {
      waits.push([key, waiting]);
    };
    const { q } = host(
      (p, n) =>
        p.op.kind === 'ask' || n < 3
          ? { state: 'pending', questionId: QID }
          : { state: 'answered', questionId: QID, answers: [{ id: 'q1', choices: ['preview'] }] },
      { onWait },
    );
    expect((await q.ask({ questions: [question] })).ok).toBe(true);
    expect(waits.map((w) => w[1])).toEqual([true, false]);
    expect(waits[0]?.[0]).toBe(waits[1]?.[0]);
    expect(waits[0]?.[0].startsWith(`${QID}:`)).toBe(true);
    // A wait_for_answer that gives up after waitSec ends its wait too; a hook that throws never breaks the call.
    const { q: q2 } = host(() => ({ state: 'pending', questionId: QID }), {
      onWait: () => {
        throw new Error('boom');
      },
    });
    expect((await q2.wait(QID, 5)).text).toContain('No answer yet');
    const { q: q3 } = host(() => null, { onWait });
    waits.length = 0;
    const pending = q3.wait(QID, 60);
    q3.end();
    await pending;
    expect(waits.map((w) => w[1])).toEqual([true, false]);
  });
});
