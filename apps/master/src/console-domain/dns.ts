import { promises as dnsPromises } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * p17-domain-wizard §3: "DNS bu sunucuyu gösteriyor mu?" — the master resolves the new name (A and AAAA) and compares
 * the answers with what it knows about this server: the addresses the current public name resolves to and the
 * addresses the host applier reports (its global interface addresses). The resolver is injectable (tests use a fake).
 *
 * Verdicts:
 * - `match` — at least one address of the new name is one of this server's known addresses (and the name is not
 *   proxied by Cloudflare).
 * - `cloudflare` — every address is a Cloudflare edge address (proxied DNS): the name is served by Cloudflare, which
 *   forwards to the origin configured there; the master cannot see that origin, so this is a hint, not a proof.
 * - `mismatch` — the name resolves, but to none of the known addresses.
 * - `not_found` — no A / AAAA record (NXDOMAIN or no data).
 * - `unknown` — the name resolves but there is nothing to compare with (no current origin, no host applier).
 * - `error` — the lookup failed (timeout, server failure).
 */

export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

export type DnsVerdict = 'match' | 'cloudflare' | 'mismatch' | 'not_found' | 'unknown' | 'error';

export interface DnsCheckResult {
  readonly domain: string;
  readonly addresses: readonly string[];
  /** The addresses the new name was compared with (this server's known addresses). */
  readonly expected: readonly string[];
  readonly verdict: DnsVerdict;
  /** The resolver's error code for `error` (ETIMEOUT, ESERVFAIL, …); null otherwise. */
  readonly detail: string | null;
  readonly checkedAt: string;
}

/** https://www.cloudflare.com/ips-v4 + ips-v6 as of 2026-10-13 (same list as infra/coolify/compose.yaml). */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const cloudflare = (() => {
  const list = new BlockList();
  for (const r of CLOUDFLARE_RANGES) {
    const [net, bits] = r.split('/');
    if (net === undefined || bits === undefined) continue;
    list.addSubnet(net, Number(bits), isIP(net) === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
})();

export function isCloudflareAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  return cloudflare.check(ip, v === 6 ? 'ipv6' : 'ipv4');
}

export const systemResolver: Resolver = {
  resolve4: (h) => dnsPromises.resolve4(h),
  resolve6: (h) => dnsPromises.resolve6(h),
};

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' }));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** All A + AAAA addresses of a name. `not_found` when neither exists; throws other resolver errors. */
export async function lookupAll(
  resolver: Resolver,
  host: string,
  timeoutMs: number,
): Promise<{ addresses: string[]; notFound: boolean }> {
  const one = async (fn: (h: string) => Promise<string[]>): Promise<string[] | 'none'> => {
    try {
      return await withTimeout(fn(host), timeoutMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (NOT_FOUND.has(code)) return 'none';
      throw err;
    }
  };
  const [v4, v6] = await Promise.all([one((h) => resolver.resolve4(h)), one((h) => resolver.resolve6(h))]);
  const addresses = [...(v4 === 'none' ? [] : v4), ...(v6 === 'none' ? [] : v6)];
  return { addresses: [...new Set(addresses)].sort(), notFound: addresses.length === 0 };
}

export async function checkDns(input: {
  readonly domain: string;
  readonly resolver: Resolver;
  /** Names that point at this server (the current public origin's host). */
  readonly knownHosts: readonly string[];
  /** Addresses this server has (the host applier's report). */
  readonly knownAddresses: readonly string[];
  readonly now: Date;
  readonly timeoutMs?: number;
}): Promise<DnsCheckResult> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  const base = { domain: input.domain, checkedAt: input.now.toISOString() };
  let found: { addresses: string[]; notFound: boolean };
  try {
    found = await lookupAll(input.resolver, input.domain, timeoutMs);
  } catch (err) {
    return {
      ...base,
      addresses: [],
      expected: [],
      verdict: 'error',
      detail: ((err as NodeJS.ErrnoException).code ?? 'lookup_failed').slice(0, 40),
    };
  }
  const expected = new Set(input.knownAddresses.filter((a) => isIP(a) !== 0));
  for (const h of input.knownHosts) {
    if (h === input.domain) continue;
    try {
      for (const a of (await lookupAll(input.resolver, h, timeoutMs)).addresses) expected.add(a);
    } catch {
      // The current name not resolving only means there is less to compare with.
    }
  }
  const exp = [...expected].sort();
  if (found.notFound) return { ...base, addresses: [], expected: exp, verdict: 'not_found', detail: null };
  const addrs = found.addresses;
  let verdict: DnsVerdict;
  // Proxied names share Cloudflare's anycast addresses, so an overlap with a proxied current name proves nothing.
  if (addrs.every(isCloudflareAddress)) verdict = 'cloudflare';
  else if (addrs.some((a) => expected.has(a))) verdict = 'match';
  else if (exp.length === 0) verdict = 'unknown';
  else verdict = 'mismatch';
  return { ...base, addresses: addrs, expected: exp, verdict, detail: null };
}
