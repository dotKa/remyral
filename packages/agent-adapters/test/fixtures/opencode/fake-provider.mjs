/* global setInterval, clearInterval */
// Scripted OpenAI-compatible chat-completions server on 127.0.0.1 for the *real*
// OpenCode binary (tests only: no model, no credentials, no external network).
// OpenCode reaches it through a config provider `{npm: "@ai-sdk/openai-compatible",
// options: {baseURL}}` (bundled in the 1.19.0 binary). Prints its port on stdout.
// Scenario = marker in the latest user message:
//   faux:long        streams one chunk, then keeps the response open (until aborted)
//   faux:approval    bash `echo approved > approved.txt`, then "finished"
//   faux:sleep:<n>   bash `sleep <n> & sleep <n+1>`, then "slept"
//   faux:webfetch    webfetch https://example.com (denied by policy), then "fetched"
//   faux:history     answers with the number of user messages
//   (default)        read README.md, then "done"
import { createServer } from 'node:http';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('');
  return '';
}

function plan(body) {
  const msgs = body.messages ?? [];
  const users = msgs.filter((m) => m.role === 'user');
  const last = textOf(users.at(-1)?.content);
  const lastUser = msgs.lastIndexOf(users.at(-1));
  const tools = msgs.slice(lastUser).filter((m) => m.role === 'tool').length;
  // Title generation and other auxiliary requests carry no tools: answer briefly.
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { kind: 'text', text: 'title' };
  if (last.includes('faux:long')) return { kind: 'hang' };
  const sleep = /faux:sleep:(\d+)/.exec(last);
  if (sleep) {
    const n = Number(sleep[1]);
    return tools === 0
      ? {
          kind: 'tool',
          name: 'bash',
          args: { command: `sleep ${n} & sleep ${n + 1}; echo end`, description: 'sleep' },
        }
      : { kind: 'text', text: 'slept' };
  }
  if (last.includes('faux:approval')) {
    return tools === 0
      ? {
          kind: 'tool',
          name: 'bash',
          args: { command: 'echo approved > approved.txt', description: 'write file' },
        }
      : { kind: 'text', text: 'finished' };
  }
  if (last.includes('faux:webfetch')) {
    return tools === 0
      ? { kind: 'tool', name: 'webfetch', args: { url: 'https://example.com', format: 'text' } }
      : { kind: 'text', text: 'fetched' };
  }
  if (last.includes('faux:env')) {
    return tools === 0
      ? {
          kind: 'tool',
          name: 'bash',
          args: { command: 'env | grep -c OPENCODE_SERVER_PASSWORD', description: 'env' },
        }
      : { kind: 'text', text: 'env checked' };
  }
  if (last.includes('faux:history')) return { kind: 'text', text: `history:${String(users.length)}` };
  // p11-fixes-a: calls the sub-job tool OpenCode offers from the local MCP server, then echoes its result.
  const sub = /faux:subtask:(\d+)/.exec(last);
  if (sub) {
    const names = body.tools.map((t) => t.function?.name ?? t.name ?? '');
    const tool = names.find((n) => n.endsWith('request_subtask'));
    if (tool === undefined) return { kind: 'text', text: `no subtask tool; tools: ${names.join(',')}` };
    if (tools === 0) {
      return {
        kind: 'tool',
        name: tool,
        args: { title: 'Draw the logo', prompt: 'Make a logo', waitSec: Number(sub[1]) },
      };
    }
    const result = msgs
      .slice(lastUser)
      .filter((m) => m.role === 'tool')
      .map((m) => textOf(m.content))
      .join(' | ');
    return { kind: 'text', text: `subtask via ${tool}: ${result}` };
  }
  return tools === 0
    ? { kind: 'tool', name: 'read', args: { filePath: 'README.md' } }
    : { kind: 'text', text: 'done' };
}

let calls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
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
      chunk({ content: p.text });
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
