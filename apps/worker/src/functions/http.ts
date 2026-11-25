import { Agent as HttpAgent, type IncomingMessage, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import {
  FUNCTION_LIMITS,
  FUNCTION_RESPONSE_HEADERS,
  type FunctionHttpResult,
  type FunctionHttpSpec,
} from '@remyral/protocol';
import {
  credentialHostAllowed,
  type EgressDeps,
  normalizeHost,
  pinnedLookup,
  type PinnedTarget,
  resolveTarget,
} from './egress.js';
import {
  pinsFor,
  presentedCertificate,
  type PresentedCertificate,
  TLS_CERT_CODES,
  trustOptions,
} from './tls-pin.js';
import { type FunctionContext, FunctionError, type HttpExecutor } from './types.js';

/**
 * p14-workflow-engine 14.3: the HTTP request node on a worker (ADR-0055 K1, §5.2). node:http / node:https directly —
 * no proxy (a fresh agent per hop, never the environment's proxy settings), no cookies, no connection reuse across
 * hops, no decompression (`accept-encoding: identity`). Every hop goes through the egress guard and connects to the
 * checked address only. The vault credential is attached only while the hop's host is one of its `allowedHosts`.
 */

/** Header names a function job never sends from the spec (credentials only via the vault; hop-by-hop headers). */
const DENIED = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-connection',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'idempotency-key',
  'accept-encoding',
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const REDACTED = '[REDACTED]';

export interface HttpExecutorOptions extends EgressDeps {
  /** Test-only CA for https test servers (production: the system trust store). */
  readonly ca?: string | Buffer;
  readonly userAgent?: string;
}

interface Hop {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly sizeBytes: number;
}

/**
 * p22-runtime-diagnostics: the handshake refused the server's certificate (no request byte was sent). Raised inside
 * `#hop` only for HTTPS hops without a trusted pin; the caller decides (pin match → retry, else `tls_untrusted`).
 */
class CertificateRefused extends Error {
  constructor(
    readonly tlsCode: string,
    message: string,
  ) {
    super(message);
  }
}

/** How long reading the presented certificate after a refused handshake may take. */
const CERT_READ_MS = 5_000;

function portOf(u: URL): number {
  if (u.port !== '') return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

export class NodeHttpExecutor implements HttpExecutor {
  constructor(private readonly opts: HttpExecutorOptions = {}) {}

  async run(spec: FunctionHttpSpec, ctx: FunctionContext): Promise<FunctionHttpResult> {
    const started = Date.now();
    const r = spec.request;
    let url = new URL(r.url);
    if (url.username !== '' || url.password !== '')
      throw new FunctionError('function_refused', 'credentials in the URL are not allowed');
    // Credential: bound to its hosts — the first hop must be one of them, later hops only carry it when they are.
    let secret: string | null = null;
    let secretForms: string[] = [];
    const cred = spec.credential;
    if (cred !== undefined) {
      const host = normalizeHost(url.hostname);
      if (!credentialHostAllowed(cred.allowedHosts, host, portOf(url))) {
        throw new FunctionError(
          'credential_host_refused',
          `the credential ${cred.id} is not bound to ${host}:${String(portOf(url))}`,
        );
      }
      const value = await ctx.credential(cred.id);
      if (value === null)
        throw new FunctionError('credential_missing', `the credential ${cred.id} is not on this worker`);
      secret = value.reveal();
      if (secret === '' || !SAFE_HEADER_VALUE.test(secret) || /[\r\n]/.test(secret))
        throw new FunctionError(
          'credential_missing',
          `the credential ${cred.id} is not usable as a header value`,
        );
      secretForms = [secret, Buffer.from(secret, 'utf8').toString('base64'), encodeURIComponent(secret)];
      for (const f of secretForms) ctx.addSecret(f);
    }
    const userHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (DENIED.has(k.toLowerCase())) continue;
      if (!SAFE_HEADER_VALUE.test(v))
        throw new FunctionError('function_refused', `header ${k} has control characters`);
      userHeaders[k] = v;
    }
    const deadline = started + r.timeoutSec * 1000;
    let method: string = r.method;
    let body = r.body;
    let redirects = 0;
    for (;;) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new FunctionError('redirect_refused', `scheme ${url.protocol} is not allowed`);
      const target = await resolveTarget(url.hostname, portOf(url), spec.egress, 'http', this.opts);
      const attach =
        cred !== undefined &&
        secret !== null &&
        credentialHostAllowed(cred.allowedHosts, target.host, target.port);
      const hopUrl = new URL(url.href);
      const headers: Record<string, string> = {
        ...userHeaders,
        'user-agent': this.opts.userAgent ?? 'remyral-workflow/1',
        'accept-encoding': 'identity',
        'idempotency-key': spec.idempotencyKey,
      };
      if (attach && secret !== null) {
        const value = secret;
        switch (cred.placement) {
          case 'bearer':
            headers.authorization = `Bearer ${value}`;
            break;
          case 'basic':
            headers.authorization = `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
            break;
          case 'header':
            headers[(cred.name ?? 'x-api-key').toLowerCase()] = value;
            break;
          case 'query':
            hopUrl.searchParams.set(cred.name ?? 'api_key', value);
            break;
        }
      }
      if (body !== undefined) headers['content-type'] = body.contentType;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new FunctionError('http_timeout', `no answer within ${String(r.timeoutSec)} s`);
      const hop = await this.#pinnedHop(
        hopUrl,
        target,
        method,
        headers,
        body?.text,
        r.maxResponseBytes,
        deadline,
        ctx,
      );
      const location = hop.headers.location;
      if (REDIRECTS.has(hop.status) && typeof location === 'string' && r.followRedirects > 0) {
        if (redirects >= r.followRedirects)
          throw new FunctionError('redirect_refused', `more than ${String(r.followRedirects)} redirects`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new FunctionError('redirect_refused', 'the redirect location is not a URL');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:')
          throw new FunctionError('redirect_refused', `redirect to scheme ${next.protocol} is not allowed`);
        if (next.username !== '' || next.password !== '')
          throw new FunctionError('redirect_refused', 'redirect with credentials in the URL');
        redirects++;
        if (
          hop.status === 303
            ? method !== 'HEAD'
            : (hop.status === 301 || hop.status === 302) && method === 'POST'
        ) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
      return this.#result(spec, hop, url, redirects, attach, secretForms, started);
    }
  }

  /**
   * p22-runtime-diagnostics: one hop; when the certificate is refused, the presented certificate is read (nothing sent)
   * and the hop is made again trusting it only when the project pinned it for this `host:port` — else the failure says
   * `tls_untrusted` with the fingerprint the console offers to trust.
   */
  async #pinnedHop(
    url: URL,
    target: PinnedTarget,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    maxBytes: number,
    deadline: number,
    ctx: FunctionContext,
  ): Promise<Hop> {
    try {
      return await this.#hop(url, target, method, headers, body, maxBytes, deadline - Date.now(), ctx.signal);
    } catch (err) {
      if (!(err instanceof CertificateRefused)) throw err;
      const left = deadline - Date.now();
      if (left <= 0) throw new FunctionError('http_timeout', 'no answer before the time limit');
      const seen = await presentedCertificate(target, Math.min(CERT_READ_MS, left), ctx.signal);
      const pins = pinsFor(ctx.tlsPins ?? [], target);
      const where = `${target.host}:${String(target.port)}`;
      if (seen !== null && pins.some((p) => p.sha256 === seen.sha256)) {
        ctx.log.info('certificate pinned by the project; request made again trusting it', {
          host: target.host,
          port: target.port,
          tlsCode: err.tlsCode,
        });
        return this.#hop(
          url,
          target,
          method,
          headers,
          body,
          maxBytes,
          deadline - Date.now(),
          ctx.signal,
          seen,
        );
      }
      const params: Record<string, string | number> = {
        cause: 'tls_untrusted',
        tlsCode: err.tlsCode.slice(0, 64),
        host: target.host.slice(0, 200),
        port: target.port,
        ...(seen === null ? {} : { certSha256: seen.sha256 }),
        ...(pins.length > 0 ? { pinMismatch: 1 } : {}),
      };
      const note =
        seen === null
          ? `the certificate of ${where} could not be read`
          : pins.length > 0
            ? `the certificate ${where} presented (SHA-256 ${seen.sha256}) is not the one the project trusts for it`
            : `the certificate ${where} presented is not trusted (SHA-256 ${seen.sha256}); a project admin can trust it for this project`;
      throw new FunctionError(
        'http_error',
        `request failed (${err.tlsCode}): ${err.message}; ${note}`,
        params,
      );
    }
  }

  #hop(
    url: URL,
    target: PinnedTarget,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    maxBytes: number,
    timeoutMs: number,
    outer: AbortSignal,
    trusted: PresentedCertificate | null = null,
  ): Promise<Hop> {
    const https = url.protocol === 'https:';
    const signal = AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    if (payload !== undefined) headers['content-length'] = String(payload.length);
    return new Promise<Hop>((resolve, reject) => {
      const lookup = pinnedLookup(target);
      const common = {
        // The hostname is used for the Host header and TLS (SNI + certificate); the address comes from `lookup`.
        hostname: target.literal ? target.address : target.host,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        lookup,
        signal,
        setHost: true,
      };
      const onRes = (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          if (size + c.length > maxBytes) {
            chunks.push(c.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            res.destroy();
            done();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated,
            sizeBytes: size,
          });
        };
        res.on('end', done);
        res.on('error', (err) => {
          if (truncated) return;
          settled = true;
          reject(mapError(err, signal, outer));
        });
        res.on('close', () => {
          if (!settled && !res.complete && !truncated) {
            settled = true;
            reject(mapError(new Error('connection closed'), signal, outer));
          }
        });
      };
      const req = https
        ? httpsRequest(
            {
              ...common,
              agent: new HttpsAgent({ keepAlive: false, maxCachedSessions: 0 }),
              ...(target.literal ? {} : { servername: target.host }),
              ...(trusted !== null
                ? trustOptions(trusted, this.opts.ca)
                : this.opts.ca === undefined
                  ? {}
                  : { ca: this.opts.ca }),
            },
            onRes,
          )
        : httpRequest({ ...common, agent: new HttpAgent({ keepAlive: false }) }, onRes);
      req.on('error', (err) => {
        const code = (err as { code?: unknown }).code;
        if (
          https &&
          trusted === null &&
          !signal.aborted &&
          typeof code === 'string' &&
          TLS_CERT_CODES.test(code)
        ) {
          reject(new CertificateRefused(code, err.message.slice(0, 300)));
          return;
        }
        reject(mapError(err, signal, outer));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  #result(
    spec: FunctionHttpSpec,
    hop: Hop,
    url: URL,
    redirects: number,
    attached: boolean,
    secrets: readonly string[],
    started: number,
  ): FunctionHttpResult {
    const red = (s: string): string => {
      let out = s;
      for (const f of secrets) if (f.length >= 4) out = out.split(f).join(REDACTED);
      return out;
    };
    const headers: Record<string, string> = {};
    for (const name of FUNCTION_RESPONSE_HEADERS) {
      if (Object.keys(headers).length >= FUNCTION_LIMITS.maxResponseHeaders) break;
      const v = hop.headers[name];
      if (v === undefined) continue;
      headers[name] = red((Array.isArray(v) ? v.join(', ') : v).slice(0, 4096));
    }
    const final = new URL(url.href);
    if (spec.credential?.placement === 'query') final.searchParams.delete(spec.credential.name ?? 'api_key');
    let truncated = hop.truncated;
    let encoding: FunctionHttpResult['bodyEncoding'] = 'none';
    let body: unknown;
    const cap = FUNCTION_LIMITS.maxReturnedBodyBytes;
    if (hop.body.length > 0 && spec.request.method !== 'HEAD') {
      if (spec.request.responseType === 'binary') {
        const bytes = hop.body.subarray(0, cap);
        if (bytes.length < hop.body.length) truncated = true;
        // Binary bytes cannot be redacted reliably by value; the text form is checked as well.
        encoding = 'base64';
        body = red(bytes.toString('latin1')) === bytes.toString('latin1') ? bytes.toString('base64') : '';
        if (body === '') {
          encoding = 'text';
          body = REDACTED;
        }
      } else {
        let text = red(hop.body.toString('utf8'));
        let parsed = false;
        if (spec.request.responseType === 'json' && !truncated) {
          try {
            body = JSON.parse(text) as unknown;
            parsed = true;
            encoding = 'json';
            if (Buffer.byteLength(JSON.stringify(body), 'utf8') > cap) parsed = false;
          } catch {
            parsed = false;
          }
        }
        if (!parsed) {
          if (spec.request.responseType === 'json') truncated = true;
          if (Buffer.byteLength(text, 'utf8') > cap) {
            text = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
            truncated = true;
          }
          encoding = 'text';
          body = text;
        }
      }
    }
    return {
      type: 'http',
      status: hop.status,
      headers,
      ...(encoding === 'none' ? {} : { body }),
      bodyEncoding: encoding,
      truncated,
      sizeBytes: hop.sizeBytes,
      finalUrl: red(final.href).slice(0, 8192),
      redirects,
      credentialAttached: attached,
      durationMs: Math.max(0, Date.now() - started),
    };
  }
}

function mapError(err: unknown, signal: AbortSignal, outer: AbortSignal): Error {
  if (outer.aborted) return err instanceof Error ? err : new Error('aborted');
  if (signal.aborted) return new FunctionError('http_timeout', 'the request timed out');
  if (err instanceof FunctionError) return err;
  const code = (err as { code?: unknown }).code;
  return new FunctionError(
    'http_error',
    `request failed${typeof code === 'string' ? ` (${code})` : ''}: ${err instanceof Error ? err.message.slice(0, 300) : 'error'}`,
  );
}
