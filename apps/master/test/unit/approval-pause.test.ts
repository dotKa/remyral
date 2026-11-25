import { APPROVAL_PAUSE_DEFAULTS, SUBTASK_PAUSED_FOR_APPROVAL } from '@remyral/protocol';
import type { JobState } from '@remyral/scheduler';
import { describe, expect, it } from 'vitest';
import { ApprovalPauseOutboxPayload } from '../../src/approvals/pause.js';
import { ApprovalPauseSettingsInput } from '../../src/approvals/pause-settings.js';
import { approvalFingerprint, staleness } from '../../src/approvals/service.js';
import { KIND_INFO, NOTIFICATION_KINDS } from '../../src/notifications/model.js';
import { subtaskStateOf } from '../../src/subtasks/service.js';

/** p10-approval-pause (docs/design/p10-approval-pause.md): pure pieces of the master side. */

const attempt = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-18T12:00:00Z');

function job(state: JobState, over: Partial<Parameters<typeof staleness>[1]> = {}) {
  return {
    state,
    current_attempt_id: attempt,
    lease_epoch: 2,
    lease_epoch_active: null,
    lease_expires_at: null,
    lease_worker: null,
    ...over,
  };
}

describe('approval fingerprint (a decision binds to the exact action)', () => {
  it('is stable and changes with any of action, requested action or summary', () => {
    const base = approvalFingerprint('runtime.dangerous_tool', 'Bash', 'npm publish');
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(approvalFingerprint('runtime.dangerous_tool', 'Bash', 'npm publish')).toBe(base);
    expect(approvalFingerprint('runtime.dangerous_tool', 'Bash', 'npm publish --force')).not.toBe(base);
    expect(approvalFingerprint('runtime.dangerous_tool', 'PowerShell', 'npm publish')).not.toBe(base);
    expect(approvalFingerprint('secret.read', 'Bash', 'npm publish')).not.toBe(base);
    // No ambiguity across the separators.
    expect(approvalFingerprint('a', 'b\nc', 'd')).not.toBe(approvalFingerprint('a', 'b', 'c\nd'));
  });
});

describe('staleness of a paused request', () => {
  const paused = {
    kind: 'in_run' as const,
    attempt_id: attempt,
    epoch: 2,
    worker_id: 'wrk_1',
    pause_requested_at: now,
  };

  it('still applies while the job is pausing or paused, without a lease', () => {
    for (const s of ['RUNNING', 'STARTING', 'VERIFYING', 'PAUSED'] as const) {
      expect(staleness(paused, job(s), now), s).toBeNull();
    }
  });

  it('no longer applies once the job moved on, the attempt changed or a new epoch was issued', () => {
    for (const s of ['QUEUED', 'RESERVED', 'CANCELLED', 'FAILED', 'SUCCEEDED', 'LOST'] as const) {
      expect(staleness(paused, job(s), now), s).toBe('job_state_changed');
    }
    expect(staleness(paused, job('PAUSED', { current_attempt_id: 'other' }), now)).toBe('attempt_changed');
    expect(staleness(paused, job('PAUSED', { lease_epoch: 3 }), now)).toBe('epoch_superseded');
  });

  it('an ordinary in-run request of a paused job is stale (the runtime that asked is stopped)', () => {
    const plain = { ...paused, pause_requested_at: null };
    expect(staleness(plain, job('PAUSED'), now)).toBe('job_state_changed');
  });
});

describe('project settings', () => {
  it('accepts the defaults and enforces bounds and order', () => {
    expect(ApprovalPauseSettingsInput.safeParse({ ...APPROVAL_PAUSE_DEFAULTS }).success).toBe(true);
    expect(
      ApprovalPauseSettingsInput.safeParse({ staleAfterSec: 3600, pauseAfterSec: 3600, retentionSec: 3600 })
        .success,
    ).toBe(false);
    expect(
      ApprovalPauseSettingsInput.safeParse({ staleAfterSec: 30, pauseAfterSec: 3600, retentionSec: 3600 })
        .success,
    ).toBe(false);
    expect(
      ApprovalPauseSettingsInput.safeParse({ staleAfterSec: 60, pauseAfterSec: 120, retentionSec: 8 * 86400 })
        .success,
    ).toBe(false);
    expect(
      ApprovalPauseSettingsInput.safeParse({
        staleAfterSec: 60,
        pauseAfterSec: 120,
        retentionSec: 3600,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('sub-jobs and notifications', () => {
  it('a paused child counts as running for its parent', () => {
    expect(subtaskStateOf('PAUSED')).toBe('running');
    expect(SUBTASK_PAUSED_FOR_APPROVAL).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('knows the two notification kinds and the outbox payload', () => {
    expect(NOTIFICATION_KINDS).toEqual(expect.arrayContaining(['approval.stale', 'job.paused']));
    expect(KIND_INFO['approval.stale'].label).toBeTruthy();
    expect(KIND_INFO['job.paused'].label).toBeTruthy();
    const ok = {
      event: 'paused',
      jobId: '00000000-0000-4000-8000-000000000002',
      requestId: '00000000-0000-4000-8000-000000000003',
    };
    expect(ApprovalPauseOutboxPayload.safeParse(ok).success).toBe(true);
    expect(ApprovalPauseOutboxPayload.safeParse({ ...ok, event: 'resumed' }).success).toBe(false);
    expect(ApprovalPauseOutboxPayload.safeParse({ ...ok, summary: 'x' }).success).toBe(false);
  });
});
