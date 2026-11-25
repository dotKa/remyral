// p19-chat-machine-admin (the assistant does what the person asks on a machine): the security policy's switch in
// Ayarlar → Güvenlik → Ajan otonomisi (saved like its neighbours, only its own key) and the assistant's sandbox prepare
// card (an administration card, op machine.prepare) in both languages.
import { createFormatter, messagesFor } from '@remyral/i18n';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { draftEvent } from '../src/diyalog/drafts/event';
import { summarizeDraft } from '../src/diyalog/drafts/summary';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });

function withDefaults(over: Record<string, Handler>): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
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

function policy(version: number, autonomy: Record<string, unknown> = {}) {
  return {
    version,
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
        autoMode: false,
        autoRetryMax: 3,
        chatDestructive: false,
        chatMachineAdmin: true,
        ...autonomy,
      },
    },
    updatedAt: null,
    updatedBy: null,
    catalog: { events: [], autonomyActions: [] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(
  'Settings → Security: machine commands from the chat (p19-chat-machine-admin)',
  { timeout: 20_000 },
  () => {
    it('shows the switch on (Serbest) and saves only its own key when switched off', async () => {
      const user = userEvent.setup();
      const puts: Record<string, unknown>[] = [];
      let current = policy(3);
      renderApp({
        path: '/settings/security?tab=autonomy',
        initialState: owner,
        routes: withDefaults({
          'GET /api/security/policy': () => ok(current),
          'PUT /api/security/policy': (req) => {
            const body = req.body as Record<string, unknown>;
            puts.push(body);
            current = policy(current.version + 1, (body.autonomy ?? {}) as Record<string, unknown>);
            return ok({ ...current, changed: ['autonomy.chatMachineAdmin'] });
          },
        }),
      });
      const sw = await screen.findByRole('switch', { name: 'Makinede söylediğimi yap' });
      expect(sw.getAttribute('data-testid')).toBe('autonomy-chat-machine-admin');
      expect(sw.getAttribute('aria-checked')).toBe('true');
      await user.click(sw);
      await user.click(screen.getByTestId('dy-form-save'));
      await waitFor(() => {
        expect(puts).toHaveLength(1);
      });
      expect(puts[0]).toEqual({ autonomy: { chatMachineAdmin: false }, expectedVersion: 3 });
      await waitFor(() => {
        expect(
          screen.getByRole('switch', { name: 'Makinede söylediğimi yap' }).getAttribute('aria-checked'),
        ).toBe('false');
      });
    });

    it('an older master without the switch shows it off', async () => {
      const old = policy(1);
      const { chatMachineAdmin: _drop, ...autonomy } = old.effective.autonomy;
      renderApp({
        path: '/settings/security?tab=autonomy',
        initialState: owner,
        routes: withDefaults({
          'GET /api/security/policy': () => ok({ ...old, effective: { ...old.effective, autonomy } }),
        }),
      });
      const sw = await screen.findByRole('switch', { name: 'Makinede söylediğimi yap' });
      expect(sw.getAttribute('aria-checked')).toBe('false');
    });
  },
);

describe('the sandbox prepare card (administration card, op machine.prepare)', () => {
  const payload = {
    target: 'admin',
    op: 'machine.prepare',
    event: 'machines.sandbox',
    workerId: 'w-1',
    name: 'mac-1',
    privileged: true,
  };

  it('names the change, the machine and the privileged helper; takes the master’s event', () => {
    const tr = summarizeDraft({ kind: 'settings_change', payload }, messagesFor('tr'), createFormatter('tr'));
    expect(tr.key).toEqual(
      expect.arrayContaining([
        { k: 'İşlem', v: 'Makinenin sandbox’ını hazırla' },
        { k: 'Makine', v: 'mac-1', mono: true },
      ]),
    );
    expect(JSON.stringify(tr)).toContain('Yetkili yardımcıyı da çalıştır');
    const en = summarizeDraft(
      { kind: 'settings_change', payload: { ...payload, privileged: false } },
      messagesFor('en'),
      createFormatter('en'),
    );
    expect(en.key).toEqual(expect.arrayContaining([{ k: 'Action', v: 'Prepare the machine’s sandbox' }]));
    expect(JSON.stringify(en)).toContain('Also run the privileged helper');
    expect(draftEvent('settings_change', payload)).toBe('machines.sandbox');
  });
});
