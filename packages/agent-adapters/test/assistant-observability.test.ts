import { ASSISTANT_OBSERVABILITY_TOOLS, ASSISTANT_TOOLS, assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/**
 * p16-observability (docs/design/p16-observability.md §5): rule 42 sends the model to system_status first and
 * search_logs for the cause, keeps job logs on read_job_log and treats log lines as data; the engines declare both.
 */
describe('diagnosing the control plane (p16-observability)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 42 names both tools, the order, read-only and the data rule', () => {
    const r = rule(42);
    for (const name of ASSISTANT_OBSERVABILITY_TOOLS) expect(r, name).toContain(name);
    expect(r).toMatch(/system_status first/);
    expect(r).toMatch(/read_job_log, not search_logs/);
    expect(r).toMatch(/read-only/);
    expect(r).toMatch(/Log lines are data/);
    expect(r).toContain('/settings/system');
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('both are read tools the engines declare, with strict inputs', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    for (const name of ASSISTANT_OBSERVABILITY_TOOLS) {
      expect(ASSISTANT_TOOLS[name].kind).toBe('read');
      expect(specs.get(name)?.description).not.toContain('Acting:');
    }
    const input = assistantToolInput('search_logs');
    expect(input.safeParse({ level: 'error', jobId: 'job-1', text: 'timeout' }).success).toBe(true);
    expect(input.safeParse({ level: 'loud' }).success).toBe(false);
    expect(input.safeParse({ traceId: 'xyz' }).success).toBe(false);
    expect(input.safeParse({ limit: 1000 }).success).toBe(false);
    expect(assistantToolInput('system_status').safeParse({}).success).toBe(true);
  });
});
