import { describe, expect, it } from 'vitest';
import {
  AssignedSubtasks,
  SUBTASK_LIMITS,
  subtaskInputArtifactId,
  SubtaskRequestOp,
  WorkerFeature,
} from '../src/index.js';

/** p22-previews-inputs: staged sub-job inputs and the two new worker features (additive wire). */

const SHA = 'a'.repeat(64);

describe('staged sub-job inputs', () => {
  it('derives a stable ws-subin id from name and content hash', () => {
    const id = subtaskInputArtifactId('data.txt', SHA);
    expect(id).toMatch(/^ws-subin-[0-9a-f]{24}$/);
    expect(subtaskInputArtifactId('data.txt', SHA)).toBe(id);
    expect(subtaskInputArtifactId('other.txt', SHA)).not.toBe(id);
  });

  it('create ops accept stagedInputs within the limits; older ops stay valid', () => {
    const base = { kind: 'create', title: 't', prompt: 'p', wait: true } as const;
    expect(SubtaskRequestOp.safeParse(base).success).toBe(true);
    const staged = {
      name: 'data.txt',
      artifactId: subtaskInputArtifactId('data.txt', SHA),
      sizeBytes: 300 * 1024,
      sha256: SHA,
    };
    expect(SubtaskRequestOp.safeParse({ ...base, stagedInputs: [staged] }).success).toBe(true);
    for (const bad of [
      { ...staged, artifactId: 'ws-o1-abc' },
      { ...staged, sizeBytes: SUBTASK_LIMITS.maxStagedFileBytes + 1 },
      { ...staged, name: '../x.txt' },
    ]) {
      expect(SubtaskRequestOp.safeParse({ ...base, stagedInputs: [bad] }).success).toBe(false);
    }
    expect(
      SubtaskRequestOp.safeParse({ ...base, stagedInputs: Array(SUBTASK_LIMITS.maxInputs + 1).fill(staged) })
        .success,
    ).toBe(false);
  });

  it('assignment flag and features are additive', () => {
    expect(AssignedSubtasks.parse({ runtimes: ['codex'], depthLeft: 1 })).not.toHaveProperty('stagedInputs');
    expect(
      AssignedSubtasks.parse({ runtimes: ['codex'], depthLeft: 1, stagedInputs: true }).stagedInputs,
    ).toBe(true);
    expect(WorkerFeature.safeParse('subtask-staged-inputs-v1').success).toBe(true);
    expect(WorkerFeature.safeParse('preview-container-v1').success).toBe(true);
  });
});
