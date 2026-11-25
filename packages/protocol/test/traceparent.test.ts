import { describe, expect, it } from 'vitest';
import { MasterToWorker, Traceparent, WorkerToMaster } from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('p16-observability: W3C traceparent on the envelope', () => {
  it('is optional on every message and kept when valid', () => {
    const assign = masterMessages.ASSIGN_JOB;
    const ack = workerMessages.LEASE_ACK;
    expect(MasterToWorker.parse(assign)).not.toHaveProperty('traceparent');
    expect(MasterToWorker.parse({ ...assign, traceparent: TP }).traceparent).toBe(TP);
    expect(WorkerToMaster.parse({ ...ack, traceparent: TP }).traceparent).toBe(TP);
  });

  it('refuses a malformed value (no free text rides on the envelope)', () => {
    expect(Traceparent.safeParse('00-xyz').success).toBe(false);
    expect(
      MasterToWorker.safeParse({ ...masterMessages.ASSIGN_JOB, traceparent: 'Bearer secret' }).success,
    ).toBe(false);
  });
});
