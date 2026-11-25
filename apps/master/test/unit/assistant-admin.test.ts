import { describe, expect, it } from 'vitest';
import { auditRequestContext, withAuditSource } from '../../src/audit/request-context.js';
import {
  ADMIN_ACTION_OF,
  adminAlwaysFresh,
  DESTRUCTIVE_OPS,
  isAdminOp,
} from '../../src/chat/admin-actions.js';
import { adminOpEvent, eventOfDraft, isStepUpEvent } from '../../src/security-policy/events.js';
import { effectivePolicy, PRESETS, SecurityPolicyPatch } from '../../src/security-policy/model.js';

/** p16-assistant-admin: the pure parts — events, card-only marks, the policy switch, the audit source scope. */
describe('administration through the chat (p16-assistant-admin)', () => {
  it('every operation has an authorization action and an event of the catalog; unknown ones fail closed', () => {
    for (const op of Object.keys(ADMIN_ACTION_OF)) {
      expect(isAdminOp(op)).toBe(true);
      expect(isStepUpEvent(adminOpEvent(op)), op).toBe(true);
    }
    expect(adminOpEvent('user.disable')).toBe('users.roles');
    expect(adminOpEvent('member.add')).toBe('users.roles');
    expect(adminOpEvent('machine.revoke')).toBe('machines.fleet');
    expect(adminOpEvent('release.set_rollout')).toBe('releases.publish');
    expect(adminOpEvent('release.rollback_machine')).toBe('machines.fleet');
    expect(adminOpEvent('notifications.update')).toBe('chat.cards');
    expect(adminOpEvent('notifications.update', { changesTargets: true })).toBe('notifications.channels');
    expect(adminOpEvent('anything.else')).toBe('security.policy');
    expect(isAdminOp('user.delete')).toBe(false);
  });

  it('a settings card with target admin takes its operation’s event; other targets are unchanged', () => {
    expect(eventOfDraft('settings_change', { target: 'admin', op: 'machine.approve' })).toBe(
      'machines.fleet',
    );
    expect(eventOfDraft('settings_change', { target: 'admin' })).toBe('security.policy');
    expect(eventOfDraft('settings_change', { target: 'project_execution' })).toBe('machines.sandbox');
  });

  it('user account changes are always-fresh; disable and revoke are the destructive ones', () => {
    expect(adminAlwaysFresh({ target: 'admin', op: 'user.set_role' })).toBe(true);
    expect(adminAlwaysFresh({ target: 'admin', op: 'member.add' })).toBe(false);
    expect(adminAlwaysFresh({ target: 'security_policy', op: 'user.set_role' })).toBe(false);
    expect([...DESTRUCTIVE_OPS].sort()).toEqual(['machine.revoke', 'user.disable']);
  });

  it('destructive administration from the chat is off in every preset and can be switched on', () => {
    for (const p of Object.values(PRESETS)) expect(p.autonomy.chatDestructive).toBe(false);
    expect(
      effectivePolicy({ preset: 'serbest', autonomy: { chatDestructive: true } }).autonomy.chatDestructive,
    ).toBe(true);
    expect(SecurityPolicyPatch.safeParse({ autonomy: { chatDestructive: true } }).success).toBe(true);
  });

  it('withAuditSource marks the scope (also across awaits) and keeps an API token id', async () => {
    expect(auditRequestContext.getStore()?.source).toBeUndefined();
    const seen = await auditRequestContext.run({ apiTokenId: 'tok-1' }, () =>
      withAuditSource('chat', async () => {
        await new Promise((r) => setTimeout(r, 1));
        return auditRequestContext.getStore();
      }),
    );
    expect(seen).toEqual({ apiTokenId: 'tok-1', source: 'chat' });
    expect(auditRequestContext.getStore()).toBeUndefined();
  });
});
