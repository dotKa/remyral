import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  ReleaseVersion,
  RuntimeKind,
  SignedSkillBundle,
  SKILL_LAYOUT_LIMITS,
  SkillId,
} from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import type { ContextActor } from '../context/store.js';
import { jobResource } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import type { RequestMeta, SkillService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  503: ErrorBody,
};

/** Upload body: ≤ 512 KiB of files (layout v2) + manifest + JSON escaping. */
export const SKILL_UPLOAD_BODY_LIMIT = 2 * 1024 * 1024;

const ProvenanceSchema = z.object({
  kind: z.enum(['upload', 'zip', 'github', 'catalog', 'chat']),
  repo: z.string().optional(),
  path: z.string().optional(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  fileName: z.string().optional(),
  importId: z.string().optional(),
  catalog: z.string().optional(),
});

const LayoutLimits = z.object({
  maxFiles: z.number().int(),
  maxFileBytes: z.number().int(),
  maxTotalBytes: z.number().int(),
  maxJobBytes: z.number().int(),
});

export const VersionSchema = z.object({
  version: z.string(),
  title: z.string(),
  description: z.string(),
  runtimes: z.array(z.string()),
  manifestSha256: z.string(),
  keyId: z.string(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  docVersion: z.number().int(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  signer: z.enum(['offline', 'panel', 'unknown']),
  /** p14-skill-import: where a panel-signed version came from (null: the offline upload path). */
  provenance: ProvenanceSchema.nullable(),
  /** p14-skill-catalogs: 2 = only skills-layout-v2 workers take this version. */
  layout: z.union([z.literal(1), z.literal(2)]),
});
export const AssignmentSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  project: z.string(),
  runtimes: z.array(z.string()).nullable(),
  version: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const SkillSchema = z.object({
  id: z.string(),
  docId: z.string(),
  deleted: z.boolean(),
  latest: z.string().nullable(),
  versions: z.array(VersionSchema),
  assignments: z.array(AssignmentSchema),
});

function human(request: FastifyRequest): ContextActor {
  const { subject } = authzOf(request);
  return { id: subject.userId, role: subject.role, ...stepUpFields(request) };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/**
 * Skills REST API (p6-skills). Reading is `skills.read` (viewer+); uploading a signed version
 * (`skills.publish`) and assigning skills to projects (`skills.assign`) are admin actions with step-up, CSRF
 * and audit. The master cannot sign: an upload is accepted only if it verifies against SKILLS_PUBLIC_KEYS.
 */
export function skillRoutes(
  skills: SkillService,
  db: Queryable,
  clock: () => Date = () => new Date(),
  /** p14-skill-import: whether GitHub imports are enabled (an outbound fetch is configured). */
  githubImport: () => boolean = () => false,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['skills'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/skills',
      {
        config: { authz: { action: 'skills.read' } },
        schema: {
          tags,
          summary: 'Skills with their signed versions and project assignments',
          security: session,
          querystring: z.object(offsetQuery(500)),
          response: {
            200: z.object({
              configured: z.boolean(),
              panelKey: z.object({ configured: z.boolean(), keyId: z.string().nullable() }),
              /** p14-skill-import: projects that accept only offline-signed skills; GitHub import availability. */
              offlineOnlyProjects: z.array(z.string()),
              imports: z.object({ github: z.boolean() }),
              /**
               * p14-skill-catalogs: the limits of layout 1 (every worker) and layout 2 (`skills-layout-v2` workers), and
               * how many approved machines take layout 2.
               */
              layouts: z.object({ v1: LayoutLimits, v2: LayoutLimits }),
              layoutV2Workers: z.object({ supported: z.number().int(), total: z.number().int() }),
              skills: z.array(SkillSchema),
              total: pageFields.total,
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const page = pageArray(await skills.list(), request.query);
        return {
          configured: skills.configured,
          panelKey: { configured: skills.panelKeyId !== null, keyId: skills.panelKeyId },
          offlineOnlyProjects: await skills.offlineOnlyProjects(),
          imports: { github: githubImport() },
          layouts: { v1: SKILL_LAYOUT_LIMITS[1], v2: SKILL_LAYOUT_LIMITS[2] },
          layoutV2Workers: await skills.layoutV2Workers(),
          skills: page.items,
          total: page.total,
        };
      },
    );

    r.get(
      '/skills/:id/versions/:version',
      {
        config: { authz: { action: 'skills.read' } },
        schema: {
          tags,
          summary: 'One signed skill version: its manifest and files',
          security: session,
          params: z.object({ id: SkillId, version: ReleaseVersion }),
          response: {
            200: z.object({
              manifest: z.record(z.string(), z.unknown()),
              files: z.array(
                z.object({
                  path: z.string(),
                  sha256: z.string(),
                  executable: z.boolean(),
                  content: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => skills.files(request.params.id, request.params.version),
    );

    r.post(
      '/skills',
      {
        config: { authz: { action: 'skills.publish' } },
        bodyLimit: SKILL_UPLOAD_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Upload a skill version signed offline with the skills key (scripts/skills/sign.mjs); refused unless it verifies against SKILLS_PUBLIC_KEYS (step-up)',
          security: csrf,
          body: SignedSkillBundle,
          response: { 200: VersionSchema, 201: VersionSchema, ...errors },
        },
      },
      async (request, reply) => {
        const out = await skills.upload(human(request), request.body, meta(request));
        return reply.code(out.created ? 201 : 200).send(out.version);
      },
    );

    r.get(
      '/skills/assignments',
      {
        config: { authz: { action: 'skills.read' } },
        schema: {
          tags,
          summary: 'Skill assignments, optionally for one project',
          security: session,
          querystring: z.object({
            project: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
              .optional(),
          }),
          response: { 200: z.object({ items: z.array(AssignmentSchema) }), ...errors },
        },
      },
      async (request) => ({ items: await skills.assignments(request.query.project) }),
    );

    r.put(
      '/skills/assignments',
      {
        config: { authz: { action: 'skills.assign' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Assign a skill to a project (optionally only some runtimes, optionally pinned to a version)',
          security: csrf,
          body: z.object({
            skillId: SkillId,
            /** A project id, or '*' for every project (p5-machine-admin). */
            project: z.string().regex(/^(\*|[A-Za-z0-9_.:-]{1,128})$/),
            runtimes: z.array(RuntimeKind).min(1).max(5).nullable().optional(),
            version: ReleaseVersion.nullable().optional(),
          }),
          response: { 200: AssignmentSchema, ...errors },
        },
      },
      async (request) => skills.assign(human(request), request.body, meta(request)),
    );

    r.delete(
      '/skills/assignments/:id',
      {
        config: { authz: { action: 'skills.assign' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove a skill assignment (jobs already dispatched keep their pinned skills)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await skills.unassign(human(request), request.params.id, meta(request));
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/jobs/:id/skills',
      {
        // A job's pins are job data: project-scoped like GET /jobs/:id (other projects' jobs look absent).
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary: 'The skill versions pinned for a job (set at its first dispatch)',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              setHash: z.string().nullable(),
              pins: z.array(z.object({ id: z.string(), version: z.string(), manifestSha256: z.string() })),
            }),
            ...errors,
          },
        },
      },
      async (request) => skills.pinsForJob(request.params.id),
    );
  };
}
