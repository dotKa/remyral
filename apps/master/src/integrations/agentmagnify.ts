import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AlertEvent } from '../alerts/index.js';
import type { Pool } from '../db/pool.js';

/**
 * Optional AgentMagnify plugin (p6-agentmagnify, docs/design/p6-observability.md §7). Disabled unless
 * `AGENTMAGNIFY_API_URL` and `AGENTMAGNIFY_TOKEN_FILE` are configured. It forwards the **job lifecycle**
 * (committed `job_transitions`) and operational alarms as AgentMagnify events (protocol 2026-07-31.1):
 *
 *   QUEUED → task.created · RESERVED → task.assigned (worker) · RUNNING → task.started ·
 *   VERIFYING / AWAITING_APPROVAL → task.progress · BLOCKED / LOST → task.blocked ·
 *   SUCCEEDED → task.completed · FAILED / CANCELLED → task.failed · alert fired/resolved → blocker.*
 *
 * Metadata only: job/attempt/worker ids, state, trigger, runtime, project identifier, epoch. Never prompts,
 * summaries, failure reasons, repository URLs, user names or secrets. The token is read from a file, sent only
 * as a bearer header to the configured URL and never logged. Delivery is best effort with a bounded in-memory
 * queue (oldest dropped and counted); event ids are deterministic (`rac-t-<transition id>`), so a retried
 * batch is deduplicated by AgentMagnify's idempotency.
 */
export interface AgentMagnifyOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly projectName?: string;
  readonly pool: Pool;
  readonly log?: FastifyBaseLogger;
  readonly fetch?: typeof fetch;
  /** Max queued events while the API is unreachable (default 2000). */
  readonly maxQueue?: number;
  readonly timeoutMs?: number;
}

export const AGENTMAGNIFY_PROTOCOL = '2026-07-31.1';
const MAX_BATCH = 100;
const ORCHESTRATOR = { agentId: 'remyral-master', role: 'orchestrator', kind: 'main' } as const;

type Json = Record<string, unknown>;

interface TransitionRow {
  id: string;
  job_id: string;
  from_state: string | null;
  to_state: string;
  trigger: string;
  epoch: number | null;
  occurred_at: Date;
  project: string;
  runtime: string | null;
  worker_id: string | null;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const safeId = (v: string | null | undefined): string | undefined =>
  v !== null && v !== undefined && ID.test(v) ? v : undefined;

export interface AgentMagnifyStats {
  readonly sent: number;
  readonly dropped: number;
  readonly queued: number;
  readonly sessionId: string | null;
}

export class AgentMagnifyForwarder {
  readonly #o: AgentMagnifyOptions;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #session: { id: string; protocol: string } | null = null;
  #sequence = 0;
  #cursor: string | null = null;
  #queue: Json[] = [];
  #sent = 0;
  #dropped = 0;
  #warned = false;
  #log: FastifyBaseLogger | undefined;

  constructor(o: AgentMagnifyOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
    this.#base = o.apiUrl.replace(/\/+$/, '');
    this.#log = o.log;
  }

  /** The app logger once it exists (the forwarder is created before the app). */
  setLog(log: FastifyBaseLogger): void {
    this.#log = log;
  }

  get stats(): AgentMagnifyStats {
    return {
      sent: this.#sent,
      dropped: this.#dropped,
      queued: this.#queue.length,
      sessionId: this.#session?.id ?? null,
    };
  }

  async #request(
    path: string,
    body: Json,
    idempotencyKey?: string,
  ): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#o.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
      redirect: 'error',
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async #ensureSession(): Promise<boolean> {
    if (this.#session !== null) return true;
    const body: Json = {
      client: { version: 'remyral-master-1' },
      executor: { type: 'custom', label: 'remana-agent-cluster' },
      capabilities: ['tasks', 'subagents'],
      ...(this.#o.projectName === undefined ? {} : { project: { name: this.#o.projectName } }),
    };
    const { status, json } = await this.#request('/v1/agent/sessions', body);
    const r = json as { sessionId?: unknown; protocol?: { version?: unknown } } | null;
    if (status < 200 || status >= 300 || typeof r?.sessionId !== 'string' || !ID.test(r.sessionId)) {
      if (!this.#warned) {
        // Status code only: the response body could echo request data.
        this.#log?.warn({ status }, 'AgentMagnify session could not be opened; events stay queued');
        this.#warned = true;
      }
      return false;
    }
    this.#warned = false;
    this.#session = {
      id: r.sessionId,
      protocol: typeof r.protocol?.version === 'string' ? r.protocol.version : AGENTMAGNIFY_PROTOCOL,
    };
    this.#sequence = 0;
    // Events queued before the session get this session's envelope when sent.
    return true;
  }

  #enqueue(e: Json): void {
    this.#queue.push(e);
    const max = this.#o.maxQueue ?? 2000;
    while (this.#queue.length > max) {
      this.#queue.shift();
      this.#dropped += 1;
    }
  }

  /** Maps one committed transition to an AgentMagnify event (null: not forwarded). */
  #fromTransition(r: TransitionRow): Json | null {
    const jobId = r.job_id;
    const worker = safeId(r.worker_id);
    const runtime = r.runtime !== null && /^[a-z0-9-]{1,32}$/.test(r.runtime) ? r.runtime : 'unknown';
    const title = `${runtime} job ${jobId.slice(0, 8)}`;
    const task = (status?: string): Json => ({
      id: `job-${jobId}`,
      title,
      ...(status === undefined ? {} : { status }),
      ...(worker === undefined ? {} : { assigneeAgentId: worker }),
    });
    const workerReporter =
      worker === undefined ? ORCHESTRATOR : { agentId: worker, role: 'worker', kind: 'logical' };
    let type: string;
    let extra: Json;
    let reporter: Json = ORCHESTRATOR;
    switch (r.to_state) {
      case 'QUEUED':
        type = r.from_state === null || r.from_state === 'DRAFT' ? 'task.created' : 'task.reopened';
        extra = { task: task('pending') };
        break;
      case 'RESERVED':
        type = 'task.assigned';
        extra = { task: task('assigned') };
        break;
      case 'RUNNING':
        type = 'task.started';
        reporter = workerReporter;
        extra = { task: task('in_progress') };
        break;
      case 'VERIFYING':
      case 'AWAITING_APPROVAL':
        type = 'task.progress';
        reporter = r.to_state === 'VERIFYING' ? workerReporter : ORCHESTRATOR;
        extra = {
          task: task('in_progress'),
          progress: { reported: r.to_state === 'VERIFYING' ? 80 : 90 },
          summary: r.to_state === 'VERIFYING' ? 'verifying the result' : 'awaiting human approval',
        };
        break;
      case 'BLOCKED':
      case 'LOST':
        type = 'task.blocked';
        extra = {
          task: task('blocked'),
          summary:
            r.to_state === 'LOST'
              ? 'worker lost; the master is reconciling'
              : 'blocked by a dependency or policy',
          severity: r.to_state === 'LOST' ? 'high' : 'medium',
        };
        break;
      case 'SUCCEEDED':
        type = 'task.completed';
        extra = {
          task: task('completed'),
          verification: {
            method: 'acceptance_criteria',
            result: 'passed',
            details: 'job succeeded after verification',
          },
        };
        break;
      case 'FAILED':
      case 'CANCELLED':
        type = 'task.failed';
        extra = {
          task: task('failed'),
          summary: r.to_state === 'FAILED' ? 'job failed' : 'job cancelled',
          severity: r.to_state === 'FAILED' ? 'high' : 'low',
        };
        break;
      default:
        return null;
    }
    return {
      eventId: `rac-t-${r.id}`,
      type,
      timestamp: r.occurred_at.toISOString(),
      reporter,
      ...extra,
      metadata: {
        jobId,
        from: r.from_state ?? 'NONE',
        to: r.to_state,
        trigger: r.trigger,
        runtime,
        ...(safeId(r.project) === undefined ? {} : { project: r.project }),
        ...(r.epoch === null ? {} : { epoch: r.epoch }),
        ...(worker === undefined ? {} : { workerId: worker }),
      },
    };
  }

  /** Alert listener (p6-alerts): fired/escalated → blocker.created/updated, resolved → blocker.resolved. */
  onAlert = (e: AlertEvent): void => {
    const id = `alert-${e.rule}-${e.instance}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
    const type =
      e.kind === 'resolved' ? 'blocker.resolved' : e.kind === 'fired' ? 'blocker.created' : 'blocker.updated';
    const severity = e.severity === 'critical' ? 'critical' : e.severity === 'warning' ? 'high' : 'medium';
    this.#enqueue({
      eventId: `rac-a-${randomUUID()}`,
      type,
      timestamp: e.at.toISOString(),
      reporter: ORCHESTRATOR,
      blocker: {
        id,
        title: `${e.rule} (${e.instance})`.slice(0, 300),
        severity,
        ...(e.kind === 'resolved' ? { resolution: 'condition cleared' } : {}),
      },
      metadata: { rule: e.rule, instance: e.instance, episode: e.episode },
    });
  };

  /** Reads new transitions (the first call only positions the cursor at the end). */
  async collect(limit = 500): Promise<number> {
    if (this.#cursor === null) {
      const { rows } = await this.#o.pool.query<{ max: string | null }>(
        'SELECT max(id)::text AS max FROM job_transitions',
      );
      this.#cursor = rows[0]?.max ?? '0';
      return 0;
    }
    const { rows } = await this.#o.pool.query<TransitionRow>(
      `SELECT t.id::text AS id, t.job_id, t.from_state::text AS from_state, t.to_state::text AS to_state,
              t.trigger, t.epoch, t.occurred_at, j.project, j.spec->>'runtime' AS runtime,
              (SELECT a.worker_id FROM job_attempts a WHERE a.id = t.attempt_id) AS worker_id
         FROM job_transitions t JOIN jobs j ON j.id = t.job_id
        WHERE t.id > $1 ORDER BY t.id LIMIT $2`,
      [this.#cursor, limit],
    );
    for (const r of rows) {
      this.#cursor = r.id;
      const e = this.#fromTransition(r);
      if (e !== null) this.#enqueue(e);
    }
    return rows.length;
  }

  /** Sends queued events in batches; keeps them on transient failures. Returns the number accepted. */
  async flush(): Promise<number> {
    if (this.#queue.length === 0) return 0;
    if (!(await this.#ensureSession())) return 0;
    const session = this.#session;
    if (session === null) return 0;
    let accepted = 0;
    while (this.#queue.length > 0) {
      const chunk = this.#queue.slice(0, MAX_BATCH);
      const events = chunk.map((e) => {
        this.#sequence += 1;
        return { ...e, sessionId: session.id, protocolVersion: session.protocol, sequence: this.#sequence };
      });
      let status: number;
      let json: unknown;
      try {
        ({ status, json } = await this.#request('/v1/events/batch', { sessionId: session.id, events }));
      } catch (err) {
        this.#log?.debug({ err: err instanceof Error ? err.name : 'error' }, 'AgentMagnify unreachable');
        return accepted;
      }
      if (status === 401 || status === 403 || status === 404 || status === 409) {
        // Credential or session problem: reopen the session next time; keep the events.
        this.#session = null;
        this.#log?.warn({ status }, 'AgentMagnify refused the batch; reopening the session later');
        return accepted;
      }
      if (status < 200 || status >= 300) return accepted; // 429/5xx: retry on the next pass
      this.#queue.splice(0, chunk.length);
      const results = (json as { results?: { accepted?: boolean; duplicate?: boolean }[] } | null)?.results;
      const ok = Array.isArray(results)
        ? results.filter((x) => x.accepted === true || x.duplicate === true).length
        : chunk.length;
      accepted += ok;
      this.#sent += ok;
      this.#dropped += chunk.length - ok; // rejected by validation: never retried
    }
    return accepted;
  }

  /** collect + flush. */
  async runOnce(): Promise<number> {
    await this.collect();
    return this.flush();
  }

  /** Background loop; returns a stop function (flushes once more on stop). */
  start(intervalMs: number): () => Promise<void> {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.#log?.warn({ err }, 'AgentMagnify forwarding pass failed');
        })
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.runOnce().catch(() => undefined);
    };
  }
}

/** Validates the API URL: https, or http only to a loopback host (local AgentMagnify / tests). */
export function agentMagnifyUrlOk(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}
