import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { stepUpClassOf } from './auth/hooks.js';
import type { StepUpClass } from './auth/step-up.js';
import { type ClientIpHeaderConfig, registerClientIpHeader } from './http/client-ip.js';
import { registerErrorHandling } from './http/errors.js';
import { type Authenticator, denyAllAuthenticator, routeAuthLevel } from './http/route-auth.js';
import { type Authorizer, denyAllAuthorizer } from './http/route-authz.js';
import { loggerOptions, type LogLevel } from './logging.js';
import { activeTraceIds, type Telemetry } from '@remyral/observability/telemetry';
import { registerHttpTelemetry } from './telemetry/instrument.js';
import { registerIpLimiter, registerUserLimiter, type RequestLimiterDeps } from './http/request-limits.js';
import { registerTokenLimiter, type TokenLimiterDeps } from './api-tokens/limits.js';
import { scopeForAction, type TokenScope } from './api-tokens/scopes.js';
import { auditRequestContext } from './audit/request-context.js';
import { OPENAPI_SECURITY_SCHEMES, OPENAPI_TAGS, openApiTransform } from './http/openapi.js';
import { webhooksOpenApi } from './webhooks-out/openapi.js';
import type { DependencyHealth } from './infra/dependency-health.js';
import {
  classBodyLimit,
  classifyRoute,
  DEFAULT_REQUEST_LIMITS,
  type RouteClass,
  SLOW_REQUEST_TIMEOUTS,
  type SlowRequestTimeouts,
} from './http/rate-policy.js';

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  /** `config.auth` (undefined = full session). */
  readonly auth: string | undefined;
  /** `config.authz.action`, if the route declares an authorization rule. */
  readonly action: string | undefined;
  /** p7-rate-limit route class (rate-policy.ts). */
  readonly rateClass: RouteClass;
  /** Effective body limit in bytes (the route's own or its class's; undefined = Fastify's global). */
  readonly bodyLimit: number | undefined;
  /** p5-stepup-window: class of the route's `requireStepUp` preHandler (undefined = none). */
  readonly stepUp: StepUpClass | undefined;
  /**
   * p16-api-tokens: the token scope a full-session route needs (null: session only — the action has no scope, or the
   * route is an SSE stream); undefined for routes that are not full-session.
   */
  readonly tokenScope: TokenScope | null | undefined;
  /** p16-api-tokens: the route declares a request body schema (the OpenAPI completeness test checks its requestBody). */
  readonly hasBody: boolean;
  /** The route is hidden from the OpenAPI document (`schema.hide`). */
  readonly hidden: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered on this instance (filled by an onRoute hook); used by the auth coverage test. */
    readonly registeredRoutes: readonly RegisteredRoute[];
  }
}

export type RoutePlugin = (app: FastifyInstance) => void | Promise<void>;

export interface AppOptions {
  readonly logLevel: LogLevel;
  /**
   * p22-ops-hygiene: the shared dependency-health gate (created after the app, hence a getter): a request that failed
   * because Redis / Postgres do not answer is reported there (one warning per outage) and answered 503.
   */
  readonly dependencyHealth?: () => DependencyHealth | null;
  /** p17-panel-settings: a function is read per request (the panel can change it without a restart). */
  readonly trustProxyHops: number | (() => number);
  /**
   * Optional CDN client-IP header (e.g. `cf-connecting-ip`), honoured only when the proxy-derived peer is
   * in the trusted source ranges (src/http/client-ip.ts). Unset: the header is ignored. p17-panel-settings: a function
   * is read per request (null: no header).
   */
  readonly clientIpHeader?: ClientIpHeaderConfig | (() => ClientIpHeaderConfig | null);
  readonly bodyLimitBytes: number;
  /**
   * p7-rate-limit: central per-IP / per-user request budgets by route class. Absent: not limited (unit
   * tests of the skeleton); the composed master always sets it.
   */
  readonly requestLimits?: RequestLimiterDeps;
  /** p7-rate-limit slow-request timeouts (default SLOW_REQUEST_TIMEOUTS; tests shorten them). */
  readonly timeouts?: Partial<SlowRequestTimeouts>;
  /** Optional log destination (tests capture logs here). Defaults to stdout. */
  readonly logStream?: NodeJS.WritableStream;
  readonly authenticator?: Authenticator;
  readonly authorizer?: Authorizer;
  /**
   * Test seam for the authorization matrix (never set in production): a request carrying the header
   * `x-authz-probe: 1` is answered with 204 right after a successful authorization decision, before
   * validation and handlers, so every route × role can be checked without side effects.
   */
  readonly authzProbe?: boolean;
  /** Runs on the root instance before the route plugins (decorators shared with them). */
  readonly beforeRoutes?: (app: FastifyInstance) => void;
  readonly routes: readonly RoutePlugin[];
  /** p6-otel: HTTP spans/metrics and trace ids in log lines (docs/design/p6-observability.md). */
  readonly telemetry?: Telemetry;
  /** p16-api-tokens: per-token request budgets and concurrency (absent: not limited — unit tests of the skeleton). */
  readonly tokenLimits?: TokenLimiterDeps;
  /** The version in the OpenAPI document's `info`. */
  readonly apiVersion?: string;
  /**
   * p19-ide W2 (ADR-0066): the IDE origin (IDE_ORIGIN; null: not configured). Requests to its host reach only the IDE
   * origin's routes (`config.ideOrigin`); every other route answers 404 there, before authentication.
   */
  readonly ideOrigin?: () => string | null;
}

export const CONTENT_SECURITY_POLICY = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
} as const;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const timeouts = { ...SLOW_REQUEST_TIMEOUTS, ...opts.timeouts };
  const app = Fastify({
    logger: {
      ...loggerOptions(opts.logLevel, opts.logStream),
      // Log ↔ trace correlation: trace_id/span_id of the active span on every line (only when tracing).
      ...(opts.telemetry?.tracing === true ? { mixin: () => activeTraceIds() } : {}),
    },
    // Trust X-Forwarded-For only for the configured number of reverse-proxy hops (request.ip feeds rate limits).
    trustProxy:
      typeof opts.trustProxyHops === 'function'
        ? (() => {
            const hops = opts.trustProxyHops;
            return (_address: string, hop: number) => hop < hops();
          })()
        : opts.trustProxyHops > 0
          ? (_address: string, hop: number) => hop < (opts.trustProxyHops as number)
          : false,
    bodyLimit: opts.bodyLimitBytes,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    // Slow requests (p7-rate-limit): the whole request within requestMs (408), its head within headersMs
    // (socket closed) — checked every checkIntervalMs by Node's HTTP server.
    requestTimeout: timeouts.requestMs,
    http: {
      headersTimeout: timeouts.headersMs,
      requestTimeout: timeouts.requestMs,
      connectionsCheckingInterval: timeouts.checkIntervalMs,
    },
    genReqId: () => randomUUID(),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });

  const routes: RegisteredRoute[] = [];
  app.decorate('registeredRoutes', routes);
  const limitPolicy = opts.requestLimits?.policy ?? DEFAULT_REQUEST_LIMITS;
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const auth = route.config?.auth;
    const action = route.config?.authz?.action;
    // p7-rate-limit: one class per route (a multi-method route takes the class of its first method; the
    // policy test checks every method), and the class's body limit unless the route declares its own.
    const classes = methods.map((m) =>
      classifyRoute({ method: String(m), url: route.url, auth, rateClass: route.config?.rateClass }),
    );
    const rateClass = classes[0] ?? 'read';
    route.config = { ...route.config, rateClass };
    if (route.bodyLimit === undefined) {
      const limit = classBodyLimit(limitPolicy, rateClass, opts.bodyLimitBytes);
      if (limit !== undefined) route.bodyLimit = limit;
    }
    const handlers: unknown[] = Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    const stepUp = handlers.map(stepUpClassOf).find((c) => c !== undefined);
    // p16-api-tokens: the bearer authenticator needs the step-up class before the preHandlers run.
    if (stepUp !== undefined) route.config = { ...route.config, stepUpClass: stepUp };
    const full = auth === undefined || auth === 'full';
    const tokenScope = !full ? undefined : rateClass === 'stream' ? null : scopeForAction(action);
    for (const [i, method] of methods.entries()) {
      routes.push({
        method: String(method),
        url: route.url,
        auth,
        action,
        rateClass: classes[i] ?? rateClass,
        bodyLimit: route.bodyLimit,
        stepUp,
        tokenScope,
        hasBody: route.schema?.body !== undefined,
        hidden: (route.schema as { hide?: boolean } | undefined)?.hide === true,
      });
    }
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Strict JSON: only application/json bodies are accepted (no text/plain), anything else is 415.
  app.removeContentTypeParser('text/plain');

  registerErrorHandling(app, {
    dependencyDown: (err) => {
      const health = opts.dependencyHealth?.() ?? null;
      if (health === null) return false;
      void health.report(err);
      return true;
    },
  });

  // p6-otel: first onRequest hook, so the request span is active for everything that follows.
  if (opts.telemetry) registerHttpTelemetry(app, opts.telemetry);

  // First onRequest hook: everything after it (rate limits, sessions, audit) sees the resolved client IP.
  if (opts.clientIpHeader) registerClientIpHeader(app, opts.clientIpHeader);

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CONTENT_SECURITY_POLICY },
    crossOriginEmbedderPolicy: true,
    referrerPolicy: { policy: 'no-referrer' },
  });

  // p7-rate-limit: per client IP, before the session lookup (after helmet so a 429 still carries the
  // security headers).
  if (opts.requestLimits) registerIpLimiter(app, opts.requestLimits);

  // API responses are never cacheable (they may carry session-bound data).
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    return payload;
  });

  // Cookie parsing must run before the auth hook below (hooks run in registration order).
  await app.register(cookie, { hook: 'onRequest' });
  app.decorateRequest('auth', null);

  // p19-ide W2: the IDE origin serves only its own routes (the console never runs on it, and it never on the console).
  const ideOrigin = opts.ideOrigin;
  if (ideOrigin !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      const origin = ideOrigin();
      if (origin === null || request.routeOptions.config.ideOrigin === true) return;
      let ideHost: string;
      try {
        ideHost = new URL(origin).host.toLowerCase();
      } catch {
        return;
      }
      if (request.host.toLowerCase() !== ideHost) return;
      await reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    });
  }

  // requireAuth: one global hook, before body parsing, for every route (including unknown URLs).
  const authenticator = opts.authenticator ?? denyAllAuthenticator;
  app.addHook('onRequest', async (request, reply) => {
    const level = routeAuthLevel(request);
    // `device` routes (the worker WebSocket) authenticate the device in-band, never with a human session.
    if (level === 'public' || level === 'device') return;
    await authenticator.authenticate(request, reply, level);
  });
  // p7-rate-limit: per user, right after authentication.
  if (opts.requestLimits) registerUserLimiter(app, opts.requestLimits);
  // p16-api-tokens: per token (budget + concurrency), after the per-user budget.
  if (opts.tokenLimits) registerTokenLimiter(app, opts.tokenLimits);

  // Authorization (docs/design/p5-rbac.md): every full-session route is checked against its declared
  // rule before validation; undeclared routes are refused (deny by default). Login steps have no subject.
  const authorizer = opts.authorizer ?? denyAllAuthorizer;
  app.decorateRequest('authz', null);
  // p16-api-tokens: audit entries written while serving a token request name the token (`metadata.viaApi`). Entered
  // after body parsing, so the authorization hook, the preHandlers and the handler all run inside it.
  app.addHook('preValidation', (request, _reply, done) => {
    const token = request.auth?.token;
    if (token === undefined) {
      done();
      return;
    }
    auditRequestContext.run({ apiTokenId: token.id }, done);
  });
  app.addHook('preValidation', async (request, reply) => {
    if (request.is404 || routeAuthLevel(request) !== 'full') return;
    await authorizer.authorize(request, request.routeOptions.config.authz);
    if (opts.authzProbe === true && request.headers['x-authz-probe'] === '1') {
      return reply.code(204).header('x-authz', 'allowed').send();
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Remyral master API',
        version: opts.apiVersion ?? '0.0.0',
        description:
          'The REST API of the Remyral master (docs/design/p16-api-tokens.md). Authenticate with an API token (`Authorization: Bearer ryl_…`) or a console session. Each operation lists its token scope in `x-token-scope`.',
      },
      servers: [{ url: '/api', description: 'Through the console origin (the proxy strips /api).' }],
      tags: [...OPENAPI_TAGS],
      components: { securitySchemes: { ...OPENAPI_SECURITY_SCHEMES } },
    },
    // The paths are the master's own (`/jobs`); `servers` says clients reach them under `/api`. Without this the
    // plugin would strip `/api` from routes that merely start with it (`/api-tokens`).
    stripBasePath: false,
    transform: openApiTransform(jsonSchemaTransform),
  });

  // p16-api-tokens: the OpenAPI document is public (schemas and descriptions only, no data, no secret); the console's
  // API page and external clients read it at /api/openapi.json.
  // p16-webhooks-out: the outgoing webhook catalog as OpenAPI 3.1 `webhooks`.
  app.get('/openapi.json', { schema: { hide: true }, config: { auth: 'public' } }, () => ({
    ...app.swagger(),
    webhooks: webhooksOpenApi(),
  }));

  opts.beforeRoutes?.(app);
  for (const plugin of opts.routes) {
    await app.register(async (scope) => {
      await plugin(scope);
    });
  }

  return app;
}
