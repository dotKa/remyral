import { z } from 'zod';
import { HttpError } from '../http/errors.js';

/**
 * p8-uptime (docs/design/p8-uptime.md §2): monitor types, their settings and the limits of the uptime module.
 *
 * Every setting is checked here and again by the probe before each request (the probe never trusts a stored row):
 * http(s) only to the allowed ports, no credentials in the URL, no custom headers; tcp to any port but only of a
 * public address; provider monitors name a Pages project or a Coolify application, never a URL or a token.
 */

export const MONITOR_TYPES = ['http', 'tcp', 'pages', 'coolify'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];
export type MonitorStatus = 'pending' | 'up' | 'down';

export const LIMITS = {
  /** Seconds between checks. */
  intervalMin: 30,
  intervalDefault: 60,
  intervalMax: 86_400,
  /** Provider monitors call the Cloudflare / Coolify API: at most once a minute each. */
  providerIntervalMin: 60,
  timeoutMinMs: 1_000,
  timeoutDefaultMs: 10_000,
  timeoutMaxMs: 30_000,
  retriesDefault: 1,
  retriesMax: 10,
  /** Redirects an http monitor may follow (each hop is checked again). */
  redirectsMax: 5,
  redirectsDefault: 3,
  /** Bytes of the body read for the keyword check (the rest is never read). */
  keywordBytes: 64 * 1024,
  keywordMax: 200,
  tlsWarnDefault: 14,
  tlsWarnMax: 365,
  nameMax: 200,
  urlMax: 2_048,
  /** Monitors per project and in total (the master does every request itself). */
  perProject: 50,
  total: 500,
  /** Checks running at the same time on one master replica. */
  concurrency: 16,
  /**
   * Raw checks are kept this long, hourly rollups this long. p22-ops-hygiene: 7 days (was 30) — raw checks feed only
   * the 24 h chart and the raw check list; uptime % and the 7/30/90-day charts read the rollups (207 000 rows on the
   * test server for 30 days).
   */
  checkRetentionDays: 7,
  /** p22-ops-hygiene: raw checks deleted per statement, and statements per prune pass (bounded work per hour). */
  pruneBatch: 5_000,
  pruneMaxBatches: 40,
  rollupRetentionDays: 90,
  listMax: 200,
  checksPageMax: 500,
  incidentsPageMax: 200,
} as const;

/** Per-user budgets on top of the central read/write classes (p7-rate-limit). */
export const RATE = {
  write: { max: 30, windowMs: 60_000 },
  checkNow: { max: 10, windowMs: 60_000 },
} as const;

/** Ports an http(s) monitor may use (explicit or default). */
export const HTTP_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
export const ProjectId = z.string().regex(PROJECT, 'project id');
/** A host name (letters, digits, hyphens, dots; at most 253) or an IP literal. */
const HOST =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;

/** Why a URL is not acceptable as an http monitor target at all (scheme, credentials, host), or null. */
export function urlShapeProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http:// and https:// URLs';
  if (u.username !== '' || u.password !== '') return 'no credentials in the URL';
  if (u.hostname === '') return 'no host';
  return null;
}

/** Why a URL is not acceptable for an http monitor (shape and the port allowlist), or null. DNS is checked per request. */
export function urlProblem(raw: string): string | null {
  const shape = urlShapeProblem(raw);
  if (shape !== null) return shape;
  const u = new URL(raw);
  const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
  if (!HTTP_PORTS.has(port)) return `port ${String(port)} is not allowed (80, 443, 8080, 8443)`;
  return null;
}

/** The URL shape is checked by the schema; the port allowlist by the service (src/uptime/service.ts configOf). */
export const HttpUrl = z
  .string()
  .trim()
  .max(LIMITS.urlMax)
  .superRefine((s, ctx) => {
    const p = urlShapeProblem(s);
    if (p !== null) ctx.addIssue({ code: 'custom', message: p });
  });

export const ExpectStatus = z
  .strictObject({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
  .refine((s) => s.min <= s.max, 'min must not exceed max');

export const HttpConfig = z.strictObject({
  url: HttpUrl,
  method: z.enum(['GET', 'HEAD']).default('GET'),
  expectStatus: ExpectStatus.default({ min: 200, max: 399 }),
  keyword: z
    .strictObject({
      text: z
        .string()
        .min(1)
        .max(LIMITS.keywordMax)
        .refine((s) => !s.includes('\u0000'), 'no NUL'),
      mode: z.enum(['present', 'absent']).default('present'),
    })
    .nullable()
    .default(null),
  maxLatencyMs: z.number().int().min(10).max(LIMITS.timeoutMaxMs).nullable().default(null),
  maxRedirects: z.number().int().min(0).max(LIMITS.redirectsMax).default(LIMITS.redirectsDefault),
  /** Warn this many days before the certificate expires (0: no warning). https only. */
  tlsWarnDays: z.number().int().min(0).max(LIMITS.tlsWarnMax).default(LIMITS.tlsWarnDefault),
});
export type HttpConfig = z.infer<typeof HttpConfig>;

export const TcpConfig = z.strictObject({
  host: z
    .string()
    .trim()
    .max(253)
    .refine((h) => HOST.test(h) || IPV6.test(h), 'a host name or IP address'),
  port: z.number().int().min(1).max(65_535),
});
export type TcpConfig = z.infer<typeof TcpConfig>;

export const PagesConfig = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,57}$/, 'Pages project name'),
  env: z.enum(['production', 'preview']).default('production'),
});
export type PagesConfig = z.infer<typeof PagesConfig>;

export const CoolifyConfig = z.strictObject({
  uuid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Coolify application uuid'),
  /**
   * p13-multi-coolify (ADR-0050): the Coolify connection to ask. Optional on input — the master fills it (the project's
   * target connection that lists the uuid, else its only usable connection, else the default) and stores it.
   */
  connection: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'connection id')
    .nullable()
    .optional(),
});
export type CoolifyConfig = z.infer<typeof CoolifyConfig>;

export type MonitorConfig =
  | { readonly type: 'http'; readonly config: HttpConfig }
  | { readonly type: 'tcp'; readonly config: TcpConfig }
  | { readonly type: 'pages'; readonly config: PagesConfig }
  | { readonly type: 'coolify'; readonly config: CoolifyConfig };

/** The stored config of a type, validated (null: the stored row is not valid any more — the check is refused). */
export function parseConfig(type: string, raw: unknown): MonitorConfig | null {
  switch (type) {
    case 'http': {
      const p = HttpConfig.safeParse(raw);
      return p.success ? { type, config: p.data } : null;
    }
    case 'tcp': {
      const p = TcpConfig.safeParse(raw);
      return p.success ? { type, config: p.data } : null;
    }
    case 'pages': {
      const p = PagesConfig.safeParse(raw);
      return p.success ? { type, config: p.data } : null;
    }
    case 'coolify': {
      const p = CoolifyConfig.safeParse(raw);
      return p.success ? { type, config: p.data } : null;
    }
    default:
      return null;
  }
}

const Name = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.nameMax)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'no control characters');

const Schedule = {
  intervalSec: z.number().int().min(LIMITS.intervalMin).max(LIMITS.intervalMax).optional(),
  timeoutMs: z.number().int().min(LIMITS.timeoutMinMs).max(LIMITS.timeoutMaxMs).optional(),
  retries: z.number().int().min(0).max(LIMITS.retriesMax).optional(),
  paused: z.boolean().optional(),
};

export const OutputKey = z
  .string()
  .max(320)
  .regex(/^site:[A-Za-z0-9_.:+-]+$/, 'an Outputs site key');

export const MonitorInput = z.discriminatedUnion('type', [
  z.strictObject({
    project: ProjectId,
    name: Name,
    type: z.literal('http'),
    config: HttpConfig,
    outputKey: OutputKey.nullable().optional(),
    ...Schedule,
  }),
  z.strictObject({
    project: ProjectId,
    name: Name,
    type: z.literal('tcp'),
    config: TcpConfig,
    outputKey: OutputKey.nullable().optional(),
    ...Schedule,
  }),
  z.strictObject({
    project: ProjectId,
    name: Name,
    type: z.literal('pages'),
    config: PagesConfig,
    outputKey: OutputKey.nullable().optional(),
    ...Schedule,
  }),
  z.strictObject({
    project: ProjectId,
    name: Name,
    type: z.literal('coolify'),
    config: CoolifyConfig,
    outputKey: OutputKey.nullable().optional(),
    ...Schedule,
  }),
]);
export type MonitorInput = z.infer<typeof MonitorInput>;

/** An edit: the type and project stay; `config` replaces the whole config of the monitor's type. */
export const MonitorPatch = z.strictObject({
  name: Name.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  outputKey: OutputKey.nullable().optional(),
  ...Schedule,
});
export type MonitorPatch = z.infer<typeof MonitorPatch>;

/** Schedule values with defaults applied and the cross-field rules checked; a reason string on failure. */
export function scheduleOf(
  type: MonitorType,
  s: { intervalSec?: number | undefined; timeoutMs?: number | undefined; retries?: number | undefined },
): { intervalSec: number; timeoutMs: number; retries: number } | string {
  const provider = type === 'pages' || type === 'coolify';
  const intervalSec = s.intervalSec ?? (provider ? 300 : LIMITS.intervalDefault);
  const timeoutMs = s.timeoutMs ?? LIMITS.timeoutDefaultMs;
  const retries = s.retries ?? LIMITS.retriesDefault;
  if (provider && intervalSec < LIMITS.providerIntervalMin) {
    return `provider monitors check at most once a minute (intervalSec ≥ ${String(LIMITS.providerIntervalMin)})`;
  }
  if (timeoutMs >= intervalSec * 1000) return 'the timeout must be shorter than the interval';
  return { intervalSec, timeoutMs, retries };
}

/** What one check found. `ok` null: undecided (provider unreachable / not configured) — the status stays. */
export interface CheckResult {
  readonly ok: boolean | null;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  /** Fixed cause code (see the migration), null on success. */
  readonly error: string | null;
  /** Short, master-built text (provider status, cause detail). Never a response body. */
  readonly detail: string | null;
  readonly tlsExpiresAt: Date | null;
}

/** A refusal with a public code and message (an HttpError, so routes answer it as it is). */
export class UptimeError extends HttpError {
  constructor(status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(status, code, message, headers);
    this.name = 'UptimeError';
  }

  get status(): number {
    return this.statusCode;
  }
}
