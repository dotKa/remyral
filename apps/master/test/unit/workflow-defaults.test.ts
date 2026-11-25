import { describe, expect, it } from 'vitest';
import { applyWorkflowDefaults, type ProjectFacts } from '../../src/composer/defaults.js';
import { issueHint, workflowGuide } from '../../src/chat/workflow-guide.js';

/**
 * p16-workflow-quality §2: a drafted workflow's `defaults` take the project's defaults like a job — only what is left
 * out is filled; the best ready host profile where the project allows host execution, else container.
 */

const REPO = 'https://github.com/acme/app.git';
const ready = (profile: string, ...workers: string[]) => ({ profile, workers });
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  workspace: false,
  registeredRepositoryUrl: REPO,
  hostExecution: true,
  autoApproveExecution: false,
  sandbox: [ready('container', 'w1'), ready('host-restricted', 'w1')],
  limits: { maxWallTimeSec: 1800, maxCostUsd: 5 },
  runtimes: [{ runtime: 'codex', eligible: ['w1'], feasible: ['w1'] }],
  ...over,
});

describe('applyWorkflowDefaults (p16-workflow-quality)', () => {
  it('fills what is missing: trusted source, the best ready host profile, approval, capped limits, a runtime', () => {
    const { doc, filled } = applyWorkflowDefaults({ schemaVersion: 2, name: 'x', nodes: [] }, facts());
    expect(doc.defaults).toEqual({
      runtime: 'codex',
      sourceTrust: 'trusted',
      sandboxProfile: 'host-restricted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 1800, maxCostUsd: 5 },
    });
    expect(filled.sort()).toEqual(['approvalPolicy', 'limits', 'runtime', 'sandboxProfile', 'sourceTrust']);
  });

  it('keeps explicit values; a foreign repository stays untrusted (container)', () => {
    const own = applyWorkflowDefaults(
      { name: 'x', defaults: { runtime: 'claude-code', sandboxProfile: 'container' } },
      facts(),
    );
    expect(own.doc.defaults).toMatchObject({ runtime: 'claude-code', sandboxProfile: 'container' });
    expect(own.filled).not.toContain('runtime');
    const foreign = applyWorkflowDefaults(
      { name: 'x', defaults: { repository: { url: 'https://github.com/evil/fork.git', baseRef: 'main' } } },
      facts(),
    );
    expect(foreign.doc.defaults).toMatchObject({ sandboxProfile: 'container' });
    expect((foreign.doc.defaults as { sourceTrust?: string }).sourceTrust).toBeUndefined();
  });

  it('without host execution: container; without fleet facts: claude-code as the schema’s runtime', () => {
    const { doc } = applyWorkflowDefaults(
      { name: 'x' },
      facts({ hostExecution: false, runtimes: undefined, limits: {} }),
    );
    expect(doc.defaults).toMatchObject({
      runtime: 'claude-code',
      sandboxProfile: 'container',
      limits: { maxDurationSec: 3600 },
    });
  });
});

describe('workflow guide hints', () => {
  it('maps common issue codes to fixes', () => {
    expect(issueHint('defaults', 'invalid_type')).toContain('Leave "defaults" out');
    expect(issueHint('nodes.0.config.timezone', 'unknown_timezone')).toContain('IANA');
    expect(issueHint('edges.1.toPort', 'single_input')).toContain('control.merge');
    expect(issueHint('nodes.3.type', 'invalid_value')).toContain('workflow_node_catalog');
    expect(issueHint('nodes.0.prompt', 'too_big')).toBeNull();
    expect(Object.keys(workflowGuide('repository'))).toEqual(['rules', 'repository']);
  });
});
