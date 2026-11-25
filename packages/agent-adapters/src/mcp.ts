import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentEvent,
  type McpCallEvent,
  type McpToolEffect,
  type McpToolRule,
  type RuntimeKind,
  mcpCallDecision,
  mcpFormatValue,
  mcpGlobMatches,
  mcpRuntimeName,
  mcpSecretValueProblem,
  McpServerId,
} from '@remyral/protocol';
import type { ApprovalPolicy, SpawnContext } from './contract.js';
import { InvalidSpawnContextError } from './errors.js';
import { SecretValue, redactSecrets, type SecretEnv } from './secrets.js';

/**
 * p14-mcp-core (ADR-0054, docs/design/p14-mcp-skills.md §2.4): what the worker hands an adapter for a job's external
 * MCP servers — already verified (signature, set hash, local vetoes) and resolved (secret values from the vault).
 * Adapters render it into their runtime's own configuration inside `configDir` (attempt-private, never the repository)
 * and enforce the tool rules; secret values never go on argv.
 */

/** A header value: literal text, or a secret (env var holding the value) written through `format` (`Bearer {}`). */
export type McpHeaderValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'secret'; readonly env: string; readonly format?: string };

/** Fields every external server has, whatever its transport. */
interface McpServerDeliveryBase {
  /** Catalog id (`github`). */
  readonly id: string;
  /** Runtime config name, always `x-<id>` (never collides with a platform server). */
  readonly name: string;
  /** First match wins; a tool no rule names is denied (`mcpCallDecision` adds the job's approval mode). */
  readonly rules: readonly McpToolRule[];
  readonly startupTimeoutSec: number;
  readonly toolTimeoutSec: number;
}

/** A remote server (`http` = streamable HTTP, `sse` = legacy SSE). */
export interface McpRemoteServerDelivery extends McpServerDeliveryBase {
  readonly transport: 'http' | 'sse';
  readonly url: string;
  readonly headers: Readonly<Record<string, McpHeaderValue>>;
}

/**
 * p14-mcp-stdio: a local server installed on the worker. The runtime starts `command args…` — always the worker's
 * launcher (`node remyral-mcp-launch.mjs <attempt>/mcp/x-<id>.launch.json`): the package's executable, its fixed args
 * and its env (secrets included) are in that 0600 file, never in the runtime config or on argv.
 */
export interface McpStdioServerDelivery extends McpServerDeliveryBase {
  readonly transport: 'stdio';
  /** Absolute path of the Node that runs the launcher (`node` inside a container image). */
  readonly command: string;
  /** `[<launcher>, <launch spec file>]` (absolute paths inside the attempt's MCP config dir). */
  readonly args: readonly string[];
  /** Variables a runtime that filters its children's env must forward to the launcher (proxy, CA bundle). */
  readonly forwardEnv: readonly string[];
}

export type McpServerDelivery = McpRemoteServerDelivery | McpStdioServerDelivery;

export interface McpJobDelivery {
  readonly servers: readonly McpServerDelivery[];
  /** Attempt-private directory (0700, created by the worker, removed with the attempt) for generated config files. */
  readonly configDir: string;
  /** Secret values by env name (`REMYRAL_MCP_<ID>_<SLOT>`): never on argv, always redacted from output. */
  readonly secretEnv: SecretEnv;
}

/** Whether an adapter can deliver `ctx.mcp` for this context (ADR-0008 truthful capabilities). */
export type McpDeliverySupport =
  { readonly supported: true } | { readonly supported: false; readonly reason: string };

// ------------------------------------------------------------------------------------------------ validation

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The job's servers, or none. */
export function mcpServersOf(ctx: Pick<SpawnContext, 'mcp'>): readonly McpServerDelivery[] {
  return ctx.mcp?.servers ?? [];
}

/** Support for a delivery whose transports must be in `transports`. */
export function mcpTransportSupport(
  runtime: RuntimeKind,
  mcp: McpJobDelivery,
  transports: readonly ('http' | 'sse' | 'stdio')[],
): McpDeliverySupport {
  const bad = mcp.servers.find((s) => !transports.includes(s.transport));
  if (bad !== undefined) {
    return { supported: false, reason: `${runtime} cannot use ${bad.transport} MCP servers (${bad.name})` };
  }
  return { supported: true };
}

/**
 * Structural checks every adapter runs before rendering anything (the worker verified the signed specs; this is
 * defence in depth against a worker bug): `x-<id>` names, https URLs, header names, env names that resolve to a
 * secret, and secret values no runtime substitution can turn into something else (mcpSecretValueProblem). Throws
 * {@link InvalidSpawnContextError}.
 */
export function assertMcpDelivery(mcp: McpJobDelivery): void {
  const names = new Set<string>();
  for (const s of mcp.servers) {
    if (!McpServerId.safeParse(s.id).success)
      throw new InvalidSpawnContextError(`invalid MCP server id ${s.id}`);
    if (s.name !== mcpRuntimeName(s.id)) {
      throw new InvalidSpawnContextError(`MCP server ${s.id} must be named ${mcpRuntimeName(s.id)}`);
    }
    if (names.has(s.name)) throw new InvalidSpawnContextError(`duplicate MCP server ${s.name}`);
    names.add(s.name);
    assertTimeouts(s);
    if (s.transport === 'stdio') {
      assertStdio(s);
      continue;
    }
    let url: URL;
    try {
      url = new URL(s.url);
    } catch {
      throw new InvalidSpawnContextError(`MCP server ${s.name}: invalid URL`);
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new InvalidSpawnContextError(`MCP server ${s.name}: only https URLs without credentials`);
    }
    if (/["\\${}`\s]/.test(s.url))
      throw new InvalidSpawnContextError(`MCP server ${s.name}: unsafe URL characters`);
    for (const [name, value] of Object.entries(s.headers)) {
      if (!HEADER_NAME.test(name))
        throw new InvalidSpawnContextError(`MCP server ${s.name}: invalid header name`);
      if (value.kind === 'literal') {
        if (mcpSecretValueProblem(value.value) !== null) {
          throw new InvalidSpawnContextError(`MCP server ${s.name}: unsafe literal value for header ${name}`);
        }
        continue;
      }
      if (!ENV_NAME.test(value.env))
        throw new InvalidSpawnContextError(`MCP server ${s.name}: invalid env name`);
      const secret = mcp.secretEnv[value.env];
      if (secret === undefined) {
        throw new InvalidSpawnContextError(
          `MCP server ${s.name}: secret ${value.env} for header ${name} is missing`,
        );
      }
      const problem =
        mcpSecretValueProblem(secret.reveal()) ??
        mcpSecretValueProblem(mcpFormatValue(value.format, secret.reveal()));
      if (problem !== null) {
        // Never the value itself: only why it was refused.
        throw new InvalidSpawnContextError(
          `MCP server ${s.name}: the secret for header ${name} is refused (${problem})`,
        );
      }
    }
  }
}

function assertTimeouts(s: McpServerDelivery): void {
  if (!Number.isInteger(s.startupTimeoutSec) || s.startupTimeoutSec < 1 || s.startupTimeoutSec > 120) {
    throw new InvalidSpawnContextError(`MCP server ${s.name}: startup timeout out of range`);
  }
  if (!Number.isInteger(s.toolTimeoutSec) || s.toolTimeoutSec < 1 || s.toolTimeoutSec > 600) {
    throw new InvalidSpawnContextError(`MCP server ${s.name}: tool timeout out of range`);
  }
}

/**
 * A stdio command line reaches runtime configs that substitute text (OpenCode `{env:…}` / `{file:…}`, Pi `${VAR}` /
 * `!cmd`): command and args are absolute paths (or `node`) without braces, `$`, quotes, backticks or control
 * characters; no secret is ever part of them (the launch spec file holds the env).
 */
function assertStdio(s: McpStdioServerDelivery): void {
  const unsafe = (v: string): boolean =>
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    v.length === 0 || v.length > 1024 || /[\u0000-\u001f\u007f"`${}]/.test(v) || v.startsWith('!');
  const absolute = (v: string): boolean => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v);
  if (unsafe(s.command) || !(s.command === 'node' || absolute(s.command))) {
    throw new InvalidSpawnContextError(`MCP server ${s.name}: invalid stdio command`);
  }
  if (s.args.length !== 2 || s.args.some((a) => unsafe(a) || !absolute(a))) {
    throw new InvalidSpawnContextError(
      `MCP server ${s.name}: stdio args must be the launcher and its spec file`,
    );
  }
  for (const e of s.forwardEnv) {
    if (!ENV_NAME.test(e)) throw new InvalidSpawnContextError(`MCP server ${s.name}: invalid env name`);
  }
}

// ----------------------------------------------------------------------------------------- resolved headers / env

/** Env var holding the final value of one secret header of one server (`REMYRAL_MCP_H_<ID>_<n>`). */
export function mcpHeaderEnvName(serverId: string, index: number): string {
  return `REMYRAL_MCP_H_${serverId.replace(/-/g, '_').toUpperCase()}_${String(index)}`;
}

export type RenderedMcpHeader =
  | { readonly kind: 'literal'; readonly value: string }
  /** The env var `env` holds the complete header value (format applied). */
  | { readonly kind: 'env'; readonly env: string };

/** Per server: headers in order, secret ones moved to a derived env var with the formatted value. */
export function mcpRenderedHeaders(server: McpRemoteServerDelivery): Record<string, RenderedMcpHeader> {
  const out: Record<string, RenderedMcpHeader> = {};
  let i = 0;
  for (const [name, value] of Object.entries(server.headers)) {
    out[name] =
      value.kind === 'literal'
        ? { kind: 'literal', value: value.value }
        : { kind: 'env', env: mcpHeaderEnvName(server.id, i) };
    i += 1;
  }
  return out;
}

/** The env a runtime process needs for the job's MCP headers: the raw slot values plus the derived header values. */
export function mcpProcessEnv(mcp: McpJobDelivery | undefined): Record<string, SecretValue> {
  if (mcp === undefined) return {};
  const env: Record<string, SecretValue> = { ...mcp.secretEnv };
  for (const s of mcp.servers) {
    if (s.transport === 'stdio') continue;
    let i = 0;
    for (const value of Object.values(s.headers)) {
      if (value.kind === 'secret') {
        const raw = mcp.secretEnv[value.env];
        if (raw === undefined) throw new InvalidSpawnContextError(`MCP secret ${value.env} is missing`);
        env[mcpHeaderEnvName(s.id, i)] = new SecretValue(mcpFormatValue(value.format, raw.reveal()));
      }
      i += 1;
    }
  }
  return env;
}

/** Header values resolved to plain text (only for a 0600 job-private config file, never argv or logs). */
export function mcpResolvedHeaders(
  server: McpRemoteServerDelivery,
  mcp: McpJobDelivery,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers)) {
    if (value.kind === 'literal') {
      out[name] = value.value;
      continue;
    }
    const raw = mcp.secretEnv[value.env];
    if (raw === undefined) throw new InvalidSpawnContextError(`MCP secret ${value.env} is missing`);
    out[name] = mcpFormatValue(value.format, raw.reveal());
  }
  return out;
}

/**
 * The spawn context with the MCP env merged into `secretEnv` (so every existing redaction path covers the MCP
 * values, and runtimes that inject `secretEnv` get them). Validates the delivery first.
 */
export function withMcpSecrets<T extends SpawnContext>(ctx: T): T {
  if (ctx.mcp === undefined || ctx.mcp.servers.length === 0) return ctx;
  assertMcpDelivery(ctx.mcp);
  const extra = mcpProcessEnv(ctx.mcp);
  for (const name of Object.keys(extra)) {
    if (name in ctx.secretEnv && !(name in ctx.mcp.secretEnv) && !name.startsWith('REMYRAL_MCP_H_')) {
      throw new InvalidSpawnContextError(`MCP env ${name} collides with a job secret`);
    }
  }
  return { ...ctx, secretEnv: { ...ctx.secretEnv, ...extra } };
}

/** Writes `content` as a 0600 file inside the attempt's MCP config dir (created 0700 if needed). */
export async function writeMcpPrivateFile(
  mcp: McpJobDelivery,
  name: string,
  content: string,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name.startsWith('.')) {
    throw new InvalidSpawnContextError('invalid MCP config file name');
  }
  await mkdir(mcp.configDir, { recursive: true, mode: 0o700 });
  await chmod(mcp.configDir, 0o700).catch(() => undefined);
  const path = join(mcp.configDir, name);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

// ----------------------------------------------------------------------------------------------- gate + calls

/** How a runtime spells tool names (`.`/`/` etc. become `_`): rules are matched against both spellings. */
export type McpNameSanitizer = (name: string) => string;

/** Claude Code / OpenCode keep `[A-Za-z0-9_-]`; Pi keeps `[A-Za-z0-9_]`. Wildcards survive. */
export const SANITIZE_KEEP_DASH: McpNameSanitizer = (n) => n.replace(/[^A-Za-z0-9_*?-]/g, '_');
export const SANITIZE_NO_DASH: McpNameSanitizer = (n) => n.replace(/[^A-Za-z0-9_*?]/g, '_');

/** The runtime-name prefix of a server's tools (as the runtime itself spells them). */
export function mcpToolPrefix(runtime: RuntimeKind, serverId: string): string {
  const name = mcpRuntimeName(serverId);
  switch (runtime) {
    case 'pi':
      return `mcp__${name.replace(/-/g, '_')}__`;
    case 'opencode':
      return `${name}_`;
    default:
      return `mcp__${name}__`;
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function jsonText(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    // JSON.stringify returns undefined for functions / symbols.
    const text: unknown = JSON.stringify(value ?? {});
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Size and sha256 of a call's arguments as JSON text (what `mcp_call` reports instead of the arguments). */
export function mcpArgsDigest(args: unknown): { readonly bytes: number; readonly sha256: string } {
  if (
    typeof args === 'object' &&
    args !== null &&
    Object.keys(args).length === 2 &&
    typeof (args as { bytes?: unknown }).bytes === 'number' &&
    typeof (args as { sha256?: unknown }).sha256 === 'string'
  ) {
    return args as { bytes: number; sha256: string };
  }
  const text = jsonText(args);
  return { bytes: Buffer.byteLength(text), sha256: sha256Hex(text) };
}

function isBytes(v: unknown): v is { bytes: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Object.keys(v).length === 1 &&
    typeof (v as { bytes?: unknown }).bytes === 'number'
  );
}

interface PendingCall {
  readonly server: string;
  readonly tool: string;
  readonly decision: McpToolEffect;
  readonly argsBytes: number;
  readonly argsSha256: string;
  readonly started: number;
}

/**
 * Per-session MCP gate: names → server/tool, the decision of one call (rules + the job's live approval mode), and the
 * metadata-only `mcp_call` events (never arguments or results).
 */
export class McpGate {
  private readonly servers: readonly McpServerDelivery[];
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly runtime: RuntimeKind,
    mcp: McpJobDelivery | undefined,
    private readonly sanitize: McpNameSanitizer = SANITIZE_KEEP_DASH,
    private readonly now: () => number = Date.now,
  ) {
    this.servers = mcp?.servers ?? [];
  }

  get active(): boolean {
    return this.servers.length > 0;
  }

  get serverIds(): string[] {
    return this.servers.map((s) => s.id);
  }

  /** `{server, tool}` of a runtime tool name of an external server, else null. */
  identify(runtimeToolName: string): { readonly server: string; readonly tool: string } | null {
    for (const s of this.servers) {
      const prefix = mcpToolPrefix(this.runtime, s.id);
      if (runtimeToolName.startsWith(prefix) && runtimeToolName.length > prefix.length) {
        return { server: s.id, tool: runtimeToolName.slice(prefix.length) };
      }
      // Codex names calls `x-<id>/<tool>` in some places.
      if (this.runtime === 'codex' && runtimeToolName.startsWith(`${s.name}/`)) {
        return { server: s.id, tool: runtimeToolName.slice(s.name.length + 1) };
      }
    }
    return null;
  }

  /** True when `name` looks like a tool of an external server prefix (also of a server not in this job). */
  isExternalName(runtimeToolName: string): boolean {
    if (this.identify(runtimeToolName) !== null) return true;
    const p = this.runtime === 'pi' ? 'mcp__x_' : this.runtime === 'opencode' ? 'x-' : 'mcp__x-';
    return runtimeToolName.startsWith(p);
  }

  /** The decision for one call; an unknown server is denied. */
  decide(server: string, tool: string, policy: ApprovalPolicy): McpToolEffect {
    const s = this.servers.find((x) => x.id === server);
    if (s === undefined) return 'deny';
    // A rule matches the server's own spelling or the runtime's sanitised spelling of the tool name.
    const rules = s.rules.map((r) =>
      mcpGlobMatches(r.tool, tool) ||
      this.sanitize(r.tool) === tool ||
      mcpGlobMatches(this.sanitize(r.tool), tool)
        ? { tool: '*', effect: r.effect }
        : r,
    );
    return mcpCallDecision(rules, tool, policy);
  }

  /** Remember a call that will run (allowed or approved). */
  begin(key: string, server: string, tool: string, decision: McpToolEffect, args: unknown): void {
    const text = jsonText(args);
    this.pending.set(key, {
      server,
      tool,
      decision,
      argsBytes: Buffer.byteLength(text),
      argsSha256: sha256Hex(text),
      started: this.now(),
    });
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** The `mcp_call` event of a finished call, or null when the call was never begun here. */
  end(
    key: string,
    outcome: 'ok' | 'error' | 'timeout',
    /** The result (only its size is kept), or `{bytes}` when only the size is known. */
    result: unknown,
    durationMs?: number,
    /** The call's arguments as the runtime finally reports them (replaces what was known at the decision). */
    args?: unknown,
  ): McpCallEvent | null {
    const p = this.pending.get(key);
    if (p === undefined) return null;
    this.pending.delete(key);
    const digest = args === undefined ? undefined : mcpArgsDigest(args);
    return {
      kind: 'mcp_call',
      server: p.server,
      tool: p.tool.slice(0, 128),
      decision: p.decision,
      outcome,
      durationMs: Math.max(0, Math.round(durationMs ?? this.now() - p.started)),
      argsBytes: digest?.bytes ?? p.argsBytes,
      argsSha256: digest?.sha256 ?? p.argsSha256,
      resultBytes: isBytes(result) ? result.bytes : Buffer.byteLength(jsonText(result)),
    };
  }

  /** The `mcp_call` event of a call that never ran (deny, or an `ask` the reviewer or the timeout refused). */
  denied(server: string, tool: string, decision: McpToolEffect, args: unknown): McpCallEvent {
    const text = jsonText(args);
    return {
      kind: 'mcp_call',
      server,
      tool: tool.slice(0, 128),
      decision,
      outcome: 'denied',
      durationMs: 0,
      argsBytes: Buffer.byteLength(text),
      argsSha256: sha256Hex(text),
      resultBytes: 0,
    };
  }

  /** Every call still open (session ending): `error` events. */
  drain(): McpCallEvent[] {
    return [...this.pending.keys()].flatMap((k) => {
      const e = this.end(k, 'error', '');
      return e === null ? [] : [e];
    });
  }
}

/** The approval request of an `ask` call (p4-approvals action `tool.mcp`, risk high, args preview redacted + capped). */
export function mcpApprovalEvent(
  approvalId: string,
  serverId: string,
  tool: string,
  args: unknown,
  secrets: SecretEnv,
): Extract<AgentEvent, { kind: 'approval_request' }> {
  const label = `${mcpRuntimeName(serverId)}/${tool}`.slice(0, 128);
  const preview = redactSecrets(jsonText(args), secrets).replace(/\s+/g, ' ').slice(0, 900);
  return {
    kind: 'approval_request',
    approvalId,
    action: 'tool.mcp',
    description: `${label}: ${preview}`.slice(0, 1000),
    risk: 'high',
    details: { tool: label, ...(preview === '' ? {} : { description: preview }) },
  };
}

// ------------------------------------------------------------------------------------------- per-runtime config

/**
 * Claude Code: the `--mcp-config` file (0600). Values are literal in the file — the SDK would put `mcpServers` on argv
 * (§11.1); whether `${VAR}` expands inside `--mcp-config` is UNVERIFIED, so it is not relied on.
 */
export function claudeMcpConfig(mcp: McpJobDelivery): { mcpServers: Record<string, unknown> } {
  const servers: Record<string, unknown> = {};
  for (const s of mcp.servers) {
    if (s.transport === 'stdio') {
      // p14-mcp-stdio: the launcher reads the server's env from its own 0600 spec file.
      servers[s.name] = { type: 'stdio', command: s.command, args: [...s.args] };
      continue;
    }
    const headers = mcpResolvedHeaders(s, mcp);
    servers[s.name] = {
      type: s.transport,
      url: s.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  }
  return { mcpServers: servers };
}

/** TOML basic string (same rules as the Codex adapter's). */
function toml(value: string): string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new InvalidSpawnContextError('control characters in a Codex override');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Literal tool names of rules without wildcards. */
function literalRules(rules: readonly McpToolRule[]): {
  readonly literal: boolean;
  readonly names: string[];
} {
  const literal = rules.every((r) => !/[*?]/.test(r.tool));
  return { literal, names: rules.map((r) => r.tool) };
}

/**
 * The key of a server in a Codex `-c` override path. **Bare, never quoted**: the pinned 0.162.1 splits the `-c` key
 * path on dots without TOML key unquoting, so `mcp_servers."x-docs"` named the server `"x-docs"` *with* the quotes
 * (verified with `codex -c … mcp list --json` on the pinned darwin-arm64 binary, 2026-10-21; p14-mcp-stdio). `x-<id>`
 * is `[a-z0-9-]` only, a valid bare key.
 */
export function codexServerKey(name: string): string {
  if (!/^x-[a-z][a-z0-9-]{1,31}$/.test(name))
    throw new InvalidSpawnContextError(`invalid MCP server name ${name}`);
  return name;
}

/**
 * Codex 0.162.1: one `-c mcp_servers.<name>={…}` override per server (fields of the pinned binary's
 * `RawMcpServerConfig`, docs/design §11.2): `url`, `http_headers` (literals only), `env_http_headers` (header → env
 * var holding the formatted value — values stay in the environment), `startup_timeout_sec`, `tool_timeout_sec`,
 * `default_tools_approval_mode = "prompt"` (every call comes to the adapter as `mcpServer/elicitation/request`, which
 * applies allow / ask / deny with the live mode), `enabled_tools` when every allow/ask rule is a literal name, and
 * `disabled_tools` for literal deny rules. No secret value is ever in these strings.
 */
export function codexMcpArgs(mcp: McpJobDelivery): string[] {
  const args: string[] = [];
  for (const s of mcp.servers) {
    if (s.transport === 'stdio') {
      args.push(
        '-c',
        `mcp_servers.${codexServerKey(s.name)}={ ${[...codexStdioFields(s), ...codexToolFields(s)].join(', ')} }`,
      );
      continue;
    }
    if (s.transport !== 'http')
      throw new InvalidSpawnContextError(`codex cannot use ${s.transport} MCP servers`);
    const rendered = mcpRenderedHeaders(s);
    const literal = Object.entries(rendered).filter(([, v]) => v.kind === 'literal');
    const env = Object.entries(rendered).filter(([, v]) => v.kind === 'env');
    const fields = [
      `url = ${toml(s.url)}`,
      `enabled = true`,
      `startup_timeout_sec = ${String(s.startupTimeoutSec)}`,
      `tool_timeout_sec = ${String(s.toolTimeoutSec)}`,
      `default_tools_approval_mode = "prompt"`,
    ];
    if (literal.length > 0) {
      fields.push(
        `http_headers = { ${literal.map(([k, v]) => `${toml(k)} = ${toml((v as { value: string }).value)}`).join(', ')} }`,
      );
    }
    if (env.length > 0) {
      fields.push(
        `env_http_headers = { ${env.map(([k, v]) => `${toml(k)} = ${toml((v as { env: string }).env)}`).join(', ')} }`,
      );
    }
    fields.push(...codexToolFields(s));
    args.push('-c', `mcp_servers.${codexServerKey(s.name)}={ ${fields.join(', ')} }`);
  }
  return args;
}

/** `enabled_tools` (every allow / ask rule a literal name) and `disabled_tools` (literal deny rules). */
function codexToolFields(s: McpServerDelivery): string[] {
  const fields: string[] = [];
  const allowAsk = s.rules.filter((r) => r.effect !== 'deny');
  const deny = s.rules.filter((r) => r.effect === 'deny' && !/[*?]/.test(r.tool)).map((r) => r.tool);
  const al = literalRules(allowAsk);
  if (al.literal) fields.push(`enabled_tools = [${al.names.map(toml).join(', ')}]`);
  if (deny.length > 0) fields.push(`disabled_tools = [${deny.map(toml).join(', ')}]`);
  return fields;
}

/**
 * p14-mcp-stdio, Codex 0.162.1 stdio fields: `command`, `args` (the launcher and its spec file — no secret), `env_vars`
 * (Codex starts stdio servers with a fixed default env; the proxy / CA variables of the attempt are forwarded by name),
 * timeouts and `default_tools_approval_mode = "prompt"` as for remote servers. `env_vars` as a list of names is
 * UNVERIFIED against the pinned binary (P6).
 */
function codexStdioFields(s: McpStdioServerDelivery): string[] {
  return [
    `command = ${toml(s.command)}`,
    `args = [${s.args.map(toml).join(', ')}]`,
    ...(s.forwardEnv.length === 0 ? [] : [`env_vars = [${s.forwardEnv.map(toml).join(', ')}]`]),
    `enabled = true`,
    `startup_timeout_sec = ${String(s.startupTimeoutSec)}`,
    `tool_timeout_sec = ${String(s.toolTimeoutSec)}`,
    `default_tools_approval_mode = "prompt"`,
  ];
}

/**
 * OpenCode 1.19.0: `mcp` entries for `OPENCODE_CONFIG_CONTENT` — `type: "remote"`, `oauth: false` (else OpenCode starts
 * its own OAuth flow), `timeout` in ms. Secret headers are `{env:NAME}` references (OpenCode replaces them as raw
 * text before parsing the JSON, so the values were checked by {@link assertMcpDelivery}: no quote, backslash, brace,
 * `$`). The URL host is the server's; streamable HTTP is tried first, then SSE (§11.3).
 */
export function opencodeMcpEntries(mcp: McpJobDelivery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of mcp.servers) {
    if (s.transport === 'stdio') {
      // p14-mcp-stdio: OpenCode starts `command[0] command[1…]` itself (no shell); the env is in the launch spec file.
      out[s.name] = {
        type: 'local',
        command: [s.command, ...s.args],
        enabled: true,
        timeout: s.toolTimeoutSec * 1000,
      };
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mcpRenderedHeaders(s))) {
      headers[k] = v.kind === 'literal' ? v.value : `{env:${v.env}}`;
    }
    out[s.name] = {
      type: 'remote',
      url: s.url,
      enabled: true,
      oauth: false,
      timeout: s.toolTimeoutSec * 1000,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  }
  return out;
}

/**
 * OpenCode session ruleset entries for the external tools (`<name>_*`): every call asks (`ask`), so OpenCode routes it
 * to the adapter, which decides with the rules and the live mode. Appended last (OpenCode: last match wins).
 */
export function opencodeMcpRuleset(
  mcp: McpJobDelivery | undefined,
): { permission: string; pattern: string; action: 'ask' }[] {
  return (mcp?.servers ?? []).map((s) => ({
    permission: `${s.name}_*`,
    pattern: '*',
    action: 'ask' as const,
  }));
}

/** Pi extension file that registers the job's servers (`pi.registerMcpServer`, exposure `direct`). */
export const PI_MCP_EXTENSION_FILE = 'remyral-mcp-servers.mjs';

/**
 * Pi 1.1.0: generated extension source registering each server with `pi.registerMcpServer('x-<id>', {type:
 * 'streamable-http', url, headers, timeout, exposure: 'direct'})` (fields of `McpHttpServerConfig`, the pinned
 * `dist/core/mcp-servers.d.ts`). Secret headers are `${REMYRAL_MCP_H_…}` references (Pi expands `${VAR}` in headers);
 * literals never start with `!` (Pi would run a command) and contain no `$` — checked by {@link assertMcpDelivery}.
 * `direct` exposure: the tools are declared to the model and every call passes the gate's `tool_call` handler.
 */
export function piMcpExtensionSource(mcp: McpJobDelivery): string {
  const servers = mcp.servers.map((s) => {
    if (s.transport === 'stdio') {
      // p14-mcp-stdio: `McpStdioServerConfig` of the pinned 1.1.0 (`dist/core/mcp-servers.d.ts`): command, args; no
      // env (the launcher reads its spec file; Pi would expand `${VAR}` / run `!cmd` in env values).
      return {
        name: s.name,
        config: {
          type: 'stdio',
          command: s.command,
          args: [...s.args],
          timeout: s.toolTimeoutSec,
          exposure: 'direct',
          enabled: true,
        },
      };
    }
    if (s.transport !== 'http')
      throw new InvalidSpawnContextError(`pi cannot use ${s.transport} MCP servers`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mcpRenderedHeaders(s))) {
      if (v.kind === 'literal') {
        if (v.value.startsWith('!') || v.value.includes('$')) {
          throw new InvalidSpawnContextError(`pi MCP header ${k}: unsafe literal`);
        }
        headers[k] = v.value;
      } else headers[k] = `\${${v.env}}`;
    }
    return {
      name: s.name,
      config: {
        type: 'streamable-http',
        url: s.url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        timeout: s.toolTimeoutSec,
        exposure: 'direct',
        enabled: true,
      },
    };
  });
  return `// Generated by @remyral/agent-adapters (p14-mcp-core). Do not edit.
const SERVERS = ${JSON.stringify(servers)};
export default function remyralMcpServers(pi) {
  for (const s of SERVERS) pi.registerMcpServer(s.name, s.config);
}
`;
}
