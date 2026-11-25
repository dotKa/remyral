// p14-ask-user (docs/design/p14-ask-user.md): the question card (single / multi / text / "Diğer", keyboard, read-only
// answered view, agent text as text only), its place in the Sohbet timeline, the job page's card answering through
// the API, "Senden bekleyenler" and the inline "Cevap yaz".
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QuestionAnswer } from '@remyral/protocol/questions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadDetail } from '../src/api/chat';
import type { JobDetail } from '../src/api/jobs';
import type { QuestionSet } from '../src/api/questions';
import { chatItems } from '../src/diyalog/ops/timeline';
import { QuestionCard } from '../src/diyalog/questions/QuestionCard';
import { JobQuestionsCard } from '../src/diyalog/questions/JobQuestionsCard';
import { lastQuestionKey } from '../src/diyalog/job/ActivityLog';
import type { LogRow } from '../src/diyalog/job/log';
import { buildNeedsYou } from '../src/screens/home/needsYou';
import { fakeFetch } from './helpers';

const QID = '00000000-0000-4000-8000-0000000000b1';
const JOB = '00000000-0000-4000-8000-0000000000c1';
const XSS = '<img src=x onerror=alert(1)>';

function set(over: Partial<QuestionSet> = {}): QuestionSet {
  return {
    id: QID,
    source: 'job',
    jobId: JOB,
    threadId: null,
    project: 'shop',
    title: 'Deploy',
    questions: [
      {
        id: 'env',
        prompt: `Which environment? ${XSS}`,
        kind: 'single',
        options: [{ label: 'preview' }, { label: XSS, description: 'needs an approval' }],
        allowOther: true,
      },
      { id: 'langs', prompt: 'Languages?', kind: 'multi', options: [{ label: 'TR' }, { label: 'EN' }] },
      { id: 'note', prompt: 'Anything else?', kind: 'text' },
    ],
    state: 'pending',
    createdAt: new Date().toISOString(),
    deadlineAt: null,
    closedAt: null,
    closeReason: null,
    answers: null,
    answeredBy: null,
    answeredAt: null,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QuestionCard', () => {
  it('answers single, multi, text and Diğer; send stays disabled until every question is answered', async () => {
    const user = userEvent.setup();
    const sent: QuestionAnswer[][] = [];
    render(
      <QuestionCard
        set={set()}
        from="job"
        canAnswer
        onAnswer={(a) => {
          sent.push(a);
          return Promise.resolve();
        }}
      />,
    );
    const send = screen.getByRole('button', { name: /Cevabı gönder/ });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('radio', { name: /preview/ }));
    await user.click(screen.getByRole('checkbox', { name: /TR/ }));
    await user.click(screen.getByRole('checkbox', { name: /EN/ }));
    await user.type(screen.getByRole('textbox', { name: 'Anything else?' }), 'ship it');
    expect((send as HTMLButtonElement).disabled).toBe(false);
    // "Diğer" replaces the single choice and needs its own text.
    await user.click(screen.getByRole('radio', { name: /Diğer/ }));
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Diğer' }), 'staging');
    await user.click(send);
    expect(sent).toEqual([
      [
        { id: 'env', other: 'staging' },
        { id: 'langs', choices: ['TR', 'EN'] },
        { id: 'note', text: 'ship it' },
      ],
    ]);
  });

  it('a note can be added to an answer, and an answered set shows it (p19-plan-decide)', async () => {
    const user = userEvent.setup();
    const sent: QuestionAnswer[][] = [];
    const one = set({ questions: [set().questions[0] as QuestionSet['questions'][number]] });
    const { rerender } = render(
      <QuestionCard
        set={one}
        from="assistant"
        canAnswer
        onAnswer={(a) => {
          sent.push(a);
          return Promise.resolve();
        }}
      />,
    );
    await user.click(screen.getByRole('radio', { name: /preview/ }));
    await user.click(screen.getByTestId('question-add-note'));
    await user.type(screen.getByTestId('question-note'), 'yeni tasarımla');
    await user.click(screen.getByRole('button', { name: /Cevabı gönder/ }));
    expect(sent).toEqual([[{ id: 'env', choices: ['preview'], note: 'yeni tasarımla' }]]);
    rerender(
      <QuestionCard
        set={{
          ...one,
          state: 'answered',
          answers: [{ id: 'env', choices: ['preview'], note: 'yeni tasarımla' }],
          answeredBy: { id: 'u', username: 'alex' },
          answeredAt: new Date().toISOString(),
        }}
        from="assistant"
        canAnswer
        onAnswer={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText('Not: yeni tasarımla')).toBeTruthy();
  });

  it('keyboard: digits pick options, arrows move between checkboxes, Enter sends', async () => {
    const sent: QuestionAnswer[][] = [];
    const s = set({
      questions: [
        { id: 'env', prompt: 'Env?', kind: 'single', options: [{ label: 'a' }, { label: 'b' }] },
        { id: 'langs', prompt: 'Langs?', kind: 'multi', options: [{ label: 'x' }, { label: 'y' }] },
      ],
    });
    render(
      <QuestionCard
        set={s}
        from="assistant"
        canAnswer
        onAnswer={(a) => {
          sent.push(a);
          return Promise.resolve();
        }}
      />,
    );
    const a = screen.getByRole('radio', { name: /a/ });
    a.focus();
    fireEvent.keyDown(a, { key: '2' });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /b/ }).checked).toBe(true);
    const x = screen.getByRole('checkbox', { name: /x/ });
    x.focus();
    fireEvent.keyDown(x, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: /y/ }));
    fireEvent.keyDown(screen.getByRole('checkbox', { name: /y/ }), { key: '1' });
    expect((x as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(x, { key: 'Enter' });
    await waitFor(() => {
      expect(sent).toEqual([
        [
          { id: 'env', choices: ['b'] },
          { id: 'langs', choices: ['x'] },
        ],
      ]);
    });
  });

  it('agent text is rendered as text, never as HTML', () => {
    const { container } = render(
      <QuestionCard set={set()} from="job" canAnswer onAnswer={() => Promise.resolve()} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.getAllByText(new RegExp(XSS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length,
    ).toBeGreaterThan(0);
  });

  it('answered sets are read-only with the answer, who and when; expired / superseded say so', () => {
    const { rerender } = render(
      <QuestionCard
        set={set({
          state: 'answered',
          answers: [
            { id: 'env', other: 'staging' },
            { id: 'langs', choices: ['TR'] },
            { id: 'note', text: 'done' },
          ],
          answeredBy: { id: 'u1', username: 'alex' },
          answeredAt: new Date().toISOString(),
        })}
        from="job"
        canAnswer
        onAnswer={() => Promise.resolve()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Cevabı gönder/ })).toBeNull();
    expect(screen.getByText('Diğer: staging')).toBeTruthy();
    expect(screen.getByText(/alex cevapladı/)).toBeTruthy();
    rerender(
      <QuestionCard
        set={set({ state: 'expired' })}
        from="job"
        canAnswer
        onAnswer={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText(/Cevapsız kaldı/)).toBeTruthy();
    rerender(
      <QuestionCard
        set={set({ state: 'cancelled', closeReason: 'superseded', source: 'assistant' })}
        from="assistant"
        canAnswer
        onAnswer={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText(/sohbete yazarak/)).toBeTruthy();
  });

  it('while the assistant still answers: choices kept, sending waits; viewers cannot answer', async () => {
    const user = userEvent.setup();
    const s = set({
      questions: [{ id: 'env', prompt: 'Env?', kind: 'single', options: [{ label: 'a' }, { label: 'b' }] }],
    });
    const { rerender } = render(
      <QuestionCard set={s} from="assistant" canAnswer waiting onAnswer={() => Promise.resolve()} />,
    );
    await user.click(screen.getByRole('radio', { name: /a/ }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Cevabı gönder/ }).disabled).toBe(true);
    expect(screen.getByText(/Remyral yanıtını bitirince/)).toBeTruthy();
    rerender(<QuestionCard set={s} from="assistant" canAnswer onAnswer={() => Promise.resolve()} />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /a/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Cevabı gönder/ }).disabled).toBe(false);
    rerender(<QuestionCard set={s} from="job" canAnswer={false} onAnswer={() => Promise.resolve()} />);
    expect(screen.getByText(/cevap verme yetkin yok/)).toBeTruthy();
  });

  it('shows the API error (409 question_closed) in the card', async () => {
    const user = userEvent.setup();
    const s = set({
      questions: [{ id: 'env', prompt: 'Env?', kind: 'single', options: [{ label: 'a' }, { label: 'b' }] }],
    });
    const err = Object.assign(new Error('closed'), { name: 'ApiError' });
    render(<QuestionCard set={s} from="job" canAnswer onAnswer={() => Promise.reject(err)} />);
    await user.click(screen.getByRole('radio', { name: /a/ }));
    await user.click(screen.getByRole('button', { name: /Cevabı gönder/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('question cards in the chat, the job page and the inbox', () => {
  it('the Sohbet timeline places the card in the strip after the turn that asked it; the answer message is hidden', () => {
    const t = new Date().toISOString();
    const detail = {
      thread: { id: 't1', title: 'x', archived: false, createdAt: t, updatedAt: t },
      messages: [
        { id: 'm1', seq: 1, role: 'user', content: 'deploy?', meta: null, turnId: null, createdAt: t },
        {
          id: 'm2',
          seq: 2,
          role: 'tool',
          content: 'ask_user: question card shown',
          meta: { name: 'ask_user', questionId: QID },
          turnId: 'k',
          createdAt: t,
        },
        {
          id: 'm3',
          seq: 3,
          role: 'user',
          content: 'Answer to your questions…',
          meta: { answerTo: QID },
          turnId: null,
          createdAt: t,
        },
      ],
      drafts: [],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
      questions: [set({ source: 'assistant', jobId: null, threadId: 't1' })],
    } as unknown as ThreadDetail;
    const items = chatItems(detail);
    // p15-chat-cards-scroll: the turn's cards follow its last row as one strip.
    expect(items.map((i) => i.kind)).toEqual(['row', 'row', 'cards']);
    expect(items.at(-1)).toMatchObject({ key: 'cards:m:m1', pending: false });
    const strip = items.at(-1);
    expect(strip?.kind === 'cards' ? strip.cards.map((c) => c.key) : []).toEqual([`question:${QID}`]);
  });

  it('the job card lists open questions and answers through POST /jobs/:id/questions/:qid/answer', async () => {
    const user = userEvent.setup();
    const s = set({
      questions: [{ id: 'env', prompt: 'Env?', kind: 'single', options: [{ label: 'a' }, { label: 'b' }] }],
    });
    const answered = {
      ...s,
      state: 'answered',
      answers: [{ id: 'env', choices: ['b'] }],
      answeredBy: { id: 'u', username: 'alex' },
      answeredAt: s.createdAt,
    };
    const f = fakeFetch({
      [`GET /api/jobs/${JOB}/questions`]: () => ({ status: 200, body: { questions: [s] } }),
      [`POST /api/jobs/${JOB}/questions/${QID}/answer`]: () => ({
        status: 200,
        body: { question: answered },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const props = {
      detail: { job: { id: JOB } } as unknown as JobDetail,
      state: 'RUNNING',
      finished: true,
      canAct: true,
      reload: () => undefined,
      names: new Map<string, string>(),
      onCancel: () => undefined,
      detailsHref: () => '',
      continuity: null,
      memory: null,
    };
    render(<JobQuestionsCard {...props} />);
    await user.click(await screen.findByRole('radio', { name: /b/ }));
    await user.click(screen.getByRole('button', { name: /Cevabı gönder/ }));
    await waitFor(() => {
      expect(screen.getByText(/Önceki sorular/)).toBeTruthy();
    });
    const post = f.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({ answers: [{ id: 'env', choices: ['b'] }] });
    await act(() => Promise.resolve());
  });

  it('"Senden bekleyenler" lists pending questions with an answer link', () => {
    const items = buildNeedsYou(
      {
        approvals: [],
        failed: [],
        blocked: [],
        workers: [],
        overview: [],
        questions: [
          {
            id: QID,
            source: 'job',
            jobId: JOB,
            jobTitle: 'Deploy the shop',
            threadId: null,
            threadTitle: null,
            project: 'shop',
            title: null,
            prompt: 'Env?',
            count: 1,
            createdAt: new Date().toISOString(),
            deadlineAt: null,
          },
        ],
      },
      Date.now(),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: 'question', action: { label: 'Answer', href: `/jobs/${JOB}` } }),
    ]);
  });

  it('inline "Cevap yaz" only when the agent\'s last line asks a question', () => {
    const row = (key: string, who: 'agent' | 'me', text: string): LogRow => ({
      kind: 'text',
      key,
      at: '',
      group: 'agent',
      icon: 'bubble',
      who,
      text,
      body: null,
      markdown: true,
      error: false,
    });
    expect(lastQuestionKey([row('a', 'agent', 'Done. Which branch should I use?')])).toBe('a');
    expect(lastQuestionKey([row('a', 'agent', 'Which?'), row('b', 'me', 'main')])).toBeNull();
    expect(lastQuestionKey([row('a', 'agent', 'All done.')])).toBeNull();
  });
});
