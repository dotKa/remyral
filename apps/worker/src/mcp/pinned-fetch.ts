import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * The MCP probe's HTTP client: every request of one probe goes to the address the SSRF check approved — node:https
 * with a `lookup` that answers only that address, so a second DNS answer (rebinding to a private / metadata address
 * between the check and the connect, or between two requests of the probe) is never used. The hostname still names
 * the server for the Host header and TLS (SNI and certificate verification). Only `https:` URLs of that one host are
 * accepted; a redirect is an error (as `fetch(…, { redirect: 'error' })`).
 */

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Status codes whose Response may not carry a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export interface PinnedFetchOptions {
  /** Tests: extra trusted CA (PEM) for a local server. */
  readonly ca?: string;
}

export function pinnedFetch(host: string, address: string, options: PinnedFetchOptions = {}): Fetch {
  const family = isIP(address);
  if (family === 0) throw new TypeError(`not an IP address: ${address}`);
  const lookup = (
    _hostname: string,
    opts: unknown,
    callback: (
      err: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all === true;
    if (all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return (raw, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.hostname !== host) {
        reject(new TypeError(`fetch refused: ${url.protocol}//${url.hostname} is not the checked host`));
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : undefined;
      if (init.body !== undefined && init.body !== null && body === undefined) {
        reject(new TypeError('fetch: only string bodies are supported'));
        return;
      }
      if (body !== undefined) headers['content-length'] = String(body.length);
      const req = httpsRequest(
        {
          hostname: host,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          lookup,
          servername: isIP(host) === 0 ? host : undefined,
          ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));
            return;
          }
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
          }
          if (NULL_BODY.has(status) || status < 200 || status > 599) {
            res.resume();
            resolve(new Response(null, { status: status < 200 || status > 599 ? 502 : status, headers: h }));
            return;
          }
          resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: h }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
}
