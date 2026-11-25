import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import {
  checkStoredDefinitions,
  type NormaliseReport,
  reportLines,
} from '../workflows/v2/normalise-check.js';

/**
 * p17-panel-settings Part 6 (docs/design/p17-panel-settings.md §8): `workflow:normalise-check` from the panel — the CLI's
 * read-only dry run (every stored workflow definition normalises to a valid v2 document and converts back unchanged;
 * open runs per engine) as `POST /panel-settings/workflows/check` (`settings.panel.read`; nothing changes, audited
 * `settings.workflow.check`). The workflows section also runs it itself before engine 2 is turned on for version-1
 * workflows and refuses the switch while a definition fails.
 */
export const WorkflowCheckBody = z.object({
  total: z.number(),
  v1: z.number(),
  v2: z.number(),
  v1Workflows: z.number(),
  openRuns: z.object({ engine1: z.number(), engine2: z.number() }),
  failures: z.array(z.object({ id: z.string(), reason: z.string() })),
  lines: z.array(z.string()),
});

export function checkView(r: NormaliseReport): z.infer<typeof WorkflowCheckBody> {
  return {
    total: r.total,
    v1: r.v1,
    v2: r.v2,
    v1Workflows: r.v1Workflows,
    openRuns: { ...r.openRuns },
    failures: r.failures.slice(0, 100).map((f) => ({ id: f.id, reason: f.reason.slice(0, 300) })),
    lines: reportLines(r).slice(0, 200),
  };
}

export function workflowCheckRoutes(deps: { readonly pool: Pool; readonly audit: AuditRecorder }) {
  return (app: FastifyInstance): void => {
    app.withTypeProvider<ZodTypeProvider>().post(
      '/panel-settings/workflows/check',
      {
        config: { authz: { action: 'settings.panel.read' as const } },
        schema: {
          tags: ['panel-settings'],
          summary:
            'Dry run of workflow:normalise-check: every stored definition normalises to v2 and back; open runs per engine (nothing changes)',
          security: [{ session: [], csrf: [] }],
          response: { 200: WorkflowCheckBody, 401: ErrorBodySchema, 403: ErrorBodySchema },
        },
      },
      async (request) => {
        const r = await checkStoredDefinitions(deps.pool);
        const a = actorOf(request);
        await deps.audit.record({
          actor: { type: 'user', id: a.userId },
          ip: a.ip,
          userAgent: a.userAgent,
          action: 'settings.workflow.check',
          target: 'workflow-definitions',
          outcome: r.failures.length === 0 ? 'success' : 'failure',
          metadata: { total: r.total, v1: r.v1, failures: r.failures.length },
        });
        return checkView(r);
      },
    );
  };
}
