import { createHash, X509Certificate } from 'node:crypto';
import type { Server } from 'node:https';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { type AssignedTlsPin, FunctionHttpSpec as HttpSpecSchema } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { dnsFailure, resolveTarget } from '../src/functions/egress.js';
import { NodeHttpExecutor } from '../src/functions/http.js';
import { FunctionError } from '../src/functions/types.js';
import { ctxWith, fakeDns, onlyTestServer, testCert } from './functions-helpers.js';

/**
 * p22-runtime-diagnostics: a function job's HTTPS request to a self-signed internal service — strict by default
 * (`http_error`, `params.cause = tls_untrusted` with the fingerprint the console offers to trust), accepted only with a
 * pin of exactly that certificate for that `host:port`; and the DNS failure wording.
 */

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

function spec(url: string, port: number) {
  return HttpSpecSchema.parse({
    type: 'http',
    idempotencyKey: 'wf2:run1:node1',
    request: {
      method: 'POST',
      url,
      headers: {},
      body: { contentType: 'application/json', text: '{"a":1}' },
      timeoutSec: 5,
      maxResponseBytes: 1024 * 1024,
      followRedirects: 0,
      responseType: 'json',
    },
    egress: {
      mode: 'open',
      hosts: [`api.example.test:${String(port)}`, `other.example.test:${String(port)}`],
    },
  });
}

async function failure(p: Promise<unknown>): Promise<FunctionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FunctionError) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

const cert = testCert();

describe.skipIf(cert === null)('p22-runtime-diagnostics: pinned certificates of function jobs', () => {
  async function selfSigned(): Promise<{ port: number; requests: string[]; sha256: string }> {
    if (cert === null) throw new Error('no cert');
    const requests: string[] = [];
    const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        requests.push(body);
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const sha256 = createHash('sha256').update(new X509Certificate(cert.cert).raw).digest('hex');
    return { port: (server.address() as AddressInfo).port, requests, sha256 };
  }

  const dns = fakeDns({ 'api.example.test': ['127.0.0.1'], 'other.example.test': ['127.0.0.1'] });
  // No test CA: the production trust store, so the self-signed certificate is refused.
  const http = new NodeHttpExecutor({ lookup: dns.lookup, isPublicAddress: onlyTestServer });

  it('default strict: tls_untrusted with the fingerprint, and the server never got the request', async () => {
    const { port, requests, sha256 } = await selfSigned();
    const err = await failure(http.run(spec(`https://api.example.test:${String(port)}/x`, port), ctxWith()));
    expect(err.code).toBe('http_error');
    expect(err.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(err.message).toContain(sha256);
    expect(err.params).toEqual({
      cause: 'tls_untrusted',
      tlsCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      host: 'api.example.test',
      port,
      certSha256: sha256,
    });
    expect(requests).toEqual([]);
  });

  it('a pin of exactly that certificate for that host:port lets the request through', async () => {
    const { port, requests, sha256 } = await selfSigned();
    const tlsPins: AssignedTlsPin[] = [{ host: 'api.example.test', port, sha256 }];
    const r = await http.run(spec(`https://api.example.test:${String(port)}/x`, port), {
      ...ctxWith(),
      tlsPins,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(requests).toEqual(['{"a":1}']);
  });

  it('a pin of another host or another certificate does not', async () => {
    const { port, requests, sha256 } = await selfSigned();
    const otherHost = await failure(
      http.run(spec(`https://other.example.test:${String(port)}/x`, port), {
        ...ctxWith(),
        tlsPins: [{ host: 'api.example.test', port, sha256 }],
      }),
    );
    expect(otherHost.params?.cause).toBe('tls_untrusted');
    const wrong = await failure(
      http.run(spec(`https://api.example.test:${String(port)}/x`, port), {
        ...ctxWith(),
        tlsPins: [{ host: 'api.example.test', port, sha256: '0'.repeat(64) }],
      }),
    );
    expect(wrong.params).toMatchObject({ cause: 'tls_untrusted', pinMismatch: 1, certSha256: sha256 });
    expect(requests).toEqual([]);
  });
});

describe('p22-runtime-diagnostics: a name that does not resolve', () => {
  it('says the domain does not resolve and where to look', async () => {
    const dns = fakeDns({});
    const err = await failure(
      resolveTarget('app.example.com', 443, { mode: 'open', hosts: [] }, 'http', dns),
    );
    expect(err.code).toBe('dns_failed');
    expect(err.message).toContain('app.example.com does not resolve');
    expect(err.message).toContain('Cloudflare');
    expect(err.params).toEqual({ host: 'app.example.com' });
  });

  it('a quick-tunnel address says its tunnel was probably stopped', () => {
    const err = dnsFailure('sharp-fox-1.trycloudflare.com', 'ENOTFOUND');
    expect(err.message).toContain('(ENOTFOUND)');
    expect(err.message).toContain('tunnel (preview) is stopped');
    expect(err.params).toEqual({ cause: 'tunnel_address', host: 'sharp-fox-1.trycloudflare.com' });
  });
});
