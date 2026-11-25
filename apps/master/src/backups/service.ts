import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import { assessBackups, backupNotifications, type BackupHealth } from './health.js';
import { readBackupFiles, type BackupFiles } from './status.js';

export interface BackupOverview extends BackupFiles {
  readonly configured: boolean;
  readonly health: BackupHealth;
  readonly checkedAt: string;
}

/**
 * p10-backup-restore §6: reads what the backup service reports (BACKUP_STATUS_DIR, mounted read-only) for the
 * console, and turns failures into notifications (orchestrator step, at most once a minute). No status directory
 * configured: everything answers "not configured" and nothing is notified.
 */
export class BackupStatusService {
  private readonly dir: string | null;
  private readonly pool: Pool;
  private readonly notifications: () => NotificationService | null;
  private readonly clock: () => Date;
  private readonly log: FastifyBaseLogger | undefined;
  private readonly intervalMs: number;
  private lastTick = 0;

  constructor(deps: {
    readonly dir: string | null;
    readonly pool: Pool;
    readonly notifications: () => NotificationService | null;
    readonly clock?: () => Date;
    readonly log?: FastifyBaseLogger;
    readonly intervalMs?: number;
  }) {
    this.dir = deps.dir;
    this.pool = deps.pool;
    this.notifications = deps.notifications;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
    this.intervalMs = deps.intervalMs ?? 60_000;
  }

  async overview(): Promise<BackupOverview> {
    const now = this.clock();
    const files: BackupFiles =
      this.dir === null ? { status: null, heartbeat: null, problems: [] } : await readBackupFiles(this.dir);
    return {
      ...files,
      configured: this.dir !== null,
      health: assessBackups(files, now),
      checkedAt: now.toISOString(),
    };
  }

  /** One alert pass (self-throttled). Returns the number of new notifications. */
  async tick(): Promise<number> {
    const now = this.clock();
    if (this.dir === null || now.getTime() - this.lastTick < this.intervalMs) return 0;
    this.lastTick = now.getTime();
    const notifications = this.notifications();
    if (notifications === null) return 0;
    const files = await readBackupFiles(this.dir);
    const drafts = backupNotifications(files, now);
    if (drafts.length === 0) return 0;
    const recipients = await globalRecipients(this.pool, 'admin');
    let created = 0;
    for (const d of drafts) created += await notifications.notify(this.pool, recipients, d);
    if (created > 0) this.log?.warn({ created, kinds: drafts.map((d) => d.kind) }, 'backup notifications');
    return created;
  }
}
