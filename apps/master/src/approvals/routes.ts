import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import { visibleProjects } from '../authz/model.js';
import {
  approvalResource,
  paramTarget,
  projectBody,
  projectParam,
  projectQuery,
} from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { cursorOrBadRequest, keysetQuery, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { JOB_TITLE_SQL } from '../jobs/approval-mode-sql.js';
import { JobStoreError } from '../jobs/errors.js';
import { ApprovalHeadlineBody, ApprovalHintsBody, detailsView } from './details.js';
import { ApprovalError } from './errors.js';
import {
  APPROVAL_ACTIONS,
  APPROVER_ROLES,
  PLATFORM_POLICY,
  POLICY_OUTCOMES,
  type ResolvedRule,
  resolveAll,
  RISKS,
} from './policy.js';
import type { HumanActor, ProjectPolicyStore, RequestMeta, StoredProjectPolicy } from './policy-store.js';
import {
  APPROVAL_STATUSES,
  MAX_BULK_MERGES,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalService,
} from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const Id = z.string().min(1).max(64);
const Project = z.string().min(1).max(128);
const Reason = z.string().max(1000);

const Rule = z.object({
  outcome: z.enum(POLICY_OUTCOMES),
  approverRole: z.enum(APPROVER_ROLES),
  requiredApprovals: z.number().int(),
  expiresInSec: z.number().int(),
  stepUp: z.boolean(),
  risk: z.enum(RISKS),
});

/** p10-approval-readable: the call's structured fields (untrusted runtime text; render as text only). */
const ApprovalDetailsBody = z.object({
  tool: z.string(),
  description: z.string().optional(),
  command: z.string().optional(),
  commandTruncated: z.boolean().optional(),
  shell: z.enum(['posix', 'powershell', 'cmd']).optional(),
  cwd: z.string().optional(),
  workspaceRoot: z.string().optional(),
  paths: z.array(z.string()).optional(),
  morePaths: z.number().int().optional(),
  url: z.string().optional(),
});

const ApprovalRequestBody = z.object({
  id: z.string(),
  jobId: z.string(),
  project: z.string(),
  jobState: z.string(),
  attemptId: z.string().nullable(),
  epoch: z.number().int(),
  approvalKey: z.string(),
  kind: z.enum(['gate', 'in_run']),
  action: z.enum(APPROVAL_ACTIONS),
  requestedAction: z.string(),
  risk: z.enum(RISKS),
  summary: z.string(),
  requestedBy: z.object({ type: z.enum(['runtime', 'worker', 'system']), id: z.string().nullable() }),
  workerId: z.string().nullable(),
  policyVersion: z.number().int(),
  approverRole: z.enum(APPROVER_ROLES),
  requiredApprovals: z.number().int(),
  approvals: z.number().int(),
  stepUp: z.boolean(),
  status: z.enum(APPROVAL_STATUSES),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  decisionReason: z.string().nullable(),
  /** p10-approval-pause (additive): still waiting past "stale after"; the job was paused for it; it is paused now. */
  staleAt: z.string().nullable(),
  pauseRequestedAt: z.string().nullable(),
  jobPaused: z.boolean(),
  /** p10-approval-readable (additive): structured fields, static hints, one readable line. */
  details: ApprovalDetailsBody.nullable(),
  hints: ApprovalHintsBody.nullable(),
  headline: ApprovalHeadlineBody,
});

const DecisionBody = z.object({
  decision: z.enum(['approve', 'deny']),
  user: z.object({ id: z.string(), username: z.string() }),
  role: z.string(),
  reason: z.string().nullable(),
  stepUpAt: z.string().nullable(),
  decidedAt: z.string(),
});

const PolicyBody = z.object({
  project: z.string(),
  version: z.number().int(),
  rules: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  effective: z.record(z.string(), Rule.extend({ sources: z.array(z.string()) })),
  platform: z.record(
    z.string(),
    z.object({
      description: z.string(),
      default: Rule,
      floor: z.object({
        outcome: z.enum(POLICY_OUTCOMES),
        approverRole: z.enum(APPROVER_ROLES),
        requiredApprovals: z.number().int(),
        stepUp: z.boolean(),
        maxExpiresInSec: z.number().int(),
      }),
    }),
  ),
});

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** Exported for the ops thread (p12-diyalog Faz 1): the same wire shape as `GET /approvals`. */
export function requestJson(r: ApprovalRequestRecord): z.infer<typeof ApprovalRequestBody> {
  return {
    ...r,
    ...detailsView(r.details, r.summary),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: iso(r.decidedAt),
    staleAt: iso(r.staleAt),
    pauseRequestedAt: iso(r.pauseRequestedAt),
    jobPaused: r.jobState === 'PAUSED',
  };
}

function decisionJson(d: ApprovalDecisionRecord): z.infer<typeof DecisionBody> {
  return { ...d, stepUpAt: iso(d.stepUpAt), decidedAt: d.decidedAt.toISOString() };
}

function ruleJson(r: ResolvedRule): z.infer<typeof Rule> & { sources: string[] } {
  return {
    outcome: r.outcome,
    approverRole: r.approverRole,
    requiredApprovals: r.requiredApprovals,
    expiresInSec: r.expiresInSec,
    stepUp: r.stepUp,
    risk: r.risk,
    sources: [...r.sources],
  };
}

function policyJson(p: StoredProjectPolicy): z.infer<typeof PolicyBody> {
  const effective = resolveAll({ project: p });
  return {
    project: p.project,
    version: p.version,
    rules: p.rules,
    reason: p.reason,
    updatedAt: iso(p.updatedAt),
    updatedBy: p.updatedBy,
    effective: Object.fromEntries(APPROVAL_ACTIONS.map((a) => [a, ruleJson(effective[a])])),
    platform: Object.fromEntries(
      APPROVAL_ACTIONS.map((a) => [
        a,
        {
          description: PLATFORM_POLICY[a].description,
          default: PLATFORM_POLICY[a].default,
          floor: PLATFORM_POLICY[a].floor,
        },
      ]),
    ),
  };
}

/**
 * The deciding human. `role` is the effective role for the request's project (p5-rbac: a per-project
 * operator/viewer decides with their membership role, capped by their account role).
 */
function human(request: FastifyRequest): HumanActor {
  const authz = authzOf(request);
  return { id: authz.subject.userId, role: authz.role, ...stepUpFields(request) };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/** Maps engine errors to their public HTTP form; anything else stays a generic 500. */
function toHttp(err: unknown): unknown {
  if (err instanceof ApprovalError) return new HttpError(err.httpStatus, err.code, err.publicMessage);
  if (err instanceof JobStoreError) {
    return new HttpError(409, 'conflict', 'The job changed concurrently. Reload and try again.');
  }
  return err;
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

/** Approvals and project policy API (docs/design/p4-approvals.md). All routes need a full session. */
export function approvalRoutes(
  service: ApprovalService,
  policies: ProjectPolicyStore,
  clock: () => Date,
  db: Queryable,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['approvals'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const hidden = (): HttpError => new HttpError(404, 'approval_not_found', 'Approval request not found.');
    const approval = { resource: approvalResource(db), notFound: hidden };
    const project = { resource: projectParam() };
    const decideDenied = { action: 'approval.decide', target: paramTarget('approval') };

    r.get(
      '/approvals',
      {
        config: { authz: { action: 'approvals.read' } },
        schema: {
          tags,
          summary: 'Approval requests (pending: soonest deadline first; otherwise newest first)',
          security: session,
          querystring: z.object({
            status: z.enum(APPROVAL_STATUSES).optional(),
            ...keysetQuery(500),
          }),
          response: { 200: z.object({ items: z.array(ApprovalRequestBody), ...pageFields }), ...errors },
        },
      },
      async (request) => {
        const page = await cursorOrBadRequest(() =>
          service.listPage({
            projects: visibleProjects(authzOf(request).subject),
            ...(request.query.status ? { status: request.query.status } : {}),
            // Older clients sent no limit and got up to 100 rows: keep that default.
            limit: request.query.limit ?? 100,
            ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
          }),
        );
        return { items: page.items.map(requestJson), nextCursor: page.nextCursor };
      },
    );

    r.get(
      '/approvals/:id',
      {
        config: { authz: { action: 'approvals.read', ...approval } },
        schema: {
          tags,
          summary: 'One approval request with its decisions',
          security: session,
          params: z.object({ id: Id }),
          response: {
            200: z.object({ request: ApprovalRequestBody, decisions: z.array(DecisionBody) }),
            ...errors,
          },
        },
      },
      async (request) => {
        const found = await service.get(request.params.id);
        if (!found) throw hidden();
        return { request: requestJson(found.request), decisions: found.decisions.map(decisionJson) };
      },
    );

    const decideResponse = {
      200: z.object({ request: ApprovalRequestBody, final: z.boolean(), jobState: z.string().nullable() }),
      ...errors,
    };

    r.post(
      '/approvals/:id/approve',
      {
        config: { authz: { action: 'approvals.decide', ...approval, auditDenied: decideDenied } },
        schema: {
          tags,
          summary: 'Approve (role per policy; step-up when the rule requires it, ADR-0009 §10)',
          security: csrf,
          params: z.object({ id: Id }),
          body: z.object({ reason: Reason.optional() }),
          response: decideResponse,
        },
      },
      async (request) =>
        mapped(async () => {
          const res = await service.decide(request.params.id, 'approve', human(request), {
            ...meta(request),
            ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
          });
          return { request: requestJson(res.request), final: res.final, jobState: res.job?.state ?? null };
        }),
    );

    r.post(
      '/approvals/:id/deny',
      {
        config: { authz: { action: 'approvals.decide', ...approval, auditDenied: decideDenied } },
        schema: {
          tags,
          summary: 'Deny with a reason (same role and step-up rules as approve)',
          security: csrf,
          params: z.object({ id: Id }),
          body: z.object({ reason: Reason.min(1) }),
          response: decideResponse,
        },
      },
      async (request) =>
        mapped(async () => {
          const res = await service.decide(request.params.id, 'deny', human(request), {
            ...meta(request),
            reason: request.body.reason,
          });
          return { request: requestJson(res.request), final: res.final, jobState: res.job?.state ?? null };
        }),
    );

    // p22-output-delivery §2: the pending merge decisions of one project with their live merge check, for the bulk
    // approval on "Senden bekleyenler" (the request summaries were written at verification and do not change).
    r.get(
      '/approvals/merge-batch',
      {
        config: {
          authz: {
            action: 'approvals.read',
            resource: projectQuery(),
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'Pending merge decisions of a project (git.merge gate requests of merge requests in mode merge) with their job title and live merge check / CI state',
          security: session,
          querystring: z.object({ project: Project }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  jobId: z.string(),
                  title: z.string().nullable(),
                  stepUp: z.boolean(),
                  expiresAt: z.string(),
                  targetBranch: z.string().nullable(),
                  mergeState: z.string().nullable(),
                  conflictFiles: z.number().int(),
                  ciState: z.string().nullable(),
                  files: z.number().int().nullable(),
                }),
              ),
              max: z.number().int(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const { rows } = await db.query<{
          id: string;
          job_id: string;
          title: string | null;
          step_up: boolean;
          expires_at: Date;
          target_branch: string | null;
          merge_state: string | null;
          conflict_files: number;
          ci_state: string | null;
          files: number | null;
        }>(
          `SELECT r.id, r.job_id, COALESCE(${JOB_TITLE_SQL('j')}, j.spec->>'title') AS title, r.step_up, r.expires_at, g.target_branch, g.merge_state,
                  COALESCE(jsonb_array_length(g.merge_check->'files'), 0)::int AS conflict_files, g.ci_state,
                  (g.changes->'totals'->>'files')::int AS files
             FROM approval_requests r
             JOIN jobs j ON j.id = r.job_id
             JOIN git_merge_requests m ON m.approval_request_id = r.id
             LEFT JOIN job_git g ON g.job_id = r.job_id
            WHERE j.project = $1 AND r.status = 'pending' AND r.kind = 'gate' AND r.action = 'git.merge'
              AND m.mode = 'merge'
            ORDER BY r.created_at
            LIMIT 200`,
          [request.query.project],
        );
        return {
          items: rows.map((x) => ({
            id: x.id,
            jobId: x.job_id,
            title: x.title,
            stepUp: x.step_up,
            expiresAt: x.expires_at.toISOString(),
            targetBranch: x.target_branch,
            mergeState: x.merge_state,
            conflictFiles: x.conflict_files,
            ciState: x.ci_state,
            files: x.files,
          })),
          max: MAX_BULK_MERGES,
        };
      },
    );

    // p22-output-delivery §2: approve several merge decisions of one project with one confirmation. Every item is
    // decided like a single approval (role, expiry, staleness, step-up, audit); the merges run one after another.
    r.post(
      '/approvals/merge-batch',
      {
        config: {
          authz: {
            action: 'approvals.decide',
            resource: projectBody(),
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'approval.decide_bulk', target: () => null },
          },
        },
        schema: {
          tags,
          summary: `Approve up to ${String(MAX_BULK_MERGES)} pending merge decisions of one project (each decided like a single approval: role per rule, step-up when any needs it, audited per item); merges into one target run one after another`,
          security: csrf,
          body: z.object({
            project: Project,
            ids: z.array(Id).min(1).max(MAX_BULK_MERGES),
            reason: Reason.optional(),
          }),
          response: {
            200: z.object({
              results: z.array(
                z.object({
                  id: z.string(),
                  outcome: z.enum(['approved', 'pending', 'refused']),
                  code: z.string().optional(),
                  message: z.string().optional(),
                  jobState: z.string().nullable().optional(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => ({
          results: [
            ...(await service.approveMerges(request.body.project, request.body.ids, human(request), {
              ...meta(request),
              ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
            })),
          ],
        })),
    );

    // p15-autonomy: extend the "expires if nobody decides" deadline from the card (who may decide may extend).
    r.post(
      '/approvals/:id/extend',
      {
        config: {
          authz: {
            action: 'approvals.decide',
            ...approval,
            auditDenied: { action: 'approval.extend', target: paramTarget('approval') },
          },
        },
        preHandler: requireStepUp('standard', clock),
        schema: {
          tags,
          summary:
            'Extend a pending approval request’s expiry (addSec, or an absolute expiresAt), at most 7 days after it was created (role per rule; audited)',
          security: csrf,
          params: z.object({ id: Id }),
          body: z
            .object({
              addSec: z
                .number()
                .int()
                .min(60)
                .max(7 * 24 * 3600)
                .optional(),
              expiresAt: z.iso.datetime().optional(),
            })
            .refine((b) => (b.addSec === undefined) !== (b.expiresAt === undefined), {
              message: 'Give addSec or expiresAt.',
            }),
          response: { 200: z.object({ request: ApprovalRequestBody }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const out = await service.extendExpiry(
            request.params.id,
            human(request),
            {
              ...(request.body.addSec === undefined ? {} : { addSec: request.body.addSec }),
              ...(request.body.expiresAt === undefined
                ? {}
                : { expiresAt: new Date(request.body.expiresAt) }),
            },
            meta(request),
          );
          return { request: requestJson(out) };
        }),
    );

    r.get(
      '/projects/:id/policy',
      {
        config: { authz: { action: 'policy.read', ...project } },
        schema: {
          tags,
          summary: 'Project approval policy, effective rules and the platform floor (owner/admin)',
          security: session,
          params: z.object({ id: Project }),
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () => policyJson(await policies.get(request.params.id, human(request)))),
    );

    r.put(
      '/projects/:id/policy',
      {
        config: {
          authz: {
            action: 'policy.write',
            ...project,
            auditDenied: { action: 'policy.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary: 'Replace the project approval policy (owner/admin, step-up; new version)',
          security: csrf,
          params: z.object({ id: Project }),
          body: z.object({
            expectedVersion: z.number().int().min(0),
            rules: z.record(z.string(), z.unknown()),
            reason: Reason.optional(),
          }),
          response: { 200: PolicyBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const stored = await policies.put(
            request.params.id,
            {
              rules: request.body.rules,
              expectedVersion: request.body.expectedVersion,
              ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
            },
            human(request),
            meta(request),
          );
          return policyJson(stored);
        }),
    );
  };
}
