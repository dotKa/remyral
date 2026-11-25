import { isIP } from 'node:net';
import { isForbiddenHost } from '@remyral/workflow-nodes';
import { isNonPublicAddress } from '../ops/http.js';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §4, ADR-0059): what a subscription may target, checked when it is
 * saved and again before every attempt (the sender re-checks every resolved address at connect time).
 *
 * - `https:` only, no credentials in the URL, no fragment, ports 443 / 8443;
 * - never a loopback, private (RFC 1918, CGNAT, ULA), link-local, cloud metadata or internal-suffix host — the same
 *   floor as the workflow egress rules (ADR-0055 K1) — unless the exact origin is on the owner's internal-target list
 *   (Ayarlar → Webhook'lar → İç hedefler; owner, a code by the security policy's `security.policy` event);
 * - an internal origin still has to be `https:`.
 */
export const DEFAULT_PORTS = [443, 8443] as const;
export const MAX_URL = 2000;

export type TargetProblem =
  | 'invalid_url'
  | 'not_https'
  | 'credentials_in_url'
  | 'fragment'
  | 'too_long'
  | 'forbidden_host'
  | 'address_refused'
  | 'port_refused';

export function targetProblem(raw: string, internalOrigins: ReadonlySet<string>): TargetProblem | null {
  if (raw.length > MAX_URL) return 'too_long';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  if (u.protocol !== 'https:') return 'not_https';
  if (u.username !== '' || u.password !== '') return 'credentials_in_url';
  if (u.hash !== '' || raw.includes('#')) return 'fragment';
  if (internalOrigins.has(u.origin)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isForbiddenHost(u.hostname)) return 'forbidden_host';
  if (isIP(host) !== 0 && isNonPublicAddress(host)) return 'address_refused';
  const port = u.port === '' ? 443 : Number(u.port);
  if (!(DEFAULT_PORTS as readonly number[]).includes(port)) return 'port_refused';
  return null;
}

/** An internal-target list entry: exactly `https://host[:port]` (normalised origin), nothing else. */
export function internalOriginProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  if (u.protocol !== 'https:') return 'not_https';
  if (u.origin !== raw) return 'not_an_origin';
  return null;
}

// ------------------------------------------------------------------------------------------------ custom headers

export const MAX_HEADERS = 10;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** Set by the master (or by HTTP itself): never overridable. */
const RESERVED = new Set([
  'host',
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'user-agent',
  'cookie',
]);
/** Names that carry credentials: their value must be saved as a secret (sealed, write-only). */
const CREDENTIAL = /(^authorization$|^proxy-|token|secret|api-?key|password|signature|auth)/i;

export interface HeaderInput {
  readonly name: string;
  /** Plain value (shown back), or for `secret: true` the value to seal (never shown back). */
  readonly value?: string | undefined;
  readonly secret?: boolean | undefined;
  /** Updating: keep the stored secret value of this header (send no value). */
  readonly keep?: boolean | undefined;
}

export type HeaderProblem =
  | 'too_many'
  | 'invalid_name'
  | 'reserved_name'
  | 'duplicate_name'
  | 'invalid_value'
  | 'credential_must_be_secret'
  | 'missing_value';

export function headerNameProblem(name: string): HeaderProblem | null {
  if (!HEADER_NAME.test(name)) return 'invalid_name';
  const lower = name.toLowerCase();
  if (RESERVED.has(lower) || lower.startsWith('x-remyral-') || lower.startsWith('sec-'))
    return 'reserved_name';
  return null;
}

export function headerValueProblem(value: string): HeaderProblem | null {
  // eslint-disable-next-line no-control-regex -- control characters (CR / LF header injection) are refused
  if (value.length === 0 || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value))
    return 'invalid_value';
  return null;
}

/** A credential-like name with a plain value is refused: such values are only stored sealed. */
export function mustBeSecret(name: string): boolean {
  return CREDENTIAL.test(name);
}
