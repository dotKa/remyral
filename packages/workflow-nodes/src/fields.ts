import { z } from 'zod';

/**
 * Config field kinds (p14-workflow-engine §2.1, §8.3). A **static** field takes a literal only — anything that grants
 * capability (hosts, credentials, recipients sets, deploy targets, repositories, runtimes, roles, code, limits) is
 * static. An **expression-capable** field also takes `{{ … }}` templates inside strings or a whole-value expression
 * `{ "$expr": "…" }` (JSONata, evaluated by the master sandbox from 14.1).
 */
export type FieldMode = 'static' | 'expr';

export const MAX_EXPRESSION_CHARS = 4096;

/** A whole-value expression. */
export const ExprValue = z.strictObject({ $expr: z.string().min(1).max(MAX_EXPRESSION_CHARS) });
export type ExprValue = z.infer<typeof ExprValue>;

/** Whether `s` holds a `{{ … }}` template (a `{{` with a `}}` after it; an index search, linear on any input). */
export function hasTemplate(s: string): boolean {
  const at = s.indexOf('{{');
  return at >= 0 && s.indexOf('}}', at + 2) >= 0;
}

/**
 * A template string (`… {{ expr }} …`): its value is only known at run time, so the literal's own constraints (an
 * address format, a number) are checked on the evaluated value then, not here.
 */
export const TemplateString = z
  .string()
  .max(MAX_EXPRESSION_CHARS * 4)
  // "A `{{` with a `}}` after it", anchored so it runs once in linear time: the prefix stops at the first `{{`.
  // (zod runs the pattern even on a value over the length limit, so `/\{\{[\s\S]*?\}\}/` was quadratic there.)
  .regex(/^(?:[^{]|\{(?!\{))*\{\{[\s\S]*\}\}/);

/** An expression-capable field: the literal schema, a `{{ }}` template string or `{ $expr }`. */
export function expr<T extends z.ZodType>(
  literal: T,
): z.ZodUnion<[T, typeof TemplateString, typeof ExprValue]> {
  return z.union([literal, TemplateString, ExprValue]);
}

/** An expression-capable text (templates allowed). */
export const ExprText = (max: number) => expr(z.string().max(max));

/** Does a (static) value carry an expression anywhere (a `{{ }}` template or a `$expr` object)? */
export function containsExpression(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') return hasTemplate(value);
  if (Array.isArray(value)) return value.some((v) => containsExpression(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    if ('$expr' in value) return true;
    return Object.values(value).some((v) => containsExpression(v, depth + 1));
  }
  return false;
}

/** Every string inside a value (secret scanning of configs), bounded. */
export function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 2000) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out, depth + 1);
  else if (value !== null && typeof value === 'object')
    for (const v of Object.values(value)) stringsOf(v, out, depth + 1);
  return out;
}

/** `$node.<id>` references inside expression text (static ancestor check; the JSONata AST check comes in 14.1). */
export function nodeReferences(value: unknown): string[] {
  const refs = new Set<string>();
  for (const s of stringsOf(value)) {
    for (const m of s.matchAll(/\$node\.([a-z][a-z0-9_-]{0,47})/g)) if (m[1] !== undefined) refs.add(m[1]);
  }
  return [...refs].sort();
}

// ------------------------------------------------------------------------------------- the security floor (K1)

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * ADR-0055 K1 security floor, static part: host names and IP literals that can never be a target of a workflow request
 * or mail server — loopback, private (RFC 1918, CGNAT, ULA), link-local, cloud metadata, multicast / reserved,
 * `localhost` and internal suffixes. The worker re-checks every resolved address at connect time (DNS rebinding);
 * this check only refuses what is visibly internal when the definition is saved.
 */
export function isForbiddenHost(hostRaw: string): boolean {
  const host = hostRaw
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan|home|intranet|corp|localdomain|home\.arpa)$/.test(host)) return true;
  if (host === 'metadata.google.internal' || host === 'metadata' || host === 'instance-data') return true;
  // p14-workflow-engine 14.3: other spellings of IPv4 that resolvers accept (inet_aton): a single decimal number
  // (2130706433), hex (0x7f000001, 0x7f.0.0.1), octal with leading zeros (0177.0.0.1) and shortened forms (127.1).
  // A host name is never all numeric, so every such literal is refused (the worker checks the resolved address too).
  if (/^[0-9.]+$/.test(host) && !IPV4.test(host)) return true;
  if (/(^|\.)0x[0-9a-f]*($|\.)/.test(host)) return true;
  if (IPV4.test(host) && host.split('.').some((o) => o.length > 1 && o.startsWith('0'))) return true;
  const m = IPV4.exec(host);
  if (m !== null) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return true;
    const [a = 0, b = 0] = o;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  if (hostRaw.includes(':')) {
    // IPv6 literal: refuse loopback, unspecified, ULA, link-local, multicast, IPv4-mapped / NAT64 forms, docs. The
    // literal is normalised first (`0:0:0:0:0:ffff:7f00:1` → `::ffff:7f00:1`); one that does not parse is refused.
    let canonical: string;
    try {
      canonical = new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return true;
    }
    return isForbiddenV6(canonical);
  }
  return false;
}

function isForbiddenV6(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host)) return true;
  // IPv4-mapped / -compatible / NAT64 / 6to4 / Teredo forms and the documentation prefix.
  if (/^::(ffff:)?[0-9a-f]{0,4}[:.]/.test(host)) return true;
  if (host.startsWith('64:ff9b:') || host.startsWith('2001:db8') || host.startsWith('2002:')) return true;
  if (/^2001:0?:/.test(host)) return true;
  return false;
}

/** A public host name (RFC 1123 labels) or a public IP literal. */
export const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const PublicHost = z
  .string()
  .min(1)
  .max(253)
  .refine((h) => HOST_NAME.test(h) || IPV4.test(h) || /^\[?[0-9a-f:]+\]?$/i.test(h), {
    message: 'invalid_host',
  })
  .refine((h) => !isForbiddenHost(h), { message: 'forbidden_host' });

/**
 * The origin of an HTTP request node (static, §8.3): `http(s)://host[:port]`, no path, no credentials. Ports: 80, 443,
 * 8080, 8443 by default; any other port only when the project's egress allowlist lists `host:port` (checked by the
 * master at save and run, and by the worker).
 */
export const HttpOrigin = z
  .string()
  .max(300)
  .superRefine((v, ctx) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid_url' });
      return;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      ctx.addIssue({ code: 'custom', message: 'scheme_not_allowed' });
    if (u.username !== '' || u.password !== '')
      ctx.addIssue({ code: 'custom', message: 'credentials_in_url' });
    if ((u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '')
      ctx.addIssue({ code: 'custom', message: 'origin_only' });
    if (isForbiddenHost(u.hostname)) ctx.addIssue({ code: 'custom', message: 'forbidden_host' });
  });

export const DEFAULT_HTTP_PORTS: readonly number[] = [80, 443, 8080, 8443];

/** The port of an origin (default by scheme). */
export function originPort(origin: string): number {
  const u = new URL(origin);
  if (u.port !== '') return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/** Header names a workflow may never set (credentials travel only as vault references; hop-by-hop headers). */
export const DENIED_HEADERS: ReadonlySet<string> = new Set([
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
]);

export const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** A vault credential id (static reference; the value is never in a definition). */
export const CredentialRef = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);

/** A mail address (bounded, no display-name tricks). */
export const MAIL_ADDRESS = /^[^@\s<>",;()\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
