// p16-api-tokens (docs/design/p16-api-tokens.md §8): Ayarlar → API anahtarları, Servis hesapları, API and the
// security policy's API tokens tab — same requests and step-up as the master expects; the secret is shown once.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { curlExample, daysLeft } from '../src/api/apiTokens';
import type { AuthState } from '../src/auth/AuthProvider';
import { cidrLines, lifetimeChoices } from '../src/diyalog/screens/settings/api-tokens-parts';
import { curlFor, filterOperations, parseOpenApi } from '../src/diyalog/screens/settings/ApiDocsView';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'viewer' },
  session: null,
  remainingRecoveryCodes: null,
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

const DAY = 24 * 60 * 60_000;
const SECRET = `ryl_pat_${'A'.repeat(40)}ABCDEF`;

function token(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'personal',
    principal: { id: USER.id, username: USER.username, role: 'owner' },
    name: 'CI read',
    scopes: ['read'],
    grantedEvents: [],
    allowedCidrs: [],
    hint: 'ryl_pat_AbCd…wxyz',
    expiresAt: new Date(Date.now() + 60 * DAY).toISOString(),
    createdAt: new Date(Date.now() - DAY).toISOString(),
    createdBy: { id: USER.id, username: USER.username },
    rotatedAt: null,
    previousValidUntil: null,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
    lastUsedIp: '203.0.113.7',
    useCount: 12,
    state: 'active',
    ...over,
  };
}

const RULES = {
  personal: true,
  maxDays: 365,
  defaultDays: 90,
  eventGrants: false,
  scopes: ['read', 'jobs:write', 'approvals', 'deploy', 'admin'],
  grantableEvents: [],
  maxCidrs: 16,
  maxOverlapMinutes: 1440,
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

describe('API token helpers', () => {
  it('lifetimes, IP lines, days left and the curl line', () => {
    expect(lifetimeChoices(90)).toEqual([7, 30, 90]);
    expect(lifetimeChoices(45)).toEqual([7, 30, 45]);
    expect(cidrLines('203.0.113.0/24\n\n 10.0.0.1 , 2001:db8::/32')).toEqual([
      '203.0.113.0/24',
      '10.0.0.1',
      '2001:db8::/32',
    ]);
    expect(daysLeft(new Date(Date.now() + 2.5 * DAY).toISOString())).toBe(3);
    expect(curlExample('https://x.test', 'ryl_pat_x')).toBe(
      'curl -H "Authorization: Bearer ryl_pat_x" https://x.test/api/jobs?limit=5',
    );
  });
});

describe('Ayarlar → API anahtarları', () => {
  it('lists tokens with use, expiry warning and scopes; creates one after a code and shows the secret once', async () => {
    const user = userEvent.setup();
    let created: unknown = null;
    let attempts = 0;
    const soon = token({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Deploy bot',
      scopes: ['read', 'deploy'],
      expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
    });
    const { requests } = renderApp({
      path: '/settings/api-tokens',
      initialState: owner,
      routes: routes({
        'GET /api/me/api-tokens': ok({ items: [token(), soon], rules: RULES }),
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
        'POST /api/me/api-tokens': (req) => {
          attempts += 1;
          if (attempts === 1)
            return {
              status: 403,
              body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
            };
          created = req.body;
          return {
            status: 201,
            body: {
              token: token({ id: '33333333-3333-4333-8333-333333333333', name: 'GitHub Actions' }),
              secret: SECRET,
            },
          };
        },
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'API anahtarları' })).toBeTruthy();
    const list = await screen.findByTestId('api-token-list');
    const rows = within(list).getAllByTestId('api-token-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('ryl_pat_AbCd…wxyz');
    expect(rows[0]?.textContent).toContain('203.0.113.7');
    expect(rows[0]?.textContent).toContain('12 istek');
    expect(rows[1]?.textContent).toContain('3 gün içinde bitiyor');
    expect(rows[1]?.textContent).toContain('Deploy');

    const form = screen.getByTestId('api-token-create');
    await user.type(within(form).getByLabelText('Ad'), 'GitHub Actions');
    await user.click(within(form).getByTestId('api-token-scope-jobs:write'));
    await user.type(within(form).getByLabelText(/IP aralıkları/), '203.0.113.0/24');
    await user.click(within(form).getByTestId('api-token-submit'));
    await confirmCode(user);
    const reveal = await screen.findByTestId('api-token-secret');
    expect(within(reveal).getByTestId('api-token-secret-value').textContent).toContain(SECRET);
    expect(reveal.textContent).toContain('bir daha gösterilmez');
    expect(created).toEqual({
      name: 'GitHub Actions',
      scopes: ['read', 'jobs:write'],
      expiresInDays: 90,
      allowedCidrs: ['203.0.113.0/24'],
    });
    expect(
      requests.find((r) => r.url === '/api/me/api-tokens' && r.method === 'POST')?.headers['x-csrf-token'],
    ).toBe('csrf-1');
    await user.click(within(reveal).getByTestId('api-token-secret-done'));
    expect(screen.queryByTestId('api-token-secret')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('rotates with an overlap (new secret shown) and revokes after a confirmation', async () => {
    const user = userEvent.setup();
    let rotateBody: unknown = null;
    let revoked = 0;
    const id = '11111111-1111-4111-8111-111111111111';
    renderApp({
      path: '/settings/api-tokens',
      initialState: owner,
      routes: routes({
        'GET /api/me/api-tokens': ok({ items: [token()], rules: RULES }),
        [`POST /api/me/api-tokens/${id}/rotate`]: (req) => {
          rotateBody = req.body;
          return {
            status: 200,
            body: {
              token: token({ previousValidUntil: new Date(Date.now() + 3_600_000).toISOString() }),
              secret: SECRET,
            },
          };
        },
        [`DELETE /api/me/api-tokens/${id}`]: () => {
          revoked += 1;
          return {
            status: 200,
            body: { token: token({ state: 'revoked', revokedAt: new Date().toISOString() }) },
          };
        },
      }),
    });
    await screen.findByTestId('api-token-list');
    await user.click(screen.getByTestId(`api-token-rotate-${id}`));
    const dialog = await screen.findByTestId('api-token-rotate-dialog');
    await user.selectOptions(within(dialog).getByLabelText('Eski token ne kadar daha çalışsın'), '240');
    await user.click(within(dialog).getByTestId('api-token-rotate-go'));
    expect(await screen.findByTestId('api-token-secret')).toBeTruthy();
    expect(rotateBody).toEqual({ overlapMinutes: 240 });
    await user.click(screen.getByTestId('api-token-secret-done'));
    await user.click(screen.getByTestId(`api-token-revoke-${id}`));
    expect(revoked).toBe(0);
    await user.click(screen.getByTestId(`api-token-revoke-${id}-confirm`));
    await waitFor(() => {
      expect(revoked).toBe(1);
    });
    expect(await screen.findByTestId('api-tokens-done')).toBeTruthy();
  });

  it('says so when the security policy switched personal tokens off', async () => {
    renderApp({
      path: '/settings/api-tokens',
      initialState: viewer,
      routes: routes({
        'GET /api/auth/session': ok({
          ...(sessionBody() as Record<string, unknown>),
          user: { ...USER, role: 'viewer' },
        }),
        'GET /api/me/api-tokens': ok({ items: [], rules: { ...RULES, personal: false, scopes: ['read'] } }),
      }),
    });
    expect(await screen.findByTestId('api-tokens-disabled')).toBeTruthy();
    expect(screen.queryByTestId('api-token-create')).toBeNull();
    expect(screen.getByTestId('api-tokens-empty')).toBeTruthy();
  });
});

describe('Ayarlar → Servis hesapları', () => {
  const SA_ID = '44444444-4444-4444-8444-444444444444';
  const account = {
    id: SA_ID,
    name: 'ci-bot',
    role: 'operator',
    description: 'GitHub Actions deploy pipeline',
    disabled: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    createdBy: { id: USER.id, username: USER.username },
    memberships: [],
    tokens: [
      token({
        kind: 'service',
        name: 'pipeline',
        hint: 'ryl_sa_XyZw…1234',
        principal: { id: SA_ID, username: 'ci-bot', role: 'operator' },
      }),
    ],
  };

  it('creates an account after a code, adds a membership, issues a token once and disables the account', async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string; body: unknown }[] = [];
    const record: (status: number, body: unknown) => Handler = (status, body) => (req) => {
      calls.push({ url: req.url, method: req.method, body: req.body });
      return { status, body };
    };
    renderApp({
      path: '/settings/service-accounts',
      initialState: owner,
      routes: routes({
        'GET /api/service-accounts': ok({ items: [account], rules: RULES }),
        'GET /api/api-tokens?kind=personal': ok({ items: [token()] }),
        'POST /api/service-accounts': record(201, {
          ...account,
          id: '55555555-5555-4555-8555-555555555555',
          name: 'nightly',
        }),
        'PUT /api/projects/web/members': record(200, { items: [] }),
        [`POST /api/service-accounts/${SA_ID}/tokens`]: record(201, {
          token: token({ kind: 'service', name: 'deploy' }),
          secret: `ryl_sa_${'B'.repeat(40)}ABCDEF`,
        }),
        [`PATCH /api/service-accounts/${SA_ID}`]: record(200, { ...account, disabled: true }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Servis hesapları' })).toBeTruthy();
    const panel = await screen.findByTestId('service-account-ci-bot');
    expect(panel.textContent).toContain('GitHub Actions deploy pipeline');
    expect(within(panel).getByTestId('api-token-row').textContent).toContain('ryl_sa_XyZw…1234');
    // Every personal token, for admins.
    expect(
      within(await screen.findByTestId('all-personal-tokens')).getAllByTestId('api-token-row'),
    ).toHaveLength(1);

    const create = screen.getByTestId('service-account-create');
    await user.type(within(create).getByLabelText('Hesap adı'), 'Nightly');
    await user.click(within(create).getByRole('button', { name: 'Servis hesabı oluştur' }));
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/service-accounts')?.body).toEqual({
        name: 'nightly',
        role: 'operator',
      });
    });

    await user.click(within(panel).getByTestId('service-account-add-member-ci-bot'));
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/projects/web/members')?.body).toEqual({
        userId: SA_ID,
        role: 'viewer',
      });
    });

    const details = within(panel).getByTestId('service-account-new-token-ci-bot');
    await user.click(within(details).getByText('Token oluştur'));
    const form = within(details).getByTestId('service-token-create-ci-bot');
    await user.type(within(form).getByLabelText('Ad'), 'deploy');
    await user.click(within(form).getByTestId('api-token-submit'));
    const reveal = await screen.findByTestId('api-token-secret');
    expect(reveal.textContent).toContain(`ryl_sa_${'B'.repeat(40)}ABCDEF`);
    expect(calls.find((c) => c.url === `/api/service-accounts/${SA_ID}/tokens`)?.body).toEqual({
      name: 'deploy',
      scopes: ['read'],
      expiresInDays: 90,
    });

    await user.click(within(panel).getByTestId('service-account-disable-ci-bot'));
    await user.click(within(panel).getByTestId('service-account-disable-ci-bot-confirm'));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ disabled: true });
    });
  });
});

const DOC = {
  openapi: '3.1.0',
  info: { title: 'Remyral master API', version: '1.2.3' },
  tags: [
    { name: 'jobs', description: 'Create, list, read, cancel and steer agent jobs.' },
    { name: 'audit', description: 'The audit log.' },
  ],
  paths: {
    '/jobs': {
      post: {
        summary: 'Create and submit a job',
        tags: ['jobs'],
        'x-token-scope': 'jobs:write',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['project', 'spec'],
                properties: {
                  project: { type: 'string', description: 'The project id' },
                  spec: { type: 'object' },
                },
              },
              examples: {
                fixBug: { summary: 'Fix a bug', value: { project: 'web', spec: { prompt: 'fix it' } } },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { type: 'object', properties: { job: { type: 'object' } } } },
            },
          },
        },
      },
      get: {
        summary: 'List jobs',
        tags: ['jobs'],
        'x-token-scope': 'read',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
    '/audit': {
      get: {
        summary: 'Search the audit log',
        tags: ['audit'],
        'x-token-scope': 'admin',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/me/api-tokens': {
      get: {
        summary: 'Your API tokens',
        tags: ['api-tokens'],
        'x-token-scope': 'none',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

describe('Ayarlar → API (OpenAPI viewer)', () => {
  it('parses, filters and builds curl lines', () => {
    const doc = parseOpenApi(DOC);
    expect(doc.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      'GET /jobs',
      'POST /jobs',
      'GET /audit',
      'GET /me/api-tokens',
    ]);
    expect(filterOperations(doc.operations, 'audit')).toHaveLength(1);
    expect(filterOperations(doc.operations, 'post')).toHaveLength(1);
    const create = doc.operations[1];
    if (create === undefined) throw new Error('no operation');
    expect(curlFor('https://x.test', create)).toContain(`-d '{"project":"web","spec":{"prompt":"fix it"}}'`);
    expect(curlFor('https://x.test', create)).toContain('"https://x.test/api/jobs"');
  });

  it('renders tags, scopes, schemas and examples; the search opens matching groups', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/api',
      initialState: viewer,
      routes: routes({
        'GET /api/auth/session': ok({
          ...(sessionBody() as Record<string, unknown>),
          user: { ...USER, role: 'viewer' },
        }),
        'GET /api/openapi.json': ok(DOC),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'API' })).toBeTruthy();
    expect((await screen.findByTestId('api-doc-quickstart')).textContent).toContain(
      'Authorization: Bearer $REMYRAL_TOKEN',
    );
    expect(screen.getByTestId('api-doc-count').textContent).toBe('4 uç nokta');
    await user.type(screen.getByLabelText('Uç nokta ara'), 'jobs');
    const group = await screen.findByTestId('api-doc-tag-jobs');
    const ops = within(group).getAllByTestId('api-doc-operation');
    expect(ops).toHaveLength(2);
    const post = ops[1] as HTMLElement;
    expect(post.textContent).toContain('Yetki: İş yazma');
    expect(ops[0]?.textContent).toContain('Yetki: Okuma');
    await user.click(within(post).getByText('/jobs'));
    expect(await within(post).findByText('The project id')).toBeTruthy();
    expect(post.textContent).toContain('zorunlu');
    expect(post.textContent).toContain('"prompt": "fix it"');
    await user.clear(screen.getByLabelText('Uç nokta ara'));
    await user.type(screen.getByLabelText('Uç nokta ara'), 'api-tokens');
    const tokens = await screen.findByTestId('api-doc-tag-api-tokens');
    expect(tokens.textContent).toContain('Yalnızca konsol');
  });
});

describe('Ayarlar → Güvenlik → API anahtarları', () => {
  it('sends only what changed (event grants on)', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    const view = {
      version: 3,
      document: { preset: 'serbest' },
      effective: {
        preset: 'serbest',
        customized: false,
        stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
        events: { 'security.policy': true, 'api.tokens': true },
        autonomy: {
          newProjectsHostExecution: true,
          newProjectsAutoApprove: true,
          jobApproval: 'allow-all',
          autoApprove: {},
          chatDirect: true,
          maxJobMinutes: 10080,
          autoMode: true,
          autoRetryMax: 3,
        },
        apiTokens: { personal: true, maxDays: 365, eventGrants: false },
      },
      updatedAt: null,
      updatedBy: null,
      catalog: { events: [] },
    };
    renderApp({
      path: '/settings/security?tab=tokens',
      initialState: owner,
      routes: routes({
        'GET /api/security/policy': ok(view),
        'PUT /api/security/policy': (req) => {
          body = req.body;
          return {
            status: 200,
            body: {
              ...view,
              version: 4,
              effective: {
                ...view.effective,
                apiTokens: { personal: true, maxDays: 365, eventGrants: true },
              },
              changed: ['apiTokens.eventGrants'],
            },
          };
        },
      }),
    });
    const panel = await screen.findByTestId('security-api-tokens');
    await user.click(within(panel).getByTestId('tokens-grants'));
    await user.click(await screen.findByRole('button', { name: /^Kaydet/ }));
    await waitFor(() => {
      expect(body).toEqual({ apiTokens: { eventGrants: true }, expectedVersion: 3 });
    });
  });
});
