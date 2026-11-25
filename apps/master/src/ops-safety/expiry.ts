import { stat } from 'node:fs/promises';
import type { AuditRecorder } from '../audit/audit.js';
import { type OriginInput, originOf } from '../console-domain/origin.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import type { CertificateReader } from './tls.js';

/**
 * p16-ops-safety §1 (docs/design/p16-ops-safety.md): "Anahtarlar ve süreler" — every credential, key and certificate
 * the master knows or can check, with its expiry (a hard date) or its rotation due date (age + a recommended period),
 * the owner's "rotated at" stamps, threshold notifications (30 / 14 / 7 / 1 days and expired, once per threshold) and a
 * summary for the home panel.
 *
 * Never reads secret contents: files are `stat`ed (mtime only), stored keys are known by their recorded dates, the
 * Cloudflare token by its own verify endpoint (status + expires_on), the public certificate by a TLS handshake.
 */

export const EXPIRY_THRESHOLDS = [30, 14, 7, 1] as const;
const DAY_MS = 86_400_000;
/** External checks (Cloudflare verify, TLS handshake) run at most this often unless forced. */
export const DEFAULT_CHECK_EVERY_MS = 6 * 60 * 60_000;

export type ExpiryCategory =
  'api_token' | 'integration' | 'certificate' | 'signing_key' | 'master_key' | 'backup' | 'vault';
/** `expires`: a hard expiry date. `rotation`: a recommended rotation date (age + period). `age`: age only. */
export type ExpiryBasis = 'expires' | 'rotation' | 'age';
export type ExpiryState = 'ok' | 'soon' | 'urgent' | 'expired' | 'unknown' | 'error';

/** The label of an item: a catalog key (translated by the console) and an optional name (token name, host …). */
export type ExpiryLabel =
  | 'apiToken'
  | 'cloudflareToken'
  | 'githubAppKey'
  | 'githubAppKeyFile'
  | 'coolifyToken'
  | 'tlsCertificate'
  | 'releaseKey'
  | 'totpKey'
  | 'leaseKey'
  | 'webhookHmac'
  | 'skillsPanelKey'
  | 'oidcSigningKey'
  | 'vapidKey'
  | 'backupIdentity'
  | 'vaultCredential'
  // p16-git-providers: a GitLab / Bitbucket connection's API token and its optional push-only token.
  | 'gitHostToken'
  | 'gitHostPushToken';

export interface ExpiryItem {
  /** Stable id (`<source>:<name>`); stamps and notices refer to it. */
  readonly id: string;
  readonly category: ExpiryCategory;
  readonly label: ExpiryLabel;
  readonly name: string | null;
  readonly basis: ExpiryBasis;
  /** The expiry or rotation due date (null: none known). */
  readonly dueAt: string | null;
  /** Whole days until `dueAt` (negative: overdue); null without a date. */
  readonly daysLeft: number | null;
  /** The date the age counts from: created / last rotated / file modified. */
  readonly since: string | null;
  readonly ageDays: number | null;
  readonly rotateEveryDays: number | null;
  /** The newest "rotated at" stamp, if any. */
  readonly rotatedAt: string | null;
  readonly state: ExpiryState;
  /** A short secret-free note ("active", "verify failed: …", "file not found"). */
  readonly detail: string | null;
  readonly checkedAt: string | null;
  /** The runbook that rotates it (docs path, section). */
  readonly runbook: string;
  /** "Rotated now" may be recorded for it. */
  readonly stampable: boolean;
  /** Threshold notifications are sent by this service (API tokens have their own 7-day notice). */
  readonly notifies: boolean;
}

export interface ExpirySummary {
  readonly total: number;
  readonly soon: number;
  readonly urgent: number;
  readonly expired: number;
  readonly unknown: number;
  readonly next: {
    readonly id: string;
    readonly label: ExpiryLabel;
    readonly name: string | null;
    readonly dueAt: string;
  } | null;
}

/** A key file the master is configured with (path from the environment; only its mtime is read). */
export interface KeyFileSpec {
  readonly id: string;
  readonly label: ExpiryLabel;
  readonly path: string | null;
  readonly rotateEveryDays: number | null;
  readonly runbook: string;
}

export interface CloudflareVerify {
  readonly status: string;
  readonly expiresOn: string | null;
}

export interface ExpiryServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly notifications: () => NotificationService | null;
  /**
   * The public origin (PUBLIC_ORIGIN / NOTIFY_PUBLIC_URL, or the master's live console address — p17-domain-wizard);
   * null: no certificate check.
   */
  readonly publicOrigin: OriginInput;
  readonly readCertificate: CertificateReader;
  /** Cloudflare's token verify with the stored token; null when no Cloudflare token is connected. */
  readonly cloudflareVerify: () => Promise<CloudflareVerify | null>;
  readonly keyFiles: readonly KeyFileSpec[];
  /** File mtime (seam for tests); null when the file does not exist. */
  readonly mtime?: (path: string) => Promise<Date | null>;
  readonly checkEveryMs?: number;
  /**
   * p16-git-providers: re-tests GitLab connections whose last test is older than `everyMs` (GitLab reports a token's
   * current expiry); returns the item ids checked. Absent: no git host check.
   */
  readonly gitHostsCheck?: (everyMs: number, force: boolean) => Promise<string[]>;
}

/** Recommended rotation periods (days); null = age only. */
export const ROTATION_DAYS = {
  cloudflareToken: 365,
  githubAppKey: 180,
  coolifyToken: 365,
  releaseKey: 365,
  totpKey: 730,
  leaseKey: 365,
  webhookHmac: 365,
  skillsPanelKey: 365,
  oidcSigningKey: 365,
  vapidKey: null,
  backupIdentity: 365,
  // p16-git-providers: a token without a known expiry (Bitbucket) is due for rotation after a year.
  gitHostToken: 365,
  gitHostPushToken: 365,
} as const satisfies Partial<Record<ExpiryLabel, number | null>>;

/** Items the owner may stamp although they are not configured on this master (rotated outside it). */
const STATIC_STAMPABLE = new Set(['backup:age-identity', 'signing:release-key']);

const ITEM_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}$/;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

async function fileMtime(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return null;
  }
}

/** The tightest threshold `due` has crossed at `now` (days), 0 when overdue, null when none yet. */
export function crossedThreshold(due: Date, now: Date): number | null {
  const left = due.getTime() - now.getTime();
  if (left <= 0) return 0;
  let out: number | null = null;
  for (const t of EXPIRY_THRESHOLDS) if (left <= t * DAY_MS) out = t;
  return out;
}

export function stateOf(due: Date | null, now: Date): ExpiryState {
  if (due === null) return 'ok';
  const left = due.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  if (left <= 7 * DAY_MS) return 'urgent';
  if (left <= 30 * DAY_MS) return 'soon';
  return 'ok';
}

interface Draft {
  id: string;
  category: ExpiryCategory;
  label: ExpiryLabel;
  name: string | null;
  basis: ExpiryBasis;
  due: Date | null;
  since: Date | null;
  rotateEveryDays: number | null;
  detail: string | null;
  checkedAt: Date | null;
  runbook: string;
  stampable: boolean;
  notifies: boolean;
  /** Forces the state (unknown / error) regardless of the date. */
  state?: ExpiryState;
}

export class ExpiryService {
  readonly #mtime: (path: string) => Promise<Date | null>;
  readonly #checkEveryMs: number;
  /** The origin the stored `tls:public-origin` check was made for in this process (a changed address re-checks). */
  #tlsOrigin: string | null = null;

  constructor(private readonly deps: ExpiryServiceDeps) {
    this.#mtime = deps.mtime ?? fileMtime;
    this.#checkEveryMs = deps.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS;
  }

  // ------------------------------------------------------------------------------------------------ reading

  async list(): Promise<{ items: ExpiryItem[]; summary: ExpirySummary; checkedAt: string | null }> {
    const now = this.deps.clock();
    const db = this.deps.pool;
    const stamps = await this.#stamps(db);
    const checks = await this.#checks(db);
    const drafts: Draft[] = [];
    const rotated = (id: string, base: Date | null): Date | null => {
      const s = stamps.get(id) ?? null;
      if (s === null) return base;
      return base === null || s > base ? s : base;
    };
    const rotation = (since: Date | null, days: number | null): Date | null =>
      since === null || days === null ? null : new Date(since.getTime() + days * DAY_MS);

    // API tokens (their own 7-day notice: api_token.expiring).
    const tokens = await db.query<{
      id: string;
      name: string;
      expires_at: Date;
      created_at: Date;
      username: string;
    }>(
      `SELECT t.id::text AS id, t.name, t.expires_at, t.created_at, u.username
         FROM api_tokens t JOIN users u ON u.id = t.principal_id
        WHERE t.revoked_at IS NULL AND u.disabled_at IS NULL
        ORDER BY t.expires_at LIMIT 200`,
    );
    for (const t of tokens.rows) {
      drafts.push({
        id: `token:${t.id.replaceAll('-', '').slice(0, 32)}`,
        category: 'api_token',
        label: 'apiToken',
        name: `${t.name} (${t.username})`,
        basis: 'expires',
        due: t.expires_at,
        since: t.created_at,
        rotateEveryDays: null,
        detail: null,
        checkedAt: null,
        runbook: 'docs/guide/tr/api-anahtarlari.md',
        stampable: false,
        notifies: false,
      });
    }

    // Cloudflare API token: its own expires_on (verify endpoint), else age since it was entered.
    const cf = await db.query<{ updated_at: Date }>(
      "SELECT updated_at FROM ops_integrations WHERE provider = 'cloudflare'",
    );
    const cfRow = cf.rows[0];
    if (cfRow !== undefined) {
      const id = 'cloudflare:token';
      const check = checks.get(id) ?? null;
      const since = rotated(id, cfRow.updated_at);
      const hard = check?.expires_at ?? null;
      drafts.push({
        id,
        category: 'integration',
        label: 'cloudflareToken',
        name: null,
        basis: hard !== null ? 'expires' : 'rotation',
        due: hard ?? rotation(since, ROTATION_DAYS.cloudflareToken),
        since,
        rotateEveryDays: ROTATION_DAYS.cloudflareToken,
        detail: check?.detail ?? null,
        checkedAt: check?.checked_at ?? null,
        runbook: 'docs/ops/deploy-coolify.md',
        stampable: true,
        notifies: true,
        ...(check !== null && !check.ok && hard === null ? { state: 'error' as const } : {}),
      });
    }

    // GitHub App key uploaded in the panel (GitHub has no key expiry; rotation recommended at 180 days).
    const gh = await db.query<{ key_created_at: Date; app_id: string }>(
      'SELECT key_created_at, app_id::text AS app_id FROM github_app_connection LIMIT 1',
    );
    const ghRow = gh.rows[0];
    if (ghRow !== undefined) {
      const id = 'github:app-key';
      const since = rotated(id, ghRow.key_created_at);
      drafts.push({
        id,
        category: 'integration',
        label: 'githubAppKey',
        name: `App ${ghRow.app_id}`,
        basis: 'rotation',
        due: rotation(since, ROTATION_DAYS.githubAppKey),
        since,
        rotateEveryDays: ROTATION_DAYS.githubAppKey,
        detail: null,
        checkedAt: null,
        runbook: 'docs/ops/github-app.md#5-rotate-the-key-disconnect',
        stampable: true,
        notifies: true,
      });
    }

    // Coolify API tokens: no expiry at Coolify; age since the token was entered or changed, plus the last test.
    const coolify = await db.query<{
      id: string;
      label: string;
      updated_at: Date;
      last_test: Record<string, unknown> | null;
      last_test_at: Date | null;
    }>(
      'SELECT id::text AS id, label, updated_at, last_test, last_test_at FROM coolify_connections ORDER BY label',
    );
    for (const c of coolify.rows) {
      const id = `coolify:${c.id.replaceAll('-', '').slice(0, 32)}`;
      const since = rotated(id, c.updated_at);
      const failed = c.last_test !== null && c.last_test.ok === false;
      drafts.push({
        id,
        category: 'integration',
        label: 'coolifyToken',
        name: c.label,
        basis: 'rotation',
        due: rotation(since, ROTATION_DAYS.coolifyToken),
        since,
        rotateEveryDays: ROTATION_DAYS.coolifyToken,
        detail:
          c.last_test === null
            ? 'never tested'
            : failed
              ? `last test failed${typeof c.last_test.error === 'string' ? `: ${c.last_test.error.slice(0, 160)}` : ''}`
              : 'last test passed',
        checkedAt: c.last_test_at,
        runbook: 'docs/ops/deploy-coolify.md',
        stampable: true,
        notifies: true,
        ...(failed ? { state: 'error' as const } : {}),
      });
    }

    // The certificate the public origin serves.
    const publicOrigin = originOf(this.deps.publicOrigin);
    if (publicOrigin !== null) {
      const id = 'tls:public-origin';
      const check = checks.get(id) ?? null;
      const host = hostOf(publicOrigin);
      drafts.push({
        id,
        category: 'certificate',
        label: 'tlsCertificate',
        name: host,
        basis: 'expires',
        due: check?.expires_at ?? null,
        since: null,
        rotateEveryDays: null,
        detail: check === null ? 'not checked yet' : check.detail,
        checkedAt: check?.checked_at ?? null,
        runbook: 'docs/ops/deploy-coolify.md#4-tls-cloudflare-origin-certificate-separate-step',
        stampable: false,
        notifies: true,
        ...(check === null ? { state: 'unknown' as const } : check.ok ? {} : { state: 'error' as const }),
      });
    }

    // The worker release signing key: first upload of a release signed with the key of the newest release.
    const rel = await db.query<{ key_id: string; first_at: Date }>(
      `SELECT r.key_id, (SELECT min(uploaded_at) FROM worker_releases x WHERE x.key_id = r.key_id) AS first_at
         FROM worker_releases r ORDER BY r.uploaded_at DESC LIMIT 1`,
    );
    const relRow = rel.rows[0];
    {
      const id = 'signing:release-key';
      const since = rotated(id, relRow?.first_at ?? null);
      drafts.push({
        id,
        category: 'signing_key',
        label: 'releaseKey',
        name: relRow?.key_id ?? null,
        basis: 'rotation',
        due: rotation(since, ROTATION_DAYS.releaseKey),
        since,
        rotateEveryDays: ROTATION_DAYS.releaseKey,
        detail: relRow === undefined && since === null ? 'no release uploaded yet' : null,
        checkedAt: null,
        runbook: 'docs/ops/worker-updates.md#6-rotate-the-release-key',
        stampable: true,
        notifies: true,
        ...(since === null ? { state: 'unknown' as const } : {}),
      });
    }

    // Key files of the master: the file's modification time (never its contents), or a newer stamp.
    for (const f of this.deps.keyFiles) {
      if (f.path === null) continue;
      const mtime = await this.#mtime(f.path);
      const since = rotated(f.id, mtime);
      drafts.push({
        id: f.id,
        category: 'master_key',
        label: f.label,
        name: null,
        basis: f.rotateEveryDays === null ? 'age' : 'rotation',
        due: rotation(since, f.rotateEveryDays),
        since,
        rotateEveryDays: f.rotateEveryDays,
        detail: mtime === null ? 'file not readable by the master' : null,
        checkedAt: null,
        runbook: f.runbook,
        stampable: true,
        notifies: f.rotateEveryDays !== null,
        ...(since === null ? { state: 'unknown' as const } : {}),
      });
    }

    // The backup age identity: lives off the master (owner's password manager) — known only by its stamp.
    {
      const id = 'backup:age-identity';
      const since = stamps.get(id) ?? null;
      drafts.push({
        id,
        category: 'backup',
        label: 'backupIdentity',
        name: null,
        basis: 'rotation',
        due: rotation(since, ROTATION_DAYS.backupIdentity),
        since,
        rotateEveryDays: ROTATION_DAYS.backupIdentity,
        detail: since === null ? 'record the date the identity was created or last rotated' : null,
        checkedAt: null,
        runbook: 'docs/ops/backups.md#2-owner-create-the-backup-keys-on-your-mac-once',
        stampable: true,
        notifies: true,
        ...(since === null ? { state: 'unknown' as const } : {}),
      });
    }

    // Vault credentials with an expiry date (metadata an administrator recorded).
    const vault = await db.query<{ id: string; name: string; expires_at: Date; updated_at: Date }>(
      `SELECT id, name, expires_at, updated_at FROM vault_credentials
        WHERE state = 'active' AND expires_at IS NOT NULL ORDER BY expires_at LIMIT 200`,
    );
    for (const v of vault.rows) {
      drafts.push({
        id: `vault:${v.id}`,
        category: 'vault',
        label: 'vaultCredential',
        name: v.name,
        basis: 'expires',
        due: v.expires_at,
        since: v.updated_at,
        rotateEveryDays: null,
        detail: null,
        checkedAt: null,
        runbook: 'docs/ops/credentials-and-models.md#rotate-share-revoke',
        stampable: false,
        notifies: true,
      });
    }

    // p16-git-providers: GitLab / Bitbucket tokens — the expiry GitLab reports (or the admin entered), else a yearly
    // rotation since the token was entered; a failed last connection test is an error.
    const hosts = await db.query<{
      id: string;
      kind: string;
      label: string;
      expires_at: Date | null;
      push_expires_at: Date | null;
      push_token_fingerprint: string | null;
      token_updated_at: Date;
      last_test: Record<string, unknown> | null;
      last_test_at: Date | null;
    }>(
      `SELECT id::text AS id, kind, label, expires_at, push_expires_at, push_token_fingerprint, token_updated_at,
              last_test, last_test_at
         FROM git_host_connections ORDER BY lower(label)`,
    );
    for (const c of hosts.rows) {
      const key = `githost:${c.id.replaceAll('-', '').slice(0, 32)}`;
      const name = `${c.kind === 'gitlab' ? 'GitLab' : 'Bitbucket'} · ${c.label}`;
      const failed = c.last_test !== null && c.last_test.ok === false;
      const code = typeof c.last_test?.code === 'string' ? c.last_test.code.slice(0, 64) : null;
      const tokens: { id: string; label: ExpiryLabel; due: Date | null }[] = [
        { id: key, label: 'gitHostToken', due: c.expires_at },
        ...(c.push_token_fingerprint === null
          ? []
          : [{ id: `${key}.push`, label: 'gitHostPushToken' as const, due: c.push_expires_at }]),
      ];
      for (const t of tokens) {
        const since = rotated(t.id, c.token_updated_at);
        drafts.push({
          id: t.id,
          category: 'integration',
          label: t.label,
          name,
          basis: t.due === null ? 'rotation' : 'expires',
          due: t.due ?? rotation(since, ROTATION_DAYS.gitHostToken),
          since,
          rotateEveryDays: t.due === null ? ROTATION_DAYS.gitHostToken : null,
          detail:
            c.last_test === null
              ? 'never tested'
              : failed
                ? `last test failed${code === null ? '' : `: ${code}`}`
                : 'last test passed',
          checkedAt: c.last_test_at,
          runbook: 'docs/guide/tr/gitlab-bitbucket.md',
          stampable: false,
          notifies: true,
          ...(failed ? { state: 'error' as const } : {}),
        });
      }
    }

    const items = drafts.map((d) => this.#item(d, stamps.get(d.id) ?? null, now));
    const order: Record<ExpiryState, number> = {
      expired: 0,
      error: 1,
      urgent: 2,
      soon: 3,
      unknown: 4,
      ok: 5,
    };
    items.sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') ||
        a.id.localeCompare(b.id),
    );
    const lastCheck = [...checks.values()].reduce<Date | null>(
      (m, c) => (m === null || c.checked_at > m ? c.checked_at : m),
      null,
    );
    return { items, summary: summarize(items), checkedAt: iso(lastCheck) };
  }

  #item(d: Draft, stamp: Date | null, now: Date): ExpiryItem {
    const daysLeft = d.due === null ? null : Math.floor((d.due.getTime() - now.getTime()) / DAY_MS);
    const ageDays =
      d.since === null ? null : Math.max(0, Math.floor((now.getTime() - d.since.getTime()) / DAY_MS));
    const state =
      d.state === 'unknown' || (d.state === 'error' && d.due === null) ? d.state : stateOf(d.due, now);
    return {
      id: d.id,
      category: d.category,
      label: d.label,
      name: d.name,
      basis: d.basis,
      dueAt: iso(d.due),
      daysLeft,
      since: iso(d.since),
      ageDays,
      rotateEveryDays: d.rotateEveryDays,
      rotatedAt: iso(stamp),
      state: d.state === 'error' && state === 'ok' ? 'error' : state,
      detail: d.detail,
      checkedAt: iso(d.checkedAt),
      runbook: d.runbook,
      stampable: d.stampable,
      notifies: d.notifies,
    };
  }

  async summary(): Promise<ExpirySummary> {
    return (await this.list()).summary;
  }

  async #stamps(db: Queryable): Promise<Map<string, Date>> {
    const { rows } = await db.query<{ item: string; rotated_at: Date }>(
      'SELECT item, max(rotated_at) AS rotated_at FROM secret_rotation_stamps GROUP BY item',
    );
    return new Map(rows.map((r) => [r.item, r.rotated_at]));
  }

  async #checks(
    db: Queryable,
  ): Promise<Map<string, { checked_at: Date; ok: boolean; expires_at: Date | null; detail: string | null }>> {
    const { rows } = await db.query<{
      item: string;
      checked_at: Date;
      ok: boolean;
      expires_at: Date | null;
      detail: string | null;
    }>('SELECT item, checked_at, ok, expires_at, detail FROM secret_expiry_checks');
    return new Map(rows.map((r) => [r.item, r]));
  }

  // ------------------------------------------------------------------------------------------------ checking

  /**
   * Runs the checks that call out (Cloudflare verify, the TLS handshake) when their last result is older than the
   * check period, or always with `force`. Stores the outcome (never the token or the certificate itself).
   */
  async refresh(force = false): Promise<{ checked: string[] }> {
    const now = this.deps.clock();
    const checks = await this.#checks(this.deps.pool);
    const due = (id: string): boolean => {
      const c = checks.get(id);
      return force || c === undefined || now.getTime() - c.checked_at.getTime() >= this.#checkEveryMs;
    };
    const checked: string[] = [];
    const publicOrigin = originOf(this.deps.publicOrigin);
    const moved = this.#tlsOrigin !== null && this.#tlsOrigin !== publicOrigin;
    this.#tlsOrigin = publicOrigin;
    if (publicOrigin !== null && (moved || due('tls:public-origin'))) {
      try {
        const cert = await this.deps.readCertificate(publicOrigin);
        const issuer = cert.issuer === null ? '' : ` · ${cert.issuer}`;
        await this.#store(
          'tls:public-origin',
          true,
          cert.notAfter,
          `${cert.authorized ? 'trusted' : 'not publicly trusted'}${issuer}`,
        );
      } catch (err) {
        await this.#store('tls:public-origin', false, null, `TLS check failed: ${errText(err)}`);
      }
      checked.push('tls:public-origin');
    }
    if (due('cloudflare:token')) {
      try {
        const v = await this.deps.cloudflareVerify();
        if (v !== null) {
          const exp = v.expiresOn === null ? null : new Date(v.expiresOn);
          await this.#store(
            'cloudflare:token',
            v.status === 'active',
            exp !== null && Number.isFinite(exp.getTime()) ? exp : null,
            `token ${v.status.slice(0, 40)}${v.expiresOn === null ? ', no expiry date set' : ''}`,
          );
          checked.push('cloudflare:token');
        }
      } catch (err) {
        await this.#store('cloudflare:token', false, null, `verify failed: ${errText(err)}`);
        checked.push('cloudflare:token');
      }
    }
    if (this.deps.gitHostsCheck !== undefined) {
      try {
        checked.push(...(await this.deps.gitHostsCheck(this.#checkEveryMs, force)));
      } catch {
        // A failed host check is recorded on the connection itself (its last test).
      }
    }
    return { checked };
  }

  async #store(item: string, ok: boolean, expiresAt: Date | null, detail: string): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO secret_expiry_checks (item, checked_at, ok, expires_at, detail) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item) DO UPDATE SET checked_at = EXCLUDED.checked_at, ok = EXCLUDED.ok,
                                        expires_at = EXCLUDED.expires_at, detail = EXCLUDED.detail`,
      [item, this.deps.clock(), ok, expiresAt, detail.slice(0, 300)],
    );
  }

  /** One pass: checks that are due, then threshold notifications. Returns the number of notices sent. */
  async tick(): Promise<number> {
    await this.refresh(false);
    return this.notify();
  }

  /**
   * Threshold notifications: for every item with a due date whose tightest crossed threshold (30 / 14 / 7 / 1 days,
   * 0 = expired) has not been notified for that due date, one `secret.expiring` notification to owners and admins and
   * an audit entry. A new due date (a rotation stamp, a new token) starts over.
   */
  async notify(): Promise<number> {
    const now = this.deps.clock();
    const { items } = await this.list();
    let sent = 0;
    for (const item of items) {
      if (!item.notifies || item.dueAt === null || item.state === 'unknown') continue;
      const due = new Date(item.dueAt);
      const threshold = crossedThreshold(due, now);
      if (threshold === null) continue;
      const created = await withTransaction(this.deps.pool, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO secret_expiry_notices (item, due_at, threshold, notified_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [item.id, due, threshold, now],
        );
        if ((ins.rowCount ?? 0) === 0) return false;
        const n = this.deps.notifications();
        if (n !== null) {
          await n.notify(tx, await globalRecipients(tx, 'admin'), {
            kind: 'secret.expiring',
            severity: threshold <= 7 ? 'critical' : 'warning',
            title: noticeTitle(item, threshold),
            body: noticeBody(item),
            link: '/settings/ops-safety',
            dedupeKey: `secret.expiring:${item.id}:${item.dueAt ?? ''}:${String(threshold)}`,
          });
        }
        await this.deps.audit.record(
          {
            actor: { type: 'system' },
            action: 'secret.expiry.notice',
            outcome: 'success',
            target: item.id,
            metadata: { dueAt: item.dueAt, threshold, basis: item.basis },
          },
          tx,
        );
        return true;
      });
      if (created) sent += 1;
    }
    return sent;
  }

  // ------------------------------------------------------------------------------------------------ stamps

  /** Records "rotated at" for an item (owner / admin after a documented rotation; console, CLI or chat). */
  async recordRotation(
    actor: {
      userId: string | null;
      ip?: string | null;
      userAgent?: string | null;
      source: 'console' | 'cli' | 'chat';
    },
    item: string,
    input: { rotatedAt?: Date | undefined; note?: string | undefined } = {},
  ): Promise<{ item: string; rotatedAt: string }> {
    if (!ITEM_ID.test(item))
      throw new HttpError(400, 'expiry_item_unknown', 'Unknown item.', {}, {}, { item: item.slice(0, 80) });
    const now = this.deps.clock();
    const at = input.rotatedAt ?? now;
    if (
      !Number.isFinite(at.getTime()) ||
      at.getTime() > now.getTime() + 5 * 60_000 ||
      at.getUTCFullYear() < 2000
    ) {
      throw new HttpError(
        400,
        'rotation_date_invalid',
        'The rotation date must be a past date (not in the future).',
      );
    }
    if (!STATIC_STAMPABLE.has(item)) {
      const { items } = await this.list();
      const known = items.find((i) => i.id === item);
      if (known === undefined || !known.stampable) {
        throw new HttpError(404, 'expiry_item_unknown', 'Unknown item.', {}, {}, { item: item.slice(0, 80) });
      }
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO secret_rotation_stamps (item, rotated_at, recorded_at, recorded_by, source, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item, at, now, actor.userId, actor.source, input.note?.slice(0, 300) ?? null],
      );
      await this.deps.audit.record(
        {
          actor: actor.userId === null ? { type: 'system', id: 'cli' } : { type: 'user', id: actor.userId },
          action: 'secret.rotation.recorded',
          outcome: 'success',
          target: item,
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { rotatedAt: at.toISOString(), source: actor.source },
        },
        tx,
      );
    });
    return { item, rotatedAt: at.toISOString() };
  }

  /** Records (or clears) the provider-side expiry date of a vault credential (metadata only). */
  async setVaultExpiry(
    actor: { userId: string; ip: string | null; userAgent: string | null },
    credentialId: string,
    expiresAt: Date | null,
  ): Promise<{ id: string; expiresAt: string | null }> {
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const r = await tx.query(
        "UPDATE vault_credentials SET expires_at = $2 WHERE id = $1 AND state = 'active'",
        [credentialId, expiresAt],
      );
      if ((r.rowCount ?? 0) === 0) throw new HttpError(404, 'not_found', 'Not found.');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'vault.credential.expiry',
          outcome: 'success',
          target: `vault:${credentialId}`,
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { expiresAt: iso(expiresAt) },
        },
        tx,
      );
      return { id: credentialId, expiresAt: iso(expiresAt) };
    });
    return out;
  }
}

function summarize(items: readonly ExpiryItem[]): ExpirySummary {
  const count = (s: ExpiryState) => items.filter((i) => i.state === s).length;
  const next = items
    .filter((i) => i.dueAt !== null && i.state !== 'expired')
    .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))[0];
  return {
    total: items.length,
    soon: count('soon'),
    urgent: count('urgent'),
    expired: count('expired') + count('error'),
    unknown: count('unknown'),
    next:
      next === undefined || next.dueAt === null
        ? null
        : { id: next.id, label: next.label, name: next.name, dueAt: next.dueAt },
  };
}

const LABEL_TEXT: Readonly<Record<ExpiryLabel, string>> = {
  apiToken: 'API token',
  cloudflareToken: 'Cloudflare API token',
  githubAppKey: 'GitHub App private key',
  githubAppKeyFile: 'GitHub App key file',
  coolifyToken: 'Coolify API token',
  tlsCertificate: 'TLS certificate',
  releaseKey: 'Worker release signing key',
  totpKey: 'TOTP encryption key',
  leaseKey: 'Lease signing key',
  webhookHmac: 'Notification webhook HMAC secret',
  skillsPanelKey: 'Skills panel signing key',
  oidcSigningKey: 'OIDC signing key',
  vapidKey: 'Web Push (VAPID) key',
  backupIdentity: 'Backup age identity',
  vaultCredential: 'Vault credential',
  gitHostToken: 'Git host access token',
  gitHostPushToken: 'Git host push token',
};

function noticeTitle(item: ExpiryItem, threshold: number): string {
  const what = `${LABEL_TEXT[item.label]}${item.name === null ? '' : ` ${item.name}`}`;
  if (threshold === 0)
    return item.basis === 'expires' ? `${what} has expired` : `${what} is overdue for rotation`;
  const verb = item.basis === 'expires' ? 'expires' : 'is due for rotation';
  return `${what} ${verb} in ${String(threshold)} day${threshold === 1 ? '' : 's'} or less`;
}

function noticeBody(item: ExpiryItem): string {
  const when = item.dueAt === null ? '' : ` Due: ${item.dueAt}.`;
  return `${LABEL_TEXT[item.label]}${item.name === null ? '' : ` "${item.name}"`}${when} Rotate it with the runbook ${item.runbook}, then record the rotation in Settings → Operations safety (or remyral-master secrets:rotated ${item.id}).`;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return (typeof code === 'string' ? code : err.message).slice(0, 160);
  }
  return 'unknown error';
}
