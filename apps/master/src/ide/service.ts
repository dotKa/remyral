import { randomUUID } from 'node:crypto';
import {
  IDE_DIFF_FEATURE,
  IDE_EXTENSIONS_FEATURE,
  IDE_FEATURE,
  IDE_PLATFORMS_FEATURE,
  IDE_LIMITS,
  type IdeEventPayload,
  type IdeFileDataPayload,
  type IdeGitResultPayload,
  type IdeProfile,
  type IdeReport,
  IdeReport as IdeReportSchema,
  IdeSpec,
  type IdeStatusPayload,
  IdeWorkspaceName,
  ideBranch,
  ideSpecHash,
  ideUserSlug,
  LIVE_IDE_STATES,
  SERVICE_EGRESS_FEATURE,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, roleAtLeast, type Subject } from '../authz/model.js';
import type { Pool } from '../db/pool.js';
import { loadGitConfig } from '../gitflow/config-store.js';
import type { ProviderFactory } from '../gitflow/service.js';
import { resolveGitIdentity } from '../git-identity/store.js';
import { HttpError } from '../http/errors.js';
import type { LeaseSigner } from '../orchestration/lease-signer.js';
import { loadProjectEgress } from '../repo-egress/service.js';
import type { GitCredentialProvider } from '../orchestration/session.js';
import type { WorkerSession } from '../workers/types.js';
import type { IdeAccess } from './access.js';
import type { IdeExtensions } from './extensions.js';

/**
 * p19-ide W2 (docs/design/p19-ide.md §3, §7, ADR-0066): "Tam IDE" — the master's side of the IDE workspaces workers run.
 *
 * - **Desired state** (`ide_workspaces`): which user's workspace of which project runs on which Linux machine, from
 *   which source. Creating / starting needs `ide.use` (project operator+) and the `ide.start` step-up event (the
 *   route's; docs/design/p19-ide.md decision 5). Others' workspaces need `ide.manage` (admin). Every change is audited.
 * - **Placement** (decision 6): a machine the project may use that advertises `ide-v1`, says it can run an IDE
 *   (CAPABILITIES.ide.available: Linux, sandbox, not refused locally), is connected, and runs fewer than
 *   {@link IDE_LIMITS.perMachine} IDEs. An IDE holds no job slot.
 * - **Delivery**: IDE_START / IDE_CONTROL / IDE_GIT are signed control messages; an offline machine gets them on its
 *   next session (CAPABILITIES.ide reconciliation). Repository checkouts get a read-only token for the worker's fetch;
 *   a push ("Gönder") a just-minted write token the worker uses once — the IDE process never holds one.
 * - **Idle**: the worker stops a server after `idleMinutes` without a stream; the master's sweeper stops what the
 *   worker did not (no open proxied socket and no request for that long).
 */

export interface IdeServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly signer: LeaseSigner;
  readonly session: (workerId: string) => WorkerSession | undefined;
  readonly access: IdeAccess;
  /** The IDE origin (null: not configured — Tam IDE is off). */
  readonly origin: () => string | null;
  readonly credentials?: GitCredentialProvider;
  readonly providers?: ProviderFactory;
  /** Open proxied WebSockets of a workspace on this master (idle sweep). */
  readonly connections?: (workspaceId: string) => number;
  /** Ends a workspace's proxied streams (stopped, deleted). */
  readonly resetStreams?: (workerId: string, workspaceId: string) => void;
  /** p19-ide W3: extensions + settings sync (absent: starts carry no profile). */
  readonly extensions?: IdeExtensions;
  /** How long a git / file request waits for the worker (ms). Default 120 s / 15 s. */
  readonly gitTimeoutMs?: number;
  readonly fileTimeoutMs?: number;
}

export interface IdeCaller {
  readonly subject: Subject;
  readonly username: string;
  readonly actor: { readonly type: 'user'; readonly id: string; readonly ip?: string | null };
  readonly via: 'api' | 'ide';
}

export interface IdeWorkspaceView {
  readonly id: string;
  readonly project: string;
  readonly userId: string;
  readonly username: string | null;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly workerConnected: boolean;
  readonly name: string;
  readonly source: 'repository' | 'files';
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly desired: 'running' | 'stopped' | 'deleted';
  readonly state: string;
  readonly detail: string | null;
  readonly stopReason: string | null;
  readonly head: string | null;
  readonly memoryMb: number;
  readonly idleMinutes: number;
  readonly memoryBytes: number | null;
  readonly pullRequestUrl: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly lastPushedAt: string | null;
  readonly createdAt: string;
  readonly stoppedAt: string | null;
  /** p19-ide W3: the last start's extensions (null: none recorded / an older machine). */
  readonly extensions: IdeExtensionsReport | null;
}

export interface IdeExtensionsReport {
  /** What the master left out of the start (not allowed, denied, no Linux build, a dependency not allowed). */
  readonly skipped: { readonly id: string; readonly reason: string }[];
  /** What the machine installed / could not install (null until it reported). */
  readonly installed: string[] | null;
  readonly failed: { readonly id: string; readonly reason: string }[];
}

export interface IdeMachineView {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly available: boolean;
  /**
   * Why it cannot run an IDE now: `offline`, `no_feature` (no `ide-v1`), `platform_update` (W2b: a macOS / Windows
   * machine whose worker release predates `ide-platforms-v1`), `capacity`, `not_assigned`, or `unavailable` (the
   * machine's own reason: `detail`, and `detailCode` from CAPABILITIES.ide `reasonCode`).
   */
  readonly reason: string | null;
  readonly detail: string | null;
  /** W2b: the machine's {@link IdeUnavailableCode} for `unavailable` (null: none / an older worker). */
  readonly detailCode: string | null;
  /** W2b: the machine's OS (`linux`, `darwin`, `win32`; null: unknown) — the console names it in reasons. */
  readonly platform: string | null;
  readonly running: number;
  readonly max: number;
}

export interface IdeGitOutcome {
  readonly status: 'ok' | 'refused' | 'failed';
  readonly reason: string | null;
  readonly detail: string | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly changedFiles: number | null;
  readonly ahead: number | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

interface Row {
  id: string;
  project: string;
  user_id: string;
  username: string | null;
  worker_id: string;
  worker_name: string | null;
  name: string;
  source_kind: 'repository' | 'files';
  branch: string | null;
  base_ref: string | null;
  seed_job_id: string | null;
  spec: unknown;
  revision: number;
  desired: 'running' | 'stopped' | 'deleted';
  state: string;
  detail: string | null;
  stop_reason: string | null;
  head: string | null;
  memory_bytes: string | null;
  pull_request_url: string | null;
  started_at: Date | null;
  last_activity_at: Date | null;
  last_pushed_at: Date | null;
  status_at: Date | null;
  created_at: Date;
  stopped_at: Date | null;
  extensions: Record<string, unknown> | null;
}

const COLS = `i.id::text AS id, i.project, i.user_id::text AS user_id, u.username, i.worker_id,
  w.display_name AS worker_name, i.name, i.source_kind, i.branch, i.base_ref, i.seed_job_id::text AS seed_job_id, i.spec,
  i.revision, i.desired, i.state, i.detail, i.stop_reason, i.head, i.memory_bytes, i.pull_request_url, i.started_at,
  i.last_activity_at, i.last_pushed_at, i.status_at, i.created_at, i.stopped_at, i.extensions`;
const FROM =
  'FROM ide_workspaces i LEFT JOIN users u ON u.id = i.user_id LEFT JOIN workers w ON w.id = i.worker_id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = new Set<string>([...LIVE_IDE_STATES, 'pending']);

export class IdeService {
  readonly #reports = new Map<string, IdeReport>();
  // Pending requests by id, with the machine each was sent to: only that machine's session may answer.
  readonly #pendingGit = new Map<
    string,
    { readonly workerId: string; readonly done: (p: IdeGitResultPayload | null) => void }
  >();
  readonly #pendingFile = new Map<
    string,
    { readonly workerId: string; readonly done: (p: IdeFileDataPayload | null) => void }
  >();
  /** Last request the proxy served per workspace (idle sweep). */
  readonly #seen = new Map<string, number>();
  #lastSweep = 0;

  constructor(private readonly deps: IdeServiceDeps) {}

  // ============================================================================================= reads

  get configured(): boolean {
    return this.deps.origin() !== null;
  }

  /** The worker reported CAPABILITIES.ide on its current session (it speaks `ide-v1` and the STREAM_* plane). */
  supports(workerId: string): boolean {
    return this.#reports.has(workerId);
  }

  async #row(id: string): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<Row>(`SELECT ${COLS} ${FROM} WHERE i.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** The project of a workspace that is not deleted (route authorization); null when there is none. */
  async projectOf(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<{ project: string }>(
      `SELECT project FROM ide_workspaces WHERE id = $1 AND desired <> 'deleted'`,
      [id],
    );
    return rows[0]?.project ?? null;
  }

  #view(r: Row): IdeWorkspaceView {
    const spec = IdeSpec.safeParse(r.spec);
    return {
      id: r.id,
      project: r.project,
      userId: r.user_id,
      username: r.username,
      workerId: r.worker_id,
      workerName: r.worker_name,
      workerConnected: this.deps.session(r.worker_id) !== undefined,
      name: r.name,
      source: r.source_kind,
      branch: r.branch,
      baseRef: r.base_ref,
      desired: r.desired,
      state: r.state,
      detail: r.detail,
      stopReason: r.stop_reason,
      head: r.head,
      memoryMb: spec.success ? spec.data.memoryMb : IDE_LIMITS.memoryMb,
      idleMinutes: spec.success ? spec.data.idleMinutes : IDE_LIMITS.idleMinutes,
      memoryBytes: r.memory_bytes === null ? null : Number(r.memory_bytes),
      pullRequestUrl: r.pull_request_url,
      startedAt: r.started_at?.toISOString() ?? null,
      lastActivityAt: r.last_activity_at?.toISOString() ?? null,
      lastPushedAt: r.last_pushed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      stoppedAt: r.stopped_at?.toISOString() ?? null,
      extensions: extensionsReport(r.extensions),
    };
  }

  /** The caller's workspaces of a project (all users' with `all` and `ide.manage`). */
  async list(c: IdeCaller, project: string, all = false): Promise<IdeWorkspaceView[]> {
    const everyone = all && authorize(c.subject, 'ide.manage', { project }).allow;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM}
        WHERE i.project = $1 AND i.desired <> 'deleted' AND ($2 OR i.user_id = $3)
        ORDER BY i.created_at DESC LIMIT 100`,
      [project, everyone, c.actor.id],
    );
    return rows.map((r) => this.#view(r));
  }

  async get(c: IdeCaller, id: string): Promise<IdeWorkspaceView> {
    return this.#view(await this.#mine(c, id));
  }

  /** A workspace the caller may act on: their own (`ide.use`), or anyone's with `ide.manage`. 404 otherwise. */
  async #mine(c: IdeCaller, id: string, own = false): Promise<Row> {
    const r = await this.#row(id);
    if (r === null || r.desired === 'deleted') throw notFound();
    if (!authorize(c.subject, 'ide.use', { project: r.project }).allow) throw notFound();
    if (r.user_id === c.actor.id) return r;
    if (!own && authorize(c.subject, 'ide.manage', { project: r.project }).allow) return r;
    throw notFound();
  }

  /** Machines a project's IDE can run on, with the reason for each one that cannot (the start dialog). */
  async machines(project: string): Promise<IdeMachineView[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      name: string;
      state: string;
      features: unknown;
      projects: unknown;
      facts: { os?: string } | null;
      running: number;
    }>(
      `SELECT w.id, w.display_name AS name, w.state, w.features, w.local_projects AS projects, w.facts,
              (SELECT count(*)::int FROM ide_workspaces i
                WHERE i.worker_id = w.id AND i.desired = 'running'
                  AND i.state IN ('pending', 'preparing', 'starting', 'running')) AS running
         FROM workers w
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL
        ORDER BY w.display_name, w.id LIMIT 200`,
    );
    const repository = (await loadGitConfig(this.deps.pool, project)) !== null;
    return rows.map((w) => {
      const online = (w.state === 'online' || w.state === 'busy') && this.deps.session(w.id) !== undefined;
      const report = this.#reports.get(w.id);
      const max = report?.max ?? IDE_LIMITS.perMachine;
      const features = Array.isArray(w.features) ? (w.features as string[]) : [];
      let reason: string | null = null;
      let detail: string | null = null;
      let detailCode: string | null = null;
      const os = typeof w.facts?.os === 'string' ? w.facts.os : null;
      if (!features.includes(IDE_FEATURE)) reason = 'no_feature';
      // W2b: an older worker on macOS / Windows advertises ide-v1 but cannot run the IDE there.
      else if (os !== null && os !== 'linux' && !features.includes(IDE_PLATFORMS_FEATURE))
        reason = 'platform_update';
      else if (!online) reason = 'offline';
      else if (report !== undefined && !report.available) {
        reason = 'unavailable';
        detail = report.reason ?? null;
        detailCode = report.reasonCode ?? null;
      } else if (repository && Array.isArray(w.projects) && !(w.projects as string[]).includes(project))
        reason = 'not_assigned';
      else if (w.running >= max) reason = 'capacity';
      return {
        id: w.id,
        name: w.name,
        online,
        available: reason === null,
        reason,
        detail,
        detailCode,
        platform: os,
        running: w.running,
        max,
      };
    });
  }

  // ============================================================================================= changes

  async #audit(
    c: {
      readonly actor: {
        readonly type: 'user' | 'system' | 'worker';
        readonly id: string;
        readonly ip?: string | null;
      };
    },
    action: string,
    r: Pick<Row, 'id' | 'project' | 'worker_id' | 'name' | 'user_id'>,
    metadata: Record<string, unknown> = {},
    outcome: 'success' | 'failure' | 'denied' = 'success',
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: c.actor.type, id: c.actor.id },
      action,
      target: `ide:${r.id}`,
      outcome,
      metadata: { project: r.project, worker: r.worker_id, name: r.name, owner: r.user_id, ...metadata },
      ...(c.actor.ip === undefined || c.actor.ip === null ? {} : { ip: c.actor.ip }),
    });
  }

  #requireConfigured(): void {
    if (this.deps.origin() === null) {
      throw new HttpError(
        409,
        'ide_not_configured',
        'Tam IDE is not set up on this server (no ide.<domain> address). The viewer works.',
      );
    }
  }

  async #author(userId: string, username: string, project: string): Promise<{ name: string; email: string }> {
    const { rows } = await this.deps.pool.query<{ email: string | null }>(
      'SELECT email FROM notification_targets WHERE user_id = $1',
      [userId],
    );
    const identity = (await resolveGitIdentity(this.deps.pool, project)).identity;
    return { name: username.slice(0, 128), email: rows[0]?.email ?? identity.email };
  }

  /** Creates a workspace and starts it (step-up checked by the route). */
  async create(
    c: IdeCaller,
    input: {
      readonly project: string;
      readonly name: string;
      readonly worker?: string | undefined;
      readonly baseRef?: string | undefined;
      readonly seedJobId?: string | undefined;
      readonly memoryMb?: number | undefined;
    },
  ): Promise<IdeWorkspaceView> {
    this.#requireConfigured();
    if (!authorize(c.subject, 'ide.use', { project: input.project }).allow) throw notFound();
    const name = IdeWorkspaceName.safeParse(input.name);
    if (!name.success)
      throw new HttpError(
        400,
        'ide_invalid',
        'A workspace name has 1-32 lower-case letters, digits and hyphens.',
      );
    const { rows: projects } = await this.deps.pool.query<{ kind: string }>(
      'SELECT kind FROM projects WHERE id = $1',
      [input.project],
    );
    const kind = projects[0]?.kind;
    if (kind === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const count = await this.deps.pool.query<{ n: number; taken: boolean }>(
      `SELECT count(*)::int AS n, coalesce(bool_or(name = $3), false) AS taken FROM ide_workspaces
        WHERE project = $1 AND user_id = $2 AND desired <> 'deleted'`,
      [input.project, c.actor.id, name.data],
    );
    if (count.rows[0]?.taken === true) {
      throw new HttpError(
        409,
        'ide_name_taken',
        'You already have a workspace with this name in the project.',
      );
    }
    if ((count.rows[0]?.n ?? 0) >= IDE_LIMITS.perUserProject) {
      throw new HttpError(
        409,
        'ide_limit',
        `At most ${String(IDE_LIMITS.perUserProject)} workspaces per project and user; delete one first.`,
      );
    }
    let source: IdeSpec['source'];
    let baseRef: string | null = null;
    let branch: string | null = null;
    let seedJobId: string | null = null;
    if (kind === 'repository') {
      const git = await loadGitConfig(this.deps.pool, input.project);
      if (git === null) {
        throw new HttpError(409, 'ide_no_repository', 'This project or workspace has no repository.');
      }
      baseRef = input.baseRef ?? git.baseBranch;
      branch = ideBranch(ideUserSlug(c.username), name.data);
      source = { kind: 'repository', repositoryUrl: git.repositoryUrl, baseRef, branch };
    } else {
      let seed: Extract<IdeSpec['source'], { kind: 'files' }>['seed'] = null;
      if (input.seedJobId !== undefined) {
        const { rows } = await this.deps.pool.query<{ attempt_id: string; worker_id: string }>(
          `SELECT k.attempt_id::text AS attempt_id, k.worker_id FROM job_workfiles k
            WHERE k.job_id = $1 AND k.project = $2 AND k.state = 'kept'
            ORDER BY k.kept_at DESC LIMIT 1`,
          [input.seedJobId, input.project],
        );
        const k = rows[0];
        if (k === undefined) {
          throw new HttpError(
            409,
            'ide_seed_missing',
            'This job’s working files are not kept on a machine any more.',
          );
        }
        if (input.worker !== undefined && input.worker !== k.worker_id) {
          throw new HttpError(409, 'ide_seed_worker', 'The working files are kept on another machine.');
        }
        seed = { jobId: input.seedJobId as never, attemptId: k.attempt_id as never };
        seedJobId = input.seedJobId;
        input = { ...input, worker: k.worker_id };
      }
      source = { kind: 'files', seed };
    }
    const machines = await this.machines(input.project);
    const pick =
      input.worker === undefined
        ? machines.filter((m) => m.available).sort((a, b) => a.running - b.running)[0]
        : machines.find((m) => m.id === input.worker || m.name === input.worker);
    if (pick === undefined) {
      throw new HttpError(
        409,
        'ide_no_machine',
        'No machine can run Tam IDE now (offline, not Linux, or full).',
      );
    }
    if (!pick.available) {
      throw new HttpError(
        409,
        pick.reason === 'capacity' ? 'ide_capacity' : 'ide_machine_unavailable',
        pick.reason === 'capacity'
          ? `${pick.name} already runs ${String(pick.max)} IDEs; stop one first or choose another machine.`
          : `${pick.name} cannot run Tam IDE now (${pick.reason ?? 'unavailable'}).`,
      );
    }
    await this.#userMachineLimit(c.actor.id, pick.id, null);
    const id = randomUUID();
    const now = this.deps.clock();
    const parsed = IdeSpec.safeParse({
      workspaceId: id,
      projectId: input.project,
      userId: c.actor.id,
      name: name.data,
      source,
      memoryMb: input.memoryMb ?? IDE_LIMITS.memoryMb,
      idleMinutes: IDE_LIMITS.idleMinutes,
      sandboxProfile: 'host-restricted',
      gitAuthor: await this.#author(c.actor.id, c.username, input.project),
    });
    if (!parsed.success)
      throw new HttpError(
        400,
        'ide_invalid',
        'A workspace name has 1-32 lower-case letters, digits and hyphens.',
      );
    await this.deps.pool.query(
      `INSERT INTO ide_workspaces (id, project, user_id, worker_id, name, source_kind, branch, base_ref, seed_job_id,
         spec, revision, desired, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'running', 'pending', $11, $11)`,
      [
        id,
        input.project,
        c.actor.id,
        pick.id,
        name.data,
        source.kind,
        branch,
        baseRef,
        seedJobId,
        JSON.stringify(parsed.data),
        now,
      ],
    );
    const row = await this.#row(id);
    if (row === null) throw new Error('IDE workspace row vanished');
    await this.#audit(c, 'ide.workspace.create', row, {
      source: source.kind,
      branch,
      baseRef,
      memoryMb: parsed.data.memoryMb,
      via: c.via,
    });
    await this.#sendStart(row).catch((err: unknown) => {
      this.deps.log.warn({ err, workspaceId: id }, 'IDE_START not sent (sent on reconnect)');
    });
    return this.#view((await this.#row(id)) ?? row);
  }

  /** A user runs at most one IDE per machine (docs/design/p19-ide.md decision 6, with the per-machine cap). */
  async #userMachineLimit(userId: string, workerId: string, except: string | null): Promise<void> {
    const { rows } = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ide_workspaces
        WHERE user_id = $1 AND worker_id = $2 AND desired = 'running' AND ($3::uuid IS NULL OR id <> $3::uuid)
          AND state IN ('pending', 'preparing', 'starting', 'running')`,
      [userId, workerId, except],
    );
    if ((rows[0]?.n ?? 0) >= 1) {
      throw new HttpError(
        409,
        'ide_user_machine',
        'You already have an IDE running on this machine; stop it first.',
      );
    }
  }

  /** Starts a stopped workspace again on its machine (step-up checked by the route). */
  async start(c: IdeCaller, id: string): Promise<IdeWorkspaceView> {
    this.#requireConfigured();
    const r = await this.#mine(c, id);
    if (LIVE.has(r.state) && r.desired === 'running') return this.#view(r);
    const machine = (await this.machines(r.project)).find((m) => m.id === r.worker_id);
    if (machine === undefined || !machine.online) {
      throw new HttpError(409, 'ide_machine_offline', 'The workspace’s machine is not connected.');
    }
    if (machine.reason === 'capacity') {
      throw new HttpError(
        409,
        'ide_capacity',
        `${machine.name} already runs ${String(machine.max)} IDEs; stop one first.`,
      );
    }
    if (machine.reason !== null && machine.reason !== 'not_assigned') {
      throw new HttpError(409, 'ide_machine_unavailable', `${machine.name} cannot run Tam IDE now.`);
    }
    await this.#userMachineLimit(r.user_id, r.worker_id, r.id);
    await this.deps.pool.query(
      `UPDATE ide_workspaces SET desired = 'running', state = 'pending', detail = NULL, stop_reason = NULL,
         updated_at = $2 WHERE id = $1`,
      [r.id, this.deps.clock()],
    );
    const row = (await this.#row(id)) ?? r;
    await this.#audit(c, 'ide.workspace.start', row, { via: c.via });
    await this.#sendStart(row).catch((err: unknown) => {
      this.deps.log.warn({ err, workspaceId: id }, 'IDE_START not sent (sent on reconnect)');
    });
    return this.#view((await this.#row(id)) ?? row);
  }

  async stop(
    c: IdeCaller | { readonly actor: { readonly type: 'system'; readonly id: string } },
    id: string,
    reason: 'requested' | 'idle' = 'requested',
  ): Promise<IdeWorkspaceView> {
    const r = 'subject' in c ? await this.#mine(c, id) : await this.#row(id);
    if (r === null || r.desired === 'deleted') throw notFound();
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE ide_workspaces SET desired = 'stopped', stopped_at = coalesce(stopped_at, $2), updated_at = $2,
         stop_reason = CASE WHEN $3 = 'idle' THEN 'idle' ELSE stop_reason END WHERE id = $1`,
      [r.id, now, reason],
    );
    await this.deps.access.revokeWorkspace(r.id);
    this.deps.resetStreams?.(r.worker_id, r.id);
    await this.#sendControl(r.worker_id, r.id, 'stop', reason === 'idle' ? 'idle' : 'stopped');
    await this.#audit(c, reason === 'idle' ? 'ide.workspace.idle_stop' : 'ide.workspace.stop', r);
    return this.#view((await this.#row(id)) ?? r);
  }

  /** Deletes a workspace: the machine removes its files (and the local branch; a pushed branch stays on the remote). */
  async remove(c: IdeCaller, id: string): Promise<void> {
    const r = await this.#mine(c, id);
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE ide_workspaces SET desired = 'deleted', deleted_at = $2, updated_at = $2,
         stopped_at = coalesce(stopped_at, $2) WHERE id = $1`,
      [r.id, now],
    );
    await this.deps.access.revokeWorkspace(r.id);
    this.deps.resetStreams?.(r.worker_id, r.id);
    await this.#sendControl(r.worker_id, r.id, 'remove', 'deleted');
    await this.#audit(c, 'ide.workspace.delete', r, { state: r.state });
  }

  /** A one-time ticket and the IDE origin URL that redeems it (the browser opens it in a new tab). */
  async open(c: IdeCaller, id: string, sessionHash: Buffer): Promise<{ url: string; expiresAt: string }> {
    this.#requireConfigured();
    const r = await this.#mine(c, id, true);
    if (r.desired !== 'running' || r.state !== 'running') {
      throw new HttpError(409, 'ide_not_running', 'The workspace is not running; start it first.');
    }
    const origin = this.deps.origin() ?? '';
    const t = await this.deps.access.issueTicket({
      workspaceId: r.id,
      userId: c.actor.id,
      sessionHash,
      ip: c.actor.ip ?? null,
    });
    return {
      url: `${origin}/_ide/enter?w=${r.id}&t=${t.ticket}`,
      expiresAt: t.expiresAt.toISOString(),
    };
  }

  /** The proxy's authorization of a request: the workspace runs, belongs to the user, the user may still use it. */
  async proxyTarget(
    workspaceId: string,
    userId: string,
  ): Promise<{ workerId: string; project: string; name: string } | null> {
    const r = await this.#row(workspaceId);
    if (r === null || r.desired !== 'running' || r.user_id !== userId) return null;
    const { rows } = await this.deps.pool.query<{ role: Subject['role']; disabled: boolean }>(
      'SELECT role, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled) return null;
    const subject = await loadSubject(this.deps.pool, { id: userId, role: u.role });
    if (!authorize(subject, 'ide.use', { project: r.project }).allow) return null;
    return { workerId: r.worker_id, project: r.project, name: r.name };
  }

  /** The proxy saw a request of a workspace (idle sweep). */
  touch(workspaceId: string): void {
    this.#seen.set(workspaceId, this.deps.clock().getTime());
  }

  async auditOpen(
    workspaceId: string,
    userId: string,
    meta: { readonly ip: string; readonly userAgent: string | null },
  ): Promise<void> {
    const r = await this.#row(workspaceId);
    if (r === null) return;
    await this.deps.audit.record({
      actor: { type: 'user', id: userId },
      action: 'ide.open',
      target: `ide:${r.id}`,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { project: r.project, worker: r.worker_id, name: r.name },
    });
  }

  // ============================================================================================= git / files

  /** "Gönder": commit (when `message` is given) and push the workspace branch; optionally open / update a PR. */
  async push(
    c: IdeCaller,
    id: string,
    input: { readonly message?: string | undefined; readonly pullRequest: boolean },
  ): Promise<IdeGitOutcome> {
    const r = await this.#mine(c, id, true);
    if (r.source_kind !== 'repository' || r.branch === null) {
      throw new HttpError(409, 'ide_no_repository', 'This project or workspace has no repository.');
    }
    const git = await loadGitConfig(this.deps.pool, r.project);
    if (git === null)
      throw new HttpError(409, 'ide_no_repository', 'This project or workspace has no repository.');
    const cred = await this.deps.credentials
      ?.issueIdePush?.({
        project: r.project,
        repositoryUrl: git.repositoryUrl,
        workerId: r.worker_id,
        workspaceId: r.id,
      })
      .catch(() => null);
    if ((cred === null || cred === undefined) && git.provider !== 'git') {
      await this.#audit(c, 'ide.git.push', r, { reason: 'no_credential' }, 'failure');
      return outcome({
        status: 'refused',
        reason: 'no_credential',
        detail: 'No push credential for this repository (Ayarlar → Entegrasyonlar).',
      });
    }
    const res = await this.#git(r, 'push', input.message, cred ?? null);
    if (res === null) {
      return outcome({ status: 'failed', reason: 'timeout', detail: 'The machine did not answer in time.' });
    }
    let pullRequest: { number: number; url: string } | null = null;
    if (res.status === 'ok') {
      const now = this.deps.clock();
      await this.deps.pool.query(
        'UPDATE ide_workspaces SET head = coalesce($2, head), last_pushed_at = $3, updated_at = $3 WHERE id = $1',
        [r.id, res.head ?? null, now],
      );
      await this.#audit(c, 'ide.git.push', r, {
        branch: res.branch ?? r.branch,
        head: res.head ?? null,
        committed: res.committed === true,
        via: c.via,
      });
      if (input.pullRequest && this.deps.providers !== undefined) {
        try {
          const provider = this.deps.providers(git);
          pullRequest = await provider.ensurePullRequest({
            headBranch: r.branch,
            targetBranch: git.baseBranch,
            title: (input.message ?? `IDE: ${r.name}`).split('\n', 1)[0]?.slice(0, 200) ?? `IDE: ${r.name}`,
            body: `Changes from the Remyral IDE workspace “${r.name}” of ${c.username} (branch ${r.branch}).`,
          });
          if (pullRequest !== null) {
            await this.deps.pool.query('UPDATE ide_workspaces SET pull_request_url = $2 WHERE id = $1', [
              r.id,
              pullRequest.url,
            ]);
            await this.#audit(c, 'ide.git.pr', r, { number: pullRequest.number, url: pullRequest.url });
          }
        } catch (err) {
          this.deps.log.warn({ err, workspaceId: r.id }, 'IDE pull request could not be opened');
          return {
            ...outcome({
              status: 'failed',
              reason: 'pull_request_failed',
              detail: 'Pushed, but the pull request could not be opened.',
            }),
            branch: res.branch ?? r.branch,
            head: res.head ?? null,
            committed: res.committed === true,
            pushed: true,
          };
        }
      }
    } else {
      await this.#audit(c, 'ide.git.push', r, { reason: res.reason ?? null }, 'failure');
    }
    return {
      status: res.status,
      reason: res.reason ?? null,
      detail: res.detail ?? null,
      branch: res.branch ?? r.branch,
      head: res.head ?? null,
      committed: res.committed === true,
      pushed: res.pushed === true,
      changedFiles: res.changedFiles ?? null,
      ahead: res.ahead ?? null,
      pullRequest,
    };
  }

  async gitStatus(c: IdeCaller, id: string): Promise<IdeGitOutcome> {
    const r = await this.#mine(c, id);
    if (r.source_kind !== 'repository') {
      throw new HttpError(409, 'ide_no_repository', 'This project or workspace has no repository.');
    }
    const res = await this.#git(r, 'status', undefined, null);
    if (res === null) {
      return outcome({ status: 'failed', reason: 'timeout', detail: 'The machine did not answer in time.' });
    }
    return {
      ...outcome({ status: res.status, reason: res.reason ?? null, detail: res.detail ?? null }),
      branch: res.branch ?? r.branch,
      head: res.head ?? null,
      changedFiles: res.changedFiles ?? null,
      ahead: res.ahead ?? null,
    };
  }

  async #git(
    r: Row,
    op: 'status' | 'push' | 'diff',
    message: string | undefined,
    cred: { token: string; username?: string } | null,
    path?: string,
  ): Promise<IdeGitResultPayload | null> {
    const session = this.deps.session(r.worker_id);
    if (session === undefined)
      throw new HttpError(409, 'ide_machine_offline', 'The workspace’s machine is not connected.');
    const requestId = randomUUID();
    const issuedAt = this.deps.clock().toISOString();
    const wait = new Promise<IdeGitResultPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingGit.delete(requestId);
        resolve(null);
      }, this.deps.gitTimeoutMs ?? 120_000);
      timer.unref();
      this.#pendingGit.set(requestId, {
        workerId: r.worker_id,
        done: (p) => {
          clearTimeout(timer);
          this.#pendingGit.delete(requestId);
          resolve(p);
        },
      });
    });
    await session.send('IDE_GIT', {
      requestId,
      workspaceId: r.id,
      op,
      ...(message === undefined ? {} : { message }),
      ...(path === undefined ? {} : { path }),
      ...(cred === null
        ? {}
        : {
            gitToken: cred.token,
            ...(cred.username === undefined ? {} : { gitTokenUsername: cred.username }),
          }),
      issuedAt,
      signature: this.deps.signer.signIdeGit({
        workerId: r.worker_id,
        workspaceId: r.id,
        requestId,
        op,
        message,
        issuedAt,
        ...(path === undefined ? {} : { path }),
      }),
    });
    return wait;
  }

  // ------------------------------------------------------------------------------------------ p19-ide W4 (assistant)

  /**
   * p19-ide W4 (`read_workspace_diff`): the caller's own IDE workspaces of a project (`code.read`; with `ide.manage`
   * everyone's) for the assistant to pick from.
   */
  async workspacesFor(subject: Subject, project: string): Promise<IdeWorkspaceView[]> {
    if (!authorize(subject, 'code.read', { project }).allow) return [];
    const everyone = authorize(subject, 'ide.manage', { project }).allow;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM}
        WHERE i.project = $1 AND i.desired <> 'deleted' AND ($2 OR i.user_id = $3)
        ORDER BY i.created_at DESC LIMIT 50`,
      [project, everyone, subject.userId],
    );
    return rows.map((r) => this.#view(r));
  }

  /**
   * p19-ide W4 (`read_workspace_diff`): a workspace's uncommitted changes, read from its machine now (IDE_GIT `diff`,
   * the machine needs `ide-diff-v1`). The owner, or `ide.manage`; `code.read` on the project. Not found (null) for
   * anything else; the text is NOT redacted here (the caller does).
   */
  async workspaceDiff(
    subject: Subject,
    workspaceId: string,
    path: string | undefined,
  ): Promise<
    | { readonly ok: false; readonly reason: string; readonly message: string }
    | {
        readonly ok: true;
        readonly workspace: IdeWorkspaceView;
        readonly result: IdeGitResultPayload;
      }
    | null
  > {
    const r = await this.#row(workspaceId);
    if (r === null || r.desired === 'deleted') return null;
    if (!authorize(subject, 'code.read', { project: r.project }).allow) return null;
    if (r.user_id !== subject.userId && !authorize(subject, 'ide.manage', { project: r.project }).allow)
      return null;
    const view = this.#view(r);
    if (r.source_kind !== 'repository')
      return {
        ok: false,
        reason: 'no_repository',
        message: 'This workspace has no repository checkout (a files workspace): there is no git diff.',
      };
    if (this.deps.session(r.worker_id) === undefined)
      return {
        ok: false,
        reason: 'machine_offline',
        message: `The workspace's machine (${r.worker_name ?? r.worker_id}) is not connected: its changes cannot be read now.`,
      };
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [r.worker_id],
    );
    const features = Array.isArray(rows[0]?.features) ? (rows[0].features as unknown[]) : [];
    if (!features.includes(IDE_DIFF_FEATURE))
      return {
        ok: false,
        reason: 'machine_update',
        message: `The workspace's machine (${r.worker_name ?? r.worker_id}) runs an older Remyral that cannot read workspace diffs (needs ${IDE_DIFF_FEATURE}): update it, or ask the user to send the changes with "Gönder" and read the branch with read_code.`,
      };
    const res = await this.#git(r, 'diff', undefined, null, path);
    if (res === null) return { ok: false, reason: 'timeout', message: 'The machine did not answer in time.' };
    if (res.status !== 'ok')
      return {
        ok: false,
        reason: res.reason ?? res.status,
        message: res.detail ?? 'The machine refused the diff.',
      };
    return { ok: true, workspace: view, result: res };
  }

  /** A file of a workspace for a chat reference: the owner (or `ide.manage`), the machine must be connected. */
  async readFile(subject: Subject, workspaceId: string, path: string): Promise<string | null> {
    const r = await this.#row(workspaceId);
    if (r === null || r.desired === 'deleted') return null;
    if (!authorize(subject, 'code.read', { project: r.project }).allow) return null;
    if (r.user_id !== subject.userId && !authorize(subject, 'ide.manage', { project: r.project }).allow)
      return null;
    const session = this.deps.session(r.worker_id);
    if (session === undefined) return null;
    const requestId = randomUUID();
    const wait = new Promise<IdeFileDataPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingFile.delete(requestId);
        resolve(null);
      }, this.deps.fileTimeoutMs ?? 15_000);
      timer.unref();
      this.#pendingFile.set(requestId, {
        workerId: r.worker_id,
        done: (p) => {
          clearTimeout(timer);
          this.#pendingFile.delete(requestId);
          resolve(p);
        },
      });
    });
    await session.send('IDE_FILE_REQUEST', { requestId, workspaceId, path }).catch(() => undefined);
    const p = await wait;
    return p?.status === 'ok' && p.text !== undefined ? p.text : null;
  }

  /** The project of a workspace a subject may reference (code references). */
  async referenceProject(subject: Subject, workspaceId: string): Promise<string | null> {
    const r = await this.#row(workspaceId);
    if (r === null || r.desired === 'deleted') return null;
    if (r.user_id !== subject.userId && !authorize(subject, 'ide.manage', { project: r.project }).allow)
      return null;
    return r.project;
  }

  /** "Sohbete ekle" references from the IDE the console has not taken yet (taken now). */
  async claimReferences(userId: string): Promise<{ project: string; id: string; label: string }[]> {
    const { rows } = await this.deps.pool.query<{ project: string; ref_id: string; label: string }>(
      `UPDATE ide_references SET claimed_at = $2::timestamptz
        WHERE id IN (SELECT id FROM ide_references WHERE user_id = $1 AND claimed_at IS NULL
                      AND created_at > $2::timestamptz - interval '1 hour' ORDER BY created_at LIMIT 8)
        RETURNING project, ref_id, label`,
      [userId, this.deps.clock()],
    );
    return rows.map((r) => ({ project: r.project, id: r.ref_id, label: r.label }));
  }

  // ============================================================================================= delivery

  async #sendStart(r: Row): Promise<boolean> {
    if (r.desired !== 'running') return false;
    const session = this.deps.session(r.worker_id);
    if (session === undefined) return false;
    const spec = await this.#withNetwork(r, IdeSpec.parse(r.spec));
    const issuedAt = this.deps.clock().toISOString();
    let git: { token: string; username?: string } | null = null;
    if (spec.source.kind === 'repository') {
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
    const extras = await this.#profile(r);
    await session.send('IDE_START', {
      spec,
      revision: r.revision,
      issuedAt,
      ...(git === null
        ? {}
        : { gitToken: git.token, ...(git.username === undefined ? {} : { gitTokenUsername: git.username }) }),
      ...(extras === null ? {} : { profile: extras.profile, downloadToken: extras.token }),
      signature: this.deps.signer.signIdeStart({
        workerId: r.worker_id,
        revision: r.revision,
        issuedAt,
        spec,
        ...(extras === null ? {} : { profile: extras.profile }),
      }),
    });
    return true;
  }

  /**
   * p21-service-egress: an IDE server gets its project's network access policy in force at this start (a repository
   * project's p14-repo-egress setting; a files workspace's project its Workspace-tab egress setting since
   * p22-worker-limits), on a worker with `service-egress-v1` (an older one would refuse the strict spec). A running
   * server keeps the policy it started with (a change applies at its next start: restarting it would drop the user's
   * editor session). Read failures: model APIs only (fails closed).
   */
  async #withNetwork(r: Row, spec: IdeSpec): Promise<IdeSpec> {
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
        { err, workspaceId: r.id },
        'project egress policy unavailable; the IDE gets model APIs only',
      );
      return base;
    }
  }

  /**
   * p19-ide W3: the extensions + enforced settings of a start and its download token — only for a machine with
   * `ide-extensions-v1`. What was left out is recorded on the workspace (the console shows it).
   */
  async #profile(r: Row): Promise<{ profile: IdeProfile; token: string } | null> {
    const ext = this.deps.extensions;
    if (ext === undefined) return null;
    const { rows } = await this.deps.pool.query<{
      features: unknown;
      os: string | null;
      arch: string | null;
    }>("SELECT features, facts->>'os' AS os, facts->>'arch' AS arch FROM workers WHERE id = $1", [
      r.worker_id,
    ]);
    const w = rows[0];
    if (
      w === undefined ||
      !Array.isArray(w.features) ||
      !(w.features as unknown[]).includes(IDE_EXTENSIONS_FEATURE)
    )
      return null;
    const { profile, skipped } = await ext.profileFor({
      project: r.project,
      userId: r.user_id,
      os: w.os,
      arch: w.arch,
    });
    const token = ext.issueToken({
      workerId: r.worker_id,
      workspaceId: r.id,
      userId: r.user_id,
      shas: profile.extensions.map((e) => e.sha256),
    });
    await this.deps.pool.query('UPDATE ide_workspaces SET extensions = $2 WHERE id = $1', [
      r.id,
      JSON.stringify({ skipped: skipped.slice(0, 100), installed: null, failed: [] }),
    ]);
    return { profile, token };
  }

  async #sendControl(
    workerId: string,
    workspaceId: string,
    op: 'stop' | 'remove',
    reason: string,
  ): Promise<void> {
    const session = this.deps.session(workerId);
    if (session === undefined) return;
    const issuedAt = this.deps.clock().toISOString();
    await session
      .send('IDE_CONTROL', {
        workspaceId,
        op,
        reason: reason.slice(0, 200),
        issuedAt,
        signature: this.deps.signer.signIdeControl({ workerId, workspaceId, op, issuedAt }),
      })
      .catch(() => undefined);
  }

  // ============================================================================================= worker messages

  /** CAPABILITIES.ide: availability of the machine, and reconciliation of its workspaces. */
  async onReport(
    session: WorkerSession,
    payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
  ): Promise<void> {
    if (payload.ide === undefined) {
      this.#reports.delete(session.workerId);
      return;
    }
    const report = IdeReportSchema.safeParse(payload.ide);
    if (!report.success) return;
    this.#reports.set(session.workerId, report.data);
    const reported = new Map(report.data.workspaces.map((w) => [w.workspaceId, w]));
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE i.worker_id = $1 AND (i.desired <> 'deleted' OR i.state <> 'removed')`,
      [session.workerId],
    );
    const known = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      const rep = reported.get(r.id);
      try {
        if (r.desired === 'running') {
          const live = rep !== undefined && (LIVE_IDE_STATES as readonly string[]).includes(rep.state);
          // Wanted and not alive (a worker restart, an offline start): start it — unless it gave up on this revision.
          if (
            !live &&
            (rep === undefined ||
              rep.revision < r.revision ||
              (rep.state !== 'failed' && rep.state !== 'refused'))
          )
            await this.#sendStart(r);
        } else if (r.desired === 'stopped') {
          if (rep !== undefined && (LIVE_IDE_STATES as readonly string[]).includes(rep.state))
            await this.#sendControl(r.worker_id, r.id, 'stop', 'stopped');
        } else if (rep !== undefined) {
          await this.#sendControl(r.worker_id, r.id, 'remove', 'deleted');
        } else {
          await this.deps.pool.query(
            `UPDATE ide_workspaces SET state = 'removed', updated_at = $2 WHERE id = $1`,
            [r.id, this.deps.clock()],
          );
        }
      } catch (err) {
        this.deps.log.warn({ err, workspaceId: r.id }, 'IDE reconciliation step failed');
      }
    }
    for (const id of reported.keys()) {
      if (!known.has(id))
        await this.#sendControl(session.workerId, id, 'remove', 'not a workspace of this machine');
    }
  }

  onSessionEnd(session: WorkerSession): void {
    this.#reports.delete(session.workerId);
  }

  async onStatus(session: WorkerSession, p: IdeStatusPayload): Promise<void> {
    const before = await this.#row(p.workspaceId);
    if (before?.worker_id !== session.workerId) {
      if ((LIVE_IDE_STATES as readonly string[]).includes(p.state))
        await this.#sendControl(session.workerId, p.workspaceId, 'remove', 'not a workspace of this machine');
      return;
    }
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE ide_workspaces SET state = $2, detail = $3, stop_reason = $4, head = coalesce($5, head),
         memory_bytes = $6, cpu_percent = $7, started_at = coalesce(least($8::timestamptz, $10), started_at),
         last_activity_at = greatest(last_activity_at, $9), status_at = $10, updated_at = $10,
         stopped_at = CASE WHEN $2 IN ('stopped', 'failed', 'refused', 'removed') THEN coalesce(stopped_at, $10)
                           ELSE NULL END
       WHERE id = $1`,
      [
        p.workspaceId,
        p.state,
        p.detail ?? null,
        p.stopReason ?? null,
        p.head ?? null,
        p.memoryBytes ?? null,
        p.cpuPercent ?? null,
        p.startedAt === undefined ? null : new Date(p.startedAt),
        p.lastActivityAt === undefined ? null : new Date(p.lastActivityAt),
        now,
      ],
    );
    if (p.extensions !== undefined) {
      const prev = extensionsReport(before.extensions);
      await this.deps.pool.query('UPDATE ide_workspaces SET extensions = $2 WHERE id = $1', [
        p.workspaceId,
        JSON.stringify({
          skipped: prev?.skipped ?? [],
          installed: p.extensions.installed,
          failed: p.extensions.failed,
        }),
      ]);
      // p19-ide W3: what this start installed (design §7 `ide.extension.install`), one entry per start.
      await this.#audit(
        { actor: { type: 'worker', id: session.workerId } },
        'ide.extension.install',
        before,
        { installed: p.extensions.installed, failed: p.extensions.failed.map((f) => f.id) },
        p.extensions.failed.length === 0 ? 'success' : 'failure',
      );
    }
    const live = (LIVE_IDE_STATES as readonly string[]).includes(p.state);
    if (before.desired !== 'running' && live) {
      await this.#sendControl(
        session.workerId,
        p.workspaceId,
        before.desired === 'deleted' ? 'remove' : 'stop',
        'not wanted',
      );
    }
    if (!live && p.state !== before.state) {
      await this.deps.access.revokeWorkspace(p.workspaceId);
      this.deps.resetStreams?.(session.workerId, p.workspaceId);
      if (
        before.desired === 'running' &&
        (p.state === 'stopped' || p.state === 'failed' || p.state === 'refused')
      ) {
        // The machine stopped it on its own (idle, memory, exit, refusal): it stays stopped until someone starts it.
        await this.deps.pool.query(
          `UPDATE ide_workspaces SET desired = 'stopped' WHERE id = $1 AND desired = 'running'`,
          [p.workspaceId],
        );
      }
      const action =
        p.stopReason === 'idle'
          ? 'ide.workspace.idle_stop'
          : p.stopReason === 'memory'
            ? 'ide.workspace.memory_stop'
            : p.state === 'removed'
              ? 'ide.workspace.removed'
              : p.state === 'failed' || p.state === 'refused'
                ? 'ide.workspace.failed'
                : null;
      if (action !== null) {
        await this.#audit(
          { actor: { type: 'worker', id: session.workerId } },
          action,
          before,
          { state: p.state, detail: p.detail ?? null },
          p.state === 'failed' || p.state === 'refused' ? 'failure' : 'success',
        );
      }
    }
  }

  onGitResult(session: WorkerSession, p: IdeGitResultPayload): void {
    const pending = this.#pendingGit.get(p.requestId);
    if (pending?.workerId === session.workerId) pending.done(p);
  }

  onFileData(session: WorkerSession, p: IdeFileDataPayload): void {
    const pending = this.#pendingFile.get(p.requestId);
    if (pending?.workerId === session.workerId) pending.done(p);
  }

  /** What the bridge extension reports or asks for (terminal audit, chat reference, push). */
  async onEvent(session: WorkerSession, p: IdeEventPayload): Promise<void> {
    const r = await this.#row(p.workspaceId);
    if (r?.worker_id !== session.workerId || r.desired === 'deleted') return;
    const owner = { actor: { type: 'user' as const, id: r.user_id } };
    switch (p.kind) {
      case 'terminal.open':
        await this.#audit(owner, 'ide.terminal.open', r, { name: p.name ?? null, via: 'ide' });
        return;
      case 'reference': {
        const end = Math.max(p.startLine, p.endLine);
        const refId = `ide:${r.id}:${String(p.startLine)}-${String(end)}:${p.path}`;
        if (refId.length > 320) return;
        const name = p.path.length > 60 ? `…/${p.path.split('/').pop() ?? p.path}` : p.path;
        const lines = p.startLine === end ? String(p.startLine) : `${String(p.startLine)}-${String(end)}`;
        await this.deps.pool.query(
          `INSERT INTO ide_references (id, user_id, workspace_id, project, ref_id, label, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            r.user_id,
            r.id,
            r.project,
            refId,
            `${name}:${lines} · IDE`.slice(0, 200),
            this.deps.clock(),
          ],
        );
        return;
      }
      case 'settings': {
        const ext = this.deps.extensions;
        const res =
          ext === undefined
            ? { ok: false, message: 'Ayar eşitleme bu sunucuda kapalı.' }
            : await ext
                .saveSettings(
                  session.workerId,
                  { id: r.id, userId: r.user_id, project: r.project },
                  p.file,
                  p.content,
                )
                .catch(() => ({ ok: false, message: 'Ayarlar kaydedilemedi.' }));
        await session
          .send('IDE_NOTICE', {
            workspaceId: r.id,
            eventId: p.eventId,
            status: res.ok ? 'ok' : 'refused',
            message: res.message.slice(0, 300),
          })
          .catch(() => undefined);
        return;
      }
      case 'push': {
        const notice = async (
          status: 'ok' | 'refused' | 'failed',
          message: string,
          url?: string,
        ): Promise<void> => {
          await session
            .send('IDE_NOTICE', {
              workspaceId: r.id,
              eventId: p.eventId,
              status,
              message: message.slice(0, 300),
              ...(url === undefined ? {} : { url }),
            })
            .catch(() => undefined);
        };
        // Not awaited: the push waits for this machine's IDE_GIT_RESULT, which the gateway delivers only after this
        // handler returns (a worker's messages are handled one at a time).
        void (async () => {
          const caller = await this.#ownerCaller(r);
          if (caller === null) {
            await notice('refused', 'Bu çalışma alanında gönderme yetkiniz yok.');
            return;
          }
          try {
            const res = await this.push(caller, r.id, { message: p.message, pullRequest: p.pullRequest });
            if (res.status === 'ok') {
              await notice(
                'ok',
                res.pullRequest !== null
                  ? `Gönderildi: ${res.branch ?? ''}; birleştirme isteği #${String(res.pullRequest.number)}.`
                  : `Gönderildi: ${res.branch ?? ''}.`,
                res.pullRequest?.url,
              );
            } else {
              await notice(res.status, pushMessage(res));
            }
          } catch (err) {
            await notice('failed', err instanceof HttpError ? err.message : 'Gönderilemedi.');
          }
        })().catch((err: unknown) => {
          this.deps.log.warn({ err, workspaceId: r.id }, 'IDE bridge push failed');
        });
        return;
      }
    }
  }

  async #ownerCaller(r: Row): Promise<IdeCaller | null> {
    const { rows } = await this.deps.pool.query<{
      role: Subject['role'];
      username: string;
      disabled: boolean;
    }>('SELECT role, username, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1', [r.user_id]);
    const u = rows[0];
    if (u === undefined || u.disabled || !roleAtLeast(u.role, 'operator')) return null;
    const subject = await loadSubject(this.deps.pool, { id: r.user_id, role: u.role });
    if (!authorize(subject, 'ide.use', { project: r.project }).allow) return null;
    return { subject, username: u.username, actor: { type: 'user', id: r.user_id }, via: 'ide' };
  }

  // ============================================================================================= idle sweep

  /**
   * The master's idle rule (the worker has its own): a running workspace without an open proxied socket whose last
   * request (this master or the worker's report) is older than its idle minutes is stopped. Returns how many.
   */
  async sweep(limit = 20): Promise<number> {
    const now = this.deps.clock().getTime();
    // Self-throttled: the orchestrator ticks often; once a minute is enough for minutes of idle time.
    if (now - this.#lastSweep < 60_000) return 0;
    this.#lastSweep = now;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE i.desired = 'running' AND i.state = 'running' ORDER BY i.status_at LIMIT 200`,
    );
    let n = 0;
    for (const r of rows) {
      if (n >= limit) break;
      if ((this.deps.connections?.(r.id) ?? 0) > 0) continue;
      const spec = IdeSpec.safeParse(r.spec);
      const idleMs = (spec.success ? spec.data.idleMinutes : IDE_LIMITS.idleMinutes) * 60_000;
      const last = Math.max(
        this.#seen.get(r.id) ?? 0,
        r.last_activity_at?.getTime() ?? 0,
        r.started_at?.getTime() ?? 0,
      );
      if (now - last < idleMs) continue;
      await this.stop({ actor: { type: 'system', id: 'ide-idle' } }, r.id, 'idle').catch((err: unknown) => {
        this.deps.log.warn({ err, workspaceId: r.id }, 'IDE idle stop failed');
      });
      n++;
    }
    return n;
  }

  /** The spec hash of a workspace (tests: the worker verifies the same bytes). */
  static specHash(spec: IdeSpec): string {
    return ideSpecHash(spec);
  }
}

function extensionsReport(v: Record<string, unknown> | null): IdeExtensionsReport | null {
  if (v === null || typeof v !== 'object') return null;
  const list = (x: unknown): { id: string; reason: string }[] =>
    (Array.isArray(x) ? x : [])
      .map((e) => e as { id?: unknown; reason?: unknown })
      .filter((e) => typeof e.id === 'string')
      .map((e) => ({ id: String(e.id), reason: typeof e.reason === 'string' ? e.reason : '' }));
  return {
    skipped: list(v.skipped),
    installed: Array.isArray(v.installed)
      ? v.installed.filter((x): x is string => typeof x === 'string')
      : null,
    failed: list(v.failed),
  };
}

function notFound(): HttpError {
  return new HttpError(404, 'ide_workspace_not_found', 'IDE workspace not found.');
}

function outcome(o: {
  readonly status: 'ok' | 'refused' | 'failed';
  readonly reason: string | null;
  readonly detail: string | null;
}): IdeGitOutcome {
  return {
    ...o,
    branch: null,
    head: null,
    committed: false,
    pushed: false,
    changedFiles: null,
    ahead: null,
    pullRequest: null,
  };
}

/** The bridge's answer for a push that did not go through (Turkish UI). */
export function pushMessage(res: IdeGitOutcome): string {
  switch (res.reason) {
    case 'secret_found':
      return `Gönderilmedi: değişikliklerde gizli bilgi olabilir. ${res.detail ?? ''}`.trim();
    case 'not_fast_forward':
      return 'Gönderilmedi: uzak branch ilerlemiş; önce güncelleyin (fetch + merge).';
    case 'no_credential':
      return 'Gönderilmedi: bu depo için gönderme yetkisi yok (Ayarlar → Entegrasyonlar).';
    case 'timeout':
      return 'Gönderilmedi: makine zamanında yanıt vermedi.';
    case 'pull_request_failed':
      return 'Gönderildi, ama birleştirme isteği açılamadı.';
    default:
      return `Gönderilmedi${res.detail === null ? '.' : `: ${res.detail}`}`;
  }
}
