import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/** p16-selfhost-onboarding: the setup wizard and host-side control-plane upgrades (rule 47). */
describe('setup wizard and control-plane updates (p16-selfhost-onboarding)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');

  it('rule 47: wizard routes, setup token on the server, upgrades by the host applier', () => {
    const r47 = rules.find((l) => l.startsWith('47. ')) ?? '';
    expect(r47).toContain('/onboarding');
    expect(r47).toContain('/setup');
    expect(r47).toContain('sudo remyral-ctl setup-token');
    expect(r47).toContain('sudo remyral-ctl upgrade --check');
    expect(r47).toContain('--restore-backup');
    // p18-assistant-gaps: the owner's update request goes through the host applier (draft_control_plane_update).
    expect(r47).toContain('draft_control_plane_update');
    expect(r47).toMatch(/never by a job/);
    expect(r47).toMatch(/fresh authenticator code/);
    expect(r47).toMatch(/Do not claim an upgrade happened unless the result says so/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
