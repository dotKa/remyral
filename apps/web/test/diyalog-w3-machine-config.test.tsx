// p12-diyalog wave 2 (W3, machine-config): the machine page's Araçlar, Sandbox ve politika and Yapılandırma tabs in
// the Diyalog language — same requests, step-up and role rules as the classic ToolsPanel / SandboxCard /
// RuntimePolicyCard / WorkerConfigPanel, none of their classic UI left.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  CONFIG_POLICIES,
  configHistory,
  configPolicy,
  configSandbox,
  configTools,
  configView,
} from '../src/diyalog/harness/screens/w3-machine-config';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';
import { findToast } from './toasts';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const W = 'w2';
const B = `/api/workers/${W}`;
const OP = '00000000-0000-4000-8000-0000000000b1';

const WORKER = {
  id: W,
  name: 'kestrel-mac',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:x',
  os: 'darwin',
  arch: 'arm64',
  osVersion: '15',
  hostname: 'kestrel-mac',
  workerVersion: '1.0.41',
  runningJobs: 0,
  lastSeenAt: new Date().toISOString(),
  createdAt: '2026-10-01T10:00:00.000Z',
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [],
  credentials: [],
};

function op(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OP,
    workerId: W,
    kind: 'tool.install',
    params: {},
    state: 'sent',
    reason: null,
    detail: null,
    progress: null,
    result: null,
    requestedBy: 'u1',
    requestedAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    finishedAt: null,
    login: null,
    logs: null,
    ...over,
  };
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

const STEP_UP = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

/** A write that asks for step-up until `POST /auth/step-up` succeeded once. */
function stepUpGate(): { gate: (h: Handler) => Handler; route: Record<string, Handler> } {
  let done = false;
  return {
    gate: (h) => (req) => (done ? h(req) : STEP_UP),
    route: {
      'POST /api/auth/step-up': () => {
        done = true;
        return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
      },
    },
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [WORKER] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/approvals?status=pending': ok({ items: [], nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    [`GET ${B}`]: ok(WORKER),
    [`GET /api/jobs?worker=${W}&state=RUNNING&limit=20`]: ok({ items: [], nextCursor: null }),
    [`GET ${B}/tools`]: ok(configTools(W)),
    [`GET ${B}/sandbox`]: ok(configSandbox(W)),
    [`GET ${B}/runtime-policy`]: ok(configPolicy(W)),
    'GET /api/runtime-policies': ok(CONFIG_POLICIES),
    [`GET ${B}/config`]: ok(configView(W)),
    [`GET ${B}/config/history`]: ok(configHistory()),
    [`GET ${B}/ops/${OP}?after=0`]: ok(op({ state: 'succeeded' })),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Makine → Araçlar (Diyalog)', () => {
  it('lists tools and recipes; Kur goes through step-up; no classic texts', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({
        ...s.route,
        [`POST ${B}/tools/ffmpeg/install`]: s.gate(ok(op())),
      }),
    });
    const panel = await screen.findByTestId('tools-panel');
    expect(await within(panel).findAllByTestId('tool-row')).toHaveLength(4);
    expect(within(panel).getByText('bulunamadı')).toBeTruthy();
    expect(within(panel).queryByText('Detect again')).toBeNull();
    const recipe = within(panel)
      .getAllByTestId('tool-recipe')
      .find((r) => r.textContent.includes('ffmpeg')) as HTMLElement;
    await user.click(within(recipe).getByRole('button', { name: 'Kur' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === `${B}/tools/ffmpeg/install`)).toBe(true);
    });
    expect(requests.filter((r) => r.url === `${B}/tools/ffmpeg/install`).at(-1)?.body).toEqual({
      version: '7.1',
    });
    expect(await screen.findByTestId('tool-op')).toBeTruthy();
  });

  it('an elevated recipe becomes a machine administration job', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2099-01-01T00:00:00.000Z' }),
        [`POST ${B}/machine-admin/tasks`]: ok({ jobId: 'job-9', state: 'QUEUED' }),
      }),
    });
    const recipe = (await screen.findAllByTestId('tool-recipe')).find((r) =>
      r.textContent.includes('Python'),
    ) as HTMLElement;
    await user.click(within(recipe).getByRole('button', { name: 'Kur' }));
    const notice = await screen.findByTestId('tool-elevated-dialog');
    await user.click(within(notice).getByRole('button', { name: 'Makine yönetimiyle kur' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === `${B}/machine-admin/tasks`)).toBe(true);
    });
    expect(requests.find((r) => r.url === `${B}/machine-admin/tasks`)?.body).toMatchObject({
      recipe: { tool: 'python', version: 'distro' },
    });
    const done = await screen.findByTestId('tool-machine-task');
    expect(within(done).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe('/jobs/job-9');
  });

  it('a viewer sees the inventory but no buttons', async () => {
    renderApp({ path: `/machines/${W}?tab=tools`, initialState: viewer, routes: routes() });
    const panel = await screen.findByTestId('tools-panel');
    await within(panel).findAllByTestId('tool-row');
    expect(within(panel).queryByRole('button', { name: 'Kur' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Yeniden tara' })).toBeNull();
  });
});

describe('Makine → Araçlar → Kod düğümleri (p14-code-images)', () => {
  const status = (codeImages: { supported: boolean; ready: boolean }) => ({
    workerId: W,
    displayName: 'kestrel-mac',
    state: 'online',
    connected: true,
    supported: true,
    report: null,
    reportedAt: null,
    ops: [],
    codeImages,
  });

  it('not ready: "Kod düğümü imajlarını hazırla" goes through step-up and shows the operation', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({
        ...s.route,
        [`GET ${B}/ops`]: ok(status({ supported: true, ready: false })),
        [`POST ${B}/code-images/prepare`]: s.gate(ok(op({ kind: 'code.images.prepare' }))),
        [`GET ${B}/ops/${OP}?after=0`]: ok(op({ kind: 'code.images.prepare', state: 'succeeded' })),
      }),
    });
    const panel = await screen.findByTestId('code-images');
    expect(within(panel).getByText('Hazır değil')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Kod düğümü imajlarını hazırla' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === `${B}/code-images/prepare`)).toBe(true);
    });
    expect((await within(panel).findByTestId('code-images-op')).textContent).toContain('Kod düğümü imajları');
  });

  it('ready → "Hazır"; an unsupported worker gets the update hint and no button; a viewer gets no button', async () => {
    renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: viewer,
      routes: routes({ [`GET ${B}/ops`]: ok(status({ supported: true, ready: true })) }),
    });
    const panel = await screen.findByTestId('code-images');
    expect(within(panel).getByText('Hazır')).toBeTruthy();
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('a worker that cannot build them explains why', async () => {
    renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({ [`GET ${B}/ops`]: ok(status({ supported: false, ready: false })) }),
    });
    const panel = await screen.findByTestId('code-images');
    expect(panel.textContent).toContain('sürümünü güncelleyin');
    expect(within(panel).queryByTestId('code-images-prepare')).toBeNull();
  });
});

describe('Makine → Sandbox ve politika (Diyalog)', () => {
  it('shows profiles; Hazırla sends privileged; unconfined needs the warning first', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2099-01-01T00:00:00.000Z' }),
        [`POST ${B}/sandbox/prepare`]: ok(op({ kind: 'sandbox.prepare' })),
        [`PUT ${B}/sandbox/unconfined`]: ok({}),
      }),
    });
    const profiles = await screen.findAllByTestId('sandbox-profile');
    expect(profiles).toHaveLength(4);
    expect(screen.getAllByTestId('sandbox-fix')[0]?.textContent).toContain('yetkili yardımcıyla');
    await user.click(screen.getByRole('button', { name: 'Hazırla' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === `${B}/sandbox/prepare`)?.body).toEqual({ privileged: true });
    });
    const unconfined = screen.getByTestId('unconfined-switch');
    await user.click(within(unconfined).getByRole('button', { name: 'Sınırsıza izin ver…' }));
    expect(requests.some((r) => r.url === `${B}/sandbox/unconfined`)).toBe(false);
    expect(within(unconfined).getByText('Sınırsız işler neye erişir')).toBeTruthy();
    await user.click(within(unconfined).getByRole('button', { name: 'Anladım — sınırsıza izin ver' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === `${B}/sandbox/unconfined`)?.body).toEqual({
        allow: true,
        expectedGeneration: 1,
      });
    });
  });

  it('p19-unconfined-parallel: "Sandbox’sız işler paralel çalışabilir" needs unconfined and a worker that knows it', async () => {
    const user = userEvent.setup();
    const base = configSandbox(W);
    // Unconfined off: the setting is shown but cannot be switched.
    const off = renderApp({ path: `/machines/${W}?tab=sandbox`, initialState: owner, routes: routes() });
    const offBox = await screen.findByTestId<HTMLInputElement>('unconfined-parallel');
    expect(offBox.checked).toBe(false);
    expect(offBox.disabled).toBe(true);
    expect(screen.getByText('Önce sınırsız profile izin verin.')).toBeTruthy();
    off.unmount();

    // Allowed, but an older worker build: still disabled, with the update hint.
    const old = renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        [`GET ${B}/sandbox`]: ok({ ...base, unconfined: { allowed: true, generation: 3 } }),
      }),
    });
    expect((await screen.findByTestId<HTMLInputElement>('unconfined-parallel')).disabled).toBe(true);
    expect(screen.getByText(/önce makineyi güncelleyin/)).toBeTruthy();
    old.unmount();

    // Allowed on a worker that knows it: switching sends `parallel` on the unconfined route.
    const { requests } = renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2099-01-01T00:00:00.000Z' }),
        [`GET ${B}/sandbox`]: ok({
          ...base,
          unconfined: { allowed: true, parallel: false, parallelSupported: true, generation: 3 },
        }),
        [`PUT ${B}/sandbox/unconfined`]: ok({}),
      }),
    });
    const box = await screen.findByTestId<HTMLInputElement>('unconfined-parallel');
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/En çok paralel iş/)).toBeTruthy();
    await user.click(box);
    await waitFor(() => {
      expect(requests.find((r) => r.url === `${B}/sandbox/unconfined`)?.body).toEqual({
        allow: true,
        parallel: true,
        expectedGeneration: 3,
      });
    });
  });

  it('p19-linux-host-isolation: a Linux host profile says whether attempts are isolated and how to enable it', async () => {
    const sandbox = (hostIsolation: Record<string, unknown>, filesystem: string) => {
      const base = configSandbox(W) as { status: { profiles: Record<string, unknown>[]; checks: unknown[] } };
      return {
        ...base,
        status: {
          ...base.status,
          profiles: base.status.profiles.map((p) =>
            p.profile === 'host-restricted'
              ? {
                  ...p,
                  confinement: { filesystem, egress: 'proxy_env_only', limits: 'rlimits' },
                  checks: ['worker_identity', 'worker_user', 'host_isolation'],
                }
              : p,
          ),
          checks: [...base.status.checks, { id: 'host_isolation', ...hostIsolation }],
        },
      };
    };
    const missing = renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        [`GET ${B}/sandbox`]: ok(
          sandbox(
            {
              status: 'warning',
              code: 'host_isolation_bwrap_missing',
              detail: 'bubblewrap is not installed',
              fix: 'prepare_privileged',
            },
            'os_user',
          ),
        ),
      }),
    });
    const hint = await screen.findByTestId('sandbox-isolation');
    expect(hint.textContent).toContain('bubblewrap kurulu değil');
    expect(hint.textContent).toContain('sudo apt install bubblewrap');
    expect(hint.textContent).toContain('yetkili yardımcıyla');
    missing.unmount();

    renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        [`GET ${B}/sandbox`]: ok(sandbox({ status: 'ok', detail: 'each host attempt …' }, 'bwrap')),
      }),
    });
    expect((await screen.findByTestId('sandbox-isolation')).textContent).toMatch(/Linux yalıtımı.*tamam/);
    expect(screen.getByText(/bubblewrap: her denemeye ayrı görünüm/)).toBeTruthy();
  });

  it('security fix: a host profile without any file system confinement is a visible warning with the fix', async () => {
    const base = configSandbox(W) as { status: { profiles: Record<string, unknown>[] } };
    const data = {
      ...base,
      status: {
        ...base.status,
        profiles: base.status.profiles.map((p) =>
          p.profile === 'host-restricted'
            ? {
                ...p,
                ready: true,
                code: 'host_unconfined_fallback',
                reason:
                  'no filesystem confinement: host jobs run as the worker’s own account (userns refused)',
                remedy: 'allow bubblewrap to create user namespaces (Ubuntu 24.04: AppArmor profile)',
                fix: 'owner',
                confinement: { filesystem: 'none', egress: 'proxy_env_only', limits: 'rlimits' },
              }
            : p,
        ),
      },
    };
    renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({ [`GET ${B}/sandbox`]: ok(data) }),
    });
    const warning = await screen.findByTestId('sandbox-unconfined');
    expect(warning.textContent).toContain('dosya sistemi kısıtlaması yok');
    expect(warning.textContent).toContain('userns refused');
    expect(warning.textContent).toContain('AppArmor profile');
  });

  it('runtime policy: promote with step-up, abandon after a confirmation', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        ...s.route,
        'POST /api/runtime-policies/default/promote': s.gate(ok(CONFIG_POLICIES.items[0])),
        'POST /api/runtime-policies/default/rollback': s.gate(ok(CONFIG_POLICIES.items[0])),
      }),
    });
    const card = await screen.findByTestId('runtime-policy-card');
    expect(await within(card).findAllByTestId('runtime-policy-row')).toHaveLength(3);
    expect(within(card).getByTestId('runtime-policy-summary').textContent).toContain(
      'makine default v3 bildiriyor',
    );
    await user.click(within(card).getByRole('button', { name: 'v4 sürümünü yay' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.find((r) => r.url === '/api/runtime-policies/default/promote' && r.method === 'POST')?.body,
      ).toEqual({
        version: 4,
      });
    });
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast('Tüm gruba yayıldı.')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Yayılımı bırak' }));
    expect(requests.some((r) => r.url === '/api/runtime-policies/default/rollback')).toBe(false);
    await user.click(within(card).getAllByRole('button', { name: 'Yayılımı bırak' }).at(-1) as HTMLElement);
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/runtime-policies/default/rollback')).toBe(true);
    });
  });

  // p15-classic-removal: the classic runtime-policy.test's assignment, on Sandbox ve politika.
  it('an admin assigns the machine to a policy group and flips canary (PUT /workers/:id/runtime-policy)', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=sandbox`,
      initialState: owner,
      routes: routes({
        ...s.route,
        [`PUT ${B}/runtime-policy`]: s.gate(ok(configPolicy(W))),
      }),
    });
    const card = await screen.findByTestId('runtime-policy-card');
    await user.selectOptions(await within(card).findByLabelText('Politika grubu'), 'gpu');
    const canary = within(card).getByLabelText<HTMLInputElement>(
      'Canary makine (aşamalı sürümleri önce alır)',
    );
    const wasCanary = canary.checked;
    await user.click(canary);
    await user.click(within(card).getByRole('button', { name: 'Atamayı kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'PUT' && r.url === `${B}/runtime-policy`).at(-1)?.body,
      ).toEqual({ policy: 'gpu', canary: !wasCanary });
    });
  });
});

describe('Makine → Yapılandırma (Diyalog)', () => {
  it('shows the status and ceiling; saving sends the cleaned spec with expectedGeneration after step-up', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({ ...s.route, [`PUT ${B}/config`]: s.gate(ok(configView(W))) }),
    });
    const panel = await screen.findByTestId('worker-config-panel');
    expect((await within(panel).findByTestId('config-status')).getAttribute('data-status')).toBe('applied');
    expect(await within(panel).findByTestId('config-ceiling')).toBeTruthy();
    expect(within(panel).getByTestId('config-blocked').textContent).toContain('projects.ops-scripts');
    expect(within(panel).queryByText('Save configuration')).toBeNull();
    // p15-form-pattern: the configuration is one form; its sticky bar (only once something changed) saves it.
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    const max = within(panel).getByLabelText('En çok paralel iş');
    await user.clear(max);
    await user.type(max, '4');
    await user.type(within(panel).getByLabelText('Değişiklik notu'), 'bir slot daha');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'PUT' && r.url === `${B}/config` && r.body !== undefined),
      ).toBe(true);
    });
    const body = requests.filter((r) => r.method === 'PUT' && r.url === `${B}/config`).at(-1)?.body as {
      spec: { maxParallelJobs: number; labels: Record<string, string> };
      expectedGeneration: number;
      changeNote: string;
    };
    expect(body.spec.maxParallelJobs).toBe(4);
    expect(body.spec.labels).toEqual({ site: 'ev', disk: 'nvme' });
    expect(body.expectedGeneration).toBe(3);
    expect(body.changeNote).toBe('bir slot daha');
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast(/g3 olarak kaydedildi/)).toBeTruthy();
  });

  it('p17-disk-selfclean: the disk cleanup switch and margin go into workspace.diskHygiene', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({ ...s.route, [`PUT ${B}/config`]: s.gate(ok(configView(W))) }),
    });
    const panel = await screen.findByTestId('worker-config-panel');
    await user.selectOptions(await within(panel).findByLabelText('Disk temizliği'), 'off');
    await user.type(within(panel).getByLabelText('Temizlik payı (GiB)'), '2');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'PUT' && r.url === `${B}/config` && r.body !== undefined),
      ).toBe(true);
    });
    const body = requests.filter((r) => r.method === 'PUT' && r.url === `${B}/config`).at(-1)?.body as {
      spec: { workspace: Record<string, unknown> };
    };
    expect(body.spec.workspace.diskHygiene).toEqual({ enabled: false, marginBytes: 2 * 1024 ** 3 });
  });

  it('bad labels are refused before any request; master issues are listed; 409 reloads', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { requests } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({
        [`PUT ${B}/config`]: () => {
          calls += 1;
          return calls === 1
            ? {
                status: 400,
                body: {
                  error: 'validation_failed',
                  message: 'Invalid configuration.',
                  issues: [{ path: 'maxParallelJobs', code: 'too_big' }],
                },
              }
            : { status: 409, body: { error: 'version_conflict', message: 'Changed meanwhile.' } };
        },
      }),
    });
    const panel = await screen.findByTestId('worker-config-panel');
    const labels = await within(panel).findByLabelText('Etiketler');
    await user.type(labels, '{Enter}bozuk');
    await user.click(screen.getByTestId('dy-form-save'));
    expect(within(panel).getByTestId('config-issues').textContent).toContain('bozuk');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    await user.clear(labels);
    await user.click(screen.getByTestId('dy-form-save'));
    expect(await within(panel).findByText('0 ile 64 arasında bir tam sayı olmalı.')).toBeTruthy();
    await user.click(screen.getByTestId('dy-form-save'));
    expect(await screen.findByText(/Yapılandırma bu arada değişti/)).toBeTruthy();
  });

  it('an unmanaged worker is taken over with adopt; history rolls back after a confirmation', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({
        [`GET ${B}/config`]: ok(configView(W, { desired: null, status: 'unmanaged', report: null })),
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2099-01-01T00:00:00.000Z' }),
        [`PUT ${B}/config`]: ok(configView(W)),
        [`POST ${B}/config/rollback`]: ok(configView(W)),
      }),
    });
    const unmanaged = await screen.findByTestId('config-unmanaged');
    await user.click(within(unmanaged).getByRole('button', { name: 'Yerel dosyadan devral' }));
    await user.click(screen.getByRole('button', { name: 'Devral ve kaydet' }));
    await waitFor(() => {
      const put = requests.find((r) => r.method === 'PUT' && r.url === `${B}/config`);
      expect(put?.body).toMatchObject({ adopt: true, expectedGeneration: 0 });
    });
    await user.click(await screen.findByRole('tab', { name: 'Geçmiş' }));
    const rows = await screen.findAllByTestId('config-history-row');
    expect(rows).toHaveLength(3);
    const g1 = rows.find((r) => r.textContent.includes('g1')) as HTMLElement;
    await user.click(within(g1).getByRole('button', { name: 'g1 sürümüne geri al' }));
    expect(requests.some((r) => r.url === `${B}/config/rollback`)).toBe(false);
    await user.click(within(g1).getByRole('button', { name: 'Geri al' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === `${B}/config/rollback`)?.body).toEqual({
        toGeneration: 1,
        expectedGeneration: 3,
      });
    });
  });

  it('credentials: vault choice not sealed to this worker is called out', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/machines/${W}?tab=configuration`,
      initialState: owner,
      routes: routes({
        [`GET ${B}/config`]: ok(
          configView(W, {
            desired: {
              ...(configView(W).desired as Record<string, unknown>),
              spec: {
                ...(configView(W).desired as { spec: Record<string, unknown> }).spec,
                runtimes: {
                  codex: {
                    auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'cred-anthropic' } },
                  },
                },
              },
            },
          }),
        ),
      }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Kimlik bilgileri' }));
    expect(await screen.findByTestId('not-shared-codex')).toBeTruthy();
    expect(screen.getByTestId('vault-key').textContent).toContain('SHA256:');
  });
});
