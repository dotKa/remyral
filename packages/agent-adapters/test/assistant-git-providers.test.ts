import { ASSISTANT_TOOLS, assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p16-git-providers (docs/design/p16-git-providers.md §7): rule 45 makes the git tools provider-agnostic (MR wording
 * on GitLab), sends token handling to the console and keeps GitHub-only tools GitHub-only; create_repository takes the
 * provider and the connection.
 */
describe('GitLab and Bitbucket through the chat (p16-git-providers)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 45: wording per provider, create_repository, no tokens in the chat, GitHub-only tools', () => {
    const r = rule(45);
    expect(r).toContain('merge request');
    expect(r).toContain('MR !<n>');
    expect(r).toContain('PR #<n>');
    expect(r).toContain('create_repository with provider gitlab or bitbucket');
    expect(r).toMatch(/never see, ask for or repeat a token/);
    expect(r).toMatch(/Ayarlar → Entegrasyonlar → GitLab \/ Bitbucket/);
    expect(r).toMatch(/GitHub-only tools/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('create_repository takes provider and connection; GitLab group paths as owner', () => {
    expect(ASSISTANT_TOOLS.create_repository.kind).toBe('draft');
    const input = assistantToolInput('create_repository');
    expect(input.safeParse({ name: 'site' }).success).toBe(true);
    expect(
      input.safeParse({ name: 'site', provider: 'gitlab', connection: 'Şirket GitLab', owner: 'acme/web' })
        .success,
    ).toBe(true);
    expect(input.safeParse({ name: 'site', provider: 'bitbucket' }).success).toBe(true);
    expect(input.safeParse({ name: 'site', provider: 'gitea' }).success).toBe(false);
    expect(input.safeParse({ name: 'site', token: 'x' }).success).toBe(false);
    expect(ASSISTANT_TOOLS.git_central_status.description).toContain('GitLab / Bitbucket connections');
  });
});
