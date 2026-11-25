import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { FUNCTION_HTTP_PORTS, FUNCTION_SMTP_PORTS, type FunctionEgress } from '@remyral/protocol';
import { isForbiddenAddress } from '../sandbox/network.js';
import { FunctionError } from './types.js';

/**
 * p14-workflow-engine 14.3 (ADR-0055 K1, §8.1 "SSRF / LAN access from workers"): the egress guard of function jobs.
 *
 * Every connection target — the first URL of an HTTP node, every redirect hop, the SMTP host of an e-mail node — goes
 * through {@link resolveTarget}:
 *  1. the host is normalised the way the connection would read it (WHATWG URL host parsing: `2130706433`,
 *     `0x7f000001`, `0177.0.0.1` and `127.1` all become `127.0.0.1`; IPv6 literals lose their brackets);
 *  2. a visibly internal name (`localhost`, `*.local`, `*.internal`, metadata names) or a non-public IP literal is
 *     refused (`egress_refused`) — the security floor holds in every policy mode;
 *  3. the project policy (K1): `open` = any public host on the default ports of the kind (HTTP 80 / 443 / 8080 /
 *     8443, SMTP 25 / 465 / 587 / 2525) or a `host:port` the project lists; `allowlist` = only listed hosts
 *     (`host` = its default ports, `host:port` = that port) → `egress_not_allowed`;
 *  4. the name is resolved once (all addresses); **any** non-public address refuses the target (a mixed answer is a
 *     rebinding / split-horizon signal), no address → `dns_failed`;
 *  5. the caller connects to exactly the returned, checked address ({@link PinnedTarget.address}) — the host name is
 *     used only for TLS SNI / certificate checks and the Host header, never resolved again.
 */

export type EgressKind = 'http' | 'smtp';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface EgressDeps {
  /** DNS: every address of a name. Default `dns.promises.lookup(host, { all: true, verbatim: true })`. */
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  /**
   * Whether an address may be connected to. Default: not {@link isForbiddenAddress}. Production never overrides it;
   * tests allow exactly their own loopback server address with it.
   */
  readonly isPublicAddress?: (address: string) => boolean;
}

export interface PinnedTarget {
  /** Normalised host (lower case, no brackets, no trailing dot). */
  readonly host: string;
  readonly port: number;
  /** The checked address the connection must go to. */
  readonly address: string;
  readonly family: 4 | 6;
  /** The host was an IP literal (no SNI). */
  readonly literal: boolean;
}

const defaultLookup = async (host: string): Promise<readonly ResolvedAddress[]> =>
  dnsLookup(host, { all: true, verbatim: true });

/** Names that are internal whatever they resolve to (the static part of the floor; DNS is checked as well). */
export function isInternalName(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan|home|intranet|corp|localdomain|home\.arpa)$/.test(host)) return true;
  return host === 'metadata' || host === 'instance-data' || !host.includes('.');
}

/**
 * The host as a connection would read it: WHATWG URL host parsing (numeric IPv4 shorthands become dotted quads,
 * IPv6 is compressed), lower case, no brackets, no trailing dot. Throws `function_refused` on a malformed host.
 */
export function normalizeHost(raw: string): string {
  let input = raw.trim();
  if (isIP(input) === 6) input = `[${input}]`;
  let host: string;
  try {
    host = new URL(`http://${input}/`).hostname;
  } catch {
    throw new FunctionError('function_refused', `invalid host ${JSON.stringify(raw.slice(0, 100))}`);
  }
  host = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === '') throw new FunctionError('function_refused', 'empty host');
  return host;
}

function defaultPorts(kind: EgressKind): readonly number[] {
  return kind === 'http' ? FUNCTION_HTTP_PORTS : FUNCTION_SMTP_PORTS;
}

function parseEntry(entry: string): { host: string; port: number | null } {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(entry.trim().toLowerCase());
  const host = (m?.[1] ?? '').replace(/\.$/, '');
  return { host, port: m?.[2] === undefined ? null : Number(m[2]) };
}

/** K1 policy: is `host:port` allowed for this kind under the project's egress policy (floor checked elsewhere)? */
export function policyAllows(host: string, port: number, egress: FunctionEgress, kind: EgressKind): boolean {
  const entries = egress.hosts.map(parseEntry);
  const exact = entries.some((e) => e.host === host && e.port === port);
  if (exact) return true;
  const standard = defaultPorts(kind).includes(port);
  if (egress.mode === 'open') return standard;
  return standard && entries.some((e) => e.host === host && e.port === null);
}

/** Credential host binding: `host` (any port) or exact `host:port` of the credential's `allowedHosts`. */
export function credentialHostAllowed(allowed: readonly string[], host: string, port: number): boolean {
  return allowed.map(parseEntry).some((e) => e.host === host && (e.port === null || e.port === port));
}

/** Resolves and checks one connection target (steps 1–4 above); the caller connects to `address` only. */
export async function resolveTarget(
  rawHost: string,
  port: number,
  egress: FunctionEgress,
  kind: EgressKind,
  deps: EgressDeps = {},
): Promise<PinnedTarget> {
  const allowed = deps.isPublicAddress ?? ((a: string) => !isForbiddenAddress(a));
  const host = normalizeHost(rawHost);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new FunctionError('egress_not_allowed', `invalid port ${String(port)}`);
  const literal = isIP(host);
  if (literal !== 0) {
    if (!allowed(host)) throw new FunctionError('egress_refused', `${host} is not a public address`);
  } else if (isInternalName(host)) {
    throw new FunctionError('egress_refused', `${host} is an internal name`);
  }
  if (!policyAllows(host, port, egress, kind)) {
    throw new FunctionError(
      'egress_not_allowed',
      egress.mode === 'allowlist'
        ? `${host}:${String(port)} is not on the project's HTTP allowlist`
        : `port ${String(port)} is not allowed for ${host} (list ${host}:${String(port)} in the project's allowlist)`,
    );
  }
  if (literal !== 0) return { host, port, address: host, family: literal as 4 | 6, literal: true };
  let answers: readonly ResolvedAddress[];
  try {
    answers = await (deps.lookup ?? defaultLookup)(host);
  } catch (err) {
    throw dnsFailure(host, (err as { code?: unknown }).code);
  }
  if (answers.length === 0) throw dnsFailure(host, undefined);
  for (const a of answers) {
    if (isIP(a.address) === 0 || !allowed(a.address)) {
      throw new FunctionError('egress_refused', `${host} resolves to a non-public address`);
    }
  }
  const first = answers[0] as ResolvedAddress;
  return { host, port, address: first.address, family: isIP(first.address) as 4 | 6, literal: false };
}

/**
 * A `lookup` for node:net / http that answers only the pinned address (a second resolution is impossible): the
 * connection goes to the address the guard checked, whatever DNS says now.
 */
export function pinnedLookup(target: PinnedTarget) {
  return (
    _hostname: string,
    options: unknown,
    callback: (
      err: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    const all =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

/** Cloudflare quick tunnels (`cloudflared tunnel --url`): the address exists only while its tunnel runs. */
const QUICK_TUNNEL = /\.trycloudflare\.com$/;

/**
 * p22-runtime-diagnostics: a name that does not resolve, said so the owner knows where to look — the domain's DNS
 * (Cloudflare: the record, the zone), or a quick-tunnel address whose tunnel (preview) was stopped. `params.host` lets
 * the master tell a stopped preview / service tunnel of the platform apart (`preview_stopped`).
 */
export function dnsFailure(host: string, code: unknown): FunctionError {
  const why = typeof code === 'string' && /^[A-Z_]{3,32}$/.test(code) ? ` (${code})` : '';
  if (QUICK_TUNNEL.test(host)) {
    return new FunctionError(
      'dns_failed',
      `${host} does not resolve${why}: it is a Cloudflare quick-tunnel address, which stops resolving once its tunnel (preview) is stopped; start the preview again and use its new address`,
      { cause: 'tunnel_address', host: host.slice(0, 200) },
    );
  }
  return new FunctionError(
    'dns_failed',
    code === 'EAI_AGAIN'
      ? `${host} could not be resolved right now${why}: the DNS server did not answer; check the machine's DNS and the domain's DNS records (Cloudflare: is the record there, is the zone active?)`
      : `${host} does not resolve${why}: the domain has no DNS address; check its DNS records (Cloudflare: is the record there, is the zone active?)`,
    { host: host.slice(0, 200) },
  );
}
