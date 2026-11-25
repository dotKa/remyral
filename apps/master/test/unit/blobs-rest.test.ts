import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATE_KINDS } from '../../src/blobs/migrate.js';
import { BLOB_KEY, BlobKeyError, LocalBlobStore } from '../../src/blobs/local.js';
import { S3Client } from '../../src/blobs/s3.js';
import {
  BLOB_KIND_PREFIX,
  BLOB_REFERENCES,
  blobKeys,
  type BlobKind,
  sameStore,
} from '../../src/blobs/store.js';
import { FakeS3 } from '../helpers/fake-s3.js';

/** p17-object-storage-rest (design note §13): key grammar of the four new kinds, streamed PUT, store identity. */

const creds = { accessKeyId: 'remyral-test-key', secretAccessKey: 'remyral-test-secret-0123456789' };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const UUID = '0b0f7c55-3c8e-4f53-9d6e-2f1e9b8a7c61';

describe('blob keys of the remaining tables', () => {
  it('the writers produce keys inside the grammar, under their kind prefix', () => {
    const keys: [BlobKind, string][] = [
      ['chat-attachment', blobKeys.chatAttachment(UUID, UUID)],
      ['workflow-file', blobKeys.workflowFile(UUID, 'in-abc123')],
      ['automation-file', blobKeys.automationFile(UUID, 'in-x9')],
      ['input-bundle', blobKeys.inputBundle(UUID, 17)],
    ];
    for (const [kind, key] of keys) {
      expect(BLOB_KEY.test(key), key).toBe(true);
      expect(key.startsWith(`${BLOB_KIND_PREFIX[kind]}/`)).toBe(true);
    }
    expect(blobKeys.inputBundle(UUID, 0)).toBe(`input-uploads/${UUID}/0`);
  });

  it('unknown prefixes and traversal stay refused by the local store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remyral-blobs-rest-'));
    try {
      const store = new LocalBlobStore(root);
      for (const bad of [
        'chat/x/y',
        'chat-attachments/../kits/x',
        'workflow-files/./a',
        '/abs/x',
        'automation-files',
      ]) {
        expect(() => store.path(bad), bad).toThrow(BlobKeyError);
      }
      const body = randomBytes(100);
      await store.put(blobKeys.chatAttachment(UUID, UUID), body);
      expect((await store.get(blobKeys.chatAttachment(UUID, UUID), 1000)).equals(body)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('every kind can be migrated and every new table is a GC reference', () => {
    expect([...MIGRATE_KINDS].sort()).toEqual(Object.keys(BLOB_KIND_PREFIX).sort());
    for (const t of [
      'chat_attachments',
      'workflow_run_files',
      'automation_files',
      'input_upload_files',
      'ide_extension_blobs',
    ]) {
      expect(BLOB_REFERENCES).toContain(t);
    }
  });

  it('store identity: local is one store; buckets differ by their store ref', () => {
    expect(sameStore('local', null, 'local', null)).toBe(true);
    expect(sameStore('s3', 'h/b/p', 's3', 'h/b/p')).toBe(true);
    expect(sameStore('s3', 'h/b/p', 's3', 'h/other/p')).toBe(false);
    expect(sameStore('local', null, 's3', 'h/b/p')).toBe(false);
  });
});

describe('S3 streamed PUT (blobs:migrate --to-store)', () => {
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

  it('streams a body of the declared length (signed, unsigned payload)', async () => {
    const body = randomBytes(300_000);
    const chunks = [body.subarray(0, 100_000), body.subarray(100_000, 250_000), body.subarray(250_000)];
    await client.putStream('chat-attachments/t/a', Readable.from(chunks), body.length, 'image/png');
    const stored = s3.objects.get('remyral/chat-attachments/t/a');
    expect(stored?.data.length).toBe(body.length);
    expect(sha(stored?.data ?? Buffer.alloc(0))).toBe(sha(body));
    expect(stored?.contentType).toBe('image/png');
  });

  it('a source stream that fails midway rejects the PUT (no hang, nothing stored)', async () => {
    const failing = new Readable({
      read() {
        this.push(randomBytes(1000));
        this.destroy(new Error('source read failed'));
      },
    });
    await expect(client.putStream('chat-attachments/t/b', failing, 5000)).rejects.toThrow();
    expect(s3.objects.has('remyral/chat-attachments/t/b')).toBe(false);
  });

  it('a provider error surfaces its code', async () => {
    s3.failNext = { status: 503, code: 'SlowDown' };
    await expect(
      client.putStream('chat-attachments/t/c', Readable.from([Buffer.from('x')]), 1),
    ).rejects.toMatchObject({ code: 'SlowDown', status: 503 });
  });
});
