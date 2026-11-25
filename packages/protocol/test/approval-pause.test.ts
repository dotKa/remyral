import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PAUSE_DEFAULTS,
  APPROVAL_PAUSE_FEATURE,
  APPROVAL_PAUSE_LIMITS,
  approvalWaitMs,
  ApprovalWait,
  AssignedResume,
  isSequencedMasterType,
  JobPausedReport,
  MasterToWorker,
  PauseJobPayload,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

describe('p10-approval-pause protocol', () => {
  it('knows the feature and PAUSE_JOB is a sequenced (durable) master message', () => {
    expect(WorkerFeature.safeParse(APPROVAL_PAUSE_FEATURE).success).toBe(true);
    expect(isSequencedMasterType('PAUSE_JOB')).toBe(true);
    expect(MasterToWorker.safeParse(masterMessages.PAUSE_JOB).success).toBe(true);
    expect(WorkerToMaster.safeParse(masterMessages.PAUSE_JOB).success).toBe(false);
  });

  it('PAUSE_JOB is fenced by attempt + epoch and names the approval', () => {
    const p = masterMessages.PAUSE_JOB.payload as Record<string, unknown>;
    for (const field of ['attemptId', 'epoch', 'approvalId', 'retainUntil']) {
      const rest = Object.fromEntries(Object.entries(p).filter(([k]) => k !== field));
      expect(PauseJobPayload.safeParse(rest).success, field).toBe(false);
    }
    expect(PauseJobPayload.safeParse({ ...p, epoch: -1 }).success).toBe(false);
  });

  it('JOB_RESULT may carry what a paused run kept (additive)', () => {
    const base = structuredClone(workerMessages.JOB_RESULT) as { payload: Record<string, unknown> };
    expect(WorkerToMaster.safeParse(base).success).toBe(true);
    base.payload.outcome = 'cancelled';
    base.payload.paused = {
      approvalId: 'appr-1',
      resume: 'session',
      activeMs: 1234,
      runtimeSessionId: 'sess-1',
    };
    expect(WorkerToMaster.safeParse(base).success).toBe(true);
    expect(
      JobPausedReport.safeParse({ approvalId: 'appr-1', resume: 'later', activeMs: 1 }).success,
      'unknown resume mode',
    ).toBe(false);
    expect(JobPausedReport.safeParse({ approvalId: 'appr-1', resume: 'session', activeMs: -1 }).success).toBe(
      false,
    );
    expect(
      JobPausedReport.safeParse({ approvalId: 'a', resume: 'session', activeMs: 1, runtimeSessionId: '../x' })
        .success,
    ).toBe(false);
  });

  it('ASSIGN_JOB execution carries approvalWait and resume', () => {
    const msg = structuredClone(masterMessages.ASSIGN_JOB) as {
      payload: { execution?: Record<string, unknown> };
    };
    msg.payload.execution = {
      hostExecutionOptIn: false,
      approvalWait: { staleAfterSec: 900, pauseAfterSec: 3600 },
      resume: {
        pausedEpoch: 2,
        approvalId: 'appr-1',
        action: 'runtime.dangerous_tool',
        summary: 'Bash: npm publish',
        decision: { decision: 'approve', decidedBy: 'owner' },
        activeMs: 60_000,
      },
    };
    expect(MasterToWorker.safeParse(msg).success).toBe(true);
    const bad = structuredClone(msg);
    (bad.payload.execution as { resume: { decision: { decision: string } } }).resume.decision.decision =
      'maybe';
    expect(MasterToWorker.safeParse(bad).success).toBe(false);
  });

  it('bounds the settings and derives the runtime backstop from the pause time', () => {
    expect(ApprovalWait.safeParse({ staleAfterSec: 59, pauseAfterSec: 3600 }).success).toBe(false);
    expect(ApprovalWait.safeParse({ staleAfterSec: 900, pauseAfterSec: 100 }).success).toBe(false);
    expect(
      ApprovalWait.safeParse({
        staleAfterSec: APPROVAL_PAUSE_DEFAULTS.staleAfterSec,
        pauseAfterSec: APPROVAL_PAUSE_DEFAULTS.pauseAfterSec,
      }).success,
    ).toBe(true);
    expect(approvalWaitMs({ staleAfterSec: 900, pauseAfterSec: 3600 })).toBe((3600 + 900) * 1000);
    expect(APPROVAL_PAUSE_DEFAULTS.retentionSec).toBeLessThanOrEqual(APPROVAL_PAUSE_LIMITS.maxRetentionSec);
    expect(
      AssignedResume.safeParse({
        pausedEpoch: 1,
        approvalId: 'a',
        action: 'x',
        summary: 's'.repeat(2001),
        decision: { decision: 'deny', decidedBy: 'u', reason: 'no' },
        activeMs: 0,
      }).success,
    ).toBe(false);
  });
});
