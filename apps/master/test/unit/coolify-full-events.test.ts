import { describe, expect, it } from 'vitest';
import { isDestructiveDraft } from '../../src/chat/coolify-actions.js';
import {
  CORE_EVENTS,
  coolifyDraftEvent,
  eventForRoute,
  eventOfDraft,
  NO_STEP_UP_ACTIONS,
  STEP_UP_EVENTS,
} from '../../src/security-policy/events.js';

/**
 * p17-coolify-full: the security-policy events of the new Coolify routes and cards — Coolify-wide changes are
 * `coolify.manage`, removing / stopping / deleting `coolify.destructive` (route overrides), reads never ask; a
 * destructive card runs only on the user's explicit instruction.
 */
describe('Coolify step-up events (p17-coolify-full)', () => {
  it('maps Coolify-wide writes to coolify.manage and destructive routes to coolify.destructive', () => {
    const base = '/integrations/coolify/connections/:id';
    expect(eventForRoute('POST', `${base}/resources/:kind/:uuid/storages`, 'coolify.manage')).toBe(
      'coolify.manage',
    );
    expect(eventForRoute('POST', `${base}/databases`, 'coolify.manage')).toBe('coolify.manage');
    for (const r of [
      `DELETE ${base}/resources/:kind/:uuid/storages/:storage`,
      `POST ${base}/resources/:kind/:uuid/stop`,
      `DELETE ${base}/databases/:uuid`,
      `DELETE ${base}/services/:uuid`,
      `DELETE ${base}/projects/:uuid`,
      `DELETE ${base}/projects/:uuid/environments/:environment`,
      'DELETE /projects/:id/coolify/apps/:uuid/storages/:storage',
      'POST /projects/:id/coolify/apps/:uuid/stop',
    ]) {
      const [m, u] = r.split(' ');
      expect(eventForRoute(m ?? '', u ?? '', 'coolify.manage'), r).toBe('coolify.destructive');
    }
    // A project application's non-destructive change stays deploy.coolify; reads never ask.
    expect(eventForRoute('POST', '/projects/:id/coolify/apps/:uuid/storages', 'deploy.coolify.manage')).toBe(
      'deploy.coolify',
    );
    expect(eventForRoute('POST', '/projects/:id/coolify/apps/:uuid/start', 'deploy.coolify.manage')).toBe(
      'deploy.coolify',
    );
    expect(NO_STEP_UP_ACTIONS.has('coolify.read')).toBe(true);
    expect(eventForRoute('GET', `${base}/resources`, 'coolify.read')).toBeUndefined();
  });

  it('both events are off in Serbest, on in Dengeli, never the safe core', () => {
    for (const e of ['coolify.manage', 'coolify.destructive'] as const) {
      expect(STEP_UP_EVENTS[e]).toMatchObject({ category: 'deploy', core: false, balanced: true });
      expect(CORE_EVENTS).not.toContain(e);
    }
  });

  it('a card asks for the code its route would', () => {
    expect(eventOfDraft('coolify_change', { op: 'resource', scope: 'project', method: 'addStorage' })).toBe(
      'deploy.coolify',
    );
    expect(
      eventOfDraft('coolify_change', { op: 'resource', scope: 'connection', method: 'createDatabase' }),
    ).toBe('coolify.manage');
    expect(
      eventOfDraft('coolify_change', {
        op: 'resource',
        scope: 'project',
        method: 'removeStorage',
        destructive: true,
      }),
    ).toBe('coolify.destructive');
    // The existing delete_app card keeps its event.
    expect(coolifyDraftEvent({ op: 'delete_app', destructive: true })).toBe('deploy.coolify');
  });

  it('destructive Coolify cards never run by default', () => {
    expect(
      isDestructiveDraft('coolify_change', { op: 'resource', method: 'deleteDatabase', destructive: true }),
    ).toBe(true);
    expect(isDestructiveDraft('coolify_change', { op: 'resource', method: 'addStorage' })).toBe(false);
  });
});
