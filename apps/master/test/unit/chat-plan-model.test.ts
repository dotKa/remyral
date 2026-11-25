import { ASSISTANT_TOOL_NAMES, ASSISTANT_TOOLS, type PlanLink } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyUpdateOps,
  applyUserOps,
  checkStatusChange,
  derivedStatus,
  diffCounts,
  diffItems,
  diffSnapshots,
  failuresAfter,
  itemsFromCreate,
  type LinkFacts,
  planBlock,
  type PlanItem,
  PLAN_AUTONOMY_INSTRUCTION,
  PLAN_ITEM_FAILURE_CAP,
  PlanOpError,
  type PlanSnapshot,
  planModeRefusal,
  progressMark,
  progressOf,
  remainingMinutes,
  readyItems,
  shapeOf,
  userEditView,
} from '../../src/chat/plan-model.js';

/** p18-plan-mode (docs/design/p18-plan-mode.md §6): the pure rules of a plan. */
const ITEMS = itemsFromCreate([
  {
    title: 'Hazırlık',
    items: [
      { key: 'tests', title: 'Testleri düzelt', owner: 'job', estimate: 'M' },
      { key: 'notes', title: 'Changelog yaz', owner: 'assistant', dependsOn: ['tests'], estimate: 30 },
    ],
  },
  {
    title: 'Yayın',
    items: [
      { key: 'tag', title: 'Sürüm etiketi', owner: 'user', dependsOn: ['notes'] },
      { key: 'deploy', title: 'Deploy', owner: 'workflow', dependsOn: ['tag'] },
    ],
  },
]);
const snap = (items: readonly PlanItem[]): PlanSnapshot => ({
  title: 'Sürüm 2.4',
  goal: 'Yayına çıksın',
  assumptions: [],
  risks: [],
  items: items.map(shapeOf),
});
const withStatus = (items: readonly PlanItem[], s: Record<string, Partial<PlanItem>>): PlanItem[] =>
  items.map((i) => ({ ...i, ...(s[i.key] ?? {}) }));
const used = (items: readonly PlanItem[]): Set<string> => new Set(items.map((i) => i.key));

describe('plan mode tool matrix (every catalog tool)', () => {
  it('plan mode allows only read tools, ask_user, plan tools (not plan_propose) and set_chat_title', () => {
    for (const name of ASSISTANT_TOOL_NAMES) {
      const kind = ASSISTANT_TOOLS[name].kind as string;
      const inPlan = planModeRefusal(name, true);
      if (name === 'plan_propose') expect(inPlan, name).toBe('plan_mode_active');
      else if (kind === 'read' || kind === 'plan' || name === 'ask_user' || name === 'set_chat_title')
        expect(inPlan, name).toBeNull();
      else expect(inPlan, name).toBe('plan_mode_read_only');
      // Outside plan mode only plan_create is refused.
      expect(planModeRefusal(name, false), name).toBe(name === 'plan_create' ? 'plan_mode_required' : null);
    }
    expect(planModeRefusal('draft_job', true)).toBe('plan_mode_read_only');
    expect(planModeRefusal('notify_when', true)).toBe('plan_mode_read_only');
    expect(planModeRefusal('create_watch', true)).toBe('plan_mode_read_only');
    expect(planModeRefusal('start_service', true)).toBe('plan_mode_read_only');
  });
});

describe('operations', () => {
  it('numbers phases and positions from plan_create', () => {
    expect(ITEMS.map((i) => [i.key, i.phase, i.position])).toEqual([
      ['tests', 0, 0],
      ['notes', 0, 1],
      ['tag', 1, 0],
      ['deploy', 1, 1],
    ]);
  });

  it('adds, moves (across phases), removes (dropping dependencies), never reuses a key', () => {
    const r = applyUpdateOps(
      ITEMS,
      [
        { op: 'add', item: { key: 'smoke', title: 'Smoke test', owner: 'job' }, phase: 1, after: 'tag' },
        { op: 'move', key: 'notes', phase: 1, after: null },
        { op: 'remove', key: 'tag' },
        { op: 'add', item: { key: 'post', title: 'Duyuru', owner: 'user' }, phase: 2, phaseTitle: 'Sonra' },
      ],
      used(ITEMS),
    );
    expect(r.removed).toEqual(['tag']);
    expect(r.items.map((i) => [i.key, i.phase, i.position, i.phaseTitle])).toEqual([
      ['tests', 0, 0, 'Hazırlık'],
      ['notes', 1, 0, 'Yayın'],
      ['smoke', 1, 1, 'Yayın'],
      ['deploy', 1, 2, 'Yayın'],
      ['post', 2, 0, 'Sonra'],
    ]);
    expect(r.items.find((i) => i.key === 'deploy')?.dependsOn).toEqual([]);
    expect(() =>
      applyUpdateOps(
        r.items,
        [{ op: 'add', item: { key: 'tag', title: 'x', owner: 'job' }, phase: 0 }],
        new Set([...used(ITEMS), 'smoke', 'post']),
      ),
    ).toThrow(PlanOpError);
  });

  it('refuses cycles, unknown dependencies, done items and a phase that does not exist', () => {
    expect(() =>
      applyUpdateOps(ITEMS, [{ op: 'set_depends', key: 'tests', dependsOn: ['deploy'] }], used(ITEMS)),
    ).toThrow(/cycle/);
    expect(() =>
      applyUpdateOps(ITEMS, [{ op: 'set_depends', key: 'tests', dependsOn: ['nope'] }], used(ITEMS)),
    ).toThrow(/not in the plan/);
    const done = withStatus(ITEMS, { tests: { status: 'done' } });
    expect(() => applyUpdateOps(done, [{ op: 'rename', key: 'tests', title: 'x' }], used(ITEMS))).toThrow(
      /done/,
    );
    expect(() =>
      applyUpdateOps(ITEMS, [{ op: 'move', key: 'tests', phase: 5, after: null }], used(ITEMS)),
    ).toThrow(/does not exist/);
  });

  it('the person: skip / unskip / done_mine are not structural; assign_me and rename are', () => {
    const a = applyUserOps(ITEMS, [{ op: 'skip', key: 'deploy' }], used(ITEMS));
    expect(a.structural).toBe(false);
    expect(a.items.find((i) => i.key === 'deploy')?.status).toBe('skipped');
    const b = applyUserOps(
      a.items,
      [
        { op: 'unskip', key: 'deploy' },
        { op: 'done_mine', key: 'tag' },
      ],
      used(ITEMS),
    );
    expect(b.structural).toBe(false);
    expect(b.doneMine).toEqual(['tag']);
    expect(b.items.find((i) => i.key === 'tag')).toMatchObject({ status: 'done', statusBy: 'user' });
    expect(() => applyUserOps(ITEMS, [{ op: 'done_mine', key: 'notes' }], used(ITEMS))).toThrow(/not yours/);
    const c = applyUserOps(
      ITEMS,
      [
        { op: 'assign_me', key: 'notes' },
        { op: 'add', item: { title: 'Kontrol' }, phase: 0 },
      ],
      used(ITEMS),
    );
    expect(c.structural).toBe(true);
    expect(c.items[0]).toMatchObject({ key: 'u1', owner: 'user', title: 'Kontrol' });
  });
});

describe('versions and diff', () => {
  it('counts added / removed / changed / moved per key', () => {
    const r = applyUpdateOps(
      ITEMS,
      [
        { op: 'add', item: { key: 'smoke', title: 'Smoke', owner: 'job' }, phase: 1, after: 'tag' },
        { op: 'remove', key: 'deploy' },
        { op: 'rename', key: 'notes', title: 'Changelog ve notlar' },
        { op: 'move', key: 'tests', phase: 0, after: 'notes' },
      ],
      used(ITEMS),
    );
    const d = diffSnapshots(snap(ITEMS), snap(r.items));
    expect(d.added).toEqual(['smoke']);
    expect(d.removed).toEqual(['deploy']);
    expect(d.changed).toEqual([{ key: 'notes', fields: ['title'] }]);
    expect(d.moved.length).toBe(1);
    expect(diffCounts(d)).toEqual({ added: 1, removed: 1, changed: 1, moved: 1 });
    // A pure insertion moves nothing; v1 ↔ v1 is empty.
    expect(diffSnapshots(snap(ITEMS), snap(ITEMS))).toMatchObject({
      added: [],
      removed: [],
      changed: [],
      moved: [],
    });
  });
});

describe('status rules', () => {
  it('done is final, one assistant item in progress, derived items keep their status', () => {
    const done = withStatus(ITEMS, { notes: { status: 'done' } });
    expect(checkStatusChange(done, 'notes', 'pending', undefined)).toMatch(/final/);
    const two = itemsFromCreate([
      {
        title: 'P',
        items: [
          { key: 'a', title: 'A', owner: 'assistant' },
          { key: 'b', title: 'B', owner: 'assistant' },
        ],
      },
    ]);
    const running = withStatus(two, { a: { status: 'in_progress' } });
    expect(checkStatusChange(running, 'b', 'in_progress', undefined)).toMatch(/one assistant item at a time/);
    expect(checkStatusChange(running, 'a', 'done', undefined)).toBeNull();
    const linked = withStatus(ITEMS, {
      tests: { status: 'in_progress', links: [{ kind: 'job', id: '11111111-1111-4111-8111-111111111111' }] },
    });
    expect(checkStatusChange(linked, 'tests', 'done', undefined)).toMatch(/follows its job/);
    expect(checkStatusChange(linked, 'tests', 'blocked', 'flaky runner')).toBeNull();
    expect(checkStatusChange(ITEMS, 'nope', 'done', undefined)).toMatch(/No item/);
  });

  it('readiness: dependencies done / skipped, not the person’s own, no open decision', () => {
    expect(readyItems(ITEMS).map((i) => i.key)).toEqual(['tests']);
    const after = withStatus(ITEMS, { tests: { status: 'done' } });
    expect(readyItems(after).map((i) => i.key)).toEqual(['notes']);
    expect(readyItems(after, new Set(['notes']))).toEqual([]);
    const tagDone = withStatus(ITEMS, { tests: { status: 'done' }, notes: { status: 'skipped' } });
    expect(readyItems(tagDone).map((i) => i.key)).toEqual([]); // `tag` is the person's
  });

  it('remaining time: parallel job items share time, assistant items queue, an item in progress counts half', () => {
    const plan = itemsFromCreate([
      {
        title: 'P',
        items: [
          { key: 'a', title: 'A', owner: 'job', estimate: 'L' },
          { key: 'b', title: 'B', owner: 'job', estimate: 'L' },
          { key: 'c', title: 'C', owner: 'workflow', dependsOn: ['a', 'b'], estimate: 'M' },
          { key: 'd', title: 'D', owner: 'assistant', estimate: 'L' },
          { key: 'e', title: 'E', owner: 'assistant', estimate: 'L' },
          { key: 'f', title: 'F', owner: 'user', dependsOn: ['c'], estimate: 'L' },
        ],
      },
    ]);
    // a ∥ b (45) → c (20) = 65; d → e queued = 30; the person's f counts 0.
    expect(remainingMinutes(plan)).toBe(65);
    expect(remainingMinutes(withStatus(plan, { a: { status: 'in_progress' }, b: { status: 'done' } }))).toBe(
      43,
    );
    expect(remainingMinutes(withStatus(plan, { a: { status: 'skipped' }, b: { status: 'skipped' } }))).toBe(
      30,
    );
  });

  it('progress and estimates; the progress mark changes with any status or link', () => {
    // Agent time on the critical path: tests (job, M = 20) then notes (30 min, after tests); tag is the person's.
    expect(progressOf(ITEMS)).toEqual({ done: 0, total: 4, skipped: 0, remainingMinutes: 50 });
    const p = withStatus(ITEMS, { tests: { status: 'done' }, deploy: { status: 'skipped' } });
    expect(progressOf(p)).toMatchObject({ done: 1, total: 3, skipped: 1, remainingMinutes: 30 });
    expect(progressMark(ITEMS, 0, 1)).toBe(progressMark(ITEMS, 0, 1));
    expect(progressMark(p, 0, 1)).not.toBe(progressMark(ITEMS, 0, 1));
    expect(progressMark(ITEMS, 1, 1)).not.toBe(progressMark(ITEMS, 0, 1));
  });
});

describe('derived status', () => {
  const J = '22222222-2222-4222-8222-222222222222';
  const R = '33333333-3333-4333-8333-333333333333';
  const D = '44444444-4444-4444-8444-444444444444';
  const facts = (f: Partial<LinkFacts>): LinkFacts => ({
    drafts: f.drafts ?? new Map(),
    jobs: f.jobs ?? new Map(),
    runs: f.runs ?? new Map(),
  });
  const card: PlanLink[] = [{ kind: 'draft', id: D }];

  it('a card waits, a confirmed card follows its job (added as a link), a dismissed card blocks', () => {
    expect(
      derivedStatus(card, facts({ drafts: new Map([[D, { state: 'proposed', jobId: null, runId: null }]]) })),
    ).toMatchObject({ status: 'in_progress', target: 'waiting', addLinks: [] });
    const confirmed = derivedStatus(
      card,
      facts({
        drafts: new Map([[D, { state: 'confirmed', jobId: J, runId: null }]]),
        jobs: new Map([[J, { state: 'RUNNING', summary: null }]]),
      }),
    );
    expect(confirmed).toMatchObject({
      status: 'in_progress',
      target: 'running',
      addLinks: [{ kind: 'job', id: J }],
    });
    expect(
      derivedStatus(
        card,
        facts({ drafts: new Map([[D, { state: 'dismissed', jobId: null, runId: null }]]) }),
      ),
    ).toMatchObject({ status: 'blocked', note: 'card dismissed' });
  });

  it('jobs: succeeded → done, failed → blocked with the summary, cancelled → blocked; runs alike', () => {
    const job: PlanLink[] = [{ kind: 'job', id: J }];
    expect(
      derivedStatus(job, facts({ jobs: new Map([[J, { state: 'SUCCEEDED', summary: 'ok' }]]) })),
    ).toMatchObject({
      status: 'done',
      note: null,
    });
    expect(
      derivedStatus(
        job,
        facts({ jobs: new Map([[J, { state: 'FAILED', summary: '3 tests failed\nmore' }]]) }),
      ),
    ).toMatchObject({ status: 'blocked', note: '3 tests failed more' });
    expect(
      derivedStatus(job, facts({ jobs: new Map([[J, { state: 'CANCELLED', summary: null }]]) })),
    ).toMatchObject({
      status: 'blocked',
    });
    const run: PlanLink[] = [{ kind: 'workflow_run', id: R }];
    expect(
      derivedStatus(run, facts({ runs: new Map([[R, { state: 'running', reason: null }]]) })),
    ).toMatchObject({
      status: 'in_progress',
    });
    expect(
      derivedStatus(run, facts({ runs: new Map([[R, { state: 'failed', reason: 'step 2' }]]) })),
    ).toMatchObject({
      status: 'blocked',
      note: 'step 2',
    });
    // The newest job / run link wins.
    expect(
      derivedStatus(
        [...job, ...run],
        facts({
          jobs: new Map([[J, { state: 'FAILED', summary: null }]]),
          runs: new Map([[R, { state: 'succeeded', reason: null }]]),
        }),
      ),
    ).toMatchObject({ status: 'done' });
    expect(derivedStatus([{ kind: 'url', id: 'https://x' }], facts({}))).toBeNull();
  });
});

describe('p18-plan-autonomy: retries and the failure cap', () => {
  const J = '22222222-2222-4222-8222-222222222222';
  const D = '44444444-4444-4444-8444-444444444444';
  const D2 = '55555555-5555-4555-8555-555555555555';
  const facts = (f: Partial<LinkFacts>): LinkFacts => ({
    drafts: f.drafts ?? new Map(),
    jobs: f.jobs ?? new Map(),
    runs: f.runs ?? new Map(),
  });
  const failedJob = facts({
    drafts: new Map([
      [D, { state: 'confirmed', jobId: J, runId: null }],
      [D2, { state: 'proposed', jobId: null, runId: null }],
    ]),
    jobs: new Map([[J, { state: 'FAILED', summary: 'tests failed' }]]),
  });

  it('a retry card after a failed job is what the item waits for (not the old failure)', () => {
    const links: PlanLink[] = [
      { kind: 'draft', id: D },
      { kind: 'job', id: J },
    ];
    expect(derivedStatus(links, failedJob)).toMatchObject({ status: 'blocked', target: 'failed' });
    expect(derivedStatus([...links, { kind: 'draft', id: D2 }], failedJob)).toMatchObject({
      status: 'in_progress',
      target: 'waiting',
      note: null,
    });
  });

  it('a failed job / run counts once when it blocks the item; done clears; cancelled and dismissed do not count', () => {
    const failed = derivedStatus([{ kind: 'job', id: J }], failedJob);
    if (failed === null) throw new Error('no derivation');
    expect(failuresAfter('in_progress', failed, 0)).toBe(1);
    expect(failuresAfter('in_progress', failed, 2)).toBe(PLAN_ITEM_FAILURE_CAP);
    expect(failuresAfter('blocked', failed, 1)).toBeNull();
    expect(failuresAfter('in_progress', { ...failed, status: 'done', target: 'succeeded' }, 2)).toBe(0);
    expect(failuresAfter('in_progress', { ...failed, status: 'done', target: 'succeeded' }, 0)).toBeNull();
    expect(failuresAfter('in_progress', { ...failed, target: 'cancelled' }, 1)).toBeNull();
    expect(failuresAfter('in_progress', { ...failed, target: 'dismissed' }, 1)).toBeNull();
    expect(PLAN_ITEM_FAILURE_CAP).toBe(3);
  });

  it('the plan block says autonomous only while an autonomous plan executes; the instruction says act, do not ask', () => {
    const at = (state: 'executing' | 'paused', autonomous: boolean): string =>
      planBlock({
        id: 'p1',
        title: 'Sürüm',
        goal: 'g',
        version: 1,
        state,
        items: ITEMS,
        decisions: [],
        userEdit: null,
        stalled: null,
        autonomous,
      });
    expect(at('executing', true)).toContain('"autonomous": true');
    expect(at('executing', false)).not.toContain('autonomous');
    expect(at('paused', true)).not.toContain('autonomous');
    expect(PLAN_AUTONOMY_INSTRUCTION).toMatch(/run immediately/);
    expect(PLAN_AUTONOMY_INSTRUCTION).toMatch(/do not ask the user to confirm/);
    expect(PLAN_AUTONOMY_INSTRUCTION).toMatch(/plan_update_items/);
    expect(PLAN_AUTONOMY_INSTRUCTION).toMatch(/blocked with a clear reason/);
  });
});

describe('the per-turn plan block', () => {
  it('is fenced data, ≤ 6 KB, compacting long plans', () => {
    const block = planBlock({
      id: 'p1',
      title: 'Sürüm',
      goal: 'g'.repeat(900),
      version: 2,
      state: 'in_review',
      items: ITEMS,
      decisions: [{ id: 'q', itemKey: 'deploy', prompt: 'Ortam?', state: 'pending', answer: null }],
      userEdit: null,
      stalled: null,
    });
    expect(block).toContain('REMYRAL-DATA');
    expect(block).toContain('"key": "deploy"');
    const many = itemsFromCreate(
      Array.from({ length: 3 }, (_, p) => ({
        title: `P${String(p)}`,
        items: Array.from({ length: 20 }, (_, i) => ({
          key: `k${String(p)}-${String(i)}`,
          title: `Madde ${'x'.repeat(120)}`,
          owner: 'job' as const,
        })),
      })),
    );
    const big = planBlock({
      id: 'p1',
      title: 'Büyük',
      goal: 'g',
      version: 1,
      state: 'executing',
      items: withStatus(
        many,
        Object.fromEntries(many.slice(0, 40).map((i) => [i.key, { status: 'done' as const }])),
      ),
      decisions: [],
      userEdit: null,
      stalled: null,
    });
    expect(Buffer.byteLength(big, 'utf8')).toBeLessThanOrEqual(6 * 1024 + 2048);
    expect(big).toContain('omitted');
  });
});

describe('W3: the person edits the plan', () => {
  it('owner / project / estimate edits are structural; done items refuse them', () => {
    const r = applyUserOps(
      ITEMS,
      [
        { op: 'set_owner', key: 'notes', owner: 'user' },
        { op: 'set_project', key: 'notes', project: 'alpha' },
        { op: 'set_estimate', key: 'notes', estimate: 'L' },
        { op: 'set_estimate', key: 'tests', estimate: null },
      ],
      used(ITEMS),
    );
    expect(r.structural).toBe(true);
    expect(r.items.find((i) => i.key === 'notes')).toMatchObject({
      owner: 'user',
      project: 'alpha',
      estimate: 'L',
    });
    expect(r.items.find((i) => i.key === 'tests')?.estimate).toBeNull();
    const d = diffSnapshots(snap(ITEMS), snap(r.items));
    expect(d.changed).toEqual([
      { key: 'tests', fields: ['estimate'] },
      { key: 'notes', fields: ['owner', 'project', 'estimate'] },
    ]);
    const done = withStatus(ITEMS, { notes: { status: 'done' } });
    for (const op of [
      { op: 'set_owner', key: 'notes', owner: 'job' },
      { op: 'set_project', key: 'notes', project: null },
      { op: 'set_estimate', key: 'notes', estimate: 'S' },
    ] as const)
      expect(() => applyUserOps(done, [op], used(ITEMS))).toThrow(/done/);
  });

  it('adds with an estimate; reorders within and across phases (keyboard and drag send the same move)', () => {
    const r = applyUserOps(
      ITEMS,
      [
        { op: 'add', item: { title: 'Smoke', owner: 'assistant', estimate: 'S' }, phase: 0, after: 'notes' },
        { op: 'move', key: 'tests', phase: 0, after: 'notes' },
        { op: 'move', key: 'deploy', phase: 0, after: null },
      ],
      used(ITEMS),
    );
    expect(r.items.map((i) => [i.key, i.phase, i.position])).toEqual([
      ['deploy', 0, 0],
      ['notes', 0, 1],
      ['tests', 0, 2],
      ['u1', 0, 3],
      ['tag', 1, 0],
    ]);
    expect(r.items.find((i) => i.key === 'u1')).toMatchObject({
      owner: 'assistant',
      estimate: 'S',
      statusBy: 'user',
    });
    expect(diffSnapshots(snap(ITEMS), snap(r.items))).toMatchObject({
      added: ['u1'],
      moved: expect.arrayContaining(['deploy']) as unknown,
    });
  });

  it('restore (the undo of a removal) brings the item back where it was, status and links kept', () => {
    const skipped = withStatus(ITEMS, { notes: { status: 'skipped', statusBy: 'user' } });
    const gone = applyUserOps(skipped, [{ op: 'remove', key: 'notes' }], used(ITEMS));
    expect(gone.items.map((i) => i.key)).toEqual(['tests', 'tag', 'deploy']);
    // tag depended on notes: the removal dropped it.
    expect(gone.items.find((i) => i.key === 'tag')?.dependsOn).toEqual([]);
    const deleted = new Map([['notes', skipped[1] as PlanItem]]);
    const back = applyUserOps(gone.items, [{ op: 'restore', key: 'notes' }], used(ITEMS), deleted);
    expect(back.structural).toBe(true);
    expect(back.items.map((i) => [i.key, i.phase, i.position])).toEqual([
      ['tests', 0, 0],
      ['notes', 0, 1],
      ['tag', 1, 0],
      ['deploy', 1, 1],
    ]);
    expect(back.items.find((i) => i.key === 'notes')).toMatchObject({
      status: 'skipped',
      dependsOn: ['tests'],
    });
    expect(diffSnapshots(snap(skipped), snap(back.items))).toMatchObject({
      added: [],
      removed: [],
      moved: [],
    });
    // Twice, or a key that was never removed: refused.
    expect(() => applyUserOps(back.items, [{ op: 'restore', key: 'notes' }], used(ITEMS), deleted)).toThrow(
      /already/,
    );
    expect(() => applyUserOps(ITEMS, [{ op: 'restore', key: 'zzz' }], used(ITEMS))).toThrow(PlanOpError);
  });

  it('restore reopens a phase that vanished with its last item; its dependencies on gone items drop', () => {
    const one = applyUserOps(
      ITEMS,
      [
        { op: 'remove', key: 'tag' },
        { op: 'remove', key: 'deploy' },
      ],
      used(ITEMS),
    );
    expect(new Set(one.items.map((i) => i.phaseTitle))).toEqual(new Set(['Hazırlık']));
    const deleted = new Map(
      ITEMS.filter((i) => i.key === 'tag' || i.key === 'deploy').map((i) => [i.key, i]),
    );
    const back = applyUserOps(one.items, [{ op: 'restore', key: 'deploy' }], used(ITEMS), deleted);
    expect(back.items.map((i) => [i.key, i.phase, i.phaseTitle])).toEqual([
      ['tests', 0, 'Hazırlık'],
      ['notes', 0, 'Hazırlık'],
      ['deploy', 1, 'Yayın'],
    ]);
    expect(back.items.find((i) => i.key === 'deploy')?.dependsOn).toEqual([]);
  });

  it('the diff view: items with both sides in reading order; v1 ↔ v3 across a user version', () => {
    const v1 = snap(ITEMS);
    const v2Items = applyUserOps(
      ITEMS,
      [
        { op: 'rename', key: 'tests', title: 'Testleri onar' },
        { op: 'move', key: 'deploy', phase: 0, after: null },
      ],
      used(ITEMS),
    ).items;
    const v3Items = applyUpdateOps(
      v2Items,
      [
        { op: 'remove', key: 'tag' },
        { op: 'add', item: { key: 'smoke', title: 'Smoke', owner: 'job' }, phase: 1, after: null },
      ],
      used(ITEMS),
    ).items;
    const v3 = snap(v3Items);
    const d = diffSnapshots(v1, v3);
    // deploy moved and lost its dependency on the removed tag: changed and moved.
    expect(diffCounts(d)).toEqual({ added: 1, removed: 1, changed: 2, moved: 1 });
    expect(
      diffItems(v1, v3).map((x) => [
        x.key,
        x.change,
        x.moved,
        x.fields,
        x.before?.title ?? null,
        x.after?.title ?? null,
      ]),
    ).toEqual([
      ['deploy', 'changed', true, ['dependsOn'], 'Deploy', 'Deploy'],
      ['tests', 'changed', false, ['title'], 'Testleri düzelt', 'Testleri onar'],
      ['smoke', 'added', false, [], null, 'Smoke'],
      ['tag', 'removed', false, [], 'Sürüm etiketi', null],
    ]);
  });

  it('the assistant reads the person’s edits since its own version, with titles, in the plan block', () => {
    const edited = applyUserOps(
      ITEMS,
      [
        { op: 'rename', key: 'notes', title: 'Sürüm notu yaz' },
        { op: 'remove', key: 'deploy' },
        { op: 'add', item: { title: 'Duyuru' }, phase: 1, after: 'tag' },
      ],
      used(ITEMS),
    ).items;
    const view = userEditView({ version: 2, snapshot: snap(ITEMS) }, { version: 5, snapshot: snap(edited) });
    expect(view).toMatchObject({
      sinceVersion: 2,
      version: 5,
      added: [{ key: 'u1', title: 'Duyuru', phase: 'Yayın' }],
      removed: [{ key: 'deploy', title: 'Deploy' }],
      changed: [
        { key: 'notes', title: 'Sürüm notu yaz', fields: ['title'], before: { title: 'Changelog yaz' } },
      ],
    });
    expect(
      userEditView({ version: 2, snapshot: snap(ITEMS) }, { version: 3, snapshot: snap(ITEMS) }),
    ).toBeNull();
    const block = planBlock({
      id: 'p1',
      title: 'Sürüm',
      goal: 'g',
      version: 5,
      state: 'executing',
      items: edited,
      decisions: [],
      userEdit: view,
      stalled: null,
    });
    expect(block).toContain('Kullanıcı planı düzenledi');
    expect(block).toContain('your v2 → their v5');
    expect(block).toContain('"title": "Deploy"');
    expect(block).toContain('"title": "Duyuru"');
  });
});
