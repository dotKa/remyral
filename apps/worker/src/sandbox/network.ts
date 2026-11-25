import { BlockList, isIP } from 'node:net';
import { SandboxRequestError } from './errors.js';
import type { EgressTarget, NetworkPolicy } from './types.js';

/**
 * Egress policy helpers (T-SBX-2, T-INJ-1). Pure; used by the worker and, bundled,
 * by the egress proxy sidecar.
 */

/** DNS host name: labels of [a-z0-9-], no leading/trailing hyphen, at least one dot. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Addresses a job must never reach, whatever the allowlist says: loopback, the
 * private ranges (LAN), link-local (incl. the cloud metadata IP 169.254.169.254),
 * CGNAT, multicast, reserved and documentation ranges, NAT64 and v4-mapped forms.
 */
const FORBIDDEN = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // `::/96`: the unspecified address, loopback `::1` and the deprecated IPv4-compatible `::a.b.c.d` form.
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv6');
}

/** IPv4 embedded in `::ffff:a.b.c.d` / `::ffff:xxxx:xxxx`, if any. */
function mappedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`;
  }
  return null;
}

/** True for any address the egress proxy must refuse (and for anything that is not an IP). */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return FORBIDDEN.check(address, 'ipv4');
  if (family === 6) {
    const v4 = mappedV4(address);
    if (v4 !== null) return FORBIDDEN.check(v4, 'ipv4');
    return FORBIDDEN.check(address, 'ipv6');
  }
  return true;
}

/** Normalizes and validates one allowlist entry: `host` (port 443) or `host:port`. */
export function parseEgressTarget(entry: string): EgressTarget {
  const trimmed = entry.trim().toLowerCase();
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (m?.[1] === undefined) throw new SandboxRequestError('network.targets', `malformed entry ${entry}`);
  const host = m[1].endsWith('.') ? m[1].slice(0, -1) : m[1];
  if (isIP(host) !== 0) {
    throw new SandboxRequestError(
      'network.targets',
      `IP literals are not allowed (${host}); use a host name`,
    );
  }
  if (!HOST.test(host)) throw new SandboxRequestError('network.targets', `invalid host name ${host}`);
  const port = m[2] === undefined ? 443 : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SandboxRequestError('network.targets', `invalid port in ${entry}`);
  }
  return { host, port };
}

export function formatTarget(t: EgressTarget): string {
  return `${t.host}:${String(t.port)}`;
}

/** Validates a network policy and returns it normalized (lower-case, deduplicated, sorted). */
export function normalizeNetworkPolicy(policy: NetworkPolicy): NetworkPolicy {
  if (policy.mode === 'none') return { mode: 'none' };
  if (policy.targets.length > 128) throw new SandboxRequestError('network.targets', 'at most 128 targets');
  const seen = new Map<string, EgressTarget>();
  for (const t of policy.targets) {
    const parsed = parseEgressTarget(formatTarget(t));
    seen.set(formatTarget(parsed), parsed);
  }
  if (seen.size === 0 && policy.mode === 'allowlist')
    throw new SandboxRequestError('network.targets', 'allowlist mode needs at least one target');
  const hint = policy.refusalHint?.trim().slice(0, 500);
  return {
    mode: policy.mode,
    targets: [...seen.values()].sort((a, b) => formatTarget(a).localeCompare(formatTarget(b))),
    ...(hint === undefined || hint === '' ? {} : { refusalHint: hint }),
  };
}

/**
 * Provider API hosts per runtime (model traffic only, ADR-0010 rule 3). The
 * operator can extend the allowlist per project; these are the defaults.
 */
export const PROVIDER_API_HOSTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com'],
};
