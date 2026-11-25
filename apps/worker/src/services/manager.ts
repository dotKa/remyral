import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_INHERITED_ENV, type OwnedProcess } from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  LIVE_SERVICE_STATES,
  type LeaseKey,
  type MasterToWorker,
  SERVICE_LIMITS,
  type ServiceControlPayload,
  type ServiceHealthState,
  type ServiceLogsPayload,
  ServiceSpec,
  type ServiceStartPayload,
  type ServiceState,
  type ServicesReport,
  type ServiceStatusPayload,
  type ServiceTunnelPayload,
  type ServiceTunnelState,
  serviceMessageFresh,
  serviceSpecHash,
  serviceSpecIssues,
  type SandboxProfile,
  verifyServiceControl,
  verifyServiceStart,
  verifyServiceTunnel,
  vaultIdOfSecretRef,
} from '@remyral/protocol';
import { checkPreviewPort, type PortCheckDeps } from '../previews/ports.js';
import type { TunnelSupervisor } from '../previews/supervisor.js';
import { PROJECT_EGRESS_SCREENS, projectProcessNetworkPolicy } from '../jobs/repo-egress.js';
import type { ResourceLimits, SandboxRunner } from '../sandbox/types.js';
import { localSecretName, parseSecretRef, SecretString } from '../secrets/ref.js';
import type { SecretStore } from '../secrets/store.js';
import type { JobSecretExposure } from '../secrets/exposure.js';
import type { PrepareRequest, Workspace } from '../workspace/manager.js';
import { ensureDirInside, isInside } from '../workspace/paths.js';
import { defaultHealthProbe, type HealthProbe, osTreeSampler, type TreeSampler } from './health.js';
import { ServiceLog } from './log.js';

/**
 * p15-services (docs/design/p15-services.md §4): the services this worker owns.
 *
 * - **Desired state** comes from the master (SERVICE_START / SERVICE_CONTROL, signed with a lease key, ≤ 5 min old)
 *   and is kept in `<dataDir>/services/<id>/record.json` (0600, the worker's data dir — every job sandbox denies it),
 *   so a restarted worker starts its services again by itself (policy `never`: reported stopped).
 * - **Process**: `sh -c <command>` (Windows: `cmd /d /s /c`) through the same sandbox profile runner, limits (capped by
 *   the worker's job limits) and egress allowlist as a job; cwd = the kept checkout (+ `cwd`). It is NOT a job: no
 *   slot in the state machine, no job timeout, not in the child registry the updater waits for. Before a restart a
 *   process the previous worker process left in the same boot is killed (no re-adoption: its egress proxy and
 *   confinement died with that process — a fresh start keeps the floor).
 * - **Health / restart / TTL**: tcp / http probes to 127.0.0.1:<port>; exits and failed probes restart per policy with
 *   backoff (≤ maxRestarts within windowSec, then `failed`); the signed `expiresAt` stops it (`expired`) even without
 *   the master.
 * - **Tunnels**: quick (`cloudflared tunnel --url`, URL captured) once the service is up and its port is served by its
 *   own process tree; named from SERVICE_TUNNEL (the connector token of that one tunnel; never on disk beyond the
 *   supervisor's 0600 token file, never logged). Both run in a supervisor of their own (`<dataDir>/services/tunnels`),
 *   separate from job previews.
 * - **Checkouts**: a job's worktree is claimed from the job runner (it keeps it after the job instead of deleting it);
 *   `checkout` sources get a worktree of their own. A checkout is released when its last service is removed.
 * - **Logs**: bounded, redacted (see log.ts); SERVICE_LOGS answers. SERVICE_STATUS on every change and every minute.
 */

export interface ServiceChannel {
  status(payload: ServiceStatusPayload): Promise<void>;
  logs(payload: ServiceLogsPayload): Promise<void>;
  workerId(): string | null;
}

/** What the manager needs from the workspace manager. */
export interface ServiceWorkspacePort {
  readonly root: string;
  prepare(req: PrepareRequest): Promise<Workspace>;
  release(ws: Workspace, outcome: { status: 'succeeded'; artifactsCollected: true }): Promise<unknown>;
}

export interface ServiceManagerDeps {
  readonly dataDir: string;
  readonly workspace: ServiceWorkspacePort | null;
  /** The profile runners (null: no sandbox → every start is refused). */
  readonly runner: (profile: SandboxProfile) => SandboxRunner | null;
  readonly limits: ResourceLimits;
  readonly egressAllow: readonly string[];
  /** Profiles the effective configuration allows on this worker. */
  readonly allowedProfiles: () => readonly SandboxProfile[];
  readonly secretStore: SecretStore;
  /**
   * Local secrets (`secret:<name>`, not `vault-*`) a service may name in `secretEnv`: the machine owner's
   * `remyral-worker secret expose` list (secrets/exposure.ts). Absent: none (default deny).
   */
  readonly jobSecretExposure?: () => Promise<JobSecretExposure>;
  readonly keys: () => readonly LeaseKey[];
  readonly channel: ServiceChannel;
  /** The tunnel supervisor of services (null: no cloudflared support → tunnels refused). */
  readonly tunnels: TunnelSupervisor | null;
  /**
   * The job runner hands over the live worktree of a job attempt on this machine (and keeps it after the job for the
   * service), or null (not running here / not a repository job / container profile).
   */
  readonly claimJobWorkspace: (jobId: string, attemptId: string, serviceId: string) => Workspace | null;
  /** The service no longer needs a job's worktree that the job still owns. */
  readonly releaseJobClaim: (jobId: string, attemptId: string, serviceId: string) => void;
  readonly logger: Logger;
  readonly extraEnv?: () => Promise<Readonly<Record<string, string>>>;
  readonly clock?: () => Date;
  readonly probe?: HealthProbe;
  readonly sampler?: TreeSampler;
  readonly ports?: PortCheckDeps;
  readonly maxServices?: number;
  /** Delay before restart n (ms); the last one repeats. */
  readonly backoffMs?: readonly number[];
  readonly statusIntervalMs?: number;
  readonly stopGraceMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Tests: the boot identity (default: boot time rounded to 10 s). */
  readonly bootId?: () => string;
  /** Tests: whether a pid is alive / kill a process group. */
  readonly killStale?: (pid: number) => Promise<void>;
}

/** A checkout the worker keeps for services. */
interface CheckoutRecord {
  readonly key: string;
  readonly ws: Workspace;
  /** `job`: claimed from a job attempt (the job runner owns it until the job ends); `own`: made for a service. */
  readonly origin: 'job' | 'own';
  /** The job ended and handed it over (release is ours). */
  handedOver: boolean;
}

interface ServiceRecord {
  v: 1;
  spec: ServiceSpec;
  revision: number;
  desired: 'running' | 'stopped';
  checkout: string | null;
  lastState: ServiceState;
  lastDetail: string | null;
  pid: number | null;
  bootId: string | null;
}

interface Live {
  rec: ServiceRecord;
  log: ServiceLog;
  proc: OwnedProcess | null;
  state: ServiceState;
  health: ServiceHealthState;
  detail: string | undefined;
  since: Date;
  startedAt: Date | null;
  exitCode: number | undefined;
  restarts: number[];
  totalRestarts: number;
  failures: number;
  stopping: boolean;
  healthTimer: NodeJS.Timeout | null;
  ttlTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  tunnel: { state: ServiceTunnelState; url?: string; detail?: string; tunnelId?: string };
  metrics: { cpuPercent?: number; memoryBytes?: number };
  /** Serialises start / stop of one service. */
  queue: Promise<void>;
  /** A start is underway (spawning). */
  generation: number;
  /**
   * p22-worker-limits: the first host the project's network policy refused during the current run (egress proxy 403,
   * `not-allowlisted`) — reset at every spawn. A failed exit after it is final: a restart would be refused the same way.
   */
  refused: { generation: number; target: string } | null;
}

const MAX_TIMER_MS = 24 * 3600_000;

/**
 * p22-worker-limits: the reason (SERVICE_STATUS `detail`, ≤ 300) of a service that failed on a refused host — the
 * host, that it is final, and where the owner allows it (the full screen names and the 403 body are in its log).
 */
export function policyRefusalDetail(target: string, why: string): string {
  const host = target.endsWith(':443') ? target.slice(0, -4) : target;
  const tail = `; not restarted. Allow it in Projeler → Politika → Ağ erişimi (or the Workspace tab of a workspace project); the service starts again after the change`;
  return `network policy refused ${host.slice(0, 120)} (egress proxy 403)${tail} — ${why}`.slice(0, 300);
}
const SVC_SEGMENT = (id: string): string => `svc-${id}`;

/** Quote one argument for `sh -c` / cmd. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv a service's command line runs as: `cmd.exe /d /s /c <line>` on Windows (the job runner passes `<line>`
 * verbatim in quotes, see `windowsCommandLine`), `/bin/sh -c <line>` elsewhere. `dir` (already checked to be inside
 * the checkout) becomes a `cd` in front of the line.
 */
export function serviceCommand(
  platform: NodeJS.Platform,
  line: string,
  dir: string | null,
  comSpec: string | undefined = process.env.ComSpec,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const prefix = dir === null ? '' : `cd /d "${dir.replace(/"/g, '')}" && `;
    return { command: comSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `${prefix}${line}`] };
  }
  const prefix = dir === null ? '' : `cd ${shQuote(dir)} && `;
  return { command: '/bin/sh', args: ['-c', `${prefix}${line}`] };
}

export class ServiceManager {
  readonly #d: ServiceManagerDeps;
  readonly #log: Logger;
  readonly #live = new Map<string, Live>();
  readonly #checkouts = new Map<string, CheckoutRecord>();
  #statusTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(d: ServiceManagerDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'services' });
  }

  get #root(): string {
    return join(this.#d.dataDir, 'services');
  }

  #now(): Date {
    return this.#d.clock?.() ?? new Date();
  }

  #bootId(): string {
    return this.#d.bootId?.() ?? String(Math.round((Date.now() / 1000 - uptime()) / 10) * 10);
  }

  #dir(id: string): string {
    return join(this.#root, id);
  }

  // ============================================================================================= persistence

  async #saveRecord(rec: ServiceRecord): Promise<void> {
    const dir = this.#dir(rec.spec.serviceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `record.json.tmp-${randomUUID().slice(0, 8)}`);
    await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
    await rename(tmp, join(dir, 'record.json'));
  }

  async #saveCheckout(c: CheckoutRecord): Promise<void> {
    const dir = join(this.#root, 'checkouts');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${c.key}.json`), JSON.stringify(c), { mode: 0o600 });
  }

  /**
   * Worker start: reads the kept records, kills processes the previous worker process left (same boot), and starts
   * the services that should run (policy `never`: reported stopped).
   */
  async load(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(join(this.#root, 'checkouts')).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await readFile(join(this.#root, 'checkouts', name), 'utf8')) as CheckoutRecord;
        // A job that held the checkout is gone with the previous process: the checkout is ours now.
        this.#checkouts.set(c.key, { ...c, handedOver: true });
      } catch {
        // unreadable: ignored
      }
    }
    for (const name of await readdir(this.#root).catch(() => [] as string[])) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      let rec: ServiceRecord;
      try {
        rec = JSON.parse(await readFile(join(this.#root, name, 'record.json'), 'utf8')) as ServiceRecord;
        rec.spec = ServiceSpec.parse(rec.spec);
      } catch {
        continue;
      }
      if (rec.pid !== null && rec.bootId === this.#bootId()) {
        await (this.#d.killStale ?? killStaleTree)(rec.pid).catch(() => undefined);
      }
      rec.pid = null;
      const live = this.#newLive(rec);
      this.#live.set(rec.spec.serviceId, live);
      if (rec.desired !== 'running') continue;
      if (rec.spec.expiresAt !== null && Date.parse(rec.spec.expiresAt) <= this.#now().getTime()) {
        rec.desired = 'stopped';
        this.#setState(live, 'expired', 'the lifetime ended while the worker was down');
        continue;
      }
      if (rec.spec.restart.policy === 'never') {
        rec.desired = 'stopped';
        this.#setState(live, 'stopped', 'the worker restarted (restart policy: never)');
        continue;
      }
      live.log.line('system', 'worker restarted: starting the service again');
      void this.#enqueue(live, () => this.#spawn(live));
    }
    this.#statusTimer = setInterval(() => {
      void this.#tick();
    }, this.#d.statusIntervalMs ?? 60_000);
    this.#statusTimer.unref();
  }

  #newLive(rec: ServiceRecord): Live {
    const log = new ServiceLog(this.#dir(rec.spec.serviceId), { now: () => this.#now() });
    return {
      rec,
      log,
      proc: null,
      state: rec.lastState,
      health: 'unknown',
      detail: rec.lastDetail ?? undefined,
      since: this.#now(),
      startedAt: null,
      exitCode: undefined,
      restarts: [],
      totalRestarts: 0,
      failures: 0,
      stopping: false,
      healthTimer: null,
      ttlTimer: null,
      restartTimer: null,
      tunnel: { state: rec.spec.tunnel === 'none' ? 'none' : 'stopped' },
      metrics: {},
      queue: Promise.resolve(),
      generation: 0,
      refused: null,
    };
  }

  #enqueue(live: Live, fn: () => Promise<void>): Promise<void> {
    const next = live.queue.then(fn, fn).catch((err: unknown) => {
      this.#log.warn('service operation failed', { serviceId: live.rec.spec.serviceId, err });
    });
    live.queue = next;
    return next;
  }

  // ============================================================================================= reports

  report(): ServicesReport {
    return {
      max: this.#d.maxServices ?? SERVICE_LIMITS.perWorker,
      services: [...this.#live.values()].slice(0, 64).map((l) => ({
        serviceId: l.rec.spec.serviceId,
        revision: l.rec.revision,
        state: l.state,
        since: l.since.toISOString(),
        network: l.rec.spec.network !== undefined,
      })),
    };
  }

  /** Local view (job tools wait on it; tests). */
  view(serviceId: string): { state: ServiceState; health: ServiceHealthState; url: string | null } | null {
    const l = this.#live.get(serviceId);
    return l === undefined ? null : { state: l.state, health: l.health, url: l.tunnel.url ?? null };
  }

  #status(l: Live): ServiceStatusPayload {
    return {
      serviceId: l.rec.spec.serviceId,
      revision: l.rec.revision,
      state: l.state,
      health: l.health,
      ...(l.detail === undefined ? {} : { detail: l.detail.slice(0, 300) }),
      ...(l.proc === null ? {} : { pid: l.proc.pid }),
      ...(l.startedAt === null ? {} : { startedAt: l.startedAt.toISOString() }),
      restarts: Math.min(l.totalRestarts, 100_000),
      ...(l.exitCode === undefined ? {} : { exitCode: l.exitCode }),
      ...(l.rec.spec.tunnel === 'none'
        ? {}
        : {
            tunnel: {
              state: l.tunnel.state,
              ...(l.tunnel.url === undefined ? {} : { url: l.tunnel.url }),
              ...(l.tunnel.detail === undefined ? {} : { detail: l.tunnel.detail.slice(0, 300) }),
            },
          }),
      ...l.metrics,
      at: this.#now().toISOString(),
    };
  }

  #send(l: Live): void {
    void this.#d.channel.status(this.#status(l)).catch(() => undefined);
  }

  #setState(l: Live, state: ServiceState, detail?: string): void {
    const changed = l.state !== state || l.detail !== detail;
    l.state = state;
    l.detail = detail;
    if (changed) {
      l.since = this.#now();
      l.rec.lastState = state;
      l.rec.lastDetail = detail ?? null;
      void this.#saveRecord(l.rec).catch(() => undefined);
      if (detail !== undefined) l.log.line('system', `${state}: ${detail}`);
      else l.log.line('system', state);
    }
    this.#send(l);
  }

  /** Every minute: figures of live services, a status heartbeat. */
  async #tick(): Promise<void> {
    for (const l of this.#live.values()) {
      if (l.proc !== null) {
        const s = await (this.#d.sampler ?? osTreeSampler(this.#d.platform))(l.proc.pid).catch(() => ({}));
        l.metrics = s;
      }
      if ((LIVE_SERVICE_STATES as readonly string[]).includes(l.state)) this.#send(l);
    }
  }

  // ============================================================================================= messages

  /** SERVICE_START / SERVICE_CONTROL / SERVICE_TUNNEL / SERVICE_LOGS_REQUEST; false for anything else. */
  async onMessage(message: MasterToWorker): Promise<boolean> {
    switch (message.type) {
      case 'SERVICE_START':
        await this.onStart(message.payload);
        return true;
      case 'SERVICE_CONTROL':
        await this.onControl(message.payload);
        return true;
      case 'SERVICE_TUNNEL':
        await this.onTunnel(message.payload);
        return true;
      case 'SERVICE_LOGS_REQUEST': {
        const p = message.payload;
        const l = this.#live.get(p.serviceId);
        const tail = l === undefined ? { lines: [], truncated: false } : await l.log.tail(p.lines);
        await this.#d.channel
          .logs({
            requestId: p.requestId,
            serviceId: p.serviceId,
            status: l === undefined ? 'not_found' : 'ok',
            lines: tail.lines,
            truncated: tail.truncated,
          })
          .catch(() => undefined);
        return true;
      }
      default:
        return false;
    }
  }

  #refuse(serviceId: string, revision: number, detail: string): void {
    this.#log.warn('service refused', { serviceId, detail });
    const l = this.#live.get(serviceId);
    if (l !== undefined && (LIVE_SERVICE_STATES as readonly string[]).includes(l.state)) {
      // A running service is never stopped by a bad update; the master hears why.
      void this.#d.channel
        .status({ ...this.#status(l), detail: `update refused: ${detail}`.slice(0, 300) })
        .catch(() => undefined);
      return;
    }
    void this.#d.channel
      .status({
        serviceId,
        revision,
        state: 'refused',
        health: 'unknown',
        detail: detail.slice(0, 300),
        restarts: 0,
        at: this.#now().toISOString(),
      })
      .catch(() => undefined);
  }

  async onStart(p: ServiceStartPayload): Promise<void> {
    const workerId = this.#d.channel.workerId();
    const id = p.spec.serviceId;
    if (this.#stopped || workerId === null) return;
    const parsed = ServiceSpec.safeParse(p.spec);
    if (!parsed.success) {
      this.#refuse(id, p.revision, 'the service spec is invalid');
      return;
    }
    const spec = parsed.data;
    const verdict = verifyServiceStart(
      { workerId, revision: p.revision, issuedAt: p.issuedAt, spec },
      p.signature,
      [...this.#d.keys()],
    );
    if (verdict !== 'ok') {
      this.#refuse(id, p.revision, `the start is not signed by the master (${verdict})`);
      return;
    }
    if (!serviceMessageFresh(p.issuedAt, this.#now())) {
      this.#refuse(id, p.revision, 'the start is too old');
      return;
    }
    const issues = serviceSpecIssues(spec);
    if (issues.length > 0) {
      this.#refuse(id, p.revision, issues.join('; '));
      return;
    }
    if (!this.#d.allowedProfiles().includes(spec.sandboxProfile)) {
      this.#refuse(id, p.revision, `the ${spec.sandboxProfile} profile is not allowed on this machine`);
      return;
    }
    const existing = this.#live.get(id);
    if (existing !== undefined && existing.rec.revision > p.revision) return; // stale re-send
    if (existing !== undefined && existing.rec.revision === p.revision) {
      // Re-send after a reconnect: start again only if it is meant to run and is not alive.
      if (
        existing.rec.desired === 'running' &&
        !(LIVE_SERVICE_STATES as readonly string[]).includes(existing.state)
      ) {
        return this.#enqueue(existing, () => this.#spawn(existing));
      }
      this.#send(existing);
      return;
    }
    if (existing !== undefined) {
      const sameRun =
        serviceSpecHash({ ...existing.rec.spec, expiresAt: null }) ===
        serviceSpecHash({ ...spec, expiresAt: null });
      existing.rec.spec = spec;
      existing.rec.revision = p.revision;
      existing.rec.desired = 'running';
      await this.#saveRecord(existing.rec);
      if (sameRun && existing.proc !== null) {
        // Only the lifetime changed (extend): no restart.
        this.#armTtl(existing);
        existing.log.line('system', `lifetime: ${spec.expiresAt ?? 'until stopped'}`);
        this.#send(existing);
        return;
      }
      return this.#enqueue(existing, async () => {
        await this.#kill(existing, 'restarting with a new configuration');
        await this.#spawn(existing);
      });
    }
    const max = this.#d.maxServices ?? SERVICE_LIMITS.perWorker;
    const running = [...this.#live.values()].filter((l) =>
      (LIVE_SERVICE_STATES as readonly string[]).includes(l.state),
    ).length;
    if (running >= max) {
      this.#refuse(id, p.revision, `at most ${String(max)} services run on this machine`);
      return;
    }
    // The working directory.
    let checkout: CheckoutRecord;
    try {
      checkout = await this.#checkoutFor(spec, p);
    } catch (err) {
      this.#refuse(id, p.revision, err instanceof Error ? err.message : 'no checkout');
      return;
    }
    const rec: ServiceRecord = {
      v: 1,
      spec,
      revision: p.revision,
      desired: 'running',
      checkout: checkout.key,
      lastState: 'starting',
      lastDetail: null,
      pid: null,
      bootId: null,
    };
    await this.#saveRecord(rec);
    const live = this.#newLive(rec);
    this.#live.set(id, live);
    return this.#enqueue(live, () => this.#spawn(live));
  }

  async #checkoutFor(spec: ServiceSpec, p: ServiceStartPayload): Promise<CheckoutRecord> {
    const src = spec.source;
    if (src.kind === 'job') {
      const key = `job-${src.jobId}-${src.attemptId}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      const kept = this.#checkouts.get(key);
      if (kept !== undefined) return kept;
      const ws = this.#d.claimJobWorkspace(src.jobId, src.attemptId, spec.serviceId);
      if (ws === null) {
        throw new Error(
          'the job’s worktree is not on this machine any more (the job ended before the service started)',
        );
      }
      if (ws.projectId !== spec.projectId) {
        this.#d.releaseJobClaim(src.jobId, src.attemptId, spec.serviceId);
        throw new Error('the job belongs to another project');
      }
      const c: CheckoutRecord = { key, ws, origin: 'job', handedOver: false };
      this.#checkouts.set(key, c);
      await this.#saveCheckout(c);
      return c;
    }
    const key = `own-${spec.serviceId}`;
    const kept = this.#checkouts.get(key);
    if (kept !== undefined) return kept;
    const workspace = this.#d.workspace;
    if (workspace === null) throw new Error('this machine has no usable workspace root');
    const ws = await workspace.prepare({
      projectId: spec.projectId,
      jobId: SVC_SEGMENT(spec.serviceId),
      attemptId: 'checkout',
      epoch: 0,
      repository: { url: src.repositoryUrl, baseRef: src.baseRef },
      ...(p.gitToken === undefined
        ? {}
        : {
            gitToken: new SecretString(p.gitToken),
            ...(p.gitTokenUsername === undefined ? {} : { gitTokenUsername: p.gitTokenUsername }),
          }),
    });
    const c: CheckoutRecord = { key, ws, origin: 'own', handedOver: true };
    this.#checkouts.set(key, c);
    await this.#saveCheckout(c);
    return c;
  }

  /** The job runner: a job whose worktree services use ended; the checkout is the services' now. */
  adoptJobCheckout(jobId: string, attemptId: string): boolean {
    const key = `job-${jobId}-${attemptId}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    const c = this.#checkouts.get(key);
    if (c === undefined) return false;
    c.handedOver = true;
    void this.#saveCheckout(c).catch(() => undefined);
    // Nobody uses it any more (all its services were removed while the job ran): release now.
    if (!this.#checkoutUsed(key)) void this.#releaseCheckout(key);
    return true;
  }

  #checkoutUsed(key: string): boolean {
    return [...this.#live.values()].some((l) => l.rec.checkout === key);
  }

  async #releaseCheckout(key: string): Promise<void> {
    const c = this.#checkouts.get(key);
    if (c === undefined || this.#checkoutUsed(key)) return;
    if (!c.handedOver) {
      // The job still runs and owns it (our claims were dropped with each service): forget it.
      this.#checkouts.delete(key);
      await rm(join(this.#root, 'checkouts', `${key}.json`), { force: true }).catch(() => undefined);
      return;
    }
    this.#checkouts.delete(key);
    await this.#d.workspace
      ?.release(c.ws, { status: 'succeeded', artifactsCollected: true })
      .catch((err: unknown) => {
        this.#log.warn('service checkout release failed', { key, err });
      });
    await rm(join(this.#root, 'checkouts', `${key}.json`), { force: true }).catch(() => undefined);
  }

  async onControl(p: ServiceControlPayload): Promise<void> {
    const workerId = this.#d.channel.workerId();
    if (workerId === null) return;
    const verdict = verifyServiceControl(
      { workerId, serviceId: p.serviceId, op: p.op, issuedAt: p.issuedAt },
      p.signature,
      [...this.#d.keys()],
    );
    if (verdict !== 'ok' || !serviceMessageFresh(p.issuedAt, this.#now())) {
      this.#log.warn('SERVICE_CONTROL refused', { serviceId: p.serviceId, verdict });
      return;
    }
    const l = this.#live.get(p.serviceId);
    if (l === undefined) {
      if (p.op !== 'remove') {
        void this.#d.channel
          .status({
            serviceId: p.serviceId,
            revision: 0,
            state: 'stopped',
            health: 'unknown',
            detail: 'not on this machine',
            restarts: 0,
            at: this.#now().toISOString(),
          })
          .catch(() => undefined);
      }
      return;
    }
    switch (p.op) {
      case 'stop':
        l.rec.desired = 'stopped';
        await this.#saveRecord(l.rec);
        return this.#enqueue(l, async () => {
          await this.#kill(l, p.reason);
          this.#setState(l, 'stopped', p.reason);
        });
      case 'restart':
        l.rec.desired = 'running';
        await this.#saveRecord(l.rec);
        l.restarts = [];
        return this.#enqueue(l, async () => {
          await this.#kill(l, p.reason);
          await this.#spawn(l);
        });
      case 'remove':
        return this.#enqueue(l, async () => {
          l.rec.desired = 'stopped';
          await this.#kill(l, p.reason);
          this.#setState(l, 'stopped', p.reason);
          this.#live.delete(p.serviceId);
          await l.log.remove();
          await rm(this.#dir(p.serviceId), { recursive: true, force: true }).catch(() => undefined);
          const ws = this.#d.workspace;
          if (ws !== null) {
            await rm(join(ws.root, 'sandboxes', SVC_SEGMENT(p.serviceId)), {
              recursive: true,
              force: true,
            }).catch(() => undefined);
          }
          const key = l.rec.checkout;
          if (key !== null) {
            const c = this.#checkouts.get(key);
            if (c !== undefined && !c.handedOver)
              this.#d.releaseJobClaim(c.ws.jobId, c.ws.attemptId, p.serviceId);
            await this.#releaseCheckout(key);
          }
        });
    }
  }

  async onTunnel(p: ServiceTunnelPayload): Promise<void> {
    const workerId = this.#d.channel.workerId();
    const l = this.#live.get(p.serviceId);
    if (workerId === null || l === undefined) return;
    const verdict = verifyServiceTunnel(
      {
        workerId,
        serviceId: p.serviceId,
        tunnelId: p.tunnelId,
        hostname: p.hostname,
        port: p.port,
        expiresAt: p.expiresAt,
        issuedAt: p.issuedAt,
        connectorToken: p.connectorToken,
      },
      p.signature,
      [...this.#d.keys()],
    );
    if (verdict !== 'ok' || !serviceMessageFresh(p.issuedAt, this.#now())) {
      l.tunnel = { state: 'refused', detail: `the tunnel is not signed by the master (${verdict})` };
      this.#send(l);
      return;
    }
    if (l.rec.spec.tunnel !== 'named' || l.rec.spec.port !== p.port) {
      l.tunnel = { state: 'refused', detail: 'this service has no named tunnel on that port' };
      this.#send(l);
      return;
    }
    l.tunnel = { state: 'starting', tunnelId: p.tunnelId, url: `https://${p.hostname.toLowerCase()}` };
    this.#named.set(p.serviceId, {
      tunnelId: p.tunnelId,
      hostname: p.hostname,
      expiresAt: new Date(p.expiresAt),
      connectorToken: p.connectorToken,
    });
    await this.#startTunnel(l);
  }

  /** Named tunnel connectors (token kept in memory only; the supervisor writes its 0600 file). */
  readonly #named = new Map<
    string,
    { tunnelId: string; hostname: string; expiresAt: Date; connectorToken: string }
  >();

  // ============================================================================================= tunnels

  /** Starts the tunnel of a service whose process is up and whose port its own tree serves. */
  async #startTunnel(l: Live): Promise<void> {
    const spec = l.rec.spec;
    const sup = this.#d.tunnels;
    if (spec.tunnel === 'none' || spec.port === null) return;
    if (sup === null) {
      l.tunnel = {
        state: 'refused',
        detail: 'cloudflared is not available on this machine (Machines → Tools)',
      };
      this.#send(l);
      return;
    }
    if (l.proc === null || (l.state !== 'running' && l.state !== 'unhealthy')) return;
    const named = spec.tunnel === 'named' ? this.#named.get(spec.serviceId) : undefined;
    if (spec.tunnel === 'named' && named === undefined) return; // waits for SERVICE_TUNNEL
    const verdict = await checkPreviewPort(this.#d.ports ?? {}, spec.port, 'owned', new Set([l.proc.pid]));
    if (!verdict.ok) {
      l.tunnel = { ...l.tunnel, state: 'refused', detail: verdict.detail };
      this.#send(l);
      return;
    }
    const tunnelId = named?.tunnelId ?? spec.serviceId;
    const expiresAt =
      named?.expiresAt ??
      (spec.expiresAt === null
        ? new Date(this.#now().getTime() + 30 * 86_400_000)
        : new Date(spec.expiresAt));
    const res = await sup.start({
      tunnelId,
      jobId: `service:${spec.serviceId}`,
      attemptId: 'service',
      port: spec.port,
      hostname: named?.hostname ?? '',
      expiresAt,
      connectorToken: named?.connectorToken ?? '',
      quick: named === undefined,
    });
    if (res !== 'refused' && l.tunnel.state !== 'running') {
      l.tunnel = { ...l.tunnel, state: 'starting', tunnelId };
      this.#send(l);
    }
  }

  /** Supervisor callbacks (wired by the factory). */
  onConnectorState(tunnelId: string, state: string, detail: string | undefined): void {
    const l = this.#byTunnel(tunnelId);
    if (l === undefined) return;
    const map: Record<string, ServiceTunnelState> = {
      starting: 'starting',
      running: 'running',
      stopped: 'stopped',
      failed: 'failed',
      refused: 'refused',
    };
    const next = map[state] ?? 'failed';
    l.tunnel = {
      ...l.tunnel,
      state: next,
      ...(detail === undefined ? {} : { detail }),
    };
    // A quick tunnel's random name dies with its connector.
    if (next === 'stopped' && l.rec.spec.tunnel === 'quick') delete l.tunnel.url;
    if (next === 'running') delete l.tunnel.detail;
    this.#send(l);
  }

  onConnectorUrl(tunnelId: string, url: string): void {
    const l = this.#byTunnel(tunnelId);
    if (l === undefined || l.rec.spec.tunnel !== 'quick') return;
    l.tunnel = { ...l.tunnel, url };
    l.log.line('system', `quick tunnel: ${url}`);
    this.#send(l);
  }

  #byTunnel(tunnelId: string): Live | undefined {
    const direct = this.#live.get(tunnelId);
    if (direct !== undefined) return direct;
    for (const l of this.#live.values()) if (l.tunnel.tunnelId === tunnelId) return l;
    return undefined;
  }

  async #stopTunnel(l: Live, reason: string): Promise<void> {
    const sup = this.#d.tunnels;
    if (sup === null) return;
    await sup.stopJob(`service:${l.rec.spec.serviceId}`, reason).catch(() => undefined);
    if (l.rec.spec.tunnel !== 'none') {
      l.tunnel = {
        state: 'stopped',
        ...(l.rec.spec.tunnel === 'named' && l.tunnel.url !== undefined ? { url: l.tunnel.url } : {}),
      };
    }
  }

  // ============================================================================================= process

  async #env(l: Live): Promise<{ env: Record<string, string>; secrets: Record<string, SecretString> }> {
    const spec = l.rec.spec;
    const env: Record<string, string> = {};
    for (const name of DEFAULT_INHERITED_ENV) {
      const v = process.env[name];
      if (v !== undefined && name !== 'HOME' && name !== 'USERPROFILE') env[name] = v;
    }
    Object.assign(env, (await this.#d.extraEnv?.().catch(() => ({}))) ?? {});
    if (spec.port !== null) {
      env.PORT = String(spec.port);
      env.HOST = '127.0.0.1';
    }
    Object.assign(env, spec.env);
    const secrets: Record<string, SecretString> = {};
    const workerId = this.#d.channel.workerId();
    const exposure = Object.values(spec.secretEnv).some((r) => vaultIdOfSecretRef(r) === null)
      ? await (this.#d.jobSecretExposure?.() ?? Promise.resolve(null)).catch(() => null)
      : null;
    for (const [name, raw] of Object.entries(spec.secretEnv)) {
      const local = localSecretName(parseSecretRef(raw), workerId, raw);
      if (vaultIdOfSecretRef(raw) === null && exposure?.allows(local, spec.projectId) !== true) {
        throw new Error(
          `${name}: this machine does not expose that local secret to the project's jobs (remyral-worker secret expose)`,
        );
      }
      const value = await this.#d.secretStore.get(local);
      if (value === null) throw new Error(`the secret ${raw} is not on this machine`);
      secrets[name] = value;
    }
    return { env, secrets };
  }

  async #cwdCommand(l: Live, checkoutPath: string): Promise<{ command: string; args: string[] }> {
    const spec = l.rec.spec;
    let dir: string | null = null;
    if (spec.cwd !== null) {
      dir = await realpath(join(checkoutPath, spec.cwd)).catch(() => null);
      if (dir === null || !isInside(checkoutPath, dir)) {
        throw new Error(`the directory ${spec.cwd} does not exist in the checkout`);
      }
    }
    return serviceCommand(this.#d.platform ?? process.platform, spec.command, dir);
  }

  #limits(spec: ServiceSpec): ResourceLimits {
    const base = this.#d.limits;
    return {
      ...base,
      memoryBytes: Math.min(base.memoryBytes, (spec.limits.memoryMb ?? Infinity) * 1024 * 1024),
      cpus: Math.min(base.cpus, spec.limits.cpus ?? Infinity),
      pids: Math.min(base.pids, spec.limits.pids ?? Infinity),
    };
  }

  async #spawn(l: Live): Promise<void> {
    if (this.#stopped || l.rec.desired !== 'running') return;
    const spec = l.rec.spec;
    const gen = ++l.generation;
    l.stopping = false;
    l.exitCode = undefined;
    const c = l.rec.checkout === null ? undefined : this.#checkouts.get(l.rec.checkout);
    const workspace = this.#d.workspace;
    const runner = this.#d.runner(spec.sandboxProfile);
    if (c === undefined || workspace === null) {
      l.rec.desired = 'stopped';
      this.#setState(l, 'failed', 'the checkout of this service is gone');
      return;
    }
    if (runner === null) {
      this.#setState(l, 'failed', `the ${spec.sandboxProfile} sandbox is not available on this machine`);
      return;
    }
    this.#setState(l, 'starting');
    let proc: OwnedProcess;
    try {
      const { env, secrets } = await this.#env(l);
      l.log.setSecrets(Object.values(secrets).map((v) => v.reveal()));
      const { command, args } = await this.#cwdCommand(l, c.ws.path);
      const sandboxDir = await ensureDirInside(workspace.root, [
        'sandboxes',
        SVC_SEGMENT(spec.serviceId),
        'run',
      ]);
      proc = await runner.launch({
        jobId: SVC_SEGMENT(spec.serviceId),
        attemptId: 'run',
        workspacePath: c.ws.path,
        sandboxDir,
        // p21-service-egress: the project's network access policy (as for its repository jobs); absent → model APIs.
        network: projectProcessNetworkPolicy(spec.network ?? null, this.#d.egressAllow),
        // p22-worker-limits: remember the first policy refusal of this run (a package install's 403).
        onEgressDecision: (d) => {
          if (!d.allowed && d.reason === 'not-allowlisted' && l.refused?.generation !== gen) {
            l.refused = { generation: gen, target: d.target };
            l.log.line('system', `network policy refused ${d.target} (egress proxy 403)`);
          }
        },
        limits: this.#limits(spec),
        listen: true,
        jobAccount: false,
        command,
        args,
        env,
        secretEnv: secrets,
        stdin: 'ignore',
        maxBufferBytes: 16 * 1024,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'the service could not be started';
      l.log.line('system', `start failed: ${msg}`);
      return this.#afterExit(l, gen, null, msg.slice(0, 300));
    }
    // The service may have been stopped while it was being started (state changes across the awaits above).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (gen !== l.generation || l.stopping) {
      await proc.terminate({ graceMs: 1000 }).catch(() => undefined);
      await proc.dispose().catch(() => undefined);
      return;
    }
    l.proc = proc;
    l.startedAt = this.#now();
    l.failures = 0;
    l.health = spec.health.kind === 'none' ? 'none' : 'unknown';
    l.rec.pid = proc.pid;
    l.rec.bootId = this.#bootId();
    await this.#saveRecord(l.rec).catch(() => undefined);
    proc.stdout.on('data', (b: Buffer) => {
      l.log.chunk('stdout', b);
    });
    proc.stderr.on('data', (b: Buffer) => {
      l.log.chunk('stderr', b);
    });
    void proc.exited.then((exit) => {
      l.log.flush();
      void proc.dispose().catch(() => undefined);
      if (l.proc === proc) l.proc = null;
      void this.#enqueue(l, () =>
        this.#afterExit(
          l,
          gen,
          exit.code,
          exit.signal === null ? `exited with code ${String(exit.code)}` : `ended by ${exit.signal}`,
        ),
      );
    });
    this.#armTtl(l);
    if (spec.health.kind === 'none') {
      this.#setState(l, 'running');
      void this.#startTunnel(l);
    } else {
      this.#armHealth(l, gen);
    }
  }

  #armHealth(l: Live, gen: number): void {
    const h = l.rec.spec.health;
    if (h.kind === 'none') return;
    if (l.healthTimer !== null) clearTimeout(l.healthTimer);
    const run = async (): Promise<void> => {
      l.healthTimer = null;
      if (gen !== l.generation || l.proc === null || l.stopping) return;
      const r = await (this.#d.probe ?? defaultHealthProbe)(h, l.rec.spec.port).catch(() => ({
        ok: false,
        detail: 'probe failed',
      }));
      // Stopped / restarted while the probe ran (state changes across the await).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (gen !== l.generation || l.proc === null || l.stopping) return;
      const inGrace =
        l.startedAt !== null && this.#now().getTime() - l.startedAt.getTime() < h.startPeriodSec * 1000;
      if (r.ok) {
        l.failures = 0;
        const first = l.health !== 'healthy';
        l.health = 'healthy';
        if (l.state !== 'running' || first) {
          this.#setState(l, 'running');
          void this.#startTunnel(l);
        }
      } else if (!inGrace || l.health === 'healthy') {
        l.failures++;
        if (l.failures >= h.failures) {
          l.health = 'unhealthy';
          if (l.state !== 'unhealthy') this.#setState(l, 'unhealthy', r.detail);
          if (l.rec.spec.restart.policy !== 'never') {
            void this.#enqueue(l, async () => {
              if (gen !== l.generation) return;
              l.log.line('system', `restarting: unhealthy (${r.detail})`);
              const child = l.proc;
              l.stopping = true;
              if (child !== null)
                await child.terminate({ graceMs: this.#d.stopGraceMs ?? 5000 }).catch(() => undefined);
              await this.#afterExit(l, gen, null, `unhealthy: ${r.detail}`, true);
            });
            return;
          }
        }
      }
      l.healthTimer = setTimeout(() => void run(), h.intervalSec * 1000);
      l.healthTimer.unref();
    };
    l.healthTimer = setTimeout(() => void run(), Math.min(1000, h.intervalSec * 1000));
    l.healthTimer.unref();
  }

  #armTtl(l: Live): void {
    if (l.ttlTimer !== null) clearTimeout(l.ttlTimer);
    l.ttlTimer = null;
    const exp = l.rec.spec.expiresAt;
    if (exp === null) return;
    const left = Date.parse(exp) - this.#now().getTime();
    if (left <= 0) {
      void this.#enqueue(l, () => this.#expire(l));
      return;
    }
    l.ttlTimer = setTimeout(
      () => {
        this.#armTtl(l);
      },
      Math.min(left, MAX_TIMER_MS),
    );
    l.ttlTimer.unref();
  }

  async #expire(l: Live): Promise<void> {
    l.rec.desired = 'stopped';
    await this.#saveRecord(l.rec).catch(() => undefined);
    await this.#kill(l, 'expired');
    this.#setState(l, 'expired', 'the lifetime ended');
  }

  /** After an exit (or a failed start / an unhealthy kill): restart per policy or settle. */
  async #afterExit(l: Live, gen: number, code: number | null, why: string, unhealthy = false): Promise<void> {
    if (gen !== l.generation) return;
    if (l.healthTimer !== null) clearTimeout(l.healthTimer);
    l.healthTimer = null;
    l.proc = null;
    l.rec.pid = null;
    if (code !== null) l.exitCode = code;
    const wasStopping = l.stopping && !unhealthy;
    if (wasStopping || l.rec.desired !== 'running' || this.#stopped) return;
    await this.#stopTunnel(l, 'the service exited');
    const policy = l.rec.spec.restart;
    const failed = unhealthy || code !== 0;
    // p22-worker-limits: a run that failed after the project's network policy refused a host (a package install's 403)
    // and never became healthy fails at once — restarting cannot help until the policy allows the host. A policy
    // change re-sends the service (master), which starts it again.
    const refused = l.refused?.generation === gen ? l.refused.target : null;
    if (failed && !unhealthy && refused !== null && l.health !== 'healthy') {
      l.rec.desired = 'stopped';
      await this.#saveRecord(l.rec).catch(() => undefined);
      l.log.line('system', `allow it in ${PROJECT_EGRESS_SCREENS}`);
      this.#setState(l, 'failed', policyRefusalDetail(refused, why));
      return;
    }
    const restart = policy.policy === 'always' || (policy.policy === 'on-failure' && failed);
    if (!restart) {
      l.rec.desired = 'stopped';
      await this.#saveRecord(l.rec).catch(() => undefined);
      this.#setState(l, failed ? 'failed' : 'stopped', why);
      return;
    }
    const now = this.#now().getTime();
    l.restarts = l.restarts.filter((t) => now - t < policy.windowSec * 1000);
    if (l.restarts.length >= policy.maxRestarts) {
      l.rec.desired = 'stopped';
      await this.#saveRecord(l.rec).catch(() => undefined);
      this.#setState(
        l,
        'failed',
        `${why}; gave up after ${String(l.restarts.length)} restarts in ${String(Math.round(policy.windowSec / 60))} min`,
      );
      return;
    }
    const backoff = this.#d.backoffMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = backoff[Math.min(l.restarts.length, backoff.length - 1)] ?? 1_000;
    l.restarts.push(now);
    l.totalRestarts++;
    this.#setState(l, 'restarting', why);
    l.restartTimer = setTimeout(() => {
      l.restartTimer = null;
      if (gen === l.generation && l.rec.desired === 'running') void this.#enqueue(l, () => this.#spawn(l));
    }, delay);
    l.restartTimer.unref();
  }

  /** Stops the process tree (SIGTERM, tree kill after the grace) and the tunnel. */
  async #kill(l: Live, reason: string): Promise<void> {
    l.generation++;
    l.stopping = true;
    for (const t of [l.healthTimer, l.restartTimer, l.ttlTimer]) if (t !== null) clearTimeout(t);
    l.healthTimer = null;
    l.restartTimer = null;
    if (l.rec.desired !== 'running') {
      if (l.ttlTimer !== null) clearTimeout(l.ttlTimer);
      l.ttlTimer = null;
    }
    await this.#stopTunnel(l, reason);
    const proc = l.proc;
    l.proc = null;
    if (proc !== null) {
      await proc.terminate({ graceMs: this.#d.stopGraceMs ?? 5000 }).catch(() => undefined);
      await proc.dispose().catch(() => undefined);
      l.log.flush();
    }
    l.rec.pid = null;
    l.health = l.rec.spec.health.kind === 'none' ? 'none' : 'unknown';
    l.metrics = {};
  }

  /**
   * Worker shutdown: every service stops (ADR-0012 rule 4 — no child left behind) but keeps its desired state, so the
   * restarted worker starts it again.
   */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    if (this.#statusTimer !== null) clearInterval(this.#statusTimer);
    await Promise.allSettled(
      [...this.#live.values()].map(async (l) => {
        await this.#kill(l, 'the worker is stopping');
        await this.#saveRecord(l.rec).catch(() => undefined);
        await l.log.settled();
      }),
    );
  }

  /** Services of a project this machine runs (job tools). */
  ids(): string[] {
    return [...this.#live.keys()];
  }
}

/** Kills a process group left by the previous worker process (POSIX: the group; Windows: the tree). */
async function killStaleTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const { runProcess } = await import('../remote-ops/process.js');
    await runProcess('taskkill', ['/T', '/F', '/PID', String(pid)], {
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      cwd: process.env.SystemRoot ?? 'C:\\Windows',
      timeoutMs: 15_000,
    });
    return;
  }
  try {
    process.kill(-pid, 0);
  } catch {
    return; // gone
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // not ours / gone
  }
}
