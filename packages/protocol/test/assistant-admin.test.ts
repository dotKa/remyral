import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ADMIN_TOOLS,
  ASSISTANT_BROWSER_TOOLS,
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_TOOLS,
  assistantToolDescription,
  assistantToolInput,
} from '../src/assistant.js';

/** p16-assistant-admin: the administration tool schemas. */
describe('administration tools (p16-assistant-admin)', () => {
  const reads = [
    'list_users',
    'list_project_members',
    'worker_release_status',
    'describe_backups',
    'list_vault_credentials',
    'open_credential_rotation',
    'notification_preferences',
    'list_integrations',
    'quota_status',
    'list_schedules',
    'list_previews',
    'git_central_status',
  ] as const;
  const changes = [
    'manage_user',
    'manage_project_member',
    'manage_machine',
    'manage_release',
    'update_notification_preferences',
    'check_integration',
  ] as const;

  it('are listed with their kind: reads read, changes draft (never browser-only, not card-default)', () => {
    expect([...ASSISTANT_ADMIN_TOOLS].sort()).toEqual([...reads, ...changes].sort());
    for (const r of reads) expect(ASSISTANT_TOOLS[r].kind, r).toBe('read');
    for (const c of changes) {
      expect(ASSISTANT_TOOLS[c].kind, c).toBe('draft');
      // The master decides card-only per change (invite, destructive), not per tool.
      expect(ASSISTANT_CARD_DEFAULT_TOOLS.has(c)).toBe(false);
      expect(ASSISTANT_BROWSER_TOOLS.has(c)).toBe(false);
      expect(assistantToolDescription(c)).toContain('Acting:');
    }
  });

  it('say what a change does and keep secrets out', () => {
    for (const c of changes) expect(ASSISTANT_TOOLS[c].description, c).toMatch(/What it changes|changes:/i);
    expect(ASSISTANT_TOOLS.manage_user.description).toMatch(/ALWAYS a card/);
    expect(ASSISTANT_TOOLS.manage_user.description).toMatch(/DESTRUCTIVE/);
    expect(ASSISTANT_TOOLS.manage_machine.description).toMatch(/DESTRUCTIVE/);
    expect(ASSISTANT_TOOLS.open_credential_rotation.description).toMatch(
      /never receive, see or pass the new value/,
    );
    // p18-assistant-gaps: backups are started with draft_backup_action; a restore is always a card.
    expect(ASSISTANT_TOOLS.describe_backups.description).toMatch(/draft_backup_action/);
    expect(ASSISTANT_TOOLS.draft_backup_action.description).toMatch(/ALWAYS a card/);
    // No tool takes a secret value: no token / password / value field.
    for (const name of ASSISTANT_ADMIN_TOOLS) {
      const keys = Object.keys(ASSISTANT_TOOLS[name].input);
      for (const k of keys) expect(k, `${name}.${k}`).not.toMatch(/token|password|secret|^value$/i);
    }
  });

  it('validate their input strictly', () => {
    expect(assistantToolInput('manage_user').safeParse({ action: 'disable', user: 'ali' }).success).toBe(
      true,
    );
    expect(assistantToolInput('manage_user').safeParse({ action: 'delete', user: 'ali' }).success).toBe(
      false,
    );
    expect(
      assistantToolInput('manage_user').safeParse({ action: 'invite', username: 'x', password: 'p' }).success,
    ).toBe(false);
    expect(
      assistantToolInput('manage_release').safeParse({ action: 'set_rollout', percent: 101 }).success,
    ).toBe(false);
    expect(
      assistantToolInput('manage_project_member').safeParse({
        action: 'add',
        project: 'p',
        user: 'u',
        role: 'admin',
      }).success,
    ).toBe(false);
    expect(
      assistantToolInput('update_notification_preferences').safeParse({
        kinds: [{ kind: 'job.failed', email: false }],
        execute: true,
      }).success,
    ).toBe(true);
    expect(assistantToolInput('check_integration').safeParse({ provider: 'aws' }).success).toBe(false);
  });

  it('change_settings can switch destructive administration from the chat', () => {
    expect(
      assistantToolInput('change_settings').safeParse({
        target: 'security_policy',
        securityPolicy: { autonomy: { chatDestructive: true } },
      }).success,
    ).toBe(true);
  });
});
