import { ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p19-linux-host-isolation Part 2: rule 57 — capacity advice only from describe_worker `capacity`, never an invented
 * setting (the owner was told to raise a "host-restricted slot count" that does not exist). p20-quick: the unconfined
 * profile's parallelism comes from the effective machine setting (p19-unconfined-parallel), never a fixed rule.
 */
describe('assistant capacity rule (p19-linux-host-isolation)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 57 sends capacity questions to describe_worker capacity and names the one real setting', () => {
    const r = rule(57);
    expect(r).toContain('describe_worker');
    expect(r).toContain('capacity');
    expect(r).toMatch(/Never invent a setting/);
    expect(r).toMatch(/there is no per-profile or "host-restricted slot" setting/);
    expect(r).toContain('En çok paralel iş');
    expect(r).toContain('Makineler → <machine> → Yapılandırma → Genel');
    expect(r).toMatch(/ONLY for a profile whose limitedBy is max_parallel_jobs/);
    expect(r).toContain('sudo apt install bubblewrap');
    // p20-quick: no fixed "unconfined: always one at a time" — the answer follows the effective setting.
    expect(r).not.toMatch(/always one at a time/);
    expect(r).toContain('Sandbox’sız işler paralel çalışabilir');
    expect(r).toMatch(/CURRENT parallel \/ runsAlone/);
    expect(r).toMatch(/Never state from memory that a profile ALWAYS runs one at a time/);
    // Turkish spelling (rule 48): no circumflex.
    expect(r).not.toMatch(/[âîûÂÎÛ]/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('describe_worker says what its capacity block carries', () => {
    const d = ASSISTANT_TOOLS.describe_worker.description;
    expect(d).toContain('capacity');
    expect(d).toContain('limitedBy');
    expect(d).toContain('En çok paralel iş');
  });
});
