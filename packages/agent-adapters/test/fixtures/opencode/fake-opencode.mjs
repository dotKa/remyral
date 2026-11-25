#!/usr/bin/env node
/* global setTimeout, setInterval, clearInterval, Buffer */
// Fixture-driven stand-in for `opencode` 1.19.0 (`--version`, `providers list`,
// `serve`). It serves the subset of the HTTP API the adapter uses and emits the
// `/event` frames recorded from the pinned binary (fixtures/opencode/transcripts,
// 2026-10-13, scripted provider). Behaviour switches (env):
//   FAKE_OC_VERSION       version to report (default 1.19.4)
//   FAKE_OC_FAIL_OPEN=1   ignore OPENCODE_SERVER_PASSWORD (fail-open server)
//   FAKE_OC_DRIFT=1       effective config reports bash=allow (repo config leaked through)
//   FAKE_OC_LAUNCH_LOG    file: one JSON line per `serve` start ({ configContent })
//   FAKE_OC_IGNORE_MCP_OFF=1  report user MCP servers enabled even when OPENCODE_CONFIG_CONTENT disables them
// The effective `mcp` merges `$HOME/.opencode/opencode.json` (the user's global dir, which the real 1.19.0 loads
// despite private XDG dirs) under OPENCODE_CONFIG_CONTENT (the final merge), entry by entry.
// Scenarios (marker in the latest prompt): faux:long faux:longtool faux:approval faux:crash
//   faux:selfapprove (something else answers the permission) faux:drift (config changes mid-run)
//   faux:badevent (consumed event with an invalid shape)   (default = basic)
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const VERSION = process.env.FAKE_OC_VERSION ?? '1.19.4';
if (argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv[0] === 'providers') {
  process.stdout.write('┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n');
  process.exit(0);
}
if (argv[0] !== 'serve') process.exit(2);
if (process.env.FAKE_OC_ENV_FILE) {
  // Names and non-secret values only; the password is recorded as present/absent.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OPENCODE_') || k.startsWith('XDG_') || k === 'HOME') {
      env[k] = k === 'OPENCODE_SERVER_PASSWORD' ? 'set' : v;
    }
  }
  writeFileSync(process.env.FAKE_OC_ENV_FILE, JSON.stringify({ argv, env }));
}
if (process.env.FAKE_OC_LAUNCH_LOG) {
  appendFileSync(
    process.env.FAKE_OC_LAUNCH_LOG,
    `${JSON.stringify({ configContent: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}') })}\n`,
  );
}
const effectiveMcp = (() => {
  const file = `${process.env.HOME ?? '/nonexistent'}/.opencode/opencode.json`;
  const user = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).mcp ?? {}) : {};
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').mcp ?? {};
  const out = {};
  for (const name of new Set([...Object.keys(user), ...Object.keys(inline)])) {
    out[name] = { ...user[name], ...inline[name] };
    if (process.env.FAKE_OC_IGNORE_MCP_OFF && user[name]) out[name].enabled = user[name].enabled ?? true;
  }
  return out;
})();
const port = Number(argv[argv.indexOf('--port') + 1]);
const password = process.env.FAKE_OC_FAIL_OPEN ? undefined : process.env.OPENCODE_SERVER_PASSWORD;
const dbPath = process.env.OPENCODE_DB;
const permission = JSON.parse(process.env.OPENCODE_PERMISSION ?? '{}');
if (process.env.FAKE_OC_DRIFT) permission.bash = 'allow';

const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const sessions = dbPath && existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, 'utf8')) : {};
const save = () => dbPath && writeFileSync(dbPath, JSON.stringify(sessions));
const clients = new Set();
const emit = (type, properties) => {
  const frame = `data: ${JSON.stringify({ id: id('evt'), type, properties })}\n\n`;
  for (const res of clients) res.write(frame);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runs = new Map(); // sessionID -> { aborted, abort, queue: [] }
const permissions = new Map(); // per id -> resolve(reply)

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function runPrompt(sessionID, text) {
  const run = runs.get(sessionID);
  const s = sessions[sessionID];
  s.users = (s.users ?? 0) + 1;
  save();
  const userMsg = id('msg');
  emit('message.updated', {
    sessionID,
    info: { id: userMsg, role: 'user', sessionID, time: { created: Date.now() } },
  });
  emit('message.part.updated', {
    sessionID,
    part: { type: 'text', text, messageID: userMsg, sessionID, id: id('prt') },
    time: Date.now(),
  });
  emit('session.status', { sessionID, status: { type: 'busy' } });
  const assistant = id('msg');
  const info = {
    id: assistant,
    parentID: userMsg,
    role: 'assistant',
    sessionID,
    modelID: 'scripted',
    providerID: 'fake',
    time: { created: Date.now() },
  };
  emit('message.updated', { sessionID, info });
  const step = (tokens) => {
    emit('message.part.updated', {
      sessionID,
      part: { id: id('prt'), messageID: assistant, sessionID, type: 'step-start' },
      time: Date.now(),
    });
    return () =>
      emit('message.part.updated', {
        sessionID,
        part: {
          id: id('prt'),
          reason: 'stop',
          messageID: assistant,
          sessionID,
          type: 'step-finish',
          tokens,
          cost: 0.0012,
        },
        time: Date.now(),
      });
  };
  const tokens = { total: 107, input: 60, output: 7, reasoning: 0, cache: { write: 0, read: 40 } };
  if (text.includes('faux:crash')) process.exit(3);
  if (text.includes('faux:badevent')) emit('session.status', { sessionID, status: { type: 'exploded' } });
  if (text.includes('faux:drift')) permission.bash = 'allow';
  if (text.includes('faux:long')) {
    step(tokens);
    // p17-runtime-verify: "faux:longtool" — the long run starts a (never finishing) shell command first.
    if (text.includes('faux:longtool'))
      emit('message.part.updated', {
        sessionID,
        part: {
          id: id('prt'),
          messageID: assistant,
          sessionID,
          type: 'tool',
          tool: 'bash',
          callID: 'call_long',
          state: { status: 'running', input: { command: 'sleep 600' }, time: { start: Date.now() } },
        },
        time: Date.now(),
      });
    await run.aborted;
    emit('session.error', {
      sessionID,
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    });
    emit('session.status', { sessionID, status: { type: 'idle' } });
    emit('session.idle', { sessionID });
    runs.delete(sessionID);
    return;
  }
  // p14-mcp-core: "faux:mcp:<tool>" → one call of that MCP tool (`<server>_<tool>`), asked like every tool the
  // session ruleset says `ask` for (permission = the tool name, patterns ["*"]); "faux:mcpbypass:<tool>" → it runs
  // without asking (a runtime ignoring the ruleset).
  const mcpMatch = /faux:mcp(bypass)?:([A-Za-z0-9_-]+)/.exec(text);
  const mcpTool = mcpMatch?.[2];
  const mcpBypass = mcpMatch?.[1] !== undefined;
  const approval =
    (mcpTool !== undefined && !mcpBypass) ||
    text.includes('faux:approval') ||
    text.includes('faux:selfapprove');
  const callID = `call_${randomBytes(4).toString('hex')}`;
  const partId = id('prt');
  const tool = mcpTool ?? (approval ? 'bash' : 'read');
  const input =
    mcpTool !== undefined
      ? { q: 'hello' }
      : approval
        ? { command: 'echo approved > approved.txt', description: 'write file' }
        : { filePath: 'README.md' };
  const finish1 = step(tokens);
  const toolPart = (state) =>
    emit('message.part.updated', {
      sessionID,
      part: { id: partId, messageID: assistant, sessionID, type: 'tool', tool, callID, state },
      time: Date.now(),
    });
  toolPart({ status: 'pending', input: {}, raw: '' });
  toolPart({ status: 'running', input, time: { start: Date.now() } });
  let ok = approval || mcpBypass || text.includes('faux:leakpw');
  if (approval) {
    const perId = id('per');
    const reply = new Promise((resolve) => permissions.set(perId, resolve));
    emit('permission.asked', {
      id: perId,
      sessionID,
      permission: mcpTool ?? 'bash',
      patterns: mcpTool !== undefined ? ['*'] : ['echo approved > approved.txt'],
      metadata: mcpTool !== undefined ? {} : { command: input.command },
      always: mcpTool !== undefined ? ['*'] : ['echo *'],
      tool: { messageID: assistant, callID },
    });
    if (text.includes('faux:selfapprove')) {
      await sleep(20);
      emit('permission.replied', { sessionID, requestID: perId, reply: 'once' });
    }
    const answer = await Promise.race([reply, run.aborted.then(() => 'reject')]);
    ok = answer === 'once';
  }
  if (run.isAborted) {
    toolPart({ status: 'error', input, error: 'Tool execution aborted', time: { start: 1, end: 2 } });
    emit('session.error', {
      sessionID,
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    });
    emit('session.status', { sessionID, status: { type: 'idle' } });
    emit('session.idle', { sessionID });
    runs.delete(sessionID);
    return;
  }
  toolPart(
    ok
      ? {
          status: 'completed',
          input,
          output: text.includes('faux:leakpw') ? `pw=${process.env.OPENCODE_SERVER_PASSWORD ?? ''}` : 'ok',
          title: tool,
          metadata: {},
          time: { start: 1, end: 2 },
        }
      : {
          status: 'error',
          input,
          error: approval
            ? 'The user rejected permission to use this specific tool call.'
            : 'File not found: README.md',
          time: { start: 1, end: 2 },
        },
  );
  finish1();
  // As in 1.19.0: prompts queued while busy join the next model request of the running loop,
  // so the reply is computed from the latest user message.
  let latest = text;
  for (let queued = run.queue.shift(); queued !== undefined; queued = run.queue.shift()) {
    s.users += 1;
    latest = queued;
  }
  save();
  const finish2 = step(tokens);
  const textPart = id('prt');
  const answer = latest.includes('faux:history')
    ? `history:${String(s.users)}`
    : approval
      ? 'finished'
      : 'done';
  emit('message.part.updated', {
    sessionID,
    part: {
      id: textPart,
      messageID: assistant,
      sessionID,
      type: 'text',
      text: '',
      time: { start: Date.now() },
    },
    time: Date.now(),
  });
  emit('message.part.updated', {
    sessionID,
    part: {
      id: textPart,
      messageID: assistant,
      sessionID,
      type: 'text',
      text: answer,
      time: { start: 1, end: Date.now() },
    },
    time: Date.now(),
  });
  finish2();
  emit('session.status', { sessionID, status: { type: 'idle' } });
  emit('session.idle', { sessionID });
  runs.delete(sessionID);
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (password !== undefined) {
      const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
        res.end('Unauthorized');
        return;
      }
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = raw ? JSON.parse(raw) : undefined;
    const directory = url.searchParams.get('directory') ?? process.cwd();
    if (req.method === 'GET' && url.pathname === '/global/health')
      return json(res, 200, { healthy: true, version: VERSION });
    if (req.method === 'GET' && url.pathname === '/config')
      return json(res, 200, {
        share: 'disabled',
        permission,
        ...(Object.keys(effectiveMcp).length === 0 ? {} : { mcp: effectiveMcp }),
      });
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: id('evt'), type: 'server.connected', properties: {} })}\n\n`);
      clients.add(res);
      const hb = setInterval(
        () =>
          res.write(
            `data: ${JSON.stringify({ id: id('evt'), type: 'plugin.added', properties: { id: 'x' } })}\n\n`,
          ),
        2_000,
      );
      res.on('close', () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return undefined;
    }
    if (parts[0] === 'session' && req.method === 'POST' && parts.length === 1) {
      const sid = `ses_${randomBytes(12).toString('hex')}`;
      sessions[sid] = {
        id: sid,
        directory: realpathSync(directory),
        permission: body?.permission ?? [],
        users: 0,
      };
      save();
      if (process.env.FAKE_OC_RULESET_FILE) {
        writeFileSync(process.env.FAKE_OC_RULESET_FILE, JSON.stringify(body?.permission ?? []));
      }
      emit('session.created', { sessionID: sid, info: { id: sid, directory: sessions[sid].directory } });
      return json(res, 200, { id: sid, directory: sessions[sid].directory, version: VERSION, cost: 0 });
    }
    if (parts[0] === 'session' && parts.length >= 2) {
      const s = sessions[parts[1]];
      if (!s)
        return json(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${parts[1]}` } });
      if (parts.length === 2 && req.method === 'GET')
        return json(res, 200, { id: s.id, directory: s.directory, version: VERSION });
      if (parts[2] === 'prompt_async' && req.method === 'POST') {
        const text = (body?.parts ?? []).map((p) => p.text ?? '').join('');
        const busy = runs.get(s.id);
        // p15-message-delivery: "faux:refuse" while busy → the follow-up is refused.
        if (busy && text.includes('faux:refuse'))
          return json(res, 400, { name: 'BadRequest', data: { message: 'follow-up refused' } });
        if (busy) {
          busy.queue.push(text);
        } else {
          const run = { queue: [], isAborted: false };
          run.aborted = new Promise((resolve) => (run.abort = () => ((run.isAborted = true), resolve())));
          runs.set(s.id, run);
          void runPrompt(s.id, text);
        }
        res.writeHead(204);
        res.end();
        return undefined;
      }
      if (parts[2] === 'abort' && req.method === 'POST') {
        if (process.env.FAKE_OC_IGNORE_ABORT) return undefined; // never answers
        runs.get(s.id)?.abort();
        return json(res, 200, true);
      }
      if (parts[2] === 'message' && req.method === 'GET') return json(res, 200, []);
      if (parts[2] === 'diff' && req.method === 'GET') return json(res, 200, []);
    }
    if (parts[0] === 'permission' && parts[2] === 'reply' && req.method === 'POST') {
      const resolve = permissions.get(parts[1]);
      if (!resolve) return json(res, 404, { name: 'PermissionNotFoundError' });
      permissions.delete(parts[1]);
      const sessionID = Object.keys(sessions)[0];
      emit('permission.replied', { sessionID, requestID: parts[1], reply: body.reply });
      resolve(body.reply);
      return json(res, 200, true);
    }
    if (parts[0] === 'question' && parts[2] === 'reject') return json(res, 200, true);
    return json(res, 404, { name: 'NotFound' });
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${String(port)}\n`);
});
process.on('SIGTERM', () => process.exit(143));
