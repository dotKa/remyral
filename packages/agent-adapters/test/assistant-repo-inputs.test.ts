import { ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p19-repo-job-inputs: rule 58 — chat attachments and earlier outputs reach REPOSITORY jobs too (the owner was told
 * "I cannot give the screenshots to the job because this is a repository project").
 */
describe('assistant rule for repository job inputs (p19-repo-job-inputs)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 58 says files can go to repository jobs and where they land', () => {
    const r = rule(58);
    expect(r).toContain('CAN be given to a job of a REPOSITORY project');
    expect(r).toContain('chatAttachments');
    expect(r).toContain('inputArtifacts');
    expect(r).toMatch(/never say "this is a repository project/);
    expect(r).toContain('scratch in/ folder next to the checkout');
    expect(r).toContain('never committed or pushed');
    expect(r).toContain('makine güncellenmeli');
    // Turkish spelling (rule 48): no circumflex.
    expect(r).not.toMatch(/[âîûÂÎÛ]/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toContain('58');
  });

  it('draft_job no longer limits the three input kinds to workspace projects', () => {
    const d = ASSISTANT_TOOLS.draft_job.description;
    expect(d).not.toContain('all three are only for workspace projects');
    expect(d).toContain('All three work for workspace AND repository projects');
    expect(d).toContain('repo-inputs-v1');
  });

  // p19-repo-inputs-composer-workflows: rule 58 extended (no new number) — run files of repository workflows.
  it('rule 58 also covers run files of repository workflows', () => {
    const r = rule(58);
    expect(r).toContain('WORKFLOW runs of repository projects');
    expect(r).toContain('draft_workflow_run continueFrom / inputArtifacts');
    expect(r).toMatch(/never refuse a repository workflow.s run files/);
  });

  it('draft_workflow_run takes run files for repository workflows (scratch in/ per AI step)', () => {
    const d = ASSISTANT_TOOLS.draft_workflow_run.description;
    expect(d).not.toContain('Workflows of workspace projects may take files');
    expect(d).toContain('workspace AND repository projects');
    expect(d).toContain('each AI step of a repository workflow');
    expect(d).toContain('repo-inputs-v1');
    expect(d).toContain('makine güncellenmeli');
  });
});
