import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressDecision, type EgressProxy } from '../src/sandbox/egress/proxy.js';
import { SandboxRequestError } from '../src/sandbox/errors.js';
import { isForbiddenAddress, normalizeNetworkPolicy, parseEgressTarget } from '../src/sandbox/network.js';

describe('egress policy (T-SBX-2, T-INJ-1)', () => {
  it('forbids loopback, LAN, link-local/metadata, CGNAT, multicast, ULA and mapped forms', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.223',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:192.168.0.1',
      '64:ff9b::a9fe:a9fe',
      'not-an-ip',
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '160.79.104.10', '172.32.0.1', '2606:4700::1111', '::ffff:1.1.1.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it('parses allowlist entries: host names only, default port 443', () => {
    expect(parseEgressTarget('API.Anthropic.com')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(parseEgressTarget('api.openai.com:8443')).toEqual({ host: 'api.openai.com', port: 8443 });
    for (const bad of [
      '169.254.169.254',
      '10.0.0.1:443',
      '[::1]',
      'localhost',
      'a b.com',
      '-x.com',
      'x.com:0',
      'x.com:99999',
      '',
    ]) {
      expect(() => parseEgressTarget(bad), bad).toThrow(SandboxRequestError);
    }
  });

  it('normalizes a policy (dedup, sorted) and refuses an empty allowlist', () => {
    expect(
      normalizeNetworkPolicy({
        mode: 'allowlist',
        targets: [
          { host: 'B.example.com', port: 443 },
          { host: 'a.example.com', port: 443 },
          { host: 'b.example.com', port: 443 },
        ],
      }),
    ).toEqual({
      mode: 'allowlist',
      targets: [
        { host: 'a.example.com', port: 443 },
        { host: 'b.example.com', port: 443 },
      ],
    });
    expect(() => normalizeNetworkPolicy({ mode: 'allowlist', targets: [] })).toThrow(SandboxRequestError);
  });
});

/** Raw CONNECT through the proxy; resolves with the status line and the socket. */
function connectVia(
  proxy: EgressProxy,
  target: string,
  method = 'CONNECT',
): Promise<{ status: number; socket: import('node:net').Socket }> {
  return new Promise((resolve, reject) => {
    const s = connect(proxy.port, '127.0.0.1');
    let buf = '';
    s.on('error', reject);
    s.on('data', function onData(c: Buffer) {
      buf += c.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end !== -1) {
        s.off('data', onData);
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), socket: s });
      }
    });
    s.on('close', () => {
      if (!buf.includes('\r\n\r\n')) resolve({ status: 0, socket: s });
    });
    s.write(
      method === 'CONNECT'
        ? `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`
        : `${method} http://${target}/ HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
    );
  });
}

describe('egress proxy (HTTP CONNECT allowlist)', () => {
  let upstream: Server | undefined;
  let proxy: EgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((r) => {
      if (upstream)
        upstream.close(() => {
          r();
        });
      else r();
    });
    proxy = undefined;
    upstream = undefined;
  });
  const px = (): EgressProxy => {
    if (!proxy) throw new Error('proxy not started');
    return proxy;
  };

  async function setup(
    extra: {
      lookup?: (h: string) => Promise<{ address: string; family: number }[]>;
      maxTunnels?: number;
    } = {},
  ) {
    upstream = createServer((s) => {
      s.on('data', (d) => s.write(`echo:${d.toString()}`));
    });
    await new Promise<void>((r) =>
      upstream?.listen(0, '127.0.0.1', () => {
        r();
      }),
    );
    const port = (upstream.address() as AddressInfo).port;
    const decisions: EgressDecision[] = [];
    proxy = await startEgressProxy({
      allow: [
        { host: 'allowed.example.com', port },
        { host: 'private.example.com', port },
        { host: 'nxdomain.example.com', port },
      ],
      lookup:
        extra.lookup ??
        ((h) => {
          if (h === 'allowed.example.com') return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
          if (h === 'private.example.com')
            return Promise.resolve([
              { address: '93.184.215.14', family: 4 },
              { address: '192.168.1.10', family: 4 },
            ]);
          return Promise.reject(new Error('ENOTFOUND'));
        }),
      // The test upstream is on loopback; every other forbidden range stays forbidden.
      isForbidden: (a) => a !== '127.0.0.1' && isForbiddenAddress(a),
      onDecision: (d) => decisions.push(d),
      ...(extra.maxTunnels === undefined ? {} : { maxTunnels: extra.maxTunnels }),
    });
    return { port, decisions };
  }

  it('tunnels to an allowlisted host and pipes bytes both ways', async () => {
    const { port, decisions } = await setup();
    const { status, socket } = await connectVia(px(), `allowed.example.com:${String(port)}`);
    expect(status).toBe(200);
    const reply = await new Promise<string>((r) => {
      socket.once('data', (d: Buffer) => {
        r(d.toString());
      });
      socket.write('ping');
    });
    expect(reply).toBe('echo:ping');
    socket.destroy();
    expect(decisions).toContainEqual(
      expect.objectContaining({ allowed: true, reason: 'allowlisted', address: '127.0.0.1' }),
    );
  });

  it('refuses hosts not on the allowlist, other ports, IP literals and plain HTTP', async () => {
    const { port, decisions } = await setup();
    expect((await connectVia(px(), `evil.example.com:${String(port)}`)).status).toBe(403);
    expect((await connectVia(px(), 'allowed.example.com:22')).status).toBe(403);
    expect((await connectVia(px(), `127.0.0.1:${String(port)}`)).status).toBe(403);
    expect((await connectVia(px(), '169.254.169.254:80')).status).toBe(403);
    expect((await connectVia(px(), `allowed.example.com:${String(port)}`, 'GET')).status).toBe(403);
    expect(decisions.filter((d) => d.allowed)).toEqual([]);
    expect(decisions.map((d) => d.reason)).toEqual([
      'not-allowlisted',
      'not-allowlisted',
      'bad-request',
      'bad-request',
      'bad-request',
    ]);
  });

  it('refuses an allowlisted name that resolves to a private address (DNS rebinding) or does not resolve', async () => {
    const { port, decisions } = await setup();
    expect((await connectVia(px(), `private.example.com:${String(port)}`)).status).toBe(403);
    expect((await connectVia(px(), `nxdomain.example.com:${String(port)}`)).status).toBe(502);
    expect(decisions).toEqual([
      expect.objectContaining({ allowed: false, reason: 'forbidden-address', address: '192.168.1.10' }),
      expect.objectContaining({ allowed: false, reason: 'dns-failed' }),
    ]);
  });

  it('bounds concurrent tunnels', async () => {
    const { port } = await setup({ maxTunnels: 1 });
    const first = await connectVia(px(), `allowed.example.com:${String(port)}`);
    expect(first.status).toBe(200);
    expect((await connectVia(px(), `allowed.example.com:${String(port)}`)).status).toBe(503);
    first.socket.destroy();
  });
});
