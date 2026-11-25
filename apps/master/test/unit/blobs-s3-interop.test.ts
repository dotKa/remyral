import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpBlobPut } from '@remyral/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashStream, S3Client, sha256HexToBase64 } from '../../src/blobs/s3.js';
import { EMPTY_SHA256, signRequest } from '../../src/blobs/sigv4.js';

/**
 * p17-object-storage interoperability with a real S3-compatible server (manual / CI with a container), skipped unless
 * REMYRAL_S3_INTEROP_URL is set, e.g. a throw-away SeaweedFS S3 gateway:
 *   docker run -d --name remyral-s3-interop -p 127.0.0.1:18333:8333 -v $PWD/s3.json:/etc/s3.json:ro \
 *     chrislusf/seaweedfs:3.97 server -s3 -s3.config=/etc/s3.json -dir=/data
 *   REMYRAL_S3_INTEROP_URL=http://127.0.0.1:18333 REMYRAL_S3_INTEROP_KEY=… REMYRAL_S3_INTEROP_SECRET=… pnpm vitest …
 * (MinIO works the same way.) It exercises the master's signer and the worker's uploader end to end.
 */
const url = process.env.REMYRAL_S3_INTEROP_URL ?? '';
const key = process.env.REMYRAL_S3_INTEROP_KEY ?? '';
const secret = process.env.REMYRAL_S3_INTEROP_SECRET ?? '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(url === '')('S3 interoperability (real server)', () => {
  const bucket = `remyral-interop-${randomBytes(4).toString('hex')}`;
  let client: S3Client;
  let dir: string;
  beforeAll(async () => {
    const h = signRequest(
      { method: 'PUT', url: new URL(`${url}/${bucket}`), payloadHash: EMPTY_SHA256 },
      { accessKeyId: key, secretAccessKey: secret },
      'us-east-1',
      new Date(),
    );
    const r = await fetch(`${url}/${bucket}`, { method: 'PUT', headers: h });
    expect([200, 409]).toContain(r.status);
    client = new S3Client({
      config: {
        provider: 'minio',
        endpoint: url,
        region: 'us-east-1',
        bucket,
        pathStyle: true,
        prefix: 'p/',
        sse: 'none',
        kmsKeyId: '',
      },
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });
    dir = await mkdtemp(join(tmpdir(), 'remyral-interop-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put / head / get / range / delete', async () => {
    const body = randomBytes(10_000);
    await client.put('artifacts/a/b/c', body, 'application/zip');
    expect((await client.head('artifacts/a/b/c'))?.size).toBe(10_000);
    expect((await client.get('artifacts/a/b/c', 20_000)).equals(body)).toBe(true);
    expect((await client.range('artifacts/a/b/c', 100, 10)).equals(body.subarray(100, 110))).toBe(true);
    await client.delete('artifacts/a/b/c');
    expect(await client.head('artifacts/a/b/c')).toBeNull();
  });

  it('presigned PUT through the worker uploader, then a presigned GET', async () => {
    const body = randomBytes(300_000);
    const file = join(dir, 'f.zip');
    await writeFile(file, body);
    const grant = client.presignPut('artifacts/a/b/d', {
      sizeBytes: body.length,
      contentType: 'application/zip',
      checksumSha256: sha256HexToBase64(sha(body)),
      expiresSeconds: 600,
    });
    const put = httpBlobPut({ masterUrl: 'ws://127.0.0.1:1/v1/worker', workerVersion: 'test' });
    await put(grant, 'object-store', { path: file, start: 0, size: body.length });
    const st = await client.stream('artifacts/a/b/d');
    expect((await hashStream(st.stream, body.length)).sha256).toBe(sha(body));
    const get = client.presignGet('artifacts/a/b/d', {
      expiresSeconds: 300,
      disposition: 'attachment; filename="f.zip"',
      contentType: 'application/octet-stream',
    });
    const r = await fetch(get);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).equals(body)).toBe(true);
    // A tampered body of the same size: AWS S3 refuses it (the signed x-amz-checksum-sha256); some compatible servers
    // (SeaweedFS 3.97) store it anyway — which is why the master always reads the object back and hashes it before it
    // reports an upload verified.
    const tampered = randomBytes(body.length);
    await writeFile(file, tampered);
    const accepted = await put(grant, 'object-store', { path: file, start: 0, size: body.length }).then(
      () => true,
      () => false,
    );
    if (accepted) {
      const again = await client.stream('artifacts/a/b/d');
      expect((await hashStream(again.stream, body.length)).sha256).not.toBe(sha(body));
    }
  });

  it('multipart with presigned parts through the worker uploader', async () => {
    const a = randomBytes(5 * 1024 * 1024);
    const b = randomBytes(12_345);
    const file = join(dir, 'big.mp4');
    await writeFile(file, Buffer.concat([a, b]));
    const id = await client.createMultipart('artifacts/a/b/e', 'video/mp4');
    const put = httpBlobPut({ masterUrl: 'ws://127.0.0.1:1/v1/worker', workerVersion: 'test' });
    const etags: { n: number; etag: string }[] = [];
    let start = 0;
    for (const [i, part] of [a, b].entries()) {
      const g = client.presignPart('artifacts/a/b/e', id, i + 1, part.length, 600);
      const r = await put(g, 'object-store', { path: file, start, size: part.length });
      etags.push({ n: i + 1, etag: r.etag ?? '' });
      start += part.length;
    }
    await client.completeMultipart('artifacts/a/b/e', id, etags);
    const st = await client.stream('artifacts/a/b/e');
    expect((await hashStream(st.stream, a.length + b.length)).sha256).toBe(sha(Buffer.concat([a, b])));
  });
});
