// p14-i18n-screens-a (i18n Phase 5): İşler in English — the job list (presets, filters, rows, sort), the queue
// (class lanes, waits, paused jobs) and the job-list helpers speak the user's language; Turkish stays the default.
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { nodeLook, placementText, runLook } from '../src/diyalog/screens/jobs/WorkflowRuns';
import { spanText, spanTr } from '../src/diyalog/screens/jobs/views';
import type { WorkflowNode } from '../src/api/workflows';
import { LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

const J1 = '11111111-1111-4111-8111-111111111111';

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/workflows': () => ({ status: 200, body: { items: [] } }),
    'GET /api/workflow-runs': () => ({ status: 200, body: { items: [] } }),
    ...over,
  };
}

const LIST = {
  status: 200,
  body: {
    items: [
      {
        id: J1,
        project: 'acme',
        projectKind: 'workspace',
        state: 'FAILED',
        runtime: 'codex',
        title: 'Fix the login test',
        attempts: 2,
        workerId: null,
        createdBy: { type: 'user', id: USER.id },
        createdAt: iso(3_600_000),
        stateChangedAt: iso(1_800_000),
      },
    ],
    nextCursor: null,
  },
};

const QUEUE = {
  status: 200,
  body: {
    generatedAt: iso(0),
    total: 1,
    estimateNote: 'Estimated start: an estimate, not a promise.',
    pools: [
      {
        key: 'host-restricted',
        profile: 'host-restricted',
        machines: [
          {
            id: 'w1',
            name: 'desktop-pc',
            slots: 3,
            profileSlots: 1,
            running: 1,
            urgentReserve: 1,
            urgentReserveAuto: false,
            urgentReserveEffective: 1,
            subscriptionLogins: null,
          },
        ],
        jobs: [
          {
            jobId: J1,
            project: 'acme',
            title: 'Queued work',
            runtime: 'claude-code',
            sandboxProfile: 'host-restricted',
            state: 'QUEUED',
            priority: 0,
            storedPriority: 0,
            priorityClass: 'urgent',
            adjusted: null,
            position: 1,
            waitingSince: iso(125_000),
            waitingSec: 125,
            category: 'profile_slot',
            reasons: [{ code: 'no_free_profile_slot', category: 'profile_slot', message: 'desktop-pc busy' }],
            estimatedStart: iso(-1_800_000),
            createdBy: USER.id,
            canReorder: false,
          },
        ],
      },
    ],
    paused: [],
  },
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('İşler in English (p14-i18n-screens-a)', { timeout: 20_000 }, () => {
  it('renders the job list, presets, filters and rows in English', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    renderApp({
      path: '/jobs',
      initialState: signedIn,
      i18n: true,
      routes: routes({ 'GET /api/jobs?limit=50': () => LIST }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Jobs' })).toBeTruthy();
    const presets = screen.getByRole('navigation', { name: 'Saved views' });
    expect(within(presets).getByRole('button', { name: 'Awaiting approval' })).toBeTruthy();
    expect(screen.getByRole('search', { name: 'Filter jobs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
    const row = await screen.findByTestId('job-row');
    expect(row.textContent).toContain('· workspace');
    expect(within(row).getByRole('link', { name: 'Run again: Fix the login test' })).toBeTruthy();
    expect(screen.getByTestId('job-sort-note').textContent).toContain('Server order: newest first');
    expect(document.body.textContent).not.toMatch(/Tüm işler|Süzgeç|Hazır görünümler|Başlıksız/);
  });

  it('renders the queue tab in English', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    renderApp({
      path: '/jobs?tab=queue',
      initialState: signedIn,
      i18n: true,
      routes: routes({ 'GET /api/queue': () => QUEUE }),
    });
    const lane = await screen.findByTestId('queue-lane');
    expect(lane.getAttribute('aria-label')).toBe('Urgent class, 1 job');
    expect(screen.getByTestId('queue-reason').textContent).toContain('Profile slots full');
    expect(screen.getByText('1 slot kept for Urgent')).toBeTruthy();
    expect(screen.getByTestId('queue-estimate-note').textContent).toContain('Urgent · Standard · Background');
    expect(screen.getByLabelText('waiting 2 min')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Kuyrukta|bekliyor|Acil/);
  });

  it('switches the presets back to Turkish by default', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    renderApp({
      path: '/jobs',
      initialState: signedIn,
      i18n: true,
      routes: routes({ 'GET /api/jobs?limit=50': () => LIST }),
    });
    const presets = await screen.findByRole('navigation', { name: 'Hazır görünümler' });
    await user.click(within(presets).getByRole('button', { name: 'Onay bekleyen' }));
    expect(within(presets).getByRole('button', { name: 'Onay bekleyen' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('job list helpers in both languages', () => {
  const tr = messagesFor('tr');
  // English is a lazy catalog: read it after test/setup.ts has loaded it (not while collecting).
  let en = tr;
  beforeAll(() => {
    en = messagesFor('en');
  });

  it('says spans in each language; the Turkish wrapper stays as it was', () => {
    expect(spanText(45_000, tr)).toBe('45 sn');
    expect(spanText(3_900_000, tr)).toBe('1 sa 05 dk');
    expect(spanText(2 * 86_400_000 + 3 * 3_600_000, tr)).toBe('2 g 3 sa');
    expect(spanText(45_000, en)).toBe('45 s');
    expect(spanText(720_000, en)).toBe('12 min');
    expect(spanText(3_900_000, en)).toBe('1 h 05 min');
    expect(spanTr(720_000)).toBe('12 dk');
  });

  it('names run and step states, and a step’s placement', () => {
    expect(runLook('awaiting_merge', en).label).toBe('Awaiting merge');
    expect(runLook('awaiting_merge', tr).label).toBe('Birleştirme bekliyor');
    expect(runLook('odd_state', en).label).toBe('odd state');
    const node = {
      state: 'queued',
      jobState: null,
      runtime: 'codex',
      placement: { runtime: 'codex', model: 'gpt-5', notes: [] },
      workerName: 'pc-1',
    } as unknown as WorkflowNode;
    expect(nodeLook(node, en).label).toBe('Queued');
    expect(placementText(node, en)).toBe('Runs with Codex (model gpt-5) · on pc-1');
    expect(placementText(node, tr)).toBe('Codex ile çalışır (model gpt-5) · pc-1 üzerinde');
  });
});
