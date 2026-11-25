import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionBody } from './helpers';

/** p5-remember-device: "Remember me", "Trust this device", trusted-devices card, session type. */

describe('Settings → session type and trusted devices', () => {
  it('Devices says when no browser is trusted', async () => {
    renderApp({
      path: '/settings/devices',
      routes: {
        'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
        'GET /api/auth/devices': () => ({ status: 200, body: { devices: [] } }),
      },
    });
    expect(await screen.findByTestId('no-trusted-devices')).toBeTruthy();
  });
});
