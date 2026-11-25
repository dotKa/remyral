import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type RoutePlugin } from '../../src/app.js';
import { ConfigError, loadConfig } from '../../src/config.js';
import { ClientIpConfigError, createClientIpResolver, parseCidr } from '../../src/http/client-ip.js';

// Cloudflare-like edge ranges (documentation prefixes stand in for the real ones).
const CF = ['198.51.100.0/24', '2001:db8:cf::/48'];
const CF_EDGE = '198.51.100.20';
const TRAEFIK = '10.0.1.5';

describe('parseCidr', () => {
  it('accepts IPv4/IPv6 CIDRs and bare addresses', () => {
    expect(parseCidr('173.245.48.0/20')).toEqual({ address: '173.245.48.0', prefix: 20, family: 'ipv4' });
    expect(parseCidr(' 2400:cb00::/32 ')).toEqual({ address: '2400:cb00::', prefix: 32, family: 'ipv6' });
    expect(parseCidr('10.0.0.1')).toMatchObject({ prefix: 32 });
    expect(parseCidr('::1')).toMatchObject({ prefix: 128 });
  });

  it.each(['', 'nope', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/8/8', '::/129', '10.0.0.0/ 8', '10.0.0.0/x'])(
    'rejects %j',
    (v) => {
      expect(() => parseCidr(v)).toThrow(ClientIpConfigError);
    },
  );
});

describe('createClientIpResolver', () => {
  const resolve = createClientIpResolver({ header: 'cf-connecting-ip', trustedSources: CF });

  it('uses the header only when the proxy-derived peer is a trusted source', () => {
    expect(resolve(CF_EDGE, '203.0.113.7')).toBe('203.0.113.7');
    expect(resolve('2001:db8:cf::9', '2001:db8:1::5')).toBe('2001:db8:1::5');
    expect(resolve('::ffff:198.51.100.20', '203.0.113.7')).toBe('203.0.113.7');
    // Direct-to-origin attacker forging the header: peer is not a trusted source.
    expect(resolve('192.0.2.66', '203.0.113.7')).toBe('192.0.2.66');
  });

  it('ignores missing, duplicated, list-valued or malformed headers', () => {
    expect(resolve(CF_EDGE, undefined)).toBe(CF_EDGE);
    expect(resolve(CF_EDGE, ['203.0.113.7', '203.0.113.8'])).toBe(CF_EDGE);
    expect(resolve(CF_EDGE, '203.0.113.7, 203.0.113.8')).toBe(CF_EDGE);
    expect(resolve(CF_EDGE, 'not-an-ip')).toBe(CF_EDGE);
    expect(resolve(CF_EDGE, '')).toBe(CF_EDGE);
    expect(resolve(CF_EDGE, `1.2.3.4${' '.repeat(100)}x`)).toBe(CF_EDGE);
  });

  it('normalises IPv4-mapped header values', () => {
    expect(resolve(CF_EDGE, '::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('refuses an empty trusted source list', () => {
    expect(() => createClientIpResolver({ header: 'cf-connecting-ip', trustedSources: [] })).toThrow(
      ClientIpConfigError,
    );
  });
});

describe('buildApp with a trusted client-IP header', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const echoIp: RoutePlugin = (a) => {
    a.get('/ip', { config: { auth: 'public' } }, (req) => ({ ip: req.ip }));
  };
  async function make(clientIpHeader?: { header: string; trustedSources: string[] }) {
    app = await buildApp({
      logLevel: 'silent',
      trustProxyHops: 1,
      bodyLimitBytes: 1024,
      ...(clientIpHeader ? { clientIpHeader } : {}),
      routes: [echoIp],
    });
    return app;
  }
  const get = (a: FastifyInstance, headers: Record<string, string>) =>
    a
      .inject({ method: 'GET', url: '/ip', remoteAddress: TRAEFIK, headers })
      .then((r) => r.json<{ ip: string }>().ip);

  it('Cloudflare → Traefik → master: request.ip is CF-Connecting-IP', async () => {
    const a = await make({ header: 'cf-connecting-ip', trustedSources: CF });
    expect(await get(a, { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': '203.0.113.7' })).toBe(
      '203.0.113.7',
    );
  });

  it('direct to origin: a forged CF-Connecting-IP is ignored', async () => {
    const a = await make({ header: 'cf-connecting-ip', trustedSources: CF });
    expect(await get(a, { 'x-forwarded-for': '192.0.2.66', 'cf-connecting-ip': '203.0.113.7' })).toBe(
      '192.0.2.66',
    );
  });

  it('not configured: the header is never trusted', async () => {
    const a = await make();
    expect(await get(a, { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': '203.0.113.7' })).toBe(CF_EDGE);
  });
});

describe('config: TRUSTED_CLIENT_IP_HEADER', () => {
  const base = {
    DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
    REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
    TOTP_KEY_FILE: '/abs/totp.key',
  };

  it('is off by default', () => {
    expect(loadConfig(base, '/cwd').clientIpHeader).toBeNull();
  });

  it('treats empty variables (compose `VAR=`) as unset', () => {
    const c = loadConfig(
      { ...base, TRUSTED_CLIENT_IP_HEADER: '', TRUSTED_CLIENT_IP_SOURCES: '', RELEASE_PUBLIC_KEYS: '' },
      '/cwd',
    );
    expect(c.clientIpHeader).toBeNull();
    expect(c.releasePublicKeys).toEqual([]);
    expect(() => loadConfig({ ...base, DATABASE_URL: '' }, '/cwd')).toThrow(ConfigError);
  });

  it('parses header + sources', () => {
    const c = loadConfig(
      {
        ...base,
        TRUST_PROXY_HOPS: '1',
        TRUSTED_CLIENT_IP_HEADER: 'cf-connecting-ip',
        TRUSTED_CLIENT_IP_SOURCES: '173.245.48.0/20, 2400:cb00::/32',
      },
      '/cwd',
    );
    expect(c.clientIpHeader).toEqual({
      header: 'cf-connecting-ip',
      trustedSources: ['173.245.48.0/20', '2400:cb00::/32'],
    });
  });

  it.each([
    [{ TRUST_PROXY_HOPS: '1', TRUSTED_CLIENT_IP_HEADER: 'cf-connecting-ip' }, 'sources missing'],
    [
      { TRUSTED_CLIENT_IP_HEADER: 'cf-connecting-ip', TRUSTED_CLIENT_IP_SOURCES: '10.0.0.0/8' },
      'no trusted proxy hop',
    ],
    [
      {
        TRUST_PROXY_HOPS: '1',
        TRUSTED_CLIENT_IP_HEADER: 'cf-connecting-ip',
        TRUSTED_CLIENT_IP_SOURCES: '10.0.0.0/99',
      },
      'bad CIDR',
    ],
    [
      {
        TRUST_PROXY_HOPS: '1',
        TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for',
        TRUSTED_CLIENT_IP_SOURCES: '10.0.0.0/8',
      },
      'header not allowed',
    ],
    [{ TRUSTED_CLIENT_IP_SOURCES: '10.0.0.0/8' }, 'sources without header'],
  ])('rejects %j (%s) without echoing values', (extra: Record<string, string>, _why: string) => {
    let err: unknown;
    try {
      loadConfig({ ...base, ...extra }, '/cwd');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain('10.0.0.0');
  });
});
