import { ASSISTANT_ADMIN_TOOLS, ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/**
 * p16-assistant-admin (docs/design/p16-assistant-admin.md): rule 39 tells the model which administration it can do,
 * that invites and destructive changes stay cards, that secrets never pass the chat and how backups are started (a
 * restore always stays a card, p18-assistant-gaps);
 * rule 2 lists the new acting tools; every engine declares the tools.
 */
describe('administration through the chat (p16-assistant-admin)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 39 names every administration tool and the card-only cases', () => {
    const r = rule(39);
    for (const name of ASSISTANT_ADMIN_TOOLS) expect(r, name).toContain(name);
    expect(r).toMatch(/ALWAYS stay a card/);
    expect(r).toMatch(/temporary password appears once on the card/);
    expect(r).toMatch(/disabling a user, revoking a machine/);
    expect(r).toMatch(/Secrets never pass this chat/);
    // p18-assistant-gaps: backups are draft_backup_action now; a restore always stays a card.
    expect(r).toContain('draft_backup_action');
    expect(r).toMatch(/a restore \(restore\) is ALWAYS a card/);
    expect(r).toMatch(/never claim a backup, drill or restore started unless the result says executed: true/);
    expect(r).toMatch(/Never change the signed-in user's own account/);
  });

  it('rule 2 lists the acting administration tools; rule numbers stay unique', () => {
    const r = rule(2);
    for (const name of [
      'manage_user',
      'manage_project_member',
      'manage_machine',
      'manage_release',
      'update_notification_preferences',
      'check_integration',
    ])
      expect(r, name).toContain(name);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('the engines declare the tools: reads without the acting suffix, changes with it', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    for (const name of ASSISTANT_ADMIN_TOOLS) {
      const s = specs.get(name);
      expect(s, name).toBeDefined();
      if (ASSISTANT_TOOLS[name].kind === 'read') expect(s?.description).not.toContain('Acting:');
      else expect(s?.description).toContain('Acting:');
    }
    expect(JSON.stringify(specs.get('manage_machine')?.inputSchema)).toContain('"pairingCode"');
    expect(JSON.stringify(specs.get('manage_user')?.inputSchema)).toContain('"propose"');
  });
});
