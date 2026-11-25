import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.js';
import {
  combineInputs,
  namePrefix,
  type PreparedInput,
  validateStoragePolicy,
} from '../../src/workspaces/service.js';
import { formatBytes, StorageQuotaError } from '../../src/workspaces/storage.js';

const MiB = 1024 * 1024;

function input(name: string, sizeBytes: number): PreparedInput {
  return {
    ref: {
      inputId: `in-${name.replace(/[^a-z0-9]/g, '')}`,
      name,
      mediaType: 'text/markdown',
      sizeBytes,
      sha256: '0'.repeat(64),
    },
    content: Buffer.alloc(0),
    source: 'upload',
    sourceJobId: null,
  };
}

describe('workspace storage (p5-research-workspace-next)', () => {
  it('combineInputs keeps the priority order within the per-job limits and names what is dropped', () => {
    const own = [input('brief.md', 4 * MiB)];
    const upstream = [input('a-notes.md', 5 * MiB), input('a-big.md', 2 * MiB), input('brief.md', 1)];
    const r = combineInputs(own, upstream);
    expect(r.inputs.map((i) => i.ref.name)).toEqual(['brief.md', 'a-notes.md']);
    expect(r.dropped).toEqual(['a-big.md', 'brief.md']);
    const many = Array.from({ length: 12 }, (_, i) => input(`f${String(i)}.md`, 1));
    expect(combineInputs(many).inputs).toHaveLength(10);
    expect(combineInputs(many).dropped).toEqual(['f10.md', 'f11.md']);
  });

  it('namePrefix produces a valid file-name prefix from a node id', () => {
    expect(namePrefix('gather')).toBe('gather');
    expect(namePrefix('plan.task-1')).toBe('plan.task-1');
    expect(namePrefix('-x y/z')).toBe('x_y_z');
    expect(namePrefix('***')).toBe('step');
    expect(namePrefix('a'.repeat(60))).toHaveLength(40);
  });

  it('validateStoragePolicy: bounds, null clears, undefined keeps', () => {
    expect(validateStoragePolicy({})).toEqual({});
    expect(validateStoragePolicy({ artifactRetentionDays: null, storageQuotaBytes: null })).toEqual({
      artifactRetentionDays: null,
      storageQuotaBytes: null,
    });
    expect(validateStoragePolicy({ artifactRetentionDays: 30, storageQuotaBytes: 10 * MiB })).toEqual({
      artifactRetentionDays: 30,
      storageQuotaBytes: 10 * MiB,
    });
    for (const bad of [
      { artifactRetentionDays: 0 },
      { artifactRetentionDays: 3651 },
      { artifactRetentionDays: '7' },
      { storageQuotaBytes: MiB },
      { storageQuotaBytes: 2 ** 41 },
      { storageQuotaBytes: 10 * MiB + 0.5 },
    ]) {
      expect(() => validateStoragePolicy(bad), JSON.stringify(bad)).toThrow(HttpError);
    }
  });

  it('StorageQuotaError is a 413 naming the quota, never file contents', () => {
    const e = new StorageQuotaError('genel', 5 * MiB, 10 * MiB);
    expect(e.statusCode).toBe(413);
    expect(e.code).toBe('storage_quota_exceeded');
    expect(e.publicMessage).toContain('10.0 MiB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3 * 1024 * MiB)).toBe('3.00 GiB');
  });
});
