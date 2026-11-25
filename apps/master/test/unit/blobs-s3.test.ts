import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leastPrivilegePolicy, limitsOf, normalisePrefix, StorageConfig } from '../../src/blobs/config.js';
import { BlobKeyError, LocalBlobStore } from '../../src/blobs/local.js';
import { hashStream, S3Client, S3Error, sha256HexToBase64, storeRefOf } from '../../src/blobs/s3.js';
import { FakeS3 } from '../helpers/fake-s3.js';

const creds = { accessKeyId: 'remyral-test-key', secretAccessKey: 'remyral-test-secret-0123456789' };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('S3 client against a signature-checking fake (p17-object-storage)', () => {
  const s3 = new FakeS3({ bucket: 'outputs', ...creds });
  let client: S3Client;

  beforeAll(async () => {
    const url = await s3.start();
    client = new S3Client({
      config: {
        provider: 'minio',
        endpoint: url,
        region: 'us-east-1',
        bucket: 'outputs',
        pathStyle: true,
        prefix: 'remyral/',
        sse: 'none',
        kmsKeyId: '',
      },
      credentials: creds,
    });
  });
  afterAll(async () => {
    await s3.stop();
  });

  it('put / head / get / range / stream / delete', async () => {
    const body = randomBytes(5000);
    await client.put('artifacts/j/a/ws-o0-x', body, 'application/zip');
    expect(s3.objects.has('remyral/artifacts/j/a/ws-o0-x')).toBe(true);
    expect((await client.head('artifacts/j/a/ws-o0-x'))?.size).toBe(5000);
    expect((await client.get('artifacts/j/a/ws-o0-x', 10_000)).equals(body)).toBe(true);
    expect((await client.range('artifacts/j/a/ws-o0-x', 10, 20)).equals(body.subarray(10, 30))).toBe(true);
    const st = await client.stream('artifacts/j/a/ws-o0-x');
    expect((await hashStream(st.stream, 10_000)).sha256).toBe(sha(body));
    await expect(client.get('artifacts/j/a/ws-o0-x', 100)).rejects.toMatchObject({ code: 'TooLarge' });
    await client.delete('artifacts/j/a/ws-o0-x');
    expect(await client.head('artifacts/j/a/ws-o0-x')).toBeNull();
    await expect(client.get('artifacts/j/a/ws-o0-x', 100)).rejects.toMatchObject({ status: 404 });
  });

  it('a wrong secret is refused with the provider code', async () => {
    const bad = new S3Client({
      config: client.config,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: 'wrong-secret-000000' },
    });
    await expect(bad.put('artifacts/x/y', Buffer.from('x'))).rejects.toMatchObject({
      code: 'SignatureDoesNotMatch',
      status: 403,
    });
  });

  it('presigned PUT: size and checksum are bound; the wrong body is refused', async () => {
    const body = randomBytes(2048);
    const grant = client.presignPut('artifacts/j/a/ws-o1-y', {
      sizeBytes: body.length,
      contentType: 'application/zip',
      checksumSha256: sha256HexToBase64(sha(body)),
      expiresSeconds: 900,
    });
    expect(grant.headers).not.toHaveProperty('authorization');
    const ok = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body });
    expect(ok.status).toBe(200);
    expect(s3.objects.get('remyral/artifacts/j/a/ws-o1-y')?.data.equals(body)).toBe(true);
    // Another body of the same size: the checksum header no longer matches.
    const other = randomBytes(2048);
    const bad = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: other });
    expect(bad.status).toBe(400);
    // A longer body: content-length is a signed header.
    const longer = await fetch(grant.url, {
      method: 'PUT',
      headers: grant.headers,
      body: Buffer.concat([body, body]),
    });
    expect(longer.status).toBe(403);
    // Another key with this signature: refused.
    const moved = await fetch(grant.url.replace('ws-o1-y', 'ws-o9-z'), {
      method: 'PUT',
      headers: grant.headers,
      body,
    });
    expect(moved.status).toBe(403);
  });

  it('multipart: create, presigned parts, complete', async () => {
    const a = randomBytes(6 * 1024 * 1024);
    const b = randomBytes(1024);
    const id = await client.createMultipart('artifacts/j/a/ws-o2-big', 'video/mp4');
    const etags: { n: number; etag: string }[] = [];
    for (const [i, part] of [a, b].entries()) {
      const g = client.presignPart('artifacts/j/a/ws-o2-big', id, i + 1, part.length, 900);
      const r = await fetch(g.url, { method: 'PUT', headers: g.headers, body: part });
      expect(r.status).toBe(200);
      etags.push({ n: i + 1, etag: r.headers.get('etag') ?? '' });
    }
    await client.completeMultipart('artifacts/j/a/ws-o2-big', id, etags);
    expect(s3.objects.get('remyral/artifacts/j/a/ws-o2-big')?.data.equals(Buffer.concat([a, b]))).toBe(true);
    // A wrong ETag fails the completion.
    const id2 = await client.createMultipart('artifacts/j/a/ws-o3', 'video/mp4');
    await expect(
      client.completeMultipart('artifacts/j/a/ws-o3', id2, [{ n: 1, etag: '"x"' }]),
    ).rejects.toBeInstanceOf(S3Error);
    await client.abortMultipart('artifacts/j/a/ws-o3', id2);
  });

  it('presigned GET forces the download name and type', async () => {
    await client.put('artifacts/j/a/ws-o4', Buffer.from('PK\x03\x04data'), 'application/zip');
    const url = client.presignGet('artifacts/j/a/ws-o4', {
      expiresSeconds: 300,
      disposition: 'attachment; filename="app.zip"',
      contentType: 'application/octet-stream',
    });
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="app.zip"');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('refuses plain http to a non-loopback endpoint; store refs carry no secret', () => {
    expect(
      () =>
        new S3Client({
          config: { ...client.config, endpoint: 'http://minio.lan:9000' },
          credentials: creds,
        }),
    ).toThrow(S3Error);
    expect(storeRefOf(client.config)).toMatch(/^127\.0\.0\.1:\d+\/outputs\/remyral\/$/);
    expect(storeRefOf(client.config)).not.toContain(creds.secretAccessKey);
  });

  it('AWS without an endpoint uses virtual-hosted addressing in the region', () => {
    const aws = new S3Client({
      config: {
        provider: 'aws',
        endpoint: '',
        region: 'eu-central-1',
        bucket: 'remyral-outputs',
        pathStyle: false,
        prefix: '',
        sse: 'AES256',
        kmsKeyId: '',
      },
      credentials: creds,
    });
    expect(aws.objectUrl('artifacts/a').toString()).toBe(
      'https://remyral-outputs.s3.eu-central-1.amazonaws.com/artifacts/a',
    );
    const put = aws.presignPut('artifacts/a', {
      sizeBytes: 1,
      contentType: 'application/zip',
      expiresSeconds: 60,
    });
    expect(put.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-server-side-encryption',
    );
  });
});

describe('storage settings shapes', () => {
  it('validates the bucket settings and normalises the prefix', () => {
    const ok = {
      provider: 'r2',
      endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'remyral-outputs',
      pathStyle: true,
      prefix: 'prod/',
      sse: 'none',
      kmsKeyId: '',
    };
    expect(StorageConfig.safeParse(ok).success).toBe(true);
    for (const bad of [
      { endpoint: 'http://example.com' },
      { endpoint: 'https://user:pw@example.com' },
      { endpoint: 'https://example.com/bucket' },
      { bucket: 'Bad_Bucket' },
      { bucket: '192.168.1.1' },
      { prefix: '../x' },
      { sse: 'rot13' },
    ]) {
      expect(StorageConfig.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(StorageConfig.safeParse({ ...ok, endpoint: 'http://127.0.0.1:9000' }).success).toBe(true);
    expect(normalisePrefix('/a/b/')).toBe('a/b/');
    expect(normalisePrefix('')).toBe('');
  });

  it('limits fall back to defaults field by field; the job limit is at least the file limit', () => {
    const l = limitsOf({ maxFileBytes: 10 * 1024 * 1024, maxJobBytes: 1024 * 1024, thresholdBytes: 'x' });
    expect(l.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(l.maxJobBytes).toBe(10 * 1024 * 1024);
    expect(l.thresholdBytes).toBe(4 * 1024 * 1024);
    expect(limitsOf(null).maxFileBytes).toBe(2 * 1024 * 1024 * 1024 - 1);
  });

  it('least-privilege policy: objects under the prefix only, no listing, no ACL', () => {
    const p = JSON.stringify(leastPrivilegePolicy('remyral-outputs', 'prod'));
    expect(p).toContain('arn:aws:s3:::remyral-outputs/prod/*');
    expect(p).not.toContain('s3:ListBucket"');
    expect(p).not.toContain('PutObjectAcl');
    expect(p).not.toContain('"*"');
  });
});

describe('local blob store (p17-object-storage)', () => {
  let dir: string;
  let store: LocalBlobStore;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remyral-blobs-unit-'));
    store = new LocalBlobStore(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes files 0600 below the root, reads, ranges, deletes', async () => {
    const body = randomBytes(1000);
    await store.put('artifacts/j/a/ws-x', body);
    const st = await stat(join(dir, 'artifacts', 'j', 'a', 'ws-x'));
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect((await stat(join(dir, 'artifacts'))).mode & 0o777).toBe(0o700);
    expect((await store.get('artifacts/j/a/ws-x', 2000)).equals(body)).toBe(true);
    expect((await store.range('artifacts/j/a/ws-x', 990, 50)).equals(body.subarray(990))).toBe(true);
    await store.delete('artifacts/j/a/ws-x');
    expect(await store.head('artifacts/j/a/ws-x')).toBeNull();
    await store.delete('artifacts/j/a/ws-x');
  });

  it('refuses keys outside the grammar or the root', () => {
    for (const bad of [
      '../etc/passwd',
      'artifacts/../x',
      '/abs',
      'other/x',
      'artifacts/.hidden',
      'artifacts/a//b',
    ]) {
      expect(() => store.path(bad), bad).toThrow(BlobKeyError);
    }
  });

  it('putStream keeps only the declared size + hash; parts assemble into the blob', async () => {
    const body = randomBytes(3000);
    const ok = await store.putStream(
      'inputs/j/in-1',
      Readable.from([body]),
      3000,
      (n, h) => n === 3000 && h === sha(body),
    );
    expect(ok.accepted).toBe(true);
    const wrong = await store.putStream('inputs/j/in-2', Readable.from([body]), 3000, () => false);
    expect(wrong.accepted).toBe(false);
    expect(await store.head('inputs/j/in-2')).toBeNull();
    const long = await store.putStream('inputs/j/in-3', Readable.from([body, body]), 3000, () => true);
    expect(long.accepted).toBe(false);
    expect(await store.head('inputs/j/in-3')).toBeNull();

    const id = '00000000-0000-4000-8000-000000000001';
    const p1 = randomBytes(4096);
    const p2 = randomBytes(100);
    expect((await store.putPart(id, 1, Readable.from([p1]), 4096, sha(p1))).accepted).toBe(true);
    expect((await store.putPart(id, 2, Readable.from([randomBytes(100)]), 100, sha(p2))).accepted).toBe(
      false,
    );
    expect(await store.partsPresent(id, 2)).toEqual([1]);
    expect((await store.putPart(id, 2, Readable.from([p2]), 100, sha(p2))).accepted).toBe(true);
    const whole = Buffer.concat([p1, p2]);
    const r = await store.assemble(
      'artifacts/j/a/ws-big',
      id,
      2,
      { size: whole.length, sha256: sha(whole) },
      () => true,
    );
    expect(r.accepted).toBe(true);
    expect((await store.get('artifacts/j/a/ws-big', 10_000)).equals(whole)).toBe(true);
    expect(await readdir(join(dir, '.uploads')).catch(() => [])).not.toContain(id);
    const space = await store.space();
    expect(space.totalBytes).toBeGreaterThan(0);
    await writeFile(join(dir, 'probe'), 'x');
  });
});
