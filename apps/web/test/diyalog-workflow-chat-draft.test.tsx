// p14-workflow-engine 14.5: a chat card of a version-2 workflow draft — the typed mini graph (node type labels from the
// catalog, branch port labels), the notice that confirming needs an admin and a verification code, and "Editörde aç",
// which opens the editor with the drafted document as the unsaved working copy. In Turkish and in English.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthState } from '../src/auth/AuthProvider';
import type { SessionInfo } from '../src/api/auth';
import { draftEditorTarget } from '../src/diyalog/drafts/DraftCard';
import { chatDraftDoc } from '../src/diyalog/screens/workflows/WorkflowEditor';
import { workflowDraftOf } from '../src/screens/chat/workflowDraft';
import { openStripCard } from './card-strip';
import { type Handler, renderApp, sessionBody, USER } from './helpers';
import { CATALOG } from './workflow-catalog-fixture';

configure({ asyncUtilTimeout: 5_000 });

type Locale = 'tr' | 'en';
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const WF = '55555555-5555-4555-8555-555555555555';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const thread = { id: THREAD, title: 'Ops', archived: false, createdAt: iso(5e6), updatedAt: iso(6e4) };

const DEFINITION = {
  schemaVersion: 2,
  name: 'lead-intake',
  inputs: {},
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'fetch', type: 'http.request', config: { origin: 'https://api.example.com', path: '/v1' } },
    { id: 'hot', type: 'control.if', config: { condition: '{{ $input.status = 200 }}' } },
    { id: 'keep', type: 'data.set', label: 'Keep it', config: { fields: { a: 1 } } },
  ],
  edges: [
    { from: 'start', to: 'fetch' },
    { from: 'fetch', to: 'hot' },
    { from: 'hot', fromPort: 'true', to: 'keep' },
  ],
};
const PAYLOAD = {
  project: 'acme',
  name: 'lead-intake',
  definition: DEFINITION,
  schemaVersion: 2,
  valid: true,
  issues: [],
  privileged: ['workflows.define.network'],
  needsStepUp: true,
  nodes: [
    { id: 'start', role: '', gate: null, dynamic: false, type: 'trigger.manual' },
    { id: 'fetch', role: '', gate: null, dynamic: false, type: 'http.request' },
    { id: 'hot', role: '', gate: null, dynamic: false, type: 'control.if' },
    { id: 'keep', role: '', gate: null, dynamic: false, type: 'data.set', label: 'Keep it' },
  ],
  edges: [
    { from: 'start', to: 'fetch' },
    { from: 'fetch', to: 'hot' },
    { from: 'hot', to: 'keep', fromPort: 'true' },
  ],
};

const WORDS = {
  tr: {
    http: 'HTTP isteği',
    ifElse: 'Eğer / değilse',
    open: 'Editörde aç',
    privileged: 'ağ (HTTP / e-posta / GitHub)',
    opened: 'Sohbet taslağı açıldı — kaydedene kadar hiçbir şey değişmez.',
  },
  en: {
    http: 'HTTP request',
    ifElse: 'If / else',
    open: 'Open in editor',
    privileged: 'network (HTTP / e-mail / GitHub)',
    opened: 'Chat draft opened — nothing changes until you save.',
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

function routes(locale: Locale, over: Record<string, Handler> = {}): Record<string, Handler> {
  const draft = {
    id: '00000000-0000-4000-8000-000000000001',
    threadId: THREAD,
    kind: 'workflow',
    title: 'New workflow lead-intake',
    payload: PAYLOAD,
    project: 'acme',
    state: 'proposed',
    result: null,
    createdAt: iso(120_000),
    expiresAt: iso(-1_680_000),
    decidedAt: null,
  };
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
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: { thread, messages: [], drafts: [draft], turn: null, watches: [], starred: [] },
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
            myRole: 'admin',
          },
        ],
      },
    }),
    'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
    'GET /api/workflows/catalog': () => ({ status: 200, body: CATALOG }),
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

describe('version-2 workflow drafts in chat (pure)', () => {
  it('reads types, ports, privileges and the document; the editor target keeps the draft as state', () => {
    const wf = workflowDraftOf(PAYLOAD);
    expect(wf.schemaVersion).toBe(2);
    expect(wf.nodes.map((n) => n.type)).toEqual(['trigger.manual', 'http.request', 'control.if', 'data.set']);
    expect(wf.nodes[3]?.label).toBe('Keep it');
    expect(wf.edges[2]?.fromPort).toBe('true');
    expect(wf.privileged).toEqual(['workflows.define.network']);
    expect(draftEditorTarget(wf)).toEqual({
      to: '/workflows/new?project=acme',
      state: { draft: DEFINITION },
    });
    expect(draftEditorTarget({ ...wf, workflowId: WF })?.to).toBe(`/workflows/${WF}`);
    expect(draftEditorTarget({ ...wf, definition: null })).toBeNull();
    // v1 payloads keep reading as before (AI steps).
    const v1 = workflowDraftOf({ nodes: [{ id: 'a', role: 'executor' }], edges: [{ from: 'a', to: 'b' }] });
    expect(v1).toMatchObject({ schemaVersion: 1, privileged: [], definition: null });
    expect(v1.nodes[0]?.type).toBe('ai.step');
  });

  it('the editor takes the router-state draft as a document, refuses junk', () => {
    expect(chatDraftDoc(null)).toBeNull();
    expect(chatDraftDoc({ saved: 2 })).toBeNull();
    const doc = chatDraftDoc({ draft: DEFINITION });
    expect(doc === 'unreadable' || doc === null ? null : doc.nodes.map((n) => n.id)).toEqual([
      'start',
      'fetch',
      'hot',
      'keep',
    ]);
    expect(chatDraftDoc({ draft: { nodes: 'x' } })).toBe('unreadable');
  });
});

describe('version-2 workflow draft card (p14-workflow-engine 14.5)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: typed graph, privileged notice, "Editörde aç" opens the editor with the draft',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      renderApp({
        path: `/chat/${THREAD}`,
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale),
      });
      const card = await openStripCard('New workflow lead-intake', { en: locale === 'en' });
      const nodes = within(card).getAllByTestId('workflow-draft-node');
      expect(nodes.map((n) => n.getAttribute('data-type'))).toEqual([
        'trigger.manual',
        'http.request',
        'control.if',
        'data.set',
      ]);
      expect(nodes[1]?.textContent).toContain(w.http);
      expect(nodes[2]?.textContent).toContain(w.ifElse);
      expect(nodes[3]?.textContent).toContain('Keep it');
      expect(within(card).getByTestId('workflow-draft-port').textContent).toBe('true');
      expect(within(card).getByTestId('workflow-draft-privileged').textContent).toContain(w.privileged);
      await user.click(within(card).getByRole('link', { name: w.open }));
      const status = await screen.findByTestId('workflow-status');
      expect(status.textContent).toContain(w.opened);
      await waitFor(() => {
        expect(screen.getAllByTestId('workflow-node').length).toBe(4);
      });
    },
  );
});
