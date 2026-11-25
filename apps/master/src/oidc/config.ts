import type { SigningKey } from './keys.js';

/**
 * p5-coolify-sso configuration (docs/design/p5-coolify-sso.md §6). Both halves are optional: without them
 * the routes exist (route coverage) but answer 404 and the console hides the button.
 */
export interface OidcClientConfig {
  readonly id: string;
  /** The client secret itself (read from OIDC_COOLIFY_CLIENT_SECRET_FILE). Never logged. */
  readonly secret: string;
  /** Exact-match allowlist of redirect URIs. */
  readonly redirectUris: readonly string[];
}

export interface OidcProviderConfig {
  /** `https://console.example.com` — the console origin; the issuer is this + {@link ISSUER_PATH}. */
  readonly consoleOrigin: string;
  readonly signingKey: SigningKey;
  readonly client: OidcClientConfig;
  /** username → e-mail (lower case); Coolify matches accounts by e-mail. */
  readonly emails: ReadonlyMap<string, string>;
}

export interface CoolifyGateConfig {
  /** The gate host (`coolify.example.org`), lower case, no port. */
  readonly host: string;
  readonly consoleOrigin: string;
}

export interface SsoConfig {
  readonly oidc?: OidcProviderConfig;
  readonly gate?: CoolifyGateConfig;
  /** Test seam: in-process cache period of positive forward-auth decisions (default 5 s; 0 = off). */
  readonly gateCacheMs?: number;
}

/** The public path prefix under which the console's proxy routes to the master (prefix stripped). */
export const API_PREFIX = '/api';
/** The issuer path on the console origin; the master serves it as `/oidc`. */
export const ISSUER_PATH = `${API_PREFIX}/oidc`;
export const COOLIFY_CLIENT_ID = 'coolify';

export function issuerOf(consoleOrigin: string): string {
  return `${consoleOrigin}${ISSUER_PATH}`;
}

export const EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;
const USERNAME_PATTERN = /^[a-z][a-z0-9_.-]{2,31}$/;

/** Parses `user=email,user2=email2`. Throws a message naming the problem (never the value). */
export function parseEmailMap(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) throw new Error('every entry must be username=email');
    const user = trimmed.slice(0, eq).trim();
    const email = trimmed
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (!USERNAME_PATTERN.test(user)) throw new Error('invalid username in entry');
    if (!EMAIL_PATTERN.test(email)) throw new Error('invalid e-mail address in entry');
    if (map.has(user)) throw new Error('username listed twice');
    map.set(user, email);
  }
  return map;
}

/** An `https://host[:port]` origin (http only for loopback, development). */
export function isOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
  return url.origin === value && url.username === '' && url.password === '';
}

/** An exact redirect URI: https, no fragment, no credentials. */
export function isRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    url.href === value
  );
}

export const HOST_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
