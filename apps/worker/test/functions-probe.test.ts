import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import type { FunctionProbeSpec } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeProbeExecutor } from '../src/functions/probe.js';
import { FunctionError } from '../src/functions/types.js';
import { ctxWith } from './functions-helpers.js';

/**
 * p15-watches (watch-checks-v1): a watch's loopback port check on the worker — `curl localhost:3000` as a typed,
 * bounded probe. Loopback only, preview port policy (service ports and the worker's own ports refused), JSON / text
 * bodies cut at the limit, allow-listed headers, and an unreachable port is a result (`reachable: false`).
 */

let http: Server;
let tcp: TcpServer;
let httpPort = 0;
let tcpPort = 0;

beforeAll(async () => {
  http = createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(200_000));
      return;
    }
    if (req.url === '/text') {
      res.writeHead(503, { 'content-type': 'text/plain', 'set-cookie': 'a=b' });
      res.end('booting');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-secret': 'nope' });
    res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpPort = (http.address() as AddressInfo).port;
  tcp = createTcpServer((s) => s.end());
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  tcpPort = (tcp.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => http.close(r));
  await new Promise((r) => tcp.close(r));
});

const httpProbe = (port: number, path = '/health', method: 'GET' | 'HEAD' = 'GET'): FunctionProbeSpec => ({
  type: 'probe',
  idempotencyKey: 'watch-test-1',
  probe: { kind: 'http', port, path, method, timeoutSec: 5, maxResponseBytes: 64 * 1024 },
});

describe('NodeProbeExecutor (p15-watches)', () => {
  it('reads a JSON answer from localhost, with allow-listed headers only', async () => {
    const r = await new NodeProbeExecutor({ hosts: ['127.0.0.1'] }).run(httpProbe(httpPort), ctxWith());
    expect(r).toMatchObject({
      type: 'probe',
      kind: 'http',
      reachable: true,
      status: 200,
      bodyEncoding: 'json',
      body: { ok: true, path: '/health', method: 'GET' },
      truncated: false,
    });
    expect(r.headers?.['content-type']).toBe('application/json');
    expect(r.headers?.['x-secret']).toBeUndefined();
  });

  it('text bodies, statuses and the size limit', async () => {
    const ex = new NodeProbeExecutor({ hosts: ['127.0.0.1'] });
    const t = await ex.run(httpProbe(httpPort, '/text'), ctxWith());
    expect(t).toMatchObject({ status: 503, body: 'booting', bodyEncoding: 'text' });
    expect(t.headers?.['set-cookie']).toBeUndefined();
    const big = await ex.run(httpProbe(httpPort, '/big'), ctxWith());
    expect(big.truncated).toBe(true);
    expect(String(big.body).length).toBe(64 * 1024);
    const head = await ex.run(httpProbe(httpPort, '/', 'HEAD'), ctxWith());
    expect(head).toMatchObject({ status: 200, bodyEncoding: 'none' });
    expect(head.body).toBeUndefined();
  });

  it('tcp: open and closed ports', async () => {
    const ex = new NodeProbeExecutor({ hosts: ['127.0.0.1'] });
    const open = await ex.run(
      { type: 'probe', idempotencyKey: 'k', probe: { kind: 'tcp', port: tcpPort, timeoutSec: 5 } },
      ctxWith(),
    );
    expect(open).toMatchObject({ kind: 'tcp', reachable: true });
    // A port nobody listens on: "not yet", not a failure.
    const closedPort = await (async () => {
      const s = createTcpServer();
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      const p = (s.address() as AddressInfo).port;
      await new Promise((r) => s.close(r));
      return p;
    })();
    const closed = await ex.run(httpProbe(closedPort), ctxWith());
    expect(closed).toMatchObject({ reachable: false, error: 'connection_refused' });
  });

  it('refuses the worker’s own ports and service ports (defence in depth behind the schema)', async () => {
    const ex = new NodeProbeExecutor({ hosts: ['127.0.0.1'], ownPorts: () => [httpPort] });
    await expect(ex.run(httpProbe(httpPort), ctxWith())).rejects.toBeInstanceOf(FunctionError);
    await expect(ex.run(httpProbe(5432), ctxWith())).rejects.toMatchObject({ code: 'function_refused' });
  });
});
