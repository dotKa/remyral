// p12-diyalog-w1: Templates in the Diyalog language — the list (search, Etkin / Arşivlenmiş, sorting, pages,
// suggestions: create / hide / not similar / refine), the template page (Çalıştır → the composer prefilled,
// Otomatikleştir with step-up, İstem ve ayarlar, Sürümler with the diff, Çoğalt, Arşivle / Geri yükle) and the form
// (prefill from a job, candidates, live preview, the class, the admin-only global scope, edit with a change note);
// "Klasik görünüm"; flag off keeps the classic pages.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { matchTemplates } from '../src/diyalog/screens/templates';
import { DiffBlock, statsText } from '../src/diyalog/screens/templates/parts';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = '2026-10-16T08:00:00.000Z';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '44444444-4444-4444-8444-444444444444';
const JOB = '22222222-2222-4222-8222-222222222222';
const empty = { status: 200, body: { items: [], nextCursor: null } };

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

const DEFAULTS = { runtime: 'codex', approvalPolicy: 'ask-sensitive', limits: { maxDurationSec: 1800 } };
const PARAMS = [
  { name: 'url', type: 'url', required: true },
  { name: 'audience_count', type: 'int', required: true, default: 1000 },
];
const CURRENT = {
  version: 2,
  prompt: 'Analyse {{url:url}} for {{audience_count:int}} people.',
  parameters: PARAMS,
  defaults: DEFAULTS,
  changeNote: null,
  createdBy: USER.id,
  createdAt: NOW,
};
const STATS = {
  runs: 4,
  finished: 4,
  succeeded: 3,
  successRate: 0.75,
  avgCostUsd: 0.42,
  avgDurationSec: 600,
  lastRunAt: NOW,
  automations: 1,
};

function template(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: T1,
    project: 'acme',
    title: 'Landing page',
    description: 'Audience analysis + landing page',
    tags: ['marketing'],
    state: 'active',
    version: 2,
    owner: { id: USER.id, username: 'alex' },
    source: { kind: 'manual' },
    createdAt: NOW,
    updatedAt: NOW,
    current: CURRENT,
    stats: STATS,
    canEdit: true,
    ...over,
  };
}

const suggestion = {
  id: 'a'.repeat(32),
  project: 'acme',
  title: 'Run an SEO audit of {{url}}',
  prompt: 'Run an SEO audit of {{url}} and report.',
  parameters: [
    { name: 'url', type: 'url', required: true, examples: ['https://a.example', 'https://b.example'] },
  ],
  occurrences: 3,
  avgSimilarity: 1,
  lastSeenAt: NOW,
  members: [
    { kind: 'job', id: JOB, title: 'Run an SEO audit', createdAt: NOW },
    { kind: 'draft', id: '33333333-3333-4333-8333-333333333333', title: 'SEO', createdAt: NOW },
  ],
  defaults: { runtime: 'claude-code', modelProfile: null, sandboxProfile: null, approvalPolicy: null },
};

const project = (id: string, myRole: string): Record<string, unknown> => ({
  id,
  name: id,
  kind: 'repository',
  createdAt: NOW,
  createdBy: null,
  members: 2,
  myRole,
});

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({ status: 200, body: { items: [project('acme', 'operator')] } }),
    ...over,
  };
}

const preview = (prompt: string): Record<string, unknown> => {
  const has = prompt.includes('{{url}}');
  return {
    parameters: has ? [{ name: 'url', type: 'url', required: true }] : [],
    issues: [],
    valueIssues: [],
    prompt: has ? prompt.replace('{{url}}', '(not given)') : prompt,
    candidates: [],
  };
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Templates — pure parts', () => {
  it('routes only the template paths, decoding ids safely', () => {
    expect(matchTemplates('/jobs/templates')).not.toBeNull();
    expect(matchTemplates('/jobs/templates/new')).not.toBeNull();
    expect(matchTemplates(`/jobs/templates/${T1}`)).not.toBeNull();
    expect(matchTemplates(`/jobs/templates/${T1}/edit`)).not.toBeNull();
    expect(matchTemplates('/jobs/templates/%E0%A4%A')).toBeNull();
    expect(matchTemplates(`/jobs/templates/${T1}/versions`)).toBeNull();
    expect(matchTemplates('/jobs/new')).toBeNull();
    expect(matchTemplates('/jobs')).toBeNull();
  });

  it('says the usage in Turkish and renders a diff with words for each change', () => {
    expect(statsText(STATS)).toBe('4 çalışma · %75 başarılı · ort. $0.42 · ort. 10 dk · 1 otomasyon');
    expect(statsText({ ...STATS, runs: 0, automations: 0 })).toBe('Henüz çalışmadı');
    const { container } = render(<DiffBlock diff={'--- v1\n+++ v2\n@@ -1 +1 @@\n-old\n+new\n same'} />);
    expect(container.querySelectorAll('[data-kind="add"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-kind="del"]')).toHaveLength(1);
    expect(container.textContent).toContain('+1 satır eklendi');
    expect(container.textContent).toContain('eklendi: +new');
  });
});

describe('Diyalog Templates list (p12-diyalog-w1)', { timeout: 20_000 }, () => {
  it('lists templates with usage, filters, sorts and acts on suggestions', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let feedback: unknown[] = [];
    const r = renderApp({
      path: '/jobs/templates',
      initialState: state('operator'),
      routes: base({
        'GET /api/templates?state=active': () => ({
          status: 200,
          body: {
            items: [
              template(),
              template({ id: T2, title: 'Alpha deps', project: null, updatedAt: '2026-10-10T08:00:00.000Z' }),
            ],
          },
        }),
        'GET /api/templates?state=active&q=land': () => ({ status: 200, body: { items: [template()] } }),
        'GET /api/templates?state=archived': () => ({ status: 200, body: { items: [] } }),
        'GET /api/template-suggestions': () => ({ status: 200, body: { items: [suggestion] } }),
        'POST /api/template-suggestions/feedback': (q) => {
          feedback = [...feedback, q.body];
          return { status: 204 };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Şablonlar' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    let rows = await screen.findAllByTestId('dy-template-row');
    expect(rows).toHaveLength(2);
    // Newest first by default; "Ada göre" sorts by title.
    expect(within(rows[0] as HTMLElement).getByRole('link').textContent).toBe('Landing page');
    expect(within(rows[0] as HTMLElement).getByTestId('dy-template-usage').textContent).toContain(
      '4 çalışma · %75 başarılı',
    );
    expect(within(rows[1] as HTMLElement).getByText('Genel')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ada göre' }));
    rows = screen.getAllByTestId('dy-template-row');
    expect(within(rows[0] as HTMLElement).getByRole('link').textContent).toBe('Alpha deps');
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/jobs/templates/${T1}`);

    // Search (debounced) and the archived view.
    await user.type(screen.getByRole('searchbox', { name: 'Ara' }), 'land');
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/templates?state=active&q=land')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('dy-template-row')).toHaveLength(1);
    });
    await user.clear(screen.getByRole('searchbox', { name: 'Ara' }));
    await user.click(screen.getByRole('button', { name: 'Arşivlenmiş' }));
    await waitFor(() => {
      expect(screen.getByTestId('templates-empty').textContent).toContain('Arşivlenmiş şablon yok');
    });
    expect(screen.getByRole('button', { name: 'Arşivlenmiş' }).getAttribute('aria-pressed')).toBe('true');

    // Suggestions: examples, sources, "Benzer değil" sends the members.
    const card = screen.getByTestId('dy-suggestion');
    expect(within(card).getByText(/3 kez görüldü/)).toBeTruthy();
    expect(within(card).getByText(/https:\/\/a.example/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Run an SEO audit' }).getAttribute('href')).toBe(
      `/jobs/${JOB}`,
    );
    await user.click(within(card).getByRole('button', { name: 'Benzer değil' }));
    await waitFor(() => {
      expect(feedback).toHaveLength(1);
    });
    expect(feedback[0]).toEqual({
      project: 'acme',
      suggestionId: 'a'.repeat(32),
      kind: 'not_similar',
      members: [`job:${JOB}`, 'draft:33333333-3333-4333-8333-333333333333'],
    });
    await user.click(within(card).getByRole('button', { name: 'Gizle' }));
    await waitFor(() => {
      expect(feedback).toHaveLength(2);
    });
    expect(feedback[1]).toEqual({ project: 'acme', suggestionId: 'a'.repeat(32), kind: 'dismissed' });
    expect(r.requests.find((q) => q.method === 'POST')?.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('pages a long list in the Diyalog pager', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 30 }, (_, i) =>
      template({
        id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        title: `T ${String(i).padStart(2, '0')}`,
        updatedAt: new Date(Date.parse(NOW) - i * 60_000).toISOString(),
      }),
    );
    renderApp({
      path: '/jobs/templates',
      initialState: state('operator'),
      routes: base({
        'GET /api/templates?state=active': () => ({ status: 200, body: { items: many } }),
        'GET /api/template-suggestions': () => ({ status: 200, body: { items: [] } }),
      }),
    });
    expect(await screen.findAllByTestId('dy-template-row')).toHaveLength(25);
    const pager = screen.getByRole('navigation', { name: 'Şablon sayfaları' });
    expect(within(pager).getByText('1–25 / 30')).toBeTruthy();
    await user.click(within(pager).getByRole('button', { name: 'Sonraki sayfa' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('dy-template-row')).toHaveLength(5);
    });
    expect(screen.queryByTestId('dy-suggestions')).toBeNull();
  });

  it('"Şablon oluştur" opens the form prefilled from the suggestion', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/jobs/templates',
      initialState: state('operator'),
      routes: base({
        'GET /api/templates?state=active': () => ({ status: 200, body: { items: [] } }),
        'GET /api/template-suggestions': () => ({ status: 200, body: { items: [suggestion] } }),
        'POST /api/templates/preview': (q) => ({
          status: 200,
          body: preview((q.body as { prompt: string }).prompt),
        }),
      }),
    });
    const card = await screen.findByTestId('dy-suggestion');
    await user.click(within(card).getByRole('button', { name: 'Şablon oluştur' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni şablon' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Başlık').value).toBe('Run an SEO audit of {{url}}');
    expect(screen.getByTestId<HTMLTextAreaElement>('template-prompt').value).toBe(
      'Run an SEO audit of {{url}} and report.',
    );
    expect(screen.getByTestId<HTMLSelectElement>('template-project').value).toBe('acme');
  });
});

describe('Diyalog template page (p12-diyalog-w1)', { timeout: 20_000 }, () => {
  it('Çalıştır renders the values and opens the composer with the rendered prompt', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let rendered: unknown = null;
    renderApp({
      path: `/jobs/templates/${T1}`,
      initialState: state('operator'),
      routes: base({
        [`GET /api/templates/${T1}`]: () => ({ status: 200, body: template() }),
        [`POST /api/templates/${T1}/render`]: (q) => {
          rendered = q.body;
          return {
            status: 200,
            body: {
              templateId: T1,
              version: 2,
              project: 'acme',
              prompt: 'Analyse "https://x.example" for 1000 people.',
              values: {},
              defaults: DEFAULTS,
              files: [],
            },
          };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Landing page' })).toBeTruthy();
    expect(screen.getByTestId('template-stats').textContent).toContain('4 çalışma');
    expect(screen.getByRole('tab', { name: 'Çalıştır' }).getAttribute('aria-selected')).toBe('true');
    // Required without a default is marked; the default fills the number field.
    expect(screen.getByLabelText<HTMLInputElement>(/^audience_count/).value).toBe('1000');
    await user.type(screen.getByLabelText(/^url/), 'https://x.example');
    await user.click(screen.getByTestId('run-template'));
    await waitFor(() => {
      expect(rendered).toEqual({
        values: { url: 'https://x.example', audience_count: '1000' },
        project: 'acme',
      });
    });
    // The composer opens prefilled; nothing was submitted.
    await waitFor(() => {
      expect(
        screen
          .getAllByRole('textbox')
          .some((el) => (el as HTMLTextAreaElement).value === 'Analyse "https://x.example" for 1000 people.'),
      ).toBe(true);
    });
  });

  it('Otomatikleştir asks for step-up through the shared provider and links the automation', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let body: unknown = null;
    renderApp({
      path: `/jobs/templates/${T1}`,
      initialState: state('operator'),
      routes: base({
        [`GET /api/templates/${T1}`]: () => ({ status: 200, body: template() }),
        [`POST /api/templates/${T1}/automations`]: (q) => {
          body = q.body;
          return { status: 201, body: { automationId: 'auto-1' } };
        },
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Landing page' });
    await user.type(screen.getByLabelText(/^url/), 'https://x.example');
    await user.click(screen.getByRole('button', { name: 'Otomatikleştir…' }));
    const form = screen.getByRole('form', { name: 'Bu şablonu zamanla çalıştır' });
    expect(within(form).getByLabelText<HTMLInputElement>(/^Cron/).value).toBe('0 3 * * *');
    await user.click(within(form).getByRole('button', { name: 'Otomasyon oluştur' }));
    await waitFor(() => {
      expect(body).toEqual({
        project: 'acme',
        name: 'Landing page (zamanlanmış)',
        trigger: { kind: 'cron', cron: '0 3 * * *' },
        values: { url: 'https://x.example', audience_count: '1000' },
      });
    });
    expect((await screen.findByRole('link', { name: 'Aç' })).getAttribute('href')).toBe(
      '/automations/auto-1',
    );
  });

  it('settings, versions with the diff, duplicate and archive / restore', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/jobs/templates/${T1}?tab=prompt`,
      initialState: state('operator'),
      routes: base({
        [`GET /api/templates/${T1}`]: () => ({ status: 200, body: template() }),
        [`GET /api/templates/${T1}/versions`]: () => ({
          status: 200,
          body: {
            items: [
              { ...CURRENT, version: 1, changeNote: null },
              { ...CURRENT, version: 2, changeNote: 'Shorter prompt' },
            ],
          },
        }),
        [`GET /api/templates/${T1}/diff?from=1&to=2`]: () => ({
          status: 200,
          body: { diff: '--- v1\n+++ v2\n@@ -1 +1 @@\n-Analyse it.\n+Analyse {{url:url}}.' },
        }),
        [`POST /api/templates/${T1}/archive`]: () => ({
          status: 200,
          body: template({ state: 'archived' }),
        }),
        [`POST /api/templates/${T1}/restore`]: () => ({ status: 200, body: template() }),
        [`POST /api/templates/${T1}/duplicate`]: () => ({
          status: 201,
          body: template({ id: T2, title: 'Landing page (copy)' }),
        }),
        [`GET /api/templates/${T2}`]: () => ({
          status: 200,
          body: template({ id: T2, title: 'Landing page (copy)' }),
        }),
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Landing page' });
    expect(screen.getByTestId('dy-template-prompt').textContent).toContain('{{url:url}}');
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Hassas adımlarda sor')).toBeTruthy();
    expect(screen.getByText('30 dk')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /Sürümler/ }));
    const versions = await screen.findAllByTestId('dy-version');
    expect(versions).toHaveLength(2);
    expect(within(versions[0] as HTMLElement).getByText('Shorter prompt')).toBeTruthy();
    expect(within(versions[0] as HTMLElement).getByText('güncel')).toBeTruthy();
    const diff = await screen.findByTestId('dy-diff');
    expect(diff.querySelector('[data-kind="add"]')?.textContent).toContain('+Analyse {{url:url}}.');
    expect(diff.querySelector('[data-kind="del"]')?.textContent).toContain('-Analyse it.');

    // Archive → the run is locked and "Düzenle" goes; Restore brings both back.
    await user.click(screen.getByRole('button', { name: 'Arşivle' }));
    expect(await screen.findByRole('button', { name: 'Geri yükle' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Düzenle' })).toBeNull();
    expect(screen.getAllByText('Arşivde').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Geri yükle' }));
    expect(await screen.findByRole('link', { name: 'Düzenle' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Düzenle' }).getAttribute('href')).toBe(
      `/jobs/templates/${T1}/edit`,
    );

    await user.click(screen.getByRole('button', { name: 'Çoğalt' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Landing page (copy)' })).toBeTruthy();
    expect(
      r.requests.filter((q) => q.method === 'POST').every((q) => q.headers['x-csrf-token'] === 'csrf-token'),
    ).toBe(true);
  });

  it('read-only template: no edit / archive', async () => {
    renderApp({
      path: `/jobs/templates/${T1}`,
      initialState: state('viewer'),
      routes: base({
        [`GET /api/templates/${T1}`]: () => ({ status: 200, body: template({ canEdit: false }) }),
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Landing page' });
    expect(screen.queryByRole('link', { name: 'Düzenle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Arşivle' })).toBeNull();
  });
});

describe('Diyalog template form (p12-diyalog-w1)', { timeout: 20_000 }, () => {
  it('from a job: candidates, live preview, class, create with the job as source', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let created: Record<string, unknown> | null = null;
    renderApp({
      path: `/jobs/templates/new?fromJob=${JOB}`,
      initialState: state('operator'),
      routes: base({
        'POST /api/templates/from-job': () => ({
          status: 200,
          body: {
            project: 'acme',
            title: 'Audit https://a.example',
            prompt: 'Audit https://a.example now.',
            defaults: { runtime: 'codex' },
            candidates: [{ text: 'https://a.example', type: 'url', name: 'url' }],
            source: { kind: 'job', id: JOB },
          },
        }),
        'POST /api/templates/preview': (q) => ({
          status: 200,
          body: preview((q.body as { prompt: string }).prompt),
        }),
        'POST /api/templates': (q) => {
          created = q.body as Record<string, unknown>;
          return { status: 201, body: template() };
        },
        [`GET /api/templates/${T1}`]: () => ({ status: 200, body: template() }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni şablon' })).toBeTruthy();
    // Operators cannot make a global template.
    const scope = screen.getByTestId<HTMLSelectElement>('template-project');
    expect([...scope.options].map((o) => o.value)).toEqual(['acme']);
    const chip = await screen.findByRole('button', { name: /https:\/\/a.example.*\{\{url\}\}/ });
    await user.click(chip);
    expect(screen.getByTestId<HTMLTextAreaElement>('template-prompt').value).toBe('Audit {{url}} now.');
    await waitFor(() => {
      expect(screen.getByTestId('template-preview').textContent).toBe('Audit (not given) now.');
    });
    const table = screen.getByTestId('param-table');
    expect(within(table).getByText('{{url}}')).toBeTruthy();
    // The type select offers the 8 types in words.
    expect(within(table).getAllByRole('combobox')[0]?.querySelectorAll('option')).toHaveLength(8);
    await user.click(within(screen.getByTestId('template-priority')).getByRole('radio', { name: 'Acil' }));
    await user.selectOptions(screen.getByTestId('template-verify'), 'gate');
    await user.click(screen.getByRole('button', { name: 'Şablonu oluştur' }));
    await waitFor(() => {
      expect(created).not.toBeNull();
    });
    expect(created).toMatchObject({
      project: 'acme',
      prompt: 'Audit {{url}} now.',
      parameters: [{ name: 'url', type: 'url' }],
      defaults: { runtime: 'codex', priorityClass: 'urgent', verify: 'gate' },
      source: { kind: 'job', id: JOB },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Landing page' })).toBeTruthy();
  });

  it('admins may choose Genel; save waits for a title and a prompt', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/jobs/templates/new',
      initialState: state('admin'),
      routes: base({
        'POST /api/templates/preview': (q) => ({
          status: 200,
          body: preview((q.body as { prompt: string }).prompt),
        }),
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Yeni şablon' });
    const scope = screen.getByTestId<HTMLSelectElement>('template-project');
    await waitFor(() => {
      expect([...scope.options].map((o) => o.value)).toEqual(['', 'acme']);
    });
    expect(scope.options[0]?.textContent).toContain('Genel');
    const save = screen.getByRole('button', { name: 'Şablonu oluştur' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('template-missing').textContent).toBe('Eksik: başlık, istem');
    await user.type(screen.getByLabelText('Başlık'), 'X');
    expect(screen.getByTestId('template-missing').textContent).toBe('Eksik: istem');
    expect(screen.getByTestId('template-preview').textContent).toBe('Önizleme için bir istem yaz.');
  });

  it('edit: scope locked, change note and the expected version are sent', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let patched: Record<string, unknown> | null = null;
    renderApp({
      path: `/jobs/templates/${T1}/edit`,
      initialState: state('operator'),
      routes: base({
        [`GET /api/templates/${T1}`]: () => ({ status: 200, body: template() }),
        'POST /api/templates/preview': () => ({
          status: 200,
          body: {
            parameters: PARAMS,
            issues: [{ code: 'x', message: 'url has no description' }],
            valueIssues: [],
            prompt: 'Analyse (not given) for 1000 people.',
            candidates: [],
          },
        }),
        [`PATCH /api/templates/${T1}`]: (q) => {
          patched = q.body as Record<string, unknown>;
          return { status: 200, body: template({ version: 3 }) };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Şablonu düzenle' })).toBeTruthy();
    expect(screen.getByTestId<HTMLSelectElement>('template-project').disabled).toBe(true);
    expect(await screen.findByTestId('template-issues')).toBeTruthy();
    await user.type(screen.getByLabelText(/^Değişiklik notu/), 'Better wording');
    await user.click(screen.getByRole('button', { name: 'Yeni sürümü kaydet' }));
    await waitFor(() => {
      expect(patched).not.toBeNull();
    });
    expect(patched).toMatchObject({
      title: 'Landing page',
      expectedVersion: 2,
      changeNote: 'Better wording',
      defaults: { runtime: 'codex', approvalPolicy: 'ask-sensitive', limits: { maxDurationSec: 1800 } },
    });
  });
});
