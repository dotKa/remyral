import {
  type Attributes,
  context,
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  contextFromTraceparent,
  errorType,
  type Telemetry,
  traceparentOf,
} from '@remyral/observability/telemetry';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { JobHint } from '../orchestration/orchestrator.js';
import type { HintQueue } from '../orchestration/relay.js';
import type { WorkerSession, WorkerSessionHandler } from '../workers/types.js';
import type { WorkerToMaster } from '@remyral/protocol';

/**
 * Master instrumentation (p6-otel, docs/design/p6-observability.md §2). Every helper adds identifiers and
 * enumerations only; the attribute policy of `@remyral/observability/telemetry` filters spans again at
 * export. Metric attribute keys are short Prometheus-friendly names chosen here.
 */

const SECONDS = (startNs: bigint): number => Number(process.hrtime.bigint() - startNs) / 1e9;

/** `select`, `insert`, … — the statement's first keyword only, never its text or parameters. */
export function sqlOperation(text: unknown): string {
  const t = typeof text === 'string' ? text : (text as { text?: unknown } | null)?.text;
  if (typeof t !== 'string') return 'other';
  const m = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i.exec(t);
  const op = m?.[1]?.toLowerCase() ?? 'other';
  return [
    'select',
    'insert',
    'update',
    'delete',
    'begin',
    'commit',
    'rollback',
    'savepoint',
    'release',
  ].includes(op)
    ? op
    : 'other';
}

/**
 * HTTP server spans and metrics. The span is made active for the rest of the request (hooks, handler,
 * database calls) by running Fastify's continuation inside its context; `http.route` is the route
 * pattern (`/jobs/:id`), never the raw URL with ids or query strings.
 */
export function registerHttpTelemetry(app: FastifyInstance, t: Telemetry): void {
  const duration = t.meter.createHistogram('remyral_http_server_duration_seconds', {
    description: 'HTTP request duration by route pattern and status class',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  });
  const spans = new WeakMap<object, { span: Span | null; start: bigint }>();
  app.addHook('onRequest', (request, _reply, done) => {
    const start = process.hrtime.bigint();
    if (!t.tracing) {
      spans.set(request, { span: null, start });
      done();
      return;
    }
    const route = request.routeOptions.url ?? 'unmatched';
    const span = t.tracer.startSpan(`HTTP ${request.method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': request.method, 'http.route': route },
    });
    spans.set(request, { span, start });
    context.with(trace.setSpan(context.active(), span), done);
  });
  app.addHook('onResponse', (request, reply, done) => {
    const s = spans.get(request);
    const route = request.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    if (s !== undefined) {
      duration.record(SECONDS(s.start), {
        method: request.method,
        route,
        status_class: `${String(Math.floor(status / 100))}xx`,
      });
      if (s.span !== null) {
        s.span.setAttribute('http.response.status_code', status);
        if (status >= 500) s.span.setStatus({ code: SpanStatusCode.ERROR });
        s.span.end();
      }
      spans.delete(request);
    }
    done();
  });
}

const WRAPPED = Symbol('remyral.telemetry.wrapped');

type QueryCallback = (err: Error | null, res: unknown) => void;

/**
 * Database client spans (`db <operation>`) and a duration histogram, installed on every pooled
 * connection (pool.query and transactions alike). Statement text and parameters are never recorded.
 *
 * p16-observability: spans are sampled — a query inside an active span gets one when it is in the `sampleRatio` share,
 * slower than `slowMs` or failed (the span is created after the fact with the query's real start and end), so slow and
 * failing queries are always in the trace while the bulk of fast ones costs no span. The histogram sees every query.
 * Defaults: every query (ratio 1), as before.
 */
export interface PoolInstrumentOptions {
  readonly sampleRatio?: number;
  readonly slowMs?: number;
  readonly random?: () => number;
}

export function instrumentPool(pool: pg.Pool, t: Telemetry, opts: PoolInstrumentOptions = {}): void {
  const ratio = opts.sampleRatio ?? 1;
  const slowNs = BigInt(Math.round((opts.slowMs ?? 100) * 1e6));
  const random = opts.random ?? Math.random;
  const hist = t.meter.createHistogram('remyral_db_query_duration_seconds', {
    description: 'Postgres query duration by operation',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5] },
  });
  const errors = t.meter.createCounter('remyral_db_query_errors', { description: 'Failed Postgres queries' });
  // `acquire` fires on every checkout (also for connections opened before instrumentation); each client
  // is wrapped once.
  pool.on('acquire', (client) => {
    const marked = client as unknown as Record<symbol, boolean>;
    if (marked[WRAPPED] === true) return;
    marked[WRAPPED] = true;
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    const wrapped = (...args: unknown[]): unknown => {
      const first = args[0];
      // Submittables (cursors, streams) pass through untouched.
      if (
        first !== null &&
        typeof first === 'object' &&
        typeof (first as { submit?: unknown }).submit === 'function'
      ) {
        return original(...args);
      }
      const operation = sqlOperation(first);
      const start = process.hrtime.bigint();
      const startedAt = new Date();
      const parent = t.tracing && trace.getActiveSpan() !== undefined ? context.active() : null;
      const sampled = parent !== null && (ratio >= 1 || random() < ratio);
      const finish = (err: unknown): void => {
        const elapsed = process.hrtime.bigint() - start;
        hist.record(Number(elapsed) / 1e9, { operation });
        const failed = err !== null && err !== undefined;
        if (failed) errors.add(1, { operation });
        if (parent === null || (!sampled && !failed && elapsed < slowNs)) return;
        const span = t.tracer.startSpan(
          `db ${operation}`,
          {
            kind: SpanKind.CLIENT,
            startTime: startedAt,
            attributes: { 'db.system.name': 'postgresql', 'db.operation.name': operation },
          },
          parent,
        );
        if (failed) {
          span.setAttribute('error.type', errorType(err));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end(new Date(startedAt.getTime() + Number(elapsed / 1_000_000n)));
      };
      const last = args.at(-1);
      if (typeof last === 'function') {
        const cb = last as QueryCallback;
        return original(...args.slice(0, -1), (err: Error | null, res: unknown) => {
          finish(err);
          cb(err, res);
        });
      }
      const result = original(...args) as Promise<unknown>;
      return result.then(
        (r) => {
          finish(null);
          return r;
        },
        (err: unknown) => {
          finish(err);
          throw err;
        },
      );
    };
    (client as unknown as { query: unknown }).query = wrapped;
  });
}

/** BullMQ delivery-hint spans and counters (publish and consume). */
export function instrumentHints(t: Telemetry): {
  queue: (q: HintQueue) => HintQueue;
  consumer: (fn: (h: JobHint) => Promise<void>) => (h: JobHint) => Promise<void>;
} {
  const published = t.meter.createCounter('remyral_dispatch_hints_published', {
    description: 'Job delivery hints published to BullMQ',
  });
  const consumed = t.meter.createCounter('remyral_dispatch_hints_consumed', {
    description: 'Job delivery hints consumed from BullMQ, by result',
  });
  const msg = { 'messaging.system': 'bullmq', 'messaging.destination.name': 'remyral-job-hints' };
  return {
    queue: (q) => ({
      publish: (hints) =>
        t.span(
          'hints publish',
          { ...msg, 'messaging.operation.name': 'publish', 'remyral.count': hints.length },
          async () => {
            await q.publish(hints);
            published.add(hints.length);
          },
        ),
      close: () => q.close(),
    }),
    consumer: (fn) => (hint) =>
      t.span(
        'hints process',
        { ...msg, 'messaging.operation.name': 'process', 'remyral.job.id': hint.jobId },
        async () => {
          try {
            await fn(hint);
            consumed.add(1, { result: 'ok' });
          } catch (err) {
            consumed.add(1, { result: 'error' });
            throw err;
          }
        },
      ),
  };
}

/** Orchestrator tick steps: one span per step and a duration histogram (`step` = code-chosen name). */
export function stepInstrument(t: Telemetry): <T>(name: string, fn: () => Promise<T>) => Promise<T> {
  const hist = t.meter.createHistogram('remyral_orchestrator_step_duration_seconds', {
    description: 'Duration of orchestrator reconciliation steps',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 30] },
  });
  const failures = t.meter.createCounter('remyral_orchestrator_step_failures', {
    description: 'Orchestrator steps that threw',
  });
  return async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = process.hrtime.bigint();
    try {
      return await t.span(`orchestrator.${name}`, { 'remyral.step': name }, fn);
    } catch (err) {
      failures.add(1, { step: name });
      throw err;
    } finally {
      hist.record(SECONDS(start), { step: name });
    }
  };
}

const MESSAGE_TYPE = /^[A-Z_]{1,32}$/;

/**
 * Worker sessions: a `worker.session` span from session start to end, a span per inbound message
 * (`worker.message <TYPE>` with worker/job ids), active-session gauge and message counters.
 */
export function instrumentSessionHandler(handler: WorkerSessionHandler, t: Telemetry): WorkerSessionHandler {
  const active = t.meter.createUpDownCounter('remyral_worker_sessions_active', {
    description: 'Open authenticated worker sessions on this master',
  });
  const messages = t.meter.createCounter('remyral_worker_messages', {
    description: 'Messages received from workers, by type and result',
  });
  const sessions = new WeakMap<WorkerSession, Span>();
  const jobIdOf = (m: WorkerToMaster): string | undefined => {
    const id = (m as { jobId?: unknown }).jobId;
    return typeof id === 'string' && id.length <= 64 ? id : undefined;
  };
  return {
    async onSessionStart(session) {
      active.add(1);
      if (t.tracing) {
        sessions.set(
          session,
          t.tracer.startSpan(
            'worker.session',
            { attributes: { 'remyral.worker.id': session.workerId } },
            ROOT_CONTEXT,
          ),
        );
      }
      await handler.onSessionStart(session);
    },
    async onMessage(session, message) {
      const type = MESSAGE_TYPE.test(message.type) ? message.type : 'OTHER';
      const attrs: Attributes = { 'remyral.worker.id': session.workerId, 'remyral.worker.message': type };
      const jobId = jobIdOf(message);
      if (jobId !== undefined) attrs['remyral.job.id'] = jobId;
      // p16-observability: its own trace (linked to the session span), or the remote parent the worker sent.
      const run = (): Promise<void> => {
        if (!t.tracing) return handler.onMessage(session, message);
        const sessionSpan = sessions.get(session);
        const links: Link[] = sessionSpan === undefined ? [] : [{ context: sessionSpan.spanContext() }];
        const parent = contextFromTraceparent(
          (message as { traceparent?: unknown }).traceparent,
          ROOT_CONTEXT,
        );
        return t.tracer.startActiveSpan(
          `worker.message ${type}`,
          { attributes: attrs, links },
          parent,
          async (span): Promise<void> => {
            try {
              await handler.onMessage(session, message);
            } catch (err) {
              span.setAttribute('error.type', errorType(err));
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      };
      try {
        await run();
        messages.add(1, { type, result: 'ok' });
      } catch (err) {
        messages.add(1, { type, result: 'error' });
        throw err;
      }
    },
    async onSessionEnd(session, reason) {
      active.add(-1);
      const span = sessions.get(session);
      if (span !== undefined) {
        span.setAttribute('remyral.session.reason', /^[a-z_]{1,48}$/.test(reason) ? reason : 'other');
        span.end();
        sessions.delete(session);
      }
      await handler.onSessionEnd(session, reason);
    },
  };
}

/** p16-observability: the chat's view of a turn's telemetry (ChatService `observe` dependency). */
export interface ChatTurnObserver {
  /** A turn was sent to its machine; returns the trace context for the ASSISTANT_TURN envelope. */
  started(
    turnId: string,
    info: { readonly runtime: string | undefined; readonly workerId: string },
  ): string | undefined;
  /** The turn ended (done / failed / cancelled; reason: a closed code). */
  ended(turnId: string, state: 'done' | 'failed' | 'cancelled', reason?: string): void;
}

const MAX_OPEN_TURNS = 1000;

/**
 * p16-observability: a `chat.turn` span from sending a turn to its end (the root of its own trace; error status when it
 * failed), the `remyral_chat_turns` counter (outcome, runtime) and `remyral_chat_turn_duration_seconds`.
 */
export function chatTurnTelemetry(t: Telemetry): ChatTurnObserver {
  const turns = t.meter.createCounter('remyral_chat_turns', {
    description: 'Finished chat (assistant) turns, by outcome and runtime',
  });
  const duration = t.meter.createHistogram('remyral_chat_turn_duration_seconds', {
    description: 'Chat turn duration from sending to its end, by outcome',
    unit: 's',
    advice: { explicitBucketBoundaries: [1, 2, 5, 10, 20, 30, 60, 120, 300, 600] },
  });
  const open = new Map<string, { span: Span | null; start: bigint; runtime: string }>();
  const safe = (v: string | undefined): string =>
    v !== undefined && /^[a-z0-9-]{1,32}$/.test(v) ? v : 'unknown';
  return {
    started(turnId, info) {
      if (open.size >= MAX_OPEN_TURNS) {
        const oldest = open.keys().next().value;
        if (oldest !== undefined) {
          open.get(oldest)?.span?.end();
          open.delete(oldest);
        }
      }
      const runtime = safe(info.runtime);
      const span = t.tracing
        ? t.tracer.startSpan(
            'chat.turn',
            {
              attributes: {
                'remyral.chat.turn': turnId,
                'remyral.worker.id': info.workerId,
                'remyral.runtime': runtime,
              },
            },
            ROOT_CONTEXT,
          )
        : null;
      open.set(turnId, { span, start: process.hrtime.bigint(), runtime });
      return span === null ? undefined : traceparentOf(span);
    },
    ended(turnId, state, reason) {
      const o = open.get(turnId);
      if (o === undefined) return;
      open.delete(turnId);
      turns.add(1, { outcome: state, runtime: o.runtime });
      duration.record(SECONDS(o.start), { outcome: state });
      if (o.span !== null) {
        o.span.setAttribute('remyral.chat.outcome', state);
        if (reason !== undefined && /^[a-z0-9_]{1,64}$/.test(reason))
          o.span.setAttribute('remyral.chat.reason', reason);
        if (state === 'failed') o.span.setStatus({ code: SpanStatusCode.ERROR });
        o.span.end();
      }
    },
  };
}
