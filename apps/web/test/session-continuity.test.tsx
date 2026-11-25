import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseContinuity } from '../src/api/continuity';

/**
 * p11-session-continuity (ADR-0042): the job page's "Session continuity" card (resume history after worker restarts,
 * unknown-outcome tool calls, checkpoints) and the pause panel of a job kept after a worker restart.
 */

configure({ asyncUtilTimeout: 5_000 });

const body = {
  checkpoints: [
    {
      n: 7,
      epoch: 1,
      takenAt: '2026-10-19T10:00:00.000Z',
      kind: 'git',
      ref: `refs/remana/checkpoints/a/7`,
      commit: 'a'.repeat(40),
      files: 3,
      bytes: 2048,
      lastTool: { toolName: 'Edit', class: 'workspace_write', state: 'done' },
      inFlight: 1,
    },
  ],
  restarts: [
    {
      pauseId: 'p1',
      status: 'resumed',
      detectedAt: '2026-10-19T10:02:00.000Z',
      pausedEpoch: 1,
      resumedEpoch: 2,
      checkpoint: 7,
      checkpointAt: '2026-10-19T10:00:00.000Z',
      restarts: 0,
      resume: 'continuation',
      unknownOutcome: [{ toolName: '<b>Bash</b>', class: 'external', state: 'running' }],
      blockedReason: null,
      endedAt: '2026-10-19T10:02:01.000Z',
      endReason: 'resumed',
      summary: 'Worker restarted — resuming from checkpoint 7 (2 min ago)',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('p11-session-continuity: job page', () => {
  it('parses the continuity view', () => {
    const v = parseContinuity(body);
    expect(v.checkpoints[0]).toMatchObject({ n: 7, kind: 'git', files: 3, inFlight: 1 });
    expect(v.restarts[0]).toMatchObject({ checkpoint: 7, resumedEpoch: 2, resume: 'continuation' });
    expect(() => parseContinuity({ checkpoints: 'x', restarts: [] })).toThrow();
  });
});
