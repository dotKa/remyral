import type { lookup as dnsLookup } from 'node:dns';
import https from 'node:https';
import { guardedLookup } from '../ops/http.js';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §6): the one HTTP client that posts webhook deliveries.
 *
 * - `https:` only; the host name is resolved inside the socket's `lookup` and every address must be public (the
 *   address checked is the address connected to — no DNS-rebinding window). An origin on the owner's internal-target
 *   list skips only the address check.
 * - No redirects are followed (a 3xx is a failed attempt), no cookies, no proxy, no keep-alive (`agent: false`).
 * - One deadline for the whole attempt (default 10 s: connect + TLS + response), the response body is read up to
 *   `maxResponseBytes` (default 4 KiB) and then the socket is destroyed; the caller keeps at most 1 KiB, redacted.
 * - Errors are fixed codes (`timeout`, `dns`, `address_refused`, `tls`, `connect`, `network`), never messages (a
 *   message can echo the URL).
 */
export interface SendRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly internal: boolean;
}

export interface SendResult {
  /** A response arrived (any status). */
  readonly status: number | null;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly body: Buffer | null;
}

export type WebhookSender = (req: SendRequest) => Promise<SendResult>;

export interface SenderOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Test seam: extra trusted CA certificates (a local TLS receiver). Never set by main.ts. */
  readonly ca?: string | Buffer;
  readonly now?: () => number;
}

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/;

export function errorCodeOf(err: NodeJS.ErrnoException): string {
  const code = err.code ?? '';
  if (code === 'EADDRREFUSED_REMYRAL') return 'address_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA' || code === 'EAI_NONAME')
    return 'dns';
  if (TLS_CODES.test(code)) return 'tls';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
    return 'connect';
  return 'network';
}

export function createWebhookSender(opts: SenderOptions = {}): WebhookSender {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxResponseBytes ?? 4096;
  const now = opts.now ?? (() => performance.now());
  return (req) =>
    new Promise<SendResult>((resolve) => {
      const start = now();
      let settled = false;
      const finish = (r: Omit<SendResult, 'latencyMs'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...r, latencyMs: Math.max(0, Math.round(now() - start)) });
      };
      let u: URL;
      try {
        u = new URL(req.url);
      } catch {
        resolve({ status: null, error: 'url_refused', latencyMs: 0, body: null });
        return;
      }
      if (u.protocol !== 'https:') {
        resolve({ status: null, error: 'url_refused', latencyMs: 0, body: null });
        return;
      }
      const payload = Buffer.from(req.body, 'utf8');
      const r = https.request(
        u,
        {
          method: 'POST',
          agent: false,
          headers: { ...req.headers, 'content-length': String(payload.length) },
          ...(req.internal ? {} : { lookup: guardedLookup as unknown as typeof dnsLookup }),
          ...(opts.ca === undefined ? {} : { ca: opts.ca }),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          const done = (): void => {
            finish({ status, error: null, body: Buffer.concat(chunks).subarray(0, maxBytes) });
          };
          res.on('data', (c: Buffer) => {
            if (size >= maxBytes) return;
            chunks.push(c);
            size += c.length;
            if (size >= maxBytes) {
              done();
              res.destroy();
            }
          });
          res.on('end', done);
          res.on('error', done);
          res.on('close', done);
        },
      );
      const timer = setTimeout(() => {
        finish({ status: null, error: 'timeout', body: null });
        r.destroy();
      }, timeoutMs);
      r.on('error', (err: NodeJS.ErrnoException) => {
        finish({ status: null, error: errorCodeOf(err), body: null });
      });
      r.end(payload);
    });
}
