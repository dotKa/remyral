// p17-update-channel (ADR-0065): Ayarlar → Sürümler → Güncelleme kanalı — feed state, the owner's policy (saved with the
// authenticator flow), releases of the feed with "Güncelle", the canary-first rollout and the version catalog; the
// runtime policy draft keeps an owner's hold.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PolicyDocument, PolicyRule } from '../src/api/runtimePolicy';
import type { AuthState } from '../src/auth/AuthProvider';
import { documentOf, draftOf } from '../src/screens/runtimePolicyDraft';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const admin: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'admin' },
  session: null,
  remainingRecoveryCodes: null,
};
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function channel(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    policy: 'patch_auto',
    soakMinutes: 30,
    feed: {
      source: 'url',
      keyId: 'abcdef0123456789',
      generatedAt: null,
      checkedAt: '2026-10-26T08:00:00.000Z',
      error: null,
    },
    stableVersion: '1.1.5',
    releases: [
      {
        version: '1.2.0',
        bump: 'minor',
        state: 'awaiting_approval',
        error: null,
        publishedAt: '2026-10-26T07:00:00.000Z',
        summary: 'New things',
        notes: '- New things',
        protocolVersions: ['1.0'],
        imported: true,
      },
      {
        version: '1.1.5',
        bump: 'patch',
        state: 'done',
        error: null,
        publishedAt: '2026-10-25T07:00:00.000Z',
        summary: 'Fixes',
        notes: '',
        protocolVersions: ['1.0'],
        imported: true,
      },
    ],
    rollout: {
      id: 'r1',
      version: '1.1.5',
      stage: 'done',
      trigger: 'policy',
      startedAt: '2026-10-25T08:00:00.000Z',
      stageAt: '2026-10-25T09:00:00.000Z',
      finishedAt: '2026-10-25T09:00:00.000Z',
      reason: null,
      canary: [{ workerId: 'wrk_canary', status: 'succeeded' }],
    },
    catalog: {
      configured: true,
      enabled: true,
      checkedAt: null,
      error: null,
      keys: 1,
      sequence: 7,
      keyId: 'abcdef0123456789',
      generatedAt: '2026-10-26T06:00:00.000Z',
      items: [
        { kind: 'runtime', item: 'codex', version: '0.165.0', verified: true, verifiedAt: null },
        { kind: 'tool', item: 'uv', version: '0.13.6', verified: false, verifiedAt: null },
      ],
      workers: [
        {
          workerId: 'wrk_a',
          enabled: true,
          keys: 1,
          sequence: 7,
          lastOutcome: 'accepted',
          lastReason: null,
          reportedAt: 'x',
        },
        {
          workerId: 'wrk_b',
          enabled: true,
          keys: 1,
          sequence: 0,
          lastOutcome: 'refused',
          lastReason: 'unknown_key',
          reportedAt: 'x',
        },
      ],
    },
    ...over,
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/releases': ok({ releases: [], channels: [], attempts: [], attemptsNextCursor: null }),
    'GET /api/update-channel': ok(channel()),
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ayarlar → Sürümler → Güncelleme kanalı', () => {
  it('shows the feed, the waiting release, the last rollout and the catalog with each machine', async () => {
    renderApp({ path: '/settings/releases?tab=channel', routes: routes(), initialState: owner });
    const panel = await screen.findByTestId('dy-update-channel');
    expect(within(panel).getByTestId('dy-channel-feed').textContent).toContain('sürüm adresi');
    const rows = await within(panel).findAllByTestId('dy-channel-release');
    expect(rows[0]?.textContent).toContain('1.2.0');
    expect(rows[0]?.textContent).toContain('küçük sürüm');
    expect(rows[0]?.textContent).toContain('Onayını bekliyor');
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: /Güncelle/ })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: /Güncelle/ })).toBeNull();
    expect(screen.getByTestId('dy-channel-rollout').textContent).toContain('başarılı');
    const catalog = screen.getByTestId('dy-channel-catalog');
    expect(catalog.textContent).toContain('0.165.0');
    expect(catalog.textContent).toContain('doğrulandı');
    expect(catalog.textContent).toContain('doğrulanmamış');
    const machines = screen.getByTestId('dy-channel-catalog-workers');
    expect(machines.textContent).toContain('katalog 7');
    expect(machines.textContent).toContain('reddetti: unknown_key');
  });

  it('"Güncelle" starts the rollout of that release', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/releases?tab=channel',
      routes: routes({
        'POST /api/update-channel/releases/1.2.0/install': ok(
          channel({ releases: [{ ...channel().releases[0], state: 'rolling_out' }] }),
        ),
      }),
      initialState: owner,
    });
    const rows = await screen.findAllByTestId('dy-channel-release');
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: /Güncelle/ }));
    await waitFor(() => {
      expect(
        r.requests.some((q) => q.method === 'POST' && q.url === '/api/update-channel/releases/1.2.0/install'),
      ).toBe(true);
    });
    expect(await screen.findByText(/Makine yazılımı 1.2.0 yayılmaya başladı/)).toBeTruthy();
  });

  it('an owner saves the policy; an admin sees it read-only', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/releases?tab=channel',
      routes: routes({ 'PUT /api/update-channel/policy': ok(channel({ policy: 'manual' })) }),
      initialState: owner,
    });
    const select = await screen.findByRole('combobox', { name: /Otomatik güncelleme kuralı/ });
    await user.selectOptions(select, 'manual');
    await user.click(screen.getByRole('button', { name: /Kaydet/ }));
    await waitFor(() => {
      const put = r.requests.find((q) => q.method === 'PUT' && q.url === '/api/update-channel/policy');
      expect(put?.body).toEqual({ policy: 'manual', soakMinutes: 30 });
    });
    r.unmount();
    vi.unstubAllGlobals();
    renderApp({ path: '/settings/releases?tab=channel', routes: routes(), initialState: admin });
    const save = await screen.findByRole('button', { name: /Kaydet/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/yalnızca bir sahip/)).toBeTruthy();
  });

  it('a feed problem and an unconfigured channel are said in words', async () => {
    renderApp({
      path: '/settings/releases?tab=channel',
      routes: routes({
        'GET /api/update-channel': ok(
          channel({
            configured: false,
            feed: { source: null, keyId: null, generatedAt: null, checkedAt: null, error: 'unknown_key' },
          }),
        ),
      }),
      initialState: owner,
    });
    expect(await screen.findByText(/tanımadığımız bir anahtarla/)).toBeTruthy();
    expect(screen.getByText(/Güncelleme kanalı ayarlı değil/)).toBeTruthy();
  });
});

describe('runtime policy draft keeps a hold (ADR-0065 §8)', () => {
  const rule = (version: string, extra: Partial<PolicyRule> = {}): PolicyRule => ({
    version,
    authModes: ['secret-ref'],
    allowUnpinned: false,
    modelProfiles: [],
    defaultProfile: null,
    ...extra,
  });
  it('a held version stays; a following rule takes the release pin and is saved as follow', () => {
    const stored: PolicyDocument = {
      runtimes: {
        codex: rule('0.162.1', {
          pin: 'hold',
          hold: { by: 'alex', at: '2026-10-26T08:00:00.000Z', note: 'wait' },
        }),
        pi: rule('1.1.0'),
      },
      projectProfiles: {},
    };
    const template: PolicyDocument = {
      runtimes: { codex: rule('0.164.0'), pi: rule('1.4.0') },
      projectProfiles: {},
    };
    const doc = documentOf(draftOf('default', stored, template, 6));
    expect(doc.runtimes.codex).toMatchObject({
      version: '0.162.1',
      pin: 'hold',
      hold: { by: 'alex', note: 'wait' },
    });
    expect(doc.runtimes.pi).toMatchObject({ version: '1.4.0', pin: 'follow' });
  });
});
