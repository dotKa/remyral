#!/usr/bin/env node
/* global setTimeout, clearTimeout, AbortController */
// Stand-in for `pi` 1.1.0 driven by the ops chat assistant engine (`--mode rpc`), with the record shapes of the
// pinned binary (recorded 2026-10-16 with the scripted faux provider). It loads the engine's REAL tool-bridge
// extension (the `-e` file named remyral-assistant-tools.mjs) through a minimal ExtensionAPI, so the bridge's own
// code relays every tool call over the extension-UI sub-protocol, exactly as Pi runs it.
// Scenarios (marker in the prompt):
//   fake:tool      the "model" calls list_workers {state:"online"}, then answers "got: <result>|<isError>"
//   fake:badtool   the "model" calls list_workers with an argument the schema refuses (handled by Pi; here: relayed)
//   fake:foreign   asks a foreign select dialog, then calls `bash` (the bridge must block it)
//   fake:two       two assistant messages with text (separator test)
//   fake:long      thinks until `abort`
//   fake:stuck     ignores `abort`
//   fake:crash     exits 3 mid-turn
//   fake:error     the model request fails (stopReason error)
//   fake:secret    streams the value of $REMYRAL_TEST_KEY split over two deltas
//   (default)      "Echo: <prompt>" streamed in pieces
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? '1.6.0'}\n`);
  process.exit(0);
}
if (process.env.FAKE_PI_ARGV_FILE) {
  writeFileSync(
    process.env.FAKE_PI_ARGV_FILE,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env).sort(),
      agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    }),
  );
}
if (process.env.FAKE_PI_FAIL_START === '1') process.exit(4);

const out = (r) => process.stdout.write(JSON.stringify(r) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extensions = argv.flatMap((a, i) => (a === '-e' ? [argv[i + 1]] : []));

// ---- minimal ExtensionAPI ------------------------------------------------------------------------------------
const tools = new Map();
const toolCallHandlers = [];
const dialogs = new Map();
const api = {
  registerTool(def) {
    tools.set(def.name, def);
  },
  on(event, handler) {
    if (event === 'tool_call') toolCallHandlers.push(handler);
  },
};
function dialog(request, opts) {
  const id = randomUUID();
  return new Promise((resolve) => {
    let timer;
    const done = (v) => {
      clearTimeout(timer);
      dialogs.delete(id);
      resolve(v);
    };
    if (opts?.timeout) timer = setTimeout(() => done(undefined), opts.timeout);
    opts?.signal?.addEventListener('abort', () => done(undefined), { once: true });
    dialogs.set(id, (r) => done(r.cancelled ? undefined : r.value));
    out({
      type: 'extension_ui_request',
      id,
      ...request,
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    });
  });
}
const ctx = {
  hasUI: true,
  mode: 'rpc',
  ui: {
    input: (title, placeholder, opts) => dialog({ method: 'input', title, placeholder }, opts),
    select: (title, options, opts) => dialog({ method: 'select', title, options }, opts),
  },
};
for (const file of extensions) {
  if (!file.endsWith('remyral-assistant-tools.mjs')) continue;
  const mod = await import(pathToFileURL(file).href);
  mod.default(api);
}

// ---- model ------------------------------------------------------------------------------------------------------
const MODEL = { provider: 'remyral-faux', model: 'scripted' };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.25 } };
let abortTurn = null;
const assistant = (content, stopReason = 'stop', extra = {}) => ({
  role: 'assistant',
  content,
  ...MODEL,
  usage,
  stopReason,
  timestamp: Date.now(),
  ...extra,
});
async function say(text, pieces = 3) {
  out({ type: 'message_start', message: assistant([], 'pending') });
  const size = Math.max(1, Math.ceil(text.length / pieces));
  for (let i = 0; i < text.length; i += size) {
    out({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: text.slice(i, i + size) },
    });
    await sleep(2);
  }
  out({ type: 'message_end', message: assistant([{ type: 'text', text }]) });
}
async function callTool(name, args) {
  for (const h of toolCallHandlers) {
    const r = await h({ toolName: name, toolCallId: 't1', input: args }, ctx);
    if (r?.block) return { blocked: r.reason };
  }
  const tool = tools.get(name);
  if (!tool) return { blocked: 'no such tool' };
  out({ type: 'tool_execution_start', toolCallId: 't1', toolName: name, args });
  const r = await tool.execute('t1', args, new AbortController().signal, undefined, ctx);
  out({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: name,
    result: r,
    isError: r.isError === true,
  });
  return r;
}

async function run(message) {
  out({ type: 'agent_start' });
  let aborted = false;
  if (message.includes('fake:tool') || message.includes('fake:badtool')) {
    const r = await callTool(
      'list_workers',
      message.includes('fake:badtool') ? { nope: 1 } : { state: 'online' },
    );
    await say(`got: ${r.content?.[0]?.text ?? r.blocked}|${String(r.isError === true)}`);
  } else if (message.includes('fake:foreign')) {
    const v = await ctx.ui.select('Allow something?', ['yes', 'no'], { timeout: 5_000 });
    const r = await callTool('bash', { command: 'id' });
    await say(`foreign:${v === undefined ? 'cancelled' : v} bash:${r.blocked ? 'blocked' : 'ran'}`);
  } else if (message.includes('fake:two')) {
    await say('first');
    await say('second');
  } else if (message.includes('fake:long') || message.includes('fake:stuck')) {
    out({ type: 'message_start', message: assistant([], 'pending') });
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'thinking' } });
    const ignore = message.includes('fake:stuck');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 600_000);
      abortTurn = () => {
        if (ignore) return;
        clearTimeout(t);
        resolve();
      };
    });
    abortTurn = null;
    out({ type: 'message_end', message: assistant([{ type: 'text', text: 'thinking' }], 'aborted') });
    aborted = true;
  } else if (message.includes('fake:crash')) {
    out({ type: 'message_start', message: assistant([], 'pending') });
    process.stderr.write('fake-pi: crashed on purpose\n');
    process.exit(3);
  } else if (message.includes('fake:error')) {
    out({ type: 'message_start', message: assistant([], 'pending') });
    out({ type: 'message_end', message: assistant([], 'error', { errorMessage: 'provider said no' }) });
  } else if (message.includes('fake:secret')) {
    const v = process.env.REMYRAL_TEST_KEY ?? 'none';
    const half = Math.floor(v.length / 2);
    out({ type: 'message_start', message: assistant([], 'pending') });
    out({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: `key ${v.slice(0, half)}` },
    });
    out({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: `${v.slice(half)} end` },
    });
    out({ type: 'message_end', message: assistant([{ type: 'text', text: `key ${v} end` }]) });
  } else {
    await say(`Echo: ${message.slice(-60)}`);
  }
  out({ type: 'agent_end', messages: [] });
  out({ type: 'agent_settled', aborted });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'extension_ui_response') {
    dialogs.get(cmd.id)?.(cmd);
    return;
  }
  if (cmd.type === 'get_state') {
    out({
      id: cmd.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId: randomUUID(),
        isStreaming: false,
        messageCount: 0,
        model: { id: 'scripted', provider: 'remyral-faux' },
      },
    });
    return;
  }
  if (cmd.type === 'prompt') {
    out({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    void run(cmd.message);
    return;
  }
  if (cmd.type === 'abort') {
    out({ id: cmd.id, type: 'response', command: 'abort', success: true });
    abortTurn?.();
    return;
  }
  out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'unsupported' });
});
rl.on('close', () => process.exit(0));
