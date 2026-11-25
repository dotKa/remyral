// p16-webhooks-out (docs/design/p16-webhooks-out.md §8): Ayarlar → Webhook'lar — create (code, secret shown once), list,
// test, pause / resume, reveal once, delete, the delivery log with redelivery, internal targets (owner only), the
// catalog on the API page and the chat card.
import { messagesFor } from '@remyral/i18n';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDraft } from '../src/api/chat';
import type { AuthState } from '../src/auth/AuthProvider';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { parseDocWebhooks } from '../src/diyalog/screens/settings/api-docs-webhooks';
import { errorText, eventLabel } from '../src/diyalog/screens/settings/webhooks-parts';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

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
const empty = ok({ items: [], nextCursor: null });
const ID = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222222';
const SECRET = `whsec_${'A'.repeat(43)}`;

function hook(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    name: 'n8n',
    url: 'https://n8n.example.com/webhook/remyral',
    project: null,
    eventTypes: ['job.failed', 'deploy.succeeded'],
    includeDetails: false,
    headers: [{ name: 'Authorization', value: null, secret: true, hint: 'Be…en' }],
    secretHint: 'whsec_AB…wxyz',
    secretCreatedAt: '2026-10-20T10:00:00.000Z',
    secretRevealed: true,
    previousValidUntil: null,
    state: 'active',
    disabledReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: '2026-10-23T09:00:00.000Z',
    lastFailureAt: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    createdBy: { id: USER.id, username: USER.username },
    updatedAt: '2026-10-20T10:00:00.000Z',
    stats: { pending: 1, succeeded24h: 12, failed24h: 2 },
    ...over,
  };
}

function delivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: D1,
    subscriptionId: ID,
    eventId: '33333333-3333-4333-8333-333333333333',
    eventType: 'job.failed',
    project: 'web',
    status: 'failed',
    test: false,
    attempts: 7,
    nextAttemptAt: null,
    lastStatusCode: 503,
    lastError: 'http_503',
    lastLatencyMs: 120,
    lastAttemptAt: '2026-10-23T09:10:00.000Z',
    createdAt: '2026-10-22T09:10:00.000Z',
    finishedAt: '2026-10-23T09:10:00.000Z',
    ...over,
  };
}

const CATALOG = {
  catalogVersion: 1,
  headers: { signature: 'x-remyral-signature', delivery: 'x-remyral-delivery' },
  groups: { job: ['job.created', 'job.failed'], deploy: ['deploy.succeeded'], fleet: ['worker.offline'] },
  events: [
    { type: 'job.created', description: 'x', global: false, subscribable: true, example: {} },
    { type: 'job.failed', description: 'x', global: false, subscribable: true, example: {} },
    { type: 'deploy.succeeded', description: 'x', global: false, subscribable: true, example: {} },
    { type: 'worker.offline', description: 'x', global: true, subscribable: true, example: {} },
  ],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/projects': ok({
      items: [
        {
          id: 'web',
          name: 'web',
          kind: 'repository',
          createdAt: '2026-10-01T00:00:00.000Z',
          createdBy: null,
          members: 1,
          myRole: 'owner',
        },
      ],
    }),
    'GET /api/webhooks': ok({ items: [hook()], maxAttempts: 7 }),
    'GET /api/webhooks/catalog': ok(CATALOG),
    'GET /api/webhooks/settings': ok({ internalOrigins: [], updatedAt: null, updatedBy: null }),
    'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
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

describe('Ayarlar → Webhook’lar', () => {
  it('lists webhooks; creates one after a code and shows the secret once', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    let created: unknown = null;
    const { requests } = renderApp({
      path: '/settings/webhooks',
      initialState: owner,
      routes: routes({
        'POST /api/webhooks': (req) => {
          attempts += 1;
          if (attempts === 1)
            return {
              status: 403,
              body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
            };
          created = req.body;
          return { status: 201, body: { webhook: hook({ id: 'new', name: 'CI' }), secret: SECRET } };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Webhook’lar' })).toBeTruthy();
    const row = within(await screen.findByTestId('webhook-list')).getByTestId('webhook-row');
    expect(row.textContent).toContain('https://n8n.example.com/webhook/remyral');
    expect(row.textContent).toContain('Son 24 saat: 12 başarılı · 2 başarısız · 1 bekliyor');
    expect(row.textContent).toContain('Başlıklar: Authorization');
    expect(row.textContent).not.toContain('Bearer');

    const form = screen.getByTestId('webhook-create');
    await user.type(within(form).getByLabelText('Ad'), 'CI');
    await user.type(within(form).getByLabelText('Hedef adres (https://)'), 'https://ci.example.com/hook');
    await user.click(within(form).getByTestId('webhook-event-job.failed'));
    await user.click(within(form).getByTestId('webhook-add-header'));
    await user.type(within(form).getByLabelText('Başlık adı'), 'X-Api-Key');
    await user.type(within(form).getByLabelText('Değer'), 'k-123');
    await user.click(within(form).getByLabelText('Gizli'));
    await user.click(within(form).getByTestId('webhook-submit'));
    await confirmCode(user);
    const reveal = await screen.findByTestId('webhook-secret');
    expect(within(reveal).getByTestId('webhook-secret-value').textContent).toContain(SECRET);
    expect(reveal.textContent).toContain('bir daha gösterilmez');
    expect(created).toEqual({
      name: 'CI',
      url: 'https://ci.example.com/hook',
      project: null,
      eventTypes: ['job.failed'],
      includeDetails: false,
      headers: [{ name: 'X-Api-Key', value: 'k-123', secret: true }],
    });
    expect(
      requests.find((r) => r.url === '/api/webhooks' && r.method === 'POST')?.headers['x-csrf-token'],
    ).toBe('csrf-1');
    await user.click(within(reveal).getByTestId('webhook-secret-done'));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('a project webhook cannot pick global events; missing fields are said, not sent', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/settings/webhooks', initialState: owner, routes: routes() });
    const form = await screen.findByTestId('webhook-create');
    await user.click(within(form).getByTestId('webhook-submit'));
    expect(within(form).getByText('Bir ad yaz.')).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText('Proje'), 'web');
    const global = within(form).getByTestId<HTMLInputElement>('webhook-event-worker.offline');
    expect(global.disabled).toBe(true);
    expect(requests.some((r) => r.url === '/api/webhooks' && r.method === 'POST')).toBe(false);
  });

  it('test, pause, delete; resume asks for a code; reveal once for an assistant-made webhook', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const record =
      (name: string, body: unknown): Handler =>
      () => {
        calls.push(name);
        return { status: 200, body };
      };
    renderApp({
      path: '/settings/webhooks',
      initialState: owner,
      routes: routes({
        'GET /api/webhooks': ok({
          items: [
            hook(),
            hook({
              id: D1,
              name: 'chat-made',
              secretRevealed: false,
              state: 'disabled',
              consecutiveFailures: 15,
              disabledReason: 'consecutive_failures',
            }),
          ],
          maxAttempts: 7,
        }),
        [`POST /api/webhooks/${ID}/test`]: record('test', {
          delivery: delivery({ status: 'succeeded', test: true, lastStatusCode: 200, lastError: null }),
          attempts: [
            {
              attempt: 1,
              startedAt: '2026-10-23T09:00:00.000Z',
              latencyMs: 42,
              statusCode: 200,
              error: null,
              responseExcerpt: null,
            },
          ],
        }),
        [`POST /api/webhooks/${ID}/pause`]: record('pause', { webhook: hook({ state: 'paused' }) }),
        [`POST /api/webhooks/${D1}/resume`]: record('resume', { webhook: hook({ id: D1 }) }),
        [`POST /api/webhooks/${D1}/secret`]: record('reveal', { secret: SECRET }),
        [`DELETE /api/webhooks/${ID}`]: record('delete', { deleted: true }),
      }),
    });
    await screen.findByTestId('webhook-list');
    expect(screen.getByTestId('webhook-disabled').textContent).toContain('art arda 15');
    await user.click(screen.getByTestId(`webhook-test-${ID}`));
    expect((await screen.findByTestId('webhooks-done')).textContent).toContain('HTTP 200, 42 ms');
    await user.click(screen.getByTestId(`webhook-pause-${ID}`));
    await waitFor(() => {
      expect(calls).toContain('pause');
    });
    await user.click(screen.getByTestId(`webhook-resume-${D1}`));
    await waitFor(() => {
      expect(calls).toContain('resume');
    });
    await user.click(screen.getByTestId(`webhook-reveal-${D1}`));
    expect((await screen.findByTestId('webhook-secret-value')).textContent).toContain(SECRET);
    await user.click(screen.getByTestId('webhook-secret-done'));
    await user.click(screen.getByTestId(`webhook-delete-${ID}`));
    expect(calls).not.toContain('delete');
    await user.click(screen.getByTestId(`webhook-delete-${ID}-confirm`));
    await waitFor(() => {
      expect(calls).toContain('delete');
    });
  });

  it('rotates with an overlap; the new secret is shown once', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    renderApp({
      path: '/settings/webhooks',
      initialState: owner,
      routes: routes({
        [`POST /api/webhooks/${ID}/rotate`]: (req) => {
          body = req.body;
          return {
            status: 200,
            body: { webhook: hook({ previousValidUntil: '2026-10-24T09:00:00.000Z' }), secret: SECRET },
          };
        },
      }),
    });
    await user.click(await screen.findByTestId(`webhook-rotate-${ID}`));
    const dialog = await screen.findByTestId('webhook-rotate-dialog');
    await user.selectOptions(within(dialog).getByLabelText('Eski anahtar ne kadar daha imzalasın'), '72');
    await user.click(within(dialog).getByTestId('webhook-rotate-go'));
    expect(await screen.findByTestId('webhook-secret')).toBeTruthy();
    expect(body).toEqual({ overlapHours: 72 });
  });

  it('the delivery log shows attempts, codes and errors and redelivers', async () => {
    const user = userEvent.setup();
    let redelivered = 0;
    renderApp({
      path: '/settings/webhooks',
      initialState: owner,
      routes: routes({
        [`GET /api/webhooks/${ID}/deliveries`]: ok({ items: [delivery()], nextCursor: null }),
        [`GET /api/webhooks/${ID}/deliveries/${D1}`]: ok({
          delivery: delivery(),
          attempts: [
            {
              attempt: 1,
              startedAt: '2026-10-22T09:10:00.000Z',
              latencyMs: 120,
              statusCode: 503,
              error: 'http_503',
              responseExcerpt: 'busy',
            },
          ],
          body: '{"id":"x","type":"job.failed"}',
        }),
        [`POST /api/webhooks/${ID}/deliveries/${D1}/redeliver`]: () => {
          redelivered += 1;
          return { status: 200, body: { delivery: delivery({ status: 'pending', finishedAt: null }) } };
        },
      }),
    });
    await user.click(await screen.findByTestId(`webhook-log-${ID}`));
    const log = await screen.findByTestId('webhook-deliveries');
    const row = await within(log).findByTestId('webhook-delivery-row');
    expect(row.textContent).toContain('İş başarısız oldu');
    expect(row.textContent).toContain('7 deneme');
    expect(row.textContent).toContain('HTTP 503');
    expect(row.textContent).toContain('120 ms');
    await user.click(within(row).getByTestId(`webhook-delivery-details-${D1}`));
    const detail = await screen.findByTestId('webhook-delivery-detail');
    expect(detail.textContent).toContain('busy');
    expect(detail.textContent).toContain('"type": "job.failed"');
    await user.click(within(row).getByTestId(`webhook-redeliver-${D1}`));
    expect((await screen.findByTestId('webhook-deliveries-done')).textContent).toContain('sıraya alındı');
    expect(redelivered).toBe(1);
  });

  it('internal targets: the owner saves exact origins after a code; an admin only reads them', async () => {
    const user = userEvent.setup();
    let saved: unknown = null;
    const first = renderApp({
      path: '/settings/webhooks',
      initialState: owner,
      routes: routes({
        'PUT /api/webhooks/settings': (req) => {
          saved = req.body;
          return {
            status: 200,
            body: { internalOrigins: ['https://n8n.lan:8443'], updatedAt: null, updatedBy: null },
          };
        },
      }),
    });
    const panel = await screen.findByTestId('webhook-internal');
    await user.type(within(panel).getByLabelText('Kaynaklar (her satıra bir tane)'), 'https://n8n.lan:8443');
    await user.click(within(panel).getByTestId('webhook-internal-save'));
    await waitFor(() => {
      expect(saved).toEqual({ internalOrigins: ['https://n8n.lan:8443'] });
    });
    first.unmount();
    renderApp({
      path: '/settings/webhooks',
      initialState: admin,
      routes: routes({
        'GET /api/auth/session': ok({
          ...(sessionBody() as Record<string, unknown>),
          user: { ...USER, role: 'admin' },
        }),
        'GET /api/webhooks/settings': ok({
          internalOrigins: ['https://n8n.lan:8443'],
          updatedAt: null,
          updatedBy: null,
        }),
      }),
    });
    const ro = await screen.findByTestId('webhook-internal');
    expect(ro.textContent).toContain('https://n8n.lan:8443');
    expect(within(ro).queryByTestId('webhook-internal-save')).toBeNull();
  });
});

describe('webhook helpers, the API page section and the chat card', () => {
  const t = messagesFor('tr');

  it('labels events and error codes', () => {
    expect(eventLabel(t.webhooks, 'deploy.succeeded')).toBe('Deploy yayında');
    expect(eventLabel(t.webhooks, 'job.unknown')).toBe('job.unknown');
    expect(errorText(t.webhooks, 'http_502')).toBe('HTTP 502');
    expect(errorText(t.webhooks, 'timeout')).toContain('zaman aşımı');
  });

  it('reads the OpenAPI webhooks into the catalog section', () => {
    const doc = {
      webhooks: {
        'job.failed': {
          post: {
            summary: 'A job failed.',
            requestBody: {
              content: { 'application/json': { example: { catalogVersion: 1, project: 'web', data: {} } } },
            },
          },
        },
        'worker.online': {
          post: {
            summary: 'A machine connected.',
            requestBody: {
              content: { 'application/json': { example: { catalogVersion: 1, project: null } } },
            },
          },
        },
      },
    };
    const out = parseDocWebhooks(doc);
    expect(out.version).toBe(1);
    expect(out.events.map((e) => [e.type, e.global])).toEqual([
      ['job.failed', false],
      ['worker.online', true],
    ]);
    expect(parseDocWebhooks({}).events).toEqual([]);
  });

  it('the draft_webhook card names the action, the target origin, the events and the secret note', () => {
    expect(draftKindText('webhook', t)).toBe('Webhook');
    const f = { dateTime: (x: string) => x } as unknown as Parameters<typeof summarizeDraft>[2];
    const s = summarizeDraft(
      {
        id: 'd1',
        kind: 'webhook',
        state: 'proposed',
        payload: {
          op: 'create',
          name: 'n8n',
          url: 'https://n8n.example.com/webhook/secret-path',
          eventTypes: ['job.failed'],
          project: null,
          includeDetails: false,
        },
      } as unknown as ChatDraft,
      t,
      f,
    );
    expect(s.key.map((x) => x.v)).toEqual(['Oluştur', 'n8n', 'https://n8n.example.com', '—', 'kapalı']);
    expect(s.details.map((x) => x.v)).toEqual(['İş başarısız oldu (yeniden deneme kalmadı)']);
    expect(s.warnings[0]?.text).toContain('sohbetten hiç geçmez');
  });
});
