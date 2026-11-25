// p12-diyalog Faz 0: the Diyalog shell — the only UI since p15-classic-removal (the classic console and the per-browser
// switch were removed; old URLs keep working, see "old classic URLs"); home = the panel dashboard (direction change
// 2026-10-19: "Senden bekleyen" + panels, no chat thread; Sohbet is its own screen).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { forgetLegacyUiChoice, LEGACY_UI_STORAGE_KEY, withoutLegacyParams } from '../src/lib/legacyUrl';
import { type Handler, renderApp, sessionBody } from './helpers';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };

function worker(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: null,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '1.0.0',
    runningJobs: 1,
    lastSeenAt: iso(1000),
    createdAt: iso(86_400_000),
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    ...over,
  };
}

const overview = {
  id: 'w-ok',
  capacity: { running: 1, max: 3 },
  capabilitiesAt: iso(60_000),
  sandboxProfiles: [],
  sandboxReadiness: [],
  tools: [],
  load: null,
  network: { key: 'n', label: 'n' },
  runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
  release: { channel: 'stable', targetVersion: null, lastAttempt: null },
  compatibility: [{ runtime: 'codex', status: 'ready', version: '1', reason: 'ready' }],
};

const approval = {
  id: 'ap-1',
  jobId: 'j-1',
  project: 'acme',
  jobState: 'AWAITING_APPROVAL',
  attemptId: null,
  epoch: 1,
  approvalKey: 'gate:git.merge',
  kind: 'gate',
  action: 'git.merge',
  requestedAction: 'git.merge',
  risk: 'high',
  summary: 'Merge feature/login into main',
  requestedBy: { type: 'system', id: 'integrator' },
  workerId: null,
  policyVersion: 0,
  approverRole: 'admin',
  requiredApprovals: 1,
  approvals: 0,
  stepUp: true,
  status: 'pending',
  createdAt: iso(60_000),
  expiresAt: iso(-3_600_000),
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
};

const running = {
  id: 'j-run',
  project: 'acme',
  projectKind: 'repo',
  state: 'RUNNING',
  runtime: 'claude-code',
  title: 'Refactor the login form',
  attempts: 1,
  workerId: 'w-ok',
  createdBy: { type: 'user', id: 'u1' },
  createdAt: iso(120_000),
  stateChangedAt: iso(60_000),
};

const THREAD_ID = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const thread = {
  id: THREAD_ID,
  title: 'Morning summary',
  archived: false,
  createdAt: iso(600_000),
  updatedAt: iso(60_000),
};
const message = (
  seq: number,
  role: string,
  content: string,
  meta: unknown = null,
): Record<string, unknown> => ({
  id: `m${String(seq)}`,
  seq,
  role,
  content,
  meta,
  turnId: null,
  createdAt: iso(500_000 - seq * 1000),
});

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [approval] } }),
    'GET /api/jobs?state=FAILED&limit=50': () => empty,
    'GET /api/jobs?state=SUCCEEDED&limit=50': () => empty,
    'GET /api/jobs?state=BLOCKED&limit=50': () => empty,
    'GET /api/jobs?state=LOST&limit=50': () => empty,
    'GET /api/jobs?state=RUNNING%2CSTARTING%2CVERIFYING%2CAWAITING_APPROVAL&limit=200': () => ({
      status: 200,
      body: { items: [running], nextCursor: null },
    }),
    'GET /api/jobs?limit=50': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [worker('w-ok', 'linux-a')] } }),
    'GET /api/fleet/overview': () => ({ status: 200, body: { workers: [overview] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 2, threads: 1 } }),
    'GET /api/ops-thread?limit=50': () => ({
      status: 404,
      body: { error: 'not_found', message: 'Not found.' },
    }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD_ID}`]: () => ({
      status: 200,
      body: {
        thread,
        messages: [
          message(1, 'user', 'What is waiting for me?'),
          message(2, 'tool', 'approvals_list: 1', { name: 'approvals_list', draftId: 'd1' }),
          message(3, 'assistant', 'One **merge** waits for you.'),
        ],
        drafts: [
          {
            id: 'd1',
            threadId: THREAD_ID,
            kind: 'approval_decision',
            title: 'Approve the merge into main',
            payload: {},
            project: 'acme',
            state: 'proposed',
            result: null,
            createdAt: iso(400_000),
            expiresAt: iso(-1_800_000),
            decidedAt: null,
          },
        ],
        turn: null,
        watches: [],
        starred: [],
      },
    }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [
          {
            workerId: 'w-ok',
            workerName: 'linux-a',
            workerState: 'online',
            runtime: 'claude-code',
            auth: 'subscription',
            store: null,
            source: 'probe',
            plan: 'max',
            available: true,
            observedAt: iso(60_000),
            stale: false,
            reports: true,
            level: 'ok',
            windows: [
              {
                id: 'five_hour',
                kind: 'session',
                label: null,
                usedPercent: 72,
                windowMinutes: 300,
                resetsAt: iso(-3_600_000),
                status: null,
                level: 'ok',
                history: [],
              },
            ],
            limit: null,
          },
        ],
        otherLimits: [],
      },
    }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Diyalog shell (p12-diyalog Faz 0; the only UI since p15-classic-removal)', () => {
  it('the Home panel dashboard with "Senden bekleyen" and the panels', async () => {
    const r = renderApp({ path: '/', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ana sayfa' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();

    // An older master without GET /ops-thread (404): "Senden bekleyen" falls back to the needs-you data. p17-needs-page:
    // the home shows its summary; the most urgent item links to its fix.
    const needs = await screen.findByRole('region', { name: 'Senden bekleyen' });
    expect(await within(needs).findByText('Senden 1 karar bekliyor')).toBeTruthy();
    expect(within(needs).getByTestId('dy-home-needs-urgent').getAttribute('href')).toBe('/approvals/ap-1');

    // No ops chat on Home (Sohbet is its own screen): no thread log, no chat read.
    expect(screen.queryByRole('log', { name: 'Operasyon akışı' })).toBeNull();
    expect(r.requests.some((q) => q.url.startsWith(`/api/chat/threads/${THREAD_ID}`))).toBe(false);

    // Panels: running jobs, machines with slots, limit windows.
    const running = screen.getByTestId('dy-home-running');
    expect(await within(running).findByRole('link', { name: /Refactor the login form/ })).toBeTruthy();
    const machines = screen.getByTestId('dy-home-machines');
    expect(await within(machines).findByText('linux-a')).toBeTruthy();
    const limits = screen.getByTestId('dy-home-limits');
    expect(await within(limits).findByRole('meter', { name: 'Claude Code 5h' })).toBeTruthy();
    expect(within(limits).getByRole('meter', { name: 'Claude Code 5h' }).getAttribute('aria-valuenow')).toBe(
      '72',
    );

    // Nav rail: Ana sayfa first and current, Sohbet with its unread count, the rest.
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
    expect(within(nav).getByRole('link', { name: 'Ana sayfa' }).getAttribute('aria-current')).toBe('page');
    // p12-diyalog Faz 3: Sohbet is its own screen (/chat). By design, no "Yeni iş" item in the rail (İşler and
    // Sohbet start new work; `n` opens the form).
    expect(within(nav).getByRole('link', { name: 'Sohbet, 2 okunmamış' }).getAttribute('href')).toBe('/chat');
    expect(within(nav).queryByRole('link', { name: 'Yeni iş' })).toBeNull();
    // i18n Phase 1: the rail speaks Turkish (glossary), "Workflow’lar" keeps the English term.
    expect(within(nav).getByRole('link', { name: 'Senden bekleyenler, 1 bekliyor' })).toBeTruthy();
    for (const label of ['İşler', 'Workflow’lar', 'Makineler', 'Çıktılar', 'Kullanım', 'Projeler', 'Ayarlar'])
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy();
  });

  it('p17-needs-page: /needs lists the fallback needs-you rows with their fix', async () => {
    renderApp({ path: '/needs', initialState: signedIn, routes: routes() });
    const needs = await screen.findByRole('region', { name: 'Senden 1 karar bekliyor' });
    expect(within(needs).getByRole('link', { name: 'Çöz' }).getAttribute('href')).toBe('/approvals/ap-1');
  });

  it('"Tümü" lists every section, and nothing offers a classic console any more', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/', initialState: signedIn, routes: routes() });
    await screen.findByRole('heading', { level: 1, name: 'Ana sayfa' });
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
    await user.click(within(nav).getByRole('link', { name: 'İşler' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'İşler' })).toBeTruthy();
    await user.click(within(nav).getByRole('button', { name: 'Tümü' }));
    const all = screen.getByRole('dialog', { name: 'Tüm ekranlar' });
    for (const label of ['Denetim kaydı', 'Onaylar', 'Otomasyonlar', 'Uptime', 'Bağlam', 'Ayarlar'])
      expect(within(all).getByRole('link', { name: label })).toBeTruthy();
    expect(within(all).queryByText(/klasik/i)).toBeNull();
    await user.keyboard('{Escape}');
    // The account menu has no classic entries either.
    await user.click(screen.getByTestId('dy-account'));
    const menu = screen.getByRole('region', { name: 'Hesap' });
    expect(within(menu).queryByText(/klasik/i)).toBeNull();
    expect(screen.queryByTestId('ui-switch')).toBeNull();
    expect(screen.queryAllByRole('navigation', { name: 'Primary' })).toHaveLength(0);
  });

  it('the token stylesheet is scoped: no Diyalog variable is declared on :root or html', () => {
    const css = readFileSync(join(__dirname, '../src/diyalog/diyalog.css'), 'utf8');
    // Every rule that declares a --dy-* token has a [data-ui='diyalog'] selector.
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*--dy-[a-z0-9-]+\s*:[^{}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(2);
    for (const [, selector] of blocks) expect(selector).toContain("[data-ui='diyalog']");
    expect(css).not.toMatch(/(^|\n)\s*:root\s*\{[^}]*--dy-/);
  });
});

// p15-classic-removal (docs/design/p15-classic-removal.md §4): old classic URLs and the old view switch keep working.
describe('old classic URLs (p15-classic-removal)', () => {
  it('withoutLegacyParams drops only ?ui= and ?gorunum=', () => {
    expect(withoutLegacyParams('')).toBeNull();
    expect(withoutLegacyParams('?tab=queue')).toBeNull();
    expect(withoutLegacyParams('?ui=classic')).toBe('');
    expect(withoutLegacyParams('?ui=diyalog&tab=queue')).toBe('?tab=queue');
    expect(withoutLegacyParams('?state=FAILED&gorunum=klasik')).toBe('?state=FAILED');
  });

  it('a stored classic choice is forgotten and changes nothing', async () => {
    window.localStorage.setItem(LEGACY_UI_STORAGE_KEY, 'classic');
    forgetLegacyUiChoice();
    expect(window.localStorage.getItem(LEGACY_UI_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(LEGACY_UI_STORAGE_KEY, 'classic');
    renderApp({ path: '/', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ana sayfa' })).toBeTruthy();
  });

  it('?ui=classic and ?gorunum=klasik open the Diyalog screen with the rest of the query', async () => {
    const r = renderApp({
      path: '/jobs?gorunum=klasik&state=FAILED',
      initialState: signedIn,
      routes: routes(),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'İşler' })).toBeTruthy();
    await waitFor(() => {
      expect(r.requests.some((q) => q.url.startsWith('/api/jobs?') && q.url.includes('state=FAILED'))).toBe(
        true,
      );
    });
    expect(screen.queryByText(/klasik/i)).toBeNull();
  });

  it('?ui=classic on the sign-in URL shows the Diyalog sign-in', async () => {
    renderApp({ path: '/login?ui=classic', routes: {} });
    expect(await screen.findByRole('heading', { level: 1, name: 'Konsola giriş yap' })).toBeTruthy();
    expect(screen.queryByTestId('ui-switch')).toBeNull();
  });

  it('moved URLs redirect: /fleet → Makineler, /jobs/schedules → Otomasyonlar, /settings/projects → Projeler', async () => {
    const a = renderApp({ path: '/fleet', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Makineler' })).toBeTruthy();
    a.unmount();
    const b = renderApp({ path: '/jobs/schedules', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Otomasyonlar' })).toBeTruthy();
    b.unmount();
    renderApp({ path: '/settings/projects', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Projeler' })).toBeTruthy();
  });

  it('an unknown path is "Sayfa bulunamadı", never an empty page', async () => {
    renderApp({ path: '/no/such/page', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sayfa bulunamadı' })).toBeTruthy();
    expect(screen.getByText('/no/such/page')).toBeTruthy();
  });
});
