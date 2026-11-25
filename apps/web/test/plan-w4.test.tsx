// p18-plan-mode W4 + the p17-chat-flow leftovers (docs/design/p18-plan-mode.md, "Implementation (W4)"): the plans
// section of "Senden bekleyen" (decisions answered there through the chat answer route, waiting items), plan decision
// rows grouped as "plan", the "Plan maddesi" link of a chat card (opens the panel on the item), the workflow approval
// card read again on a pushed `flow` event (no polling in a conversation), "Bu sohbete sonuç gönderme", the item editor's
// detail and dependencies (cycle refused), "+ Aşama ekle", the merge view's per-operation choice, and the card kind
// words in the reader's language (registry).
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadCatalog, messagesFor } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Plan, type PlanNeed, type PlanUserOp, parsePlan, parsePlanNeed } from '../src/api/plans';
import type { PendingQuestion } from '../src/api/questionsPending';
import { ChatActionsContext } from '../src/diyalog/chat/chatActions';
import { flowStreamOpened, pushFlowEvent, resetFlowEvents } from '../src/diyalog/chat/flowEvents';
import { PlanItemLink, ScheduledMute } from '../src/diyalog/chat/FlowLinks';
import { WorkflowApprovalCard } from '../src/diyalog/chat/WorkflowCards';
import { LiveCard } from '../src/diyalog/LiveCard';
import { decisionRows } from '../src/diyalog/ops/NeedsSummary';
import { AddPhaseRow, editorOps, ItemEditor, MergeView } from '../src/diyalog/plan/PlanEditing';
import { applyLocal, dependsCycle, phaseCount } from '../src/diyalog/plan/planModel';
import { resetPlanStore, usePlanFocus } from '../src/diyalog/plan/planStore';
import { cardFor, kindLabel } from '../src/diyalog/registry';
import { PlanNeeds } from '../src/diyalog/screens/needs/PlanNeeds';
import { type AuthApi, AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
function fakeApi(): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: unused,
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.reject(new Error('offline')),
  };
}
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const PLAN = '7c0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const QID = '8d0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const RUN = '11111111-1111-4111-8111-111111111111';
const NODE_RUN = '22222222-2222-4222-8222-222222222222';
const NOW = new Date().toISOString();

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
    awaitsUser: false,
    failures: 0,
    ...over,
  };
}
function plan(over: Record<string, unknown> = {}): Plan {
  const p = parsePlan({
    id: PLAN,
    threadId: THREAD,
    title: 'Sürüm 2.5',
    goal: 'Yayına çık.',
    assumptions: [],
    risks: [],
    state: 'executing',
    version: 2,
    rev: 5,
    approvedVersion: 2,
    autonomous: true,
    stalled: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    phases: [
      { index: 0, title: 'Hazırlık' },
      { index: 1, title: 'Yayın' },
    ],
    items: [item('a', 0, 0), item('b', 0, 1, { dependsOn: ['a'] }), item('c', 1, 0, { dependsOn: ['b'] })],
    decisions: [],
    progress: { done: 0, total: 3, skipped: 0, remainingMinutes: null },
    lastChange: null,
    ...over,
  });
  if (p === null) throw new Error('bad plan');
  return p;
}

const decisionSet = {
  id: QID,
  source: 'assistant',
  jobId: null,
  threadId: THREAD,
  project: null,
  title: null,
  questions: [
    {
      id: 'q1',
      prompt: 'Hangi ortama çıkalım?',
      kind: 'single',
      options: [{ label: 'staging' }, { label: 'production' }],
      recommended: 'staging',
    },
  ],
  state: 'pending',
  createdAt: NOW,
  deadlineAt: null,
  closedAt: null,
  closeReason: null,
  answers: null,
  answeredBy: null,
  answeredAt: null,
  planId: PLAN,
  planItemKey: 'a',
};
function need(over: Record<string, unknown> = {}): PlanNeed {
  const n = parsePlanNeed({
    planId: PLAN,
    threadId: THREAD,
    threadTitle: 'Sürüm sohbeti',
    title: 'Sürüm 2.5',
    state: 'executing',
    rev: 5,
    stalled: null,
    questions: [decisionSet],
    waiting: [
      { key: 'b', title: 'Deploy', why: 'card', note: null },
      { key: 'c', title: 'CI', why: 'blocked', note: 'token yok' },
      { key: 'x', title: 'Bad', why: 'nope', note: null },
    ],
    updatedAt: NOW,
    ...over,
  });
  if (n === null) throw new Error('bad need');
  return n;
}

beforeEach(() => {
  stubCookies('__Host-remyral_csrf=csrf-token');
  resetPlanStore();
  resetFlowEvents();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('"Senden bekleyen": plans', () => {
  it('parses a waiting plan (unknown reasons dropped)', () => {
    const n = need();
    expect(n.questions).toHaveLength(1);
    expect(n.waiting.map((w) => w.why)).toEqual(['card', 'blocked']);
    expect(parsePlanNeed({ planId: 1 })).toBeNull();
  });

  it('a plan card answers its decision through the conversation’s answer route and lists what waits', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      [`POST /api/chat/threads/${THREAD}/questions/${QID}/answer`]: () => ({
        status: 200,
        body: { question: { ...decisionSet, state: 'answered' }, turnId: null },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const changed = vi.fn();
    render(
      <MemoryRouter>
        <PlanNeeds plans={[need()]} onChanged={changed} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId('plan-need');
    expect(within(card).getByRole('heading', { name: 'Sürüm 2.5' })).toBeTruthy();
    expect(screen.getByText(TR.plan.needs.count({ n: 1 }))).toBeTruthy();
    const items = within(card).getByTestId('plan-need-items');
    expect(within(items).getByText('Deploy')).toBeTruthy();
    expect(within(items).getByText(`${TR.plan.needs.why.blocked} — token yok`)).toBeTruthy();
    expect(within(card).getByTestId('plan-need-open').getAttribute('href')).toBe(`/chat/${THREAD}`);
    await user.click(within(card).getByRole('radio', { name: /staging/ }));
    await user.click(within(card).getByRole('button', { name: TR.questions.card.send }));
    await waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST /api/chat/threads/${THREAD}/questions/${QID}/answer`,
    ]);
    expect(f.requests[0]?.body).toEqual({ answers: [{ id: 'q1', choices: ['staging'] }] });
    expect(screen.getByTestId('plan-needs-live').textContent).toBe(TR.plan.needs.answered);
  });

  it('a plan can be cancelled (confirmed) or put off for a day from "Senden bekleyen" (p19-needs-snooze)', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      [`POST /api/chat/plans/${PLAN}/cancel`]: () => ({ status: 200, body: plan({ state: 'cancelled' }) }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const changed = vi.fn();
    const snooze = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <PlanNeeds plans={[need()]} onChanged={changed} snoozed={new Set()} onSnooze={snooze} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId('plan-need');
    await user.click(within(card).getByTestId('plan-need-cancel'));
    expect(within(card).getByText(TR.plan.needs.cancelConfirm)).toBeTruthy();
    // "Hayır" sends nothing.
    await user.click(within(card).getByRole('button', { name: TR.plan.needs.confirmNo }));
    expect(f.requests).toHaveLength(0);
    await user.click(within(card).getByTestId('plan-need-cancel'));
    await user.click(within(card).getByTestId('plan-need-cancel-yes'));
    await waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST /api/chat/plans/${PLAN}/cancel`]);
    expect(screen.getByTestId('plan-needs-live').textContent).toBe(TR.plan.needs.cancelled);
    await user.click(within(card).getByTestId('plan-need-snooze'));
    expect(snooze).toHaveBeenCalledWith(`plan:${PLAN}`);
    // A plan put off is not listed.
    rerender(
      <MemoryRouter>
        <PlanNeeds
          plans={[need()]}
          onChanged={changed}
          snoozed={new Set([`plan:${PLAN}`])}
          onSnooze={snooze}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('plan-need')).toBeNull();
  });

  it('nothing waits: no section', () => {
    const { container } = render(
      <MemoryRouter>
        <PlanNeeds plans={[]} onChanged={() => undefined} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('');
  });

  it('a plan decision row is grouped as "plan" and names the plan', () => {
    const q: PendingQuestion = {
      id: QID,
      source: 'assistant',
      jobId: null,
      jobTitle: null,
      threadId: THREAD,
      threadTitle: 'Sürüm sohbeti',
      project: null,
      title: null,
      prompt: 'Hangi ortam?',
      count: 1,
      createdAt: NOW,
      deadlineAt: null,
      plan: { id: PLAN, title: 'Sürüm 2.5', itemKey: 'a', itemTitle: 'Madde a' },
    };
    const rows = decisionRows(
      [],
      [
        {
          kind: 'question',
          key: `question:${QID}`,
          tone: 'attention',
          sentence: '',
          action: { label: '', href: '/chat' },
          question: q,
        },
      ],
      false,
      TR,
      'tr',
    );
    expect(rows[0]).toMatchObject({
      group: 'plan',
      planId: PLAN,
      text: TR.questions.needs.plan({ plan: 'Sürüm 2.5' }),
    });
    expect(TR.home.decisions.groups.plan({ n: 1 })).toBe('plan');
  });
});

describe('chat flow cards', () => {
  it('"Plan maddesi" opens the plan panel on the item', async () => {
    const user = userEvent.setup();
    const openPlan = vi.fn();
    let seen: { key: string | null; n: number } | null = null;
    function Probe(): ReactNode {
      seen = usePlanFocus(THREAD);
      return null;
    }
    render(
      <ChatActionsContext.Provider
        value={{ threadId: THREAD, ask: () => undefined, reload: () => undefined, openPlan }}
      >
        <PlanItemLink item={{ planId: PLAN, key: 'b', title: 'Deploy' }} />
        <Probe />
      </ChatActionsContext.Provider>,
    );
    const link = screen.getByTestId('plan-item-link');
    expect(link.textContent).toBe(TR.plan.itemLink.label({ title: 'Deploy' }));
    await user.click(link);
    expect(openPlan).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ key: 'b' });
  });

  it('the approval card in a conversation does not poll; a pushed decision and a reopened stream read it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state = 'waiting';
    const f = fakeFetch({
      [`GET /api/workflows/runs/${RUN}/node-runs/${NODE_RUN}/approval`]: () => ({
        status: 200,
        body: {
          runId: RUN,
          nodeRunId: NODE_RUN,
          node: 'ask',
          nodeType: 'control.approval',
          scope: '',
          workflow: 'ship',
          project: 'alpha',
          version: 1,
          title: 'Ship?',
          details: null,
          approverRole: 'admin',
          state,
          decidedBy: state === 'waiting' ? null : 'ayse',
          decidedAt: state === 'waiting' ? null : NOW,
          createdAt: NOW,
          dueAt: null,
          runState: 'running',
          untrusted: false,
          canDecide: state === 'waiting',
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <AuthProvider api={fakeApi()} initialState={owner}>
          <StepUpProvider>
            <WorkflowApprovalCard runId={RUN} nodeRunId={NODE_RUN} pushed />
          </StepUpProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').getAttribute('data-state')).toBe('waiting');
    });
    const reads = (): number => f.requests.filter((r) => r.url.endsWith('/approval')).length;
    const before = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(reads()).toBe(before);
    state = 'approved';
    act(() => {
      pushFlowEvent({ kind: 'workflow-approval', runId: RUN, nodeRunId: NODE_RUN, state: 'approved' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').getAttribute('data-state')).toBe('approved');
    });
    const after = reads();
    // Another step's event changes nothing; a reopened stream reads once.
    act(() => {
      pushFlowEvent({
        kind: 'workflow-approval',
        runId: RUN,
        nodeRunId: '33333333-3333-4333-8333-333333333333',
      });
    });
    expect(reads()).toBe(after);
    act(() => {
      flowStreamOpened();
    });
    await waitFor(() => {
      expect(reads()).toBe(after + 1);
    });
  });

  it('"Bu sohbete sonuç gönderme" mutes the scheduled results here, and turns them on again', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      [`PUT /api/chat/threads/${THREAD}/result-mutes`]: (r) => ({
        status: 200,
        body: { target: 'automation:x', muted: (r.body as { muted: boolean }).muted },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <ChatActionsContext.Provider
        value={{ threadId: THREAD, ask: () => undefined, reload: () => undefined }}
      >
        <ScheduledMute scheduled={{ target: `automation:${RUN}`, label: 'Gece raporu' }} />
      </ChatActionsContext.Provider>,
    );
    await user.click(
      screen.getByRole('button', { name: TR.chatFlow.scheduled.muteLabel({ label: 'Gece raporu' }) }),
    );
    await screen.findByText(TR.chatFlow.scheduled.muted({ label: 'Gece raporu' }));
    await user.click(screen.getByTestId('scheduled-unmute'));
    await screen.findByTestId('scheduled-mute-button');
    expect(f.requests.map((r) => r.body)).toEqual([
      { target: `automation:${RUN}`, muted: true },
      { target: `automation:${RUN}`, muted: false },
    ]);
  });
});

describe('plan panel W3 leftovers', () => {
  it('the item editor sends detail and dependencies; a cycle is refused before sending', async () => {
    const user = userEvent.setup();
    const p = plan();
    const a = p.items.find((i) => i.key === 'a');
    if (a === undefined) throw new Error('no a');
    const save = vi.fn<(ops: PlanUserOp[]) => void>();
    render(<ItemEditor item={a} projects={[]} items={p.items} onSave={save} onClose={() => undefined} />);
    await user.type(screen.getByTestId('plan-item-detail'), 'Kırmızı testler');
    const deps = screen.getByTestId('plan-item-depends');
    // a ← c (c already waits for b, b for a): a cycle.
    await user.click(within(deps).getByRole('checkbox', { name: 'Madde c' }));
    expect(screen.getByTestId('plan-item-depends-cycle').textContent).toBe(TR.plan.edit.dependsCycle);
    expect(screen.getByTestId<HTMLButtonElement>('plan-item-editor-save').disabled).toBe(true);
    await user.click(within(deps).getByRole('checkbox', { name: 'Madde c' }));
    await user.click(screen.getByTestId('plan-item-editor-save'));
    expect(save).toHaveBeenCalledWith([{ op: 'detail', key: 'a', detail: 'Kırmızı testler' }]);
    // Pure: dependencies changed → set_depends; unchanged → nothing.
    const b = p.items.find((i) => i.key === 'b');
    if (b === undefined) throw new Error('no b');
    expect(
      editorOps(b, { title: b.title, owner: b.owner, estimate: null, project: null, dependsOn: [] }),
    ).toEqual([{ op: 'set_depends', key: 'b', dependsOn: [] }]);
    expect(
      editorOps(b, { title: b.title, owner: b.owner, estimate: null, project: null, dependsOn: ['a'] }),
    ).toEqual([]);
  });

  it('at most five dependencies can be ticked', async () => {
    const user = userEvent.setup();
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k, n) => item(k, 0, n));
    const p = plan({ items });
    const g = p.items.find((i) => i.key === 'g');
    if (g === undefined) throw new Error('no g');
    render(
      <ItemEditor
        item={g}
        projects={[]}
        items={p.items}
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    const deps = screen.getByTestId('plan-item-depends');
    for (const k of ['a', 'b', 'c', 'd', 'e'])
      await user.click(within(deps).getByRole('checkbox', { name: `Madde ${k}` }));
    expect(within(deps).getByRole<HTMLInputElement>('checkbox', { name: 'Madde f' }).disabled).toBe(true);
  });

  it('"+ Aşama ekle" adds a phase with its first item (applied here at once)', async () => {
    const user = userEvent.setup();
    const p = plan();
    const add = vi.fn<(op: PlanUserOp) => void>();
    render(<AddPhaseRow phase={phaseCount(p)} full={false} onAdd={add} />);
    await user.click(screen.getByTestId('plan-add-phase'));
    await user.type(screen.getByTestId('plan-add-phase-name'), 'Duyuru');
    await user.type(screen.getByTestId('plan-add-phase-item'), 'Blog yazısı');
    await user.click(screen.getByTestId('plan-add-phase-submit'));
    const op = add.mock.calls[0]?.[0];
    expect(op).toEqual({
      op: 'add',
      item: { title: 'Blog yazısı' },
      phase: 2,
      phaseTitle: 'Duyuru',
      after: null,
    });
    const next = applyLocal(p, op === undefined ? [] : [op]);
    expect(next.phases.map((x) => x.title)).toEqual(['Hazırlık', 'Yayın', 'Duyuru']);
    expect(next.items.at(-1)).toMatchObject({ title: 'Blog yazısı', phase: 2, phaseTitle: 'Duyuru' });
    // At eight phases the button is off.
    render(<AddPhaseRow phase={8} full={false} onAdd={add} />);
    expect((screen.getAllByTestId('plan-add-phase')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('dependsCycle and set_depends here', () => {
    const p = plan();
    expect(dependsCycle(p.items, 'a', ['c'])).toBe(true);
    expect(dependsCycle(p.items, 'c', ['a'])).toBe(false);
    const next = applyLocal(p, [{ op: 'set_depends', key: 'c', dependsOn: ['a', 'a'] }]);
    expect(next.items.find((i) => i.key === 'c')?.dependsOn).toEqual(['a']);
  });

  it('the merge view applies again only the operations the person keeps', async () => {
    const user = userEvent.setup();
    const p = plan();
    const ops: PlanUserOp[] = [
      { op: 'rename', key: 'a', title: 'Yeni A' },
      { op: 'skip', key: 'b' },
    ];
    const reapply = vi.fn<(ops?: readonly PlanUserOp[]) => void>();
    render(
      <MergeView
        conflict={{ base: p, ops }}
        current={p}
        yours={['Yeniden adlandırıldı: Yeni A.', 'Atlandı: Madde b.']}
        onReapply={reapply}
        onDiscard={() => undefined}
      />,
    );
    await user.click(screen.getByTestId('plan-merge-toggle'));
    const picks = screen.getAllByTestId('plan-merge-pick');
    expect(picks).toHaveLength(2);
    await user.click(picks[1] as HTMLElement);
    const button = screen.getByTestId('plan-merge-reapply');
    expect(button.textContent).toBe(TR.plan.merge.reapplySelected({ n: 1 }));
    await user.click(button);
    expect(reapply).toHaveBeenCalledWith([{ op: 'rename', key: 'a', title: 'Yeni A' }]);
  });
});

describe('card kind words follow the reader’s language (registry)', () => {
  it('a draft card kind in Turkish and English; account_action has its own entry', async () => {
    const EN = await loadCatalog('en');
    const job = cardFor('draft:job').kind;
    expect(kindLabel(job, TR)).toBe('İş taslağı');
    expect(kindLabel(job, EN)).toBe('Job draft');
    expect(kindLabel(cardFor('draft:account_action').kind, EN)).toBe('Runtime account');
    expect(cardFor('draft:account_action').kind.icon).toBe('key');
    expect(kindLabel(cardFor('needs:question').kind, EN)).toBe(EN.questions.needs.label);
    expect(kindLabel(cardFor('job:outputs').kind, EN)).toBe('Outputs');
    expect(kindLabel(cardFor('unknown:x').kind, EN)).toBe('Record');
    render(
      <I18nProvider locale="en">
        <LiveCard kind={cardFor('draft:workflow_run').kind} title="t" />
      </I18nProvider>,
    );
    expect(screen.getByText('Workflow run')).toBeTruthy();
  });
});
