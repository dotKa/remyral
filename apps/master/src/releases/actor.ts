import type { AuditEventInput } from '../audit/audit.js';
import type { ActorContext } from '../workers/fleet.js';

/** A host-side process acting on releases (no session, no IP): e.g. the `release-import` CLI. */
export interface SystemActor {
  readonly type: 'system';
  readonly id: string;
}

/**
 * Who publishes or promotes a release: a signed-in admin through the console/API ({@link ActorContext},
 * audited as `user`), or a host-side import ({@link SystemActor}, audited as `system`).
 */
export type ReleaseActor = ActorContext | SystemActor;

/** `node dist/cli/release-import.js` on the control-plane host (p6-release-import). */
export const RELEASE_IMPORT_ACTOR: SystemActor = { type: 'system', id: 'release-import' };

/** The audit identity of an actor (actor, ip, user agent). */
export function auditIdentity(actor: ReleaseActor): Pick<AuditEventInput, 'actor' | 'ip' | 'userAgent'> {
  if ('type' in actor) return { actor: { type: 'system', id: actor.id }, ip: null, userAgent: null };
  return { actor: { type: 'user', id: actor.userId }, ip: actor.ip, userAgent: actor.userAgent };
}

/** The user recorded in `uploaded_by` / `updated_by` (null for a system actor: those columns are user FKs). */
export function actorUserId(actor: ReleaseActor): string | null {
  return 'type' in actor ? null : actor.userId;
}
