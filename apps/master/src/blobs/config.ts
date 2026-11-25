import { BLOB_LIMITS, MAX_ARTIFACT_BYTES } from '@remyral/protocol';
import { z } from 'zod';
import { isLoopback, type S3Config, type S3Provider } from './s3.js';

/**
 * p17-object-storage: the shapes of Settings → Integrations → Storage — where blobs go (`local` disk or an `s3`
 * bucket), the bucket's non-secret settings, the access keys (sealed, never returned) and the owner's limits.
 */

export const PROVIDERS = ['aws', 'r2', 'minio', 'other'] as const satisfies readonly S3Provider[];

export const BucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'bucket name (3–63 lower-case letters, digits, dots, hyphens)')
  .refine((b) => !b.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(b), 'bucket name');

export const Region = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'region (e.g. eu-central-1, auto)');

/** https URL without path, query or credentials (http only to this machine — local MinIO for tests). */
export const Endpoint = z
  .string()
  .max(300)
  .refine((v) => {
    if (v === '') return true;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false;
    }
    const plain =
      u.username === '' && u.password === '' && u.search === '' && u.hash === '' && /^\/?$/.test(u.pathname);
    return plain && (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname)));
  }, 'https:// address of the storage endpoint, without a path');

export const KeyPrefix = z
  .string()
  .max(200)
  .regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63}\/?){0,8}$/, 'prefix: segments of letters, digits, . _ - and /');

export const StorageConfig = z.strictObject({
  provider: z.enum(PROVIDERS),
  endpoint: Endpoint,
  region: Region,
  bucket: BucketName,
  pathStyle: z.boolean(),
  prefix: KeyPrefix,
  sse: z.enum(['none', 'AES256', 'aws:kms']),
  kmsKeyId: z
    .string()
    .max(2048)
    .regex(/^[A-Za-z0-9:/_.-]*$/, 'KMS key id or ARN'),
});
export type StorageConfig = z.infer<typeof StorageConfig>;

/** The stored config row (it also carries `keyIdHint`, the last four characters of the key id) as StorageConfig. */
export function configOf(raw: unknown): StorageConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { keyIdHint: _hint, ...rest } = raw as Record<string, unknown>;
  const parsed = StorageConfig.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

export const AccessKeyId = z.string().regex(/^[A-Za-z0-9._-]{3,128}$/, 'access key id');
export const SecretAccessKey = z.string().regex(/^[\x21-\x7e]{8,256}$/, 'secret access key');
export const StoredKeys = z.strictObject({ accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey });
export type StoredKeys = z.infer<typeof StoredKeys>;

export const STORAGE_LIMIT_BOUNDS = {
  maxFileBytes: { min: 1024 * 1024, max: BLOB_LIMITS.ceilingFileBytes },
  maxJobBytes: { min: 1024 * 1024, max: BLOB_LIMITS.ceilingJobBytes },
  thresholdBytes: { min: 64 * 1024, max: MAX_ARTIFACT_BYTES },
  downloadTtlSeconds: { min: 60, max: 3600 },
  shareMaxDays: { min: 1, max: 30 },
} as const;

export const StorageLimits = z.strictObject({
  maxFileBytes: z
    .number()
    .int()
    .min(STORAGE_LIMIT_BOUNDS.maxFileBytes.min)
    .max(STORAGE_LIMIT_BOUNDS.maxFileBytes.max),
  maxJobBytes: z
    .number()
    .int()
    .min(STORAGE_LIMIT_BOUNDS.maxJobBytes.min)
    .max(STORAGE_LIMIT_BOUNDS.maxJobBytes.max),
  thresholdBytes: z
    .number()
    .int()
    .min(STORAGE_LIMIT_BOUNDS.thresholdBytes.min)
    .max(STORAGE_LIMIT_BOUNDS.thresholdBytes.max),
  downloadTtlSeconds: z
    .number()
    .int()
    .min(STORAGE_LIMIT_BOUNDS.downloadTtlSeconds.min)
    .max(STORAGE_LIMIT_BOUNDS.downloadTtlSeconds.max),
  shareMaxDays: z
    .number()
    .int()
    .min(STORAGE_LIMIT_BOUNDS.shareMaxDays.min)
    .max(STORAGE_LIMIT_BOUNDS.shareMaxDays.max),
});
export type StorageLimits = z.infer<typeof StorageLimits>;

export const DEFAULT_LIMITS: StorageLimits = {
  maxFileBytes: BLOB_LIMITS.defaultFileBytes,
  maxJobBytes: BLOB_LIMITS.defaultJobBytes,
  thresholdBytes: BLOB_LIMITS.defaultThresholdBytes,
  downloadTtlSeconds: 300,
  shareMaxDays: 7,
};

/** Stored limits with defaults for missing or invalid fields (a row written by an older shape stays usable). */
export function limitsOf(raw: unknown): StorageLimits {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof StorageLimits)[]) {
    const v = o[k];
    const one = StorageLimits.shape[k].safeParse(v);
    if (one.success) out[k] = one.data;
  }
  if ((out.maxJobBytes ?? 0) < (out.maxFileBytes ?? 0)) out.maxJobBytes = out.maxFileBytes ?? 0;
  return out as unknown as StorageLimits;
}

/** Normalises a prefix to `a/b/` (or empty). */
export function normalisePrefix(p: string): string {
  const t = p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return t === '' ? '' : `${t}/`;
}

/** Provider defaults the panel pre-fills (R2: region `auto`, path-style; MinIO: path-style). */
export function providerDefaults(provider: S3Provider): Pick<S3Config, 'region' | 'pathStyle'> {
  switch (provider) {
    case 'r2':
      return { region: 'auto', pathStyle: true };
    case 'minio':
      return { region: 'us-east-1', pathStyle: true };
    case 'aws':
      return { region: 'eu-central-1', pathStyle: false };
    default:
      return { region: 'us-east-1', pathStyle: true };
  }
}

/** The S3 config of stored settings (endpoint required except for AWS). */
export function s3ConfigOf(c: StorageConfig): S3Config {
  return {
    provider: c.provider,
    endpoint: c.endpoint,
    region: c.region,
    bucket: c.bucket,
    pathStyle: c.pathStyle,
    prefix: normalisePrefix(c.prefix),
    sse: c.sse,
    kmsKeyId: c.kmsKeyId,
  };
}

/**
 * The least-privilege bucket policy for the access key (shown in the panel and in docs/guide/tr/depolama.md): object
 * read / write / delete and multipart under the prefix only — no bucket listing, no ACL or policy changes.
 */
export function leastPrivilegePolicy(bucket: string, prefix: string): Record<string, unknown> {
  const p = normalisePrefix(prefix);
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'RemyralBlobObjects',
        Effect: 'Allow',
        Action: [
          's3:PutObject',
          's3:GetObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        Resource: `arn:aws:s3:::${bucket}/${p}*`,
      },
    ],
  };
}
