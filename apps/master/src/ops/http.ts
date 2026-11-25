import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * p6-deploy-integrations: the one HTTP client the master uses to call Coolify and Cloudflare (ADR-0028 §SSRF).
 *
 * - The Coolify URL is set by an administrator in the panel, so the destination is semi-trusted: only `https:`,
 *   no credentials in the URL, and every address the host name resolves to must be public — the check runs inside
 *   the socket's `lookup`, so the address that is checked is the address that is connected to (no DNS-rebinding
 *   window between check and connect).
 * - Redirects are never followed (a 3xx is returned to the caller, which treats it as an error), so a public host
 *   cannot bounce the request (and its bearer token) to an internal address.
 * - Exceptions are exact origins set by the operator in the master's environment (`OPS_INTERNAL_ORIGINS`, e.g. the
 *   Coolify container on the control-plane host's Docker network), never by the panel.
 * - Responses are capped; time-outs are short. The token is passed in by the caller per request and never logged.
 */

export interface OpsHttpRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
  readonly timeoutMs?: number;
}

export interface OpsHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export type OpsFetch = (req: OpsHttpRequest) => Promise<OpsHttpResponse>;

export class OpsHttpError extends Error {
  override name = 'OpsHttpError';
  constructor(
    readonly code: 'url_refused' | 'address_refused' | 'timeout' | 'too_large' | 'network',
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY = 4 * 1024 * 1024;

/** Non-public IPv4/IPv6 ranges (loopback, private, link-local incl. cloud metadata, CGNAT/Tailscale, ULA, …). */
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    b.addSubnet(net, bits, 'ipv4');
  }
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32],
    ['64:ff9b::', 96],
  ] as const) {
    b.addSubnet(net, bits, 'ipv6');
  }
  return b;
})();

/** True for an address the guarded client must never connect to (IPv4-mapped IPv6 is checked as IPv4). */
export function isNonPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return BLOCKED.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

/**
 * Validates an administrator-supplied base URL (Coolify instance). Returns the normalised URL (no trailing slash)
 * or a reason. `internalOrigins` are exact origins the operator allowed in the environment.
 */
export function checkBaseUrl(
  raw: string,
  internalOrigins: ReadonlySet<string>,
): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'credentials in the URL' };
  if (u.search !== '' || u.hash !== '') return { ok: false, reason: 'query or fragment in the URL' };
  const internal = internalOrigins.has(u.origin);
  if (!internal && u.protocol !== 'https:') return { ok: false, reason: 'only https:// URLs are allowed' };
  if (!internal && isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    if (isNonPublicAddress(u.hostname.replace(/^\[|\]$/g, ''))) {
      return { ok: false, reason: 'the address is not public' };
    }
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.origin}${path}` };
}

export function guardedLookup(
  hostname: string,
  options: { all?: boolean } & Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses;
    const bad = list.find((a) => isNonPublicAddress(a.address));
    if (bad !== undefined || list.length === 0) {
      const e = new Error('address refused') as NodeJS.ErrnoException;
      e.code = 'EADDRREFUSED_REMYRAL';
      callback(e, '', 0);
      return;
    }
    if (options.all === true) callback(null, list);
    else callback(null, list[0]?.address ?? '', list[0]?.family ?? 4);
  });
}

export interface GuardedFetchOptions {
  /** Exact origins (scheme://host:port) exempt from the https/public-address rules (operator env, tests). */
  readonly internalOrigins?: Iterable<string>;
  readonly maxBytes?: number;
}

/** The production client (see the module comment). */
export function createGuardedFetch(opts: GuardedFetchOptions = {}): OpsFetch {
  // p17-panel-settings: a set-like value (the panel's live set) is used as is, so a change applies at once.
  const given = opts.internalOrigins;
  const internal: ReadonlySet<string> =
    given !== undefined && typeof (given as ReadonlySet<string>).has === 'function'
      ? (given as ReadonlySet<string>)
      : new Set(given ?? []);
  const maxBytes = opts.maxBytes ?? MAX_BODY;
  return (req) =>
    new Promise<OpsHttpResponse>((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(req.url);
      } catch {
        reject(new OpsHttpError('url_refused', 'invalid URL'));
        return;
      }
      const isInternal = internal.has(u.origin);
      if (!isInternal && u.protocol !== 'https:') {
        reject(new OpsHttpError('url_refused', 'only https:// destinations are allowed'));
        return;
      }
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!isInternal && isIP(host) !== 0 && isNonPublicAddress(host)) {
        reject(new OpsHttpError('address_refused', 'the destination address is not public'));
        return;
      }
      const mod = u.protocol === 'https:' ? https : http;
      const body = req.body === undefined ? undefined : Buffer.from(req.body);
      const r = mod.request(
        u,
        {
          method: req.method,
          headers: {
            ...req.headers,
            ...(body === undefined ? {} : { 'content-length': String(body.length) }),
          },
          ...(isInternal ? {} : { lookup: guardedLookup as unknown as typeof dnsLookup }),
          timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              reject(new OpsHttpError('too_large', 'response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') headers[k.toLowerCase()] = v;
              else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
          res.on('error', () => {
            reject(new OpsHttpError('network', 'connection failed'));
          });
        },
      );
      r.on('timeout', () => {
        r.destroy();
        reject(new OpsHttpError('timeout', 'request timed out'));
      });
      r.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRREFUSED_REMYRAL') {
          reject(new OpsHttpError('address_refused', 'the destination resolves to a non-public address'));
        } else if (!(err instanceof OpsHttpError)) {
          // Only the error code: the message could echo the URL (never the token, which is a header).
          reject(new OpsHttpError('network', `connection failed (${err.code ?? 'error'})`));
        }
      });
      if (body !== undefined) r.write(body);
      r.end();
    });
}

/** Parses a JSON body; null when it is not JSON. */
export function jsonOf(res: OpsHttpResponse): unknown {
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
