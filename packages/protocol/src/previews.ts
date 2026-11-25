import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { AttemptId, Ed25519Signature, Epoch, Identifier, Text, Timestamp } from './common.js';
import { LeaseKey } from './lease.js';

/**
 * p8-preview-tunnels (ADR-0032, docs/design/p8-preview-tunnels.md): preview links for what a job serves on the
 * worker's localhost, through a Cloudflare Tunnel the **master** creates with its account token.
 *
 *  1. The job's agent calls `open_preview` (or the job was submitted with "open a preview when the dev server is
 *     up", or a human opens one from the job page). The worker checks the port locally (range, deny-list, a
 *     listener on loopback that belongs to the job's process tree) and asks the master:
 *     worker → master `PREVIEW_REQUEST {attemptId, epoch, requestId, op}` (job message, control, fenced by the lease).
 *  2. The master records an ops action `tunnel.open` (policy, limits, audit), creates a remotely-managed named tunnel
 *     with one ingress rule `hostname → http://localhost:<port>`, the proxied CNAME `<hostname> → <id>.cfargotunnel.com`
 *     and, if asked, a Cloudflare Access application; answers `PREVIEW_RESULT`.
 *  3. master → worker `TUNNEL_START {tunnelId, …, connectorToken, signature}` (worker message, control, never in the
 *     durable outbox): the **only** Cloudflare credential that ever reaches a worker — the connector token of that
 *     one tunnel. Signed with a master lease key over the binding (worker, job, attempt, epoch, tunnel, port,
 *     hostname, window, token digest). The worker writes it to a 0600 file in its own data dir (outside every job
 *     sandbox) and runs `cloudflared tunnel run --token-file <file>` as a supervised child.
 *  4. worker → master `TUNNEL_STATUS` on every connector state change; CAPABILITIES.previewTunnels lists the
 *     running connectors after a reconnect (the master re-sends or stops).
 *  5. master → worker `TUNNEL_STOP` (job ended, TTL, closed); the master then deletes the Access app, the DNS record
 *     and the tunnel — deleting the tunnel revokes its token.
 *
 * Shared, pure schemas and statements.
 */

export const PREVIEW_TUNNELS_FEATURE = 'preview-tunnels-v1';
/**
 * p10-publish-bundle (ADR-0038): the worker offers the in-job tool `publish_site` (same MCP server and
 * PREVIEW_REQUEST channel, `op.kind = 'publish'`) when ASSIGN_JOB carries `execution.previews.publish`.
 */
export const SITE_PUBLISH_FEATURE = 'site-publish-v1';
/**
 * p12-deploy-feedback (ADR-0048): the worker offers the in-job deploy tools (`deploy_status`, `deploy_logs`,
 * `request_redeploy`) over the same PREVIEW_REQUEST channel (`op.kind = 'deploy_status' | 'deploy_logs' |
 * 'redeploy'`) when ASSIGN_JOB carries `execution.previews.deploy`. Every runtime with a tool channel gets them.
 */
export const DEPLOY_FEEDBACK_FEATURE = 'deploy-feedback-v1';
/** The in-process MCP server name of the job tools (`open_preview`, `close_preview`, `list_previews`). */
export const PREVIEW_MCP_SERVER = 'remyral-preview';

export const PREVIEW_LIMITS = {
  /** Job-bound tunnels: default and longest lifetime (minutes). */
  defaultTtlMinutes: 240,
  maxTtlMinutes: 24 * 60,
  /** Stable tunnels (fixed hostname, e.g. an APK's backend): longest lifetime per renewal (minutes). */
  stableMaxMinutes: 30 * 24 * 60,
  /** How long `open_preview` waits for the connector to come up (seconds). */
  readyWaitSec: 45,
  nameMaxChars: 20,
} as const;

/** Ports a preview may expose: unprivileged only. */
export const PREVIEW_PORT_MIN = 1024;
export const PREVIEW_PORT_MAX = 65_535;

/**
 * Well-known service ports never exposed, whatever the job says: remote shells and desktops, databases, caches,
 * container / cluster APIs, mail, directory services, the cloudflared metrics range. The worker adds its own
 * listening ports (egress proxies, adapter loopback servers) at runtime.
 */
export const PREVIEW_DENIED_PORTS: readonly number[] = Object.freeze([
  // shells, remote desktop, file sharing, directory, mail, printing (< 1024 are refused anyway; listed for clarity)
  22,
  23, 25, 110, 135, 139, 143, 389, 445, 465, 587, 631, 636, 993, 995,
  // remote desktop / VNC / WinRM
  3389, 5900, 5901, 5902, 5903, 5985, 5986,
  // databases and caches
  1433, 1521, 2483, 2484, 3306, 5432, 5433, 6379, 6380, 7000, 7001, 8086, 9042, 9200, 9300, 11211, 27017,
  27018, 27019, 28017, 26257, 5984, 7474, 7687,
  // container engines, orchestrators, service meshes, secrets
  2375, 2376, 2377, 2379, 2380, 4243, 6443, 10248, 10249, 10250, 10255, 10256, 8200, 8201, 8500, 8300, 8301,
  8302,
  // message brokers
  4369, 5671, 5672, 15672, 9092, 2181, 1883, 8883, 61616,
  // cloudflared metrics (127.0.0.1:20241–20245) and the Chrome / Node debugger
  20241, 20242, 20243, 20244, 20245, 9222, 9229,
]);

export type PreviewPortProblem = 'out_of_range' | 'denied';

/** Why a port may never be exposed (shared by master and worker), or null. */
export function previewPortProblem(port: number): PreviewPortProblem | null {
  if (!Number.isInteger(port) || port < PREVIEW_PORT_MIN || port > PREVIEW_PORT_MAX) return 'out_of_range';
  if (PREVIEW_DENIED_PORTS.includes(port)) return 'denied';
  return null;
}

export const PreviewPort = z
  .number()
  .int()
  .min(PREVIEW_PORT_MIN)
  .max(PREVIEW_PORT_MAX)
  .refine((p) => previewPortProblem(p) === null, 'this port is a known service port and is never exposed');

/** `none`: public link (the default, by design); `access`: Cloudflare Access e-mail one-time PIN allowlist;
 * `service-token`: a per-tunnel Access service token (mobile app backends send CF-Access-Client-Id / -Secret). */
export const PreviewProtection = z.enum(['none', 'access', 'service-token']);
export type PreviewProtection = z.infer<typeof PreviewProtection>;

/** A short human name of a preview (lower-case letters, digits and hyphens). */
export const PreviewName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/, 'preview name: 1–20 lower-case letters, digits, hyphens');

/** `JobSpec.previews` (submitter's; the master keeps only what the project allows). */
export const JobPreviewRequest = z.strictObject({
  /** Open a preview automatically once something of the job listens on this port. */
  autoOpen: z
    .strictObject({
      port: PreviewPort,
      name: PreviewName.optional(),
      protect: PreviewProtection.default('none'),
      ttlMinutes: z.number().int().min(5).max(PREVIEW_LIMITS.maxTtlMinutes).optional(),
      stable: z.boolean().default(false),
    })
    .optional(),
});
export type JobPreviewRequest = z.infer<typeof JobPreviewRequest>;

/** ASSIGN_JOB `execution.previews` (master-filled, only to `preview-tunnels-v1` workers). */
export const AssignedPreviews = z.object({
  /** The agent gets the preview tools (project setting "agents may open previews"). */
  tools: z.boolean(),
  /** Ports a human declared for this job (auto-open); the worker accepts them without the process-tree check. */
  declaredPorts: z.array(PreviewPort).max(4),
  autoOpen: JobPreviewRequest.shape.autoOpen,
  /** Protections the project allows (`access` needs an e-mail allowlist). */
  protections: z.array(PreviewProtection).min(1).max(3),
  /**
   * p10-publish-bundle (ADR-0038; only to `site-publish-v1` workers): the agent gets `publish_site` (ask the master to
   * publish this job's site when it succeeds — one ops request, decided by the project's policy).
   */
  publish: z.boolean().optional(),
  /**
   * p12-deploy-feedback (ADR-0048; only to `deploy-feedback-v1` workers): the agent gets the read-only deploy tools of
   * its project and `request_redeploy` (a request the deploy policy decides after the job succeeded).
   */
  deploy: z.boolean().optional(),
});
export type AssignedPreviews = z.infer<typeof AssignedPreviews>;

/** How the worker vouched for the port of an `open` request. */
export const PreviewPortCheck = z.enum([
  /** A listener on loopback that belongs to the job's process tree. */
  'owned',
  /** A port a human declared (auto-open / console); a listener exists; ownership not required. */
  'declared',
]);

export const PreviewOp = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('open'),
    port: PreviewPort,
    name: PreviewName.optional(),
    protect: PreviewProtection.default('none'),
    ttlMinutes: z.number().int().min(5).max(PREVIEW_LIMITS.stableMaxMinutes).optional(),
    stable: z.boolean().default(false),
    check: PreviewPortCheck,
  }),
  z.strictObject({ kind: z.literal('close'), tunnelId: z.uuid().optional(), name: PreviewName.optional() }),
  z.strictObject({ kind: z.literal('list') }),
  /**
   * p10-publish-bundle (ADR-0038): publish this job's site when it succeeds (create the Pages project if missing,
   * deploy, attach a domain, write its CNAME) — recorded by the master, run after the job succeeded, policy-decided.
   */
  z.strictObject({
    kind: z.literal('publish'),
    env: z.enum(['preview', 'production']).optional(),
    pagesProject: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,57}$/)
      .optional(),
    createIfMissing: z.boolean().optional(),
    domain: z.string().min(3).max(253).optional(),
    dns: z.enum(['auto', 'skip']).optional(),
    directory: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
  }),
  /** p12-deploy-feedback: this job's deploy request and the project's recent deploys (or one action). */
  z.strictObject({ kind: z.literal('deploy_status'), actionId: z.uuid().optional() }),
  /** p12-deploy-feedback: build / runtime / health logs (redacted, capped) of an action or the project's runtime. */
  z.strictObject({
    kind: z.literal('deploy_logs'),
    actionId: z.uuid().optional(),
    logKind: z.enum(['build', 'runtime', 'health']).optional(),
    lines: z.number().int().min(10).max(2000).optional(),
    sinceMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .optional(),
    env: z.enum(['preview', 'production']).optional(),
  }),
  /** p12-deploy-feedback: redeploy this job's result when it succeeds — a request the deploy policy decides. */
  z.strictObject({
    kind: z.literal('redeploy'),
    target: z.enum(['pages', 'coolify']).optional(),
    env: z.enum(['preview', 'production']).optional(),
  }),
]);
export type PreviewOp = z.infer<typeof PreviewOp>;

/** worker → master `PREVIEW_REQUEST` payload (job message, control). */
export const PreviewRequestPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  op: PreviewOp,
});
export type PreviewRequestPayload = z.infer<typeof PreviewRequestPayload>;

export const PreviewTunnelState = z.enum(['opening', 'active', 'idle', 'closing', 'closed', 'failed']);
export type PreviewTunnelState = z.infer<typeof PreviewTunnelState>;

/** What a job sees of a preview. `serviceToken` only for the job that opened a `service-token` preview. */
export const PreviewTunnelInfo = z.object({
  id: z.uuid(),
  name: PreviewName,
  url: z.url({ protocol: /^https$/ }),
  protection: PreviewProtection,
  stable: z.boolean(),
  state: PreviewTunnelState,
  port: PreviewPort.nullable(),
  expiresAt: Timestamp,
  serviceToken: z
    .object({ clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(256) })
    .optional(),
});
export type PreviewTunnelInfo = z.infer<typeof PreviewTunnelInfo>;

/** master → worker `PREVIEW_RESULT` payload (job message, control). */
export const PreviewResultPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  /** `pending`: waits for a human approval (stable tunnels by default); the tunnel opens when approved. */
  status: z.enum(['ok', 'pending', 'refused', 'failed']),
  reason: z.string().max(64).optional(),
  detail: Text.optional(),
  tunnels: z.array(PreviewTunnelInfo).max(20).optional(),
  /** The ops action behind an open / close (console link). */
  actionId: z.uuid().optional(),
});
export type PreviewResultPayload = z.infer<typeof PreviewResultPayload>;

/** Connector token of one remotely-managed tunnel (base64 JSON as issued by Cloudflare). */
export const ConnectorToken = z.string().regex(/^[A-Za-z0-9+/=_-]{32,4096}$/, 'tunnel token');

export const TunnelSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });
export type TunnelSignature = z.infer<typeof TunnelSignature>;

/** master → worker `TUNNEL_START` payload (worker message, control). Re-sent with a new window to extend. */
export const TunnelStartPayload = z.object({
  tunnelId: z.uuid(),
  jobId: Identifier,
  attemptId: AttemptId,
  epoch: Epoch,
  port: PreviewPort,
  hostname: z.string().min(4).max(253),
  /** The worker stops the connector at this time even if the master does not. */
  expiresAt: Timestamp,
  connectorToken: ConnectorToken,
  /** How the port was vouched for (the worker re-checks before it starts). */
  check: PreviewPortCheck,
  issuedAt: Timestamp,
  /** Absent only when the master has no lease-signing key; a worker with trusted keys then refuses it. */
  signature: TunnelSignature.optional(),
});
export type TunnelStartPayload = z.infer<typeof TunnelStartPayload>;

/** master → worker `TUNNEL_STOP` payload (worker message, control). */
export const TunnelStopPayload = z.object({
  tunnelId: z.uuid(),
  reason: z.string().max(200),
  issuedAt: Timestamp,
  signature: TunnelSignature.optional(),
});
export type TunnelStopPayload = z.infer<typeof TunnelStopPayload>;

export const ConnectorState = z.enum(['starting', 'running', 'stopped', 'failed', 'refused']);
export type ConnectorState = z.infer<typeof ConnectorState>;

/** worker → master `TUNNEL_STATUS` payload (worker message, control). */
export const TunnelStatusPayload = z.object({
  tunnelId: z.uuid(),
  state: ConnectorState,
  /** Plain-language reason (refusals, exits); never cloudflared output verbatim. */
  detail: z.string().max(300).optional(),
  restarts: z.number().int().min(0).max(1000).optional(),
  at: Timestamp,
});
export type TunnelStatusPayload = z.infer<typeof TunnelStatusPayload>;

/** CAPABILITIES.previewTunnels (with `preview-tunnels-v1`). */
export const PreviewTunnelsReport = z.object({
  /** The managed cloudflared (tool recipe) or one found on the machine; null: not installed. */
  cloudflared: z.object({ version: z.string().max(64), source: z.enum(['managed', 'system']) }).nullable(),
  /** Connectors this worker runs now. */
  connectors: z.array(z.object({ tunnelId: z.uuid(), state: ConnectorState, since: Timestamp })).max(64),
});
export type PreviewTunnelsReport = z.infer<typeof PreviewTunnelsReport>;

export const TUNNEL_START_CONTEXT = 'remana-tunnel-start/v1';
export const TUNNEL_STOP_CONTEXT = 'remana-tunnel-stop/v1';
/** Clock skew the worker tolerates for `issuedAt`. */
export const TUNNEL_CLOCK_SKEW_MS = 2 * 60_000;
/** A TUNNEL_START older than this is refused (a re-send carries a fresh `issuedAt`). */
export const TUNNEL_START_MAX_AGE_MS = 5 * 60_000;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface TunnelStartBinding {
  readonly workerId: string;
  readonly tunnelId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly port: number;
  readonly hostname: string;
  readonly expiresAt: string;
  readonly check: z.infer<typeof PreviewPortCheck>;
  readonly issuedAt: string;
  readonly connectorToken: string;
}

/** Exact bytes a master signs for a TUNNEL_START (the token only as its SHA-256). */
export function tunnelStartStatement(b: TunnelStartBinding): Buffer {
  return Buffer.from(
    [
      TUNNEL_START_CONTEXT,
      b.workerId,
      b.tunnelId,
      b.jobId,
      b.attemptId,
      String(b.epoch),
      String(b.port),
      b.hostname.toLowerCase(),
      b.expiresAt,
      b.check,
      b.issuedAt,
      sha256Hex(b.connectorToken),
    ].join('\n'),
    'utf8',
  );
}

export function tunnelStopStatement(b: {
  readonly workerId: string;
  readonly tunnelId: string;
  readonly issuedAt: string;
}): Buffer {
  return Buffer.from([TUNNEL_STOP_CONTEXT, b.workerId, b.tunnelId, b.issuedAt].join('\n'), 'utf8');
}

export function signTunnelStart(b: TunnelStartBinding, kid: string, key: KeyObject): TunnelSignature {
  return { kid, signature: sign(null, tunnelStartStatement(b), key).toString('base64url') };
}

export function signTunnelStop(
  b: Parameters<typeof tunnelStopStatement>[0],
  kid: string,
  key: KeyObject,
): TunnelSignature {
  return { kid, signature: sign(null, tunnelStopStatement(b), key).toString('base64url') };
}

type Verdict = 'ok' | 'missing' | 'unknown_key' | 'bad_signature';

function verifyWith(
  statement: Buffer,
  signature: TunnelSignature | undefined,
  keys: readonly LeaseKey[],
): Verdict {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, statement, signature.signature) ? 'ok' : 'bad_signature';
}

/** Verifies a TUNNEL_START signature against trusted master keys. Never throws. */
export function verifyTunnelStart(
  b: TunnelStartBinding,
  signature: TunnelSignature | undefined,
  keys: readonly LeaseKey[],
): Verdict {
  return verifyWith(tunnelStartStatement(b), signature, keys);
}

export function verifyTunnelStop(
  b: Parameters<typeof tunnelStopStatement>[0],
  signature: TunnelSignature | undefined,
  keys: readonly LeaseKey[],
): Verdict {
  return verifyWith(tunnelStopStatement(b), signature, keys);
}

/** `issuedAt` within the accepted window (worker side). */
export function tunnelMessageFresh(issuedAt: string, now: Date, maxAgeMs = TUNNEL_START_MAX_AGE_MS): boolean {
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime() + TUNNEL_CLOCK_SKEW_MS && now.getTime() - t <= maxAgeMs + TUNNEL_CLOCK_SKEW_MS;
}
