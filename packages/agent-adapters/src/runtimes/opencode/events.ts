import { mcpArgsDigest } from '../../mcp.js';
import type { AgentEvent } from '@remyral/protocol';
import type { ApprovalDetails } from '@remyral/protocol/approval-details';
import { runtimeApprovalDetails } from '../../approval-details.js';
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
import { OC_CONSUMED_EVENTS, OC_CONSUMED_PARTS, OcEvent, OcPart } from './schema.js';
import { PROVIDER_USAGE_LIMIT, usageLimitFromError, usageLimitMessage } from '../../usage-limit.js';

export type OcAction =
  | { readonly kind: 'emit'; readonly event: AgentEvent }
  | { readonly kind: 'connected' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'approval';
      readonly permissionId: string;
      readonly approvalId: string;
      /** The OpenCode permission key (`bash`, `edit`, `read`, …; p6-approval-mode-switch live gate). */
      readonly permission: string;
      readonly event: AgentEvent;
      /** p6-safe-auto-approve: the exact command of a `bash` permission (for a safe-command claim). */
      readonly shellCommand?: string;
      /** p14-mcp-core: the tool call this permission is for, and what OpenCode says about its input. */
      readonly callId?: string;
      readonly toolInput?: unknown;
    }
  /** p14-mcp-core: a tool call finished (the adapter reports calls of external MCP servers). */
  | {
      readonly kind: 'tool-state';
      readonly callId: string;
      readonly tool: string;
      readonly status: 'completed' | 'error';
      /** Size + sha256 of the input and the size of the result — never their content. */
      readonly input: { readonly bytes: number; readonly sha256: string };
      readonly resultBytes: number;
    }
  | { readonly kind: 'permission-replied'; readonly permissionId: string; readonly reply: string }
  | { readonly kind: 'question'; readonly questionId: string }
  | { readonly kind: 'session-error'; readonly name: string; readonly code: string; readonly message: string }
  | { readonly kind: 'assistant-text'; readonly text: string }
  /** Something used the job server's API that the adapter did not (password reached a tool?). */
  | { readonly kind: 'tamper'; readonly reason: string }
  /** A consumed event failed its schema: the adapter fails the session closed. */
  | { readonly kind: 'protocol-error'; readonly message: string };

const HIGH_RISK = new Set(['bash', 'edit', 'external_directory']);

/** `ProviderAuthError` -> `provider_auth_error` (a protocol Identifier). */
export function errorCode(name: string | undefined): string {
  if (!name) return 'session_error';
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toLowerCase();
  return snake.slice(0, 64) || 'session_error';
}

export interface OcMapperOptions {
  /** Known once the session exists (`bind`); until then session-scoped events are ignored. */
  readonly sessionID?: string;
  readonly secrets: SecretEnv;
  readonly authMode: RuntimeAuthMode;
  readonly now?: () => number;
  /** p10-approval-readable: the job workspace (approval details name it for "outside the workspace" readings). */
  readonly workspaceRoot?: string;
}

/**
 * Maps OpenCode 1.19.0 `/event` frames for one session onto protocol events
 * (table: docs/design/p3-adapter-pi-opencode.md §6.3). OpenCode re-sends a
 * part on every change, so the mapper de-duplicates: one `tool_call` and one
 * `tool_result` per call id, one `message` per finished text part, one `usage`
 * per `step-finish` part.
 */
export class OcEventMapper {
  private readonly textDone = new Set<string>();
  private readonly toolCalled = new Set<string>();
  private readonly toolDone = new Set<string>();
  private readonly stepsDone = new Set<string>();
  private readonly assistantMessages = new Map<string, { modelID?: string; providerID?: string }>();
  private stepStarted: number | undefined;
  private readonly now: () => number;
  private sessionID: string | undefined;

  constructor(private readonly opts: OcMapperOptions) {
    this.now = opts.now ?? Date.now;
    this.sessionID = opts.sessionID;
  }

  bind(sessionID: string): void {
    this.sessionID = sessionID;
  }

  map(raw: unknown): OcAction[] {
    const type = typeof raw === 'object' && raw !== null && 'type' in raw ? raw.type : undefined;
    if (typeof type !== 'string' || !OC_CONSUMED_EVENTS.has(type)) return [];
    const parsed = OcEvent.safeParse(raw);
    if (!parsed.success) return [{ kind: 'protocol-error', message: `invalid ${type} event` }];
    const ev = parsed.data;
    if (ev.type === 'server.connected') return [{ kind: 'connected' }];
    // The adapter never opens a PTY or a second session on its per-job server.
    if (ev.type === 'pty.created') return [{ kind: 'tamper', reason: 'a PTY was created on the job server' }];
    if (ev.type === 'session.created') {
      return this.sessionID !== undefined && ev.properties.info.id !== this.sessionID
        ? [{ kind: 'tamper', reason: 'another session was created on the job server' }]
        : [];
    }
    if (this.sessionID === undefined) return [];
    if (ev.properties.sessionID !== undefined && ev.properties.sessionID !== this.sessionID) return [];
    const secrets = this.opts.secrets;
    switch (ev.type) {
      case 'session.status':
        if (ev.properties.status.type === 'busy') return [{ kind: 'busy' }];
        if (ev.properties.status.type === 'idle') return [{ kind: 'idle' }];
        return [];
      case 'session.idle':
        return [{ kind: 'idle' }];
      case 'session.error': {
        const name = ev.properties.error?.name ?? 'UnknownError';
        const message = eventText(ev.properties.error?.data?.message ?? name, secrets);
        // p6-quota-scheduling: a provider usage limit (message or the provider's response body).
        const body = ev.properties.error?.data?.responseBody;
        const limit = usageLimitFromError(
          undefined,
          typeof body === 'string' ? `${message}\n${body.slice(0, 4096)}` : message,
          new Date(this.now()),
        );
        if (limit !== null) {
          const text = eventText(usageLimitMessage(limit, message), secrets);
          return [{ kind: 'session-error', name, code: PROVIDER_USAGE_LIMIT, message: text }];
        }
        return [{ kind: 'session-error', name, code: errorCode(name), message }];
      }
      case 'message.updated': {
        const info = ev.properties.info;
        if (info.role === 'assistant') {
          this.assistantMessages.set(info.id, {
            ...(info.modelID !== undefined ? { modelID: info.modelID } : {}),
            ...(info.providerID !== undefined ? { providerID: info.providerID } : {}),
          });
        }
        return [];
      }
      case 'message.part.updated':
        return this.part(ev.properties.part);
      case 'permission.asked': {
        const p = ev.properties;
        const detail = typeof p.metadata?.command === 'string' ? p.metadata.command : p.patterns.join(' ');
        const approvalId = toIdentifier(p.id);
        return [
          {
            kind: 'approval',
            permissionId: p.id,
            approvalId,
            permission: p.permission,
            // p14-mcp-core: which call this is (MCP decisions and call events).
            ...(p.tool?.callID === undefined ? {} : { callId: p.tool.callID }),
            ...(p.metadata === undefined ? {} : { toolInput: p.metadata }),
            ...(p.permission === 'bash' && typeof p.metadata?.command === 'string'
              ? { shellCommand: p.metadata.command }
              : {}),
            event: {
              kind: 'approval_request',
              approvalId,
              action: 'runtime.dangerous_tool',
              description: eventText(`${p.permission}: ${detail}`, secrets, SUMMARY_CHARS),
              risk: HIGH_RISK.has(p.permission) ? 'high' : 'medium',
              ...withDetails(ocApprovalDetails(p, secrets, this.opts.workspaceRoot)),
            },
          },
        ];
      }
      case 'permission.replied':
        return [
          { kind: 'permission-replied', permissionId: ev.properties.requestID, reply: ev.properties.reply },
        ];
      case 'question.asked':
        return [{ kind: 'question', questionId: ev.properties.id }];
    }
  }

  private part(raw: { type: string }): OcAction[] {
    if (raw.type === 'step-start') {
      this.stepStarted = this.now();
      return [];
    }
    if (!OC_CONSUMED_PARTS.has(raw.type)) return [];
    const parsed = OcPart.safeParse(raw);
    if (!parsed.success) return [{ kind: 'protocol-error', message: `invalid ${raw.type} part` }];
    const part = parsed.data;
    const secrets = this.opts.secrets;
    switch (part.type) {
      case 'text': {
        // User prompt parts carry no time; assistant text is final once `time.end` is set.
        if (part.time?.end === undefined || part.synthetic === true || this.textDone.has(part.id)) return [];
        this.textDone.add(part.id);
        if (part.text.trim() === '') return [];
        const text = eventText(part.text, secrets);
        return [
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text } },
          { kind: 'assistant-text', text },
        ];
      }
      case 'tool': {
        const actions: OcAction[] = [];
        const callId = toIdentifier(part.callID);
        const state = part.state;
        if (state.status !== 'pending' && !this.toolCalled.has(part.callID)) {
          this.toolCalled.add(part.callID);
          actions.push({
            kind: 'emit',
            event: {
              kind: 'tool_call',
              callId,
              toolName: eventText(part.tool, secrets, 128) || 'unknown',
              inputSummary: summarize(state.input ?? {}, secrets),
            },
          });
        }
        if ((state.status === 'completed' || state.status === 'error') && !this.toolDone.has(part.callID)) {
          this.toolDone.add(part.callID);
          // p14-mcp-core: the adapter turns finished calls of external MCP servers into `mcp_call` events.
          actions.push({
            kind: 'tool-state',
            callId: part.callID,
            tool: part.tool,
            status: state.status,
            input: mcpArgsDigest(state.input ?? {}),
            resultBytes: Buffer.byteLength(state.status === 'completed' ? state.output : state.error),
          });
          actions.push({
            kind: 'emit',
            event: {
              kind: 'tool_result',
              callId,
              ok: state.status === 'completed',
              outputSummary: eventText(
                state.status === 'completed' ? state.output : state.error,
                secrets,
                SUMMARY_CHARS,
              ),
            },
          });
        }
        return actions;
      }
      case 'step-finish': {
        if (this.stepsDone.has(part.id)) return [];
        this.stepsDone.add(part.id);
        const t = part.tokens;
        const subscription = this.opts.authMode === 'local-login';
        const info = this.assistantMessages.get(part.messageID);
        const provider = protocolProvider(info?.providerID);
        const model = protocolModel(info?.modelID);
        const inputTokens = count(t.input);
        const outputTokens = count(t.output + t.reasoning);
        const cacheReadTokens = count(t.cache.read);
        const cacheWriteTokens = count(t.cache.write);
        const started = this.stepStarted;
        this.stepStarted = undefined;
        return [
          {
            kind: 'emit',
            event: {
              kind: 'usage',
              provenance: subscription ? 'estimated-from-tokens' : 'reported-by-runtime',
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
              ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
              ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
              ...(!subscription && part.cost >= 0 ? { costUsd: part.cost } : {}),
              turns: 1,
              ...(started !== undefined ? { durationMs: Math.max(0, Math.round(this.now() - started)) } : {}),
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
              authMode: this.opts.authMode,
            },
          },
        ];
      }
    }
  }
}

/** OpenCode permissions whose patterns are file paths (not command patterns). */
const OC_PATH_PERMISSIONS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'read',
  'external_directory',
  'patch',
]);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * p10-approval-readable: the fields of an OpenCode permission request — `metadata.command` / `metadata.description` of
 * `bash`, the file path(s) of edit-like permissions (their patterns), `metadata.url` of `webfetch`.
 */
export function ocApprovalDetails(
  p: { permission: string; patterns: readonly string[]; metadata?: Record<string, unknown> | undefined },
  secrets: SecretEnv,
  workspaceRoot?: string,
): ApprovalDetails | undefined {
  const m = p.metadata ?? {};
  const filePath = str(m.filepath) ?? str(m.filePath) ?? str(m.path);
  const paths = [
    ...(filePath === null ? [] : [filePath]),
    ...(OC_PATH_PERMISSIONS.has(p.permission) ? p.patterns : []),
  ];
  return runtimeApprovalDetails(p.permission, null, secrets, {
    command: p.permission === 'bash' ? str(m.command) : null,
    description: str(m.description),
    url: str(m.url),
    paths,
    ...(p.permission === 'bash' ? { shell: 'posix' as const } : {}),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
}

function withDetails(details: ApprovalDetails | undefined): { details?: ApprovalDetails } {
  return details === undefined ? {} : { details };
}
