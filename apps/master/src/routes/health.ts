import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export function postgresProbe(db: { query(sql: string): Promise<unknown> }): ReadinessProbe {
  return {
    name: 'postgres',
    async check() {
      await db.query('SELECT 1');
    },
  };
}

export const REDIS_PING_TIMEOUT_MS = 1_000;

/**
 * p11-fixes-a: the PING waits at most `timeoutMs` (default 1 s). A paused Redis keeps its socket open, so the client
 * neither errors nor fails fast (`enableOfflineQueue: false` only covers a closed connection): readiness must see an
 * unresponsive Redis as down. Only this probe's wait is bounded; other commands keep the client's behaviour.
 */
export function redisProbe(
  redis: { ping(): Promise<unknown> },
  timeoutMs = REDIS_PING_TIMEOUT_MS,
): ReadinessProbe {
  return {
    name: 'redis',
    async check() {
      await withTimeout(
        redis.ping().then(() => undefined),
        timeoutMs,
      );
    },
  };
}

const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StatusOptions {
  /** A computed result is reused for this long (default 10 s): public traffic never fans out to the DB. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

/**
 * `GET /status` (p1-monitoring, docs/ops/monitoring.md): the **public** uptime probe, reachable through the
 * proxy as `/api/status` for the external uptime check. It answers `{"status":"ok"}` (200) when the
 * readiness probes pass and `{"status":"unavailable"}` (503) otherwise — nothing else: no probe names, no
 * versions, no timings. The result is cached and computed single-flight, so an anonymous flood costs at
 * most one Postgres + Redis round trip per `cacheMs`. `/healthz` and `/readyz` stay internal.
 */
export function statusRoutes(probes: readonly ReadinessProbe[], opts: StatusOptions = {}) {
  const cacheMs = opts.cacheMs ?? 10_000;
  const now = opts.now ?? Date.now;
  let cached: { ok: boolean; at: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  const evaluate = async (log: { warn(obj: object, msg: string): void }): Promise<boolean> => {
    const t = now();
    if (cached !== null && t - cached.at < cacheMs) return cached.ok;
    inflight ??= (async () => {
      try {
        const results = await Promise.allSettled(probes.map((p) => withTimeout(p.check(), PROBE_TIMEOUT_MS)));
        const failed = probes.filter((_, i) => results[i]?.status === 'rejected').map((p) => p.name);
        if (failed.length > 0) log.warn({ failed }, 'public status check failed');
        cached = { ok: failed.length === 0, at: now() };
        return cached.ok;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/status',
      {
        config: { auth: 'public' },
        schema: {
          tags: ['health'],
          summary: 'Public uptime probe: ok, or 503 unavailable (cached; no detail)',
          response: {
            200: z.object({ status: z.literal('ok') }),
            503: z.object({ status: z.literal('unavailable') }),
          },
        },
      },
      async (request, reply) => {
        const ok = await evaluate(request.log);
        return ok
          ? reply.code(200).send({ status: 'ok' as const })
          : reply.code(503).send({ status: 'unavailable' as const });
      },
    );
  };
}

/**
 * `/healthz`: liveness (the process serves HTTP). `/readyz`: Postgres and Redis reachable.
 * Both are unauthenticated and return no internal detail; failures are logged server-side only.
 */
export function healthRoutes(probes: readonly ReadinessProbe[]) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/healthz',
      {
        config: { auth: 'public' },
        schema: {
          tags: ['health'],
          summary: 'Liveness: the process serves HTTP',
          response: { 200: z.object({ status: z.literal('ok') }) },
        },
      },
      () => ({ status: 'ok' as const }),
    );
    r.get(
      '/readyz',
      {
        config: { auth: 'public' },
        schema: {
          tags: ['health'],
          summary: 'Readiness: Postgres and Redis reachable (503 otherwise; no detail)',
          response: {
            200: z.object({ status: z.literal('ready') }),
            503: z.object({ status: z.literal('unavailable') }),
          },
        },
      },
      async (request, reply) => {
        const results = await Promise.allSettled(probes.map((p) => withTimeout(p.check(), PROBE_TIMEOUT_MS)));
        const failed = probes.filter((_, i) => results[i]?.status === 'rejected').map((p) => p.name);
        if (failed.length > 0) {
          request.log.warn({ failed }, 'readiness check failed');
          return reply.code(503).send({ status: 'unavailable' as const });
        }
        return reply.code(200).send({ status: 'ready' as const });
      },
    );
  };
}
