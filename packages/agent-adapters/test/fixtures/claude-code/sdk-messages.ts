/**
 * SDKMessage fixtures for the Claude Code adapter tests. Every builder returns
 * a value typed against the pinned `@anthropic-ai/claude-agent-sdk@0.3.296`
 * declarations (sdk.d.ts) — the compiler rejects any shape the real SDK would
 * not produce. No message here was invented field by field: field names and
 * optionality come from the SDK typings; values are synthetic.
 */
import { randomUUID } from 'node:crypto';
import type {
  ModelUsage,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export const FIXTURE_MODEL = 'claude-sonnet-5';

export function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cacheWrite },
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    fallback_credit: null,
    inference_geo: 'us',
    input_tokens: input,
    iterations: [],
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

export interface CumulativeUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

export function modelUsage(u: CumulativeUsage, provider = 'firstParty'): ModelUsage {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadInputTokens: u.cacheRead,
    cacheCreationInputTokens: u.cacheWrite,
    webSearchRequests: 0,
    costUSD: u.costUsd,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    canonicalModel: FIXTURE_MODEL,
    provider,
    costBasis: 'list',
  };
}

export function initMessage(
  sessionId: string,
  permissionMode: SDKSystemMessage['permissionMode'],
  cwd: string,
): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.310',
    cwd,
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
    mcp_servers: [],
    model: FIXTURE_MODEL,
    permissionMode,
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function assistantBase(sessionId: string): Omit<SDKAssistantMessage, 'message'> {
  return { type: 'assistant', parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId };
}

function betaMessage(content: SDKAssistantMessage['message']['content']): SDKAssistantMessage['message'] {
  return {
    id: `msg_${randomUUID()}`,
    container: null,
    content,
    context_management: null,
    diagnostics: null,
    model: FIXTURE_MODEL,
    role: 'assistant',
    stop_details: null,
    stop_reason: null,
    stop_sequence: null,
    type: 'message',
    usage: { ...usage(10, 5) },
  };
}

export function assistantText(sessionId: string, text: string): SDKAssistantMessage {
  return { ...assistantBase(sessionId), message: betaMessage([{ type: 'text', text, citations: null }]) };
}

export function assistantToolUse(
  sessionId: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
): SDKAssistantMessage {
  return { ...assistantBase(sessionId), message: betaMessage([{ type: 'tool_use', id, name, input }]) };
}

export function userToolResult(
  sessionId: string,
  toolUseId: string,
  content: string,
  isError = false,
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

export function resultSuccess(
  sessionId: string,
  text: string,
  cumulative: CumulativeUsage,
  turn: { numTurns: number; durationMs: number; queued?: number },
): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: turn.durationMs,
    duration_api_ms: Math.floor(turn.durationMs / 2),
    is_error: false,
    num_turns: turn.numTurns,
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: cumulative.costUsd,
    usage: usage(cumulative.input, cumulative.output, cumulative.cacheRead, cumulative.cacheWrite),
    modelUsage: { [FIXTURE_MODEL]: modelUsage(cumulative) },
    permission_denials: [],
    queued_turn_count: turn.queued ?? 0,
    terminal_reason: 'completed',
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

export function resultInterrupted(sessionId: string, cumulative: CumulativeUsage): SDKResultError {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 50,
    duration_api_ms: 10,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: cumulative.costUsd,
    usage: usage(cumulative.input, cumulative.output),
    modelUsage: { [FIXTURE_MODEL]: modelUsage(cumulative) },
    permission_denials: [],
    errors: ['Request was aborted.'],
    terminal_reason: 'aborted_streaming',
    uuid: randomUUID(),
    session_id: sessionId,
  };
}
