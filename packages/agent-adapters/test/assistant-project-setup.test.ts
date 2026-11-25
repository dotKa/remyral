import { ASSISTANT_PROJECT_SETUP_TOOLS, ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/** p18-project-bootstrap: rule 56 — check a new project's repository, network and machines and ask before acting. */
describe('assistant project setup (p18-project-bootstrap)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 56 names the tools, checks before the first job and asks the user', () => {
    const r = rule(56);
    for (const name of ASSISTANT_PROJECT_SETUP_TOOLS) {
      expect(r, name).toContain(name);
      expect(ASSISTANT_TOOL_NAMES).toContain(name);
    }
    expect(r).toMatch(/before the FIRST job/);
    expect(r).toContain('ask_user');
    expect(r).toContain('plan_ask_decision');
    expect(r).toMatch(/ALWAYS the user's decision, also in an autonomous plan: never silently/);
    expect(r).toMatch(/EMPTY repository is fine/);
    expect(r).toMatch(/draft_job workers \/ os/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('rule 26 no longer says the network cannot be changed from the chat', () => {
    const r = rule(26);
    expect(r).not.toMatch(/you cannot change it and there is no draft tool for it/);
    expect(r).toContain('draft_project_network');
  });

  it('the engines declare the setup tools (drafts acting, the read as a read)', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    expect(specs.get('draft_project_network')?.description).toContain('Acting:');
    expect(specs.get('draft_project_machines')?.description).toContain('Acting:');
    expect(JSON.stringify(specs.get('draft_project_network')?.inputSchema)).toContain('"allowlist"');
    expect(specs.get('describe_project_readiness')?.description).toMatch(/^READ/);
  });
});
