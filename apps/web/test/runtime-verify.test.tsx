// p17-runtime-verify — Makine → Runtime’lar "Doğrula": the proof line, the confirmation with the expected tokens and
// time, the step-up'd start, live progress with the results so far, the result per capability, history; an older
// worker gets no button; Ayarlar → Runtime politikası shows how many runtimes still depend on "Doğrulanmamışa izin ver"
// and the per-platform proofs; the version catalog's "Doğrulandı olarak işaretle".
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { opFixture, opsStatusFixture } from '../src/diyalog/harness/screens/w3-machine-runtimes';
import {
  CatalogProofLine,
  PlatformProofsPanel,
  PolicyDependencePanel,
} from '../src/diyalog/screens/settings/runtimes-verification';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const OP = '00000000-0000-4000-8000-0000000000b7';

const W2 = {
  id: 'w2',
  name: 'kestrel-win',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w2',
  os: 'win32',
  arch: 'x64',
  osVersion: '11',
  hostname: 'kestrel-win',
  workerVersion: '1.1.8',
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

const CAPS = [
  'streaming',
  'interactive_prompt',
  'approval',
  'cancel',
  'safe_cancel',
  'resume',
  'cost_reporting',
  'artifacts',
] as const;

function capability(c: string, effective: string, decided: 'passed' | 'failed' | null = null) {
  return {
    capability: c,
    reported: c === 'artifacts' ? 'unsupported' : 'unverified',
    declared: c === 'artifacts' ? 'unsupported' : 'supported',
    effective,
    verified: decided === 'passed' && c !== 'artifacts',
    decided:
      decided === null
        ? null
        : { outcome: decided, reason: `${c} ${decided}`, at: iso(60_000), evidenceId: 'e1', workerId: 'w2' },
    note: null,
  };
}

const RUN = {
  id: 'e1',
  workerId: 'w2',
  machine: 'kestrel-win',
  runtime: 'claude-code',
  runtimeVersion: '2.1.296',
  adapterVersion: 'claude-code-adapter/1+sdk0.3.296',
  platform: 'win32-x64',
  workerVersion: '1.1.8',
  authMode: 'local-login',
  sandboxProfile: 'host-restricted',
  startedAt: iso(180_000),
  finishedAt: iso(60_000),
  durationMs: 120_000,
  inputTokens: 30_000,
  outputTokens: 4_000,
  costUsd: null,
  stoppedBy: null,
  passed: 6,
  failed: 1,
  results: CAPS.map((c) => ({
    capability: c,
    status: c === 'artifacts' ? 'skipped' : c === 'safe_cancel' ? 'failed' : 'passed',
    reason: c === 'safe_cancel' ? 'sleep 177 still runs' : 'ok',
    durationMs: 1000,
  })),
};

function verification(over: { supported?: boolean; proven?: boolean; running?: boolean } = {}) {
  const proven = over.proven === true;
  return {
    workerId: 'w2',
    supported: over.supported ?? true,
    connected: true,
    runtimes: [
      {
        runtime: 'claude-code',
        version: '2.1.296',
        platform: 'win32-x64',
        adapterVersion: 'claude-code-adapter/1+sdk0.3.296',
        authMode: 'local-login',
        state: proven ? 'partial' : 'unverified',
        capabilities: CAPS.map((c) =>
          proven
            ? capability(
                c,
                c === 'safe_cancel' ? 'unverified' : c === 'artifacts' ? 'unsupported' : 'supported',
                c === 'safe_cancel' ? 'failed' : 'passed',
              )
            : capability(c, c === 'artifacts' ? 'unsupported' : 'unverified'),
        ),
        lastRun: proven ? RUN : null,
        history: proven
          ? [
              { ...RUN, applies: true },
              { ...RUN, id: 'e0', runtimeVersion: '2.1.290', applies: false },
            ]
          : [],
        running: over.running === true ? { opId: OP, state: 'running' } : null,
        estimate: { tokens: 45_000, durationSec: 180, maxTokens: 150_000, maxDurationSec: 600 },
      },
    ],
  };
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W2] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/usage-limits/overview?history=1': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/workers/w2': ok(W2),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w2/history': ok({ items: [] }),
    'GET /api/workers/w2/ops': ok(opsStatusFixture('w2')),
    'GET /api/workers/w2/runtime-verification': ok(verification()),
    ...extra,
  };
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

describe('Makine → Runtime’lar: Doğrula', () => {
  it('shows "Kanıtlanmadı", asks with the expected tokens / time, starts the run and follows its progress', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const op = (over: Record<string, unknown>) =>
      opFixture(OP, 'w2', {
        kind: 'runtime.capabilities.verify',
        params: { runtime: 'claude-code', version: '2.1.296' },
        finishedAt: null,
        ...over,
      });
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/runtimes/claude-code/verify': ok(op({ state: 'sent' })),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: () => {
          polls += 1;
          return {
            status: 200,
            body: op({
              state: 'running',
              progress: { step: 'long' },
              result: { capabilityVerify: { final: false, results: RUN.results.slice(0, 2) } },
            }),
          };
        },
      }),
    });
    const proof = await screen.findByTestId('runtime-proof-claude-code');
    expect(proof.getAttribute('data-state')).toBe('unverified');
    expect(within(proof).getByTestId('runtime-proof-line').textContent).toBe(
      'Kanıtlanmadı: bu sürüm ve platform için henüz doğrulama çalışmadı',
    );
    await user.click(within(proof).getByRole('button', { name: 'Doğrula' }));
    expect(requests.some((r) => r.url.endsWith('/verify'))).toBe(false);
    const dialog = await screen.findByTestId('runtime-proof-confirm');
    expect(within(dialog).getByTestId('runtime-proof-estimate').textContent).toContain('45.000 token');
    expect(dialog.textContent).toContain('Abonelik oturumu kullanılır');
    await user.click(within(dialog).getByRole('button', { name: 'Doğrulamayı başlat' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url.endsWith('/runtimes/claude-code/verify'))?.method).toBe('POST');
    });
    expect(
      requests.find((r) => r.url.endsWith('/runtimes/claude-code/verify'))?.headers['x-csrf-token'],
    ).toBe('csrf-token');
    const running = await within(proof).findByTestId('runtime-proof-running');
    expect(running.textContent).toContain('Doğrulanıyor');
    expect(running.textContent).toContain('uzun komut ve iptal');
    const results = within(proof).getByTestId('runtime-proof-results');
    expect(
      within(results)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-capability')),
    ).toEqual(['streaming', 'interactive_prompt']);
    expect(polls).toBeGreaterThan(0);
  });

  it('a proven tuple says by which machine and when, lists the result per capability and the history', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({ 'GET /api/workers/w2/runtime-verification': ok(verification({ proven: true })) }),
    });
    const proof = await screen.findByTestId('runtime-proof-claude-code');
    expect(proof.getAttribute('data-state')).toBe('partial');
    const line = within(proof).getByTestId('runtime-proof-line').textContent;
    expect(line).toContain('Kısmen kanıtlandı (kestrel-win');
    expect(line).toContain('Güvenli iptal geçmedi');
    const items = within(within(proof).getByTestId('runtime-proof-results')).getAllByRole('listitem');
    expect(items.find((li) => li.getAttribute('data-capability') === 'safe_cancel')?.textContent).toContain(
      'sleep 177 still runs',
    );
    expect(within(proof).getByRole('button', { name: 'Yeniden doğrula' })).toBeTruthy();
    const history = within(proof).getByTestId('runtime-proof-history');
    expect(history.textContent).toContain('6 geçti, 1 geçmedi');
    expect(history.textContent).toContain('artık geçerli değil');
  });

  it('an older worker has no button and says to update the machine', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({ 'GET /api/workers/w2/runtime-verification': ok(verification({ supported: false })) }),
    });
    const proof = await screen.findByTestId('runtime-proof-claude-code');
    expect(within(proof).queryByRole('button', { name: 'Doğrula' })).toBeNull();
    expect(within(proof).getByTestId('runtime-proof-update').textContent).toContain('önce makineyi güncelle');
  });
});

describe('Ayarlar → Runtime politikası / Araçlar ve sürümler / katalog', () => {
  function renderWith(ui: React.ReactNode, routes: Record<string, Handler>) {
    const f = fakeFetch(routes);
    vi.stubGlobal('fetch', f.fetch);
    return {
      ...render(
        <MemoryRouter>
          <AuthProvider initialState={owner}>
            <StepUpProvider>{ui}</StepUpProvider>
          </AuthProvider>
        </MemoryRouter>,
      ),
      requests: f.requests,
    };
  }

  it('counts the runtimes that still depend on "Doğrulanmamışa izin ver" and names the way out', async () => {
    renderWith(<PolicyDependencePanel />, {
      'GET /api/runtime-verification/policy': ok({
        total: 7,
        dependent: 2,
        items: [
          {
            workerId: 'w2',
            machine: 'kestrel-win',
            runtime: 'pi',
            version: '1.4.0',
            platform: 'win32-x64',
            unverified: ['streaming', 'cancel'],
            canVerify: true,
          },
          {
            workerId: 'w3',
            machine: 'old-linux',
            runtime: 'codex',
            version: '0.164.0',
            platform: 'linux-x64',
            unverified: ['approval'],
            canVerify: false,
          },
        ],
      }),
    });
    const panel = await screen.findByTestId('runtime-policy-dependence');
    expect(within(panel).getByTestId('runtime-policy-dependence-count').textContent).toContain(
      'Toplam 7 runtime’ın 2 tanesi',
    );
    expect(panel.textContent).toContain('Makine → Runtime’lar → Doğrula');
    const links = within(panel).getAllByRole('link');
    expect(links[0]?.textContent).toBe('kestrel-win: pi 1.4.0 (win32-x64) — Akış, İptal');
    expect(links[0]?.getAttribute('href')).toBe('/machines?worker=w2&section=remote-ops');
    expect(panel.textContent).toContain('önce makineyi güncelle');
  });

  it('nothing depends on it: says the allowance can be turned off', async () => {
    renderWith(<PolicyDependencePanel />, {
      'GET /api/runtime-verification/policy': ok({ total: 3, dependent: 0, items: [] }),
    });
    expect((await screen.findByTestId('runtime-policy-dependence')).textContent).toContain('kapatılabilir');
  });

  it('per platform which versions are proven (an old adapter revision says to verify again)', async () => {
    renderWith(<PlatformProofsPanel />, {
      'GET /api/runtime-verification/platforms': ok({
        items: [
          {
            runtime: 'pi',
            platform: 'win32-x64',
            version: '1.4.0',
            adapterVersion: 'pi-adapter/1+pin1.4.0',
            current: true,
            verified: ['streaming', 'cancel'],
            failed: ['safe_cancel'],
            at: iso(60_000),
            machine: 'kestrel-win',
            workerId: 'w2',
          },
          {
            runtime: 'codex',
            platform: 'darwin-arm64',
            version: '0.164.0',
            adapterVersion: 'codex-adapter/0',
            current: false,
            verified: ['streaming'],
            failed: [],
            at: iso(60_000),
            machine: 'mac',
            workerId: 'w1',
          },
        ],
      }),
    });
    const rows = await screen.findAllByTestId('runtime-platform-proof');
    expect(
      rows.map((r) => `${r.getAttribute('data-runtime') ?? ''}@${r.getAttribute('data-version') ?? ''}`),
    ).toEqual(['codex@0.164.0', 'pi@1.4.0']);
    expect(rows[1]?.textContent).toContain('Akış, İptal kanıtlandı');
    expect(rows[1]?.textContent).toContain('Güvenli iptal geçmedi');
    expect(rows[0]?.textContent).toContain('adaptör değişti');
  });

  it('a catalog runtime version with a passed run can be marked verified on this installation', async () => {
    const user = userEvent.setup();
    const onMarked = vi.fn();
    const { requests } = renderWith(
      <CatalogProofLine
        runtime="codex"
        version="0.165.0"
        canMark
        onMarked={onMarked}
        proofs={[
          {
            runtime: 'codex',
            version: '0.165.0',
            evidence: 'passed',
            at: iso(60_000),
            machine: 'canary-mac',
            platform: 'darwin-arm64',
            evidenceId: 'e9',
            marked: null,
          },
        ]}
      />,
      {
        // The stub answers 200 (a 204 Response cannot carry the stub's empty body).
        'POST /api/runtime-verification/catalog/codex/0.165.0/mark': () => ({ status: 200, body: null }),
      },
    );
    const line = await screen.findByTestId('catalog-proof');
    expect(line.getAttribute('data-state')).toBe('passed');
    expect(line.textContent).toContain('Kanıtlandı (canary-mac');
    await user.click(within(line).getByRole('button', { name: 'Doğrulandı olarak işaretle' }));
    expect(screen.getByText(/İmzalı katalog değişmez/)).toBeTruthy();
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Doğrulandı olarak işaretle' }),
    );
    await waitFor(() => {
      expect(requests.some((r) => r.url.endsWith('/catalog/codex/0.165.0/mark') && r.method === 'POST')).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(onMarked).toHaveBeenCalled();
    });
  });

  it('without a passed run the catalog line says where to verify and offers no mark', async () => {
    renderWith(
      <CatalogProofLine runtime="pi" version="1.5.0" canMark onMarked={() => undefined} proofs={[]} />,
      {},
    );
    const line = await screen.findByTestId('catalog-proof');
    expect(line.getAttribute('data-state')).toBe('none');
    expect(line.textContent).toContain('Doğrula');
    expect(within(line).queryByRole('button')).toBeNull();
  });
});
