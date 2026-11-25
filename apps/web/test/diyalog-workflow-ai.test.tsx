// p15-workflow-ai (docs/design/p15-workflow-ai.md): the AI panel of the workflow editor — design puts a validated
// draft onto the canvas at once; an invalid draft (after the master's automatic repair) is shown with its issues and
// leaves the canvas; edit opens the diff review with accept / reject per change; a viewer only explains / debugs.
// In Turkish and in English.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthState } from '../src/auth/AuthProvider';
import type { SessionInfo } from '../src/api/auth';
import type { ThreadDetail } from '../src/api/chat';
import { proposalsOf } from '../src/diyalog/screens/workflows/AiPanel';
import { type Handler, type RecordedRequest, renderApp, sessionBody, USER } from './helpers';
import { CATALOG } from './workflow-catalog-fixture';

configure({ asyncUtilTimeout: 5_000 });

type Locale = 'tr' | 'en';
const AI_THREAD = '7c1d0e3f-2a8b-4d4c-8f9e-3b2c4d5e6f70';
const WF = '55555555-5555-4555-8555-555555555555';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const thread = {
  id: AI_THREAD,
  title: 'Workflow: triage',
  archived: false,
  createdAt: iso(5e6),
  updatedAt: iso(6e4),
};

const SAVED = {
  schemaVersion: 2,
  name: 'triage',
  inputs: {},
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'tell', type: 'notify.users', config: { recipients: { creator: true }, title: 'Done' } },
  ],
  edges: [{ from: 'start', to: 'tell' }],
};
const EDITED = {
  ...SAVED,
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'gate', type: 'control.approval', config: { approverRole: 'admin' } },
    { id: 'tell', type: 'notify.users', config: { recipients: { creator: true }, title: 'Approved' } },
  ],
  edges: [
    { from: 'start', to: 'gate' },
    { from: 'gate', fromPort: 'approved', to: 'tell' },
  ],
};
const DESIGNED = { ...SAVED, name: 'made' };

const WORDS = {
  tr: { applied: 'AI taslağı tuvalde', repaired: 'Otomatik onarımdan sonra da geçersiz', design: 'Tasarla' },
  en: {
    applied: 'The AI draft is on the canvas',
    repaired: 'Still invalid after the automatic repair',
    design: 'Design',
  },
} as const;

function session(locale: Locale): SessionInfo {
  return {
    user: USER,
    createdAt: iso(1e6),
    expiresAt: iso(-1e6),
    idleExpiresAt: iso(-1e5),
    mfaAt: iso(1e6),
    stepUpValidUntil: null,
    stepUpScope: 'window',
    alwaysFreshValidUntil: null,
    type: 'standard',
    locale,
    features: { workflowEngineV2: true },
  };
}
const state = (locale: Locale): AuthState => ({
  kind: 'signedIn',
  user: USER,
  session: session(locale),
  remainingRecoveryCodes: null,
});
function fakeApi(locale: Locale): AuthApi {
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
    getSession: () => Promise.resolve(session(locale)),
  };
}

const msg = (seq: number, role: string, content: string, meta: Record<string, unknown> | null = null) => ({
  id: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`,
  seq,
  role,
  content,
  meta,
  turnId: null,
  createdAt: iso(1000 - seq),
});
const draft = (id: string, definition: Record<string, unknown>, valid: boolean, issues: unknown[] = []) => ({
  id,
  threadId: AI_THREAD,
  kind: 'workflow',
  title: 'Workflow',
  payload: {
    project: 'acme',
    name: definition.name,
    definition,
    schemaVersion: 2,
    valid,
    issues,
    privileged: [],
  },
  project: 'acme',
  state: 'proposed',
  result: null,
  createdAt: iso(500),
  expiresAt: iso(-86_000_000),
  decidedAt: null,
});

/** A conversation that answers the first panel message with `answer` (messages + drafts). */
function conversation(answer: (body: Record<string, unknown>) => { messages: unknown[]; drafts: unknown[] }) {
  let detail: { messages: unknown[]; drafts: unknown[] } = { messages: [], drafts: [] };
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    routes: {
      [`GET /api/chat/threads/${AI_THREAD}`]: () => ({
        status: 200,
        body: { thread, ...detail, turn: null, watches: [], starred: [] },
      }),
      [`POST /api/workflows/ai/threads/${AI_THREAD}/messages`]: (req: RecordedRequest) => {
        const body = req.body as Record<string, unknown>;
        sent.push(body);
        detail = answer(body);
        return { status: 202, body: { message: msg(1, 'user', String(body.text)), turnId: 't1' } };
      },
    } satisfies Record<string, Handler>,
  };
}

function routes(
  locale: Locale,
  opts: { role?: string; workflow?: { name: string | null; definitionId: string | null } },
  over: Record<string, Handler>,
): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), locale, features: { workflowEngineV2: true } },
    }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'mac-1', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: null,
      },
    }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'POST /api/workflows/ai/threads': () => ({
      status: 200,
      body: {
        thread,
        workflow: { project: 'acme', ...(opts.workflow ?? { name: null, definitionId: null }) },
        created: true,
      },
    }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/notifications?limit=20': () => empty,
    'GET /api/queue': () => ({
      status: 200,
      body: { generatedAt: iso(0), total: 0, estimateNote: '', pools: [], paused: [] },
    }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      },
    }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'acme',
            kind: 'workspace',
            createdAt: iso(1e9),
            createdBy: null,
            members: 2,
            myRole: opts.role ?? 'operator',
          },
        ],
      },
    }),
    'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
    'GET /api/workflows/catalog': () => ({ status: 200, body: CATALOG }),
    [`GET /api/workflows/${WF}/definition`]: () => ({
      status: 200,
      body: {
        id: WF,
        project: 'acme',
        name: 'triage',
        version: 2,
        latestVersion: 2,
        latestId: WF,
        archived: false,
        createdBy: 'ayse',
        createdAt: iso(3_600_000),
        hash: 'h2',
        promptsHidden: false,
        definition: SAVED,
      },
    }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('proposalsOf (pure)', () => {
  it('pairs every workflow card with the mode of the request it answered and marks repair answers', () => {
    const detail = {
      thread,
      messages: [
        msg(1, 'user', 'make it', { workflowAi: { mode: 'design', project: 'acme' } }),
        msg(2, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd1' }),
        msg(3, 'user', 'Automatic repair', {
          workflowAi: { mode: 'design', project: 'acme', repairOf: 'd1' },
        }),
        msg(4, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd2' }),
      ],
      drafts: [
        draft('d1', DESIGNED, false, [{ path: 'nodes.0.type', code: 'unknown_type' }]),
        draft('d2', DESIGNED, true),
      ],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
    } as unknown as ThreadDetail;
    const p = proposalsOf(detail);
    expect(p.map((x) => [x.draft.id, x.mode, x.repair, x.valid])).toEqual([
      ['d1', 'design', false, false],
      ['d2', 'design', true, true],
    ]);
    expect(p[0]?.issues).toEqual([{ path: 'nodes.0.type', code: 'unknown_type' }]);
  });
});

describe('workflow editor AI panel (p15-workflow-ai)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: design puts the validated draft onto the canvas at once',
    async (locale) => {
      const user = userEvent.setup();
      const c = conversation(() => ({
        messages: [
          msg(1, 'user', 'make a notifier', { workflowAi: { mode: 'design', project: 'acme' } }),
          msg(2, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd1' }),
          msg(3, 'assistant', 'Done: a manual trigger and a notification.'),
        ],
        drafts: [draft('d1', DESIGNED, true)],
      }));
      renderApp({
        path: '/workflows/new?project=acme&ai=design',
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {}, c.routes),
      });
      const panel = await screen.findByTestId('workflow-ai-panel');
      expect((await within(panel).findByTestId('ai-mode-design')).textContent).toBe(WORDS[locale].design);
      await user.type(await within(panel).findByTestId('ai-input'), 'make a notifier');
      await user.click(within(panel).getByTestId('ai-send'));
      await waitFor(() => {
        expect(screen.getAllByTestId('workflow-node').length).toBe(2);
      });
      expect(screen.getByTestId('workflow-status').textContent).toContain(WORDS[locale].applied);
      expect(c.sent[0]).toMatchObject({ mode: 'design', project: 'acme', text: 'make a notifier' });
      expect(c.sent[0]?.document).toBeDefined();
      expect(within(panel).getByText('Done: a manual trigger and a notification.')).toBeTruthy();
    },
  );

  it.each(['tr', 'en'] as const)(
    '%s: an invalid draft after the automatic repair is shown with its issues; the canvas stays',
    async (locale) => {
      const user = userEvent.setup();
      const bad = { ...DESIGNED, nodes: [{ id: 'x', type: 'magic.wand', config: {} }], edges: [] };
      const issues = [{ path: 'nodes.0.type', code: 'unknown_type' }];
      const c = conversation(() => ({
        messages: [
          msg(1, 'user', 'make it', { workflowAi: { mode: 'design', project: 'acme' } }),
          msg(2, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd1' }),
          msg(3, 'assistant', 'Here.'),
          msg(4, 'user', 'Automatic repair', {
            workflowAi: { mode: 'design', project: 'acme', repairOf: 'd1' },
          }),
          msg(5, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd2' }),
          msg(6, 'assistant', 'Tried again.'),
        ],
        drafts: [draft('d1', bad, false, issues), draft('d2', bad, false, issues)],
      }));
      renderApp({
        path: '/workflows/new?project=acme&ai=design',
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {}, c.routes),
      });
      const panel = await screen.findByTestId('workflow-ai-panel');
      await user.type(await within(panel).findByTestId('ai-input'), 'make it');
      await user.click(within(panel).getByTestId('ai-send'));
      const invalid = await within(panel).findByTestId('ai-invalid');
      expect(invalid.textContent).toContain(WORDS[locale].repaired);
      expect(within(invalid).getByTestId('ai-issues').textContent).toContain('x · ');
      expect(within(panel).getAllByText(/Otomatik onarım|Automatic repair/).length).toBeGreaterThan(0);
      expect(screen.queryAllByTestId('workflow-node')).toHaveLength(0);
    },
  );

  it('edit: the proposal is reviewed as a diff; rejecting one change applies the rest', async () => {
    const user = userEvent.setup();
    const c = conversation(() => ({
      messages: [
        msg(1, 'user', 'put it behind an approval', { workflowAi: { mode: 'edit', project: 'acme' } }),
        msg(2, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd1' }),
        msg(3, 'assistant', 'Added an approval.'),
      ],
      drafts: [draft('d1', EDITED, true)],
    }));
    renderApp({
      path: `/workflows/${WF}?ai=edit`,
      initialState: state('en'),
      api: fakeApi('en'),
      i18n: true,
      routes: routes('en', { workflow: { name: 'triage', definitionId: WF } }, c.routes),
    });
    const panel = await screen.findByTestId('workflow-ai-panel');
    await user.click(await within(panel).findByTestId('ai-mode-edit'));
    await user.type(within(panel).getByTestId('ai-input'), 'put it behind an approval');
    await user.click(within(panel).getByTestId('ai-send'));
    const review = await screen.findByTestId('ai-review');
    const keys = within(review)
      .getAllByTestId('ai-change')
      .map((x) => x.getAttribute('data-key'));
    expect(keys).toEqual([
      'node:+gate',
      'node:~tell',
      'edge:+start:out->gate:in',
      'edge:+gate:approved->tell:in',
      'edge:-start:out->tell:in',
    ]);
    expect(c.sent[0]).toMatchObject({ mode: 'edit', workflowId: WF });
    // The canvas marks the proposal and is locked while reviewing.
    await waitFor(() => {
      const marks = screen
        .getAllByTestId('workflow-node')
        .map((n) => [n.getAttribute('data-node'), n.getAttribute('data-diff')]);
      expect(marks).toEqual(
        expect.arrayContaining([
          ['gate', 'added'],
          ['tell', 'changed'],
        ]),
      );
    });
    // Reject the changed notification, apply the rest.
    const tell = within(review)
      .getAllByTestId('ai-change')
      .find((x) => x.getAttribute('data-key') === 'node:~tell');
    await user.click(within(tell as HTMLElement).getByRole('checkbox'));
    await user.click(within(review).getByTestId('ai-apply'));
    await waitFor(() => {
      expect(screen.queryByTestId('ai-review')).toBeNull();
    });
    expect(screen.getAllByTestId('workflow-node').map((n) => n.getAttribute('data-node'))).toEqual(
      expect.arrayContaining(['start', 'gate', 'tell']),
    );
    expect(screen.getAllByTestId('workflow-node').every((n) => n.getAttribute('data-diff') === null)).toBe(
      true,
    );
    expect(screen.getByTestId('workflow-status').textContent).toContain('4 changes applied');
    expect(screen.getByTestId('workflow-dirty')).toBeTruthy();
  });

  it('edit: rejecting all leaves the canvas as it was', async () => {
    const user = userEvent.setup();
    const c = conversation(() => ({
      messages: [
        msg(1, 'user', 'x', { workflowAi: { mode: 'edit', project: 'acme' } }),
        msg(2, 'tool', 'draft_workflow', { name: 'draft_workflow', isError: false, draftId: 'd1' }),
      ],
      drafts: [draft('d1', EDITED, true)],
    }));
    renderApp({
      path: `/workflows/${WF}?ai=edit`,
      initialState: state('tr'),
      api: fakeApi('tr'),
      i18n: true,
      routes: routes('tr', { workflow: { name: 'triage', definitionId: WF } }, c.routes),
    });
    const panel = await screen.findByTestId('workflow-ai-panel');
    await user.click(await within(panel).findByTestId('ai-mode-edit'));
    await user.type(within(panel).getByTestId('ai-input'), 'x');
    await user.click(within(panel).getByTestId('ai-send'));
    const review = await screen.findByTestId('ai-review');
    await user.click(within(review).getByTestId('ai-reject-all'));
    await waitFor(() => {
      expect(screen.queryByTestId('ai-review')).toBeNull();
    });
    expect(screen.getAllByTestId('workflow-node').map((n) => n.getAttribute('data-node'))).toEqual([
      'start',
      'tell',
    ]);
    expect(screen.getByTestId('workflow-status').textContent).toContain('Öneri reddedildi');
    expect(screen.queryByTestId('workflow-dirty')).toBeNull();
  });

  it('a viewer gets explain and debug only; explain sends no change request', async () => {
    const user = userEvent.setup();
    const c = conversation(() => ({
      messages: [
        msg(1, 'user', 'What does this workflow do?', { workflowAi: { mode: 'explain', project: 'acme' } }),
        msg(2, 'assistant', 'It notifies you when started.'),
      ],
      drafts: [],
    }));
    renderApp({
      path: `/workflows/${WF}?ai=explain`,
      initialState: state('en'),
      api: fakeApi('en'),
      i18n: true,
      routes: routes('en', { role: 'viewer', workflow: { name: 'triage', definitionId: WF } }, c.routes),
    });
    const panel = await screen.findByTestId('workflow-ai-panel');
    await within(panel).findByTestId('ai-mode-explain');
    expect(within(panel).queryByTestId('ai-mode-design')).toBeNull();
    expect(within(panel).queryByTestId('ai-mode-edit')).toBeNull();
    expect(within(panel).getByTestId('ai-mode-debug')).toBeTruthy();
    await user.click(within(panel).getByTestId('ai-explain'));
    await within(panel).findByText('It notifies you when started.');
    expect(c.sent[0]).toMatchObject({ mode: 'explain', text: 'What does this workflow do?', workflowId: WF });
    expect(c.sent[0]?.selected).toBeUndefined();
  });
});
