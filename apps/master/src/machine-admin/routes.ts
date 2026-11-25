import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  ELEVATED_RECIPES,
  InspectSection,
  MAX_MACHINE_MEMORY,
  ToolInventoryReport,
  ToolRecipeId,
  ToolVersion,
  TOOLS_FEATURE,
} from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget } from '../authz/resources.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { OpBody } from '../remote-ops/routes.js';
import type { RemoteOpsService } from '../remote-ops/service.js';
import { actorOf } from '../workers/routes.js';
import type { MachineAdminService } from './service.js';
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
const Json = z.record(z.string(), z.unknown());
const WorkerParams = z.object({ id: z.string().min(1).max(64) });
const ToolParams = z.object({ id: z.string().min(1).max(64), tool: ToolRecipeId });

const CommandBody = z.object({
  requestId: z.string(),
  jobId: z.string(),
  attemptId: z.string(),
  kind: z.string(),
  summary: z.string(),
  /** p17-worker-1-1-1: the agent's stated purpose (unverified), null for older workers. */
  purpose: z.string().nullable(),
  state: z.string(),
  autoApproved: z.boolean(),
  approvalId: z.string().nullable(),
  reason: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  file: Json.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const MemoryBody = z.object({
  docId: z.string().nullable(),
  version: z.number().int(),
  content: z.string(),
  updatedAt: z.string().nullable(),
});
const ViewBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  connected: z.boolean(),
  supported: z.boolean(),
  desired: z.object({ enabled: z.boolean(), autoApprove: z.boolean(), generation: z.number().int() }),
  reported: Json.nullable(),
  reportedAt: z.string().nullable(),
  projectAutoApprove: z.boolean(),
  activeJob: z.object({ jobId: z.string(), state: z.string(), title: z.string() }).nullable(),
  commands: z.array(CommandBody),
  memory: MemoryBody,
});

/**
 * p5-machine-admin API (ADR-0021). Reading a machine's administration state, command log and memory is admin
 * information; switching machine administration on is OWNER-only with always-fresh step-up; starting a
 * machine-admin job needs always-fresh step-up too (it may run root/Administrator commands on the machine).
 * Tools: the inventory is fleet information (viewer+); detection, recipe installs and inspection are remote
 * operations (admin, step-up). An elevated recipe never installs here: it becomes a machine-admin job.
 */
export function machineAdminRoutes(
  service: MachineAdminService,
  remoteOps: RemoteOpsService,
  pool: Pool,
  clock: () => Date = () => new Date(),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['fleet'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', clock);
    const fresh = requireStepUp('always-fresh', clock);
    const read = { config: { authz: { action: 'machines.admin.read' as const } } };
    const opsWrite = { config: { authz: { action: 'workers.ops.write' as const } } };

    r.get(
      '/workers/:id/machine-admin',
      {
        ...read,
        schema: {
          tags,
          summary:
            'Machine administration of a worker: desired and reported opt-in, privileged helper, active job, elevated command log, machine memory',
          security: session,
          params: WorkerParams,
          response: { 200: ViewBody, ...errors },
        },
      },
      async (request) => {
        const v = await service.view(request.params.id);
        return { ...v, reported: v.reported as unknown as Record<string, unknown> | null };
      },
    );

    r.put(
      '/workers/:id/machine-admin',
      {
        config: {
          authz: {
            action: 'machines.admin.enable',
            auditDenied: { action: 'worker.machine_admin', target: paramTarget('worker') },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Enable or disable AI machine administration (root/Administrator commands of machine-admin jobs) on a worker (OWNER, always-fresh step-up, audited, owners/admins notified)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            enabled: z.boolean(),
            autoApprove: z.boolean(),
            expectedGeneration: z.number().int().min(0),
            reason: z.string().max(500).optional(),
          }),
          response: { 200: ViewBody, ...errors },
        },
      },
      async (request) => {
        const v = await service.setEnabled(request.params.id, request.body, actorOf(request));
        return { ...v, reported: v.reported as unknown as Record<string, unknown> | null };
      },
    );

    r.post(
      '/workers/:id/machine-admin/tasks',
      {
        config: { authz: { action: 'machines.admin.run' } },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Start a machine administration job on this worker (Claude Code; every elevated command is approved unless full access is allowed) (admin, always-fresh step-up)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            title: z.string().max(200).default(''),
            prompt: z
              .string()
              .max(32 * 1024)
              .default(''),
            approvalPolicy: z.enum(['ask-all', 'allow-all']).optional(),
            maxDurationSec: z
              .number()
              .int()
              .min(60)
              .max(12 * 3600)
              .optional(),
            recipe: z.strictObject({ tool: ToolRecipeId, version: ToolVersion.optional() }).optional(),
            /** p17-worker-managed: a fixed setup task of this release (rootless Docker for the worker user, Linux). */
            setup: z.enum(['rootless-docker']).optional(),
          }),
          response: { 201: z.object({ jobId: z.string(), state: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const out = await service.createTask(request.params.id, request.body, actorOf(request));
        return reply.code(201).send(out);
      },
    );

    r.get(
      '/workers/:id/machine-admin/commands/:requestId',
      {
        ...read,
        schema: {
          tags,
          summary: 'One elevated command: the exact operation, its decision and its redacted output',
          security: session,
          params: z.object({ id: z.string().min(1).max(64), requestId: z.uuid() }),
          response: {
            200: CommandBody.extend({ op: Json, output: z.string(), truncated: z.boolean() }),
            ...errors,
          },
        },
      },
      async (request) => service.command(request.params.id, request.params.requestId),
    );

    r.put(
      '/workers/:id/machine-memory',
      {
        config: { authz: { action: 'machines.admin.run' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: "Replace a machine's memory (what machine-admin jobs read first) (admin, step-up)",
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({
            content: z.string().max(MAX_MACHINE_MEMORY),
            expectedVersion: z.number().int().min(0),
          }),
          response: { 200: MemoryBody, ...errors },
        },
      },
      async (request) => service.editMemory(request.params.id, request.body, actorOf(request)),
    );

    // ---------------------------------------------------------------------------------------- tools

    r.get(
      '/workers/:id/tools',
      {
        config: { authz: { action: 'workers.read' } },
        schema: {
          tags,
          summary:
            'Tool inventory of a worker (browsers, Python, git, Docker, Node, ffmpeg …) and its recipes',
          security: session,
          params: WorkerParams,
          response: {
            200: z.object({
              workerId: z.string(),
              supported: z.boolean(),
              inventory: Json.nullable(),
              reportedAt: z.string().nullable(),
              machineAdminEnabled: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const { rows } = await pool.query<{
          id: string;
          features: unknown;
          tool_inventory: unknown;
          tool_inventory_at: Date | null;
        }>(
          `SELECT id, features, tool_inventory, tool_inventory_at FROM workers
            WHERE id = $1 AND approved_at IS NOT NULL AND archived_at IS NULL`,
          [request.params.id],
        );
        const w = rows[0];
        if (w === undefined) throw new HttpError(404, 'worker_not_found', 'No such worker.');
        const inv = ToolInventoryReport.safeParse(w.tool_inventory);
        const view = await service.view(w.id).catch(() => null);
        return {
          workerId: w.id,
          supported: Array.isArray(w.features) && (w.features as unknown[]).includes(TOOLS_FEATURE),
          inventory: inv.success ? inv.data : null,
          reportedAt: w.tool_inventory_at?.toISOString() ?? null,
          machineAdminEnabled: view?.desired.enabled === true,
        };
      },
    );

    r.post(
      '/workers/:id/tools/detect',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Detect the machine’s tools again now (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => remoteOps.request(request.params.id, { kind: 'tools.detect' }, actorOf(request)),
    );

    r.post(
      '/workers/:id/tools/:tool/install',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Install a tool from the release’s checksummed recipe into the worker’s own directory (admin, step-up). Recipes that need root/Administrator answer 409 machine_admin_required.',
          security: csrf,
          params: ToolParams,
          body: z.strictObject({ version: ToolVersion.optional() }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) => {
        const { id, tool } = request.params;
        const inv = await pool.query<{ tool_inventory: unknown }>(
          'SELECT tool_inventory FROM workers WHERE id = $1',
          [id],
        );
        const parsed = ToolInventoryReport.safeParse(inv.rows[0]?.tool_inventory);
        const recipes = parsed.success ? parsed.data.recipes.filter((x) => x.tool === tool) : [];
        const wanted =
          request.body.version === undefined
            ? (recipes.find((x) => x.supported && !x.elevated) ?? recipes.find((x) => x.supported))
            : recipes.find((x) => x.version === request.body.version);
        const elevated =
          wanted?.elevated === true ||
          (wanted === undefined &&
            ELEVATED_RECIPES.some((e) => e.tool === tool && request.body.version === e.version));
        if (elevated) {
          throw new HttpError(
            409,
            'machine_admin_required',
            `Installing ${tool} on this machine needs root/Administrator: start it as a machine administration job.`,
            {},
            {},
            { tool },
          );
        }
        if (wanted === undefined) {
          throw new HttpError(
            400,
            'recipe_not_found',
            `This worker reports no ${tool} recipe it can install.`,
            {},
            {},
            { reason: 'worker', tool },
          );
        }
        if (!wanted.supported) {
          throw new HttpError(
            409,
            'recipe_unsupported',
            wanted.unsupportedReason ?? 'Not supported on this machine.',
          );
        }
        return remoteOps.request(
          id,
          { kind: 'tool.install', tool, version: wanted.version },
          actorOf(request),
        );
      },
    );

    r.post(
      '/workers/:id/tools/:tool/remove',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove a worker-installed tool version (admin, step-up)',
          security: csrf,
          params: ToolParams,
          body: z.strictObject({ version: ToolVersion }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        remoteOps.request(
          request.params.id,
          { kind: 'tool.remove', tool: request.params.tool, version: request.body.version },
          actorOf(request),
        ),
    );

    r.post(
      '/workers/:id/inspect',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Read-only inspection of the machine: installed software, services, disk, recent worker logs, tools (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          body: z.strictObject({ sections: z.array(InspectSection).min(1).max(5) }),
          response: { 200: OpBody, ...errors },
        },
      },
      async (request) =>
        remoteOps.request(
          request.params.id,
          { kind: 'machine.inspect', sections: [...new Set(request.body.sections)] },
          actorOf(request),
        ),
    );
  };
}
