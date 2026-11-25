// p14-skill-import (ADR-0054): Diyalog Yetenekler → "Yetenek içe aktar" (GitHub link → preview with findings →
// publish with an always-fresh step-up), provenance badges, and Projeler → Politika → "Yetenek imzası".
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { W3_SKILLS } from '../src/diyalog/harness/screens/w3-knowledge';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = { ...owner, user: { ...USER, role: 'viewer' } };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };

const PREVIEW = {
  id: '00000000-0000-4000-8000-0000000000aa',
  sourceKind: 'github',
  source: {
    repo: 'anthropics/skills',
    path: 'skills/pdf',
    ref: 'main',
    commit: 'c0ffee'.padEnd(40, '0'),
    url: 'https://github.com/anthropics/skills/tree/c0ffee/skills/pdf',
  },
  state: 'previewed',
  blocked: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z',
  suggested: { skillId: 'pdf', title: 'PDF', description: 'Use for PDF forms.', version: '1.0.0' },
  latest: null,
  files: [
    {
      path: 'SKILL.md',
      size: 40,
      sha256: 'a'.repeat(64),
      executable: false,
      content: '<img src=x onerror=alert(1)>',
    },
    { path: 'scripts/fill.py', size: 20, sha256: 'b'.repeat(64), executable: true, content: 'print(1)\n' },
  ],
  excluded: [{ path: '.github/ci.yml', size: 10, reason: 'hidden' }],
  findings: [
    { kind: 'script', severity: 'warn', path: 'scripts/fill.py', line: 9 },
    {
      kind: 'risky',
      severity: 'warn',
      path: 'SKILL.md',
      line: 3,
      rule: 'pipe_to_shell',
      excerpt: 'curl x | sh',
    },
    { kind: 'skipped', severity: 'info', path: '.github/ci.yml', rule: 'hidden' },
    { kind: 'license', severity: 'info', path: 'resources/LICENSE.txt', rule: 'Apache-2.0' },
  ],
  license: { path: 'resources/LICENSE.txt', name: 'Apache-2.0' },
  fileCount: 2,
  totalBytes: 60,
  diff: null,
  published: null,
  limits: { maxFiles: 32, maxFileBytes: 65536, maxTotalBytes: 131072 },
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': ok({ items: [] }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/skills': ok(W3_SKILLS),
    'GET /api/projects': ok({
      items: [
        {
          id: 'alpha',
          name: 'Alpha app',
          kind: 'repository',
          createdAt: '2026-10-01T10:00:00.000Z',
          createdBy: null,
          members: 1,
          myRole: 'owner',
        },
      ],
    }),
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

describe('Diyalog Yetenekler: import from the panel (p14-skill-import)', { timeout: 20_000 }, () => {
  it('versions show where they came from (GitHub repo@commit links to the pinned commit)', async () => {
    renderApp({ path: '/skills', initialState: viewer, routes: routes() });
    const badge = await screen.findByTestId('skill-provenance');
    expect(badge.textContent).toContain('Panelden içe aktarıldı · anthropics/skills@a1b2c3d');
    expect(badge.getAttribute('href')).toBe(
      'https://github.com/anthropics/skills/tree/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/skills/lint',
    );
    // Viewers cannot import.
    expect(screen.queryByTestId('skills-import')).toBeNull();
  });

  it('GitHub link → preview (findings as text) → publish behind an always-fresh step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = 0;
    let previewBody: unknown = null;
    let publishBody: unknown = null;
    renderApp({
      path: '/skills',
      initialState: owner,
      routes: routes({
        'POST /api/skills/imports': (req) => {
          if (stepped === 0) return STEP_UP;
          previewBody = req.body;
          return { status: 201, body: PREVIEW };
        },
        [`POST /api/skills/imports/${PREVIEW.id}/publish`]: (req) => {
          if (stepped < 2) return STEP_UP;
          publishBody = req.body;
          return {
            status: 201,
            body: {
              version: {
                ...W3_SKILLS.skills[0]?.versions[0],
                version: '1.0.0',
                signer: 'panel',
                provenance: { kind: 'github', repo: 'anthropics/skills', commit: PREVIEW.source.commit },
              },
              assignment: {
                id: '00000000-0000-4000-8000-00000000a0a0',
                skillId: 'pdf',
                project: 'alpha',
                runtimes: null,
                version: null,
                updatedAt: '2026-10-20T10:00:00.000Z',
              },
            },
          };
        },
        'POST /api/auth/step-up': () => {
          stepped += 1;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const panel = await screen.findByTestId('skills-import');
    await user.click(within(panel).getByRole('button', { name: 'GitHub bağlantısı' }));
    await user.type(
      within(panel).getByLabelText('GitHub klasör bağlantısı'),
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
    );
    await user.click(within(panel).getByRole('button', { name: 'Önizle' }));
    await confirmStepUp(user, 'İçe aktarma önizlemesi güncel bir doğrulama kodu ister.');
    const preview = await screen.findByTestId('skill-import-preview');
    expect(previewBody).toEqual({
      kind: 'github',
      url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    });
    expect(preview.textContent).toContain('GitHub anthropics/skills · commit c0ffee000000');
    expect(preview.textContent).toContain('Bu yetenek çalıştırılabilir dosya içeriyor: scripts/fill.py');
    expect(preview.textContent).toContain('internetten indirip doğrudan kabuğa veriyor');
    expect(preview.textContent).toContain('Lisans: Apache-2.0');
    expect(preview.textContent).toContain('.github/ci.yml alınmadı (gizli ya da sistem dosyası)');
    // Untrusted file content renders as text, never as markup.
    expect(preview.querySelector('img')).toBeNull();

    const form = within(preview).getByRole('form', { name: 'Yayımla' });
    expect(within(form).getByLabelText<HTMLInputElement>(/Yetenek kimliği/).value).toBe('pdf');
    await user.selectOptions(within(form).getByLabelText('Atama'), 'alpha');
    await user.click(within(form).getByRole('checkbox', { name: 'Pi' }));
    await user.click(within(form).getByRole('button', { name: 'Panel anahtarıyla imzala ve yayımla' }));
    await confirmStepUp(
      user,
      'İçe aktarılan yeteneği yayımlamak her seferinde güncel bir doğrulama kodu ister.',
    );
    await waitFor(() => {
      expect(publishBody).toEqual({
        skillId: 'pdf',
        title: 'PDF',
        description: 'Use for PDF forms.',
        version: '1.0.0',
        runtimes: ['claude-code', 'codex', 'opencode'],
        assign: { project: 'alpha' },
      });
    });
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast(/pdf 1\.0\.0 yayımlandı \(panel anahtarıyla imzalı\)/)).toBeTruthy();
  });

  it('a blocked preview cannot be published', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const blocked = {
      ...PREVIEW,
      blocked: true,
      findings: [{ kind: 'secret', severity: 'block', path: 'SKILL.md', line: 4, rule: 'github-token' }],
    };
    renderApp({
      path: '/skills',
      initialState: owner,
      routes: routes({ 'POST /api/skills/imports': () => ({ status: 201, body: blocked }) }),
    });
    const panel = await screen.findByTestId('skills-import');
    await user.click(within(panel).getByRole('button', { name: 'GitHub bağlantısı' }));
    await user.type(within(panel).getByLabelText('GitHub klasör bağlantısı'), 'https://github.com/o/r');
    await user.click(within(panel).getByRole('button', { name: 'Önizle' }));
    const preview = await screen.findByTestId('skill-import-preview');
    expect(preview.textContent).toContain('Gizli bilgiye benzeyen bir değer var: SKILL.md:4 (github-token)');
    expect(preview.textContent).toContain('Engelleyen bulgular var');
    expect(
      within(preview).getByRole<HTMLButtonElement>('button', {
        name: 'Panel anahtarıyla imzala ve yayımla',
      }).disabled,
    ).toBe(true);
  });
});

describe('Projeler → Politika → Yetenek imzası (p14-skill-import)', { timeout: 20_000 }, () => {
  it('owners switch a project to offline-signed only through step-up; skipped skills are named', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/projects/alpha?tab=policy',
      initialState: owner,
      routes: routes({
        'GET /api/projects/alpha/skill-trust': ok({
          project: 'alpha',
          trust: 'any',
          panelSignedAssignments: [],
        }),
        'PUT /api/projects/alpha/skill-trust': (req) => {
          if (!stepped) return STEP_UP;
          body = req.body;
          return {
            status: 200,
            body: { project: 'alpha', trust: 'offline-only', panelSignedAssignments: ['lint-fix'] },
          };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const panel = await screen.findByTestId('skill-trust-panel');
    await user.click(await within(panel).findByRole('radio', { name: /Yalnız çevrimdışı imzalı/ }));
    // p15-form-pattern: a section of the Politika tab's form; the sticky bar saves it.
    expect(within(panel).queryByRole('button', { name: 'Kaydet' })).toBeNull();
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user, 'Yetenek imzası ayarını değiştirmek güncel bir doğrulama kodu ister.');
    await waitFor(() => {
      expect(body).toEqual({ trust: 'offline-only' });
    });
    expect(await within(panel).findByText(/artık gitmez: lint-fix/)).toBeTruthy();
  });

  it('viewers read the setting only', async () => {
    renderApp({
      path: '/projects/alpha?tab=policy',
      initialState: viewer,
      routes: routes({
        'GET /api/projects/alpha/skill-trust': ok({
          project: 'alpha',
          trust: 'offline-only',
          panelSignedAssignments: [],
        }),
      }),
    });
    const panel = await screen.findByTestId('skill-trust-panel');
    const radio = await within(panel).findByRole('radio', { name: /Yalnız çevrimdışı imzalı/ });
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(radio.matches(':disabled')).toBe(true);
    expect(within(panel).queryByRole('button', { name: 'Kaydet' })).toBeNull();
  });
});
