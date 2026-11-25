import { useEffect, useState } from 'react';
import { getCoolifySso } from '../api/sso';
import { useAuth } from '../auth/AuthProvider';

/** owner/admin may open Coolify (master RBAC action `sso.coolify`). */
export function canOpenCoolify(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * One "Open Coolify" entry. `label` null: the single SSO link of a server without connections (p5 behaviour).
 * `testId` is `open-coolify` for the default (or only) entry, `open-coolify-<id>` for the others.
 */
export interface CoolifyLink {
  readonly key: string;
  readonly url: string;
  readonly label: string | null;
  readonly sso: boolean;
  readonly testId: string;
}

/**
 * p13-multi-coolify: the "Open Coolify" entries for the signed-in owner/admin — one per Coolify connection (the SSO
 * gate for connections that use it, else the connection's own address), or the single SSO link when the master lists
 * no connection. Empty for other roles (they never call the endpoint) or when nothing is available.
 */
export function useCoolifyLinks(): readonly CoolifyLink[] {
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : null;
  const [links, setLinks] = useState<readonly CoolifyLink[]>([]);
  useEffect(() => {
    if (role === null || !canOpenCoolify(role)) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    getCoolifySso().then(
      (c) => {
        if (cancelled) return;
        if (c.connections.length === 0) {
          setLinks(
            c.enabled && c.url !== null
              ? [{ key: 'sso', url: c.url, label: null, sso: true, testId: 'open-coolify' }]
              : [],
          );
          return;
        }
        const primary = c.connections.find((x) => x.isDefault) ?? c.connections[0];
        setLinks(
          c.connections.map((x) => ({
            key: x.id,
            url: x.url,
            label: x.label,
            sso: x.sso,
            testId: x === primary ? 'open-coolify' : `open-coolify-${x.id}`,
          })),
        );
      },
      () => {
        if (!cancelled) setLinks([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [role]);
  return links;
}
