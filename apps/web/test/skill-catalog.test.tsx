// p14-skill-catalogs (ADR-0054, docs/design/p14-mcp-skills.md P2): Diyalog Yetenekler → "Keşfet" (catalog search, fit
// pills, import from a catalog entry into the usual preview, admin catalog sources), the layout-v2 limits and pill,
// and the `skill_import` chat card (propose_skill_install).
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { createFormatter, messagesFor } from '@remyral/i18n';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';

// p14-i18n-screens-a: the summaries take the catalog; these say them in Turkish (the Diyalog default).
const TR = messagesFor('tr');
const TRF = createFormatter('tr');
const draftKindTr = (k: string): string => draftKindText(k, TR);
const summarizeDraftTr = (d: Parameters<typeof summarizeDraft>[0]) => summarizeDraft(d, TR, TRF);
import { W3_SKILLS } from '../src/diyalog/harness/screens/w3-knowledge';
import { openStripCard } from './card-strip';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = { ...owner, user: { ...USER, role: 'viewer' } };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
const COMMIT = 'dbd4588f9e1033efb41dad4bef2f7947c8993d44';

const SKILLS = {
  ...W3_SKILLS,
  layouts: {
    v1: { maxFiles: 32, maxFileBytes: 65536, maxTotalBytes: 131072, maxJobBytes: 163840 },
    v2: { maxFiles: 64, maxFileBytes: 131072, maxTotalBytes: 524288, maxJobBytes: 655360 },
  },
  layoutV2Workers: { supported: 2, total: 5 },
  skills: W3_SKILLS.skills.map((s, i) =>
    i === 0
      ? { ...s, versions: s.versions.map((v, j) => (j === 0 ? { ...v, layout: 2 } : { ...v, layout: 1 })) }
      : s,
  ),
};

const SOURCES = [
  {
    id: 'anthropic',
    title: 'Anthropic skills',
    repo: 'anthropics/skills',
    ref: null,
    path: 'skills',
    enabled: true,
    builtin: true,
    commit: COMMIT,
    listedAt: '2026-10-20T10:00:00.000Z',
    error: null,
    entryCount: 2,
    updatedAt: '2026-10-20T10:00:00.000Z',
  },
  {
    id: 'acme',
    title: 'Acme',
    repo: 'acme/skills',
    ref: 'main',
    path: '',
    enabled: false,
    builtin: false,
    commit: null,
    listedAt: null,
    error: 'github_rate_limited: GitHub refused the request',
    entryCount: 0,
    updatedAt: '2026-10-20T10:00:00.000Z',
  },
];

const ENTRIES = [
  {
    id: 'anthropic:skills/skill-creator',
    sourceId: 'anthropic',
    repo: 'anthropics/skills',
    path: 'skills/skill-creator',
    commit: COMMIT,
    name: 'skill-creator',
    description: '<img src=x onerror=alert(1)> Create new skills.',
    fileCount: 18,
    totalBytes: 224992,
    fit: 'v2',
    url: `https://github.com/anthropics/skills/tree/${COMMIT}/skills/skill-creator`,
  },
  {
    id: 'anthropic:skills/canvas-design',
    sourceId: 'anthropic',
    repo: 'anthropics/skills',
    path: 'skills/canvas-design',
    commit: COMMIT,
    name: 'canvas-design',
    description: null,
    fileCount: 83,
    totalBytes: 5554003,
    fit: 'binary',
    url: `https://github.com/anthropics/skills/tree/${COMMIT}/skills/canvas-design`,
  },
];

const PREVIEW = {
  id: '00000000-0000-4000-8000-0000000000bb',
  sourceKind: 'catalog',
  source: {
    catalog: 'anthropic',
    repo: 'anthropics/skills',
    path: 'skills/skill-creator',
    ref: COMMIT,
    commit: COMMIT,
    url: `https://github.com/anthropics/skills/tree/${COMMIT}/skills/skill-creator`,
  },
  state: 'previewed',
  blocked: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z',
  suggested: {
    skillId: 'skill-creator',
    title: 'Skill Creator',
    description: 'Create skills.',
    version: '1.0.0',
  },
  latest: null,
  files: [
    { path: 'SKILL.md', size: 33168, sha256: 'a'.repeat(64), executable: false, content: '# Skill Creator' },
    { path: 'agents/grader.md', size: 9049, sha256: 'b'.repeat(64), executable: false, content: 'grade' },
  ],
  excluded: [],
  findings: [
    { kind: 'layout_v2', severity: 'info', size: 224992 },
    { kind: 'license', severity: 'info', path: 'resources/LICENSE.txt', rule: 'Apache-2.0' },
  ],
  license: { path: 'resources/LICENSE.txt', name: 'Apache-2.0' },
  fileCount: 2,
  totalBytes: 42217,
  diff: null,
  published: null,
  limits: { maxFiles: 64, maxFileBytes: 131072, maxTotalBytes: 524288 },
  layout: 2,
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': ok({ items: [] }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/skills': ok(SKILLS),
    'GET /api/projects': ok({ items: [] }),
    'GET /api/skills/catalog': ok({ enabled: true, sources: SOURCES, entries: ENTRIES }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>, reason: string): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain(reason);
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Yetenekler: layout v2 and Keşfet (p14-skill-catalogs)', { timeout: 20_000 }, () => {
  it('shows the two layouts with their limits, how many machines take layout 2, and the version pill', async () => {
    renderApp({ path: '/skills', initialState: viewer, routes: routes() });
    const limits = await screen.findByTestId('skills-layout-limits');
    expect(limits.textContent).toContain('Düzen 2 — yalnız geniş düzeni destekleyen makineler');
    expect(limits.textContent).toContain('En çok 64 dosya');
    expect(within(limits).getByTestId('skills-layout-workers').textContent).toBe(
      '2/5 makine geniş düzeni destekliyor.',
    );
    expect(screen.getAllByTestId('skill-layout-v2')).toHaveLength(1);
  });

  it('Keşfet: entries as text with fit pills; a viewer cannot import or change sources', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/skills', initialState: viewer, routes: routes() });
    await user.click(await screen.findByRole('tab', { name: 'Keşfet' }));
    const results = await screen.findByTestId('catalog-results');
    const rows = within(results).getAllByTestId('catalog-entry');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId('catalog-fit-v2').textContent).toBe('geniş düzen');
    expect(within(rows[1] as HTMLElement).getByTestId('catalog-fit-binary')).toBeTruthy();
    // Untrusted catalog text renders as text, never markup.
    expect(results.querySelector('img')).toBeNull();
    expect(results.textContent).toContain('<img src=x onerror=alert(1)> Create new skills.');
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: /anthropics\/skills\/skills\/skill-creator@dbd4588/ })
        .getAttribute('href'),
    ).toBe(ENTRIES[0]?.url);
    expect(within(results).queryByRole('button', { name: 'İçe aktar' })).toBeNull();
    const sources = screen.getByTestId('catalog-sources');
    expect(sources.textContent).toContain('Son okuma başarısız: github_rate_limited');
    expect(within(sources).queryByRole('button', { name: 'Yenile' })).toBeNull();
  });

  it('search sends q and source; import from an entry → step-up → the preview with the layout-2 line', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = 0;
    let importBody: unknown = null;
    const r = renderApp({
      path: '/skills',
      initialState: owner,
      routes: routes({
        'GET /api/skills/catalog?q=creator&source=anthropic': ok({
          enabled: true,
          sources: SOURCES,
          entries: [ENTRIES[0]],
        }),
        'POST /api/skills/imports': (req) => {
          if (stepped === 0) return STEP_UP;
          importBody = req.body;
          return { status: 201, body: PREVIEW };
        },
        'POST /api/auth/step-up': () => {
          stepped += 1;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Keşfet' }));
    const search = await screen.findByTestId('catalog-search');
    await within(search).findByTestId('catalog-results');
    await user.type(within(search).getByLabelText('Ara'), 'creator');
    await user.selectOptions(within(search).getByLabelText('Katalog'), 'anthropic');
    await user.click(within(search).getByRole('button', { name: 'Ara' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/skills/catalog?q=creator&source=anthropic')).toBe(true);
    });
    await waitFor(() => {
      expect(within(search).getAllByTestId('catalog-entry')).toHaveLength(1);
    });
    await user.click(within(search).getByRole('button', { name: 'İçe aktar' }));
    await confirmStepUp(user, 'Katalogdan içe aktarmak güncel bir doğrulama kodu ister.');
    const preview = await screen.findByTestId('skill-import-preview');
    expect(importBody).toEqual({ kind: 'catalog', entryId: 'anthropic:skills/skill-creator' });
    expect(preview.textContent).toContain(
      'Katalog anthropics/skills/skills/skill-creator · commit dbd4588f9e10',
    );
    expect(within(preview).getByTestId('import-layout').textContent).toContain('Düzen 2');
    expect(within(preview).getByTestId('import-finding-layout_v2').textContent).toContain(
      'Bu yetenek geniş düzeni kullanıyor',
    );
  });

  it('admin: refresh a source, add one behind a step-up, the built-in one cannot be removed', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = 0;
    let saved: unknown = null;
    const r = renderApp({
      path: '/skills?tab=discover',
      initialState: owner,
      routes: routes({
        'POST /api/skills/catalog/sources/anthropic/refresh': ok(SOURCES[0]),
        'PUT /api/skills/catalog/sources/team': (req) => {
          if (stepped === 0) return STEP_UP;
          saved = req.body;
          return { status: 200, body: { ...SOURCES[1], id: 'team', title: 'Team', repo: 'team/skills' } };
        },
        'POST /api/auth/step-up': () => {
          stepped += 1;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const sources = await screen.findByTestId('catalog-sources');
    const rows = within(sources).getAllByTestId('catalog-source');
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: 'Kaldır' })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Kaldır' })).toBeTruthy();
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Yenile' }));
    expect(await screen.findByText('anthropic kataloğu yeniden okundu.')).toBeTruthy();
    expect(r.requests.some((q) => q.url === '/api/skills/catalog/sources/anthropic/refresh')).toBe(true);

    await user.click(
      within(screen.getByTestId('catalog-sources')).getByRole('button', { name: 'Katalog ekle' }),
    );
    const form = await screen.findByTestId('catalog-source-form');
    await user.type(within(form).getByLabelText(/Kimlik/), 'team');
    await user.type(within(form).getByLabelText('Ad'), 'Team');
    await user.type(within(form).getByLabelText('GitHub deposu (sahip/ad)'), 'team/skills');
    await user.type(within(form).getByLabelText('Klasör (isteğe bağlı)'), 'skills');
    await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
    await confirmStepUp(user, 'Katalog kaynaklarını değiştirmek güncel bir doğrulama kodu ister.');
    await waitFor(() => {
      expect(saved).toEqual({ title: 'Team', repo: 'team/skills', ref: null, path: 'skills', enabled: true });
    });
    expect(await screen.findByText('team kataloğu kaydedildi.')).toBeTruthy();
  });
});

describe('skill_import chat card (propose_skill_install)', () => {
  const payload = {
    importId: PREVIEW.id,
    sourceKind: 'catalog',
    source: PREVIEW.source,
    skillId: 'skill-creator',
    title: 'Skill Creator',
    description: 'Create skills.',
    version: '1.0.0',
    runtimes: ['claude-code', 'codex'],
    project: 'acme',
    layout: 2,
    fileCount: 2,
    totalBytes: 42217,
    files: [
      { path: 'SKILL.md', size: 33168, sha256: 'a'.repeat(64), executable: false },
      { path: 'scripts/run.py', size: 120, sha256: 'b'.repeat(64), executable: true },
    ],
    findings: [
      { kind: 'script', severity: 'warn', path: 'scripts/run.py' },
      {
        kind: 'risky',
        severity: 'warn',
        path: 'SKILL.md',
        line: 4,
        rule: 'pipe_to_shell',
        excerpt: 'curl x | sh',
      },
    ],
    license: { path: 'resources/LICENSE.txt', name: 'Apache-2.0' },
    latest: null,
  };

  it('summarises source, pinned commit, files, scripts and risky lines, license, project and layout', () => {
    expect(draftKindTr('skill_import')).toBe('Yetenek kurulumu');
    const s = summarizeDraftTr({ kind: 'skill_import', payload });
    const key = Object.fromEntries(s.key.map((f) => [f.k, f.v]));
    expect(key.Yetenek).toBe('skill-creator 1.0.0 (yeni)');
    expect(key.Kaynak).toBe('anthropics/skills/skills/skill-creator @ dbd4588f9e10');
    expect(key.Proje).toBe('acme');
    expect(key['Düzen']).toBe('Düzen 2 — yalnız geniş düzeni destekleyen makineler');
    expect(key.Lisans).toBe('Apache-2.0');
    expect(s.notice?.text).toContain('acme projesine atanır');
    expect(s.notice?.text).toContain('Her seferinde yeni bir authenticator kodu ister');
    expect(s.warnings.map((w) => w.text).join('\n')).toContain('Çalıştırılabilir dosya: scripts/run.py');
    expect(s.warnings.map((w) => w.text).join('\n')).toContain('curl x | sh');
    const list = s.details.find((d) => d.k === 'Dosya listesi');
    expect(list?.v).toContain('scripts/run.py');
    expect(list?.v).toContain('(çalıştırılabilir)');
    const none = summarizeDraftTr({
      kind: 'skill_import',
      payload: { ...payload, project: null, layout: 1 },
    });
    expect(Object.fromEntries(none.key.map((f) => [f.k, f.v])).Proje).toBe('atanmaz (yalnız yayımlanır)');
  });

  it('renders natively in the Sohbet thread and confirms with the code in the card', async () => {
    const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
    const NOW = Date.now();
    const iso = (ago: number): string => new Date(NOW - ago).toISOString();
    const thread = { id: THREAD, title: 'Ops', archived: false, createdAt: iso(60_000), updatedAt: iso(0) };
    const d = {
      id: '00000000-0000-4000-8000-000000000777',
      threadId: THREAD,
      kind: 'skill_import',
      title: 'Install skill skill-creator 1.0.0',
      payload,
      project: 'acme',
      state: 'proposed',
      result: null,
      createdAt: iso(60_000),
      expiresAt: iso(-1_800_000),
      decidedAt: null,
    };
    let confirmed = 0;
    let stepped = 0;
    stubCookies('__Host-ras-csrf=csrf-1');
    renderApp({
      path: `/chat/${THREAD}`,
      initialState: owner,
      routes: routes({
        'GET /api/chat/status': ok({
          enabled: true,
          available: true,
          code: null,
          message: null,
          worker: { id: 'w1', name: 'mac-1', online: true },
          runtime: 'claude-code',
          model: null,
          limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
          input: null,
        }),
        'GET /api/chat/threads': ok({ items: [thread], nextCursor: null }),
        'GET /api/chat/threads?limit=1': ok({ items: [thread], nextCursor: null }),
        [`GET /api/chat/threads/${THREAD}`]: ok({
          thread,
          messages: [],
          drafts: [d],
          turn: null,
          watches: [],
          starred: [],
        }),
        'GET /api/usage-limits/overview': ok({
          generatedAt: iso(0),
          settings: { nearThreshold: 80, notifyNear: true },
          entries: [],
          otherLimits: [],
        }),
        'POST /api/auth/step-up': () => {
          stepped += 1;
          return { status: 200, body: { stepUpValidUntil: iso(-600_000) } };
        },
        [`POST /api/chat/drafts/${d.id}/confirm`]: () => {
          confirmed += 1;
          return {
            status: 200,
            body: {
              draft: { ...d, state: 'confirmed', decidedAt: iso(0) },
              result: {
                skillId: 'skill-creator',
                version: '1.0.0',
                signer: 'panel',
                layout: 2,
                assignedTo: 'acme',
              },
            },
          };
        },
      }),
    });
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    const c = await openStripCard('Install skill skill-creator 1.0.0', { scope: log });
    expect(within(c).getByTestId('skill-import-note').textContent).toContain('panelin yetenek anahtarıyla');
    expect(c.textContent).toContain('Riskli talimat');
    const user = userEvent.setup();
    await user.click(within(c).getByRole('button', { name: 'Onayla' }));
    await user.type(await within(c).findByLabelText('Authenticator kodu'), '123456');
    await user.click(within(c).getByRole('button', { name: 'Kodu gönder ve onayla' }));
    await waitFor(() => {
      expect(confirmed).toBe(1);
    });
    expect(stepped).toBe(1);
  });
});
