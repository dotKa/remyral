import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SigningKey } from '../../src/oidc/keys.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p5-coolify-sso (docs/design/p5-coolify-sso.md): the OIDC provider driven like Coolify's client
 * (discovery → authorize with PKCE → token → userinfo → ID-token verification against the JWKS), the
 * forward-auth gate with its ticket flow, refusals, audit entries and log hygiene.
 */
const PW = 'quartz-meadow-lantern-7';
const CONSOLE = 'https://console.remyral.test';
const ISSUER = `${CONSOLE}/api/oidc`;
const K = 'coolify.remyral.test';
const REDIRECT = `https://${K}/auth/oidc/callback`;
const SECRET = 'c'.repeat(16) + randomBytes(24).toString('hex');
const OWNER_EMAIL = 'owner@remyral.test';

const signingKey = new SigningKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);

let h: Harness;
let ownerSecret: string;
let ownerId: string;
let operatorSecret: string;
let nomailSecret: string;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(params: Record<string, string>, path = '/oidc/authorize'): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}

function standard(challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: 'coolify',
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    state: 'st-' + randomBytes(6).toString('hex'),
    nonce: 'nn-' + randomBytes(6).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  };
}

function location(res: LightMyRequestResponse): URL {
  const loc = res.headers.location;
  if (typeof loc !== 'string') throw new Error(`no location (status ${String(res.statusCode)}: ${res.body})`);
  return new URL(loc, `${CONSOLE}/api/oidc/authorize`);
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/oidc/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(form).toString(),
    remoteAddress: '203.0.113.7',
  });
}

/** Authorize as `client` and return the code (asserts a successful redirect). */
async function codeFor(client: Client, challenge: string, extra: Record<string, string> = {}) {
  const params = standard(challenge, extra);
  const res = await client.req('GET', authorizeUrl(params));
  expect(res.statusCode).toBe(302);
  const loc = location(res);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe(params.state);
  expect(loc.searchParams.get('iss')).toBe(ISSUER);
  const code = loc.searchParams.get('code');
  if (code === null) throw new Error(`no code: ${loc.href}`);
  return { code, params };
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h64, c64] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h64 ?? '', 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c64 ?? '', 'base64url').toString()) as Record<string, unknown>,
  };
}

async function audit(
  action: string,
): Promise<{ outcome: string; actor_id: string | null; metadata: unknown }[]> {
  const { rows } = await h.db.pool.query<{ outcome: string; actor_id: string | null; metadata: unknown }>(
    'SELECT outcome, actor_id, metadata FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows;
}

/** A cookie jar for the Coolify host (the console Client keeps the console cookies). */
class GateBrowser {
  readonly cookies = new Map<string, string>();
  readonly setCookies: string[] = [];
  async get(url: string, headers: Record<string, string> = {}) {
    const res = await h.app.inject({
      method: 'GET',
      url,
      headers: { host: K, ...headers },
      cookies: Object.fromEntries(this.cookies),
      remoteAddress: '203.0.113.9',
    });
    this.absorb(res);
    return res;
  }
  /** What Traefik sends to forward-auth for a browser request to `uri` on K. */
  async forwardAuth(uri: string, headers: Record<string, string> = {}, host = K) {
    const res = await h.app.inject({
      method: 'GET',
      url: '/forward-auth/coolify',
      headers: {
        'x-forwarded-host': host,
        'x-forwarded-method': 'GET',
        'x-forwarded-proto': 'https',
        'x-forwarded-uri': uri,
        ...headers,
      },
      cookies: Object.fromEntries(this.cookies),
      remoteAddress: '172.18.0.2',
    });
    this.absorb(res);
    return res;
  }
  private absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies as { name: string; value: string; maxAge?: number }[]) {
      if (c.maxAge === 0 || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const raw = res.headers['set-cookie'];
    if (raw !== undefined) this.setCookies.push(...(Array.isArray(raw) ? raw : [raw]));
  }
}

const NAV = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };

/** The full gate flow for a signed-in console client; returns the gate browser holding __Host-rcs. */
async function openGate(consoleClient: Client, next = '/projects?x=1'): Promise<GateBrowser> {
  const b = new GateBrowser();
  const fa = await b.forwardAuth(next, NAV);
  expect(fa.statusCode).toBe(302);
  const toTicket = new URL(String(fa.headers.location));
  expect(toTicket.origin).toBe(CONSOLE);
  expect(toTicket.pathname).toBe('/api/coolify-sso/ticket');
  const ticket = await consoleClient.req('GET', `/coolify-sso/ticket${toTicket.search}`);
  expect(ticket.statusCode).toBe(302);
  const cb = new URL(String(ticket.headers.location));
  expect(cb.origin).toBe(`https://${K}`);
  expect(cb.pathname).toBe('/_remana/sso/callback');
  const done = await b.get(`/coolify-sso/callback${cb.search}`);
  expect(done.statusCode).toBe(302);
  expect(done.headers.location).toBe(`https://${K}${next}`);
  expect(b.cookies.has('__Host-rcs')).toBe(true);
  return b;
}

describeIntegration('Coolify SSO (integration)', () => {
  let owner: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      sso: {
        oidc: {
          consoleOrigin: CONSOLE,
          signingKey,
          client: { id: 'coolify', secret: SECRET, redirectUris: [REDIRECT] },
          emails: new Map([
            ['owner', OWNER_EMAIL],
            ['oper', 'oper@remyral.test'],
          ]),
        },
        gate: { host: K, consoleOrigin: CONSOLE },
        gateCacheMs: 0,
      },
    });
    ownerId = await h.createUser('owner', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner', PW)).secret;
    await h.createUser('oper', PW, 'operator');
    operatorSecret = (await enroll(h, 'oper', PW)).secret;
    await h.createUser('nomail', PW, 'admin');
    nomailSecret = (await enroll(h, 'nomail', PW)).secret;
    owner = await fullLogin(h, 'owner', PW, ownerSecret);
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('OIDC provider', () => {
    it('serves discovery and the JWKS (RS256, kid)', async () => {
      const d = await h.client().req('GET', '/oidc/.well-known/openid-configuration');
      expect(d.statusCode).toBe(200);
      expect(d.json()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
      });
      const j = await h.client().req('GET', '/oidc/jwks');
      const keys = j.json<{ keys: Record<string, string>[] }>().keys;
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: signingKey.kid });
      expect(keys[0]).not.toHaveProperty('d');
    });

    it('full flow: authorize (PKCE) → token → userinfo → verified ID token', async () => {
      const { verifier, challenge } = pkce();
      const { code, params } = await codeFor(owner, challenge);
      const res = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'coolify',
        client_secret: SECRET,
        code_verifier: verifier,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json<{
        access_token: string;
        id_token: string;
        token_type: string;
        expires_in: number;
      }>();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(300);

      // ID token: signature against the published JWKS, then the claims Coolify checks.
      const jwks = (await h.client().req('GET', '/oidc/jwks')).json<{ keys: Record<string, string>[] }>();
      const { header, claims } = decodeJwt(body.id_token);
      expect(header).toEqual({ alg: 'RS256', kid: signingKey.kid, typ: 'JWT' });
      const jwk = jwks.keys.find((k) => k.kid === header.kid);
      const pub = createPublicKey({ key: jwk as never, format: 'jwk' });
      const [a, b, sig] = body.id_token.split('.');
      expect(
        verify('sha256', Buffer.from(`${a ?? ''}.${b ?? ''}`), pub, Buffer.from(sig ?? '', 'base64url')),
      ).toBe(true);
      const now = Math.floor(h.clock.now().getTime() / 1000);
      expect(claims).toMatchObject({
        iss: ISSUER,
        sub: ownerId,
        aud: 'coolify',
        nonce: params.nonce,
        email: OWNER_EMAIL,
        email_verified: true,
        name: 'owner',
        preferred_username: 'owner',
        iat: now,
        exp: now + 300,
        at_hash: createHash('sha256')
          .update(body.access_token)
          .digest()
          .subarray(0, 16)
          .toString('base64url'),
      });

      const ui = await h.client().req('GET', '/oidc/userinfo', undefined, {
        authorization: `Bearer ${body.access_token}`,
      });
      expect(ui.statusCode).toBe(200);
      expect(ui.json()).toEqual({
        sub: ownerId,
        email: OWNER_EMAIL,
        email_verified: true,
        name: 'owner',
        preferred_username: 'owner',
      });
      const post = await h.client().req('POST', '/oidc/userinfo', undefined, {
        authorization: `Bearer ${body.access_token}`,
      });
      expect(post.statusCode).toBe(200);

      const issued = await audit('oidc.authorize');
      expect(issued.some((r) => r.outcome === 'success' && r.actor_id === ownerId)).toBe(true);
      const tokens = await audit('oidc.token');
      expect(tokens.some((r) => r.outcome === 'success' && r.actor_id === ownerId)).toBe(true);

      // Log hygiene: no code, token, ID token or client secret anywhere in the logs or the audit log.
      const { rows } = await h.db.pool.query<{ t: string }>('SELECT metadata::text AS t FROM audit_events');
      const auditText = rows.map((r) => r.t).join('\n');
      for (const secret of [code, body.access_token, body.id_token, SECRET, verifier]) {
        expect(h.logs.text).not.toContain(secret);
        expect(auditText).not.toContain(secret);
      }
    });

    it('accepts client_secret_basic; refuses two methods and a wrong secret', async () => {
      const { verifier, challenge } = pkce();
      const { code } = await codeFor(owner, challenge);
      const basic = `Basic ${Buffer.from(`coolify:${SECRET}`).toString('base64')}`;
      const both = await token(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_secret: SECRET,
          code_verifier: verifier,
        },
        { authorization: basic },
      );
      expect(both.statusCode).toBe(400);
      expect(both.json()).toMatchObject({ error: 'invalid_request' });
      const wrong = await token(
        { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
        { authorization: `Basic ${Buffer.from('coolify:nope').toString('base64')}` },
      );
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: 'invalid_client' });
      expect(wrong.headers['www-authenticate']).toMatch(/^Basic/);
      const ok = await token(
        { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
        { authorization: basic },
      );
      expect(ok.statusCode).toBe(200);
    });

    it('refuses a reused code and revokes the tokens issued for it', async () => {
      const { verifier, challenge } = pkce();
      const { code } = await codeFor(owner, challenge);
      const form = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'coolify',
        client_secret: SECRET,
        code_verifier: verifier,
      };
      const first = await token(form);
      expect(first.statusCode).toBe(200);
      const access = first.json<{ access_token: string }>().access_token;
      const again = await token(form);
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ error: 'invalid_grant' });
      const ui = await h
        .client()
        .req('GET', '/oidc/userinfo', undefined, { authorization: `Bearer ${access}` });
      expect(ui.statusCode).toBe(401);
      const replays = await audit('oidc.code.replay');
      expect(replays.at(-1)).toMatchObject({
        outcome: 'denied',
        actor_id: ownerId,
        metadata: { revokedGrants: 1 },
      });
    });

    it('refuses an expired code, a wrong or missing verifier and another redirect URI', async () => {
      const base = { grant_type: 'authorization_code', client_id: 'coolify', client_secret: SECRET };
      const p1 = pkce();
      const c1 = await codeFor(owner, p1.challenge);
      h.clock.advance(61_000);
      const expired = await token({
        ...base,
        code: c1.code,
        redirect_uri: REDIRECT,
        code_verifier: p1.verifier,
      });
      expect(expired.json()).toMatchObject({ error: 'invalid_grant' });

      const p2 = pkce();
      const c2 = await codeFor(owner, p2.challenge);
      const wrongVerifier = await token({
        ...base,
        code: c2.code,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      });
      expect(wrongVerifier.json()).toMatchObject({ error: 'invalid_grant' });

      const p3 = pkce();
      const c3 = await codeFor(owner, p3.challenge);
      const noVerifier = await token({ ...base, code: c3.code, redirect_uri: REDIRECT });
      expect(noVerifier.json()).toMatchObject({ error: 'invalid_grant' });

      const p4 = pkce();
      const c4 = await codeFor(owner, p4.challenge);
      const otherRedirect = await token({
        ...base,
        code: c4.code,
        redirect_uri: `https://${K}/auth/other/callback`,
        code_verifier: p4.verifier,
      });
      expect(otherRedirect.json()).toMatchObject({ error: 'invalid_grant' });

      const notForm = await h.app.inject({ method: 'POST', url: '/oidc/token', payload: { code: c4.code } });
      expect(notForm.statusCode).toBe(400);
      const repeated = await h.app.inject({
        method: 'POST',
        url: '/oidc/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `grant_type=authorization_code&code=${c4.code}&code=${c4.code}`,
      });
      expect(repeated.json()).toMatchObject({ error: 'invalid_request' });
      const grant = await token({ ...base, grant_type: 'refresh_token', refresh_token: 'x' });
      expect(grant.json()).toMatchObject({ error: 'unsupported_grant_type' });
    });

    it('never redirects to an unregistered redirect URI or for an unknown client', async () => {
      const { challenge } = pkce();
      for (const params of [
        standard(challenge, { redirect_uri: 'https://evil.example/cb' }),
        standard(challenge, { redirect_uri: `${REDIRECT}/x` }),
        standard(challenge, { client_id: 'other' }),
      ]) {
        const res = await owner.req('GET', authorizeUrl(params));
        expect(res.statusCode).toBe(400);
        expect(res.headers.location).toBeUndefined();
      }
      const dup = await owner.req('GET', `${authorizeUrl(standard(challenge))}&state=again`);
      expect(dup.statusCode).toBe(400);
      expect(dup.headers.location).toBeUndefined();
    });

    it('answers protocol errors with an error redirect to the registered URI', async () => {
      const { challenge } = pkce();
      const cases: [Record<string, string>, string][] = [
        [standard(challenge, { response_type: 'token' }), 'unsupported_response_type'],
        [standard(challenge, { scope: 'email profile' }), 'invalid_scope'],
        [standard(challenge, { code_challenge_method: 'plain' }), 'invalid_request'],
        [standard('short'), 'invalid_request'],
        [standard(challenge, { request: 'eyJ' }), 'request_not_supported'],
      ];
      for (const [params, error] of cases) {
        const res = await owner.req('GET', authorizeUrl(params));
        expect(res.statusCode).toBe(302);
        const loc = location(res);
        expect(loc.origin + loc.pathname).toBe(REDIRECT);
        expect(loc.searchParams.get('error')).toBe(error);
        expect(loc.searchParams.get('state')).toBe(params.state);
        expect(loc.searchParams.get('code')).toBeNull();
      }
    });

    it('refuses non-admin accounts and accounts without an e-mail mapping (audited)', async () => {
      const { challenge } = pkce();
      const operator = await fullLogin(h, 'oper', PW, operatorSecret);
      const res = await operator.req('GET', authorizeUrl(standard(challenge)));
      expect(location(res).searchParams.get('error')).toBe('access_denied');
      expect(location(res).searchParams.get('code')).toBeNull();
      const nomail = await fullLogin(h, 'nomail', PW, nomailSecret);
      const res2 = await nomail.req('GET', authorizeUrl(standard(challenge)));
      expect(location(res2).searchParams.get('error')).toBe('access_denied');
      const denied = (await audit('oidc.authorize')).filter((r) => r.outcome === 'denied');
      expect(denied.map((r) => (r.metadata as { reason: string }).reason)).toEqual(
        expect.arrayContaining(['role', 'no_email_mapping']),
      );
    });

    it('without a console session: sends the browser to the console, then resumes', async () => {
      const { verifier, challenge } = pkce();
      const params = standard(challenge);
      const anon = h.client();
      const none = await anon.req('GET', authorizeUrl({ ...params, prompt: 'none' }));
      expect(location(none).searchParams.get('error')).toBe('login_required');
      const res = await anon.req('GET', authorizeUrl(params));
      expect(res.statusCode).toBe(302);
      const cont = location(res);
      expect(cont.origin).toBe(CONSOLE);
      expect(cont.pathname).toBe('/sso/continue');
      expect(cont.searchParams.get('flow')).toBe('oidc');
      const r = cont.searchParams.get('r') ?? '';
      // The sealed request carries nothing readable.
      expect(Buffer.from(r, 'base64url').toString('latin1')).not.toContain(params.state);
      // Sign in (the console's login screen), then the console navigates to the fixed resume path.
      const signedIn = await fullLogin(h, 'owner', PW, ownerSecret);
      const resumed = await signedIn.req('GET', `/oidc/authorize/resume?r=${r}`);
      const loc = location(resumed);
      expect(loc.searchParams.get('state')).toBe(params.state);
      const code = loc.searchParams.get('code') ?? '';
      const t = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'coolify',
        client_secret: SECRET,
        code_verifier: verifier,
      });
      expect(decodeJwt(t.json<{ id_token: string }>().id_token).claims.nonce).toBe(params.nonce);
      // Tampered or expired sealed requests are refused without a redirect.
      const tampered = await signedIn.req('GET', `/oidc/authorize/resume?r=${r.slice(0, -2)}AA`);
      expect(tampered.statusCode).toBe(400);
      h.clock.advance(11 * 60_000);
      const late = await signedIn.req('GET', `/oidc/authorize/resume?r=${r}`);
      expect(late.statusCode).toBe(400);
    });

    it('with a stale step-up: console step-up, then resume issues the code', async () => {
      const client = await fullLogin(h, 'owner', PW, ownerSecret);
      h.clock.advance(11 * 60_000);
      const { challenge } = pkce();
      const params = standard(challenge);
      const none = await client.req('GET', authorizeUrl({ ...params, prompt: 'none' }));
      expect(location(none).searchParams.get('error')).toBe('interaction_required');
      const res = await client.req('GET', authorizeUrl(params));
      const cont = location(res);
      expect(cont.pathname).toBe('/sso/continue');
      const r = cont.searchParams.get('r') ?? '';
      // Without the step-up the resume goes back to the console.
      expect(location(await client.req('GET', `/oidc/authorize/resume?r=${r}`)).pathname).toBe(
        '/sso/continue',
      );
      h.clock.advance(30_000);
      const up = await client.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
      expect(up.statusCode).toBe(200);
      const resumed = await client.req('GET', `/oidc/authorize/resume?r=${r}`);
      expect(location(resumed).searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('userinfo refuses missing and unknown tokens', async () => {
      const missing = await h.client().req('GET', '/oidc/userinfo');
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toMatch(/^Bearer/);
      const unknown = await h.client().req('GET', '/oidc/userinfo', undefined, {
        authorization: `Bearer ${'A'.repeat(43)}`,
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.headers['www-authenticate']).toContain('invalid_token');
    });
  });

  describe('forward-auth gate', () => {
    it('denies without a gate cookie: navigation → console ticket, scripts/WebSockets → 401, other hosts → 403', async () => {
      const b = new GateBrowser();
      const nav = await b.forwardAuth('/servers', NAV);
      expect(nav.statusCode).toBe(302);
      expect(String(nav.headers.location)).toMatch(new RegExp(`^${CONSOLE}/api/coolify-sso/ticket\\?r=`));
      expect(nav.headers['cache-control']).toBe('no-store');
      const state = b.setCookies.find((c) => c.startsWith('__Host-rcs-state-')) ?? '';
      expect(state).toMatch(/HttpOnly/);
      expect(state).toMatch(/Secure/);
      expect(state).toMatch(/SameSite=Strict/);
      expect(state).toMatch(/Path=\//);
      expect(state).not.toMatch(/Domain=/i);
      expect(
        (await b.forwardAuth('/livewire/update', { accept: 'application/json', 'sec-fetch-mode': 'cors' }))
          .statusCode,
      ).toBe(401);
      expect((await b.forwardAuth('/app/key', { ...NAV, upgrade: 'websocket' })).statusCode).toBe(401);
      expect((await b.forwardAuth('/', NAV, 'console.remyral.test')).statusCode).toBe(403);
      expect((await b.forwardAuth('/', NAV, 'evil.example')).statusCode).toBe(403);
      // Unsafe next paths fall back to "/".
      const evil = await new GateBrowser().forwardAuth('//evil.example/x', NAV);
      expect(evil.statusCode).toBe(302);
    });

    it('ticket flow: console session → one-time ticket → gate cookie; then pages and WebSockets pass', async () => {
      const b = await openGate(owner);
      const gate = b.setCookies.find((c) => c.startsWith('__Host-rcs=')) ?? '';
      expect(gate).toMatch(/HttpOnly/);
      expect(gate).toMatch(/Secure/);
      expect(gate).toMatch(/SameSite=Strict/);
      expect(gate).toMatch(/Path=\//);
      expect(gate).not.toMatch(/Domain=/i);
      expect((await b.forwardAuth('/projects', NAV)).statusCode).toBe(200);
      expect((await b.forwardAuth('/livewire/update', { accept: 'application/json' })).statusCode).toBe(200);
      expect((await b.forwardAuth('/app/key?protocol=7', { upgrade: 'websocket' })).statusCode).toBe(200);
      expect((await b.forwardAuth('/terminal/ws', { upgrade: 'websocket' })).statusCode).toBe(200);
      expect(await audit('sso.coolify.ticket')).toEqual(
        expect.arrayContaining([expect.objectContaining({ outcome: 'success', actor_id: ownerId })]),
      );
      expect(await audit('sso.coolify.session')).toEqual(
        expect.arrayContaining([expect.objectContaining({ outcome: 'success', actor_id: ownerId })]),
      );
    });

    it('the callback needs the state cookie of the same browser, a fresh ticket, and the gate host', async () => {
      const starter = new GateBrowser();
      const fa = await starter.forwardAuth('/', NAV);
      const ticket = await owner.req(
        'GET',
        `/coolify-sso/ticket${new URL(String(fa.headers.location)).search}`,
      );
      const cb = new URL(String(ticket.headers.location));
      // Another browser (no state cookie) cannot redeem it — login CSRF / ticket injection.
      const other = new GateBrowser();
      expect((await other.get(`/coolify-sso/callback${cb.search}`)).statusCode).toBe(400);
      expect(other.cookies.has('__Host-rcs')).toBe(false);
      // Not on the console host (the public /api route is also blocked at Traefik).
      const onConsole = await h.app.inject({
        method: 'GET',
        url: `/coolify-sso/callback${cb.search}`,
        headers: { host: 'console.remyral.test' },
        cookies: Object.fromEntries(starter.cookies),
      });
      expect(onConsole.statusCode).toBe(404);
      // The right browser redeems it — once: a copy of its state cookie cannot redeem the ticket again.
      const twin = new GateBrowser();
      for (const [k, v] of starter.cookies) twin.cookies.set(k, v);
      expect((await starter.get(`/coolify-sso/callback${cb.search}`)).statusCode).toBe(302);
      expect((await starter.forwardAuth('/', NAV)).statusCode).toBe(200);
      expect((await twin.get(`/coolify-sso/callback${cb.search}`)).statusCode).toBe(400);
      expect(twin.cookies.has('__Host-rcs')).toBe(false);
      // A forged sealed request is refused at the ticket endpoint.
      const forged = await owner.req('GET', '/coolify-sso/ticket?r=' + 'A'.repeat(80));
      expect(forged.statusCode).toBe(400);
    });

    it('without a console session the ticket endpoint sends the browser to the console page', async () => {
      const b = new GateBrowser();
      const fa = await b.forwardAuth('/', NAV);
      const search = new URL(String(fa.headers.location)).search;
      const res = await h.client().req('GET', `/coolify-sso/ticket${search}`);
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers.location), CONSOLE);
      expect(loc.origin).toBe(CONSOLE);
      expect(loc.pathname).toBe('/sso/continue');
      expect(loc.searchParams.get('flow')).toBe('coolify');
      expect(loc.searchParams.get('r')).toBe(new URLSearchParams(search).get('r'));
    });

    it('refuses non-admins at the ticket (audited) and closes the gate on demotion, logout and idle', async () => {
      const operator = await fullLogin(h, 'oper', PW, operatorSecret);
      const b = new GateBrowser();
      const fa = await b.forwardAuth('/', NAV);
      const res = await operator.req(
        'GET',
        `/coolify-sso/ticket${new URL(String(fa.headers.location)).search}`,
      );
      expect(res.headers.location).toBe('/sso/continue?flow=coolify&error=forbidden');
      expect((await audit('sso.coolify.ticket')).some((r) => r.outcome === 'denied')).toBe(true);

      // Step-up rotates the console session id; the gate follows the session lineage.
      const admin = await fullLogin(h, 'owner', PW, ownerSecret);
      const gate = await openGate(admin);
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
      expect((await gate.forwardAuth('/', NAV)).statusCode).toBe(200);

      // Demotion closes it immediately (cache disabled in this harness).
      await h.db.pool.query("UPDATE users SET role = 'operator' WHERE id = $1", [ownerId]);
      expect((await gate.forwardAuth('/', { accept: 'application/json' })).statusCode).toBe(401);
      await h.db.pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [ownerId]);
      expect((await gate.forwardAuth('/', { accept: 'application/json' })).statusCode).toBe(200);

      // Console logout ends the gate session too.
      expect((await admin.req('POST', '/auth/logout')).statusCode).toBe(200);
      expect((await gate.forwardAuth('/', { accept: 'application/json' })).statusCode).toBe(401);

      // Idle: Coolify activity keeps the console session alive, inactivity ends both.
      const idle = await fullLogin(h, 'owner', PW, ownerSecret);
      const g2 = await openGate(idle);
      for (let i = 0; i < 3; i += 1) {
        h.clock.advance(20 * 60_000);
        expect((await g2.forwardAuth('/', NAV)).statusCode).toBe(200);
      }
      h.clock.advance(31 * 60_000);
      expect((await g2.forwardAuth('/', { accept: 'application/json' })).statusCode).toBe(401);
      expect((await idle.req('GET', '/auth/session')).statusCode).toBe(401);
    });

    it('reports the launch URL to owners/admins only', async () => {
      const fresh = await fullLogin(h, 'owner', PW, ownerSecret);
      const cfg = await fresh.req('GET', '/coolify-sso/config');
      expect(cfg.statusCode).toBe(200);
      expect(cfg.json()).toEqual({ enabled: true, url: `https://${K}/auth/oidc/redirect`, connections: [] });
      const operator = await fullLogin(h, 'oper', PW, operatorSecret);
      expect((await operator.req('GET', '/coolify-sso/config')).statusCode).toBe(403);
    });

    it('keeps tickets and gate ids out of the logs', () => {
      // Routes with secrets in the query string log at warn; nothing of the flow reaches the log text.
      expect(h.logs.text).not.toMatch(/ticket=[A-Za-z0-9_-]{43}/);
      expect(h.logs.text).not.toMatch(/__Host-rcs=/);
      expect(h.logs.text).not.toContain('/coolify-sso/callback?');
    });
  });

  // p5-stepup-window: these advance the fake clock by hours, so they run last (other tests' sessions idle out).
  describe('step-up window per session type (authorize)', () => {
    it('p5-stepup-window: a remember-me session keeps its login TOTP for the session ("Open Coolify" asks no code)', async () => {
      h.clock.advance(30_000);
      const client = h.client();
      await client.req('POST', '/auth/login', { username: 'owner', password: PW, remember: true });
      const verified = await client.req('POST', '/auth/totp/verify', { code: h.code(ownerSecret) });
      expect(verified.statusCode).toBe(200);
      const loginAt = Math.floor(h.clock.now().getTime() / 1000);
      // Hours later, well past the standard 10-minute window (a remembered session idles out after 7 days);
      // prompt=none proves that no interaction is needed.
      h.clock.advance(3 * 60 * 60_000);
      const { challenge, verifier } = pkce();
      const { code, params } = await codeFor(client, challenge, { prompt: 'none' });
      const tok = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: params.redirect_uri ?? REDIRECT,
        code_verifier: verifier,
        client_id: 'coolify',
        client_secret: SECRET,
      });
      expect(tok.statusCode).toBe(200);
      // auth_time is still the TOTP of the login (the step-up time), not the authorize time.
      expect(decodeJwt(tok.json<{ id_token: string }>().id_token).claims.auth_time).toBe(loginAt);
    });

    it('p5-stepup-window: a trusted-device login asks once, then holds; revoking the device ends that', async () => {
      // Trust this browser (a standard, not remembered, session).
      h.clock.advance(30_000);
      const first = h.client();
      await first.req('POST', '/auth/login', { username: 'owner', password: PW });
      const v = await first.req('POST', '/auth/totp/verify', {
        code: h.code(ownerSecret),
        trustDevice: true,
      });
      expect(v.statusCode).toBe(200);
      const deviceCookie = first.cookies.get('__Host-rtd');
      expect(deviceCookie).toBeDefined();
      // A later login on that device skips the code: no step-up yet.
      h.clock.advance(60 * 60_000);
      const client = h.client();
      client.cookies.set('__Host-rtd', deviceCookie ?? '');
      const login = await client.req('POST', '/auth/login', { username: 'owner', password: PW });
      expect(login.json()).toMatchObject({ status: 'authenticated' });
      const { challenge } = pkce();
      const none = await client.req('GET', authorizeUrl({ ...standard(challenge), prompt: 'none' }));
      expect(location(none).searchParams.get('error')).toBe('interaction_required');
      // One step-up (rotates the session) …
      h.clock.advance(30_000);
      expect((await client.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
      // … holds for the session: two hours later (active, so the 30-minute idle timeout does not end it)
      // Coolify signs in without a prompt.
      for (let i = 0; i < 6; i++) {
        h.clock.advance(20 * 60_000);
        expect((await client.req('GET', '/auth/session')).statusCode).toBe(200);
      }
      await codeFor(client, pkce().challenge, { prompt: 'none' });
      // Revoking the device turns the session back into a standard one (10-minute window).
      const devices = await client.req('GET', '/auth/devices');
      const current = devices
        .json<{ devices: { id: string; current: boolean }[] }>()
        .devices.find((d) => d.current);
      expect(current).toBeDefined();
      expect((await client.req('DELETE', `/auth/devices/${current?.id ?? ''}`)).statusCode).toBe(200);
      const after = await client.req('GET', authorizeUrl({ ...standard(pkce().challenge), prompt: 'none' }));
      expect(location(after).searchParams.get('error')).toBe('interaction_required');
    });
  });
});
