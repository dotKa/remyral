import { randomUUID } from 'node:crypto';
import {
  JobSpec,
  LIVE_SERVICE_STATES,
  SERVICE_LIMITS,
  SERVICE_EGRESS_FEATURE,
  SERVICES_FEATURE,
  type ServiceInfo,
  type ServiceLogLine,
  type ServiceLogsPayload,
  type ServiceRequestPayload,
  type ServiceResultPayload,
  ServicesReport,
  ServiceSpec,
  type ServiceStartRequest,
  type ServiceStatusPayload,
  serviceExpiry,
  serviceSpecIssues,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, projectRoleOf, roleAtLeast, type Subject, visibleProjects } from '../authz/model.js';
import type { Pool } from '../db/pool.js';
import { loadGitConfig } from '../gitflow/config-store.js';
import { HttpError } from '../http/errors.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';
import { loadProjectEgress } from '../repo-egress/service.js';
import type { LeaseSigner } from '../orchestration/lease-signer.js';
import type { GitCredentialProvider } from '../orchestration/session.js';
import type { PreviewService } from '../previews/service.js';
import type { WorkerSession } from '../workers/types.js';
import { checkVaultRefs } from '../project-env/job-refs.js';
import { type ServiceEvent, ServiceEvents, serviceTransitions } from './events.js';

/**
 * p15-services (docs/design/p15-services.md): Servisler — the master's side of the long-running services workers own.
 *
 * - **Desired state** (`services` rows): who started what, where, from which checkout, until when. Starting needs
 *   `services.manage` (project operator+) — from the panel, the assistant (`start_service`, executed at once: owner
 *   decision) or a job's agent (SERVICE_REQUEST over its live lease, the job's creator re-authorized). The `unconfined`
 *   profile needs a project admin. Every start / stop / restart / extend / remove is audited.
 * - **Delivery**: SERVICE_START / SERVICE_CONTROL / SERVICE_TUNNEL are control messages signed with the lease key; a
 *   worker that is offline gets them on its next session (CAPABILITIES.services reconciliation: wanted ones it does not
 *   run are re-sent, ones the master does not want are stopped / removed).
 * - **Observed state** (SERVICE_STATUS): state, health, URL, pid, uptime, CPU / memory. Changes are emitted on the
 *   {@link ServiceEvents} hook and wake p15-watches' `service_url` watches (DB trigger, migration 0120).
 * - **No job slot**: a service is not a job; the orchestrator's placement never counts it.
 * - **Tunnels**: quick (the worker runs `cloudflared --url`, no account) or named (the master creates the tunnel with
 *   the project's preview-link settings — PreviewService.openForService — and sends only that tunnel's connector token).
 */

export interface ServiceRegistryDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly signer: LeaseSigner;
  readonly session: (workerId: string) => WorkerSession | undefined;
  readonly previews: () => PreviewService | null;
  readonly credentials?: GitCredentialProvider;
  /** How long a logs request waits for the worker (ms). Default 10 s. */
  readonly logsTimeoutMs?: number;
}

export interface ServiceCaller {
  readonly subject: Subject;
  readonly actor: { readonly type: 'user' | 'system'; readonly id: string; readonly ip?: string | null };
  readonly via: 'api' | 'chat' | 'job';
}

export interface ServiceCreateInput {
  readonly project: string;
  /** Machine id or name; with `fromJobId` the job's machine (must match when both are given). */
  readonly worker?: string | undefined;
  readonly fromJobId?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly sandboxProfile?: 'host-restricted' | 'unconfined' | undefined;
  readonly request: ServiceStartRequest;
}

export interface ServiceView {
  readonly id: string;
  readonly project: string;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly name: string;
  readonly desired: 'running' | 'stopped' | 'removed';
  readonly state: string;
  readonly health: string;
  readonly detail: string | null;
  readonly url: string | null;
  readonly port: number | null;
  readonly command: string;
  readonly cwd: string | null;
  readonly tunnel: { readonly mode: string; readonly state: string | null; readonly detail: string | null };
  readonly sandboxProfile: string;
  readonly restartPolicy: string;
  readonly health_kind: string;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly restarts: number;
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly sourceJobId: string | null;
  readonly createdBy: { readonly type: string; readonly id: string; readonly username: string | null };
  readonly createdVia: string;
  readonly expiresAt: string | null;
  readonly statusAt: string | null;
  readonly createdAt: string;
  readonly stoppedAt: string | null;
  readonly stopReason: string | null;
  readonly workerConnected: boolean;
  /**
   * p21-service-egress: whose network rules the service runs under — `project` (the project's network access policy,
   * as for its jobs) or `model_apis_only` (a machine without `service-egress-v1`; update it).
   */
  readonly network: 'project' | 'model_apis_only';
}

interface Row {
  id: string;
  project: string;
  worker_id: string;
  worker_name: string | null;
  name: string;
  spec: unknown;
  revision: number;
  desired: 'running' | 'stopped' | 'removed';
  state: string;
  health: string;
  detail: string | null;
  tunnel_mode: 'none' | 'quick' | 'named';
  tunnel_state: string | null;
  tunnel_detail: string | null;
  tunnel_id: string | null;
  tunnel_protect: 'none' | 'access' | 'service-token' | null;
  tunnel_name: string | null;
  url: string | null;
  pid: number | null;
  started_at: Date | null;
  restarts: number;
  exit_code: number | null;
  cpu_percent: number | null;
  memory_bytes: string | null;
  source_job_id: string | null;
  created_by_type: string;
  created_by_id: string;
  creator: string | null;
  created_via: string;
  expires_at: Date | null;
  status_at: Date | null;
  created_at: Date;
  stopped_at: Date | null;
  stop_reason: string | null;
  network_applies: boolean | null;
}

const COLS = `s.id::text AS id, s.project, s.worker_id, w.display_name AS worker_name, s.name, s.spec, s.revision,
  s.desired, s.state, s.health, s.detail, s.tunnel_mode, s.tunnel_state, s.tunnel_detail, s.tunnel_id::text AS tunnel_id,
  s.tunnel_protect, s.tunnel_name, s.url, s.pid, s.started_at, s.restarts, s.exit_code, s.cpu_percent, s.memory_bytes,
  s.source_job_id::text AS source_job_id, s.created_by_type, s.created_by_id,
  (SELECT username FROM users u WHERE s.created_by_type = 'user' AND u.id::text = s.created_by_id) AS creator,
  s.created_via, s.expires_at, s.status_at, s.created_at, s.stopped_at, s.stop_reason,
  (w.features ? '${SERVICE_EGRESS_FEATURE}') AS network_applies`;
const FROM = 'FROM services s LEFT JOIN workers w ON w.id = s.worker_id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = new Set<string>([...LIVE_SERVICE_STATES, 'pending']);

export class ServiceRegistry {
  readonly events: ServiceEvents;
  readonly #pendingLogs = new Map<string, (p: ServiceLogsPayload | null) => void>();

  constructor(private readonly deps: ServiceRegistryDeps) {
    this.events = new ServiceEvents((err, e) => {
      deps.log.warn({ err, serviceId: e.serviceId, kind: e.kind }, 'service event listener failed');
    });
  }

  // ============================================================================================= reads

  async #row(id: string): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<Row>(`SELECT ${COLS} ${FROM} WHERE s.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** The project of a service (route authorization); null when it does not exist. */
  async projectOf(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<{ project: string }>(
      `SELECT project FROM services WHERE id = $1 AND desired <> 'removed'`,
      [id],
    );
    return rows[0]?.project ?? null;
  }

  #view(r: Row): ServiceView {
    const spec = ServiceSpec.safeParse(r.spec);
    const s = spec.success ? spec.data : null;
    return {
      id: r.id,
      project: r.project,
      workerId: r.worker_id,
      workerName: r.worker_name,
      name: r.name,
      desired: r.desired,
      state: r.state,
      health: r.health,
      detail: r.detail,
      url: r.url,
      port: s?.port ?? null,
      command: s?.command ?? '',
      cwd: s?.cwd ?? null,
      tunnel: { mode: r.tunnel_mode, state: r.tunnel_state, detail: r.tunnel_detail },
      sandboxProfile: s?.sandboxProfile ?? 'host-restricted',
      restartPolicy: s?.restart.policy ?? 'on-failure',
      health_kind: s?.health.kind ?? 'none',
      pid: r.pid,
      startedAt: r.started_at?.toISOString() ?? null,
      restarts: r.restarts,
      cpuPercent: r.cpu_percent,
      memoryBytes: r.memory_bytes === null ? null : Number(r.memory_bytes),
      sourceJobId: r.source_job_id,
      createdBy: { type: r.created_by_type, id: r.created_by_id, username: r.creator },
      createdVia: r.created_via,
      expiresAt: r.expires_at?.toISOString() ?? null,
      statusAt: r.status_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      stoppedAt: r.stopped_at?.toISOString() ?? null,
      stopReason: r.stop_reason,
      workerConnected: this.deps.session(r.worker_id) !== undefined,
      network: r.network_applies === true ? 'project' : 'model_apis_only',
    };
  }

  /** Services the subject may see (`services.read`), newest first; live ones plus those stopped in the last 7 days. */
  async list(
    subject: Subject,
    filter: {
      project?: string | undefined;
      worker?: string | undefined;
      state?: 'live' | 'stopped' | 'failed' | 'any' | undefined;
      includeStopped?: boolean | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<ServiceView[]> {
    const visible = visibleProjects(subject);
    const params: unknown[] = [];
    const where: string[] = [`s.desired <> 'removed'`];
    if (filter.project !== undefined) {
      params.push(filter.project);
      where.push(`s.project = $${String(params.length)}`);
    }
    if (filter.worker !== undefined) {
      params.push(filter.worker);
      where.push(`(s.worker_id = $${String(params.length)} OR w.display_name = $${String(params.length)})`);
    }
    if (visible !== null) {
      params.push(visible.filter((p) => authorize(subject, 'services.read', { project: p }).allow));
      where.push(`s.project = ANY($${String(params.length)})`);
    }
    const state = filter.state ?? (filter.includeStopped === true ? 'any' : 'live');
    if (state === 'live') where.push(`s.desired = 'running'`);
    else if (state === 'stopped') where.push(`s.state IN ('stopped', 'expired')`);
    else if (state === 'failed') where.push(`s.state IN ('failed', 'refused')`);
    params.push(new Date(this.deps.clock().getTime() - 7 * 86_400_000));
    where.push(`(s.desired = 'running' OR s.updated_at > $${String(params.length)})`);
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 200));
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT $${String(params.length)}`,
      params,
    );
    return rows.map((r) => this.#view(r));
  }

  async get(subject: Subject, id: string): Promise<ServiceView> {
    const r = await this.#row(id);
    if (
      r === null ||
      r.desired === 'removed' ||
      !authorize(subject, 'services.read', { project: r.project }).allow
    ) {
      throw new HttpError(404, 'service_not_found', 'Service not found.');
    }
    return this.#view(r);
  }

  /** p15-watches `ServiceUrlSource`: the URL of a service the subject can see, and whether it is up. */
  async resolveUrl(
    subject: Subject,
    serviceId: string,
  ): Promise<{
    project: string;
    label: string;
    url: string | null;
    up: boolean;
    ended?: { state: string; detail: string | null; exitCode: number | null };
  } | null> {
    const r = await this.#row(serviceId);
    if (
      r === null ||
      r.desired === 'removed' ||
      !authorize(subject, 'services.read', { project: r.project }).allow
    )
      return null;
    return {
      project: r.project,
      label: r.name,
      url: r.url,
      up:
        r.state === 'running' &&
        r.url !== null &&
        r.tunnel_state !== 'failed' &&
        r.tunnel_state !== 'stopped',
      // p19-watch-follow-up: down for good — the worker gave up (failed / refused / its lifetime ended), it was
      // stopped, or (p21-service-exit) its command exited by itself under the policy `never` (state `stopped` while
      // still wanted); a watch waiting for it to come up ends now instead of at its timeout.
      ...(['failed', 'refused', 'expired', 'stopped'].includes(r.state) || r.desired === 'stopped'
        ? {
            ended: {
              state: r.desired === 'stopped' ? 'stopped' : r.state,
              detail: r.detail,
              exitCode: r.exit_code,
            },
          }
        : {}),
    };
  }

  // ============================================================================================= writes

  #manage(c: ServiceCaller, project: string): void {
    const d = authorize(c.subject, 'services.manage', { project });
    if (d.allow) return;
    if (d.reason === 'not_visible') throw new HttpError(404, 'project_not_found', 'Project not found.');
    throw new HttpError(
      403,
      'forbidden',
      'Starting and stopping services needs the operator role in this project.',
      {},
      {},
      { reason: 'services' },
    );
  }

  async #audit(
    c: ServiceCaller,
    action: string,
    r: { id: string; project: string; worker_id: string; name: string },
    metadata: Record<string, unknown> = {},
    outcome: 'success' | 'denied' = 'success',
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: c.actor.type, id: c.actor.id },
      action,
      target: `service:${r.id}`,
      outcome,
      metadata: { project: r.project, worker: r.worker_id, name: r.name, via: c.via, ...metadata },
      ...(c.actor.ip === undefined || c.actor.ip === null ? {} : { ip: c.actor.ip }),
    });
  }

  async #resolveWorker(ref: string): Promise<{ id: string; features: unknown; projects: unknown } | null> {
    const { rows } = await this.deps.pool.query<{ id: string; features: unknown; projects: unknown }>(
      `SELECT id, features, local_projects AS projects FROM workers
        WHERE (id = $1 OR display_name = $1) AND approved_at IS NOT NULL AND revoked_at IS NULL
          AND archived_at IS NULL
        ORDER BY (id = $1) DESC LIMIT 1`,
      [ref],
    );
    return rows[0] ?? null;
  }

  async create(c: ServiceCaller, input: ServiceCreateInput): Promise<ServiceView> {
    this.#manage(c, input.project);
    const req = input.request;
    const now = this.deps.clock();
    const { rows: exists } = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [
      input.project,
    ]);
    if (exists.length === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const count = await this.deps.pool.query<{ n: number; taken: boolean }>(
      `SELECT count(*)::int AS n, bool_or(name = $2) AS taken FROM services WHERE project = $1 AND desired <> 'removed'`,
      [input.project, req.name],
    );
    if (count.rows[0]?.taken === true) {
      throw new HttpError(
        409,
        'service_name_taken',
        'A service with this name already exists in the project.',
      );
    }
    if ((count.rows[0]?.n ?? 0) >= SERVICE_LIMITS.perProject) {
      throw new HttpError(
        409,
        'service_limit',
        'This project already has the most services allowed; stop or remove one first.',
      );
    }
    let workerId: string;
    let source: ServiceSpec['source'];
    let profile: 'host-restricted' | 'unconfined' = input.sandboxProfile ?? 'host-restricted';
    let sourceJobId: string | null = null;
    if (input.fromJobId !== undefined) {
      const live = await this.#liveAttempt(input.fromJobId);
      if (live === null || live.project !== input.project) {
        throw new HttpError(
          409,
          'service_job_not_running',
          'The job is not running any more; its worktree is gone. Start the service from the repository instead.',
        );
      }
      if (input.worker !== undefined) {
        const w = await this.#resolveWorker(input.worker);
        if (w?.id !== live.workerId) {
          throw new HttpError(409, 'service_worker_mismatch', 'The job runs on another machine.');
        }
      }
      const jp = live.spec?.sandboxProfile;
      if (jp === 'container') {
        throw new HttpError(
          409,
          'service_profile_unsupported',
          'Services cannot run from a container-profile job (the server would not be on the machine’s localhost).',
        );
      }
      if (input.sandboxProfile === undefined && jp === 'unconfined') profile = 'unconfined';
      workerId = live.workerId;
      source = { kind: 'job', jobId: input.fromJobId, attemptId: live.attemptId as never };
      sourceJobId = input.fromJobId;
    } else {
      const git = await loadGitConfig(this.deps.pool, input.project);
      if (git === null) {
        throw new HttpError(
          409,
          'service_no_repository',
          'This project has no repository set up (Project → Repository); start the service from a running job instead.',
        );
      }
      let w: { id: string; features: unknown; projects: unknown } | null;
      if (input.worker !== undefined) {
        w = await this.#resolveWorker(input.worker);
        if (w === null) throw new HttpError(404, 'worker_not_found', 'No such worker.');
      } else {
        const { rows } = await this.deps.pool.query<{ id: string; features: unknown; projects: unknown }>(
          `SELECT id, features, local_projects AS projects FROM workers
            WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL
              AND state IN ('online', 'busy') AND features ? $1
              AND (local_projects IS NULL OR local_projects ? $2)
            ORDER BY running_jobs, id LIMIT 1`,
          [SERVICES_FEATURE, input.project],
        );
        w = rows[0] ?? null;
        if (w === null) {
          throw new HttpError(
            409,
            'service_no_worker',
            'No connected machine with services and this project can start it; name a machine.',
          );
        }
      }
      if (Array.isArray(w.projects) && !w.projects.includes(input.project)) {
        throw new HttpError(
          409,
          'service_worker_project',
          'This machine does not have the project’s repository.',
        );
      }
      workerId = w.id;
      source = {
        kind: 'checkout',
        repositoryUrl: git.repositoryUrl,
        baseRef: input.baseRef ?? git.baseBranch,
      };
    }
    const features = (await this.#resolveWorker(workerId))?.features;
    if (!Array.isArray(features) || !features.includes(SERVICES_FEATURE)) {
      throw new HttpError(
        409,
        'service_worker_unsupported',
        'This machine’s worker cannot run services yet (it needs a worker update).',
      );
    }
    if (profile === 'unconfined') {
      const role = projectRoleOf(c.subject, input.project);
      if (role === null || !roleAtLeast(role, 'admin')) {
        throw new HttpError(403, 'service_unconfined_admin', 'An unconfined service needs a project admin.');
      }
    }
    const tunnel = req.tunnel ?? 'none';
    if (
      c.via === 'job' &&
      tunnel === 'quick' &&
      (await this.deps.previews()?.agentQuickTunnels(input.project)) === false
    ) {
      throw new HttpError(
        403,
        'service_tunnel_not_allowed',
        'This project does not let agents open public links.',
      );
    }
    if (tunnel !== 'none' && req.port === undefined) {
      throw new HttpError(400, 'service_invalid', 'The service definition is not valid.');
    }
    const expires = serviceExpiry(now, req);
    const id = randomUUID();
    const parsed = ServiceSpec.safeParse({
      serviceId: id,
      projectId: input.project,
      name: req.name,
      source,
      cwd: req.cwd ?? null,
      command: req.command,
      env: req.env ?? {},
      secretEnv: req.secretEnv ?? {},
      port: req.port ?? null,
      health: req.health ?? (req.port === undefined ? { kind: 'none' } : { kind: 'tcp' }),
      restart: req.restart ?? {},
      sandboxProfile: profile,
      limits: req.limits ?? {},
      expiresAt: expires?.toISOString() ?? null,
      tunnel,
    });
    if (!parsed.success) {
      throw new HttpError(400, 'service_invalid', 'The service definition is not valid.');
    }
    const issues = serviceSpecIssues(parsed.data);
    if (issues.length > 0)
      throw new HttpError(400, 'service_invalid', 'The service definition is not valid.');
    const spec = parsed.data;
    // p19-project-env "Job-level references": a vault credential in `secretEnv` must be one this project gives its jobs.
    const { refused } = await checkVaultRefs(this.deps.pool, input.project, spec.secretEnv, {
      eligible: true,
    });
    if (refused.length > 0) {
      throw new HttpError(
        400,
        'vault_credential_not_available',
        `Not a credential this project gives its jobs (Projects → Policy → Environment variables): ${refused.join(', ')}.`,
        {},
        {},
        { env: refused.join(', ').slice(0, 300) },
      );
    }
    await this.deps.pool.query(
      `INSERT INTO services (id, project, worker_id, name, spec, revision, desired, state, health, tunnel_mode,
         tunnel_protect, tunnel_name, source_job_id, created_by_type, created_by_id, created_via, expires_at,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'running', 'pending', 'unknown', $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [
        id,
        input.project,
        workerId,
        req.name,
        JSON.stringify(spec),
        tunnel,
        tunnel === 'named' ? (req.protect ?? 'none') : null,
        tunnel === 'named' ? (req.tunnelName ?? null) : null,
        sourceJobId,
        c.actor.type,
        c.actor.id.slice(0, 128),
        c.via,
        expires,
        now,
      ],
    );
    const row = await this.#row(id);
    if (row === null) throw new Error('service row vanished');
    await this.#audit(c, 'service.start', row, {
      command: spec.command.slice(0, 200),
      port: spec.port,
      tunnel,
      profile,
      source: source.kind,
      ...(sourceJobId === null ? {} : { jobId: sourceJobId }),
      expiresAt: expires?.toISOString() ?? null,
    });
    if (tunnel === 'named') await this.#openNamed(row, c);
    await this.#sendStart((await this.#row(id)) ?? row).catch((err: unknown) => {
      this.deps.log.warn({ err, serviceId: id }, 'SERVICE_START not sent (sent on reconnect)');
    });
    return this.#view((await this.#row(id)) ?? row);
  }

  async #openNamed(row: Row, c: ServiceCaller): Promise<void> {
    const pv = this.deps.previews();
    const spec = ServiceSpec.parse(row.spec);
    if (pv === null || spec.port === null) {
      await this.#setTunnel(row.id, 'refused', 'Preview links are not available on this master.');
      return;
    }
    const out = await pv.openForService({
      project: row.project,
      serviceId: row.id,
      port: spec.port,
      name: row.tunnel_name ?? row.name.slice(0, 20),
      protect: row.tunnel_protect ?? 'none',
      expiresAt:
        row.expires_at ?? new Date(this.deps.clock().getTime() + SERVICE_LIMITS.maxTtlMinutes * 60_000),
      actor: c.actor,
      byAgent: c.via === 'job',
    });
    if (!out.ok) {
      await this.#setTunnel(row.id, 'refused', out.reason);
      return;
    }
    await this.deps.pool.query(
      `UPDATE services SET tunnel_id = $2, url = $3, tunnel_state = 'starting', tunnel_detail = NULL, updated_at = $4
        WHERE id = $1`,
      [row.id, out.tunnelId, `https://${out.hostname}`, this.deps.clock()],
    );
  }

  async #setTunnel(id: string, state: string, detail: string | null): Promise<void> {
    await this.deps.pool.query(
      'UPDATE services SET tunnel_state = $2, tunnel_detail = $3, updated_at = $4 WHERE id = $1',
      [id, state, detail?.slice(0, 300) ?? null, this.deps.clock()],
    );
  }

  async #mine(c: ServiceCaller, id: string): Promise<Row> {
    const r = await this.#row(id);
    if (r === null || r.desired === 'removed')
      throw new HttpError(404, 'service_not_found', 'Service not found.');
    if (!authorize(c.subject, 'services.read', { project: r.project }).allow) {
      throw new HttpError(404, 'service_not_found', 'Service not found.');
    }
    this.#manage(c, r.project);
    return r;
  }

  /** Stops a service (kept; it can be started again) or removes it with its checkout and logs. */
  async stop(
    c: ServiceCaller,
    id: string,
    opts: { remove?: boolean; reason?: string } = {},
  ): Promise<ServiceView> {
    const r = await this.#mine(c, id);
    const remove = opts.remove === true;
    const reason = (opts.reason ?? (remove ? 'removed' : 'stopped')).slice(0, 200);
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE services SET desired = $2, stopped_at = COALESCE(stopped_at, $3), stop_reason = $4, updated_at = $3,
         state = CASE WHEN state = 'pending' THEN 'stopped' ELSE state END
       WHERE id = $1`,
      [id, remove ? 'removed' : 'stopped', now, reason],
    );
    await this.#audit(c, remove ? 'service.remove' : 'service.stop', r, { reason });
    await this.#closeTunnel(r, reason);
    await this.#sendControl(r.worker_id, id, remove ? 'remove' : 'stop', reason);
    const after = await this.#row(id);
    if (after !== null) this.#emit(r, after);
    return this.#view(after ?? r);
  }

  async #closeTunnel(r: Row, reason: string): Promise<void> {
    if (r.tunnel_id === null) return;
    await this.deps
      .previews()
      ?.closeForService(r.tunnel_id, reason)
      .catch((err: unknown) => {
        this.deps.log.warn(
          { err, serviceId: r.id },
          'service tunnel close failed (the preview sweep retries)',
        );
      });
    await this.deps.pool.query(
      `UPDATE services SET tunnel_id = NULL, tunnel_state = 'stopped', url = NULL, updated_at = $2 WHERE id = $1`,
      [r.id, this.deps.clock()],
    );
  }

  /** Restarts (also a stopped one); optionally a new lifetime from now. */
  async restart(
    c: ServiceCaller,
    id: string,
    opts: { extendMinutes?: number | undefined; untilStopped?: boolean | undefined } = {},
  ): Promise<ServiceView> {
    const r = await this.#mine(c, id);
    const extend = opts.extendMinutes !== undefined || opts.untilStopped === true;
    if (extend) await this.#setExpiry(r, opts);
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE services SET desired = 'running', stopped_at = NULL, stop_reason = NULL, updated_at = $2 WHERE id = $1`,
      [id, now],
    );
    await this.#audit(c, 'service.restart', r, extend ? { extendMinutes: opts.extendMinutes ?? null } : {});
    const fresh = (await this.#row(id)) ?? r;
    if (fresh.tunnel_mode === 'named' && fresh.tunnel_id === null) await this.#openNamed(fresh, c);
    // The current spec first (a stopped service may have been started under an older revision), then the restart.
    await this.#sendStart((await this.#row(id)) ?? fresh).catch(() => undefined);
    await this.#sendControl(r.worker_id, id, 'restart', 'restarted');
    return this.#view((await this.#row(id)) ?? fresh);
  }

  /** A new lifetime from now (minutes) or until stopped; the running process is not restarted. */
  async extend(
    c: ServiceCaller,
    id: string,
    opts: { minutes?: number | undefined; untilStopped?: boolean | undefined },
  ): Promise<ServiceView> {
    const r = await this.#mine(c, id);
    if (r.desired !== 'running') {
      throw new HttpError(
        409,
        'service_not_running',
        'The service is stopped; start it again to give it a lifetime.',
      );
    }
    const at = await this.#setExpiry(r, { extendMinutes: opts.minutes, untilStopped: opts.untilStopped });
    await this.#audit(c, 'service.extend', r, { expiresAt: at?.toISOString() ?? null });
    await this.#sendStart((await this.#row(id)) ?? r).catch(() => undefined);
    return this.#view((await this.#row(id)) ?? r);
  }

  async #setExpiry(
    r: Row,
    opts: { extendMinutes?: number | undefined; untilStopped?: boolean | undefined },
  ): Promise<Date | null> {
    const at = serviceExpiry(this.deps.clock(), {
      ttlMinutes: opts.extendMinutes,
      untilStopped: opts.untilStopped,
    });
    const spec = ServiceSpec.parse(r.spec);
    const next = { ...spec, expiresAt: at?.toISOString() ?? null };
    await this.deps.pool.query(
      `UPDATE services SET spec = $2, revision = revision + 1, expires_at = $3, updated_at = $4 WHERE id = $1`,
      [r.id, JSON.stringify(next), at, this.deps.clock()],
    );
    if (r.tunnel_id !== null) {
      await this.deps
        .previews()
        ?.extendForService(
          r.tunnel_id,
          at ?? new Date(this.deps.clock().getTime() + SERVICE_LIMITS.maxTtlMinutes * 60_000),
        )
        .catch(() => undefined);
    }
    return at;
  }

  /** The last log lines (from the worker; secrets were redacted there). */
  async logs(
    subject: Subject,
    id: string,
    lines = 200,
  ): Promise<{ lines: ServiceLogLine[]; truncated: boolean }> {
    const r = await this.#row(id);
    if (
      r === null ||
      r.desired === 'removed' ||
      !authorize(subject, 'services.read', { project: r.project }).allow
    ) {
      throw new HttpError(404, 'service_not_found', 'Service not found.');
    }
    const session = this.deps.session(r.worker_id);
    if (session === undefined) {
      throw new HttpError(409, 'service_worker_offline', 'The machine of this service is not connected.');
    }
    const requestId = randomUUID();
    const answer = new Promise<ServiceLogsPayload | null>((resolve) => {
      const t = setTimeout(() => {
        resolve(null);
      }, this.deps.logsTimeoutMs ?? 10_000);
      t.unref();
      this.#pendingLogs.set(requestId, (p) => {
        clearTimeout(t);
        resolve(p);
      });
    });
    try {
      await session.send('SERVICE_LOGS_REQUEST', {
        serviceId: id,
        requestId,
        lines: Math.min(Math.max(lines, 1), SERVICE_LIMITS.logLinesMax),
      });
      const p = await answer;
      if (p === null)
        throw new HttpError(504, 'service_logs_timeout', 'The machine did not send the logs in time.');
      return { lines: p.lines, truncated: p.truncated };
    } finally {
      this.#pendingLogs.delete(requestId);
    }
  }

  // ============================================================================================= delivery

  async #sendStart(r: Row): Promise<boolean> {
    if (r.desired !== 'running') return false;
    const session = this.deps.session(r.worker_id);
    if (session === undefined) return false;
    const spec = await this.#withNetwork(r, ServiceSpec.parse(r.spec));
    // p19-project-env "Job-level references": every (re)start from the stored spec checks its vault secrets again —
    // a credential the project no longer gives its jobs stops the service with the variable names as the reason.
    const { refused } = await checkVaultRefs(this.deps.pool, r.project, spec.secretEnv, { eligible: true });
    if (refused.length > 0) {
      const now = this.deps.clock();
      await this.deps.pool.query(
        `UPDATE services SET desired = 'stopped', stopped_at = $2, stop_reason = $3, updated_at = $2
          WHERE id = $1 AND desired = 'running'`,
        [r.id, now, `vault_credential_not_available: ${refused.join(', ')}`.slice(0, 300)],
      );
      this.deps.log.warn(
        { serviceId: r.id, env: refused },
        'service not started: vault secret no longer available',
      );
      await this.#sendControl(r.worker_id, r.id, 'stop', 'stopped').catch(() => undefined);
      const after = await this.#row(r.id);
      if (after !== null) this.#emit(r, after);
      return false;
    }
    const issuedAt = this.deps.clock().toISOString();
    const binding = { workerId: r.worker_id, revision: r.revision, issuedAt, spec };
    let git: { token: string; username?: string } | null = null;
    if (spec.source.kind === 'checkout' && r.state === 'pending') {
      const cred = await this.deps.credentials
        ?.issueReadOnly?.({
          project: r.project,
          repositoryUrl: spec.source.repositoryUrl,
          workerId: r.worker_id,
        })
        .catch(() => null);
      if (cred !== null && cred !== undefined) {
        git = { token: cred.token, ...(cred.username === undefined ? {} : { username: cred.username }) };
      }
    }
    await session.send('SERVICE_START', {
      spec,
      revision: r.revision,
      issuedAt,
      ...(git === null
        ? {}
        : { gitToken: git.token, ...(git.username === undefined ? {} : { gitTokenUsername: git.username }) }),
      signature: this.deps.signer.signServiceStart(binding),
    });
    return true;
  }

  /**
   * p21-service-egress: the project's network access policy (p14-repo-egress; a workspace project's Workspace-tab
   * egress setting since p22-worker-limits) in force now, for a worker with `service-egress-v1` (an older worker would refuse the strict spec: it keeps model APIs only). A failure to read the
   * policy sends the spec without it — model APIs only, fails closed.
   */
  async #withNetwork(r: Row, spec: ServiceSpec): Promise<ServiceSpec> {
    const { network: _stored, ...base } = spec;
    try {
      const { rows } = await this.deps.pool.query<{ ok: boolean }>(
        'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
        [r.worker_id, SERVICE_EGRESS_FEATURE],
      );
      if (rows[0]?.ok !== true) return base;
      return { ...base, network: await loadProjectEgress(this.deps.pool, r.project) };
    } catch (err) {
      this.deps.log.warn(
        { err, serviceId: r.id },
        'project egress policy unavailable; the service gets model APIs only',
      );
      return base;
    }
  }

  /**
   * p21-service-egress: the project's network access policy changed — every service of it gets a new revision (a
   * stopped one then starts under the new policy, not the one in the worker's record), and the ones meant to run are
   * sent it now (the worker restarts a service whose rules changed; one that failed for a refused host starts
   * again). Returns how many were re-sent.
   */
  async onEgressChanged(project: string): Promise<number> {
    const { rows } = await this.deps.pool.query<{ id: string; desired: string }>(
      `UPDATE services SET revision = revision + 1, updated_at = $2
        WHERE project = $1 AND desired <> 'removed' RETURNING id::text AS id, desired`,
      [project, this.deps.clock()],
    );
    const running = rows.filter((x) => x.desired === 'running');
    for (const { id } of running) {
      const r = await this.#row(id);
      if (r !== null) {
        await this.#sendStart(r).catch((err: unknown) => {
          this.deps.log.warn({ err, serviceId: id }, 'SERVICE_START not sent (sent on reconnect)');
        });
      }
    }
    return running.length;
  }

  async #sendControl(
    workerId: string,
    serviceId: string,
    op: 'stop' | 'restart' | 'remove',
    reason: string,
  ): Promise<void> {
    const session = this.deps.session(workerId);
    if (session === undefined) return;
    const issuedAt = this.deps.clock().toISOString();
    await session
      .send('SERVICE_CONTROL', {
        serviceId,
        op,
        reason: reason.slice(0, 200),
        issuedAt,
        signature: this.deps.signer.signServiceControl({ workerId, serviceId, op, issuedAt }),
      })
      .catch(() => undefined);
  }

  async #sendTunnel(r: Row): Promise<void> {
    const session = this.deps.session(r.worker_id);
    const pv = this.deps.previews();
    if (session === undefined || pv === null || r.tunnel_id === null) return;
    const c = await pv.serviceConnector(r.tunnel_id);
    if (c === null) return;
    const issuedAt = this.deps.clock().toISOString();
    const binding = {
      workerId: r.worker_id,
      serviceId: r.id,
      tunnelId: r.tunnel_id,
      hostname: c.hostname,
      port: c.port,
      expiresAt: c.expiresAt.toISOString(),
      issuedAt,
      connectorToken: c.connectorToken,
    };
    await session.send('SERVICE_TUNNEL', {
      ...binding,
      signature: this.deps.signer.signServiceTunnel(binding),
    });
  }

  // ============================================================================================= worker messages

  /** CAPABILITIES.services: re-send what the master wants and the worker does not run; stop what it does not want. */
  async onReport(
    session: WorkerSession,
    payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
  ): Promise<void> {
    if (payload.services === undefined) return;
    const report = ServicesReport.safeParse(payload.services);
    if (!report.success) return;
    const reported = new Map(report.data.services.map((s) => [s.serviceId, s]));
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE s.worker_id = $1 AND (s.desired <> 'removed' OR s.updated_at > $2)`,
      [session.workerId, new Date(this.deps.clock().getTime() - 30 * 86_400_000)],
    );
    const known = new Map(rows.map((r) => [r.id, r]));
    for (const r0 of rows) {
      let r = r0;
      const rep = reported.get(r.id);
      try {
        // p21-service-egress: a worker updated to `service-egress-v1` restarts its services from records kept without a
        // network policy — give them a new revision with the project's policy.
        if (
          r.desired === 'running' &&
          rep !== undefined &&
          rep.network === false &&
          r.network_applies === true
        ) {
          await this.deps.pool.query(
            'UPDATE services SET revision = revision + 1, updated_at = $2 WHERE id = $1',
            [r.id, this.deps.clock()],
          );
          r = (await this.#row(r.id)) ?? r;
        }
        if (r.desired === 'running') {
          if (rep === undefined || rep.revision < r.revision || !LIVE.has(rep.state)) {
            if (rep === undefined || rep.revision < r.revision || rep.state !== 'failed')
              await this.#sendStart(r);
          }
          if (r.tunnel_mode === 'named' && r.tunnel_id !== null && r.tunnel_state !== 'running') {
            await this.#sendTunnel(r).catch(() => undefined);
          }
        } else if (rep !== undefined) {
          if (r.desired === 'removed') await this.#sendControl(r.worker_id, r.id, 'remove', 'removed');
          else if (LIVE.has(rep.state)) await this.#sendControl(r.worker_id, r.id, 'stop', 'stopped');
        }
      } catch (err) {
        this.deps.log.warn({ err, serviceId: r.id }, 'service reconciliation step failed');
      }
    }
    for (const id of reported.keys()) {
      if (!known.has(id))
        await this.#sendControl(session.workerId, id, 'remove', 'not a service of this machine');
    }
  }

  async onStatus(session: WorkerSession, p: ServiceStatusPayload): Promise<void> {
    const before = await this.#row(p.serviceId);
    if (before?.worker_id !== session.workerId) {
      if (LIVE.has(p.state))
        await this.#sendControl(session.workerId, p.serviceId, 'remove', 'not a service of this machine');
      return;
    }
    if (p.revision < before.revision && p.state !== 'refused' && LIVE.has(p.state)) {
      // An older revision runs: deliver the current one.
      await this.#sendStart(before).catch(() => undefined);
    }
    if (before.desired !== 'running' && LIVE.has(p.state)) {
      await this.#sendControl(
        session.workerId,
        p.serviceId,
        before.desired === 'removed' ? 'remove' : 'stop',
        'stopped',
      );
    }
    const now = this.deps.clock();
    const quickUrl = before.tunnel_mode === 'quick' ? (p.tunnel?.url ?? null) : undefined;
    await this.deps.pool.query(
      `UPDATE services SET state = $2, health = $3, detail = $4, pid = $5, started_at = $6, restarts = $7,
         exit_code = $8, cpu_percent = $9, memory_bytes = $10, tunnel_state = COALESCE($11, tunnel_state),
         tunnel_detail = CASE WHEN $11::text IS NULL THEN tunnel_detail ELSE $12 END,
         url = CASE WHEN $13::boolean THEN $14 ELSE url END,
         healthy_at = CASE WHEN $3 = 'healthy' AND health <> 'healthy' THEN $15 ELSE healthy_at END,
         status_at = $15, updated_at = $15
       WHERE id = $1`,
      [
        p.serviceId,
        p.state,
        p.health,
        p.detail ?? null,
        p.pid ?? null,
        p.startedAt ?? null,
        p.restarts,
        p.exitCode ?? null,
        p.cpuPercent ?? null,
        p.memoryBytes ?? null,
        p.tunnel?.state ?? null,
        p.tunnel?.detail ?? null,
        quickUrl !== undefined,
        quickUrl ?? null,
        now,
      ],
    );
    const after = await this.#row(p.serviceId);
    if (after !== null) this.#emit(before, after);
    if (p.state === 'refused') {
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'service.refused',
        target: `service:${p.serviceId}`,
        outcome: 'denied',
        metadata: { project: before.project, detail: p.detail ?? null },
      });
    }
    // A named tunnel waits for its connector once the service runs.
    if (
      after?.tunnel_mode === 'named' &&
      after.tunnel_id !== null &&
      p.state === 'running' &&
      p.tunnel?.state === 'stopped'
    ) {
      await this.#sendTunnel(after).catch(() => undefined);
    }
  }

  onLogs(_session: WorkerSession, p: ServiceLogsPayload): void {
    this.#pendingLogs.get(p.requestId)?.(p);
  }

  #emit(before: Row | null, after: Row): void {
    const kinds = serviceTransitions(
      before === null
        ? null
        : { state: before.state, health: before.health, url: before.url, desired: before.desired },
      { state: after.state, health: after.health, url: after.url, desired: after.desired },
    );
    for (const kind of kinds) {
      const e: ServiceEvent = {
        kind,
        serviceId: after.id,
        project: after.project,
        workerId: after.worker_id,
        name: after.name,
        url: after.url,
        state: after.state,
        at: this.deps.clock(),
      };
      this.events.emit(e);
    }
  }

  // ============================================================================================= job tools

  async #liveAttempt(jobId: string): Promise<{
    project: string;
    attemptId: string;
    epoch: number;
    workerId: string;
    spec: JobSpec | null;
    createdByType: string;
    createdById: string | null;
  } | null> {
    if (!UUID.test(jobId)) return null;
    const { rows } = await this.deps.pool.query<{
      project: string;
      spec: unknown;
      attempt_id: string;
      epoch: number;
      worker_id: string;
      created_by_type: string;
      created_by_id: string | null;
    }>(
      `SELECT j.project, j.spec, l.attempt_id::text AS attempt_id, l.epoch, l.worker_id, j.created_by_type,
              j.created_by_id
         FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id = $1 AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $2 AND j.lease_epoch = l.epoch
          AND j.state::text IN ('RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'AWAITING_APPROVAL')`,
      [jobId, this.deps.clock()],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const spec = JobSpec.safeParse(r.spec);
    return {
      project: r.project,
      attemptId: r.attempt_id,
      epoch: r.epoch,
      workerId: r.worker_id,
      spec: spec.success ? spec.data : null,
      createdByType: r.created_by_type,
      createdById: r.created_by_id,
    };
  }

  /** ASSIGN_JOB `execution.services` for a job on a worker (null: no service tools). */
  async assignment(
    project: string,
    spec: JobSpec,
    workerId: string,
  ): Promise<{ tools: true; tunnels: ('none' | 'quick' | 'named')[] } | null> {
    if (spec.kind !== undefined || spec.workspace !== undefined || spec.sandboxProfile === 'container')
      return null;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, SERVICES_FEATURE],
    );
    if (rows[0]?.ok !== true) return null;
    const pv = this.deps.previews();
    const named = pv === null ? false : await pv.serviceTunnelsOffered(project);
    const quick = pv === null ? true : await pv.agentQuickTunnels(project);
    return {
      tools: true,
      tunnels: [
        ...(['none'] as const),
        ...(quick ? (['quick'] as const) : []),
        ...(named ? (['named'] as const) : []),
      ],
    };
  }

  /** SERVICE_REQUEST from a job's agent: fenced by the live lease, the job's creator re-authorized. */
  async onRequest(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'SERVICE_REQUEST' }>,
  ): Promise<void> {
    const p: ServiceRequestPayload = message.payload;
    const jobId = message.jobId;
    const reply = (r: Omit<ServiceResultPayload, 'attemptId' | 'epoch' | 'requestId'>) =>
      session
        .send(
          'SERVICE_RESULT',
          { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId, ...r },
          { jobId },
        )
        .catch(() => undefined);
    const live = await this.#liveAttempt(jobId);
    if (live?.attemptId !== p.attemptId || live.epoch !== p.epoch || live.workerId !== session.workerId) {
      await reply({
        status: 'refused',
        reason: 'stale_lease',
        detail: 'This job attempt is no longer running here.',
      });
      return;
    }
    const subject = await this.#creator(live);
    if (subject === null) {
      await reply({
        status: 'refused',
        reason: 'creator_not_allowed',
        detail: 'The person who started this job may not manage services in this project.',
      });
      return;
    }
    const caller: ServiceCaller = { subject, actor: { type: 'system', id: `job:${jobId}` }, via: 'job' };
    const info = (r: ServiceView): ServiceInfo => ({
      id: r.id,
      name: r.name,
      workerId: r.workerId,
      state: r.state,
      health: r.health as ServiceInfo['health'],
      url: r.url,
      port: r.port,
      expiresAt: r.expiresAt,
      startedByThisJob: r.sourceJobId === jobId,
      detail: r.detail,
    });
    try {
      const op = p.op;
      switch (op.kind) {
        case 'start': {
          const v = await this.create(caller, {
            project: live.project,
            fromJobId: jobId,
            request: op.request,
          });
          await reply({ status: 'ok', services: [info(v)] });
          return;
        }
        case 'list': {
          const all = await this.list(subject, { project: live.project });
          await reply({ status: 'ok', services: all.slice(0, SERVICE_LIMITS.perProject * 2).map(info) });
          return;
        }
        case 'stop':
        case 'restart':
        case 'logs': {
          const all = await this.list(subject, { project: live.project, state: 'any' });
          const target = all.find(
            (s) =>
              (op.serviceId !== undefined ? s.id === op.serviceId : s.name === op.name) &&
              s.sourceJobId === jobId,
          );
          if (target === undefined) {
            await reply({
              status: 'refused',
              reason: 'not_this_job',
              detail: 'Only services this job started can be stopped, restarted or read here.',
            });
            return;
          }
          if (op.kind === 'stop') {
            await this.stop(caller, target.id, { reason: 'stopped by the job’s agent' });
            await reply({ status: 'ok', detail: `Stopped ${target.name}.` });
          } else if (op.kind === 'restart') {
            await this.restart(caller, target.id);
            await reply({ status: 'ok', detail: `Restarting ${target.name}.` });
          } else {
            const l = await this.logs(subject, target.id, op.lines ?? 100);
            await reply({ status: 'ok', logs: l.lines.slice(-500) });
          }
          return;
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        await reply({ status: 'refused', reason: err.code.slice(0, 64), detail: err.publicMessage });
        return;
      }
      this.deps.log.error({ err, jobId }, 'service request failed');
      await reply({ status: 'failed', reason: 'internal', detail: 'The service request failed.' });
    }
  }

  async #creator(live: { createdByType: string; createdById: string | null }): Promise<Subject | null> {
    if (live.createdByType !== 'user' || live.createdById === null) return null;
    const { rows } = await this.deps.pool.query<{
      id: string;
      role: 'owner' | 'admin' | 'operator' | 'viewer';
      disabled: boolean;
    }>('SELECT id, role, disabled_at IS NOT NULL AS disabled FROM users WHERE id::text = $1', [
      live.createdById,
    ]);
    const u = rows[0];
    if (u === undefined || u.disabled) return null;
    return loadSubject(this.deps.pool, { id: u.id, role: u.role });
  }

  /** The subject of a user id (assistant tools). */
  async subjectOf(userId: string): Promise<Subject | null> {
    return this.#creator({ createdByType: 'user', createdById: userId });
  }

  // ============================================================================================= sweep

  /**
   * One pass (orchestrator tick step `services`): services past their lifetime are stopped (the worker stops them
   * itself too), and the tunnels of stopped / removed services are closed.
   */
  async sweep(limit = 20): Promise<number> {
    const now = this.deps.clock();
    let n = 0;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM}
        WHERE (s.desired = 'running' AND s.expires_at IS NOT NULL AND s.expires_at <= $1)
           OR (s.desired <> 'running' AND s.tunnel_id IS NOT NULL)
        ORDER BY s.updated_at LIMIT $2`,
      [now, limit],
    );
    const system: ServiceCaller = {
      subject: { userId: 'system', role: 'owner', memberships: new Map() },
      actor: { type: 'system', id: 'services' },
      via: 'api',
    };
    for (const r of rows) {
      try {
        if (r.desired === 'running') {
          await this.deps.pool.query(
            `UPDATE services SET desired = 'stopped', stopped_at = $2, stop_reason = 'expired', updated_at = $2,
               state = CASE WHEN state IN ('pending', 'starting', 'running', 'unhealthy', 'restarting') THEN 'expired'
                            ELSE state END
             WHERE id = $1 AND desired = 'running'`,
            [r.id, now],
          );
          await this.#audit(system, 'service.expire', r);
          await this.#sendControl(r.worker_id, r.id, 'stop', 'expired');
          const after = await this.#row(r.id);
          if (after !== null) this.#emit(r, after);
        }
        await this.#closeTunnel(r, r.desired === 'running' ? 'expired' : (r.stop_reason ?? 'stopped'));
        n++;
      } catch (err) {
        this.deps.log.warn({ err, serviceId: r.id }, 'service sweep step failed');
      }
    }
    return n;
  }
}
