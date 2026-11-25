import { afterAll, beforeAll, expect, it } from 'vitest';
import { ALWAYS_FRESH_ROUTES } from '../../src/auth/step-up.js';
import { isAction } from '../../src/authz/model.js';
import { eventForRoute } from '../../src/security-policy/events.js';
import { scopeForAction, TOKEN_SCOPES } from '../../src/api-tokens/scopes.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, Harness } from '../helpers/harness.js';

/**
 * P1 gate (ADR-0009 "Verification"): every registered route except the health checks and the login steps
 * requires a full (password + TOTP) session. The allowlists below are the complete set of exceptions
 * (DEVICE: the worker WebSocket, authenticated by the device key instead of a human session);
 * adding a route that is reachable without a full session must fail this test.
 *
 * P5 gate (p5-rbac-api): every full-session route also declares an authorization rule (`config.authz`)
 * naming a catalogued action; the per-role behaviour of every declared route is checked by
 * rbac-matrix.test.ts. Routes that authenticate differently (worker device auth) are in DEVICE.
 */
/** `GET /status`: the public uptime probe (p1-monitoring) — cached, answers only ok/unavailable. */
const PUBLIC = new Set([
  'GET /healthz',
  'HEAD /healthz',
  'GET /readyz',
  'HEAD /readyz',
  'GET /status',
  'HEAD /status',
  'POST /auth/login',
  // p5-remember-device: which login options (remember me, trusted devices) are enabled; static config.
  'GET /auth/options',
  'HEAD /auth/options',
  // p16-api-tokens: the OpenAPI document (schemas and descriptions only; openapi.test.ts checks it holds no secret).
  'GET /openapi.json',
  'HEAD /openapi.json',
  // p16-selfhost-onboarding: first-owner setup while no account exists (the owner route needs the one-time token).
  'GET /setup/status',
  'HEAD /setup/status',
  'POST /setup/owner',
]);
const MFA_PENDING = new Set(['POST /auth/totp/verify', 'POST /auth/recovery']);
const ENROLLMENT = new Set(['POST /auth/totp/enroll/start', 'POST /auth/totp/enroll/confirm']);
/** p5-self-password: an account with a temporary password can only replace it. */
const PASSWORD_CHANGE = new Set(['POST /auth/password/initial']);
/**
 * Device-authenticated routes (route auth level `device`, ADR-0005): the worker WebSocket. It is not
 * reachable with a human session and does not need one — the device proves possession of its Ed25519 key
 * in-band (HELLO → CHALLENGE → AUTH) and an unauthenticated socket can send nothing but HELLO/AUTH
 * (test/integration/worker-gateway.test.ts). A plain HTTP request gets 426 and no data.
 */
const DEVICE = new Set(['GET /v1/worker']);
/**
 * p2-signed-updates: release downloads for workers (route auth level `device`). Authenticated by the
 * single-worker, single-release, short-lived bearer token the master sent over the worker's authenticated
 * WebSocket (test/integration/releases.test.ts); without it: 401 and no data.
 */
const WORKER_TOKEN = new Set([
  'GET /v1/worker/releases/:version/manifest',
  'GET /v1/worker/releases/:version/artifact',
  // p17-object-storage: a large output's bytes, with the one-time bearer token of the master's upload grant (bound to
  // one attempt, one key, one size + SHA-256; object-storage.test.ts). Without it: 401, nothing is written.
  'PUT /v1/worker/blobs/:id',
  'PUT /v1/worker/blobs/:id/:n',
  // p19-ide W3: an IDE start's VSIX blobs and the owner's synced settings, with that start's bearer download token
  // (this worker, these blobs, 30 minutes; ide-extensions.test.ts). Without it: 401, nothing is served.
  'GET /v1/worker/ide/extensions/:sha256',
  'GET /v1/worker/ide/settings/:workspaceId',
]);
/**
 * p17-object-storage: a time-limited, revocable share link of one output (route auth level `public`). Authenticated by
 * the 256-bit token in the path (only its SHA-256 is stored), rate-limited per IP, audited; an unknown token → 404,
 * an expired / revoked link or a removed file → 410 (object-storage.test.ts).
 */
const SHARE = new Set(['GET /share/f/:token']);

/**
 * p5-worker-onboarding: anonymous installer downloads for a machine that has no credential yet (route auth
 * level `public`). They serve only release-key-signed kits, their signed index and bootstrap scripts that
 * contain no secret and verify the kit's SHA-256 (test/integration/installers.test.ts); with nothing
 * uploaded (as here) every request is a 404.
 */
const INSTALLER = new Set([
  'GET /v1/worker/install/:version/:os/:file',
  'GET /v1/worker/install/:version/:file',
]);

/**
 * p5-sandbox-ops: the master's lease-signing *public* keys, for the privileged prepare helper on a worker machine
 * (it verifies the signed sandbox.prepare command itself). Public key material only; answers 200 without a session.
 */
const LEASE_KEYS = new Set(['GET /v1/worker/lease-keys']);

/**
 * p6-automations (ADR-0024): inbound automation triggers. Public by design and authenticated by a signature over
 * the raw body — the GitHub App's webhook secret, or the automation's own HMAC secret with timestamp + nonce
 * (test/integration/automations.test.ts). Unsigned: no App connected → 503, unknown automation → 404; never data.
 * p14-workflow-engine 14.2: a workflow's webhook wait — a 256-bit capability token, plus the workflow webhook
 * trigger's signature unless token-only (test/integration/workflow-integrations.test.ts); unknown token → 404.
 */
const HOOKS = new Set(['POST /v1/hooks/github', 'POST /v1/hooks/:id', 'POST /v1/hooks/wait/:token']);

/**
 * p5-coolify-sso (docs/design/p5-coolify-sso.md): routes at hook level `public` because they must answer
 * with OAuth error bodies or redirects; each authenticates in its handler — discovery/JWKS are public
 * metadata; authorize/resume need a full console session of an owner/admin with a fresh step-up; token
 * needs the client secret; userinfo a bearer token; forward-auth/callback the gate cookie / a one-time
 * ticket bound to a state cookie; ticket a full console session. Every refusal is tested in
 * coolify-sso.test.ts. Unconfigured (as here) they all answer 404.
 */
const SSO = new Set([
  'GET /oidc/.well-known/openid-configuration',
  'GET /oidc/jwks',
  'GET /oidc/authorize',
  'GET /oidc/authorize/resume',
  'POST /oidc/token',
  'GET /oidc/userinfo',
  'POST /oidc/userinfo',
  'GET /forward-auth/coolify',
  'GET /coolify-sso/ticket',
  'GET /coolify-sso/callback',
]);

/**
 * p19-ide W2 (ADR-0066): the IDE origin (`ide.<domain>`). Public at hook level and host-gated: they answer only on the
 * IDE_ORIGIN host (404 elsewhere, and 404 for every route when it is not configured — as here). `/_ide/enter` redeems
 * a one-time ticket the console issued to a full session (ide.use); `/w/:id/*` needs the IDE origin's own cookie
 * session bound to that console session (test/unit/ide-proxy.test.ts, test/integration/ide.test.ts).
 */
const IDE = new Set([
  'GET /_ide/enter',
  'HEAD /_ide/enter',
  'GET /w/:id',
  'HEAD /w/:id',
  'GET /w/:id/*',
  'HEAD /w/:id/*',
]);

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

let h: Harness;
const PW = 'quartz-meadow-lantern-7';

describeIntegration('route authentication coverage (integration)', () => {
  let pending: Client;
  let enrolling: Client;
  let changing: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    // A user with TOTP enrolled, stopped after the password step.
    await h.createUser('covered', PW);
    const { enroll } = await import('../helpers/harness.js');
    await enroll(h, 'covered', PW);
    h.clock.advance(30_000);
    pending = h.client();
    expect((await pending.req('POST', '/auth/login', { username: 'covered', password: PW })).statusCode).toBe(
      200,
    );
    // A user without TOTP, stopped at the enrollment step.
    await h.createUser('fresh', PW);
    enrolling = h.client();
    expect((await enrolling.req('POST', '/auth/login', { username: 'fresh', password: PW })).statusCode).toBe(
      200,
    );
    // A user with a temporary password, stopped at the forced password change.
    await h.createUser('temporary', PW);
    const { secret } = await enroll(h, 'temporary', PW);
    await h.db.pool.query("UPDATE users SET password_change_required = true WHERE username = 'temporary'");
    h.clock.advance(30_000);
    changing = h.client();
    await changing.req('POST', '/auth/login', { username: 'temporary', password: PW });
    const verified = await changing.req('POST', '/auth/totp/verify', { code: h.code(secret) });
    expect(verified.json()).toMatchObject({ status: 'password_change_required' });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('every full-session route declares an authorization rule with a catalogued action', () => {
    const missing: string[] = [];
    for (const r of h.app.registeredRoutes) {
      const key = `${r.method} ${r.url}`;
      if (r.auth !== undefined && r.auth !== 'full') {
        // Only the explicit allowlists may be reachable before a full session.
        expect(
          [
            ...PUBLIC,
            ...SSO,
            ...IDE,
            ...DEVICE,
            ...WORKER_TOKEN,
            ...SHARE,
            ...INSTALLER,
            ...LEASE_KEYS,
            ...HOOKS,
            ...MFA_PENDING,
            ...ENROLLMENT,
            ...PASSWORD_CHANGE,
          ],
          `${key} declares auth=${r.auth}`,
        ).toContain(key);
        continue;
      }
      if (r.action === undefined || !isAction(r.action)) missing.push(`${key} (${String(r.action)})`);
    }
    expect(missing, 'routes without a valid config.authz declaration').toEqual([]);
  });

  it('p16-api-tokens: every full-session route declares its token scope (a scope, or session only)', () => {
    const undeclared: string[] = [];
    const sessionOnly: string[] = [];
    for (const r of h.app.registeredRoutes) {
      const key = `${r.method} ${r.url}`;
      if (r.auth !== undefined && r.auth !== 'full') {
        expect(r.tokenScope, `${key} is not a full-session route`).toBeUndefined();
        continue;
      }
      if (r.tokenScope === undefined) undeclared.push(key);
      else if (r.tokenScope === null) sessionOnly.push(key);
      else expect(TOKEN_SCOPES, key).toContain(r.tokenScope);
      // The registry agrees with the scope table (SSE streams are session only whatever their action).
      const expected = r.rateClass === 'stream' ? null : scopeForAction(r.action);
      expect(r.tokenScope, key).toBe(expected);
    }
    expect(undeclared).toEqual([]);
    // A token never reaches the token, service-account, user-management or security-policy writes, nor the chat.
    for (const k of [
      'GET /me/api-tokens',
      'POST /me/api-tokens',
      'POST /me/api-tokens/:id/rotate',
      'DELETE /me/api-tokens/:id',
      'GET /api-tokens',
      'DELETE /api-tokens/:id',
      'POST /service-accounts',
      'POST /service-accounts/:id/tokens',
      'POST /users',
      'PUT /security/policy',
      'POST /auth/logout',
      'GET /jobs/:id/stream',
    ]) {
      expect(sessionOnly, k).toContain(k);
    }
    const scopeOf = (k: string) =>
      h.app.registeredRoutes.find((r) => `${r.method} ${r.url}` === k)?.tokenScope;
    expect(scopeOf('POST /jobs')).toBe('jobs:write');
    expect(scopeOf('GET /jobs/:id')).toBe('read');
    expect(scopeOf('POST /approvals/:id/approve')).toBe('approvals');
    expect(scopeOf('POST /deploy/actions')).toBe('deploy');
    expect(scopeOf('GET /audit')).toBe('admin');
  });

  it('p5-stepup-window: the always-fresh step-up class is exactly the documented account-security list', () => {
    const fresh = h.app.registeredRoutes
      .filter((r) => r.stepUp === 'always-fresh')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(fresh).toEqual([...ALWAYS_FRESH_ROUTES].sort());
    // Every other step-up route follows the session's rule.
    const standard = h.app.registeredRoutes.filter((r) => r.stepUp === 'standard');
    expect(standard.length).toBeGreaterThan(10);
  });

  it('p15-autonomy: every route with a step-up check belongs to a security policy event (fail closed otherwise)', () => {
    const missing = h.app.registeredRoutes
      .filter((r) => r.stepUp !== undefined)
      .filter((r) => eventForRoute(r.method, r.url, r.action) === undefined)
      .map((r) => `${r.method} ${r.url} (${String(r.action)})`);
    expect(missing).toEqual([]);
    // The chat confirmation decides per card (no route-level step-up).
    expect(eventForRoute('POST', '/chat/drafts/:id/confirm', 'chat.use')).toBe('dynamic');
  });

  it('knows every route that exists', () => {
    const routes = h.app.registeredRoutes.map((r) => `${r.method} ${r.url}`);
    expect(routes.length).toBeGreaterThan(10);
    for (const r of [
      ...PUBLIC,
      ...SSO,
      ...IDE,
      ...DEVICE,
      ...WORKER_TOKEN,
      ...SHARE,
      ...INSTALLER,
      ...LEASE_KEYS,
      ...HOOKS,
      ...MFA_PENDING,
      ...ENROLLMENT,
      ...PASSWORD_CHANGE,
    ]) {
      expect(routes).toContain(r);
    }
  });

  it('rejects every non-allowlisted route without a full session', async () => {
    const checked: string[] = [];
    for (const route of h.app.registeredRoutes) {
      const key = `${route.method} ${route.url}`;
      if (PUBLIC.has(key)) continue;
      if (SSO.has(key)) {
        // Not configured in this harness: nothing to authenticate against, every SSO route is a 404.
        const anonymous = await h.client().req(route.method as Method, route.url);
        expect(anonymous.statusCode, `${key} unconfigured`).toBe(404);
        continue;
      }
      if (IDE.has(key)) {
        // Not configured in this harness: every IDE origin route is a 404 (also on the console host when it is).
        const anonymous = await h
          .client()
          .req(route.method as Method, route.url.replace(':id', 'x').replace('*', 'x'));
        expect(anonymous.statusCode, `${key} unconfigured`).toBe(404);
        continue;
      }
      if (DEVICE.has(key)) {
        const plain = await h.client().req(route.method as Method, route.url);
        expect(plain.statusCode, `${key} over plain HTTP`).toBe(426);
        continue;
      }
      if (INSTALLER.has(key)) {
        const url = route.url
          .replace(':version', '1.0.0')
          .replace(':os', 'linux')
          .replace(':file', 'index.json');
        const anonymous = await h.client().req(route.method as Method, url);
        expect(anonymous.statusCode, `${key} with nothing uploaded`).toBe(404);
        continue;
      }
      if (LEASE_KEYS.has(key)) {
        const anonymous = await h.client().req(route.method as Method, route.url);
        expect(anonymous.statusCode, `${key} anonymous`).toBe(200);
        const body = anonymous.json<{ keys: { kid: string; publicKey: string }[] }>();
        expect(Object.keys(body)).toEqual(['keys']);
        for (const k of body.keys) expect(Object.keys(k).sort()).toEqual(['kid', 'publicKey']);
        continue;
      }
      if (HOOKS.has(key)) {
        const url = route.url
          .replace(':id', '00000000-0000-4000-8000-000000000000')
          .replace(':token', 'A'.repeat(43));
        const unsigned = await h.client().req('POST', url, { any: 'thing' });
        expect(unsigned.statusCode, `${key} unsigned`).toBe(key === 'POST /v1/hooks/github' ? 503 : 404);
        expect(Object.keys(unsigned.json<Record<string, unknown>>()).sort()).toEqual(['error', 'message']);
        continue;
      }
      if (SHARE.has(key)) {
        const unknown = await h.client().req('GET', route.url.replace(':token', 'A'.repeat(43)));
        expect(unknown.statusCode, `${key} with an unknown token`).toBe(404);
        continue;
      }
      if (WORKER_TOKEN.has(key)) {
        const url = route.url.replace(':version', '1.0.0');
        const anonymous = await h.client().req(route.method as Method, url);
        expect(anonymous.statusCode, `${key} without a download token`).toBe(401);
        const forged = await h
          .client()
          .req(route.method as Method, url, undefined, { authorization: `Bearer ${'A'.repeat(43)}` });
        expect(forged.statusCode, `${key} with an unknown token`).toBe(401);
        continue;
      }
      const url = route.url.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x');
      const method = route.method as Method;
      const anonymous = await h
        .client()
        .req(method, url, method === 'GET' || method === 'HEAD' ? undefined : {});
      expect(anonymous.statusCode, `${key} without session`).toBe(401);
      for (const [label, client, allowed] of [
        ['mfa_pending', pending, MFA_PENDING],
        ['enrollment', enrolling, ENROLLMENT],
        ['password_change', changing, PASSWORD_CHANGE],
      ] as const) {
        if (allowed.has(key)) continue;
        const res = await client
          .clone()
          .req(method, url, method === 'GET' || method === 'HEAD' ? undefined : {});
        expect(res.statusCode, `${key} with ${label} session`).toBe(401);
      }
      checked.push(key);
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        'GET /auth/session',
        // p14-i18n-foundation: the caller's console language.
        'PUT /me/locale',
        'PUT /me/theme',
        // p20-decisions: the caller's put-off / ignored decisions.
        'GET /me/deferrals',
        'PUT /me/deferrals',
        'DELETE /me/deferrals',
        'POST /auth/logout',
        // p5-self-password.
        'POST /auth/password',
        'POST /auth/password/initial',
        // p5-remember-device.
        'GET /auth/devices',
        'DELETE /auth/devices/:id',
        'POST /auth/devices/revoke-all',
        // p5-notifications.
        'GET /notifications',
        'POST /notifications/:id/read',
        'POST /notifications/read-all',
        'GET /notifications/preferences',
        'PUT /notifications/preferences',
        // p8-pwa.
        'GET /notifications/push',
        'POST /notifications/push/subscriptions',
        'DELETE /notifications/push/subscriptions/:id',
        'POST /notifications/push/unsubscribe',
        'POST /notifications/push/test',
        // p4-approvals: every approval and policy route needs a full session.
        'GET /approvals',
        'GET /approvals/:id',
        'POST /approvals/:id/approve',
        'POST /approvals/:id/deny',
        // p22-output-delivery: the pending merge decisions of a project and their bulk approval.
        'GET /approvals/merge-batch',
        'POST /approvals/merge-batch',
        'GET /projects/:id/policy',
        'PUT /projects/:id/policy',
        // p6-context-model: every context route needs a full session.
        'GET /context/docs',
        'POST /context/docs',
        'GET /context/docs/:id',
        'GET /context/docs/:id/versions',
        'GET /context/docs/:id/versions/:version',
        'POST /context/docs/:id/versions',
        'POST /context/docs/:id/rollback',
        'PUT /context/docs/:id/access',
        'DELETE /context/docs/:id',
        'POST /context/purge',
        'GET /context/bundle',
        // p6-context-policy.
        'GET /context/policies',
        'PUT /context/policies',
        'GET /context/deletion-receipts',
        'GET /context/export',
        // p6-vector.
        'GET /context/search',
        'GET /context/search/settings',
        'PUT /context/search/settings',
        'POST /context/search/reindex',
        // p10-semantic-memory.
        'GET /memory-suggestions',
        'GET /memory-suggestions/settings',
        'PUT /memory-suggestions/settings',
        'POST /memory-suggestions/:id/accept',
        'POST /memory-suggestions/:id/dismiss',
        'POST /memory-suggestions/backfill',
        'GET /memory-suggestions/agent-prompt',
        // p10-chat-memory-suggestions.
        'GET /memory-suggestions/chat-prompt',
        // p17-auto-learning.
        'PUT /memory-suggestions/auto-learn',
        'POST /memory-suggestions/auto-learn/run',
        'POST /memory-suggestions/:id/undo',
        'POST /memory-suggestions/bulk',
        // p17-memory-import.
        'GET /memory-imports/options',
        'GET /memory-imports',
        'POST /memory-imports/preview',
        'POST /memory-imports',
        'POST /memory-imports/:id/undo',
        // p10-semantic-defaults-chat.
        'GET /context/defaults',
        'PUT /context/defaults',
        // p5-search-audit: audit explorer, jobs read API and exports.
        'GET /audit',
        'GET /audit/events/:id',
        'GET /audit/verify',
        'GET /audit/export',
        'GET /jobs',
        'GET /jobs/:id',
        'GET /jobs/:id/export',
        // p4-dispatch: job submission and cancellation.
        'POST /jobs',
        'POST /jobs/:id/cancel',
        // p4-git-flow: changes, merge/discard requests, project git configuration.
        'GET /jobs/:id/changes',
        'POST /jobs/:id/merge',
        'POST /jobs/:id/discard',
        'GET /projects/:id/git',
        'PUT /projects/:id/git',
        // p5-rbac-api: project and user management.
        'GET /projects',
        'POST /projects',
        'GET /projects/:id/members',
        'PUT /projects/:id/members',
        'DELETE /projects/:id/members',
        'GET /users',
        'POST /users',
        'PUT /users/:id/role',
        'POST /users/:id/disable',
        'POST /users/:id/enable',
        // p6-cost: every usage, price table and budget route needs a full session.
        'GET /usage/summary',
        'GET /usage/records',
        'GET /usage/prices',
        'GET /usage/prices/versions',
        'PUT /usage/prices',
        'GET /budgets',
        'GET /budgets/:id',
        'POST /budgets',
        'PUT /budgets/:id',
        'DELETE /budgets/:id',
        // p2-signed-updates: release registry and update targeting.
        'GET /releases',
        'POST /releases',
        // p6-release-upload: chunked upload of release.json.
        'POST /releases/uploads',
        'GET /releases/uploads/:id',
        'PUT /releases/uploads/:id/parts/:n',
        'POST /releases/uploads/:id/complete',
        'DELETE /releases/uploads/:id',
        'PUT /releases/channels/:channel',
        'POST /workers/:id/update',
        // p17-update-channel: the worker update channel and the version catalog.
        'GET /update-channel',
        'POST /update-channel/check',
        'PUT /update-channel/policy',
        'POST /update-channel/releases/:version/install',
        'GET /owner-upgrades',
        'POST /owner-upgrades',
        'POST /owner-upgrades/:id/confirm',
        'POST /owner-upgrades/:id/rollback',
        // p5-worker-onboarding: Fleet → Add machine.
        'GET /installers',
        'GET /installers/:version/:os/kit',
        // p5-fleet-archive: remove a dead worker from the list / put it back.
        'POST /workers/:id/archive',
        'POST /workers/:id/unarchive',
        // p15-chat-cards-scroll: a person-chosen machine name.
        'PUT /workers/:id/name',
        // p3-runtime-policy: runtime policies and per-worker assignment.
        'GET /runtime-policies',
        'GET /runtime-policies/template',
        'GET /runtime-policies/:name',
        'GET /runtime-policies/:name/versions',
        'PUT /runtime-policies/:name',
        'POST /runtime-policies/:name/promote',
        'POST /runtime-policies/:name/rollback',
        'GET /workers/:id/runtime-policy',
        'PUT /workers/:id/runtime-policy',
        // p4-quotas: enforcement status, policy, provider pauses, kill switch.
        'GET /quotas/status',
        'PUT /quotas/policy',
        'POST /quotas/pauses/:id/resume',
        'POST /projects/:id/kill',
        'DELETE /projects/:id/kill',
        // p6-quota-scheduling: off-peak windows and "Run now".
        'GET /projects/:id/off-peak',
        'PUT /projects/:id/off-peak',
        'POST /jobs/:id/run-now',
        // p6-warm-caches: the project setting for shared package caches.
        'GET /projects/:id/package-caches',
        'PUT /projects/:id/package-caches',
        // p4-dag: workflow definitions, runs and approval gates.
        'POST /workflows',
        'GET /workflows',
        'POST /workflows/:id/runs',
        'GET /workflows/runs/:id',
        'POST /workflows/runs/:id/cancel',
        'POST /workflows/runs/:id/nodes/:node/approve',
        'POST /workflows/runs/:id/nodes/:node/deny',
        // p13-workflows-ui: the catalog and the editor.
        'POST /workflows/validate',
        'GET /workflows/:id/definition',
        'PUT /workflows/:id',
        'GET /workflows/:id/versions',
        'POST /workflows/:id/archive',
        'POST /workflows/:id/unarchive',
        'POST /workflows/:id/duplicate',
        // p18-last-gaps: comments and "Değişiklik iste" on a compare view of the Kod tab.
        'GET /projects/:id/code/compare/comments',
        'POST /projects/:id/code/compare/comments',
        'PATCH /projects/:id/code/compare/comments/:cid',
        'DELETE /projects/:id/code/compare/comments/:cid',
        'POST /projects/:id/code/compare/request-changes',
      ]),
    );
  });

  it('rejects unknown URLs without a session as 401 (no route enumeration)', async () => {
    expect((await h.client().req('GET', '/admin')).statusCode).toBe(401);
    expect((await h.client().req('DELETE', '/auth/session')).statusCode).toBe(401);
  });
});
