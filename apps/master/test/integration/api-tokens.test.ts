import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stepUpRequiredError } from '../../src/auth/hooks.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec } from '../helpers/job-worker.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md, ADR-0058) against a real master (Postgres + Redis): personal tokens
 * and service accounts — create (shown once, hash only), use, scope ∩ role, expiry, revoke, rotation overlap, IP
 * allowlist, step-up refusal and grants, audit and its volume limit, CSRF (not for bearer, still for cookies), per-token
 * rate limit and concurrency, service accounts (no login, memberships, disable), the expiry notification.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'tk-proj';
const OTHER = 'tk-other';
const DAY = 24 * 60 * 60_000;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function api(
  app: FastifyInstance,
  token: string,
  method: Method,
  url: string,
  body?: unknown,
  ip = '198.51.100.20',
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'vitest-token' },
    remoteAddress: ip,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}

interface Issued {
  token: { id: string; hint: string; scopes: string[]; expiresAt: string; state: string };
  secret: string;
}

async function auditRows(
  h: Harness,
  action: string,
): Promise<{ outcome: string; target: string | null; metadata: Record<string, unknown> }[]> {
  const { rows } = await h.db.pool.query<{
    outcome: string;
    target: string | null;
    metadata: Record<string, unknown>;
  }>('SELECT outcome, target, metadata FROM audit_events WHERE action = $1 ORDER BY id', [action]);
  return rows;
}

describeIntegration('API tokens (integration, p16-api-tokens)', { timeout: 120_000 }, () => {
  let h: Harness;
  let owner: Client;
  let operator: Client;
  let viewer: Client;
  let ownerId = '';
  let operatorId = '';
  /** TOTP secrets from enrollment (to sign in again after the clock moved past the step-up window). */
  const secrets = new Map<string, string>();
  const secretOf = (username: string): string => secrets.get(username) ?? '';
  /** Fresh sessions after the clock moved past the session / step-up lifetimes. */
  async function relogin(): Promise<void> {
    owner = await fullLogin(h, 'tk-owner', PW, secretOf('tk-owner'));
    operator = await fullLogin(h, 'tk-op', PW, secretOf('tk-op'));
    viewer = await fullLogin(h, 'tk-viewer', PW, secretOf('tk-viewer'));
  }

  async function create(c: Client, body: Record<string, unknown>): Promise<Issued> {
    const res = await c.req('POST', '/me/api-tokens', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Issued>();
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    ownerId = await h.createUser('tk-owner', PW, 'owner');
    operatorId = await h.createUser('tk-op', PW, 'operator');
    const viewerId = await h.createUser('tk-viewer', PW, 'viewer');
    await h.grant(operatorId, [PROJECT], 'operator');
    await h.grant(viewerId, [PROJECT], 'viewer');
    await h.grant(ownerId, [OTHER], 'operator');
    const o = await enroll(h, 'tk-owner', PW);
    const p = await enroll(h, 'tk-op', PW);
    const v = await enroll(h, 'tk-viewer', PW);
    secrets.set('tk-owner', o.secret);
    secrets.set('tk-op', p.secret);
    secrets.set('tk-viewer', v.secret);
    owner = await fullLogin(h, 'tk-owner', PW, o.secret);
    operator = await fullLogin(h, 'tk-op', PW, p.secret);
    viewer = await fullLogin(h, 'tk-viewer', PW, v.secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('creates a token shown once, stores only its HMAC and audits the creation', async () => {
    const res = await operator.req('POST', '/me/api-tokens', {
      name: 'CI read',
      scopes: ['read'],
      expiresInDays: 30,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const out = res.json<Issued>();
    expect(out.secret).toMatch(/^ryl_pat_[0-9A-Za-z]{46}$/);
    expect(out.token.hint).toBe(`ryl_pat_${out.secret.slice(8, 12)}…${out.secret.slice(-4)}`);
    expect(out.token.scopes).toEqual(['read']);
    expect(new Date(out.token.expiresAt).getTime()).toBe(h.clock.now().getTime() + 30 * DAY);
    // The database has no column holding the secret.
    const { rows } = await h.db.pool.query<Record<string, unknown>>(
      'SELECT * FROM api_tokens WHERE id = $1',
      [out.token.id],
    );
    expect(JSON.stringify(rows[0])).not.toContain(out.secret.slice(8));
    expect((rows[0]?.secret_hash as Buffer).length).toBe(32);
    // The list never shows it again.
    const list = await operator.req('GET', '/me/api-tokens');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(out.secret.slice(8));
    expect(list.json<{ rules: { scopes: string[] } }>().rules.scopes).toEqual([
      'read',
      'jobs:write',
      'approvals',
      'deploy',
    ]);
    const created = (await auditRows(h, 'api_token.create')).filter((r) => r.outcome === 'success');
    expect(created.at(-1)?.target).toBe(`api-token:${out.token.id}`);
    expect(JSON.stringify(created.at(-1))).not.toContain(out.secret.slice(8));
    // The logs never carry it either.
    expect(h.logs.text).not.toContain(out.secret.slice(8));
  });

  it('authenticates bearer requests without CSRF; cookie requests still need it', async () => {
    const t = await create(operator, { name: 'jobs', scopes: ['read', 'jobs:write'], expiresInDays: 30 });
    const list = await api(h.app, t.secret, 'GET', `/jobs?project=${PROJECT}`);
    expect(list.statusCode, list.body).toBe(200);
    const job = await api(h.app, t.secret, 'POST', '/jobs', { project: PROJECT, spec: jobSpec() });
    expect(job.statusCode, job.body).toBe(201);
    const jobId = job.json<{ job: { id: string } }>().job.id;
    // The job's own audit entry names the token that created it.
    const entry = (await auditRows(h, 'job.create')).at(-1);
    expect(entry?.metadata.viaApi).toBe(t.token.id);
    // A browser session without the CSRF header is still refused.
    const noCsrf = operator.clone();
    noCsrf.sendCsrf = false;
    const refused = await noCsrf.req('POST', `/jobs/${jobId}/cancel`, { reason: 'csrf check' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toBe('csrf_failed');
    // The bearer request needs none (and ignores a cookie: a bad token never falls back to the session).
    const cancel = await api(h.app, t.secret, 'POST', `/jobs/${jobId}/cancel`, { reason: 'done via API' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const bad = await h.app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: 'Bearer ryl_pat_nope' },
      cookies: Object.fromEntries(operator.cookies),
      remoteAddress: '198.51.100.21',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json<{ error: string }>().error).toBe('invalid_token');
    expect(bad.headers['www-authenticate']).toContain('invalid_token');
    // Usage is counted (no audit row per request).
    await h.app.apiTokens.flushUsage();
    await expect
      .poll(async () => {
        const r = await operator.req('GET', '/me/api-tokens');
        return r
          .json<{ items: { id: string; useCount: number; lastUsedIp: string | null }[] }>()
          .items.find((i) => i.id === t.token.id);
      })
      .toMatchObject({ useCount: 3, lastUsedIp: '198.51.100.20' });
  });

  it('a token is the intersection of its scopes and the live role and memberships', async () => {
    // A viewer cannot even name a scope its role never reaches.
    const tooMuch = await viewer.req('POST', '/me/api-tokens', {
      name: 'x',
      scopes: ['jobs:write'],
      expiresInDays: 10,
    });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json<{ error: string }>().error).toBe('scope_not_allowed');
    // Scope missing.
    const read = await create(operator, { name: 'read only', scopes: ['read'], expiresInDays: 10 });
    const write = await api(h.app, read.secret, 'POST', '/jobs', { project: PROJECT, spec: jobSpec() });
    expect(write.statusCode).toBe(403);
    expect(write.json<{ error: string; params: { scope: string } }>()).toMatchObject({
      error: 'token_scope_missing',
      params: { scope: 'jobs:write' },
    });
    // Role: an owner token with read only cannot read the audit log (admin scope) — with admin it can.
    const ownerRead = await create(owner, { name: 'owner read', scopes: ['read'], expiresInDays: 10 });
    expect((await api(h.app, ownerRead.secret, 'GET', '/audit')).statusCode).toBe(403);
    const ownerAdmin = await create(owner, { name: 'owner admin', scopes: ['admin'], expiresInDays: 10 });
    expect((await api(h.app, ownerAdmin.secret, 'GET', '/audit')).statusCode).toBe(200);
    // Memberships: the operator's token sees no job of a project the operator is not in.
    const writer = await create(operator, {
      name: 'writer',
      scopes: ['read', 'jobs:write'],
      expiresInDays: 10,
    });
    const foreign = await api(h.app, writer.secret, 'POST', '/jobs', { project: OTHER, spec: jobSpec() });
    expect(foreign.statusCode).toBe(404);
    // The role is read per request: demoting the account demotes the token at once.
    await h.db.pool.query("UPDATE users SET role = 'viewer' WHERE id = $1", [operatorId]);
    const demoted = await api(h.app, writer.secret, 'POST', '/jobs', { project: PROJECT, spec: jobSpec() });
    expect(demoted.statusCode).toBe(403);
    expect(demoted.json<{ error: string }>().error).toBe('forbidden');
    await h.db.pool.query("UPDATE users SET role = 'operator' WHERE id = $1", [operatorId]);
    // Session-only endpoints are never reachable with a token, whatever its scopes.
    for (const [m, u] of [
      ['GET', '/me/api-tokens'],
      ['GET', '/auth/session'],
      ['GET', '/api-tokens'],
      ['GET', '/service-accounts'],
      ['GET', '/notifications'],
    ] as const) {
      const res = await api(h.app, ownerAdmin.secret, m, u);
      expect(res.statusCode, `${m} ${u}`).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('token_not_allowed');
    }
    const mint = await api(h.app, ownerAdmin.secret, 'POST', '/me/api-tokens', {
      name: 'from a token',
      scopes: ['read'],
      expiresInDays: 1,
    });
    expect(mint.statusCode).toBe(403);
    expect(mint.json<{ error: string }>().error).toBe('token_not_allowed');
  });

  it('expiry is required and capped by the policy; an expired token is refused', async () => {
    const none = await operator.req('POST', '/me/api-tokens', { name: 'x', scopes: ['read'] });
    expect(none.statusCode).toBe(400);
    // Harness preset Sıkı: at most 90 days.
    const long = await operator.req('POST', '/me/api-tokens', {
      name: 'x',
      scopes: ['read'],
      expiresInDays: 91,
    });
    expect(long.statusCode).toBe(400);
    expect(long.json<{ error: string; params: { max: number } }>()).toMatchObject({
      error: 'token_expiry_invalid',
      params: { max: 90 },
    });
    const t = await create(operator, { name: 'short', scopes: ['read'], expiresInDays: 1 });
    expect((await api(h.app, t.secret, 'GET', '/jobs')).statusCode).toBe(200);
    h.clock.advance(DAY + 1_000);
    const late = await api(h.app, t.secret, 'GET', '/jobs');
    expect(late.statusCode).toBe(401);
    expect(late.json<{ error: string }>().error).toBe('token_expired');
    const failed = (await auditRows(h, 'api_token.auth')).filter(
      (r) => r.target === `api-token:${t.token.id}`,
    );
    expect(failed.map((r) => r.metadata.reason)).toEqual(['expired']);
    await relogin();
  });

  it('revokes at once and audits it; a revoked token is refused', async () => {
    const t = await create(operator, { name: 'to revoke', scopes: ['read'], expiresInDays: 5 });
    expect((await api(h.app, t.secret, 'GET', '/jobs')).statusCode).toBe(200);
    // Not someone else's.
    expect((await viewer.req('DELETE', `/me/api-tokens/${t.token.id}`)).statusCode).toBe(404);
    const res = await operator.req('DELETE', `/me/api-tokens/${t.token.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ token: { state: string } }>().token.state).toBe('revoked');
    const after = await api(h.app, t.secret, 'GET', '/jobs');
    expect(after.statusCode).toBe(401);
    expect(after.json<{ error: string }>().error).toBe('token_revoked');
    expect((await auditRows(h, 'api_token.revoke')).at(-1)).toMatchObject({
      outcome: 'success',
      target: `api-token:${t.token.id}`,
    });
  });

  it('rotation: the new secret works at once, the old one only during the overlap', async () => {
    const t = await create(operator, { name: 'rotating', scopes: ['read'], expiresInDays: 30 });
    const r1 = await operator.req('POST', `/me/api-tokens/${t.token.id}/rotate`, { overlapMinutes: 30 });
    expect(r1.statusCode, r1.body).toBe(200);
    const n1 = r1.json<Issued>();
    expect(n1.secret).not.toBe(t.secret);
    expect(n1.token.id).toBe(t.token.id);
    expect((await api(h.app, n1.secret, 'GET', '/jobs')).statusCode).toBe(200);
    expect((await api(h.app, t.secret, 'GET', '/jobs')).statusCode).toBe(200);
    h.clock.advance(31 * 60_000);
    await relogin();
    const old = await api(h.app, t.secret, 'GET', '/jobs');
    expect(old.statusCode).toBe(401);
    expect(old.json<{ error: string }>().error).toBe('invalid_token');
    expect((await api(h.app, n1.secret, 'GET', '/jobs')).statusCode).toBe(200);
    // Without an overlap the previous secret stops at once.
    const r2 = await operator.req('POST', `/me/api-tokens/${t.token.id}/rotate`, { overlapMinutes: 0 });
    expect(r2.statusCode, r2.body).toBe(200);
    expect((await api(h.app, n1.secret, 'GET', '/jobs')).statusCode).toBe(401);
    expect((await api(h.app, r2.json<Issued>().secret, 'GET', '/jobs')).statusCode).toBe(200);
    expect((await auditRows(h, 'api_token.rotate')).filter((r) => r.outcome === 'success').length).toBe(2);
  });

  it('IP allowlist: only from the allowed ranges', async () => {
    const bad = await operator.req('POST', '/me/api-tokens', {
      name: 'x',
      scopes: ['read'],
      expiresInDays: 5,
      allowedCidrs: ['10.0.0.0/33'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe('invalid_cidr');
    const t = await create(operator, {
      name: 'office',
      scopes: ['read'],
      expiresInDays: 5,
      allowedCidrs: ['203.0.113.0/24', '2001:db8::/32'],
    });
    const outside = await api(h.app, t.secret, 'GET', '/jobs', undefined, '198.51.100.20');
    expect(outside.statusCode).toBe(403);
    expect(outside.json<{ error: string }>().error).toBe('ip_not_allowed');
    expect((await api(h.app, t.secret, 'GET', '/jobs', undefined, '203.0.113.7')).statusCode).toBe(200);
    expect((await api(h.app, t.secret, 'GET', '/jobs', undefined, '2001:db8::5')).statusCode).toBe(200);
  });

  it('step-up: refused for tokens while the event asks for a code; waived events pass; grants are opt-in', async () => {
    const t = await create(owner, { name: 'admin', scopes: ['read', 'admin'], expiresInDays: 5 });
    const workerId = 'wrk_tktktktktktktktktktktktktk';
    // Sıkı: every event asks — machines.fleet included.
    const drain = await api(h.app, t.secret, 'POST', `/workers/${workerId}/drain`, {});
    expect(drain.statusCode, drain.body).toBe(403);
    expect(drain.json<{ error: string; params: { event: string } }>()).toMatchObject({
      error: 'token_step_up_refused',
      params: { event: 'machines.fleet' },
    });
    const denied = (await auditRows(h, 'api_token.denied')).at(-1);
    expect(denied?.metadata).toMatchObject({ reason: 'step_up', event: 'machines.fleet' });
    // Event switched off in the policy: nobody is asked, the token passes the step-up (then: no such worker).
    await h.setSecurityPolicy({ preset: 'siki', events: { 'machines.fleet': false } });
    const waived = await api(h.app, t.secret, 'POST', `/workers/${workerId}/drain`, {});
    expect(waived.json<{ error: string }>().error).not.toBe('token_step_up_refused');
    await h.setSecurityPolicy({ preset: 'siki' });
    // Grants are off by default.
    const grant = { name: 'granted', scopes: ['admin'], expiresInDays: 5, grantedEvents: ['machines.fleet'] };
    const off = await owner.req('POST', '/me/api-tokens', grant);
    expect(off.statusCode).toBe(403);
    expect(off.json<{ error: string }>().error).toBe('event_grants_disabled');
    // On: an admin with a fresh code may grant non-core events; never the safe core.
    await h.setSecurityPolicy({ preset: 'siki', apiTokens: { eventGrants: true } });
    const core = await owner.req('POST', '/me/api-tokens', { ...grant, grantedEvents: ['users.roles'] });
    expect(core.statusCode).toBe(400);
    expect(core.json<{ error: string }>().error).toBe('event_not_grantable');
    const notAdmin = await operator.req('POST', '/me/api-tokens', {
      ...grant,
      scopes: ['read'],
    });
    expect(notAdmin.statusCode).toBe(403);
    const g = await create(owner, grant);
    expect(
      (await api(h.app, g.secret, 'POST', `/workers/${workerId}/drain`, {})).json<{ error: string }>().error,
    ).not.toBe('token_step_up_refused');
    // A grant only counts while the policy allows grants.
    await h.setSecurityPolicy({ preset: 'siki' });
    expect(
      (await api(h.app, g.secret, 'POST', `/workers/${workerId}/drain`, {})).json<{ error: string }>().error,
    ).toBe('token_step_up_refused');
  });

  it('audits failures once per token / IP and reason per window', async () => {
    const before = (await auditRows(h, 'api_token.auth')).length;
    for (let i = 0; i < 5; i++) {
      const res = await api(
        h.app,
        'ryl_pat_000000000000000000000000000000000000000000AAAAAA',
        'GET',
        '/jobs',
        undefined,
        '192.0.2.99',
      );
      expect(res.statusCode).toBe(401);
    }
    const rows = (await auditRows(h, 'api_token.auth')).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.reason).toBe('malformed');
  });

  it('personal tokens can be switched off in the security policy', async () => {
    await h.setSecurityPolicy({ preset: 'siki', apiTokens: { personal: false } });
    const res = await operator.req('POST', '/me/api-tokens', {
      name: 'x',
      scopes: ['read'],
      expiresInDays: 5,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('personal_tokens_disabled');
    await h.setSecurityPolicy({ preset: 'siki' });
  });

  it('service accounts: no login, memberships like users, scoped tokens, disable stops them', async () => {
    const created = await owner.req('POST', '/service-accounts', {
      name: 'ci-bot',
      role: 'operator',
      description: 'GitHub Actions deploy pipeline',
    });
    expect(created.statusCode, created.body).toBe(201);
    const sa = created.json<{ id: string; name: string; role: string }>();
    expect(sa).toMatchObject({ name: 'ci-bot', role: 'operator' });
    // It can never sign in (same answer as an unknown user) and is not listed among people.
    const login = await h
      .client('192.0.2.50')
      .req('POST', '/auth/login', { username: 'ci-bot', password: PW });
    expect(login.statusCode).toBe(401);
    const users = await owner.req('GET', '/users');
    expect(users.json<{ items: { username: string }[] }>().items.map((u) => u.username)).not.toContain(
      'ci-bot',
    );
    // Owner role is refused by the schema; an owner-only escalation through the API is impossible.
    expect(
      (await owner.req('POST', '/service-accounts', { name: 'root-bot', role: 'owner' })).statusCode,
    ).toBe(400);
    // The people endpoints do not touch service accounts (their page enforces role ≤ admin).
    expect((await owner.req('PUT', `/users/${sa.id}/role`, { role: 'owner' })).statusCode).toBe(404);
    // Membership through the existing project members API.
    const member = await owner.req('PUT', `/projects/${PROJECT}/members`, {
      userId: sa.id,
      role: 'operator',
    });
    expect(member.statusCode, member.body).toBe(200);
    const issued = await owner.req('POST', `/service-accounts/${sa.id}/tokens`, {
      name: 'deploy pipeline',
      scopes: ['read', 'jobs:write'],
      expiresInDays: 60,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const t = issued.json<Issued>();
    expect(t.secret).toMatch(/^ryl_sa_[0-9A-Za-z]{46}$/);
    expect(
      (await api(h.app, t.secret, 'POST', '/jobs', { project: PROJECT, spec: jobSpec() })).statusCode,
    ).toBe(201);
    expect(
      (await api(h.app, t.secret, 'POST', '/jobs', { project: OTHER, spec: jobSpec() })).statusCode,
    ).toBe(404);
    // A service account token is not a personal token: the prefix must match the account kind.
    expect((await api(h.app, t.secret.replace('ryl_sa_', 'ryl_pat_'), 'GET', '/jobs')).statusCode).toBe(401);
    // Listed for admins with its tokens (no secret).
    const list = await owner.req('GET', '/service-accounts');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(t.secret.slice(8));
    // Disabled: its tokens stop at once.
    const off = await owner.req('PATCH', `/service-accounts/${sa.id}`, { disabled: true });
    expect(off.statusCode, off.body).toBe(200);
    const stopped = await api(h.app, t.secret, 'GET', '/jobs');
    expect(stopped.statusCode).toBe(401);
    expect(stopped.json<{ error: string }>().error).toBe('principal_disabled');
    // Admins see and revoke every token.
    const all = await owner.req('GET', '/api-tokens?kind=service');
    expect(all.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toContain(t.token.id);
    expect((await owner.req('DELETE', `/api-tokens/${t.token.id}`)).statusCode).toBe(200);
    expect((await auditRows(h, 'service_account.create')).at(-1)?.outcome).toBe('success');
    expect((await auditRows(h, 'service_account.update')).at(-1)?.metadata).toMatchObject({
      changes: ['disabled'],
    });
  });

  it('notifies the owner 7 days before expiry, once per expiry date', async () => {
    await create(viewer, { name: 'soon', scopes: ['read'], expiresInDays: 10 });
    expect(await h.app.notifications.sweep()).toBeGreaterThanOrEqual(0);
    const kinds = async () =>
      (await viewer.req('GET', '/notifications'))
        .json<{ items: { kind: string; title: string }[] }>()
        .items.filter((n) => n.kind === 'api_token.expiring');
    expect(await kinds()).toHaveLength(0);
    h.clock.advance(4 * DAY);
    await relogin();
    await h.app.notifications.sweep();
    await h.app.notifications.sweep();
    const n = await kinds();
    expect(n).toHaveLength(1);
    expect(n[0]?.title).toContain('soon');
  });
});

/** Per-token rate limit and concurrency, and the service-level step-up rewrite, on a master with tight token limits. */
describeIntegration('API token limits (integration, p16-api-tokens)', { timeout: 60_000 }, () => {
  const h = new Harness();
  let client: Client;

  beforeAll(async () => {
    await h.start({
      tokenLimits: {
        perToken: {
          read: { max: 3, windowMs: 60_000 },
          write: { max: 3, windowMs: 60_000 },
          export: { max: 1, windowMs: 60_000 },
        },
        concurrency: 1,
      },
      // A route whose service refuses for a missing code (the shape of every in-transaction step-up check).
      extraRoutes: [
        (app) => {
          app.get('/test/service-step-up', { config: { authz: { action: 'jobs.read' } } }, () => {
            throw stepUpRequiredError();
          });
        },
      ],
    });
    await h.createUser('tl-owner', PW, 'owner');
    const e = await enroll(h, 'tl-owner', PW);
    client = await fullLogin(h, 'tl-owner', PW, e.secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('limits', () => {
    it('refuses over the per-token budget with 429 and retry-after', async () => {
      const res = await client.req('POST', '/me/api-tokens', {
        name: 'rl',
        scopes: ['read'],
        expiresInDays: 5,
      });
      expect(res.statusCode, res.body).toBe(201);
      const { secret, token } = res.json<Issued>();
      for (let i = 0; i < 3; i++) expect((await api(h.app, secret, 'GET', '/jobs')).statusCode).toBe(200);
      const over = await api(h.app, secret, 'GET', '/jobs');
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'http.rate_limited'",
      );
      expect(rows.map((r) => r.metadata.viaApi)).toContain(token.id);
    });

    it('holds at most `concurrency` requests of one token in flight', async () => {
      const res = await client.req('POST', '/me/api-tokens', {
        name: 'cc',
        scopes: ['read'],
        expiresInDays: 5,
      });
      const { secret, token } = res.json<Issued>();
      // Another replica holds the only slot.
      await h.redis.set(`${h.redisPrefix}tc:${token.id}`, '1', 'PX', 60_000);
      const busy = await api(h.app, secret, 'GET', '/jobs');
      expect(busy.statusCode).toBe(429);
      expect(busy.json<{ error: string }>().error).toBe('token_busy');
      await h.redis.del(`${h.redisPrefix}tc:${token.id}`);
      expect((await api(h.app, secret, 'GET', '/jobs')).statusCode).toBe(200);
      // The slot was released after the answer.
      expect(Number((await h.redis.get(`${h.redisPrefix}tc:${token.id}`)) ?? '0')).toBe(0);
    });

    it('a service-level step-up refusal says the token cannot give a code', async () => {
      const res = await client.req('POST', '/me/api-tokens', {
        name: 'su',
        scopes: ['read'],
        expiresInDays: 5,
      });
      const { secret } = res.json<Issued>();
      const out = await api(h.app, secret, 'GET', '/test/service-step-up');
      expect(out.statusCode).toBe(403);
      expect(out.json<{ error: string }>().error).toBe('token_step_up_refused');
      // A session still gets the ordinary answer.
      const s = await client.req('GET', '/test/service-step-up');
      expect(s.json<{ error: string }>().error).toBe('step_up_required');
    });
  });
});
