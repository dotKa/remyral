import { describe, expect, it } from 'vitest';
import {
  AssignJob,
  isWorkfilePath,
  MasterToWorker,
  pickEvictions,
  WorkerToMaster,
  WORKFILES_LIMITS,
  WorkfilesDataPayload,
  workfilesEffectiveExpiry,
  WorkfilesOp,
  workfilesPinned,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

const at = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
const entry = (id: string, day: number, size: number, pinnedUntil: string | null = null) => ({
  jobId: id,
  attemptId: `a-${id}`,
  sizeBytes: size,
  keptAt: at(day),
  pinnedUntil,
});

describe('p15-workspace-retention protocol', () => {
  it('parses the new messages both ways', () => {
    for (const t of ['WORKFILES_DATA', 'WORKFILES_STATUS', 'WORKFILES_FETCH'] as const) {
      expect(WorkerToMaster.safeParse(workerMessages[t]).success).toBe(true);
    }
    for (const t of ['WORKFILES_REQUEST', 'WORKFILES_FETCH_DATA'] as const) {
      expect(MasterToWorker.safeParse(masterMessages[t]).success).toBe(true);
    }
  });

  it('carries keepFiles / seedFiles in ASSIGN_JOB execution', () => {
    const base = masterMessages.ASSIGN_JOB;
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        execution: {
          hostExecutionOptIn: false,
          keepFiles: { expiresAt: at(30), maxBytes: WORKFILES_LIMITS.machineCapBytesDefault },
          seedFiles: { jobId: 'job_00', attemptId: 'att_00', mode: 'relay' },
        },
      },
    };
    const r = AssignJob.safeParse(msg);
    expect(r.success).toBe(true);
    // A cap below the minimum is refused.
    const low = structuredClone(msg);
    low.payload.execution.keepFiles.maxBytes = 1024;
    expect(AssignJob.safeParse(low).success).toBe(false);
  });

  it('accepts only safe relative paths', () => {
    expect(isWorkfilePath('out/index.html')).toBe(true);
    expect(isWorkfilePath('a b/ç.md')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', './a', 'a/\u0000', 'x/'])
      expect(isWorkfilePath(bad)).toBe(false);
    expect(isWorkfilePath(Array.from({ length: 17 }, () => 'd').join('/'))).toBe(false);
    expect(WorkfilesOp.safeParse({ op: 'read', path: '../secret', offset: 0 }).success).toBe(false);
  });

  it('bounds a data chunk', () => {
    const big = 'A'.repeat(Math.ceil(WORKFILES_LIMITS.readChunkBytes / 3) * 4 + 4);
    expect(
      WorkfilesDataPayload.safeParse({
        requestId: '00000000-0000-4000-8000-0000000000fe',
        status: 'ok',
        data: big,
      }).success,
    ).toBe(false);
  });

  it('evicts the oldest unpinned directories first until the cap fits', () => {
    const now = new Date(at(20));
    const entries = [
      entry('c', 3, 300),
      entry('a', 1, 100, at(25)), // oldest but pinned
      entry('b', 2, 200),
      entry('d', 4, 400),
    ];
    expect(pickEvictions(entries, 1000, now)).toEqual([]);
    expect(pickEvictions(entries, 700, now).map((e) => e.jobId)).toEqual(['b', 'c']);
    // A protected (just kept) directory is never evicted; a pin in the past no longer protects.
    const expiredPin = [entry('a', 1, 100, at(10)), entry('b', 2, 200)];
    expect(pickEvictions(expiredPin, 150, now, new Set(['b/a-b'])).map((e) => e.jobId)).toEqual(['a']);
    // Everything pinned: nothing can go.
    expect(pickEvictions([entry('a', 1, 100, at(25))], 10, now)).toEqual([]);
  });

  it('honours the later of expiry and pin', () => {
    const now = new Date(at(20));
    expect(workfilesPinned({ pinnedUntil: at(21) }, now)).toBe(true);
    expect(workfilesPinned({ pinnedUntil: null }, now)).toBe(false);
    expect(workfilesEffectiveExpiry({ expiresAt: at(22), pinnedUntil: at(25) })).toBe(Date.parse(at(25)));
    expect(workfilesEffectiveExpiry({ expiresAt: at(22), pinnedUntil: null })).toBe(Date.parse(at(22)));
  });
});
