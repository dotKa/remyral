import { ASSISTANT_PROJECTS_TOOLS, ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/** p18-multi-project W3 + W5 (worker 1.2.1): rule 54 — working projects, shared workflows, job batches. */
describe('assistant working projects (p18-multi-project)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 54 names every new tool and the targeting rules', () => {
    const r = rule(54);
    for (const name of ASSISTANT_PROJECTS_TOOLS) {
      expect(r, name).toContain(name);
      expect(ASSISTANT_TOOL_NAMES).toContain(name);
    }
    expect(r).toContain('Çalışma projeleri');
    expect(r).toContain('project_required');
    expect(r).toContain('project_not_in_thread');
    expect(r).toMatch(/ask with ask_user/);
    expect(r).toMatch(/never one job over several repositories/);
    // W4: the same automation in several projects (a group).
    expect(r).toMatch(/draft_automation with projects/);
    expect(r).toContain('Tümüne uygula');
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('the engines declare the tools as acting drafts; draft_workflow_run takes project', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    for (const name of ASSISTANT_PROJECTS_TOOLS)
      expect(specs.get(name)?.description, name).toContain('Acting:');
    expect(JSON.stringify(specs.get('draft_workflow_run')?.inputSchema)).toContain('"project"');
    expect(JSON.stringify(specs.get('draft_job_batch')?.inputSchema)).toContain('"perProject"');
  });
});
