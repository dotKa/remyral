import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, USER } from './helpers';

const signedIn = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Fleet screen', () => {
  it('shows an empty state with pairing instructions', async () => {
    renderApp({
      path: '/fleet',
      initialState: signedIn,
      routes: { 'GET /api/workers': () => ({ status: 200, body: { workers: [] } }) },
    });
    expect((await screen.findByTestId('fleet-empty')).textContent).toContain('remyral-worker pair --master');
  });
});
