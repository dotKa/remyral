import { DEFAULT_ACCESS_LIMITS } from '../audit/access.js';
import { DEFAULT_RATE_LIMITS } from '../auth/service.js';

/**
 * p7-rate-limit: the one request-limit policy of the master (docs/design/p7-hardening.md §1).
 *
 * Every route belongs to exactly one {@link RouteClass}. The class decides
 *  - the fixed-window request budgets the central hooks enforce per client IP (before authentication,
 *    from the trusted client IP of src/http/client-ip.ts) and per user (after authentication);
 *  - the request body limit (Fastify `bodyLimit`) of routes that do not declare their own.
 *
 * Budgets that already existed are *referenced* here, not duplicated: the credential-attempt buckets of
 * the login/second-factor/step-up/password flows (AuthService, ADR-0009 §7), the per-user export/verify
 * buckets (AccessGate), the worker WebSocket connect bucket and per-connection message/byte token buckets
 * (workers/gateway.ts, connection.ts). The central
 * hooks skip the `device` and `worker-download` classes, whose routes limit themselves per IP and per
 * worker (see {@link WORKER_LIMITS}).
 */
export type RouteClass =
  'public' | 'auth' | 'read' | 'write' | 'export' | 'stream' | 'proxy' | 'device' | 'worker-download';

export const ROUTE_CLASSES: readonly RouteClass[] = [
  'public',
  'auth',
  'read',
  'write',
  'export',
  'stream',
  'proxy',
  'device',
  'worker-download',
];

export interface WindowRule {
  readonly max: number;
  readonly windowMs: number;
}

export interface ClassPolicy {
  /** Requests per client IP (null: not limited by the central hook). */
  readonly perIp: WindowRule | null;
  /** Requests per authenticated user (null: not limited by the central hook). */
  readonly perUser: WindowRule | null;
  /**
   * Body limit for routes of this class without their own `bodyLimit`: bytes, `global` (the configured
   * BODY_LIMIT_BYTES) or `route` (left to the route / its content-type parser, e.g. the proxy).
   */
  readonly bodyLimit: number | 'global' | 'route';
}

export type RequestLimitPolicy = Readonly<Record<RouteClass, ClassPolicy>>;

const MIN = 60_000;
const rule = (max: number, windowMs = MIN): WindowRule => ({ max, windowMs });

/** Defaults sized for a handful of operators per site (a console tab polls a few requests per second). */
export const DEFAULT_REQUEST_LIMITS: RequestLimitPolicy = {
  // Health checks: load balancers poll; cheap, but still bounded per source.
  public: { perIp: rule(1_200), perUser: null, bodyLimit: 8 * 1024 },
  // Coarse per-IP ceiling on every /auth/* request; the credential-attempt buckets are AUTH_ATTEMPT_LIMITS.
  auth: { perIp: rule(120), perUser: rule(120), bodyLimit: 8 * 1024 },
  read: { perIp: rule(1_200), perUser: rule(600), bodyLimit: 1024 },
  write: { perIp: rule(300), perUser: rule(120), bodyLimit: 'global' },
  // Heavy reads; additionally the per-user AccessGate buckets (EXPORT_LIMITS).
  export: { perIp: rule(60), perUser: rule(60), bodyLimit: 1024 },
  // Opening SSE streams; concurrency is CONNECTION_CAPS.liveStream.
  stream: { perIp: rule(120), perUser: rule(60), bodyLimit: 1024 },
  // High-frequency proxy endpoints (Traefik forward-auth); classed explicitly with `rateClass: 'proxy'`.
  proxy: { perIp: rule(3_000), perUser: rule(3_000), bodyLimit: 'route' },
  // Worker WebSocket: limited in the gateway (WORKER_LIMITS), not by the central hooks.
  device: { perIp: null, perUser: null, bodyLimit: 1024 },
  'worker-download': { perIp: null, perUser: null, bodyLimit: 1024 },
};

/** Credential attempts (login, TOTP, recovery, step-up, password change): enforced by AuthService. */
export const AUTH_ATTEMPT_LIMITS = DEFAULT_RATE_LIMITS;
/** Per-user export / chain-verification buckets: enforced by AccessGate. */
export const EXPORT_LIMITS = DEFAULT_ACCESS_LIMITS;

/** Per-worker and per-IP limits of the device-authenticated routes (enforced where the worker is known). */
export const WORKER_LIMITS = {
  /** WebSocket upgrades per IP (gateway, before any protocol work). */
  connectPerIp: rule(60),
  /** Established sessions per worker id (a worker in a reconnect loop churns DB state). */
  sessionsPerWorker: rule(60, 10 * MIN),
  /** Release downloads per IP and per worker (the token names the worker). */
  downloadPerIp: rule(60),
  downloadPerWorker: rule(30),
} as const;

/**
 * Concurrent long-lived connections per master process. Per-key = per user (live streams, proxy
 * sockets) or per client IP (worker sockets, before and after authentication).
 */
export const CONNECTION_CAPS = {
  liveStream: { perKey: 6, total: 500 },
  proxySocket: { perKey: 16, total: 200 },
  workerSocket: { perKey: 32, total: 512 },
  // p14-workflow-engine 14.4: webhook calls held for a `control.respond` answer (≤ 30 s each), per automation.
  webhookWait: { perKey: 4, total: 64 },
} as const;

/**
 * Slow-request protection (Node HTTP server timeouts). The keep-alive timeout stays at Fastify's 72 s
 * default on purpose: it must exceed the reverse proxy's idle timeout or reused connections race (502).
 */
export interface SlowRequestTimeouts {
  /** The complete request head must arrive within this time (slowloris); the socket is closed. */
  readonly headersMs: number;
  /** The complete request (head + body) must arrive within this time; 408 otherwise. */
  readonly requestMs: number;
  /** How often Node checks the two timeouts above. */
  readonly checkIntervalMs: number;
}

export const SLOW_REQUEST_TIMEOUTS: SlowRequestTimeouts = {
  headersMs: 10_000,
  requestMs: 30_000,
  checkIntervalMs: 2_000,
};

/**
 * Explicit classes for routes the default rules would misclassify. Keys are `METHOD url` as registered;
 * the policy test fails on keys that match no route (stale entries).
 */
export const ROUTE_CLASS_OVERRIDES: Readonly<Record<string, RouteClass>> = {
  'GET /audit/export': 'export',
  'GET /audit/verify': 'export',
  'GET /jobs/:id/export': 'export',
  'GET /context/export': 'export',
  'GET /jobs/:id/stream': 'stream',
  // p5-ops-chat: the live view of a chat thread.
  'GET /chat/threads/:id/stream': 'stream',
  'GET /v1/worker/releases/:version/manifest': 'worker-download',
  'GET /v1/worker/releases/:version/artifact': 'worker-download',
  // p5-worker-onboarding: anonymous installer downloads limit themselves per IP (installers/routes.ts).
  'GET /v1/worker/install/:version/:os/:file': 'worker-download',
  'GET /v1/worker/install/:version/:file': 'worker-download',
  // p19-ide W3: an IDE start's VSIX blobs and synced settings (they limit themselves per IP; token per start).
  'GET /v1/worker/ide/extensions/:sha256': 'worker-download',
  'GET /v1/worker/ide/settings/:workspaceId': 'worker-download',
};

/**
 * Routes whose declared `bodyLimit` may exceed their class limit (with the reason). Anything else that
 * declares a larger limit fails the policy test.
 */
export const BODY_LIMIT_EXCEPTIONS: Readonly<Record<string, string>> = {
  'POST /chat/threads/:id/attachments':
    'one chat attachment base64 in the JSON body (≤ 3.75 MiB raw, CHAT_ATTACHMENT_BODY_LIMIT, p8-chat-attachments-mentions)',
  'POST /jobs':
    'workspace job inputs travel base64 in the JSON body (≤ 10 MiB of files, JOB_CREATE_BODY_LIMIT, p5-research-workspace)',
  'POST /workflows/:id/runs':
    'workspace run files travel base64 in the JSON body (≤ 10 MiB of files, JOB_CREATE_BODY_LIMIT, p5-research-workspace-next)',
  'POST /workflows':
    'v2 definitions ≤ 200 nodes with config (≤ 512 KiB of JSON + envelope, WORKFLOW_DEFINITION_BODY_LIMIT, p14-workflow-engine)',
  'PUT /workflows/:id':
    'v2 definitions ≤ 200 nodes with config (≤ 512 KiB of JSON + envelope, WORKFLOW_DEFINITION_BODY_LIMIT, p14-workflow-engine)',
  'POST /workflows/ai/threads/:id/messages':
    'the editor’s current workflow document travels with the request (≤ 512 KiB of JSON + text, p15-workflow-ai)',
  'POST /workflows/validate':
    'v2 definitions ≤ 200 nodes with config (≤ 512 KiB of JSON + envelope, WORKFLOW_DEFINITION_BODY_LIMIT, p14-workflow-engine)',
  'POST /automations':
    'workspace automation input files travel base64 in the JSON body (≤ 10 MiB, JOB_CREATE_BODY_LIMIT, p5-research-workspace-next)',
  'PATCH /automations/:id':
    'workspace automation input files travel base64 in the JSON body (≤ 10 MiB, JOB_CREATE_BODY_LIMIT, p5-research-workspace-next)',
  'POST /automation-groups':
    'the automation input of every project of the group, input files base64 in the JSON body (≤ 10 MiB, JOB_CREATE_BODY_LIMIT, p18-multi-project W4)',
  'POST /schedules':
    'scheduled workspace job / run input files travel base64 in the JSON body (≤ 10 MiB, JOB_CREATE_BODY_LIMIT, p5-research-workspace-next)',
  'POST /memory-imports/preview':
    'a pasted memory export (≤ 256 KB of text, JSON-escaped ≤ 1 MiB, MEMORY_IMPORT_BODY_LIMIT, p17-memory-import)',
  'POST /memory-imports':
    'the reviewed memory export items (≤ 256 KB of text, JSON-escaped ≤ 1 MiB, MEMORY_IMPORT_BODY_LIMIT, p17-memory-import)',
  'POST /projects/:id/input-uploads':
    'the declared file list of a job input bundle (≤ 2000 entries of path + size + SHA-256, ≤ 1 MiB, p16-zip-job-input)',
  'PUT /projects/:id/input-uploads/:uploadId/parts/:n':
    'one raw part (≤ 4 MiB, INPUT_BUNDLE_LIMITS.partBytes) of a chunked job input bundle upload (p16-zip-job-input)',
  'POST /releases': 'signed worker release upload (base64 artifact, RELEASE_UPLOAD_BODY_LIMIT)',
  'PUT /releases/uploads/:id/parts/:n':
    'one raw part (≤ 4 MiB, UPLOAD_PART_MAX_BYTES) of a chunked release upload (p6-release-upload)',
  'POST /projects/:id/site-uploads':
    'the declared file list of a static site upload (≤ 500 entries of path + size + SHA-256, ≤ 256 KiB, p10-site-upload)',
  'PUT /projects/:id/site-uploads/:uploadId/parts/:n':
    'one raw part (≤ 4 MiB, SITE_UPLOAD_LIMITS.partBytes) of a chunked static site upload (p10-site-upload)',
  'POST /skills':
    'signed skill upload (≤ 512 KiB of files with layout v2 + manifest, SKILL_UPLOAD_BODY_LIMIT = 2 MiB, p14-skill-catalogs)',
  'POST /skills/imports':
    'skill import preview: a zip (≤ 2 MiB) or a folder’s files base64 in the JSON body (≤ 3 MiB, SKILL_IMPORT_BODY_LIMIT, p14-skill-import)',
  'POST /vault/credentials': 'per-worker ciphertext (≤ 32 workers × ≤ 22 KB, VAULT_BODY_LIMIT)',
  'PUT /vault/credentials/:id/value': 'per-worker ciphertext (≤ 32 workers × ≤ 22 KB, VAULT_BODY_LIMIT)',
  'POST /v1/hooks/github':
    'GitHub App deliveries (pull request / push payloads; ≤ 1 MiB, GITHUB_HOOK_BODY_LIMIT, p6-automations), signature-checked first',
  'POST /v1/hooks/wait/:token':
    'wait-for-webhook resume payloads (≤ 64 KiB, WAIT_HOOK_BODY_LIMIT, p14-workflow-engine), token + signature checked first',
  'POST /v1/hooks/:id':
    'signed automation webhooks (≤ 256 KiB, WEBHOOK_BODY_LIMIT; event data ≤ 64 KiB, p6-automations), signature-checked first',
};

export interface RouteShape {
  readonly method: string;
  readonly url: string;
  /** `config.auth` (undefined = full). */
  readonly auth: string | undefined;
  /** Explicit `config.rateClass`. */
  readonly rateClass?: RouteClass | undefined;
}

/** The class of a route: explicit config, then the override table, then the default rules. */
export function classifyRoute(route: RouteShape): RouteClass {
  if (route.rateClass !== undefined) return route.rateClass;
  const override = ROUTE_CLASS_OVERRIDES[`${route.method} ${route.url}`];
  if (override !== undefined) return override;
  if (route.url === '/auth' || route.url.startsWith('/auth/')) return 'auth';
  if (route.auth === 'device') return 'device';
  if (route.auth === 'public') return 'public';
  if (route.auth === 'mfa_pending' || route.auth === 'enrollment' || route.auth === 'password_change') {
    return 'auth';
  }
  return route.method === 'GET' || route.method === 'HEAD' || route.method === 'OPTIONS' ? 'read' : 'write';
}

/** Class of a request that matched no route (404s are still limited per IP). */
export function classifyUnrouted(method: string): RouteClass {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write';
}

/** The body limit a route gets from its class (undefined: leave it to the route). */
export function classBodyLimit(
  policy: RequestLimitPolicy,
  cls: RouteClass,
  globalLimit: number,
): number | undefined {
  const b = policy[cls].bodyLimit;
  if (b === 'route') return undefined;
  if (b === 'global') return globalLimit;
  return Math.min(b, globalLimit);
}

/** Multiplies every budget (ops tuning via RATE_LIMIT_SCALE, generous test harnesses). */
export function scaleRequestLimits(policy: RequestLimitPolicy, factor: number): RequestLimitPolicy {
  const scale = (r: WindowRule | null): WindowRule | null =>
    r === null ? null : { max: Math.max(1, Math.round(r.max * factor)), windowMs: r.windowMs };
  const each = (p: ClassPolicy): ClassPolicy => ({ ...p, perIp: scale(p.perIp), perUser: scale(p.perUser) });
  return {
    public: each(policy.public),
    auth: each(policy.auth),
    read: each(policy.read),
    write: each(policy.write),
    export: each(policy.export),
    stream: each(policy.stream),
    proxy: each(policy.proxy),
    device: each(policy.device),
    'worker-download': each(policy['worker-download']),
  };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** p7-rate-limit route class (default: derived by {@link classifyRoute}). */
    rateClass?: RouteClass;
  }
}
