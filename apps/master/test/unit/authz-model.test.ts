import { describe, expect, it } from 'vitest';
import {
  ACTION_NAMES,
  ACTIONS,
  authorize,
  isAction,
  type ProjectRole,
  projectRoleOf,
  type Role,
  type Subject,
  visibleProjects,
} from '../../src/authz/model.js';

function subject(role: Role, memberships: Record<string, ProjectRole> = {}, userId = 'u1'): Subject {
  return { userId, role, memberships: new Map(Object.entries(memberships)) };
}

describe('authorization model (p5-rbac)', () => {
  it('denies unknown actions by default, for every role', () => {
    for (const role of ['owner', 'admin', 'operator', 'viewer'] as const) {
      expect(authorize(subject(role), 'jobs.delete_everything')).toEqual({
        allow: false,
        reason: 'unknown_action',
      });
      // Prototype keys are not actions.
      expect(authorize(subject(role), 'constructor').allow).toBe(false);
      expect(authorize(subject(role), '__proto__').allow).toBe(false);
    }
    expect(isAction('toString')).toBe(false);
  });

  it('every catalog entry names a valid minimum role and scope', () => {
    expect(ACTION_NAMES.length).toBeGreaterThan(20);
    for (const name of ACTION_NAMES) {
      expect(name).toMatch(/^[a-z]+(\.[a-z]+)+$/);
      expect(['owner', 'admin', 'operator', 'viewer']).toContain(ACTIONS[name].minRole);
      expect(['global', 'project']).toContain(ACTIONS[name].scope);
    }
  });

  it('owner and admin are global: every project, no memberships needed', () => {
    for (const role of ['owner', 'admin'] as const) {
      const s = subject(role);
      expect(visibleProjects(s)).toBeNull();
      expect(projectRoleOf(s, 'anything')).toBe(role);
      expect(authorize(s, 'approvals.decide', { project: 'alpha' })).toEqual({ allow: true, role });
      expect(authorize(s, 'policy.write', { project: 'alpha' }).allow).toBe(true);
    }
    expect(authorize(subject('admin'), 'users.manage').allow).toBe(false);
    expect(authorize(subject('owner'), 'users.manage').allow).toBe(true);
  });

  it('operator/viewer see only member projects; invisible resources are not_visible (404)', () => {
    const op = subject('operator', { alpha: 'operator' });
    expect(visibleProjects(op)).toEqual(['alpha']);
    expect(authorize(op, 'jobs.read', { project: 'alpha' })).toEqual({ allow: true, role: 'operator' });
    expect(authorize(op, 'jobs.read', { project: 'beta' })).toEqual({ allow: false, reason: 'not_visible' });
    expect(authorize(op, 'approvals.decide', { project: 'beta' })).toEqual({
      allow: false,
      reason: 'not_visible',
    });
    // Collections: allowed by the account role; rows are filtered by visibleProjects.
    expect(authorize(op, 'jobs.read').allow).toBe(true);
    expect(authorize(op, 'jobs.read', { project: null }).allow).toBe(true);
  });

  it('the account role is a ceiling for membership roles', () => {
    const v = subject('viewer', { alpha: 'operator' });
    expect(projectRoleOf(v, 'alpha')).toBe('viewer');
    expect(authorize(v, 'approvals.decide', { project: 'alpha' })).toEqual({ allow: false, reason: 'role' });
    const o = subject('operator', { alpha: 'viewer' });
    expect(projectRoleOf(o, 'alpha')).toBe('viewer');
    expect(authorize(o, 'approvals.decide', { project: 'alpha' })).toEqual({ allow: false, reason: 'role' });
    expect(authorize(o, 'approvals.read', { project: 'alpha' })).toEqual({ allow: true, role: 'viewer' });
  });

  it('checks the account role before the resource (no existence oracle)', () => {
    const v = subject('viewer', {});
    // Same answer whether or not the job exists or is visible.
    expect(authorize(v, 'jobs.cancel', { project: 'beta' })).toEqual({ allow: false, reason: 'role' });
    expect(authorize(v, 'jobs.cancel')).toEqual({ allow: false, reason: 'role' });
  });

  it('global actions ignore memberships', () => {
    const o = subject('operator', { alpha: 'operator' });
    expect(authorize(o, 'audit.read').allow).toBe(false);
    expect(authorize(o, 'projects.create').allow).toBe(false);
    expect(authorize(o, 'workers.read').allow).toBe(true);
    expect(authorize(o, 'workers.drain').allow).toBe(false);
  });

  it('self-only actions require the resource owner to be the subject', () => {
    const s = subject('viewer', {}, 'me');
    expect(authorize(s, 'session.self', { ownerId: 'me' }).allow).toBe(true);
    expect(authorize(s, 'session.self', { ownerId: 'someone-else' })).toEqual({
      allow: false,
      reason: 'not_owner',
    });
    expect(authorize(s, 'session.self').allow).toBe(false);
  });
});
