import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_PROJECT_SETUP_FEATURE,
  ASSISTANT_PROJECT_SETUP_TOOLS,
  ASSISTANT_TOOLS,
  assistantToolDescription,
  assistantToolInput,
  WorkerFeature,
} from '../src/index.js';

/** p18-project-bootstrap (docs/design/p18-project-bootstrap.md §4): the project setup tools and their features. */
describe('assistant project setup (p18-project-bootstrap)', () => {
  it('comes with a worker feature; the empty-repository workspace has its own', () => {
    expect(WorkerFeature.options).toContain(ASSISTANT_PROJECT_SETUP_FEATURE);
    expect(WorkerFeature.options).toContain('workspace-empty-repo-v1');
    expect([...ASSISTANT_PROJECT_SETUP_TOOLS].sort()).toEqual([
      'describe_project_readiness',
      'draft_project_machines',
      'draft_project_network',
    ]);
    expect(ASSISTANT_TOOLS.describe_project_readiness.kind).toBe('read');
    for (const t of ['draft_project_network', 'draft_project_machines'] as const) {
      expect(ASSISTANT_TOOLS[t].kind, t).toBe('draft');
      expect(assistantToolDescription(t)).toContain('Acting:');
      // The master decides card vs. direct per change (opening the network is a card unless asked for).
      expect(ASSISTANT_CARD_DEFAULT_TOOLS.has(t)).toBe(false);
    }
  });

  it('validates the inputs strictly', () => {
    const r = (v: unknown) => assistantToolInput('describe_project_readiness').safeParse(v).success;
    expect(r({ project: 'sample-leads' })).toBe(true);
    expect(r({})).toBe(false);
    expect(r({ project: 'a b' })).toBe(false);

    const n = (v: unknown) => assistantToolInput('draft_project_network').safeParse(v).success;
    expect(
      n({ project: 'p', mode: 'allowlist', presets: ['npm', 'github'], hosts: ['api.stripe.com'] }),
    ).toBe(true);
    expect(n({ project: 'p', mode: 'none' })).toBe(true);
    expect(n({ project: 'p', mode: 'open' })).toBe(false);
    expect(n({ project: 'p', mode: 'allowlist', presets: ['apt'] })).toBe(false);
    expect(
      n({ project: 'p', mode: 'allowlist', hosts: Array.from({ length: 49 }, (_, i) => `h${String(i)}.io`) }),
    ).toBe(false);

    const m = (v: unknown) => assistantToolInput('draft_project_machines').safeParse(v).success;
    expect(m({ project: 'p', add: ['wrk_1'], preferred: ['wrk_1'] })).toBe(true);
    expect(m({ project: 'p', preferred: [] })).toBe(true);
    expect(m({ project: 'p', preferred: Array.from({ length: 17 }, (_, i) => `w${String(i)}`) })).toBe(false);
    expect(m({ project: 'p', add: [''] })).toBe(false);
  });

  it('no setup tool takes or names a secret field', () => {
    for (const t of ASSISTANT_PROJECT_SETUP_TOOLS) {
      const keys = Object.keys(ASSISTANT_TOOLS[t].input);
      expect(
        keys.filter((k) => /secret|token|password|key/i.test(k)),
        t,
      ).toEqual([]);
    }
  });
});
