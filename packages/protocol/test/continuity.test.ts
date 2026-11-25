import { describe, expect, it } from 'vitest';
import {
  AssignedResume,
  AssignJob,
  CheckpointReport,
  classifyToolCall,
  ContinuityPolicy,
  defaultContinuityPolicy,
  Heartbeat,
  isApprovalResume,
  isWorkerRestartResume,
  needsVerification,
  restartSummary,
  shellCommandOf,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { envelope, jobId, masterMessages, workerId, workerMessages } from './fixtures.js';

/** p11-session-continuity: tool classes, the checkpoint / restart messages and the restart resume. */

describe('classifyToolCall', () => {
  it.each([
    ['Read', '{"file_path":"a"}', 'idempotent'],
    ['Grep', '{"pattern":"x"}', 'idempotent'],
    ['list', '{}', 'idempotent'],
    ['WebFetch', '{"url":"https://x"}', 'idempotent'],
    ['Edit', '{"file_path":"a"}', 'workspace_write'],
    ['apply_patch', 'a.ts, b.ts', 'workspace_write'],
    ['Bash', '{"command":"git status && git diff"}', 'idempotent'],
    ['Bash', '{"command":"ls -la | wc -l"}', 'idempotent'],
    ['Bash', '{"command":"cat a > b"}', 'unknown'],
    ['Bash', '{"command":"git push origin feature"}', 'external'],
    ['shell', 'git -c x=y push --force', 'external'],
    ['Bash', '{"command":"npm publish"}', 'external'],
    ['Bash', '{"command":"pnpm install"}', 'external'],
    ['Bash', '{"command":"pip install requests"}', 'external'],
    ['Bash', '{"command":"curl -X POST https://api"}', 'external'],
    ['Bash', '{"command":"curl https://example.com"}', 'unknown'],
    ['Bash', '{"command":"gh pr create --fill"}', 'external'],
    ['Bash', '{"command":"vercel deploy --prod"}', 'external'],
    ['Bash', '{"command":"pnpm test"}', 'unknown'],
    ['PowerShell', '{"command":"Get-ChildItem"}', 'idempotent'],
    ['request_subtask', '{}', 'external'],
    ['publish_site', '{}', 'external'],
    ['mcp:remyral/wait_subtask', '{}', 'idempotent'],
    ['mcp:github/create_issue', '{}', 'external'],
    ['mcp__remyral__get_status', '{}', 'idempotent'],
    ['SomethingNew', '{}', 'unknown'],
  ])('%s %s → %s', (tool, input, want) => {
    expect(classifyToolCall(tool, input)).toBe(want);
  });

  it('only idempotent and workspace writes are safe to redo', () => {
    expect(needsVerification('external')).toBe(true);
    expect(needsVerification('unknown')).toBe(true);
    expect(needsVerification('workspace_write')).toBe(false);
    expect(needsVerification('idempotent')).toBe(false);
  });

  it('extracts the command of a JSON input summary', () => {
    expect(shellCommandOf('{"command":"echo \\"hi\\"","description":"x"}')).toBe('echo "hi"');
    expect(shellCommandOf('{"command":["git","push"]}')).toBe('git push');
    expect(shellCommandOf('git push')).toBe('git push');
  });
});

describe('continuity messages', () => {
  const att = 'att_01';

  it('policy bounds and defaults', () => {
    expect(ContinuityPolicy.parse(defaultContinuityPolicy())).toEqual(defaultContinuityPolicy());
    expect(ContinuityPolicy.safeParse({ ...defaultContinuityPolicy(), intervalSec: 5 }).success).toBe(false);
    expect(ContinuityPolicy.safeParse({ ...defaultContinuityPolicy(), maxRestarts: 9 }).success).toBe(false);
  });

  it('CHECKPOINT_REPORT is a control job message with a hidden ref only', () => {
    const msg = envelope('CHECKPOINT_REPORT', {
      workerId,
      jobId,
      seq: 0,
      payload: {
        attemptId: att,
        epoch: 1,
        n: 3,
        at: '2026-10-19T10:00:00.000Z',
        kind: 'git',
        ref: 'refs/remana/checkpoints/att_01/3',
        commit: 'a'.repeat(40),
        files: 2,
        bytes: 10,
        lastTool: { callId: 'c1', toolName: 'Edit', class: 'workspace_write', state: 'done' },
        inFlight: 0,
        activeMs: 1000,
      },
    });
    expect(CheckpointReport.safeParse(msg).success).toBe(true);
    expect(WorkerToMaster.safeParse(msg).success).toBe(true);
    const bad = { ...msg, payload: { ...msg.payload, ref: 'refs/heads/rac/x' } };
    expect(CheckpointReport.safeParse(bad).success).toBe(false);
  });

  it('HEARTBEAT recoverableJobs is optional (older workers) and bounded', () => {
    expect(Heartbeat.safeParse(workerMessages.HEARTBEAT).success).toBe(true);
    const hb = workerMessages.HEARTBEAT as { payload: Record<string, unknown> };
    const entry = {
      jobId,
      attemptId: att,
      epoch: 2,
      checkpoint: 4,
      checkpointAt: '2026-10-19T10:00:00.000Z',
      activeMs: 5,
      resume: 'continuation',
      restarts: 0,
      unknownOutcome: [{ toolName: 'Bash', class: 'external', state: 'running' }],
    };
    expect(Heartbeat.safeParse({ ...hb, payload: { ...hb.payload, recoverableJobs: [entry] } }).success).toBe(
      true,
    );
    expect(
      Heartbeat.safeParse({
        ...hb,
        payload: { ...hb.payload, recoverableJobs: [{ ...entry, problem: 'x'.repeat(501) }] },
      }).success,
    ).toBe(false);
  });

  it('the worker_restart resume is a third AssignedResume variant', () => {
    const r = AssignedResume.parse({
      cause: 'worker_restart',
      pausedEpoch: 1,
      checkpoint: 2,
      activeMs: 0,
      restart: 1,
    });
    expect(isWorkerRestartResume(r)).toBe(true);
    expect(isApprovalResume(r)).toBe(false);
    expect(
      AssignedResume.safeParse({ cause: 'worker_restart', pausedEpoch: 1, checkpoint: 2, activeMs: 0 })
        .success,
    ).toBe(false);
    const base = masterMessages.ASSIGN_JOB as { payload: Record<string, unknown> };
    const assign = AssignJob.safeParse({
      ...base,
      payload: {
        ...base.payload,
        execution: {
          hostExecutionOptIn: true,
          continuity: defaultContinuityPolicy(),
          resume: { cause: 'worker_restart', pausedEpoch: 1, checkpoint: 0, activeMs: 0, restart: 1 },
        },
      },
    });
    expect(assign.success, assign.error?.message).toBe(true);
  });

  it('feature and summary', () => {
    expect(WorkerFeature.options).toContain('session-continuity-v1');
    const now = new Date('2026-10-19T10:02:00.000Z');
    expect(restartSummary(7, '2026-10-19T10:00:00.000Z', now)).toBe(
      'Worker restarted — resuming from checkpoint 7 (2 min ago)',
    );
    expect(restartSummary(0, null, now)).toBe(
      'Worker restarted — resuming from the kept workspace (no checkpoint yet)',
    );
  });
});
