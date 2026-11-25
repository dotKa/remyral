/* global setInterval, clearInterval */
// Scripted OpenAI-compatible chat-completions server on 127.0.0.1 for the *real* OpenCode binary driven by the
// assistant engine (tests only: no model, no credentials, no external network). Prints its port on stdout.
// `GET /requests` returns every recorded chat request as {tools: [names], system, users}.
// Scenario = marker in the latest user message:
//   faux:tool      calls remyral_list_workers {"state":"online"}, then answers "workers: <tool result>"
//   faux:foreign   calls the built-in `bash` tool (must not exist for the assistant), then "ran"
//   faux:hang      streams one chunk, then keeps the response open (until aborted)
//   (default)      answers "hello " + "world" in two chunks
import { createServer } from 'node:http';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('');
  return '';
}

const requests = [];

function plan(body) {
  const msgs = body.messages ?? [];
  const users = msgs.filter((m) => m.role === 'user');
  const last = textOf(users.at(-1)?.content);
  const lastUser = msgs.lastIndexOf(users.at(-1));
  const toolMsgs = msgs.slice(lastUser).filter((m) => m.role === 'tool');
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { kind: 'text', parts: ['title'] };
  if (last.includes('faux:hang')) return { kind: 'hang' };
  if (last.includes('faux:tool')) {
    return toolMsgs.length === 0
      ? { kind: 'tool', name: 'remyral_list_workers', args: { state: 'online' } }
      : { kind: 'text', parts: ['workers: ', textOf(toolMsgs.at(-1).content)] };
  }
  if (last.includes('faux:foreign')) {
    return toolMsgs.length === 0
      ? { kind: 'tool', name: 'bash', args: { command: 'echo pwned', description: 'x' } }
      : { kind: 'text', parts: ['ran'] };
  }
  return { kind: 'text', parts: ['hello ', 'world'] };
}

let calls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests));
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // empty body
    }
    const msgs = body.messages ?? [];
    requests.push({
      tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
      system: msgs
        .filter((m) => m.role === 'system')
        .map((m) => textOf(m.content))
        .join('\n'),
      users: msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)),
    });
    calls += 1;
    const p = plan(body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `chatcmpl-${String(calls)}`;
    const chunk = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'scripted', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    if (p.kind === 'hang') {
      chunk({ role: 'assistant', content: 'thinking' });
      const t = setInterval(() => res.write(': keepalive\n\n'), 1000);
      res.on('close', () => clearInterval(t));
      return;
    }
    chunk({ role: 'assistant', content: '' });
    if (p.kind === 'text') {
      for (const part of p.parts) chunk({ content: part });
      chunk({}, 'stop');
    } else {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${String(calls)}`,
            type: 'function',
            function: { name: p.name, arguments: JSON.stringify(p.args) },
          },
        ],
      });
      chunk({}, 'tool_calls');
    }
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'scripted', choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${String(server.address().port)}\n`);
});
process.on('SIGTERM', () => process.exit(0));
