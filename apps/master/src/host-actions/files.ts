import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { type HostSigner, signatureBytes } from '../console-domain/host-files.js';

/**
 * p17-host-actions §3 (ADR-0063 amendment 2026-10-26): the request kinds the console signs for a remyral-ctl host
 * besides the domain change — the files the master and the host applier (`remyral-ctl apply-pending`) exchange.
 *
 * - `requests/<kind>.json` + `<kind>.sig.json` (written by the master, uid 10001): flat pretty JSON of **string values
 *   only**, exactly the fields {@link FIELDS} lists for the kind plus the common ones (kind, id, nonce, createdAt,
 *   expiresAt), Ed25519-signed with the lease-signing key under the kind's own domain `remyral-host-<kind>/v1`. The host
 *   refuses a request with any other field, a nested value, a quote, backslash or control character before it reads a
 *   value, then re-validates each value with a fixed expression.
 * - `status/<kind>-result.json` (root, read-only for the master): `remyral-host-result/v1` — state, the current step,
 *   a short detail and the tail of the host's output (lines that name a secret are left out by the host and again here).
 * - `status/applier.json` (the heartbeat): the kinds the applier accepts and the releases kept on the host.
 */

export const HOST_ACTION_KINDS = [
  'upgrade',
  'rollback',
  // part 3: backups.
  'backup-run',
  'backup-drill',
  'backup-restore',
  'backup-config',
  'backup-offsite',
  // p17-panel-settings Part 0: withdraws a recipient / off-site change waiting for the host time lock.
  'backup-change-cancel',
] as const;
export type HostActionKind = (typeof HOST_ACTION_KINDS)[number];

/** The closed set of fields per kind (order = the order in the file). */
export const FIELDS: { readonly [K in HostActionKind]: readonly string[] } = {
  upgrade: ['version', 'fromVersion', 'acceptBreaking'],
  rollback: ['version', 'fromVersion', 'backupId', 'restoreDatabase'],
  'backup-run': ['reason'],
  'backup-drill': ['backupId'],
  'backup-restore': ['backupId', 'restoreDatabase'],
  'backup-config': [
    'time',
    'intervalMinutes',
    'keepDaily',
    'keepWeekly',
    'keepMonthly',
    'keepRecentHours',
    'drillEnabled',
    'drillWeekday',
    'drillTime',
    'walArchive',
    'recipients',
  ],
  // The only kind that carries a credential (the off-site keys) to the host; the master keeps it sealed otherwise.
  'backup-offsite': [
    'mode',
    'endpoint',
    'region',
    'bucket',
    'prefix',
    'pathStyle',
    'accessKeyId',
    'secretAccessKey',
  ],
  'backup-change-cancel': ['change'],
};

export const RESULT_KIND = 'remyral-host-result/v1';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_VALUE = 1200;

export function isHostActionKind(v: unknown): v is HostActionKind {
  return typeof v === 'string' && (HOST_ACTION_KINDS as readonly string[]).includes(v);
}

export const contextOf = (kind: HostActionKind): string => `remyral-host-${kind}/v1`;
export const requestFile = (kind: HostActionKind): string => `${kind}.json`;
export const signatureFile = (kind: HostActionKind): string => `${kind}.sig.json`;
export const resultFile = (kind: HostActionKind): string => `${kind}-result.json`;

export interface HostRequestCommon {
  readonly id: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

// eslint-disable-next-line no-control-regex
const SAFE = /^[^"\\\u0000-\u001f\u007f]*$/u;

/** The exact bytes of a request: fixed key order, two-space indent, string values only, trailing newline. */
export function hostRequestBytes(
  kind: HostActionKind,
  common: HostRequestCommon,
  fields: Readonly<Record<string, string>>,
): Buffer {
  const names = FIELDS[kind];
  const extra = Object.keys(fields).filter((k) => !names.includes(k));
  if (extra.length > 0) throw new Error(`host request ${kind}: unknown field ${extra[0] ?? ''}`);
  const ordered: Record<string, string> = { kind: contextOf(kind), id: common.id, nonce: common.nonce };
  for (const n of names) {
    const v = fields[n];
    if (v === undefined) throw new Error(`host request ${kind}: missing field ${n}`);
    ordered[n] = v;
  }
  ordered.createdAt = common.createdAt;
  ordered.expiresAt = common.expiresAt;
  for (const [k, v] of Object.entries(ordered)) {
    if (!SAFE.test(v) || v.length > MAX_VALUE) throw new Error(`host request ${kind}: unsafe ${k}`);
  }
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

async function writeAtomic(dir: string, name: string, bytes: Buffer): Promise<void> {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  // 0600: a request may carry a credential for the host (part 3); the directory is 0700 for the master and root.
  await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await rename(tmp, join(dir, name));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Signature first, request last (the host's path unit watches the request file). */
export async function writeHostRequest(
  requestsDir: string,
  kind: HostActionKind,
  common: HostRequestCommon,
  fields: Readonly<Record<string, string>>,
  signer: HostSigner,
): Promise<void> {
  await mkdir(requestsDir, { recursive: true });
  const bytes = hostRequestBytes(kind, common, fields);
  await writeAtomic(
    requestsDir,
    signatureFile(kind),
    signatureBytes(signer.signHostDocument(contextOf(kind), bytes)),
  );
  await writeAtomic(requestsDir, requestFile(kind), bytes);
}

export async function removeHostRequest(requestsDir: string, kind: HostActionKind): Promise<void> {
  await rm(join(requestsDir, requestFile(kind)), { force: true });
  await rm(join(requestsDir, signatureFile(kind)), { force: true });
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The id of the request of `kind` still waiting in the requests directory (null: none / unreadable). */
export async function pendingHostRequestId(
  requestsDir: string,
  kind: HostActionKind,
): Promise<string | null> {
  const doc = await readJson(join(requestsDir, requestFile(kind)));
  return doc !== null && typeof doc.id === 'string' ? doc.id : null;
}

export const HOST_RESULT_STATES = [
  'applying',
  'applied',
  // p17-panel-settings Part 0: accepted, but (a part of) it waits for the host time lock (BACKUP_CHANGE_WAIT_S).
  'scheduled',
  'rolled_back',
  'held',
  'failed',
  'refused',
] as const;
export type HostResultState = (typeof HOST_RESULT_STATES)[number];

const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

/** A line that names a secret never reaches the console (the host filters too; defence in depth). */
const SECRETISH = /(password|passwd|secret|token|access_?key|private|credential)[a-z_]*[=:]/i;
export function cleanLog(lines: readonly string[]): string[] {
  return lines
    .filter((l) => !SECRETISH.test(l))
    .map((l) => l.slice(0, 400))
    .slice(-40);
}

const ResultSchema = z.object({
  kind: z.literal(RESULT_KIND),
  request: z.string(),
  id: z.string().max(64),
  state: z.enum(HOST_RESULT_STATES),
  step: z.string().max(400).default(''),
  detail: z.string().max(2000).default(''),
  at: Iso,
  log: z.array(z.string().max(2000)).max(200).default([]),
});

export interface HostActionResult {
  /** '' when the host could not attribute it (the signature did not verify). */
  readonly id: string;
  readonly state: HostResultState;
  readonly step: string;
  readonly detail: string;
  readonly at: Date;
  readonly log: readonly string[];
}

export async function readHostResult(
  statusDir: string,
  kind: HostActionKind,
): Promise<HostActionResult | null> {
  const p = ResultSchema.safeParse(await readJson(join(statusDir, resultFile(kind))));
  if (!p.success || p.data.request !== kind) return null;
  return {
    id: p.data.id,
    state: p.data.state,
    step: p.data.step.slice(0, 200),
    detail: p.data.detail.slice(0, 500),
    at: new Date(p.data.at),
    log: cleanLog(p.data.log),
  };
}

const Semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);

const Short = z.string().max(64);
/** p17-panel-settings Part 0: a recipient / off-site change waiting for the host time lock (times by the host's clock). */
const PendingChangeSchema = z.object({
  change: z.enum(['recipients', 'offsite']),
  id: z.string().max(64),
  since: Iso,
  until: Iso,
  added: z
    .array(z.string().regex(/^age1[02-9ac-hj-np-z]{58}$/))
    .max(10)
    .default([]),
  target: z.string().max(400).default(''),
});
const ResolvedChangeSchema = z.object({
  change: z.string().max(20),
  state: z.string().max(20),
  id: z.string().max(64),
  at: Iso,
});
const BackupBlock = z.object({
  BACKUP_TIME: Short.default(''),
  BACKUP_INTERVAL_MINUTES: Short.default(''),
  BACKUP_KEEP_DAILY: Short.default(''),
  BACKUP_KEEP_WEEKLY: Short.default(''),
  BACKUP_KEEP_MONTHLY: Short.default(''),
  BACKUP_KEEP_RECENT_HOURS: Short.default(''),
  BACKUP_DRILL_ENABLED: Short.default(''),
  BACKUP_DRILL_WEEKDAY: Short.default(''),
  BACKUP_DRILL_TIME: Short.default(''),
  PG_WAL_ARCHIVE: Short.default(''),
  recipients: z
    .array(z.string().regex(/^age1[02-9ac-hj-np-z]{58}$/))
    .max(10)
    .default([]),
  offsite: z.string().max(400).default(''),
  pending: z.array(PendingChangeSchema).max(4).default([]),
  changes: z.array(ResolvedChangeSchema).max(10).default([]),
});

/** The backup settings a remyral-ctl host applies (stack.env, recipients.txt, where the off-site copy goes). */
export interface HostBackupSettings {
  readonly time: string;
  readonly intervalMinutes: string;
  readonly keepDaily: string;
  readonly keepWeekly: string;
  readonly keepMonthly: string;
  readonly keepRecentHours: string;
  readonly drillEnabled: string;
  readonly drillWeekday: string;
  readonly drillTime: string;
  readonly walArchive: string;
  readonly recipients: readonly string[];
  /** `s3://bucket/prefix/ @ host` without credentials; '' = no off-site copy. */
  readonly offsite: string;
  /** Changes waiting for the host time lock (p17-panel-settings Part 0). */
  readonly pending: readonly PendingBackupChange[];
  /** The last waiting changes the host applied, cancelled or superseded (newest last). */
  readonly changes: readonly ResolvedBackupChange[];
}

export interface PendingBackupChange {
  readonly change: 'recipients' | 'offsite';
  /** The request that asked for it. */
  readonly id: string;
  /** When the host first saw it (its own clock — never the request's createdAt). */
  readonly since: string;
  /** When the host applies it unless cancelled. */
  readonly until: string;
  /** recipients: the keys it adds. */
  readonly added: readonly string[];
  /** offsite: the new target without credentials. */
  readonly target: string;
}

export interface ResolvedBackupChange {
  readonly change: string;
  readonly state: string;
  readonly id: string;
  readonly at: string;
}

const ApplierSchema = z.object({
  kind: z.literal('remyral-host-applier/v1'),
  version: z.string().max(64),
  at: Iso,
  kinds: z.array(z.string().max(40)).max(32).default([]),
  current: z.union([Semver, z.literal('')]).default(''),
  previous: z.union([Semver, z.literal('')]).default(''),
  releases: z.array(Semver).max(16).default([]),
  backup: BackupBlock.optional(),
});

export interface ApplierInfo {
  readonly version: string;
  readonly at: Date;
  /** The request kinds this applier accepts (an older remyral-ctl: only `domain-change`). */
  readonly kinds: readonly string[];
  readonly current: string | null;
  readonly previous: string | null;
  /** Releases kept on the host (rollback targets besides the current one). */
  readonly releases: readonly string[];
  /** Part 3: the backup settings the host applies (null: an older applier). */
  readonly backup: HostBackupSettings | null;
}

export async function readApplierInfo(statusDir: string): Promise<ApplierInfo | null> {
  const p = ApplierSchema.safeParse(await readJson(join(statusDir, 'applier.json')));
  if (!p.success) return null;
  const h = p.data;
  return {
    version: h.version,
    at: new Date(h.at),
    kinds: h.kinds,
    current: h.current === '' ? null : h.current,
    previous: h.previous === '' ? null : h.previous,
    releases: h.releases,
    backup:
      h.backup === undefined
        ? null
        : {
            time: h.backup.BACKUP_TIME,
            intervalMinutes: h.backup.BACKUP_INTERVAL_MINUTES,
            keepDaily: h.backup.BACKUP_KEEP_DAILY,
            keepWeekly: h.backup.BACKUP_KEEP_WEEKLY,
            keepMonthly: h.backup.BACKUP_KEEP_MONTHLY,
            keepRecentHours: h.backup.BACKUP_KEEP_RECENT_HOURS,
            drillEnabled: h.backup.BACKUP_DRILL_ENABLED,
            drillWeekday: h.backup.BACKUP_DRILL_WEEKDAY,
            drillTime: h.backup.BACKUP_DRILL_TIME,
            walArchive: h.backup.PG_WAL_ARCHIVE,
            recipients: h.backup.recipients,
            offsite: h.backup.offsite,
            pending: h.backup.pending,
            changes: h.backup.changes,
          },
  };
}
