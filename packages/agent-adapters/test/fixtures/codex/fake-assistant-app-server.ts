#!/usr/bin/env node
/**
 * Stand-in for `codex app-server` driven by the Codex **assistant** engine (p5-ops-chat-next); never talks to
 * a model. Every line the client sends, plus argv and the environment names, is appended to
 * `<cwd>/.fake-codex-assistant.jsonl` so tests can assert the handshake, the thread/start parameters and the
 * answers to server requests. Notification shapes are typed against the protocol types generated from the
 * pinned 0.162.1 (`satisfies`).
 *
 * Scenario by the turn's text: "tool" → one `item/tool/call` (list_workers) then an answer quoting the result;
 * "foreign" → a tool call for `shell`; "approval" → a command approval request; "builtin" → a commandExecution
 * item starts; "long" → runs until turn/interrupt; "hang" → ignores turn/interrupt; "crash" → exits mid-turn;
 * "secret" → streams $CODEX_API_KEY split across two deltas; "codemode" → the model calls code mode's `exec`
 * (raw `custom_tool_call`, as a `code_mode_only` model does) and then narrates the failure; anything else →
 * "Hello world". Model tool calls are also reported as `rawResponseItem/completed` when the thread asked for
 * `experimentalRawEvents`.
 * Env: FAKE_MCP_SERVERS (JSON object) is returned by config/read; servers not disabled in the thread's config
 * report `mcpServer/startupStatus/updated`. FAKE_CODEX_VERSION changes the reported version.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ItemCompletedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/ItemCompletedNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { Turn } from '../../../src/runtimes/codex/protocol/generated/v2/Turn.js';
import type { TurnCompletedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/TurnCompletedNotification.js';

type Json = Record<string, unknown>;
/** `item/agentMessage/delta` params (v2/AgentMessageDeltaNotification of `generate-ts`, codex-cli 0.162.1; not vendored). */
interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

const version = process.env.FAKE_CODEX_VERSION ?? '0.164.0';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

const logFile = join(process.cwd(), '.fake-codex-assistant.jsonl');
const record = (entry: Json): void => {
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
record({
  start: true,
  argv: args,
  envNames: Object.keys(process.env),
  codexHome: process.env.CODEX_HOME ?? null,
});

const send = (msg: Json): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const notify = (method: string, params: unknown): void => {
  send({ method, params });
};

const threadId = '01a13336-2f88-7013-aa1f-c2a92bff8ce3';
let turnSeq = 0;
let nextServerId = 500;
const pendingServer = new Map<number, (msg: Json) => void>();
let interrupt: (() => void) | undefined;
let ignoreInterrupt = false;
let rawEvents = false;

/** `rawResponseItem/completed` of a model item (only when the thread opted in, like the real app-server). */
function raw(turnId: string, item: Json): void {
  if (rawEvents) notify('rawResponseItem/completed', { threadId, turnId, item });
}
const total = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };

function turn(id: string, status: Turn['status']): Turn {
  return {
    id,
    rootTurnId: id,
    items: [],
    itemsView: 'notLoaded',
    status,
    error:
      status === 'failed'
        ? { message: 'boom', codexErrorInfo: 'other', additionalDetails: null, misalignment: null }
        : null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 5,
  };
}

function serverRequest(method: string, params: unknown): Promise<Json> {
  const id = nextServerId++;
  return new Promise((resolve) => {
    pendingServer.set(id, resolve);
    send({ id, method, params });
  });
}

function delta(turnId: string, text: string): void {
  notify('item/agentMessage/delta', {
    threadId,
    turnId,
    itemId: 'msg_1',
    delta: text,
  } satisfies AgentMessageDeltaNotification);
}

function finishTurn(turnId: string, text: string, status: Turn['status'] = 'completed'): void {
  if (text !== '') {
    notify('item/completed', {
      item: {
        type: 'agentMessage',
        id: 'msg_1',
        text,
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
      threadId,
      turnId,
      completedAtMs: 1,
    } satisfies ItemCompletedNotification);
  }
  total.inputTokens += 100;
  total.cachedInputTokens += 10;
  total.outputTokens += 20;
  const last = {
    totalTokens: 120,
    inputTokens: 100,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
  };
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: { ...total, totalTokens: total.inputTokens + total.outputTokens, reasoningOutputTokens: 0 },
      last,
      modelContextWindow: null,
    },
  } satisfies ThreadTokenUsageUpdatedNotification);
  notify('turn/completed', { threadId, turn: turn(turnId, status) } satisfies TurnCompletedNotification);
}

async function runTurn(turnId: string, text: string): Promise<void> {
  notify('turn/started', { threadId, turn: turn(turnId, 'inProgress') });
  if (text.includes('crash')) {
    delta(turnId, 'partial');
    setTimeout(() => process.exit(3), 20);
    return;
  }
  if (text.includes('codemode')) {
    raw(turnId, { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: 'text(1)' });
    // Codex answers exec itself ("code-mode host is disabled") and the model narrates it.
    setTimeout(() => {
      delta(turnId, 'The code-mode host is disabled.');
      finishTurn(turnId, 'The code-mode host is disabled.');
    }, 50);
    return;
  }
  if (text.includes('builtin')) {
    notify('item/started', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: 'cmd_1', command: 'ls', status: 'inProgress' },
    });
    return;
  }
  if (text.includes('approval')) {
    const answer = await serverRequest('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      itemId: 'cmd_1',
      command: 'rm -rf /',
    });
    record({ approvalAnswer: answer });
    return;
  }
  if (text.includes('long') || text.includes('hang')) {
    ignoreInterrupt = text.includes('hang');
    delta(turnId, 'working');
    await new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    finishTurn(turnId, '', 'interrupted');
    return;
  }
  if (text.includes('secret')) {
    const s = process.env.CODEX_API_KEY ?? 'none';
    const half = Math.floor(s.length / 2);
    delta(turnId, `key: ${s.slice(0, half)}`);
    delta(turnId, `${s.slice(half)} end`);
    finishTurn(turnId, `key: ${s} end`);
    return;
  }
  if (text.includes('tool') || text.includes('foreign')) {
    const tool = text.includes('foreign') ? 'shell' : 'list_workers';
    if (!text.includes('foreign')) {
      raw(turnId, {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_x',
        name: tool,
        arguments: '{"limit":5}',
      });
    }
    notify('item/started', {
      threadId,
      turnId,
      item: {
        type: 'dynamicToolCall',
        id: 'call_x',
        tool,
        arguments: {},
        status: 'inProgress',
        success: null,
      },
    });
    const answer = await serverRequest('item/tool/call', {
      threadId,
      turnId,
      callId: 'call_x',
      namespace: null,
      tool,
      arguments: { limit: 5 },
    });
    record({ toolAnswer: answer });
    const result = answer.result as { contentItems: { text: string }[]; success: boolean };
    const quoted = `Result(${String(result.success)}): ${result.contentItems[0]?.text ?? ''}`;
    delta(turnId, quoted);
    finishTurn(turnId, quoted);
    return;
  }
  delta(turnId, 'Hello ');
  delta(turnId, 'world');
  finishTurn(turnId, 'Hello world');
}

let mcpServers: Json = {};
try {
  mcpServers = JSON.parse(process.env.FAKE_MCP_SERVERS ?? '{}') as Json;
} catch {
  mcpServers = {};
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line) as Json;
  record({ in: msg });
  const id = msg.id as number | string | undefined;
  const method = msg.method as string | undefined;
  if (method === undefined && typeof id === 'number' && pendingServer.has(id)) {
    const resolve = pendingServer.get(id);
    pendingServer.delete(id);
    resolve?.(msg);
    return;
  }
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          userAgent: `remyral-worker-assistant/${version} (Mac OS 26.6.0; arm64) unknown (remyral-worker-assistant; 1.0.0)`,
          codexHome: process.env.CODEX_HOME ?? '/home/user/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
      return;
    case 'initialized':
      return;
    case 'config/read':
      send({
        id,
        result: { config: { mcp_servers: mcpServers, model: 'gpt-5.4' }, origins: {}, layers: null },
      });
      return;
    case 'thread/start': {
      const p = msg.params as Json;
      rawEvents = p.experimentalRawEvents === true;
      send({
        id,
        result: {
          thread: { id: threadId },
          model: (p.model as string | undefined) ?? 'gpt-5.4',
          modelProvider: 'openai',
          approvalPolicy: process.env.FAKE_APPROVAL ?? p.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: { type: p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite', networkAccess: false },
          instructionSources: [],
          cwd: p.cwd,
        },
      });
      const disabled = ((p.config as Json | undefined)?.mcp_servers ?? {}) as Record<
        string,
        { enabled?: boolean }
      >;
      for (const name of Object.keys(mcpServers)) {
        if (disabled[name]?.enabled !== false) {
          notify('mcpServer/startupStatus/updated', { name, status: 'starting' });
        }
      }
      return;
    }
    case 'turn/start': {
      turnSeq += 1;
      const turnId = `turn-${String(turnSeq)}`;
      send({ id, result: { turn: turn(turnId, 'inProgress') } });
      const input = ((msg.params as Json).input as { text: string }[])[0]?.text ?? '';
      void runTurn(turnId, input);
      return;
    }
    case 'turn/interrupt':
      send({ id, result: {} });
      if (!ignoreInterrupt) interrupt?.();
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown ${String(method)}` } });
  }
});
rl.on('close', () => {
  process.exit(0);
});
