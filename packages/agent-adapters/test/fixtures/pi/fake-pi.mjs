#!/usr/bin/env node
/* global setTimeout, clearTimeout, Buffer */
// Fixture-driven stand-in for `pi` 1.1.0 (`--version`, `auth check`, `--mode rpc`).
// It replays the record shapes captured from the pinned binary
// (fixtures/pi/transcripts/*.jsonl, recorded 2026-10-13 with the scripted provider)
// and loads the adapter's real permission-gate extension (the `-e` file named
// remyral-permission-gate.mjs) through a minimal ExtensionAPI, so the gate's own
// code decides every tool call — exactly as Pi does (handler block / throw = block,
// dialog timeout = undefined). Scenarios (marker in the latest prompt):
//   faux:long  faux:longtool  faux:approval  faux:crash  faux:badline  (default = basic)
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const VERSION = process.env.FAKE_PI_VERSION ?? '1.4.0';

if (argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv[0] === 'auth') {
  process.stdout.write(
    JSON.stringify({ status: 'not_ready', provider: 'x', reason: 'credentials_not_configured' }) + '\n',
  );
  process.exit(1);
}
if (argv[argv.indexOf('--mode') + 1] !== 'rpc') {
  process.stderr.write('fake-pi: only --mode rpc is emulated\n');
  process.exit(2);
}

const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const extensions = argv.flatMap((a, i) => (a === '-e' ? [argv[i + 1]] : []));
const sessionId = arg('--session-id') ?? randomUUID();
const sessionDir = arg('--session-dir') ?? '/tmp';
const sessionFile = join(sessionDir, `fake_${sessionId}.jsonl`);
const modelArg = arg('--model') ?? 'remyral-faux/scripted';
const [provider, modelId] = modelArg.includes('/') ? modelArg.split('/') : ['remyral-faux', modelArg];

// Record the argv so tests can assert the policy flags the adapter passed.
if (process.env.FAKE_PI_ARGV_FILE) writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(argv));

const out = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const response = (id, command, data) =>
  out({
    ...(id !== undefined ? { id } : {}),
    type: 'response',
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal ExtensionAPI for the gate ---------------------------------------------------------
const toolCallHandlers = [];
const dialogs = new Map();
// p14-mcp-core: what the adapter's MCP extension registers (recorded with the env names its headers reference).
const mcpRegistrations = [];
const piApi = {
  on(event, handler) {
    if (event === 'tool_call') toolCallHandlers.push(handler);
  },
  registerMcpServer(name, config) {
    if (!argv.includes('builtin:mcp') || argv.includes('--no-mcp')) throw new Error('MCP is disabled');
    mcpRegistrations.push({ name, config });
  },
};
const uiCtx = {
  hasUI: true,
  mode: 'rpc',
  ui: {
    select(title, options, opts) {
      const id = randomUUID();
      out({
        type: 'extension_ui_request',
        id,
        method: 'select',
        title,
        options,
        ...(opts?.timeout ? { timeout: opts.timeout } : {}),
      });
      return new Promise((resolve) => {
        const timer = opts?.timeout
          ? setTimeout(() => (dialogs.delete(id), resolve(undefined)), opts.timeout)
          : undefined;
        dialogs.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer.cancelled ? undefined : answer.value);
        });
      });
    },
  },
};
for (const path of extensions) {
  if (path.endsWith('remyral-permission-gate.mjs') || path.endsWith('remyral-mcp-servers.mjs')) {
    const mod = await import(pathToFileURL(path).href);
    mod.default(piApi);
  }
}
if (process.env.FAKE_PI_MCP_FILE) {
  // `${VAR}` references resolve from the environment (Pi expands them; a missing one is an error).
  const resolved = mcpRegistrations.map((r) => ({
    name: r.name,
    config: r.config,
    missingEnv: Object.values(r.config.headers ?? {})
      .flatMap((v) => [...String(v).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]))
      .filter((n) => process.env[n] === undefined),
    agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
  }));
  writeFileSync(process.env.FAKE_PI_MCP_FILE, JSON.stringify(resolved));
}

// ---- recorded shapes ------------------------------------------------------------------------
let clock = 1791857793867;
const usage = (input, output) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: input,
  totalTokens: input * 2 + output,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
});
const assistant = (content, stopReason, u, extra = {}) => ({
  role: 'assistant',
  content,
  api: 'faux:1:fixture',
  provider,
  model: modelId,
  usage: u,
  stopReason,
  timestamp: clock++,
  ...extra,
});

let run; // { aborted, abort(), done }
let messageCount = 0;
const queue = [];

async function runTool(toolCallId, toolName, args) {
  out({ type: 'tool_execution_start', toolCallId, toolName, args });
  let block;
  for (const h of toolCallHandlers) {
    try {
      const r = await h({ type: 'tool_call', toolCallId, toolName, input: args }, uiCtx);
      if (r?.block) {
        block = r.reason ?? 'blocked';
        break;
      }
    } catch (error) {
      block = `Extension error: ${error.message}`;
      break;
    }
  }
  if (run.aborted) {
    out({
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      result: { content: [{ type: 'text', text: 'Command aborted' }], details: {} },
      isError: true,
    });
    return false;
  }
  if (block) {
    out({
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      result: { content: [{ type: 'text', text: block }], details: {} },
      isError: true,
    });
    return false;
  }
  out({ type: 'tool_execution_update', toolCallId, toolName, args, partialResult: { content: [] } });
  const text = toolName === 'read' ? 'File not found: README.md' : 'ok\n';
  out({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text }], details: {} },
    isError: toolName === 'read',
    durationMs: 3,
  });
  return true;
}

async function turn(content, stopReason) {
  out({ type: 'turn_start' });
  const msg = assistant(content, stopReason, usage(1508, 10));
  out({ type: 'message_start', message: { ...msg, content: [], stopReason: 'pending' } });
  out({
    type: 'message_update',
    usage: msg.usage,
    assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
  });
  out({ type: 'message_end', message: msg });
  return msg;
}

async function startRun(message) {
  const r = { aborted: false };
  const aborted = new Promise((resolve) => (r.abort = () => ((r.aborted = true), resolve())));
  run = r;
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  out({
    type: 'message_start',
    message: { role: 'system', content: '', sections: { preamble: 'fixture' }, timestamp: clock },
  });
  out({
    type: 'message_end',
    message: { role: 'system', content: '', sections: { preamble: 'fixture' }, timestamp: clock },
  });
  out({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: message }], timestamp: clock },
  });
  out({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: message }], timestamp: clock },
  });
  messageCount += 2;
  if (message.includes('faux:crash')) {
    process.stderr.write('fatal: simulated crash\n');
    process.exit(3);
  }
  if (message.includes('faux:badline')) {
    out({ type: 'totally_unknown_record', x: 1 });
  }
  if (message.includes('faux:long')) {
    // p17-runtime-verify: "faux:longtool" — the long run starts a (never finishing) shell command first.
    if (message.includes('faux:longtool'))
      out({
        type: 'tool_execution_start',
        toolCallId: 'tool:long:fixture',
        toolName: 'bash',
        args: { command: 'sleep 600' },
      });
    await aborted;
    const m = assistant([], 'aborted', usage(1514, 0), { errorMessage: 'Request was aborted' });
    out({ type: 'message_start', message: { ...m, stopReason: 'pending' } });
    out({ type: 'message_end', message: m });
    out({ type: 'turn_end', message: m, toolResults: [] });
    out({ type: 'agent_end', messages: [m], willRetry: false });
    out({ type: 'agent_settled', aborted: true });
    run = undefined;
    return;
  }
  const approval = message.includes('faux:approval');
  // p14-mcp-core: "faux:mcp:<tool name>" → one call of that (MCP) tool.
  const mcpTool = /faux:mcp:([A-Za-z0-9_]+)/.exec(message)?.[1];
  const toolName = mcpTool ?? (approval ? 'bash' : 'read');
  const args =
    mcpTool !== undefined
      ? { q: 'hello' }
      : approval
        ? { command: 'echo approved > approved.txt' }
        : { path: 'README.md' };
  const toolCallId = `tool:${String(clock)}:fixture`;
  const first = assistant(
    [
      { type: 'text', text: approval ? 'need to write' : 'ack' },
      { type: 'toolCall', id: toolCallId, name: toolName, arguments: args },
    ],
    'toolUse',
    usage(1508, 10),
  );
  out({ type: 'message_start', message: { ...first, content: [], stopReason: 'pending' } });
  out({
    type: 'message_update',
    usage: first.usage,
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: toolCallId, toolName },
  });
  out({ type: 'message_end', message: first });
  await runTool(toolCallId, toolName, args);
  out({ type: 'turn_end', message: first, toolResults: [] });
  if (run?.aborted) {
    out({ type: 'agent_end', messages: [], willRetry: false });
    out({ type: 'agent_settled', aborted: true });
    run = undefined;
    return;
  }
  await sleep(Number(process.env.FAKE_PI_STEP_MS ?? 5));
  const final = await turn(
    [{ type: 'text', text: approval ? 'finished' : `done: ${message.slice(0, 40)}` }],
    'stop',
  );
  out({ type: 'turn_end', message: final, toolResults: [] });
  out({ type: 'agent_end', messages: [final], willRetry: false });
  out({ type: 'agent_settled', aborted: false });
  messageCount += 2;
  run = undefined;
}

// ---- RPC loop ---------------------------------------------------------------------------
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a)) {
    const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
    buf = buf.subarray(nl + 1);
    if (line.trim() !== '') void handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(143));

async function handle(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (error) {
    out({
      type: 'response',
      command: 'parse',
      success: false,
      error: `Failed to parse command: ${error.message}`,
    });
    return;
  }
  const id = cmd.id;
  switch (cmd.type) {
    case 'get_state':
      await sleep(Number(process.env.FAKE_PI_STARTUP_MS ?? 0));
      response(id, 'get_state', {
        model: { id: modelId, name: modelId, api: 'faux:1:fixture', provider },
        thinkingLevel: 'off',
        isStreaming: run !== undefined,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        sessionFile,
        sessionId: process.env.FAKE_PI_WRONG_SESSION ? randomUUID() : sessionId,
        autoCompactionEnabled: true,
        messageCount,
        pendingMessageCount: queue.length,
      });
      return;
    case 'prompt':
      if (run) {
        out({
          id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: 'Agent is already processing. Specify streamingBehavior.',
        });
        return;
      }
      if (process.env.FAKE_PI_NO_AUTH) {
        out({
          id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: 'No API key found for the selected model.',
        });
        return;
      }
      response(id, 'prompt', { disposition: 'started' });
      void startRun(String(cmd.message));
      return;
    case 'steer':
    case 'follow_up':
      // p15-message-delivery: "faux:refuse" → the steer is refused.
      if (String(cmd.message).includes('faux:refuse')) {
        out({ id, type: 'response', command: cmd.type, success: false, error: 'steering refused' });
        return;
      }
      queue.push(String(cmd.message));
      out({
        type: 'queue_update',
        steering: cmd.type === 'steer' ? [...queue] : [],
        followUp: cmd.type === 'follow_up' ? [...queue] : [],
      });
      response(id, cmd.type, { disposition: 'queued' });
      return;
    case 'clear_queue': {
      const steering = queue.splice(0);
      out({ type: 'queue_update', steering: [], followUp: [] });
      response(id, 'clear_queue', { steering, followUp: [] });
      return;
    }
    case 'abort':
      if (process.env.FAKE_PI_IGNORE_ABORT) return; // never answers: forces the adapter's kill path
      if (run) {
        run.abort();
        for (const [dialogId, resolve] of dialogs) {
          dialogs.delete(dialogId);
          resolve({ cancelled: true });
        }
        while (run) await sleep(1);
      }
      response(id, 'abort');
      return;
    case 'extension_ui_response': {
      const resolve = dialogs.get(cmd.id);
      if (resolve) {
        dialogs.delete(cmd.id);
        resolve(cmd);
      }
      return;
    }
    case 'get_session_stats':
      response(id, 'get_session_stats', {
        sessionFile,
        sessionId,
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 5,
        tokens: { input: 1526, output: 11, cacheRead: 1508, cacheWrite: 1526, total: 4571 },
        cost: 0,
      });
      return;
    default:
      out({ id, type: 'response', command: cmd.type, success: false, error: `Unknown command: ${cmd.type}` });
  }
}
