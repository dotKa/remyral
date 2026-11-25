import { z } from 'zod';

/**
 * Zod schemas for the Pi 1.1.0 RPC wire format (`pi --mode rpc`), derived from
 * the pinned package: `dist/modes/rpc/rpc-types.d.ts` (commands, responses,
 * extension UI), `docs/json.md` + `dist/core/agent-session.d.ts` (session
 * events) and `docs/message-types.md` (messages). Pi has no protocol-version
 * handshake, so every inbound record is validated and **unknown record types
 * are rejected** (the transport closes, the session fails) instead of being
 * ignored silently — schema drift must surface (docs/compat/pi.md §3.1).
 *
 * Objects are `looseObject`: Pi may add fields within a release line; only the
 * fields the adapter consumes are typed.
 */

const Text = z.looseObject({ type: z.literal('text'), text: z.string() });

export const PiUsage = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.looseObject({ total: z.number() }),
});
export type PiUsage = z.infer<typeof PiUsage>;

export const PiAssistantMessage = z.looseObject({
  role: z.literal('assistant'),
  content: z.array(z.looseObject({ type: z.string() })),
  provider: z.string(),
  model: z.string(),
  usage: PiUsage,
  stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
  errorMessage: z.string().optional(),
  timestamp: z.number(),
});
export type PiAssistantMessage = z.infer<typeof PiAssistantMessage>;

/** Any AgentMessage; only assistant messages are interpreted in detail. */
export const PiMessage = z.looseObject({ role: z.string() });

const ToolContent = z.array(z.looseObject({ type: z.string() }));

export const PiToolResult = z.looseObject({ content: ToolContent.optional() });

const PromptDisposition = z.string();

/** `RpcResponse` (rpc-types.d.ts). `id` is optional: a parse error carries none. */
export const PiResponse = z.looseObject({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export const PiPromptData = z.looseObject({ disposition: PromptDisposition });

export const PiStateData = z.looseObject({
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  isStreaming: z.boolean(),
  messageCount: z.number(),
  model: z.looseObject({ id: z.string(), provider: z.string() }).optional(),
});
export type PiStateData = z.infer<typeof PiStateData>;

/** `RpcExtensionUIRequest`. Dialog methods expect an `extension_ui_response`. */
export const PI_DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'] as const;
export const PiExtensionUiRequest = z.looseObject({
  type: z.literal('extension_ui_request'),
  id: z.string().min(1).max(256),
  method: z.enum([...PI_DIALOG_METHODS, 'notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']),
  title: z.string().optional(),
  options: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});
export type PiExtensionUiRequest = z.infer<typeof PiExtensionUiRequest>;

const ev = <T extends string, S extends z.core.$ZodLooseShape>(type: T, shape: S) =>
  z.looseObject({ type: z.literal(type), ...shape });

/** Session events (JSON event stream, shared by json and rpc modes) + RPC-only records. */
export const PiInbound = z.discriminatedUnion('type', [
  PiResponse,
  PiExtensionUiRequest,
  ev('agent_start', {}),
  ev('agent_end', { willRetry: z.boolean().optional() }),
  ev('agent_settled', { aborted: z.boolean() }),
  ev('turn_start', {}),
  ev('turn_end', {}),
  ev('message_start', { message: PiMessage }),
  ev('message_update', {}),
  ev('message_end', { message: PiMessage }),
  ev('tool_execution_start', { toolCallId: z.string(), toolName: z.string(), args: z.unknown().optional() }),
  ev('tool_execution_update', { toolCallId: z.string() }),
  ev('tool_execution_end', {
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown().optional(),
    isError: z.boolean(),
    durationMs: z.number().optional(),
  }),
  ev('queue_update', {}),
  ev('entry_appended', {}),
  ev('session_info_changed', {}),
  ev('thinking_level_changed', {}),
  ev('compaction_start', {}),
  ev('compaction_end', { aborted: z.boolean().optional(), errorMessage: z.string().optional() }),
  ev('auto_retry_start', {}),
  ev('auto_retry_end', { success: z.boolean(), finalError: z.string().optional() }),
  ev('summarization_retry_scheduled', {}),
  ev('summarization_retry_attempt_start', {}),
  ev('summarization_retry_finished', {}),
  ev('bash_execution_update', {}),
  ev('extension_error', { event: z.string().optional(), error: z.string().optional() }),
]);
export type PiInbound = z.infer<typeof PiInbound>;

/** Commands the adapter sends (subset of `RpcCommand`). */
export type PiCommand =
  | {
      type: 'prompt';
      message: string;
      /** pi 1.1.0 rpc-types.d.ts: `images?: ImageContent[]` (pi-ai `{type:'image', data, mimeType}`). */
      images?: { type: 'image'; data: string; mimeType: string }[];
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'get_state' }
  | { type: 'get_session_stats' }
  | { type: 'get_messages' };

/** `RpcExtensionUIResponse` without `type`/`id` (added by the codec). */
export type PiUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export function textBlocks(content: readonly { type: string }[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const parsed = Text.safeParse(block);
    if (parsed.success) parts.push(parsed.data.text);
  }
  return parts.join('');
}
