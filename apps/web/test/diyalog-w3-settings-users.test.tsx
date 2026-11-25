// p12-diyalog wave 2 (W3): Ayarlar → Kullanıcılar in the Diyalog language — owner-only writes through step-up, the
// one-time password, admins read only, 403 for others; flag off keeps the classic page.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

function account(id: string, username: string, role: string, over: Record<string, unknown> = {}): unknown {
  return {
    id,
    username,
    role,
    totpEnrolled: true,
    disabled: false,
    disabledAt: null,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    memberships: [],
    ...over,
  };
}

const OPER = '00000000-0000-4000-8000-0000000000a1';
const USERS = {
  items: [
    account(USER.id, 'alex', 'owner'),
    account(OPER, 'oper1', 'operator', { memberships: [{ project: 'alpha', role: 'operator' }] }),
    account('00000000-0000-4000-8000-0000000000a2', 'eski', 'viewer', { disabled: true }),
  ],
};

function routes(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok({ ...(sessionBody() as object), user: { ...USER, role } }),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/users': ok(USERS),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

const as = (role: string): AuthState => ({
  kind: 'signedIn',
  user: { ...USER, role },
  session: null,
  remainingRecoveryCodes: null,
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Kullanıcılar', () => {
  it('the owner creates a user through step-up and sees the temporary password once', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/settings/users',
      initialState: as('owner'),
      routes: routes('owner', {
        'POST /api/users': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          body = req.body;
          return {
            status: 201,
            body: {
              ...(account('00000000-0000-4000-8000-0000000000a3', 'yeni.kisi', 'viewer') as object),
              temporaryPassword: 'Tmp-9f3a-77',
            },
          };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const rows = await screen.findAllByTestId('user-row');
    expect(rows[1]?.textContent).toContain('devre dışı');
    await user.click(screen.getByRole('button', { name: 'Kullanıcı ekle' }));
    const form = await screen.findByRole('form', { name: 'Kullanıcı oluştur' });
    await user.type(within(form).getByLabelText('Kullanıcı adı'), '1x');
    await user.click(within(form).getByRole('button', { name: 'Kullanıcı oluştur' }));
    expect(within(form).getByText(/3–32 karakter/)).toBeTruthy();
    await user.clear(within(form).getByLabelText('Kullanıcı adı'));
    await user.type(within(form).getByLabelText('Kullanıcı adı'), 'Yeni.Kisi');
    await user.click(within(form).getByRole('button', { name: 'Kullanıcı oluştur' }));
    const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
    expect((await screen.findByTestId('temporary-password')).textContent).toBe('Tmp-9f3a-77');
    await waitFor(() => {
      expect(body).toEqual({ username: 'yeni.kisi', role: 'viewer' });
    });
  });

  // p15-classic-removal: the classic directory.test's role change and disable, on the Diyalog page.
  it('the owner changes a role and disables an account (PUT /users/:id/role, POST /users/:id/disable)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const role: unknown[] = [];
    const disable: unknown[] = [];
    renderApp({
      path: '/settings/users',
      initialState: as('owner'),
      routes: routes('owner', {
        [`PUT /api/users/${OPER}/role`]: (req) => {
          role.push(req.body);
          return { status: 200, body: account(OPER, 'oper1', 'admin') };
        },
        [`POST /api/users/${OPER}/disable`]: (req) => {
          disable.push(req.body);
          return { status: 200, body: account(OPER, 'oper1', 'admin', { disabled: true }) };
        },
      }),
    });
    await screen.findAllByTestId('user-row');
    await user.click(screen.getByRole('button', { name: 'oper1 yönet' }));
    const group = await screen.findByRole('group', { name: /oper1/ });
    await user.selectOptions(within(group).getByLabelText('oper1 için rol'), 'admin');
    await user.click(within(group).getByRole('button', { name: 'Rolü değiştir' }));
    await waitFor(() => {
      expect(role).toEqual([{ role: 'admin' }]);
    });
    await user.click(await screen.findByTestId('user-disable'));
    await user.click(await screen.findByTestId('user-disable-confirm'));
    await waitFor(() => {
      expect(disable).toHaveLength(1);
    });
  });

  it('admins read the list without write controls; operators / viewers only get the account recovery', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings/users', initialState: as('admin'), routes: routes('admin') });
    await screen.findAllByTestId('user-row');
    expect(screen.queryByRole('button', { name: 'Kullanıcı ekle' })).toBeNull();
    // p17-panel-settings Part 4: no dialog for the owner; the operator's dialog has the recovery section only.
    expect(screen.queryByRole('button', { name: 'alex yönet' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'oper1 yönet' }));
    expect(await screen.findByTestId('user-recovery')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rolü değiştir' })).toBeNull();
  });

  it('a 403 says who can see accounts', async () => {
    renderApp({
      path: '/settings/users',
      initialState: as('operator'),
      routes: routes('operator', {
        'GET /api/users': () => ({ status: 403, body: { error: 'forbidden', message: 'No.' } }),
      }),
    });
    expect(
      await screen.findByText('Kullanıcı hesaplarını yalnızca sahipler ve yöneticiler görebilir.'),
    ).toBeTruthy();
  });
});
