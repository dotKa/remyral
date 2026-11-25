import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { ApplierBody, copyAction, failHostAction, HostActionBody } from '../host-actions/routes.js';
import { actorOf } from '../workers/routes.js';
import { BackupConfigInput, BackupManageError, type BackupManageService, OffsiteInput } from './manage.js';
import type { BackupChangeWatch } from './time-lock.js';

/**
 * p17-host-actions part 3 (docs/design/p17-host-actions.md §5): Ayarlar → Yedekler, the owner's management — each
 * change a signed request for the remyral-ctl host applier.
 *
 * - `GET /backups/manage` (`host.actions.read`, owners): the applier, what the host applies, the off-site target
 *   (never its keys), the open and recent backup requests.
 * - `POST /backups/run`, `POST /backups/drill`, `PUT /backups/settings`, `PUT /backups/offsite`,
 *   `POST /backups/offsite/test`, `DELETE /backups/offsite` (`backups.manage`, owners; step-up `backups.manage`).
 * - `POST /backups/restore` (`backups.restore`, owners; safe-core, always-fresh step-up): replaces the database.
 * - p17-panel-settings Part 0: `GET /backups/pending-changes` (`host.actions.read`) and `POST /backups/changes/cancel`
 *   (`backups.manage`, no step-up: it only withdraws a change waiting for the host time lock).
 */
const ErrorBody = ErrorBodySchema;
const Json = z.record(z.string(), z.unknown());
const errors = {
  400: ErrorBody.extend({ result: Json.optional() }),
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody.extend({ result: Json.optional() }),
  503: ErrorBody,
};
const tags = ['backups'];
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];

export const PendingChange = z.object({
  change: z.enum(['recipients', 'offsite']),
  id: z.string(),
  since: z.string(),
  until: z.string(),
  added: z.array(z.string()),
  target: z.string(),
});
const Settings = z.object({
  time: z.string(),
  intervalMinutes: z.string(),
  keepDaily: z.string(),
  keepWeekly: z.string(),
  keepMonthly: z.string(),
  keepRecentHours: z.string(),
  drillEnabled: z.string(),
  drillWeekday: z.string(),
  drillTime: z.string(),
  walArchive: z.string(),
  recipients: z.array(z.string()),
  offsite: z.string(),
  // p17-panel-settings Part 0: changes waiting for the host time lock, and the last outcomes.
  pending: z.array(PendingChange),
  changes: z.array(z.object({ change: z.string(), state: z.string(), id: z.string(), at: z.string() })),
});
const Offsite = z.object({
  config: z
    .object({
      provider: z.string(),
      endpoint: z.string(),
      region: z.string(),
      bucket: z.string(),
      prefix: z.string(),
      pathStyle: z.boolean(),
    })
    .nullable(),
  keyIdHint: z.string().nullable(),
  keyFingerprint: z.string().nullable(),
  lastTest: Json.nullable(),
  lastTestAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  storageKeysAvailable: z.boolean(),
});
export const BackupManageBody = z.object({
  applier: ApplierBody,
  settings: Settings.nullable(),
  offsite: Offsite,
  open: HostActionBody.nullable(),
  recent: z.array(HostActionBody),
});
const OffsiteSaved = z.object({ test: Json, request: HostActionBody.nullable() });

/** One literal site per code (the console's error catalog is checked against them, scripts/i18n). */
function fail(err: unknown): never {
  if (err instanceof BackupManageError) {
    const m = err.message;
    const extra = err.result === undefined ? {} : { result: err.result };
    switch (err.code) {
      case 'invalid_backup_settings':
        throw new HttpError(400, 'invalid_backup_settings', m);
      case 'backup_recipients_too_few':
        throw new HttpError(400, 'backup_recipients_too_few', m);
      case 'invalid_offsite':
        throw new HttpError(400, 'invalid_offsite', m);
      case 'offsite_keys_required':
        throw new HttpError(400, 'offsite_keys_required', m);
      case 'offsite_test_failed':
        throw new HttpError(409, 'offsite_test_failed', m, {}, extra);
      case 'backup_not_found':
        throw new HttpError(409, 'backup_not_found', m);
    }
  }
  return failHostAction(err);
}

export function backupManageRoutes(deps: {
  readonly service: BackupManageService;
  readonly changes: BackupChangeWatch;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const manage = { authz: { action: 'backups.manage' as const } };
    const stepUp = requireStepUp(undefined, deps.clock);
    const fresh = requireStepUp('always-fresh', deps.clock);
    const view = async () => {
      const v = await deps.service.view();
      return {
        applier: { ...v.applier, kinds: [...v.applier.kinds], releases: [...v.applier.releases] },
        settings:
          v.settings === null
            ? null
            : {
                ...v.settings,
                recipients: [...v.settings.recipients],
                pending: v.settings.pending.map((p) => ({ ...p, added: [...p.added] })),
                changes: v.settings.changes.map((c) => ({ ...c })),
              },
        offsite: { ...v.offsite, config: v.offsite.config === null ? null : { ...v.offsite.config } },
        open: v.open === null ? null : copyAction(v.open),
        recent: v.recent.map(copyAction),
      };
    };

    r.get(
      '/backups/manage',
      {
        config: { authz: { action: 'host.actions.read' as const } },
        schema: {
          tags,
          summary:
            'Backup management: the host applier, the settings it applies, the off-site target (never its keys) and the backup requests',
          security: session,
          response: { 200: BackupManageBody, ...errors },
        },
      },
      view,
    );

    r.post(
      '/backups/run',
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Take a backup now (a signed request the host applier runs; the reason goes to the audit trail)',
          security: csrf,
          body: z.strictObject({ reason: z.string().max(200).default('') }),
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) =>
        copyAction(await deps.service.run(actorOf(request), request.body.reason).catch(fail)),
    );

    r.post(
      '/backups/drill',
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Start a restore drill now (into a throw-away database; the live one is untouched)',
          security: csrf,
          body: z.strictObject({ backupId: z.string().max(80).nullable().default(null) }),
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) =>
        copyAction(await deps.service.drill(actorOf(request), request.body.backupId).catch(fail)),
    );

    r.put(
      '/backups/settings',
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Schedule, retention, restore drill, WAL archiving and encryption recipients (at least two) — the host applies them into stack.env and backup-config',
          security: csrf,
          body: BackupConfigInput,
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) => copyAction(await deps.service.configure(actorOf(request), request.body).catch(fail)),
    );

    r.post(
      '/backups/offsite/test',
      {
        config: manage,
        schema: {
          tags,
          summary: 'Test an off-site target: a put / head / get / delete round trip (nothing is stored)',
          security: csrf,
          body: OffsiteInput,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => deps.service.testOffsite(request.body).catch(fail),
    );

    r.put(
      '/backups/offsite',
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set the off-site target (S3 / R2 / MinIO): tested, stored sealed, then handed to the host applier (keys never returned)',
          security: csrf,
          body: OffsiteInput,
          response: { 200: OffsiteSaved, ...errors },
        },
      },
      async (request) => {
        const out = await deps.service.saveOffsite(actorOf(request), request.body).catch(fail);
        return { test: out.test, request: out.request === null ? null : copyAction(out.request) };
      },
    );

    r.delete(
      '/backups/offsite',
      {
        config: manage,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Turn the off-site copy off (forget the keys; the host removes backup-config/offsite.env)',
          security: csrf,
          response: { 200: z.object({ request: HostActionBody.nullable() }), ...errors },
        },
      },
      async (request) => {
        const out = await deps.service.clearOffsite(actorOf(request)).catch(fail);
        return { request: out === null ? null : copyAction(out) };
      },
    );

    r.get(
      '/backups/pending-changes',
      {
        config: { authz: { action: 'host.actions.read' as const } },
        schema: {
          tags,
          summary:
            'Backup changes waiting for the host time lock (a new encryption recipient or off-site target; 72 h, the host clock)',
          security: session,
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  change: z.enum(['recipients', 'offsite']),
                  since: z.string(),
                  until: z.string(),
                  requestId: z.string(),
                  added: z.array(z.string()),
                  target: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async () => ({
        items: (await deps.changes.pending()).map((p) => ({ ...p, added: [...p.added] })),
      }),
    );

    r.post(
      '/backups/changes/cancel',
      {
        config: manage,
        schema: {
          tags,
          summary:
            'Cancel a backup change waiting for the host time lock (recipients, offsite or all; a signed request — it can only withdraw, never apply)',
          security: csrf,
          body: z.strictObject({ change: z.enum(['recipients', 'offsite', 'all']) }),
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) =>
        copyAction(await deps.service.cancelChange(actorOf(request), request.body.change).catch(fail)),
    );

    r.post(
      '/backups/restore',
      {
        config: { authz: { action: 'backups.restore' as const } },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Replace the live database with a backup of this host (destructive: the backup id typed again; owners; always-fresh step-up; audited)',
          security: csrf,
          body: z.strictObject({ backupId: z.string().max(80), confirm: z.string().max(80) }),
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) =>
        copyAction(
          await deps.service
            .restore(actorOf(request), { backupId: request.body.backupId, confirm: request.body.confirm })
            .catch(fail),
        ),
    );
  };
}
