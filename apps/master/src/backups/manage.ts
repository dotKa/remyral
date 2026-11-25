import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBoxError } from '../auth/secret-box.js';
import {
  AccessKeyId,
  BucketName,
  Endpoint,
  normalisePrefix,
  PROVIDERS,
  Region,
  SecretAccessKey,
} from '../blobs/config.js';
import type { StorageConfig, StoredKeys } from '../blobs/config.js';
import type { StorageSettings } from '../blobs/settings.js';
import type { BlobService } from '../blobs/store.js';
import { type Pool, withTransaction } from '../db/pool.js';
import type { HostBackupSettings } from '../host-actions/files.js';
import {
  type ApplierView,
  BACKUP_ID,
  HostActionError,
  type HostActionActor,
  type HostActionService,
  type HostActionView,
} from '../host-actions/service.js';
import type { BackupStatusService } from './service.js';

/**
 * p17-host-actions part 3 (docs/design/p17-host-actions.md §5): backups managed from Ayarlar → Yedekler. Everything
 * that changes the host — a backup now, a restore drill, a restore, the schedule / retention / drill / WAL archiving /
 * encryption recipients, the off-site target — is a signed request the remyral-ctl host applier carries out. The
 * settings are applied **into stack.env and backup-config/** by the host (the backup service keeps reading its
 * environment and files; nothing new to trust in the backup image); what the host applies is reported back in its
 * heartbeat. The off-site keys are stored sealed here (like the storage integration) and tested with the same
 * put / head / get / delete round trip before anything is sent to the host.
 */

export type BackupManageCode =
  | 'invalid_backup_settings'
  | 'backup_recipients_too_few'
  | 'invalid_offsite'
  | 'offsite_keys_required'
  | 'offsite_test_failed'
  | 'backup_not_found';

export class BackupManageError extends Error {
  constructor(
    readonly code: BackupManageCode,
    message: string,
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BackupManageError';
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** The runner's off-site prefix rule (infra/backup/runner/lib/naming.mjs PREFIX_RE). */
const OFFSITE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}){0,4}$/;

export const BackupConfigInput = z.strictObject({
  time: z.union([z.string().regex(HHMM), z.literal('')]),
  intervalMinutes: z.number().int().min(15).max(10080).nullable(),
  keepDaily: z.number().int().min(0).max(366).nullable(),
  keepWeekly: z.number().int().min(0).max(520).nullable(),
  keepMonthly: z.number().int().min(0).max(120).nullable(),
  keepRecentHours: z.number().int().min(0).max(744).nullable(),
  drillEnabled: z.boolean(),
  drillWeekday: z.enum(WEEKDAYS),
  drillTime: z.union([z.string().regex(HHMM), z.literal('')]),
  walArchive: z.boolean(),
  recipients: z.array(z.string().max(80)).max(10),
});
export type BackupConfigInput = z.infer<typeof BackupConfigInput>;

export const OffsiteInput = z.strictObject({
  provider: z.enum(PROVIDERS),
  endpoint: Endpoint,
  region: Region,
  bucket: BucketName,
  prefix: z.string().max(200),
  pathStyle: z.boolean(),
  accessKeyId: z.string().max(200).optional(),
  secretAccessKey: z.string().max(300).optional(),
  /** Use the access keys of Ayarlar → Entegrasyonlar → Depolama (the same S3 account, another prefix). */
  useStorageKeys: z.boolean().optional(),
});
export type OffsiteInput = z.infer<typeof OffsiteInput>;

interface OffsiteConfig {
  readonly provider: (typeof PROVIDERS)[number];
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly pathStyle: boolean;
}

interface OffsiteRow {
  config: OffsiteConfig;
  secret: Buffer;
  key_fingerprint: string;
  key_id_hint: string;
  last_test: Record<string, unknown> | null;
  last_test_at: Date | null;
  updated_at: Date;
}

export interface OffsiteView {
  readonly config: OffsiteConfig | null;
  readonly keyIdHint: string | null;
  readonly keyFingerprint: string | null;
  readonly lastTest: Record<string, unknown> | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string | null;
  /** Ayarlar → Entegrasyonlar → Depolama has S3 keys that could be reused. */
  readonly storageKeysAvailable: boolean;
}

export interface BackupManageView {
  readonly applier: ApplierView;
  /** What the host applies now (null: no applier / an older one). */
  readonly settings: HostBackupSettings | null;
  readonly offsite: OffsiteView;
  readonly open: HostActionView | null;
  readonly recent: readonly HostActionView[];
}

export const BACKUP_KINDS = [
  'backup-run',
  'backup-drill',
  'backup-restore',
  'backup-config',
  'backup-offsite',
  'backup-change-cancel',
];
const OFFSITE_AAD = 'backup-offsite';
const UNSAFE = /["\\]/;

const fingerprint = (k: StoredKeys): string =>
  createHash('sha256').update(`${k.accessKeyId}:${k.secretAccessKey}`, 'utf8').digest('hex').slice(0, 16);

/** The owner's words as the host's backup reason: lower-case ASCII letters, digits and `-` (at most 40). */
export function reasonSlug(text: string): string {
  const s = text
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s === '' ? 'manual' : s;
}

export class BackupManageService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly host: HostActionService;
      readonly blobs: BlobService;
      readonly storage: StorageSettings;
      readonly status: BackupStatusService;
      readonly log?: { warn(obj: unknown, msg: string): void };
    },
  ) {}

  private async offsiteRow(): Promise<OffsiteRow | null> {
    const { rows } = await this.deps.pool.query<OffsiteRow>(
      `SELECT config, secret, key_fingerprint, key_id_hint, last_test, last_test_at, updated_at
         FROM backup_offsite_settings WHERE id = 1`,
    );
    return rows[0] ?? null;
  }

  private keysOf(secret: Buffer): StoredKeys | null {
    try {
      const v: unknown = JSON.parse(this.deps.blobs.box.decrypt(secret, OFFSITE_AAD).toString('utf8'));
      const o = v as { accessKeyId?: unknown; secretAccessKey?: unknown };
      return typeof o.accessKeyId === 'string' && typeof o.secretAccessKey === 'string'
        ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey }
        : null;
    } catch (err) {
      if (err instanceof SecretBoxError || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private async storageKeys(): Promise<StoredKeys | null> {
    const row = await this.deps.blobs.settingsRow();
    return row === null ? null : this.deps.blobs.keysOf(row.secret);
  }

  async view(): Promise<BackupManageView> {
    const s = await this.deps.host.status(BACKUP_KINDS);
    const { info } = await this.deps.host.applierInfo();
    const row = await this.offsiteRow();
    return {
      applier: s.applier,
      settings: info?.backup ?? null,
      offsite: {
        config: row?.config ?? null,
        keyIdHint: row?.key_id_hint ?? null,
        keyFingerprint: row?.key_fingerprint ?? null,
        lastTest: row?.last_test ?? null,
        lastTestAt: row?.last_test_at?.toISOString() ?? null,
        updatedAt: row?.updated_at.toISOString() ?? null,
        storageKeysAvailable: (await this.storageKeys()) !== null,
      },
      open: s.open,
      recent: s.recent,
    };
  }

  /** "Şimdi yedek al" with the owner's reason (kept in the audit trail; the host gets a slug of it). */
  run(actor: HostActionActor, reason: string): Promise<HostActionView> {
    const text = reason.trim().slice(0, 200);
    const slug = reasonSlug(text === '' ? 'manual' : `panel ${text}`);
    return this.deps.host.submit(actor, 'backup-run', { reason: slug }, { reason: text, hostReason: slug });
  }

  /** A restore drill now (into a throw-away database; the live one is untouched). */
  async drill(actor: HostActionActor, backupId: string | null): Promise<HostActionView> {
    if (backupId !== null) await this.knownBackup(backupId);
    return this.deps.host.submit(actor, 'backup-drill', { backupId: backupId ?? '' }, { backupId });
  }

  private async knownBackup(
    id: string,
  ): Promise<{ finishedAt: string | null; schemaVersion: string | null }> {
    if (!BACKUP_ID.test(id)) throw new HostActionError('invalid_backup_id', 'Not a backup id.');
    const o = await this.deps.status.overview();
    if (o.status === null) return { finishedAt: null, schemaVersion: null };
    const b = o.status.backups.find((x) => x.runId === id);
    if (b === undefined || b.outcome === 'failed') {
      throw new BackupManageError(
        'backup_not_found',
        'There is no usable backup with this id on the server.',
      );
    }
    return { finishedAt: b.finishedAt, schemaVersion: b.schemaVersion };
  }

  /** Replaces the live database with a backup — destructive: the owner types the backup id as confirmation. */
  async restore(
    actor: HostActionActor,
    input: { readonly backupId: string; readonly confirm: string },
  ): Promise<HostActionView> {
    const b = await this.knownBackup(input.backupId);
    if (input.confirm !== input.backupId) {
      throw new HostActionError(
        'restore_confirmation_required',
        'Restoring the database needs the backup and its id typed again as confirmation.',
      );
    }
    return this.deps.host.submit(
      actor,
      'backup-restore',
      { backupId: input.backupId, restoreDatabase: 'yes' },
      { backupId: input.backupId, backupFinishedAt: b.finishedAt, backupSchema: b.schemaVersion },
    );
  }

  /** Schedule, retention, drill, WAL archiving and the encryption recipients (at least two kept). */
  async configure(actor: HostActionActor, raw: unknown): Promise<HostActionView> {
    const p = BackupConfigInput.safeParse(raw);
    if (!p.success) {
      const field = p.error.issues[0]?.path.join('.') ?? 'settings';
      throw new BackupManageError('invalid_backup_settings', `Invalid backup setting: ${field}.`);
    }
    const c = p.data;
    if (c.keepDaily === 0 && c.keepWeekly === 0 && c.keepMonthly === 0) {
      throw new BackupManageError(
        'invalid_backup_settings',
        'Invalid backup setting: the retention keeps nothing.',
      );
    }
    const recipients = [...new Set(c.recipients.map((r) => r.trim()).filter((r) => r !== ''))];
    if (recipients.some((r) => !AGE_RECIPIENT.test(r))) {
      throw new BackupManageError(
        'invalid_backup_settings',
        'Invalid backup setting: recipients (age1… public keys).',
      );
    }
    if (recipients.length < 2) {
      throw new BackupManageError(
        'backup_recipients_too_few',
        'Keep at least two encryption recipients (a second key in case one is lost).',
      );
    }
    const n = (v: number | null): string => (v === null ? '' : String(v));
    const fields = {
      time: c.time,
      intervalMinutes: n(c.intervalMinutes),
      keepDaily: n(c.keepDaily),
      keepWeekly: n(c.keepWeekly),
      keepMonthly: n(c.keepMonthly),
      keepRecentHours: n(c.keepRecentHours),
      drillEnabled: c.drillEnabled ? 'true' : 'false',
      drillWeekday: c.drillWeekday,
      drillTime: c.drillTime,
      walArchive: c.walArchive ? 'on' : 'off',
      recipients: recipients.join(','),
    };
    return this.deps.host.submit(actor, 'backup-config', fields, {
      ...fields,
      recipients: recipients.length,
    });
  }

  /**
   * p17-panel-settings Part 0: withdraws a recipient / off-site change waiting for the host time lock ("İptal et").
   * Only ever makes the host do less: it cannot apply or shorten a change.
   */
  async cancelChange(
    actor: HostActionActor,
    change: 'recipients' | 'offsite' | 'all',
  ): Promise<HostActionView> {
    return this.deps.host.submit(actor, 'backup-change-cancel', { change }, { change });
  }

  private parseOffsite(raw: unknown): { input: OffsiteInput; config: OffsiteConfig } {
    const p = OffsiteInput.safeParse(raw);
    if (!p.success) {
      const field = p.error.issues[0]?.path.join('.') ?? 'offsite';
      throw new BackupManageError('invalid_offsite', `Invalid off-site setting: ${field}.`);
    }
    const i = p.data;
    const prefix = i.prefix.trim().replace(/^\/+|\/+$/g, '');
    if (prefix !== '' && !OFFSITE_PREFIX.test(prefix)) {
      throw new BackupManageError('invalid_offsite', 'Invalid off-site setting: prefix.');
    }
    if (i.provider !== 'aws' && i.endpoint === '') {
      throw new BackupManageError(
        'invalid_offsite',
        'Invalid off-site setting: endpoint (needed for R2 / MinIO).',
      );
    }
    return {
      input: i,
      config: {
        provider: i.provider,
        endpoint: i.endpoint.replace(/\/$/, ''),
        region: i.region,
        bucket: i.bucket,
        prefix,
        pathStyle: i.pathStyle,
      },
    };
  }

  private async keysFor(input: OffsiteInput, row: OffsiteRow | null): Promise<StoredKeys> {
    if (input.accessKeyId !== undefined || input.secretAccessKey !== undefined) {
      const k = AccessKeyId.safeParse(input.accessKeyId);
      const s = SecretAccessKey.safeParse(input.secretAccessKey);
      if (!k.success)
        throw new BackupManageError('invalid_offsite', 'Invalid off-site setting: accessKeyId.');
      if (!s.success || UNSAFE.test(s.data)) {
        throw new BackupManageError('invalid_offsite', 'Invalid off-site setting: secretAccessKey.');
      }
      return { accessKeyId: k.data, secretAccessKey: s.data };
    }
    if (input.useStorageKeys === true) {
      const k = await this.storageKeys();
      if (k === null)
        throw new BackupManageError(
          'offsite_keys_required',
          'Enter the access keys for the off-site target.',
        );
      if (UNSAFE.test(k.secretAccessKey)) {
        throw new BackupManageError('invalid_offsite', 'Invalid off-site setting: secretAccessKey.');
      }
      return k;
    }
    const k = row === null ? null : this.keysOf(row.secret);
    if (k === null)
      throw new BackupManageError('offsite_keys_required', 'Enter the access keys for the off-site target.');
    return k;
  }

  private storageConfig(c: OffsiteConfig): StorageConfig {
    return {
      provider: c.provider,
      endpoint: c.endpoint,
      region: c.region,
      bucket: c.bucket,
      pathStyle: c.pathStyle,
      prefix: normalisePrefix(c.prefix === '' ? 'remana' : c.prefix),
      sse: 'none',
      kmsKeyId: '',
    };
  }

  /** The storage integration's round trip (put / head / get / delete under the prefix) — nothing stored. */
  async testOffsite(raw: unknown): Promise<Record<string, unknown>> {
    const { input, config } = this.parseOffsite(raw);
    const keys = await this.keysFor(input, await this.offsiteRow());
    return this.deps.storage.roundTrip(this.storageConfig(config), keys);
  }

  /**
   * Tests, stores (sealed) and — with a host applier — hands the target to the host. A failed test stores nothing.
   * Returns the request (null without an applier: the operator writes backup-config/offsite.env).
   */
  async saveOffsite(
    actor: HostActionActor,
    raw: unknown,
  ): Promise<{ readonly test: Record<string, unknown>; readonly request: HostActionView | null }> {
    const { input, config } = this.parseOffsite(raw);
    const keys = await this.keysFor(input, await this.offsiteRow());
    const test = await this.deps.storage.roundTrip(this.storageConfig(config), keys);
    if (test.ok !== true) {
      throw new BackupManageError(
        'offsite_test_failed',
        'The off-site target did not pass the test; nothing was saved.',
        test,
      );
    }
    const now = this.deps.clock();
    const fp = fingerprint(keys);
    const hint = keys.accessKeyId.slice(-4);
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO backup_offsite_settings (id, config, secret, key_fingerprint, key_id_hint, last_test, last_test_at,
                                              updated_at, updated_by)
         VALUES (1, $1, $2, $3, $4, $5, $6, $6, $7)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, secret = EXCLUDED.secret,
           key_fingerprint = EXCLUDED.key_fingerprint, key_id_hint = EXCLUDED.key_id_hint,
           last_test = EXCLUDED.last_test, last_test_at = EXCLUDED.last_test_at, updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
        [
          JSON.stringify(config),
          this.deps.blobs.box.encrypt(Buffer.from(JSON.stringify(keys), 'utf8'), OFFSITE_AAD),
          fp,
          hint,
          JSON.stringify(test),
          now,
          actor.userId,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          action: 'backups.offsite.set',
          target: 'backup-offsite',
          outcome: 'success',
          metadata: { ...config, keyFingerprint: fp, fromStorage: input.useStorageKeys === true },
        },
        tx,
      );
    });
    const { applier } = await this.deps.host.status(BACKUP_KINDS);
    if (!applier.managed || !applier.kinds.includes('backup-offsite')) return { test, request: null };
    const request = await this.deps.host.submit(
      actor,
      'backup-offsite',
      {
        mode: 'set',
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        prefix: config.prefix,
        pathStyle: config.pathStyle ? 'true' : 'false',
        accessKeyId: keys.accessKeyId,
        secretAccessKey: keys.secretAccessKey,
      },
      {
        mode: 'set',
        bucket: config.bucket,
        endpoint: config.endpoint,
        region: config.region,
        prefix: config.prefix,
        keyFingerprint: fp,
      },
    );
    return { test, request };
  }

  /** Turns the off-site copy off: forgets the stored keys and (with an applier) removes the host's file. */
  async clearOffsite(actor: HostActionActor): Promise<HostActionView | null> {
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('DELETE FROM backup_offsite_settings WHERE id = 1');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          action: 'backups.offsite.clear',
          target: 'backup-offsite',
          outcome: 'success',
        },
        tx,
      );
    });
    const { applier } = await this.deps.host.status(BACKUP_KINDS);
    if (!applier.managed || !applier.kinds.includes('backup-offsite')) return null;
    return this.deps.host.submit(
      actor,
      'backup-offsite',
      {
        mode: 'clear',
        endpoint: '',
        region: '',
        bucket: '',
        prefix: '',
        pathStyle: '',
        accessKeyId: '',
        secretAccessKey: '',
      },
      { mode: 'clear' },
    );
  }
}
