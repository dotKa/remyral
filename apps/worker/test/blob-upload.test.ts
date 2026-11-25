import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '@remyral/observability';
import type { AssignedBlobUpload, BlobUploadGrantPayload, BlobUploadStatusPayload } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectArtifacts,
  scanLargeFile,
  summaryMarkdown,
  workspacePreamble,
} from '../src/jobs/workspace-job.js';
import {
  type BlobPut,
  BlobUploadError,
  hashFile,
  httpBlobPut,
  uploadBigFile,
} from '../src/workspace/blob-upload.js';
import { prePushScanner } from '../src/workspace/secret-scan.js';

/** p17-object-storage: collection of large outputs, the streamed scan, hashing in parts and the upload sequence. */

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const BLOB: AssignedBlobUpload = {
  thresholdBytes: 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxJobBytes: 100 * 1024 * 1024,
  maxFiles: 3,
  partBytes: 8 * 1024 * 1024,
};
const UUID = '7b0c4f1e-1d2a-4c3b-9a8e-0f1e2d3c4b5a';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blob-upload-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const zip = (n: number): Buffer => {
  const b = randomBytes(n);
  b.set([0x50, 0x4b, 0x03, 0x04], 0);
  return b;
};

describe('collecting large outputs', () => {
  it('large types and files over the threshold go to the blob list, within the limits', async () => {
    const out = await mkdtemp(join(dir, 'out-'));
    await writeFile(join(out, 'app.zip'), zip(2000));
    await writeFile(join(out, 'setup.exe'), Buffer.concat([Buffer.from('MZ'), randomBytes(100)]));
    await writeFile(join(out, 'data.csv'), Buffer.alloc(2 * 1024 * 1024, 0x61));
    await writeFile(join(out, 'report.md'), '# Report\n');
    await writeFile(join(out, 'fake.mp4'), 'not a video');
    await writeFile(join(out, 'too-big.zip'), zip(65 * 1024 * 1024));
    const c = await collectArtifacts(out, new Redactor(), BLOB);
    expect(c.files.map((f) => f.name)).toEqual(['report.md']);
    expect((c.big ?? []).map((f) => f.name).sort()).toEqual(['app.zip', 'data.csv', 'setup.exe']);
    const reasons = Object.fromEntries(c.skipped.map((s) => [s.name, s.reason]));
    expect(reasons['fake.mp4']).toBe('content is not video/mp4');
    expect(reasons['too-big.zip']).toMatch(/larger than/);
  });

  it('without a blob assignment large types are named as not returned (older master)', async () => {
    const out = await mkdtemp(join(dir, 'old-'));
    await writeFile(join(out, 'app.zip'), zip(100));
    const c = await collectArtifacts(out, new Redactor());
    expect(c.files).toEqual([]);
    expect(c.big).toBeUndefined();
    expect(c.skipped).toEqual([
      {
        name: 'app.zip',
        code: 'inline_budget',
        reason: 'large files need a master with object storage support',
      },
    ]);
  });

  it('the streamed scan drops a large file with a secret, also across a window boundary', async () => {
    const scanner = prePushScanner(new Redactor().secrets);
    const key = `ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8`;
    const p = join(dir, 'leak.zip');
    // The token straddles the 1 MiB window boundary.
    // Newlines around it: random neighbouring bytes could otherwise extend the token past its pattern.
    const body = Buffer.concat([zip(1024 * 1024 - 10), Buffer.from(`\n${key}\n`), randomBytes(1000)]);
    await writeFile(p, body);
    expect(await scanLargeFile(p, body.length, 'application/zip', scanner)).toBe(
      'dropped: looks like it contains a secret',
    );
    const clean = join(dir, 'clean.zip');
    const ok = zip(3 * 1024 * 1024);
    await writeFile(clean, ok);
    expect(await scanLargeFile(clean, ok.length, 'application/zip', scanner)).toBeNull();
    expect(await scanLargeFile(clean, ok.length + 1, 'application/zip', scanner)).toBe(
      'changed while it was collected',
    );
  });

  it('the preamble and the summary name the blob limits and the large files', () => {
    const text = workspacePreamble([], 'none', { blob: BLOB });
    expect(text).toContain('64 MiB each');
    expect(text).toContain('.tar.gz');
    const md = summaryMarkdown({
      outcome: 'succeeded',
      summary: 'ok',
      files: [],
      large: [{ name: 'app.zip', size: 2000 }],
      skipped: [],
    }).toString();
    expect(md).toContain('- app.zip (2000 bytes, download only)');
  });
});

describe('hashing and uploading', () => {
  it('hashes the whole file and its parts in one pass', async () => {
    const body = randomBytes(20 * 1024 + 7);
    const p = join(dir, 'h.bin');
    await writeFile(p, body);
    const h = await hashFile(p, body.length, 8 * 1024);
    expect(h.sha256).toBe(sha(body));
    expect(h.parts.map((x) => x.sizeBytes)).toEqual([8192, 8192, 4103]);
    expect(h.parts[2]?.sha256).toBe(sha(body.subarray(16384)));
    await expect(hashFile(p, body.length + 1, 8192)).rejects.toThrow(BlobUploadError);
  });

  it('single PUT: grant, PUT, COMPLETE, verified; a refusal names its reason', async () => {
    const body = zip(5000);
    const p = join(dir, 's.zip');
    await writeFile(p, body);
    const puts: { url: string; size: number }[] = [];
    const put: BlobPut = (t, _kind, f) => {
      puts.push({ url: t.url, size: f.size });
      return Promise.resolve({ etag: null });
    };
    const grant = (over: Partial<BlobUploadGrantPayload> = {}): BlobUploadGrantPayload => ({
      attemptId: 'a' as BlobUploadGrantPayload['attemptId'],
      epoch: 1,
      requestId: UUID,
      status: 'ok',
      uploadId: UUID,
      target: 'master',
      put: { url: `/v1/worker/blobs/${UUID}`, headers: { authorization: 'Bearer x' } },
      ...over,
    });
    const status: BlobUploadStatusPayload = {
      attemptId: 'a' as BlobUploadStatusPayload['attemptId'],
      epoch: 1,
      requestId: UUID,
      uploadId: UUID,
      status: 'verified',
    };
    let requested: Record<string, unknown> | null = null;
    const done = await uploadBigFile(
      {
        request: (r) => {
          requested = r;
          return Promise.resolve(grant());
        },
        complete: () => Promise.resolve(status),
        put,
      },
      { artifactId: 'ws-o0-x', name: 's.zip', mediaType: 'application/zip', path: p, size: body.length },
      BLOB,
    );
    expect(done).toEqual({ uploadId: UUID, sha256: sha(body) });
    expect(requested).toMatchObject({ sizeBytes: 5000, sha256: sha(body) });
    expect(requested).not.toHaveProperty('parts');
    expect(puts).toEqual([{ url: `/v1/worker/blobs/${UUID}`, size: 5000 }]);
    await expect(
      uploadBigFile(
        {
          request: () => Promise.resolve(grant({ status: 'refused', reason: 'quota' })),
          complete: () => Promise.resolve(status),
          put,
        },
        { artifactId: 'ws-o0-x', name: 's.zip', mediaType: 'application/zip', path: p, size: body.length },
        BLOB,
      ),
    ).rejects.toMatchObject({ reason: 'refused_quota' });
    await expect(
      uploadBigFile(
        {
          request: () => Promise.resolve(grant()),
          complete: () => Promise.resolve({ ...status, status: 'failed', reason: 'sha256_mismatch' }),
          put,
        },
        { artifactId: 'ws-o0-x', name: 's.zip', mediaType: 'application/zip', path: p, size: body.length },
        BLOB,
      ),
    ).rejects.toMatchObject({ reason: 'not_verified_sha256_mismatch' });
  });

  it('parts: one PUT per part (exact ranges), ETags reported for object storage', async () => {
    const small = { ...BLOB, partBytes: 5 * 1024 * 1024 };
    const body = zip(11 * 1024 * 1024);
    const p = join(dir, 'm.zip');
    await writeFile(p, body);
    const seen: { start: number; size: number }[] = [];
    let completed: unknown = null;
    await uploadBigFile(
      {
        request: (r) =>
          Promise.resolve({
            attemptId: 'a' as BlobUploadGrantPayload['attemptId'],
            epoch: 1,
            requestId: UUID,
            status: 'ok',
            uploadId: UUID,
            target: 'object-store',
            parts: (r.parts ?? []).map((_x, i) => ({
              n: i + 1,
              url: `https://s3.example/k?partNumber=${String(i + 1)}`,
              headers: {},
            })),
          }),
        complete: (c) => {
          completed = c;
          return Promise.resolve({
            attemptId: 'a' as BlobUploadStatusPayload['attemptId'],
            epoch: 1,
            requestId: UUID,
            uploadId: UUID,
            status: 'verified',
          });
        },
        put: (_t, _k, f) => {
          seen.push({ start: f.start, size: f.size });
          return Promise.resolve({ etag: `"e${String(seen.length)}"` });
        },
      },
      { artifactId: 'ws-o1-m', name: 'm.zip', mediaType: 'application/zip', path: p, size: body.length },
      small,
    );
    expect(seen).toEqual([
      { start: 0, size: 5 * 1024 * 1024 },
      { start: 5 * 1024 * 1024, size: 5 * 1024 * 1024 },
      { start: 10 * 1024 * 1024, size: 1024 * 1024 },
    ]);
    expect(completed).toEqual({
      uploadId: UUID,
      parts: [
        { n: 1, etag: '"e1"' },
        { n: 2, etag: '"e2"' },
        { n: 3, etag: '"e3"' },
      ],
    });
  });
});

describe('the HTTP uploader', () => {
  let server: Server;
  let base = '';
  const got: { url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        got.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = req.url?.includes('fail') === true ? 403 : 200;
        res.setHeader('etag', '"abc"');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('streams a byte range with its exact length; master paths stay on the master origin', async () => {
    const body = randomBytes(10_000);
    const p = join(dir, 'u.bin');
    await writeFile(p, body);
    const put = httpBlobPut({ masterUrl: `ws://${base}/v1/worker`, workerVersion: '1.0.0' });
    const r = await put(
      {
        url: `/v1/worker/blobs/${UUID}/2`,
        headers: { authorization: 'Bearer tok', 'content-type': 'application/octet-stream' },
      },
      'master',
      { path: p, start: 1000, size: 500 },
    );
    expect(r.etag).toBe('"abc"');
    const last = got.at(-1);
    expect(last?.url).toBe(`/v1/worker/blobs/${UUID}/2`);
    expect(last?.headers.authorization).toBe('Bearer tok');
    expect(last?.headers['content-length']).toBe('500');
    expect(last?.body.equals(body.subarray(1000, 1500))).toBe(true);
    // An object-store URL never gets an authorization header from a grant.
    await put(
      { url: `http://${base}/bucket/k?X-Amz-Signature=1`, headers: { authorization: 'Bearer leak' } },
      'object-store',
      {
        path: p,
        start: 0,
        size: 10,
      },
    );
    expect(got.at(-1)?.headers.authorization).toBeUndefined();
    // Refused targets: another path on the master, a non-loopback http URL, a 4xx answer.
    await expect(
      put({ url: '/v1/worker/releases/x', headers: {} }, 'master', { path: p, start: 0, size: 1 }),
    ).rejects.toMatchObject({ reason: 'bad_url' });
    await expect(
      put({ url: 'http://bucket.example.com/k', headers: {} }, 'object-store', {
        path: p,
        start: 0,
        size: 1,
      }),
    ).rejects.toMatchObject({ reason: 'bad_url' });
    await expect(
      put({ url: `http://${base}/fail`, headers: {} }, 'object-store', { path: p, start: 0, size: 1 }),
    ).rejects.toMatchObject({ reason: 'http_403' });
  });
});
