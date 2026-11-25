// p12-diyalog wave 2 (W3): Ayarlar → Profil leftovers (password, Coolify, personal rules), Cihazlar, Sohbet and
// Bildirimler in the Diyalog language (flag on) — same requests, step-up and role rules as the classic pages; the
// phone settings navigation is a disclosure naming the current section.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  ACC_CHAT_SETTINGS,
  ACC_CHAT_STATUS,
  ACC_KNOWLEDGE_PREFS,
  ACC_PREFS,
  ACC_PUSH,
  ACC_TRUSTED,
} from '../src/diyalog/harness/screens/w3-settings-account';
import { W3_RECORDS } from '../src/diyalog/harness/screens/w3-project-rest';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast, toastByTestId } from './toasts';

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

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/auth/devices': ok(ACC_TRUSTED),
    'GET /api/notifications/push': ok(ACC_PUSH),
    'GET /api/notifications/preferences': ok(ACC_PREFS),
    'GET /api/chat/knowledge/preferences': ok(ACC_KNOWLEDGE_PREFS),
    'GET /api/chat/settings': ok(ACC_CHAT_SETTINGS),
    'GET /api/chat/status': ok(ACC_CHAT_STATUS),
    'GET /api/models': ok({ items: [], defaults: [] }),
    'GET /api/coolify-sso/config': ok({ enabled: true, url: 'https://coolify.example' }),
    'GET /api/memory-records/personal': ok({ items: [] }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

const viewerSession = ok({
  ...(sessionBody() as Record<string, unknown>),
  user: { ...USER, role: 'viewer' },
});

function stepUpRoutes(): { routes: Record<string, Handler>; stepped: () => boolean } {
  let stepped = false;
  return {
    routes: {
      'POST /api/auth/step-up': () => {
        stepped = true;
        return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
      },
    },
    stepped: () => stepped,
  };
}

async function confirmCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
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

describe('Diyalog Ayarlar — hesap sayfaları (W3)', () => {
  it('Profil: password, Coolify and personal rules are native; no classic cards remain', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings/profile', initialState: owner, routes: routes() });
    // p15-form-pattern: Görünüm ve dil · Oturum · Parola · Kişisel kurallar are tabs.
    await user.click(await screen.findByRole('tab', { name: 'Parola' }));
    expect(await screen.findByTestId('dy-password')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Oturum' }));
    const coolify = await screen.findByTestId('open-coolify');
    expect(coolify.getAttribute('rel')).toBe('noopener noreferrer');
    expect(coolify.getAttribute('href')).toBe('https://coolify.example/');
    await user.click(screen.getByRole('tab', { name: 'Kişisel kurallar' }));
    expect(await screen.findByTestId('personal-empty')).toBeTruthy();
    expect(screen.queryByText('Change password')).toBeNull();
    expect(screen.queryByText('Personal rules')).toBeNull();
  });

  // p15-classic-removal: the classic memory-layers.test's personal rules, on Profil → Kişisel kurallar.
  it('Profil: a personal rule is retired (POST /memory-records/personal/:id/status)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const rule = { ...(W3_RECORDS[0] as Record<string, unknown>), scope: 'personal', canWrite: true };
    const { requests } = renderApp({
      path: '/settings/profile?tab=rules',
      initialState: owner,
      routes: routes({
        'GET /api/memory-records/personal': ok({ items: [rule] }),
        'POST /api/memory-records/personal/r1/status': ok({ ...rule, status: 'expired' }),
      }),
    });
    const list = await screen.findByTestId('personal-rules');
    await user.click(within(list).getByRole('button', { name: 'Emekliye ayır' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/memory-records/personal/r1/status')?.body).toEqual({
        status: 'expired',
      });
    }); // p17-toasts-rest: the result is a toast.
    await waitFor(() => {
      expect(toastByTestId('personal-notice')).toBeDefined();
    });
    // The test id now names the toast (inside the toaster), not a line in the panel.
    expect(screen.getByTestId('personal-notice').closest('[data-toast]')).not.toBeNull();
  });

  it('Profil: a changed password says so in a toast; the form is emptied (p17-toasts-rest)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const step = stepUpRoutes();
    const r = renderApp({
      path: '/settings/profile?tab=password',
      initialState: owner,
      routes: routes({
        ...step.routes,
        'POST /api/auth/password': () => ({ status: 200, body: { status: 'changed' } }),
      }),
    });
    const panel = await screen.findByTestId('dy-password');
    await user.type(within(panel).getByLabelText('Şu anki parola'), 'old-password-123');
    await user.type(within(panel).getByLabelText('Yeni parola'), 'quartz-meadow-lantern-9');
    await user.type(within(panel).getByLabelText('Yeni parola (tekrar)'), 'quartz-meadow-lantern-9');
    await user.click(within(panel).getByRole('button', { name: 'Parolayı değiştir' }));
    expect(await findToast('Parola değişti. Diğer bütün oturumlar kapatıldı.')).toBeTruthy();
    expect(r.requests.filter((q) => q.url === '/api/auth/password')).toHaveLength(1);
    expect(within(panel).queryByText('Parola değişti. Diğer bütün oturumlar kapatıldı.')).toBeNull();
    expect(within(panel).getByLabelText<HTMLInputElement>('Yeni parola').value).toBe('');
  });

  it('Profil: password checks run before any request; a viewer sees no Coolify panel', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/profile?tab=password',
      initialState: viewer,
      routes: routes({ 'GET /api/auth/session': viewerSession }),
    });
    await screen.findByTestId('dy-password');
    await user.click(screen.getByRole('tab', { name: 'Oturum' }));
    await screen.findByTestId('dy-session');
    expect(screen.queryByTestId('dy-coolify')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Parola' }));
    const panel = await screen.findByTestId('dy-password');
    await user.type(within(panel).getByLabelText('Yeni parola'), 'short');
    await user.type(within(panel).getByLabelText('Yeni parola (tekrar)'), 'shorter');
    await user.click(within(panel).getByRole('button', { name: 'Parolayı değiştir' }));
    expect(within(panel).getByText('Şu anki parolanı gir.')).toBeTruthy();
    expect(within(panel).getByText('En az 12 karakter kullan.')).toBeTruthy();
    expect(within(panel).getByText('Parolalar aynı değil.')).toBeTruthy();
    expect(r.requests.some((q) => q.url === '/api/auth/password')).toBe(false);
  });

  it('Cihazlar: push devices and trusted browsers; revoke all is confirmed first', async () => {
    const user = userEvent.setup();
    let revokedAll = 0;
    renderApp({
      path: '/settings/devices',
      initialState: owner,
      routes: routes({
        'POST /api/auth/devices/revoke-all': () => {
          revokedAll += 1;
          return { status: 200, body: { status: 'revoked', revoked: 2 } };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Cihazlar' })).toBeTruthy();
    expect(await screen.findByTestId('dy-this-device')).toBeTruthy();
    const push = await screen.findByTestId('dy-push-devices');
    expect(within(push).getAllByTestId('dy-push-device')).toHaveLength(2);
    expect(push.textContent).toContain('henüz teslim edilmedi');
    const trusted = screen.getByTestId('dy-trusted-devices');
    const rows = await within(trusted).findAllByTestId('dy-trusted-device');
    expect(rows[0]?.textContent).toContain('bu tarayıcı');
    expect(rows[0]?.textContent).toContain('198.51.100.7 adresinden eklendi');
    await user.click(within(trusted).getByTestId('revoke-all-trusted'));
    expect(revokedAll).toBe(0);
    await user.click(within(trusted).getByTestId('revoke-all-trusted-confirm'));
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast('2 cihaza artık güvenilmiyor.')).toBeTruthy();
    expect(revokedAll).toBe(1);
    expect(screen.queryByRole('table', { name: 'Trusted devices' })).toBeNull();
  });

  it('Sohbet: a viewer gets only "Sohbetlerim"; a switch saves with the version check', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    renderApp({
      path: '/settings/chat',
      initialState: viewer,
      routes: routes({
        'GET /api/auth/session': viewerSession,
        'PUT /api/chat/knowledge/preferences': (req) => {
          body = req.body;
          return { status: 200, body: { ...ACC_KNOWLEDGE_PREFS, shareProjects: true, version: 4 } };
        },
      }),
    });
    const sw = await screen.findByTestId('chat-share');
    expect(screen.queryByTestId('dy-chat-assistant')).toBeNull();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await user.click(sw);
    await waitFor(() => {
      expect(body).toEqual({
        indexConversations: true,
        shareProjects: true,
        autoRelated: true,
        expectedVersion: 3,
      });
    });
    expect(await screen.findByText('Paylaşım açık.')).toBeTruthy();
  });

  it('Sohbet (admin): engine readiness per runtime, limits checked locally, save through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const s = stepUpRoutes();
    let put: unknown = null;
    renderApp({
      path: '/settings/chat',
      initialState: owner,
      routes: routes({
        ...s.routes,
        'PUT /api/chat/settings': (req) => {
          if (!s.stepped()) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          put = req.body;
          return { status: 200, body: { ...ACC_CHAT_SETTINGS, version: 5 } };
        },
      }),
    });
    expect(await screen.findByTestId('chat-settings-status')).toBeTruthy();
    // p15-form-pattern: Sohbetlerim · Asistan · Sınırlar are tabs; each tab is one form with the sticky save bar.
    expect(await screen.findByTestId('dy-my-conversations')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Asistan' }));
    expect((await screen.findByTestId('chat-runtime-claude-code')).textContent).toBe('Hazır');
    expect(screen.getByTestId('chat-runtime-pi').textContent).toContain('Hazır değil: not_authenticated');
    await user.click(screen.getByRole('tab', { name: 'Sınırlar' }));
    const limits = await screen.findByTestId('dy-chat-limits');
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    const turns = within(limits).getByLabelText('Kullanıcı başına 10 dakikada tur');
    await user.clear(turns);
    await user.type(turns, '0');
    await user.click(screen.getByTestId('dy-form-save'));
    expect(
      await screen.findByText('10 dakikadaki tur sayısı 1 ya da daha büyük bir tam sayı olmalı.'),
    ).toBeTruthy();
    expect(turns.getAttribute('aria-invalid')).toBe('true');
    expect(put).toBeNull();
    await user.clear(turns);
    await user.type(turns, '30');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmCode(user);
    await waitFor(() => {
      expect(put).toMatchObject({
        enabled: true,
        workerId: 'w1',
        runtime: 'claude-code',
        fallbackRuntime: 'codex',
        expectedVersion: 4,
        limits: { turnsPerUserPer10Min: 30, maxToolCallsPerTurn: 12, monthlyCostUsd: 50 },
      });
    });
    expect((await screen.findByTestId('dy-form-saved')).textContent).toContain('Kaydedildi');
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
  });

  it('Bildirimler: per-kind matrix; a target change goes through step-up and only changed targets are sent', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const s = stepUpRoutes();
    const puts: Record<string, unknown>[] = [];
    renderApp({
      path: '/settings/notifications',
      initialState: owner,
      routes: routes({
        ...s.routes,
        'PUT /api/notifications/preferences': (req) => {
          if (!s.stepped()) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          puts.push(req.body as Record<string, unknown>);
          return { status: 200, body: ACC_PREFS };
        },
      }),
    });
    // p15-form-pattern: Ses · Kanallar · Bildirim türleri are tabs; each saves only its own part.
    expect(await screen.findByTestId('dy-sound')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Bildirim türleri' }));
    const matrix = await screen.findByTestId('dy-notify-matrix');
    const deployPush = within(matrix).getByRole('checkbox', { name: 'Deploy waiting: push' });
    expect((deployPush as HTMLInputElement).checked).toBe(false);
    await user.click(deployPush);
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmCode(user);
    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]?.kinds).toContainEqual({
      kind: 'deploy.waiting',
      email: false,
      webhook: false,
      push: true,
    });
    expect(puts[0]?.email).toBeUndefined();
    expect(await screen.findByTestId('dy-form-saved')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Kanallar' }));
    const email = await screen.findByLabelText('E-posta adresi');
    await user.clear(email);
    await user.type(email, 'ops@example.com');
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(puts).toHaveLength(2);
    });
    const sent = puts[1];
    expect(sent?.email).toBe('ops@example.com');
    expect(sent?.webhookUrl).toBeUndefined();
    expect(sent?.kinds).toBeUndefined();
    expect(screen.getByTestId('push-target').textContent).toContain('2 cihaza');
  });

  it('phone navigation is a disclosure naming the current section', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings/notifications', initialState: owner, routes: routes() });
    const disclosure = await screen.findByTestId('dy-settings-disclosure');
    expect(disclosure.textContent).toContain('Bildirimler');
    expect(within(disclosure).queryByRole('link')).toBeNull();
    await user.click(within(disclosure).getByText('Ayarlar'));
    const nav = await screen.findByRole('navigation', { name: 'Ayarlar bölümleri' });
    expect(within(nav).getByRole('link', { name: 'Bildirimler' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Kullanıcılar' })).toBeTruthy();
  });
});
