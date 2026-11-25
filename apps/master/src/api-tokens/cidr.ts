import { BlockList, isIP } from 'node:net';

/**
 * p16-api-tokens: the optional IP allowlist of a token (IPv4 / IPv6 CIDR ranges, or single addresses). Pure.
 */
export const MAX_CIDRS = 16;

export interface Cidr {
  readonly address: string;
  readonly prefix: number;
  readonly family: 'ipv4' | 'ipv6';
}

/** An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) as plain IPv4; anything else unchanged. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m?.[1] ?? ip;
}

/** `10.0.0.0/8`, `2001:db8::/32` or a single address (`/32` / `/128`); null when invalid. */
export function parseCidr(value: string): Cidr | null {
  const v = value.trim();
  const [addr = '', prefixText, extra] = v.split('/');
  if (extra !== undefined) return null;
  const version = isIP(addr);
  if (version === 0) return null;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  const max = version === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix < 0 || prefix > max) return null;
  return { address: addr.toLowerCase(), prefix, family };
}

/** The canonical text of a range (`address/prefix`). */
export function formatCidr(c: Cidr): string {
  return `${c.address}/${String(c.prefix)}`;
}

/** Whether `ip` is inside one of `cidrs` (an empty list allows every address). */
export function ipAllowed(ip: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  const addr = normalizeIp(ip);
  const version = isIP(addr);
  if (version === 0) return false;
  const list = new BlockList();
  for (const text of cidrs) {
    const c = parseCidr(text);
    if (c !== null) list.addSubnet(c.address, c.prefix, c.family);
  }
  return list.check(addr, version === 4 ? 'ipv4' : 'ipv6');
}
