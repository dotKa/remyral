import { describe, expect, it } from 'vitest';
import { AssignedBlobUpload, BLOB_LIMITS } from '../src/blob-uploads.js';
import { AssignJob } from '../src/master-messages.js';
import {
  AssignedOutputLimits,
  effectiveJobBytes,
  effectiveMaxFiles,
  OUTPUT_LIMITS,
  OUTPUT_LIMITS_FEATURE,
  OutputReport,
} from '../src/output-limits.js';
import { WorkerFeature } from '../src/worker-features.js';
import { JobResult } from '../src/worker-messages.js';
import { MAX_ARTIFACTS } from '../src/workspace.js';
import { masterMessages, workerMessages } from './fixtures.js';

describe('output limits (p17-output-limits)', () => {
  it('the feature is known; defaults and ceiling', () => {
    expect(WorkerFeature.safeParse(OUTPUT_LIMITS_FEATURE).success).toBe(true);
    expect(OUTPUT_LIMITS.defaultMaxFiles).toBe(500);
    expect(OUTPUT_LIMITS.ceilingMaxFiles).toBe(2000);
    expect(OUTPUT_LIMITS.legacyMaxFiles).toBe(MAX_ARTIFACTS);
    // No ZIP64: the overflow zip and its entry count stay inside the classic format.
    expect(OUTPUT_LIMITS.zipMaxBytes).toBeLessThan(4 * 1024 * 1024 * 1024);
    expect(OUTPUT_LIMITS.zipMaxEntries).toBeLessThan(65_535);
  });

  it('execution.outputLimits is optional in ASSIGN_JOB and bounded', () => {
    const assign = masterMessages.ASSIGN_JOB as { payload: Record<string, unknown> };
    const parsed = AssignJob.parse({
      ...assign,
      payload: {
        ...assign.payload,
        execution: { hostExecutionOptIn: false, outputLimits: { maxFiles: 500, zipOverflow: true } },
      },
    });
    expect(parsed.payload.execution?.outputLimits).toEqual({ maxFiles: 500, zipOverflow: true });
    expect(AssignedOutputLimits.safeParse({ maxFiles: 2001, zipOverflow: false }).success).toBe(false);
    expect(AssignedOutputLimits.safeParse({ maxFiles: 0, zipOverflow: false }).success).toBe(false);
  });

  it('blobUpload.maxFiles may go up to the ceiling (only output-limits-v1 workers get more than 20)', () => {
    const base = {
      thresholdBytes: BLOB_LIMITS.defaultThresholdBytes,
      maxFileBytes: BLOB_LIMITS.defaultFileBytes,
      maxJobBytes: BLOB_LIMITS.defaultJobBytes,
      partBytes: BLOB_LIMITS.partBytes,
    };
    expect(AssignedBlobUpload.safeParse({ ...base, maxFiles: 500 }).success).toBe(true);
    expect(AssignedBlobUpload.safeParse({ ...base, maxFiles: 2001 }).success).toBe(false);
    expect(BLOB_LIMITS.maxFiles).toBe(20);
  });

  it('JOB_RESULT carries an optional outputs report', () => {
    const result = workerMessages.JOB_RESULT as { payload: Record<string, unknown> };
    const outputs = {
      maxFiles: 500,
      returned: 500,
      storage: true,
      zip: { name: 'out-rest.zip', files: 120, bytes: 4096 },
      skipped: [{ name: 'out/link', code: 'symlink', reason: 'symbolic link (not followed)' }],
      skippedCount: 1,
    };
    const parsed = JobResult.parse({ ...result, payload: { ...result.payload, outputs } });
    expect(parsed.payload.outputs).toEqual(outputs);
    // Older payloads stay valid.
    expect(JobResult.parse(result).payload.outputs).toBeUndefined();
    expect(
      OutputReport.safeParse({ ...outputs, skipped: [{ name: 'x', code: 'nope', reason: '' }] }).success,
    ).toBe(false);
    expect(
      OutputReport.safeParse({
        ...outputs,
        skipped: Array.from({ length: 101 }, () => ({ name: 'x', code: 'type', reason: '' })),
      }).success,
    ).toBe(false);
  });

  it('a project lowers the server limit, never raises it', () => {
    expect(effectiveMaxFiles(500, null)).toBe(500);
    expect(effectiveMaxFiles(500, 100)).toBe(100);
    expect(effectiveMaxFiles(500, 1500)).toBe(500);
    expect(effectiveMaxFiles(5000, null)).toBe(2000);
    expect(effectiveMaxFiles(500, 0)).toBe(1);
    expect(effectiveJobBytes(5 * 2 ** 30, null)).toBe(5 * 2 ** 30);
    expect(effectiveJobBytes(5 * 2 ** 30, 2 ** 30)).toBe(2 ** 30);
    expect(effectiveJobBytes(2 ** 30, 5 * 2 ** 30)).toBe(2 ** 30);
  });
});
