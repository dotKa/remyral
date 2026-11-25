import { createHash } from 'node:crypto';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import {
  ArtifactName,
  contentMatchesType,
  MAX_ARTIFACT_BYTES,
  OUTPUT_LIMITS,
  workspaceFileType,
} from '@remyral/protocol';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { blobs } from '../blobs/registry.js';
import { artifactKey } from '../blobs/uploads.js';
import { withTransaction } from '../db/pool.js';
import { reserveStorage, StorageQuotaError } from '../workspaces/storage.js';
import type { GitProvider } from './types.js';

/**
 * p22-output-delivery (docs/design/p22-output-delivery.md §3): a repository job with `spec.delivery = "outputs"`
 * delivers the files its verified attempt added or changed as job outputs (`job_artifacts` kind `output`, the blob
 * store) — the same rows a workspace job's `out/` files become, so Çıktılar, the job's Dosyalar tab, "all.zip", the
 * chat result card and later jobs' inputs (continueFrom / inputArtifacts) see them. Nothing is merged.
 *
 * The files are read from the remote at the VERIFIED head (never from the worker's claim) through the provider's
 * read-only `blob` (text files, ≤ 5 MiB each). The rules of a workspace output apply: a safe relative name of at most
 * four segments, a known file type whose content matches it, text redacted by the master's secret rules, the project's
 * storage quota. What cannot be copied (removed, binary, too large, unknown type, unsafe name, over the limits) stays on
 * the attempt branch and is reported, never silently dropped.
 */

export const REPO_OUTPUT_LIMITS = {
  /** Files copied per attempt (the workspace default output limit). */
  maxFiles: OUTPUT_LIMITS.defaultMaxFiles,
  /** Largest file copied (what one provider read returns). */
  maxFileBytes: MAX_ARTIFACT_BYTES,
  /** Bytes copied per attempt. */
  maxTotalBytes: 64 * 1024 * 1024,
} as const;

export type DeliverySkipCode =
  'removed' | 'name' | 'type' | 'binary' | 'too_large' | 'missing' | 'limit' | 'quota';

export interface DeliveredOutputs {
  /** Files stored as outputs (this call or an earlier one for the same attempt). */
  readonly stored: number;
  readonly bytes: number;
  /** Text files whose content the master's secret rules changed. */
  readonly redacted: number;
  readonly skipped: readonly { readonly path: string; readonly code: DeliverySkipCode }[];
  /** The provider capped the list of changed files: files beyond it stay on the attempt branch only. */
  readonly listTruncated: boolean;
}

/** The artifact id of a delivered repository file: stable per path, so a retried verification stores nothing twice. */
export function repoOutputArtifactId(path: string): string {
  return `ws-repo-${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32)}`;
}

const redactor = new Redactor({ rules: DEFAULT_RULES });

export async function deliverRepoOutputs(
  deps: {
    readonly pool: pg.Pool;
    readonly audit: AuditRecorder | null;
    readonly clock: () => Date;
  },
  input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly project: string;
    readonly head: string;
    readonly files: readonly { readonly path: string; readonly status: string }[];
    readonly provider: Pick<GitProvider, 'blob'>;
    readonly truncated?: boolean;
  },
): Promise<DeliveredOutputs> {
  const read = input.provider.blob?.bind(input.provider);
  const skipped: { path: string; code: DeliverySkipCode }[] = [];
  let stored = 0;
  let bytes = 0;
  let redacted = 0;
  for (const f of input.files) {
    if (f.status === 'removed') {
      skipped.push({ path: f.path, code: 'removed' });
      continue;
    }
    if (!ArtifactName.safeParse(f.path).success) {
      skipped.push({ path: f.path, code: 'name' });
      continue;
    }
    const type = workspaceFileType(f.path);
    if (type === null || type.large === true) {
      skipped.push({ path: f.path, code: 'type' });
      continue;
    }
    // Only text is read back through the provider (its blob read classifies anything else as binary).
    if (!type.text) {
      skipped.push({ path: f.path, code: 'binary' });
      continue;
    }
    if (stored >= REPO_OUTPUT_LIMITS.maxFiles) {
      skipped.push({ path: f.path, code: 'limit' });
      continue;
    }
    if (read === undefined) throw new Error('the git provider cannot read files');
    const blob = await read(input.head, f.path, REPO_OUTPUT_LIMITS.maxFileBytes);
    if (blob === null) {
      skipped.push({ path: f.path, code: 'missing' });
      continue;
    }
    if (blob.state !== 'text') {
      skipped.push({ path: f.path, code: blob.state });
      continue;
    }
    const clean = redactor.redact(blob.text);
    const content = Buffer.from(clean, 'utf8');
    if (!contentMatchesType(content, type.mediaType)) {
      skipped.push({ path: f.path, code: 'type' });
      continue;
    }
    if (bytes + content.length > REPO_OUTPUT_LIMITS.maxTotalBytes) {
      skipped.push({ path: f.path, code: 'limit' });
      continue;
    }
    const artifactId = repoOutputArtifactId(f.path);
    const outcome = await storeOne(deps, input, {
      artifactId,
      name: f.path,
      mediaType: type.mediaType,
      content,
      redacted: clean !== blob.text,
    });
    if (outcome === 'quota') {
      skipped.push({ path: f.path, code: 'quota' });
      continue;
    }
    stored += 1;
    bytes += content.length;
    if (clean !== blob.text) redacted += 1;
  }
  return { stored, bytes, redacted, skipped, listTruncated: input.truncated === true };
}

async function storeOne(
  deps: { readonly pool: pg.Pool; readonly audit: AuditRecorder | null; readonly clock: () => Date },
  input: { readonly jobId: string; readonly attemptId: string; readonly project: string },
  file: {
    readonly artifactId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly content: Buffer;
    readonly redacted: boolean;
  },
): Promise<'ok' | 'quota'> {
  const done = await deps.pool.query(
    'SELECT 1 FROM job_artifacts WHERE attempt_id = $1 AND artifact_id = $2',
    [input.attemptId, file.artifactId],
  );
  if ((done.rowCount ?? 0) > 0) return 'ok';
  const key = await blobs().write(
    'artifact',
    artifactKey(input.jobId, input.attemptId, file.artifactId),
    file.content,
    file.mediaType,
  );
  const now = deps.clock();
  // The project's storage quota lock is transactional: one short transaction per file.
  return withTransaction(deps.pool, async (tx): Promise<'ok' | 'quota'> => {
    try {
      await reserveStorage(tx, input.project, file.content.length, now, deps.audit);
    } catch (err) {
      if (err instanceof StorageQuotaError) return 'quota';
      throw err;
    }
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', $8, NULL, $9, $10)
       ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [
        input.attemptId,
        input.jobId,
        file.artifactId,
        file.name,
        file.mediaType,
        file.content.length,
        createHash('sha256').update(file.content).digest('hex'),
        file.redacted,
        key,
        now,
      ],
    );
    return 'ok';
  });
}
