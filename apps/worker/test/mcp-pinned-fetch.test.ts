import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedFetch } from '../src/mcp/pinned-fetch.js';
import { testCert } from './functions-helpers.js';

/** The MCP probe's client connects to the checked address only; the name is used for Host and TLS. */
const cert = testCert();
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.close(() => {
            r(null);
          });
        }),
    ),
  );
});

async function start(): Promise<{
  port: number;
  seen: { host: string | undefined; path: string | undefined; body: string }[];
}> {
  if (cert === null) throw new Error('no cert');
  const seen: { host: string | undefined; path: string | undefined; body: string }[] = [];
  const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ host: req.headers.host, path: req.url, body });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://169.254.169.254/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' });
      res.write('event: message\n');
      res.end('data: {"ok":true}\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => {
      r();
    });
  });
  return { port: (server.address() as AddressInfo).port, seen };
}

describe.skipIf(cert === null)('MCP probe pinned fetch (DNS rebinding)', () => {
  it('connects to the pinned address although the name does not resolve; Host, TLS name and body as given', async () => {
    const { port, seen } = await start();
    // api.example.test has no DNS: the request can only reach the server through the pinned address.
    const f = pinnedFetch('api.example.test', '127.0.0.1', { ca: cert?.cert ?? '' });
    const res = await f(`https://api.example.test:${String(port)}/mcp?x=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('s1');
    expect(await res.text()).toContain('data: {"ok":true}');
    expect(seen).toEqual([{ host: `api.example.test:${String(port)}`, path: '/mcp?x=1', body: '{"a":1}' }]);
  });

  it('refuses another host, plain http and a redirect', async () => {
    const { port } = await start();
    const f = pinnedFetch('api.example.test', '127.0.0.1', { ca: cert?.cert ?? '' });
    await expect(f(`https://other.example.test:${String(port)}/`, {})).rejects.toThrow(
      /not the checked host/,
    );
    await expect(f(`http://api.example.test:${String(port)}/`, {})).rejects.toThrow(/not the checked host/);
    await expect(f(`https://api.example.test:${String(port)}/redirect`, {})).rejects.toMatchObject({
      cause: { message: 'unexpected redirect' },
    });
  });

  it('verifies the certificate against the host name, not the address', async () => {
    const { port } = await start();
    const f = pinnedFetch('evil.example.test', '127.0.0.1', { ca: cert?.cert ?? '' });
    await expect(f(`https://evil.example.test:${String(port)}/`, {})).rejects.toThrow(
      /altnames|certificate/i,
    );
  });
});
