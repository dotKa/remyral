import { describe, expect, it } from 'vitest';
import {
  AssignedBlobUpload,
  BLOB_LIMITS,
  BLOB_UPLOAD_FEATURE,
  blobPartCount,
  blobUrlAllowed,
  BlobUploadGrantPayload,
  BlobUploadRequestPayload,
} from '../src/blob-uploads.js';
import { AssignJob } from '../src/master-messages.js';
import { ArtifactRef } from '../src/worker-messages.js';
import { WorkerFeature } from '../src/worker-features.js';
import {
  ArtifactName,
  contentMatchesType,
  downloadOnlyType,
  InputName,
  LARGE_MEDIA_TYPES,
  workspaceFileType,
} from '../src/workspace.js';
import { masterMessages, workerMessages } from './fixtures.js';

const UUID = '7b0c4f1e-1d2a-4c3b-9a8e-0f1e2d3c4b5a';

describe('blob uploads (p17-object-storage)', () => {
  it('feature and messages parse', () => {
    expect(WorkerFeature.safeParse(BLOB_UPLOAD_FEATURE).success).toBe(true);
    expect(workerMessages.BLOB_UPLOAD_REQUEST).toBeDefined();
    expect(masterMessages.BLOB_UPLOAD_GRANT).toBeDefined();
  });

  it('ARTIFACT_REF takes an optional blobUploadId; ASSIGN_JOB an optional execution.blobUpload', () => {
    const ref = ArtifactRef.parse({
      ...(workerMessages.ARTIFACT_REF as Record<string, unknown>),
      payload: {
        ...(workerMessages.ARTIFACT_REF as { payload: Record<string, unknown> }).payload,
        blobUploadId: UUID,
      },
    });
    expect(ref.payload.blobUploadId).toBe(UUID);
    const assign = masterMessages.ASSIGN_JOB as { payload: Record<string, unknown> };
    const parsed = AssignJob.parse({
      ...assign,
      payload: {
        ...assign.payload,
        execution: {
          hostExecutionOptIn: false,
          blobUpload: {
            thresholdBytes: BLOB_LIMITS.defaultThresholdBytes,
            maxFileBytes: BLOB_LIMITS.defaultFileBytes,
            maxJobBytes: BLOB_LIMITS.defaultJobBytes,
            maxFiles: 20,
            partBytes: BLOB_LIMITS.partBytes,
          },
        },
      },
    });
    expect(parsed.payload.execution?.blobUpload?.maxFileBytes).toBe(BLOB_LIMITS.defaultFileBytes);
  });

  it('limits are bounded by the 32-bit size column and S3 part rules', () => {
    expect(BLOB_LIMITS.ceilingFileBytes).toBe(2_147_483_647);
    expect(
      AssignedBlobUpload.safeParse({
        thresholdBytes: 1024 * 1024,
        maxFileBytes: BLOB_LIMITS.ceilingFileBytes + 1,
        maxJobBytes: 1,
        maxFiles: 1,
        partBytes: BLOB_LIMITS.partBytes,
      }).success,
    ).toBe(false);
    expect(blobPartCount(0, BLOB_LIMITS.partBytes)).toBe(0);
    expect(blobPartCount(BLOB_LIMITS.partBytes, BLOB_LIMITS.partBytes)).toBe(1);
    expect(blobPartCount(BLOB_LIMITS.ceilingFileBytes, BLOB_LIMITS.partBytes)).toBe(32);
    const req = {
      attemptId: 'att_01',
      epoch: 1,
      requestId: UUID,
      artifactId: 'ws-o1-abc',
      name: 'setup.msi',
      mediaType: 'application/x-msi',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
    };
    expect(BlobUploadRequestPayload.safeParse(req).success).toBe(true);
    expect(BlobUploadRequestPayload.safeParse({ ...req, artifactId: 'diff-1' }).success).toBe(false);
  });

  it('grant headers are restricted to authorization, content-type and x-amz-*', () => {
    const base = { attemptId: 'a', epoch: 1, requestId: UUID, status: 'ok' as const };
    expect(
      BlobUploadGrantPayload.safeParse({
        ...base,
        put: { url: 'https://x.example/y', headers: { 'x-amz-checksum-sha256': 'x' } },
      }).success,
    ).toBe(true);
    expect(
      BlobUploadGrantPayload.safeParse({
        ...base,
        put: { url: 'https://x.example/y', headers: { cookie: 'x' } },
      }).success,
    ).toBe(false);
  });

  it('grant URLs: https, or http to loopback only, never with credentials', () => {
    expect(blobUrlAllowed('https://acc.r2.cloudflarestorage.com/b/k?X-Amz-Signature=1')).toBe(true);
    expect(blobUrlAllowed('http://127.0.0.1:9000/b/k')).toBe(true);
    expect(blobUrlAllowed('http://minio.lan:9000/b/k')).toBe(false);
    expect(blobUrlAllowed('https://user:pw@x.example/k')).toBe(false);
    expect(blobUrlAllowed('file:///etc/passwd')).toBe(false);
    expect(blobUrlAllowed('not a url')).toBe(false);
  });

  it('large deliverable types: recognised, magic-checked, outputs only, download only', () => {
    for (const [name, mediaType] of [
      ['dist/setup.exe', 'application/vnd.microsoft.portable-executable'],
      ['Setup.MSI', 'application/x-msi'],
      ['App.dmg', 'application/x-apple-diskimage'],
      ['App.pkg', 'application/x-xar'],
      ['release.zip', 'application/zip'],
      ['data/export.tar.gz', 'application/gzip'],
      ['export.tgz', 'application/gzip'],
      ['demo.mp4', 'video/mp4'],
      ['demo.webm', 'video/webm'],
    ] as const) {
      const t = workspaceFileType(name);
      expect(t?.mediaType, name).toBe(mediaType);
      expect(t !== null && downloadOnlyType(t), name).toBe(true);
      expect(ArtifactName.safeParse(name).success, name).toBe(true);
      expect(InputName.safeParse(name.split('/').at(-1)).success, name).toBe(false);
      expect(LARGE_MEDIA_TYPES.has(mediaType)).toBe(true);
    }
    // `.gz` alone and a bare `.tar.gz` name stay refused.
    expect(workspaceFileType('x.gz')).toBeNull();
    expect(workspaceFileType('.tar.gz')).toBeNull();
    const b = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
    expect(contentMatchesType(b(0x4d, 0x5a, 0x90), 'application/vnd.microsoft.portable-executable')).toBe(
      true,
    );
    expect(contentMatchesType(b(0x7f, 0x45), 'application/vnd.microsoft.portable-executable')).toBe(false);
    expect(
      contentMatchesType(b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0), 'application/x-msi'),
    ).toBe(true);
    expect(contentMatchesType(b(0x78, 0x61, 0x72, 0x21), 'application/x-xar')).toBe(true);
    expect(contentMatchesType(b(0x50, 0x4b, 0x05, 0x06), 'application/zip')).toBe(true);
    expect(contentMatchesType(b(0x1f, 0x8b, 8), 'application/gzip')).toBe(true);
    expect(contentMatchesType(b(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70), 'video/mp4')).toBe(true);
    expect(contentMatchesType(b(0x1a, 0x45, 0xdf, 0xa3), 'video/webm')).toBe(true);
    expect(contentMatchesType(b(1), 'application/x-apple-diskimage')).toBe(true);
    expect(contentMatchesType(b(), 'application/x-apple-diskimage')).toBe(false);
  });
});
