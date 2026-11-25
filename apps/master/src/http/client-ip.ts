import { BlockList, isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';

/**
 * Real client IP from a CDN header (e.g. Cloudflare's `CF-Connecting-IP`), honoured **only** when the
 * address that reached our outermost trusted proxy is one of the CDN's own egress ranges.
 *
 * Production chain (docs/ops/deploy-coolify.md): client → Cloudflare → Traefik → master. With
 * `TRUST_PROXY_HOPS=1` Fastify's `request.ip` is the address that connected to Traefik — a Cloudflare edge
 * IP for legitimate traffic. Anyone who reaches the origin directly (bypassing Cloudflare) can send any
 * `CF-Connecting-IP`; their `request.ip` is then not a Cloudflare address and the header is ignored.
 * The header must hold exactly one syntactically valid IP; anything else is ignored (never trusted).
 */
export interface ClientIpHeaderConfig {
  /** Lower-case header name. */
  readonly header: string;
  /** CIDRs (or single IPs) the immediate upstream of our trusted proxies must belong to. */
  readonly trustedSources: readonly string[];
}

export class ClientIpConfigError extends Error {
  override name = 'ClientIpConfigError';
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; other addresses unchanged. */
function normalize(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m?.[1] ?? ip;
}

/** Parses `a.b.c.d/nn`, `x:y::/nn` or a bare IP. Throws {@link ClientIpConfigError} (no values echoed). */
export function parseCidr(entry: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [rawAddress = '', rawPrefix, ...rest] = entry.trim().split('/');
  const address = normalize(rawAddress);
  const version = isIP(address);
  if (version === 0 || rest.length > 0) throw new ClientIpConfigError('not an IP address or CIDR');
  const max = version === 4 ? 32 : 128;
  if (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) {
    throw new ClientIpConfigError('invalid CIDR prefix length');
  }
  const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
  if (prefix > max) {
    throw new ClientIpConfigError('invalid CIDR prefix length');
  }
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** Returns a pure resolver `(proxyDerivedIp, headerValue) → client IP`. */
export function createClientIpResolver(
  cfg: ClientIpHeaderConfig,
): (peerIp: string, headerValue: string | readonly string[] | undefined) => string {
  if (cfg.trustedSources.length === 0) {
    throw new ClientIpConfigError('a trusted client-IP header needs at least one trusted source range');
  }
  const trusted = new BlockList();
  for (const entry of cfg.trustedSources) {
    const c = parseCidr(entry);
    trusted.addSubnet(c.address, c.prefix, c.family);
  }
  return (peerIp, headerValue) => {
    const peer = normalize(peerIp);
    const peerFamily = isIP(peer);
    if (peerFamily === 0 || !trusted.check(peer, peerFamily === 4 ? 'ipv4' : 'ipv6')) return peerIp;
    // Exactly one header instance with exactly one address; lists, duplicates and junk are ignored.
    if (typeof headerValue !== 'string') return peerIp;
    const candidate = normalize(headerValue.trim());
    if (candidate.length > 45 || isIP(candidate) === 0) return peerIp;
    return candidate;
  };
}

/**
 * Registers the first `onRequest` hook: replaces `request.ip` (which feeds rate limits, sessions and the
 * audit log) with the header value when {@link createClientIpResolver} allows it. Must run before every
 * other hook that reads `request.ip`.
 */
export function registerClientIpHeader(
  app: FastifyInstance,
  cfg: ClientIpHeaderConfig | (() => ClientIpHeaderConfig | null),
): void {
  // p17-panel-settings: a live configuration — the resolver is rebuilt when the settings change.
  let key = '';
  let resolve: ((peerIp: string, headerValue: string | readonly string[] | undefined) => string) | null =
    null;
  let header = '';
  const current = (): typeof resolve => {
    const c = typeof cfg === 'function' ? cfg() : cfg;
    const k = c === null ? '' : JSON.stringify(c);
    if (k !== key) {
      key = k;
      header = c === null ? '' : c.header.toLowerCase();
      try {
        resolve = c === null ? null : createClientIpResolver(c);
      } catch {
        resolve = null; // an unusable configuration ignores the header (never trusts it)
      }
    }
    return resolve;
  };
  app.addHook('onRequest', (request, _reply, done) => {
    const r = current();
    if (r !== null) {
      const peer = request.ip;
      const ip = r(peer, request.headers[header]);
      if (ip !== peer) {
        // Fastify computes `ip` with a prototype getter; an own property shadows it for this request only.
        Object.defineProperty(request, 'ip', { value: ip, enumerable: true, configurable: true });
      }
    }
    done();
  });
}

/**
 * p17-panel-settings: the client IP this request would get under other proxy settings — the proxy-addr walk over the
 * socket address and `X-Forwarded-For` with `hops` trusted hops, then the CDN header rule. Used before a save so the
 * owner cannot lock themselves out unknowingly.
 */
export function clientIpUnder(
  socketAddress: string,
  forwardedFor: string | readonly string[] | undefined,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  settings: { readonly hops: number; readonly header: string; readonly sources: readonly string[] },
): string {
  const raw: string = typeof forwardedFor === 'string' ? forwardedFor : (forwardedFor ?? []).join(',');
  const xff = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .reverse();
  const addrs = [socketAddress, ...xff];
  let i = 0;
  while (i < addrs.length - 1 && i < settings.hops) i++;
  const peer = addrs[i] ?? socketAddress;
  if (settings.header === '' || settings.sources.length === 0) return peer;
  try {
    return createClientIpResolver({ header: settings.header, trustedSources: settings.sources })(
      peer,
      headers[settings.header],
    );
  } catch {
    return peer;
  }
}
