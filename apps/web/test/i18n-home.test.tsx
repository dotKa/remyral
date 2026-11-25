// p14-i18n-screens-a (i18n Phase 5): the Home dashboard and the operations-thread parts (`ops/*`) come from the
// `home` catalog — Turkish by default (the existing Diyalog tests keep querying the Turkish text), English when the
// user's language is `en`: page header, panels, live decision cards, the decision row, day separators and ages.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFormatter, messagesFor } from '@remyral/i18n';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { agoText } from '../src/diyalog/ops/cards';
import { DecisionPanel } from '../src/diyalog/ops/DecisionPanel';
import { dayLabel } from '../src/diyalog/ops/timeline';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody } from './helpers';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const A1 = '7c1e09ab-0000-4000-8000-000000000001';
const M1 = '9e8d7c6b-0000-4000-8000-000000000001';

const approval = {
  id: A1,
  jobId: 'j-1',
  project: 'mobil-app',
  jobState: 'RUNNING',
  kind: 'in_run',
  action: 'bash',
  requestedAction: 'bash',
  risk: 'high',
  summary: 'Bash: rm -rf node_modules',
  requestedBy: { type: 'runtime', id: 'w1' },
  workerId: null,
  approverRole: 'operator',
  requiredApprovals: 1,
  approvals: 0,
  stepUp: true,
  status: 'pending',
  epoch: 1,
  createdAt: iso(18 * MIN),
  expiresAt: iso(-42 * MIN),
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  details: { tool: 'Bash', description: 'Clear the lockfile cache', command: 'rm -rf node_modules' },
  hints: {
    runs: ['rm'],
    reaches: [],
    writes: [],
    deletes: ['node_modules'],
    installs: [],
    envVars: [],
    outside: [],
    elevated: false,
    safeVerdict: null,
    partial: false,
  },
  headline: { text: 'Clear node_modules and reinstall', source: 'agent' },
};

const merge = {
  id: M1,
  project: 'mobil-app',
  source: 'coordinator',
  rootJobId: 'j-root',
  runId: null,
  nodeId: null,
  branch: 'int/7c1e09ab',
  targetBranch: 'main',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  orderMode: 'dependency',
  state: 'ready',
  reason: null,
  resolutionRounds: 0,
  maxResolutions: 3,
  fixRounds: 0,
  maxFixes: 1,
  branches: [],
  jobs: [],
  warnings: [],
  verification: null,
  pullRequest: { number: 218, url: 'https://github.com/acme/app/pull/218' },
  mergeJobId: 'j-merge',
  log: [],
  createdAt: iso(30 * MIN),
  updatedAt: iso(3 * MIN),
};

function card(type: string, id: string, at: number, payload: unknown) {
  return { id, type, at: iso(at), subject: id, unread: false, event: null, payload };
}

const routes: Record<string, Handler> = {
  'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
  'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
  'GET /api/jobs?state=FAILED&limit=50': () => empty,
  'GET /api/jobs?state=SUCCEEDED&limit=50': () => empty,
  'GET /api/jobs?state=BLOCKED&limit=50': () => empty,
  'GET /api/jobs?state=LOST&limit=50': () => empty,
  'GET /api/jobs?state=RUNNING&limit=50': () => empty,
  'GET /api/jobs?state=STARTING&limit=50': () => empty,
  'GET /api/jobs?state=VERIFYING&limit=50': () => empty,
  'GET /api/jobs?state=AWAITING_APPROVAL&limit=50': () => empty,
  'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
  'GET /api/fleet/overview': () => ({ status: 200, body: { workers: [] } }),
  'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
  'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [], nextCursor: null } }),
  'GET /api/usage-limits/overview': () => ({
    status: 200,
    body: {
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    },
  }),
  'GET /api/ops-thread?limit=50': () => ({
    status: 200,
    body: {
      items: [
        card('approval:request', `approval:${A1}`, 18 * MIN, approval),
        card('merge:integration', `merge:${M1}`, 3 * MIN, merge),
      ],
      nextCursor: null,
      open: null,
    },
  }),
};

function home(locale: 'tr' | 'en') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  return renderApp({ path: '/', initialState: signedIn, routes, i18n: true });
}

/** p17-needs-page: the decisions page. */
function needsPage(locale: 'tr' | 'en') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  return renderApp({ path: '/needs', initialState: signedIn, routes, i18n: true });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Home in English', () => {
  it('says the header, the needs summary, quick access and the panels in English, no Turkish copy', async () => {
    home('en');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    const tile = await screen.findByRole('region', { name: 'Needs you' });
    expect(await within(tile).findByText('2 decisions need you')).toBeTruthy();
    expect(
      within(tile)
        .getByRole('link', { name: /Open all/ })
        .getAttribute('href'),
    ).toBe('/needs');
    const quick = screen.getByRole('region', { name: 'Quick access' });
    expect(within(quick).getByRole('link', { name: 'New job' })).toBeTruthy();
    expect(within(quick).getByRole('link', { name: 'Use the form' })).toBeTruthy();
    expect(within(quick).getByRole('navigation', { name: 'Screens' })).toBeTruthy();
    expect(await screen.findByText('Running jobs')).toBeTruthy();
    expect(screen.getByText('Recent failures')).toBeTruthy();
    expect(screen.getByText('No failed or lost jobs.')).toBeTruthy();
    for (const tr of [
      'Ana sayfa',
      'Çalışan işler',
      'Son hatalar',
      'Senden 2 karar bekliyor',
      'Hızlı erişim',
      'Tümünü aç',
    ])
      expect(screen.queryByText(tr)).toBeNull();
  });

  it('the needs page says its title and the decisions in English', async () => {
    needsPage('en');
    expect(await screen.findByRole('heading', { level: 1, name: 'Needs you' })).toBeTruthy();
    const panel = await screen.findByTestId('dy-needs-decisions');
    expect(await within(panel).findByRole('heading', { name: '2 decisions need you' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Approval history' }).getAttribute('href')).toBe('/approvals');
    expect(screen.queryByText('Senden bekleyenler')).toBeNull();
  });

  it('renders the live approval and merge cards in English', async () => {
    needsPage('en');
    const panel = await screen.findByTestId('dy-needs-decisions');
    const a = await within(panel).findByRole('article', { name: /Clear node_modules/ });
    expect(within(a).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(a).getByRole('button', { name: 'Deny with a reason' })).toBeTruthy();
    expect(within(a).getByText('Approval, high risk')).toBeTruthy();
    expect(within(a).getByText('Deletes')).toBeTruthy();
    const m = await within(panel).findByRole('article', { name: /into main\?/ });
    expect(within(m).getByRole('link', { name: 'Open PR #218' })).toBeTruthy();
    expect(within(m).getByRole('button', { name: 'Request merge approval' })).toBeTruthy();
    expect(within(m).getByText('0/0 branches')).toBeTruthy();
    expect(screen.queryByText('Onayla')).toBeNull();

    // The decision row inside the card: code field and buttons in English.
    await userEvent.click(within(a).getByRole('button', { name: 'Approve' }));
    expect(await within(a).findByText('Authenticator code')).toBeTruthy();
    expect(within(a).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('keeps the Turkish copy for Turkish users (glossary: "branch", not "dal")', async () => {
    needsPage('tr');
    const panel = await screen.findByTestId('dy-needs-decisions');
    expect(await within(panel).findByRole('heading', { name: 'Senden 2 karar bekliyor' })).toBeTruthy();
    const m = await within(panel).findByRole('article', { name: /main’e girsin mi\?/ });
    expect(within(m).getByText('0/0 branch')).toBeTruthy();
    expect(within(m).getByRole('link', { name: 'PR #218’i aç' })).toBeTruthy();
  });
});

describe('ops helpers in English', () => {
  it('day separators and card ages follow the language', () => {
    const now = new Date('2026-10-19T12:00:00');
    const en = { t: messagesFor('en'), f: createFormatter('en') };
    expect(dayLabel('2026-10-19T09:00:00', now, en)).toBe('Today, Monday 19 October');
    expect(dayLabel('2026-10-18T09:00:00', now, en)).toBe('Yesterday, Sunday 18 October');
    expect(dayLabel('2026-10-19T09:00:00', now)).toBe('Bugün, Pazartesi 19 Ekim');
    const at = now.getTime();
    const ago = messagesFor('en').home.ago;
    expect(agoText(new Date(at - 10_000).toISOString(), at, ago)).toBe('just now');
    expect(agoText(new Date(at - 2 * 86_400_000).toISOString(), at, ago)).toBe('2 days');
    expect(agoText(new Date(at - 12 * MIN).toISOString(), at)).toBe('12 dk');
  });

  it('the decision row asks for a reason in English', async () => {
    render(
      <AuthProvider initialState={signedIn} channel={null}>
        <I18nProvider locale="en">
          <DecisionPanel
            intent="deny"
            needsCode={false}
            submitLabel="Deny"
            reason={{ required: true, placeholder: 'Why…' }}
            onSubmit={() => Promise.resolve()}
            onCancel={() => undefined}
          />
        </I18nProvider>
      </AuthProvider>,
    );
    expect(screen.getByLabelText('Reason')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Write a reason: the other side sees why it was denied.')).toBeTruthy();
  });
});
