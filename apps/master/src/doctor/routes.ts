import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  DoctorFinding,
  DoctorSummary,
  SUPPORT_DESCRIPTION_MAX,
  SUPPORT_LOG_HOURS_MAX,
  SupportReportSection,
  WorkerDoctorReport,
} from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { RemoteOpsService } from '../remote-ops/service.js';
import type { ActorContext } from '../workers/fleet.js';
import { WORKER_ID_PATTERN } from '../workers/ids.js';
import { DoctorService, type DoctorRunView } from './service.js';
import type { ReportPreview, SupportService } from './support.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** p16-doctor: diagnostics and the support report (tests drive daily() / run()). */
    readonly doctor: { readonly service: DoctorService; readonly support: SupportService };
  }
}

/**
 * p16-doctor (docs/design/p16-doctor.md §6, ADR-0062): Ayarlar → Tanılama.
 *
 * - `doctor.run` (admin; an admin API token may read and run): the runs, running the doctor, asking one machine for its
 *   doctor, the support settings (without the password), building / previewing / downloading the redacted bundle —
 *   nothing leaves the installation, no authenticator code.
 * - `support.report` (admin, session + CSRF, step-up event `support.report`): sending the bundle by e-mail.
 * - `support.settings` (owner, session + CSRF, step-up event `support.report`): the support address and SMTP.
 */

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  410: ErrorBodySchema,
  422: ErrorBodySchema,
  502: ErrorBodySchema,
  503: ErrorBodySchema,
};

const WorkerResultBody = z.object({
  workerId: z.string(),
  name: z.string(),
  state: z.enum(['done', 'pending', 'failed', 'unsupported', 'offline']),
  source: z.enum(['doctor', 'diagnostics']).nullable(),
  opId: z.string().nullable(),
  reason: z.string().nullable(),
  report: WorkerDoctorReport.nullable(),
});

export const DoctorRunBody = z.object({
  id: z.string(),
  kind: z.enum(['manual', 'daily', 'chat']),
  scope: z.enum(['full', 'light']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  requestedBy: z.string().nullable(),
  summary: DoctorSummary,
  findings: z.array(DoctorFinding),
  workers: z.array(WorkerResultBody),
  newProblems: z.number().int(),
});

const RunListItem = z.object({
  id: z.string(),
  kind: z.enum(['manual', 'daily', 'chat']),
  scope: z.enum(['full', 'light']),
  startedAt: z.string(),
  summary: DoctorSummary,
  newProblems: z.number().int(),
});

export const SupportSettingsBody = z.object({
  email: z.string().nullable().describe('The support address; null = not set (reports are only downloaded).'),
  defaultEmail: z.string().nullable(),
  smtpSource: z.enum(['settings', 'notifications', 'none']),
  smtp: z
    .object({
      host: z.string(),
      port: z.number().int(),
      security: z.enum(['starttls', 'tls']),
      from: z.string(),
      username: z.string().nullable(),
      passwordSet: z.boolean().describe('Whether a password is stored (sealed); never the password.'),
    })
    .nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
});

const SettingsInput = z.strictObject({
  email: z.string().min(3).max(254).nullable().optional().describe('null clears the support address.'),
  smtp: z
    .strictObject({
      host: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65535),
      security: z.enum(['starttls', 'tls']),
      from: z.string().min(3).max(254),
      username: z.string().max(255).nullable().optional(),
      password: z
        .string()
        .max(1024)
        .nullable()
        .optional()
        .describe('Omit to keep the stored password; null removes it. Sealed at once, never returned.'),
    })
    .nullable()
    .optional(),
});

const ReportFileBody = z.object({
  path: z.string(),
  section: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  items: z.number().int().optional(),
});

export const ReportPreviewBody = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  sections: z.array(SupportReportSection),
  logHours: z.number().int(),
  files: z.array(ReportFileBody),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  filename: z.string(),
  overCap: z.boolean(),
  attachmentMaxBytes: z.number().int(),
  summary: z.string().describe('The Markdown summary (report.md) exactly as packed.'),
  description: z.string().nullable(),
  recipient: z.string().nullable(),
  ccAddress: z.string().nullable(),
  smtpReady: z.boolean(),
  sent: z
    .object({ at: z.string(), to: z.string(), cc: z.string().nullable(), attached: z.boolean() })
    .nullable(),
});

const BuildInput = z.strictObject({
  sections: z.array(SupportReportSection).min(1).max(8).optional(),
  hours: z.number().int().min(1).max(SUPPORT_LOG_HOURS_MAX).optional(),
  description: z.string().max(SUPPORT_DESCRIPTION_MAX).nullable().optional(),
});

function actorOf(request: FastifyRequest): ActorContext {
  return {
    userId: authzOf(request).subject.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

const previewJson = (p: ReportPreview): z.infer<typeof ReportPreviewBody> =>
  p as unknown as z.infer<typeof ReportPreviewBody>;

const runJson = (r: DoctorRunView): z.infer<typeof DoctorRunBody> =>
  r as unknown as z.infer<typeof DoctorRunBody>;

export function doctorRoutes(deps: {
  readonly doctor: DoctorService;
  readonly support: SupportService;
  readonly remoteOps: () => RemoteOpsService | null;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['doctor'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, deps.clock);
    const read = { authz: { action: 'doctor.run' as const } };
    const IdParams = z.object({ id: z.uuid() });

    r.get(
      '/doctor',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Diagnostics: the latest run, the latest daily run and the recent runs (owners and admins)',
          security: session,
          response: {
            200: z.object({
              latest: DoctorRunBody.nullable(),
              latestDaily: DoctorRunBody.nullable(),
              runs: z.array(RunListItem),
            }),
            ...errors,
          },
        },
      },
      async () => {
        const [latest, latestDaily, runs] = await Promise.all([
          deps.doctor.latest(),
          deps.doctor.latest('daily'),
          deps.doctor.list(20),
        ]);
        return {
          latest: latest === null ? null : runJson(latest),
          latestDaily: latestDaily === null ? null : runJson(latestDaily),
          runs,
        };
      },
    );

    r.post(
      '/doctor/runs',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Run every check now; with machines: true also ask every connected machine for its doctor (waits up to ~20 s)',
          security: csrf,
          body: z.strictObject({ machines: z.boolean().optional() }).optional(),
          response: { 200: DoctorRunBody, ...errors },
        },
      },
      async (request) =>
        runJson(
          await deps.doctor.run({
            kind: 'manual',
            scope: 'full',
            actor: actorOf(request),
            machines: request.body?.machines === true,
          }),
        ),
    );

    r.get(
      '/doctor/runs/:id',
      {
        config: read,
        schema: {
          tags,
          summary: 'One diagnostics run with its findings and machine results',
          security: session,
          params: IdParams,
          response: { 200: DoctorRunBody, ...errors },
        },
      },
      async (request) => runJson(await deps.doctor.get(request.params.id)),
    );

    r.post(
      '/doctor/machines/:workerId',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Ask one machine for its doctor (doctor.run; diagnostics.run on older workers) — poll GET /doctor/machines/:workerId/ops/:opId',
          security: csrf,
          params: z.object({ workerId: z.string().regex(WORKER_ID_PATTERN) }),
          response: {
            202: z.object({ opId: z.string(), source: z.enum(['doctor', 'diagnostics']) }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const { op, source } = await deps.doctor.requestMachine(request.params.workerId, actorOf(request));
        return reply.code(202).send({ opId: op.id, source });
      },
    );

    r.get(
      '/doctor/machines/:workerId/ops/:opId',
      {
        config: read,
        schema: {
          tags,
          summary: "A machine doctor request: its state and, once done, the machine's report",
          security: session,
          params: z.object({ workerId: z.string().regex(WORKER_ID_PATTERN), opId: z.uuid() }),
          response: {
            200: z.object({
              state: z.string(),
              reason: z.string().nullable(),
              report: WorkerDoctorReport.nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const ops = deps.remoteOps();
        if (ops === null)
          throw new HttpError(
            503,
            'unavailable',
            'Remote operations are not available.',
            {},
            {},
            { reason: 'remote_ops' },
          );
        const v = await ops.op(request.params.workerId, request.params.opId);
        if (v.kind !== 'doctor.run' && v.kind !== 'diagnostics.run')
          throw new HttpError(404, 'op_not_found', 'No such operation on this worker.');
        return { state: v.state, reason: v.reason, report: DoctorService.reportOf(v) };
      },
    );

    r.get(
      '/support/settings',
      {
        config: read,
        schema: {
          tags,
          summary: 'The support address and the SMTP the support mail uses (never the password)',
          security: session,
          response: { 200: SupportSettingsBody, ...errors },
        },
      },
      async () => deps.support.settings(),
    );

    r.put(
      '/support/settings',
      {
        config: { authz: { action: 'support.settings' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change the support address and / or the support SMTP server (owners; the password is sealed at once)',
          security: csrf,
          body: SettingsInput,
          response: { 200: SupportSettingsBody, ...errors },
        },
      },
      async (request) =>
        deps.support.updateSettings(actorOf(request), {
          ...(request.body.email === undefined ? {} : { email: request.body.email }),
          ...(request.body.smtp === undefined
            ? {}
            : {
                smtp:
                  request.body.smtp === null
                    ? null
                    : {
                        host: request.body.smtp.host,
                        port: request.body.smtp.port,
                        security: request.body.smtp.security,
                        from: request.body.smtp.from,
                        ...(request.body.smtp.username === undefined
                          ? {}
                          : { username: request.body.smtp.username }),
                        ...(request.body.smtp.password === undefined
                          ? {}
                          : { password: request.body.smtp.password }),
                      },
              }),
        }),
    );

    r.post(
      '/support/reports',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Build the redacted support bundle of the chosen sections and return its preview (files, sizes, summary); nothing is sent',
          security: csrf,
          body: BuildInput,
          response: { 201: ReportPreviewBody, ...errors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        const p = await deps.support.build(actorOf(request), {
          source: 'console',
          ...(b.sections === undefined ? {} : { sections: b.sections }),
          ...(b.hours === undefined ? {} : { hours: b.hours }),
          ...(b.description === undefined ? {} : { description: b.description }),
        });
        return reply.code(201).send(previewJson(p));
      },
    );

    r.get(
      '/support/reports/:id',
      {
        config: read,
        schema: {
          tags,
          summary: 'The preview of a built support bundle',
          security: session,
          params: IdParams,
          response: { 200: ReportPreviewBody, ...errors },
        },
      },
      async (request) => previewJson(await deps.support.preview(actorOf(request), request.params.id)),
    );

    r.get(
      '/support/reports/:id/download',
      {
        config: read,
        schema: {
          tags,
          summary: 'Download the redacted support bundle (zip; kept for 24 hours after it was built)',
          security: session,
          params: IdParams,
        },
      },
      async (request, reply) => {
        const d = await deps.support.download(actorOf(request), request.params.id);
        return reply
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${d.filename}"`)
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('cache-control', 'private, no-store')
          .header('x-remyral-sha256', d.sha256)
          .send(d.data);
      },
    );

    r.post(
      '/support/reports/:id/send',
      {
        config: { authz: { action: 'support.report' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Send the support bundle to the support address by e-mail (attached up to 10 MB, else the summary only); ccMe adds your notification e-mail',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ ccMe: z.boolean().optional() }).optional(),
          response: {
            200: z.object({
              to: z.string(),
              cc: z.string().nullable(),
              attached: z.boolean(),
              sizeBytes: z.number().int(),
              sha256: z.string(),
              sentAt: z.string(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        deps.support.send(actorOf(request), request.params.id, {
          ccMe: request.body?.ccMe === true,
          source: 'console',
        }),
    );
  };
}
