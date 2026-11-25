#!/usr/bin/env node
/* global setTimeout, Buffer, fetch */
// Stand-in for `opencode` 1.19.0 as the assistant engine drives it (`--version`, `serve`): the HTTP routes the
// engine uses, `/event` frames shaped like the pinned binary's, and — for `faux:tool` — an MCP client that calls
// the engine's loopback endpoint exactly as the configured `remote` MCP server (URL and `{env:…}` header from
// OPENCODE_CONFIG_CONTENT). Switches (env):
//   FAKE_OC_VERSION       version to report (default 1.19.4)
//   FAKE_OC_ENV_FILE      write {argv, env (OPENCODE_*, XDG_*, HOME; secrets as "set"), tokenSet} there
//   FAKE_OC_DRIFT=1       effective config reports permission bash=allow
// Scenarios (marker in the prompt): faux:tool  faux:hang  faux:crash  faux:foreign  faux:secret  (default: text)
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const VERSION = process.env.FAKE_OC_VERSION ?? '1.19.4';
if (argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv[0] !== 'serve') process.exit(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
if (process.env.FAKE_OC_ENV_FILE) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OPENCODE_') || k.startsWith('XDG_') || k === 'HOME' || k.startsWith('REMYRAL_')) {
      env[k] = k === 'OPENCODE_SERVER_PASSWORD' || k === 'REMYRAL_ASSISTANT_MCP_TOKEN' ? 'set' : v;
    }
  }
  writeFileSync(process.env.FAKE_OC_ENV_FILE, JSON.stringify({ argv, env }));
}
const port = Number(argv[argv.indexOf('--port') + 1]);
const password = process.env.OPENCODE_SERVER_PASSWORD;
const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const clients = new Set();
const emit = (type, properties) => {
  const frame = `data: ${JSON.stringify({ id: id('evt'), type, properties })}\n\n`;
  for (const res of clients) res.write(frame);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sessionID;
let aborted = null;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** Header value with `{env:NAME}` substituted, like OpenCode's config loader. */
function substitute(v) {
  return v.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_m, n) => process.env[n] ?? '');
}

async function mcp(method, params, id = 1) {
  const server = config.mcp?.remyral;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const [k, v] of Object.entries(server.headers ?? {})) headers[k] = substitute(v);
  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json();
}

function text(messageID, partID, value, done) {
  emit('message.part.updated', {
    sessionID,
    part: {
      id: partID,
      messageID,
      sessionID,
      type: 'text',
      text: value,
      time: done ? { start: 1, end: 2 } : { start: 1 },
    },
  });
}

async function run(prompt) {
  const user = id('msg');
  emit('message.updated', { sessionID, info: { id: user, role: 'user', sessionID } });
  emit('message.part.updated', {
    sessionID,
    part: { id: id('prt'), messageID: user, sessionID, type: 'text', text: prompt },
  });
  emit('session.status', { sessionID, status: { type: 'busy' } });
  const msg = id('msg');
  emit('message.updated', {
    sessionID,
    info: { id: msg, role: 'assistant', sessionID, modelID: 'scripted', providerID: 'fake' },
  });
  const part = id('prt');
  if (prompt.includes('faux:crash')) process.exit(3);
  if (prompt.includes('faux:hang')) {
    text(msg, part, 'thinking', false);
    await new Promise((r) => (aborted = r));
    emit('session.error', {
      sessionID,
      error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
    });
    emit('session.status', { sessionID, status: { type: 'idle' } });
    return;
  }
  if (prompt.includes('faux:foreign')) {
    emit('message.part.updated', {
      sessionID,
      part: {
        id: id('prt'),
        messageID: msg,
        sessionID,
        type: 'tool',
        tool: 'bash',
        callID: 'c1',
        state: { status: 'completed', input: {}, output: 'pwned' },
      },
    });
    await sleep(50);
    emit('session.status', { sessionID, status: { type: 'idle' } });
    return;
  }
  let answer = 'hello world';
  if (prompt.includes('faux:tool')) {
    const init = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-opencode', version: '1' },
    });
    const list = await mcp('tools/list', {}, 2);
    const call = await mcp('tools/call', { name: 'list_workers', arguments: { state: 'online' } }, 3);
    emit('message.part.updated', {
      sessionID,
      part: {
        id: id('prt'),
        messageID: msg,
        sessionID,
        type: 'tool',
        tool: 'remyral_list_workers',
        callID: 'c1',
        state: { status: 'completed', input: { state: 'online' }, output: 'x' },
      },
    });
    answer = `init:${init.result?.serverInfo?.name} tools:${String(list.result?.tools?.length)} result:${call.result?.content?.[0]?.text}`;
  }
  if (prompt.includes('faux:secret')) {
    const v = process.env[process.env.FAKE_SECRET_NAME ?? ''] ?? '';
    answer = `key ${v} end`;
  }
  const half = Math.floor(answer.length / 2);
  text(msg, part, answer.slice(0, half), false);
  await sleep(20);
  text(msg, part, answer, true);
  emit('message.part.updated', {
    sessionID,
    part: {
      id: id('prt'),
      messageID: msg,
      sessionID,
      type: 'step-finish',
      reason: 'stop',
      cost: 0.25,
      tokens: { input: 100, output: 7, reasoning: 3, cache: { read: 40, write: 0 } },
    },
  });
  emit('session.status', { sessionID, status: { type: 'idle' } });
}

const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  const ok = auth === `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  if (!ok) return json(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw);
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true, version: VERSION });
    if (url.pathname === '/config') {
      const permission = { ...config.permission };
      if (process.env.FAKE_OC_DRIFT) permission.bash = 'allow';
      return json(res, 200, { ...config, permission });
    }
    if (url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      clients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      res.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/session' && req.method === 'POST') {
      sessionID = `ses_${randomBytes(8).toString('hex')}`;
      emit('session.created', { sessionID, info: { id: sessionID } });
      return json(res, 200, {
        id: sessionID,
        directory: url.searchParams.get('directory'),
        agent: body.agent,
      });
    }
    const m = /^\/session\/(ses_[A-Za-z0-9]+)\/(prompt_async|abort)$/.exec(url.pathname);
    if (m && m[2] === 'prompt_async') {
      json(res, 204);
      void run(body.parts?.[0]?.text ?? '');
      return;
    }
    if (m && m[2] === 'abort') {
      aborted?.();
      aborted = null;
      return json(res, 200, true);
    }
    return json(res, 404, { error: 'not found' });
  });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
