// p14-i18n-screens-b (i18n Phase 5): Çıktılar speaks the user's language — the list, tabs, rows, the item drawer and
// the shared badges in English when the user chose English; the Turkish wording stays as it was (the tunnel's
// provider name, which used to leak English, now says "Önizleme bağlantısı").
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Locale } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputItem } from '../src/api/outputs';
import type { AuthState } from '../src/auth/AuthProvider';
import { DyFileViewer } from '../src/diyalog/screens/outputs/Preview';
import { HealthBadge, UpWord } from '../src/diyalog/screens/outputs/shared';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { DiyalogTextScope } from '../src/i18n/scope';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const ACTION = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-10-16T08:00:00.000Z';
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

const site = {
  key: 'site:pages:acme-site:preview',
  type: 'site',
  project: 'acme',
  title: null,
  name: 'acme-site',
  tags: [],
  pinned: true,
  noteCount: 2,
  jobId: JOB,
  createdAt: NOW,
  site: {
    url: 'https://abc.acme-site.pages.dev',
    env: 'preview',
    provider: 'pages',
    target: 'pages:acme-site',
    opsActionId: ACTION,
    opsKind: 'pages.deploy',
    deployedAt: NOW,
  },
  file: null,
  note: null,
};

const md = {
  key: `file:${JOB}:ws-report-md`,
  type: 'file',
  project: 'acme',
  title: null,
  name: 'report.md',
  tags: [],
  pinned: false,
  noteCount: 0,
  jobId: JOB,
  createdAt: NOW,
  site: null,
  file: {
    source: 'workspace',
    artifactId: 'ws-report-md',
    kind: 'output',
    mediaType: 'text/markdown',
    sizeBytes: 120,
    sha256: 'a'.repeat(64),
    redacted: true,
    removed: null,
    expiresAt: null,
    download: `/jobs/${JOB}/artifacts/ws-report-md`,
    preview: 'markdown',
  },
  note: null,
};

const empty200 = { status: 200, body: { items: [] } };

function routes(): Record<string, Handler> {
  const key = encodeURIComponent(md.key);
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'acme',
            kind: 'workspace',
            createdAt: NOW,
            createdBy: null,
            members: 2,
            myRole: 'operator',
          },
        ],
      },
    }),
    'GET /api/outputs/tree': () => ({ status: 200, body: { nodes: [] } }),
    'GET /api/outputs/folders': () => empty200,
    'GET /api/outputs?limit=25': () => ({ status: 200, body: { items: [site, md], total: 2 } }),
    [`GET /api/outputs/thread?project=acme&key=${key}`]: () => empty200,
    [`GET /api/outputs/item-folders?project=acme&key=${key}`]: () => empty200,
    [`GET /api/jobs/${JOB}/artifacts/ws-report-md?inline=1`]: () => ({
      status: 200,
      raw: '# Report',
      headers: { 'content-type': 'text/markdown' },
    }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  stubCookies('__Host-ras-csrf=csrf-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Outputs in English (p14-i18n-screens-b)', { timeout: 20_000 }, () => {
  it('the screen, tabs, rows and the item drawer speak English', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/outputs', initialState: owner, i18n: true, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Outputs' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['All', 'Sites', 'Files', 'Notes']);
    const [s, f] = (await screen.findAllByTestId('output-row')) as [HTMLElement, HTMLElement];
    expect(within(s).getByRole('link', { name: 'Open site' })).toBeTruthy();
    expect(within(s).getAllByText('Pinned').length).toBeGreaterThan(0);
    expect(within(s).getByRole('button', { name: 'acme-site: unpin' })).toBeTruthy();
    expect(within(s).getByText('Cloudflare Pages · preview')).toBeTruthy();
    expect(s.textContent).toContain('2 notes');
    expect(within(f).getByRole('button', { name: 'report.md: pin' })).toBeTruthy();
    expect(within(f).getByText('text/markdown · 120 B')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Layout' })).toBeTruthy();
    expect(screen.queryByText('Sabit')).toBeNull();
    expect(screen.queryByText(/Klasöre ekle/)).toBeNull();

    await user.click(within(f).getByRole('button', { name: 'report.md' }));
    const detail = await screen.findByTestId('output-detail');
    expect(within(detail).getByRole('region', { name: 'Preview' })).toBeTruthy();
    expect(within(detail).getByText('Download')).toBeTruthy();
    expect(within(detail).getByText('The master removed secrets from this file.')).toBeTruthy();
    expect(await within(detail).findByText('Not in any folder yet.')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Add note' })).toBeTruthy();
    expect(detail.textContent).not.toMatch(/Önizleme|Klasörlerde|Notlar/);
  });
});

function inDiyalog(locale: Locale, ui: ReactNode) {
  return render(
    <MemoryRouter>
      <I18nProvider locale={locale}>
        <DiyalogTextScope>{ui}</DiyalogTextScope>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const tunnel = {
  ...site,
  site: { ...site.site, provider: 'tunnel', protection: 'access', expiresAt: null },
  health: {
    state: 'passed',
    statusCode: 200,
    latencyMs: 120,
    broken: 1,
    checkedAt: NOW,
    screenshot: null,
  },
} as unknown as OutputItem;

describe('Outputs parts in both languages', () => {
  it('health and uptime words', () => {
    const r = inDiyalog('en', <HealthBadge item={tunnel} />);
    expect(screen.getByTestId('site-health').textContent).toContain('Healthy');
    expect(screen.getByTestId('site-health').textContent).toContain('1 broken link');
    r.unmount();
    const t = inDiyalog('tr', <HealthBadge item={tunnel} />);
    expect(screen.getByTestId('site-health').textContent).toContain('Sağlıklı');
    expect(screen.getByTestId('site-health').textContent).toContain('1 kırık bağlantı');
    t.unmount();
    inDiyalog('en', <UpWord state="down" />);
    expect(screen.getByTestId('status-dot').textContent).toBe('Down');
  });

  it('file previews explain removed and machine-reported files in English', () => {
    const file = md.file as unknown as Parameters<typeof DyFileViewer>[0]['file'];
    const r = inDiyalog(
      'en',
      <DyFileViewer file={{ ...file, removed: 'quota' }} jobId={JOB} name="report.md" />,
    );
    expect(
      screen.getByText("This file's content was removed by the workspace storage quota; its details remain."),
    ).toBeTruthy();
    r.unmount();
    inDiyalog('tr', <DyFileViewer file={{ ...file, source: 'run', download: null }} jobId={JOB} name="x" />);
    expect(screen.getByTestId('no-preview').textContent).toBe(
      'Bu çıktıyı makine bildirdi; içeriği master’da saklanmıyor.',
    );
  });
});
