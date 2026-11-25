// p20-decisions (docs/design/p20-decisions.md): one decision state — the badge counts
// without the person's put-off / ignored decisions (the master's list, the same set /needs and the home leave out); a
// job's merge approval is one block (no second "Değişiklikler" card while it is pending); a replaced plan card or a
// decision closed in the conversation folds without an action and leads to the current card.
import { messagesFor } from '@remyral/i18n';
import { describe, expect, it } from 'vitest';
import type { ThreadDetail } from '../src/api/chat';
import type { QuestionSet } from '../src/api/questions';
import { mergeDecisionPending } from '../src/diyalog/job/cards';
import { chatItems, type StripCard } from '../src/diyalog/ops/timeline';
import { closedText } from '../src/diyalog/questions/QuestionCard';
import { legacyDeferrals } from '../src/screens/home/deferrals';
import { badgeCounts } from '../src/shell/navBadges';

const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const PLAN = '5d3f2a10-0000-4000-8000-000000000001';
const PLAN2 = '5d3f2a10-0000-4000-8000-000000000002';
const Q1 = '9a0b1c2d-0000-4000-8000-000000000001';
const Q2 = '9a0b1c2d-0000-4000-8000-000000000002';
const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe('badge counts (p20-decisions)', () => {
  const src = {
    approvals: [{ id: 'a1' }, { id: 'a2' }],
    workers: [
      { id: 'w1', state: 'pending' },
      { id: 'w2', state: 'online' },
    ],
    chatUnread: 3,
    questions: [
      { id: 'q1', plan: null },
      { id: 'q2', plan: { id: 'p1' } },
      { id: 'q3', plan: { id: 'p1' } },
    ],
  } as never;

  it('counts everything when nothing is put off', () => {
    expect(badgeCounts(src, new Set())).toEqual({
      '/chat': 3,
      '/approvals': 2,
      '/machines': 1,
      '/questions': 3,
    });
  });

  it('leaves out an approval, a pairing, a question and a plan’s decisions the person put off or ignored', () => {
    const deferred = new Set(['approval:a1', 'pairing:w1', 'question:q1', 'plan:p1']);
    expect(badgeCounts(src, deferred)).toEqual({
      '/chat': 3,
      '/approvals': 1,
      '/machines': 0,
      '/questions': 0,
    });
  });

  it('an unreadable source has no badge', () => {
    expect(
      badgeCounts(
        { approvals: null, workers: null, chatUnread: null, questions: null },
        new Set(['approval:a1']),
      ),
    ).toEqual({ '/chat': 0, '/approvals': 0, '/machines': 0, '/questions': 0 });
  });
});

describe('the one-time move of the p19 browser lists (p20-decisions)', () => {
  it('keeps live entries with their end, drops expired and malformed ones', () => {
    const store = new Map<string, string>([
      [
        'remyral.needs.snoozed',
        JSON.stringify([
          `approval:a1|${String(NOW - 2 * 3600_000)}`,
          `approval:old|${String(NOW - 25 * 3600_000)}`,
          'no-colon|1',
        ]),
      ],
      ['remyral.home.dismissed', JSON.stringify(['failed:j1', `machine:w1|${String(NOW - 3600_000)}`])],
    ]);
    const storage = { getItem: (k: string) => store.get(k) ?? null } as Storage;
    const out = legacyDeferrals(NOW, storage);
    expect(out.map((i) => [i.key, i.mode, Date.parse(i.until ?? '') - NOW])).toEqual([
      ['approval:a1', 'snooze', 22 * 3600_000],
      ['failed:j1', 'ignore', 7 * 24 * 3600_000],
      ['machine:w1', 'ignore', 7 * 24 * 3600_000 - 3600_000],
    ]);
  });
});

describe('a job’s merge decision is one block (p20-decisions)', () => {
  it('the changes card stays away while the merge request’s approval is pending', () => {
    const open = { approvalRequestId: 'r1' } as never;
    expect(mergeDecisionPending(open, [{ id: 'r1', status: 'pending' }])).toBe(true);
    expect(mergeDecisionPending(open, [{ id: 'r1', status: 'approved' }])).toBe(false);
    expect(mergeDecisionPending(open, [{ id: 'r2', status: 'pending' }])).toBe(false);
    expect(mergeDecisionPending(null, [{ id: 'r1', status: 'pending' }])).toBe(false);
  });
});

describe('replaced and closed decision cards fold (p20-decisions)', () => {
  const msg = (
    seq: number,
    role: string,
    content: string,
    meta: unknown = null,
  ): Record<string, unknown> => ({
    id: `00000000-0000-4000-8000-0000000000${String(10 + seq)}`,
    seq,
    role,
    content,
    meta,
    turnId: null,
    createdAt: iso((30 - seq) * MIN),
  });
  const planTool = (seq: number, planId: string, v: number) =>
    msg(seq, 'tool', `plan_update_items: plan v${String(v)}`, {
      name: seq === 2 ? 'plan_create' : 'plan_update_items',
      isError: false,
      planId,
      planVersion: v,
    });
  const question = (id: string, over: Partial<QuestionSet>): QuestionSet =>
    ({
      id,
      source: 'assistant',
      jobId: null,
      threadId: THREAD,
      project: null,
      title: null,
      questions: [
        { id: 'q1', prompt: 'Dil?', kind: 'single', options: [{ label: 'Türkçe' }, { label: 'English' }] },
      ],
      state: 'pending',
      createdAt: iso(20 * MIN),
      deadlineAt: null,
      closedAt: null,
      closeReason: null,
      answers: null,
      answeredBy: null,
      answeredAt: null,
      planId: PLAN,
      planItemKey: 'a',
      ...over,
    }) as QuestionSet;
  const detail = (messages: unknown[], questions: QuestionSet[] = []): ThreadDetail =>
    ({
      thread: { id: THREAD, title: 'Plan', archived: false, createdAt: iso(60 * MIN), updatedAt: iso(MIN) },
      messages,
      drafts: [],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
      questions,
    }) as never;
  const cards = (d: ThreadDetail): StripCard[] =>
    chatItems(d).flatMap((i) => (i.kind === 'cards' ? [...i.cards] : []));

  it('an earlier turn’s card of the same plan leads to the newer one; the newest has no `newer`', () => {
    const all = cards(
      detail([
        msg(1, 'user', 'planla'),
        planTool(2, PLAN, 1),
        msg(3, 'assistant', 'hazır'),
        msg(4, 'user', 'b maddesini değiştir'),
        planTool(5, PLAN, 2),
        msg(6, 'assistant', 'güncelledim'),
      ]),
    );
    expect(all.map((c) => (c.kind === 'plan' ? [c.key, c.version, c.newer] : null))).toEqual([
      ['plan:00000000-0000-4000-8000-000000000012', 1, 'plan:00000000-0000-4000-8000-000000000015'],
      ['plan:00000000-0000-4000-8000-000000000015', 2, undefined],
    ]);
  });

  it('a decision its plan’s replacement closed leads to the new plan’s card; a settled one keeps its answer', () => {
    const replaced = question(Q1, {
      state: 'cancelled',
      closeReason: 'plan_superseded',
      closedAt: iso(5 * MIN),
    });
    const settled = question(Q2, {
      state: 'cancelled',
      closeReason: 'settled_in_chat',
      closeNote: 'Türkçe',
      closedAt: iso(5 * MIN),
    });
    const all = cards(
      detail(
        [
          msg(1, 'user', 'planla'),
          planTool(2, PLAN, 1),
          msg(3, 'tool', 'plan_ask_decision', { name: 'plan_ask_decision', isError: false, questionId: Q1 }),
          msg(4, 'tool', 'plan_ask_decision', { name: 'plan_ask_decision', isError: false, questionId: Q2 }),
          msg(5, 'assistant', 'karar lazım'),
          msg(6, 'user', 'yeni plan yap'),
          planTool(7, PLAN2, 1),
          msg(8, 'assistant', 'yeni plan'),
        ],
        [replaced, settled],
      ),
    );
    const q = (id: string) => all.find((c) => c.kind === 'question' && c.q.id === id);
    expect(q(Q1)).toMatchObject({ newer: 'plan:00000000-0000-4000-8000-000000000017' });
    expect(q(Q2)).not.toHaveProperty('newer');
    const tr = messagesFor('tr').questions.card;
    expect(closedText(settled, tr)).toBe('Sohbette karara bağlandı: Türkçe');
    expect(closedText(question(Q2, { state: 'cancelled', closeReason: 'settled_in_chat' }), tr)).toBe(
      'Sohbette karara bağlandı.',
    );
    expect(closedText(replaced, tr)).toBe('Yerine geçti: plan yenilendi, güncel kararlar yeni planda.');
    expect(closedText(question(Q1, { state: 'cancelled', closeReason: 'plan_done' }), tr)).toBe(
      'Plan kapandı; bu karar artık beklenmiyor.',
    );
  });
});
