import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOLS,
  assistantToolInput,
  JobSpec,
  REPO_SCRATCH_FEATURE,
  WorkerFeature,
  WorkspaceJobSpec,
} from '../src/index.js';

/**
 * p16-workflow-quality: repository-less workflow steps of repository projects (`workspace.scratch`, feature
 * `repo-scratch-v1`) and the workflow drafting tools (validate_workflow, workflow_guide, activate / dryRun).
 */
describe('p16-workflow-quality protocol', () => {
  const base = {
    projectId: 'acme',
    runtime: 'codex',
    prompt: 'write one line',
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
  };

  it('a scratch step is a workspace spec with scratch: true (exactly one of repository / workspace)', () => {
    expect(WorkerFeature.safeParse(REPO_SCRATCH_FEATURE).success).toBe(true);
    expect(JobSpec.safeParse({ ...base, workspace: { egress: 'web', scratch: true } }).success).toBe(true);
    expect(WorkspaceJobSpec.safeParse({ egress: 'web', scratch: false }).success).toBe(false);
    expect(
      JobSpec.safeParse({
        ...base,
        workspace: { egress: 'web', scratch: true },
        repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'wf/x' },
      }).success,
    ).toBe(false);
    // An older parser (non-strict object) strips the flag: the worker sees a plain workspace job and refuses it.
    expect(WorkspaceJobSpec.parse({ egress: 'web', scratch: true }).scratch).toBe(true);
  });

  it('validate_workflow / workflow_guide are read tools; draft_workflow takes activate and dryRun', () => {
    expect(ASSISTANT_TOOLS.validate_workflow.kind).toBe('read');
    expect(ASSISTANT_TOOLS.workflow_guide.kind).toBe('read');
    const def = { schemaVersion: 2, name: 'x', nodes: [{ id: 'a', type: 'trigger.manual' }], edges: [] };
    expect(assistantToolInput('validate_workflow').safeParse({ project: 'p', definition: def }).success).toBe(
      true,
    );
    expect(
      assistantToolInput('draft_workflow').safeParse({
        project: 'p',
        definition: def,
        activate: false,
        dryRun: true,
      }).success,
    ).toBe(true);
    expect(assistantToolInput('workflow_guide').safeParse({}).success).toBe(true);
  });
});
