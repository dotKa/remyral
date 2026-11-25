// p12-diyalog-final: every destructive action in the Diyalog UI takes two steps (`DyConfirm`). p18-confirm-dialog: the
// second step is a confirm dialog, never inline. A sample across screens: the first press sends nothing, the dialog's
// confirm sends the request, Vazgeç and Escape step back without a request.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
import {
  CTX_DEFAULTS,
  CTX_DOCS,
  CTX_RECEIPTS,
  CTX_SEARCH,
  ctxPolicy,
} from '../src/diyalog/harness/screens/w3-context';
import { W3_SKILLS } from '../src/diyalog/harness/screens/w3-knowledge';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const as = (role: string): AuthState => ({
  kind: 'signedIn',
  user: { ...USER, role },
  session: null,
  remainingRecoveryCodes: null,
});
const owner = as('owner');

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

function routes(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok({ ...(sessionBody() as Record<string, unknown>), user: { ...USER, role } }),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      const h = t[k];
      if (h !== undefined) return h;
      if (k.startsWith('GET /api/memory-records?')) return ok({ items: [] });
      return (() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler;
    },
  });
}

const ACCOUNT: Record<string, Handler> = {
  'GET /api/auth/devices': ok(ACC_TRUSTED),
  'GET /api/notifications/push': ok(ACC_PUSH),
  'GET /api/notifications/preferences': ok(ACC_PREFS),
  'GET /api/chat/knowledge/preferences': ok(ACC_KNOWLEDGE_PREFS),
  'GET /api/chat/settings': ok(ACC_CHAT_SETTINGS),
  'GET /api/chat/status': ok(ACC_CHAT_STATUS),
  'GET /api/models': ok({ items: [], defaults: [] }),
  'GET /api/coolify-sso/config': ok({ enabled: true, url: 'https://coolify.example' }),
  'GET /api/memory-records/personal': ok({ items: [] }),
};

const sent = (requests: readonly RecordedRequest[], method: string, url: string): number =>
  requests.filter((r) => r.method === method && r.url === url).length;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog: destructive actions take two steps', () => {
  it('Cihazlar: removing a trusted browser asks first; Vazgeç and Escape send nothing', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const id = ACC_TRUSTED.devices[1]?.id ?? '';
    const url = `/api/auth/devices/${id}`;
    const { requests } = renderApp({
      path: '/settings/devices',
      initialState: owner,
      routes: routes('owner', { ...ACCOUNT, [`DELETE ${url}`]: ok({ status: 'revoked' }) }),
    });
    const trigger = await screen.findByTestId(`trusted-revoke-${id}`);
    await user.click(trigger);
    expect(sent(requests, 'DELETE', url)).toBe(0);
    const dialog = await screen.findByRole('dialog', {
      name: /Safari · iPhone cihazına güven kaldırılsın mı/,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => {
      expect(screen.queryByTestId(`trusted-revoke-${id}-confirm`)).toBeNull();
    });
    // Escape (the native dialog's `cancel`) steps back too, and focus returns to the button.
    await user.click(screen.getByTestId(`trusted-revoke-${id}`));
    const again = await screen.findByRole('dialog', {
      name: /Safari · iPhone cihazına güven kaldırılsın mı/,
    });
    expect(document.activeElement).toBe(within(again).getByRole('button', { name: 'Vazgeç' }));
    fireEvent(again, new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByTestId(`trusted-revoke-${id}-confirm`)).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId(`trusted-revoke-${id}`));
    });
    expect(sent(requests, 'DELETE', url)).toBe(0);
    await user.click(screen.getByTestId(`trusted-revoke-${id}`));
    await user.click(screen.getByTestId(`trusted-revoke-${id}-confirm`));
    await waitFor(() => {
      expect(sent(requests, 'DELETE', url)).toBe(1);
    });
  });

  it('Profil: log out everywhere asks first', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      // p15-form-pattern: the session is the "Oturum" tab of Profil.
      path: '/settings/profile?tab=session',
      initialState: owner,
      routes: routes('owner', {
        ...ACCOUNT,
        'POST /api/auth/logout-all': ok({ status: 'logged_out', revokedSessions: 3 }),
      }),
    });
    const session = await screen.findByTestId('dy-session');
    await user.click(within(session).getByTestId('logout-all'));
    expect(sent(requests, 'POST', '/api/auth/logout-all')).toBe(0);
    await user.click(within(session).getByRole('button', { name: 'Vazgeç' }));
    expect(sent(requests, 'POST', '/api/auth/logout-all')).toBe(0);
    await user.click(within(session).getByTestId('logout-all'));
    await user.click(within(session).getByRole('button', { name: 'Evet, her yerden çık' }));
    await waitFor(() => {
      expect(sent(requests, 'POST', '/api/auth/logout-all')).toBe(1);
    });
  });

  it('Hesap menüsü: log out everywhere asks first; Escape steps back inside the open menu', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/profile',
      initialState: owner,
      routes: routes('owner', {
        ...ACCOUNT,
        'POST /api/auth/logout-all': ok({ status: 'logged_out', revokedSessions: 3 }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: /Hesap menüsü/ }));
    const panel = screen.getByRole('region', { name: 'Hesap' });
    await user.click(within(panel).getByTestId('topbar-logout-all'));
    expect(sent(requests, 'POST', '/api/auth/logout-all')).toBe(0);
    // p18-confirm-dialog: the question is a dialog; Escape (the native `cancel`) closes only the dialog.
    const dialog = await within(panel).findByTestId('topbar-logout-all-dialog');
    await user.keyboard('{Escape}');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    // The menu stays open; only the question closed.
    expect(screen.getByRole('region', { name: 'Hesap' })).toBeTruthy();
    await waitFor(() => {
      expect(within(panel).queryByTestId('topbar-logout-all-confirm')).toBeNull();
    });
    await user.click(within(panel).getByTestId('topbar-logout-all'));
    await user.click(within(panel).getByTestId('topbar-logout-all-confirm'));
    await waitFor(() => {
      expect(sent(requests, 'POST', '/api/auth/logout-all')).toBe(1);
    });
  });

  it('Kullanıcılar: disabling an account asks first; enabling does not', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const OPER = '00000000-0000-4000-8000-0000000000a1';
    const account = (id: string, username: string, role: string, disabled = false): unknown => ({
      id,
      username,
      role,
      totpEnrolled: true,
      disabled,
      disabledAt: null,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      memberships: [],
    });
    const url = `/api/users/${OPER}/disable`;
    const { requests } = renderApp({
      path: '/settings/users',
      initialState: owner,
      routes: routes('owner', {
        'GET /api/users': ok({
          items: [account(USER.id, 'alex', 'owner'), account(OPER, 'oper1', 'operator')],
        }),
        [`POST ${url}`]: ok(account(OPER, 'oper1', 'operator', true)),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'oper1 yönet' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('user-disable'));
    expect(sent(requests, 'POST', url)).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    expect(sent(requests, 'POST', url)).toBe(0);
    await user.click(within(dialog).getByTestId('user-disable'));
    await user.click(within(dialog).getByTestId('user-disable-confirm'));
    await waitFor(() => {
      expect(sent(requests, 'POST', url)).toBe(1);
    });
    // Enabling again is not destructive: one press.
    const enable = await within(dialog).findByRole('button', { name: 'Etkinleştir' });
    expect(within(dialog).queryByTestId('user-disable')).toBeNull();
    expect(enable).toBeTruthy();
  });

  it('Bağlam: running retention (a purge) asks first', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/context',
      initialState: as('admin'),
      routes: routes('admin', {
        'GET /api/projects': empty,
        'GET /api/context/docs?namespace=global': ok({
          items: CTX_DOCS.items.filter((d) => d.document.deletedAt === null),
        }),
        'GET /api/context/docs?namespace=global&includeDeleted=true': ok(CTX_DOCS),
        'GET /api/context/policies?namespace=global': ok({ items: [ctxPolicy('global')] }),
        'GET /api/context/deletion-receipts?namespace=global&limit=50': ok(CTX_RECEIPTS),
        'GET /api/context/search/settings?namespace=global': ok(CTX_SEARCH),
        'GET /api/context/defaults': ok(CTX_DEFAULTS),
        'GET /api/memory-records/conflicts': ok({ items: [] }),
        'POST /api/context/purge': ok({ purged: ['d1'], expired: [], pruned: [], held: 0 }),
      }),
    });
    const trigger = await screen.findByTestId('context-run-retention');
    await user.click(trigger);
    expect(sent(requests, 'POST', '/api/context/purge')).toBe(0);
    expect(screen.getByText('Saklama süresi dolan içerik kalıcı olarak temizlensin mi?')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(sent(requests, 'POST', '/api/context/purge')).toBe(0);
    await user.click(screen.getByTestId('context-run-retention'));
    await user.click(screen.getByTestId('context-run-retention-confirm'));
    await waitFor(() => {
      expect(sent(requests, 'POST', '/api/context/purge')).toBe(1);
    });
  });

  it('Yetenekler: removing a skill assignment asks first', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const assignment = '00000000-0000-4000-8000-00000000a001';
    const url = `/api/skills/assignments/${assignment}`;
    const { requests } = renderApp({
      path: '/skills',
      initialState: owner,
      routes: routes('owner', {
        'GET /api/skills': ok(W3_SKILLS),
        'GET /api/projects': empty,
        [`DELETE ${url}`]: () => ({ status: 204 }),
      }),
    });
    const trigger = await screen.findByTestId(`skill-unassign-${assignment}`);
    await user.click(trigger);
    expect(sent(requests, 'DELETE', url)).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(sent(requests, 'DELETE', url)).toBe(0);
    await user.click(screen.getByTestId(`skill-unassign-${assignment}`));
    await user.click(screen.getByTestId(`skill-unassign-${assignment}-confirm`));
    await waitFor(() => {
      expect(sent(requests, 'DELETE', url)).toBe(1);
    });
  });
});
