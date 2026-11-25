import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { AttemptId, Ed25519Signature, Epoch, Identifier, Text, Timestamp } from './common.js';
import { LeaseKey } from './lease.js';
import { ConnectorToken, PreviewName, PreviewPort, PreviewProtection } from './previews.js';
import { AssignedRepoEgress } from './repo-egress.js';
import { canonicalPolicyJson } from './runtime-policy.js';

/**
 * p15-services (docs/design/p15-services.md, ADR-0032 addendum 2026-10-21): long-running processes a **worker** owns —
 * a dev server, a backend an APK talks to, a preview of a branch — instead of a job. A service:
 *
 *  - runs a start command in a project checkout the worker keeps (the worktree a job handed over, or a checkout the
 *    worker made for the service), under the same sandbox profile runners, resource limits and egress policy as a
 *    repository job of its project (`spec.network`, p21-service-egress);
 *  - holds **no job slot** and has **no job timeout**: its lifetime is a TTL (or "until stopped"), its health a probe,
 *    its crashes a restart policy;
 *  - survives worker restarts: the worker keeps the signed spec in its data dir and restarts the service when it
 *    comes back (re-adoption of a surviving process is not attempted: the sandbox's egress proxy, Job Object and slot
 *    belong to the worker process that started it — a fresh start keeps the floor);
 *  - may get a Cloudflare tunnel: a **quick tunnel** (`cloudflared tunnel --url`, a random `trycloudflare.com` name,
 *    no account) or a **named** one created by the master through the project's preview-link settings (ADR-0032: only
 *    that tunnel's connector token reaches the worker, in SERVICE_TUNNEL).
 *
 * Wire (all control messages, never in the durable outbox; the master's desired state lives in Postgres and is
 * reconciled against CAPABILITIES.services after every reconnect):
 *
 *  master → worker  SERVICE_START   {spec, revision, issuedAt, signature}   start / update (a later expiry needs no restart)
 *  master → worker  SERVICE_CONTROL {serviceId, op: stop | restart | remove, …, signature}
 *  master → worker  SERVICE_TUNNEL  {serviceId, tunnelId, hostname, connectorToken, …, signature}   (named tunnels)
 *  master → worker  SERVICE_LOGS_REQUEST {serviceId, requestId, lines}
 *  master → worker  SERVICE_RESULT  (job message) the answer to a job's SERVICE_REQUEST
 *  worker → master  SERVICE_STATUS  {serviceId, revision, state, health, url, pid, metrics, …}
 *  worker → master  SERVICE_LOGS    {requestId, serviceId, lines}
 *  worker → master  SERVICE_REQUEST (job message, fenced by the live lease) — the agent's `start_service` & co.
 */

export const SERVICES_FEATURE = 'services-v1';
/** The in-process MCP server name of the job tools (`start_service`, `list_services`, …). */
export const SERVICE_MCP_SERVER = 'remyral-services';

/** Same rules as `EnvName` / `SecretRefString` of master-messages.ts (kept here: that module imports this one). */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'environment variable name');
const SecretRefString = z
  .string()
  .max(256)
  .regex(/^(worker:[A-Za-z0-9_.:-]{1,128}\/)?secret:[A-Za-z0-9_-]{1,64}$/, 'secret reference');

export const SERVICE_LIMITS = {
  /** Running services per machine (the worker refuses more). */
  perWorker: 8,
  /** Services per project that are not removed (the master refuses more). */
  perProject: 10,
  /** Default lifetime (minutes) when none is given; `null` (until stopped) must be asked for. */
  defaultTtlMinutes: 240,
  /** Longest lifetime per start or extension (minutes): 30 days. */
  maxTtlMinutes: 30 * 24 * 60,
  commandMaxChars: 2000,
  envMax: 32,
  secretEnvMax: 16,
  /** Log ring per service on the worker: current file + one rotated file of this size. */
  logFileBytes: 1024 * 1024,
  /** Lines one SERVICE_LOGS answer carries at most. */
  logLinesMax: 2000,
  logLineChars: 2000,
} as const;

/** A service name: lower-case letters, digits and hyphens (unique per project among services not removed). */
export const ServiceName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'service name: 1–32 lower-case letters, digits, hyphens');

/** A sub-directory of the checkout to start in (relative, no `..`, no absolute paths). */
export const ServiceCwd = z
  .string()
  .max(256)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/, 'relative directory');

export const ServiceCommand = z
  .string()
  .min(1)
  .max(SERVICE_LIMITS.commandMaxChars)
  .refine((s) => !s.includes('\0'), 'no NUL bytes');

export const ServiceHealth = z.discriminatedUnion('kind', [
  /** No probe: running = the process is alive. */
  z.strictObject({ kind: z.literal('none') }),
  /** A TCP connect to 127.0.0.1:<port>. */
  z.strictObject({
    kind: z.literal('tcp'),
    intervalSec: z.number().int().min(2).max(300).default(10),
    timeoutSec: z.number().int().min(1).max(30).default(3),
    failures: z.number().int().min(1).max(10).default(3),
    startPeriodSec: z.number().int().min(0).max(1800).default(60),
  }),
  /** An HTTP GET of http://127.0.0.1:<port><path>; healthy when the status is within [min, max]. */
  z.strictObject({
    kind: z.literal('http'),
    path: z
      .string()
      .max(512)
      .regex(/^\/[\x21-\x7e]*$/, 'a path starting with /')
      .default('/'),
    expectStatus: z
      .strictObject({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
      .default({ min: 200, max: 399 }),
    intervalSec: z.number().int().min(2).max(300).default(10),
    timeoutSec: z.number().int().min(1).max(30).default(3),
    failures: z.number().int().min(1).max(10).default(3),
    startPeriodSec: z.number().int().min(0).max(1800).default(60),
  }),
]);
export type ServiceHealth = z.infer<typeof ServiceHealth>;

/**
 * `never`: an exit ends the service (failed / stopped); `on-failure`: a non-zero exit or an unhealthy probe restarts it;
 * `always`: any exit restarts it. At most `maxRestarts` within `windowSec`, then `failed`. A worker restart starts the
 * service again unless the policy is `never`.
 */
export const ServiceRestart = z.strictObject({
  policy: z.enum(['never', 'on-failure', 'always']).default('on-failure'),
  maxRestarts: z.number().int().min(0).max(50).default(5),
  windowSec: z
    .number()
    .int()
    .min(60)
    .max(24 * 3600)
    .default(600),
});
export type ServiceRestart = z.infer<typeof ServiceRestart>;

/** Optional per-service limits; the worker caps them by its own job limits (never more than a job may use). */
export const ServiceResourceLimits = z.strictObject({
  memoryMb: z
    .number()
    .int()
    .min(64)
    .max(64 * 1024)
    .optional(),
  cpus: z.number().min(0.1).max(64).optional(),
  pids: z.number().int().min(16).max(8192).optional(),
});
export type ServiceResourceLimits = z.infer<typeof ServiceResourceLimits>;

/** Profiles a service may run in (the container profile is not offered in this release: the port is not on the host). */
export const ServiceProfile = z.enum(['host-restricted', 'unconfined']);
export type ServiceProfile = z.infer<typeof ServiceProfile>;

export const ServiceTunnelMode = z.enum(['none', 'quick', 'named']);
export type ServiceTunnelMode = z.infer<typeof ServiceTunnelMode>;

/** Where the service's working directory comes from. */
export const ServiceSource = z.discriminatedUnion('kind', [
  /** The worktree of a job attempt on this worker (the job hands it over; it is kept until the service is removed). */
  z.strictObject({ kind: z.literal('job'), jobId: Identifier, attemptId: AttemptId }),
  /** A checkout the worker makes for the service (the project's repository at `baseRef`; allowlist-checked). */
  z.strictObject({
    kind: z.literal('checkout'),
    repositoryUrl: z.string().min(1).max(2048),
    baseRef: z.string().min(1).max(256),
  }),
]);
export type ServiceSource = z.infer<typeof ServiceSource>;

/** What the worker runs (master-built, signed). Every field is explicit so both sides hash the same bytes. */
export const ServiceSpec = z.strictObject({
  serviceId: z.uuid(),
  projectId: Identifier,
  name: ServiceName,
  source: ServiceSource,
  cwd: ServiceCwd.nullable(),
  command: ServiceCommand,
  /** Non-secret environment. */
  env: z.record(EnvName, z.string().max(4096)),
  /** Secrets by reference (vault credentials `secret:vault-<id>` or the worker store), resolved on the worker. */
  secretEnv: z.record(EnvName, SecretRefString),
  /** The port the service listens on (localhost), needed for tcp / http health and tunnels. */
  port: PreviewPort.nullable(),
  health: ServiceHealth,
  restart: ServiceRestart,
  sandboxProfile: ServiceProfile,
  limits: ServiceResourceLimits,
  /** The worker stops the service at this time even if the master does not; null = until stopped. */
  expiresAt: Timestamp.nullable(),
  tunnel: ServiceTunnelMode,
  /**
   * p21-service-egress: the project's effective repository egress policy (p14-repo-egress), set by the master when it
   * sends the start to a worker with `service-egress-v1` (never stored in the master's row: the policy in force at
   * each send). Covered by the signature like the rest of the spec. Absent: model APIs only (an older master or
   * worker).
   */
  network: AssignedRepoEgress.optional(),
});
export type ServiceSpec = z.infer<typeof ServiceSpec>;
export type ServiceSpecInput = z.input<typeof ServiceSpec>;

export function serviceSpecIssues(spec: ServiceSpec): string[] {
  const out: string[] = [];
  if (Object.keys(spec.env).length > SERVICE_LIMITS.envMax) out.push('too many environment variables');
  if (Object.keys(spec.secretEnv).length > SERVICE_LIMITS.secretEnvMax) out.push('too many secrets');
  for (const k of Object.keys(spec.secretEnv))
    if (k in spec.env) out.push(`${k} is both a value and a secret`);
  if (spec.port === null && spec.health.kind !== 'none') out.push('a tcp / http health check needs a port');
  if (spec.port === null && spec.tunnel !== 'none') out.push('a tunnel needs a port');
  if (spec.health.kind === 'http' && spec.health.expectStatus.min > spec.health.expectStatus.max)
    out.push('expectStatus.min is above expectStatus.max');
  return out;
}

/** The SHA-256 (hex) of a spec's canonical JSON — what SERVICE_START signs. */
export function serviceSpecHash(spec: ServiceSpec): string {
  return createHash('sha256').update(canonicalPolicyJson(spec), 'utf8').digest('hex');
}

export const ServiceSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });
export type ServiceSignature = z.infer<typeof ServiceSignature>;

/** master → worker `SERVICE_START` (control). A higher `revision` of the same service replaces the spec. */
export const ServiceStartPayload = z.object({
  spec: ServiceSpec,
  revision: z.number().int().min(1).max(1_000_000),
  issuedAt: Timestamp,
  /**
   * `checkout` sources: a short-lived **read-only** git token for the worker's own fetch (never in the service's
   * environment, never stored). Absent: the repository is public or the worker already has the checkout.
   */
  gitToken: z.string().min(1).max(4096).optional(),
  gitTokenUsername: z.string().min(1).max(128).optional(),
  signature: ServiceSignature.optional(),
});
export type ServiceStartPayload = z.infer<typeof ServiceStartPayload>;

/** master → worker `SERVICE_CONTROL` (control). `remove` also deletes the kept checkout and the logs. */
export const ServiceControlPayload = z.object({
  serviceId: z.uuid(),
  op: z.enum(['stop', 'restart', 'remove']),
  reason: z.string().max(200),
  issuedAt: Timestamp,
  signature: ServiceSignature.optional(),
});
export type ServiceControlPayload = z.infer<typeof ServiceControlPayload>;

/** master → worker `SERVICE_TUNNEL` (control): the connector of a named tunnel for a service (ADR-0032 addendum). */
export const ServiceTunnelPayload = z.object({
  serviceId: z.uuid(),
  tunnelId: z.uuid(),
  hostname: z.string().min(4).max(253),
  port: PreviewPort,
  expiresAt: Timestamp,
  connectorToken: ConnectorToken,
  issuedAt: Timestamp,
  signature: ServiceSignature.optional(),
});
export type ServiceTunnelPayload = z.infer<typeof ServiceTunnelPayload>;

/** master → worker `SERVICE_LOGS_REQUEST` (control). */
export const ServiceLogsRequestPayload = z.object({
  serviceId: z.uuid(),
  requestId: z.uuid(),
  lines: z.number().int().min(1).max(SERVICE_LIMITS.logLinesMax),
});
export type ServiceLogsRequestPayload = z.infer<typeof ServiceLogsRequestPayload>;

export const ServiceState = z.enum([
  /** Started, the first health check has not passed yet. */
  'starting',
  /** Alive and healthy (or alive without a probe). */
  'running',
  /** Alive but the probe fails. */
  'unhealthy',
  /** Exited or unhealthy; waiting for the restart backoff. */
  'restarting',
  /** Stopped on request (or the process exited with the `never` policy and code 0). */
  'stopped',
  /** Gave up: restart limit, start error, checkout error. */
  'failed',
  /** The lifetime ended. */
  'expired',
  /** The worker would not start it (signature, limits, profile, missing checkout …). */
  'refused',
]);
export type ServiceState = z.infer<typeof ServiceState>;

export const ServiceHealthState = z.enum(['unknown', 'healthy', 'unhealthy', 'none']);
export type ServiceHealthState = z.infer<typeof ServiceHealthState>;

export const ServiceTunnelState = z.enum(['none', 'starting', 'running', 'failed', 'refused', 'stopped']);
export type ServiceTunnelState = z.infer<typeof ServiceTunnelState>;

/** worker → master `SERVICE_STATUS` (control) on every state / health / tunnel change and every minute while alive. */
export const ServiceStatusPayload = z.object({
  serviceId: z.uuid(),
  revision: z.number().int().min(0).max(1_000_000),
  state: ServiceState,
  health: ServiceHealthState,
  /** Plain-language reason (refusals, exits, probe failures); never the service's own output. */
  detail: z.string().max(300).optional(),
  pid: z.number().int().min(1).optional(),
  startedAt: Timestamp.optional(),
  restarts: z.number().int().min(0).max(100_000),
  exitCode: z.number().int().optional(),
  tunnel: z
    .object({
      state: ServiceTunnelState,
      /** The public https URL (quick tunnel: captured from cloudflared; named: the hostname the master gave). */
      url: z.url({ protocol: /^https$/ }).optional(),
      detail: z.string().max(300).optional(),
    })
    .optional(),
  /** Sampled process-tree figures (absent where the host cannot tell). */
  cpuPercent: z.number().min(0).max(100_000).optional(),
  memoryBytes: z.number().int().min(0).optional(),
  at: Timestamp,
});
export type ServiceStatusPayload = z.infer<typeof ServiceStatusPayload>;

export const ServiceLogLine = z.object({
  at: Timestamp,
  stream: z.enum(['stdout', 'stderr', 'system']),
  text: z.string().max(SERVICE_LIMITS.logLineChars),
});
export type ServiceLogLine = z.infer<typeof ServiceLogLine>;

/** worker → master `SERVICE_LOGS` (control): the last lines (secret values redacted on the worker). */
export const ServiceLogsPayload = z.object({
  requestId: z.uuid(),
  serviceId: z.uuid(),
  status: z.enum(['ok', 'not_found']),
  lines: z.array(ServiceLogLine).max(SERVICE_LIMITS.logLinesMax),
  truncated: z.boolean(),
});
export type ServiceLogsPayload = z.infer<typeof ServiceLogsPayload>;

/** CAPABILITIES.services (with `services-v1`): what this worker runs now (ids, revisions, states). */
export const ServicesReport = z.object({
  max: z.number().int().min(0).max(64),
  services: z
    .array(
      z.object({
        serviceId: z.uuid(),
        revision: z.number().int().min(0).max(1_000_000),
        state: ServiceState,
        since: Timestamp,
        /**
         * p21-service-egress (`service-egress-v1`): whether the spec this worker runs carries a project network policy.
         * `false` from such a worker (a record kept from before its update) makes the master send the spec again at a
         * new revision.
         */
        network: z.boolean().optional(),
      }),
    )
    .max(64),
});
export type ServicesReport = z.infer<typeof ServicesReport>;

// ------------------------------------------------------------------------------------------ job tools

/** ASSIGN_JOB `execution.services` (only to `services-v1` workers): the agent gets the service tools. */
export const AssignedServices = z.object({
  tools: z.boolean(),
  /** Tunnel modes the agent may ask for (the project's settings; `named` needs preview links). */
  tunnels: z.array(ServiceTunnelMode).min(1).max(3),
});
export type AssignedServices = z.infer<typeof AssignedServices>;

export const ServiceTtlMinutes = z.number().int().min(5).max(SERVICE_LIMITS.maxTtlMinutes);

/** What an agent (or a person, or the assistant) asks for when starting a service. */
export const ServiceStartRequest = z.strictObject({
  name: ServiceName,
  command: ServiceCommand,
  cwd: ServiceCwd.optional(),
  port: PreviewPort.optional(),
  env: z.record(EnvName, z.string().max(4096)).optional(),
  secretEnv: z.record(EnvName, SecretRefString).optional(),
  health: ServiceHealth.optional(),
  restart: ServiceRestart.partial().optional(),
  tunnel: ServiceTunnelMode.optional(),
  /** Named tunnels only (default: the project's first offered protection, normally `none`). */
  protect: PreviewProtection.optional(),
  tunnelName: PreviewName.optional(),
  /** Minutes; absent = the default (4 h); `untilStopped: true` = no expiry. */
  ttlMinutes: ServiceTtlMinutes.optional(),
  untilStopped: z.boolean().optional(),
  limits: ServiceResourceLimits.optional(),
});
export type ServiceStartRequest = z.infer<typeof ServiceStartRequest>;

const ServiceRef = { serviceId: z.uuid().optional(), name: ServiceName.optional() };

export const ServiceRequestOp = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), request: ServiceStartRequest }),
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('stop'), ...ServiceRef }),
  z.strictObject({ kind: z.literal('restart'), ...ServiceRef }),
  z.strictObject({
    kind: z.literal('logs'),
    ...ServiceRef,
    lines: z.number().int().min(1).max(500).optional(),
  }),
]);
export type ServiceRequestOp = z.infer<typeof ServiceRequestOp>;

/** worker → master `SERVICE_REQUEST` payload (job message, control, fenced by the live lease). */
export const ServiceRequestPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  op: ServiceRequestOp,
});
export type ServiceRequestPayload = z.infer<typeof ServiceRequestPayload>;

/** What a job (or the assistant) sees of a service. */
export const ServiceInfo = z.object({
  id: z.uuid(),
  name: ServiceName,
  workerId: Identifier,
  state: z.string().max(32),
  health: ServiceHealthState,
  url: z.string().max(300).nullable(),
  port: PreviewPort.nullable(),
  expiresAt: Timestamp.nullable(),
  startedByThisJob: z.boolean(),
  detail: z.string().max(300).nullable(),
});
export type ServiceInfo = z.infer<typeof ServiceInfo>;

/** master → worker `SERVICE_RESULT` payload (job message, control). */
export const ServiceResultPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  status: z.enum(['ok', 'refused', 'failed']),
  reason: z.string().max(64).optional(),
  detail: Text.optional(),
  services: z
    .array(ServiceInfo)
    .max(SERVICE_LIMITS.perProject * 2)
    .optional(),
  logs: z.array(ServiceLogLine).max(500).optional(),
});
export type ServiceResultPayload = z.infer<typeof ServiceResultPayload>;

// ------------------------------------------------------------------------------------------ signatures

export const SERVICE_START_CONTEXT = 'remana-service-start/v1';
export const SERVICE_CONTROL_CONTEXT = 'remana-service-control/v1';
export const SERVICE_TUNNEL_CONTEXT = 'remana-service-tunnel/v1';
/** A SERVICE_START / CONTROL / TUNNEL older than this is refused (re-sends carry a fresh `issuedAt`). */
export const SERVICE_MESSAGE_MAX_AGE_MS = 5 * 60_000;
export const SERVICE_CLOCK_SKEW_MS = 2 * 60_000;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface ServiceStartBinding {
  readonly workerId: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly spec: ServiceSpec;
}

export function serviceStartStatement(b: ServiceStartBinding): Buffer {
  return Buffer.from(
    [
      SERVICE_START_CONTEXT,
      b.workerId,
      b.spec.serviceId,
      String(b.revision),
      b.issuedAt,
      serviceSpecHash(b.spec),
    ].join('\n'),
    'utf8',
  );
}

export interface ServiceControlBinding {
  readonly workerId: string;
  readonly serviceId: string;
  readonly op: ServiceControlPayload['op'];
  readonly issuedAt: string;
}

export function serviceControlStatement(b: ServiceControlBinding): Buffer {
  return Buffer.from([SERVICE_CONTROL_CONTEXT, b.workerId, b.serviceId, b.op, b.issuedAt].join('\n'), 'utf8');
}

export interface ServiceTunnelBinding {
  readonly workerId: string;
  readonly serviceId: string;
  readonly tunnelId: string;
  readonly hostname: string;
  readonly port: number;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly connectorToken: string;
}

export function serviceTunnelStatement(b: ServiceTunnelBinding): Buffer {
  return Buffer.from(
    [
      SERVICE_TUNNEL_CONTEXT,
      b.workerId,
      b.serviceId,
      b.tunnelId,
      b.hostname.toLowerCase(),
      String(b.port),
      b.expiresAt,
      b.issuedAt,
      sha256Hex(b.connectorToken),
    ].join('\n'),
    'utf8',
  );
}

const signWith = (statement: Buffer, kid: string, key: KeyObject): ServiceSignature => ({
  kid,
  signature: sign(null, statement, key).toString('base64url'),
});

export function signServiceStart(b: ServiceStartBinding, kid: string, key: KeyObject): ServiceSignature {
  return signWith(serviceStartStatement(b), kid, key);
}
export function signServiceControl(b: ServiceControlBinding, kid: string, key: KeyObject): ServiceSignature {
  return signWith(serviceControlStatement(b), kid, key);
}
export function signServiceTunnel(b: ServiceTunnelBinding, kid: string, key: KeyObject): ServiceSignature {
  return signWith(serviceTunnelStatement(b), kid, key);
}

export type ServiceVerdict = 'ok' | 'missing' | 'unknown_key' | 'bad_signature';

function verifyWith(
  statement: Buffer,
  signature: ServiceSignature | undefined,
  keys: readonly LeaseKey[],
): ServiceVerdict {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, statement, signature.signature) ? 'ok' : 'bad_signature';
}

/** Never throws. */
export function verifyServiceStart(
  b: ServiceStartBinding,
  s: ServiceSignature | undefined,
  keys: readonly LeaseKey[],
): ServiceVerdict {
  return verifyWith(serviceStartStatement(b), s, keys);
}
export function verifyServiceControl(
  b: ServiceControlBinding,
  s: ServiceSignature | undefined,
  keys: readonly LeaseKey[],
): ServiceVerdict {
  return verifyWith(serviceControlStatement(b), s, keys);
}
export function verifyServiceTunnel(
  b: ServiceTunnelBinding,
  s: ServiceSignature | undefined,
  keys: readonly LeaseKey[],
): ServiceVerdict {
  return verifyWith(serviceTunnelStatement(b), s, keys);
}

/** `issuedAt` within the accepted window (worker side). */
export function serviceMessageFresh(
  issuedAt: string,
  now: Date,
  maxAgeMs = SERVICE_MESSAGE_MAX_AGE_MS,
): boolean {
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime() + SERVICE_CLOCK_SKEW_MS && now.getTime() - t <= maxAgeMs + SERVICE_CLOCK_SKEW_MS;
}

/** Pure TTL rule shared by master and the tools: minutes → expiry (null = until stopped). */
export function serviceExpiry(
  now: Date,
  req: { readonly ttlMinutes?: number | undefined; readonly untilStopped?: boolean | undefined },
): Date | null {
  if (req.untilStopped === true) return null;
  const minutes = Math.min(req.ttlMinutes ?? SERVICE_LIMITS.defaultTtlMinutes, SERVICE_LIMITS.maxTtlMinutes);
  return new Date(now.getTime() + minutes * 60_000);
}

/** Statuses that mean the process is (meant to be) alive. */
export const LIVE_SERVICE_STATES: readonly ServiceState[] = [
  'starting',
  'running',
  'unhealthy',
  'restarting',
];
