import { describe, expect, it } from 'vitest';
import {
  ChatPlanService,
  type ChatPlanDeps,
  likePattern,
  PLAN_LIST_STATES,
  planListCounts,
  planNeedsYou,
} from '../../src/chat/plans.js';

/** p18-plans-ui ("Planlar" screen, `GET /chat/plans`): the pure rules and the list read over a fake pool. */

const T0 = new Date('2026-10-29T10:00:00Z');
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const D1 = '00000000-0000-4000-8000-0000000000d1';

function planRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    thread_id: `${id.slice(0, -1)}f`,
    user_id: 'u1',
    title: `Plan ${id.slice(-1)}`,
    goal: 'g',
    meta: {},
    state: 'executing',
    version: 2,
    rev: 5,
    approved_version: 2,
    autonomous: true,
    cont_due: false,
    stalled: null,
    cont_turn: null,
    cont_mark: null,
    created_at: T0,
    updated_at: T0,
    closed_at: null,
    thread_title: 'Sohbet',
    archived_at: null,
    mine: true,
    projects: ['alpha', 'beta'],
    ...over,
  };
}

function item(planId: string, key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_id: planId,
    key,
    phase: 0,
    phase_title: 'Faz',
    position: key.charCodeAt(0),
    title: key.toUpperCase(),
    active_title: null,
    detail: null,
    status: 'pending',
    owner: 'job',
    project: null,
    depends_on: [],
    estimate: 'M',
    links: [],
    note: null,
    status_by: 'assistant',
    deleted_at: null,
    failures: 0,
    ...over,
  };
}

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function service(answers: {
  plans: Record<string, unknown>[];
  items?: Record<string, unknown>[];
  open?: Record<string, unknown>[];
  drafts?: Record<string, unknown>[];
  byState?: Record<string, unknown>[];
  needs?: Record<string, unknown>[];
}): { svc: ChatPlanService; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = sql.includes('FROM chat_plan_items WHERE plan_id = ANY')
        ? (answers.items ?? [])
        : sql.includes('FROM user_questions')
          ? (answers.open ?? [])
          : sql.includes('FROM chat_drafts')
            ? (answers.drafts ?? [])
            : sql.includes('GROUP BY p.state')
              ? (answers.byState ?? [])
              : sql.includes("p.state IN ('in_review', 'executing', 'paused')")
                ? (answers.needs ?? [])
                : answers.plans;
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  const svc = new ChatPlanService({ pool, clock: () => T0 } as unknown as ChatPlanDeps);
  return { svc, calls };
}

describe('plans list rules (p18-plans-ui)', () => {
  it('waits for the owner only: review, or executing / paused with a decision, a waiting item or a stall', () => {
    const base = {
      role: 'owner' as const,
      archived: false,
      state: 'executing' as const,
      stalled: null,
      openDecisions: 0,
      waiting: 0,
    };
    expect(planNeedsYou(base)).toBe(false);
    expect(planNeedsYou({ ...base, openDecisions: 1 })).toBe(true);
    expect(planNeedsYou({ ...base, waiting: 2 })).toBe(true);
    expect(planNeedsYou({ ...base, state: 'paused', stalled: 'budget' })).toBe(true);
    expect(planNeedsYou({ ...base, state: 'in_review' })).toBe(true);
    expect(planNeedsYou({ ...base, state: 'in_review', role: 'reader' })).toBe(false);
    expect(planNeedsYou({ ...base, state: 'in_review', archived: true })).toBe(false);
    expect(planNeedsYou({ ...base, state: 'done', openDecisions: 1 })).toBe(false);
  });

  it('counts per filter from the states', () => {
    const c = planListCounts(
      new Map([
        ['executing', 3],
        ['approved', 1],
        ['in_review', 2],
        ['paused', 1],
        ['done', 4],
        ['superseded', 2],
      ]),
      2,
    );
    expect(c).toEqual({
      total: 13,
      active: 7,
      executing: 4,
      review: 2,
      paused: 1,
      done: 4,
      cancelled: 2,
      needsYou: 2,
    });
    expect(PLAN_LIST_STATES.cancelled).toEqual(['cancelled', 'superseded']);
  });

  it('takes search text literally', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('ChatPlanService.list (p18-plans-ui)', () => {
  it('reads one page with the figures of each plan and the overview', async () => {
    const { svc, calls } = service({
      plans: [planRow(P1), planRow(P2, { state: 'done', mine: false, closed_at: T0 })],
      items: [
        item(P1, 'a', { status: 'done' }),
        item(P1, 'b', { status: 'in_progress', links: [{ kind: 'draft', id: D1, label: null }] }),
        item(P1, 'c', { owner: 'user' }),
        item(P2, 'a', { status: 'done' }),
      ],
      open: [{ plan_id: P1, item_key: null }],
      drafts: [{ id: D1 }],
      byState: [
        { state: 'executing', n: '1' },
        { state: 'done', n: '1' },
      ],
      needs: [planRow(P1)],
    });
    const page = await svc.list('u1', { scope: 'all' });
    expect(page.next).toBeNull();
    const [a, b] = page.items;
    expect(a).toMatchObject({
      id: P1,
      role: 'owner',
      title: 'Plan 1',
      autonomous: true,
      progress: { done: 1, total: 3 },
      openDecisions: 1,
      // b waits for its card, c is the person's own ready item.
      waiting: 2,
      needsYou: true,
      projects: ['alpha', 'beta'],
    });
    expect(a?.progress.remainingMinutes).not.toBeNull();
    expect(b).toMatchObject({ id: P2, role: 'reader', state: 'done', needsYou: false, waiting: 0 });
    expect(page.counts).toMatchObject({ total: 2, active: 1, executing: 1, done: 1, needsYou: 1 });
    // Shared conversations are part of the "all" scope.
    expect(calls[0]?.sql).toContain('chat_thread_shares');
  });

  it('passes filter, project, search and paging as parameters; a full page has a next offset', async () => {
    const { svc, calls } = service({ plans: [planRow(P1), planRow(P2), planRow(P1)] });
    const page = await svc.list('u1', {
      filter: 'review',
      project: 'alpha',
      q: 'web%',
      limit: 2,
      offset: 4,
    });
    expect(page.items).toHaveLength(2);
    expect(page.next).toBe(6);
    const first = calls[0];
    expect(first?.sql).toContain('t.user_id = $1');
    expect(first?.sql).not.toContain('t.user_id <> $1');
    expect(first?.params).toEqual(['u1', ['drafting', 'in_review'], 'alpha', '%web\\%%', 3, 4]);
  });

  it('the shared scope lists other people’s conversations shared with the caller and never counts needs', async () => {
    const { svc, calls } = service({ plans: [] });
    const page = await svc.list('u1', { scope: 'shared' });
    expect(page.items).toEqual([]);
    expect(calls[0]?.sql).toContain('t.user_id <> $1 AND EXISTS');
    expect(calls.some((c) => c.sql.includes("p.state IN ('in_review', 'executing', 'paused')"))).toBe(false);
    expect(page.counts.needsYou).toBe(0);
  });
});
