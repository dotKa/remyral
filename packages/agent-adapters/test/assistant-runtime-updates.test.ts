import { ASSISTANT_TOOLS, assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md §5): rule 40 tells the model that a version newer than the
 * release pin installs only as "doğrulanmamış" through the policy, how to roll back and that a verified candidate is not
 * "verified"; the draft tool and the release status describe the option.
 */
describe('runtime updates through the chat (p16-runtime-updates)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 40 names the tools, the policy, the label, the rollback and what verification means', () => {
    const r = rule(40);
    expect(r).toContain('draft_runtime_update');
    expect(r).toContain('worker_release_status');
    expect(r).toContain('fleet.unverifiedRuntimeUpdates');
    expect(r).toContain('doğrulanmamış');
    expect(r).toMatch(/rollback: true/);
    expect(r).toMatch(/never call it verified or supported/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('draft_runtime_update and worker_release_status describe the unverified option; the input is strict', () => {
    expect(ASSISTANT_TOOLS.draft_runtime_update.kind).toBe('draft');
    expect(ASSISTANT_TOOLS.draft_runtime_update.description).toMatch(
      /unverified: true installs a version NEWER/,
    );
    expect(ASSISTANT_TOOLS.worker_release_status.description).toMatch(/labelled unverified/);
    const input = assistantToolInput('draft_runtime_update');
    expect(
      input.safeParse({ runtime: 'codex', workers: 'all', unverified: true, rollout: 'canary-first' })
        .success,
    ).toBe(true);
    expect(input.safeParse({ runtime: 'codex', workers: 'all', version: 'latest' }).success).toBe(false);
    expect(input.safeParse({ runtime: 'openhands', workers: 'all' }).success).toBe(false);
  });
});
