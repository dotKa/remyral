// p13-runtime-accounts (docs/design/p13-runtime-accounts.md §7): several Claude Code / Codex accounts per machine in the
// Diyalog console — the accounts list on Makine → Runtime'lar (add a subscription account → its login, add an API-key
// account from the vault, log in / pause / default / rename / remove through step-up), per-account limit lines,
// the project's account selection policy, the chat engine's account.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLogin, logoutRuntime, startLogin } from '../src/api/remoteOps';
import { parseOverview } from '../src/api/runtimeUsage';
import type { AuthState } from '../src/auth/AuthProvider';
import { limitLine } from '../src/diyalog/compose/labels';
import { opFixture, opsStatusFixture } from '../src/diyalog/harness/screens/w3-machine-runtimes';
import { accountSwitchText } from '../src/diyalog/job/mapping';
import {
  POLICY_ADVICE,
  POLICY_APPROVAL_PAUSE,
  POLICY_CACHES,
  POLICY_OFF_PEAK,
  POLICY_QUEUE,
  POLICY_ROUTING,
  POLICY_USAGE_LIMIT,
} from '../src/diyalog/harness/screens/w3-project-policy';
import { ACC_CHAT_SETTINGS, ACC_CHAT_STATUS } from '../src/diyalog/harness/screens/w3-settings-account';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const OP = '00000000-0000-4000-8000-0000000000a1';
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const STEP_UP = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

const W2 = {
  id: 'w2',
  name: 'kestrel-pc',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w2',
  os: 'win32',
  arch: 'x64',
  osVersion: '11',
  hostname: 'kestrel-pc',
  workerVersion: '1.0.50',
  runningJobs: 0,
  lastSeenAt: iso(1000),
  createdAt: iso(86_400_000),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [],
  credentials: [],
};

const WINDOWS = [
  {
    id: 'five_hour',
    kind: 'session',
    label: null,
    usedPercent: 62,
    windowMinutes: 300,
    resetsAt: iso(-3_600_000),
    status: 'allowed',
    level: 'ok',
  },
  {
    id: 'seven_day',
    kind: 'weekly',
    label: null,
    usedPercent: 30,
    windowMinutes: 10080,
    resetsAt: iso(-86_400_000),
    status: 'allowed',
    level: 'ok',
  },
];

function account(over: Record<string, unknown>): Record<string, unknown> {
  return {
    workerId: 'w2',
    workerName: 'kestrel-pc',
    runtime: 'claude-code',
    id: 'default',
    label: 'Varsayılan',
    kind: 'subscription',
    credentialId: null,
    store: 'claude',
    isDefault: true,
    position: 0,
    paused: false,
    pausedReason: null,
    login: { status: 'logged_in', reason: null, checkedAt: iso(60_000) },
    state: 'logged_in',
    limit: null,
    usage: { level: 'ok', observedAt: iso(60_000), windows: WINDOWS },
    running: 1,
    lendable: false,
    supported: true,
    ...over,
  };
}

const PERSONAL = account({ label: 'Kişisel Max' });
const TEAM = account({
  id: 'a7k2m9q1',
  label: 'Şirket Team',
  store: 'claude-a7k2m9q1',
  isDefault: false,
  position: 1,
  lendable: true,
  running: 0,
  state: 'limited',
  limit: { episodeId: 'e1', resetAt: iso(-2 * 3_600_000), resumeAt: iso(-2 * 3_600_000) },
  usage: null,
});

const LIST = { accounts: [PERSONAL, TEAM], workers: [{ id: 'w2', name: 'kestrel-pc', supported: true }] };

function machineRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const overview = {
    generatedAt: iso(0),
    settings: { nearThreshold: 80, notifyNear: true },
    entries: [],
    otherLimits: [],
  };
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W2] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok(overview),
    'GET /api/usage-limits/overview?history=1': ok(overview),
    'GET /api/workers/w2': ok(W2),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w2/ops': ok(opsStatusFixture('w2')),
    'GET /api/runtime-accounts?worker=w2&runtime=claude-code': ok(LIST),
    'GET /api/runtime-accounts?worker=w2&runtime=codex': ok({
      accounts: [account({ runtime: 'codex', store: 'codex', label: 'Varsayılan', usage: null })],
      workers: LIST.workers,
    }),
    ...extra,
  };
}

async function confirmCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const field = await screen.findByLabelText(/6-digit code|kod/i);
  const dialog = field.closest('dialog') as HTMLElement;
  await user.type(field, '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Makine → Runtime’lar: hesaplar', { timeout: 30_000 }, () => {
  it('lists the accounts with kind, state, default mark, usage bars, running jobs and limit reset', async () => {
    renderApp({ path: '/machines/w2?tab=runtimes', initialState: owner, routes: machineRoutes() });
    const list = await screen.findByTestId('accounts-claude-code');
    const personal = await within(list).findByTestId('account-claude-code-default');
    expect(within(personal).getByTestId('account-label').textContent).toBe('Kişisel Max');
    expect(within(personal).getByTestId('account-state').textContent).toBe('Hazır');
    expect(personal.textContent).toContain('varsayılan');
    expect(personal.textContent).toContain('1 iş çalışıyor');
    expect(within(personal).getAllByTestId('limit-window')).toHaveLength(2);
    const team = within(list).getByTestId('account-claude-code-a7k2m9q1');
    expect(team.getAttribute('data-state')).toBe('limited');
    expect(within(team).getByTestId('account-state').textContent).toBe('Limitte');
    expect(within(team).getByTestId('account-limit').textContent).toContain('limitte');
    // The configured login runs as the worker account; added ones are lent: the hint says how to run in parallel.
    expect(within(list).getByTestId('accounts-default-hint').textContent).toContain('Hesap ekle');
    // No delete for the configured account.
    expect(within(personal).queryByRole('button', { name: 'Sil' })).toBeNull();
    expect(within(team).getByRole('button', { name: 'Sil' })).toBeTruthy();
  });

  it('add a subscription account: created through step-up, then its own login opens the login dialog', async () => {
    const user = userEvent.setup();
    let creates = 0;
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes({
        'POST /api/workers/w2/runtime-accounts': () => {
          creates += 1;
          return creates === 1
            ? STEP_UP
            : {
                status: 201,
                body: { account: account({ id: 'b1c2d3e4', label: 'İkinci Max', isDefault: false }) },
              };
        },
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
        'POST /api/workers/w2/runtimes/claude-code/login': ok(
          opFixture(OP, 'w2', {
            kind: 'login.start',
            params: { runtime: 'claude-code' },
            state: 'sent',
            finishedAt: null,
          }),
        ),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: ok(
          opFixture(OP, 'w2', {
            kind: 'login.start',
            params: { runtime: 'claude-code' },
            state: 'waiting_for_user',
            finishedAt: null,
            login: {
              runtime: 'claude-code',
              account: 'b1c2d3e4',
              url: 'https://claude.com/cai/oauth/authorize?code=true',
              userCode: null,
              expectsCode: true,
              codeSent: false,
            },
          }),
        ),
      }),
    });
    const list = await screen.findByTestId('accounts-claude-code');
    await user.click(within(list).getByRole('button', { name: 'Hesap ekle' }));
    const dialog = await screen.findByTestId('account-add-dialog');
    await user.type(within(dialog).getByLabelText('Ad'), 'İkinci Max');
    await user.click(within(dialog).getByRole('button', { name: 'Ekle ve oturum aç' }));
    await confirmCode(user);
    await waitFor(() => {
      expect(creates).toBe(2);
    });
    expect(requests.filter((r) => r.url.endsWith('/runtime-accounts')).at(-1)?.body).toEqual({
      runtime: 'claude-code',
      label: 'İkinci Max',
      kind: 'subscription',
    });
    await waitFor(() => {
      expect(requests.find((r) => r.url.endsWith('/runtimes/claude-code/login'))?.body).toEqual({
        account: 'b1c2d3e4',
      });
    });
    expect(await screen.findByTestId('login-dialog')).toBeTruthy();
  });

  it('add an API-key account: picks an Anthropic vault credential shared with the machine', async () => {
    const user = userEvent.setup();
    const cred = (id: string, kind: string, workerId: string) => ({
      id,
      name: `${id} anahtarı`,
      kind,
      env: 'ANTHROPIC_API_KEY',
      description: null,
      version: 1,
      state: 'active',
      createdAt: iso(0),
      createdBy: null,
      updatedAt: iso(0),
      revokedAt: null,
      lastUsedAt: null,
      workers: [
        {
          workerId,
          displayName: workerId,
          version: 1,
          keyId: 'k',
          status: 'applied',
          ackedVersion: 1,
          ackedAt: null,
          reason: null,
          lastUsedAt: null,
        },
      ],
    });
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes({
        'GET /api/vault/credentials': ok({
          items: [
            cred('anthropic-fatura', 'anthropic', 'w2'),
            cred('openai-x', 'openai', 'w2'),
            cred('baska', 'anthropic', 'w9'),
          ],
        }),
        'POST /api/workers/w2/runtime-accounts': () => ({
          status: 201,
          body: { account: account({ id: 'k1', label: 'API — fatura', kind: 'api_key', isDefault: false }) },
        }),
      }),
    });
    const list = await screen.findByTestId('accounts-claude-code');
    await user.click(within(list).getByRole('button', { name: 'Hesap ekle' }));
    const dialog = await screen.findByTestId('account-add-dialog');
    await user.type(within(dialog).getByLabelText('Ad'), 'API — fatura');
    await user.selectOptions(within(dialog).getByLabelText('Tür'), 'api_key');
    const pick = await within(dialog).findByLabelText('Kasadaki anahtar');
    expect(
      within(pick)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['anthropic-fatura anahtarı']);
    expect(dialog.textContent).toContain('Ücretli API anahtarları');
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST' && r.url.endsWith('/runtime-accounts'))?.body).toEqual({
        runtime: 'claude-code',
        label: 'API — fatura',
        kind: 'api_key',
        credentialId: 'anthropic-fatura',
      });
    });
    // No login for an API-key account.
    expect(requests.some((r) => r.url.endsWith('/login'))).toBe(false);
  });

  it('pause, make default, rename and remove (confirmed) send their requests', async () => {
    const user = userEvent.setup();
    let deletes = 0;
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes({
        'PATCH /api/workers/w2/runtime-accounts/claude-code/a7k2m9q1': ok({ account: TEAM }),
        'DELETE /api/workers/w2/runtime-accounts/claude-code/a7k2m9q1': () => {
          deletes += 1;
          return deletes === 1 ? STEP_UP : { status: 204, body: null };
        },
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
      }),
    });
    const team = await screen.findByTestId('account-claude-code-a7k2m9q1');
    await user.click(within(team).getByRole('button', { name: 'Duraklat' }));
    await user.click(within(team).getByRole('button', { name: 'Varsayılan yap' }));
    await user.click(within(team).getByRole('button', { name: 'Yeniden adlandır' }));
    const field = within(team).getByLabelText('Yeni ad');
    await user.clear(field);
    await user.type(field, 'Şirket');
    await user.click(within(team).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
        { paused: true },
        { isDefault: true },
        { label: 'Şirket' },
      ]);
    });
    await user.click(within(team).getByRole('button', { name: 'Sil' }));
    expect(deletes).toBe(0);
    expect(team.textContent).toContain('hesabı silinsin mi');
    await user.click(within(team).getByTestId('account-delete-a7k2m9q1-confirm'));
    await confirmCode(user);
    await waitFor(() => {
      expect(deletes).toBe(2);
    });
  });

  it('a worker without accounts support says it must be updated (no add button)', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes({
        'GET /api/runtime-accounts?worker=w2&runtime=claude-code': ok({
          accounts: [account({ supported: false })],
          workers: [{ id: 'w2', name: 'kestrel-pc', supported: false }],
        }),
      }),
    });
    const list = await screen.findByTestId('accounts-claude-code');
    expect(within(list).getByTestId('accounts-unsupported').textContent).toContain('güncellenmeli');
    expect(within(list).queryByRole('button', { name: 'Hesap ekle' })).toBeNull();
  });
});

describe('limit lines per account', () => {
  const entry = (account: string, label: string | null, used: number) => ({
    workerId: 'w2',
    workerName: 'kestrel-pc',
    workerState: 'online',
    runtime: 'claude-code',
    auth: 'subscription',
    store: account === 'default' ? 'claude' : `claude-${account}`,
    account,
    accountLabel: label,
    source: 'probe',
    plan: 'max',
    available: true,
    observedAt: iso(60_000),
    stale: false,
    reports: true,
    level: 'ok',
    windows: [{ ...WINDOWS[0], usedPercent: used, history: [] }],
    limit: null,
  });
  const overview = {
    generatedAt: iso(0),
    settings: { nearThreshold: 80, notifyNear: true },
    entries: [entry('default', 'Kişisel Max', 62), entry('a7k2m9q1', 'Şirket Team', 12)],
    otherLimits: [],
  };

  it('the composer line names the emptiest account and how many there are', () => {
    const line = limitLine(parseOverview(overview), 'claude-code');
    expect(line?.text).toMatch(/^en boş: Şirket Team — 5 saatlik %12/);
    expect(line?.text).toContain('(2 hesap)');
    // A single default account keeps the old line.
    const one = limitLine(
      parseOverview({ ...overview, entries: [entry('default', null, 40)] }),
      'claude-code',
    );
    expect(one?.text).toMatch(/^5 saatlik %40/);
  });

  it('the machine card shows one row per account, named', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes({
        'GET /api/usage-limits/overview?history=1': ok(overview),
        'GET /api/usage-limits/overview': ok(overview),
      }),
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('machine-limit-claude-code')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('machine-limit-account').map((x) => x.textContent)).toEqual([
      'Kişisel Max',
      'Şirket Team',
    ]);
  });

  it('timeline: an automatic and a manual account switch in Turkish', () => {
    expect(
      accountSwitchText(
        'usage limit on Claude Code (account Kişisel Max on w2); continuing with account Şirket Team in the same workspace',
      ),
    ).toBe('Kişisel Max hesabı limitte → Şirket Team hesabıyla sürdü');
    expect(
      accountSwitchText(
        'usage limit on Claude Code (account Kişisel Max on w2); continuing with account Ev on w3 as a new attempt',
      ),
    ).toBe('Kişisel Max hesabı limitte → Ev hesabıyla sürdü (w3, yeni deneme)');
    expect(
      accountSwitchText(
        'account switch by a person: continuing with account Şirket Team in the same workspace',
      ),
    ).toBe('Hesap elle değiştirildi → Şirket Team');
    expect(accountSwitchText('usage limit on Claude Code; waiting until 15:00')).toBeNull();
  });
});

describe('Projeler → Politika: hesap seçimi', { timeout: 30_000 }, () => {
  const PROJECT = {
    id: 'alpha',
    name: 'Alpha app',
    kind: 'repository',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: null,
    members: 2,
    myRole: 'owner',
  };
  const POLICY = {
    own: null,
    effective: { strategy: 'balanced', order: [], skipPercent: 90 },
    source: 'default',
    defaults: { strategy: 'balanced', order: [], skipPercent: 90 },
    allowPaid: false,
    accounts: [
      {
        ref: 'w2/claude-code/default',
        workerId: 'w2',
        workerName: 'kestrel-pc',
        runtime: 'claude-code',
        id: 'default',
        label: 'Kişisel Max',
        kind: 'subscription',
      },
      {
        ref: 'w2/claude-code/a7k2m9q1',
        workerId: 'w2',
        workerName: 'kestrel-pc',
        runtime: 'claude-code',
        id: 'a7k2m9q1',
        label: 'Şirket Team',
        kind: 'subscription',
      },
    ],
  };
  function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
    const base: Record<string, Handler> = {
      'GET /api/auth/session': ok(sessionBody()),
      'GET /api/projects': ok({ items: [PROJECT] }),
      'GET /api/projects/alpha/workers': ok({ items: [] }),
      'GET /api/models': ok({ items: [], defaults: [] }),
      'GET /api/projects/alpha/execution': ok({
        project: 'alpha',
        hostExecution: false,
        unconfined: false,
        allowAutoApprove: false,
        safeCommands: 'read-only',
        subtasks: false,
        delegationRuntimes: [],
      }),
      'GET /api/projects/alpha/approval-pause': ok({ ...POLICY_APPROVAL_PAUSE, project: 'alpha' }),
      'GET /api/projects/alpha/queue-settings': ok({ ...POLICY_QUEUE, project: 'alpha' }),
      'GET /api/projects/alpha/off-peak': ok(POLICY_OFF_PEAK),
      'GET /api/projects/alpha/usage-limit-policy': ok({ ...POLICY_USAGE_LIMIT, project: 'alpha' }),
      'GET /api/projects/alpha/runtime-advice': ok(POLICY_ADVICE),
      'GET /api/projects/alpha/package-caches': ok({ ...POLICY_CACHES, project: 'alpha' }),
      'GET /api/routing/rules?project=alpha': ok(POLICY_ROUTING),
      'GET /api/projects/alpha/account-policy': ok(POLICY),
      'GET /api/approvals?status=pending': ok({ items: [] }),
      'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
      'GET /api/workers': ok({ workers: [] }),
      'GET /api/notifications?limit=20': ok({ items: [], unread: 0, nextCursor: null }),
      'GET /api/notifications/unread-count': ok({ count: 0 }),
      ...over,
    };
    return base;
  }

  it('shows the effective policy and the paid switch; saves strategy, order and threshold through step-up; resets', async () => {
    const user = userEvent.setup();
    let puts = 0;
    const own = {
      strategy: 'fill_first',
      order: ['w2/claude-code/a7k2m9q1', 'w2/claude-code/default'],
      skipPercent: 85,
    };
    const { requests } = renderApp({
      // p15-form-pattern: account selection is in the "Sınırlar ve yönlendirme" tab; its bar saves the form.
      path: '/projects/alpha?tab=limits',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/alpha/account-policy': (req) => {
          puts += 1;
          if (puts === 1) return STEP_UP;
          const policy = (req.body as { policy: unknown }).policy;
          return {
            status: 200,
            body: policy === null ? POLICY : { ...POLICY, own: policy, effective: policy, source: 'project' },
          };
        },
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
      }),
    });
    const panel = await screen.findByTestId('account-policy-panel');
    expect((await within(panel).findByTestId('account-policy-current')).textContent).toContain('dengeli');
    expect(within(panel).getByTestId('account-policy-paid').textContent).toContain('kapalı');
    const form = within(panel).getByTestId('account-policy-form');
    await user.selectOptions(within(form).getByLabelText('Strateji'), 'fill_first');
    const skip = within(form).getByLabelText('Kullanımı şu yüzde ve üstü olan hesaplar en sona');
    await user.clear(skip);
    await user.type(skip, '40');
    expect(within(form).queryByRole('button', { name: 'Kaydet' })).toBeNull();
    await user.click(screen.getByTestId('dy-form-save'));
    expect(await within(form).findByText('Eşik 50 ile 100 arasında bir tam sayı olmalı.')).toBeTruthy();
    expect(puts).toBe(0);
    await user.clear(skip);
    await user.type(skip, '85');
    await user.click(
      within(form).getByRole('button', { name: 'Şirket Team — Claude Code, kestrel-pc yukarı' }),
    );
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmCode(user);
    await waitFor(() => {
      expect(puts).toBe(2);
    });
    expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ policy: own });
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast('Hesap seçimi kaydedildi.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Çalışma alanı varsayılanını kullan' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ policy: null });
    });
  });
});

describe('Ayarlar → Sohbet: asistan hesabı', { timeout: 30_000 }, () => {
  it('picks the account and the fallback account of the chosen machine and runtime', async () => {
    const user = userEvent.setup();
    let put: Record<string, unknown> | null = null;
    let stepped = false;
    const base: Record<string, Handler> = {
      'GET /api/auth/session': ok(sessionBody()),
      'GET /api/approvals?status=pending': ok({ items: [], nextCursor: null }),
      'GET /api/workers': ok({ workers: [] }),
      'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
      'GET /api/notifications?limit=20': ok({ items: [], nextCursor: null }),
      'GET /api/notifications/unread-count': ok({ count: 0 }),
      'GET /api/chat/knowledge/preferences': ok({
        indexConversations: true,
        shareProjects: false,
        autoRelated: true,
        version: 3,
      }),
      'GET /api/chat/settings': ok({ ...ACC_CHAT_SETTINGS, account: null, fallbackAccount: null }),
      'GET /api/chat/status': ok(ACC_CHAT_STATUS),
      'GET /api/models': ok({ items: [], defaults: [] }),
      'GET /api/runtime-accounts?worker=w1&runtime=claude-code': ok({
        accounts: [
          account({ workerId: 'w1', label: 'Kişisel Max' }),
          account({ workerId: 'w1', id: 'a7k2m9q1', label: 'Şirket Team', isDefault: false }),
        ],
        workers: [{ id: 'w1', name: 'atlas-win-01', supported: true }],
      }),
      'POST /api/auth/step-up': () => {
        stepped = true;
        return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
      },
      'PUT /api/chat/settings': (req) => {
        if (!stepped) return STEP_UP;
        put = req.body as Record<string, unknown>;
        return {
          status: 200,
          body: { ...ACC_CHAT_SETTINGS, account: 'a7k2m9q1', fallbackAccount: 'default', version: 5 },
        };
      },
    };
    const routes = new Proxy(base, {
      get: (t, k: string) =>
        t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
    });
    // p15-form-pattern: the assistant is the "Asistan" tab of Sohbet.
    renderApp({ path: '/settings/chat?tab=assistant', initialState: owner, routes });
    const box = await screen.findByTestId('chat-account');
    // p15-message-delivery item 2: "Otomatik" first, then "Yok", then the accounts.
    const fallback = within(box).getByLabelText<HTMLSelectElement>('Limitte yedek hesap');
    expect([...fallback.options].slice(0, 2).map((o) => [o.value, o.textContent])).toEqual([
      ['auto', 'Otomatik'],
      ['', 'Yok'],
    ]);
    await user.selectOptions(within(box).getByLabelText('Hesap'), 'a7k2m9q1');
    await user.selectOptions(within(box).getByLabelText('Limitte yedek hesap'), 'default');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmCode(user);
    await waitFor(() => {
      expect(put).toMatchObject({ account: 'a7k2m9q1', fallbackAccount: 'default' });
    });
  });
});

// p13-fix-login-auth: the panel's login calls always send a JSON body — `{}` for the machine's configured login
// (classic and Diyalog), `{ account }` for an added account — so they never depend on the master accepting a
// bodyless POST (which it does again, for API clients).
describe('login API body', () => {
  it('the configured login sends {}; an account login sends { account }', async () => {
    const op = opFixture(OP, 'w2', { kind: 'login.start', params: { runtime: 'claude-code' } });
    const f = fakeFetch({
      'POST /api/workers/w2/runtimes/claude-code/login': ok(op),
      'POST /api/workers/w2/runtimes/claude-code/login-status': ok(op),
      'POST /api/workers/w2/runtimes/claude-code/logout': ok(op),
    });
    const opts = { fetchImpl: f.fetch, cookieString: '__Host-ras-csrf=t' };
    for (const call of [startLogin, checkLogin, logoutRuntime]) {
      await call('w2', 'claude-code', undefined, opts);
      await call('w2', 'claude-code', 'b1c2d3e4', opts);
    }
    expect(f.requests.map((r) => [r.headers['content-type'], r.body])).toEqual(
      Array.from({ length: 3 }, () => [
        ['application/json', {}],
        ['application/json', { account: 'b1c2d3e4' }],
      ]).flat(),
    );
  });
});
