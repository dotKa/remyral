import { z } from 'zod';
import { PreviewPort } from './previews.js';
import { VaultCredentialId } from './worker-config.js';

/**
 * p14-workflow-engine 14.3 (ADR-0055 §5.2, docs/design/p14-workflow-engine.md §19): **function jobs** — the
 * non-AI job kind that runs a workflow's HTTP request, e-mail and code nodes on a worker. Never on the master: the
 * master never opens a connection to a host chosen by a workflow author or by data (§5.1).
 *
 * Wire (additive in 1.0, only to workers advertising the features):
 *  - ASSIGN_JOB `spec.kind = "function"` with `spec.function` ({@link FunctionSpec}). No repository, no workspace, no
 *    runtime (its runtime is a label), no model, no secrets by `secretRefs`, no AI slot: the worker runs at most
 *    {@link FUNCTION_LIMITS.slots} function jobs beside its agent jobs, and the master counts them apart.
 *  - `function-v1` ({@link FUNCTION_FEATURE}): HTTP (`type: "http"`) and SMTP (`type: "email"`). Every connection
 *    target — the first URL, each redirect hop, the SMTP host — is resolved by the worker, every resolved address is
 *    checked against the non-public ranges (loopback, RFC 1918, CGNAT, link-local / metadata, ULA, multicast,
 *    reserved, IPv4-mapped / NAT64 forms) and the connection goes to exactly that checked address (no second lookup,
 *    so DNS rebinding cannot swap it). K1: any public host by default; with the project allowlist on (`egress.mode =
 *    "allowlist"`) only listed hosts. A vault credential (`http-auth` / `smtp`) is attached only for a host in its
 *    `allowedHosts`, never after a redirect to another host.
 *  - `function-code-v1` ({@link FUNCTION_CODE_FEATURE}, K3): `type: "code"` (JavaScript / Python) in a network-less
 *    container of a pinned image ({@link FUNCTION_CODE_BASE_IMAGES}); advertised only by workers whose container
 *    engine is ready.
 *  - `watch-checks-v1` ({@link WATCH_CHECKS_FEATURE}, p15-watches): `type: "probe"` — a deterministic check of a port
 *    on the worker's OWN loopback interface (HTTP GET / HEAD or a TCP connect; the `curl localhost:3000` case of a
 *    watch). Loopback only, ports of the preview port policy ({@link PreviewPort}), no credential, no redirects; an
 *    unreachable port is a successful result with `reachable: false` (the watch is simply "not yet").
 *  - The result is the artifact {@link FUNCTION_RESULT_NAME} (id {@link FUNCTION_RESULT_ARTIFACT_ID},
 *    {@link FunctionResult}), redacted on the worker (the credential's exact value + secret patterns) and again on the
 *    master. A refused or failed call is a failed JOB_RESULT whose `error.code` is one of {@link FunctionErrorCode}.
 *  - At-least-once: a lease loss can run the same job twice; HTTP and e-mail carry the node run's idempotency key
 *    (identical across attempts) as `Idempotency-Key` / a deterministic `Message-ID`.
 */

export const FUNCTION_FEATURE = 'function-v1';
export const FUNCTION_CODE_FEATURE = 'function-code-v1';
/**
 * p14-code-images (docs/design/p14-followups.md §2): the worker can build its code node images itself — the remote op
 * `code.images.prepare` pulls {@link FUNCTION_CODE_BASE_IMAGES} by digest and builds `remyral/code-js` /
 * `remyral/code-python` from the build contexts shipped in the worker release. Then it advertises `function-code-v1`.
 */
export const CODE_IMAGES_FEATURE = 'code-images-v1';

/** p15-watches: `function` jobs of type `probe` (loopback port checks of a watch). */
export const WATCH_CHECKS_FEATURE = 'watch-checks-v1';
export const FUNCTION_RESULT_ARTIFACT_ID = 'ws-function-result';
export const FUNCTION_RESULT_NAME = 'function-result.json';

export const FUNCTION_LIMITS = {
  /** Function jobs one worker runs at once (beside, never instead of, its AI slots). */
  slots: 8,
  /** HTTP: response bytes read at most (the body is cut there and marked `truncated`). */
  maxResponseBytes: 1024 * 1024,
  /** HTTP: response body bytes returned in the result (stored by the master in the payload store). */
  maxReturnedBodyBytes: 256 * 1024,
  maxRequestBodyBytes: 1024 * 1024,
  maxRedirects: 3,
  maxHttpTimeoutSec: 120,
  maxHeaders: 30,
  maxResponseHeaders: 30,
  /** SMTP: whole conversation. */
  maxSmtpTimeoutSec: 120,
  maxRecipients: 50,
  /** Code: source, stdin input and stdout output (JSON). */
  maxSourceBytes: 64 * 1024,
  maxCodeInputBytes: 1024 * 1024,
  maxCodeOutputBytes: 256 * 1024,
  maxCodeTimeoutSec: 60,
  minCodeMemoryMb: 32,
  maxCodeMemoryMb: 256,
  /** The whole `function-result.json` artifact. */
  maxResultBytes: 768 * 1024,
  /** Allowlist / credential host lists. */
  maxEgressHosts: 64,
  maxCredentialHosts: 16,
  /** Probe (watch-checks-v1): one connection to loopback, bounded. */
  maxProbeTimeoutSec: 30,
  maxProbeResponseBytes: 64 * 1024,
} as const;

/** Ports an HTTP node may use without the project allowlist naming `host:port` (§3.5). */
export const FUNCTION_HTTP_PORTS: readonly number[] = [80, 443, 8080, 8443];
/** SMTP ports (K4): 465 implicit TLS, 587 / 25 / 2525 STARTTLS — never plaintext. */
export const FUNCTION_SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];

/**
 * K3: base images of the code node, pinned by digest. The worker runs its locally built `remyral/code-js` /
 * `remyral/code-python` images (infra/worker/images/code-js|code-python, `FROM` exactly these digests — checked by
 * `pnpm security:pins` and a protocol test), never a tag pulled at run time.
 */
export const FUNCTION_CODE_BASE_IMAGES = {
  js: 'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205',
  python: 'python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641',
} as const;

/** Code node languages (the keys of {@link FUNCTION_CODE_BASE_IMAGES}). */
export const CodeLanguage = z.enum(['js', 'python']);
export type CodeLanguage = z.infer<typeof CodeLanguage>;

/** p14-code-images: what `code.images.prepare` built (OPS_UPDATE `codeImages`). */
export const CodeImagesReport = z.object({
  images: z
    .array(
      z.object({
        language: CodeLanguage,
        /** Local tag the code executor runs (`remyral/code-js:0.1.0`). */
        tag: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9._-]{1,64}$/),
        /** The pinned base it was built FROM (`name:tag@sha256:…`, one of FUNCTION_CODE_BASE_IMAGES). */
        base: z.string().max(256),
        /** Local image id (`sha256:…`). */
        id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      }),
    )
    .max(2),
  /** The worker's code executor sees both images now (it then advertises function-code-v1). */
  ready: z.boolean(),
});
export type CodeImagesReport = z.infer<typeof CodeImagesReport>;

/** Why a function job failed (JOB_RESULT `error.code`); the master maps each to the node's error output. */
export const FunctionErrorCode = z.enum([
  /** The target (or a redirect hop, or the SMTP host) is / resolves to a non-public address. */
  'egress_refused',
  /** The project allowlist is on and the host (or `host:port`) is not on it, or the port is not allowed. */
  'egress_not_allowed',
  /** DNS gave no address. */
  'dns_failed',
  /** The credential is not attached to a host outside its `allowedHosts` (refused before sending). */
  'credential_host_refused',
  /** The vault credential is not on this worker (or not usable as a header value / password). */
  'credential_missing',
  /** A redirect that cannot be followed (no Location, scheme change to a non-http(s) URL, too many). */
  'redirect_refused',
  'http_timeout',
  /** Connection / TLS / protocol error. */
  'http_error',
  'smtp_error',
  'smtp_auth_failed',
  /** The server does not offer TLS (STARTTLS) — mail is never sent in plaintext. */
  'smtp_tls_required',
  /** Every recipient was refused by the server. */
  'smtp_rejected',
  'smtp_timeout',
  /** No ready container engine / image for code on this worker. */
  'code_unavailable',
  'code_timeout',
  /** The code threw, exited non-zero or was killed (memory). */
  'code_failed',
  /** stdout was not one JSON document within the size limit. */
  'code_output_invalid',
  /** The spec is malformed or not allowed here (defence in depth behind the master). */
  'function_refused',
]);
export type FunctionErrorCode = z.infer<typeof FunctionErrorCode>;

const HostEntry = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[a-z0-9.-]+(:\d{1,5})?$/, 'host or host:port (lower case, no IP literal check here)');

/** The project's effective egress policy, sent with every network function job (the worker re-checks it). */
export const FunctionEgress = z.strictObject({
  mode: z.enum(['open', 'allowlist']),
  /** `host` or `host:port`; in `open` mode only `host:port` entries matter (non-default ports). */
  hosts: z.array(HostEntry).max(FUNCTION_LIMITS.maxEgressHosts),
});
export type FunctionEgress = z.infer<typeof FunctionEgress>;

/** p22-runtime-diagnostics: a certificate fingerprint — SHA-256 of the DER certificate, 64 lower-case hex digits. */
export const CertSha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** p22-runtime-diagnostics: at most this many pinned certificates travel with one function job. */
export const MAX_TLS_PINS = 32;

/**
 * p22-runtime-diagnostics: ASSIGN_JOB `execution.tlsPins` (only to `function-tls-pins-v1` workers; function jobs) — the
 * certificates the job's project trusts although they fail verification (self-signed internal services), each bound
 * to one `host:port`. Opt-in per project (Trust this certificate, audited); without a pin verification stays strict.
 */
export const AssignedTlsPin = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.:-]+$/),
  port: z.number().int().min(1).max(65_535),
  sha256: CertSha256,
});
export type AssignedTlsPin = z.infer<typeof AssignedTlsPin>;
export const AssignedTlsPins = z.array(AssignedTlsPin).max(MAX_TLS_PINS);

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const HeaderName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const FunctionHttpSpec = z.strictObject({
  type: z.literal('http'),
  /** Same across attempts and lease losses of one node run: sent as `Idempotency-Key`. */
  idempotencyKey: IdempotencyKey,
  request: z.strictObject({
    method: z.enum(HTTP_METHODS),
    /** Absolute http(s) URL built by the master: static origin + encoded path + encoded query. */
    url: z.url({ protocol: /^https?$/ }).max(8192),
    headers: z
      .record(HeaderName, z.string().max(4096))
      .refine((h) => Object.keys(h).length <= FUNCTION_LIMITS.maxHeaders, { message: 'too_many' }),
    body: z
      .strictObject({
        contentType: z.string().min(1).max(200),
        /** UTF-8 text (JSON / form / text bodies are built by the master). */
        text: z.string().max(FUNCTION_LIMITS.maxRequestBodyBytes),
      })
      .optional(),
    timeoutSec: z.number().int().min(1).max(FUNCTION_LIMITS.maxHttpTimeoutSec),
    maxResponseBytes: z.number().int().min(1).max(FUNCTION_LIMITS.maxResponseBytes),
    followRedirects: z.number().int().min(0).max(FUNCTION_LIMITS.maxRedirects),
    responseType: z.enum(['json', 'text', 'binary']),
  }),
  /** A vault `http-auth` credential: attached only when the (current hop's) host is in `allowedHosts`. */
  credential: z
    .strictObject({
      id: VaultCredentialId,
      version: z.number().int().min(1),
      placement: z.enum(['header', 'bearer', 'basic', 'query']),
      /** Header name (`header`) or query parameter name (`query`). */
      name: z
        .string()
        .regex(/^[A-Za-z0-9_.~-]{1,64}$/)
        .optional(),
      /** Exact `host` or `host:port` (lower case). */
      allowedHosts: z.array(HostEntry).min(1).max(FUNCTION_LIMITS.maxCredentialHosts),
    })
    .optional(),
  egress: FunctionEgress,
});
export type FunctionHttpSpec = z.infer<typeof FunctionHttpSpec>;

const MailAddress = z
  .string()
  .max(320)
  .regex(/^[^@\s<>",;()\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/);

export const FunctionEmailSpec = z.strictObject({
  type: z.literal('email'),
  idempotencyKey: IdempotencyKey,
  /** K4: static in the node's config (provider preset or own server). */
  smtp: z.strictObject({
    host: z.string().min(1).max(253),
    port: z
      .number()
      .int()
      .refine((p) => FUNCTION_SMTP_PORTS.includes(p), { message: 'port_not_allowed' }),
    tls: z.enum(['tls', 'starttls']),
    username: z.string().min(1).max(256),
  }),
  /** The vault `smtp` credential holding the password; attached only for a host in `allowedHosts`. */
  credential: z.strictObject({
    id: VaultCredentialId,
    version: z.number().int().min(1),
    allowedHosts: z.array(HostEntry).min(1).max(FUNCTION_LIMITS.maxCredentialHosts),
  }),
  message: z
    .strictObject({
      from: MailAddress,
      fromName: z
        .string()
        .max(100)
        .regex(/^[^\r\n<>"]*$/)
        .optional(),
      to: z.array(MailAddress).max(FUNCTION_LIMITS.maxRecipients),
      cc: z.array(MailAddress).max(FUNCTION_LIMITS.maxRecipients),
      bcc: z.array(MailAddress).max(FUNCTION_LIMITS.maxRecipients),
      replyTo: MailAddress.optional(),
      subject: z.string().max(998),
      text: z
        .string()
        .max(256 * 1024)
        .optional(),
      html: z
        .string()
        .max(256 * 1024)
        .optional(),
      /** Deterministic per node run (`<key@remyral.workflow>`): a duplicate send after a lease loss is recognisable. */
      messageId: z.string().regex(/^<[A-Za-z0-9_.:@-]{3,200}>$/),
    })
    .refine((m) => m.to.length + m.cc.length + m.bcc.length >= 1, { message: 'no_recipients' })
    .refine((m) => m.to.length + m.cc.length + m.bcc.length <= FUNCTION_LIMITS.maxRecipients, {
      message: 'too_many_recipients',
    })
    .refine((m) => m.text !== undefined || m.html !== undefined, { message: 'body_required' }),
  timeoutSec: z.number().int().min(5).max(FUNCTION_LIMITS.maxSmtpTimeoutSec),
  egress: FunctionEgress,
});
export type FunctionEmailSpec = z.infer<typeof FunctionEmailSpec>;

export const FunctionCodeSpec = z.strictObject({
  type: z.literal('code'),
  language: z.enum(['js', 'python']),
  /** JS: the body of `(input, ctx) => output` (may be async); Python: the body of `def main(input, ctx)`. */
  source: z.string().min(1).max(FUNCTION_LIMITS.maxSourceBytes),
  /** JSON value given to the code on stdin. */
  input: z.unknown(),
  timeoutSec: z.number().int().min(1).max(FUNCTION_LIMITS.maxCodeTimeoutSec),
  memoryMb: z.number().int().min(FUNCTION_LIMITS.minCodeMemoryMb).max(FUNCTION_LIMITS.maxCodeMemoryMb),
});
export type FunctionCodeSpec = z.infer<typeof FunctionCodeSpec>;

/** A path on the probed port: one leading `/`, printable, no backslash / whitespace, ≤ 512 characters. */
const ProbePath = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[\x21-\x7e]*$/, 'a path starting with a single /, without spaces or backslashes')
  .refine((p) => !p.includes('\\'), 'no backslashes');

/**
 * p15-watches (watch-checks-v1): a check of a port on the worker's own loopback interface. The worker connects to
 * 127.0.0.1 (then ::1) and nothing else; the port must pass the preview port policy (1024–65535, no well-known
 * service port) and the worker refuses its own listening ports.
 */
export const FunctionProbeSpec = z.strictObject({
  type: z.literal('probe'),
  idempotencyKey: IdempotencyKey,
  probe: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('http'),
      port: PreviewPort,
      path: ProbePath,
      method: z.enum(['GET', 'HEAD']),
      timeoutSec: z.number().int().min(1).max(FUNCTION_LIMITS.maxProbeTimeoutSec),
      maxResponseBytes: z.number().int().min(1).max(FUNCTION_LIMITS.maxProbeResponseBytes),
    }),
    z.strictObject({
      kind: z.literal('tcp'),
      port: PreviewPort,
      timeoutSec: z.number().int().min(1).max(FUNCTION_LIMITS.maxProbeTimeoutSec),
    }),
  ]),
});
export type FunctionProbeSpec = z.infer<typeof FunctionProbeSpec>;

export const FunctionSpec = z.discriminatedUnion('type', [
  FunctionHttpSpec,
  FunctionEmailSpec,
  FunctionCodeSpec,
  FunctionProbeSpec,
]);
export type FunctionSpec = z.infer<typeof FunctionSpec>;

/** Which worker feature a function spec needs. */
export function functionFeatureOf(
  spec: Pick<FunctionSpec, 'type'>,
): typeof FUNCTION_FEATURE | typeof FUNCTION_CODE_FEATURE | typeof WATCH_CHECKS_FEATURE {
  return spec.type === 'code'
    ? FUNCTION_CODE_FEATURE
    : spec.type === 'probe'
      ? WATCH_CHECKS_FEATURE
      : FUNCTION_FEATURE;
}

/** Response headers that may be returned (everything else is dropped on the worker; never cookies or auth). */
export const FUNCTION_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'content-language',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'date',
  'location',
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'link',
  'idempotency-key',
];

export const FunctionHttpResult = z.strictObject({
  type: z.literal('http'),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string().max(64), z.string().max(4096)),
  /** `json`: parsed JSON; `text`: UTF-8 text; `base64`: binary (base64). Absent for HEAD / empty bodies. */
  body: z.unknown().optional(),
  bodyEncoding: z.enum(['json', 'text', 'base64', 'none']),
  /** The body was cut at the size limit (or did not parse as JSON and is returned as text). */
  truncated: z.boolean(),
  sizeBytes: z.number().int().min(0),
  /** The final URL after redirects (query parameters of a credential placed in the query are removed). */
  finalUrl: z.string().max(8192),
  redirects: z.number().int().min(0).max(FUNCTION_LIMITS.maxRedirects),
  /** Whether the credential was attached to the final request. */
  credentialAttached: z.boolean(),
  durationMs: z.number().int().min(0),
});
export type FunctionHttpResult = z.infer<typeof FunctionHttpResult>;

export const FunctionEmailResult = z.strictObject({
  type: z.literal('email'),
  messageId: z.string().max(220),
  accepted: z.array(z.string().max(320)).max(FUNCTION_LIMITS.maxRecipients),
  rejected: z.array(z.string().max(320)).max(FUNCTION_LIMITS.maxRecipients),
  durationMs: z.number().int().min(0),
});
export type FunctionEmailResult = z.infer<typeof FunctionEmailResult>;

export const FunctionCodeResult = z.strictObject({
  type: z.literal('code'),
  output: z.unknown(),
  /** Last ≤ 4 KiB of stderr (redacted), for debugging. */
  stderr: z.string().max(4096).optional(),
  durationMs: z.number().int().min(0),
});
export type FunctionCodeResult = z.infer<typeof FunctionCodeResult>;

/** p15-watches: what a loopback probe saw. Unreachable is a result (`reachable: false`), not a failure. */
export const FunctionProbeResult = z.strictObject({
  type: z.literal('probe'),
  kind: z.enum(['http', 'tcp']),
  reachable: z.boolean(),
  /** http: the response status (absent when unreachable). */
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string().max(64), z.string().max(4096)).optional(),
  /** http: parsed JSON when the body is JSON, else UTF-8 text (cut at `maxResponseBytes`). Absent for HEAD. */
  body: z.unknown().optional(),
  bodyEncoding: z.enum(['json', 'text', 'none']),
  truncated: z.boolean(),
  /** Why it was unreachable (`connection_refused`, `timeout`, `reset`, `protocol_error`). */
  error: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
  durationMs: z.number().int().min(0),
});
export type FunctionProbeResult = z.infer<typeof FunctionProbeResult>;

export const FunctionResult = z.discriminatedUnion('type', [
  FunctionHttpResult,
  FunctionEmailResult,
  FunctionCodeResult,
  FunctionProbeResult,
]);
export type FunctionResult = z.infer<typeof FunctionResult>;
