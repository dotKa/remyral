import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AuditRecorder } from '../audit/audit.js';
import {
  AccessKeyId,
  configOf,
  DEFAULT_LIMITS,
  leastPrivilegePolicy,
  limitsOf,
  normalisePrefix,
  PROVIDERS,
  providerDefaults,
  SecretAccessKey,
  StorageConfig,
  StorageLimits,
  type StoredKeys,
} from './config.js';
import { S3Error, storeRefOf } from './s3.js';
import { type BlobLocation, type BlobService, STORAGE_AAD } from './store.js';

/**
 * p17-object-storage: Settings → Integrations → Storage ("Depolama"). The owner picks where blobs go — the master's
 * local disk or an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) — enters the bucket settings and access keys
 * (stored like every other integration secret, ADR-0028: AES-256-GCM under the HKDF sub-key `ops-integrations`, AAD
 * `object-storage`; never returned, logged, audited (only a fingerprint), sent to a worker or shown to the chat
 * assistant), and sets the limits. Switching to a bucket is refused unless a put / head / get / delete round trip with
 * the new settings succeeds. Blobs already stored stay where they are (each blob records its location).
 */

export class StorageSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StorageSettingsError';
  }
}

export interface StorageActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface StorageStatus {
  readonly mode: BlobLocation;
  readonly config: StorageConfig | null;
  readonly keyIdHint: string | null;
  readonly keyFingerprint: string | null;
  readonly usable: boolean;
  readonly problem: string | null;
  readonly limits: StorageLimits;
  readonly lastTest: Record<string, unknown> | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string;
  readonly usage: readonly {
    readonly location: BlobLocation;
    readonly blobs: number;
    readonly bytes: number;
  }[];
  /** Bytes still in Postgres (not yet moved by `blobs:migrate`). */
  readonly legacyBytes: number;
  readonly local: {
    readonly dir: string;
    readonly freeBytes: number | null;
    readonly totalBytes: number | null;
  };
  readonly options: {
    readonly providers: readonly string[];
    readonly defaults: Readonly<Record<string, { readonly region: string; readonly pathStyle: boolean }>>;
    readonly limitDefaults: StorageLimits;
  };
  readonly policy: Record<string, unknown> | null;
}

const fingerprint = (k: StoredKeys): string =>
  createHash('sha256').update(`${k.accessKeyId}:${k.secretAccessKey}`, 'utf8').digest('hex').slice(0, 16);

/** A short, actionable hint per S3 error code (never the provider's message). */
export function storageErrorHint(code: string, status: number | null): string {
  switch (code) {
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
    case 'AuthorizationHeaderMalformed':
    case 'InvalidToken':
      return 'The provider does not accept the access key: check the access key id, the secret and the region.';
    case 'AccessDenied':
      return 'The key is valid but may not use this bucket or prefix: attach the policy below to the key.';
    case 'NoSuchBucket':
      return 'The bucket does not exist at this endpoint / region: check the bucket name, endpoint and region.';
    case 'PermanentRedirect':
    case 'AuthorizationQueryParametersError':
      return 'The bucket is in another region: set the bucket region.';
    case 'NetworkError':
    case 'Timeout':
      return 'The endpoint did not answer: check the address and the network path from the master.';
    case 'InvalidEndpoint':
      return 'The endpoint must be an https:// address (R2: https://<account id>.r2.cloudflarestorage.com).';
    case 'ChecksumMismatch':
      return 'The object read back differs from what was written: the endpoint or a proxy changes data.';
    default:
      return status !== null && status >= 500
        ? 'The storage provider had a server error: try again later.'
        : 'The test failed; the error code above names the cause.';
  }
}

export class StorageSettings {
  constructor(
    private readonly deps: {
      readonly blobs: BlobService;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly pool: BlobService['deps']['pool'];
    },
  ) {}

  async status(): Promise<StorageStatus> {
    const row = await this.deps.blobs.settingsRow();
    const cfg = row === null ? null : configOf(row.config);
    const keys = row === null ? null : this.deps.blobs.keysOf(row.secret);
    const info = await this.deps.blobs.modeInfo();
    const space = await this.deps.blobs.local.space().catch(() => null);
    const legacy = await this.deps.pool.query<{ n: string }>(
      `SELECT (coalesce((SELECT sum(size_bytes) FROM job_artifacts WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM job_inputs WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM site_upload_files WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM worker_releases WHERE artifact IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM worker_release_installer_kits WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM chat_attachments WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM workflow_run_files WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM automation_files WHERE content IS NOT NULL), 0)
             + coalesce((SELECT sum(size_bytes) FROM input_upload_files WHERE content IS NOT NULL), 0))::text AS n`,
    );
    const hint = row !== null && typeof row.config.keyIdHint === 'string' ? row.config.keyIdHint : null;
    return {
      mode: row?.mode ?? 'local',
      config: cfg,
      keyIdHint: hint,
      keyFingerprint: row?.key_fingerprint ?? null,
      usable: (row?.mode ?? 'local') === 'local' || (cfg !== null && keys !== null && info.s3Error === null),
      problem: info.s3Error,
      limits: limitsOf(row?.limits ?? {}),
      lastTest: row?.last_test ?? null,
      lastTestAt: row?.last_test_at?.toISOString() ?? null,
      updatedAt: (row?.updated_at ?? this.deps.clock()).toISOString(),
      usage: await this.deps.blobs.usage(),
      legacyBytes: Number(legacy.rows[0]?.n ?? 0),
      local: {
        dir: this.deps.blobs.local.root,
        freeBytes: space?.freeBytes ?? null,
        totalBytes: space?.totalBytes ?? null,
      },
      options: {
        providers: [...PROVIDERS],
        defaults: Object.fromEntries(PROVIDERS.map((p) => [p, providerDefaults(p)])),
        limitDefaults: DEFAULT_LIMITS,
      },
      policy: cfg === null ? null : leastPrivilegePolicy(cfg.bucket, cfg.prefix),
    };
  }

  /**
   * A put / head / get / delete round trip of a small random object under the prefix. Never stores anything that
   * outlives the test; returns latency and the error code + hint on failure (no secrets, no provider message).
   */
  async roundTrip(config: StorageConfig, keys: StoredKeys): Promise<Record<string, unknown>> {
    const started = performance.now();
    const key = `artifacts/remyral-storage-test-${randomBytes(8).toString('hex')}`;
    const body = randomBytes(1024);
    let step = 'put';
    try {
      const client = this.deps.blobs.clientFor(config, keys);
      await client.put(key, body, 'application/octet-stream');
      step = 'head';
      const head = await client.head(key);
      if (head?.size !== body.length) throw new S3Error('ChecksumMismatch', 200, 'size differs');
      step = 'get';
      const back = await client.get(key, 4096);
      if (!back.equals(body)) throw new S3Error('ChecksumMismatch', 200, 'content differs');
      step = 'delete';
      await client.delete(key);
      return {
        ok: true,
        provider: config.provider,
        bucket: config.bucket,
        store: storeRefOf(client.config),
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      const code = err instanceof S3Error ? err.code : 'UnexpectedError';
      const httpStatus = err instanceof S3Error ? err.status : null;
      return {
        ok: false,
        provider: config.provider,
        bucket: config.bucket,
        step,
        error: code,
        httpStatus,
        latencyMs: Math.round(performance.now() - started),
        hint: storageErrorHint(code, httpStatus),
      };
    }
  }

  /**
   * Save: mode, bucket settings, (first time: required) new keys, and the limits. Keys omitted keep the stored ones.
   * Choosing `s3` runs the round trip first and refuses to switch when it fails (the result is returned).
   */
  async save(
    actor: StorageActor,
    input: {
      readonly mode: unknown;
      readonly config?: unknown;
      readonly accessKeyId?: string | undefined;
      readonly secretAccessKey?: string | undefined;
      readonly limits?: unknown;
    },
  ): Promise<StorageStatus> {
    const mode = input.mode === 's3' ? 's3' : input.mode === 'local' ? 'local' : null;
    if (mode === null) throw new StorageSettingsError(400, 'invalid_storage', 'Choose local disk or S3.');
    const limits = input.limits === undefined ? null : StorageLimits.safeParse(input.limits);
    if (limits !== null && !limits.success) {
      throw new StorageSettingsError(400, 'invalid_storage_limits', 'A limit is out of range.');
    }
    if (limits?.success === true && limits.data.maxJobBytes < limits.data.maxFileBytes) {
      throw new StorageSettingsError(
        400,
        'invalid_storage_limits',
        'The per-job limit must be at least the per-file limit.',
      );
    }
    const existing = await this.deps.blobs.settingsRow();
    const existingKeys = existing === null ? null : this.deps.blobs.keysOf(existing.secret);
    let config: StorageConfig | null = null;
    if (input.config !== undefined && input.config !== null) {
      const raw = input.config as Record<string, unknown>;
      const parsed = StorageConfig.safeParse({
        ...raw,
        prefix: typeof raw.prefix === 'string' ? normalisePrefix(raw.prefix) : raw.prefix,
      });
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join('.') ?? 'config';
        throw new StorageSettingsError(400, 'invalid_storage', `Invalid storage setting: ${field}.`);
      }
      if (parsed.data.provider !== 'aws' && parsed.data.endpoint === '') {
        throw new StorageSettingsError(
          400,
          'invalid_storage',
          'Enter the endpoint address of the storage provider.',
        );
      }
      config = parsed.data;
    } else if (existing !== null) {
      config = configOf(existing.config);
    }
    const hasId = input.accessKeyId !== undefined && input.accessKeyId !== '';
    const hasSecret = input.secretAccessKey !== undefined && input.secretAccessKey !== '';
    if (hasId !== hasSecret) {
      throw new StorageSettingsError(400, 'keys_incomplete', 'Enter both the access key id and the secret.');
    }
    let keys: StoredKeys | null = null;
    if (hasId) {
      const id = AccessKeyId.safeParse(input.accessKeyId.trim());
      const secret = SecretAccessKey.safeParse(input.secretAccessKey?.trim());
      if (!id.success) throw new StorageSettingsError(400, 'invalid_access_key_id', 'Invalid access key id.');
      if (!secret.success) {
        throw new StorageSettingsError(400, 'invalid_secret_access_key', 'Invalid secret access key.');
      }
      keys = { accessKeyId: id.data, secretAccessKey: secret.data };
    }
    const effectiveKeys = keys ?? existingKeys;
    let test: Record<string, unknown> | null = null;
    if (mode === 's3') {
      if (config === null)
        throw new StorageSettingsError(400, 'invalid_storage', 'Enter the bucket settings.');
      if (effectiveKeys === null) {
        throw new StorageSettingsError(400, 'keys_required', 'Enter the access key id and the secret.');
      }
      test = await this.roundTrip(config, effectiveKeys);
      if (test.ok !== true) {
        await this.#audit(actor, 'storage.settings.save', 'failure', { mode, test: summary(test) });
        throw new StorageSettingsError(
          400,
          'storage_test_failed',
          'The bucket did not pass the round trip; nothing was changed.',
          test,
        );
      }
    }
    const stored =
      config === null ? {} : { ...config, keyIdHint: (keys ?? existingKeys)?.accessKeyId.slice(-4) ?? '' };
    const secret =
      keys === null
        ? null
        : this.deps.blobs.box.encrypt(Buffer.from(JSON.stringify(keys), 'utf8'), STORAGE_AAD);
    const fp = keys === null ? (existing?.key_fingerprint ?? null) : fingerprint(keys);
    const now = this.deps.clock();
    const nextLimits = limits?.success === true ? limits.data : limitsOf(existing?.limits ?? {});
    await this.deps.pool.query(
      `INSERT INTO object_storage_settings (id, mode, config, secret, key_fingerprint, limits, last_test, last_test_at,
                                            updated_by, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, config = EXCLUDED.config,
         secret = EXCLUDED.secret, key_fingerprint = EXCLUDED.key_fingerprint,
         limits = EXCLUDED.limits,
         last_test = COALESCE(EXCLUDED.last_test, object_storage_settings.last_test),
         last_test_at = COALESCE(EXCLUDED.last_test_at, object_storage_settings.last_test_at),
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      // The candidate row must satisfy the table's checks on its own (the row's secret is kept when none is new).
      [
        mode,
        stored,
        secret ?? existing?.secret ?? null,
        fp,
        nextLimits,
        test,
        test === null ? null : now,
        actor.userId,
        now,
      ],
    );
    await this.#audit(actor, 'storage.settings.save', 'success', {
      mode,
      previousMode: existing?.mode ?? 'local',
      provider: config?.provider ?? null,
      bucket: config?.bucket ?? null,
      endpointHost: config === null || config.endpoint === '' ? null : new URL(config.endpoint).host,
      sse: config?.sse ?? null,
      keyFingerprint: fp,
      keyChanged: keys !== null,
      previousKeyFingerprint: existing?.key_fingerprint ?? null,
      limits: nextLimits,
    });
    await this.deps.blobs.refresh();
    return this.status();
  }

  /** "Bağlantıyı test et" with the stored settings (stored and audited). */
  async test(actor: StorageActor): Promise<Record<string, unknown>> {
    const row = await this.deps.blobs.settingsRow();
    let result: Record<string, unknown>;
    if (row === null || row.mode === 'local') {
      const key = `artifacts/remyral-storage-test-${randomBytes(8).toString('hex')}`;
      const started = performance.now();
      try {
        const body = randomBytes(1024);
        await this.deps.blobs.local.put(key, body);
        const back = await this.deps.blobs.local.get(key, 4096);
        await this.deps.blobs.local.delete(key);
        const space = await this.deps.blobs.local.space();
        result = back.equals(body)
          ? {
              ok: true,
              mode: 'local',
              freeBytes: space.freeBytes,
              latencyMs: Math.round(performance.now() - started),
            }
          : {
              ok: false,
              mode: 'local',
              error: 'ChecksumMismatch',
              hint: storageErrorHint('ChecksumMismatch', null),
            };
      } catch (err) {
        result = {
          ok: false,
          mode: 'local',
          error: (err as NodeJS.ErrnoException).code ?? 'LocalDiskError',
          hint: 'The master cannot write its blob directory: check the volume (BLOB_DATA_DIR) and its permissions.',
        };
      }
    } else {
      const config = configOf(row.config);
      const keys = this.deps.blobs.keysOf(row.secret);
      result =
        config === null || keys === null
          ? {
              ok: false,
              error: 'KeysUnusable',
              hint: 'The stored settings or keys cannot be read (master key changed?) — enter them again.',
            }
          : await this.roundTrip(config, keys);
    }
    await this.deps.pool.query(
      'UPDATE object_storage_settings SET last_test = $1, last_test_at = $2 WHERE id = 1',
      [result, this.deps.clock()],
    );
    await this.#audit(
      actor,
      'storage.settings.test',
      result.ok === true ? 'success' : 'failure',
      summary(result),
    );
    return result;
  }

  async #audit(
    actor: StorageActor,
    action: string,
    outcome: 'success' | 'failure',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action,
      target: 'object-storage',
      outcome,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata,
    });
  }
}

function summary(r: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: r.ok === true,
    error: r.error ?? null,
    step: r.step ?? null,
    httpStatus: r.httpStatus ?? null,
    latencyMs: r.latencyMs ?? null,
  };
}
