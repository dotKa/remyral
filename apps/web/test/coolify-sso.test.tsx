import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { browser } from '../src/screens/ssoBrowser';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

const LAUNCH = 'https://coolify.example.org/auth/oidc/redirect';
const R = 'A1b2C3d4E5f6G7h8I9j0_-xyzXYZ0123456789abcdef';

function signedIn(
  role: string,
  stepUpValidUntil: string | null = null,
  stepUpScope: 'window' | 'session' = 'window',
): AuthState {
  return {
    kind: 'signedIn',
    user: { ...USER, role },
    session: {
      user: { ...USER, role },
      createdAt: '2026-10-14T10:00:00.000Z',
      expiresAt: '2026-10-14T22:00:00.000Z',
      idleExpiresAt: '2026-10-14T10:30:00.000Z',
      mfaAt: '2026-10-14T10:00:00.000Z',
      stepUpValidUntil,
      stepUpScope,
      alwaysFreshValidUntil: null,
      type: stepUpScope === 'session' ? 'remembered' : 'standard',
    },
    remainingRecoveryCodes: null,
  };
}

function routes(enabled = true, role = 'owner'): Record<string, Handler> {
  return {
    'GET /api/coolify-sso/config': () => ({
      status: 200,
      body: enabled ? { enabled: true, url: LAUNCH } : { enabled: false, url: null },
    }),
    'GET /api/auth/session': () => {
      const body = sessionBody() as { user: Record<string, string> };
      return { status: 200, body: { ...body, user: { ...body.user, role } } };
    },
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { unread: 0 } }),
  };
}

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
  stubCookies('__Host-ras-csrf=csrf-token');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/sso/continue', () => {
  it('OIDC with a fresh step-up continues to the fixed resume path at once', async () => {
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    renderApp({
      path: `/sso/continue?flow=oidc&r=${R}`,
      initialState: signedIn('admin', until),
      routes: routes(),
    });
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/api/oidc/authorize/resume?r=${R}`);
    });
  });

  it('OIDC on a remember-me / trusted-device session verified for the session does not ask again', async () => {
    // p5-stepup-window: the step-up holds until the session ends (hours away), not for 10 minutes.
    const sessionEnd = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    renderApp({
      path: `/sso/continue?flow=oidc&r=${R}`,
      initialState: signedIn('owner', sessionEnd, 'session'),
      routes: routes(),
    });
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/api/oidc/authorize/resume?r=${R}`);
    });
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
  });
});
