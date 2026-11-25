import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { RuntimeKind, RuntimeVersion } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { OpBody } from '../remote-ops/routes.js';
import { actorOf } from '../workers/routes.js';
import type { CapabilityEvidenceService } from './service.js';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md §5): "Doğrula" and the evidence views.
 *
 *  - `POST /workers/:id/runtimes/:runtime/verify` — owner / admin (`workers.ops.write`), step-up of the security
 *    policy's `machines.ops` event, CSRF; audited and rate-limited by the service.
 *  - `GET /workers/:id/runtime-verification` — the machine's runtimes: effective status per capability, last run of the
 *    tuple, history, a running run, the expected tokens / time (`workers.ops.read`).
 *  - `GET /runtime-verification/platforms`, `/policy` — per platform which versions are proven; how many runtimes still
 *    depend on `allowUnverified` (`runtimes.read`).
 *  - `GET /runtime-verification/catalog`, `POST …/catalog/:runtime/:version/mark` — catalog runtime versions with a
 *    passed run, the owner's local "verified" mark (`releases.read` / `releases.publish` + step-up).
 */
const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  429: ErrorBodySchema,
  503: ErrorBodySchema,
};

const Result = z.object({
  capability: z.string(),
  status: z.string(),
  reason: z.string(),
  durationMs: z.number(),
});
const Run = z.object({
  id: z.string(),
  workerId: z.string(),
  machine: z.string(),
  runtime: z.string(),
  runtimeVersion: z.string(),
  adapterVersion: z.string(),
  platform: z.string(),
  workerVersion: z.string(),
  authMode: z.string(),
  sandboxProfile: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  stoppedBy: z.string().nullable(),
  passed: z.number(),
  failed: z.number(),
  results: z.array(Result),
});
const Decided = z
  .object({
    outcome: z.enum(['passed', 'failed']),
    reason: z.string(),
    at: z.string(),
    evidenceId: z.string(),
    workerId: z.string(),
  })
  .nullable();
const Effective = z.object({
  capability: z.string(),
  reported: z.string(),
  declared: z.string().nullable(),
  effective: z.string(),
  verified: z.boolean(),
  decided: Decided,
  note: z.string().nullable(),
});
export const WorkerVerificationBody = z.object({
  workerId: z.string(),
  supported: z.boolean(),
  connected: z.boolean(),
  runtimes: z.array(
    z.object({
      runtime: z.string(),
      version: z.string(),
      platform: z.string().nullable(),
      adapterVersion: z.string().nullable(),
      authMode: z.string().nullable(),
      state: z.enum(['verified', 'partial', 'unverified', 'not_applicable']),
      capabilities: z.array(Effective),
      lastRun: Run.nullable(),
      history: z.array(Run.extend({ applies: z.boolean() })),
      running: z.object({ opId: z.string(), state: z.string() }).nullable(),
      estimate: z.object({
        tokens: z.number(),
        durationSec: z.number(),
        maxTokens: z.number(),
        maxDurationSec: z.number(),
      }),
    }),
  ),
});
const PlatformsBody = z.object({
  items: z.array(
    z.object({
      runtime: z.string(),
      platform: z.string(),
      version: z.string(),
      adapterVersion: z.string(),
      current: z.boolean(),
      verified: z.array(z.string()),
      failed: z.array(z.string()),
      at: z.string(),
      machine: z.string(),
      workerId: z.string(),
    }),
  ),
});
const PolicyBody = z.object({
  total: z.number(),
  dependent: z.number(),
  items: z.array(
    z.object({
      workerId: z.string(),
      machine: z.string(),
      runtime: z.string(),
      version: z.string(),
      platform: z.string().nullable(),
      unverified: z.array(z.string()),
      canVerify: z.boolean(),
    }),
  ),
});
const CatalogBody = z.object({
  items: z.array(
    z.object({
      runtime: z.string(),
      version: z.string(),
      evidence: z.enum(['passed', 'failed', 'partial']),
      at: z.string(),
      machine: z.string(),
      platform: z.string(),
      evidenceId: z.string(),
      marked: z.object({ at: z.string(), by: z.string().nullable() }).nullable(),
    }),
  ),
});

export function capabilityEvidenceRoutes(
  service: CapabilityEvidenceService,
  clock: () => Date = () => new Date(),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['runtime-verification'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', clock);

    r.get(
      '/workers/:id/runtime-verification',
      {
        config: { authz: { action: 'workers.ops.read' as const } },
        schema: {
          tags,
          summary:
            'Runtime capability verification of a machine: effective status, last run, history, running run',
          security: session,
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: WorkerVerificationBody, ...errors },
        },
      },
      async (request) => (await service.status(request.params.id)) as z.infer<typeof WorkerVerificationBody>,
    );

    r.post(
      '/workers/:id/runtimes/:runtime/verify',
      {
        config: { authz: { action: 'workers.ops.write' as const } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Verify a runtime’s capabilities on this machine through the real adapter (owner / admin, step-up; spends tokens)',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64), runtime: RuntimeKind }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => service.start(request.params.id, request.params.runtime, actorOf(request)),
    );

    r.get(
      '/runtime-verification/platforms',
      {
        config: { authz: { action: 'runtimes.read' as const } },
        schema: {
          tags,
          summary: 'Per runtime and platform, which versions a verification run proved (latest run each)',
          security: session,
          response: { 200: PlatformsBody, ...errors },
        },
      },
      async () => ({ items: (await service.platforms()) as z.infer<typeof PlatformsBody>['items'] }),
    );

    r.get(
      '/runtime-verification/policy',
      {
        config: { authz: { action: 'runtimes.read' as const } },
        schema: {
          tags,
          summary: 'Installed runtimes whose job capabilities still depend on allowUnverified',
          security: session,
          response: { 200: PolicyBody, ...errors },
        },
      },
      async () => {
        const d = await service.policyDependence();
        return {
          total: d.total,
          dependent: d.dependent,
          items: d.items as z.infer<typeof PolicyBody>['items'],
        };
      },
    );

    r.get(
      '/runtime-verification/catalog',
      {
        config: { authz: { action: 'releases.read' as const } },
        schema: {
          tags,
          summary: 'Runtime versions with a verification run and the owner’s local verified mark',
          security: session,
          response: { 200: CatalogBody, ...errors },
        },
      },
      async () => ({ items: await service.catalog() }),
    );

    r.post(
      '/runtime-verification/catalog/:runtime/:version/mark',
      {
        config: { authz: { action: 'releases.publish' as const } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Mark a catalog runtime version verified on this installation after its run passed (admin, step-up)',
          security: csrf,
          params: z.object({ runtime: RuntimeKind, version: RuntimeVersion }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await service.markCatalogVerified(request.params.runtime, request.params.version, actorOf(request));
        return reply.code(204).send(null);
      },
    );
  };
}
