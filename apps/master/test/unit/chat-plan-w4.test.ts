import { PlanUserEdit, type PlanLink } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyUserOps,
  derivedStatus,
  itemsFromCreate,
  type LinkFacts,
  outputJob,
  PlanOpError,
} from '../../src/chat/plan-model.js';
import { planNotice } from '../../src/chat/plan-notify.js';
import { type PlanItemView, waitingItems } from '../../src/chat/plans.js';
import { eventKey } from '../../src/chat/flow-model.js';

/** p18-plan-mode W4 (docs/design/p18-plan-mode.md, "Implementation (W4)"): the pure parts. */
const ITEMS = itemsFromCreate([
  {
    title: 'Hazırlık',
    items: [
      { key: 'a', title: 'A', owner: 'job' },
      { key: 'b', title: 'B', owner: 'assistant', dependsOn: ['a'] },
      { key: 'c', title: 'C', owner: 'user' },
    ],
  },
]);
const used = new Set(ITEMS.map((i) => i.key));

describe('the person edits dependencies (set_depends)', () => {
  it('sets, dedupes and makes a version', () => {
    const out = applyUserOps(ITEMS, [{ op: 'set_depends', key: 'c', dependsOn: ['a', 'b', 'a'] }], used);
    expect(out.items.find((i) => i.key === 'c')?.dependsOn).toEqual(['a', 'b']);
    expect(out.structural).toBe(true);
  });
  it('refuses a cycle, itself and an unknown item', () => {
    for (const dependsOn of [['b'], ['a', 'x']]) {
      const key = dependsOn[0] === 'b' ? 'a' : 'c';
      expect(() => applyUserOps(ITEMS, [{ op: 'set_depends', key, dependsOn }], used)).toThrow(PlanOpError);
    }
    expect(() => applyUserOps(ITEMS, [{ op: 'set_depends', key: 'a', dependsOn: ['a'] }], used)).toThrow(
      /depends on itself/,
    );
  });
  it('allows at most five (the REST schema)', () => {
    const ok = PlanUserEdit.safeParse({
      baseRev: 1,
      ops: [{ op: 'set_depends', key: 'c', dependsOn: ['a', 'b', 'd', 'e', 'f'] }],
    });
    expect(ok.success).toBe(true);
    const six = PlanUserEdit.safeParse({
      baseRev: 1,
      ops: [{ op: 'set_depends', key: 'c', dependsOn: ['a', 'b', 'd', 'e', 'f', 'g'] }],
    });
    expect(six.success).toBe(false);
  });
  it('a new phase from the panel: add one past the last phase with its title', () => {
    const out = applyUserOps(
      ITEMS,
      [{ op: 'add', item: { title: 'Yayınla' }, phase: 1, phaseTitle: 'Yayın', after: null }],
      used,
    );
    expect(out.items.at(-1)).toMatchObject({
      phase: 1,
      phaseTitle: 'Yayın',
      title: 'Yayınla',
      owner: 'user',
    });
  });
});

describe('derived status of pr / automation / output links', () => {
  const facts = (f: Partial<LinkFacts>): LinkFacts => ({
    drafts: new Map(),
    jobs: new Map(),
    runs: new Map(),
    ...f,
  });
  const PR = 'https://github.com/acme/app/pull/7';
  const A = '11111111-1111-4111-8111-111111111111';
  const J = '22222222-2222-4222-8222-222222222222';
  const D = '33333333-3333-4333-8333-333333333333';
  const pr: PlanLink[] = [{ kind: 'pr', id: PR }];
  it('pr: merged → done, closed → blocked, open → in progress, unknown → nothing', () => {
    const at = (state: 'open' | 'merged' | 'closed') =>
      derivedStatus(pr, facts({ prs: new Map([[PR, { state, reason: null }]]) }))?.status;
    expect(at('merged')).toBe('done');
    expect(at('closed')).toBe('blocked');
    expect(at('open')).toBe('in_progress');
    expect(derivedStatus(pr, facts({}))).toBeNull();
  });
  it('a PR after the job that made it wins (newest known link)', () => {
    const links: PlanLink[] = [{ kind: 'job', id: J }, ...pr];
    const f = facts({
      jobs: new Map([[J, { state: 'SUCCEEDED', summary: null }]]),
      prs: new Map([[PR, { state: 'open', reason: null }]]),
    });
    expect(derivedStatus(links, f)?.status).toBe('in_progress');
    // An unknown PR host: the job decides.
    expect(derivedStatus(links, facts({ jobs: f.jobs }))?.status).toBe('done');
  });
  it('automation: enabled or a run succeeded → done; first run failed / deleted → blocked; paused → in progress', () => {
    const auto = (a: {
      state: string;
      succeeded?: boolean;
      lastState?: string | null;
      lastReason?: string;
    }) =>
      derivedStatus(
        [{ kind: 'automation', id: A }],
        facts({
          automations: new Map([
            [
              A,
              {
                state: a.state,
                succeeded: a.succeeded ?? false,
                lastState: a.lastState ?? null,
                lastReason: a.lastReason ?? null,
              },
            ],
          ]),
        }),
      );
    expect(auto({ state: 'active' })?.status).toBe('done');
    expect(auto({ state: 'paused', succeeded: true })?.status).toBe('done');
    const failed = auto({ state: 'active', lastState: 'failed', lastReason: 'no machine' });
    expect(failed).toMatchObject({ status: 'blocked', note: 'no machine', target: 'failed' });
    expect(auto({ state: 'deleted' })?.status).toBe('blocked');
    expect(auto({ state: 'paused' })?.status).toBe('in_progress');
  });
  it('a confirmed automation card adds its automation as a link and follows it', () => {
    const d = derivedStatus(
      [{ kind: 'draft', id: D }],
      facts({
        drafts: new Map([[D, { state: 'confirmed', jobId: null, runId: null, automationId: A }]]),
        automations: new Map([[A, { state: 'active', succeeded: false, lastState: null, lastReason: null }]]),
      }),
    );
    expect(d).toMatchObject({ status: 'done', addLinks: [{ kind: 'automation', id: A }] });
  });
  it('output: follows its job (succeeded → done, failed → blocked)', () => {
    expect(outputJob(`job:${J}/out/report.pdf`)).toBe(J);
    expect(outputJob(`/jobs/${J.toUpperCase()}/outputs`)).toBe(J);
    expect(outputJob('report.pdf')).toBeNull();
    const out = (state: string) =>
      derivedStatus(
        [{ kind: 'output', id: `job:${J}/out/a.txt` }],
        facts({ jobs: new Map([[J, { state, summary: 'x' }]]) }),
      )?.status;
    expect(out('SUCCEEDED')).toBe('done');
    expect(out('FAILED')).toBe('blocked');
    expect(out('RUNNING')).toBe('in_progress');
    expect(derivedStatus([{ kind: 'output', id: 'a.txt' }], facts({}))).toBeNull();
  });
});

describe('plan notifications (chat.plan)', () => {
  const p = { planId: 'p1', title: 'Sürüm 2.4 planı' };
  it('one key per occurrence, in the plan’s language', () => {
    const d = planNotice('decision', 'tr', p, { occurrence: 'turn-1', prompt: 'Hangi ortam?', count: 2 });
    expect(d).toMatchObject({
      title: 'Plan senden karar bekliyor: Sürüm 2.4 planı',
      dedupeKey: 'chat.plan:p1:decision:turn-1',
      severity: 'warning',
    });
    expect(d.body).toContain('2 karar');
    expect(planNotice('done', 'en', p, { occurrence: 'done' })).toMatchObject({
      title: 'Plan done: Sürüm 2.4 planı',
      severity: 'info',
      dedupeKey: 'chat.plan:p1:done:done',
    });
    expect(planNotice('review', 'tr', p, { occurrence: '3', note: 'adım eklendi' }).body).toContain(
      'adım eklendi',
    );
    expect(planNotice('blocked', 'en', p, { occurrence: 'b:4', item: 'Deploy', note: 'no token' }).body).toBe(
      '“Deploy” cannot go on: no token',
    );
    expect(planNotice('waiting', 'tr', p, { occurrence: 'd1', item: 'Deploy' }).body).toContain(
      'kartı onaylaman',
    );
    expect(planNotice('waiting', 'en', p, { occurrence: 's', note: 'cost_brake' }).body).toContain(
      'cost_brake',
    );
  });
});

describe('what waits for the person in a plan (Senden bekleyen)', () => {
  const view = (over: Record<string, Partial<PlanItemView>>): PlanItemView[] =>
    ITEMS.map((i) => ({ ...i, decisionOpen: false, awaitsUser: false, failures: 0, ...(over[i.key] ?? {}) }));
  it('a waiting card, a blocked item that is not retried, the person’s own ready item', () => {
    expect(
      waitingItems(
        view({
          a: { status: 'in_progress', awaitsUser: true },
          b: { status: 'blocked', statusBy: 'assistant', note: 'needs token' },
          c: { status: 'pending' },
        }),
      ),
    ).toEqual([
      { key: 'a', title: 'A', why: 'card', note: null },
      { key: 'b', title: 'B', why: 'blocked', note: 'needs token' },
      { key: 'c', title: 'C', why: 'mine', note: null },
    ]);
  });
  it('a derived block that is retried, a decided item, a done item: nothing', () => {
    expect(
      waitingItems(
        view({
          a: { status: 'blocked', statusBy: 'derived', failures: 1 },
          c: { status: 'pending', decisionOpen: true },
          b: { status: 'done' },
        }),
      ),
    ).toEqual([]);
    expect(
      waitingItems(view({ a: { status: 'blocked', statusBy: 'derived', failures: 3 } })).map((w) => w.why),
    ).toEqual(['blocked', 'mine']);
  });
});

describe('flow keys (W4)', () => {
  it('decided / sched keys', () => {
    expect(eventKey('decided', 'ABC')).toBe('decided:abc');
    expect(eventKey('sched', 'x')).toBe('sched:x');
  });
});
