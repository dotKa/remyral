import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import type { PendingBackupChange } from '../host-actions/files.js';
import type { HostActionService } from '../host-actions/service.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';

/**
 * p17-panel-settings Part 0 (docs/design/p17-panel-settings.md §2, ADR-0063 amendment 2026-10-26 "host time lock"): the
 * remyral-ctl host keeps a backup change that adds an encryption recipient or changes the off-site target waiting for
 * 72 h (its own clock, root-owned state) and lists it in its heartbeat. This watcher only **tells the owners**: once when
 * a waiting change appears (every owner, in-app and by e-mail whatever their preference) and once 24 h before it takes
 * effect; it records the outcome (applied / cancelled / superseded) and audits each step. It cannot shorten or extend
 * the wait — a compromised master could suppress these notices, which is why the operator also sees the change in
 * `remyral-ctl status`.
 */

export const BACKUP_CHANGE_REMIND_MS = 24 * 60 * 60_000;

interface NoticeRow {
  change: 'recipients' | 'offsite';
  since: Date;
  request_id: string;
  until: Date;
  reminded_at: Date | null;
  inserted: boolean;
}

export interface BackupChangeNotice {
  readonly change: 'recipients' | 'offsite';
  readonly since: string;
  readonly until: string;
  readonly requestId: string;
  readonly added: readonly string[];
  readonly target: string;
}

const CHANGE_TEXT: Readonly<Record<'recipients' | 'offsite', string>> = {
  recipients: 'a new backup encryption key',
  offsite: 'a new off-site backup target',
};

export class BackupChangeWatch {
  #running: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly host: HostActionService;
      readonly notifications: () => NotificationService | null;
      readonly log?: { warn(obj: unknown, msg: string): void };
      readonly remindBeforeMs?: number;
    },
  ) {}

  /** What the host has waiting now (the heartbeat; [] without an applier or with an older one). */
  async pending(): Promise<readonly BackupChangeNotice[]> {
    const { info } = await this.deps.host.applierInfo();
    return (info?.backup?.pending ?? []).map(noticeOf);
  }

  /** Orchestrator tick. Never throws. */
  async tick(): Promise<void> {
    if (this.#running !== null) return this.#running;
    this.#running = this.run()
      .catch((err: unknown) => {
        this.deps.log?.warn({ err }, 'backup change watch failed');
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  private async run(): Promise<void> {
    const { info, fresh } = await this.deps.host.applierInfo();
    // A stale heartbeat says nothing reliable about what is still waiting.
    if (info === null || !fresh || info.backup === null) return;
    const now = this.deps.clock();
    const seen = new Set<string>();
    for (const p of info.backup.pending) {
      seen.add(`${p.change}|${new Date(p.since).toISOString()}`);
      await this.notice(p, now);
    }
    const { rows: open } = await this.deps.pool.query<{ change: string; since: Date; request_id: string }>(
      'SELECT change, since, request_id FROM backup_change_notices WHERE resolved IS NULL',
    );
    for (const r of open) {
      if (seen.has(`${r.change}|${r.since.toISOString()}`)) continue;
      const outcome =
        [...info.backup.changes].reverse().find((c) => c.change === r.change && c.id === r.request_id)
          ?.state ?? 'gone';
      const state = /^[a-z]{1,20}$/.test(outcome) ? outcome : 'gone';
      const { rowCount } = await this.deps.pool.query(
        `UPDATE backup_change_notices SET resolved = $3, resolved_at = $4
          WHERE change = $1 AND since = $2 AND resolved IS NULL`,
        [r.change, r.since, state, now],
      );
      if (rowCount === 0) continue;
      await this.deps.audit.record({
        actor: { type: 'system', id: 'host-applier' },
        action: `backups.change.${state}`,
        target: r.request_id,
        outcome: 'success',
        metadata: { change: r.change, since: r.since.toISOString() },
      });
    }
  }

  private async notice(p: PendingBackupChange, now: Date): Promise<void> {
    const since = new Date(p.since);
    const until = new Date(p.until);
    const { rows } = await this.deps.pool.query<NoticeRow>(
      `INSERT INTO backup_change_notices (change, since, request_id, until, added, target, seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (change, since) DO UPDATE SET request_id = EXCLUDED.request_id, until = EXCLUDED.until,
         added = EXCLUDED.added, target = EXCLUDED.target
       RETURNING change, since, request_id, until, reminded_at, (xmax = 0) AS inserted`,
      [p.change, since, p.id.slice(0, 64), until, JSON.stringify(p.added), p.target.slice(0, 400), now],
    );
    const row = rows[0];
    if (row === undefined) return;
    const what = CHANGE_TEXT[p.change];
    const detail =
      p.change === 'recipients'
        ? `It adds ${p.added.map((k) => `${k.slice(0, 12)}…${k.slice(-6)}`).join(', ') || 'a key'}.`
        : `New target: ${p.target}.`;
    if (row.inserted) {
      await this.deps.audit.record({
        actor: { type: 'system', id: 'host-applier' },
        action: 'backups.change.pending',
        target: p.id,
        outcome: 'success',
        metadata: { change: p.change, since: p.since, until: p.until, added: [...p.added], target: p.target },
      });
      await this.tell(
        `backup.change_pending:${p.change}:${p.since}`,
        `Backup change waiting: ${what} takes effect ${p.until}`,
        `The server was asked to use ${what} for future backups. ${detail} It takes effect on ${p.until} (72 hours after the server first saw it). If you or another owner did not ask for this, cancel it now in Settings → Backups and check who has owner access.`,
      );
    }
    const remindAt = until.getTime() - (this.deps.remindBeforeMs ?? BACKUP_CHANGE_REMIND_MS);
    if (row.reminded_at === null && now.getTime() >= remindAt && now.getTime() < until.getTime()) {
      const { rowCount } = await this.deps.pool.query(
        `UPDATE backup_change_notices SET reminded_at = $3
          WHERE change = $1 AND since = $2 AND reminded_at IS NULL`,
        [p.change, since, now],
      );
      if (rowCount === 0) return;
      await this.tell(
        `backup.change_pending:${p.change}:${p.since}:reminder`,
        `Reminder: ${what} takes effect ${p.until}`,
        `In less than 24 hours the server starts using ${what} for future backups. ${detail} If this was not asked for by an owner, cancel it in Settings → Backups.`,
      );
    }
  }

  private async tell(dedupeKey: string, title: string, body: string): Promise<void> {
    const n = this.deps.notifications();
    if (n === null) return;
    await n
      .notify(
        this.deps.pool,
        await globalRecipients(this.deps.pool, 'owner'),
        {
          kind: 'backup.change_pending',
          severity: 'critical',
          title,
          body,
          link: '/settings/backups',
          dedupeKey,
        },
        { mandatory: ['email'] },
      )
      .catch((err: unknown) => {
        this.deps.log?.warn({ err }, 'backup change notification failed');
      });
  }
}

function noticeOf(p: PendingBackupChange): BackupChangeNotice {
  return {
    change: p.change,
    since: p.since,
    until: p.until,
    requestId: p.id,
    added: [...p.added],
    target: p.target,
  };
}
