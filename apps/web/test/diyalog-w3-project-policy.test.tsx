// p12-diyalog wave 2 (W3): Projeler → Politika natively in the Diyalog language — every policy panel (execution,
// safe commands, approval waits, sub-jobs, routing, runtime advice, off-peak, usage limits, queue, package caches)
// over the classic requests, client checks and step-up; viewers read only; the classic English section texts are gone.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  POLICY_ADVICE,
  POLICY_APPROVAL_PAUSE,
  POLICY_CACHES,
  POLICY_OFF_PEAK,
  POLICY_QUEUE,
  POLICY_ROUTING,
  POLICY_USAGE_LIMIT,
} from '../src/diyalog/harness/screens/w3-project-policy';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = { ...owner, user: { ...USER, role: 'viewer' } };

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const STEP_UP = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

const PROJECT = {
  id: 'alpha',
  name: 'Alpha app',
  kind: 'repository',
  createdAt: '2026-10-01T10:00:00.000Z',
  createdBy: null,
  members: 2,
  myRole: 'owner',
};

const EXECUTION = {
  project: 'alpha',
  hostExecution: false,
  unconfined: false,
  allowAutoApprove: false,
  safeCommands: 'read-only',
  subtasks: false,
  delegationRuntimes: [],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () => ok({ items: [PROJECT] }),
    'GET /api/projects/alpha/workers': () => ok({ items: [] }),
    'GET /api/models': () => ok({ items: [], defaults: [] }),
    'GET /api/projects/alpha/execution': () => ok(EXECUTION),
    'GET /api/projects/alpha/approval-pause': () => ok({ ...POLICY_APPROVAL_PAUSE, project: 'alpha' }),
    'GET /api/projects/alpha/queue-settings': () => ok({ ...POLICY_QUEUE, project: 'alpha' }),
    'GET /api/projects/alpha/off-peak': () => ok(POLICY_OFF_PEAK),
    'GET /api/projects/alpha/usage-limit-policy': () => ok({ ...POLICY_USAGE_LIMIT, project: 'alpha' }),
    'GET /api/projects/alpha/runtime-advice': () => ok(POLICY_ADVICE),
    'GET /api/projects/alpha/package-caches': () => ok({ ...POLICY_CACHES, project: 'alpha' }),
    'GET /api/routing/rules?project=alpha': () =>
      ok({
        rules: POLICY_ROUTING.rules.map((r) => (r.project === null ? r : { ...r, project: 'alpha' })),
      }),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Projeler → Politika (p12-diyalog wave 2, W3)', { timeout: 20_000 }, () => {
  it('renders every policy panel natively in Turkish (no classic section texts)', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/projects/alpha?tab=policy', initialState: owner, routes: routes() });
    // p15-form-pattern: Politika · Ağ erişimi · Sınırlar ve yönlendirme are tabs of the project, one form each.
    const policy = await screen.findByTestId('dy-project-policy');
    for (const h of ['Çalıştırma politikası', 'Güvenli komutlar', 'Uzun onay beklemeleri', 'Alt işler'])
      expect(within(policy).getByRole('heading', { level: 2, name: h })).toBeTruthy();
    await screen.findByTestId('execution-policy');
    for (const english of ['Execution policy', 'Safe commands', 'Long approval waits', 'Sub-jobs'])
      expect(within(policy).queryByRole('heading', { name: english })).toBeNull();
    expect(within(policy).queryByRole('region', { name: 'Execution policy of alpha' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Sınırlar ve yönlendirme' }));
    const tab = await screen.findByTestId('dy-project-limits');
    for (const h of [
      'Yönlendirme',
      'Runtime önerisi',
      'Yoğun olmayan saatler',
      'Kullanım limitleri',
      'Kuyruk',
      'Paket önbellekleri',
    ])
      expect(within(tab).getByRole('heading', { level: 2, name: h })).toBeTruthy();
    await screen.findByTestId('usage-limit-current');
    await waitFor(() => {
      expect(screen.getByTestId('routing-execute').textContent).toContain('geçersiz kılma');
    });
    expect(screen.getByTestId('routing-plan').textContent).toContain('Tüm projeler');
    expect(screen.getByTestId('usage-limit-fallback-blocked').textContent).toContain('ücretli');
    expect(screen.getByTestId('off-peak-current').textContent).toContain('22:00');
    for (const english of [
      'Routing',
      'Runtime advice',
      'Off-peak window',
      'Usage limits',
      'Queue',
      'Package caches',
    ])
      expect(within(tab).queryByRole('heading', { name: english })).toBeNull();
  });

  it('queue: field checks first, then a save asks for a code and retries (step-up)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/alpha?tab=limits',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/alpha/queue-settings': (r) =>
          stepped ? ok({ project: 'alpha', ...(r.body as object) }) : STEP_UP,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const form = await screen.findByRole('form', { name: 'Kuyruk ayarları' });
    const perUser = within(form).getByLabelText('Kişi başına en fazla iş');
    await user.clear(perUser);
    await user.type(perUser, '500');
    // p15-form-pattern: the card has no own button in the tab's form; the sticky bar saves it.
    expect(within(form).queryByRole('button', { name: 'Kuyruk ayarlarını kaydet' })).toBeNull();
    await user.click(screen.getByTestId('dy-form-save'));
    expect(within(form).getByText('1 ile 100 arasında tam sayı girin ya da boş bırakın.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await user.clear(perUser);
    await user.type(perUser, '4');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect(puts[1]?.body).toEqual({ maxPerUser: 4, maxPerAutomation: null, waitNotifyMinutes: 15 });
    });
    expect(await screen.findByText('Kuyruk ayarları kaydedildi.')).toBeTruthy();
  });

  it('routing: sets a project rule (kind + runtime order) behind step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/alpha?tab=limits',
      initialState: owner,
      routes: routes({
        'PUT /api/routing/rules': () => (stepped ? ok({ rules: [] }) : STEP_UP),
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const form = await screen.findByRole('form', { name: 'Yönlendirme kuralı belirle' });
    await user.selectOptions(within(form).getByLabelText('İş türü'), 'research');
    await user.click(within(form).getByLabelText('Codex'));
    await user.click(within(form).getByLabelText('Pi'));
    expect(within(form).getByLabelText('2. Pi')).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Kuralı kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect(puts[1]?.body).toEqual({
        project: 'alpha',
        role: 'research',
        modelProfile: null,
        runtimes: ['codex', 'pi'],
      });
    });
  });

  it('usage limits: the classic check in Turkish; "workspace default" sends no policy', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/alpha?tab=limits',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/alpha/usage-limit-policy': () =>
          ok({ ...POLICY_USAGE_LIMIT, project: 'alpha', own: null, source: 'default' }),
        'POST /api/auth/step-up': () =>
          ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() }),
      }),
    });
    const form = await screen.findByRole('form', { name: 'Kullanım limiti politikası' });
    const wait = within(form).getByLabelText('Şu kadar saat içinde sıfırlanıyorsa bekle');
    await user.clear(wait);
    await user.type(wait, '0');
    await user.click(screen.getByTestId('dy-form-save'));
    expect(await screen.findByText('Bekleme süresi 0,25 ile 168 saat arasında olmalı.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await user.click(within(form).getByRole('button', { name: 'Çalışma alanı varsayılanını kullan' }));
    await waitFor(() => {
      const put = requests.find((r) => r.method === 'PUT');
      expect(put?.body).toEqual({ policy: null });
    });
    expect(await screen.findByText('Proje artık çalışma alanı varsayılanını izliyor.')).toBeTruthy();
  });

  it('package caches switch saves through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/alpha?tab=limits',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/alpha/package-caches': (r) =>
          ok({ ...POLICY_CACHES, project: 'alpha', ...(r.body as object) }),
      }),
    });
    const sw = await screen.findByTestId('package-caches-switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await user.click(sw);
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ enabled: false });
    });
    await waitFor(() => {
      expect(screen.getByTestId('package-caches-switch').getAttribute('aria-checked')).toBe('false');
    });
  });

  it('a viewer reads the policy: facts, no save buttons, no routing form', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/projects/alpha?tab=policy', initialState: viewer, routes: routes() });
    expect(await screen.findByTestId('policy-read-only')).toBeTruthy();
    const pause = await screen.findByTestId('approval-pause-read');
    expect(pause.textContent).toContain('15 dk');
    expect(screen.queryByRole('button', { name: /kaydet$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tam erişimi aç' })).toBeNull();
    const box = await screen.findByTestId('execution-policy');
    for (const c of within(box).getAllByRole<HTMLInputElement>('checkbox')) expect(c.disabled).toBe(true);
    // p15-form-pattern: queue, caches and routing are in the "Sınırlar ve yönlendirme" tab; a viewer gets no bar.
    await user.click(screen.getByRole('tab', { name: 'Sınırlar ve yönlendirme' }));
    expect((await screen.findByTestId('queue-settings-read')).textContent).toContain('Sınır yok');
    expect((await screen.findByTestId('package-caches-current')).textContent).toContain('Açık');
    await screen.findByTestId('routing-execute');
    expect(screen.queryByRole('form', { name: 'Yönlendirme kuralı belirle' })).toBeNull();
    expect(screen.queryByRole('button', { name: /kaydet$/ })).toBeNull();
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
  });
});
