import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DEFAULT_RULES, Redactor, redactDeep, SecretSet } from '@remyral/observability';
import {
  DEFAULT_SUPPORT_EMAIL,
  DEFAULT_SUPPORT_SECTIONS,
  type DoctorFinding,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_DESCRIPTION_MAX,
  SUPPORT_LOG_HOURS_DEFAULT,
  SUPPORT_REPORT_SECTIONS,
  type SupportReportSection,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { DeliveryError } from '../notifications/notifier.js';
import { isEmailAddress, SmtpClient, type SmtpConfig } from '../notifications/smtp.js';
import type { LogStore } from '../system/logs.js';
import type { SystemStatus } from '../system/status.js';
import type { ActorContext } from '../workers/fleet.js';
import { configSummary } from './config-summary.js';
import { buildSupportMail } from './mail.js';
import type { DoctorRunView, DoctorService, WorkerResult } from './service.js';
import { buildZip } from './zip.js';

/**
 * p16-doctor (docs/design/p16-doctor.md §4–§5, ADR-0062): the support report — one redacted zip (JSON files and a
 * Markdown summary) the owner previews (files, sizes, the summary text), downloads, or sends by e-mail to the support
 * address with the configured SMTP.
 *
 * Redaction, in layers: every source is metadata by construction (closed codes, ids, numbers; the configuration is an
 * allowlist, job prompts only when the owner ticks them); every value passes `redactDeep` (pattern rules, secret-looking
 * keys, the exact SMTP passwords this master knows); the serialised text of every file passes the Redactor once more.
 * Logs are capped (lines and bytes), the bundle is capped, an attachment above the cap is never sent (the mail then
 * carries the summary only).
 */

export interface SmtpSettingsInput {
  readonly host: string;
  readonly port: number;
  readonly security: 'starttls' | 'tls';
  readonly from: string;
  readonly username?: string | null;
  /** undefined: keep the stored password; null: remove it; a string: the new password (sealed at once). */
  readonly password?: string | null;
}

export interface SupportSettingsView {
  /** The support address; null = not set (the report is only downloaded, never e-mailed). */
  readonly email: string | null;
  readonly defaultEmail: string | null;
  /** Where the support mail is sent from: the owner's SMTP here, else the master's notification SMTP. */
  readonly smtpSource: 'settings' | 'notifications' | 'none';
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly security: 'starttls' | 'tls';
    readonly from: string;
    readonly username: string | null;
    readonly passwordSet: boolean;
  } | null;
  readonly updatedAt: string | null;
  readonly updatedBy: { readonly id: string; readonly username: string } | null;
}

export interface ReportFile {
  readonly path: string;
  readonly section: SupportReportSection | 'summary' | 'manifest' | 'description';
  readonly bytes: number;
  readonly sha256: string;
  /** Records inside (log lines, jobs, machines), when that is meaningful. */
  readonly items?: number;
}

export interface ReportPreview {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sections: readonly SupportReportSection[];
  readonly logHours: number;
  readonly files: readonly ReportFile[];
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly filename: string;
  /** Larger than the attachment cap: the mail carries the summary only. */
  readonly overCap: boolean;
  readonly attachmentMaxBytes: number;
  readonly summary: string;
  readonly description: string | null;
  /** The support address the report would be sent to; null = not set. */
  readonly recipient: string | null;
  /** The requesting user's notification e-mail (for "cc me"), null when none is set. */
  readonly ccAddress: string | null;
  readonly smtpReady: boolean;
  readonly sent: {
    readonly at: string;
    readonly to: string;
    readonly cc: string | null;
    readonly attached: boolean;
  } | null;
}

export interface SupportDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** 32-byte sub-key (`box.deriveKey('support-smtp')`) sealing the support SMTP password. */
  readonly sealKey: Buffer;
  readonly doctor: DoctorService;
  readonly status: () => Promise<SystemStatus | null>;
  readonly logs: () => LogStore | null;
  /** The master's configuration (only allowlisted keys reach the report). */
  readonly config: unknown;
  readonly securityPreset: () => Promise<string | null>;
  readonly releaseTag: string | null;
  /** The notification SMTP (NOTIFY_SMTP_*), the fallback sender. */
  readonly notificationSmtp: SmtpConfig | null;
  /** p17-panel-settings: the SMTP is the one configuration — the notification e-mail re-reads it after a save. */
  readonly onSmtpChanged?: () => Promise<void>;
  /** Test seams: extra trust anchors for the owner-configured SMTP, timeouts, caps. */
  readonly smtpCa?: string | Buffer;
  readonly smtpTimeoutMs?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxLogLines?: number;
  readonly maxLogBytes?: number;
  /** How long a built bundle is kept (default 24 h). */
  readonly keepMs?: number;
  /** Delivery seam (tests): defaults to the SMTP client. */
  readonly submit?: (smtp: SmtpConfig, recipients: readonly string[], message: string) => Promise<void>;
}

interface SettingsRow {
  email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: 'starttls' | 'tls' | null;
  smtp_from: string | null;
  smtp_username: string | null;
  smtp_password_sealed: Buffer | null;
  updated_at: Date | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

interface ReportRow {
  id: string;
  created_at: Date;
  created_by: string | null;
  sections: SupportReportSection[];
  log_hours: number;
  description: string | null;
  files: ReportFile[];
  size_bytes: number;
  sha256: string;
  bundle: Buffer | null;
  expires_at: Date;
  sent_at: Date | null;
  sent_to: string | null;
  sent_cc: string | null;
  attached: boolean | null;
}

const MAX_BUNDLE = 50 * 1024 * 1024;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

function noControl(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters (other than newlines and tabs) are removed
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

export class SupportService {
  readonly #d: SupportDeps;
  readonly #box: SecretBox;

  constructor(d: SupportDeps) {
    this.#d = d;
    this.#box = new SecretBox(d.sealKey);
  }

  // ------------------------------------------------------------------------------------------------ settings

  async #row(db: Queryable = this.#d.pool): Promise<SettingsRow> {
    const { rows } = await db.query<SettingsRow>(
      `SELECT s.*, u.username AS updated_by_name FROM support_settings s
         LEFT JOIN users u ON u.id = s.updated_by WHERE s.id = 1`,
    );
    return (
      rows[0] ?? {
        email: DEFAULT_SUPPORT_EMAIL,
        smtp_host: null,
        smtp_port: null,
        smtp_security: null,
        smtp_from: null,
        smtp_username: null,
        smtp_password_sealed: null,
        updated_at: null,
        updated_by: null,
        updated_by_name: null,
      }
    );
  }

  async settings(): Promise<SupportSettingsView> {
    const r = await this.#row();
    const own =
      r.smtp_host !== null && r.smtp_port !== null && r.smtp_security !== null && r.smtp_from !== null;
    return {
      email: r.email,
      defaultEmail: DEFAULT_SUPPORT_EMAIL,
      smtpSource: own ? 'settings' : this.#d.notificationSmtp !== null ? 'notifications' : 'none',
      smtp: own
        ? {
            host: r.smtp_host ?? '',
            port: r.smtp_port ?? 0,
            security: r.smtp_security ?? 'starttls',
            from: r.smtp_from ?? '',
            username: r.smtp_username,
            passwordSet: r.smtp_password_sealed !== null,
          }
        : null,
      updatedAt: iso(r.updated_at),
      updatedBy:
        r.updated_by === null ? null : { id: r.updated_by, username: r.updated_by_name ?? 'unknown' },
    };
  }

  /** Changes the support address and / or the support SMTP (owner; the route asks for the step-up). */
  async updateSettings(
    actor: ActorContext,
    input: { readonly email?: string | null; readonly smtp?: SmtpSettingsInput | null },
  ): Promise<SupportSettingsView> {
    if (input.email !== undefined && input.email !== null && !isEmailAddress(input.email))
      throw new HttpError(
        422,
        'invalid_support_settings',
        'The support address is not a valid e-mail address.',
        {},
        {},
        { reason: 'email' },
      );
    const s = input.smtp;
    if (s !== undefined && s !== null) {
      const hostOk = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(s.host);
      if (!hostOk || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
        throw new HttpError(
          422,
          'invalid_support_settings',
          'The SMTP host or port is not valid.',
          {},
          {},
          { reason: 'smtp_host' },
        );
      if (!isEmailAddress(s.from))
        throw new HttpError(
          422,
          'invalid_support_settings',
          'The sender is not a valid e-mail address.',
          {},
          {},
          { reason: 'smtp_from' },
        );
      if (typeof s.password === 'string' && (s.username ?? '') === '')
        throw new HttpError(
          422,
          'invalid_support_settings',
          'A password needs a user name.',
          {},
          {},
          { reason: 'smtp_username' },
        );
    }
    const now = this.#d.clock();
    const cur = await this.#row();
    // null clears the address (the report is then only downloaded); undefined keeps it.
    const email = input.email === undefined ? cur.email : input.email;
    let sealed = cur.smtp_password_sealed;
    let host = cur.smtp_host;
    let port = cur.smtp_port;
    let security = cur.smtp_security;
    let from = cur.smtp_from;
    let username = cur.smtp_username;
    if (s === null) {
      host = port = security = from = username = null;
      sealed = null;
    } else if (s !== undefined) {
      host = s.host.toLowerCase();
      port = s.port;
      security = s.security;
      from = s.from;
      username =
        s.username === undefined ? username : s.username === null || s.username === '' ? null : s.username;
      if (s.password === null || username === null) sealed = null;
      else if (typeof s.password === 'string' && s.password !== '')
        sealed = this.#box.encrypt(Buffer.from(s.password, 'utf8'), 'support-smtp-password');
    }
    await this.#d.pool.query(
      `UPDATE support_settings SET email = $1, smtp_host = $2, smtp_port = $3, smtp_security = $4, smtp_from = $5,
              smtp_username = $6, smtp_password_sealed = $7, updated_at = $8, updated_by = $9 WHERE id = 1`,
      [email, host, port, security, from, username, sealed, now, actor.userId],
    );
    await this.#d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'support.settings.update',
      outcome: 'success',
      target: 'support:settings',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        emailChanged: email !== cur.email,
        email,
        smtp: s === undefined ? 'unchanged' : s === null ? 'removed' : 'set',
        ...(s === undefined || s === null
          ? {}
          : {
              smtpHost: host,
              smtpPort: port,
              passwordChanged: typeof s.password === 'string' || s.password === null,
            }),
      },
    });
    await this.#d.onSmtpChanged?.().catch(() => undefined);
    return this.settings();
  }

  /** The SMTP the support mail uses (the owner's here, else the notification SMTP), or null. */
  async #smtp(): Promise<SmtpConfig | null> {
    const r = await this.#row();
    if (r.smtp_host !== null && r.smtp_port !== null && r.smtp_security !== null && r.smtp_from !== null) {
      const password =
        r.smtp_password_sealed === null
          ? undefined
          : this.#box.decrypt(r.smtp_password_sealed, 'support-smtp-password').toString('utf8');
      return {
        host: r.smtp_host,
        port: r.smtp_port,
        security: r.smtp_security,
        from: r.smtp_from,
        ...(r.smtp_username === null ? {} : { username: r.smtp_username }),
        ...(password === undefined ? {} : { password }),
        ...(this.#d.smtpCa === undefined ? {} : { ca: this.#d.smtpCa }),
        heloName: 'remyral-master',
        timeoutMs: this.#d.smtpTimeoutMs ?? 30_000,
      };
    }
    const n = this.#d.notificationSmtp;
    return n === null
      ? null
      : { ...n, ...(this.#d.smtpTimeoutMs === undefined ? {} : { timeoutMs: this.#d.smtpTimeoutMs }) };
  }

  /** A redactor that also knows the exact SMTP passwords of this master. */
  async #redactor(): Promise<Redactor> {
    const secrets = new SecretSet();
    const add = (v: string | undefined): void => {
      if (v === undefined || v.length < 6) return;
      try {
        secrets.add(v, 'smtp-password');
      } catch {
        // too short to register: the pattern rules still apply
      }
    };
    add(this.#d.notificationSmtp?.password);
    add((await this.#smtp())?.password);
    return new Redactor({ secrets, rules: DEFAULT_RULES });
  }

  async #ccAddress(userId: string): Promise<string | null> {
    if (userId === '') return null;
    const { rows } = await this.#d.pool.query<{ email: string | null }>(
      'SELECT email FROM notification_targets WHERE user_id = $1',
      [userId],
    );
    const e = rows[0]?.email ?? null;
    return e !== null && isEmailAddress(e) ? e : null;
  }

  // ------------------------------------------------------------------------------------------------ build

  /** Builds the bundle of the chosen sections, stores it for a day and returns its preview. */
  async build(
    actor: ActorContext,
    input: {
      readonly sections?: readonly SupportReportSection[];
      readonly hours?: number;
      readonly description?: string | null;
      readonly source?: 'console' | 'chat';
    },
  ): Promise<ReportPreview> {
    const now = this.#d.clock();
    const chosen = new Set(input.sections ?? DEFAULT_SUPPORT_SECTIONS);
    const sections = SUPPORT_REPORT_SECTIONS.filter((s) => chosen.has(s));
    if (sections.length === 0)
      throw new HttpError(
        422,
        'invalid_support_report',
        'Choose at least one section.',
        {},
        {},
        { reason: 'sections' },
      );
    const hours = Math.min(72, Math.max(1, Math.round(input.hours ?? SUPPORT_LOG_HOURS_DEFAULT)));
    const description =
      input.description === undefined || input.description === null || input.description.trim() === ''
        ? null
        : noControl(input.description.trim(), SUPPORT_DESCRIPTION_MAX);
    const redactor = await this.#redactor();
    const clean = (v: unknown): unknown => redactDeep(v, redactor, { maxEntries: 5000, maxDepth: 10 });
    const text = (s: string): Buffer => Buffer.from(redactor.redact(s), 'utf8');
    const json = (v: unknown): Buffer => text(`${JSON.stringify(clean(v), null, 2)}\n`);
    const id = randomUUID();
    const files: { path: string; section: ReportFile['section']; data: Buffer; items?: number }[] = [];

    // The doctor: the newest finished run of the last hour, else a fresh full run (without asking the machines).
    let run = await this.#d.doctor.latest();
    if (run === null || now.getTime() - Date.parse(run.startedAt) > 3_600_000 || run.scope !== 'full')
      run = await this.#d.doctor.run({ kind: 'manual', scope: 'full', actor: null });
    const status =
      sections.includes('status') || sections.includes('versions') ? await this.#d.status() : null;

    if (sections.includes('doctor'))
      files.push({
        path: 'doctor.json',
        section: 'doctor',
        data: json(this.#doctorJson(run)),
        items: run.findings.length,
      });
    let machines: WorkerResult[] = [];
    if (sections.includes('workers')) {
      machines = this.#mergeMachines(run.workers, await this.#d.doctor.recentMachineReports());
      for (const m of machines.slice(0, 40))
        files.push({
          path: `workers/${m.workerId}.json`,
          section: 'workers',
          data: json(m),
          items: m.report?.findings.length ?? 0,
        });
      if (machines.length === 0)
        files.push({
          path: 'workers/none.json',
          section: 'workers',
          data: json({
            note: 'No machine doctor result of the last 24 hours. Run it from Ayarlar → Tanılama.',
          }),
          items: 0,
        });
    }
    if (sections.includes('status'))
      files.push({ path: 'status.json', section: 'status', data: json(status ?? { unavailable: true }) });
    if (sections.includes('versions'))
      files.push({ path: 'versions.json', section: 'versions', data: json(await this.#versions(status)) });
    if (sections.includes('config'))
      files.push({
        path: 'config.json',
        section: 'config',
        data: json({
          note: 'Allowlisted settings only (docs/design/p16-doctor.md §5); secrets, URLs with credentials and file paths are never included.',
          securityPreset: await this.#d.securityPreset().catch(() => null),
          settings: configSummary(this.#d.config),
        }),
      });
    let logCount = 0;
    if (sections.includes('logs')) {
      const logs = await this.#logs(hours, now, redactor);
      logCount = logs.count;
      files.push({ path: 'logs.jsonl', section: 'logs', data: logs.data, items: logs.count });
    }
    let failedCount = 0;
    if (sections.includes('failed_jobs') || sections.includes('job_prompts')) {
      const jobs = await this.#failedJobs(hours, now, sections.includes('job_prompts'));
      failedCount = jobs.length;
      files.push({
        path: 'failed-jobs.json',
        section: sections.includes('failed_jobs') ? 'failed_jobs' : 'job_prompts',
        data: json({
          windowHours: Math.max(hours, 24),
          includesPrompts: sections.includes('job_prompts'),
          jobs,
        }),
        items: jobs.length,
      });
    }
    if (description !== null)
      files.push({ path: 'description.txt', section: 'description', data: text(`${description}\n`) });
    const summary = redactor.redact(
      this.#markdown({ id, now, run, machines, sections, hours, logCount, failedCount, description }),
    );
    files.unshift({ path: 'report.md', section: 'summary', data: Buffer.from(summary, 'utf8') });
    const listed: ReportFile[] = files.map((x) => ({
      path: x.path,
      section: x.section,
      bytes: x.data.length,
      sha256: sha(x.data),
      ...(x.items === undefined ? {} : { items: x.items }),
    }));
    const manifest = Buffer.from(
      `${JSON.stringify(
        {
          schema: 'remyral-support-report/v1',
          id,
          createdAt: now.toISOString(),
          release: this.#d.releaseTag,
          sections,
          logHours: hours,
          files: listed,
          redaction:
            'Every value passed the platform Redactor (secret patterns, secret-looking keys, known SMTP passwords) and every file again as text; configuration is an allowlist; job prompts only when chosen.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const entries = [
      ...files.map((x) => ({ path: x.path, data: x.data })),
      { path: 'manifest.json', data: manifest },
    ];
    const zip = buildZip(entries, now);
    if (zip.length > MAX_BUNDLE)
      throw new HttpError(
        422,
        'support_report_too_large',
        'The report is too large; choose fewer sections or fewer log hours.',
        {},
        {},
        { maxMib: MAX_BUNDLE / 1024 / 1024 },
      );
    const allFiles: ReportFile[] = [
      ...listed,
      { path: 'manifest.json', section: 'manifest', bytes: manifest.length, sha256: sha(manifest) },
    ];
    const digest = sha(zip);
    const expires = new Date(now.getTime() + (this.#d.keepMs ?? 86_400_000));
    await this.#d.pool.query(
      `INSERT INTO support_reports (id, created_at, created_by, source, sections, log_hours, description, files,
                                    size_bytes, sha256, bundle, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        now,
        actor.userId === '' ? null : actor.userId,
        input.source ?? 'console',
        sections,
        hours,
        description,
        JSON.stringify(allFiles),
        zip.length,
        digest,
        zip,
        expires,
      ],
    );
    // Old bundles go (their facts stay).
    await this.#d.pool.query(
      'UPDATE support_reports SET bundle = NULL WHERE bundle IS NOT NULL AND expires_at < $1',
      [now],
    );
    await this.#d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'support.report.build',
      outcome: 'success',
      target: `support-report:${id}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { sections, logHours: hours, sizeBytes: zip.length, sha256: digest, files: allFiles.length },
    });
    return this.preview(actor, id);
  }

  #doctorJson(run: DoctorRunView): Record<string, unknown> {
    return {
      runId: run.id,
      kind: run.kind,
      scope: run.scope,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: run.summary,
      findings: run.findings,
    };
  }

  #mergeMachines(fromRun: readonly WorkerResult[], recent: readonly WorkerResult[]): WorkerResult[] {
    const by = new Map<string, WorkerResult>();
    for (const r of recent) by.set(r.workerId, r);
    for (const r of fromRun) if (r.report !== null || !by.has(r.workerId)) by.set(r.workerId, r);
    return [...by.values()].sort((a, b) => a.workerId.localeCompare(b.workerId));
  }

  async #versions(status: SystemStatus | null): Promise<Record<string, unknown>> {
    const db = this.#d.pool;
    const [workers, runtimes, channels] = await Promise.all([
      db.query<{
        id: string;
        name: string;
        worker_version: string;
        protocol_version: string | null;
        facts: Record<string, unknown>;
      }>(
        `SELECT id, COALESCE(label, display_name) AS name, worker_version, protocol_version, facts FROM workers
          WHERE state NOT IN ('pending', 'quarantined') AND archived_at IS NULL ORDER BY id LIMIT 100`,
      ),
      db.query<{
        worker_id: string;
        runtime: string;
        version: string;
        pin_status: string;
        authenticated: string;
      }>(
        `SELECT worker_id, runtime, version, pin_status, authenticated FROM worker_runtimes WHERE present ORDER BY worker_id, runtime LIMIT 400`,
      ),
      db.query<{ channel: string; version: string; rollout_percent: number }>(
        'SELECT channel, version, rollout_percent FROM worker_release_channels ORDER BY channel',
      ),
    ]);
    const { rows: mig } = await db.query<{ version: string }>(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    return {
      master: {
        release: this.#d.releaseTag,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        startedAt: status?.master.startedAt ?? null,
        uptimeSec: status?.master.uptimeSec ?? null,
        schema: mig[0]?.version ?? null,
      },
      workerRelease: channels.rows.map((c) => ({
        channel: c.channel,
        version: c.version,
        rolloutPercent: c.rollout_percent,
      })),
      machines: workers.rows.map((w) => ({
        id: w.id,
        name: w.name,
        workerVersion: w.worker_version,
        protocolVersion: w.protocol_version,
        os: typeof w.facts.os === 'string' ? w.facts.os : null,
        osVersion: typeof w.facts.osVersion === 'string' ? w.facts.osVersion : null,
        arch: typeof w.facts.arch === 'string' ? w.facts.arch : null,
        runtimes: runtimes.rows
          .filter((r) => r.worker_id === w.id)
          .map((r) => ({
            runtime: r.runtime,
            version: r.version,
            pin: r.pin_status,
            signedIn: r.authenticated,
          })),
      })),
    };
  }

  async #logs(hours: number, now: Date, redactor: Redactor): Promise<{ data: Buffer; count: number }> {
    const store = this.#d.logs();
    const maxLines = this.#d.maxLogLines ?? 5000;
    const maxBytes = this.#d.maxLogBytes ?? 4 * 1024 * 1024;
    if (store === null || !store.enabled)
      return {
        data: Buffer.from(
          `${JSON.stringify({ note: 'The log store is off on this master (LOG_STORE_RETENTION_DAYS=0).' })}\n`,
        ),
        count: 0,
      };
    const chunks: string[] = [];
    let bytes = 0;
    let count = 0;
    let before: string | undefined;
    let truncated = false;
    const since = new Date(now.getTime() - hours * 3_600_000);
    for (let page = 0; page < 40 && count < maxLines; page++) {
      const res = await store.search({
        level: 'warn',
        since,
        until: now,
        limit: 500,
        ...(before === undefined ? {} : { before }),
      });
      for (const l of res.lines) {
        const line = `${redactor.redact(JSON.stringify(redactDeep(l, redactor, { maxStringLength: 2048 })))}\n`;
        if (count >= maxLines || bytes + line.length > maxBytes) {
          truncated = true;
          break;
        }
        chunks.push(line);
        bytes += line.length;
        count += 1;
      }
      if (truncated || res.nextBefore === null) break;
      before = res.nextBefore;
    }
    if (truncated || count >= maxLines)
      chunks.push(`${JSON.stringify({ truncated: true, keptLines: count })}\n`);
    return { data: Buffer.from(chunks.join(''), 'utf8'), count };
  }

  async #failedJobs(hours: number, now: Date, prompts: boolean): Promise<Record<string, unknown>[]> {
    const { rows } = await this.#d.pool.query<{
      id: string;
      project: string;
      state: string;
      runtime: string | null;
      title: string | null;
      prompt: string | null;
      created_at: Date;
      ended_at: Date;
      reason: string | null;
      trigger: string | null;
      attempts: number;
      worker_id: string | null;
    }>(
      `SELECT j.id::text AS id, j.project, j.state::text AS state, j.spec->>'runtime' AS runtime,
              j.spec->>'title' AS title, j.spec->>'prompt' AS prompt, j.created_at, j.state_changed_at AS ended_at,
              t.reason, t.trigger,
              (SELECT count(*)::int FROM job_attempts a WHERE a.job_id = j.id) AS attempts,
              (SELECT a.worker_id FROM job_attempts a WHERE a.job_id = j.id ORDER BY a.number DESC LIMIT 1) AS worker_id
         FROM jobs j
         LEFT JOIN LATERAL (SELECT reason, trigger FROM job_transitions x WHERE x.job_id = j.id
                             ORDER BY x.version DESC LIMIT 1) t ON true
        WHERE j.state IN ('FAILED', 'LOST', 'BLOCKED') AND j.state_changed_at > $1
        ORDER BY j.state_changed_at DESC LIMIT 50`,
      [new Date(now.getTime() - Math.max(hours, 24) * 3_600_000)],
    );
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      state: r.state,
      runtime: r.runtime,
      createdAt: r.created_at.toISOString(),
      endedAt: r.ended_at.toISOString(),
      trigger: r.trigger,
      reason: r.reason === null ? null : r.reason.slice(0, 300),
      attempts: r.attempts,
      workerId: r.worker_id,
      ...(prompts ? { title: r.title?.slice(0, 200) ?? null, prompt: r.prompt?.slice(0, 4000) ?? null } : {}),
    }));
  }

  #markdown(i: {
    id: string;
    now: Date;
    run: DoctorRunView;
    machines: readonly WorkerResult[];
    sections: readonly SupportReportSection[];
    hours: number;
    logCount: number;
    failedCount: number;
    description: string | null;
  }): string {
    const s = i.run.summary;
    const line = (f: DoctorFinding): string =>
      `- **${f.severity.toUpperCase()}** \`${f.check}\` — ${f.message}${f.fix === undefined ? '' : `\n  - Fix: ${f.fix}`}`;
    const problems = i.run.findings.filter((f) => f.severity !== 'ok');
    const out = [
      '# Remyral support report',
      '',
      `- Report: \`${i.id}\``,
      `- Created: ${i.now.toISOString()}`,
      `- Master release: ${this.#d.releaseTag ?? 'unknown'}`,
      `- Sections: ${i.sections.join(', ')}`,
      `- Doctor (${i.run.scope}, ${i.run.startedAt}): ${String(s.error)} error, ${String(s.warning)} warning, ${String(s.info)} info, ${String(s.ok)} ok`,
      '',
    ];
    if (i.description !== null) out.push('## Description from the customer', '', i.description, '');
    out.push('## Findings', '');
    if (problems.length === 0) out.push('No problem found.', '');
    else
      out.push(
        ...problems.slice(0, 80).map(line),
        ...(problems.length > 80 ? [`- … ${String(problems.length - 80)} more in doctor.json`] : []),
        '',
      );
    if (i.sections.includes('workers')) {
      out.push('## Machines', '');
      if (i.machines.length === 0) out.push('No machine doctor result of the last 24 hours.', '');
      for (const m of i.machines) {
        const r = m.report;
        if (r === null) {
          out.push(`- ${m.name} (\`${m.workerId}\`): ${m.state}${m.reason === null ? '' : ` (${m.reason})`}`);
          continue;
        }
        out.push(
          `- ${m.name} (\`${m.workerId}\`, worker ${r.workerVersion}, ${r.host.platform}/${r.host.arch}): ${String(r.summary.error)} error, ${String(r.summary.warning)} warning`,
        );
        for (const f of r.findings
          .filter((x) => x.severity === 'error' || x.severity === 'warning')
          .slice(0, 10))
          out.push(`  - **${f.severity.toUpperCase()}** \`${f.check}\` — ${f.message}`);
      }
      out.push('');
    }
    out.push('## Contents', '');
    if (i.sections.includes('logs'))
      out.push(
        `- logs.jsonl: ${String(i.logCount)} warn / error line(s) of the last ${String(i.hours)} h (redacted, capped)`,
      );
    if (i.sections.includes('failed_jobs') || i.sections.includes('job_prompts'))
      out.push(
        `- failed-jobs.json: ${String(i.failedCount)} failed / lost / blocked job(s)${i.sections.includes('job_prompts') ? ' (with prompts — the customer chose to include them)' : ' (metadata only, no prompts or outputs)'}`,
      );
    out.push(
      '',
      'Secrets are masked; the configuration is an allowlist. See manifest.json for every file and its SHA-256.',
      '',
    );
    return out.join('\n');
  }

  // ------------------------------------------------------------------------------------------------ read / send

  async #report(id: string): Promise<ReportRow> {
    const { rows } = await this.#d.pool.query<ReportRow>('SELECT * FROM support_reports WHERE id = $1', [id]);
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'support_report_not_found', 'This report does not exist.');
    return r;
  }

  #filename(r: Pick<ReportRow, 'id' | 'created_at'>): string {
    const d = r.created_at.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    return `remyral-support-${d}-${r.id.slice(0, 8)}.zip`;
  }

  async preview(actor: ActorContext, id: string): Promise<ReportPreview> {
    const r = await this.#report(id);
    const summary = r.bundle === null ? '' : this.#entry(r.bundle, 'report.md');
    const settings = await this.#row();
    return {
      id: r.id,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      sections: r.sections,
      logHours: r.log_hours,
      files: r.files,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      filename: this.#filename(r),
      overCap: r.size_bytes > this.#cap(),
      attachmentMaxBytes: this.#cap(),
      summary,
      description: r.description,
      recipient: settings.email,
      ccAddress: await this.#ccAddress(actor.userId),
      smtpReady: (await this.#smtp()) !== null,
      sent:
        r.sent_at === null
          ? null
          : {
              at: r.sent_at.toISOString(),
              to: r.sent_to ?? '',
              cc: r.sent_cc,
              attached: r.attached === true,
            },
    };
  }

  #cap(): number {
    return this.#d.maxAttachmentBytes ?? SUPPORT_ATTACHMENT_MAX_BYTES;
  }

  /** The stored bytes of one entry (the summary for the preview); stored entries only need inflating. */
  #entry(zip: Buffer, name: string): string {
    let p = 0;
    while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
      const method = zip.readUInt16LE(p + 8);
      const size = zip.readUInt32LE(p + 18);
      const nameLen = zip.readUInt16LE(p + 26);
      const extra = zip.readUInt16LE(p + 28);
      const n = zip.subarray(p + 30, p + 30 + nameLen).toString('utf8');
      const start = p + 30 + nameLen + extra;
      const body = zip.subarray(start, start + size);
      if (n === name) return (method === 8 ? inflateRawSync(body) : body).toString('utf8');
      p = start + size;
    }
    return '';
  }

  async download(
    actor: ActorContext,
    id: string,
  ): Promise<{ filename: string; data: Buffer; sha256: string }> {
    const r = await this.#report(id);
    if (r.bundle === null)
      throw new HttpError(410, 'support_report_expired', 'This report is no longer kept; build a new one.');
    await this.#d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'support.report.download',
      outcome: 'success',
      target: `support-report:${id}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { sizeBytes: r.size_bytes, sha256: r.sha256, sections: r.sections },
    });
    return { filename: this.#filename(r), data: r.bundle, sha256: r.sha256 };
  }

  /**
   * Sends the report to the support address (and a copy to the user's own notification e-mail): the zip attached when
   * it fits the cap, else the summary only. Every attempt is audited (who, to whom, size, sections, hash).
   */
  async send(
    actor: ActorContext,
    id: string,
    opts: { readonly ccMe?: boolean; readonly source?: 'console' | 'chat' } = {},
  ): Promise<{
    to: string;
    cc: string | null;
    attached: boolean;
    sizeBytes: number;
    sha256: string;
    sentAt: string;
  }> {
    const r = await this.#report(id);
    if (r.bundle === null)
      throw new HttpError(410, 'support_report_expired', 'This report is no longer kept; build a new one.');
    const settings = await this.#row();
    const to = settings.email;
    if (to === null)
      throw new HttpError(
        409,
        'support_email_missing',
        'No support address is set: enter one in Settings → Diagnostics, or download the report and send it yourself.',
      );
    const smtp = await this.#smtp();
    if (smtp === null)
      throw new HttpError(
        409,
        'support_smtp_missing',
        'No e-mail server is configured: set the SMTP server in Settings → Diagnostics (or NOTIFY_SMTP_*), or download the report and send it yourself.',
      );
    const cc = opts.ccMe === true ? await this.#ccAddress(actor.userId) : null;
    if (opts.ccMe === true && cc === null)
      throw new HttpError(
        409,
        'support_cc_missing',
        'You have no notification e-mail address; set it in Settings → Notifications or send without a copy.',
      );
    const attached = r.size_bytes <= this.#cap();
    const summary = this.#entry(r.bundle, 'report.md');
    const filename = this.#filename(r);
    const body = [
      'A Remyral installation sent this diagnostics report.',
      '',
      ...(r.description === null ? [] : ['Description from the customer:', r.description, '']),
      attached
        ? `The redacted bundle is attached (${filename}, ${String(r.size_bytes)} bytes, SHA-256 ${r.sha256}).`
        : `The bundle (${String(r.size_bytes)} bytes, SHA-256 ${r.sha256}) is larger than ${String(this.#cap())} bytes and is NOT attached; the customer can download it in Settings → Diagnostics and share it another way.`,
      '',
      '---',
      '',
      summary,
    ].join('\n');
    const message = buildSupportMail(
      {
        from: smtp.from,
        to,
        cc,
        subject: `[Remyral support] Diagnostics report ${r.id.slice(0, 8)}${r.description === null ? '' : ` — ${r.description.split('\n')[0]?.slice(0, 80) ?? ''}`}`,
        text: body,
        attachment: attached ? { filename, data: r.bundle } : null,
        reportId: r.id,
      },
      this.#d.clock(),
    );
    const meta = {
      to,
      cc,
      sizeBytes: r.size_bytes,
      sections: r.sections,
      sha256: r.sha256,
      attached,
      source: opts.source ?? 'console',
      smtp: settings.smtp_host === null ? 'notifications' : 'settings',
    };
    try {
      const submit =
        this.#d.submit ??
        ((c: SmtpConfig, rcpt: readonly string[], m: string) => new SmtpClient(c).submit(rcpt, m));
      await submit(smtp, cc === null ? [to] : [to, cc], message);
    } catch (err) {
      const code = err instanceof DeliveryError ? err.code : 'smtp_error';
      await this.#d.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'support.report.send',
        outcome: 'failure',
        target: `support-report:${id}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { ...meta, error: code },
      });
      throw new HttpError(
        502,
        'support_send_failed',
        `The e-mail could not be sent (${code}). Check the SMTP settings or download the report.`,
        {},
        {},
        { code },
      );
    }
    const now = this.#d.clock();
    await this.#d.pool.query(
      'UPDATE support_reports SET sent_at = $2, sent_by = $3, sent_to = $4, sent_cc = $5, attached = $6 WHERE id = $1',
      [id, now, actor.userId === '' ? null : actor.userId, to, cc, attached],
    );
    await this.#d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'support.report.send',
      outcome: 'success',
      target: `support-report:${id}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: meta,
    });
    return { to, cc, attached, sizeBytes: r.size_bytes, sha256: r.sha256, sentAt: now.toISOString() };
  }
}
