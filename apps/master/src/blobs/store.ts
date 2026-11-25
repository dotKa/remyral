import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox, SecretBoxError } from '../auth/secret-box.js';
import type { Pool, Queryable } from '../db/pool.js';
import {
  configOf,
  limitsOf,
  s3ConfigOf,
  type StorageConfig,
  type StorageLimits,
  StoredKeys,
} from './config.js';
import { BLOB_KEY, BlobNotFoundError, LocalBlobStore } from './local.js';
import { S3Client, type S3Config, S3Error, storeRefOf } from './s3.js';

/**
 * p17-object-storage (docs/design/p17-object-storage.md): the master's blob store. New blobs (job outputs and inputs,
 * site uploads, worker releases and installer kits) go to the configured S3-compatible bucket, or to the master's
 * local blob directory when none is configured — never into Postgres. `blob_objects` records every blob (key, kind,
 * where it lives, size, SHA-256); rows of the owning tables point at it with `blob_key`.
 *
 * Write protocol: the `blob_objects` row is inserted first (autocommit), then the bytes are put, then the caller's
 * transaction sets its row's `blob_key`. A blob whose owner never committed (crash, rollback) is unreferenced and
 * the GC removes it after a grace period, like blobs whose rows were pruned or deleted.
 */

/** The few log calls the blob code makes (a Fastify logger, or the CLI's stderr writer). */
export interface BlobLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export type BlobKind =
  | 'artifact'
  | 'input'
  | 'site-upload'
  | 'release'
  | 'kit'
  // p17-object-storage-rest: the remaining bounded blobs.
  | 'chat-attachment'
  | 'workflow-file'
  | 'automation-file'
  | 'input-bundle'
  // p19-ide W3: verified Open VSX VSIX packages of the IDE extension allowlist.
  | 'ide-extension';
export type BlobLocation = 'local' | 's3';

export const BLOB_KIND_PREFIX: Readonly<Record<BlobKind, string>> = {
  artifact: 'artifacts',
  input: 'inputs',
  'site-upload': 'site-uploads',
  release: 'releases',
  kit: 'kits',
  'chat-attachment': 'chat-attachments',
  'workflow-file': 'workflow-files',
  'automation-file': 'automation-files',
  'input-bundle': 'input-uploads',
  'ide-extension': 'ide-extensions',
};

/** The blob key a writer uses for a row (shared with the writers so a migrated row looks like a new one). */
export const blobKeys = {
  chatAttachment: (threadId: string, id: string): string => `chat-attachments/${threadId}/${id}`,
  workflowFile: (runId: string, inputId: string): string => `workflow-files/${runId}/${inputId}`,
  automationFile: (automationId: string, inputId: string): string =>
    `automation-files/${automationId}/${inputId}`,
  inputBundle: (uploadId: string, idx: number): string => `input-uploads/${uploadId}/${String(idx)}`,
  ideExtension: (sha256: string): string => `ide-extensions/${sha256}`,
} as const;

/**
 * Every table whose rows point at a blob by `blob_key`. A blob none of them references (its row pruned, deleted with
 * its job / thread / run / automation / bundle, replaced, or never committed) is garbage for the GC.
 */
export const BLOB_REFERENCES: readonly string[] = [
  'job_artifacts',
  'job_inputs',
  'site_upload_files',
  'worker_releases',
  'worker_release_installer_kits',
  'chat_attachments',
  'workflow_run_files',
  'automation_files',
  'input_upload_files',
  // p19-ide W3: the cached VSIX of allowed extensions (removed from the allowlist → unreferenced → GC).
  'ide_extension_blobs',
];

/** SQL: the blob `o.key` is referenced by no row of {@link BLOB_REFERENCES}. */
const UNREFERENCED = BLOB_REFERENCES.map(
  (t) => `NOT EXISTS (SELECT 1 FROM ${t} r WHERE r.blob_key = o.key)`,
).join('\n          AND ');

/** Largest blob read whole into memory by `read()` (bigger ones are streamed or redirected). */
export const MAX_READ_BYTES = 128 * 1024 * 1024;
/** Unreferenced blobs younger than this are left alone (their owning row may still be committing). */
export const GC_GRACE_MS = 60 * 60_000;

export class BlobUnavailableError extends Error {
  constructor(
    readonly key: string,
    readonly reason: 'not_found' | 'store_unavailable' | 'store_changed',
    message: string,
  ) {
    super(message);
    this.name = 'BlobUnavailableError';
  }
}

/** A row's content: the legacy bytea, or a blob key (both null: pruned). */
export interface ContentRef {
  readonly content?: Buffer | null;
  readonly blob_key?: string | null;
}

export interface S3Active {
  readonly client: S3Client;
  readonly config: S3Config;
  readonly storeRef: string;
}

export interface BlobServiceDeps {
  readonly pool: Pool;
  readonly box: SecretBox;
  readonly clock: () => Date;
  readonly log: BlobLog;
  readonly audit?: AuditRecorder;
  /** The local blob directory (a volume; `BLOB_DATA_DIR`). */
  readonly localDir: string;
  /** Tests: extra CA / timeouts for the S3 client. */
  readonly s3?: { readonly ca?: string | Buffer; readonly timeoutMs?: number };
  /** Settings cache lifetime (other masters may change them); default 30 s. */
  readonly settingsTtlMs?: number;
}

interface SettingsRow {
  mode: BlobLocation;
  config: Record<string, unknown>;
  secret: Buffer | null;
  key_fingerprint: string | null;
  limits: Record<string, unknown>;
  last_test: Record<string, unknown> | null;
  last_test_at: Date | null;
  updated_at: Date;
}

export const STORAGE_AAD = 'object-storage';

/** Whether two (location, store_ref) pairs name the same store (a local blob has no store_ref). */
export function sameStore(
  a: BlobLocation,
  aRef: string | null,
  b: BlobLocation,
  bRef: string | null,
): boolean {
  return a === b && (a === 'local' || aRef === bRef);
}

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

interface CacheState {
  readonly at: number;
  readonly mode: BlobLocation;
  readonly s3: S3Active | null;
  readonly s3Error: string | null;
  readonly limits: StorageLimits;
}

export class BlobService {
  readonly local: LocalBlobStore;
  readonly #box: SecretBox;
  #cache: CacheState | null = null;
  #loading: Promise<void> | null = null;

  constructor(readonly deps: BlobServiceDeps) {
    this.local = new LocalBlobStore(deps.localDir);
    // Same sub-key as the other integration secrets (ADR-0028); the AAD binds the blob to this row.
    this.#box = new SecretBox(deps.box.deriveKey('ops-integrations'));
  }

  get box(): SecretBox {
    return this.#box;
  }

  async #row(): Promise<SettingsRow | null> {
    const { rows } = await this.deps.pool.query<SettingsRow>(
      `SELECT mode, config, secret, key_fingerprint, limits, last_test, last_test_at, updated_at
         FROM object_storage_settings WHERE id = 1`,
    );
    return rows[0] ?? null;
  }

  settingsRow(): Promise<SettingsRow | null> {
    return this.#row();
  }

  /** Decrypted keys of a settings row (null: none or undecryptable). */
  keysOf(secret: Buffer | null): StoredKeys | null {
    if (secret === null) return null;
    try {
      const parsed = StoredKeys.safeParse(
        JSON.parse(this.#box.decrypt(secret, STORAGE_AAD).toString('utf8')),
      );
      return parsed.success ? parsed.data : null;
    } catch (err) {
      if (err instanceof SecretBoxError || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  clientFor(config: StorageConfig, keys: StoredKeys): S3Client {
    return new S3Client({
      config: s3ConfigOf(config),
      credentials: keys,
      clock: this.deps.clock,
      ...(this.deps.s3?.ca === undefined ? {} : { ca: this.deps.s3.ca }),
      timeoutMs: this.deps.s3?.timeoutMs ?? 60_000,
    });
  }

  /** Re-reads the settings (after a panel change, or when the cache is older than its lifetime). */
  async refresh(): Promise<void> {
    const row = await this.#row();
    let s3: S3Active | null = null;
    let s3Error: string | null = null;
    // The bucket client is kept while settings + keys are stored, also in local mode: blobs written while the bucket
    // was selected stay readable (and deletable by the GC) after a switch back to local disk.
    if (row !== null && row.secret !== null) {
      const config = configOf(row.config);
      const keys = this.keysOf(row.secret);
      if (config === null) s3Error = 'the stored bucket settings are invalid';
      else if (keys === null) s3Error = 'the stored access keys cannot be decrypted (master key changed?)';
      else {
        try {
          const client = this.clientFor(config, keys);
          s3 = { client, config: client.config, storeRef: storeRefOf(client.config) };
        } catch (err) {
          s3Error = err instanceof Error ? err.message : 'invalid settings';
        }
      }
    }
    this.#cache = {
      at: Date.now(),
      mode: row?.mode ?? 'local',
      s3,
      s3Error,
      limits: limitsOf(row?.limits ?? {}),
    };
  }

  async #state(): Promise<CacheState> {
    const ttl = this.deps.settingsTtlMs ?? 30_000;
    if (this.#cache === null || Date.now() - this.#cache.at > ttl) {
      this.#loading ??= this.refresh().finally(() => {
        this.#loading = null;
      });
      await this.#loading;
    }
    if (this.#cache === null) throw new Error('blob settings not loaded');
    return this.#cache;
  }

  async limits(): Promise<StorageLimits> {
    return (await this.#state()).limits;
  }

  /** Where new blobs go now; `s3` without a usable client is an error (never silently local). */
  async target(): Promise<{ location: BlobLocation; s3: S3Active | null }> {
    const s = await this.#state();
    if (s.mode === 'local') return { location: 'local', s3: null };
    if (s.s3 === null) {
      throw new BlobUnavailableError(
        '',
        'store_unavailable',
        `Object storage is selected but not usable: ${s.s3Error ?? 'unknown error'}.`,
      );
    }
    return { location: 's3', s3: s.s3 };
  }

  /** The active S3 client (null in local mode or when unusable). */
  async activeS3(): Promise<S3Active | null> {
    return (await this.#state()).s3;
  }

  async modeInfo(): Promise<{ mode: BlobLocation; s3Error: string | null; storeRef: string | null }> {
    const s = await this.#state();
    return {
      mode: s.mode,
      s3Error: s.mode === 's3' ? s.s3Error : null,
      storeRef: s.mode === 's3' ? (s.s3?.storeRef ?? null) : null,
    };
  }

  /** Records a blob row (autocommit, before the bytes are put); returns its location. */
  async register(
    kind: BlobKind,
    key: string,
    size: number,
    sha256: string,
    target: { location: BlobLocation; s3: S3Active | null },
  ): Promise<void> {
    if (!BLOB_KEY.test(key) || !key.startsWith(`${BLOB_KIND_PREFIX[kind]}/`)) {
      throw new Error(`invalid ${kind} blob key ${key.slice(0, 80)}`);
    }
    await this.deps.pool.query(
      `INSERT INTO blob_objects (key, kind, location, store_ref, size_bytes, sha256, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET location = EXCLUDED.location, store_ref = EXCLUDED.store_ref,
         size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, created_at = EXCLUDED.created_at,
         verified_at = NULL`,
      [key, kind, target.location, target.s3?.storeRef ?? null, size, sha256, this.deps.clock()],
    );
  }

  /**
   * Stores `content` under `key` in the current store and records it (verified: the bytes are ours). Returns the key
   * for the caller's row. Throws BlobUnavailableError when object storage is selected but unusable.
   */
  async write(kind: BlobKind, key: string, content: Buffer, contentType?: string): Promise<string> {
    const target = await this.target();
    const sha = sha256Hex(content);
    await this.register(kind, key, content.length, sha, target);
    if (target.s3 !== null) await target.s3.client.put(key, content, contentType);
    else await this.local.put(key, content);
    await this.deps.pool.query('UPDATE blob_objects SET verified_at = $2 WHERE key = $1', [
      key,
      this.deps.clock(),
    ]);
    return key;
  }

  async #where(
    key: string,
    db: Queryable = this.deps.pool,
  ): Promise<{ location: BlobLocation; storeRef: string | null }> {
    const { rows } = await db.query<{ location: BlobLocation; store_ref: string | null }>(
      'SELECT location, store_ref FROM blob_objects WHERE key = $1',
      [key],
    );
    const r = rows[0];
    if (r === undefined) throw new BlobUnavailableError(key, 'not_found', `blob ${key} is not recorded`);
    return { location: r.location, storeRef: r.store_ref };
  }

  async #s3For(key: string, storeRef: string | null): Promise<S3Client> {
    const s3 = await this.activeS3();
    if (s3 === null) {
      throw new BlobUnavailableError(
        key,
        'store_unavailable',
        'This file is in object storage, which is not configured or not usable now.',
      );
    }
    if (storeRef !== null && storeRef !== s3.storeRef) {
      throw new BlobUnavailableError(
        key,
        'store_changed',
        'This file is in a bucket that is no longer the configured one.',
      );
    }
    return s3.client;
  }

  #wrap(key: string, err: unknown): never {
    if (err instanceof BlobUnavailableError) throw err;
    if (err instanceof BlobNotFoundError || (err instanceof S3Error && err.status === 404)) {
      throw new BlobUnavailableError(key, 'not_found', `blob ${key} is missing from the store`);
    }
    if (err instanceof S3Error) {
      throw new BlobUnavailableError(key, 'store_unavailable', `object storage: ${err.code}`);
    }
    throw err;
  }

  /** The whole blob (bounded; streams / redirects for anything bigger). */
  async read(key: string, maxBytes = MAX_READ_BYTES): Promise<Buffer> {
    const w = await this.#where(key);
    try {
      if (w.location === 'local') return await this.local.get(key, maxBytes);
      return await (await this.#s3For(key, w.storeRef)).get(key, maxBytes);
    } catch (err) {
      this.#wrap(key, err);
    }
  }

  /** A row's bytes: the legacy bytea, else its blob; null when pruned. */
  async readRow(r: ContentRef, maxBytes = MAX_READ_BYTES): Promise<Buffer | null> {
    if (r.content !== null && r.content !== undefined) return r.content;
    if (r.blob_key === null || r.blob_key === undefined) return null;
    return this.read(r.blob_key, maxBytes);
  }

  async range(key: string, offset: number, length: number): Promise<Buffer> {
    const w = await this.#where(key);
    try {
      if (w.location === 'local') return await this.local.range(key, offset, length);
      return await (await this.#s3For(key, w.storeRef)).range(key, offset, length);
    } catch (err) {
      this.#wrap(key, err);
    }
  }

  async stream(key: string): Promise<{ stream: Readable; size: number }> {
    const w = await this.#where(key);
    try {
      if (w.location === 'local') return await this.local.stream(key);
      return await (await this.#s3For(key, w.storeRef)).stream(key);
    } catch (err) {
      this.#wrap(key, err);
    }
  }

  /** A blob as a stream from a named store (blobs:migrate --to-store reads the copy it moves, not the row's). */
  async streamFrom(
    key: string,
    location: BlobLocation,
    storeRef: string | null,
  ): Promise<{ stream: Readable; size: number }> {
    try {
      if (location === 'local') return await this.local.stream(key);
      return await (await this.#s3For(key, storeRef)).stream(key);
    } catch (err) {
      this.#wrap(key, err);
    }
  }

  /** Where a blob lives (for the console: "S3'te" / "Diskte"). */
  async locationOf(key: string): Promise<BlobLocation | null> {
    const { rows } = await this.deps.pool.query<{ location: BlobLocation }>(
      'SELECT location FROM blob_objects WHERE key = $1',
      [key],
    );
    return rows[0]?.location ?? null;
  }

  /**
   * A download: a short-lived presigned GET with a forced attachment name (object storage), or the local file to
   * stream. `ttlSeconds` defaults to the owner's download TTL.
   */
  async download(
    key: string,
    file: { readonly disposition: string; readonly mediaType: string; readonly ttlSeconds?: number },
  ): Promise<{ kind: 'redirect'; url: string } | { kind: 'stream'; stream: Readable; size: number }> {
    const w = await this.#where(key);
    if (w.location === 'local') {
      try {
        return { kind: 'stream', ...(await this.local.stream(key)) };
      } catch (err) {
        this.#wrap(key, err);
      }
    }
    const client = await this.#s3For(key, w.storeRef);
    const ttl = file.ttlSeconds ?? (await this.limits()).downloadTtlSeconds;
    return {
      kind: 'redirect',
      url: client.presignGet(key, {
        expiresSeconds: ttl,
        disposition: file.disposition,
        contentType: file.mediaType,
      }),
    };
  }

  /** Deletes a blob from its store (GC; the row is removed by the caller). */
  async deleteObject(key: string, location: BlobLocation, storeRef: string | null): Promise<void> {
    if (location === 'local') {
      await this.local.delete(key);
      return;
    }
    const client = await this.#s3For(key, storeRef);
    await client.delete(key);
  }

  /**
   * GC: blobs no row references any more (pruned, deleted with their job / upload, or never committed), older than
   * the grace period, are deleted from their store and from `blob_objects`; expired upload grants first become
   * `expired` (their multipart uploads aborted). Bounded per pass; blobs whose store is unreachable stay for later.
   */
  async gc(
    maxBlobs = 500,
  ): Promise<{ deleted: number; bytes: number; failed: number; expiredUploads: number }> {
    const now = this.deps.clock();
    const expired = await this.deps.pool.query<{
      id: string;
      key: string;
      multipart_id: string | null;
      location: BlobLocation;
    }>(
      `UPDATE blob_uploads SET state = 'expired', reason = 'grant_expired', token_hash = NULL
        WHERE state IN ('granted', 'verifying') AND expires_at < $1
        RETURNING id::text AS id, key, multipart_id, location`,
      [new Date(now.getTime() - 15 * 60_000)],
    );
    for (const u of expired.rows) {
      if (u.location === 'local') await this.local.dropParts(u.id).catch(() => undefined);
      if (u.multipart_id === null || u.location !== 's3') continue;
      const s3 = await this.activeS3();
      await s3?.client.abortMultipart(u.key, u.multipart_id).catch((err: unknown) => {
        this.deps.log.warn({ err, key: u.key }, 'blob gc: aborting a multipart upload failed');
      });
    }
    const { rows } = await this.deps.pool.query<{
      key: string;
      location: BlobLocation;
      store_ref: string | null;
      size_bytes: string;
      prior_location: BlobLocation | null;
      prior_store_ref: string | null;
    }>(
      `SELECT o.key, o.location, o.store_ref, o.size_bytes, o.prior_location, o.prior_store_ref
         FROM blob_objects o
        WHERE o.created_at < $1
          AND ${UNREFERENCED}
          AND NOT EXISTS (SELECT 1 FROM blob_uploads u WHERE u.key = o.key
                            AND u.state IN ('granted', 'verifying', 'verified'))
        ORDER BY o.created_at LIMIT $2`,
      [new Date(now.getTime() - GC_GRACE_MS), maxBlobs],
    );
    let deleted = 0;
    let bytes = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await this.deleteObject(r.key, r.location, r.store_ref);
        // A copy left in the previous store by an interrupted `blobs:migrate --to-store` goes with it.
        if (
          r.prior_location !== null &&
          !sameStore(r.prior_location, r.prior_store_ref, r.location, r.store_ref)
        ) {
          await this.deleteObject(r.key, r.prior_location, r.prior_store_ref);
        }
      } catch (err) {
        failed++;
        this.deps.log.warn({ err, key: r.key }, 'blob gc: delete failed; kept for the next pass');
        continue;
      }
      const del = await this.deps.pool.query(
        `DELETE FROM blob_objects o WHERE o.key = $1
          AND ${UNREFERENCED}`,
        [r.key],
      );
      if ((del.rowCount ?? 0) > 0) {
        deleted++;
        bytes += Number(r.size_bytes);
      }
    }
    if (deleted > 0 || expired.rows.length > 0) {
      await this.deps.audit?.record({
        actor: { type: 'system', id: 'blob-gc' },
        action: 'blobs.gc',
        target: 'blobs',
        outcome: failed > 0 ? 'failure' : 'success',
        metadata: { deleted, bytes, failed, expiredUploads: expired.rows.length },
      });
    }
    return { deleted, bytes, failed, expiredUploads: expired.rows.length };
  }

  /** Counts and bytes per location (Doctor, Settings). */
  async usage(): Promise<{ location: BlobLocation; blobs: number; bytes: number }[]> {
    const { rows } = await this.deps.pool.query<{ location: BlobLocation; n: number; bytes: string }>(
      `SELECT location, count(*)::int AS n, coalesce(sum(size_bytes), 0)::text AS bytes
         FROM blob_objects GROUP BY location ORDER BY location`,
    );
    return rows.map((r) => ({ location: r.location, blobs: r.n, bytes: Number(r.bytes) }));
  }
}
