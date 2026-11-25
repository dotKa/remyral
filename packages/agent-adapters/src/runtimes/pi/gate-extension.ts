import type { ApprovalPolicy } from '../../contract.js';

/**
 * Remyral permission gate for Pi 1.1.0 (ADR-0012: "our permission-gate extension
 * that denies on timeout/error"). Pi has no native approvals (docs/compat/pi.md
 * §4.1); its extension API lets a `tool_call` handler block a call, and in RPC
 * mode `ctx.ui.select` becomes an `extension_ui_request` the adapter answers.
 *
 * Fail-closed by construction (all verified against the pinned binary):
 * - missing/invalid policy  -> every tool call is blocked;
 * - dialog timeout          -> `select` resolves `undefined` -> blocked;
 * - cancelled dialog / deny -> blocked;
 * - handler throws          -> Pi blocks the tool (docs/extensions.md "a tool_call
 *   handler failure blocks the tool as a fail-safe"); we also catch and block.
 *
 * The source is plain ESM JavaScript without imports so Pi's loader (jiti) needs
 * nothing from the workspace; the adapter writes it into the session's private
 * state directory (0600) and loads it with `--no-extensions -e <path>`. It reads
 * its policy from `REMYRAL_PI_GATE_POLICY` (non-secret).
 *
 * This gate is advisory with respect to containment: extensions run inside the
 * Pi process with the user's permissions, and an approved `bash` call can do
 * anything that user can. Isolation is the sandbox's job (ADR-0007).
 */

export const PI_GATE_MARKER = 'remyral-approval:v1:';
/**
 * p6-approval-mode-switch: title prefix of the dialog in which the gate asks the adapter for the job's *current*
 * approval mode before each tool call (options: the four modes; the adapter answers at once). No valid answer in
 * {@link PI_POLICY_QUERY_TIMEOUT_MS} → the call is blocked (fail-closed).
 */
export const PI_POLICY_MARKER = 'remyral-policy:v1:';
export const PI_POLICY_QUERY_TIMEOUT_MS = 30_000;
/**
 * p14-mcp-core: title prefix of the dialog in which the gate asks the adapter about one MCP tool call (`mcp__*` and
 * the MCP resource tools). The adapter decides with the job's tool policy and live mode (asking a human for `ask`);
 * options approve / deny; no answer → blocked.
 */
export const PI_MCP_MARKER = 'remyral-mcp:v1:';
/** Pi 1.1.0's MCP resource tools (`dist/core/mcp-servers.d.ts`): no tool policy names them — always via the adapter. */
export const PI_MCP_RESOURCE_TOOLS: readonly string[] = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
];
export const PI_GATE_MODES: readonly ApprovalPolicy[] = [
  'ask-all',
  'ask-sensitive',
  'deny-sensitive',
  'allow-all',
];
export const PI_GATE_POLICY_ENV = 'REMYRAL_PI_GATE_POLICY';
export const PI_GATE_FILE = 'remyral-permission-gate.mjs';

/** Built-in Pi tools that cannot change state (docs: "read-only, off by default" for grep/find/ls). */
export const PI_READ_ONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/** Built-in Pi tools that change files; their input carries `path` (pinned 1.1.0 tool schemas). */
export const PI_WRITE_TOOLS: readonly string[] = ['edit', 'write'];

export interface PiGatePolicy {
  readonly v: 1;
  /**
   * - `ask-all`: every tool call needs a human decision;
   * - `ask-sensitive`: read-only tools run, and (p5-full-access §2) `edit` / `write` of a path inside the
   *   workspace run; everything else (bash, powershell, edits elsewhere, unknown/custom/MCP tools) needs a decision;
   * - `deny-sensitive`: read-only tools run, everything else is blocked;
   * - `allow-all` (ADR-0020): nothing is blocked or asked.
   */
  readonly mode: ApprovalPolicy;
  /** Dialog timeout; on expiry the call is blocked. */
  readonly timeoutMs: number;
  readonly readOnlyTools: readonly string[];
  /** The job's workspace (Pi's cwd); absent = no in-workspace exemption. */
  readonly workspaceRoot?: string;
  /**
   * p6-approval-mode-switch: ask the adapter for the current mode before each tool call (`mode` is then only the
   * start value, used when Pi offers no UI channel).
   */
  readonly live?: boolean;
  /**
   * p8-subtasks-pi (ADR-0031): tool names that run without a gate decision in every mode — exactly the sub-job tools
   * the adapter's own extension registers (subtask-extension.ts); the master's gates decide those calls. Absent / empty:
   * no exemption.
   */
  readonly preApprovedTools?: readonly string[];
  /**
   * p14-mcp-core: the job has external MCP servers — every `mcp__*` / MCP resource call is sent to the adapter
   * (dialog {@link PI_MCP_MARKER}); without it such calls follow the normal mode rules.
   */
  readonly mcp?: boolean;
}

export function piGatePolicy(
  mode: ApprovalPolicy,
  timeoutMs: number,
  workspaceRoot?: string,
  live = false,
  preApprovedTools: readonly string[] = [],
  mcp = false,
): PiGatePolicy {
  return {
    v: 1,
    mode,
    timeoutMs: Math.max(1, Math.floor(timeoutMs)),
    readOnlyTools: PI_READ_ONLY_TOOLS,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(live ? { live: true } : {}),
    ...(preApprovedTools.length === 0 ? {} : { preApprovedTools: [...preApprovedTools] }),
    ...(mcp ? { mcp: true } : {}),
  };
}

/**
 * The mode the gate enforces for `policy`: without an offered approval channel nothing could answer a dialog, so
 * every asking mode becomes `deny-sensitive`; `allow-all` asks nobody.
 */
export function piGateMode(policy: ApprovalPolicy, approvalOffered: boolean): ApprovalPolicy {
  return policy === 'allow-all' || approvalOffered ? policy : 'deny-sensitive';
}

/** Payload carried in the dialog title after `PI_GATE_MARKER`. */
export interface PiGateRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  /** JSON of the tool input, truncated by the extension to 4000 characters. */
  readonly input: string;
}

export const PI_GATE_APPROVE = 'approve';
export const PI_GATE_DENY = 'deny';

export const PI_GATE_SOURCE = `// Generated by @remyral/agent-adapters (Pi permission gate). Do not edit.
const MARKER = ${JSON.stringify(PI_GATE_MARKER)};
const POLICY_MARKER = ${JSON.stringify(PI_POLICY_MARKER)};
const POLICY_TIMEOUT = ${JSON.stringify(PI_POLICY_QUERY_TIMEOUT_MS)};
const MCP_MARKER = ${JSON.stringify(PI_MCP_MARKER)};
const MCP_RESOURCE_TOOLS = new Set(${JSON.stringify(PI_MCP_RESOURCE_TOOLS)});
const MODE_LIST = ${JSON.stringify(PI_GATE_MODES)};
const MODES = new Set(MODE_LIST);
const WRITE_TOOLS = new Set(${JSON.stringify(['edit', 'write'])});
function loadPolicy() {
  try {
    const p = JSON.parse(process.env[${JSON.stringify(PI_GATE_POLICY_ENV)}] ?? '');
    if (!p || p.v !== 1 || !MODES.has(p.mode)) return undefined;
    if (!Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) return undefined;
    if (!Array.isArray(p.readOnlyTools)) return undefined;
    const root = typeof p.workspaceRoot === 'string' && p.workspaceRoot.length > 0 ? p.workspaceRoot : undefined;
    if (p.preApprovedTools !== undefined && !Array.isArray(p.preApprovedTools)) return undefined;
    return {
      mode: p.mode,
      timeoutMs: p.timeoutMs,
      readOnly: new Set(p.readOnlyTools.map(String)),
      preApproved: new Set((p.preApprovedTools ?? []).map(String)),
      root,
      live: p.live === true,
      mcp: p.mcp === true,
    };
  } catch {
    return undefined;
  }
}
// The target of an edit/write lies inside the workspace (symlinks of the deepest existing ancestor resolved,
// not under .git). Any doubt or error: false (ask).
async function insideWorkspace(root, target) {
  try {
    if (typeof root !== 'string' || typeof target !== 'string') return false;
    if (target.length === 0 || target.length > 4096 || target.includes('\\0')) return false;
    if (target.startsWith('~') || target.startsWith('@')) return false;
    const path = await import('node:path');
    const fs = await import('node:fs');
    if (!path.isAbsolute(root)) return false;
    const realRoot = fs.realpathSync.native(root);
    const abs = path.resolve(root, target);
    let cur = abs;
    for (;;) {
      let exists = true;
      try { fs.lstatSync(cur); } catch { exists = false; }
      if (exists) break;
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
    const real = path.join(fs.realpathSync.native(cur), path.relative(cur, abs));
    const rel = path.relative(realRoot, real);
    if (rel === '' || path.isAbsolute(rel)) return false;
    const parts = rel.split(/[\\\\/]/);
    if (parts[0] === '..') return false;
    return !parts.some((s) => s.toLowerCase() === '.git');
  } catch {
    return false;
  }
}
function inputSummary(input) {
  let text;
  try { text = JSON.stringify(input) ?? ''; } catch { text = '[unserializable]'; }
  return text.length > 4000 ? text.slice(0, 4000) : text;
}
export default function remyralPermissionGate(pi) {
  const policy = loadPolicy();
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (!policy) return { block: true, reason: 'Blocked by Remyral: no valid approval policy (fail-closed).' };
      // p14-mcp-core: MCP tool calls are decided by the adapter (tool policy + live mode), in every mode.
      const name = event ? String(event.toolName) : '';
      if (policy.mcp && (name.startsWith('mcp__') || MCP_RESOURCE_TOOLS.has(name))) {
        if (!ctx || !ctx.hasUI || !ctx.ui) {
          return { block: true, reason: 'Blocked by Remyral: MCP tools are not available in this job.' };
        }
        const mcpTitle = MCP_MARKER + JSON.stringify({
          toolCallId: String(event.toolCallId),
          toolName: name,
          input: inputSummary(event.input),
        });
        const verdict = await ctx.ui.select(mcpTitle, ['approve', 'deny'], { timeout: policy.timeoutMs + 5000 });
        if (verdict === 'approve') return undefined;
        return { block: true, reason: 'Blocked by Remyral: the MCP tool policy or the reviewer denied ' + name + '.' };
      }
      // p8-subtasks-pi: the platform's own sub-job tools (gated by the master, not here).
      if (event && policy.preApproved.has(event.toolName)) return undefined;
      // p6-approval-mode-switch: the job's current mode, from the adapter (it may change while the job runs).
      let mode = policy.mode;
      if (policy.live && ctx && ctx.hasUI && ctx.ui) {
        const current = await ctx.ui.select(POLICY_MARKER + '{}', MODE_LIST, { timeout: POLICY_TIMEOUT });
        if (typeof current !== 'string' || !MODES.has(current)) {
          return { block: true, reason: 'Blocked by Remyral: the current approval mode is unavailable (fail-closed).' };
        }
        mode = current;
      }
      if (mode === 'allow-all') return undefined;
      const readOnly = policy.readOnly.has(event.toolName);
      if (readOnly && mode !== 'ask-all') return undefined;
      if (
        mode === 'ask-sensitive' &&
        WRITE_TOOLS.has(event.toolName) &&
        event.input &&
        (await insideWorkspace(policy.root, event.input.path))
      ) {
        return undefined;
      }
      if (mode === 'deny-sensitive') {
        return { block: true, reason: 'Blocked by Remyral: the job policy denies ' + event.toolName + '.' };
      }
      if (!ctx || !ctx.hasUI || !ctx.ui) {
        return { block: true, reason: 'Blocked by Remyral: no approval channel.' };
      }
      const title = MARKER + JSON.stringify({
        toolCallId: String(event.toolCallId),
        toolName: String(event.toolName),
        input: inputSummary(event.input),
      });
      const choice = await ctx.ui.select(title, ['approve', 'deny'], { timeout: policy.timeoutMs });
      if (choice === 'approve') return undefined;
      return {
        block: true,
        reason: choice === undefined
          ? 'Blocked by Remyral: no approval decision in time (denied).'
          : 'Blocked by Remyral: denied by the reviewer.',
      };
    } catch {
      return { block: true, reason: 'Blocked by Remyral: approval gate error (fail-closed).' };
    }
  });
}
`;
