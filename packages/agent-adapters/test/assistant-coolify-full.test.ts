import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p17-coolify-full (docs/design/p17-coolify-full.md §8): rule 51 — the assistant manages Coolify completely and never
 * answers "aracım yok" for what the API offers (the trigger: a persistent /data volume), always says that a new volume
 * starts empty, names the exact Coolify screen for what the API cannot do, and keeps destructive steps explicit.
 */
describe('managing Coolify completely (p17-coolify-full)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = rules.find((l) => l.startsWith('51. ')) ?? '';

  it('rule 51 names the tools and forbids saying there is no tool', () => {
    for (const t of [
      'coolify_resources',
      'coolify_resource',
      'coolify_logs',
      'coolify_storage',
      'coolify_lifecycle',
      'coolify_database',
      'coolify_service',
      'coolify_infra',
    ])
      expect(rule).toContain(t);
    expect(rule).toMatch(/NEVER answer that you have no tool/);
    expect(rule).toContain('remyral-data');
  });

  it('says the volume starts empty, gives the manual step and the Coolify screens, keeps deletions explicit', () => {
    expect(rule).toMatch(/starts empty/);
    expect(rule).toMatch(/lost at that redeploy unless it is copied out first/);
    expect(rule).toContain('unsupported');
    expect(rule).toContain('Servers → <server> → Proxy');
    expect(rule).toMatch(/typed the resource's name \(confirm\)/);
    expect(rule).toMatch(/passwords.*never go through you/);
    // Rule 28 points to rule 51 for storages.
    expect(rules.find((l) => l.startsWith('28. '))).toContain('rule 51');
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
