import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BackupOverview, BackupStatusService } from './service.js';
import { BackupRunBody as BackupRun, DrillRunBody as DrillRun } from './status.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const Reason = z.object({
  level: z.enum(['info', 'warning', 'failing']),
  code: z.string(),
  message: z.string(),
});

export const BackupOverviewBody = z.object({
  configured: z.boolean(),
  checkedAt: z.string(),
  health: z.object({
    state: z.enum(['not_configured', 'ok', 'warning', 'failing']),
    reasons: z.array(Reason),
  }),
  problems: z.array(z.string()),
  env: z.string().nullable(),
  heartbeat: z
    .object({
      at: z.string(),
      startedAt: z.string(),
      nextBackupAt: z.string(),
      nextDrillAt: z.string().nullable(),
      schedule: z.object({
        mode: z.enum(['daily', 'interval']),
        intervalMinutes: z.number().int().nullable(),
        timeOfDay: z.string(),
        drill: z.string(),
      }),
      retention: z.object({
        daily: z.number().int(),
        weekly: z.number().int(),
        monthly: z.number().int(),
        keepRecentHours: z.number().int(),
      }),
    })
    .nullable(),
  storage: z
    .object({ backups: z.number().int(), bytes: z.number().int(), freeBytes: z.number().int().nullable() })
    .nullable(),
  encryption: z.object({ configured: z.boolean(), recipients: z.number().int() }).nullable(),
  offsite: z
    .object({
      configured: z.boolean(),
      target: z.string().nullable(),
      lastUploadAt: z.string().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  lastBackup: BackupRun.nullable(),
  lastSuccessfulBackup: BackupRun.nullable(),
  backups: z.array(BackupRun),
  lastDrill: DrillRun.nullable(),
  lastSuccessfulDrill: DrillRun.nullable(),
  drills: z.array(DrillRun),
  /** p11-master-resilience: warm standby readiness (WAL shipping, base backups, the last standby drill). */
  standby: z.object({
    enabled: z.boolean(),
    lastShippedSegment: z.string().nullable(),
    lastShippedAt: z.string().nullable(),
    lastArchivedSegment: z.string().nullable(),
    lastArchivedAt: z.string().nullable(),
    lagSeconds: z.number().int(),
    pendingSegments: z.number().int(),
    localSegments: z.number().int(),
    offsiteConfigured: z.boolean(),
    lastError: z.string().nullable(),
    gaps: z.array(z.string()),
    lastBaseBackup: z
      .object({
        id: z.string(),
        startedAt: z.string(),
        finishedAt: z.string().nullable(),
        outcome: z.enum(['ok', 'partial', 'failed']),
        bytes: z.number().int().nullable(),
        offsite: z.enum(['not_configured', 'uploaded', 'failed']),
        error: z.string().nullable(),
      })
      .nullable(),
    lastSuccessfulBaseBackupAt: z.string().nullable(),
    lastStandbyDrill: z
      .object({
        drillId: z.string(),
        at: z.string(),
        outcome: z.enum(['passed', 'failed']),
        baseId: z.string().nullable(),
        targetTime: z.string().nullable(),
        recoveredTo: z.string().nullable(),
        replayedSegments: z.number().int(),
        restoreMs: z.number().int().nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
  }),
});

/**
 * p10-backup-restore §6: Settings → Backups. Status only (owners/admins, `backups.read`): there is deliberately no
 * download of dumps or archives through the console — restores follow docs/ops/backup-restore.md.
 */
export function backupRoutes(deps: { readonly service: BackupStatusService }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/backups/status',
      {
        config: { authz: { action: 'backups.read' } },
        schema: {
          tags: ['backups'],
          summary: 'Backup and restore-drill status (owners and admins)',
          security: [{ session: [] }],
          response: { 200: BackupOverviewBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      async () => {
        const o = await deps.service.overview();
        const s = o.status;
        return {
          configured: o.configured,
          checkedAt: o.checkedAt,
          health: { state: o.health.state, reasons: [...o.health.reasons] },
          problems: [...o.problems],
          env: s?.env ?? o.heartbeat?.env ?? null,
          heartbeat: o.heartbeat
            ? {
                at: o.heartbeat.at,
                startedAt: o.heartbeat.startedAt,
                nextBackupAt: o.heartbeat.nextBackupAt,
                nextDrillAt: o.heartbeat.nextDrillAt,
                schedule: o.heartbeat.schedule,
                retention: o.heartbeat.retention,
              }
            : null,
          storage: s?.storage ?? null,
          encryption: s ? { configured: s.encryption.configured, recipients: s.encryption.recipients } : null,
          offsite: s?.offsite ?? null,
          lastBackup: s?.lastBackup ?? null,
          lastSuccessfulBackup: s?.lastSuccessfulBackup ?? null,
          backups: s?.backups.slice(0, 10) ?? [],
          lastDrill: s?.lastDrill ?? null,
          lastSuccessfulDrill: s?.lastSuccessfulDrill ?? null,
          drills: s?.drills.slice(0, 10) ?? [],
          standby: standbyView(o),
        };
      },
    );
  };
}

/** p11-master-resilience: the standby block of the response (disabled when WAL archiving never reported). */
function standbyView(o: BackupOverview): z.infer<typeof BackupOverviewBody>['standby'] {
  const sb = o.standby ?? null;
  const drill = o.status?.drills.find((d) => d.standby != null) ?? null;
  const lb = sb?.lastBaseBackup ?? null;
  return {
    enabled: sb?.walArchive.enabled === true,
    lastShippedSegment: sb?.lastShippedSegment ?? null,
    lastShippedAt: sb?.lastShippedAt ?? null,
    lastArchivedSegment: sb?.lastArchivedSegment ?? null,
    lastArchivedAt: sb?.lastArchivedAt ?? null,
    lagSeconds: sb?.lagSeconds ?? 0,
    pendingSegments: sb?.pendingSegments ?? 0,
    localSegments: sb?.localSegments ?? 0,
    offsiteConfigured: sb?.offsite.configured === true,
    lastError: sb?.offsite.lastError ?? null,
    gaps: [...(sb?.gaps ?? [])],
    lastBaseBackup: lb
      ? {
          id: lb.id,
          startedAt: lb.startedAt,
          finishedAt: lb.finishedAt,
          outcome: lb.outcome,
          bytes: lb.bytes,
          offsite: lb.offsite.status,
          error: lb.error,
        }
      : null,
    lastSuccessfulBaseBackupAt: sb?.lastSuccessfulBaseBackup?.finishedAt ?? null,
    lastStandbyDrill:
      drill?.standby != null
        ? {
            drillId: drill.runId,
            at: drill.standby.at,
            outcome: drill.standby.outcome,
            baseId: drill.standby.baseId,
            targetTime: drill.standby.targetTime,
            recoveredTo: drill.standby.recoveredTo,
            replayedSegments: drill.standby.replayedSegments,
            restoreMs: drill.standby.restoreMs,
            error: drill.standby.error,
          }
        : null,
  };
}
