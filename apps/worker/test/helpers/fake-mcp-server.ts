import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * p14-mcp-core test helper: a fake **remote** MCP server on 127.0.0.1 speaking
 *
 * - streamable HTTP at `/mcp` (answers as `application/json`, or as a `text/event-stream` with `answer: 'sse'`),
 *   `Mcp-Session-Id`, cursor-paged `tools/list`, DELETE of the session;
 * - legacy SSE at `/sse` (an `endpoint` event, then answers as `message` events to POSTs on `/messages`);
 * - `/redirect` (302 to `/mcp`) and `/big` (a > 4 MiB answer) for the client's bounds.
 *
 * Every request's method, path and headers are recorded so tests can assert what arrived (e.g. the Authorization
 * header carrying the vault secret). `fetchVia(server)` maps the spec's https host onto it for the probe client.
 */

export interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

export interface FakeMcpOptions {
  readonly tools: readonly FakeTool[];
  /** Tools per tools/list page (default: all on one page). */
  readonly pageSize?: number;
  /** How `/mcp` answers requests. */
  readonly answer?: 'json' | 'sse';
  /** When set, requests without exactly this Authorization header get 401. */
  readonly requireAuthorization?: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface FakeMcpServer {
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

const SESSION = 'fake-session-1';

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function answerFor(
  opts: FakeMcpOptions,
  msg: { id?: unknown; method?: string; params?: { cursor?: string } },
) {
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.1' },
      },
    };
  }
  if (msg.method === 'tools/list') {
    const size = opts.pageSize ?? opts.tools.length;
    const start = msg.params?.cursor === undefined ? 0 : Number(msg.params.cursor);
    const page = opts.tools.slice(start, start + size);
    const next = start + size < opts.tools.length ? String(start + size) : undefined;
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: page, ...(next === undefined ? {} : { nextCursor: next }) },
    };
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
}

export async function startFakeMcpServer(opts: FakeMcpOptions): Promise<FakeMcpServer> {
  const requests: RecordedRequest[] = [];
  let sseStream: ServerResponse | null = null;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const text = await body(req);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        headers: { ...req.headers },
        body: text,
      });
      if (
        opts.requireAuthorization !== undefined &&
        req.headers.authorization !== opts.requireAuthorization
      ) {
        res.writeHead(401).end();
        return;
      }
      if (url.pathname === '/redirect') {
        res.writeHead(302, { location: '/mcp' }).end();
        return;
      }
      if (url.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('x'.repeat(5 * 1024 * 1024));
        return;
      }
      if (url.pathname === '/mcp') {
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        const msg = JSON.parse(text) as { id?: unknown; method?: string; params?: { cursor?: string } };
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const out = JSON.stringify(answerFor(opts, msg));
        const headers = msg.method === 'initialize' ? { 'mcp-session-id': SESSION } : {};
        if (opts.answer === 'sse') {
          res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
          res.write(': keep-alive\n\n');
          res.write(`event: message\ndata: ${out}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { ...headers, 'content-type': 'application/json' });
          res.end(out);
        }
        return;
      }
      if (url.pathname === '/sse' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: endpoint\ndata: /messages?session=abc\n\n');
        sseStream = res;
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        const msg = JSON.parse(text) as { id?: unknown; method?: string; params?: { cursor?: string } };
        res.writeHead(202).end();
        if (msg.id !== undefined)
          sseStream?.write(`event: message\ndata: ${JSON.stringify(answerFor(opts, msg))}\n\n`);
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        sseStream?.end();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A fetch that sends `https://<any host>/<path>` to the fake server over plain http (tests only). */
export function fetchVia(server: FakeMcpServer): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) => {
    const u = new URL(url);
    return fetch(`http://127.0.0.1:${String(server.port)}${u.pathname}${u.search}`, init);
  };
}

/** A public address for the client's private-address check (the fake host never resolves). */
export const publicLookup = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);
