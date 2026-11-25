import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HostedHttp } from '../../src/gitflow/hosted-http.js';
import { createGuardedWebFetch, EgressRefusedError, isLinkLocalAddress } from '../../src/ops/web-fetch.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) =>
          s.close(() => {
            r();
          }),
        ),
    ),
  );
});

async function serve(
  handler: (
    url: string,
    headers: IncomingHttpHeaders,
  ) => { status: number; location?: string; body?: string },
): Promise<{ origin: string; seen: { url: string; headers: IncomingHttpHeaders }[] }> {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const out = handler(req.url ?? '', req.headers);
    res.writeHead(out.status, out.location === undefined ? {} : { location: out.location });
    res.end(out.body ?? '');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

describe('guarded fetch for administrator-configured destinations', () => {
  it('refuses http, non-public literals and names resolving to loopback unless the origin is listed', async () => {
    const f = createGuardedWebFetch({ redirects: 'same-origin' });
    await expect(f('http://example.test/', {})).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(f('https://10.0.0.5/', {})).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(f('https://localhost:1/', {})).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('never reaches a link-local (metadata) address, even for a listed internal origin', async () => {
    expect(isLinkLocalAddress('169.254.169.254')).toBe(true);
    expect(isLinkLocalAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isLinkLocalAddress('10.1.2.3')).toBe(false);
    const f = createGuardedWebFetch({
      redirects: 'follow',
      internalOrigins: new Set(['http://169.254.169.254']),
    });
    await expect(f('http://169.254.169.254/latest/meta-data/', {})).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
  });

  it('credentialed calls: same-origin redirects only; the token never reaches another origin', async () => {
    const other = await serve(() => ({ status: 200, body: '{}' }));
    const api = await serve((url) =>
      url.startsWith('/moved')
        ? { status: 301, location: '/api/v4/projects/x' }
        : url.startsWith('/away')
          ? { status: 302, location: `${other.origin}/steal` }
          : { status: 200, body: '{"ok":true}' },
    );
    const internalOrigins = new Set([api.origin, other.origin]);
    const http = new HostedHttp({
      name: 'GitLab',
      apiRoot: api.origin,
      token: () => Promise.resolve('glpat-test-token'),
      fetch: createGuardedWebFetch({ redirects: 'same-origin', internalOrigins }),
    });
    const ok = await http.request('GET', '/moved');
    expect(ok.status).toBe(200);
    expect(api.seen.at(-1)?.headers['private-token']).toBe('glpat-test-token');
    await expect(http.request('GET', '/away')).rejects.toThrow(/network/);
    expect(other.seen).toHaveLength(0);
  });

  it('anonymous downloads follow a redirect to another origin, re-checked, without credential headers', async () => {
    const cdn = await serve(() => ({ status: 200, body: 'vsix' }));
    const registry = await serve((url) =>
      url.startsWith('/meta')
        ? { status: 302, location: 'https://169.254.169.254/' }
        : { status: 302, location: `${cdn.origin}/file` },
    );
    const f = createGuardedWebFetch({
      redirects: 'follow',
      internalOrigins: new Set([registry.origin, cdn.origin]),
    });
    const res = await f(`${registry.origin}/dl`, { headers: { authorization: 'Bearer x', accept: '*/*' } });
    expect(await res.text()).toBe('vsix');
    expect(cdn.seen[0]?.headers.authorization).toBeUndefined();
    expect(cdn.seen[0]?.headers.accept).toBe('*/*');
    await expect(f(`${registry.origin}/meta`, {})).rejects.toBeInstanceOf(EgressRefusedError);
  });
});
