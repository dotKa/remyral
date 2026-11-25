import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/** p10-backup-restore: Settings → Backups (GET /backups/status, owners and admins). Status only, no download. */
export type HealthState = 'not_configured' | 'ok' | 'warning' | 'failing';
export interface HealthReason {
  readonly level: 'info' | 'warning' | 'failing';
  readonly code: string;
  readonly message: string;
}
export interface BackupRun {
  readonly runId: string;
  readonly reason?: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: 'ok' | 'partial' | 'failed';
  readonly tier: string | null;
  readonly schemaVersion: string | null;
  readonly dbBytes: number | null;
  readonly secrets: 'ok' | 'failed' | 'missing';
  readonly offsite: {
    readonly status: 'not_configured' | 'uploaded' | 'failed';
    readonly target: string | null;
    readonly error: string | null;
  };
  readonly warnings: readonly string[];
  readonly error: string | null;
}
export interface DrillRun {
  readonly runId: string;
  readonly backupId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: 'passed' | 'failed';
  readonly restoreMs: number | null;
  readonly totalMs: number | null;
  readonly dumpBytes: number | null;
  readonly restoredBytes: number | null;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
  readonly error: string | null;
}
/** p11-master-resilience: warm standby readiness (continuous WAL archiving + daily base backup). */
export interface StandbyStatus {
  readonly enabled: boolean;
  readonly lastShippedSegment: string | null;
  readonly lastShippedAt: string | null;
  readonly lastArchivedSegment: string | null;
  readonly lastArchivedAt: string | null;
  readonly lagSeconds: number;
  readonly pendingSegments: number;
  readonly localSegments: number;
  readonly offsiteConfigured: boolean;
  readonly lastError: string | null;
  readonly gaps: readonly string[];
  readonly lastBaseBackup: {
    readonly id: string;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly outcome: 'ok' | 'partial' | 'failed';
    readonly bytes: number | null;
    readonly offsite: 'not_configured' | 'uploaded' | 'failed';
    readonly error: string | null;
  } | null;
  readonly lastSuccessfulBaseBackupAt: string | null;
  readonly lastStandbyDrill: {
    readonly drillId: string;
    readonly at: string;
    readonly outcome: 'passed' | 'failed';
    readonly baseId: string | null;
    readonly targetTime: string | null;
    readonly recoveredTo: string | null;
    readonly replayedSegments: number;
    readonly restoreMs: number | null;
    readonly error: string | null;
  } | null;
}
export interface BackupOverview {
  readonly configured: boolean;
  readonly checkedAt: string;
  readonly health: { readonly state: HealthState; readonly reasons: readonly HealthReason[] };
  readonly problems: readonly string[];
  readonly env: string | null;
  readonly heartbeat: {
    readonly at: string;
    readonly startedAt: string;
    readonly nextBackupAt: string;
    readonly nextDrillAt: string | null;
    readonly schedule: {
      readonly mode: 'daily' | 'interval';
      readonly intervalMinutes: number | null;
      readonly timeOfDay: string;
      readonly drill: string;
    };
    readonly retention: {
      readonly daily: number;
      readonly weekly: number;
      readonly monthly: number;
      readonly keepRecentHours: number;
    };
  } | null;
  readonly storage: {
    readonly backups: number;
    readonly bytes: number;
    readonly freeBytes: number | null;
  } | null;
  readonly encryption: { readonly configured: boolean; readonly recipients: number } | null;
  readonly offsite: {
    readonly configured: boolean;
    readonly target: string | null;
    readonly lastUploadAt: string | null;
    readonly lastError: string | null;
  } | null;
  readonly lastBackup: BackupRun | null;
  readonly lastSuccessfulBackup: BackupRun | null;
  readonly backups: readonly BackupRun[];
  readonly lastDrill: DrillRun | null;
  readonly lastSuccessfulDrill: DrillRun | null;
  readonly drills: readonly DrillRun[];
  /** Absent from masters before p11-master-resilience. */
  readonly standby?: StandbyStatus;
}

const STATES: readonly HealthState[] = ['not_configured', 'ok', 'warning', 'failing'];

/** The master validates the response schema; the client checks the fields the page branches on. */
export function parseBackupOverview(v: unknown): BackupOverview {
  const o = obj(v);
  const health = obj(o.health);
  if (!STATES.includes(health.state as HealthState) || !Array.isArray(health.reasons)) {
    throw new ShapeError('unexpected backup status');
  }
  if (!Array.isArray(o.backups) || !Array.isArray(o.drills)) throw new ShapeError('unexpected backup status');
  return o as unknown as BackupOverview;
}

export function getBackupOverview(opts: Omit<RequestOptions, 'body'> = {}): Promise<BackupOverview> {
  return apiRequest('GET', '/backups/status', parseBackupOverview, opts);
}
