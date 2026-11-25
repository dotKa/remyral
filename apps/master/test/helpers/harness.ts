import type { Telemetry } from '@remyral/observability/telemetry';
import type { OpenVsxClient } from '../../src/ide/openvsx.js';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { RoutePlugin } from '../../src/app.js';
import type { AccessLimits } from '../../src/audit/access.js';
import type { RateLimiter } from '../../src/auth/rate-limit.js';
import { AuditLog } from '../../src/audit/audit.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/auth/hooks.js';
import type { ScryptParams } from '../../src/auth/password.js';
import { SecretBox } from '../../src/auth/secret-box.js';
import type { RateLimits } from '../../src/auth/service.js';
import { base32Decode, totpAt } from '../../src/auth/totp.js';
import type { Role } from '../../src/auth/users.js';
import { createUser } from '../../src/cli/admin.js';
import {
  createMasterApp,
  type GitFlowConfig,
  type LiveConfig,
  type MasterDeps,
  type NotificationsDeps,
  type OrchestrationConfig,
  type WorkerGatewayConfig,
} from '../../src/compose.js';
import type { RedisClient } from '../../src/redis.js';
import type { ClientIpHeaderConfig } from '../../src/http/client-ip.js';
import {
  DEFAULT_REQUEST_LIMITS,
  type RequestLimitPolicy,
  scaleRequestLimits,
  type SlowRequestTimeouts,
} from '../../src/http/rate-policy.js';
import { createTestDatabase, createTestRedis, type TestDatabase, uniquePrefix } from './env.js';
import {
  scaleTokenLimits,
  TOKEN_REQUEST_LIMITS,
  type TokenLimitPolicy,
} from '../../src/api-tokens/limits.js';
import { LogCapture } from './logs.js';
import { Redactor } from '@remyral/observability';
import { redactingLogStream } from '../../src/logging.js';

/** Cheap scrypt parameters for integration tests (production parameters are covered by unit tests). */
export const FAST_SCRYPT: ScryptParams = { log2N: 10, r: 8, p: 1, keyLen: 32, saltLen: 16 };

export class FakeClock {
  constructor(private t: number = Date.parse('2026-10-12T12:00:00.000Z')) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface HarnessOptions {
  /** p15-watches: dry-test wait / queue timeout of check watches. */
  readonly watchChecks?: { readonly dryWaitMs?: number; readonly queueTimeoutSec?: number };
  /** p16-chat-complete: chat settings for the test (e.g. the restart recovery's grace). */
  readonly chat?: MasterDeps['chat'];
  readonly rateLimits?: RateLimits;
  readonly totpSecretFactory?: () => Buffer;
  readonly extraRoutes?: readonly RoutePlugin[];
  readonly accessLimits?: AccessLimits;
  readonly exportLimits?: { readonly maxRecords?: number; readonly maxBytes?: number };
  /** p5-rbac matrix seam: `x-authz-probe: 1` answers 204 after a successful authorization decision. */
  readonly authzProbe?: boolean;
  readonly workers?: WorkerGatewayConfig;
  readonly limiter?: RateLimiter;
  /** p4 orchestration; default: no background loop (tests call orchestrator.tick()). */
  readonly orchestration?: OrchestrationConfig;
  /** p2-signed-updates: release public keys and download rate limit. */
  readonly releases?: {
    readonly publicKeys?: readonly string[];
    readonly downloadRateLimit?: { readonly perIp: number; readonly windowMs: number };
    readonly channelPollIntervalMs?: number;
  };
  /** p5-worker-onboarding: Add machine (public origin, anonymous downloads, download limit). */
  /** p19-ide W2: the IDE origin (IDE_ORIGIN). */
  readonly ide?: {
    readonly origin: string | null;
    /** p19-ide W3: an Open VSX client with a fake registry. */
    readonly openVsx?: OpenVsxClient;
  };
  readonly installers?: {
    readonly publicOrigin?: string | null;
    readonly publicDownloads?: boolean;
    readonly downloadRateLimit?: { readonly perIp: number; readonly windowMs: number };
  };
  /** p5-remote-ops: operation limits. */
  readonly remoteOpsLimits?: MasterDeps['remoteOpsLimits'];
  /** p5-notifications: outbound channels and options (no background loop: tests call runOnce()). */
  readonly notifications?: NotificationsDeps;
  /** p4-git-flow: provider factory (local bare repositories) and timing. */
  readonly gitflow?: GitFlowConfig;
  /** p5-live: storage budgets and stream limits. */
  readonly live?: LiveConfig;
  /** p6-otel: telemetry (tests pass in-memory exporters); the tailer loop is off (tests drive it). */
  readonly telemetry?: Telemetry;
  /** p6-alerts: thresholds/cooldown/listeners (no loop: tests call `app.alerts.evaluate()`). */
  readonly alerts?: MasterDeps['alerts'];
  /** p6-agentmagnify: fake API (no loop: tests call `app.agentmagnify.runOnce()`). */
  readonly agentmagnify?: MasterDeps['agentmagnify'];
  /** p6-skills: skills public keys. */
  readonly skills?: MasterDeps['skills'];
  /** p6-vector: embedding provider (no indexer loop: tests call `app.semanticSearch.sync()`). */
  readonly search?: MasterDeps['search'];
  /** p10-semantic-memory (no poller in tests: they call app.memorySuggestions.pass()). */
  readonly memorySuggestions?: MasterDeps['memorySuggestions'];
  /** p10-semantic-defaults-chat (no backfill at start: tests call app.semanticDefaults.backfill()). */
  readonly semanticDefaults?: MasterDeps['semanticDefaults'];
  /**
   * p7-rate-limit: central request budgets. Default: the production policy × 1000, so suites that make
   * hundreds of requests from one test IP are not throttled; abuse tests pass the real policy.
   */
  readonly requestLimits?: RequestLimitPolicy;
  readonly httpTimeouts?: Partial<SlowRequestTimeouts>;
  /** Trusted client-IP header (src/http/client-ip.ts); `trustProxyHops` is then 1. */
  readonly clientIpHeader?: ClientIpHeaderConfig;
  /** p5-coolify-sso: OIDC provider / forward-auth gate. */
  readonly sso?: MasterDeps['sso'];
  /** p5-remember-device: remember-me / trusted-device lifetimes (default: production defaults). */
  readonly loginPersistence?: MasterDeps['loginPersistence'];
  /** p5-stepup-window: step-up windows (default: production defaults, 10 min / whole long-lived session). */
  readonly stepUp?: MasterDeps['stepUp'];
  /** p6-deploy-integrations: fake Coolify / Cloudflare origins, control-plane lists, limits. */
  readonly ops?: MasterDeps['ops'];
  /** p8-uptime: probe exceptions (local fake targets), limits. */
  readonly uptime?: MasterDeps['uptime'];
  /** p10-backup-restore: status directory of the backup service (no throttle: tests call app.backups.tick()). */
  readonly backups?: MasterDeps['backups'];
  /** p10-verify-health: guarded fetcher / retry timing seams. */
  readonly verify?: MasterDeps['verify'];
  /** p13-fleet-tools: version feed fetch seam (default: feeds off). */
  readonly fleetTools?: MasterDeps['fleetTools'];
  /** p14-mcp-chat: the registry fetch of MCP discovery / package lookups (default: the global fetch). */
  readonly mcp?: MasterDeps['mcp'];
  /**
   * p15-autonomy (ADR-0056): the security policy document the suite starts with. Default `{ preset: 'siki' }` — the
   * behaviour before ADR-0056, which the existing suites assert; the production default (migration 0118) is Serbest.
   */
  readonly securityPolicy?: Record<string, unknown>;
  /** p16-api-tokens: per-token budgets and concurrency (default: production budgets × 1000, concurrency 8). */
  readonly tokenLimits?: TokenLimitPolicy;
  /** p16-ops-safety: expiry seams (public origin, TLS reader, key files); no background pass (tests drive it). */
  readonly opsSafety?: MasterDeps['opsSafety'];
  /** p16-observability: status page, log store, recent traces (timers default off in tests). */
  readonly observability?: MasterDeps['observability'];
  /**
   * p16-observability: log lines also go through the production redacting stream, which hands each redacted line to
   * this tap (the log store's sink); `logs` still captures the redacted output.
   */
  readonly logTap?: (line: Record<string, unknown>) => void;
  /** p16-webhooks-out: sender seam (a local TLS receiver's CA), options; no background pass (tests drive runOnce()). */
  readonly webhooksOut?: MasterDeps['webhooksOut'];
  /** p16-selfhost-onboarding: installed version, feed sources and keys (tests call app.updates.refresh()). */
  readonly updates?: MasterDeps['updates'];
  /** p17-update-channel: worker feed / catalog sources and seams (tests call app.updateChannel.tick({ force: true })). */
  readonly updateChannel?: MasterDeps['updateChannel'];
  /** p17-domain-wizard: host applier directory, DNS resolver and timing seams (tests call app.consoleDomain.tick()). */
  readonly consoleDomain?: MasterDeps['consoleDomain'];
  /** p16-doctor: config / SMTP / cap seams; no background pass (tests call app.doctor.service.daily()). */
  readonly doctor?: MasterDeps['doctor'];
  /** p17-object-storage: the local blob directory and S3 seams (default: a shared temp directory, no settings cache). */
  readonly blobs?: MasterDeps['blobs'];
  /** p17-panel-settings: the environment's values / secrets of the panel settings (as main.ts builds them). */
  readonly panelEnv?: MasterDeps['panelEnv'];
  /** p17-panel-settings: the trusted proxy hops (default 0, or 1 with `clientIpHeader`). */
  readonly trustProxyHops?: number;
}

export class Harness {
  readonly clock: FakeClock;
  readonly logs = new LogCapture();
  readonly box = new SecretBox(randomBytes(32));
  /** The Redis key prefix of this master's rate limits and token concurrency slots. */
  readonly redisPrefix = uniquePrefix();
  app!: FastifyInstance;
  db!: TestDatabase;
  redis!: RedisClient;

  /**
   * `clockStart`: the fake clock's start (default: a fixed instant, 2026-10-12T12:00Z). Suites that run real worker
   * daemons must start at the wall clock: the daemons use the real clock and compare master-issued instants (e.g. a
   * kept workspace's `retainUntil`) with it, so a fixed start turns into a time bomb once the wall clock passes it.
   */
  constructor(clockStart?: number) {
    this.clock = new FakeClock(clockStart);
  }

  async start(opts: HarnessOptions = {}): Promise<this> {
    this.db = await createTestDatabase();
    await this.db.pool.query('UPDATE security_policy SET document = $1 WHERE id = 1', [
      JSON.stringify(opts.securityPolicy ?? { preset: 'siki' }),
    ]);
    this.redis = await createTestRedis();
    this.app = await createMasterApp({
      pool: this.db.pool,
      redis: this.redis,
      box: this.box,
      logLevel: 'trace',
      trustProxyHops: opts.trustProxyHops ?? (opts.clientIpHeader ? 1 : 0),
      ...(opts.panelEnv ? { panelEnv: opts.panelEnv } : {}),
      ...(opts.clientIpHeader ? { clientIpHeader: opts.clientIpHeader } : {}),
      requestLimits: opts.requestLimits ?? scaleRequestLimits(DEFAULT_REQUEST_LIMITS, 1000),
      tokenLimits: opts.tokenLimits ?? scaleTokenLimits(TOKEN_REQUEST_LIMITS, 1000),
      // p16-api-tokens: token uses are written at once (no timer), so suites can read them back.
      tokenUsageFlushMs: 0,
      ...(opts.httpTimeouts ? { httpTimeouts: opts.httpTimeouts } : {}),
      bodyLimitBytes: 64 * 1024,
      logStream:
        opts.logTap === undefined ? this.logs : redactingLogStream(this.logs, new Redactor(), opts.logTap),
      ...(opts.observability
        ? {
            observability: {
              logFlushMs: 0,
              historyIntervalMs: 0,
              statusCacheMs: 0,
              ...opts.observability,
            },
          }
        : {}),
      clock: this.clock.now,
      passwordParams: FAST_SCRYPT,
      rateLimitPrefix: this.redisPrefix,
      rateLimits: opts.rateLimits ?? { perIp: 10_000, perAccount: 10_000, windowMs: 60_000 },
      ...(opts.totpSecretFactory ? { totpSecretFactory: opts.totpSecretFactory } : {}),
      ...(opts.extraRoutes ? { extraRoutes: opts.extraRoutes } : {}),
      ...(opts.accessLimits ? { accessLimits: opts.accessLimits } : {}),
      ...(opts.exportLimits ? { exportLimits: opts.exportLimits } : {}),
      ...(opts.authzProbe ? { authzProbe: true } : {}),
      // No background offline sweep unless a test asks for one: tests call fleetSessions.sweep() themselves,
      // and a timer-driven sweep racing them made assertions on its result load-dependent.
      workers: { sweepIntervalMs: 0, ...opts.workers },
      ...(opts.limiter ? { limiter: opts.limiter } : {}),
      // p14-workflow-engine: REMYRAL_TEST_WORKFLOW_ENGINE=2 runs every suite's workflows on engine 2 (the parity run);
      // an explicit `orchestration.workflowEngine` wins.
      orchestration: {
        ...(process.env.REMYRAL_TEST_WORKFLOW_ENGINE === '2'
          ? { workflowEngine: { v2: true, v2ForV1: true } }
          : {}),
        ...(opts.orchestration ?? { tickIntervalMs: 0 }),
      },
      ...(opts.releases ? { releases: opts.releases } : {}),
      ...(opts.remoteOpsLimits ? { remoteOpsLimits: opts.remoteOpsLimits } : {}),
      ...(opts.fleetTools ? { fleetTools: opts.fleetTools } : {}),
      ...(opts.installers ? { installers: opts.installers } : {}),
      ...(opts.ide ? { ide: opts.ide } : {}),
      ...(opts.notifications ? { notifications: opts.notifications } : {}),
      ...(opts.gitflow ? { gitflow: opts.gitflow } : {}),
      ...(opts.live ? { live: opts.live } : {}),
      ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
      metricsTailIntervalMs: 0,
      ...(opts.alerts ? { alerts: { ...opts.alerts, intervalMs: 0 } } : {}),
      ...(opts.agentmagnify ? { agentmagnify: { ...opts.agentmagnify, intervalMs: 0 } } : {}),
      ...(opts.skills ? { skills: opts.skills } : {}),
      ...(opts.mcp ? { mcp: opts.mcp } : {}),
      ...(opts.sso ? { sso: opts.sso } : {}),
      ...(opts.loginPersistence ? { loginPersistence: opts.loginPersistence } : {}),
      ...(opts.stepUp ? { stepUp: opts.stepUp } : {}),
      securityPolicyCacheMs: 0,
      // p16-ops-safety: the cost brake is computed fresh on every check; the background pass is off.
      opsSafety: { brakeCacheMs: 0, ...opts.opsSafety, intervalMs: 0 },
      webhooksOut: { ...opts.webhooksOut, intervalMs: 0 },
      doctor: { workerWaitMs: 5_000, ...opts.doctor, intervalMs: 0 },
      blobs: { dataDir: join(tmpdir(), 'remyral-blobs-test'), settingsTtlMs: 0, ...opts.blobs },
      ...(opts.ops ? { ops: opts.ops } : {}),
      ...(opts.uptime ? { uptime: opts.uptime } : {}),
      ...(opts.backups ? { backups: { intervalMs: 0, ...opts.backups } } : {}),
      ...(opts.updates ? { updates: opts.updates } : {}),
      ...(opts.updateChannel ? { updateChannel: opts.updateChannel } : {}),
      ...(opts.consoleDomain ? { consoleDomain: opts.consoleDomain } : {}),
      ...(opts.verify ? { verify: opts.verify } : {}),
      ...(opts.search ? { search: { ...opts.search, intervalMs: 0 } } : {}),
      ...(opts.memorySuggestions ? { memorySuggestions: { ...opts.memorySuggestions, intervalMs: 0 } } : {}),
      ...(opts.semanticDefaults ? { semanticDefaults: opts.semanticDefaults } : {}),
      ...(opts.watchChecks || opts.chat
        ? { chat: { ...opts.chat, ...(opts.watchChecks ? { watchChecks: opts.watchChecks } : {}) } }
        : {}),
    });
    await this.app.ready();
    return this;
  }

  /** p15-autonomy: replaces the stored security policy document (read again on the next request; cache 0 in tests). */
  async setSecurityPolicy(document: Record<string, unknown>): Promise<void> {
    await this.db.pool.query('UPDATE security_policy SET document = $1, version = version + 1 WHERE id = 1', [
      JSON.stringify(document),
    ]);
  }

  /** Listen on an ephemeral loopback port (WebSocket tests); returns the `ws://` base URL. */
  async listen(): Promise<string> {
    await this.app.listen({ host: '127.0.0.1', port: 0 });
    const address = this.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    return `ws://127.0.0.1:${String(address.port)}`;
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.redis.disconnect();
    await this.db.drop();
  }

  async createUser(username: string, password: string, role: Role = 'owner'): Promise<string> {
    return createUser(
      { pool: this.db.pool, audit: new AuditLog(this.db.pool, this.clock.now), passwordParams: FAST_SCRYPT },
      { username, role, password },
    );
  }

  /**
   * p5-rbac: registers the projects (if needed) and makes `userId` a member of each with `role`.
   * operator/viewer accounts see a project only through such a membership.
   */
  async grant(userId: string, projects: readonly string[], role: 'operator' | 'viewer'): Promise<void> {
    for (const project of projects) {
      await this.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING',
        [project, this.clock.now()],
      );
      await this.db.pool.query(
        `INSERT INTO project_memberships (project_id, user_id, role, granted_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [project, userId, role, this.clock.now()],
      );
    }
  }

  client(ip = '198.51.100.10'): Client {
    return new Client(this.app, ip);
  }

  /** TOTP code for `secret` (base32) at the harness clock, offset by whole steps. */
  code(secretB32: string, stepOffset = 0): string {
    return totpAt(base32Decode(secretB32), this.clock.now().getTime() + stepOffset * 30_000);
  }
}

/** Minimal browser: keeps cookies and echoes the CSRF cookie in X-CSRF-Token. */
export class Client {
  readonly cookies = new Map<string, string>();
  sendCsrf = true;

  constructor(
    private readonly app: FastifyInstance,
    private readonly ip: string,
  ) {}

  async req(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS',
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { 'user-agent': 'vitest-client', ...extraHeaders };
    const csrf = this.cookies.get(CSRF_COOKIE);
    if (this.sendCsrf && csrf) headers['x-csrf-token'] = csrf;
    const res: LightMyRequestResponse = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      cookies: Object.fromEntries(this.cookies),
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
    for (const c of res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const expired =
        c.maxAge === 0 || (c.expires !== undefined && c.expires.getTime() <= Date.now()) || c.value === '';
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get session(): string | undefined {
    return this.cookies.get(SESSION_COOKIE);
  }

  clone(): Client {
    const c = new Client(this.app, this.ip);
    for (const [k, v] of this.cookies) c.cookies.set(k, v);
    return c;
  }
}

/** Logs in and enrolls TOTP; returns the base32 secret, recovery codes and the full-session client. */
export async function enroll(
  h: Harness,
  username: string,
  password: string,
): Promise<{ client: Client; secret: string; recoveryCodes: string[] }> {
  const client = h.client();
  const login = await client.req('POST', '/auth/login', { username, password });
  if (login.statusCode !== 200) throw new Error(`login failed: ${String(login.statusCode)} ${login.body}`);
  const start = await client.req('POST', '/auth/totp/enroll/start');
  if (start.statusCode !== 200)
    throw new Error(`enroll start failed: ${String(start.statusCode)} ${start.body}`);
  const { secret } = start.json<{ secret: string }>();
  const confirm = await client.req('POST', '/auth/totp/enroll/confirm', { code: h.code(secret) });
  if (confirm.statusCode !== 200) throw new Error(`enroll confirm failed: ${String(confirm.statusCode)}`);
  return { client, secret, recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

/** Logs an enrolled user in with password + TOTP (advances the clock one step to avoid replay). */
export async function fullLogin(
  h: Harness,
  username: string,
  password: string,
  secret: string,
): Promise<Client> {
  h.clock.advance(30_000);
  const client = h.client();
  const login = await client.req('POST', '/auth/login', { username, password });
  if (login.statusCode !== 200) throw new Error(`login failed: ${String(login.statusCode)}`);
  const verify = await client.req('POST', '/auth/totp/verify', { code: h.code(secret) });
  if (verify.statusCode !== 200)
    throw new Error(`totp verify failed: ${String(verify.statusCode)} ${verify.body}`);
  return client;
}
