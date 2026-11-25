// p18-plan-mode W3 (docs/design/p18-plan-mode.md §3 "Editing", §4, §6 W3): editing the plan in the panel — inline
// rename, add per phase, delete with undo, skip / un-skip, the item editor (owner / estimate), reorder by keyboard (with
// announcements) and by pointer, move between phases, the 409 merge view (apply again / drop), the history list and
// the diff between versions, and who may not edit (shared readers, a closed plan). The fake master applies the edits
// with the console's own rules and answers like the real one (rev / version, 409 with the current plan).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Plan, type PlanItem, type PlanUserOp, parsePlan } from '../src/api/plans';
import type { AuthState } from '../src/auth/AuthProvider';
import { applyLocal, moveOp, phasesOf, planChanges, stepMove } from '../src/diyalog/plan/planModel';
import { resetPlanStore } from '../src/diyalog/plan/planStore';
import { editorOps } from '../src/diyalog/plan/PlanEditing';
import { type Handler, type RecordedRequest, renderApp, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const tr = messagesFor('tr').plan;
const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e70';
const PLAN = '7c0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e70';
const thread = { id: THREAD, title: 'Sürüm', archived: false, createdAt: iso(90 * MIN), updatedAt: iso(MIN) };

function item(key: string, phase: number, position: number, over: Record<string, unknown> = {}) {
  return {
    key,
    phase,
    phaseTitle: phase === 0 ? 'Hazırlık' : 'Yayın',
    position,
    title: `Madde ${key}`,
    activeTitle: null,
    detail: null,
    status: 'pending',
    owner: 'assistant',
    project: null,
    dependsOn: [],
    estimate: null,
    links: [],
    note: null,
    statusBy: 'assistant',
    decisionOpen: false,
    ...over,
  };
}

function rawPlan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLAN,
    threadId: THREAD,
    title: 'Sürüm 2.5',
    goal: 'Yayına çık.',
    assumptions: [],
    risks: [],
    state: 'in_review',
    version: 2,
    rev: 5,
    approvedVersion: null,
    stalled: null,
    createdAt: iso(20 * MIN),
    updatedAt: iso(MIN),
    closedAt: null,
    phases: [
      { index: 0, title: 'Hazırlık' },
      { index: 1, title: 'Yayın' },
    ],
    items: [item('a', 0, 0), item('b', 0, 1, { owner: 'job', estimate: 'M' }), item('c', 1, 0)],
    decisions: [],
    progress: { done: 0, total: 3, skipped: 0, remainingMinutes: null },
    lastChange: null,
    ...over,
  };
}
const asPlan = (o: Record<string, unknown>): Plan => {
  const p = parsePlan(o);
  if (p === null) throw new Error('bad plan fixture');
  return p;
};

const STRUCTURAL = new Set([
  'rename',
  'add',
  'remove',
  'restore',
  'move',
  'set_owner',
  'set_estimate',
  'set_project',
]);

/** A fake master for the plan: applies the edits (the console's rules), bumps rev / version, 409 on a stale rev. */
function fakeMaster(start: Record<string, unknown>) {
  let cur = asPlan(start);
  const removed = new Map<string, PlanItem>();
  let conflictNext: Plan | null = null;
  let added = 0;
  const patch: Handler = (req: RecordedRequest) => {
    const body = req.body as { baseRev: number; ops: PlanUserOp[] };
    if (conflictNext !== null) {
      cur = conflictNext;
      conflictNext = null;
    }
    if (body.baseRev !== cur.rev)
      return { status: 409, body: { error: 'plan_rev_conflict', message: 'x', plan: cur } };
    for (const op of body.ops) {
      if (op.op === 'remove') {
        const i = cur.items.find((x) => x.key === op.key);
        if (i !== undefined) removed.set(op.key, i);
      }
    }
    let next = applyLocal(cur, body.ops, { removed });
    // The master names added items u1, u2 …
    next = {
      ...next,
      items: next.items.map((i) => (i.key.startsWith('local-') ? { ...i, key: `u${String(++added)}` } : i)),
    };
    const structural = body.ops.some((o) => STRUCTURAL.has(o.op));
    cur = { ...next, rev: cur.rev + 1, version: structural ? cur.version + 1 : cur.version };
    return { status: 200, body: cur };
  };
  return {
    patch,
    get plan() {
      return cur;
    },
    /** The next edit finds the plan changed by someone else (the assistant renamed "a"). */
    conflictOnce(p: Plan) {
      conflictNext = p;
    },
  };
}

function routes(opts: {
  plan: Record<string, unknown>;
  access?: 'reader';
  extra?: Record<string, Handler>;
}): Record<string, Handler> {
  return {
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'kestrel', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: null,
        plan: true,
      },
    }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: {
        thread,
        messages: [],
        drafts: [],
        turn: null,
        watches: [],
        starred: [],
        questions: [],
        plan: { mode: null, active: opts.plan },
        ...(opts.access === undefined ? {} : { access: opts.access, owner: { id: 'u9', username: 'ayse' } }),
      },
    }),
    [`POST /api/chat/threads/${THREAD}/read`]: () => ({
      status: 200,
      body: { threadId: THREAD, lastReadSeq: 0, lastReadAt: iso(0), unreadCount: 0 },
    }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/notifications?limit=20': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      },
    }),
    ...(opts.extra ?? {}),
  };
}

function setWidth(width: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const min = /min-width:\s*([\d.]+)rem/.exec(q);
    const maxPx = /max-width:\s*([\d.]+)px/.exec(q);
    const matches = q.includes('prefers-reduced-motion')
      ? false
      : min !== null
        ? width >= Number(min[1]) * 16
        : maxPx !== null
          ? width <= Number(maxPx[1])
          : false;
    return {
      matches,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    };
  });
  window.matchMedia = globalThis.matchMedia;
}

function openWith(
  start: Record<string, unknown>,
  opts: { access?: 'reader'; extra?: Record<string, Handler> } = {},
) {
  const m = fakeMaster(start);
  const app = renderApp({
    path: `/chat/${THREAD}`,
    initialState: signedIn,
    routes: routes({
      plan: start,
      ...(opts.access === undefined ? {} : { access: opts.access }),
      extra: { [`PATCH /api/chat/plans/${PLAN}/items`]: m.patch, ...(opts.extra ?? {}) },
    }),
  });
  return { app, m };
}

const patches = (reqs: RecordedRequest[]): { baseRev: number; ops: unknown[] }[] =>
  reqs.filter((q) => q.method === 'PATCH').map((q) => q.body as { baseRev: number; ops: unknown[] });
const row = (col: HTMLElement, key: string): HTMLElement => {
  const el = col.querySelector<HTMLElement>(`[data-plan-item="${key}"]`);
  if (el === null) throw new Error(`no row ${key}`);
  return el;
};
const order = (col: HTMLElement): string[] =>
  [...col.querySelectorAll<HTMLElement>('[data-plan-item]')].map((e) => e.dataset.planItem ?? '');
async function editMode(col: HTMLElement): Promise<void> {
  await userEvent.click(within(col).getByTestId('plan-edit-toggle'));
  expect(within(col).getByTestId('plan-body').hasAttribute('data-editing')).toBe(true);
}
async function menuAction(col: HTMLElement, title: string, label: string): Promise<void> {
  await userEvent.click(within(col).getByRole('button', { name: tr.actions.itemMenu({ title }) }));
  await userEvent.click(await screen.findByRole('menuitem', { name: label }));
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-1');
  window.localStorage.clear();
  resetPlanStore();
  setWidth(1440);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('editing rules (pure)', () => {
  const p = asPlan(rawPlan());
  it('local edits follow the master: add after, move across phases, remove, restore in place', () => {
    const moved = applyLocal(p, [moveOp(p, 'c', 0, 'b')]);
    expect(moved.items.map((i) => `${String(i.phase)}:${i.key}`)).toEqual(['0:a', '0:c', '0:b']);
    // The phase emptied by the move is gone (renumbered like the master) unless a move is in progress.
    expect(moved.phases).toEqual([{ index: 0, title: 'Hazırlık' }]);
    expect(applyLocal(p, [moveOp(p, 'c', 0, null)], { keepPhases: true }).phases.length).toBe(2);
    const gone = applyLocal(p, [{ op: 'remove', key: 'c' }]);
    const removed = new Map([['c', p.items[2] as PlanItem]]);
    expect(applyLocal(gone, [{ op: 'restore', key: 'c' }], { removed }).items.map((i) => i.key)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const added = applyLocal(p, [
      { op: 'add', item: { title: 'Yeni', owner: 'user' }, phase: 0, after: 'a' },
    ]);
    expect(added.items.map((i) => i.title)).toEqual(['Madde a', 'Yeni', 'Madde b', 'Madde c']);
  });

  it('keyboard steps cross phase edges; the drop names the item it follows in the full list', () => {
    const shown = phasesOf(p, 'all');
    expect(stepMove(shown, 'b', 1)).toEqual({ phase: 1, before: 'c' });
    expect(stepMove(shown, 'c', -1)).toEqual({ phase: 0, before: null });
    expect(stepMove(shown, 'a', -1)).toBeNull();
    expect(moveOp(p, 'c', 0, null)).toEqual({ op: 'move', key: 'c', phase: 0, after: 'b' });
    expect(moveOp(p, 'b', 0, 'a')).toEqual({ op: 'move', key: 'b', phase: 0, after: null });
  });

  it('the item editor sends only what changed; the merge view lists the other side’s changes', () => {
    const b = p.items[1] as PlanItem;
    expect(editorOps(b, { title: 'Madde b', owner: 'job', estimate: 'M', project: null })).toEqual([]);
    expect(editorOps(b, { title: ' Yeni ', owner: 'user', estimate: 45, project: null })).toEqual([
      { op: 'rename', key: 'b', title: 'Yeni' },
      { op: 'set_owner', key: 'b', owner: 'user' },
      { op: 'set_estimate', key: 'b', estimate: 45 },
    ]);
    const other = applyLocal(p, [
      { op: 'rename', key: 'a', title: 'Asistan adı' },
      { op: 'remove', key: 'c' },
    ]);
    expect(planChanges(p, other).map((c) => c.change)).toEqual(['renamed', 'removed']);
  });
});

describe('editing in the panel', () => {
  it('rename inline: Enter saves with the revision seen, the row changes at once, the live region says so', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await editMode(col);
    await userEvent.click(within(row(col, 'a')).getByTestId('plan-item-title'));
    const input = within(col).getByTestId('plan-item-rename');
    await userEvent.clear(input);
    await userEvent.type(input, 'Değişiklikleri incele{Enter}');
    expect(within(row(col, 'a')).getByText('Değişiklikleri incele')).toBeTruthy();
    await waitFor(() => {
      expect(patches(app.requests)).toEqual([
        { baseRev: 5, ops: [{ op: 'rename', key: 'a', title: 'Değişiklikleri incele' }] },
      ]);
    });
    expect(within(col).getByTestId('plan-edit-live').textContent).toContain(
      tr.edit.live.renamed({ title: 'Değişiklikleri incele' }),
    );
    // The answer's version shows (a user version, no re-approval).
    await waitFor(() => {
      expect(within(col).getByText(tr.version({ v: 3 }))).toBeTruthy();
    });
  });

  it('Escape cancels a rename (nothing is sent)', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await menuAction(col, 'Madde b', tr.edit.rename);
    const input = within(col).getByTestId('plan-item-rename');
    await userEvent.type(input, 'xx{Escape}');
    expect(within(col).queryByTestId('plan-item-rename')).toBeNull();
    expect(patches(app.requests)).toEqual([]);
  });

  it('adds an item at the end of a phase from the keyboard; two quick edits chain their revisions', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await editMode(col);
    const [first] = within(col).getAllByTestId('plan-add');
    await userEvent.click(first as HTMLElement);
    const input = within(col).getByTestId('plan-add-input');
    await userEvent.type(input, 'Smoke test{Enter}');
    await userEvent.type(input, 'Duyuru{Enter}');
    await waitFor(() => {
      expect(patches(app.requests)).toEqual([
        {
          baseRev: 5,
          ops: [{ op: 'add', item: { title: 'Smoke test', owner: 'assistant' }, phase: 0, after: 'b' }],
        },
        {
          baseRev: 6,
          ops: [{ op: 'add', item: { title: 'Duyuru', owner: 'assistant' }, phase: 0, after: 'u1' }],
        },
      ]);
    });
    await waitFor(() => {
      expect(order(col)).toEqual(['a', 'b', 'u1', 'u2', 'c']);
    });
    expect(within(col).getByText('Smoke test')).toBeTruthy();
    expect(within(col).getByText('Duyuru')).toBeTruthy();
  });

  it('delete then undo: the row leaves, "Geri al" restores it in place; without undo the bar expires', async () => {
    const { app, m } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await menuAction(col, 'Madde b', tr.edit.remove);
    expect(col.querySelector('[data-plan-item="b"]')).toBeNull();
    const bar = await within(col).findByTestId('plan-undo');
    expect(bar.textContent).toContain(tr.edit.removed({ title: 'Madde b' }));
    expect(within(col).getByTestId('plan-edit-live').textContent).toContain(
      tr.edit.live.removed({ title: 'Madde b' }),
    );
    await userEvent.click(within(bar).getByTestId('plan-undo-button'));
    await waitFor(() => {
      expect(patches(app.requests).map((b) => b.ops)).toEqual([
        [{ op: 'remove', key: 'b' }],
        [{ op: 'restore', key: 'b' }],
      ]);
    });
    await waitFor(() => {
      expect(order(col)).toEqual(['a', 'b', 'c']);
    });
    expect(m.plan.items.map((i) => i.key)).toEqual(['a', 'b', 'c']);
    expect(within(col).queryByTestId('plan-undo')).toBeNull();
    // Another delete, no undo: the bar leaves after its time, the item stays deleted.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await menuAction(col, 'Madde c', tr.edit.remove);
    expect(await within(col).findByTestId('plan-undo')).toBeTruthy();
    vi.advanceTimersByTime(6_500);
    await waitFor(() => {
      expect(within(col).queryByTestId('plan-undo')).toBeNull();
    });
    expect(m.plan.items.map((i) => i.key)).toEqual(['a', 'b']);
  });

  it('skip and un-skip from the item menu', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await userEvent.click(within(col).getByRole('button', { name: tr.filter.all }));
    await menuAction(col, 'Madde a', tr.actions.skip);
    await waitFor(() => {
      expect(row(col, 'a').getAttribute('data-status')).toBe('skipped');
    });
    await menuAction(col, 'Madde a', tr.actions.unskip);
    await waitFor(() => {
      expect(patches(app.requests).map((b) => b.ops)).toEqual([
        [{ op: 'skip', key: 'a' }],
        [{ op: 'unskip', key: 'a' }],
      ]);
    });
    await waitFor(() => {
      expect(row(col, 'a').getAttribute('data-status')).toBe('pending');
    });
  });

  it('the item editor changes owner and estimate', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await menuAction(col, 'Madde b', tr.edit.editItem);
    const editor = within(col).getByTestId('plan-item-editor');
    await userEvent.click(within(editor).getByRole('button', { name: tr.owners.user }));
    await userEvent.click(within(editor).getByRole('button', { name: tr.edit.sizeLabels.L }));
    await userEvent.click(within(editor).getByTestId('plan-item-editor-save'));
    await waitFor(() => {
      expect(patches(app.requests)).toEqual([
        {
          baseRev: 5,
          ops: [
            { op: 'set_owner', key: 'b', owner: 'user' },
            { op: 'set_estimate', key: 'b', estimate: 'L' },
          ],
        },
      ]);
    });
    await waitFor(() => {
      expect(within(row(col, 'b')).getByTestId('plan-item-estimate').textContent).toContain('L');
    });
  });
});

describe('reorder', () => {
  it('keyboard: Space picks up, ↑ moves (announced), Space drops — and across a phase edge', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await editMode(col);
    const live = within(col).getByTestId('plan-edit-live');
    const handle = within(row(col, 'b')).getByTestId('plan-item-handle');
    expect(handle.getAttribute('aria-describedby')).toBeTruthy();
    handle.focus();
    await userEvent.keyboard(' ');
    expect(row(col, 'b').getAttribute('data-lifted')).toBe('keyboard');
    expect(live.textContent).toContain(
      tr.edit.live.picked({ title: 'Madde b', index: 2, count: 2, phase: 'Hazırlık' }),
    );
    await userEvent.keyboard('{ArrowUp}');
    expect(order(col)).toEqual(['b', 'a', 'c']);
    await waitFor(() => {
      expect(live.textContent).toContain(tr.edit.live.position({ index: 1, count: 2, phase: 'Hazırlık' }));
    });
    await userEvent.keyboard('{ArrowUp}');
    expect(live.textContent).toContain(tr.edit.live.edge);
    await userEvent.keyboard(' ');
    await waitFor(() => {
      expect(patches(app.requests)).toEqual([
        { baseRev: 5, ops: [{ op: 'move', key: 'b', phase: 0, after: null }] },
      ]);
    });
    expect(live.textContent).toContain(
      tr.edit.live.dropped({ title: 'Madde b', index: 1, count: 2, phase: 'Hazırlık' }),
    );
    // Across the edge: "c" (first of Yayın) ↑ → the end of Hazırlık.
    await waitFor(() => {
      expect(order(col)).toEqual(['b', 'a', 'c']);
    });
    const hc = within(row(col, 'c')).getByTestId('plan-item-handle');
    hc.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowUp}');
    expect(order(col)).toEqual(['b', 'a', 'c']);
    expect(row(col, 'c').getAttribute('data-plan-phase')).toBe('0');
    // The focus stayed on the moved handle.
    expect(document.activeElement?.getAttribute('data-plan-handle')).toBe('c');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(patches(app.requests)[1]).toEqual({
        baseRev: 6,
        ops: [{ op: 'move', key: 'c', phase: 0, after: 'a' }],
      });
    });
  });

  it('keyboard: Escape cancels the move (nothing sent)', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await editMode(col);
    within(row(col, 'a')).getByTestId('plan-item-handle').focus();
    await userEvent.keyboard(' {ArrowDown}');
    expect(order(col)).toEqual(['b', 'a', 'c']);
    await userEvent.keyboard('{Escape}');
    expect(order(col)).toEqual(['a', 'b', 'c']);
    expect(within(col).getByTestId('plan-edit-live').textContent).toContain(
      tr.edit.live.cancelled({ title: 'Madde a' }),
    );
    expect(patches(app.requests)).toEqual([]);
    // Escape inside the panel did not close it.
    expect(screen.getByTestId('plan-column')).toBeTruthy();
  });

  it('pointer (mouse or touch): dragging the handle below the next row drops it there', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await editMode(col);
    // Rows are 40 px tall in DOM order (rows and the phases' add rows).
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const all = [...col.querySelectorAll<HTMLElement>('[data-plan-item], [data-plan-phase-end]')];
      const i = all.indexOf(this);
      const top = i < 0 ? 0 : i * 40;
      return {
        top,
        bottom: top + 40,
        height: 40,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });
    try {
      const handle = within(row(col, 'a')).getByTestId('plan-item-handle');
      fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', button: 0, clientY: 20 });
      expect(row(col, 'a').getAttribute('data-lifted')).toBe('pointer');
      fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 75 });
      await waitFor(() => {
        expect(order(col)).toEqual(['b', 'a', 'c']);
      });
      fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'touch', clientY: 75 });
      await waitFor(() => {
        expect(patches(app.requests)).toEqual([
          { baseRev: 5, ops: [{ op: 'move', key: 'a', phase: 0, after: 'b' }] },
        ]);
      });
      expect(row(col, 'a').hasAttribute('data-lifted')).toBe(false);
      expect(row(col, 'a').style.transform).toBe('');
    } finally {
      rect.mockRestore();
    }
  });

  it('the menu moves between phases', async () => {
    const { app } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    await menuAction(col, 'Madde a', tr.edit.moveNext);
    await waitFor(() => {
      expect(patches(app.requests)).toEqual([
        { baseRev: 5, ops: [{ op: 'move', key: 'a', phase: 1, after: null }] },
      ]);
    });
    await waitFor(() => {
      expect(row(col, 'a').getAttribute('data-plan-phase')).toBe('1');
    });
  });
});

describe('conflicts', () => {
  it('a 409 shows the merge view; "apply again" sends the edit at the current revision; "drop" forgets it', async () => {
    const { app, m } = openWith(rawPlan());
    const col = await screen.findByTestId('plan-column');
    // The assistant renamed "a" meanwhile.
    await userEvent.click(within(col).getByRole('button', { name: tr.filter.all }));
    const theirs = applyLocal(asPlan(rawPlan()), [{ op: 'rename', key: 'a', title: 'Asistanın adı' }]);
    m.conflictOnce({ ...theirs, rev: 9, version: 3 });
    await menuAction(col, 'Madde b', tr.actions.skip);
    const merge = await within(col).findByTestId('plan-conflict');
    expect(merge.textContent).toContain(tr.merge.title);
    expect(within(col).getByTestId('plan-edit-live').textContent).toContain(tr.edit.live.conflict);
    // The current plan is shown (the optimistic skip is gone until applied again).
    expect(within(col).getByText('Asistanın adı')).toBeTruthy();
    expect(row(col, 'b').getAttribute('data-status')).toBe('pending');
    await userEvent.click(within(merge).getByTestId('plan-merge-toggle'));
    const diff = within(merge).getByTestId('plan-merge-diff');
    expect(diff.textContent).toContain(tr.merge.renamed({ from: 'Madde a', to: 'Asistanın adı' }));
    expect(diff.textContent).toContain(tr.edit.live.skipped({ title: 'Madde b' }));
    await userEvent.click(within(merge).getByTestId('plan-merge-reapply'));
    await waitFor(() => {
      expect(patches(app.requests)).toEqual([
        { baseRev: 5, ops: [{ op: 'skip', key: 'b' }] },
        { baseRev: 9, ops: [{ op: 'skip', key: 'b' }] },
      ]);
    });
    await waitFor(() => {
      expect(row(col, 'b').getAttribute('data-status')).toBe('skipped');
    });
    expect(within(col).queryByTestId('plan-conflict')).toBeNull();
    // Again, and this time drop it.
    m.conflictOnce({ ...m.plan, rev: 20 });
    await menuAction(col, 'Madde c', tr.actions.skip);
    await userEvent.click(await within(col).findByTestId('plan-merge-discard'));
    expect(within(col).queryByTestId('plan-conflict')).toBeNull();
    expect(patches(app.requests).length).toBe(3);
    expect(row(col, 'c').getAttribute('data-status')).toBe('pending');
  });
});

describe('history and diff', () => {
  it('lists the versions (author, approved / current) and shows the diff of one, and of any two', async () => {
    const versions = {
      versions: [
        {
          version: 3,
          author: 'user',
          reason: null,
          createdAt: iso(MIN),
          items: 3,
          added: 0,
          removed: 1,
          changed: 1,
          moved: 1,
        },
        {
          version: 2,
          author: 'assistant',
          reason: 'Smoke eklendi',
          createdAt: iso(5 * MIN),
          items: 4,
          added: 1,
          removed: 0,
          changed: 0,
          moved: 0,
        },
        {
          version: 1,
          author: 'assistant',
          reason: null,
          createdAt: iso(9 * MIN),
          items: 3,
          added: 0,
          removed: 0,
          changed: 0,
          moved: 0,
        },
      ],
    };
    const shape = (
      key: string,
      title: string,
      phaseTitle = 'Hazırlık',
      over: Record<string, unknown> = {},
    ) => ({
      key,
      phase: phaseTitle === 'Hazırlık' ? 0 : 1,
      phaseTitle,
      position: 0,
      title,
      activeTitle: null,
      detail: null,
      owner: 'assistant',
      project: null,
      dependsOn: [],
      estimate: null,
      ...over,
    });
    const meta = (v: number, author: string) => ({
      version: v,
      author,
      reason: null,
      createdAt: iso(v * MIN),
    });
    const { app } = openWith(rawPlan({ version: 3, approvedVersion: 2 }), {
      extra: {
        [`GET /api/chat/plans/${PLAN}/versions`]: () => ({ status: 200, body: versions }),
        [`GET /api/chat/threads/${THREAD}/plans`]: () => ({
          status: 200,
          body: {
            active: null,
            mode: null,
            history: [
              {
                id: 'old',
                title: 'Eski plan',
                state: 'cancelled',
                version: 2,
                done: 1,
                total: 4,
                createdAt: iso(99 * MIN),
                closedAt: iso(90 * MIN),
              },
            ],
          },
        }),
        [`GET /api/chat/plans/${PLAN}/diff?from=2&to=3`]: () => ({
          status: 200,
          body: {
            added: [],
            removed: ['smoke'],
            changed: [{ key: 'b', fields: ['title', 'owner'] }],
            moved: ['c'],
            goalChanged: false,
            titleChanged: false,
            from: meta(2, 'assistant'),
            to: meta(3, 'user'),
            items: [
              {
                key: 'b',
                change: 'changed',
                fields: ['title', 'owner'],
                moved: false,
                before: shape('b', 'Eski b'),
                after: shape('b', 'Madde b', 'Hazırlık', { owner: 'user' }),
              },
              {
                key: 'c',
                change: 'moved',
                fields: [],
                moved: true,
                before: shape('c', 'Madde c'),
                after: shape('c', 'Madde c', 'Yayın'),
              },
              {
                key: 'smoke',
                change: 'removed',
                fields: [],
                moved: false,
                before: shape('smoke', 'Smoke test'),
                after: null,
              },
            ],
            decisions: [{ id: 'q', itemKey: null, prompt: 'Ortam?', change: 'answered', answer: 'preview' }],
          },
        }),
        [`GET /api/chat/plans/${PLAN}/diff?from=1&to=3`]: () => ({
          status: 200,
          body: {
            added: ['a'],
            removed: [],
            changed: [],
            moved: [],
            goalChanged: true,
            titleChanged: false,
            from: meta(1, 'assistant'),
            to: meta(3, 'user'),
            items: [
              {
                key: 'a',
                change: 'added',
                fields: [],
                moved: false,
                before: null,
                after: shape('a', 'Madde a'),
              },
            ],
            decisions: [],
          },
        }),
      },
    });
    const col = await screen.findByTestId('plan-column');
    await userEvent.click(within(col).getByRole('button', { name: tr.actions.menu }));
    await userEvent.click(await screen.findByRole('menuitem', { name: tr.history.open }));
    const history = await within(col).findByTestId('plan-history');
    const rows = await within(history).findAllByTestId('plan-version');
    expect(rows.map((r) => r.getAttribute('data-version'))).toEqual(['3', '2', '1']);
    expect(rows[0]?.textContent).toContain(tr.history.author.user);
    expect(rows[0]?.textContent).toContain(tr.history.current);
    expect(rows[1]?.textContent).toContain(tr.history.approved);
    expect(rows[1]?.textContent).toContain('Smoke eklendi');
    expect(within(history).getByTestId('plan-earlier').textContent).toContain('Eski plan');
    await userEvent.click(rows[0] as HTMLElement);
    const diff = await within(history).findByTestId('plan-diff');
    const items = within(diff).getAllByTestId('plan-diff-item');
    expect(items.map((x) => x.getAttribute('data-change'))).toEqual(['removed', 'changed', 'moved']);
    expect(items[0]?.textContent).toContain('Smoke test');
    expect(items[1]?.textContent).toContain(
      tr.history.fieldChange({ field: tr.history.fields.title, from: 'Eski b', to: 'Madde b' }),
    );
    expect(items[1]?.textContent).toContain(
      tr.history.fieldChange({
        field: tr.history.fields.owner,
        from: tr.owners.assistant,
        to: tr.owners.user,
      }),
    );
    expect(items[2]?.textContent).toContain(tr.history.movedTo({ from: 'Hazırlık', to: 'Yayın' }));
    expect(within(diff).getByTestId('plan-diff-decision').textContent).toBe(
      tr.history.answered({ prompt: 'Ortam?', answer: 'preview' }),
    );
    // Any two: v1 ↔ v3.
    await userEvent.selectOptions(within(history).getByTestId('plan-compare-from'), '1');
    await userEvent.selectOptions(within(history).getByTestId('plan-compare-to'), '3');
    await userEvent.click(within(history).getByTestId('plan-compare'));
    await waitFor(() => {
      expect(within(history).getByTestId('plan-diff').textContent).toContain(tr.history.goalChanged);
    });
    expect(app.requests.some((q) => q.url.endsWith('/diff?from=1&to=3'))).toBe(true);
    await userEvent.click(within(col).getByTestId('plan-history-back'));
    expect(await within(col).findByTestId('plan-list')).toBeTruthy();
  });
});

describe('who may edit', () => {
  it('a shared reader: no edit button, no item menus (history still readable)', async () => {
    openWith(rawPlan(), { access: 'reader' });
    const col = await screen.findByTestId('plan-column');
    expect(within(col).queryByTestId('plan-edit-toggle')).toBeNull();
    expect(within(col).queryByRole('button', { name: tr.actions.itemMenu({ title: 'Madde a' }) })).toBeNull();
    expect(within(col).getByText(tr.panel.readOnly)).toBeTruthy();
    await userEvent.click(within(col).getByRole('button', { name: tr.actions.menu }));
    expect(await screen.findByRole('menuitem', { name: tr.history.open })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: tr.actions.cancelPlan })).toBeNull();
  });

  it('a done plan stays in view read only; a cancelled one leaves the panel', async () => {
    const done = openWith(
      rawPlan({
        state: 'done',
        closedAt: iso(MIN),
        items: [item('a', 0, 0, { status: 'done' }), item('b', 0, 1, { status: 'skipped' })],
        phases: [{ index: 0, title: 'Hazırlık' }],
      }),
    );
    const col = await screen.findByTestId('plan-column');
    await userEvent.click(within(col).getByRole('button', { name: tr.filter.all }));
    expect(within(col).queryByTestId('plan-edit-toggle')).toBeNull();
    expect(within(col).queryByRole('button', { name: tr.actions.itemMenu({ title: 'Madde b' }) })).toBeNull();
    expect(within(col).queryAllByTestId('plan-item-handle')).toEqual([]);
    done.app.unmount();
    resetPlanStore();
    openWith(rawPlan({ state: 'cancelled', closedAt: iso(MIN) }));
    await screen.findByTestId('dy-composer-field');
    expect(screen.queryByTestId('plan-column')).toBeNull();
  });

  it('the last item cannot be deleted; done items have no edit actions or handle', async () => {
    openWith(
      rawPlan({
        state: 'executing',
        items: [item('a', 0, 0, { status: 'done' }), item('b', 0, 1)],
        phases: [{ index: 0, title: 'Hazırlık' }],
      }),
    );
    const col = await screen.findByTestId('plan-column');
    await userEvent.click(within(col).getByRole('button', { name: tr.filter.all }));
    await editMode(col);
    expect(within(row(col, 'a')).queryByTestId('plan-item-handle')).toBeNull();
    expect(
      within(row(col, 'a')).queryByRole('button', { name: tr.actions.itemMenu({ title: 'Madde a' }) }),
    ).toBeNull();
    await userEvent.click(
      within(col).getByRole('button', { name: tr.actions.itemMenu({ title: 'Madde b' }) }),
    );
    expect(await screen.findByRole('menuitem', { name: tr.edit.rename })).toBeTruthy();
    // b is not the last item (a is done but still in the plan): delete is offered.
    expect(screen.getByRole('menuitem', { name: tr.edit.remove })).toBeTruthy();
  });
});

describe('motion', () => {
  it('reduced motion turns the editing motions off too (system and in-app switch)', () => {
    const css = readFileSync(join(__dirname, '../src/diyalog/motion.css'), 'utf8');
    const block = css.slice(css.indexOf('p18-plan-mode W3'));
    expect(block).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dy-plan-undo, \.dy-plan-undo-clock, \.dy-plan-diff\) \{\s*animation: none !important/,
    );
    expect(block).toMatch(
      /\[data-motion='reduce'\] :is\(\.dy-plan-undo, \.dy-plan-undo-clock, \.dy-plan-diff\)/,
    );
    expect(block).toMatch(
      /\[data-motion='reduce'\] \.dy-plan-row\[data-lifted='keyboard'\] \{\s*transform: none/,
    );
  });
});
