import type { NotificationDraft } from '../notifications/model.js';
import type { BackupFiles } from './status.js';

/**
 * p10-backup-restore §6: health of the backups as the console shows it, and the notifications it implies. Pure
 * (unit-tested). Notification texts are fixed sentences plus ids, times and numbers — never free text from the
 * status file.
 */
export const HEARTBEAT_STALE_MS = 30 * 60_000;
export const DRILL_OVERDUE_MS = 8 * 86_400_000 + 3_600_000;
const HOUR = 3_600_000;
export const BACKUPS_LINK = '/settings/backups';

export type HealthLevel = 'ok' | 'info' | 'warning' | 'failing';
export interface HealthReason {
  readonly level: Exclude<HealthLevel, 'ok'>;
  readonly code: string;
  readonly message: string;
}
export interface BackupHealth {
  readonly state: 'not_configured' | 'ok' | 'warning' | 'failing';
  readonly reasons: readonly HealthReason[];
}

const at = (s: string | null | undefined): number | null => (s ? Date.parse(s) : null);
const ago = (ms: number): string => {
  const h = Math.round(ms / HOUR);
  return h < 48 ? `${String(h)} h` : `${String(Math.round(h / 24))} days`;
};

/** Staleness threshold for successful backups: the expected interval × 1.5 + 1 h (default interval 24 h). */
export function overdueAfterMs(files: BackupFiles): number {
  const interval = files.heartbeat?.expectedIntervalMs ?? 86_400_000;
  return interval * 1.5 + HOUR;
}

export function assessBackups(files: BackupFiles, now: Date): BackupHealth {
  const { status, heartbeat } = files;
  if (status === null && heartbeat === null) {
    return {
      state: 'not_configured',
      reasons: [
        ...files.problems.map((p) => ({ level: 'warning' as const, code: 'unreadable', message: p })),
        {
          level: 'info',
          code: 'not_running',
          message: 'The backup service has not reported yet (not deployed, or never started).',
        },
      ],
    };
  }
  const t = now.getTime();
  const reasons: HealthReason[] = files.problems.map((p) => ({
    level: 'warning',
    code: 'unreadable',
    message: p,
  }));
  const hb = at(heartbeat?.at);
  if (hb === null || t - hb > HEARTBEAT_STALE_MS) {
    reasons.push({
      level: 'failing',
      code: 'service_stopped',
      message:
        hb === null
          ? 'The backup service is not running (no heartbeat).'
          : `The backup service stopped reporting ${ago(t - hb)} ago.`,
    });
  }
  const lastOk = at(status?.lastSuccessfulBackup?.finishedAt);
  if (lastOk === null) {
    reasons.push({ level: 'warning', code: 'no_backup', message: 'No successful backup yet.' });
  } else if (t - lastOk > overdueAfterMs(files)) {
    reasons.push({
      level: 'failing',
      code: 'backup_overdue',
      message: `The last successful backup is ${ago(t - lastOk)} old.`,
    });
  }
  const last = status?.lastBackup ?? null;
  if (last?.outcome === 'failed') {
    reasons.push({
      level: 'failing',
      code: 'backup_failed',
      message: `The last backup (${last.runId}) failed: ${last.error ?? 'unknown error'}`,
    });
  } else if (last?.outcome === 'partial') {
    reasons.push({
      level: 'warning',
      code: 'backup_partial',
      message: `The last backup (${last.runId}) is only partial: ${last.warnings.join('; ') || 'see the service log'}`,
    });
  }
  if (status && !status.encryption.configured) {
    reasons.push({
      level: 'warning',
      code: 'no_owner_key',
      message:
        'No owner public key (backup-config/recipients.txt): the secrets archive and off-site copies are disabled.',
    });
  }
  if (status && !status.offsite.configured) {
    reasons.push({
      level: 'info',
      code: 'no_offsite',
      message: 'No off-site copy configured: the backups are on the control-plane host only.',
    });
  }
  const drill = status?.lastDrill ?? null;
  if (drill?.outcome === 'failed') {
    reasons.push({
      level: 'failing',
      code: 'drill_failed',
      message: `The last restore drill (${drill.runId}) failed: ${drill.error ?? 'see its checks'}`,
    });
  }
  const drillOk = at(status?.lastSuccessfulDrill?.startedAt);
  if (lastOk !== null && heartbeat?.nextDrillAt !== null) {
    if (drillOk === null ? t - lastOk > 86_400_000 : t - drillOk > DRILL_OVERDUE_MS) {
      reasons.push({
        level: 'warning',
        code: 'drill_overdue',
        message:
          drillOk === null
            ? 'No restore drill has passed yet.'
            : `The last passed restore drill is ${ago(t - drillOk)} old.`,
      });
    }
  }
  reasons.push(...standbyReasons(files, now));
  const state = reasons.some((r) => r.level === 'failing')
    ? 'failing'
    : reasons.some((r) => r.level === 'warning')
      ? 'warning'
      : 'ok';
  return { state, reasons };
}

/** p11-master-resilience: WAL shipping lag (RPO target 5 min) at which the console warns / fails. */
export const WAL_LAG_WARN_S = 10 * 60;
export const WAL_LAG_FAIL_S = 60 * 60;
/** A base backup is taken daily; older than this the standby replay window keeps growing. */
export const BASE_OVERDUE_MS = 30 * HOUR;

/** p11-master-resilience: standby readiness (only when WAL archiving is on). */
export function standbyReasons(files: BackupFiles, now: Date): HealthReason[] {
  const sb = files.standby ?? null;
  if (sb === null || !sb.walArchive.enabled) return [];
  const out: HealthReason[] = [];
  const t = now.getTime();
  if (sb.lagSeconds >= WAL_LAG_WARN_S) {
    out.push({
      level: sb.lagSeconds >= WAL_LAG_FAIL_S ? 'failing' : 'warning',
      code: 'wal_lag',
      message: `WAL shipping is ${String(Math.round(sb.lagSeconds / 60))} min behind (${String(sb.pendingSegments)} segments pending): a standby restore would lose that much.`,
    });
  }
  if (sb.gaps.length > 0) {
    out.push({
      level: 'failing',
      code: 'wal_gap',
      message: `The local WAL archive has a gap at ${sb.gaps[0] ?? '?'}: replay stops there until a new base backup.`,
    });
  }
  if (sb.offsite.lastError !== null) {
    out.push({ level: 'warning', code: 'wal_error', message: `WAL shipping: ${sb.offsite.lastError}` });
  }
  if (!sb.offsite.configured) {
    out.push({
      level: 'info',
      code: 'wal_local_only',
      message:
        'WAL is archived on this host only: configure the off-site copy for a standby on another host.',
    });
  }
  const base = sb.lastBaseBackup;
  const baseOk = at(sb.lastSuccessfulBaseBackup?.finishedAt);
  if (base?.outcome === 'failed') {
    out.push({
      level: 'warning',
      code: 'base_failed',
      message: `The last base backup (${base.id}) failed: ${base.error ?? 'unknown error'}`,
    });
  }
  if (baseOk === null) {
    out.push({
      level: 'warning',
      code: 'no_base',
      message: 'No base backup yet: WAL alone cannot be restored.',
    });
  } else if (t - baseOk > BASE_OVERDUE_MS) {
    out.push({
      level: 'warning',
      code: 'base_overdue',
      message: `The last base backup is ${ago(t - baseOk)} old.`,
    });
  }
  return out;
}

/** Notifications for owners/admins; each event once (dedupe keys), see the design note §6. */
export function backupNotifications(files: BackupFiles, now: Date): NotificationDraft[] {
  const { status, heartbeat } = files;
  const out: NotificationDraft[] = [];
  if (status === null && heartbeat === null) return out;
  const t = now.getTime();
  const base = { link: BACKUPS_LINK } as const;

  const last = status?.lastBackup ?? null;
  if (last && last.outcome !== 'ok') {
    const failed = last.outcome === 'failed';
    out.push({
      ...base,
      kind: 'backup.failed',
      severity: failed ? 'critical' : 'warning',
      title: failed ? `Backup failed: ${last.runId}` : `Backup incomplete: ${last.runId}`,
      body: failed
        ? `The backup run ${last.runId} (started ${last.startedAt}) produced no usable backup. See Settings → Backups and the backup service log.`
        : `The backup run ${last.runId} saved the database locally, but ${[
            last.secrets !== 'ok' ? 'the encrypted secrets archive' : null,
            last.offsite.status === 'failed' ? 'the off-site copy' : null,
          ]
            .filter(Boolean)
            .join(' and ')} failed or is not configured. See Settings → Backups.`,
      dedupeKey: `backup.failed:${last.runId}`,
    });
  }
  const lastOk = status?.lastSuccessfulBackup ?? null;
  const lastOkAt = at(lastOk?.finishedAt);
  const hbStarted = at(heartbeat?.startedAt);
  const overdue =
    lastOkAt === null
      ? hbStarted !== null && t - hbStarted > overdueAfterMs(files)
      : t - lastOkAt > overdueAfterMs(files);
  if (overdue) {
    out.push({
      ...base,
      kind: 'backup.failed',
      severity: 'critical',
      title: 'Backups are overdue',
      body:
        lastOk === null
          ? 'The backup service has not completed any backup since it started. See Settings → Backups.'
          : `No successful backup since ${lastOk.finishedAt ?? lastOk.startedAt} (${lastOk.runId}). See Settings → Backups.`,
      dedupeKey: `backup.overdue:${lastOk?.runId ?? 'none'}`,
    });
  }
  const hb = at(heartbeat?.at);
  if (heartbeat && hb !== null && t - hb > HEARTBEAT_STALE_MS) {
    out.push({
      ...base,
      kind: 'backup.failed',
      severity: 'critical',
      title: 'Backup service stopped',
      body: `The backup service has not reported since ${heartbeat.at}: no backups or restore drills run until it is back.`,
      dedupeKey: `backup.service:${heartbeat.at}`,
    });
  }

  const drill = status?.lastDrill ?? null;
  if (drill?.outcome === 'failed') {
    const failedChecks = drill.checks.filter((c) => !c.ok).map((c) => c.name);
    out.push({
      ...base,
      kind: 'restore_drill.failed',
      severity: 'critical',
      title: `Restore drill failed: ${drill.backupId ?? drill.runId}`,
      body: `The restore drill ${drill.runId} of backup ${drill.backupId ?? 'unknown'} failed${
        failedChecks.length ? ` (checks: ${failedChecks.join(', ')})` : ''
      }. The backup may not be restorable. See Settings → Backups.`,
      dedupeKey: `restore_drill.failed:${drill.runId}`,
    });
  }
  const drillOk = status?.lastSuccessfulDrill ?? null;
  const drillOkAt = at(drillOk?.startedAt);
  const drillsOn = heartbeat?.nextDrillAt !== null;
  if (drillsOn && lastOkAt !== null) {
    const drillOverdue = drillOkAt === null ? t - lastOkAt > 86_400_000 : t - drillOkAt > DRILL_OVERDUE_MS;
    if (drillOverdue) {
      out.push({
        ...base,
        kind: 'restore_drill.failed',
        severity: 'warning',
        title: 'Restore drill overdue',
        body:
          drillOk === null
            ? 'No restore drill has passed since backups started. See Settings → Backups.'
            : `No restore drill has passed since ${drillOk.startedAt} (${drillOk.runId}). See Settings → Backups.`,
        dedupeKey: `restore_drill.overdue:${drillOk?.runId ?? 'none'}`,
      });
    }
  }
  // p11-master-resilience: standby readiness.
  const sb = files.standby ?? null;
  if (sb?.walArchive.enabled === true) {
    if (sb.lagSeconds >= WAL_LAG_FAIL_S / 2) {
      out.push({
        ...base,
        kind: 'backup.failed',
        severity: 'critical',
        title: 'Standby WAL shipping is behind',
        body: `Archived WAL has not reached the off-site copy for ${String(Math.round(sb.lagSeconds / 60))} min (${String(sb.pendingSegments)} segments pending; last shipped ${sb.lastShippedSegment ?? 'none'}). See Settings → Backups.`,
        dedupeKey: `standby.wal_lag:${sb.lastShippedSegment ?? 'none'}`,
      });
    }
    const lb = sb.lastBaseBackup;
    if (lb?.outcome === 'failed') {
      out.push({
        ...base,
        kind: 'backup.failed',
        severity: 'warning',
        title: `Base backup failed: ${lb.id}`,
        body: `The physical base backup ${lb.id} (started ${lb.startedAt}) failed; the standby restore keeps using the previous base. See Settings → Backups.`,
        dedupeKey: `standby.base:${lb.id}`,
      });
    }
  }
  return out;
}
