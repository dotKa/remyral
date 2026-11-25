import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  DEFAULT_ACCOUNT_ID,
  LoginPasteCode,
  LoginRuntime,
  LogSource,
  MAX_LOG_BYTES,
  MAX_LOG_LINES,
  RuntimeAccountId,
  RuntimeKind,
  RuntimeVersion,
} from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { actorOf } from '../workers/routes.js';
import type { RemoteOpsService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};

const WorkerParams = z.object({ id: z.string().min(1).max(64) });
const RuntimeParams = z.object({ id: z.string().min(1).max(64), runtime: RuntimeKind });
/**
 * p13-runtime-accounts: optional body of the login routes. Older clients (and the API) send none: Fastify hands a
 * bodyless request to the validator as `null`, so the schema accepts `null` as well as `undefined` (p13-fix-login-auth;
 * `.optional()` alone answered such a login 400).
 */
const AccountBody = z.object({ account: RuntimeAccountId.optional() }).strict().nullish();

function accountOf(body: { account?: string | undefined } | null | undefined): { account?: string } {
  const a = body?.account;
  return a === undefined || a === DEFAULT_ACCOUNT_ID ? {} : { account: a };
}

const LoginParams = z.object({ id: z.string().min(1).max(64), runtime: LoginRuntime });
const OpParams = z.object({ id: z.string().min(1).max(64), opId: z.uuid() });

const Json = z.record(z.string(), z.unknown());
export const OpBody = z.object({
  id: z.string(),
  workerId: z.string(),
  kind: z.string(),
  params: Json,
  state: z.string(),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  progress: z
    .object({ step: z.string(), done: z.number().int().optional(), total: z.number().int().optional() })
    .nullable(),
  result: Json.nullable(),
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  login: z
    .object({
      runtime: z.string(),
      url: z.string().nullable(),
      userCode: z.string().nullable(),
      expectsCode: z.boolean(),
      codeSent: z.boolean(),
    })
    .nullable(),
  logs: z
    .object({
      lines: z.array(z.string()),
      next: z.number().int(),
      complete: z.boolean(),
      truncated: z.boolean(),
    })
    .nullable(),
});
const StatusBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  state: z.string(),
  connected: z.boolean(),
  supported: z.boolean(),
  report: Json.nullable(),
  reportedAt: z.string().nullable(),
  ops: z.array(OpBody),
  codeImages: z.object({ supported: z.boolean(), ready: z.boolean() }),
});

/**
 * Remote operations API (p5-remote-ops, ADR-0017). Admin only. Every operation needs step-up and CSRF, is
 * audited and rate-limited; login routes are in the always-fresh step-up class (a subscription login is an
 * account-security action). Reads poll an operation's progress, login relay and log lines.
 */
export function remoteOpsRoutes(service: RemoteOpsService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['remote-ops'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', clock);
    const fresh = requireStepUp('always-fresh', clock);
    const write = { config: { authz: { action: 'workers.ops.write' as const } } };
    const read = { config: { authz: { action: 'workers.ops.read' as const } } };

    r.get(
      '/workers/:id/ops',
      {
        ...read,
        schema: {
          tags,
          summary:
            'Remote operations of a worker: managed runtimes, login states, service, recent operations',
          security: session,
          params: WorkerParams,
          response: { 200: StatusBody, ...errors },
        },
      },
      async (request) => service.status(request.params.id),
    );

    r.get(
      '/workers/:id/ops/:opId',
      {
        ...read,
        schema: {
          tags,
          summary:
            'One operation: progress, result, login relay (URL / device code) and log lines after `after`',
          security: session,
          params: OpParams,
          querystring: z.object({ after: z.coerce.number().int().min(0).max(100_000).optional() }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => service.op(request.params.id, request.params.opId, request.query.after ?? 0),
    );

    r.post(
      '/workers/:id/runtimes/:runtime/install',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Install, upgrade or roll back a runtime to a pinned, checksummed version (admin, step-up)',
          security: csrf,
          params: RuntimeParams,
          body: z.strictObject({ version: RuntimeVersion }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          { kind: 'runtime.install', runtime: request.params.runtime, version: request.body.version },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/runtimes/:runtime/remove',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove a worker-managed runtime version (admin, step-up)',
          security: csrf,
          params: RuntimeParams,
          body: z.strictObject({ version: RuntimeVersion }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          { kind: 'runtime.remove', runtime: request.params.runtime, version: request.body.version },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/runtimes/:runtime/restart',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Re-detect a runtime and rebuild its adapter (running jobs keep theirs) (admin, step-up)',
          security: csrf,
          params: RuntimeParams,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          { kind: 'runtime.restart', runtime: request.params.runtime },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/runtimes/:runtime/login',
      {
        ...write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            "Start the runtime's own subscription login on the worker; the panel shows only its URL / device code (admin, always-fresh step-up)",
          security: csrf,
          params: LoginParams,
          // p13-runtime-accounts: the login of one account of the runtime (absent / default = the configured one).
          body: AccountBody,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          {
            kind: 'login.start',
            runtime: request.params.runtime,
            ...accountOf(request.body),
          },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/runtimes/:runtime/login-status',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: "Refresh the login state from the runtime's own status command (admin, step-up)",
          security: csrf,
          params: LoginParams,
          // p13-runtime-accounts: the login of one account of the runtime (absent / default = the configured one).
          body: AccountBody,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          {
            kind: 'login.status',
            runtime: request.params.runtime,
            ...accountOf(request.body),
          },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/runtimes/:runtime/logout',
      {
        ...write,
        preHandler: fresh,
        schema: {
          tags,
          summary: 'Log the runtime out with its own logout command (admin, always-fresh step-up)',
          security: csrf,
          params: LoginParams,
          // p13-runtime-accounts: the login of one account of the runtime (absent / default = the configured one).
          body: AccountBody,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          {
            kind: 'login.logout',
            runtime: request.params.runtime,
            ...accountOf(request.body),
          },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/ops/:opId/input',
      {
        ...write,
        preHandler: fresh,
        bodyLimit: 4096,
        schema: {
          tags,
          summary:
            'Paste back the code a login page showed; relayed to the login process only, never stored (admin, always-fresh step-up)',
          security: csrf,
          params: OpParams,
          body: z.strictObject({ code: LoginPasteCode }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.input(request.params.id, request.params.opId, request.body.code, actorOf(request)),
    );

    r.post(
      '/workers/:id/ops/:opId/cancel',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Cancel a running operation (a login waiting for the user, an install) (admin, step-up)',
          security: csrf,
          params: OpParams,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => service.cancel(request.params.id, request.params.opId, actorOf(request)),
    );

    r.post(
      '/workers/:id/restart',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Restart the worker service, optionally after draining running jobs (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            drain: z.boolean(),
            drainTimeoutSec: z
              .number()
              .int()
              .min(0)
              .max(24 * 3600)
              .default(1800),
          }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          {
            kind: 'service.restart',
            drain: request.body.drain,
            drainTimeoutSec: request.body.drainTimeoutSec,
          },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/logs',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Fetch the last worker log lines, redacted on the worker and again here (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            lines: z.number().int().min(1).max(MAX_LOG_LINES).default(300),
            maxBytes: z
              .number()
              .int()
              .min(1024)
              .max(MAX_LOG_BYTES)
              .default(128 * 1024),
            /** p6-worker-boot-diagnostics: worker (default) | boot | updater. */
            source: LogSource.default('worker'),
          }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(
          request.params.id,
          {
            kind: 'logs.tail',
            lines: request.body.lines,
            maxBytes: request.body.maxBytes,
            // Absent on the wire for the default: an older worker's signature check sees the same command as before.
            ...(request.body.source === 'worker' ? {} : { source: request.body.source }),
          },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/diagnostics',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Run diagnostics on the worker: disk, Node, sandbox readiness, runtimes, service (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => service.request(request.params.id, { kind: 'diagnostics.run' }, actorOf(request)),
    );

    r.post(
      '/workers/:id/disk/clean',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Run the worker’s disk hygiene now: drop what it owns and can recreate (temporary directories, rotated logs, staged releases, expired kept directories, inactive runtime versions, package caches) until the free space reaches its target (admin, step-up, audited)',
          security: csrf,
          params: WorkerParams,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => service.request(request.params.id, { kind: 'disk.clean' }, actorOf(request)),
    );

    r.post(
      '/workers/:id/code-images/prepare',
      {
        ...write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Prepare the code node images: pull the pinned bases by digest and build them on the worker (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        service.request(request.params.id, { kind: 'code.images.prepare' }, actorOf(request)),
    );
  };
}
