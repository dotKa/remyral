import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_PROJECTS_FEATURE,
  ASSISTANT_PROJECTS_TOOLS,
  ASSISTANT_TOOLS,
  assistantToolDescription,
  assistantToolInput,
  MAX_THREAD_PROJECTS,
  PLAN_LINK_KINDS,
  PlanLink,
  WorkerFeature,
} from '../src/index.js';

/** p18-multi-project W3 + W5 (docs/design/p18-multi-project.md, worker 1.2.1): the working-project tools. */
describe('assistant working projects (p18-multi-project)', () => {
  const U = '7d0e2f1a-3b4c-4d5e-8f60-718293a4b5c6';
  const ok = (t: Parameters<typeof assistantToolInput>[0], v: unknown) =>
    assistantToolInput(t).safeParse(v).success;

  it('the tools are drafts in the catalog; the feature is a worker feature', () => {
    expect(WorkerFeature.options).toContain(ASSISTANT_PROJECTS_FEATURE);
    expect([...ASSISTANT_PROJECTS_TOOLS].sort()).toEqual([
      'attach_workflow',
      'draft_job_batch',
      'set_thread_projects',
    ]);
    for (const t of ASSISTANT_PROJECTS_TOOLS) {
      expect(ASSISTANT_TOOLS[t].kind, t).toBe('draft');
      expect(assistantToolDescription(t)).toContain('Acting:');
    }
    expect(MAX_THREAD_PROJECTS).toBe(8);
  });

  it('set_thread_projects: the whole set, at most 8, strict entries', () => {
    expect(ok('set_thread_projects', { projects: [] })).toBe(true);
    expect(
      ok('set_thread_projects', { projects: [{ project: 'alpha' }, { project: 'beta', share: false }] }),
    ).toBe(true);
    expect(
      ok('set_thread_projects', {
        projects: Array.from({ length: 9 }, (_, i) => ({ project: `p${String(i)}` })),
      }),
    ).toBe(false);
    expect(ok('set_thread_projects', { projects: [{ project: 'bad id!' }] })).toBe(false);
    expect(ok('set_thread_projects', { projects: [{ project: 'alpha', role: 'owner' }] })).toBe(false);
  });

  it('attach_workflow: a target project and a workflow id; follow auto | pin', () => {
    expect(ok('attach_workflow', { project: 'beta', workflowId: U })).toBe(true);
    expect(ok('attach_workflow', { project: 'beta', workflowId: U, follow: 'pin' })).toBe(true);
    expect(ok('attach_workflow', { project: 'beta', workflowId: U, follow: 'always' })).toBe(false);
    expect(ok('attach_workflow', { workflowId: U })).toBe(false);
  });

  it('draft_job_batch: 2–8 projects, per-project additions, never a secret field', () => {
    const base = { title: 'Bağımlılıkları güncelle', prompt: 'Update {{project.name}}', runtime: 'codex' };
    expect(ok('draft_job_batch', { ...base, projects: ['a', 'b'] })).toBe(true);
    expect(ok('draft_job_batch', { ...base, projects: ['a'] })).toBe(false);
    expect(
      ok('draft_job_batch', { ...base, projects: Array.from({ length: 9 }, (_, i) => `p${String(i)}`) }),
    ).toBe(false);
    expect(
      ok('draft_job_batch', {
        ...base,
        projects: ['a', 'b'],
        perProject: { a: { prompt: 'also docs', baseRef: 'dev' } },
      }),
    ).toBe(true);
    expect(ok('draft_job_batch', { ...base, projects: ['a', 'b'], perProject: { a: { token: 'x' } } })).toBe(
      false,
    );
    const keys = Object.keys(ASSISTANT_TOOLS.draft_job_batch.input).join(' ');
    expect(keys).not.toMatch(/secret|token|password|credential/i);
  });

  it('draft_workflow_run takes the run project; list_workflows takes offers', () => {
    expect(ok('draft_workflow_run', { workflowId: U, project: 'beta' })).toBe(true);
    expect(ok('draft_workflow_run', { workflowId: U })).toBe(true);
    expect(ok('list_workflows', { offers: true })).toBe(true);
  });

  it('p18-multi-project W4: draft_automation takes the projects of a group (2–8)', () => {
    const base = {
      name: 'Nightly',
      trigger: { kind: 'cron', cron: '0 3 * * *' },
      prompt: 'Run it',
      runtime: 'codex',
    };
    expect(ok('draft_automation', { ...base, projects: ['a', 'b'] })).toBe(true);
    expect(ok('draft_automation', { ...base, projects: ['a'] })).toBe(false);
    expect(
      ok('draft_automation', { ...base, projects: Array.from({ length: 9 }, (_, i) => `p${String(i)}`) }),
    ).toBe(false);
    expect(ASSISTANT_TOOLS.draft_automation.description).toContain('projects (2–8');
  });

  it('plan items link to a batch', () => {
    expect(PLAN_LINK_KINDS).toContain('batch');
    expect(PlanLink.safeParse({ kind: 'batch', id: U }).success).toBe(true);
  });
});
