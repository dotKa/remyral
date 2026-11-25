import { createFormatter, messagesFor } from '@remyral/i18n';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftEvent } from '../src/diyalog/drafts/event';
import { TemporaryPassword } from '../src/diyalog/drafts/parts';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { renderApp, sessionBody, USER } from './helpers';

/**
 * p16-assistant-admin: the assistant's administration cards (settings cards with target "admin") — their name,
 * facts and warnings in both languages, the event that decides about the code, the invite's temporary password shown
 * once, and the security policy's switch for destructive administration from the chat.
 */
let EN = messagesFor('tr');
const TR = messagesFor('tr');
beforeAll(() => {
  EN = messagesFor('en');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('administration cards (p16-assistant-admin)', () => {
  it('name the card "Yönetim" and keep other settings cards as they were', () => {
    expect(draftKindText('settings_change', TR, { target: 'admin', op: 'user.disable' })).toBe('Yönetim');
    expect(draftKindText('settings_change', EN, { target: 'admin' })).toBe('Administration');
    expect(draftKindText('settings_change', TR, { target: 'security_policy' })).toBe('Ayar değişikliği');
  });

  it('summarise a destructive change with its warning and never show a pairing code', () => {
    const disable = summarizeDraft(
      {
        kind: 'settings_change',
        payload: {
          target: 'admin',
          op: 'user.disable',
          username: 'ali',
          cardOnly: 'destructive',
          reason: 'left',
        },
      },
      TR,
      createFormatter('tr'),
    );
    expect(disable.key).toEqual(
      expect.arrayContaining([
        { k: 'İşlem', v: 'Hesabı devre dışı bırak' },
        { k: 'Kullanıcı', v: 'ali', mono: true },
      ]),
    );
    expect(disable.warnings[0]).toMatchObject({ testId: 'admin-card-destructive', danger: true });
    const approve = summarizeDraft(
      {
        kind: 'settings_change',
        payload: { target: 'admin', op: 'machine.approve', name: 'atlas', pairingCode: 'ABCD-EFGH' },
      },
      EN,
      createFormatter('en'),
    );
    expect(JSON.stringify(approve)).not.toContain('ABCD-EFGH');
    expect(approve.key[0]).toEqual({ k: 'Action', v: 'Approve the machine pairing' });
    const rollout = summarizeDraft(
      {
        kind: 'settings_change',
        payload: {
          target: 'admin',
          op: 'release.set_rollout',
          channel: 'stable',
          version: '1.2.3',
          percent: 25,
        },
      },
      EN,
      createFormatter('en'),
    );
    expect(rollout.key).toEqual(expect.arrayContaining([{ k: 'Rollout', v: '1.2.3 · 25% of the machines' }]));
    const hook = summarizeDraft(
      {
        kind: 'settings_change',
        payload: {
          target: 'admin',
          op: 'notifications.update',
          update: { webhookUrl: 'https://h.example/x/secret' },
        },
      },
      EN,
      createFormatter('en'),
    );
    expect(JSON.stringify(hook)).not.toContain('secret');
  });

  it('take the event the master put on the card', () => {
    expect(draftEvent('settings_change', { target: 'admin', event: 'machines.fleet' })).toBe(
      'machines.fleet',
    );
    expect(draftEvent('settings_change', { target: 'admin' })).toBe('security.policy');
  });

  it('show an invite’s temporary password once with a copy button', () => {
    render(
      <I18nProvider>
        <TemporaryPassword username="newbie" value="Tmp-PassWord-123456789012" />
      </I18nProvider>,
    );
    expect(screen.getByTestId('admin-temporary-password-value').textContent).toBe(
      'Tmp-PassWord-123456789012',
    );
    expect(screen.getByTestId('admin-temporary-password').textContent).toContain('newbie');
  });
});

describe('Settings → Security: destructive administration from the chat (p16-assistant-admin)', () => {
  it('shows the switch, off by default', async () => {
    renderApp({
      path: '/settings/security?tab=autonomy',
      initialState: { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null },
      routes: {
        'GET /api/security/policy': () => ({
          status: 200,
          body: {
            version: 1,
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
                chatDestructive: false,
              },
            },
            updatedAt: null,
            updatedBy: null,
            catalog: { events: [], autonomyActions: [] },
          },
        }),
        'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
      },
    });
    const sw = await screen.findByRole('switch', {
      name: 'Sohbet yıkıcı yönetim işlemlerini kartsız yapabilir',
    });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('data-testid')).toBe('autonomy-chat-destructive');
  });
});
