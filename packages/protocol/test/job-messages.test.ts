import { describe, expect, it } from 'vitest';
import {
  JOB_MESSAGE_STATUSES,
  JobMessagePayload,
  JobMessageStatusPayload,
  WorkerFeature,
  WorkerToMaster,
  isSequencedWorkerType,
  jobMessageAdvances,
  jobMessageFinal,
} from '../src/index.js';
import { workerMessages } from './fixtures.js';

describe('p15-message-delivery protocol', () => {
  it('JOB_MESSAGE_STATUS is a control job message from receipts workers', () => {
    expect(WorkerToMaster.safeParse(workerMessages.JOB_MESSAGE_STATUS).success).toBe(true);
    expect(isSequencedWorkerType('JOB_MESSAGE_STATUS')).toBe(false);
    expect(WorkerFeature.safeParse('job-message-receipts-v1').success).toBe(true);
  });

  it('bounds the status payload (no unknown status, short code, ≤ 500 chars of detail)', () => {
    const base = { attemptId: 'att_1', epoch: 1, messageId: '00000000-0000-4000-8000-000000000001' };
    expect(JobMessageStatusPayload.safeParse({ ...base, status: 'read' }).success).toBe(true);
    expect(JobMessageStatusPayload.safeParse({ ...base, status: 'waiting' }).success).toBe(false);
    expect(JobMessageStatusPayload.safeParse({ ...base, status: 'failed', code: 'Bad Code' }).success).toBe(
      false,
    );
    expect(
      JobMessageStatusPayload.safeParse({ ...base, status: 'failed', code: 'x', detail: 'd'.repeat(501) })
        .success,
    ).toBe(false);
  });

  it('JOB_MESSAGE `receipts` is optional (older masters never send it)', () => {
    const p = {
      attemptId: 'att_1',
      epoch: 1,
      messageId: '00000000-0000-4000-8000-000000000001',
      text: 'hi',
      sentBy: 'u1',
    };
    expect(JobMessagePayload.parse(p).receipts).toBeUndefined();
    expect(JobMessagePayload.parse({ ...p, receipts: true }).receipts).toBe(true);
  });

  it('statuses only move forward; read and failed are final', () => {
    expect(JOB_MESSAGE_STATUSES).toEqual(['waiting', 'sent', 'received', 'delivered', 'read', 'failed']);
    expect(jobMessageAdvances('sent', 'received')).toBe(true);
    expect(jobMessageAdvances('delivered', 'received')).toBe(false);
    expect(jobMessageAdvances('delivered', 'failed')).toBe(true);
    expect(jobMessageAdvances('read', 'failed')).toBe(false);
    expect(jobMessageAdvances('failed', 'read')).toBe(false);
    expect(jobMessageAdvances('sent', 'read')).toBe(true);
    expect(jobMessageFinal('read')).toBe(true);
    expect(jobMessageFinal('delivered')).toBe(false);
  });
});
