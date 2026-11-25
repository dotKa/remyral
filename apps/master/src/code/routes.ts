import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { CodeActor, CodeService } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  410: ErrorBody,
  413: ErrorBody,
  429: ErrorBody,
  502: ErrorBody,
  503: ErrorBody,
  504: ErrorBody,
};

const ProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Ref = z.string().max(255).optional();
const Path = z.string().max(1024);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Line = z.number().int().min(1).max(1_000_000);

const Entry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'dir', 'symlink', 'submodule']),
  size: z.number().nullable(),
});

const FileBody = z.object({
  project: z.string(),
  source: z.enum(['repo', 'workfiles']),
  ref: z.string(),
  path: z.string(),
  state: z.enum(['text', 'binary', 'too_large']),
  size: z.number(),
  text: z.string().nullable(),
  language: z.string().nullable(),
  redacted: z.boolean(),
});

const Side = z.object({
  sha: z.string().nullable(),
  state: z.enum(['text', 'binary', 'too_large', 'absent']),
  size: z.number(),
  text: z.string().nullable(),
});

const FilePair = z.object({ path: z.string(), previousPath: z.string().nullable(), old: Side, new: Side });

const ReviewFile = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

const Comment = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  path: z.string(),
  side: z.enum(['old', 'new']),
  startLine: z.number(),
  endLine: z.number(),
  commitSha: z.string(),
  body: z.string(),
  author: z.object({ id: z.string().nullable(), name: z.string().nullable() }),
  mine: z.boolean(),
  resolved: z.boolean(),
  outdated: z.boolean(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CommentCreate = z
  .strictObject({
    path: Path.min(1),
    side: z.enum(['old', 'new']),
    startLine: Line,
    endLine: Line,
    body: z.string().trim().min(1).max(4000),
    parentId: z.uuid().optional(),
  })
  .refine((c) => c.endLine >= c.startLine, { message: 'endLine before startLine', path: ['endLine'] });

const Hunk = z.strictObject({
  path: Path.min(1),
  previousPath: Path.min(1).optional(),
  oldStart: Line.nullable(),
  oldEnd: Line.nullable(),
  newStart: Line.nullable(),
  newEnd: Line.nullable(),
});

/**
 * p19-ide W1 (docs/design/p19-ide.md §5, §7, "Implementation (W1)"): the console's code viewer and diff reviewer.
 * Reads need `code.read` (viewer) on the project — on the job's project for `/jobs/:id/…`; an invisible project or job
 * is 404 like an unknown one. Comments and "Değişiklik iste" need `code.review` (operator); the latter also needs
 * `jobs.message` or `jobs.create`, checked by the service. Nothing here writes to a repository.
 */
export function codeRoutes(deps: { readonly service: CodeService; readonly db: Queryable }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const tags = ['code'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'job_not_found', 'Job not found.');
    const projectRead = { action: 'code.read' as const, resource: projectParam() };
    const jobRead = { action: 'code.read' as const, resource: jobResource(deps.db), notFound };
    const jobReview = (audit: string) => ({
      action: 'code.review' as const,
      resource: jobResource(deps.db),
      notFound,
      auditDenied: { action: audit, target: paramTarget('job') },
    });
    const actor = (request: FastifyRequest): CodeActor => {
      const meta = requestMeta(request);
      return {
        subject: authzOf(request).subject,
        userId: sessionOf(request).user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      };
    };
    const JobParams = z.object({ id: z.uuid() });

    r.get(
      '/projects/:id/code',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary:
            'What the Kod tab can show: the repository (provider, base branch, recent verified job branches) or the kept working files of a workspace project (viewer+)',
          security: session,
          params: z.object({ id: ProjectId }),
          response: {
            200: z.object({
              project: z.string(),
              kind: z.enum(['repository', 'workspace']),
              provider: z.string().nullable(),
              repositoryUrl: z.string().nullable(),
              defaultBranch: z.string().nullable(),
              supported: z.boolean(),
              reason: z.string().nullable(),
              branches: z.array(
                z.object({
                  jobId: z.string(),
                  title: z.string(),
                  branch: z.string(),
                  headSha: z.string(),
                  baseSha: z.string().nullable(),
                  state: z.string(),
                  at: z.string(),
                }),
              ),
              workfiles: z.array(
                z.object({
                  jobId: z.string(),
                  title: z.string().nullable(),
                  keptAt: z.string(),
                  workerConnected: z.boolean(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => service.source(authzOf(request).subject, request.params.id),
    );

    r.get(
      '/projects/:id/code/tree',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary:
            'One directory of the repository at a branch or commit (default: the base branch), read from the git provider (viewer+)',
          security: session,
          params: z.object({ id: ProjectId }),
          querystring: z.object({ ref: Ref, path: Path.optional() }),
          response: {
            200: z.object({
              sha: z.string(),
              path: z.string(),
              entries: z.array(Entry),
              truncated: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request) => service.tree(request.params.id, request.query.ref, request.query.path ?? ''),
    );

    r.get(
      '/projects/:id/code/file',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary:
            'One repository file at a branch or commit: redacted text ≤ 1 MiB, else a summary (binary / too large) (viewer+)',
          security: session,
          params: z.object({ id: ProjectId }),
          querystring: z.object({ ref: Ref, path: Path.min(1) }),
          response: { 200: FileBody, ...errors },
        },
      },
      async (request) => service.file(request.params.id, request.query.ref, request.query.path),
    );

    // p18-leftovers: the open pull / merge requests of the repository (the Kod tab lists them; each opens a compare).
    r.get(
      '/projects/:id/code/pulls',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary:
            'Open pull / merge requests of the project repository (≤ 30, newest change first) with the refs of their compare view (viewer+; read from the git provider, cached 60 s)',
          security: session,
          params: z.object({ id: ProjectId }),
          response: {
            200: z.object({
              supported: z.boolean(),
              items: z.array(
                z.object({
                  number: z.number().int(),
                  title: z.string(),
                  url: z.string().nullable(),
                  author: z.string().nullable(),
                  draft: z.boolean(),
                  baseBranch: z.string(),
                  headBranch: z.string(),
                  sameRepository: z.boolean(),
                  updatedAt: z.string().nullable(),
                  compare: z.object({ base: z.string(), head: z.string() }).nullable(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await service.pullRequests(request.params.id);
        return { supported: out.supported, items: out.items.map((i) => ({ ...i })) };
      },
    );

    r.get(
      '/projects/:id/code/compare',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary: 'Two branches or commits compared (base...head): the changed files (viewer+)',
          security: session,
          params: z.object({ id: ProjectId }),
          querystring: z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }),
          response: {
            200: z.object({
              baseSha: z.string(),
              headSha: z.string(),
              mergeBase: z.string(),
              files: z.array(ReviewFile),
              truncated: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request) => service.compare(request.params.id, request.query.base, request.query.head),
    );

    r.get(
      '/projects/:id/code/compare/file',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary:
            'Both sides of one changed file of a compare (by commit sha; redacted text or summaries) (viewer+)',
          security: session,
          params: z.object({ id: ProjectId }),
          querystring: z.object({
            base: Sha,
            head: Sha,
            path: Path.min(1),
            previousPath: Path.min(1).optional(),
          }),
          response: { 200: FilePair, ...errors },
        },
      },
      async (request) =>
        service.compareFile(
          request.params.id,
          request.query.base,
          request.query.head,
          request.query.path,
          request.query.previousPath ?? null,
        ),
    );

    // ---------------------------------------------------------------------- p18-last-gaps: compare comments
    const CompareQuery = z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) });
    const projectReview = (audit: string) => ({
      action: 'code.review' as const,
      resource: projectParam(),
      auditDenied: { action: audit, target: paramTarget('project') },
    });
    const Target = z.union([
      z.object({ mode: z.literal('job'), jobId: z.string(), branch: z.string().nullable() }),
      z.object({
        mode: z.literal('pull'),
        number: z.number().int(),
        headBranch: z.string(),
        baseBranch: z.string(),
        headSha: z.string().nullable(),
      }),
      z.object({ mode: z.literal('none'), reason: z.string() }),
    ]);

    r.get(
      '/projects/:id/code/compare/comments',
      {
        config: { authz: projectRead },
        schema: {
          tags,
          summary:
            'Review comments of a compare view (base / head as the view names them; outdated when the head moved) and where its “Değişiklik iste” goes: a job’s branch, an open pull request of the repository, or nowhere with the reason (viewer+)',
          security: session,
          params: z.object({ id: ProjectId }),
          querystring: CompareQuery,
          response: {
            200: z.object({ comments: z.array(Comment), headSha: z.string().nullable(), target: Target }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await service.compareComments(
          request.params.id,
          { base: request.query.base, head: request.query.head },
          sessionOf(request).user.id,
        );
        return { comments: out.comments, headSha: out.headSha, target: out.target };
      },
    );

    r.post(
      '/projects/:id/code/compare/comments',
      {
        config: { authz: projectReview('code.review.comment') },
        schema: {
          tags,
          summary:
            'Comment on lines of a compare view (anchored to its refs and the commits it showed), or reply to a thread (operator+)',
          security: csrf,
          params: z.object({ id: ProjectId }),
          body: z
            .strictObject({
              base: z.string().min(1).max(255),
              head: z.string().min(1).max(255),
              baseSha: Sha,
              headSha: Sha,
              path: Path.min(1),
              side: z.enum(['old', 'new']),
              startLine: Line,
              endLine: Line,
              body: z.string().trim().min(1).max(4000),
              parentId: z.uuid().optional(),
            })
            .refine((c) => c.endLine >= c.startLine, {
              message: 'endLine before startLine',
              path: ['endLine'],
            }),
          response: { 201: z.object({ comment: Comment }), ...errors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        const comment = await service.addCompareComment(
          actor(request),
          request.params.id,
          { base: b.base, head: b.head, baseSha: b.baseSha, headSha: b.headSha },
          {
            path: b.path,
            side: b.side,
            startLine: b.startLine,
            endLine: b.endLine,
            body: b.body,
            ...(b.parentId === undefined ? {} : { parentId: b.parentId }),
          },
        );
        return reply.code(201).send({ comment });
      },
    );

    r.patch(
      '/projects/:id/code/compare/comments/:cid',
      {
        config: { authz: projectReview('code.review.comment') },
        schema: {
          tags,
          summary: 'Edit one’s own compare comment, or resolve / reopen a thread (operator+)',
          security: csrf,
          params: z.object({ id: ProjectId, cid: z.uuid() }),
          body: z
            .strictObject({
              body: z.string().trim().min(1).max(4000).optional(),
              resolved: z.boolean().optional(),
            })
            .refine((b) => b.body !== undefined || b.resolved !== undefined, {
              message: 'nothing to change',
            }),
          response: { 200: z.object({ comment: Comment }), ...errors },
        },
      },
      async (request) => ({
        comment: await service.updateCompareComment(
          actor(request),
          request.params.id,
          request.params.cid,
          request.body,
        ),
      }),
    );

    r.delete(
      '/projects/:id/code/compare/comments/:cid',
      {
        config: { authz: projectReview('code.review.comment') },
        schema: {
          tags,
          summary:
            'Delete one’s own compare comment (owners and admins: any); a thread’s first comment takes its replies (operator+)',
          security: csrf,
          params: z.object({ id: ProjectId, cid: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await service.deleteCompareComment(actor(request), request.params.id, request.params.cid);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/projects/:id/code/compare/request-changes',
      {
        config: { authz: projectReview('code.review.request_changes') },
        schema: {
          tags,
          summary:
            '“Değişiklik iste” of a compare view: the open threads, rejected hunks (re-read from the provider) and a note go to the job whose branch the head is (message / follow-up job), or start a new job on the branch of the open pull request whose head it is (jobs.create; the review in its prompt); otherwise 409 with the reason (operator+; audited)',
          security: csrf,
          params: z.object({ id: ProjectId }),
          body: z.strictObject({
            base: z.string().min(1).max(255),
            head: z.string().min(1).max(255),
            note: z.string().max(4000).optional(),
            hunks: z.array(Hunk).max(20).optional(),
          }),
          response: {
            200: z.object({
              mode: z.enum(['message', 'job']),
              target: z.enum(['job', 'pull']),
              messageId: z.string().nullable(),
              jobId: z.string().nullable(),
              comments: z.number().int(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        service.compareRequestChanges(
          actor(request),
          request.params.id,
          { base: request.body.base, head: request.body.head },
          {
            ...(request.body.note === undefined ? {} : { note: request.body.note }),
            ...(request.body.hunks === undefined ? {} : { hunks: request.body.hunks }),
          },
        ),
    );

    r.get(
      '/jobs/:id/code/workfile',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            'One kept working file of a workspace job as redacted text ≤ 1 MiB (read from its machine; the machine must be online) (viewer+)',
          security: session,
          params: JobParams,
          querystring: z.object({ path: Path.min(1) }),
          response: { 200: FileBody, ...errors },
        },
      },
      async (request) => service.workfile(authzOf(request).subject, request.params.id, request.query.path),
    );

    r.get(
      '/jobs/:id/review',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            'The job’s verified changes for the diff reviewer: base / head and the changed files (viewer+)',
          security: session,
          params: JobParams,
          response: {
            200: z.object({
              jobId: z.string(),
              project: z.string(),
              baseSha: z.string(),
              headSha: z.string(),
              branch: z.string().nullable(),
              targetBranch: z.string(),
              files: z.array(ReviewFile),
              truncated: z.boolean(),
              supported: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async (request) => service.jobReview(request.params.id),
    );

    r.get(
      '/jobs/:id/review/file',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            'Both sides of one changed file of the job (base and head; redacted text or summaries) (viewer+)',
          security: session,
          params: JobParams,
          querystring: z.object({ path: Path.min(1), previousPath: Path.min(1).optional() }),
          response: { 200: FilePair, ...errors },
        },
      },
      async (request) =>
        service.jobReviewFile(request.params.id, request.query.path, request.query.previousPath ?? null),
    );

    r.get(
      '/jobs/:id/review/comments',
      {
        config: { authz: jobRead },
        schema: {
          tags,
          summary:
            'Review comments of the job’s changes (threads; outdated when the reviewed head moved) (viewer+)',
          security: session,
          params: JobParams,
          response: { 200: z.object({ comments: z.array(Comment) }), ...errors },
        },
      },
      async (request) => ({
        comments: await service.comments(request.params.id, sessionOf(request).user.id),
      }),
    );

    r.post(
      '/jobs/:id/review/comments',
      {
        config: { authz: jobReview('code.review.comment') },
        schema: {
          tags,
          summary: 'Comment on lines of the job’s changes, or reply to a thread (operator+)',
          security: csrf,
          params: JobParams,
          body: CommentCreate,
          response: { 201: z.object({ comment: Comment }), ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send({ comment: await service.addComment(actor(request), request.params.id, request.body) }),
    );

    r.patch(
      '/jobs/:id/review/comments/:cid',
      {
        config: { authz: jobReview('code.review.comment') },
        schema: {
          tags,
          summary: 'Edit one’s own comment, or resolve / reopen a thread (operator+)',
          security: csrf,
          params: z.object({ id: z.uuid(), cid: z.uuid() }),
          body: z
            .strictObject({
              body: z.string().trim().min(1).max(4000).optional(),
              resolved: z.boolean().optional(),
            })
            .refine((b) => b.body !== undefined || b.resolved !== undefined, {
              message: 'nothing to change',
            }),
          response: { 200: z.object({ comment: Comment }), ...errors },
        },
      },
      async (request) => ({
        comment: await service.updateComment(
          actor(request),
          request.params.id,
          request.params.cid,
          request.body,
        ),
      }),
    );

    r.delete(
      '/jobs/:id/review/comments/:cid',
      {
        config: { authz: jobReview('code.review.comment') },
        schema: {
          tags,
          summary:
            'Delete one’s own comment (owners and admins: any); a thread’s first comment takes its replies (operator+)',
          security: csrf,
          params: z.object({ id: z.uuid(), cid: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await service.deleteComment(actor(request), request.params.id, request.params.cid);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/jobs/:id/review/request-changes',
      {
        config: { authz: jobReview('code.review.request_changes') },
        schema: {
          tags,
          summary:
            '“Değişiklik iste”: the open review threads, rejected hunks (re-read from the provider) and a note go to the job’s agent as a message while it runs, else to a follow-up job started on the job’s verified head (operator+; audited)',
          security: csrf,
          params: JobParams,
          body: z.strictObject({
            note: z.string().max(4000).optional(),
            hunks: z.array(Hunk).max(20).optional(),
          }),
          response: {
            200: z.object({
              mode: z.enum(['message', 'job']),
              messageId: z.string().nullable(),
              jobId: z.string().nullable(),
              comments: z.number().int(),
            }),
            ...errors,
          },
        },
      },
      async (request) => service.requestChanges(actor(request), request.params.id, request.body),
    );
  };
}
