// p15-chat-failover: Ayarlar → Sohbet — the ordered backup machines with each machine's readiness in the Asistan form
// (saved through step-up with the version check), the "Yedek geçişi" tab (who answers and why, the chain, controls,
// recent switches) and the Sohbet header / thread notice words.
import { messagesFor } from '@remyral/i18n';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatMessage, parseStatus } from '../src/api/chat';
import type { AuthState } from '../src/auth/AuthProvider';
import { failoverNotice } from '../src/diyalog/chat/rows';
import {
  ACC_CHAT_SETTINGS,
  ACC_CHAT_STATUS,
  ACC_KNOWLEDGE_PREFS,
} from '../src/diyalog/harness/screens/w3-settings-account';
import { headerRouting } from '../src/diyalog/screens/settings/chat-failover';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

function worker(id: string, name: string, state = 'online'): Record<string, unknown> {
  return {
    id,
    name,
    state,
    quarantineReason: null,
    connected: state !== 'offline',
    fingerprint: null,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '1.0.65',
    protocolVersion: '1.0',
    runningJobs: 0,
    lastSeenAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    approvedAt: '2026-10-13T10:00:00.000Z',
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    archivedAt: null,
  };
}

const ENGINES = [
  { runtime: 'claude-code', ready: true, reason: null },
  { runtime: 'codex', ready: true, reason: null },
];

const SETTINGS = {
  ...ACC_CHAT_SETTINGS,
  workerId: 'w1',
  backupWorkerIds: ['w2'],
  engines: [
    {
      workerId: 'w1',
      workerName: 'build-01',
      online: false,
      disabled: false,
      engines: ENGINES,
      reportedAt: null,
      workerVersion: '1.0.65',
      assistantFeature: true,
      connectedAt: null,
    },
    {
      workerId: 'w2',
      workerName: 'mac-studio',
      online: true,
      disabled: false,
      engines: ENGINES,
      reportedAt: null,
      workerVersion: '1.0.65',
      assistantFeature: true,
      connectedAt: '2026-10-23T09:00:00.000Z',
    },
    {
      workerId: 'w3',
      workerName: 'pi-5',
      online: true,
      disabled: false,
      engines: [{ runtime: 'claude-code', ready: false, reason: 'not logged in' }],
      reportedAt: null,
      workerVersion: '1.0.60',
      assistantFeature: true,
      connectedAt: '2026-10-23T09:00:00.000Z',
    },
  ],
};

const ROUTING = {
  machine: 'backup',
  reason: 'primary_offline',
  position: 1,
  pinned: false,
  auto: true,
  primaryIssue: {
    code: 'offline',
    message: 'The assistant worker “build-01” is offline; chat is unavailable.',
  },
  returnsAt: null,
  backups: 1,
  pin: null,
};

const STATUS = {
  ...ACC_CHAT_STATUS,
  worker: { id: 'w2', name: 'mac-studio', online: true },
  primary: { id: 'w1', name: 'build-01', online: false },
  routing: ROUTING,
};

const VIEW = {
  status: STATUS,
  auto: true,
  stableSeconds: 60,
  pin: null,
  active: {
    workerId: 'w2',
    name: 'mac-studio',
    reason: 'primary_offline',
    since: '2026-10-23T09:30:00.000Z',
  },
  chain: [
    {
      workerId: 'w1',
      name: 'build-01',
      role: 'primary',
      position: 0,
      online: false,
      connectedAt: null,
      workerVersion: '1.0.65',
      eligible: false,
      issue: 'offline',
      message: 'The assistant worker “build-01” is offline; chat is unavailable.',
      runtime: null,
      fallback: false,
      account: null,
      answering: false,
    },
    {
      workerId: 'w2',
      name: 'mac-studio',
      role: 'backup',
      position: 1,
      online: true,
      connectedAt: '2026-10-23T09:00:00.000Z',
      workerVersion: '1.0.65',
      eligible: true,
      issue: null,
      message: null,
      runtime: 'claude-code',
      fallback: false,
      account: null,
      answering: true,
    },
  ],
  events: [
    {
      id: '2',
      kind: 'rerun',
      from: { id: 'w1', name: 'build-01' },
      to: { id: 'w2', name: 'mac-studio' },
      reason: 'assistant_disconnected',
      actor: null,
      at: '2026-10-23T09:30:00.000Z',
    },
    {
      id: '1',
      kind: 'failover',
      from: { id: 'w1', name: 'build-01' },
      to: { id: 'w2', name: 'mac-studio' },
      reason: 'primary_offline',
      actor: null,
      at: '2026-10-23T09:30:00.000Z',
    },
  ],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({
      workers: [worker('w1', 'build-01', 'offline'), worker('w2', 'mac-studio'), worker('w3', 'pi-5')],
    }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/chat/knowledge/preferences': ok(ACC_KNOWLEDGE_PREFS),
    'GET /api/chat/settings': ok(SETTINGS),
    'GET /api/chat/status': ok(STATUS),
    'GET /api/chat/failover': ok(VIEW),
    'GET /api/models': ok({ items: [], defaults: [] }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

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

describe('Sohbet yedek makineleri (p15-chat-failover)', () => {
  it('Asistan: the backup list shows readiness; add, move and remove are saved through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const s = stepUpRoutes();
    let put: Record<string, unknown> | null = null;
    renderApp({
      path: '/settings/chat?tab=assistant',
      initialState: owner,
      routes: routes({
        ...s.routes,
        'PUT /api/chat/settings': (req) => {
          if (!s.stepped()) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          put = req.body as Record<string, unknown>;
          return { status: 200, body: { ...SETTINGS, backupWorkerIds: put.backupWorkerIds, version: 5 } };
        },
      }),
    });
    const list = await screen.findByTestId('chat-backups');
    const row = await within(list).findByTestId('chat-backup-w2');
    expect(row.textContent).toContain('mac-studio');
    expect(row.textContent).toContain('1. yedek');
    expect(row.textContent).toContain('Bağlı');
    expect(row.textContent).toContain('sürüm 1.0.65');
    expect(row.textContent).toContain('claude-code hazır');
    expect(row.textContent).toContain('yedek motor codex hazır');
    expect(row.textContent).toContain('Devralabilir');
    // Add pi-5: its runtime is not signed in — listed with the reason, cannot take over.
    await user.selectOptions(within(list).getByRole('combobox', { name: 'Yedek ekle' }), 'w3');
    await user.click(within(list).getByRole('button', { name: 'Yedek ekle' }));
    const pi = await within(list).findByTestId('chat-backup-w3');
    expect(pi.textContent).toContain('2. yedek');
    expect(pi.textContent).toContain('claude-code hazır değil: not logged in');
    expect(pi.textContent).toContain('Şu an devralamaz');
    // Move it first, then save.
    await user.click(within(list).getByRole('button', { name: 'pi-5: yukarı taşı' }));
    expect(within(list).getByTestId('chat-backup-w3').textContent).toContain('1. yedek');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmCode(user);
    await waitFor(() => {
      expect(put).toMatchObject({ workerId: 'w1', backupWorkerIds: ['w3', 'w2'], expectedVersion: 4 });
    });
    // Remove one: the next save sends the shorter list.
    await user.click(await within(list).findByRole('button', { name: 'pi-5: yedeklerden çıkar' }));
    expect(within(list).queryByTestId('chat-backup-w3')).toBeNull();
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(put).toMatchObject({ backupWorkerIds: ['w2'], expectedVersion: 5 });
    });
  });

  it('Yedek geçişi: who answers and why, the chain, recent switches; controls go through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const s = stepUpRoutes();
    const calls: { method: string; url: string; body: unknown }[] = [];
    const record =
      (next: unknown): Handler =>
      (req) => {
        if (!s.stepped()) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
        calls.push({ method: req.method, url: req.url, body: req.body });
        return { status: 200, body: next };
      };
    renderApp({
      path: '/settings/chat?tab=failover',
      initialState: owner,
      routes: routes({
        ...s.routes,
        'PUT /api/chat/failover/auto': record({ ...VIEW, auto: false }),
        'PUT /api/chat/failover/pin': record({
          ...VIEW,
          pin: { workerId: 'w2', name: 'mac-studio', until: '2026-10-23T11:00:00.000Z' },
        }),
        'DELETE /api/chat/failover/pin': record(VIEW),
        'POST /api/chat/failover/primary': record(VIEW),
      }),
    });
    expect((await screen.findByTestId('chat-failover-answering')).textContent).toBe(
      'Cevap veren: mac-studio (1. yedek)',
    );
    expect(screen.getByTestId('chat-failover-why').textContent).toBe('build-01 bağlı değil.');
    const chain = screen.getByTestId('chat-failover-chain');
    expect(within(chain).getByTestId('chat-failover-machine-w1').textContent).toContain('bağlı değil');
    expect(within(chain).getByTestId('chat-failover-machine-w2').textContent).toContain('Cevap veriyor');
    const events = screen.getByTestId('chat-failover-events');
    expect(events.textContent).toContain(
      'build-01 cevap verirken koptu; mesaj mac-studio’da yeniden yanıtlandı',
    );
    expect(events.textContent).toContain('build-01 → mac-studio: sohbet yedeğe geçti');
    // The primary cannot answer: "Ana makineye dön" is not offered.
    expect(screen.getByTestId<HTMLButtonElement>('chat-failover-force').disabled).toBe(true);

    await user.click(screen.getByTestId('chat-failover-auto'));
    await confirmCode(user);
    await waitFor(() => {
      expect(calls.at(-1)).toMatchObject({
        method: 'PUT',
        url: '/api/chat/failover/auto',
        body: { enabled: false },
      });
    });
    expect((await screen.findByTestId('chat-failover-done')).textContent).toBe('Otomatik geçiş kapalı.');

    const controls = screen.getByTestId('chat-failover-controls');
    await user.selectOptions(within(controls).getByLabelText('Süre'), 'h4');
    await user.click(screen.getByTestId('chat-failover-pin-button'));
    await waitFor(() => {
      expect(calls.at(-1)).toMatchObject({
        method: 'PUT',
        url: '/api/chat/failover/pin',
        body: { workerId: 'w2', minutes: 240 },
      });
    });
    expect((await screen.findByTestId('chat-failover-pin')).textContent).toContain('mac-studio');
    await user.click(screen.getByTestId('chat-failover-unpin'));
    await waitFor(() => {
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/chat/failover/pin' });
    });
  });

  it('the Sohbet header and the thread notice say which machine answers', () => {
    const t = messagesFor('tr').chatFailover;
    const status = parseStatus(STATUS);
    expect(status.routing?.reason).toBe('primary_offline');
    expect(headerRouting(t, status.routing, 'build-01')).toBe('yedek — build-01 bağlı değil');
    expect(
      headerRouting(
        t,
        parseStatus({ ...STATUS, routing: { ...ROUTING, machine: 'primary' } }).routing,
        'build-01',
      ),
    ).toBeNull();
    const m = (cause: string): ChatMessage => ({
      id: 'm1',
      seq: 3,
      role: 'error',
      content: 'build-01 is not connected; the answer comes from mac-studio.',
      meta: { notice: 'chat-failover', reason: null, cause, from: 'build-01', to: 'mac-studio' },
      turnId: null,
      createdAt: '2026-10-23T09:30:00.000Z',
    });
    expect(failoverNotice(t, m('primary_offline'))).toBe('build-01 bağlı değil; yanıt mac-studio’dan.');
    expect(failoverNotice(t, m('rerun'))).toBe('build-01 cevap verirken koptu; yanıt mac-studio’dan.');
    expect(failoverNotice(t, m('returned'))).toBe('Yanıt yeniden mac-studio’dan.');
    expect(failoverNotice(messagesFor('tr').chatFailover, { ...m('x'), meta: null })).toBeNull();
    // An older master's status (no routing) still parses.
    expect(parseStatus(ACC_CHAT_STATUS).routing).toBeNull();
  });
});
