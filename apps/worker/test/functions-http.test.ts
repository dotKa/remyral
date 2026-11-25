import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { FunctionEgress, FunctionHttpSpec } from '@remyral/protocol';
import { FunctionHttpSpec as HttpSpecSchema } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialHostAllowed,
  normalizeHost,
  policyAllows,
  resolveTarget,
} from '../src/functions/egress.js';
import { NodeHttpExecutor } from '../src/functions/http.js';
import { FunctionError } from '../src/functions/types.js';
import { isForbiddenAddress } from '../src/sandbox/network.js';
import { ctxWith, fakeDns, onlyTestServer, testCert } from './functions-helpers.js';

/**
 * p14-workflow-engine 14.3 (ADR-0055 K1): the worker's egress guard and HTTP executor — the SSRF matrix (IP literal
 * forms, internal names, DNS answers, rebinding, redirects), K1 policy (open / allowlist, ports), credential host
 * binding and redaction, Idempotency-Key, limits, timeout and abort. Real servers on 127.0.0.1; the only address the
 * tests treat as public is that server's (injected checker), everything else uses the production rules.
 */

const OPEN: FunctionEgress = { mode: 'open', hosts: [] };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) =>
          s.close(() => {
            r(null);
          }),
        ),
    ),
  );
});

interface Seen {
  method: string;
  url: string;
  host: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{
  port: number;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const s = {
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host ?? '',
        headers: req.headers,
        body,
      };
      seen.push(s);
      handler(req, res, s);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen };
}

function spec(
  url: string,
  over: Partial<FunctionHttpSpec> = {},
  req: Partial<FunctionHttpSpec['request']> = {},
) {
  return HttpSpecSchema.parse({
    type: 'http',
    idempotencyKey: 'wf2:run1:node1',
    request: {
      method: 'GET',
      url,
      headers: {},
      timeoutSec: 5,
      maxResponseBytes: 1024 * 1024,
      followRedirects: 3,
      responseType: 'json',
      ...req,
    },
    egress: OPEN,
    ...over,
  });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FunctionError) return err.code;
    throw err;
  }
  return 'ok';
}

describe('egress guard (K1 floor)', () => {
  const literals = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fd00:ec2::254',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::a00:1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '127.1',
    '0x7f.1',
    '10.0.0.1.',
  ];
  it.each(literals)('refuses the non-public literal %s (every policy mode)', async (host) => {
    for (const egress of [OPEN, { mode: 'allowlist' as const, hosts: [host] }]) {
      expect(await code(resolveTarget(host, 443, egress, 'http'))).toBe('egress_refused');
    }
  });

  it('normalises numeric IPv4 shorthands the way a connection reads them', () => {
    expect(normalizeHost('2130706433')).toBe('127.0.0.1');
    expect(normalizeHost('0x7f000001')).toBe('127.0.0.1');
    expect(normalizeHost('0177.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('[::FFFF:127.0.0.1]')).toBe('::ffff:7f00:1');
    expect(normalizeHost('API.Example.COM.')).toBe('api.example.com');
  });

  it.each(['localhost', 'a.localhost', 'nas.local', 'db.internal', 'metadata.google.internal', 'router'])(
    'refuses the internal name %s without resolving it',
    async (host) => {
      const dns = fakeDns({ [host]: ['8.8.8.8'] });
      expect(await code(resolveTarget(host, 443, OPEN, 'http', { lookup: dns.lookup }))).toBe(
        'egress_refused',
      );
      expect(dns.calls).toEqual([]);
    },
  );

  it('refuses a name that resolves to a private address, or to a mix of public and private ones', async () => {
    const dns = fakeDns({
      'evil.example.com': ['10.0.0.5'],
      'mixed.example.com': ['8.8.8.8', '192.168.0.10'],
    });
    expect(await code(resolveTarget('evil.example.com', 443, OPEN, 'http', dns))).toBe('egress_refused');
    expect(await code(resolveTarget('mixed.example.com', 443, OPEN, 'http', dns))).toBe('egress_refused');
    expect(await code(resolveTarget('none.example.com', 443, OPEN, 'http', dns))).toBe('dns_failed');
  });

  it('pins the checked address (public answers pass with production rules)', async () => {
    const dns = fakeDns({ 'api.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
    const t = await resolveTarget('api.example.com', 443, OPEN, 'http', dns);
    expect(t).toMatchObject({ host: 'api.example.com', address: '93.184.216.34', family: 4, literal: false });
    expect(isForbiddenAddress('93.184.216.34')).toBe(false);
  });

  it('K1 policy: open = default ports or a listed host:port; allowlist = listed hosts only', () => {
    expect(policyAllows('api.example.com', 443, OPEN, 'http')).toBe(true);
    expect(policyAllows('api.example.com', 8443, OPEN, 'http')).toBe(true);
    expect(policyAllows('api.example.com', 9000, OPEN, 'http')).toBe(false);
    expect(
      policyAllows('api.example.com', 9000, { mode: 'open', hosts: ['api.example.com:9000'] }, 'http'),
    ).toBe(true);
    expect(policyAllows('api.example.com', 587, OPEN, 'smtp')).toBe(true);
    expect(policyAllows('api.example.com', 443, OPEN, 'smtp')).toBe(false);
    const list: FunctionEgress = { mode: 'allowlist', hosts: ['api.example.com', 'other.example.com:9000'] };
    expect(policyAllows('api.example.com', 443, list, 'http')).toBe(true);
    expect(policyAllows('api.example.com', 9000, list, 'http')).toBe(false);
    expect(policyAllows('other.example.com', 9000, list, 'http')).toBe(true);
    expect(policyAllows('other.example.com', 443, list, 'http')).toBe(false);
    expect(policyAllows('third.example.com', 443, list, 'http')).toBe(false);
    expect(credentialHostAllowed(['api.example.com'], 'api.example.com', 8443)).toBe(true);
    expect(credentialHostAllowed(['api.example.com:443'], 'api.example.com', 8443)).toBe(false);
    expect(credentialHostAllowed(['api.example.com'], 'evil.example.com', 443)).toBe(false);
  });

  it('reports a disallowed port / an unlisted host as egress_not_allowed', async () => {
    const dns = fakeDns({ 'api.example.com': ['93.184.216.34'] });
    expect(await code(resolveTarget('api.example.com', 22, OPEN, 'http', dns))).toBe('egress_not_allowed');
    expect(
      await code(
        resolveTarget('api.example.com', 443, { mode: 'allowlist', hosts: ['x.example.com'] }, 'http', dns),
      ),
    ).toBe('egress_not_allowed');
    expect(dns.calls).toEqual([]);
  });
});

describe('HTTP executor', { timeout: 20_000 }, () => {
  it('refuses private targets before any connection (literal URL forms)', async () => {
    const http = new NodeHttpExecutor();
    for (const url of [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://localhost/',
    ]) {
      expect(await code(http.run(spec(url), ctxWith())), url).toBe('egress_refused');
    }
  });

  it('sends the request to the pinned address with Host, Idempotency-Key and no denied headers', async () => {
    const { port, seen } = await serve((_q, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'a=b');
      res.setHeader('x-secret-internal', 'nope');
      res.end(JSON.stringify({ ok: true }));
    });
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const s = spec(
      `http://api.example.test:${String(port)}/v1/items?x=1`,
      { egress: { mode: 'open', hosts: [`api.example.test:${String(port)}`] } },
      {
        method: 'POST',
        headers: { 'x-trace': 't1', Cookie: 'c=d' },
        body: { contentType: 'application/json', text: '{"a":1}' },
      },
    );
    const r = await http.run(s, ctxWith());
    expect(r).toMatchObject({
      status: 200,
      body: { ok: true },
      bodyEncoding: 'json',
      truncated: false,
      redirects: 0,
    });
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['x-secret-internal']).toBeUndefined();
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/items?x=1',
      host: `api.example.test:${String(port)}`,
      body: '{"a":1}',
    });
    expect(seen[0]?.headers['idempotency-key']).toBe('wf2:run1:node1');
    expect(seen[0]?.headers['x-trace']).toBe('t1');
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(dns.calls).toEqual(['api.example.test']);
    // A second call (retry after a lease loss) carries the identical key.
    await http.run(s, ctxWith());
    expect(seen[1]?.headers['idempotency-key']).toBe(seen[0]?.headers['idempotency-key']);
  });

  it('DNS rebinding: the name is resolved once per hop and the connection uses that checked address', async () => {
    const { port, seen } = await serve((_q, res) => res.end('{}'));
    let n = 0;
    const dns = fakeDns({ 'rebind.example.test': () => (n++ === 0 ? ['127.0.0.1'] : ['10.0.0.1']) });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const r = await http.run(
      spec(`http://rebind.example.test:${String(port)}/`, {
        egress: { mode: 'open', hosts: [`rebind.example.test:${String(port)}`] },
      }),
      ctxWith(),
    );
    expect(r.status).toBe(200);
    expect(dns.calls).toEqual(['rebind.example.test']);
    expect(seen).toHaveLength(1);
    // The next call sees the rebound (private) answer and is refused.
    expect(
      await code(
        http.run(
          spec(`http://rebind.example.test:${String(port)}/`, {
            egress: { mode: 'open', hosts: [`rebind.example.test:${String(port)}`] },
          }),
          ctxWith(),
        ),
      ),
    ).toBe('egress_refused');
    expect(seen).toHaveLength(1);
  });

  it('re-checks every redirect hop: to a private literal, to a name resolving privately, to another scheme', async () => {
    const targets = [
      'http://10.0.0.1/x',
      'http://intranet.example.test/x',
      'file:///etc/passwd',
      'http://[::1]:80/',
    ];
    let i = 0;
    const { port } = await serve((_q, res) => {
      res.statusCode = 302;
      res.setHeader('location', targets[i++] ?? '/');
      res.end();
    });
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'], 'intranet.example.test': ['192.168.1.20'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const s = spec(`http://api.example.test:${String(port)}/`, {
      egress: { mode: 'open', hosts: [`api.example.test:${String(port)}`] },
    });
    expect(await code(http.run(s, ctxWith()))).toBe('egress_refused');
    expect(await code(http.run(s, ctxWith()))).toBe('egress_refused');
    expect(await code(http.run(s, ctxWith()))).toBe('redirect_refused');
    expect(await code(http.run(s, ctxWith()))).toBe('egress_refused');
  });

  it('limits redirect hops; with followRedirects 0 the 3xx is the result', async () => {
    const { port } = await serve((_q, res) => {
      res.statusCode = 301;
      res.setHeader('location', '/again');
      res.end();
    });
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const egress = { mode: 'open' as const, hosts: [`api.example.test:${String(port)}`] };
    expect(
      await code(
        http.run(
          spec(`http://api.example.test:${String(port)}/`, { egress }, { followRedirects: 2 }),
          ctxWith(),
        ),
      ),
    ).toBe('redirect_refused');
    const r = await http.run(
      spec(`http://api.example.test:${String(port)}/`, { egress }, { followRedirects: 0 }),
      ctxWith(),
    );
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('/again');
  });

  it('attaches the credential only for its hosts, drops it on a redirect to another host, redacts echoes', async () => {
    const secret = 'sk_live_abcdefghijklmnop';
    let hop = 0;
    const second = await serve((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    });
    const first = await serve((req, res) => {
      if (hop++ === 0 && req.url === '/go') {
        res.statusCode = 307;
        res.setHeader('location', `http://other.example.test:${String(second.port)}/landed`);
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', `echo ${req.headers.authorization ?? ''}`);
      res.end(JSON.stringify({ echoed: req.headers.authorization ?? null }));
    });
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'], 'other.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const egress: FunctionEgress = {
      mode: 'open',
      hosts: [`api.example.test:${String(first.port)}`, `other.example.test:${String(second.port)}`],
    };
    const credential = {
      id: 'api',
      version: 1,
      placement: 'bearer' as const,
      allowedHosts: ['api.example.test'],
    };
    // Echoing server: the value never comes back in the result.
    const ctx = ctxWith({ api: secret });
    const echo = await http.run(
      spec(`http://api.example.test:${String(first.port)}/echo`, { egress, credential }),
      ctx,
    );
    expect(first.seen.at(-1)?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(echo)).not.toContain(secret);
    expect(echo.credentialAttached).toBe(true);
    expect(ctx.secrets).toContain(secret);
    // Redirect to another host: not attached there.
    hop = 0;
    const moved = await http.run(
      spec(`http://api.example.test:${String(first.port)}/go`, { egress, credential }),
      ctxWith({ api: secret }),
    );
    expect(moved).toMatchObject({
      status: 200,
      body: { auth: null },
      redirects: 1,
      credentialAttached: false,
    });
    expect(second.seen.at(-1)?.headers.authorization).toBeUndefined();
    // First hop outside the credential's hosts: refused before sending.
    const before = second.seen.length;
    expect(
      await code(
        http.run(
          spec(`http://other.example.test:${String(second.port)}/`, { egress, credential }),
          ctxWith({ api: secret }),
        ),
      ),
    ).toBe('credential_host_refused');
    expect(second.seen.length).toBe(before);
    // Missing on this worker.
    expect(
      await code(
        http.run(spec(`http://api.example.test:${String(first.port)}/`, { egress, credential }), ctxWith()),
      ),
    ).toBe('credential_missing');
  });

  it('query credentials are removed from the final URL; basic / header placements', async () => {
    const { port, seen } = await serve((_q, res) => res.end('{}'));
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const egress = { mode: 'open' as const, hosts: [`api.example.test:${String(port)}`] };
    const url = `http://api.example.test:${String(port)}/q?a=1`;
    const q = await http.run(
      spec(url, {
        egress,
        credential: {
          id: 'k',
          version: 1,
          placement: 'query',
          name: 'key',
          allowedHosts: ['api.example.test'],
        },
      }),
      ctxWith({ k: 'querysecret123' }),
    );
    expect(seen[0]?.url).toBe('/q?a=1&key=querysecret123');
    expect(q.finalUrl).not.toContain('querysecret123');
    await http.run(
      spec(url, {
        egress,
        credential: { id: 'k', version: 1, placement: 'basic', allowedHosts: ['api.example.test'] },
      }),
      ctxWith({ k: 'user:pass' }),
    );
    expect(seen[1]?.headers.authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    await http.run(
      spec(url, {
        egress,
        credential: {
          id: 'k',
          version: 1,
          placement: 'header',
          name: 'X-Token',
          allowedHosts: ['api.example.test'],
        },
      }),
      ctxWith({ k: 'hdrsecret999' }),
    );
    expect(seen[2]?.headers['x-token']).toBe('hdrsecret999');
  });

  it('K1: a non-default port needs the allowlist entry; allowlist mode refuses unlisted hosts', async () => {
    const { port } = await serve((_q, res) => res.end('{}'));
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const url = `http://api.example.test:${String(port)}/`;
    expect(await code(http.run(spec(url), ctxWith()))).toBe('egress_not_allowed');
    expect(
      await code(
        http.run(spec(url, { egress: { mode: 'allowlist', hosts: ['api.example.test'] } }), ctxWith()),
      ),
    ).toBe('egress_not_allowed');
    const ok = await http.run(
      spec(url, { egress: { mode: 'allowlist', hosts: [`api.example.test:${String(port)}`] } }),
      ctxWith(),
    );
    expect(ok.status).toBe(200);
  });

  it('cuts the response at maxResponseBytes, returns non-JSON as text, base64 for binary', async () => {
    const { port } = await serve((req, res) => {
      if (req.url === '/big') res.end('x'.repeat(5000));
      else if (req.url === '/bin') res.end(Buffer.from([0, 1, 2, 255]));
      else res.end('not json');
    });
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const egress = { mode: 'open' as const, hosts: [`api.example.test:${String(port)}`] };
    const base = `http://api.example.test:${String(port)}`;
    const big = await http.run(
      spec(`${base}/big`, { egress }, { maxResponseBytes: 1000, responseType: 'text' }),
      ctxWith(),
    );
    expect(big).toMatchObject({ truncated: true, sizeBytes: 1000, bodyEncoding: 'text' });
    expect((big.body as string).length).toBe(1000);
    const txt = await http.run(spec(`${base}/x`, { egress }), ctxWith());
    expect(txt).toMatchObject({ bodyEncoding: 'text', body: 'not json' });
    const bin = await http.run(spec(`${base}/bin`, { egress }, { responseType: 'binary' }), ctxWith());
    expect(bin).toMatchObject({
      bodyEncoding: 'base64',
      body: Buffer.from([0, 1, 2, 255]).toString('base64'),
    });
  });

  it('times out (http_timeout) and stops on abort', async () => {
    const { port } = await serve(() => undefined);
    const dns = fakeDns({ 'api.example.test': ['127.0.0.1'] });
    const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });
    const egress = { mode: 'open' as const, hosts: [`api.example.test:${String(port)}`] };
    const url = `http://api.example.test:${String(port)}/`;
    expect(await code(http.run(spec(url, { egress }, { timeoutSec: 1 }), ctxWith()))).toBe('http_timeout');
    const ac = new AbortController();
    const p = http.run(spec(url, { egress }), ctxWith({}, ac.signal));
    setTimeout(() => {
      ac.abort();
    }, 100);
    await expect(p).rejects.not.toBeInstanceOf(FunctionError);
  });

  const cert = testCert();
  it.skipIf(cert === null)(
    'https: verifies the certificate against the host name (SNI), not the pinned address',
    async () => {
      if (cert === null) return;
      const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (_q, res) =>
        res.end('{"tls":true}'),
      );
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      const dns = fakeDns({ 'api.example.test': ['127.0.0.1'], 'wrong.example.test': ['127.0.0.1'] });
      const http = new NodeHttpExecutor({
        lookup: dns.lookup,
        isPublicAddress: onlyTestServer,
        ca: cert.cert,
      });
      const egress = {
        mode: 'open' as const,
        hosts: [`api.example.test:${String(port)}`, `wrong.example.test:${String(port)}`],
      };
      const r = await http.run(spec(`https://api.example.test:${String(port)}/`, { egress }), ctxWith());
      expect(r.body).toEqual({ tls: true });
      expect(
        await code(http.run(spec(`https://wrong.example.test:${String(port)}/`, { egress }), ctxWith())),
      ).toBe('http_error');
    },
  );
});
