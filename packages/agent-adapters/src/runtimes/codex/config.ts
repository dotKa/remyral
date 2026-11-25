import type { SandboxProfile } from '@remyral/protocol';
import { z } from 'zod';
import type { ApprovalPolicy } from '../../contract.js';
import { InvalidSpawnContextError } from '../../errors.js';
import { type JobToolChannel, jobChannelToolSpecs } from '../../deploy-tools.js';
import type { RuntimeAuthMode } from '../session-kit/auth.js';
import type { AskForApproval } from './protocol/generated/v2/AskForApproval.js';
import type { SandboxPolicy } from './protocol/generated/v2/SandboxPolicy.js';
import type { ThreadResumeParams } from './protocol/generated/v2/ThreadResumeParams.js';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams.js';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams.js';
import { CODEX_PROVIDER_CREDENTIAL_ENV } from './pins.js';

/** TOML basic string (for `-c key=value` overrides, parsed as TOML by Codex). */
export function tomlString(value: string): string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new InvalidSpawnContextError('value for a Codex config override contains control characters');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Job approval policy → Codex `AskForApproval` (values of the pinned schema).
 * `on-failure` does not exist in 0.162.1 (compat §2.1) and is never used.
 * `deny-sensitive` and `allow-all` (ADR-0020) both map to `never` (Codex does not ask); they differ in what
 * the adapter answers if a request still arrives: deny vs approve.
 */
export function codexApprovalPolicy(policy: ApprovalPolicy): AskForApproval {
  switch (policy) {
    case 'ask-all':
      return 'untrusted';
    case 'ask-sensitive':
      return 'on-request';
    case 'deny-sensitive':
      return 'never';
    case 'allow-all':
      // ADR-0020: Codex never asks; what it may do is bounded by the per-turn sandbox policy (unchanged).
      return 'never';
  }
}

/**
 * Per-turn sandbox policy. Mirrors `codexSandboxConfig` of p3-sandbox
 * (apps/worker/src/sandbox/runtime-sandbox.ts — mirrored, packages must not
 * import apps):
 * - `runtime-sandbox`: Codex's own sandbox (bwrap / Windows), workspace-write,
 *   tool network off, `/tmp` excluded;
 * - `container` / `host-restricted`: the container or host confinement is the
 *   boundary (a nested Seatbelt fails on macOS, bwrap fails under Docker's
 *   default seccomp — handson 2026-10-13) → `externalSandbox`, network restricted.
 */
export function codexSandboxPolicy(
  profile: SandboxProfile,
  extraWritableRoots: readonly string[] = [],
): SandboxPolicy {
  if (profile === 'runtime-sandbox') {
    return {
      type: 'workspaceWrite',
      writableRoots: [...extraWritableRoots],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    };
  }
  return { type: 'externalSandbox', networkAccess: 'restricted' };
}

/**
 * The provider entry API-key sessions use (p6-codex-apikey-fix). Verified on the pinned 0.162.1 with a local
 * fake Responses API (docs/compat/codex.md §4.1): `codex app-server` does **not** authenticate with
 * `CODEX_API_KEY` or `OPENAI_API_KEY` from its environment — with the built-in `openai` provider every request
 * went out without an `Authorization` header and `account/read` answered `requiresOpenaiAuth: true`. A custom
 * provider whose `env_key` names the injected variable makes Codex read the key from its environment and send
 * it as `Authorization: Bearer …`; the key itself is never in argv or a config file.
 */
export const CODEX_API_KEY_PROVIDER = 'remyral-openai';
export const CODEX_DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';

/** The env names an API key may be injected under, in precedence order (CODEX_API_KEY wins, as in the SDK). */
const API_KEY_ENV_NAMES = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

/** secret-ref: the injected env name that carries the OpenAI API key, if any. */
export function codexApiKeyEnv(secretNames: readonly string[]): string | undefined {
  return API_KEY_ENV_NAMES.find((k) => secretNames.includes(k));
}

/**
 * `-c` overrides that route the session through {@link CODEX_API_KEY_PROVIDER} with the key read from
 * `apiKeyEnv` (shared by the job adapter and the assistant engine). `apiBaseUrl`: the OpenAI Responses endpoint
 * (default {@link CODEX_DEFAULT_API_BASE_URL}); an operator setting for OpenAI-compatible gateways, tests point
 * it at a local fake.
 */
export function codexApiKeyProviderArgs(apiKeyEnv: string, apiBaseUrl?: string): string[] {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(apiKeyEnv)) {
    throw new InvalidSpawnContextError('invalid API key variable name');
  }
  const url = apiBaseUrl ?? CODEX_DEFAULT_API_BASE_URL;
  if (!/^https?:\/\/[^\s]+$/.test(url))
    throw new InvalidSpawnContextError('apiBaseUrl must be an http(s) URL');
  return [
    '-c',
    `model_providers.${CODEX_API_KEY_PROVIDER}={ name = "OpenAI (API key)", base_url = ${tomlString(url)}, env_key = ${tomlString(apiKeyEnv)}, wire_api = "responses" }`,
    '-c',
    `model_provider=${tomlString(CODEX_API_KEY_PROVIDER)}`,
  ];
}

/**
 * p14-codex-mcp-isolation: `-c` overrides that keep the worker user's own Codex configuration from running code
 * in a session (shared by every job, the usage probe and the assistant). local-login uses the worker user's own
 * `CODEX_HOME`, and the pinned 0.162.1 has no flag to skip its `config.toml` (`codex app-server --help`: only
 * `-c`, `--enable`/`--disable`, `--strict-config`; `--profile` only *adds* a layer). Each key is a 0.162.1
 * feature or config key (`codex features list` on the pin; `--strict-config` rejects an unknown one, so a renamed
 * key fails the start instead of being silently ignored):
 * - `hooks`: command hooks (`SessionStart`, `PreToolUse`, … from `config.toml` / `hooks.json`) run programs;
 * - `plugins`, `remote_plugin`: plugins bring their own MCP servers, hooks and skills;
 * - `apps`: the account's connected apps (connectors) as tools;
 * - `skill_mcp_dependency_install`: skills that install MCP servers;
 * - `computer_use`, `browser_use`, `browser_use_external`: drive the worker host's desktop / browser;
 * - `memories`: no memory carried between jobs through the user's home;
 * - `notify=[]`: the user's `notify` program runs after every turn otherwise (verified for the assistant, §9).
 * MCP servers cannot be removed with an override (`-c mcp_servers={}` merges, docs/compat/codex.md §9): see
 * {@link codexIsolatedThreadConfig}. The platform's own tools are thread `dynamicTools`, not affected by any of these.
 */
export const CODEX_USER_CONFIG_ISOLATION_OVERRIDES: readonly string[] = [
  'features.hooks=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.apps=false',
  'features.skill_mcp_dependency_install=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.memories=false',
  'notify=[]',
];

/**
 * p14-mcp-core: the effective entries of the job's own MCP servers (`config/read`) must be exactly ours — a server of
 * the worker user's `config.toml` with the same name would otherwise merge its fields (`command`, `env`, …) into
 * ours. Returns the problems found (empty = fine).
 */
export async function checkOwnMcpServers(
  request: (msg: { method: string; params: unknown }, timeoutMs: number) => Promise<unknown>,
  cwd: string,
  timeoutMs: number,
  /** name → the remote URL, or (p14-mcp-stdio) the stdio command line and forwarded env names. */
  own: Readonly<
    Record<
      string,
      | string
      | { readonly command: string; readonly args: readonly string[]; readonly envVars: readonly string[] }
    >
  >,
): Promise<string[]> {
  const raw = await request({ method: 'config/read', params: { includeLayers: false, cwd } }, timeoutMs);
  const parsed = ConfigReadMcpResult.safeParse(raw);
  if (!parsed.success) return ['config/read: response failed schema validation'];
  const servers = parsed.data.config.mcp_servers ?? {};
  const problems: string[] = [];
  const same = (a: unknown, b: readonly string[]): boolean =>
    Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  for (const [name, want] of Object.entries(own)) {
    const raw: unknown = servers[name];
    if (typeof raw !== 'object' || raw === null) {
      problems.push(`${name} missing from the effective configuration`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof want === 'string') {
      if (entry.url !== want) problems.push(`${name} has another URL in the effective configuration`);
      for (const k of ['command', 'args', 'env', 'env_vars', 'bearer_token', 'cwd']) {
        if (entry[k] !== undefined && entry[k] !== null)
          problems.push(`${name} carries ${k} from another layer`);
      }
      continue;
    }
    // A stdio server: exactly our launcher command line; no env, cwd, URL or token from another layer.
    if (entry.command !== want.command || !same(entry.args, want.args)) {
      problems.push(`${name} has another command in the effective configuration`);
    }
    if (entry.env_vars !== undefined && entry.env_vars !== null && !same(entry.env_vars, want.envVars)) {
      problems.push(`${name} forwards other env variables in the effective configuration`);
    }
    for (const k of [
      'url',
      'env',
      'bearer_token',
      'bearer_token_env_var',
      'cwd',
      'http_headers',
      'env_http_headers',
    ]) {
      if (entry[k] !== undefined && entry[k] !== null)
        problems.push(`${name} carries ${k} from another layer`);
    }
  }
  return problems;
}

/** `config/read` answer: only the configured MCP server names are used. */
const ConfigReadMcpResult = z.looseObject({
  config: z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).nullable().optional() }),
});

/**
 * p14-codex-mcp-isolation: the names of every MCP server the effective configuration declares (user
 * `config.toml`, profiles, system layer …), read with the app-server's `config/read {includeLayers:false, cwd}`
 * before the thread starts. Fails (throws) when the answer does not match — the caller must not start a thread
 * then (fail closed).
 */
export async function readConfiguredMcpServerNames(
  request: (msg: { method: string; params: unknown }, timeoutMs: number) => Promise<unknown>,
  cwd: string,
  timeoutMs: number,
): Promise<string[]> {
  const raw = await request({ method: 'config/read', params: { includeLayers: false, cwd } }, timeoutMs);
  const parsed = ConfigReadMcpResult.safeParse(raw);
  if (!parsed.success) throw new Error('config/read: response failed schema validation');
  return Object.keys(parsed.data.config.mcp_servers ?? {});
}

/** Thread `config` that switches off every configured MCP server and the `notify` program. */
export interface CodexIsolatedThreadConfig {
  mcp_servers: Record<string, { enabled: false }>;
  notify: [];
}

/**
 * p14-codex-mcp-isolation: thread `config` (`thread/start` / `thread/resume`) disabling each named MCP server as
 * `{"mcp_servers": {"<name>": {"enabled": false}}}` — the form verified on 0.162.1 (also for names with dots):
 * no `mcpServer/startupStatus/updated`, no MCP tools offered (docs/compat/codex.md §9). Shared by jobs and the
 * assistant.
 */
export function codexIsolatedThreadConfig(mcpServerNames: readonly string[]): CodexIsolatedThreadConfig {
  const mcp: Record<string, { enabled: false }> = {};
  for (const name of mcpServerNames) mcp[name] = { enabled: false };
  return { mcp_servers: mcp, notify: [] };
}

export interface AppServerArgsInput {
  readonly authMode: RuntimeAuthMode;
  readonly workspaceRoot: string;
  readonly repositoryTrust: 'trusted' | 'untrusted';
  /** Env names of injected secrets (excluded from tool-command environments). */
  readonly secretNames: readonly string[];
  /** p6-skills: repository SKILL.md files to disable (`[[skills.config]] path = … enabled = false`). */
  readonly disabledSkillPaths?: readonly string[];
  /** secret-ref with an API key: the Responses endpoint of the provider entry (see {@link codexApiKeyProviderArgs}). */
  readonly apiBaseUrl?: string;
  /** p14-mcp-core: the job's external MCP servers as `-c mcp_servers.<name>={…}` overrides (no secret values). */
  readonly mcpArgs?: readonly string[];
}

/**
 * `codex --no-daemon app-server --listen stdio:// --strict-config -c …`.
 * Every override was verified on the pinned binary (2026-10-13, `config/read`
 * and thread/start responses; `--strict-config` rejects unknown keys, so a
 * renamed key fails the start instead of being silently ignored):
 * - `projects.<workspace>.trust_level="untrusted"`: the repo's `.codex/config.toml`
 *   is not loaded (without it a hostile `network_access = true` took effect);
 * - `project_doc_max_bytes=0` for untrusted repos: no repo AGENTS.md in the instructions;
 * - `history.persistence="none"`; `shell_environment_policy.exclude=[secret names]`;
 * - `features.image_generation=true` (p8-codex-images, docs/compat/codex.md §10);
 * - {@link CODEX_USER_CONFIG_ISOLATION_OVERRIDES} (p14-codex-mcp-isolation): no hooks, plugins, apps, notify …
 *   of the worker user's own config;
 * - secret-ref: `cli_auth_credentials_store="ephemeral"` (no auth.json written) and, when an API key is
 *   injected (`CODEX_API_KEY` / `OPENAI_API_KEY`), the {@link CODEX_API_KEY_PROVIDER} provider entry — the
 *   app-server ignores those variables otherwise (p6-codex-apikey-fix).
 */
export function appServerArgs(input: AppServerArgsInput): string[] {
  const excluded = [...new Set([...CODEX_PROVIDER_CREDENTIAL_ENV, ...input.secretNames])];
  const args = [
    '--no-daemon',
    'app-server',
    '--listen',
    'stdio://',
    '--strict-config',
    '-c',
    `projects={ ${tomlString(input.workspaceRoot)} = { trust_level = "untrusted" } }`,
    '-c',
    'history.persistence="none"',
    '-c',
    `shell_environment_policy.exclude=[${excluded.map(tomlString).join(', ')}]`,
    // p8-codex-images: on by default in 0.162.1 (`codex features list`: image_generation stable true); stated
    // explicitly so the worker user's own config.toml cannot switch it off for jobs (the key is accepted by
    // --strict-config: the assistant sets the same key to false).
    '-c',
    'features.image_generation=true',
    // p14-codex-mcp-isolation: nothing from the worker user's config.toml that runs code (hooks, plugins, apps,
    // notify …); its MCP servers are disabled per thread (codexIsolatedThreadConfig).
    ...CODEX_USER_CONFIG_ISOLATION_OVERRIDES.flatMap((o) => ['-c', o]),
  ];
  if (input.authMode === 'secret-ref') {
    args.push('-c', 'cli_auth_credentials_store="ephemeral"');
    const keyEnv = codexApiKeyEnv(input.secretNames);
    if (keyEnv !== undefined) args.push(...codexApiKeyProviderArgs(keyEnv, input.apiBaseUrl));
  }
  if (input.repositoryTrust === 'untrusted') args.push('-c', 'project_doc_max_bytes=0');
  const disabled = input.disabledSkillPaths ?? [];
  if (disabled.length > 0) {
    // Repository skills load even for untrusted workspaces (verified on 0.162.1): disable each by path.
    const entries = disabled.map((p) => `{ path = ${tomlString(p)}, enabled = false }`);
    args.push('-c', `skills.config=[${entries.join(', ')}]`);
  }
  if (input.mcpArgs !== undefined) args.push(...input.mcpArgs);
  return args;
}

export interface ThreadInput {
  readonly cwd: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly model?: string;
}

/**
 * Experimental `thread/start.dynamicTools` entry (`DynamicToolSpec` of `codex app-server generate-ts --experimental`,
 * 0.162.1: `{type:"function", name, description, inputSchema, deferLoading?}`; not in the vendored non-experimental
 * types). Requires `initialize.capabilities.experimentalApi: true`; each call comes back as the server request
 * `item/tool/call` (vendored `DynamicToolCallParams`), answered with `{contentItems:[{type:"inputText", text}], success}`.
 */
export interface CodexDynamicToolSpec {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** `thread/start` of a job, optionally with dynamic tools (experimental API). */
export type CodexJobThreadStart = ThreadStartParams & { dynamicTools?: CodexDynamicToolSpec[] };

/**
 * p8-subtasks-codex (ADR-0031): the sub-job tools (`request_subtask`, `wait_subtask`, `cancel_subtask`) as dynamic
 * tools of a job thread — JSON Schemas derived from the same zod inputs the tool host validates with.
 */
export function codexSubtaskDynamicTools(
  /** p12-deploy-feedback: the job's tool channel (default: the sub-job tools only). */
  channel: JobToolChannel = { subtaskTools: {} as never },
): CodexDynamicToolSpec[] {
  return jobChannelToolSpecs(channel).map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** `thread/start`: explicit cwd, approval policy, human reviewer, workspace-write sandbox, persisted (for resume). */
export function threadStartParams(input: ThreadInput): ThreadStartParams {
  return {
    cwd: input.cwd,
    approvalPolicy: codexApprovalPolicy(input.approvalPolicy),
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    ephemeral: false,
    serviceName: 'remyral',
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

export function threadResumeParams(threadId: string, input: ThreadInput): ThreadResumeParams {
  return {
    threadId,
    cwd: input.cwd,
    approvalPolicy: codexApprovalPolicy(input.approvalPolicy),
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    excludeTurns: true,
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

/** `turn/start`: the sandbox and approval policy are re-stated on every turn (they persist for later turns). */
export function turnStartParams(
  threadId: string,
  text: string,
  input: ThreadInput & { readonly sandboxPolicy: SandboxPolicy },
): TurnStartParams {
  return {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    cwd: input.cwd,
    approvalPolicy: codexApprovalPolicy(input.approvalPolicy),
    approvalsReviewer: 'user',
    sandboxPolicy: input.sandboxPolicy,
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}
