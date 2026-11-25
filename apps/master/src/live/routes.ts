import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../audit/access.js';
import { cursorOrBadRequest } from '../audit/routes.js';
import { jobResource } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { parseCursor } from './sse.js';
import { EVENT_KINDS, type LiveStore, LOG_STREAMS, MAX_PAGE } from './store.js';
import type { LiveStreams } from './stream.js';
import { EventBody, eventJson, LogBody, logJson } from './wire.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/** The verified attempt diff of a job (p4-git-flow), as text. */
export interface DiffSource {
  patch(
    jobId: string,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean; baseSha: string; headSha: string } | null>;
}

export const MAX_DIFF_BYTES = 1024 * 1024;

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 429: ErrorBody };

const Cursor = z.string().min(1).max(512);
const Seq = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);

/**
 * Live job view (docs/design/p5-live.md §5): SSE stream, paginated logs (search) and events, summary and
 * the attempt diff. Every route is `jobs.read` on the job's project (viewer+ member); invisible jobs are
 * 404 like unknown ones. Nothing here changes a job; cancel and approvals use their own routes.
 */
export function liveRoutes(deps: {
  readonly store: LiveStore;
  readonly streams: LiveStreams;
  readonly db: Queryable;
  readonly diff: () => DiffSource | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const security = [{ session: [] }];
    const hidden = (): HttpError => new HttpError(404, 'job_not_found', 'Job not found.');
    const job = { action: 'jobs.read', resource: jobResource(deps.db), notFound: hidden } as const;

    app.addHook('preClose', (done) => {
      deps.streams.closeAll();
      done();
    });

    r.get(
      '/jobs/:id/stream',
      {
        config: { authz: job },
        schema: {
          tags,
          summary:
            'Live stream of a job (text/event-stream): log and event frames with `id` = stream sequence, ' +
            'resume with Last-Event-ID or ?after=, heartbeats, `behind` when the client lags (any role)',
          security,
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ after: Seq.optional() }),
          response: errors,
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const after = parseCursor(request.headers['last-event-id']) ?? parseCursor(request.query.after);
        await deps.streams.serve(reply, {
          jobId: request.params.id.toLowerCase(),
          userId: session.user.id,
          after,
        });
      },
    );

    r.get(
      '/jobs/:id/live',
      {
        config: { authz: job },
        schema: {
          tags,
          summary: 'Live view summary: stream head, counts, artifacts, terminal support (any role)',
          security,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              head: z.number().int(),
              logChunks: z.number().int(),
              logBytes: z.number().int(),
              events: z.number().int(),
              logLimited: z.boolean(),
              artifacts: z.array(EventBody),
              terminal: z.object({ supported: z.boolean(), status: z.string().nullable() }),
              stream: z.object({ maxAgeMs: z.number().int(), maxPerUser: z.number().int() }),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const s = await deps.store.summary(request.params.id);
        return {
          ...s,
          artifacts: s.artifacts.map(eventJson),
          stream: {
            maxAgeMs: deps.streams.limits.maxAgeMs,
            maxPerUser: deps.streams.limits.maxPerUser,
          },
        };
      },
    );

    r.get(
      '/jobs/:id/logs',
      {
        config: { authz: job },
        schema: {
          tags,
          summary:
            'Log chunks in order (attempt, worker seq, chunk seq); `q` searches the redacted text ' +
            '(case-insensitive substrings), `tail=1` returns the last chunks (any role)',
          security,
          params: z.object({ id: z.uuid() }),
          querystring: z.object({
            q: z.string().max(400).optional(),
            stream: z.enum(LOG_STREAMS).optional(),
            attempt: z.coerce.number().int().min(0).max(100_000).optional(),
            cursor: Cursor.optional(),
            limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
            tail: z.enum(['0', '1']).optional(),
          }),
          response: {
            200: z.object({ items: z.array(LogBody), nextCursor: z.string().nullable(), head: z.number() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const q = request.query;
        const [page, head] = await Promise.all([
          cursorOrBadRequest(() =>
            deps.store.logs(request.params.id, {
              ...(q.q === undefined ? {} : { q: q.q }),
              ...(q.stream === undefined ? {} : { stream: q.stream }),
              ...(q.attempt === undefined ? {} : { attemptNo: q.attempt }),
              cursor: q.cursor ?? null,
              ...(q.limit === undefined ? {} : { limit: q.limit }),
              tail: q.tail === '1',
            }),
          ),
          deps.store.head(request.params.id),
        ]);
        return { items: page.items.map(logJson), nextCursor: page.nextCursor, head };
      },
    );

    r.get(
      '/jobs/:id/events',
      {
        config: { authz: job },
        schema: {
          tags,
          summary:
            'Agent events in order, approval requests joined with their decision state; `tail=1` returns ' +
            'the last events (any role)',
          security,
          params: z.object({ id: z.uuid() }),
          querystring: z.object({
            kind: z.enum(EVENT_KINDS).optional(),
            cursor: Cursor.optional(),
            limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
            tail: z.enum(['0', '1']).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(EventBody),
              nextCursor: z.string().nullable(),
              head: z.number(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const q = request.query;
        const [page, head] = await Promise.all([
          cursorOrBadRequest(() =>
            deps.store.events(request.params.id, {
              ...(q.kind === undefined ? {} : { kind: q.kind }),
              cursor: q.cursor ?? null,
              ...(q.limit === undefined ? {} : { limit: q.limit }),
              tail: q.tail === '1',
            }),
          ),
          deps.store.head(request.params.id),
        ]);
        return { items: page.items.map(eventJson), nextCursor: page.nextCursor, head };
      },
    );

    r.get(
      '/jobs/:id/diff',
      {
        config: { authz: job },
        schema: {
          tags,
          summary: 'Verified attempt diff (base...head on the remote) as redacted text, ≤ 1 MiB (any role)',
          security,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              text: z.string(),
              truncated: z.boolean(),
              baseSha: z.string(),
              headSha: z.string(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const source = deps.diff();
        const unavailable = new HttpError(
          404,
          'diff_unavailable',
          'No verified diff is available for this job (no git flow, not verified yet, or the provider has none).',
        );
        if (source === null) throw unavailable;
        const d = await source.patch(request.params.id, MAX_DIFF_BYTES);
        if (d === null) throw unavailable;
        return { ...d, text: deps.store.redactor.text(d.text) };
      },
    );
  };
}
