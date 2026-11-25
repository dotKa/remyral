import type { AgentEvent } from '@remyral/protocol';
import { runtimeApprovalDetails, shellOfTool } from '../../approval-details.js';
import type { SecretEnv } from '../../secrets.js';
import type { RuntimeAuthMode } from '../common/session-core.js';
import {
  count,
  eventText,
  protocolModel,
  protocolProvider,
  summarize,
  SUMMARY_CHARS,
  toIdentifier,
} from '../common/text.js';
import { PI_GATE_MARKER, PI_MCP_MARKER, PI_POLICY_MARKER } from './gate-extension.js';
import { PI_SUBTASK_MARKER } from './subtask-extension.js';
import { PiAssistantMessage, PiToolResult, textBlocks, type PiInbound } from './schema.js';

/** What the adapter must do with one inbound Pi record (besides emitting events). */
export type PiAction =
  | { readonly kind: 'emit'; readonly event: AgentEvent }
  /** `agent_settled`: Pi will not continue automatically (terminal signal of a run). */
  | { readonly kind: 'settled'; readonly aborted: boolean }
  /** A gate dialog: surface as `approval_request`; `uiId` is answered via `extension_ui_response`. */
  | {
      readonly kind: 'approval';
      readonly uiId: string;
      readonly approvalId: string;
      readonly toolName: string;
      readonly event: AgentEvent;
      /** p6-safe-auto-approve: the exact command of a `bash` / `powershell` call (for a safe-command claim). */
      readonly shellCommand?: string;
    }
  /** p14-mcp-core: the gate asks the adapter about one MCP tool call (answered approve / deny). */
  | {
      readonly kind: 'mcp-gate';
      readonly uiId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      /** The call's input as JSON text (cut at 4000 characters by the gate). */
      readonly input: string;
    }
  /** p14-mcp-core: a tool call ended (the adapter reports calls of external MCP servers). */
  | {
      readonly kind: 'tool-end';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      /** Size of the result (never its content). */
      readonly resultBytes: number;
      readonly durationMs?: number;
    }
  /** p6-approval-mode-switch: the gate asks for the job's current approval mode (answered at once). */
  | { readonly kind: 'policy-query'; readonly uiId: string }
  /** p8-subtasks-pi: a sub-job tool call relayed by subtask-extension.ts (answered with the host's result). */
  | { readonly kind: 'subtask-call'; readonly uiId: string; readonly tool: string; readonly input: unknown }
  /** A dialog that is not ours (or unparsable): answer `cancelled` so nothing waits on it (fail-closed). */
  | { readonly kind: 'cancel-dialog'; readonly uiId: string }
  /** The final assistant message ended with an error stop reason. */
  | { readonly kind: 'assistant-error'; readonly message: string }
  | { readonly kind: 'assistant-text'; readonly text: string };

const HIGH_RISK_TOOLS = new Set(['bash', 'powershell']);

export interface PiMapperOptions {
  readonly secrets: SecretEnv;
  readonly authMode: RuntimeAuthMode;
  readonly now?: () => number;
  /** p10-approval-readable: the job workspace (approval details name it for "outside the workspace" readings). */
  readonly workspaceRoot?: string;
}

/**
 * Maps Pi 1.1.0 RPC records onto protocol `AgentEvent`s (mapping table:
 * docs/design/p3-adapter-pi-opencode.md §3). Stateless except for message
 * start times (usage `durationMs`). Never throws on runtime data: anything
 * unexpected inside a known record is summarized, not trusted.
 */
export class PiEventMapper {
  private readonly messageStart: number[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: PiMapperOptions) {
    this.now = opts.now ?? Date.now;
  }

  map(record: PiInbound): PiAction[] {
    const secrets = this.opts.secrets;
    switch (record.type) {
      case 'message_start':
        if (record.message.role === 'assistant') this.messageStart.push(this.now());
        return [];
      case 'message_end':
        return record.message.role === 'assistant' ? this.assistantEnd(record.message) : [];
      case 'tool_execution_start':
        return [
          {
            kind: 'emit',
            event: {
              kind: 'tool_call',
              callId: toIdentifier(record.toolCallId),
              toolName: eventText(record.toolName, secrets, 128) || 'unknown',
              inputSummary: summarize(record.args ?? {}, secrets),
            },
          },
        ];
      case 'tool_execution_end': {
        const result = PiToolResult.safeParse(record.result);
        const output = result.success ? textBlocks(result.data.content ?? []) : '';
        return [
          {
            kind: 'emit',
            event: {
              kind: 'tool_result',
              callId: toIdentifier(record.toolCallId),
              ok: !record.isError,
              outputSummary: eventText(output, secrets, SUMMARY_CHARS),
            },
          },
          {
            kind: 'tool-end',
            toolCallId: record.toolCallId,
            toolName: record.toolName,
            isError: record.isError,
            resultBytes: jsonBytes(record.result),
            ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
          },
        ];
      }
      case 'extension_ui_request':
        return this.uiRequest(record);
      case 'agent_settled':
        return [{ kind: 'settled', aborted: record.aborted }];
      case 'auto_retry_end':
        return record.success
          ? []
          : [
              {
                kind: 'emit',
                event: {
                  kind: 'error',
                  code: 'retry_exhausted',
                  message: eventText(record.finalError ?? 'automatic retry failed', secrets),
                },
              },
            ];
      case 'compaction_end':
        return record.errorMessage === undefined
          ? []
          : [
              {
                kind: 'emit',
                event: {
                  kind: 'error',
                  code: 'compaction_failed',
                  message: eventText(record.errorMessage, secrets),
                },
              },
            ];
      case 'extension_error':
        return [
          {
            kind: 'emit',
            event: {
              kind: 'error',
              code: 'extension_error',
              // The extension path is a local path of the worker: not included.
              message: eventText(`${record.event ?? 'event'}: ${record.error ?? 'error'}`, secrets),
            },
          },
        ];
      default:
        return [];
    }
  }

  private assistantEnd(raw: unknown): PiAction[] {
    const started = this.messageStart.shift();
    const parsed = PiAssistantMessage.safeParse(raw);
    if (!parsed.success) return [];
    const m = parsed.data;
    const secrets = this.opts.secrets;
    const actions: PiAction[] = [];
    const text = textBlocks(m.content);
    if (text.trim().length > 0) {
      actions.push({
        kind: 'emit',
        event: { kind: 'message', role: 'assistant', text: eventText(text, secrets) },
      });
      actions.push({ kind: 'assistant-text', text: eventText(text, secrets) });
    }
    const u = m.usage;
    const tokens = [u.input, u.output, u.cacheRead, u.cacheWrite].some((n) => n > 0);
    if (tokens || u.cost.total > 0) {
      const subscription = this.opts.authMode === 'local-login';
      const provider = protocolProvider(m.provider);
      const model = protocolModel(m.model);
      const inputTokens = count(u.input);
      const outputTokens = count(u.output);
      const cacheReadTokens = count(u.cacheRead);
      const cacheWriteTokens = count(u.cacheWrite);
      const costUsd = typeof u.cost.total === 'number' && u.cost.total >= 0 ? u.cost.total : undefined;
      actions.push({
        kind: 'emit',
        event: {
          kind: 'usage',
          // ADR-0014: subscription runs have no per-run dollar cost; the master estimates from tokens.
          provenance: subscription ? 'estimated-from-tokens' : 'reported-by-runtime',
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
          ...(!subscription && costUsd !== undefined ? { costUsd } : {}),
          turns: 1,
          ...(started !== undefined ? { durationMs: Math.max(0, Math.round(this.now() - started)) } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          authMode: this.opts.authMode,
        },
      });
    }
    if (m.stopReason === 'error') {
      const message = eventText(m.errorMessage ?? 'model request failed', secrets);
      actions.push({ kind: 'emit', event: { kind: 'error', code: 'model_error', message } });
      actions.push({ kind: 'assistant-error', message });
    }
    return actions;
  }

  private uiRequest(record: Extract<PiInbound, { type: 'extension_ui_request' }>): PiAction[] {
    const dialog = ['select', 'confirm', 'input', 'editor'].includes(record.method);
    if (!dialog) return []; // notify/setStatus/...: fire-and-forget, nothing to answer
    const title = record.title ?? '';
    if (record.method === 'select' && title.startsWith(PI_POLICY_MARKER)) {
      return [{ kind: 'policy-query', uiId: record.id }];
    }
    if (record.method === 'select' && title.startsWith(PI_MCP_MARKER)) {
      let parsed: { toolCallId?: unknown; toolName?: unknown; input?: unknown };
      try {
        parsed = JSON.parse(title.slice(PI_MCP_MARKER.length)) as typeof parsed;
      } catch {
        return [{ kind: 'cancel-dialog', uiId: record.id }];
      }
      if (typeof parsed.toolName !== 'string' || typeof parsed.toolCallId !== 'string') {
        return [{ kind: 'cancel-dialog', uiId: record.id }];
      }
      return [
        {
          kind: 'mcp-gate',
          uiId: record.id,
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName,
          input: typeof parsed.input === 'string' ? parsed.input : '',
        },
      ];
    }
    if (record.method === 'input' && title.startsWith(PI_SUBTASK_MARKER)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(title.slice(PI_SUBTASK_MARKER.length));
      } catch {
        return [{ kind: 'cancel-dialog', uiId: record.id }];
      }
      const call = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
        tool?: unknown;
        input?: unknown;
      };
      if (typeof call.tool !== 'string') return [{ kind: 'cancel-dialog', uiId: record.id }];
      return [{ kind: 'subtask-call', uiId: record.id, tool: call.tool, input: call.input }];
    }
    if (record.method !== 'select' || !title.startsWith(PI_GATE_MARKER)) {
      return [{ kind: 'cancel-dialog', uiId: record.id }];
    }
    let payload: { toolCallId?: unknown; toolName?: unknown; input?: unknown };
    try {
      payload = JSON.parse(title.slice(PI_GATE_MARKER.length)) as typeof payload;
    } catch {
      return [{ kind: 'cancel-dialog', uiId: record.id }];
    }
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
    const input = typeof payload.input === 'string' ? payload.input : '';
    const secrets = this.opts.secrets;
    const approvalId = toIdentifier(record.id);
    const shellCommand = piShellCommand(toolName, input);
    // p10-approval-readable: the gate's input is JSON text (cut at 4000 characters): parsed, never shown half-parsed.
    const shell = shellOfTool(toolName);
    const details = runtimeApprovalDetails(toolName, input, secrets, {
      ...(shell === undefined ? {} : { shell }),
      ...(this.opts.workspaceRoot === undefined ? {} : { workspaceRoot: this.opts.workspaceRoot }),
    });
    return [
      {
        kind: 'approval',
        uiId: record.id,
        approvalId,
        toolName,
        ...(shellCommand === null ? {} : { shellCommand }),
        event: {
          kind: 'approval_request',
          approvalId,
          // p4-approvals catalog: tool calls of a runtime are `runtime.dangerous_tool`.
          action: 'runtime.dangerous_tool',
          description: eventText(`${toolName}: ${input}`, secrets, SUMMARY_CHARS),
          risk: HIGH_RISK_TOOLS.has(toolName) ? 'high' : 'medium',
          ...(details === undefined ? {} : { details }),
        },
      },
    ];
  }
}

function jsonBytes(value: unknown): number {
  try {
    if (typeof value === 'string') return Buffer.byteLength(value);
    const text: unknown = JSON.stringify(value ?? '');
    return typeof text === 'string' ? Buffer.byteLength(text) : 0;
  } catch {
    return 0;
  }
}

/** Input keys of Pi's shell tools that do not change what runs. */
const PI_SHELL_KEYS: ReadonlySet<string> = new Set(['command', 'timeout']);

/**
 * The command of a gated `bash` / `powershell` call, or null. The gate truncates the input JSON at 4000 characters;
 * a truncated (unparsable) or unexpected input is never claimed.
 */
export function piShellCommand(toolName: string, input: string): string | null {
  if (toolName !== 'bash' && toolName !== 'powershell') return null;
  if (input.length >= 4000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !PI_SHELL_KEYS.has(k))) return null;
  return typeof obj.command === 'string' ? obj.command : null;
}
