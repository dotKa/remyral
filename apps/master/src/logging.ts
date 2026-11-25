import { Writable } from 'node:stream';
import { Redactor, redactDeep } from '@remyral/observability';
import type { FastifyServerOptions } from 'fastify';

/**
 * pino redaction paths. Fastify's default request serializer logs only method/url/host/remote address,
 * but anything that ends up in a log object under one of these keys is censored as a second line of
 * defence (threat model T-SEC-1). Keep in sync with {@link SENSITIVE_KEY} in audit/redact.ts.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["x-csrf-token"]',
  'password',
  'newPassword',
  'currentPassword',
  'code',
  'totp',
  'totpCode',
  'secret',
  'totpSecret',
  'recoveryCode',
  'recoveryCodes',
  'sessionId',
  'csrfToken',
  'otpauthUri',
  'token',
  // p5-github-connect: never expected in a log object; censored if one ever is.
  'pem',
  'clientSecret',
  'webhookSecret',
  'client_secret',
  'webhook_secret',
  // p8-preview-tunnels: the connector token of a preview tunnel (TUNNEL_START) — never logged.
  'connectorToken',
  // p15-services: the read-only git token of a service checkout (SERVICE_START) — never logged.
  'gitToken',
  // p15-github-create-repo: GitHub user access / refresh tokens (never expected in a log object).
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.code',
  '*.totp',
  '*.totpCode',
  '*.secret',
  '*.totpSecret',
  '*.recoveryCode',
  '*.recoveryCodes',
  '*.sessionId',
  '*.csrfToken',
  '*.otpauthUri',
  '*.token',
  '*.pem',
  '*.clientSecret',
  '*.webhookSecret',
  '*.client_secret',
  '*.webhook_secret',
  '*.connectorToken',
  '*.gitToken',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
];

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/**
 * Query parameters whose values are credentials (the IDE's one-time `t` ticket on `/_ide/enter`, the GitHub
 * manifest `state`, OAuth-style `code` / `token`, …): masked in the logged request URL. The value is a credential
 * even when the request is refused, so the mask applies on every route.
 */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  't',
  'ticket',
  'token',
  'access_token',
  'refresh_token',
  'code',
  'state',
  'secret',
  'sig',
  'signature',
]);

/** `url` with the values of {@link SENSITIVE_QUERY_PARAMS} replaced by `[REDACTED]` (order and other values kept). */
export function redactUrlQuery(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const query = url.slice(q + 1).replace(/(^|&)([^=&]*)=([^&]*)/g, (whole, sep: string, name: string) => {
    let key = name;
    try {
      key = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      // undecodable: compared as is
    }
    return SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ? `${sep}${name}=[REDACTED]` : whole;
  });
  return `${url.slice(0, q)}?${query}`;
}

interface LoggedRequest {
  readonly method: string;
  readonly url: string;
  readonly host?: string | undefined;
  readonly ip?: string | undefined;
  readonly socket?: { readonly remotePort?: number | undefined } | null;
  readonly raw?: { readonly httpVersion?: string } | undefined;
}

/** Fastify's default request serializer (method, url, version, host, remote address/port) with the URL's query masked. */
function serializeRequest(req: LoggedRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrlQuery(req.url),
    version: req.raw?.httpVersion,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

export function loggerOptions(
  level: LogLevel,
  stream?: NodeJS.WritableStream,
): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    serializers: { req: serializeRequest },
    ...(stream ? { stream } : {}),
  };
}

/**
 * p1-monitoring: last line of defence before log lines leave the process (stdout → Docker → CloudWatch
 * Logs). pino's path redaction above only knows key names; this stream re-parses every JSON line and runs
 * every string (keys included) through the shared pattern/exact-value redactor of `@remyral/observability`
 * (`redactDeep`), so a token that slipped into a message, an error text or an unexpected key is masked
 * before shipping. Output stays one valid JSON object per line. A line that is not JSON (should not
 * happen with pino) is redacted as text.
 */
export function redactingLogStream(
  out: NodeJS.WritableStream,
  redactor: Redactor = new Redactor(),
  /**
   * p16-observability: receives every redacted line object (the console's log search, system/logs.ts). Called
   * synchronously; must not throw or do I/O.
   */
  tap?: (line: Record<string, unknown>) => void,
): NodeJS.WritableStream {
  let pending = '';
  const emit = (line: string): void => {
    if (line.trim() === '') return;
    let text: string;
    let obj: unknown;
    try {
      obj = redactDeep(JSON.parse(line) as unknown, redactor, { maxEntries: 200 });
      text = JSON.stringify(obj);
    } catch {
      obj = { level: 40, time: Date.now(), msg: redactor.redact(line), unparsedLogLine: true };
      text = JSON.stringify(obj);
    }
    out.write(`${text}\n`);
    if (tap !== undefined && obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      try {
        tap(obj as Record<string, unknown>);
      } catch {
        // The log search never breaks logging.
      }
    }
  };
  return new Writable({
    decodeStrings: false,
    write(chunk: Buffer | string, _enc, cb) {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        emit(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
      cb();
    },
    final(cb) {
      emit(pending);
      pending = '';
      cb();
    },
  });
}
