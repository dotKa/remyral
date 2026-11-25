import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, sessionBody, USER } from './helpers';

/**
 * p15-chat-execute-default: Ayarlar → Güvenlik explains the new default — the user's own chat commands run without a
 * card — and keeps the switch to turn it off.
 */
const ADMIN = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null } as const;

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Security: chat commands without a card (p15-chat-execute-default)', () => {
  it('names the default and explains what still waits as a card; the switch stays', async () => {
    renderApp({
      // p15-form-pattern: Ajan otonomisi is its own tab of Güvenlik.
      path: '/settings/security?tab=autonomy',
      initialState: ADMIN,
      routes: {
        'GET /api/security/policy': () => ({ status: 200, body: POLICY }),
        'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
      },
    });
    const sw = await screen.findByRole('switch', { name: 'Sohbetteki açık komutlar kartsız uygulanır' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('data-testid')).toBe('autonomy-chat');
    const hint = document.getElementById(sw.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(hint).toContain('“PR’ları onayla”');
    expect(hint).toContain('asistanın kendi önerileri');
    expect(hint).toContain('Kapatırsan her işlem kartla onaylanır');
  });
});
