// Sidebar / bottom-bar badges: pending approvals and machines waiting to be paired.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionBody } from './helpers';

const signedIn = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
} as const;

describe('navigation badges', () => {
  it('shows nothing when nothing waits or the counts cannot be read', async () => {
    renderApp({
      path: '/settings',
      initialState: signedIn,
      routes: {
        'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
        'GET /api/approvals?status=pending': () => ({
          status: 403,
          body: { error: 'forbidden', message: 'no' },
        }),
        'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByTestId('nav-badge')).toHaveLength(0);
  });
});
