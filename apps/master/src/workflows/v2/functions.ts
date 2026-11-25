import { createHash } from 'node:crypto';
import {
  FUNCTION_HTTP_PORTS,
  FUNCTION_LIMITS,
  FUNCTION_RESULT_ARTIFACT_ID,
  FUNCTION_SMTP_PORTS,
  type FunctionEgress,
  FunctionErrorCode,
  FunctionResult,
  type FunctionSpec,
} from '@remyral/protocol';
import {
  type EmailSendConfig,
  isForbiddenHost,
  MAIL_ADDRESS,
  nodeType,
  originPort,
  smtpServer,
  type V2Node,
} from '@remyral/workflow-nodes';
import type { Queryable } from '../../db/pool.js';
import { CREDENTIAL_NOT_ALLOWED_FOR_PROJECT, credentialAllowsProject } from '../../vault/projects.js';
import { rowContent } from '../../blobs/registry.js';
import { egressAllows } from '../egress.js';
import { clip } from '../steps.js';

/**
 * p14-workflow-engine 14.3 (ADR-0055 §5.2, docs/design/p14-workflow-engine.md §19): the master side of the worker
 * function nodes — `http.request`, `email.send` (K4), `code.js` / `code.python` (K3). The master never opens these
 * connections itself (§5.1): it builds a {@link FunctionSpec} from the node's static config and the values its
 * expressions resolved to, checks it against the project's egress policy (K1) and the vault credential's bound hosts,
 * and the engine submits it as a `kind: "function"` job through the side-effect outbox (one job per node-run attempt,
 * the same Idempotency-Key across attempts and lease losses). The worker re-checks everything (DNS, every resolved
 * address, redirects, the credential's hosts). The result artifact becomes the node's output.
 */

export const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  'http.request',
  'email.send',
  'code.js',
  'code.python',
]);

export function isFunctionNode(type: string): boolean {
  return FUNCTION_NODE_TYPES.has(type);
}

/** Default wait for a capable worker before the node fails `no_worker` (§5.2, node `queueTimeoutSec`). */
export const DEFAULT_QUEUE_TIMEOUT_SEC = 600;
const SMTP_TIMEOUT_SEC = 60;
/** Slack on top of the call's own timeout for the function job's lease (`limits.maxDurationSec`). */
const JOB_SLACK_SEC = 60;

/** A function request that cannot be built (the node fails with the code, without retry). */
export class FunctionRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FunctionRequestError';
  }
}

export interface FunctionCredentialRow {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly state: string;
  readonly allowedHosts: readonly string[] | null;
  /** p22-vault-projects: the projects that may use it (null: every project). */
  readonly projects: readonly string[] | null;
}

export async function loadFunctionCredential(
  db: Queryable,
  id: string,
): Promise<FunctionCredentialRow | null> {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    version: number;
    state: string;
    allowed_hosts: string[] | null;
    projects: string[] | null;
  }>('SELECT id, kind, version, state, allowed_hosts, projects FROM vault_credentials WHERE id = $1', [id]);
  const r = rows[0];
  return r === undefined
    ? null
    : {
        id: r.id,
        kind: r.kind,
        version: r.version,
        state: r.state,
        allowedHosts: r.allowed_hosts,
        projects: r.projects,
      };
}

/** `host` and `host:port` forms a bound-host list may use for a target. */
function hostForms(host: string, port: number): string[] {
  const h = host.toLowerCase();
  return [h, `${h}:${String(port)}`];
}

/**
 * The credential for a node, checked: exists, active, the right kind, allowed for the project (p22-vault-projects),
 * bound to the target host.
 */
async function boundCredential(
  db: Queryable,
  id: string,
  kind: 'http-auth' | 'smtp',
  host: string,
  port: number,
  project: string,
): Promise<FunctionCredentialRow & { readonly allowedHosts: readonly string[] }> {
  const c = await loadFunctionCredential(db, id);
  if (c === null || c.state !== 'active')
    throw new FunctionRequestError(
      'credential_unknown',
      `vault credential ${id} does not exist or is revoked`,
    );
  if (c.kind !== kind)
    throw new FunctionRequestError('credential_kind', `vault credential ${id} is not a ${kind} credential`);
  if (!credentialAllowsProject(c.projects, project))
    throw new FunctionRequestError(
      CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
      `vault credential ${id} is not allowed for project ${project} (Ayarlar → Kimlik bilgileri → Projeler)`,
    );
  const allowed = c.allowedHosts ?? [];
  if (!hostForms(host, port).some((h) => allowed.includes(h)))
    throw new FunctionRequestError(
      'credential_host_not_bound',
      `vault credential ${id} is not bound to ${host}:${String(port)} (its allowed hosts: ${allowed.join(', ') || 'none'})`,
    );
  return { ...c, allowedHosts: allowed };
}

function checkTarget(egress: FunctionEgress, host: string, port: number, defaults: readonly number[]): void {
  if (isForbiddenHost(host))
    throw new FunctionRequestError(
      'egress_refused',
      `${host} is a LAN, private, loopback or metadata address (always refused)`,
    );
  if (!egressAllows(egress, host, port, defaults))
    throw new FunctionRequestError(
      'egress_not_allowed',
      egress.mode === 'allowlist'
        ? `${host}:${String(port)} is not on the project's HTTP allowlist (Projects → Policy → HTTP izin listesi)`
        : `port ${String(port)} of ${host} needs a ${host}:${String(port)} entry in the project's HTTP list`,
    );
}

const asText = (v: unknown, max: number): string =>
  clip(typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v), max);

function noCrLf(v: string, what: string): string {
  if (/[\r\n\0]/.test(v))
    throw new FunctionRequestError('type_error', `${what} must not contain line breaks`);
  return v;
}

function addresses(v: unknown, what: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : [v];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string')
      throw new FunctionRequestError('type_error', `${what}: not an e-mail address`);
    const a = raw.trim();
    if (a === '') continue;
    if (!MAIL_ADDRESS.test(a) || a.length > 320)
      throw new FunctionRequestError('invalid_address', `${what}: ${clip(a, 80)} is not an e-mail address`);
    out.push(a);
  }
  return out;
}

export interface BuiltFunction {
  readonly spec: FunctionSpec;
  /** `limits.maxDurationSec` of the function job. */
  readonly maxDurationSec: number;
  /** How long the job may wait for a capable worker before the node fails `no_worker`. */
  readonly queueTimeoutSec: number;
  /** HTTP methods that are not idempotent are retried only with `retry.safe` (§5.2). */
  readonly idempotent: boolean;
}

/**
 * The function spec of a ready node from its static config and resolved expression fields. `key`: the node run's
 * idempotency key (identical across attempts).
 */
export async function buildFunction(input: {
  readonly db: Queryable;
  readonly node: V2Node;
  readonly config: Readonly<Record<string, unknown>>;
  /** The node's input value (code nodes without an `input` field get it). */
  readonly value: unknown;
  readonly key: string;
  readonly egress: FunctionEgress;
  /**
   * p18-multi-project: the vault credential a credential id written in the definition (a slot) resolves to — itself in
   * the owner project, the target's binding in a project that attached the workflow (throws `credential_unbound`).
   */
  readonly credential?: (slot: string) => string;
  /** p22-vault-projects: the project the job runs in — a credential must be allowed for it. */
  readonly project: string;
}): Promise<BuiltFunction> {
  const { node, config: c, egress } = input;
  const resolve = input.credential ?? ((slot: string) => slot);
  const idempotencyKey = `wf-${input.key.slice(0, 64)}`;
  const queueTimeoutSec = node.queueTimeoutSec ?? DEFAULT_QUEUE_TIMEOUT_SEC;
  switch (node.type) {
    case 'http.request': {
      const origin = new URL(String(c.origin));
      const host = origin.hostname.replace(/^\[|\]$/g, '');
      const port = originPort(origin.origin);
      checkTarget(egress, host, port, FUNCTION_HTTP_PORTS);
      const path = asText(c.path ?? '/', 2048);
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\s\0]/.test(path))
        throw new FunctionRequestError(
          'invalid_path',
          'the path must start with a single / and contain no spaces or backslashes',
        );
      const url = new URL(path, origin);
      if (url.origin !== origin.origin)
        throw new FunctionRequestError('invalid_path', 'the path may not change the origin');
      for (const [name, v] of Object.entries((c.query as Record<string, unknown> | undefined) ?? {}))
        url.searchParams.append(name, asText(v, 2048));
      url.hash = '';
      const headers: Record<string, string> = {};
      for (const [name, v] of Object.entries((c.headers as Record<string, unknown> | undefined) ?? {}))
        headers[name] = noCrLf(asText(v, 4096), `header ${name}`);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent'))
        headers['User-Agent'] = 'Remyral-Workflow/1.0';
      let body: { contentType: string; text: string } | undefined;
      const b = c.body as { type?: string; value?: unknown } | undefined;
      if (b !== undefined) {
        if (b.type === 'json')
          body = { contentType: 'application/json', text: JSON.stringify(b.value ?? null) };
        else if (b.type === 'form') {
          const v = b.value;
          if (v === null || typeof v !== 'object' || Array.isArray(v))
            throw new FunctionRequestError('type_error', 'a form body must be an object of fields');
          const form = new URLSearchParams();
          for (const [k, x] of Object.entries(v)) form.append(k, asText(x, 64 * 1024));
          body = { contentType: 'application/x-www-form-urlencoded', text: form.toString() };
        } else
          body = {
            contentType: 'text/plain; charset=utf-8',
            text: asText(b.value, FUNCTION_LIMITS.maxRequestBodyBytes),
          };
        if (Buffer.byteLength(body.text, 'utf8') > FUNCTION_LIMITS.maxRequestBodyBytes)
          throw new FunctionRequestError('request_too_large', 'the request body is larger than 1 MiB');
      }
      const auth = c.auth as { credential: string; placement?: string; name?: string } | undefined;
      let credential: Extract<FunctionSpec, { type: 'http' }>['credential'];
      if (auth !== undefined) {
        const cred = await boundCredential(
          input.db,
          resolve(auth.credential),
          'http-auth',
          host,
          port,
          input.project,
        );
        const placement = (auth.placement ?? 'bearer') as 'header' | 'bearer' | 'basic' | 'query';
        if ((placement === 'header' || placement === 'query') && auth.name === undefined)
          throw new FunctionRequestError(
            'credential_name_required',
            `a ${placement} credential needs the header / parameter name`,
          );
        credential = {
          id: cred.id,
          version: cred.version,
          placement,
          ...(auth.name === undefined ? {} : { name: auth.name }),
          allowedHosts: [...cred.allowedHosts],
        };
      }
      const timeoutSec = Number(c.timeoutSec ?? 30);
      const method = (typeof c.method === 'string' ? c.method : 'GET') as
        'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      return {
        spec: {
          type: 'http',
          idempotencyKey,
          request: {
            method,
            url: url.toString(),
            headers,
            ...(body === undefined ? {} : { body }),
            timeoutSec,
            maxResponseBytes: Number(c.maxResponseBytes ?? FUNCTION_LIMITS.maxResponseBytes),
            followRedirects: Number(c.followRedirects ?? 3),
            responseType: (c.responseType ?? 'json') as 'json' | 'text' | 'binary',
          },
          ...(credential === undefined ? {} : { credential }),
          egress,
        },
        maxDurationSec: timeoutSec * (1 + Number(c.followRedirects ?? 3)) + JOB_SLACK_SEC,
        queueTimeoutSec,
        idempotent: method === 'GET' || method === 'HEAD' || method === 'PUT',
      };
    }
    case 'email.send': {
      const cfg = c as unknown as EmailSendConfig;
      const server = smtpServer(cfg);
      checkTarget(egress, server.host, server.port, FUNCTION_SMTP_PORTS);
      const cred = await boundCredential(
        input.db,
        resolve(cfg.smtp.credential),
        'smtp',
        server.host,
        server.port,
        input.project,
      );
      const to = addresses(c.to, 'to');
      const cc = addresses(c.cc, 'cc');
      const bcc = addresses(c.bcc, 'bcc');
      const total = to.length + cc.length + bcc.length;
      const max = Math.min(cfg.maxRecipients, FUNCTION_LIMITS.maxRecipients);
      if (total === 0) throw new FunctionRequestError('no_recipients', 'the message has no recipients');
      if (total > max)
        throw new FunctionRequestError(
          'too_many_recipients',
          `${String(total)} recipients exceed the node's limit of ${String(max)}`,
        );
      const replyTo = c.replyTo === undefined ? [] : addresses(c.replyTo, 'replyTo');
      const text = c.text === undefined ? undefined : asText(c.text, 256 * 1024);
      const html = c.html === undefined ? undefined : asText(c.html, 256 * 1024);
      return {
        spec: {
          type: 'email',
          idempotencyKey,
          smtp: { host: server.host, port: server.port, tls: server.tls, username: cfg.smtp.username },
          credential: { id: cred.id, version: cred.version, allowedHosts: [...cred.allowedHosts] },
          message: {
            from: cfg.from.address,
            ...(cfg.from.name === undefined ? {} : { fromName: cfg.from.name }),
            to,
            cc,
            bcc,
            ...(replyTo[0] === undefined ? {} : { replyTo: replyTo[0] }),
            subject: asText(c.subject, 998).replace(/[\r\n]+/g, ' '),
            ...(text === undefined ? {} : { text }),
            ...(html === undefined ? {} : { html }),
            messageId: `<${idempotencyKey}@remyral.workflow>`,
          },
          timeoutSec: SMTP_TIMEOUT_SEC,
          egress,
        },
        maxDurationSec: SMTP_TIMEOUT_SEC + JOB_SLACK_SEC,
        queueTimeoutSec,
        idempotent: false,
      };
    }
    case 'code.js':
    case 'code.python': {
      const value = c.input === undefined ? (input.value ?? null) : c.input;
      const json = JSON.stringify(value ?? null);
      if (Buffer.byteLength(json, 'utf8') > FUNCTION_LIMITS.maxCodeInputBytes)
        throw new FunctionRequestError('value_too_large', 'the code input is larger than 1 MiB');
      const timeoutSec = Number(c.timeoutSec ?? 10);
      return {
        spec: {
          type: 'code',
          language: node.type === 'code.js' ? 'js' : 'python',
          source: String(c.source),
          input: JSON.parse(json) as unknown,
          timeoutSec,
          memoryMb: Number(c.memoryMb ?? 256),
        },
        maxDurationSec: timeoutSec + JOB_SLACK_SEC,
        queueTimeoutSec,
        // Code has no outside effect (no network): repeating it is harmless.
        idempotent: true,
      };
    }
    default:
      throw new FunctionRequestError('node_type_unavailable', `${node.type} is not a function node`);
  }
}

/** The protocol JobSpec of a function job (no repository / workspace / runtime; the runtime is a label). */
export function functionJobSpec(input: {
  readonly project: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly type: string;
  readonly built: BuiltFunction;
}): Record<string, unknown> {
  return {
    kind: 'function',
    function: input.built.spec,
    projectId: input.project,
    runtime: 'claude-code',
    prompt: `Workflow function (no agent): ${input.type} of node ${input.nodeId}, run ${input.runId}.`,
    sandboxProfile: 'container',
    approvalPolicy: 'deny-sensitive',
    sourceTrust: 'untrusted',
    limits: { maxDurationSec: Math.min(Math.max(input.built.maxDurationSec, 30), 3600) },
    role: 'chore',
  };
}

/** What a finished function job means for its node: an output on `out`, or a failure code (→ error port / policy). */
export type FunctionOutcome =
  | { readonly kind: 'done'; readonly output: unknown }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly retryable: boolean };

/** Codes that are refusals by policy or configuration: never retried. */
const REFUSALS = new Set<string>([
  'credential_unbound',
  CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
  'egress_refused',
  'egress_not_allowed',
  'credential_host_refused',
  'credential_missing',
  'redirect_refused',
  'smtp_tls_required',
  'smtp_auth_failed',
  'code_unavailable',
  'code_output_invalid',
  'function_refused',
]);

/** The function result artifact of a job (stored redacted by the master), or null. */
export async function readFunctionResult(db: Queryable, jobId: string): Promise<FunctionResult | null> {
  const { rows } = await db.query<{ content: Buffer | null; blob_key: string | null }>(
    `SELECT content, blob_key FROM job_artifacts WHERE job_id = $1 AND kind = 'function' AND artifact_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [jobId, FUNCTION_RESULT_ARTIFACT_ID],
  );
  // p17-object-storage: the result's bytes may be in the blob store.
  const c = rows[0] === undefined ? null : await rowContent(rows[0], 16 * 1024 * 1024);
  if (c === null) return null;
  const parsed = FunctionResult.safeParse(JSON.parse(c.toString('utf8')));
  return parsed.success ? parsed.data : null;
}

/** The output of a succeeded function job; HTTP statuses outside `successStatus` (default 2xx) fail `http_status`. */
export function functionOutcome(
  type: string,
  config: Readonly<Record<string, unknown>>,
  result: FunctionResult | null,
): FunctionOutcome {
  if (result === null)
    return {
      kind: 'failed',
      code: 'function_result_missing',
      message: 'the worker reported success but sent no result',
      retryable: true,
    };
  if (type === 'http.request' && result.type === 'http') {
    const ok = Array.isArray(config.successStatus)
      ? (config.successStatus as unknown[]).includes(result.status)
      : result.status >= 200 && result.status <= 299;
    if (!ok)
      return {
        kind: 'failed',
        code: 'http_status',
        message: `HTTP ${String(result.status)} from ${clip(result.finalUrl, 300)}`,
        retryable: true,
      };
    return {
      kind: 'done',
      output: {
        status: result.status,
        headers: result.headers,
        body: result.body ?? null,
        ...(result.truncated ? { truncated: true } : {}),
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
      },
    };
  }
  if (type === 'email.send' && result.type === 'email')
    return {
      kind: 'done',
      output: { messageId: result.messageId, accepted: result.accepted, rejected: result.rejected },
    };
  if ((type === 'code.js' || type === 'code.python') && result.type === 'code')
    return { kind: 'done', output: result.output ?? null };
  return {
    kind: 'failed',
    code: 'function_result_invalid',
    message: 'the result does not match the node',
    retryable: false,
  };
}

/** The failure of a failed function job: the worker's typed code (FunctionErrorCode) or a generic one. */
export async function functionFailure(
  db: Queryable,
  jobId: string,
): Promise<{ code: string; message: string; retryable: boolean }> {
  const { rows } = await db.query<{ result: { error?: { code?: unknown; message?: unknown } } | null }>(
    `SELECT r.result FROM job_runs r JOIN job_attempts a ON a.id = r.attempt_id
      WHERE r.job_id = $1 AND r.result IS NOT NULL ORDER BY a.started_at DESC NULLS LAST LIMIT 1`,
    [jobId],
  );
  const err = rows[0]?.result?.error;
  const raw = typeof err?.code === 'string' ? err.code : null;
  const message = typeof err?.message === 'string' ? clip(err.message, 1000) : 'the function job failed';
  if (raw === null) {
    // p22-vault-projects: dispatch refused the job's credential for its project (`infeasible`, never assigned).
    const refused = await db.query(
      "SELECT 1 FROM job_transitions WHERE job_id = $1 AND trigger = 'infeasible' AND reason LIKE $2 LIMIT 1",
      [jobId, `%(${CREDENTIAL_NOT_ALLOWED_FOR_PROJECT})%`],
    );
    if ((refused.rowCount ?? 0) > 0)
      return {
        code: CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
        message: 'the vault credential is not allowed for this project',
        retryable: false,
      };
    const acked = await everAcked(db, jobId);
    return acked
      ? { code: 'job_failed', message, retryable: true }
      : { code: 'no_worker', message: 'no capable worker could take the function job', retryable: true };
  }
  const code = FunctionErrorCode.safeParse(raw).success ? raw : 'job_failed';
  return { code, message, retryable: !REFUSALS.has(code) };
}

/** Whether a worker ever accepted the job (a lease_acked transition): the queue timeout no longer applies. */
export async function everAcked(db: Queryable, jobId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM job_transitions WHERE job_id = $1 AND trigger = 'lease_acked' LIMIT 1",
    [jobId],
  );
  return (rowCount ?? 0) > 0;
}

/** Stable short hash for logs (never the value). */
export function specDigest(spec: FunctionSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
}

/** Save-time checks of a definition's function nodes against the project policy and the vault (§8.4). */
export async function functionNodeIssues(
  db: Queryable,
  nodes: readonly V2Node[],
  egress: FunctionEgress,
  /** p22-vault-projects: the project the definition is saved / attached in. */
  project: string,
): Promise<{ path: string; code: string }[]> {
  const issues: { path: string; code: string }[] = [];
  for (const [i, n] of nodes.entries()) {
    if (!isFunctionNode(n.type) || nodeType(n.type) === undefined) continue;
    const c = (n as { config?: Record<string, unknown> }).config ?? {};
    const at = `nodes.${String(i)}.config`;
    try {
      if (n.type === 'http.request') {
        const origin = new URL(String(c.origin));
        const host = origin.hostname.replace(/^\[|\]$/g, '');
        const port = originPort(origin.origin);
        try {
          checkTarget(egress, host, port, FUNCTION_HTTP_PORTS);
        } catch (err) {
          if (err instanceof FunctionRequestError) issues.push({ path: `${at}.origin`, code: err.code });
        }
        const auth = c.auth as { credential?: string } | undefined;
        if (auth?.credential !== undefined) {
          try {
            await boundCredential(db, auth.credential, 'http-auth', host, port, project);
          } catch (err) {
            if (err instanceof FunctionRequestError)
              issues.push({ path: `${at}.auth.credential`, code: err.code });
          }
        }
      } else if (n.type === 'email.send') {
        const server = smtpServer(c as unknown as EmailSendConfig);
        try {
          checkTarget(egress, server.host, server.port, FUNCTION_SMTP_PORTS);
        } catch (err) {
          if (err instanceof FunctionRequestError) issues.push({ path: `${at}.smtp.host`, code: err.code });
        }
        const id = (c.smtp as { credential?: string } | undefined)?.credential;
        if (id !== undefined) {
          try {
            await boundCredential(db, id, 'smtp', server.host, server.port, project);
          } catch (err) {
            if (err instanceof FunctionRequestError)
              issues.push({ path: `${at}.smtp.credential`, code: err.code });
          }
        }
      }
    } catch {
      issues.push({ path: at, code: 'invalid' });
    }
  }
  return issues;
}
