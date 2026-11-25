import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { type OpsAction, parseAction } from './deploy';

/**
 * p8-preview-tunnels (ADR-0032; apps/master/src/previews/routes.ts): preview links for what a job serves on its
 * worker's localhost, through a Cloudflare Tunnel the master creates. The browser never sees a tunnel token; a
 * service-token preview's client secret is only returned by the explicit "reveal" call (admin, fresh code) and is
 * never stored by the console.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const PROTECTIONS = ['none', 'access', 'service-token'] as const;
export type PreviewProtection = (typeof PROTECTIONS)[number];

export const TUNNEL_STATES = ['opening', 'active', 'idle', 'closing', 'closed', 'failed'] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

export const CONNECTOR_STATES = ['starting', 'running', 'stopped', 'failed', 'refused', 'down'] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

export interface TunnelView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly hostname: string;
  readonly url: string;
  readonly protection: PreviewProtection;
  readonly stable: boolean;
  readonly state: TunnelState;
  readonly connector: {
    readonly state: ConnectorState;
    readonly detail: string | null;
    readonly since: string;
  } | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly port: number | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly openedBy: { readonly type: string; readonly id: string; readonly username: string | null };
  readonly openActionId: string | null;
  readonly serviceTokenClientId: string | null;
}

export interface PreviewSettings {
  readonly zone: { readonly id: string; readonly name: string } | null;
  readonly prefix: string | null;
  readonly agentsMayOpen: boolean;
  readonly accessEmails: readonly string[];
  readonly maxActive: number;
  readonly maxPerJob: number;
}

export interface JobPreviews {
  readonly tunnels: readonly TunnelView[];
  readonly available: { readonly ok: boolean; readonly reason: string | null };
  readonly settings: {
    readonly protections: readonly PreviewProtection[];
    readonly defaultTtlMinutes: number;
    readonly maxTtlMinutes: number;
  } | null;
}

function oneOf<T extends string>(values: readonly T[], v: unknown, what: string): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new ShapeError(what);
  return v as T;
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(key);
  return v;
}

export function parseTunnel(v: unknown): TunnelView {
  const o = obj(v);
  const c = o.connector === null || o.connector === undefined ? null : obj(o.connector);
  const by = obj(o.openedBy);
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    name: str(o, 'name'),
    hostname: str(o, 'hostname'),
    url: str(o, 'url'),
    protection: oneOf(PROTECTIONS, o.protection, 'protection'),
    stable: o.stable === true,
    state: oneOf(TUNNEL_STATES, o.state, 'state'),
    connector:
      c === null
        ? null
        : {
            state: oneOf(CONNECTOR_STATES, c.state, 'connector.state'),
            detail: typeof c.detail === 'string' ? c.detail : null,
            since: str(c, 'since'),
          },
    jobId: nullableStr(o, 'jobId'),
    workerId: nullableStr(o, 'workerId'),
    port: nullableInt(o, 'port'),
    expiresAt: str(o, 'expiresAt'),
    createdAt: str(o, 'createdAt'),
    closedAt: nullableStr(o, 'closedAt'),
    closeReason: nullableStr(o, 'closeReason'),
    openedBy: { type: str(by, 'type'), id: str(by, 'id'), username: nullableStr(by, 'username') },
    openActionId: nullableStr(o, 'openActionId'),
    serviceTokenClientId: typeof o.serviceTokenClientId === 'string' ? o.serviceTokenClientId : null,
  };
}

function tunnels(v: unknown): TunnelView[] {
  if (!Array.isArray(v)) throw new ShapeError('tunnels');
  return v.map(parseTunnel);
}

export function parsePreviewSettings(v: unknown): PreviewSettings | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const zone = o.zone === null || o.zone === undefined ? null : obj(o.zone);
  const emails = Array.isArray(o.accessEmails)
    ? o.accessEmails.filter((e): e is string => typeof e === 'string')
    : [];
  return {
    zone: zone === null ? null : { id: str(zone, 'id'), name: str(zone, 'name') },
    prefix: typeof o.prefix === 'string' && o.prefix !== '' ? o.prefix : null,
    agentsMayOpen: o.agentsMayOpen !== false,
    accessEmails: emails,
    maxActive: typeof o.maxActive === 'number' ? o.maxActive : 5,
    maxPerJob: typeof o.maxPerJob === 'number' ? o.maxPerJob : 3,
  };
}

function parseJobPreviews(v: unknown): JobPreviews {
  const o = obj(v);
  const a = obj(o.available);
  const s = o.settings === null || o.settings === undefined ? null : obj(o.settings);
  return {
    tunnels: tunnels(o.tunnels),
    available: { ok: a.ok === true, reason: typeof a.reason === 'string' ? a.reason : null },
    settings:
      s === null
        ? null
        : {
            protections: Array.isArray(s.protections)
              ? s.protections.filter((p): p is PreviewProtection =>
                  (PROTECTIONS as readonly unknown[]).includes(p),
                )
              : ['none'],
            defaultTtlMinutes: typeof s.defaultTtlMinutes === 'number' ? s.defaultTtlMinutes : 240,
            maxTtlMinutes: typeof s.maxTtlMinutes === 'number' ? s.maxTtlMinutes : 1440,
          },
  };
}

function parseActionAndTunnel(v: unknown): { action: OpsAction; tunnel: TunnelView | null } {
  const o = obj(v);
  return {
    action: parseAction(o.action),
    tunnel: o.tunnel === null || o.tunnel === undefined ? null : parseTunnel(o.tunnel),
  };
}

// ------------------------------------------------------------------------------ requests

export function getProjectPreviews(
  project: string,
  opts: Opts = {},
): Promise<{ settings: PreviewSettings | null; tunnels: TunnelView[] }> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/previews`,
    (v) => {
      const o = obj(v);
      return { settings: parsePreviewSettings(o.settings), tunnels: tunnels(o.tunnels) };
    },
    opts,
  );
}

export function getJobPreviews(jobId: string, opts: Opts = {}): Promise<JobPreviews> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/previews`, parseJobPreviews, opts);
}

export interface OpenPreviewBody {
  readonly port: number;
  readonly name?: string;
  readonly protect?: PreviewProtection;
  readonly ttlMinutes?: number;
  readonly stable?: boolean;
  readonly idempotencyKey: string;
}

export function openPreview(
  jobId: string,
  body: OpenPreviewBody,
  opts: Opts = {},
): Promise<{ action: OpsAction; tunnel: TunnelView | null }> {
  return apiRequest('POST', `/jobs/${encodeURIComponent(jobId)}/previews`, parseActionAndTunnel, {
    ...opts,
    body,
  });
}

export function closePreview(
  id: string,
  idempotencyKey: string,
  opts: Opts = {},
): Promise<{ action: OpsAction; tunnel: TunnelView | null }> {
  return apiRequest('POST', `/previews/${encodeURIComponent(id)}/close`, parseActionAndTunnel, {
    ...opts,
    body: { idempotencyKey },
  });
}

export function extendPreview(
  id: string,
  minutes: number,
  idempotencyKey: string,
  opts: Opts = {},
): Promise<{ action: OpsAction; tunnel: TunnelView | null }> {
  return apiRequest('POST', `/previews/${encodeURIComponent(id)}/extend`, parseActionAndTunnel, {
    ...opts,
    body: { minutes, idempotencyKey },
  });
}

export function revealServiceToken(
  id: string,
  opts: Opts = {},
): Promise<{ clientId: string; clientSecret: string }> {
  return apiRequest(
    'POST',
    `/previews/${encodeURIComponent(id)}/reveal`,
    (v) => {
      const o = obj(v);
      return { clientId: str(o, 'clientId'), clientSecret: str(o, 'clientSecret') };
    },
    opts,
  );
}

// ------------------------------------------------------------------------------ wording

export const PROTECTION_TEXT: Readonly<Record<PreviewProtection, string>> = {
  none: 'Public link',
  access: 'Cloudflare Access (e-mail code)',
  'service-token': 'Service token (app backend)',
};

export const TUNNEL_STATE_TEXT: Readonly<Record<TunnelState, string>> = {
  opening: 'Opening',
  active: 'Open',
  idle: 'Idle (no job serves it)',
  closing: 'Closing',
  closed: 'Closed',
  failed: 'Failed',
};

export const CONNECTOR_TEXT: Readonly<Record<ConnectorState, string>> = {
  starting: 'connector starting',
  running: 'connector running',
  stopped: 'connector stopped',
  failed: 'connector failed',
  refused: 'refused by the machine',
  down: 'machine offline',
};

/** An https URL the console may link to (preview URLs come from the master; never another scheme). */
export function safePreviewUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === '' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Still open (or on its way): the card keeps polling. */
export function tunnelLive(t: TunnelView): boolean {
  return t.state === 'opening' || t.state === 'active' || t.state === 'closing';
}

/** Ops action kinds of p8-preview-tunnels (Deploys page labels). */
export const TUNNEL_KIND_TEXT: Readonly<Record<string, string>> = {
  'tunnel.open': 'Preview open',
  'tunnel.close': 'Preview close',
  'tunnel.extend': 'Preview extend',
};

/** Media types of mobile app packages (download only, never previewed). */
export const PACKAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.android.package-archive',
  'application/x-android-app-bundle',
  'application/x-ios-app',
]);

export function isAppPackage(mediaType: string | null, name = ''): boolean {
  return (mediaType !== null && PACKAGE_MEDIA_TYPES.has(mediaType)) || /\.(apk|aab|ipa)$/i.test(name);
}
