import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { ReleaseInfo, ReleaseUploadInfo } from '../src/api/releases';
import {
  PART_ATTEMPTS,
  partRanges,
  UploadCancelledError,
  type UploadApi,
  type UploadProgress,
  uploadReleaseInParts,
} from '../src/lib/releaseUpload';

const nodeSha = (b: ArrayBuffer | Uint8Array) =>
  createHash('sha256')
    .update(b instanceof Uint8Array ? b : new Uint8Array(b))
    .digest('hex');
const digest = (b: ArrayBuffer) => Promise.resolve(nodeSha(b));
const noSleep = () => Promise.resolve();
const ID = '11111111-2222-4333-8444-555555555555';

const RELEASE: ReleaseInfo = {
  version: '1.4.0',
  channel: 'stable',
  sha256: 'a'.repeat(64),
  sizeBytes: 1000,
  keyId: 'b'.repeat(16),
  uploadedAt: '2026-10-15T10:00:00.000Z',
};

function bytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) % 251;
  return out;
}

/** An in-memory master: records parts, checks their hashes, assembles at complete. */
function fakeMaster(
  opts: { failOnce?: Set<number>; failAlways?: number; received?: number[]; partSize?: number } = {},
) {
  const parts = new Map<number, Uint8Array>();
  const calls: string[] = [];
  let declared = { totalBytes: 0, sha256: '', partSize: 0 };
  const failed = new Set<number>();
  const info = (): ReleaseUploadInfo => ({
    id: ID,
    totalBytes: declared.totalBytes,
    partSize: declared.partSize,
    partCount: Math.ceil(declared.totalBytes / declared.partSize),
    received: [...parts.keys()].sort((a, b) => a - b),
    expiresAt: '2026-10-15T11:00:00.000Z',
  });
  const api: UploadApi = {
    start: (input) => {
      calls.push('start');
      declared = input;
      return Promise.resolve(info());
    },
    status: () => {
      calls.push('status');
      return Promise.resolve(info());
    },
    putPart: async (_id, n, body, sha) => {
      calls.push(`part ${String(n)}`);
      if (opts.failAlways === n) throw new ApiError(503, 'unavailable', 'Service unavailable.');
      if (opts.failOnce?.has(n) && !failed.has(n)) {
        failed.add(n);
        throw new ApiError(0, 'network_error', 'Cannot reach the server.');
      }
      const buf = body instanceof Blob ? await body.arrayBuffer() : body;
      if (nodeSha(buf) !== sha) throw new ApiError(422, 'part_checksum_mismatch', 'bad part');
      parts.set(n, new Uint8Array(buf));
      return { n, received: parts.size };
    },
    complete: () => {
      calls.push('complete');
      const all = Buffer.concat([...parts.entries()].sort(([a], [b]) => a - b).map(([, p]) => p));
      if (nodeSha(all) !== declared.sha256) {
        return Promise.reject(new ApiError(422, 'checksum_mismatch', 'mismatch'));
      }
      return Promise.resolve(RELEASE);
    },
  };
  return {
    api,
    calls,
    parts,
    seed(total: number, sha: string, partSize: number, received: [number, Uint8Array][]) {
      declared = { totalBytes: total, sha256: sha, partSize };
      for (const [n, p] of received) parts.set(n, p);
    },
  };
}

describe('chunked release upload (p6-release-upload)', () => {
  it('slices the file into partSize parts (shorter last one) that reassemble to the exact bytes', async () => {
    expect(partRanges(10, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 10 },
    ]);
    expect(partRanges(8, 4)).toHaveLength(2);
    const data = bytes(10_000);
    const m = fakeMaster();
    const progress: UploadProgress[] = [];
    const result = await uploadReleaseInParts(new Blob([data]), {
      partSize: 4096,
      api: m.api,
      digest,
      sleep: noSleep,
      onProgress: (p) => progress.push(p),
    });
    expect(result.version).toBe('1.4.0');
    expect(m.calls).toEqual(['start', 'part 0', 'part 1', 'part 2', 'complete']);
    expect([...m.parts.values()].map((p) => p.length)).toEqual([4096, 4096, 1808]);
    // Progress: hashing → uploading 0..3 parts (monotonic bytes) → verifying.
    expect(progress[0]?.phase).toBe('hashing');
    expect(progress.at(-1)).toMatchObject({ phase: 'verifying', sentBytes: 10_000, partsDone: 3 });
    const sent = progress.filter((p) => p.phase === 'uploading').map((p) => p.sentBytes);
    expect(sent).toEqual([0, 4096, 8192, 10_000]);
  });

  it('retries a part after a transient failure and reports the retry', async () => {
    const m = fakeMaster({ failOnce: new Set([1]) });
    const sleep = vi.fn(noSleep);
    const progress: UploadProgress[] = [];
    await uploadReleaseInParts(new Blob([bytes(9000)]), {
      partSize: 4096,
      api: m.api,
      digest,
      sleep,
      onProgress: (p) => progress.push(p),
    });
    expect(m.calls).toEqual(['start', 'part 0', 'part 1', 'part 1', 'part 2', 'complete']);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(progress.some((p) => p.retry?.part === 1 && p.retry.attempt === 2)).toBe(true);
  });

  it('gives up after the last attempt and does not retry refusals', async () => {
    const m = fakeMaster({ failAlways: 0 });
    await expect(
      uploadReleaseInParts(new Blob([bytes(5000)]), { partSize: 4096, api: m.api, digest, sleep: noSleep }),
    ).rejects.toMatchObject({ status: 503 });
    expect(m.calls.filter((c) => c === 'part 0')).toHaveLength(PART_ATTEMPTS);
    const refused = fakeMaster();
    refused.api.putPart = () => Promise.reject(new ApiError(410, 'upload_expired', 'expired'));
    await expect(
      uploadReleaseInParts(new Blob([bytes(5000)]), {
        partSize: 4096,
        api: refused.api,
        digest,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'upload_expired' });
  });

  it('resumes: sends only the parts the master lacks, then completes', async () => {
    const data = bytes(12_000);
    const m = fakeMaster();
    m.seed(data.length, nodeSha(data), 4096, [[0, data.subarray(0, 4096)]]);
    await uploadReleaseInParts(new Blob([data]), {
      resumeId: ID,
      api: m.api,
      digest,
      sleep: noSleep,
    });
    expect(m.calls).toEqual(['status', 'part 1', 'part 2', 'complete']);
  });

  it('cancel stops before the next part and never completes', async () => {
    const m = fakeMaster();
    const ctl = new AbortController();
    const original = m.api.putPart;
    m.api.putPart = async (...args) => {
      const r = await original(...args);
      ctl.abort();
      return r;
    };
    await expect(
      uploadReleaseInParts(new Blob([bytes(9000)]), {
        partSize: 4096,
        api: m.api,
        digest,
        sleep: noSleep,
        signal: ctl.signal,
      }),
    ).rejects.toBeInstanceOf(UploadCancelledError);
    expect(m.calls).toEqual(['start', 'part 0']);
  });
});
