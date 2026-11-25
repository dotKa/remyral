import { createHash, type KeyObject, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import {
  Ed25519PublicKey,
  NonNegativeInt,
  RuntimeKind,
  runtimeKindList,
  Sha256Hex,
  Timestamp,
} from './common.js';
import { ReleaseVersion } from './release.js';
import { canonicalPolicyJson } from './runtime-policy.js';
import { SkillSignature, skillKeyId } from './skills.js';

/**
 * p14-mcp-core (ADR-0054 decision 7, docs/design/p14-mcp-skills.md §2): external MCP servers for jobs.
 *
 * A server version is an **immutable, signed spec** (JSON, the exact bytes are signed) — the MCP counterpart of a
 * skill manifest. It is signed by the panel skills key (or offline) with its **own context** `remana-mcp/v1\n`, so a
 * skill signature can never be replayed as an MCP spec and vice versa. Workers verify the signature with the skills
 * keys of their own configuration before anything reaches a runtime.
 *
 * P3 ships remote servers (`http` = streamable HTTP, `sse` = legacy SSE). `stdio` (pre-installed npm / PyPI packages)
 * is part of the schema so the format does not change in P4, but the master refuses to publish it and `mcp-v1`
 * workers decline it (`stdio_unsupported`) until `mcp-install-v1`.
 *
 * Shared by the master (publish, issue, probe), the worker (verify, config, egress) and the adapters (per-runtime
 * rendering) so the rules can never diverge.
 */

/** Worker feature: ASSIGN_JOB `mcp`, per-runtime MCP config, `mcp_call` events, the `mcp.probe` remote op. */
export const MCP_FEATURE = 'mcp-v1';
/** Domain separation from skills (`remana-skill/v1\n`), releases, leases and AUTH. */
export const MCP_SIGNATURE_CONTEXT = 'remana-mcp/v1\n';
export const MAX_MCP_SPEC_BYTES = 16 * 1024;
export const MAX_JOB_MCP_SERVERS = 8;
export const MAX_MCP_TOOL_RULES = 64;
export const MAX_MCP_SECRET_SLOTS = 16;
export const MAX_MCP_HEADERS = 16;
export const MAX_MCP_EGRESS_HOSTS = 16;
export const MAX_JOB_MCP_EGRESS_HOSTS = 32;
export const MAX_MCP_ASSIGNMENTS_PER_PROJECT = 16;
/** Tools a probe reports (more are cut and counted). */
export const MAX_MCP_PROBE_TOOLS = 256;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 1024;
export const MCP_STARTUP_TIMEOUT_DEFAULT_SEC = 30;
export const MCP_STARTUP_TIMEOUT_MAX_SEC = 120;
export const MCP_TOOL_TIMEOUT_DEFAULT_SEC = 120;
export const MCP_TOOL_TIMEOUT_MAX_SEC = 600;
/** Name prefix of every external server in a runtime config: never collides with a platform server. */
export const MCP_RUNTIME_NAME_PREFIX = 'x-';
/** Approval action of an `ask` tool call (p4-approvals catalog). */
export const MCP_APPROVAL_ACTION = 'tool.mcp';

/** Runtimes that can speak each transport (§2.4: SSE only through Claude Code and OpenCode's fallback). */
export const MCP_TRANSPORT_RUNTIMES: Readonly<Record<McpTransport, readonly RuntimeKind[]>> = {
  stdio: ['claude-code', 'codex', 'pi', 'opencode'],
  http: ['claude-code', 'codex', 'pi', 'opencode'],
  sse: ['claude-code', 'opencode'],
};

const RESERVED_ID = /^(remyral|remana|subtask)/;
const RESERVED_IDS: ReadonlySet<string> = new Set(['admin', 'preview', 'deploy']);

/** Catalog id: `^[a-z][a-z0-9-]{1,31}$`, not `remyral*` / `remana*` / `subtask*` / admin / preview / deploy (migrations 0102, 0149). */
export const McpServerId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase letters, digits and hyphens, starting with a letter (2–32)')
  .refine((id) => !RESERVED_ID.test(id) && !RESERVED_IDS.has(id), 'reserved for platform tools');
export type McpServerId = z.infer<typeof McpServerId>;

/** The name a server has in every runtime config: `x-<id>`. */
export function mcpRuntimeName(id: string): string {
  return `${MCP_RUNTIME_NAME_PREFIX}${id}`;
}

export const McpTransport = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransport>;

/** Secret slot name (`token`, `api_key`): what the spec references, bound to a vault credential per server. */
export const McpSecretSlot = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'slot: [a-z][a-z0-9_]{0,31}');

/**
 * Text around a secret in a header (`Bearer {}`): letters, digits, space and `._:/=+-` only — never `$`, `{`, `}`,
 * quotes or backslashes, so no runtime's own substitution (Pi `$VAR`, OpenCode `{env:…}`) can be triggered by it.
 */
const FORMAT_TEXT = /^[A-Za-z0-9 ._:/=+-]{0,64}$/;
export const McpSecretFormat = z
  .string()
  .max(140)
  .refine((f) => {
    const parts = f.split('{}');
    return parts.length === 2 && parts.every((p) => FORMAT_TEXT.test(p));
  }, 'exactly one "{}" with letters, digits, space and ._:/=+- around it');

/**
 * Literal (non-secret) header value: printable ASCII without `"`, `\`, `$`, `{`, `}`, backtick, not starting with `!`.
 */
export const McpLiteralValue = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) => /^[\x20-\x7e]+$/.test(v) && !/["\\${}`]/.test(v) && !v.startsWith('!') && v.trim() === v,
    'printable ASCII without quotes, backslashes, $ { } ` and not starting with !',
  );

export const McpSecretValueRef = z.strictObject({
  secret: McpSecretSlot,
  /** How the value is written: `{}` is replaced by the secret. Default `{}`. */
  format: McpSecretFormat.optional(),
});
export type McpSecretValueRef = z.infer<typeof McpSecretValueRef>;

export const McpValue = z.union([McpLiteralValue, McpSecretValueRef]);
export type McpValue = z.infer<typeof McpValue>;

/** Headers a server may set (hop-by-hop and request-framing headers are the client's own). */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);
export const McpHeaderName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'header name')
  .refine((n) => !FORBIDDEN_HEADERS.has(n.toLowerCase()), 'this header is set by the MCP client itself');

/** DNS host name: labels of [a-z0-9-], at least one dot (the worker egress rules, apps/worker/src/sandbox/network.ts). */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** `host` or `host:port` (lowercase DNS name, no IP literal, no localhost / .local / .internal). */
export function mcpEgressHostProblem(entry: string): string | null {
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(entry);
  if (m?.[1] === undefined) return 'host or host:port';
  const host = m[1];
  if (isIP(host) !== 0) return 'IP literals are not allowed; use a host name';
  if (!HOST.test(host)) return 'invalid host name (lowercase, at least one dot)';
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))
    return 'local / internal host names are not allowed';
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid port';
  }
  return null;
}
export const McpEgressHost = z
  .string()
  .max(260)
  .superRefine((v, ctx) => {
    const p = mcpEgressHostProblem(v);
    if (p !== null) ctx.addIssue({ code: 'custom', message: p });
  });

/** The egress entry (`host` or `host:port`, port 443 dropped) of an https URL, or null when it is not one. */
export function mcpUrlHost(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  return u.port === '' || u.port === '443' ? host : `${host}:${u.port}`;
}

/** Remote server URL: https, a DNS host name (no IP literal, no userinfo, no fragment), ≤ 2048 characters. */
export function mcpUrlProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'https:') return 'only https URLs';
  if (u.username !== '' || u.password !== '') return 'no credentials in the URL; use a secret header';
  if (u.hash !== '') return 'no fragment';
  const host = mcpUrlHost(value);
  if (host === null) return 'invalid host';
  return mcpEgressHostProblem(host);
}
export const McpUrl = z
  .string()
  .max(2048)
  .superRefine((v, ctx) => {
    const p = mcpUrlProblem(v);
    if (p !== null) ctx.addIssue({ code: 'custom', message: p });
  });

export const McpRemote = z.strictObject({
  url: McpUrl,
  headers: z
    .record(McpHeaderName, McpValue)
    .refine((h) => Object.keys(h).length <= MAX_MCP_HEADERS, `at most ${String(MAX_MCP_HEADERS)} headers`)
    .refine(
      (h) => new Set(Object.keys(h).map((k) => k.toLowerCase())).size === Object.keys(h).length,
      'duplicate header (case-insensitive)',
    )
    .optional(),
});
export type McpRemote = z.infer<typeof McpRemote>;

/**
 * P4 (`mcp-stdio-v1`, p14-mcp-stdio): a package installed on the machine before a job uses it (npm or PyPI, exact
 * version, the registry's integrity of the top-level package). `bin` is the package's executable (npm `bin` entry /
 * PyPI console script); `args` are fixed strings; `env` names values the server gets (literals or secret slots).
 */
/**
 * Env names a stdio spec may not set: the launcher sets PATH / HOME / temp / proxy itself, and loader variables would
 * change what code runs (NODE_OPTIONS, LD_PRELOAD, PYTHONPATH, …).
 */
const RESERVED_STDIO_ENV =
  /^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR|NODE_OPTIONS|NODE_PATH|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|(LD|DYLD)_[A-Z0-9_]*|REMYRAL_[A-Z0-9_]*|UV_[A-Z0-9_]*|NPM_CONFIG_[A-Z0-9_]*)$/;
const ShellSafeArg = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9 _@%+=:,./-]*$/, 'letters, digits, space and _@%+=:,./- only');
export const McpStdio = z.strictObject({
  package: z.strictObject({
    manager: z.enum(['npm', 'pypi']),
    name: z
      .string()
      .max(214)
      .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'package name'),
    version: z
      .string()
      .max(64)
      .regex(/^[0-9][0-9A-Za-z.+-]*$/, 'exact version'),
    integrity: z
      .string()
      .max(200)
      .regex(/^(sha512-[A-Za-z0-9+/]+=*|sha256:[a-f0-9]{64})$/, 'npm sha512 integrity or sha256:<hex>'),
  }),
  bin: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'bin name'),
  args: z.array(ShellSafeArg).max(32).optional(),
  env: z
    .record(
      z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'env name')
        .refine((n) => !RESERVED_STDIO_ENV.test(n), 'reserved env name (set by the platform)'),
      McpValue,
    )
    .refine((e) => Object.keys(e).length <= MAX_MCP_SECRET_SLOTS, 'too many env entries')
    .optional(),
});
export type McpStdio = z.infer<typeof McpStdio>;

export const McpSecretSlotDecl = z.strictObject({
  slot: McpSecretSlot,
  kind: z.literal('generic'),
  /** What the owner should put there ("GitHub fine-grained PAT, repo:read"). Shown on the card; never a value. */
  why: z.string().max(200),
});

export const McpLimits = z.strictObject({
  startupTimeoutSec: z.number().int().min(1).max(MCP_STARTUP_TIMEOUT_MAX_SEC),
  toolTimeoutSec: z.number().int().min(1).max(MCP_TOOL_TIMEOUT_MAX_SEC),
});

export const McpSource = z.strictObject({
  kind: z.enum(['url', 'npm', 'pypi', 'registry']),
  ref: z.string().min(1).max(512),
  registry: z.string().max(253).optional(),
});

/** Every `{secret: slot}` a spec references (headers, stdio env). */
export function mcpReferencedSlots(spec: {
  readonly http?: McpRemote | undefined;
  readonly sse?: McpRemote | undefined;
  readonly stdio?: McpStdio | undefined;
}): string[] {
  const values = [
    ...Object.values(spec.http?.headers ?? {}),
    ...Object.values(spec.sse?.headers ?? {}),
    ...Object.values(spec.stdio?.env ?? {}),
  ];
  return [...new Set(values.flatMap((v) => (typeof v === 'string' ? [] : [v.secret])))].sort();
}

export const McpSpec = z
  .strictObject({
    schema: z.literal(1),
    kind: z.literal('remana.mcp'),
    id: McpServerId,
    version: ReleaseVersion,
    transport: McpTransport,
    http: McpRemote.optional(),
    sse: McpRemote.optional(),
    stdio: McpStdio.optional(),
    secrets: z.array(McpSecretSlotDecl).max(MAX_MCP_SECRET_SLOTS),
    /** What the server talks to (stdio) — for remote servers the URL host is added automatically. */
    egressHosts: z.array(McpEgressHost).max(MAX_MCP_EGRESS_HOSTS),
    runtimes: runtimeKindList(RuntimeKind.options.length, 1),
    limits: McpLimits,
    source: McpSource.optional(),
    createdAt: Timestamp,
  })
  .superRefine((s, ctx) => {
    const blocks = { http: s.http, sse: s.sse, stdio: s.stdio };
    for (const [name, block] of Object.entries(blocks)) {
      if ((block !== undefined) !== (name === s.transport)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: name === s.transport ? `${name} block required` : `only the ${s.transport} block`,
        });
      }
    }
    if (new Set(s.runtimes).size !== s.runtimes.length) {
      ctx.addIssue({ code: 'custom', path: ['runtimes'], message: 'must not contain duplicates' });
    }
    const can = MCP_TRANSPORT_RUNTIMES[s.transport];
    for (const r of s.runtimes) {
      if (!can.includes(r)) {
        ctx.addIssue({
          code: 'custom',
          path: ['runtimes'],
          message: `${r} cannot use ${s.transport} servers`,
        });
      }
    }
    const declared = s.secrets.map((x) => x.slot);
    if (new Set(declared).size !== declared.length) {
      ctx.addIssue({ code: 'custom', path: ['secrets'], message: 'duplicate slot' });
    }
    const used = mcpReferencedSlots(s);
    for (const slot of used) {
      if (!declared.includes(slot)) {
        ctx.addIssue({ code: 'custom', path: ['secrets'], message: `slot ${slot} is used but not declared` });
      }
    }
    for (const slot of declared) {
      if (!used.includes(slot)) {
        ctx.addIssue({ code: 'custom', path: ['secrets'], message: `slot ${slot} is declared but not used` });
      }
    }
    if (new Set(s.egressHosts).size !== s.egressHosts.length) {
      ctx.addIssue({ code: 'custom', path: ['egressHosts'], message: 'duplicate host' });
    }
    if (s.stdio !== undefined) {
      const problem = mcpStdioProblem(s.stdio);
      if (problem !== null) ctx.addIssue({ code: 'custom', path: ['stdio', 'package'], message: problem });
    }
  });
export type McpSpec = z.infer<typeof McpSpec>;

/** The hosts a job using this server may reach: the URL host of a remote server plus the declared ones, sorted. */
export function mcpSpecEgressHosts(spec: McpSpec): string[] {
  const remote = spec.http ?? spec.sse;
  const urlHost = remote === undefined ? null : mcpUrlHost(remote.url);
  return [...new Set([...(urlHost === null ? [] : [urlHost]), ...spec.egressHosts])].sort();
}

/** The remote block of a spec (http or sse), or undefined for stdio. */
export function mcpRemoteOf(spec: McpSpec): McpRemote | undefined {
  return spec.http ?? spec.sse;
}

/** Signed delivery form: the exact spec bytes (base64) and the detached signature (same shape as skills). */
export const SignedMcpSpec = z.strictObject({
  spec: z.base64().max(Math.ceil(MAX_MCP_SPEC_BYTES / 3) * 4),
  signature: SkillSignature,
});
export type SignedMcpSpec = z.infer<typeof SignedMcpSpec>;

export function mcpSha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Bytes the key signs: context prefix + the spec exactly as distributed. */
export function mcpSigningPayload(specBytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(MCP_SIGNATURE_CONTEXT, 'utf8'), specBytes]);
}

export type McpRefusal =
  | 'no_trusted_keys'
  | 'spec_too_large'
  | 'invalid_signature_document'
  | 'unknown_key'
  | 'bad_signature'
  | 'invalid_spec';

export type McpVerification =
  | { readonly ok: true; readonly spec: McpSpec; readonly keyId: string; readonly specSha256: string }
  | { readonly ok: false; readonly reason: McpRefusal; readonly detail?: string };

/** Verifies the signature over the raw spec bytes with one of the trusted keys, then parses the spec. Never throws. */
export function verifyMcpSpec(signed: unknown, trustedKeys: readonly string[]): McpVerification {
  const keys = trustedKeys.filter((k) => Ed25519PublicKey.safeParse(k).success);
  if (keys.length === 0) return { ok: false, reason: 'no_trusted_keys' };
  if (typeof signed !== 'object' || signed === null) return { ok: false, reason: 'invalid_spec' };
  const s = signed as Record<string, unknown>;
  if (typeof s.spec !== 'string') return { ok: false, reason: 'invalid_spec', detail: 'spec missing' };
  const bytes = Buffer.from(s.spec, 'base64');
  if (bytes.byteLength > MAX_MCP_SPEC_BYTES) return { ok: false, reason: 'spec_too_large' };
  const sig = SkillSignature.safeParse(s.signature);
  if (!sig.success) return { ok: false, reason: 'invalid_signature_document' };
  const key = keys.find((k) => skillKeyId(k) === sig.data.keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key', detail: sig.data.keyId };
  if (!verifyEd25519(key, mcpSigningPayload(bytes), sig.data.signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_spec', detail: 'not JSON' };
  }
  const parsed = McpSpec.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_spec',
      detail: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, spec: parsed.data, keyId: sig.data.keyId, specSha256: mcpSha256(bytes) };
}

/** Input of {@link packMcpSpec}: everything but `schema` / `kind` (filled in). */
export type McpSpecInput = Omit<z.input<typeof McpSpec>, 'schema' | 'kind'>;

/** Builds and signs a spec (panel key after an admin's always-fresh confirmation, or offline). Throws when invalid. */
export function packMcpSpec(
  input: McpSpecInput,
  privateKey: KeyObject,
  publicKeyB64Url: string,
): { readonly signed: SignedMcpSpec; readonly spec: McpSpec; readonly specSha256: string } {
  const spec = McpSpec.parse({ schema: 1, kind: 'remana.mcp', ...input });
  const bytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_MCP_SPEC_BYTES) throw new RangeError('MCP spec above 16 KiB');
  const signature = sign(null, mcpSigningPayload(bytes), privateKey).toString('base64url');
  return {
    signed: { spec: bytes.toString('base64'), signature: { keyId: skillKeyId(publicKeyB64Url), signature } },
    spec,
    specSha256: mcpSha256(bytes),
  };
}

// ------------------------------------------------------------------------------------------------- tool policy

export const McpToolEffect = z.enum(['allow', 'ask', 'deny']);
export type McpToolEffect = z.infer<typeof McpToolEffect>;

/** Tool name glob: MCP tool-name characters plus `*` (any run) and `?` (one character). */
export const McpToolGlob = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.*?/-]+$/, 'tool name characters [A-Za-z0-9_./-] and the wildcards * ?');

export const McpToolRule = z.strictObject({ tool: McpToolGlob, effect: McpToolEffect });
export type McpToolRule = z.infer<typeof McpToolRule>;

export const McpToolRules = z.array(McpToolRule).max(MAX_MCP_TOOL_RULES);

function globRegex(glob: string): RegExp {
  const body = glob
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.\\/^$+()[\]{}|-]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/** True when `glob` matches the tool name exactly (case-sensitive, like MCP tool names). */
export function mcpGlobMatches(glob: string, tool: string): boolean {
  return globRegex(glob).test(tool);
}

/** The rule effect for `tool`: the first matching rule in order; a tool no rule names is **denied** (decision 3). */
export function mcpToolEffect(rules: readonly McpToolRule[], tool: string): McpToolEffect {
  for (const r of rules) if (mcpGlobMatches(r.tool, tool)) return r.effect;
  return 'deny';
}

/**
 * The decision for one call under the job's approval mode, which can only tighten the tool policy (§2.6):
 * `deny-sensitive` turns `ask` into `deny`; `ask-all` turns `allow` into `ask`; `ask-sensitive` and `allow-all` leave
 * the policy as it is (an `ask` tool still asks under `allow-all`).
 */
export function mcpCallDecision(
  rules: readonly McpToolRule[],
  tool: string,
  approvalPolicy: string,
): McpToolEffect {
  const effect = mcpToolEffect(rules, tool);
  if (effect === 'deny') return 'deny';
  if (approvalPolicy === 'deny-sensitive' && effect === 'ask') return 'deny';
  if (approvalPolicy === 'ask-all' && effect === 'allow') return 'ask';
  return effect;
}

/** sha256 hex over the canonical JSON of a server's rules (order matters: first match wins). */
export function mcpPolicySha256(rules: readonly McpToolRule[]): string {
  return mcpSha256(canonicalPolicyJson(rules.map((r) => ({ tool: r.tool, effect: r.effect }))));
}

const READ_ONLY_PREFIXES =
  /^(get|list|search|read|fetch|find|query|describe|show|view|lookup|count|check)[_.-]/i;

/** Verbs that change something: a name like this is never suggested, whatever the server's annotation says. */
const WRITE_VERBS =
  /(^|[_.-])(create|delete|remove|update|write|send|post|put|patch|exec|execute|run|push|merge|deploy|drop|insert|modify|set|move|rename|upload|publish|close|approve|kill|stop|start|install|edit|add|comment|reply|transfer|pay|grant|revoke)([_.-]|$)/i;

/**
 * The card's suggestion for "allow" (decision 3): the server says read-only, or the name reads like a read.
 * p14-mcp-chat (P5 red-team): the annotation is the server's own, untrusted text — a tool whose name contains a
 * write verb (`create_issue`, `repo_delete`) is never suggested even when it claims `readOnlyHint: true`. It is only a
 * suggestion either way: the owner allows tools on the policy table.
 */
export function mcpToolLooksReadOnly(name: string, readOnlyHint?: boolean | null): boolean {
  if (readOnlyHint === false || WRITE_VERBS.test(name)) return false;
  if (readOnlyHint === true) return true;
  return READ_ONLY_PREFIXES.test(name);
}

// ------------------------------------------------------------------------------------------------ job delivery

/** A server pinned for a job: id, version, spec hash and the hash of the tool rules snapshot. */
export const McpPin = z.strictObject({
  id: McpServerId,
  version: ReleaseVersion,
  specSha256: Sha256Hex,
  policySha256: Sha256Hex,
});
export type McpPin = z.infer<typeof McpPin>;

/**
 * Hash of a job's MCP set: sha256 over `remana.mcp/v1` + one `id@version:specSha256:policySha256` line per server,
 * sorted by id. Any version, spec or rule change changes it.
 */
export function mcpSetHash(pins: readonly McpPin[]): string {
  const lines = [...pins]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}@${p.version}:${p.specSha256}:${p.policySha256}\n`);
  return `sha256:${mcpSha256(`remana.mcp/v1\n${lines.join('')}`)}`;
}

/** `secret:<name>` / `worker:<id>/secret:<name>` (same rule as JobSpec.secretRefs; values never cross the wire). */
export const McpSecretRef = z
  .string()
  .max(256)
  .regex(/^(worker:[A-Za-z0-9_.:-]{1,128}\/)?secret:[A-Za-z0-9_-]{1,64}$/, 'secret reference');

/**
 * ASSIGN_JOB `mcp` (additive in 1.0, only to `mcp-v1` workers): the job's pinned, signed server specs, the tool rules
 * per server and where each secret slot comes from (a vault credential `secret:vault-<id>`). The worker verifies every
 * signature with its own skills keys and recomputes `setHash` from the verified specs and the rules.
 */
export const AssignedMcp = z
  .strictObject({
    setHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    servers: z.array(SignedMcpSpec).min(1).max(MAX_JOB_MCP_SERVERS),
    policies: z.array(z.strictObject({ server: McpServerId, rules: McpToolRules })).max(MAX_JOB_MCP_SERVERS),
    secrets: z
      .array(z.strictObject({ server: McpServerId, slot: McpSecretSlot, ref: McpSecretRef }))
      .max(MAX_JOB_MCP_SERVERS * MAX_MCP_SECRET_SLOTS),
  })
  .refine(
    (a) => new Set(a.policies.map((p) => p.server)).size === a.policies.length,
    'one policy per server',
  );
export type AssignedMcp = z.infer<typeof AssignedMcp>;

/** Env variable a secret slot is injected as (never on argv): `REMYRAL_MCP_<ID>_<SLOT>`. */
export function mcpSecretEnvName(serverId: string, slot: string): string {
  return `REMYRAL_MCP_${serverId.replace(/-/g, '_').toUpperCase()}_${slot.toUpperCase()}`;
}

/**
 * Why a secret value cannot be put into a runtime's MCP config, or null. Printable ASCII only (a header value), no
 * quotes, backslashes, `$`, braces or backticks (OpenCode substitutes `{env:…}` as raw text before parsing JSON; Pi
 * expands `$VAR`), not starting with `!` (Pi runs such a value as a shell command), ≤ 4 KiB.
 */
export function mcpSecretValueProblem(value: string): string | null {
  if (value.length === 0) return 'empty';
  if (value.length > 4096) return 'longer than 4096 characters';
  if (!/^[\x20-\x7e]+$/.test(value)) return 'only printable ASCII is allowed';
  if (value.trim() !== value) return 'leading or trailing space';
  if (/["\\${}`]/.test(value)) return 'contains a quote, backslash, $, brace or backtick';
  if (value.startsWith('!')) return 'starts with !';
  return null;
}

/** `{}` of a format replaced by the value (default format `{}`). */
export function mcpFormatValue(format: string | undefined, value: string): string {
  const [pre = '', post = ''] = (format ?? '{}').split('{}');
  return `${pre}${value}${post}`;
}

// ------------------------------------------------------------------------------------------- calls and probes

export const McpCallDecision = McpToolEffect;
export const McpCallOutcome = z.enum(['ok', 'error', 'timeout', 'denied']);
export type McpCallOutcome = z.infer<typeof McpCallOutcome>;

/** Tool name as an MCP server reports it (also what a call names). */
export const McpToolName = z.string().min(1).max(128);

/**
 * One MCP tool call (EVENT `mcp_call`, metadata only — never arguments or results): the master stores it in
 * `job_mcp_calls` and audits it as `mcp.tool.call`.
 */
export const McpCallEvent = z.object({
  kind: z.literal('mcp_call'),
  server: McpServerId,
  tool: McpToolName,
  decision: McpCallDecision,
  outcome: McpCallOutcome,
  durationMs: NonNegativeInt,
  argsBytes: NonNegativeInt,
  argsSha256: Sha256Hex,
  resultBytes: NonNegativeInt,
});
export type McpCallEvent = z.infer<typeof McpCallEvent>;

/** Splits a runtime tool name into `{server, tool}` when it names an external server, else null. */
export function parseMcpRuntimeToolName(
  runtime: RuntimeKind,
  name: string,
  serverIds: readonly string[],
): { readonly server: string; readonly tool: string } | null {
  for (const id of serverIds) {
    const prefixes =
      runtime === 'pi'
        ? [`mcp__${mcpRuntimeName(id).replace(/-/g, '_')}__`]
        : runtime === 'opencode'
          ? [`${mcpRuntimeName(id)}_`]
          : runtime === 'codex'
            ? [`mcp__${mcpRuntimeName(id)}__`, `${mcpRuntimeName(id)}/`]
            : [`mcp__${mcpRuntimeName(id)}__`];
    for (const p of prefixes) {
      if (name.startsWith(p) && name.length > p.length) return { server: id, tool: name.slice(p.length) };
    }
  }
  return null;
}

/** `mcp.probe` remote op: discover the tools of one server version on one worker (the master never connects). */
export const McpProbeOp = z.object({
  kind: z.literal('mcp.probe'),
  server: SignedMcpSpec,
  secrets: z.array(z.strictObject({ slot: McpSecretSlot, ref: McpSecretRef })).max(MAX_MCP_SECRET_SLOTS),
});

export const McpProbeTool = z.object({
  name: McpToolName,
  /** Untrusted server text, ≤ 1 KiB (cut). */
  description: z.string().max(MAX_MCP_TOOL_DESCRIPTION_BYTES),
  /** sha256 of the canonical JSON of the tool's input schema. */
  schemaSha256: Sha256Hex,
  readOnlyHint: z.boolean().optional(),
});
export type McpProbeTool = z.infer<typeof McpProbeTool>;

/** OPS_UPDATE `mcpProbe` of a finished probe. */
export const McpProbeReport = z.object({
  tools: z.array(McpProbeTool).max(MAX_MCP_PROBE_TOOLS),
  /** Tools beyond {@link MAX_MCP_PROBE_TOOLS} (not listed). */
  moreTools: NonNegativeInt.optional(),
  serverInfo: z.object({ name: z.string().max(128), version: z.string().max(64).optional() }).optional(),
  protocolVersion: z.string().max(32).optional(),
  transport: z.enum(['streamable-http', 'sse', 'stdio']),
  durationMs: NonNegativeInt,
});
export type McpProbeReport = z.infer<typeof McpProbeReport>;

// ------------------------------------------------------------------------------------- P4: local (stdio) packages

/**
 * p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §2.7, §14): local MCP servers from npm and PyPI. Worker
 * feature: the `mcp.install` / `mcp.remove` remote ops (lock on canary, install scripts never run, tree digest),
 * stdio probes and stdio servers in jobs (a launcher started by the runtime). The master sends stdio specs, installs
 * and stdio probes only to workers with it; a job pinning a stdio server is placed only on a machine that reported the
 * exact install (placement reason `mcp_not_installed`).
 */
export const MCP_STDIO_FEATURE = 'mcp-stdio-v1';
/** A lockfile as captured on the canary (npm `package-lock.json` v3 / uv `requirements.txt` with hashes). */
export const MAX_MCP_LOCK_BYTES = 2 * 1024 * 1024;
/** The gzip of a lockfile as it travels in OPS_UPDATE / OPS_COMMAND (keeps both far below MAX_FRAME_BYTES). */
export const MAX_MCP_LOCK_GZ_BYTES = 256 * 1024;
/** Installed tree (package + dependencies; PyPI: + the uv-managed CPython), per server version. */
export const MAX_MCP_INSTALL_BYTES = 300 * 1024 * 1024;
/** Installs a worker reports in CAPABILITIES. */
export const MAX_MCP_INSTALLS = 64;

/**
 * Hosts an install may reach (the worker's own network, never a job's): the npm registry; PyPI and its file host;
 * for PyPI packages also the CPython build the pinned uv downloads (python-build-standalone release assets).
 */
export const MCP_PACKAGE_HOSTS: Readonly<Record<'npm' | 'pypi', readonly string[]>> = {
  npm: ['registry.npmjs.org'],
  pypi: [
    'pypi.org',
    'files.pythonhosted.org',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ],
};

export const McpPackageManager = z.enum(['npm', 'pypi']);
export type McpPackageManager = z.infer<typeof McpPackageManager>;

/** A lockfile in transit: its manager, the sha256 and size of the raw bytes and the gzip'ed bytes (base64). */
export const McpLockfile = z.strictObject({
  manager: McpPackageManager,
  sha256: Sha256Hex,
  bytes: z.number().int().min(1).max(MAX_MCP_LOCK_BYTES),
  gz: z.base64().max(Math.ceil(MAX_MCP_LOCK_GZ_BYTES / 3) * 4),
});
export type McpLockfile = z.infer<typeof McpLockfile>;

/**
 * p19-install-scripts (ADR-0068): an npm package whose install script an admin approved, platform-wide, for exactly this
 * version and registry tarball (`dist.integrity`). An `mcp.install` carries the active approvals (only to workers with
 * `mcp-install-scripts-v1`); the worker accepts a lockfile entry with `hasInstallScript` only when name, version and
 * integrity match one, and runs only those packages' lifecycle scripts after the tree is unpacked.
 */
export const NPM_SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
export const MAX_INSTALL_SCRIPT_APPROVALS = 200;
export const NpmScriptApproval = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(214)
    .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  version: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,63}$/),
  integrity: z.string().regex(NPM_SHA512_INTEGRITY),
});
export type NpmScriptApproval = z.infer<typeof NpmScriptApproval>;

/** What an install ran of approved install scripts (`name@version` in npm order, the sandbox, the bounded output tail). */
export const McpInstallScriptsRun = z.object({
  ran: z.array(z.string().max(300)).max(50),
  sandbox: z.enum(['bwrap', 'none']),
  output: z.string().max(4000),
});
export type McpInstallScriptsRun = z.infer<typeof McpInstallScriptsRun>;

/** `sha256:<hex>` over the sorted (path, sha256) list of an installed tree. */
export const McpTreeDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'tree digest');

/**
 * `mcp.install` remote op (only to `mcp-stdio-v1` workers): install one signed stdio server version into
 * `<dataDir>/mcp/<id>/<version>/`. Without `lock` the worker resolves the dependency tree itself (the canary: npm
 * `--package-lock-only --ignore-scripts`, `uv pip compile --generate-hashes --no-build`) and reports the lock it made;
 * with `lock` it installs exactly that lock (every package checked against its hash before it is unpacked).
 */
export const McpInstallOp = z.object({
  kind: z.literal('mcp.install'),
  server: SignedMcpSpec,
  lock: McpLockfile.optional(),
  /** p19-install-scripts: the active install script approvals (npm only; `mcp-install-scripts-v1` workers). */
  installScripts: z.array(NpmScriptApproval).max(MAX_INSTALL_SCRIPT_APPROVALS).optional(),
});
export type McpInstallOp = z.infer<typeof McpInstallOp>;

/** `mcp.remove` remote op: delete one installed server version. */
export const McpRemoveOp = z.object({
  kind: z.literal('mcp.remove'),
  id: McpServerId,
  version: ReleaseVersion,
});
export type McpRemoveOp = z.infer<typeof McpRemoveOp>;

/** OPS_UPDATE `mcpInstall` of a finished install. */
export const McpInstallReport = z.object({
  id: McpServerId,
  version: ReleaseVersion,
  manager: McpPackageManager,
  digest: McpTreeDigest,
  /** sha256 of the lockfile the install used (the received one, or the one it made). */
  lockSha256: Sha256Hex,
  /** Present only when this install produced the lock (the canary): the master stores it for every other machine. */
  lock: McpLockfile.optional(),
  bytes: NonNegativeInt,
  files: NonNegativeInt,
  /** Windows: the protected DACL (job accounts read + execute only) was applied, or why not. */
  acl: z.enum(['applied', 'skipped', 'not_windows']).optional(),
  /** p19-install-scripts: the approved install scripts this install ran (absent: none). */
  scripts: McpInstallScriptsRun.optional(),
});
export type McpInstallReport = z.infer<typeof McpInstallReport>;

/** CAPABILITIES `mcpInstalls`: what is installed and intact on this worker (digests re-checked by the worker). */
export const McpInstallEntry = z.object({
  id: McpServerId,
  version: ReleaseVersion,
  digest: McpTreeDigest,
  lockSha256: Sha256Hex,
});
export type McpInstallEntry = z.infer<typeof McpInstallEntry>;
export const McpInstallsReport = z.array(McpInstallEntry).max(MAX_MCP_INSTALLS);
export type McpInstallsReport = z.infer<typeof McpInstallsReport>;

/** npm package names (scoped or not) as the registry accepts them for new packages. */
export const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** PyPI project names (PEP 508 characters). */
export const PYPI_PACKAGE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/** PyPI normalised name (PEP 503): lowercase, runs of `-_.` → `-`. */
export function pypiNormalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Why a stdio block cannot be installed (beyond the schema), or null: name rules and integrity format per manager. */
export function mcpStdioProblem(stdio: McpStdio): string | null {
  const p = stdio.package;
  if (p.manager === 'npm') {
    if (!NPM_PACKAGE_NAME.test(p.name)) return 'npm package names are lowercase (optionally @scope/name)';
    if (!p.integrity.startsWith('sha512-'))
      return 'npm packages need the registry sha512 integrity (dist.integrity)';
  } else {
    if (!PYPI_PACKAGE_NAME.test(p.name)) return 'invalid PyPI project name';
    if (!p.integrity.startsWith('sha256:'))
      return 'PyPI packages need the sha256 of one of the release files (sha256:<hex>)';
  }
  return null;
}

/** The (id, version) key of an install. */
export function mcpInstallKey(id: string, version: string): string {
  return `${id}@${version}`;
}
