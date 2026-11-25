import type {
  CanUseTool,
  Options,
  PermissionMode,
  Settings,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalPolicy } from '../../contract.js';
import type { ClaudeRuntimeSandbox } from './sandbox.js';

/**
 * ADR-0012: the starting permission mode is always explicit. `default` routes
 * every tool call that is not pre-approved to `canUseTool` (our approval
 * flow); `dontAsk` denies anything not pre-approved without prompting.
 * `bypassPermissions` is used for exactly one policy: `allow-all`
 * (p5-full-access, ADR-0020 — a project that opted in, a trusted source; the
 * master and the worker both refuse it otherwise). `acceptEdits` and `auto`
 * (model-classifier approvals) are never used.
 */
export function permissionModeFor(policy: ApprovalPolicy): PermissionMode {
  if (policy === 'allow-all') return 'bypassPermissions';
  return policy === 'deny-sensitive' ? 'dontAsk' : 'default';
}

/**
 * Settings layer we pass inline. For every policy but `allow-all` bypass mode can never be switched on
 * (`disableBypassPermissionsMode: 'disable'` in the flag and policy layers). `allow-all` (ADR-0020) leaves the key
 * out — it would make the CLI refuse the mode we ask for; nothing else in the settings changes.
 */
export function hardenedSettings(policy?: ApprovalPolicy): Settings {
  if (policy === 'allow-all') return { permissions: {} };
  return { permissions: { disableBypassPermissionsMode: 'disable' } };
}

export interface ClaudeQueryOptionsInput {
  readonly cwd: string;
  readonly approvalPolicy: ApprovalPolicy;
  /** Path of the pinned bundled CLI (never a global `claude`). */
  readonly pathToClaudeCodeExecutable: string;
  /** Complete non-secret environment for the CLI; secrets are added by the spawner only. */
  readonly env: Readonly<Record<string, string>>;
  readonly canUseTool: CanUseTool;
  readonly abortController: AbortController;
  readonly spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  readonly stderr: (data: string) => void;
  readonly model?: string;
  /** New session: caller-assigned UUID. Mutually exclusive with `resume`. */
  readonly sessionId?: string;
  /** Resume a previous session id (same worker). */
  readonly resume?: string;
  readonly sandbox?: ClaudeRuntimeSandbox;
  readonly maxTurns?: number;
  /**
   * p6-skills: ids of verified skills the adapter wrote to `<CLAUDE_CONFIG_DIR>/skills/<id>/` (the per-attempt
   * config dir, never the real home). Non-empty: the `user` setting source is loaded — it resolves to that
   * private, adapter-created directory — and the Skill tool is limited to exactly these names. `project` and
   * `local` stay off, so repository `.claude/` settings, skills and CLAUDE.md never load (ADR-0010).
   */
  readonly skills?: readonly string[];
}

/**
 * The complete SDK `Options` for a job. Every security-relevant field is set
 * explicitly so nothing falls back to a settings file or CLI default:
 * - `settingSources: []` — no user/project/local settings, no repo
 *   `.claude/settings.json`, no CLAUDE.md auto-load (ADR-0010 / ADR-0012 rule 3);
 * - explicit `permissionMode`, `allowDangerouslySkipPermissions: false`,
 *   `disableBypassPermissionsMode: 'disable'` in the flag and policy layers —
 *   except for `allow-all` (ADR-0020): `bypassPermissions` with
 *   `allowDangerouslySkipPermissions: true` and no disable key;
 * - `permissionPrompts: 'host'` + `canUseTool` → our approval flow;
 * - `strictMcpConfig` with no servers, no plugins;
 * - `verbatimPrompts` — job prompts are not expanded (`@path`, slash commands);
 * - the CLI is spawned by our hook (owned, confined process tree).
 */
export function buildClaudeQueryOptions(input: ClaudeQueryOptionsInput): Options {
  const options: Options = {
    cwd: input.cwd,
    additionalDirectories: [],
    settingSources: input.skills !== undefined && input.skills.length > 0 ? ['user'] : [],
    settings: hardenedSettings(input.approvalPolicy),
    managedSettings: hardenedSettings(input.approvalPolicy),
    permissionMode: permissionModeFor(input.approvalPolicy),
    allowDangerouslySkipPermissions: input.approvalPolicy === 'allow-all',
    permissionPrompts: 'host',
    canUseTool: input.canUseTool,
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    verbatimPrompts: true,
    includePartialMessages: false,
    persistSession: true,
    env: { ...input.env },
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    spawnClaudeCodeProcess: input.spawnClaudeCodeProcess,
    abortController: input.abortController,
    stderr: input.stderr,
  };
  if (input.model !== undefined) options.model = input.model;
  if (input.resume !== undefined) options.resume = input.resume;
  else if (input.sessionId !== undefined) options.sessionId = input.sessionId;
  if (input.sandbox !== undefined) options.sandbox = input.sandbox;
  if (input.maxTurns !== undefined) options.maxTurns = input.maxTurns;
  if (input.skills !== undefined && input.skills.length > 0) options.skills = [...input.skills];
  return options;
}
