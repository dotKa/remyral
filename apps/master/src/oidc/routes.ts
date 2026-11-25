import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../auth/hooks.js';
import { type SessionRecord, sessions } from '../auth/sessions.js';
import type { Pool } from '../db/pool.js';
import { GATE_COOKIE, type CoolifyGate } from './gate.js';
import {
  type AuthorizeOutcome,
  isOutcome,
  type OidcProvider,
  OidcError,
  type RequestMeta,
} from './provider.js';

/**
 * HTTP surface of p5-coolify-sso (docs/design/p5-coolify-sso.md). Every route is registered even when the
 * feature is not configured (route coverage); unconfigured halves answer 404.
 *
 * All routes except `/coolify-sso/config` are `auth: 'public'` at the hook level because they must answer
 * with redirects or OAuth error bodies instead of the generic 401: each one authenticates in its handler
 * (console session, client secret, bearer token, gate cookie or ticket) — the route-coverage test lists
 * them explicitly and coolify-sso.test.ts checks each refusal.
 */
export interface SsoRouteDeps {
  readonly pool: Pool;
  readonly provider: OidcProvider | null;
  readonly gate: CoolifyGate | null;
  readonly clock: () => Date;
  /** p13-multi-coolify: the Coolify connections ("Open Coolify" per connection; no tokens in the view). */
  readonly coolifyConnections?: () => Promise<
    readonly {
      readonly id: string;
      readonly label: string;
      readonly url: string;
      readonly openUrl: string | null;
      readonly useServerSso: boolean;
      readonly isDefault: boolean;
    }[]
  >;
}

/** An https link without credentials, or null. */
function httpsLink(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.username === '' && u.password === '' ? u.href : null;
  } catch {
    return null;
  }
}

const FORM = 'application/x-www-form-urlencoded';

interface ParsedForm {
  readonly values: Map<string, string>;
  readonly repeated: boolean;
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
}

/** The request's full console session (cookie `__Host-ras`), or null. Touches it like the auth hook. */
async function consoleSession(pool: Pool, request: FastifyRequest, now: Date): Promise<SessionRecord | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined) return null;
  const session = await sessions.find(pool, token, now);
  if (session?.stage !== 'full') return null;
  await sessions.touch(pool, session, now);
  return session;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/' };

export function ssoRoutes(deps: SsoRouteDeps) {
  return (app: FastifyInstance): void => {
    // OAuth token requests are form-encoded (RFC 6749 §4.1.3). Registered in this encapsulated scope only:
    // the rest of the API stays JSON-only.
    app.addContentTypeParser(FORM, { parseAs: 'string', bodyLimit: 8 * 1024 }, (_req, body, done) => {
      const values = new Map<string, string>();
      let repeated = false;
      for (const [k, v] of new URLSearchParams(String(body))) {
        if (values.has(k)) repeated = true;
        values.set(k, v);
      }
      done(null, { values, repeated } satisfies ParsedForm);
    });

    const pub = { auth: 'public' as const };
    const quiet = { logLevel: 'warn' as const, exposeHeadRoute: false };

    const sendOutcome = (reply: FastifyReply, outcome: AuthorizeOutcome) => {
      if (outcome.kind === 'page') {
        return reply
          .code(outcome.status)
          .send({ error: outcome.error, error_description: outcome.description });
      }
      return reply.code(302).header('location', outcome.location).send();
    };

    const sendOidcError = (reply: FastifyReply, err: unknown) => {
      if (!(err instanceof OidcError)) throw err;
      for (const [k, v] of Object.entries(err.headers)) void reply.header(k, v);
      return reply
        .code(err.status)
        .header('pragma', 'no-cache')
        .send({ error: err.error, error_description: err.description });
    };

    // ------------------------------------------------------------------------------------ OIDC provider

    app.get(
      '/oidc/.well-known/openid-configuration',
      { config: pub, exposeHeadRoute: false, schema: { hide: true } },
      (_request, reply) => {
        if (deps.provider === null) return notFound(reply);
        return reply.header('cache-control', 'public, max-age=300').send(deps.provider.discovery());
      },
    );

    app.get(
      '/oidc/jwks',
      { config: pub, exposeHeadRoute: false, schema: { hide: true } },
      (_request, reply) => {
        if (deps.provider === null) return notFound(reply);
        return reply.header('cache-control', 'public, max-age=300').send(deps.provider.jwks());
      },
    );

    app.get('/oidc/authorize', { config: pub, ...quiet, schema: { hide: true } }, async (request, reply) => {
      const provider = deps.provider;
      if (provider === null) return notFound(reply);
      const parsed = provider.parseAuthorize(request.query as Record<string, unknown>);
      if (isOutcome(parsed)) return sendOutcome(reply, parsed);
      const session = await consoleSession(deps.pool, request, deps.clock());
      return sendOutcome(reply, await provider.decide(parsed, session, meta(request)));
    });

    app.get(
      '/oidc/authorize/resume',
      { config: pub, ...quiet, schema: { hide: true } },
      async (request, reply) => {
        const provider = deps.provider;
        if (provider === null) return notFound(reply);
        const q = request.query as Record<string, unknown>;
        const parsed = provider.openRequest(q.r);
        if (isOutcome(parsed)) return sendOutcome(reply, parsed);
        const session = await consoleSession(deps.pool, request, deps.clock());
        return sendOutcome(reply, await provider.decide(parsed, session, meta(request)));
      },
    );

    app.post(
      '/oidc/token',
      { config: pub, logLevel: 'warn', schema: { hide: true } },
      async (request, reply) => {
        const provider = deps.provider;
        if (provider === null) return notFound(reply);
        void reply.header('pragma', 'no-cache');
        const body = request.body as ParsedForm | undefined;
        if (body === undefined || !(body.values instanceof Map)) {
          return sendOidcError(reply, new OidcError(400, 'invalid_request', `The body must be ${FORM}.`));
        }
        if (body.repeated) {
          return sendOidcError(
            reply,
            new OidcError(400, 'invalid_request', 'A parameter was sent more than once.'),
          );
        }
        try {
          return await reply.send(
            await provider.token(body.values, header(request, 'authorization'), meta(request)),
          );
        } catch (err) {
          return sendOidcError(reply, err);
        }
      },
    );

    const userinfo = async (request: FastifyRequest, reply: FastifyReply) => {
      const provider = deps.provider;
      if (provider === null) return notFound(reply);
      try {
        return await reply.send(await provider.userinfo(header(request, 'authorization')));
      } catch (err) {
        return sendOidcError(reply, err);
      }
    };
    app.get('/oidc/userinfo', { config: pub, exposeHeadRoute: false, schema: { hide: true } }, userinfo);
    app.post('/oidc/userinfo', { config: pub, schema: { hide: true } }, userinfo);

    // ------------------------------------------------------------------------------------ Coolify gate

    // Called by Traefik's forwardAuth middleware over the Docker network (never routed publicly).
    app.get(
      '/forward-auth/coolify',
      { config: { ...pub, rateClass: 'proxy' }, ...quiet, schema: { hide: true } },
      async (request, reply) => {
        const gate = deps.gate;
        if (gate === null) return notFound(reply);
        const mode = header(request, 'sec-fetch-mode');
        const accept = header(request, 'accept') ?? '';
        const upgrade = header(request, 'upgrade');
        const navigation =
          upgrade === undefined &&
          (mode === 'navigate' || (mode === undefined && accept.includes('text/html')));
        const decision = await gate.forwardAuth({
          forwardedHost: header(request, 'x-forwarded-host'),
          forwardedMethod: header(request, 'x-forwarded-method'),
          forwardedUri: header(request, 'x-forwarded-uri'),
          gateCookie: request.cookies[GATE_COOKIE],
          navigation,
        });
        switch (decision.kind) {
          case 'allow':
            return reply.code(200).send();
          case 'wrong_host':
            request.log.warn('forward-auth called for an unexpected host');
            return reply.code(403).send({ error: 'forbidden', message: 'Not allowed.' });
          case 'deny':
            return reply.code(401).send({ error: 'unauthorized', message: 'Sign in through the console.' });
          case 'login':
            void reply.setCookie(decision.stateCookie.name, decision.stateCookie.value, {
              ...COOKIE_BASE,
              maxAge: 300,
            });
            return reply.code(302).header('location', decision.location).send();
        }
      },
    );

    // Console host: issues the one-time ticket for the browser that started the gate flow.
    app.get(
      '/coolify-sso/ticket',
      { config: pub, ...quiet, schema: { hide: true } },
      async (request, reply) => {
        const gate = deps.gate;
        if (gate === null) return notFound(reply);
        const session = await consoleSession(deps.pool, request, deps.clock());
        const outcome = await gate.ticket(
          (request.query as Record<string, unknown>).r,
          session,
          meta(request),
        );
        if (outcome.kind === 'invalid') {
          return reply.code(400).send({
            error: 'sso_request_invalid',
            message: 'This Coolify sign-in link has expired. Open Coolify again from the console.',
          });
        }
        return reply.code(302).header('location', outcome.location).send();
      },
    );

    // Gate host (Traefik rewrites /_remana/sso/callback): ticket + state cookie → gate cookie.
    app.get(
      '/coolify-sso/callback',
      { config: pub, ...quiet, schema: { hide: true } },
      async (request, reply) => {
        const gate = deps.gate;
        if (gate === null) return notFound(reply);
        const q = request.query as Record<string, unknown>;
        const outcome = await gate.callback(
          { host: request.host, ticket: q.ticket, sealed: q.r, cookies: request.cookies },
          meta(request),
        );
        if (outcome === null) return notFound(reply);
        if (outcome.clearState !== null) void reply.clearCookie(outcome.clearState, COOKIE_BASE);
        if (outcome.kind === 'invalid') {
          return reply.code(400).send({
            error: 'sso_failed',
            message: 'Single sign-on could not be completed. Open Coolify again from the console.',
          });
        }
        const maxAge = Math.max(1, Math.floor((outcome.expiresAt.getTime() - deps.clock().getTime()) / 1000));
        void reply.setCookie(GATE_COOKIE, outcome.token, { ...COOKIE_BASE, maxAge });
        return reply.code(302).header('location', outcome.location).send();
      },
    );

    // Console: is the button available, and where does it go (owner/admin).
    app.get(
      '/coolify-sso/config',
      {
        config: { authz: { action: 'sso.coolify' } },
        schema: { tags: ['sso'], summary: 'Coolify single sign-on: availability and launch URL' },
      },
      async () => {
        const gate = deps.gate;
        // With the OIDC provider the button lands signed in (Coolify's OIDC entry point); without it, on
        // Coolify's own login page behind the gate.
        const gateUrl =
          gate === null ? null : deps.provider === null ? `https://${gate.host}/` : gate.launchUrl;
        // p13-multi-coolify: one entry per connection — the SSO gate for connections that use it while it is
        // configured, else the connection's browser link (its open URL, else its https API base).
        const list = deps.coolifyConnections === undefined ? [] : await deps.coolifyConnections();
        const connections = list
          .map((c) => {
            const sso = c.useServerSso && gateUrl !== null;
            const url = sso ? gateUrl : (httpsLink(c.openUrl) ?? httpsLink(c.url));
            return { id: c.id, label: c.label, isDefault: c.isDefault, sso, url };
          })
          .filter((c): c is typeof c & { url: string } => c.url !== null);
        return gateUrl === null
          ? { enabled: false, url: null, connections }
          : { enabled: true, url: gateUrl, connections };
      },
    );
  };
}
