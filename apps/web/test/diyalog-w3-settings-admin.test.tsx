// p12-diyalog wave 2 (W3): Ayarlar → Kimlik bilgileri, Worker sürümleri (upload + diagnostics) and Yedekler in the
// Diyalog language — values sealed in the browser (only ciphertext leaves), step-up on every write, the chunked
// release upload with resume / upload again, the attempt diagnostics; flag off keeps the classic pages.
import { createHash, webcrypto } from 'node:crypto';
import { openCredential, type SealedValue, vaultKeyId } from '@remyral/protocol/credential-seal';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { SETTINGS_BACKUPS, SETTINGS_RELEASES } from '../src/diyalog/harness/screens/settings';
import {
  W3_CREDENTIALS,
  W3_DIAGNOSTICS,
  w3Credential,
  w3VaultWorker,
} from '../src/diyalog/harness/screens/w3-settings-admin';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 8_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const VALUE = 'sk-ant-api03-test-value-0123456789';

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

type Key = Parameters<typeof openCredential>[1];

async function workerKey(): Promise<{ publicKey: string; privateKey: Key; keyId: string }> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: Key;
    privateKey: Key;
  };
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = Buffer.from(raw).toString('base64url');
  return { publicKey, privateKey: pair.privateKey, keyId: await vaultKeyId(publicKey) };
}

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/releases': ok(SETTINGS_RELEASES),
    'GET /api/releases?limit=25': ok(SETTINGS_RELEASES),
    'GET /api/backups/status': ok(SETTINGS_BACKUPS),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

const stepUpRoute =
  (onStep: () => void): Handler =>
  () => {
    onStep();
    return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
  };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Kimlik bilgileri', () => {
  it('p16-assistant-admin: the assistant’s rotation link (?replace=<id>) opens that credential’s new-value form', async () => {
    renderApp({
      path: '/settings/credentials?replace=anthropic-main',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({
          items: [w3VaultWorker('w1', 'atlas-win-01', { publicKey: 'AAAA', keyId: 'a1b2' })],
        }),
        'GET /api/vault/credentials': ok({ items: W3_CREDENTIALS }),
      }),
    });
    expect(await screen.findByRole('form', { name: 'anthropic-main değerini değiştir' })).toBeTruthy();
  });

  it('lists credentials with delivery states and the machine keys, in Turkish', async () => {
    renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({
          items: [
            w3VaultWorker('w1', 'atlas-win-01', { publicKey: 'AAAA', keyId: 'a1b2' }),
            w3VaultWorker('w5', 'pebble-pi', null),
          ],
        }),
        'GET /api/vault/credentials': ok({ items: W3_CREDENTIALS }),
      }),
    });
    const table = await screen.findByTestId('credential-table');
    expect(within(table).getAllByTestId('credential-row')).toHaveLength(2);
    expect(screen.getByTestId('status-anthropic-main-w1').textContent).toBe('v2 · Makinede');
    expect(screen.getByTestId('status-anthropic-main-w3').textContent).toBe('v2 · Reddedildi');
    expect(table.textContent).toContain('iptal edildi');
    expect(screen.getByTestId('key-w5').textContent).toContain('desteklemiyor');
    expect(screen.queryByText('Add credential')).toBeNull();
  });

  it('p17-toasts-rest: a key rotation request says so in a toast, not under the table', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const k = await workerKey();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({ items: [w3VaultWorker('w1', 'atlas-win-01', k)] }),
        'GET /api/vault/credentials': ok({ items: [] }),
        'POST /api/vault/workers/w1/rotate-key': ok({ requested: true }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'atlas-win-01 anahtarını yenile' }));
    expect(
      await findToast('atlas-win-01 için yenileme istendi; makine bildirince yeni parmak izi görünür.'),
    ).toBeTruthy();
    expect(requests.filter((r) => r.url === '/api/vault/workers/w1/rotate-key')).toHaveLength(1);
    expect(within(screen.getByTestId('dy-vault-keys')).queryByText(/yenileme istendi/)).toBeNull();
  });

  it('seals the value in the browser; the request carries ciphertext only, after step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const k = await workerKey();
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({
          items: [w3VaultWorker('w1', 'atlas-win-01', k), w3VaultWorker('w5', 'pebble-pi', null)],
        }),
        'GET /api/vault/credentials': ok({ items: [] }),
        'POST /api/vault/credentials': () =>
          stepped
            ? { status: 200, body: w3Credential({ version: 1, workers: [] }) }
            : { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Kimlik bilgisi ekle' }));
    const form = await screen.findByRole('form', { name: 'Kimlik bilgisi ekle' });
    await user.type(within(form).getByLabelText('Kimlik bilgisi kimliği'), 'anthropic-main');
    await user.type(within(form).getByLabelText('Ad'), 'Anthropic ana');
    expect(within(form).getByRole('checkbox', { name: /pebble-pi/ })).toHaveProperty('disabled', true);
    await user.click(within(form).getByRole('checkbox', { name: /atlas-win-01/ }));
    const value = within(form).getByLabelText<HTMLInputElement>('Değer');
    await user.type(value, VALUE);
    await user.click(within(form).getByRole('button', { name: 'Mühürle ve ekle' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/vault/credentials')).toHaveLength(
        2,
      );
    });
    for (const r of requests) expect(JSON.stringify(r.body ?? null)).not.toContain(VALUE);
    const post = requests.filter((r) => r.url === '/api/vault/credentials').at(-1);
    const body = post?.body as { workers: { workerId: string; keyId: string; sealed: SealedValue }[] };
    const w = body.workers[0];
    const opened = await openCredential(
      w?.sealed as SealedValue,
      k.privateKey,
      k.publicKey,
      {
        workerId: 'w1',
        credentialId: 'anthropic-main',
        version: 1,
        keyId: k.keyId,
        kind: 'anthropic',
        env: 'ANTHROPIC_API_KEY',
      },
      webcrypto.subtle as never,
    );
    expect(opened).toBe(VALUE);
    expect(value.value).toBe('');
  });

  it('refuses a Claude subscription token before any request (Turkish message)', async () => {
    const k = await workerKey();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({ items: [w3VaultWorker('w1', 'atlas-win-01', k)] }),
        'GET /api/vault/credentials': ok({ items: [] }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Kimlik bilgisi ekle' }));
    const form = await screen.findByRole('form', { name: 'Kimlik bilgisi ekle' });
    await user.type(within(form).getByLabelText('Kimlik bilgisi kimliği'), 'claude');
    await user.type(within(form).getByLabelText('Ad'), 'Claude');
    await user.click(within(form).getByRole('checkbox', { name: /atlas-win-01/ }));
    await user.type(within(form).getByLabelText('Değer'), 'sk-ant-oat01-subscription-token');
    await user.click(within(form).getByRole('button', { name: 'Mühürle ve ekle' }));
    expect(await within(form).findByText(/abonelik \(OAuth\)/)).toBeTruthy();
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  // p15-classic-removal: the classic credentials.test's "rotates a value as a new version", on the Diyalog page.
  it('replaces a value as a new version sealed in the browser (PUT /vault/credentials/:id/value)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const k = await workerKey();
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({ items: [w3VaultWorker('w1', 'atlas-win-01', k)] }),
        'GET /api/vault/credentials': ok({
          items: [w3Credential({ workers: [(w3Credential().workers as unknown[])[0]] })],
        }),
        'PUT /api/vault/credentials/anthropic-main/value': () =>
          stepped
            ? { status: 200, body: w3Credential({ version: 3 }) }
            : { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    await user.click((await screen.findAllByRole('button', { name: 'Değiştir / paylaş' }))[0] as HTMLElement);
    const form = await screen.findByRole('form', { name: 'anthropic-main değerini değiştir' });
    await user.type(within(form).getByLabelText('Değer'), VALUE);
    await user.click(within(form).getByRole('button', { name: 'Yeni sürümü mühürle' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'PUT' && r.url === '/api/vault/credentials/anthropic-main/value'),
      ).toHaveLength(2);
    });
    for (const r of requests) expect(JSON.stringify(r.body ?? null)).not.toContain(VALUE);
    const put = requests.filter((r) => r.url === '/api/vault/credentials/anthropic-main/value').at(-1);
    const body = put?.body as { expectedVersion: number; workers: { workerId: string }[] };
    expect(body.expectedVersion).toBe(2);
    expect(body.workers.map((w) => w.workerId)).toEqual(['w1']);
  });

  it('revoke everywhere is confirmed, then sent through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: routes({
        'GET /api/vault/workers': ok({ items: [] }),
        'GET /api/vault/credentials': ok({ items: [w3Credential()] }),
        'DELETE /api/vault/credentials/anthropic-main': () =>
          stepped
            ? { status: 200, body: w3Credential({ state: 'revoked' }) }
            : { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    await user.click(await screen.findByTestId('revoke-anthropic-main'));
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    await user.click(screen.getByTestId('revoke-anthropic-main-confirm'));
    await confirmStepUp(user);
    expect(await screen.findByText('iptal edildi')).toBeTruthy();
  });
});

const ID = '00000000-0000-4000-8000-0000000000ff';
const RELEASE = {
  version: '1.4.0',
  channel: 'stable',
  sha256: 'd'.repeat(64),
  sizeBytes: 70_000,
  keyId: 'b'.repeat(16),
  uploadedAt: '2026-10-19T10:00:00.000Z',
};

describe('Diyalog Worker sürümleri — upload and diagnostics', () => {
  it('uploads in parts through step-up, then rolls out to stable', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const doc = new Uint8Array(70_000).fill(7);
    let stepped = false;
    let promoted: unknown = null;
    const user = userEvent.setup();
    renderApp({
      path: '/settings/releases',
      initialState: owner,
      routes: routes({
        'POST /api/releases/uploads': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          const b = req.body as { totalBytes: number; sha256: string; partSize: number };
          expect(b.sha256).toBe(createHash('sha256').update(doc).digest('hex'));
          return {
            status: 201,
            body: {
              id: ID,
              totalBytes: b.totalBytes,
              sha256: b.sha256,
              partSize: b.partSize,
              partCount: 1,
              received: [],
              expiresAt: RELEASE.uploadedAt,
            },
          };
        },
        [`PUT /api/releases/uploads/${ID}/parts/0`]: ok({
          n: 0,
          received: 1,
          partCount: 1,
          expiresAt: RELEASE.uploadedAt,
        }),
        [`POST /api/releases/uploads/${ID}/complete`]: () => ({ status: 201, body: RELEASE }),
        'PUT /api/releases/channels/stable': (req) => {
          promoted = req.body;
          return {
            status: 200,
            body: { channel: 'stable', version: '1.4.0', rolloutPercent: 100, updatedAt: RELEASE.uploadedAt },
          };
        },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    await screen.findByTestId('dy-channels');
    await user.upload(
      screen.getByLabelText('İmzalı sürüm belgesi'),
      new File([doc], 'release.json', { type: 'application/json' }),
    );
    expect(screen.getByRole('progressbar', { name: 'Sürüm yükleme' })).toBeTruthy();
    await confirmStepUp(user);
    expect((await screen.findByTestId('release-upload-done')).textContent).toContain('1.4.0');
    await user.click(screen.getByRole('button', { name: 'stable kanalında yay' }));
    await waitFor(() => {
      expect(promoted).toEqual({ version: '1.4.0', rolloutPercent: 100 });
    });
    expect(await screen.findByText(/stable → 1\.4\.0, %100/)).toBeTruthy();
    expect(screen.queryByText('Upload signed release.json')).toBeNull();
  });

  it('a refused release offers to upload again, not to resume', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const doc = new Uint8Array(70_000).fill(3);
    const user = userEvent.setup();
    renderApp({
      path: '/settings/releases',
      initialState: owner,
      routes: routes({
        'POST /api/releases/uploads': () => ({
          status: 201,
          body: {
            id: ID,
            totalBytes: doc.length,
            sha256: createHash('sha256').update(doc).digest('hex'),
            partSize: 2 * 1024 * 1024,
            partCount: 1,
            received: [],
            expiresAt: RELEASE.uploadedAt,
          },
        }),
        [`PUT /api/releases/uploads/${ID}/parts/0`]: ok({
          n: 0,
          received: 1,
          partCount: 1,
          expiresAt: RELEASE.uploadedAt,
        }),
        [`POST /api/releases/uploads/${ID}/complete`]: () => ({
          status: 422,
          body: { error: 'signature_invalid', message: 'The release is not validly signed (bad_signature).' },
        }),
      }),
    });
    await screen.findByTestId('dy-channels');
    await user.upload(
      screen.getByLabelText('İmzalı sürüm belgesi'),
      new File([doc], 'release.json', { type: 'application/json' }),
    );
    const failed = await screen.findByTestId('release-upload-failed');
    expect(failed.textContent).toContain('not validly signed');
    expect(within(failed).getByRole('button', { name: 'Yeniden yükle' })).toBeTruthy();
    expect(within(failed).queryByRole('button', { name: 'Yüklemeyi sürdür' })).toBeNull();
  });

  it('a rolled-back attempt opens its diagnostics in Turkish', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/releases?tab=attempts',
      initialState: owner,
      routes: routes({
        'GET /api/releases/attempts/att-2/diagnostics': ok({ diagnostics: W3_DIAGNOSTICS }),
      }),
    });
    const attempts = await screen.findAllByTestId('dy-attempt');
    await user.click(within(attempts[1] as HTMLElement).getByRole('button', { name: /Neden\?/ }));
    const d = await screen.findByTestId('attempt-diagnostics');
    expect(d.textContent).toContain('açılırken çöktü');
    expect(d.textContent).toContain('Yetkili güncelleyici');
    expect(within(d).getByTestId('diag-boot-log').textContent).toContain('TypeError');
  });
});

describe('Diyalog Yedekler — classic parity details', () => {
  it('shows the last successful backup and the drill’s next run', async () => {
    renderApp({ path: '/settings/backups', initialState: owner, routes: routes() });
    const last = await screen.findByTestId('dy-backup-last');
    expect(last.textContent).toContain('Son başarılı');
    expect(screen.getByTestId('dy-backup-drill').textContent).toContain('Sonraki');
  });
});
