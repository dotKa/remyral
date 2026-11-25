// p14-repo-egress: Projeler → Politika → "Ağ erişimi" of a repository project in the Diyalog UI (Turkish and English:
// default Kapalı with the recommendation, "apply the recommendation" → allowlist with the package registries saved
// through step-up, custom hosts checked on the client, the live reach line, machines on an older worker named,
// read-only for non-admins, hidden for workspace projects) and the classic Projects → Policy section (English).
import { REPO_EGRESS_PRESETS } from '@remyral/protocol';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftReach, REPO_EGRESS_PRESET_HOSTS } from '../src/api/repo-egress';
import { type AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 8_000 });

type Locale = 'tr' | 'en';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
const REGISTRIES = ['npm', 'pypi', 'crates', 'go', 'maven'];

function session(locale: Locale) {
  return {
    user: USER,
    createdAt: iso(1e6),
    expiresAt: iso(-1e6),
    idleExpiresAt: iso(-1e5),
    mfaAt: iso(1e6),
    stepUpValidUntil: null,
    stepUpScope: 'window' as const,
    alwaysFreshValidUntil: null,
    type: 'standard' as const,
    locale,
  };
}
const owner = (locale: Locale): AuthState => ({
  kind: 'signedIn',
  user: USER,
  session: session(locale),
  remainingRecoveryCodes: null,
});
const operator: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'operator' },
  session: session('tr'),
  remainingRecoveryCodes: null,
};

const WORDS = {
  tr: {
    off: 'Kapalı (yalnız model API’leri)',
    allowed: 'Yalnız izin verilenler',
    reachNone: 'Şu an işler yalnız model API’lerine ulaşabilir.',
    reachN: (n: number) => `Şu an işler model API’lerine ve ${String(n)} adrese ulaşabilir.`,
    floor: 'her kapsamda kapalıdır; model API’leri her zaman açıktır',
    apply: 'Önerileni uygula',
    hostLabel: 'Adres ekle (adres veya adres:port)',
    ip: 'IP adresi yazılamaz; alan adı kullanın.',
    saved: 'Ağ erişimi kaydedildi; sıradaki işler yeni ayarla başlar.',
    unsupported: '1 makine eski bir Remyral sürümü çalıştırıyor',
    readOnly: 'Bu ayarı yalnız proje sahipleri ve yöneticileri değiştirebilir.',
  },
  en: {
    off: 'Off (model APIs only)',
    allowed: 'Allowed only',
    reachNone: 'Jobs can reach the model APIs only.',
    reachN: (n: number) => `Jobs can reach the model APIs and ${String(n)} addresses.`,
    floor: 'are refused in every scope; the model APIs are always reachable',
    apply: 'Apply the recommendation',
    hostLabel: 'Add an address (host or host:port)',
    ip: 'IP addresses are not allowed; use a domain name.',
    saved: 'Network access saved; the next jobs start with it.',
    unsupported: '1 machine runs an older Remyral version',
    readOnly: 'Only project owners and admins can change this setting.',
  },
} as const;

const view = (over: Record<string, unknown> = {}) => ({
  project: 'alpha',
  kind: 'repository',
  mode: 'none',
  presets: [],
  hosts: [],
  effective: { mode: 'none', hosts: [] },
  updatedAt: null,
  updatedBy: null,
  unsupportedWorkers: [{ id: 'wrk_old', name: 'pi-garage' }],
  ...over,
});

function projects(kind: 'repository' | 'workspace') {
  return {
    items: [
      {
        id: 'alpha',
        name: 'Alpha app',
        kind,
        createdAt: '2026-10-01T10:00:00.000Z',
        createdBy: null,
        members: 1,
        myRole: 'owner',
      },
    ],
  };
}

function routes(
  locale: Locale,
  over: Record<string, Handler> = {},
  kind: 'repository' | 'workspace' = 'repository',
) {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok({ ...(sessionBody() as object), locale }),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/projects': ok(projects(kind)),
    'GET /api/projects/alpha/repo-egress': ok(view()),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialogs = await screen.findAllByRole('dialog');
  const dialog = dialogs.at(-1) as HTMLElement;
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

describe('preset hosts', () => {
  it('the console list matches the protocol list the master expands', () => {
    expect(REPO_EGRESS_PRESET_HOSTS).toEqual(REPO_EGRESS_PRESETS);
    expect(draftReach('allowlist', [], [])).toEqual({ mode: 'none', hosts: [] });
    expect(draftReach('none', ['npm'], ['a.example.com'])).toEqual({ mode: 'none', hosts: [] });
    expect(draftReach('allowlist', ['go'], ['a.example.com']).hosts).toEqual([
      'a.example.com',
      'proxy.golang.org',
      'sum.golang.org',
    ]);
  });
});

describe('Projeler → Politika → Ağ erişimi (p14-repo-egress)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: default off with the recommendation; admin applies it plus a host through step-up',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-1');
      let stepped = false;
      let body: unknown = null;
      renderApp({
        path: '/projects/alpha?tab=network', // p15-form-pattern: the "Ağ erişimi" tab
        initialState: owner(locale),
        i18n: true,
        routes: routes(locale, {
          'PUT /api/projects/alpha/repo-egress': (req) => {
            if (!stepped) return STEP_UP;
            body = req.body;
            const b = req.body as { mode: string; presets: string[]; hosts: string[] };
            return {
              status: 200,
              body: view({
                ...b,
                effective: {
                  mode: b.mode,
                  hosts: draftReach('allowlist', b.presets as never, b.hosts).hosts,
                },
                updatedAt: '2026-10-21T10:00:00.000Z',
                updatedBy: 'alex',
                unsupportedWorkers: [],
              }),
            };
          },
          'POST /api/auth/step-up': () => {
            stepped = true;
            return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
          },
        }),
      });
      const panel = await screen.findByTestId('project-network-panel');
      const mode = await within(panel).findByTestId('network-mode');
      const off = within(mode).getByRole('radio', { name: new RegExp(w.off.replace(/[()]/g, '.')) });
      expect((off as HTMLInputElement).checked).toBe(true);
      expect(within(panel).getByTestId('network-reach').textContent).toBe(w.reachNone);
      expect(panel.textContent).toContain(w.floor);
      expect(within(panel).getByTestId('network-unsupported').textContent).toContain(w.unsupported);
      expect(within(panel).getByTestId('network-unsupported').textContent).toContain('pi-garage');
      // Off: no groups, no host editor.
      expect(within(panel).queryByTestId('network-presets')).toBeNull();

      await user.click(within(panel).getByTestId('network-apply-recommended'));
      const allowed = within(mode).getByRole('radio', { name: new RegExp(w.allowed) });
      expect((allowed as HTMLInputElement).checked).toBe(true);
      for (const p of REGISTRIES)
        expect(within(panel).getByTestId<HTMLInputElement>(`network-preset-${p}`).checked).toBe(true);
      expect(within(panel).getByTestId<HTMLInputElement>('network-preset-github').checked).toBe(false);
      const registryHosts = draftReach('allowlist', REGISTRIES as never, []).hosts.length;
      expect(within(panel).getByTestId('network-reach').textContent).toBe(w.reachN(registryHosts));
      expect(within(panel).queryByTestId('network-recommend')).toBeNull();

      // Client-side refusal of an IP literal, then a custom host.
      const input = within(panel).getByLabelText(w.hostLabel);
      await user.type(input, '10.0.0.1');
      await user.click(within(panel).getByTestId('network-host-add'));
      expect(panel.textContent).toContain(w.ip);
      await user.clear(input);
      await user.type(input, 'cdn.example.com{Enter}');
      await user.click(within(panel).getByTestId('network-preset-github'));
      expect(within(panel).getByTestId('network-reach').textContent).toBe(
        w.reachN(registryHosts + 1 + REPO_EGRESS_PRESETS.github.length),
      );

      expect(within(panel).queryByTestId('network-save')).toBeNull();
      await user.click(screen.getByTestId('dy-form-save'));
      await confirmStepUp(user);
      await waitFor(() => {
        expect(body).toEqual({
          mode: 'allowlist',
          presets: [...REGISTRIES, 'github'],
          hosts: ['cdn.example.com'],
        });
      });
      // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
      expect(await findToast(w.saved)).toBeTruthy();
      expect(within(panel).queryByTestId('network-unsupported')).toBeNull();
    },
  );

  it('non-admins read the setting only', async () => {
    renderApp({
      path: '/projects/alpha?tab=network', // p15-form-pattern: the "Ağ erişimi" tab
      initialState: operator,
      routes: routes('tr', {
        'GET /api/projects/alpha/repo-egress': ok(
          view({
            mode: 'allowlist',
            presets: ['npm'],
            hosts: ['cdn.example.com'],
            effective: { mode: 'allowlist', hosts: ['cdn.example.com', ...REPO_EGRESS_PRESETS.npm] },
            unsupportedWorkers: [],
          }),
        ),
      }),
    });
    const panel = await screen.findByTestId('project-network-panel');
    expect(await within(panel).findByTestId('network-read-only')).toBeTruthy();
    expect(panel.textContent).toContain(WORDS.tr.readOnly);
    expect(within(panel).getByTestId('network-hosts').textContent).toContain('cdn.example.com');
    expect(within(panel).getByTestId('network-reach').textContent).toBe(WORDS.tr.reachN(4));
    expect(within(panel).queryByTestId('network-save')).toBeNull();
    expect(within(panel).queryByTestId('network-host-input')).toBeNull();
    expect(within(panel).queryByTestId('network-apply-recommended')).toBeNull();
    for (const r of within(panel).getAllByRole('radio')) expect(r.matches(':disabled')).toBe(true);
  });

  it('workspace projects do not show it (their egress lives on the Workspace tab)', async () => {
    renderApp({
      path: '/projects/alpha?tab=network', // p15-form-pattern: the "Ağ erişimi" tab
      initialState: owner('tr'),
      routes: routes('tr', {}, 'workspace'),
    });
    await screen.findByTestId('dy-project-network');
    expect(screen.queryByTestId('project-network-panel')).toBeNull();
  });
});
