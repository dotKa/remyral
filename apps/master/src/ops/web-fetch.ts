import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { guardedLookup, isNonPublicAddress } from './http.js';

/**
 * A `fetch`-shaped client with the ops client's egress rules (see `./http.ts`), for administrator-configured
 * destinations that are called through a `fetch` signature: a self-managed GitLab (with its `private-token`) and an
 * Open VSX registry.
 *
 * - `https:` only and every resolved address public (checked inside the socket's `lookup`, so the checked address is
 *   the connected one) — except exact origins in `internalOrigins` (the operator's `ops.internalOrigins` /
 *   `OPS_INTERNAL_ORIGINS`, the same exception the Coolify connections use). Even for those, link-local addresses
 *   (cloud metadata) are refused.
 * - Redirects are handled here, never by the platform `fetch`: each hop is checked again. `same-origin` (credentialed
 *   calls) refuses a redirect to another origin; `follow` (anonymous downloads) follows it but drops every
 *   credential header first.
 * - The response body is capped; a `signal` in `init` aborts the request.
 */

export type WebFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface GuardedWebFetchOptions {
  readonly internalOrigins?: ReadonlySet<string>;
  readonly redirects: 'same-origin' | 'follow';
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

export class EgressRefusedError extends Error {
  override name = 'EgressRefusedError';
}

const LINK_LOCAL = (() => {
  const b = new BlockList();
  b.addSubnet('169.254.0.0', 16, 'ipv4');
  b.addSubnet('fe80::', 10, 'ipv6');
  b.addAddress('fd00:ec2::254', 'ipv6');
  return b;
})();

/** Link-local (incl. the cloud metadata addresses): refused even for an operator-listed internal origin. */
export function isLinkLocalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return LINK_LOCAL.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (family === 4) return LINK_LOCAL.check(address, 'ipv4');
  if (family === 6) return LINK_LOCAL.check(address, 'ipv6');
  return true;
}

function internalLookup(
  hostname: string,
  options: { all?: boolean } & Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, list) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    if (list.length === 0 || list.some((a) => isLinkLocalAddress(a.address))) {
      const e = new Error('address refused') as NodeJS.ErrnoException;
      e.code = 'EADDRREFUSED_REMYRAL';
      callback(e, '', 0);
      return;
    }
    if (options.all === true) callback(null, list);
    else callback(null, list[0]?.address ?? '', list[0]?.family ?? 4);
  });
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'private-token']);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function bodyOf(init: RequestInit): Buffer | undefined {
  const b = init.body;
  if (b === undefined || b === null) return undefined;
  if (typeof b === 'string') return Buffer.from(b);
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  throw new TypeError('guarded fetch: unsupported request body');
}

/** The guarded client (see the module comment). */
export function createGuardedWebFetch(opts: GuardedWebFetchOptions): WebFetch {
  const internal = opts.internalOrigins ?? new Set<string>();
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;

  const once = (
    u: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    signal: AbortSignal | undefined,
  ) =>
    new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
      const isInternal = internal.has(u.origin);
      if (!isInternal && u.protocol !== 'https:') {
        reject(new EgressRefusedError('only https:// destinations are allowed'));
        return;
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        reject(new EgressRefusedError('unsupported protocol'));
        return;
      }
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) !== 0 && (isInternal ? isLinkLocalAddress(host) : isNonPublicAddress(host))) {
        reject(new EgressRefusedError('the destination address is not allowed'));
        return;
      }
      const mod = u.protocol === 'https:' ? https : http;
      const r = mod.request(
        u,
        {
          method,
          headers: { ...headers, ...(body === undefined ? {} : { 'content-length': String(body.length) }) },
          lookup: (isInternal ? internalLookup : guardedLookup) as unknown as typeof dnsLookup,
          ...(signal === undefined ? {} : { signal }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              reject(new EgressRefusedError('response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') h.set(k, v);
              else if (Array.isArray(v)) for (const x of v) h.append(k, x);
            }
            resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) });
          });
          res.on('error', reject);
        },
      );
      r.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRREFUSED_REMYRAL'
            ? new EgressRefusedError('the destination resolves to an address that is not allowed')
            : err,
        );
      });
      if (body !== undefined) r.write(body);
      r.end();
    });

  return async (input, init) => {
    let url = new URL(input);
    let method = (init.method ?? 'GET').toUpperCase();
    let headers = headersOf(init);
    let body = bodyOf(init);
    const signal = init.signal ?? undefined;
    for (let hop = 0; ; hop++) {
      const res = await once(url, method, headers, body, signal);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status > 399 || location === null || res.status === 304) {
        return new Response(NULL_BODY.has(res.status) || res.body.length === 0 ? null : res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      if (hop >= maxRedirects) throw new EgressRefusedError('too many redirects');
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        if (opts.redirects === 'same-origin') {
          throw new EgressRefusedError('redirect to another origin refused');
        }
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k)));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      url = next;
    }
  };
}
