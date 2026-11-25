import { describe, expect, it } from 'vitest';
import type { ChatDraft } from '../src/api/chat';
import { parseRun } from '../src/api/automations';
import { identicalText, parseReuseCheck, sha256OfBase64 } from '../src/api/reuse';
import { parseRun as parseWorkflowRun } from '../src/api/workflows';
import { identicalOf, summarizeDraft } from '../src/screens/chat/drafts';
import { reusePolicy } from '../src/screens/automations/form';

/**
 * p6-result-reuse: the reuse check's parsing and wording, the chat card's "identical result" line, the automation
 * form's opt-in policy and the run / workflow-step links. The composer flow is in composer.test.tsx.
 */

const JOB = '33333333-3333-4333-8333-333333333333';

describe('reuse check API', () => {
  it('parses a match and no match', () => {
    const m = parseReuseCheck({
      match: {
        jobId: JOB,
        finishedAt: '2026-10-16T08:00:00.000Z',
        age: '2 h ago',
        runtime: 'codex',
        modelProfile: null,
        baseCommit: 'a'.repeat(40),
      },
      reason: null,
      windowHours: 72,
    });
    expect(m.match).toMatchObject({ jobId: JOB, age: '2 h ago', baseCommit: 'a'.repeat(40) });
    expect(parseReuseCheck({ match: null, reason: 'untrusted_source' })).toEqual({
      match: null,
      reason: 'untrusted_source',
    });
  });

  it('says what "identical" meant', () => {
    expect(
      identicalText({
        jobId: JOB,
        finishedAt: '',
        age: '',
        runtime: 'codex',
        modelProfile: 'fast',
        baseCommit: 'abcdef0123456789',
      }),
    ).toBe(
      'Same project, runtime codex, model fast, prompt, base commit abcdef012345. Open its result, or run this job anyway.',
    );
    expect(
      identicalText({
        jobId: JOB,
        finishedAt: '',
        age: '',
        runtime: 'pi',
        modelProfile: null,
        baseCommit: null,
      }),
    ).toContain('runtime pi, prompt, input files');
  });

  it('hashes a file body like the master (hex sha256 of the bytes)', async () => {
    expect(await sha256OfBase64(btoa('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('chat job draft', () => {
  function draft(payload: Record<string, unknown>): ChatDraft {
    return {
      id: '00000000-0000-4000-8000-0000000000d1',
      threadId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'job',
      title: 'Lint',
      payload: {
        project: 'acme',
        spec: { runtime: 'codex', prompt: 'Bump the lint rules', sandboxProfile: 'container' },
        ...payload,
      },
      project: 'acme',
      state: 'proposed',
      result: null,
      createdAt: '2026-10-16T10:00:00.000Z',
      expiresAt: '2026-10-17T10:00:00.000Z',
      decidedAt: null,
    };
  }

  it('states an identical recent success from the master’s check (ids only, text only)', () => {
    expect(
      summarizeDraft(draft({ reuse: { jobId: JOB, age: '5 min ago', finishedAt: 'x' } })).identical,
    ).toEqual({
      jobId: JOB,
      age: '5 min ago',
    });
    expect(summarizeDraft(draft({})).identical).toBeUndefined();
    // Anything that is not a job id is ignored (never turned into a link).
    expect(identicalOf({ reuse: { jobId: '../admin', age: 'x' } })).toBeNull();
  });
});

describe('automation policy and links', () => {
  it('sends the reuse policy only for job targets that switched it on', () => {
    expect(reusePolicy({ target: 'job', reuseOn: true, reuseHours: '12' })).toBe(12);
    expect(reusePolicy({ target: 'job', reuseOn: false, reuseHours: '12' })).toBeNull();
    expect(reusePolicy({ target: 'workflow', reuseOn: true, reuseHours: '12' })).toBeNull();
  });

  it('reads the skipped run’s identical job, and null from older masters', () => {
    const base = {
      id: 'r1',
      automationId: 'a1',
      project: 'acme',
      triggerKind: 'cron',
      state: 'skipped',
      reason: 'Skipped: an identical job succeeded 2 h ago',
      sourceTrust: 'trusted',
      eventSummary: null,
      jobId: null,
      jobState: null,
      workflowRunId: null,
      scheduledFor: null,
      chainParentRunId: null,
      chainDepth: 0,
      triggeredBy: null,
      createdAt: '2026-10-16T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      waitingApproval: null,
    };
    expect(parseRun({ ...base, reusedJobId: JOB }).reusedJobId).toBe(JOB);
    expect(parseRun(base).reusedJobId).toBeNull();
  });

  it('reads a workflow step’s reused job', () => {
    const run = parseWorkflowRun({
      run: {
        id: 'w1',
        definitionId: 'd1',
        project: 'acme',
        name: 'docs',
        version: 1,
        state: 'succeeded',
        inputs: {},
        repository: null,
        files: [],
        createdBy: 'u',
        createdAt: '2026-10-16T10:00:00.000Z',
        endedAt: null,
        reason: null,
      },
      nodes: [
        {
          id: 'docs',
          role: 'executor',
          state: 'succeeded',
          parent: null,
          jobId: JOB,
          jobState: 'SUCCEEDED',
          workerId: null,
          attempts: 1,
          reason: null,
          reusedJobId: JOB,
          outputs: null,
          gate: null,
        },
      ],
      edges: [],
      mergeRequests: [],
    });
    expect(run.nodes[0]?.reusedJobId).toBe(JOB);
  });
});
