import { apiRequest, obj, type RequestOptions } from './client';

/**
 * p5-coolify-sso: whether "Open Coolify" is available and where it goes (master `GET /coolify-sso/config`,
 * owner/admin only). The URL comes from the master's configuration; the console only accepts an https URL.
 */
export interface CoolifySso {
  readonly enabled: boolean;
  readonly url: string | null;
  /**
   * p13-multi-coolify: one "Open Coolify" entry per connection (https only): `sso` through the server's SSO gate,
   * else the connection's own address (sign in there).
   */
  readonly connections: readonly {
    readonly id: string;
    readonly label: string;
    readonly url: string;
    readonly sso: boolean;
    readonly isDefault: boolean;
  }[];
}

export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.username === '' && u.password === '' ? u.href : null;
  } catch {
    return null;
  }
}

export function getCoolifySso(opts: Omit<RequestOptions, 'body'> = {}): Promise<CoolifySso> {
  return apiRequest(
    'GET',
    '/coolify-sso/config',
    (v) => {
      const o = obj(v);
      const url = safeHttpsUrl(o.url);
      const connections = (Array.isArray(o.connections) ? o.connections : []).flatMap((c) => {
        const x = obj(c);
        const u = safeHttpsUrl(x.url);
        if (u === null || typeof x.id !== 'string' || typeof x.label !== 'string') return [];
        return [{ id: x.id, label: x.label, url: u, sso: x.sso === true, isDefault: x.isDefault === true }];
      });
      return { enabled: o.enabled === true && url !== null, url, connections };
    },
    opts,
  );
}

/** The two fixed console→master continuation paths of the SSO flows (never a URL from the query). */
export const SSO_RESUME_PATHS = {
  oidc: '/api/oidc/authorize/resume',
  coolify: '/api/coolify-sso/ticket',
} as const;

/** Opaque sealed request from the master (base64url). */
export const SEALED_REQUEST = /^[A-Za-z0-9_-]{16,4096}$/;
