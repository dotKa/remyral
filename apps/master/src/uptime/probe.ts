import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { isNonPublicAddress } from '../ops/http.js';
import { type CheckResult, type HttpConfig, LIMITS, type TcpConfig, urlProblem } from './model.js';

/**
 * p8-uptime (docs/design/p8-uptime.md §4, security review §9): the HTTP(S) and TCP checks the master runs.
 *
 * The master makes these requests from inside the control plane, so every one is an SSRF risk. The guard:
 *  - http/https only, to ports 80/443/8080/8443; no credentials in the URL; no custom headers (a fixed user agent,
 *    `accept: *\/*`, no cookies, no authorization) — a monitor can never carry a secret;
 *  - the host name is resolved inside the socket's `lookup` and EVERY address it resolves to must be public
 *    (loopback, private, link-local incl. 169.254.169.254, CGNAT/Tailscale, ULA, multicast, documentation ranges
 *    refused), so the address that was checked is the one connected to (no DNS-rebinding window); IP literals are
 *    checked directly;
 *  - redirects are followed by hand, at most `maxRedirects`, and every hop goes through the same checks again
 *    (scheme, port, credentials, DNS);
 *  - one deadline for the whole check (all hops); the body is read only for the keyword check and only its first
 *    64 KiB, then the socket is destroyed; nothing of the body is stored;
 *  - tcp: any port, but the same public-address rule, connect only (nothing is sent).
 * `allowOrigins` are exact `scheme://host:port` (http) or `tcp://host:port` exceptions — set by tests, never by the
 * panel or the environment.
 */

export interface ProbeOptions {
  readonly allowOrigins?: Iterable<string>;
  /** Clock for latency (monotonic in production). */
  readonly now?: () => number;
}

export interface Probe {
  http(cfg: HttpConfig, timeoutMs: number): Promise<CheckResult>;
  tcp(cfg: TcpConfig, timeoutMs: number): Promise<CheckResult>;
}

/**
 * p10-verify-health: one guarded page request for the post-deploy crawler and the docs link check — the same guard as
 * the monitors (scheme, port allowlist, no credentials, public addresses per hop, fixed headers), plus the final URL
 * after redirects, the content type and (GET, 2xx, `text/html` only) at most `maxBytes` of the body.
 */
export interface PageRequest {
  readonly method: 'GET' | 'HEAD';
  readonly timeoutMs: number;
  /** Body bytes read at most (GET + 2xx + text/html only); the socket is destroyed after that. */
  readonly maxBytes: number;
  readonly maxRedirects: number;
}

export interface PageResult {
  /** A final (non-redirect) response arrived; `status` says which. */
  readonly ok: boolean;
  readonly status: number | null;
  readonly finalUrl: string | null;
  readonly contentType: string | null;
  readonly body: Buffer | null;
  /** Fixed cause code when no final response arrived (timeout, dns, address_refused, url_refused, …). */
  readonly error: string | null;
  readonly latencyMs: number | null;
}

export interface PageFetcher {
  page(url: string, req: PageRequest): Promise<PageResult>;
}

const USER_AGENT = 'RemyralUptime/1.0 (+https://github.com/remyral; master region)';

class ProbeFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly statusCode: number | null = null,
  ) {
    super(detail);
  }
}

function guardedLookup(
  hostname: string,
  options: { all?: boolean } & Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isNonPublicAddress(a.address))) {
      const e = new Error('address refused') as NodeJS.ErrnoException;
      e.code = 'EADDRREFUSED_REMYRAL';
      callback(e, '', 0);
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, addresses[0]?.address ?? '', addresses[0]?.family ?? 4);
  });
}

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/;

/** A socket / request error as a fixed cause code (never the error message: it can echo the URL). */
export function causeOf(err: NodeJS.ErrnoException): ProbeFailure {
  const code = err.code ?? '';
  if (code === 'EADDRREFUSED_REMYRAL') {
    return new ProbeFailure('address_refused', 'the host resolves to a non-public address');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA' || code === 'EAI_NONAME') {
    return new ProbeFailure('dns', `the host name does not resolve (${code})`);
  }
  if (TLS_CODES.test(code)) return new ProbeFailure('tls', `TLS certificate refused (${code})`);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new ProbeFailure('connect', `connection failed (${code})`);
  }
  return new ProbeFailure('network', `connection failed (${code === '' ? 'error' : code})`);
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '');
}

export function createProbe(opts: ProbeOptions = {}): Probe & PageFetcher {
  const allow = new Set(opts.allowOrigins ?? []);
  const now = opts.now ?? (() => performance.now());

  /** Static checks of one hop; returns whether the hop is an operator/test exception. */
  const vet = (u: URL): boolean => {
    if (allow.has(u.origin)) return true;
    const p = urlProblem(u.href);
    if (p !== null) throw new ProbeFailure('url_refused', p);
    const host = hostOf(u);
    if (isIP(host) !== 0 && isNonPublicAddress(host)) {
      throw new ProbeFailure('address_refused', 'the address is not public');
    }
    return false;
  };

  interface Hop {
    readonly status: number;
    readonly location: string | null;
    readonly body: Buffer | null;
    readonly certValidTo: Date | null;
    readonly contentType: string | null;
  }

  const hop = (
    u: URL,
    method: 'GET' | 'HEAD',
    readBody: boolean | ((status: number, contentType: string | null) => boolean),
    deadline: number,
    limit: number = LIMITS.keywordBytes,
  ): Promise<Hop> =>
    new Promise<Hop>((resolve, reject) => {
      let exempt: boolean;
      try {
        exempt = vet(u);
      } catch (err) {
        reject(err instanceof Error ? err : new ProbeFailure('url_refused', 'invalid URL'));
        return;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        reject(new ProbeFailure('timeout', 'timed out'));
        return;
      }
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = mod.request(
        u,
        {
          method,
          agent: false,
          headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' },
          ...(exempt ? {} : { lookup: guardedLookup as unknown as typeof dnsLookup }),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let certValidTo: Date | null = null;
          const sock = res.socket as Socket | TLSSocket | null;
          if (sock !== null && 'getPeerCertificate' in sock) {
            const c = sock.getPeerCertificate();
            const t = typeof c.valid_to === 'string' ? Date.parse(c.valid_to) : NaN;
            if (Number.isFinite(t)) certValidTo = new Date(t);
          }
          const location = typeof res.headers.location === 'string' ? res.headers.location : null;
          const ctHeader = res.headers['content-type'];
          const contentType =
            typeof ctHeader === 'string'
              ? (ctHeader.split(';')[0]?.trim().toLowerCase().slice(0, 100) ?? null)
              : null;
          const wanted = typeof readBody === 'function' ? readBody(status, contentType) : readBody;
          if (!wanted || (status >= 300 && status < 400 && location !== null)) {
            res.destroy();
            done(() => {
              resolve({ status, location, body: null, certValidTo, contentType });
            });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = (): void => {
            done(() => {
              resolve({
                status,
                location,
                body: Buffer.concat(chunks).subarray(0, limit),
                certValidTo,
                contentType,
              });
            });
          };
          res.on('data', (c: Buffer) => {
            if (size >= limit) return;
            chunks.push(c);
            size += c.length;
            if (size >= limit) {
              finish();
              res.destroy();
            }
          });
          res.on('end', finish);
          res.on('error', () => {
            finish();
          });
        },
      );
      const timer = setTimeout(() => {
        done(() => {
          reject(new ProbeFailure('timeout', 'timed out'));
        });
        req.destroy();
      }, remaining);
      req.on('error', (err: NodeJS.ErrnoException) => {
        done(() => {
          reject(causeOf(err));
        });
      });
      req.end();
    });

  return {
    async page(raw, req) {
      const start = now();
      const deadline = start + Math.max(1, req.timeoutMs);
      try {
        let url = new URL(raw);
        let redirects = 0;
        for (;;) {
          const r = await hop(
            url,
            req.method,
            req.method === 'GET'
              ? (status, ct) => status >= 200 && status < 300 && ct === 'text/html'
              : false,
            deadline,
            Math.max(0, req.maxBytes),
          );
          if (r.status >= 300 && r.status < 400 && r.location !== null && req.maxRedirects > 0) {
            if (redirects >= req.maxRedirects) {
              throw new ProbeFailure('redirect', 'too many redirects', r.status);
            }
            let next: URL;
            try {
              next = new URL(r.location, url);
            } catch {
              throw new ProbeFailure('redirect', 'invalid redirect location', r.status);
            }
            redirects++;
            url = next;
            continue;
          }
          return {
            ok: true,
            status: r.status,
            finalUrl: url.href,
            contentType: r.contentType,
            body: r.body,
            error: null,
            latencyMs: Math.max(0, Math.round(now() - start)),
          };
        }
      } catch (err) {
        const f = err instanceof ProbeFailure ? err : new ProbeFailure('network', 'request failed');
        return {
          ok: false,
          status: f.statusCode,
          finalUrl: null,
          contentType: null,
          body: null,
          error: f.code,
          latencyMs: null,
        };
      }
    },

    async http(cfg, timeoutMs) {
      const start = now();
      const deadline = start + timeoutMs;
      let tlsExpiresAt: Date | null = null;
      try {
        let url = new URL(cfg.url);
        let redirects = 0;
        for (;;) {
          const wantBody = cfg.method === 'GET' && cfg.keyword !== null;
          const r = await hop(url, cfg.method, wantBody, deadline);
          // The certificate of the first https hop (the monitored host itself).
          if (tlsExpiresAt === null && r.certValidTo !== null) tlsExpiresAt = r.certValidTo;
          if (r.status >= 300 && r.status < 400 && r.location !== null && cfg.maxRedirects > 0) {
            if (redirects >= cfg.maxRedirects) {
              throw new ProbeFailure('redirect', `more than ${String(cfg.maxRedirects)} redirects`, r.status);
            }
            let next: URL;
            try {
              next = new URL(r.location, url);
            } catch {
              throw new ProbeFailure('redirect', 'invalid redirect location', r.status);
            }
            redirects++;
            url = next;
            continue;
          }
          const latencyMs = Math.max(0, Math.round(now() - start));
          if (r.status < cfg.expectStatus.min || r.status > cfg.expectStatus.max) {
            throw new ProbeFailure(
              'status',
              `HTTP ${String(r.status)} (expected ${String(cfg.expectStatus.min)}–${String(cfg.expectStatus.max)})`,
              r.status,
            );
          }
          if (cfg.keyword !== null && r.body !== null) {
            const found = r.body.toString('utf8').includes(cfg.keyword.text);
            if (found !== (cfg.keyword.mode === 'present')) {
              throw new ProbeFailure(
                'keyword',
                cfg.keyword.mode === 'present' ? 'keyword not found' : 'unwanted keyword found',
                r.status,
              );
            }
          }
          if (cfg.maxLatencyMs !== null && latencyMs > cfg.maxLatencyMs) {
            return {
              ok: false,
              latencyMs,
              statusCode: r.status,
              error: 'slow',
              detail: `${String(latencyMs)} ms (max ${String(cfg.maxLatencyMs)} ms)`,
              tlsExpiresAt,
            };
          }
          return { ok: true, latencyMs, statusCode: r.status, error: null, detail: null, tlsExpiresAt };
        }
      } catch (err) {
        const f = err instanceof ProbeFailure ? err : new ProbeFailure('network', 'check failed');
        const latencyMs = f.statusCode === null ? null : Math.max(0, Math.round(now() - start));
        return {
          ok: false,
          latencyMs,
          statusCode: f.statusCode,
          error: f.code,
          detail: f.detail,
          tlsExpiresAt,
        };
      }
    },

    async tcp(cfg, timeoutMs) {
      const start = now();
      const exempt = allow.has(`tcp://${cfg.host}:${String(cfg.port)}`);
      const host = cfg.host.replace(/^\[|\]$/g, '');
      if (!exempt && isIP(host) !== 0 && isNonPublicAddress(host)) {
        return fail('address_refused', 'the address is not public');
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const sock = netConnect({
            host,
            port: cfg.port,
            ...(exempt ? {} : { lookup: guardedLookup as unknown as typeof dnsLookup }),
          });
          const timer = setTimeout(() => {
            sock.destroy();
            reject(new ProbeFailure('timeout', 'timed out'));
          }, timeoutMs);
          sock.once('connect', () => {
            clearTimeout(timer);
            sock.destroy();
            resolve();
          });
          sock.once('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            sock.destroy();
            reject(causeOf(err));
          });
        });
        return {
          ok: true,
          latencyMs: Math.max(0, Math.round(now() - start)),
          statusCode: null,
          error: null,
          detail: null,
          tlsExpiresAt: null,
        };
      } catch (err) {
        const f = err instanceof ProbeFailure ? err : new ProbeFailure('network', 'check failed');
        return fail(f.code, f.detail);
      }
    },
  };
}

function fail(code: string, detail: string): CheckResult {
  return { ok: false, latencyMs: null, statusCode: null, error: code, detail, tlsExpiresAt: null };
}
