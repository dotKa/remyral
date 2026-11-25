// p12-diyalog wave 2 (W3): Yetenekler (/skills) and Denetim (/audit) in the Diyalog language (flag on) — same
// requests, step-up and role rules as the classic pages; flag off and "Klasik görünüm" keep the classic pages.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { W3_AUDIT, W3_SKILL_FILES, W3_SKILLS } from '../src/diyalog/harness/screens/w3-knowledge';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'viewer' },
  session: null,
  remainingRecoveryCodes: null,
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const PROJECTS = {
  items: [
    {
      id: 'mobil-app',
      name: 'Mobil uygulama',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: null,
      members: 2,
      myRole: 'owner',
    },
  ],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/skills': ok(W3_SKILLS),
    'GET /api/projects': ok(PROJECTS),
    'GET /api/skills/lint-fix/versions/1.1.0': ok(W3_SKILL_FILES),
    'GET /api/audit?limit=50': ok(W3_AUDIT),
    'GET /api/audit?limit=50&cursor=c1': ok({ items: [], nextCursor: null }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Yetenekler (/skills)', () => {
  it('lists versions with signer, assignments and the panel key; files open as text', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/skills', initialState: owner, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yetenekler' })).toBeTruthy();
    const cards = await screen.findAllByTestId('skill-card');
    expect(cards).toHaveLength(2);
    const lint = cards[0] as HTMLElement;
    expect(within(lint).getAllByTestId('skill-version')).toHaveLength(2);
    expect(
      within(lint)
        .getAllByTestId('skill-signer')
        .map((s) => s.textContent),
    ).toEqual(['çevrimdışı imzalı', 'panel imzalı']);
    const assigned = within(lint).getByTestId('skill-assignments');
    expect(assigned.textContent).toContain('mobil-app');
    expect(assigned.textContent).toContain('1.0.0 sürümüne sabit');
    expect(assigned.textContent).toContain('Tüm projeler');
    expect(cards[1]?.textContent).toContain('silindi');
    expect(screen.getByTestId('skills-panel-key').textContent).toContain('panel-7f3a');
    // No classic leftovers on the Diyalog screen.
    expect(screen.queryByText('Upload a signed skill')).toBeNull();
    await user.click(within(lint).getAllByRole('button', { name: 'Dosyalar' })[0] as HTMLElement);
    const files = await within(lint).findByTestId('skill-files');
    expect(files.textContent).toContain('scripts/fix.sh');
    expect(files.textContent).toContain('betik');
  });

  it('viewers get no upload, assign or remove controls', async () => {
    renderApp({
      path: '/skills',
      initialState: viewer,
      routes: routes({
        'GET /api/auth/session': ok({
          ...(sessionBody() as Record<string, unknown>),
          user: { ...USER, role: 'viewer' },
        }),
      }),
    });
    await screen.findAllByTestId('skill-card');
    expect(screen.queryByTestId('skills-upload')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kaldır' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'lint-fix ata' })).toBeNull();
  });

  it('assigning goes through step-up and sends the classic body', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/skills',
      initialState: owner,
      routes: routes({
        'PUT /api/skills/assignments': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          body = req.body;
          return {
            status: 200,
            body: {
              id: '00000000-0000-4000-8000-00000000a009',
              skillId: 'lint-fix',
              project: 'mobil-app',
              runtimes: ['codex'],
              version: '1.1.0',
              updatedAt: '2026-10-19T10:00:00.000Z',
            },
          };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const form = await screen.findByRole('form', { name: 'lint-fix ata' });
    await user.selectOptions(within(form).getByLabelText('lint-fix sürümü'), '1.1.0');
    await user.click(within(form).getByRole('checkbox', { name: 'Codex' }));
    await user.click(within(form).getByRole('button', { name: 'Ata' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Yetenek atamak güncel bir doğrulama kodu ister.');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
    await waitFor(() => {
      expect(body).toEqual({
        skillId: 'lint-fix',
        project: 'mobil-app',
        runtimes: ['codex'],
        version: '1.1.0',
      });
    });
    expect(await screen.findByText('lint-fix, mobil-app için atandı.')).toBeTruthy();
  });
});

describe('Diyalog Denetim (/audit)', () => {
  it('lists events with outcome words, keeps hostile text inert, opens the detail sheet', async () => {
    const user = userEvent.setup();
    const { container } = renderApp({ path: '/audit', initialState: owner, routes: routes() });
    const region = await screen.findByRole('region', { name: 'Denetim kayıtları' });
    const table = await within(region).findByTestId('audit-table');
    expect(table.textContent).toContain('reddedildi');
    expect(table.textContent).toContain('anonim');
    expect(region.textContent).toContain('deploy:<img src=x onerror=alert(1)>');
    expect(container.querySelector('img:not([data-brand])')).toBeNull();
    await user.click(within(table).getByRole('button', { name: 'worker.approve' }));
    const sheet = await screen.findByRole('dialog', { name: 'Denetim kaydı #1040' });
    expect(within(sheet).getByTestId('json-block').textContent).toContain('"password": "[REDACTED]"');
    expect(sheet.textContent).toContain('a'.repeat(64));
    await user.click(within(sheet).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Denetim kaydı #1040' })).toBeNull();
    });
  });

  it('sends the filters as the classic query', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/audit',
      initialState: owner,
      routes: routes({
        'GET /api/audit?actorType=worker&action=job.&outcome=denied&q=mac+9f&limit=50': empty,
      }),
    });
    await screen.findByTestId('audit-table');
    await user.type(screen.getByLabelText('Ara'), 'mac 9f');
    await user.click(screen.getByText('Daha fazla süzgeç'));
    await user.selectOptions(screen.getByLabelText('Aktör türü'), 'worker');
    await user.type(screen.getByLabelText('Eylem şununla başlar'), 'JOB.');
    await user.selectOptions(screen.getByLabelText('Sonuç'), 'denied');
    await user.click(screen.getByRole('button', { name: 'Uygula' }));
    expect(await screen.findByTestId('empty-state')).toBeTruthy();
    expect(r.requests.at(-1)?.url).toBe(
      '/api/audit?actorType=worker&action=job.&outcome=denied&q=mac+9f&limit=50',
    );
  });

  it('verifies the chain and names the first broken event', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/audit',
      initialState: owner,
      routes: routes({
        'GET /api/audit/verify': ok({
          ok: false,
          checked: 41,
          fromId: null,
          toId: null,
          lastCheckedId: null,
          headHash: null,
          brokenAtId: '42',
          reason: 'hash_mismatch',
          anchored: 'genesis',
          verifiedAt: new Date().toISOString(),
        }),
      }),
    });
    await screen.findByTestId('audit-table');
    await user.click(screen.getByRole('button', { name: 'Zinciri doğrula' }));
    const result = await screen.findByTestId('verify-result');
    expect(result.textContent).toContain('#42');
    expect(result.textContent).toContain('kayıt değiştirilmiş');
  });

  it('non-admins see the owner/admin notice and no export', async () => {
    renderApp({
      path: '/audit',
      initialState: viewer,
      routes: routes({
        'GET /api/auth/session': ok({
          ...(sessionBody() as Record<string, unknown>),
          user: { ...USER, role: 'viewer' },
        }),
        'GET /api/audit?limit=50': () => ({ status: 403, body: { error: 'forbidden', message: 'No.' } }),
      }),
    });
    expect((await screen.findByTestId('forbidden')).textContent).toContain('sahip ya da yönetici');
    expect(screen.queryByRole('button', { name: 'Dışa aktar' })).toBeNull();
  });
});
