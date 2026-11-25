import { createServer, type Server } from 'node:http';

/**
 * A local stand-in for the OpenAI Responses API (`POST /v1/responses`, SSE) for real-binary Codex tests: no
 * model, no network. It records every request body and answers with a script — by default first a function
 * call to `list_workers`, then (once the request carries a `function_call_output`) a streamed text answer.
 * Event shapes are the Responses API stream events the pinned codex-cli 0.162.1 consumes (verified against
 * the binary, docs/compat/codex.md §9).
 */
export interface MockResponses {
  readonly url: string;
  readonly requests: Record<string, unknown>[];
  /** The `authorization` header of each model request (tests compare, never print it). */
  readonly authorizations: (string | undefined)[];
  close(): Promise<void>;
}

export interface MockScript {
  /** `false`: answer the first request with the text right away (no tool call). */
  readonly toolCall?: boolean;
  readonly toolName?: string;
  readonly toolArguments?: string;
  /**
   * `custom`: the call is a Responses `custom_tool_call` (free-form input, how a code-mode model calls `exec`)
   * instead of a `function_call`; `toolArguments` is then its raw input.
   */
  readonly toolKind?: 'function' | 'custom';
  readonly answer?: readonly string[];
}

export async function startMockResponses(script: MockScript = {}): Promise<MockResponses> {
  const requests: Record<string, unknown>[] = [];
  const authorizations: (string | undefined)[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      n += 1;
      if (!(req.url ?? '').endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      authorizations.push(req.headers.authorization);
      const input = (parsed.input ?? []) as { type?: string }[];
      const answered =
        script.toolCall === false ||
        input.some((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = (ev: Record<string, unknown>): void => {
        res.write(`event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      const id = `resp_${String(n)}`;
      sse({ type: 'response.created', response: { id } });
      if (!answered) {
        const item =
          script.toolKind === 'custom'
            ? {
                type: 'custom_tool_call',
                id: 'ctc_1',
                call_id: 'call_1',
                name: script.toolName ?? 'exec',
                input: script.toolArguments ?? '',
              }
            : {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: script.toolName ?? 'list_workers',
                arguments: script.toolArguments ?? '{}',
              };
        sse({ type: 'response.output_item.added', output_index: 0, item });
        sse({ type: 'response.output_item.done', output_index: 0, item });
      } else {
        const pieces = script.answer ?? ['Two ', 'workers ', 'online.'];
        sse({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
        });
        for (const delta of pieces) {
          sse({
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta,
          });
        }
        sse({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: pieces.join(''), annotations: [] }],
          },
        });
      }
      sse({
        type: 'response.completed',
        response: {
          id,
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 120,
          },
        },
      });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
