import { request } from 'node:http';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startAssistantMcpEndpoint, type AssistantMcpEndpoint } from '../src/index.js';

/** Raw HTTP (fetch cannot set Host / Origin freely). */
function raw(
  ep: AssistantMcpEndpoint,
  opts: { method?: string; headers?: Record<string, string>; body?: string; path?: string },
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: opts.path ?? '/mcp',
        method: opts.method ?? 'POST',
        headers: {
          host: `127.0.0.1:${String(ep.port)}`,
          authorization: `Bearer ${ep.token.reveal()}`,
          'content-type': 'application/json',
          ...opts.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** `id: null` = a notification (no id member). */
const rpc = (method: string, params: unknown = {}, id: number | null = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });

let ep: AssistantMcpEndpoint | undefined;
const seen: { name: string; args: unknown }[] = [];

async function start(): Promise<AssistantMcpEndpoint> {
  seen.length = 0;
  ep = await startAssistantMcpEndpoint({
    relay: {
      call: (name, args) => {
        seen.push({ name, args });
        return Promise.resolve({ content: `ran ${name}`, isError: name === 'search_audit' });
      },
    },
  });
  return ep;
}

afterEach(async () => {
  await ep?.close();
  ep = undefined;
});

describe('assistant loopback MCP endpoint', () => {
  it('binds to loopback with a 256-bit token', async () => {
    const e = await start();
    expect(e.url).toBe(`http://127.0.0.1:${String(e.port)}/mcp`);
    expect(Buffer.from(e.token.reveal(), 'base64url')).toHaveLength(32);
  });

  it('refuses requests without or with a wrong token (401)', async () => {
    const e = await start();
    expect((await raw(e, { headers: { authorization: '' }, body: rpc('ping') })).status).toBe(401);
    const wrong = await raw(e, { headers: { authorization: 'Bearer nope' }, body: rpc('ping') });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer');
    expect(seen).toHaveLength(0);
  });

  it('refuses a foreign Host (DNS rebinding) and a non-loopback Origin', async () => {
    const e = await start();
    expect((await raw(e, { headers: { host: 'evil.example:80' }, body: rpc('ping') })).status).toBe(421);
    expect(
      (await raw(e, { headers: { host: `localhost:${String(e.port)}` }, body: rpc('ping') })).status,
    ).toBe(421);
    expect((await raw(e, { headers: { origin: 'https://evil.example' }, body: rpc('ping') })).status).toBe(
      403,
    );
    expect(
      (await raw(e, { headers: { origin: `http://127.0.0.1:${String(e.port)}` }, body: rpc('ping') })).status,
    ).toBe(200);
  });

  it('serves only POST /mcp with JSON', async () => {
    const e = await start();
    expect((await raw(e, { method: 'GET' })).status).toBe(405);
    expect((await raw(e, { method: 'DELETE' })).status).toBe(405);
    expect((await raw(e, { path: '/other', body: rpc('ping') })).status).toBe(404);
    expect((await raw(e, { headers: { 'content-type': 'text/plain' }, body: rpc('ping') })).status).toBe(415);
    expect((await raw(e, { body: '{not json' })).status).toBe(400);
    expect((await raw(e, { body: '[]' })).status).toBe(400);
  });

  it('refuses bodies over the limit (413)', async () => {
    const e = await start();
    const big = rpc('tools/call', { name: 'list_workers', arguments: { x: 'a'.repeat(300 * 1024) } });
    expect((await raw(e, { body: big })).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('initializes, accepts notifications and lists exactly the platform tools with JSON Schemas', async () => {
    const e = await start();
    const init = JSON.parse(
      (await raw(e, { body: rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} }) })).body,
    ) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo.name).toBe('remyral');
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    const unknownVersion = JSON.parse(
      (await raw(e, { body: rpc('initialize', { protocolVersion: '1999-01-01' }) })).body,
    ) as { result: { protocolVersion: string } };
    expect(unknownVersion.result.protocolVersion).toBe('2025-06-18');
    const note = await raw(e, { body: rpc('notifications/initialized', {}, null) });
    expect(note.status).toBe(202);
    expect(note.body).toBe('');
    const list = JSON.parse((await raw(e, { body: rpc('tools/list') })).body) as {
      result: { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(ASSISTANT_TOOL_NAMES);
    for (const t of list.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(10);
    }
    const ping = JSON.parse((await raw(e, { body: rpc('ping', {}, 7) })).body) as {
      id: number;
      result: object;
    };
    expect(ping).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('relays tools/call and returns MCP content with isError', async () => {
    const e = await start();
    const ok = JSON.parse(
      (await raw(e, { body: rpc('tools/call', { name: 'list_workers', arguments: { state: 'online' } }) }))
        .body,
    ) as { result: unknown };
    expect(ok.result).toEqual({ content: [{ type: 'text', text: 'ran list_workers' }], isError: false });
    const err = JSON.parse(
      (await raw(e, { body: rpc('tools/call', { name: 'search_audit', arguments: {} }) })).body,
    ) as { result: { isError: boolean } };
    expect(err.result.isError).toBe(true);
    expect(seen).toEqual([
      { name: 'list_workers', args: { state: 'online' } },
      { name: 'search_audit', args: {} },
    ]);
    expect(e.toolCalls).toBe(2);
  });

  it('answers unknown tools and methods with JSON-RPC errors, never reaching the relay', async () => {
    const e = await start();
    const tool = JSON.parse(
      (await raw(e, { body: rpc('tools/call', { name: 'bash', arguments: { command: 'id' } }) })).body,
    ) as { error: { code: number; message: string } };
    expect(tool.error.code).toBe(-32602);
    const method = JSON.parse((await raw(e, { body: rpc('resources/list') })).body) as {
      error: { code: number };
    };
    expect(method.error.code).toBe(-32601);
    expect(seen).toHaveLength(0);
  });

  it('stops listening when closed', async () => {
    const e = await start();
    await e.close();
    await expect(raw(e, { body: rpc('ping') })).rejects.toThrow();
    await e.close(); // idempotent
  });
});
