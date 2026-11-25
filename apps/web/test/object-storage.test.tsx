// p17-object-storage: Ayarlar → Entegrasyonlar → Depolama (local disk / S3-compatible bucket, write-only keys through a
// fresh code, a failed round trip shown with its code and hint, "Bağlantıyı test et", usage and the blobs:migrate
// command, the least-privilege policy) and the Outputs drawer (location, download by navigation, "S3'te aç", share
// links for owners / admins only — the link shown once).
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-10-24T08:00:00.000Z';
const STEP_UP = { error: 'step_up_required', message: 'Confirm with a current authenticator code.' };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

const LIMITS = {
  maxFileBytes: 2 * 1024 * 1024 * 1024 - 1,
  maxJobBytes: 5 * 1024 * 1024 * 1024,
  thresholdBytes: 4 * 1024 * 1024,
  downloadTtlSeconds: 300,
  shareMaxDays: 7,
};

const LOCAL_STATUS = {
  mode: 'local',
  config: null,
  keyIdHint: null,
  keyFingerprint: null,
  usable: true,
  problem: null,
  limits: LIMITS,
  lastTest: null,
  lastTestAt: null,
  updatedAt: NOW,
  usage: [{ location: 'local', blobs: 12, bytes: 3 * 1024 * 1024 }],
  legacyBytes: 600 * 1024 * 1024,
  local: {
    dir: '/var/lib/remyral/blobs',
    freeBytes: 40 * 1024 * 1024 * 1024,
    totalBytes: 80 * 1024 * 1024 * 1024,
  },
  options: {
    providers: ['aws', 'r2', 'minio', 'other'],
    defaults: {
      aws: { region: 'eu-central-1', pathStyle: false },
      r2: { region: 'auto', pathStyle: true },
      minio: { region: 'us-east-1', pathStyle: true },
      other: { region: 'us-east-1', pathStyle: true },
    },
    limitDefaults: LIMITS,
  },
  policy: null,
};

const S3_CONFIG = {
  provider: 'r2',
  endpoint: 'https://acc.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'remyral-outputs',
  pathStyle: true,
  prefix: 'prod/',
  sse: 'none',
  kmsKeyId: '',
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/integrations/storage': ok(LOCAL_STATUS),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

const sent = (r: { requests: RecordedRequest[] }, method: string, url: string): RecordedRequest[] =>
  r.requests.filter((q) => q.method === method && q.url === url);

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ayarlar → Entegrasyonlar → Depolama (p17-object-storage)', { timeout: 20_000 }, () => {
  it('switches to R2 through a fresh code; a failed round trip shows its code; keys are never shown', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false, fail: true };
    const r = renderApp({
      path: '/settings/integrations?tab=storage',
      initialState: state('owner'),
      routes: routes({
        'PUT /api/integrations/storage': () => {
          if (!gate.stepped) return { status: 403, body: STEP_UP };
          if (gate.fail) {
            gate.fail = false;
            return {
              status: 400,
              body: {
                error: 'storage_test_failed',
                message: 'The bucket did not pass the round trip; nothing was changed.',
                result: {
                  ok: false,
                  error: 'AccessDenied',
                  httpStatus: 403,
                  step: 'put',
                  hint: 'Attach the policy.',
                },
              },
            };
          }
          return {
            status: 200,
            body: {
              ...LOCAL_STATUS,
              mode: 's3',
              config: S3_CONFIG,
              keyIdHint: 'ABCD',
              keyFingerprint: '0123456789abcdef',
              lastTest: { ok: true, latencyMs: 42 },
              updatedAt: '2026-10-24T09:00:00.000Z',
              usage: [],
              legacyBytes: 0,
            },
          };
        },
        'POST /api/auth/step-up': () => {
          gate.stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
        'POST /api/integrations/storage/test': ok({ ok: true, latencyMs: 17 }),
      }),
    });
    const panel = await screen.findByTestId('dy-storage');
    // Usage, local directory and the migrate command for files still in the database.
    expect(within(panel).getByTestId('storage-usage').textContent).toContain('/var/lib/remyral/blobs');
    expect(within(panel).getByTestId('storage-legacy').textContent).toContain('remyral-master blobs:migrate');
    await user.selectOptions(within(panel).getByLabelText('Nereye'), 's3');
    await user.type(within(panel).getByLabelText('Kova adı'), 'remyral-outputs');
    await user.type(within(panel).getByLabelText('Uç nokta adresi'), 'https://acc.r2.cloudflarestorage.com');
    await user.type(within(panel).getByLabelText('Önek (isteğe bağlı)'), 'prod/');
    await user.type(within(panel).getByLabelText('Erişim anahtarı kimliği'), 'KEYIDABCD');
    await user.type(within(panel).getByLabelText('Gizli erişim anahtarı'), 'SECRET-R2-KEY');
    expect(within(panel).getByTestId('storage-policy').textContent).toContain(
      'arn:aws:s3:::remyral-outputs/prod/*',
    );
    await user.click(within(panel).getByRole('button', { name: 'Kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(within(screen.getByTestId('dy-storage')).getByTestId('storage-test').textContent).toContain(
        'AccessDenied',
      );
    });
    const body = sent(r, 'PUT', '/api/integrations/storage').at(-1)?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: 's3',
      config: { provider: 'r2', region: 'auto', bucket: 'remyral-outputs', pathStyle: true, prefix: 'prod/' },
      accessKeyId: 'KEYIDABCD',
      secretAccessKey: 'SECRET-R2-KEY',
      limits: LIMITS,
    });
    // Second try passes.
    await user.click(within(screen.getByTestId('dy-storage')).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(screen.getByTestId('dy-storage').textContent).toContain('Kaydedildi.');
    });
    expect(document.body.textContent).not.toContain('SECRET-R2-KEY');
    await user.click(
      within(screen.getByTestId('dy-storage')).getByRole('button', { name: 'Bağlantıyı test et' }),
    );
    await waitFor(() => {
      expect(within(screen.getByTestId('dy-storage')).getByTestId('storage-test').textContent).toContain(
        '17 ms',
      );
    });
  });
});

function fileItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: `file:${JOB}:ws-o0-app`,
    type: 'file',
    project: 'acme',
    title: null,
    name: 'app-release.apk',
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: NOW,
    site: null,
    file: {
      source: 'workspace',
      artifactId: 'ws-o0-app',
      kind: 'output',
      mediaType: 'application/vnd.android.package-archive',
      sizeBytes: 150 * 1024 * 1024,
      sha256: 'a'.repeat(64),
      redacted: false,
      removed: null,
      expiresAt: null,
      download: `/jobs/${JOB}/artifacts/ws-o0-app`,
      preview: 'none',
      location: 's3',
      ...over,
    },
    note: null,
  };
}

function outputsRoutes(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  const item = fileItem();
  const key = encodeURIComponent(String(item.key));
  return routes({
    'GET /api/projects': ok({
      items: [
        {
          id: 'acme',
          name: 'acme',
          kind: 'workspace',
          createdAt: NOW,
          createdBy: null,
          members: 1,
          myRole: role,
        },
      ],
    }),
    'GET /api/outputs/tree': ok({ nodes: [] }),
    'GET /api/outputs/folders': ok({ items: [] }),
    'GET /api/outputs?limit=25': ok({ items: [item], total: 1 }),
    [`GET /api/outputs/thread?project=acme&key=${key}`]: ok({ items: [] }),
    [`GET /api/outputs/item-folders?project=acme&key=${key}`]: ok({ items: [] }),
    ...over,
  });
}

describe('Çıktılar: location, download, share links (p17-object-storage)', { timeout: 20_000 }, () => {
  it('an admin sees "S3’te", downloads by navigation, opens in S3 and creates a link shown once', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const link = {
      id: '11111111-1111-4111-8111-111111111111',
      jobId: JOB,
      artifactId: 'ws-o0-app',
      name: 'app-release.apk',
      createdBy: 'owner1',
      createdAt: NOW,
      expiresAt: '2030-01-01T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
      useCount: 0,
    };
    const r = renderApp({
      path: '/outputs',
      initialState: state('admin'),
      routes: outputsRoutes('admin', {
        [`GET /api/jobs/${JOB}/artifacts/ws-o0-app/shares`]: ok({ links: [] }),
        [`POST /api/jobs/${JOB}/artifacts/ws-o0-app/shares`]: () =>
          gate.stepped
            ? { status: 200, body: { link, path: `/share/f/${'T'.repeat(43)}` } }
            : { status: 403, body: STEP_UP },
        'POST /api/auth/step-up': () => {
          gate.stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
        [`DELETE /api/jobs/${JOB}/artifacts/ws-o0-app/shares/${link.id}`]: ok({
          link: { ...link, revokedAt: NOW },
        }),
      }),
    });
    const row = (await screen.findAllByTestId('output-row'))[0] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'app-release.apk' }));
    const detail = await screen.findByTestId('output-detail');
    expect(detail.textContent).toContain('S3’te');
    const dl = within(detail).getByTestId('download-file');
    expect(dl.getAttribute('href')).toBe(`/api/jobs/${JOB}/artifacts/ws-o0-app/download`);
    const open = within(detail).getByTestId('open-in-s3');
    expect(open.getAttribute('href')).toBe(`/api/jobs/${JOB}/artifacts/ws-o0-app/download?open=1`);
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    const shares = await within(detail).findByTestId('share-links');
    await user.clear(within(shares).getByLabelText('Geçerlilik (gün)'));
    await user.type(within(shares).getByLabelText('Geçerlilik (gün)'), '3');
    await user.click(within(shares).getByRole('button', { name: 'Bağlantı oluştur' }));
    await confirmStepUp(user);
    const url = await within(shares).findByTestId('share-url');
    expect(url.textContent).toBe(`${window.location.origin}/api/share/f/${'T'.repeat(43)}`);
    expect(sent(r, 'POST', `/api/jobs/${JOB}/artifacts/ws-o0-app/shares`).at(-1)?.body).toEqual({ days: 3 });
    await user.click(within(shares).getByRole('button', { name: 'İptal et' }));
    // p18-confirm-dialog: the confirm dialog opens over the file dialog.
    const ask = (await screen.findAllByRole('dialog')).at(-1) as HTMLElement;
    await user.click(within(ask).getByRole('button', { name: 'İptal et' }));
    await waitFor(() => {
      expect(sent(r, 'DELETE', `/api/jobs/${JOB}/artifacts/ws-o0-app/shares/${link.id}`).length).toBe(1);
    });
  });

  it('an operator sees no share links; a file on disk has no "S3’te aç"', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/outputs',
      initialState: state('operator'),
      routes: outputsRoutes('operator', {
        'GET /api/outputs?limit=25': ok({ items: [fileItem({ location: 'local' })], total: 1 }),
      }),
    });
    const row = (await screen.findAllByTestId('output-row'))[0] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'app-release.apk' }));
    const detail = await screen.findByTestId('output-detail');
    expect(detail.textContent).toContain('Diskte');
    expect(within(detail).queryByTestId('open-in-s3')).toBeNull();
    expect(within(detail).queryByTestId('share-links')).toBeNull();
  });
});
