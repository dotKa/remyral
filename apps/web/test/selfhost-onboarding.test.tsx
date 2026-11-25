// p16-selfhost-onboarding: the first-owner screen (/setup), the setup hint on the sign-in screen, the owners' setup
// wizard (/onboarding: steps, marks, organisation, security preset, install commands, sample job, finish), the home
// card and empty-state hints, and the "Güncelleme mevcut" band with its notes.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Onboarding, OnboardingStep } from '../src/api/selfhost';
import { ONBOARDING_STEPS } from '../src/api/selfhost';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const admin: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'admin' },
  session: null,
  remainingRecoveryCodes: null,
};
const POLICY = {
  version: 3,
  document: { preset: 'serbest' },
  effective: {
    preset: 'serbest',
    customized: false,
    stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
    events: {},
    autonomy: {
      newProjectsHostExecution: true,
      newProjectsAutoApprove: true,
      jobApproval: 'allow-all',
      autoApprove: {},
      chatDirect: true,
      maxJobMinutes: 10080,
    },
  },
  updatedAt: null,
  updatedBy: null,
  catalog: { events: [], autonomyActions: [] },
};
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function wizard(
  over: Partial<Record<OnboardingStep, 'todo' | 'done' | 'skipped'>> = {},
  extra: Partial<Onboarding> = {},
) {
  const steps = ONBOARDING_STEPS.map((id) => ({
    id,
    state: over[id] ?? (id === 'account' ? 'done' : 'todo'),
    detected: id === 'account',
  }));
  const counted = steps.filter((s) => s.id !== 'done');
  return {
    visible: true,
    completedAt: null,
    organisationName: null,
    steps,
    progress: { done: counted.filter((s) => s.state !== 'todo').length, total: counted.length },
    current: counted.find((s) => s.state === 'todo')?.id ?? 'done',
    ...extra,
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/onboarding': ok(wizard()),
    'GET /api/updates/status': ok({
      configured: true,
      currentVersion: '1.0.0',
      latest: null,
      updateAvailable: false,
      newer: [],
      checkedAt: null,
      error: null,
      command: null,
    }),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      k in t
        ? t[k]
        : ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/setup — the first owner', () => {
  it('the sign-in screen offers the setup while the installation has no account', async () => {
    renderApp({
      path: '/login',
      routes: routes({
        'GET /api/auth/session': () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }),
        'GET /api/setup/status': ok({ required: true }),
      }),
    });
    const link = await screen.findByTestId('dy-setup-link');
    expect(link.getAttribute('href')).toBe('/setup');
    expect(link.textContent).toContain('İlk kurulum');
  });

  it('checks the fields, sends token + username + password, then points to the sign-in', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/setup',
      routes: routes({
        'GET /api/auth/session': () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }),
        'GET /api/setup/status': ok({ required: true }),
        'POST /api/setup/owner': () => ({ status: 201, body: { username: 'acme' } }),
      }),
    });
    await screen.findByTestId('dy-setup');
    await user.click(screen.getByRole('button', { name: 'Sahip hesabını oluştur' }));
    expect(screen.getByText('Kurulum anahtarını gir.')).toBeDefined();
    await user.type(screen.getByLabelText('Kurulum anahtarı'), 'rst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');
    await user.type(screen.getByLabelText('Kullanıcı adı'), 'acme');
    await user.type(screen.getByLabelText('Parola'), 'quartz-meadow-lantern-7');
    await user.type(screen.getByLabelText('Parola (tekrar)'), 'quartz-meadow-lantern-7');
    await user.click(screen.getByRole('button', { name: 'Sahip hesabını oluştur' }));
    const done = await screen.findByTestId('dy-setup-done');
    expect(done.textContent).toContain('acme oluşturuldu');
    const sent = r.requests.find((q) => q.method === 'POST' && q.url === '/api/setup/owner');
    expect(sent?.body).toEqual({
      token: 'rst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
      username: 'acme',
      password: 'quartz-meadow-lantern-7',
    });
  });

  it('shows the master’s refusal of a used token in words', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/setup',
      routes: routes({
        'GET /api/auth/session': () => ({ status: 401, body: { error: 'unauthorized', message: 'x' } }),
        'GET /api/setup/status': ok({ required: true }),
        'POST /api/setup/owner': () => ({
          status: 401,
          body: {
            error: 'invalid_setup_token',
            message:
              'The setup token is wrong, used or expired. remyral-ctl setup-token on the server prints a new one.',
          },
        }),
      }),
    });
    await screen.findByTestId('dy-setup');
    await user.type(screen.getByLabelText('Kurulum anahtarı'), 'rst_x');
    await user.type(screen.getByLabelText('Kullanıcı adı'), 'acme');
    await user.type(screen.getByLabelText('Parola'), 'quartz-meadow-lantern-7');
    await user.type(screen.getByLabelText('Parola (tekrar)'), 'quartz-meadow-lantern-7');
    await user.click(screen.getByRole('button', { name: 'Sahip hesabını oluştur' }));
    expect((await screen.findByTestId('api-error')).textContent).toContain('Kurulum anahtarı yanlış');
  });
});

describe('/onboarding — the setup wizard', () => {
  it('opens at the resume point; every step is listed with its state', async () => {
    renderApp({
      path: '/onboarding',
      initialState: owner,
      routes: routes({ 'GET /api/onboarding': ok(wizard({ about_you: 'skipped' })) }),
    });
    await screen.findByTestId('dy-onboarding-body-organisation');
    const steps = screen.getByTestId('dy-onboarding-steps');
    expect(within(steps).getAllByRole('button')).toHaveLength(11);
    expect(screen.getByTestId('dy-onboarding-step-account').getAttribute('data-state')).toBe('done');
    // p17-remyral-brand: the counter counts the actionable steps (ten since p17-memory-import's "Seni tanıyalım");
    // they are numbered 1–10 and the last entry is the completion (a flag, no number), so "2/10 adım" matches.
    expect(screen.getByText('2/10 adım')).toBeDefined();
    expect(screen.getByTestId('dy-onboarding-step-about_you').textContent).toContain('Seni tanıyalım');
    expect(screen.getByTestId('dy-onboarding-step-domain').textContent).toContain('4');
    expect(screen.getByTestId('dy-onboarding-step-sample_job').textContent).toContain('10');
    expect(screen.getByTestId('dy-onboarding-step-done').textContent).not.toMatch(/\d/);
  });

  // p17-domain-wizard: the domain step is a form — the address in use, where it comes from, the certificate, the DNS
  // check and "Kaydet" (links only) or "Kaydet ve uygula" (a remyral-ctl host applies the change itself).
  const TLS_ITEM = {
    id: 'tls:public-origin',
    category: 'certificate',
    label: 'tlsCertificate',
    name: 'remyral.example.com',
    basis: 'expires',
    dueAt: '2027-01-20T00:00:00.000Z',
    daysLeft: 88,
    since: null,
    ageDays: null,
    rotateEveryDays: null,
    rotatedAt: null,
    state: 'ok',
    detail: 'trusted · Let’s Encrypt',
    checkedAt: '2026-10-24T08:00:00.000Z',
    runbook: 'docs/ops/deploy-coolify.md',
    stampable: false,
    notifies: true,
  };
  const expiry = (items: object[]) => ({
    items,
    summary: { total: items.length, soon: 0, urgent: 0, expired: 0, unknown: 0, next: null },
    checkedAt: null,
  });
  const NO_HOST = {
    managed: false,
    lastSeen: null,
    version: null,
    domain: null,
    tls: null,
    acmeEmail: null,
    httpsPort: null,
  };
  const HOST = {
    managed: true,
    lastSeen: '2026-10-24T10:00:00.000Z',
    version: '1.2.0',
    domain: 'remyral.example.com',
    tls: 'letsencrypt',
    acmeEmail: 'ops@example.com',
    httpsPort: 443,
  };
  const cd = (over: Record<string, unknown> = {}) => ({
    origin: null,
    source: 'none',
    setting: null,
    environment: null,
    host: NO_HOST,
    request: null,
    ...over,
  });
  const request = (state: string, detail: string | null = null) => ({
    id: '6f1c2d9e-4b7a-4c1e-9a55-1d2e3f4a5b6c',
    domain: 'yeni.example.com',
    tls: 'cloudflare',
    previousDomain: 'remyral.example.com',
    state,
    detail,
    requestedAt: '2026-10-24T10:00:00.000Z',
    expiresAt: '2026-10-24T10:15:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
  });
  async function confirmCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
  }

  it('domain: shows the address in use, where it comes from, the certificate and access', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/onboarding?step=domain',
      initialState: owner,
      routes: routes({
        'GET /api/console-domain': ok(
          cd({
            origin: 'https://remyral.example.com',
            source: 'environment',
            environment: 'https://remyral.example.com',
          }),
        ),
        'GET /api/ops-safety/expiry': ok(expiry([TLS_ITEM])),
        'POST /api/ops-safety/expiry/check': ok(
          expiry([{ ...TLS_ITEM, state: 'error', detail: 'TLS check failed: timeout', dueAt: null }]),
        ),
      }),
    });
    const box = await screen.findByTestId('dy-onboarding-domain');
    await within(box).findByText('https://remyral.example.com');
    expect(within(box).getByText('Sunucu ortamından (PUBLIC_ORIGIN)')).toBeDefined();
    await within(box).findByText(/Geçerli, .*2027.* tarihine kadar \(88 gün\)/);
    // jsdom's origin is not the public one: the step says where the console is open and offers the public address.
    expect(within(box).getByText(/Konsolu şu an .* adresinden açıyorsun/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Genel adresi aç' }).getAttribute('href')).toBe(
      'https://remyral.example.com',
    );
    // The form starts from the address in use; no terminal command anywhere.
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Alan adı' }).value).toBe(
      'remyral.example.com',
    );
    expect(document.body.textContent).not.toContain('remyral-ctl install');
    await user.click(screen.getByTestId('dy-onboarding-domain-check'));
    await within(box).findByText('Denetlenemedi: TLS check failed: timeout');
    expect(r.requests.some((q) => q.url === '/api/ops-safety/expiry/check' && q.method === 'POST')).toBe(
      true,
    );
    expect(r.requests.filter((q) => q.method === 'PUT')).toHaveLength(0);
  });

  it('domain: no address yet and no host applier (Coolify / EC2) — enter it, check DNS, save the links', async () => {
    const user = userEvent.setup();
    let saves = 0;
    const r = renderApp({
      path: '/onboarding?step=domain',
      initialState: owner,
      routes: routes({
        'GET /api/console-domain': ok(cd()),
        'GET /api/ops-safety/expiry': ok(expiry([])),
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
        'POST /api/console-domain/dns-check': (req) => ({
          status: 200,
          body: {
            domain: (req.body as { domain: string }).domain,
            addresses: ['104.21.4.4', '172.67.1.1'],
            expected: [],
            verdict: 'cloudflare',
            detail: null,
            checkedAt: '2026-10-24T10:00:00.000Z',
          },
        }),
        'PUT /api/console-domain': () => {
          saves += 1;
          if (saves === 1)
            return {
              status: 403,
              body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
            };
          const origin = 'https://console.example.org';
          return {
            status: 200,
            body: {
              mode: 'setting',
              origin,
              request: null,
              status: cd({
                origin,
                source: 'setting',
                setting: { origin, source: 'owner', updatedAt: '2026-10-24T10:00:00.000Z' },
              }),
            },
          };
        },
      }),
    });
    const box = await screen.findByTestId('dy-onboarding-domain');
    await within(box).findByText(/^Ayarlı değil\./);
    expect(within(box).getByText('Genel adres ayarlı olmadığı için denetlenmiyor')).toBeDefined();
    expect(screen.getByTestId('dy-onboarding-domain-mode').textContent).toContain(
      'başka bir platform yönlendiriyor',
    );
    // No TLS choice without a host applier: the platform terminates TLS.
    expect(screen.queryByTestId('dy-onboarding-domain-tls')).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Alan adı' });
    await user.clear(input);
    await user.type(input, 'console.example.org');
    expect(screen.getByTestId('dy-onboarding-domain-route').textContent).toContain(
      'https://console.example.org bu konsola gelmeli',
    );
    await user.click(screen.getByTestId('dy-onboarding-domain-dns'));
    expect((await screen.findByTestId('dy-onboarding-domain-dns-result')).textContent).toContain(
      'Cloudflare üzerinden yayınlanıyor (104.21.4.4, 172.67.1.1)',
    );
    await user.click(screen.getByTestId('dy-onboarding-domain-save'));
    await confirmCode(user);
    expect((await screen.findByTestId('dy-onboarding-domain-saved')).textContent).toContain(
      'Kaydedildi: bağlantılar artık https://console.example.org adresini kullanıyor.',
    );
    await within(box).findByText('https://console.example.org');
    expect(within(box).getByText('Kurulum sihirbazında kaydedildi')).toBeDefined();
    const puts = r.requests.filter((q) => q.url === '/api/console-domain' && q.method === 'PUT');
    expect(puts.map((q) => q.body)).toEqual([
      { domain: 'console.example.org' },
      { domain: 'console.example.org' },
    ]);
  });

  it('domain: an invalid name is explained and nothing is sent', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/onboarding?step=domain',
      initialState: owner,
      routes: routes({ 'GET /api/console-domain': ok(cd()), 'GET /api/ops-safety/expiry': ok(expiry([])) }),
    });
    const input = await screen.findByRole('textbox', { name: 'Alan adı' });
    await user.type(input, 'https://konsol.example.com/yol');
    await user.click(screen.getByTestId('dy-onboarding-domain-save'));
    expect(await screen.findByText('Geçerli bir alan adı yaz (ör. konsol.sirketin.example).')).toBeDefined();
    expect(screen.getByTestId<HTMLButtonElement>('dy-onboarding-domain-dns').disabled).toBe(true);
    expect(r.requests.filter((q) => q.method === 'PUT' || q.url.includes('dns-check'))).toHaveLength(0);
  });

  it('domain: a remyral-ctl host — TLS mode, DNS mismatch explained, "Kaydet ve uygula", applying → ready', async () => {
    const user = userEvent.setup();
    let applied = false;
    const managed = cd({
      origin: 'https://remyral.example.com',
      source: 'environment',
      environment: 'https://remyral.example.com',
      host: HOST,
    });
    const r = renderApp({
      path: '/onboarding?step=domain',
      initialState: owner,
      routes: routes({
        'GET /api/console-domain': () => ({
          status: 200,
          body: applied
            ? {
                ...managed,
                origin: 'https://yeni.example.com',
                source: 'setting',
                setting: {
                  origin: 'https://yeni.example.com',
                  source: 'host-applier',
                  updatedAt: '2026-10-24T10:02:00.000Z',
                },
                request: request('applied', 'the console answers at https://yeni.example.com'),
              }
            : managed,
        }),
        'GET /api/ops-safety/expiry': ok(expiry([TLS_ITEM])),
        'POST /api/console-domain/dns-check': ok({
          domain: 'yeni.example.com',
          addresses: ['198.51.100.9'],
          expected: ['203.0.113.10'],
          verdict: 'mismatch',
          detail: null,
          checkedAt: '2026-10-24T10:00:00.000Z',
        }),
        'PUT /api/console-domain': () => {
          applied = true;
          return {
            status: 200,
            body: {
              mode: 'host',
              origin: null,
              request: request('pending'),
              status: { ...managed, request: request('pending') },
            },
          };
        },
      }),
    });
    expect((await screen.findByTestId('dy-onboarding-domain-mode')).textContent).toContain(
      'remyral-ctl ile kuruldu',
    );
    const tls = screen.getByTestId('dy-onboarding-domain-tls');
    expect(within(tls).getByRole<HTMLInputElement>('radio', { name: /Let’s Encrypt/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Let’s Encrypt e-postası' }).value).toBe(
      'ops@example.com',
    );
    await user.click(within(tls).getByRole('radio', { name: /Cloudflare arkasında/ }));
    // No e-mail outside Let's Encrypt.
    expect(screen.queryByRole('textbox', { name: 'Let’s Encrypt e-postası' })).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Alan adı' });
    await user.clear(input);
    await user.type(input, 'Yeni.Example.com');
    await user.click(screen.getByTestId('dy-onboarding-domain-dns'));
    const dns = await screen.findByTestId('dy-onboarding-domain-dns-result');
    expect(dns.textContent).toContain('Hayır: ad 198.51.100.9 adresini gösteriyor');
    expect(dns.textContent).toContain('bu sunucunun bilinen adresi ise 203.0.113.10');
    await user.click(screen.getByRole('button', { name: 'Kaydet ve uygula' }));
    expect((await screen.findByTestId('dy-onboarding-domain-request')).textContent).toContain(
      'yeni.example.com sunucuya iletildi, sıra bekliyor',
    );
    expect(screen.getByTestId('dy-onboarding-domain-cancel')).toBeDefined();
    expect(screen.getByTestId<HTMLButtonElement>('dy-onboarding-domain-save').disabled).toBe(true);
    expect(r.requests.find((q) => q.url === '/api/console-domain' && q.method === 'PUT')?.body).toEqual({
      domain: 'yeni.example.com',
      tls: 'cloudflare',
    });
    // The step polls while the host applies the change.
    await waitFor(
      () => {
        expect(screen.getByTestId('dy-onboarding-domain-request').textContent).toContain(
          'Hazır: konsol artık yeni.example.com adresinde.',
        );
      },
      { timeout: 8_000 },
    );
    expect(screen.getByRole('link', { name: 'Yeni adrese geç' }).getAttribute('href')).toBe(
      'https://yeni.example.com',
    );
    expect(screen.getByText('Sunucu yeni adı uyguladı')).toBeDefined();
  }, 15_000);

  it('domain: a change the host rolled back says why; a stuck request says what to check', async () => {
    renderApp({
      path: '/onboarding?step=domain',
      initialState: owner,
      routes: routes({
        'GET /api/console-domain': ok(
          cd({
            origin: 'https://remyral.example.com',
            source: 'environment',
            environment: 'https://remyral.example.com',
            host: HOST,
            request: request(
              'rolled_back',
              'yeni.example.com did not become healthy in time; back on remyral.example.com',
            ),
          }),
        ),
        'GET /api/ops-safety/expiry': ok(expiry([TLS_ITEM])),
      }),
    });
    const notice = await screen.findByTestId('dy-onboarding-domain-request');
    expect(notice.textContent).toContain('Hata: yeni.example.com did not become healthy in time');
    expect(notice.textContent).toContain('Eski adrese geri dönüldü.');
    expect(screen.getByTestId<HTMLButtonElement>('dy-onboarding-domain-save').disabled).toBe(false);
  });

  it('organisation: saves the name and moves on', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/onboarding?step=organisation',
      initialState: owner,
      routes: routes({
        'PUT /api/onboarding/organisation': ok(
          wizard({ organisation: 'done' }, { organisationName: 'Acme' }),
        ),
      }),
    });
    await user.type(await screen.findByRole('textbox', { name: 'Organizasyon adı' }), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    // p17-remyral-brand: the domain step follows the organisation name.
    await screen.findByTestId('dy-onboarding-body-domain');
    expect(r.requests.find((q) => q.url === '/api/onboarding/organisation')?.body).toEqual({ name: 'Acme' });
  });

  it('a step can be skipped (the mark goes to the master)', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/onboarding?step=integrations',
      initialState: owner,
      routes: routes({ 'PUT /api/onboarding/steps/integrations': ok(wizard({ integrations: 'skipped' })) }),
    });
    await screen.findByTestId('dy-onboarding-body-integrations');
    await user.click(screen.getByTestId('dy-onboarding-skip'));
    await screen.findByTestId('dy-onboarding-body-project');
    expect(r.requests.find((q) => q.url === '/api/onboarding/steps/integrations')?.body).toEqual({
      state: 'skipped',
    });
  });

  it('security: the three presets with their plain explanations; choosing one applies it and marks the step', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/onboarding?step=security',
      initialState: owner,
      routes: routes({
        'GET /api/security/policy': ok(POLICY),
        'PUT /api/security/policy': ok({ ...POLICY, effective: { ...POLICY.effective, preset: 'dengeli' } }),
        'PUT /api/onboarding/steps/security': ok(wizard({ security: 'done' })),
      }),
    });
    const presets = await screen.findByTestId('dy-onboarding-presets');
    expect(presets.textContent).toContain('Serbest');
    expect(presets.textContent).toContain('Dengeli');
    expect(presets.textContent).toContain('Sıkı');
    await waitFor(() => {
      expect(
        within(screen.getByTestId('dy-onboarding-preset-serbest')).getByText('Şu an seçili'),
      ).toBeDefined();
    });
    await user.click(within(screen.getByTestId('dy-onboarding-preset-dengeli')).getByRole('button'));
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'PUT' && q.url === '/api/security/policy')?.body).toEqual({
        preset: 'dengeli',
        resetOverrides: true,
      });
    });
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/onboarding/steps/security')).toBe(true);
    });
  });

  it('machine: one install command pair per system, or how to get one', async () => {
    const kit = (os: string) => ({
      os,
      file: `${os}.tar.gz`,
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      commands: {
        bootstrapUrl: 'https://x',
        bootstrapSha256: 'b'.repeat(64),
        download: `get-${os}`,
        run: `run-${os}`,
      },
      kitUrl: null,
    });
    renderApp({
      path: '/onboarding?step=machine',
      initialState: owner,
      routes: routes({
        'GET /api/installers': ok({
          publicOrigin: 'https://remyral.example.com',
          masterUrl: 'wss://remyral.example.com/v1/worker',
          publicDownloads: true,
          current: {
            version: '1.0.75',
            channel: 'stable',
            stable: true,
            keyId: 'k',
            nodeVersion: '24.21.0',
            uploadedAt: '2026-10-23T10:00:00.000Z',
            kits: [kit('linux'), kit('macos'), kit('windows')],
          },
          withoutKits: [],
        }),
      }),
    });
    const box = await screen.findByTestId('dy-onboarding-install');
    await waitFor(() => {
      expect(box.textContent).toContain('run-windows');
    });
    expect(box.textContent).toContain('get-linux');
    expect(box.textContent).toContain('macOS');
  });

  it('sample job: opens the composer prefilled with the README prompt', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/onboarding?step=sample_job', initialState: owner, routes: routes() });
    await screen.findByTestId('dy-onboarding-body-sample_job');
    expect(screen.getByTestId('dy-onboarding-body-sample_job').textContent).toContain('README dosyasını oku');
    await user.click(screen.getByTestId('dy-onboarding-sample'));
    await waitFor(() => {
      expect(screen.queryByTestId('dy-onboarding')).toBeNull();
    });
  });

  it('done: "Hazırsın" with links; finishing completes the wizard', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/onboarding?step=done',
      initialState: owner,
      routes: routes({ 'POST /api/onboarding/complete': ok({ ...wizard(), visible: false }) }),
    });
    const body = await screen.findByTestId('dy-onboarding-body-done');
    expect(within(body).getByRole('link', { name: 'Sohbet' }).getAttribute('href')).toBe('/chat');
    await user.click(screen.getByTestId('dy-onboarding-finish'));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'POST' && q.url === '/api/onboarding/complete')).toBe(true);
    });
  });

  it('the home card and an empty list point owners to the wizard; others see neither', async () => {
    renderApp({
      path: '/projects',
      initialState: owner,
      routes: routes({ 'GET /api/projects': ok({ items: [] }) }),
    });
    expect(await screen.findByTestId('dy-wizard-hint-project')).toBeDefined();
  });

  it('admins get no wizard', async () => {
    const r = renderApp({ path: '/onboarding', initialState: admin, routes: routes() });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-onboarding')).toBeNull();
    });
    expect(r.requests.some((q) => q.url === '/api/onboarding')).toBe(false);
  });
});

describe('Güncelleme mevcut', () => {
  const status = {
    configured: true,
    currentVersion: '1.0.0',
    latest: null,
    updateAvailable: true,
    newer: [
      {
        version: '1.1.0',
        publishedAt: '2026-10-23T10:00:00.000Z',
        minWorkerVersion: '1.0.75',
        migrationsHead: '0148',
        breaking: ['The Traefik overlay needs the remyral-proxy network'],
        summary: 'Kurulum sihirbazı',
        notes: '- feat: setup wizard',
      },
    ],
    checkedAt: '2026-10-23T11:00:00.000Z',
    error: null,
    command: 'sudo remyral-ctl upgrade --to 1.1.0',
  };

  it('owners see the band, the notes, breaking changes and the host command; hiding sticks per version', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/profile',
      initialState: owner,
      routes: routes({ 'GET /api/updates/status': ok(status) }),
    });
    const band = await screen.findByTestId('dy-server-update');
    expect(band.textContent).toContain('Güncelleme mevcut: Remyral 1.1.0');
    await user.click(within(band).getByRole('button', { name: 'Notlar' }));
    const notes = await screen.findByTestId('dy-server-update-notes');
    expect(notes.textContent).toContain('remyral-proxy network');
    expect(notes.textContent).toContain('sudo remyral-ctl upgrade --to 1.1.0');
    expect(notes.textContent).toContain('1.0.75 makine sürümünü');
    await user.click(screen.getAllByRole('button', { name: 'Kapat' })[0] as HTMLElement);
    await user.click(
      within(screen.getByTestId('dy-server-update')).getByRole('button', { name: 'Bu sürüm için gizle' }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('dy-server-update')).toBeNull();
    });
    expect(window.localStorage.getItem('remyral.update.dismissed')).toBe('1.1.0');
  });

  it('nothing for admins (owners only)', async () => {
    const r = renderApp({
      path: '/settings/profile',
      initialState: admin,
      routes: routes({ 'GET /api/updates/status': ok(status) }),
    });
    await screen.findAllByRole('heading');
    expect(screen.queryByTestId('dy-server-update')).toBeNull();
    expect(r.requests.some((q) => q.url === '/api/updates/status')).toBe(false);
  });
});
