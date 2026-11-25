import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AssistantToolCallResult } from './assistant.js';
import { assistantToolSpecs, isAssistantToolName, type AssistantToolSpec } from './assistant-kit.js';
import { LOOPBACK_HOST } from './loopback-server.js';
import { SecretValue } from './secrets.js';

/**
 * Loopback MCP endpoint of one assistant session (p5-ops-chat-next, ADR-0025): the platform tools for a
 * runtime whose only custom-tool path is a *remote* MCP server (OpenCode 1.19.0). It is the narrowest possible
 * listener:
 *
 *  - bound to `127.0.0.1` on a random port, one path (`/mcp`), lives exactly as long as the session;
 *  - every request needs `Authorization: Bearer <token>` — 256 random bits per session, compared in constant
 *    time; the token reaches the runtime through its environment only (never argv, never a file);
 *  - the `Host` header must be this loopback address and port (DNS-rebinding guard), an `Origin` header is
 *    refused unless it is this loopback origin (no browser can drive it);
 *  - only `POST` with `application/json`, body ≤ 256 KiB (default), one JSON-RPC message per request;
 *  - it speaks the minimum of MCP Streamable HTTP with plain JSON answers: `initialize`,
 *    `notifications/*` (202), `ping`, `tools/list`, `tools/call`; everything else is a JSON-RPC error;
 *  - it executes nothing: `tools/call` goes to the session's relay (the host forwards it to the master, which
 *    runs the tool as the user who sent the turn).
 */

export interface AssistantMcpRelay {
  call(name: string, args: unknown): Promise<AssistantToolCallResult>;
}

export interface AssistantMcpEndpointOptions {
  readonly relay: AssistantMcpRelay;
  /** Default: every platform tool. */
  readonly tools?: readonly AssistantToolSpec[];
  /** Server name reported by `initialize` (default `remyral`). */
  readonly serverName?: string;
  readonly maxBodyBytes?: number;
}

export interface AssistantMcpEndpoint {
  /** `http://127.0.0.1:<port>/mcp` */
  readonly url: string;
  readonly port: number;
  /** The bearer token (a secret: register it for redaction, pass it through the env only). */
  readonly token: SecretValue;
  /** Number of `tools/call` requests that reached the relay. */
  readonly toolCalls: number;
  close(): Promise<void>;
}

export const MCP_ENDPOINT_PATH = '/mcp';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = '2025-06-18';
const DEFAULT_MAX_BODY = 256 * 1024;

type JsonRpcId = string | number | null;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export async function startAssistantMcpEndpoint(
  opts: AssistantMcpEndpointOptions,
): Promise<AssistantMcpEndpoint> {
  const token = new SecretValue(randomBytes(32).toString('base64url'));
  const expected = digest(`Bearer ${token.reveal()}`);
  const tools = opts.tools ?? assistantToolSpecs();
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  let port = 0;
  let toolCalls = 0;

  const listed = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  async function dispatch(msg: Record<string, unknown>): Promise<unknown> {
    const id = msg.id as JsonRpcId;
    const method = msg.method;
    const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<
      string,
      unknown
    >;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.serverName ?? 'remyral', version: '1.0.0' },
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: listed });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!isAssistantToolName(name) || !tools.some((t) => t.name === name)) {
          return fail(-32602, `Unknown tool: ${name.slice(0, 64)}`);
        }
        toolCalls += 1;
        const r = await opts.relay.call(name, params.arguments ?? {});
        return ok({ content: [{ type: 'text', text: r.content }], isError: r.isError });
      }
      default:
        return fail(-32601, 'Method not found');
    }
  }

  function send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status, { 'content-length': '0' });
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  function authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length > 512) return false;
    return timingSafeEqual(digest(auth), expected);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const self = `${LOOPBACK_HOST}:${String(port)}`;
    // DNS rebinding / browser guards before anything else.
    if (req.headers.host !== self) {
      send(res, 421, { error: 'misdirected request' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${self}`) {
      send(res, 403, { error: 'origin refused' });
      return;
    }
    if (!authorized(req)) {
      res.setHeader('www-authenticate', 'Bearer');
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_ENDPOINT_PATH) {
      send(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      send(res, 405, { error: 'method not allowed' });
      return;
    }
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json\b/i.test(type)) {
      send(res, 415, { error: 'unsupported media type' });
      return;
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > maxBody) {
      req.resume();
      send(res, 413, { error: 'payload too large' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBody) {
        aborted = true;
        send(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let msg: unknown;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
        send(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        });
        return;
      }
      const m = msg as Record<string, unknown>;
      if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        // A JSON-RPC response from the client (we never send requests) or garbage: accepted, ignored.
        if (m.jsonrpc === '2.0' && ('result' in m || 'error' in m)) {
          send(res, 202);
          return;
        }
        send(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        });
        return;
      }
      if (!('id' in m) || m.id === undefined) {
        send(res, 202);
        return;
      } // notification
      dispatch(m).then(
        (out) => {
          send(res, 200, out);
        },
        () => {
          send(res, 200, { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Internal error' } });
        },
      );
    });
  }

  const server: Server = createServer({ requestTimeout: 0 }, handle);
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | null = null;
  return {
    url: `http://${LOOPBACK_HOST}:${String(port)}${MCP_ENDPOINT_PATH}`,
    port,
    token,
    get toolCalls() {
      return toolCalls;
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
