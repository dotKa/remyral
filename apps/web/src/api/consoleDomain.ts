import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p17-domain-wizard (docs/design/p17-domain-wizard.md): the console's public address — `GET /console-domain`,
 * `POST /console-domain/dns-check`, `PUT /console-domain` (step-up by policy), `DELETE /console-domain`,
 * `POST /console-domain/request/cancel` (apps/master/src/console-domain/routes.ts).
 */

type Opts = Omit<RequestOptions, 'body'>;

export const TLS_MODES = ['letsencrypt', 'cloudflare', 'proxy'] as const;
export type TlsMode = (typeof TLS_MODES)[number];
export type RequestState =
  'pending' | 'applying' | 'applied' | 'rolled_back' | 'failed' | 'refused' | 'expired' | 'cancelled';
const REQUEST_STATES: readonly string[] = [
  'pending',
  'applying',
  'applied',
  'rolled_back',
  'failed',
  'refused',
  'expired',
  'cancelled',
];
export type DnsVerdict = 'match' | 'cloudflare' | 'mismatch' | 'not_found' | 'unknown' | 'error';
const VERDICTS: readonly string[] = ['match', 'cloudflare', 'mismatch', 'not_found', 'unknown', 'error'];

export interface DomainRequest {
  readonly id: string;
  readonly domain: string;
  readonly tls: TlsMode;
  readonly previousDomain: string;
  readonly state: RequestState;
  readonly detail: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface ConsoleDomain {
  readonly origin: string | null;
  readonly source: 'setting' | 'environment' | 'none';
  readonly setting: {
    readonly origin: string;
    readonly source: 'owner' | 'host-applier';
    readonly updatedAt: string;
  } | null;
  readonly environment: string | null;
  readonly host: {
    readonly managed: boolean;
    readonly lastSeen: string | null;
    readonly version: string | null;
    readonly domain: string | null;
    readonly tls: TlsMode | null;
    readonly acmeEmail: string | null;
    readonly httpsPort: number | null;
  };
  readonly request: DomainRequest | null;
}

export interface DnsCheck {
  readonly domain: string;
  readonly addresses: readonly string[];
  readonly expected: readonly string[];
  readonly verdict: DnsVerdict;
  readonly detail: string | null;
  readonly checkedAt: string;
}

const isTls = (v: unknown): v is TlsMode =>
  typeof v === 'string' && (TLS_MODES as readonly string[]).includes(v);

function parseRequest(v: unknown): DomainRequest | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const state = str(o, 'state');
  if (!REQUEST_STATES.includes(state)) throw new ShapeError('unknown request state');
  if (!isTls(o.tls)) throw new ShapeError('unknown TLS mode');
  return {
    id: str(o, 'id'),
    domain: str(o, 'domain'),
    tls: o.tls,
    previousDomain: str(o, 'previousDomain'),
    state: state as RequestState,
    detail: nullableStr(o, 'detail'),
    requestedAt: str(o, 'requestedAt'),
    expiresAt: str(o, 'expiresAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

export function parseConsoleDomain(body: unknown): ConsoleDomain {
  const o = obj(body);
  const source = str(o, 'source');
  if (source !== 'setting' && source !== 'environment' && source !== 'none') throw new ShapeError('source');
  const s = o.setting;
  let setting: ConsoleDomain['setting'] = null;
  if (s !== null && s !== undefined) {
    const so = obj(s);
    const src = str(so, 'source');
    if (src !== 'owner' && src !== 'host-applier') throw new ShapeError('setting source');
    setting = { origin: str(so, 'origin'), source: src, updatedAt: str(so, 'updatedAt') };
  }
  const h = obj(o.host);
  return {
    origin: nullableStr(o, 'origin'),
    source,
    setting,
    environment: nullableStr(o, 'environment'),
    host: {
      managed: h.managed === true,
      lastSeen: nullableStr(h, 'lastSeen'),
      version: nullableStr(h, 'version'),
      domain: nullableStr(h, 'domain'),
      tls: isTls(h.tls) ? h.tls : null,
      acmeEmail: nullableStr(h, 'acmeEmail'),
      httpsPort: h.httpsPort === null || h.httpsPort === undefined ? null : int(h, 'httpsPort'),
    },
    request: parseRequest(o.request),
  };
}

export function getConsoleDomain(opts: Opts = {}): Promise<ConsoleDomain> {
  return apiRequest('GET', '/console-domain', parseConsoleDomain, opts);
}

export function checkDomainDns(domain: string, opts: Opts = {}): Promise<DnsCheck> {
  return apiRequest(
    'POST',
    '/console-domain/dns-check',
    (b) => {
      const o = obj(b);
      const verdict = str(o, 'verdict');
      if (!VERDICTS.includes(verdict)) throw new ShapeError('verdict');
      return {
        domain: str(o, 'domain'),
        addresses: strArray(o, 'addresses'),
        expected: strArray(o, 'expected'),
        verdict: verdict as DnsVerdict,
        detail: nullableStr(o, 'detail'),
        checkedAt: str(o, 'checkedAt'),
      };
    },
    { ...opts, body: { domain } },
  );
}

export interface SaveResult {
  readonly mode: 'setting' | 'host';
  readonly origin: string | null;
  readonly request: DomainRequest | null;
  readonly status: ConsoleDomain;
}

export function saveConsoleDomain(
  input: { readonly domain: string; readonly tls?: TlsMode; readonly email?: string },
  opts: Opts = {},
): Promise<SaveResult> {
  return apiRequest(
    'PUT',
    '/console-domain',
    (b) => {
      const o = obj(b);
      const mode = str(o, 'mode');
      if (mode !== 'setting' && mode !== 'host') throw new ShapeError('mode');
      return {
        mode,
        origin: nullableStr(o, 'origin'),
        request: parseRequest(o.request),
        status: parseConsoleDomain(o.status),
      };
    },
    { ...opts, body: input },
  );
}

export function clearConsoleDomain(opts: Opts = {}): Promise<ConsoleDomain> {
  return apiRequest('DELETE', '/console-domain', parseConsoleDomain, opts);
}

export function cancelDomainRequest(opts: Opts = {}): Promise<ConsoleDomain> {
  return apiRequest('POST', '/console-domain/request/cancel', parseConsoleDomain, opts);
}

/** The wizard's client-side check (the master validates again): a lower-case DNS name with a dot, no IP address. */
export function domainOf(input: string): string | null {
  let d = input.trim().toLowerCase();
  if (d.startsWith('https://')) d = d.slice('https://'.length);
  if (d.endsWith('/')) d = d.slice(0, -1);
  const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
  const ok =
    d.length >= 4 &&
    d.length <= 253 &&
    new RegExp(`^${label}(\\.${label})+$`).test(d) &&
    !/^[0-9]+$/.test(d.split('.').at(-1) ?? '');
  return ok ? d : null;
}
