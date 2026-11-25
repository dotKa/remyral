// p14-i18n-screens-c (i18n Faz 5, group C): Ayarlar, Projeler, Yetenekler / Bağlam / Denetim and the shared screen
// parts come from the catalog — Turkish by default (the existing text-based tests stay green) and English when the
// user's language is `en`, with no Turkish left behind.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { messagesFor } from '@remyral/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { agoText, whenText } from '../src/diyalog/common/time';
import { ConflictList, DecisionTimeline } from '../src/diyalog/screens/projects/tabs/memory-records';
import { chainLines, DyDeployDiff } from '../src/diyalog/screens/projects/tabs/deploy-diff';
import { decisionLabel, kindLabel, statusLabel } from '../src/diyalog/screens/projects/tabs/deploy-text';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

const ADMIN: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

/** No Turkish letters in English copy (names in fixtures are ASCII). */
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return new Proxy(
    {},
    {
      get: (_t, key: string): Handler => {
        const h = extra[key];
        if (h !== undefined) return h;
        if (key === 'GET /api/auth/session') return () => ({ status: 200, body: sessionBody() });
        if (key === 'GET /api/time') return () => ({ status: 200, body: { now: new Date().toISOString() } });
        return () => ({ status: 200, body: { items: [], nextCursor: null, unreadCount: 0 } });
      },
    },
  );
}

function openIn(locale: 'tr' | 'en', path: string, extra: Record<string, Handler> = {}): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  renderApp({ path, initialState: ADMIN, routes: routes(extra), i18n: true });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RUN = {
  runId: 'remana-prod-20261018T023000Z',
  reason: 'scheduled',
  startedAt: '2026-10-18T02:30:00.000Z',
  finishedAt: '2026-10-18T02:30:04.000Z',
  durationMs: 4000,
  outcome: 'ok',
  tier: 'daily',
  schemaVersion: '0075',
  dbBytes: 5_242_880,
  dbSha256: 'a'.repeat(64),
  secrets: 'ok',
  offsite: { status: 'uploaded', target: 's3://bk/remyral/', error: null },
  warnings: [],
  error: null,
};

const BACKUPS = {
  configured: true,
  checkedAt: '2026-10-18T10:00:00.000Z',
  health: { state: 'ok', reasons: [] },
  problems: [],
  env: 'prod',
  heartbeat: {
    at: '2026-10-18T09:59:00.000Z',
    startedAt: '2026-10-17T00:00:00.000Z',
    nextBackupAt: '2026-10-19T02:30:00.000Z',
    nextDrillAt: null,
    schedule: { mode: 'daily', intervalMinutes: null, timeOfDay: '02:30', drill: 'weekly sun 04:00' },
    retention: { daily: 7, weekly: 4, monthly: 3, keepRecentHours: 0 },
  },
  storage: { backups: 9, bytes: 47_185_920, freeBytes: 20_000_000_000 },
  encryption: { configured: true, recipients: 2 },
  offsite: { configured: true, target: 's3://bk/remyral/', lastUploadAt: RUN.finishedAt, lastError: null },
  lastBackup: RUN,
  lastSuccessfulBackup: RUN,
  backups: [RUN],
  lastDrill: null,
  lastSuccessfulDrill: null,
  drills: [],
};

describe('Ayarlar → Yedekler in both languages', () => {
  const backups = { 'GET /api/backups/status': () => ({ status: 200, body: BACKUPS }) };

  it('Turkish stays as it was', async () => {
    openIn('tr', '/settings/backups', backups);
    expect(await screen.findByText('Yedekler sağlıklı.')).toBeTruthy();
    expect(screen.getByText('Takvim ve saklama')).toBeTruthy();
    expect(screen.getByText('Her gece 02:30 UTC')).toBeTruthy();
    expect(screen.getByText('7 günlük, 4 haftalık, 3 aylık')).toBeTruthy();
  });

  it('English has the same facts and no Turkish words', async () => {
    openIn('en', '/settings/backups', backups);
    const health = await screen.findByTestId('dy-backup-health');
    expect(within(health).getByText('Backups are healthy.')).toBeTruthy();
    expect(screen.getByText('Schedule and retention')).toBeTruthy();
    expect(screen.getByText('Every night at 02:30 UTC')).toBeTruthy();
    expect(screen.getByText('7 daily, 4 weekly, 3 monthly')).toBeTruthy();
    expect(screen.getByText('encrypted to 2 owner keys')).toBeTruthy();
    expect(screen.getByText('No drill yet. Next: weekly sun 04:00')).toBeTruthy();
    expect(screen.getByTestId('dy-backups').textContent).not.toMatch(TURKISH);
  });
});

describe('Denetim and Bağlam in English', () => {
  it('the audit explorer: filters, actions and the empty state', async () => {
    openIn('en', '/audit');
    expect(await screen.findByText('No matching records')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify chain' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    expect(screen.getByRole('search', { name: 'Filter audit records' })).toBeTruthy();
    expect(screen.getByTestId('dy-audit').textContent).not.toMatch(TURKISH);
  });

  it('the context screen: namespace, search and the documents panel', async () => {
    openIn('en', '/context');
    expect(await screen.findByRole('button', { name: 'Search by meaning' })).toBeTruthy();
    expect(screen.getAllByText('Namespace').length).toBeGreaterThan(0);
    expect(screen.getByText('Documents')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'global (all projects)' })).toBeTruthy();
  });
});

describe('Projeler and Ayarlar frames in English', () => {
  it('the project list', async () => {
    openIn('en', '/projects');
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    expect(screen.queryByText('Projeler')).toBeNull();
  });

  it('the settings frame and the profile', async () => {
    openIn('en', '/settings/profile');
    const nav = (await screen.findAllByRole('navigation', { name: 'Settings' }))[0] as HTMLElement;
    // p17-ui-polish: the System group (English name) is folded while a page of another group is open.
    fireEvent.click(within(nav).getByRole('button', { name: 'System' }));
    expect(within(nav).getByRole('link', { name: 'Machine releases' })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Language' })).toBeTruthy();
  });
});

describe('Projeler parts in English', () => {
  it('memory: empty decision history and conflict list', () => {
    render(
      <MemoryRouter>
        <I18nProvider locale="en">
          <DecisionTimeline decisions={[]} />
          <ConflictList conflicts={[]} canResolve onResolved={() => undefined} />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('No decisions recorded yet.')).toBeTruthy();
    expect(screen.getByText('No possible conflicts.')).toBeTruthy();
  });

  it('deploy: the review of a publish chain and the policy words', () => {
    const diff = {
      action: 'publish',
      project: 'site',
      env: 'production',
      source: 'upload',
      steps: [
        { step: 'create', project: 'site', subdomain: 'site.pages.dev', decision: { decision: 'approval' } },
        { step: 'deploy', fileCount: 3, bytes: 2048, decision: { decision: 'auto' } },
        {
          step: 'domain',
          domain: 'www.example.com',
          decision: { decision: 'approval_step_up' },
          dns: { action: 'create', zone: 'example.com', after: { content: 'site.pages.dev' } },
        },
      ],
    };
    const en = messagesFor('en').projectTabs;
    expect(chainLines(en.diff, diff).map((l) => l.text)).toEqual([
      'Pages project site is created (Direct Upload, site.pages.dev)',
      'Deploy (production): 3 files · 2.0 KB → site',
      'Domain is attached: www.example.com',
      'CNAME www.example.com → site.pages.dev, zone example.com (new record)',
    ]);
    const tr = messagesFor('tr').projectTabs;
    expect(chainLines(tr.diff, diff)[0]?.text).toBe(
      'Pages projesi site oluşturulur (Direct Upload, site.pages.dev)',
    );
    expect(kindLabel(en.deployText, 'dns.upsert')).toBe('DNS change');
    expect(kindLabel(tr.deployText, 'dns.upsert')).toBe('DNS değişikliği');
    expect(decisionLabel(en.deployText, 'refused', 'zone not allowed')).toBe('Refused: zone not allowed');
    expect(statusLabel(en.deployText, 'awaiting_approval', 'approval')).toBe('Waits for approval');
    render(
      <I18nProvider locale="en">
        <DyDeployDiff diff={diff} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('deploy-diff-publish').textContent).toContain('Publish → Pages project site');
    expect(screen.getByTestId('deploy-diff-publish').textContent).not.toMatch(TURKISH);
  });
});

describe('shared screen parts', () => {
  it('relative times in both languages', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const en = messagesFor('en').screenKit.time;
    expect(agoText('2026-10-20T11:57:00Z', now)).toBe('3 dk önce');
    expect(agoText('2026-10-20T11:57:00Z', now, en)).toBe('3 min ago');
    expect(agoText('2026-10-18T12:00:00Z', now, en)).toBe('2 days ago');
    expect(whenText('2026-10-20T14:00:00Z', now, en)).toBe('in 2 h');
    expect(whenText('2026-10-20T14:00:00Z', now)).toBe('2 sa sonra');
  });

  it('the command palette says approval risk in the user’s language', () => {
    expect(messagesFor('en').palette.risk.high).toBe('high risk');
    expect(messagesFor('tr').palette.risk.high).toBe('yüksek risk');
    expect(messagesFor('tr').palette.risk.critical).toBe('kritik');
  });
});
