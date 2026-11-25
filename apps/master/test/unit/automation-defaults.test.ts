import { describe, expect, it } from 'vitest';
import {
  adviceOf,
  applyJobDefaults,
  bestHostProfile,
  type ProjectFacts,
} from '../../src/composer/defaults.js';
import type { PlacementPreview } from '../../src/composer/preview.js';

/** p6-automation-defaults (docs/design/p6-automations.md §2a): automation job templates take the composer's defaults. */

const REPO = 'https://github.com/acme/app.git';
const ready = (profile: string, ...workers: string[]) => ({ profile, workers });

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  workspace: false,
  registeredRepositoryUrl: REPO,
  hostExecution: true,
  autoApproveExecution: false,
  sandbox: [ready('container', 'w1'), ready('host-restricted', 'w1'), ready('runtime-sandbox')],
  limits: {},
  ...over,
});

describe('bestHostProfile (the composer rule)', () => {
  it('container without the project opt-in, whatever the machines have ready', () => {
    expect(bestHostProfile(false, [ready('host-restricted', 'w1')])).toBe('container');
  });
  it('host-restricted, then runtime-sandbox, when some machine has it ready', () => {
    expect(bestHostProfile(true, [ready('host-restricted', 'w1'), ready('runtime-sandbox', 'w2')])).toBe(
      'host-restricted',
    );
    expect(bestHostProfile(true, [ready('host-restricted'), ready('runtime-sandbox', 'w2')])).toBe(
      'runtime-sandbox',
    );
    expect(bestHostProfile(true, [ready('host-restricted'), ready('unconfined', 'w1')])).toBe('container');
  });
});

describe('applyJobDefaults', () => {
  it('the project’s registered repository is trusted and gets the best ready host profile', () => {
    const out = applyJobDefaults(
      { runtime: 'codex', prompt: 'x', repository: { url: 'https://GitHub.com/acme/app', baseRef: 'main' } },
      facts(),
    );
    expect(out.spec).toMatchObject({
      sourceTrust: 'trusted',
      sandboxProfile: 'host-restricted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    });
    expect(out.filled).toEqual(['sourceTrust', 'sandboxProfile', 'approvalPolicy', 'limits']);
    expect(out.spec.model).toBeUndefined(); // the project's default model is resolved at submission
  });

  it('a workspace project is trusted; another repository stays untrusted in the container', () => {
    expect(applyJobDefaults({ runtime: 'codex' }, facts({ workspace: true })).spec).toMatchObject({
      sourceTrust: 'trusted',
      sandboxProfile: 'host-restricted',
    });
    const other = applyJobDefaults(
      { runtime: 'codex', repository: { url: 'https://github.com/someone/else.git' } },
      facts(),
    );
    expect(other.spec.sourceTrust).toBeUndefined();
    expect(other.spec.sandboxProfile).toBe('container');
  });

  it('keeps explicit choices and never picks unconfined', () => {
    const out = applyJobDefaults(
      {
        runtime: 'codex',
        sourceTrust: 'trusted',
        sandboxProfile: 'container',
        approvalPolicy: 'deny-sensitive',
        limits: { maxDurationSec: 120 },
      },
      facts({ sandbox: [ready('unconfined', 'w1')] }),
    );
    expect(out.spec).toMatchObject({
      sandboxProfile: 'container',
      approvalPolicy: 'deny-sensitive',
      limits: { maxDurationSec: 120 },
    });
    expect(out.filled).toEqual([]);
    expect(
      applyJobDefaults({ sourceTrust: 'trusted' }, facts({ sandbox: [ready('unconfined', 'w1')] })).spec,
    ).toMatchObject({ sandboxProfile: 'container' });
  });

  it('caps the duration at the project’s wall-time limit and adds its cost / token / turn limits', () => {
    const out = applyJobDefaults(
      { sourceTrust: 'trusted', limits: { maxTokens: 10 } },
      facts({ limits: { maxWallTimeSec: 900, maxCostUsd: 2, maxTokens: 5000, maxTurns: 40 } }),
    );
    expect(out.spec.limits).toEqual({ maxDurationSec: 900, maxCostUsd: 2, maxTokens: 10, maxTurns: 40 });
  });
});

describe('adviceOf (placement advice for drafts)', () => {
  const preview = (over: Partial<PlacementPreview>): PlacementPreview =>
    ({
      project: 'genel',
      sandboxProfile: 'container',
      issues: [],
      workers: [{ id: 'w1', name: 'Windows desktop' }],
      placement: {
        runtime: 'codex',
        verdict: 'placed',
        holds: [],
        candidates: [{ workerId: 'w1', score: 1, breakdown: {} }],
        rejected: [],
        summary: [],
      },
      ...over,
    }) as unknown as PlacementPreview;

  it('placed: the machines by name, no warning', () => {
    expect(adviceOf(preview({}))).toEqual({
      verdict: 'placed',
      machines: ['Windows desktop'],
      warning: null,
      note: null,
    });
  });

  it('infeasible: a warning with the permanent reasons (the prod case: container nowhere ready)', () => {
    const a = adviceOf(
      preview({
        placement: {
          runtime: 'codex',
          verdict: 'infeasible',
          holds: [],
          candidates: [],
          rejected: [],
          explanation: null,
          summary: [
            {
              code: 'sandbox_profile_unavailable',
              permanent: true,
              message: 'sandbox profile container is not ready',
              workers: ['w1'],
            },
          ],
        },
      }),
    );
    expect(a?.verdict).toBe('infeasible');
    expect(a?.warning).toContain('No machine can run this target (codex, container sandbox)');
    expect(a?.warning).toContain('sandbox profile container is not ready');
  });

  it('project rules that refuse the draft are warnings; busy / offline machines are a note', () => {
    expect(
      adviceOf(
        preview({ issues: [{ code: 'auto_approve_not_allowed', message: 'project does not allow it' }] }),
      )?.warning,
    ).toContain('project does not allow it');
    const waiting = adviceOf(
      preview({
        placement: {
          runtime: 'codex',
          verdict: 'waiting',
          holds: [],
          candidates: [],
          rejected: [],
          explanation: null,
          summary: [{ code: 'offline', permanent: false, message: 'w1 is offline', workers: ['w1'] }],
        },
      }),
    );
    expect(waiting).toMatchObject({ verdict: 'waiting', warning: null });
    expect(waiting?.note).toContain('w1 is offline');
    expect(adviceOf(preview({ placement: null }))).toBeNull();
  });
});
