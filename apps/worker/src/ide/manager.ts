import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { uptime } from 'node:os';
import { join, sep } from 'node:path';
import { DEFAULT_INHERITED_ENV, type OwnedProcess, pickFreeLoopbackPort } from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  IDE_EXTENSION_LIMITS,
  IDE_LIMITS,
  type IdeControlPayload,
  type IdeEventPayload,
  type IdeFileDataPayload,
  type IdeFileRequestPayload,
  type IdeGitPayload,
  type IdeGitResultPayload,
  type IdeNoticePayload,
  type IdeReport,
  IdeSpec,
  type IdeStartPayload,
  type IdeState,
  type IdeStatusPayload,
  type IdeStopReason,
  IdeSyncedSettings,
  type IdeUnavailableCode,
  type LeaseKey,
  LIVE_IDE_STATES,
  type MasterToWorker,
  ideBasePath,
  ideMessageFresh,
  ideSpecHash,
  verifyIdeControl,
  verifyIdeGit,
  verifyIdeStart,
} from '@remyral/protocol';
import { projectProcessNetworkPolicy } from '../jobs/repo-egress.js';
import type { ResourceLimits, SandboxRunner } from '../sandbox/types.js';
import { SecretString } from '../secrets/ref.js';
import type { TreeSampler } from '../services/health.js';
import { PushRejectedError, SecretScanError } from '../workspace/errors.js';
import type { IdeGitDiff, IdeGitStatus, PrepareRequest, Workspace } from '../workspace/manager.js';
import { ensureDirInside, isInside } from '../workspace/paths.js';
import type { BridgeAnswer, BridgeSettings, IdeBridgeServer } from './bridge.js';
import {
  BRIDGE_EXTENSION_DIR,
  BRIDGE_EXTENSION_ID,
  bridgeExtensionFiles,
  bridgeExtensionsJson,
} from './bridge-extension.js';
import { type IdeExtensionCache, installExtensions, machineSettings } from './extensions.js';
import { IdeGateway } from './gateway.js';
import { type IdeLaunchPlan, type IdeReadiness, ideLaunchPlan } from './launch.js';
import type { IdeServerPort } from './server.js';

/**
 * p19-ide W2 (docs/design/p19-ide.md §3, §7, ADR-0066): the IDE workspaces this worker runs — openvscode-server per
 * (project, user, name), started and stopped by the master, reached only through the STREAM_* plane.
 *
 * - **Desired state** comes from the master (IDE_START / IDE_CONTROL, signed with a lease key, ≤ 5 min old) and is
 *   kept in `<dataDir>/ide/<id>/record.json` (0600). A worker restart stops every IDE (no re-adoption: the sandbox's
 *   egress proxy and limits belong to the process that started it); the master starts it again on reconnect when it is
 *   still wanted (CAPABILITIES.ide reconciliation, a fresh signature).
 * - **Files**: repository projects get a worktree of the worker's mirror on the workspace's own branch
 *   (`remyral/ide/<user>/<name>`, `<root>/jobs/ide-<id>/checkout`), never shared with a job; workspace projects a
 *   working directory (`<root>/jobs/ide-<id>/files`), optionally seeded once from a kept working dir. Stopping keeps
 *   them; `remove` deletes them (and the local branch).
 * - **Process**: the pinned server (Linux: openvscode-server; W2b macOS / Windows: code-server — launch.ts) under the
 *   services' sandbox profile (`host-restricted`, `listen`, the job egress allowlist), bound to 127.0.0.1 on a free port
 *   with a random per-start secret, reached under `/w/<id>`. Its state (server / user data, extensions with the bridge
 *   extension, HOME) lives in `<root>/sandboxes/ide-<id>/run`. It holds **no job slot**.
 * - **W2b per OS**: Linux as W2 (no job account). macOS only with Seatbelt (writes: the folder and the run dir; reads
 *   of the data dir, other jobs and protected home paths denied; network only to the egress proxy and the bridge port,
 *   Unix sockets only under the run dir; the repository mirror read-only for the IDE's own git). Windows only with the
 *   per-job account pool: the server runs as its own `remyral-job-<n>` account in a Job Object (memory, processes, tree
 *   kill on close) for its whole run, the mirror granted read-only, the account released at stop. Elsewhere — or when
 *   that sandbox is not ready — the machine reports why (`reasonCode`) and refuses starts.
 * - **Limits** (by design): at most {@link IDE_LIMITS.perMachine} running per machine (more are refused), memory
 *   per IDE (`memoryMb`, default 4 GB: the sandbox's limit where the profile enforces one, and a watchdog that samples
 *   the process tree every 30 s and stops it above the limit on every OS), idle stop after `idleMinutes` without a
 *   stream or a request — enforced here too, so the master cannot be bypassed.
 * - **Git**: IDE_GIT status / push run through the daemon's hardened git path with a token the master minted for that
 *   push (never in the IDE's environment); pushes are fast-forward only, secret-scanned, and only the workspace branch.
 * - **Bridge**: the loopback bridge (bridge.ts) turns the extension's calls into IDE_EVENT (terminal audit, chat
 *   reference, push request) and waits for the master's IDE_NOTICE for pushes.
 */

export interface IdeChannel {
  status(payload: IdeStatusPayload): Promise<void>;
  gitResult(payload: IdeGitResultPayload): Promise<void>;
  fileData(payload: IdeFileDataPayload): Promise<void>;
  event(payload: IdeEventPayload): Promise<void>;
  workerId(): string | null;
}

/** What the manager needs from the workspace manager. */
export interface IdeWorkspacePort {
  readonly root: string;
  prepare(req: PrepareRequest): Promise<Workspace>;
  release(ws: Workspace, outcome: { status: 'succeeded'; artifactsCollected: true }): Promise<unknown>;
  ideGitStatus(ws: Workspace): Promise<IdeGitStatus>;
  /** p19-ide W4: the uncommitted diff (IDE_GIT `diff`); absent: the op is refused. */
  ideGitDiff?(
    ws: Workspace,
    opts: { readonly path?: string; readonly maxChars: number; readonly maxFiles: number },
  ): Promise<IdeGitDiff>;
  idePush(
    ws: Workspace,
    req: {
      readonly message?: string;
      readonly author: { readonly name: string; readonly email: string };
      readonly gitToken?: SecretString;
      readonly gitTokenUsername?: string;
    },
  ): Promise<{ branch: string; sha: string; committed: boolean }>;
}

export interface IdeManagerDeps {
  readonly dataDir: string;
  readonly workspace: IdeWorkspacePort | null;
  /** The host-restricted runner (null: no sandbox → every start is refused). */
  readonly runner: () => SandboxRunner | null;
  readonly limits: ResourceLimits;
  readonly egressAllow: readonly string[];
  readonly allowedProfiles: () => readonly string[];
  readonly keys: () => readonly LeaseKey[];
  readonly channel: IdeChannel;
  readonly server: IdeServerPort;
  readonly bridge: IdeBridgeServer;
  /** Open browser streams of a workspace on the current master connection. */
  readonly streamsFor: (workspaceId: string) => number;
  /** Ends a workspace's streams (it stopped). */
  readonly resetStreams: (workspaceId: string) => void;
  /** Copies a kept working dir of this machine into a new files workspace (p15-workspace-retention). */
  readonly seed?: (jobId: string, attemptId: string, dest: string) => Promise<boolean>;
  /** The console origin (Konsola dön in the bridge). */
  readonly consoleUrl?: string;
  /** Owner refused the IDE on this machine (local ceiling). */
  readonly disabledReason?: () => string | null;
  readonly logger: Logger;
  readonly extraEnv?: () => Promise<Readonly<Record<string, string>>>;
  readonly clock?: () => Date;
  readonly sampler?: TreeSampler;
  readonly maxRunning?: number;
  readonly platform?: NodeJS.Platform;
  /**
   * W2b: the host runner's readiness and filesystem confinement now (`seatbelt`, `job_user`, `bwrap`, `none`); macOS
   * needs `seatbelt`, Windows `job_user`. Absent: not confined (Linux behaves as W2).
   */
  readonly sandboxCheck?: () => {
    readonly ready: boolean;
    readonly filesystemConfinement: string;
    readonly reason?: string | undefined;
  };
  readonly freePort?: () => Promise<number>;
  /** Waits until the server answers on its port (tests replace it). */
  readonly waitReady?: (
    port: number,
    readiness: IdeReadiness,
    timeoutMs: number,
  ) => Promise<'ready' | 'open' | 'timeout'>;
  readonly statusIntervalMs?: number;
  readonly watchIntervalMs?: number;
  readonly stopGraceMs?: number;
  readonly readyTimeoutMs?: number;
  readonly pushTimeoutMs?: number;
  readonly bootId?: () => string;
  readonly killStale?: (pid: number) => Promise<void>;
  /**
   * p19-ide W3: the offline VSIX cache and the master download (path on the master origin, the start's token, a
   * byte cap). Without them a start installs only the bridge extension.
   */
  readonly extensionCache?: IdeExtensionCache;
  readonly download?: (path: string, token: string, maxBytes: number) => Promise<Buffer>;
  /** How long a settings save waits for the master's answer (ms); default 30 s. */
  readonly settingsTimeoutMs?: number;
}

type Checkout =
  { readonly kind: 'repository'; readonly ws: Workspace } | { readonly kind: 'files'; readonly path: string };

interface IdeRecord {
  v: 1;
  spec: IdeSpec;
  revision: number;
  desired: 'running' | 'stopped';
  checkout: Checkout | null;
  lastState: IdeState;
  lastDetail: string | null;
  pid: number | null;
  bootId: string | null;
}

interface Live {
  rec: IdeRecord;
  proc: OwnedProcess | null;
  gateway: IdeGateway | null;
  port: number | null;
  token: string | null;
  state: IdeState;
  detail: string | undefined;
  stopReason: IdeStopReason | undefined;
  since: Date;
  startedAt: Date | null;
  lastActivity: Date;
  memoryBytes: number | undefined;
  cpuPercent: number | undefined;
  head: string | undefined;
  stopping: boolean;
  generation: number;
  queue: Promise<void>;
  /** W3: what the last start installed (reported in IDE_STATUS). */
  extensions: { installed: string[]; failed: { id: string; reason: string }[] } | undefined;
  /** The install report went out with the first `running` status of this start (reported once per start). */
  extensionsSent: boolean;
  /** W3: the synced settings this start fetched (null: sync off). */
  sync: BridgeSettings | null;
}

const SEGMENT = (id: string): string => `ide-${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class IdeManager {
  readonly #d: IdeManagerDeps;
  readonly #log: Logger;
  readonly #live = new Map<string, Live>();
  /** Bridge requests (push, settings save) waiting for the master's IDE_NOTICE, by event id. */
  readonly #pendingPush = new Map<string, (n: IdeNoticePayload) => void>();
  #statusTimer: NodeJS.Timeout | null = null;
  #watchTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(d: IdeManagerDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'ide' });
  }

  get #root(): string {
    return join(this.#d.dataDir, 'ide');
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

  /** Why this machine runs no IDE (null: it can). */
  unavailable(): string | null {
    return this.#why()?.detail ?? null;
  }

  /** W2b: the reason as a code (CAPABILITIES.ide `reasonCode`) and an English detail. */
  #why(): { code: IdeUnavailableCode; detail: string } | null {
    const local = this.#d.disabledReason?.() ?? null;
    if (local !== null) return { code: 'disabled_locally', detail: local };
    const platform = this.#d.platform ?? process.platform;
    const s = this.#d.server.unsupported();
    if (s !== null) return { code: 'platform_unsupported', detail: s };
    if (this.#d.runner() === null)
      return {
        code: 'sandbox_unavailable',
        detail: 'the host-restricted sandbox is not available on this machine',
      };
    if (!this.#d.allowedProfiles().includes('host-restricted'))
      return {
        code: 'profile_not_allowed',
        detail: 'the host-restricted profile is not allowed on this machine',
      };
    const check = this.#d.sandboxCheck?.();
    if (check !== undefined && !check.ready)
      return {
        code: 'sandbox_unavailable',
        detail: `the host-restricted sandbox is not ready: ${check.reason ?? 'unknown'}`,
      };
    return (
      idePlatformRefusal(platform, check?.filesystemConfinement ?? null) ??
      (this.#d.workspace === null
        ? { code: 'no_workspace_root', detail: 'this machine has no usable workspace root' }
        : null)
    );
  }

  // ============================================================================================= persistence

  async #save(rec: IdeRecord): Promise<void> {
    const dir = this.#dir(rec.spec.workspaceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `record.json.tmp-${randomUUID().slice(0, 8)}`);
    await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
    await rename(tmp, join(dir, 'record.json'));
  }

  /**
   * Worker start: reads the kept records and kills the server processes the previous worker process left (same boot).
   * Nothing is started: a wanted IDE is started again by the master's IDE_START after the reconnect.
   */
  async load(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.#root).catch(() => [] as string[])) {
      if (!UUID.test(name)) continue;
      let rec: IdeRecord;
      try {
        rec = JSON.parse(await readFile(join(this.#root, name, 'record.json'), 'utf8')) as IdeRecord;
        rec.spec = IdeSpec.parse(rec.spec);
      } catch {
        continue;
      }
      if (rec.pid !== null && rec.bootId === this.#bootId()) {
        await (this.#d.killStale ?? killStaleTree)(rec.pid).catch(() => undefined);
      }
      rec.pid = null;
      const live = this.#newLive(rec);
      if ((LIVE_IDE_STATES as readonly string[]).includes(rec.lastState)) {
        live.state = 'stopped';
        live.stopReason = 'worker';
        live.detail = 'the worker restarted';
        rec.lastState = 'stopped';
        rec.lastDetail = live.detail;
        await this.#save(rec).catch(() => undefined);
      }
      this.#live.set(rec.spec.workspaceId, live);
    }
    this.#statusTimer = setInterval(() => {
      this.#tick();
    }, this.#d.statusIntervalMs ?? 60_000);
    this.#statusTimer.unref();
    this.#watchTimer = setInterval(() => {
      void this.#watch();
    }, this.#d.watchIntervalMs ?? 30_000);
    this.#watchTimer.unref();
  }

  #newLive(rec: IdeRecord): Live {
    const now = this.#now();
    return {
      rec,
      proc: null,
      gateway: null,
      port: null,
      token: null,
      state: rec.lastState,
      detail: rec.lastDetail ?? undefined,
      stopReason: undefined,
      since: now,
      startedAt: null,
      lastActivity: now,
      memoryBytes: undefined,
      cpuPercent: undefined,
      head: undefined,
      stopping: false,
      generation: 0,
      queue: Promise.resolve(),
      extensions: undefined,
      extensionsSent: false,
      sync: null,
    };
  }

  #enqueue(live: Live, fn: () => Promise<void>): Promise<void> {
    const next = live.queue.then(fn, fn).catch((err: unknown) => {
      this.#log.warn('IDE operation failed', { workspaceId: live.rec.spec.workspaceId, err });
    });
    live.queue = next;
    return next;
  }

  // ============================================================================================= reports

  report(): IdeReport {
    const why = this.#why();
    const kind = this.#d.server.kind;
    return {
      available: why === null,
      ...(why === null ? {} : { reason: why.detail.slice(0, 200), reasonCode: why.code }),
      serverVersion: this.#d.server.version,
      ...(kind === null ? {} : { serverKind: kind }),
      max: this.#max(),
      workspaces: [...this.#live.values()].slice(0, 64).map((l) => ({
        workspaceId: l.rec.spec.workspaceId,
        revision: l.rec.revision,
        state: l.state,
        since: l.since.toISOString(),
      })),
    };
  }

  #max(): number {
    return this.#d.maxRunning ?? IDE_LIMITS.perMachine;
  }

  /** The gateway of a running workspace (the stream plane's lookup). */
  gateway(workspaceId: string): IdeGateway | null {
    const l = this.#live.get(workspaceId);
    return l?.state === 'running' && l.gateway !== null ? l.gateway : null;
  }

  /** Local view (tests). */
  view(workspaceId: string): { state: IdeState; port: number | null; detail: string | undefined } | null {
    const l = this.#live.get(workspaceId);
    return l === undefined ? null : { state: l.state, port: l.port, detail: l.detail };
  }

  #status(l: Live): IdeStatusPayload {
    const report = l.extensions !== undefined && l.state === 'running' && !l.extensionsSent;
    if (report) l.extensionsSent = true;
    const branch = l.rec.spec.source.kind === 'repository' ? l.rec.spec.source.branch : undefined;
    return {
      workspaceId: l.rec.spec.workspaceId,
      revision: l.rec.revision,
      state: l.state,
      ...(l.detail === undefined ? {} : { detail: l.detail.slice(0, 300) }),
      ...(l.stopReason === undefined ? {} : { stopReason: l.stopReason }),
      ...(l.startedAt === null ? {} : { startedAt: l.startedAt.toISOString() }),
      streams: Math.min(this.#d.streamsFor(l.rec.spec.workspaceId), 10_000),
      lastActivityAt: l.lastActivity.toISOString(),
      ...(branch === undefined ? {} : { branch }),
      ...(l.head === undefined ? {} : { head: l.head }),
      ...(l.memoryBytes === undefined ? {} : { memoryBytes: l.memoryBytes }),
      ...(l.cpuPercent === undefined ? {} : { cpuPercent: l.cpuPercent }),
      ...(report && l.extensions !== undefined ? { extensions: l.extensions } : {}),
      at: this.#now().toISOString(),
    };
  }

  #send(l: Live): void {
    void this.#d.channel.status(this.#status(l)).catch(() => undefined);
  }

  #setState(l: Live, state: IdeState, detail?: string, stopReason?: IdeStopReason): void {
    const changed = l.state !== state || l.detail !== detail;
    l.state = state;
    l.detail = detail;
    l.stopReason = state === 'stopped' || state === 'failed' ? stopReason : undefined;
    if (changed) {
      l.since = this.#now();
      l.rec.lastState = state;
      l.rec.lastDetail = detail ?? null;
      if (state !== 'removed') void this.#save(l.rec).catch(() => undefined);
    }
    this.#send(l);
  }

  #tick(): void {
    for (const l of this.#live.values()) {
      if ((LIVE_IDE_STATES as readonly string[]).includes(l.state)) this.#send(l);
    }
  }

  /** Every 30 s: memory of running servers (stop above the limit) and the idle rule. */
  async #watch(): Promise<void> {
    const now = this.#now().getTime();
    for (const l of this.#live.values()) {
      if (l.state !== 'running' || l.proc === null) continue;
      const proc = l.proc;
      if (this.#d.sampler !== undefined) {
        const s: { memoryBytes?: number; cpuPercent?: number } = await this.#d
          .sampler(proc.pid)
          .catch(() => ({}));
        l.memoryBytes = s.memoryBytes;
        l.cpuPercent = s.cpuPercent;
        const limit = l.rec.spec.memoryMb * 1024 * 1024;
        if (s.memoryBytes !== undefined && s.memoryBytes > limit && l.proc === proc) {
          this.#log.warn('IDE over its memory limit; stopping', {
            workspaceId: l.rec.spec.workspaceId,
            memoryBytes: s.memoryBytes,
          });
          void this.#enqueue(l, () =>
            this.#stop(l, 'memory', `stopped: memory above ${String(l.rec.spec.memoryMb)} MB`),
          );
          continue;
        }
      }
      if (this.#d.streamsFor(l.rec.spec.workspaceId) > 0) {
        l.lastActivity = this.#now();
        continue;
      }
      if (now - l.lastActivity.getTime() >= l.rec.spec.idleMinutes * 60_000) {
        void this.#enqueue(l, () =>
          this.#stop(l, 'idle', `stopped after ${String(l.rec.spec.idleMinutes)} minutes without use`),
        );
      }
    }
  }

  // ============================================================================================= messages

  /** IDE_START / IDE_CONTROL / IDE_GIT / IDE_FILE_REQUEST / IDE_NOTICE; false for anything else. */
  async onMessage(message: MasterToWorker): Promise<boolean> {
    switch (message.type) {
      case 'IDE_START':
        await this.onStart(message.payload);
        return true;
      case 'IDE_CONTROL':
        await this.onControl(message.payload);
        return true;
      case 'IDE_GIT':
        await this.onGit(message.payload);
        return true;
      case 'IDE_FILE_REQUEST':
        await this.onFile(message.payload);
        return true;
      case 'IDE_NOTICE': {
        const wake = this.#pendingPush.get(message.payload.eventId);
        if (wake !== undefined) wake(message.payload);
        return true;
      }
      default:
        return false;
    }
  }

  #refuse(workspaceId: string, revision: number, detail: string): void {
    this.#log.warn('IDE start refused', { workspaceId, detail });
    const l = this.#live.get(workspaceId);
    if (l !== undefined && (LIVE_IDE_STATES as readonly string[]).includes(l.state)) {
      void this.#d.channel
        .status({ ...this.#status(l), detail: `update refused: ${detail}`.slice(0, 300) })
        .catch(() => undefined);
      return;
    }
    void this.#d.channel
      .status({
        workspaceId,
        revision,
        state: 'refused',
        detail: detail.slice(0, 300),
        at: this.#now().toISOString(),
      })
      .catch(() => undefined);
  }

  async onStart(p: IdeStartPayload): Promise<void> {
    const workerId = this.#d.channel.workerId();
    const id = p.spec.workspaceId;
    if (this.#stopped || workerId === null) return;
    const parsed = IdeSpec.safeParse(p.spec);
    if (!parsed.success) {
      this.#refuse(id, p.revision, 'the workspace spec is invalid');
      return;
    }
    const spec = parsed.data;
    const verdict = verifyIdeStart(
      { workerId, revision: p.revision, issuedAt: p.issuedAt, spec, profile: p.profile },
      p.signature,
      [...this.#d.keys()],
    );
    if (verdict !== 'ok') {
      this.#refuse(id, p.revision, `the start is not signed by the master (${verdict})`);
      return;
    }
    if (!ideMessageFresh(p.issuedAt, this.#now())) {
      this.#refuse(id, p.revision, 'the start is too old');
      return;
    }
    const why = this.unavailable();
    if (why !== null) {
      this.#refuse(id, p.revision, why);
      return;
    }
    const existing = this.#live.get(id);
    if (existing !== undefined && existing.rec.revision > p.revision) return; // stale re-send
    if (existing?.rec.spec.userId !== undefined && existing.rec.spec.userId !== spec.userId) {
      this.#refuse(id, p.revision, 'the workspace belongs to another user');
      return;
    }
    const alive = (l: Live): boolean => (LIVE_IDE_STATES as readonly string[]).includes(l.state);
    if (existing !== undefined && alive(existing)) {
      if (existing.rec.revision === p.revision) {
        this.#send(existing);
        return;
      }
      const sameRun = ideSpecHash(existing.rec.spec) === ideSpecHash(spec);
      existing.rec.revision = p.revision;
      existing.rec.desired = 'running';
      if (sameRun) {
        await this.#save(existing.rec);
        this.#send(existing);
        return;
      }
      existing.rec.spec = spec;
      await this.#save(existing.rec);
      return this.#enqueue(existing, async () => {
        await this.#kill(existing);
        await this.#spawn(existing, p);
      });
    }
    const running = [...this.#live.values()].filter((l) => l !== existing && alive(l)).length;
    if (running >= this.#max()) {
      this.#refuse(id, p.revision, `at most ${String(this.#max())} IDEs run on this machine at a time`);
      return;
    }
    if (existing !== undefined) {
      existing.rec.revision = p.revision;
      existing.rec.desired = 'running';
      if (existing.rec.checkout === null || ideSpecHash(existing.rec.spec) === ideSpecHash(spec)) {
        existing.rec.spec = spec;
      } else {
        // The files stay; only memory / idle / author may change for an existing workspace.
        existing.rec.spec = { ...spec, source: existing.rec.spec.source };
      }
      await this.#save(existing.rec);
      return this.#enqueue(existing, () => this.#spawn(existing, p));
    }
    const rec: IdeRecord = {
      v: 1,
      spec,
      revision: p.revision,
      desired: 'running',
      checkout: null,
      lastState: 'preparing',
      lastDetail: null,
      pid: null,
      bootId: null,
    };
    await this.#save(rec);
    const live = this.#newLive(rec);
    this.#live.set(id, live);
    return this.#enqueue(live, () => this.#spawn(live, p));
  }

  async onControl(p: IdeControlPayload): Promise<void> {
    const workerId = this.#d.channel.workerId();
    if (workerId === null) return;
    const verdict = verifyIdeControl(
      { workerId, workspaceId: p.workspaceId, op: p.op, issuedAt: p.issuedAt },
      p.signature,
      [...this.#d.keys()],
    );
    if (verdict !== 'ok' || !ideMessageFresh(p.issuedAt, this.#now())) {
      this.#log.warn('IDE_CONTROL refused', { workspaceId: p.workspaceId, verdict });
      return;
    }
    const l = this.#live.get(p.workspaceId);
    if (l === undefined) {
      void this.#d.channel
        .status({
          workspaceId: p.workspaceId,
          revision: 0,
          state: p.op === 'remove' ? 'removed' : 'stopped',
          detail: 'not on this machine',
          at: this.#now().toISOString(),
        })
        .catch(() => undefined);
      return;
    }
    if (p.op === 'stop') {
      l.rec.desired = 'stopped';
      await this.#save(l.rec);
      return this.#enqueue(l, () => this.#stop(l, 'requested', p.reason || 'stopped'));
    }
    return this.#enqueue(l, async () => {
      l.rec.desired = 'stopped';
      await this.#stop(l, 'requested', p.reason || 'removed', false);
      await this.#removeFiles(l);
      this.#live.delete(p.workspaceId);
      this.#setState(l, 'removed', p.reason || 'removed');
    });
  }

  // ============================================================================================= start / stop

  async #prepareCheckout(l: Live, p: IdeStartPayload): Promise<Checkout> {
    const spec = l.rec.spec;
    const workspace = this.#d.workspace;
    if (workspace === null) throw new Error('this machine has no usable workspace root');
    if (l.rec.checkout !== null) {
      const path = l.rec.checkout.kind === 'repository' ? l.rec.checkout.ws.path : l.rec.checkout.path;
      if ((await lstat(path).catch(() => null)) !== null) return l.rec.checkout;
      throw new Error('the workspace files are gone from this machine');
    }
    const src = spec.source;
    if (src.kind === 'repository') {
      const ws = await workspace.prepare({
        projectId: spec.projectId,
        jobId: SEGMENT(spec.workspaceId),
        attemptId: 'checkout',
        epoch: 0,
        repository: { url: src.repositoryUrl, baseRef: src.baseRef },
        ide: { branch: src.branch },
        ...(p.gitToken === undefined
          ? {}
          : {
              gitToken: new SecretString(p.gitToken),
              ...(p.gitTokenUsername === undefined ? {} : { gitTokenUsername: p.gitTokenUsername }),
            }),
      });
      return { kind: 'repository', ws };
    }
    const path = await ensureDirInside(workspace.root, ['jobs', SEGMENT(spec.workspaceId), 'files']);
    if (src.seed !== null && this.#d.seed !== undefined) {
      const ok = await this.#d.seed(src.seed.jobId, src.seed.attemptId, path).catch(() => false);
      if (!ok)
        this.#log.warn('IDE seed not copied', { workspaceId: spec.workspaceId, jobId: src.seed.jobId });
    }
    return { kind: 'files', path };
  }

  /**
   * The IDE's own state dirs, the bridge extension (re-written at every start: a release pins its code), and (W3) the
   * profile's extensions from the offline cache, `extensions.allowed`, the enforced settings and the synced settings.
   */
  async #prepareRun(
    l: Live,
    p: IdeStartPayload,
  ): Promise<{ run: string; home: string; ext: string; userData: string; serverData: string }> {
    const workspace = this.#d.workspace;
    if (workspace === null) throw new Error('this machine has no usable workspace root');
    const run = await ensureDirInside(workspace.root, ['sandboxes', SEGMENT(l.rec.spec.workspaceId), 'run']);
    const sub = async (name: string): Promise<string> => {
      const p = join(run, name);
      await mkdir(p, { recursive: true, mode: 0o700 });
      return p;
    };
    const home = await sub('home');
    const ext = await sub('extensions');
    const userData = await sub('user-data');
    const serverData = await sub('server-data');
    const bridgeDir = join(ext, BRIDGE_EXTENSION_DIR);
    await rm(bridgeDir, { recursive: true, force: true });
    await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(bridgeExtensionFiles())) {
      await writeFile(join(bridgeDir, name), content, { mode: 0o600 });
    }
    const entries: unknown[] = JSON.parse(bridgeExtensionsJson(ext, this.#now())) as unknown[];
    const profile = p.profile;
    l.extensions = undefined;
    l.extensionsSent = false;
    if (profile !== undefined && profile.extensions.length > 0) {
      const res = await this.#installProfile(ext, p);
      entries.push(...res.entries);
      l.extensions = { installed: res.installed, failed: res.failed };
    } else {
      // Folders of an earlier start's extensions go (the profile is empty or absent).
      await installExtensions({
        extDir: ext,
        refs: [],
        cache: this.#d.extensionCache ?? null,
        download: () => Promise.reject(new Error('no download')),
        keepFolders: [BRIDGE_EXTENSION_DIR],
        now: this.#now(),
        logger: this.#log,
      });
      if (profile !== undefined) l.extensions = { installed: [], failed: [] };
    }
    await writeFile(join(ext, 'extensions.json'), JSON.stringify(entries), { mode: 0o600 });
    // Machine settings: no telemetry, no update / marketplace checks, only the installed extensions allowed (W3), and
    // the project's enforced settings (presentation: a folder's .vscode/settings.json still wins).
    const machine = join(userData, 'Machine');
    await mkdir(machine, { recursive: true, mode: 0o700 });
    await writeFile(
      join(machine, 'settings.json'),
      `${JSON.stringify(
        machineSettings({
          allowed: l.extensions?.installed ?? [],
          enforced: profile?.enforcedSettings ?? {},
          bridgeId: BRIDGE_EXTENSION_ID,
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    l.sync = await this.#fetchSettings(l, p);
    return { run, home, ext, userData, serverData };
  }

  async #installProfile(
    ext: string,
    p: IdeStartPayload,
  ): Promise<{ installed: string[]; failed: { id: string; reason: string }[]; entries: unknown[] }> {
    const refs = p.profile?.extensions ?? [];
    const cache = this.#d.extensionCache;
    const download = this.#d.download;
    const token = p.downloadToken;
    if (cache === undefined || download === undefined || token === undefined) {
      return {
        installed: [],
        failed: refs.map((r) => ({ id: r.id, reason: 'this machine cannot download extensions' })),
        entries: [],
      };
    }
    const res = await installExtensions({
      extDir: ext,
      refs,
      cache,
      download: (ref) => download(`/v1/worker/ide/extensions/${ref.sha256}`, token, ref.size),
      keepFolders: [BRIDGE_EXTENSION_DIR],
      now: this.#now(),
      logger: this.#log,
    });
    await cache.prune(new Set(refs.map((r) => r.sha256))).catch(() => 0);
    return res;
  }

  /** W3: the owner's synced settings for the bridge (fetched once per start; null when sync is off). */
  async #fetchSettings(l: Live, p: IdeStartPayload): Promise<BridgeSettings | null> {
    if (p.profile?.settingsSync !== true || p.downloadToken === undefined || this.#d.download === undefined)
      return null;
    try {
      const raw = await this.#d.download(
        `/v1/worker/ide/settings/${l.rec.spec.workspaceId}`,
        p.downloadToken,
        2 * IDE_EXTENSION_LIMITS.settingsMaxBytes + 64 * 1024,
      );
      const parsed = IdeSyncedSettings.parse(JSON.parse(raw.toString('utf8')));
      return { sync: true, settings: parsed.settings, keybindings: parsed.keybindings };
    } catch (err) {
      this.#log.warn('IDE settings not fetched; sync off for this start', {
        workspaceId: l.rec.spec.workspaceId,
        err,
      });
      return null;
    }
  }

  async #spawn(l: Live, p: IdeStartPayload): Promise<void> {
    if (this.#stopped || l.rec.desired !== 'running') return;
    const spec = l.rec.spec;
    const id = spec.workspaceId;
    const gen = ++l.generation;
    l.stopping = false;
    this.#setState(l, 'preparing');
    const runner = this.#d.runner();
    if (runner === null) {
      this.#setState(l, 'failed', 'the host-restricted sandbox is not available on this machine', 'error');
      return;
    }
    let proc: OwnedProcess;
    let port: number;
    let token: string;
    let plan: IdeLaunchPlan;
    try {
      const server = await this.#d.server.ensure();
      const checkout = await this.#prepareCheckout(l, p);
      l.rec.checkout = checkout;
      await this.#save(l.rec);
      // Stopped / replaced while the checkout was prepared (state changes across the awaits above).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (gen !== l.generation || l.rec.desired !== 'running') return;
      const dirs = await this.#prepareRun(l, p);
      token = randomBytes(32).toString('base64url');
      port = await (this.#d.freePort ?? pickFreeLoopbackPort)();
      const folder = checkout.kind === 'repository' ? checkout.ws.path : checkout.path;
      const platform = this.#d.platform ?? process.platform;
      plan = ideLaunchPlan({
        install: server,
        platform,
        port,
        token,
        basePath: ideBasePath(id),
        dirs,
        folder,
      });
      for (const f of plan.files) await writeFile(f.path, f.content, { mode: 0o600 });
      const bridge = this.#d.bridge.register(id);
      const env: Record<string, string> = {};
      for (const name of DEFAULT_INHERITED_ENV) {
        const v = process.env[name];
        if (v !== undefined && name !== 'HOME' && name !== 'USERPROFILE') env[name] = v;
      }
      Object.assign(env, (await this.#d.extraEnv?.().catch(() => ({}))) ?? {});
      for (const name of plan.dropEnv) Reflect.deleteProperty(env, name);
      Object.assign(env, plan.env);
      env.HOME = dirs.home;
      env.REMYRAL_IDE_BRIDGE_URL = bridge.url;
      env.REMYRAL_IDE_LABEL =
        spec.source.kind === 'repository' ? spec.source.branch : `${spec.projectId}/${spec.name}`;
      if (this.#d.consoleUrl !== undefined) env.REMYRAL_CONSOLE_URL = this.#d.consoleUrl;
      this.#setState(l, 'starting');
      proc = await runner.launch({
        ...ideSandboxPlacement(platform, id, {
          bridgePort: bridgePort(bridge.url),
          runDir: dirs.run,
          mirror: checkout.kind === 'repository' ? checkout.ws.mirrorPath : null,
        }),
        jobId: SEGMENT(id),
        workspacePath: folder,
        sandboxDir: dirs.run,
        // p21-service-egress: the project's network access policy (as for its repository jobs); absent → model APIs.
        network: projectProcessNetworkPolicy(spec.network ?? null, this.#d.egressAllow),
        limits: {
          ...this.#d.limits,
          memoryBytes: spec.memoryMb * 1024 * 1024,
          // The IDE needs more processes and files than a typical job (language servers, watchers, terminals).
          pids: Math.max(this.#d.limits.pids, 1024),
          openFiles: Math.max(this.#d.limits.openFiles, 8192),
        },
        listen: true,
        command: plan.command,
        args: [...plan.args],
        env,
        secretEnv: { REMYRAL_IDE_BRIDGE_TOKEN: new SecretString(bridge.token) },
        stdin: 'ignore',
        maxBufferBytes: 16 * 1024,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'the IDE could not be started';
      this.#d.bridge.unregister(id);
      if (gen === l.generation) this.#setState(l, 'failed', msg.slice(0, 300), 'error');
      return;
    }
    // Stopped while the server was being started (state changes across the awaits above).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (gen !== l.generation || l.stopping) {
      await proc.terminate({ graceMs: 1000 }).catch(() => undefined);
      await proc.dispose().catch(() => undefined);
      return;
    }
    l.proc = proc;
    l.port = port;
    l.token = token;
    l.startedAt = this.#now();
    l.lastActivity = this.#now();
    l.rec.pid = proc.pid;
    l.rec.bootId = this.#bootId();
    await this.#save(l.rec).catch(() => undefined);
    proc.stdout.resume();
    proc.stderr.resume();
    void proc.exited.then((exit) => {
      void proc.dispose().catch(() => undefined);
      if (l.proc !== proc) return;
      l.proc = null;
      void this.#enqueue(l, async () => {
        if (l.stopping || gen !== l.generation) return;
        this.#teardown(l);
        l.rec.desired = 'stopped';
        await this.#save(l.rec).catch(() => undefined);
        this.#setState(
          l,
          exit.code === 0 ? 'stopped' : 'failed',
          exit.signal === null
            ? `the IDE server exited with code ${String(exit.code)}`
            : `ended by ${exit.signal}`,
          'exited',
        );
      });
    });
    const ready = await (this.#d.waitReady ?? waitIdeReady)(
      port,
      plan.readiness,
      this.#d.readyTimeoutMs ?? 90_000,
    );
    if (gen !== l.generation || l.proc !== proc) return;
    if (ready !== 'ready') {
      // `open`: the server answered without the token — never expose such a server.
      const why =
        ready === 'open'
          ? 'the IDE server answered without its secret (or refused it); stopped'
          : 'the IDE server did not start in time';
      await this.#kill(l);
      l.rec.desired = 'stopped';
      await this.#save(l.rec).catch(() => undefined);
      this.#setState(l, 'failed', why, 'error');
      return;
    }
    l.gateway = new IdeGateway({
      workspaceId: id,
      basePath: ideBasePath(id),
      upstream: {
        cookieName: plan.upstream.cookie.slice(0, plan.upstream.cookie.indexOf('=')),
        stripBase: plan.upstream.stripBase,
        browserTokenCookie: plan.upstream.browserTokenCookie,
      },
      port: () => l.port,
      token: () => l.token,
      onActivity: () => {
        l.lastActivity = this.#now();
      },
    });
    if (spec.source.kind === 'repository' && l.rec.checkout.kind === 'repository') {
      const ws = this.#d.workspace;
      const status = ws === null ? null : await ws.ideGitStatus(l.rec.checkout.ws).catch(() => null);
      if (status !== null) l.head = status.head;
    }
    this.#setState(l, 'running');
  }

  /** Stops the process tree and the gateway (files kept). */
  async #kill(l: Live): Promise<void> {
    l.generation++;
    l.stopping = true;
    this.#teardown(l);
    const proc = l.proc;
    l.proc = null;
    if (proc !== null) {
      await proc.terminate({ graceMs: this.#d.stopGraceMs ?? 5000 }).catch(() => undefined);
      await proc.dispose().catch(() => undefined);
    }
    l.rec.pid = null;
    l.memoryBytes = undefined;
    l.cpuPercent = undefined;
  }

  #teardown(l: Live): void {
    const id = l.rec.spec.workspaceId;
    l.gateway?.close();
    l.gateway = null;
    l.port = null;
    l.token = null;
    this.#d.resetStreams(id);
    this.#d.bridge.unregister(id);
  }

  async #stop(l: Live, reason: IdeStopReason, detail: string, report = true): Promise<void> {
    if (reason !== 'requested') l.rec.desired = 'stopped';
    await this.#kill(l);
    await this.#save(l.rec).catch(() => undefined);
    if (report) this.#setState(l, 'stopped', detail, reason);
  }

  async #removeFiles(l: Live): Promise<void> {
    const workspace = this.#d.workspace;
    const id = l.rec.spec.workspaceId;
    const c = l.rec.checkout;
    if (workspace !== null) {
      if (c?.kind === 'repository') {
        await workspace
          .release(c.ws, { status: 'succeeded', artifactsCollected: true })
          .catch((err: unknown) => {
            this.#log.warn('IDE checkout release failed', { workspaceId: id, err });
          });
      }
      await rm(join(workspace.root, 'jobs', SEGMENT(id)), { recursive: true, force: true }).catch(
        () => undefined,
      );
      await rm(join(workspace.root, 'sandboxes', SEGMENT(id)), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    await rm(this.#dir(id), { recursive: true, force: true }).catch(() => undefined);
  }

  // ============================================================================================= git / files

  async onGit(p: IdeGitPayload): Promise<void> {
    const workerId = this.#d.channel.workerId();
    if (workerId === null) return;
    const answer = (r: Omit<IdeGitResultPayload, 'requestId' | 'workspaceId'>): void => {
      void this.#d.channel
        .gitResult({ requestId: p.requestId, workspaceId: p.workspaceId, ...r })
        .catch(() => undefined);
    };
    const verdict = verifyIdeGit(
      {
        workerId,
        workspaceId: p.workspaceId,
        requestId: p.requestId,
        op: p.op,
        message: p.message,
        issuedAt: p.issuedAt,
        ...(p.path === undefined ? {} : { path: p.path }),
      },
      p.signature,
      [...this.#d.keys()],
    );
    if (verdict !== 'ok' || !ideMessageFresh(p.issuedAt, this.#now())) {
      answer({
        status: 'refused',
        reason: 'not_signed',
        detail: `the request is not signed by the master (${verdict})`,
      });
      return;
    }
    const l = this.#live.get(p.workspaceId);
    const workspace = this.#d.workspace;
    if (l === undefined || workspace === null) {
      answer({ status: 'refused', reason: 'not_found', detail: 'the workspace is not on this machine' });
      return;
    }
    const c = l.rec.checkout;
    if (c?.kind !== 'repository') {
      answer({
        status: 'refused',
        reason: 'no_repository',
        detail: 'this workspace has no repository checkout',
      });
      return;
    }
    await this.#enqueue(l, async () => {
      try {
        if (p.op === 'status') {
          const s = await workspace.ideGitStatus(c.ws);
          l.head = s.head;
          answer({
            status: 'ok',
            branch: s.branch,
            head: s.head,
            changedFiles: s.changedFiles,
            ahead: s.ahead,
          });
          return;
        }
        // p19-ide W4 (read_workspace_diff): read-only — the uncommitted changes, capped.
        if (p.op === 'diff') {
          if (workspace.ideGitDiff === undefined) {
            answer({ status: 'refused', reason: 'unsupported', detail: 'this machine cannot read diffs' });
            return;
          }
          const d = await workspace.ideGitDiff(c.ws, {
            ...(p.path === undefined ? {} : { path: p.path }),
            maxChars: IDE_LIMITS.diffMaxChars,
            maxFiles: IDE_LIMITS.diffMaxFiles,
          });
          l.head = d.head;
          answer({
            status: 'ok',
            branch: d.branch,
            head: d.head,
            files: d.files.map((f) => ({ ...f, path: f.path.slice(0, 1024) })),
            untracked: d.untracked.map((u) => u.slice(0, 1024)),
            diff: d.diff,
            truncated: d.truncated,
          });
          return;
        }
        if (p.gitToken === undefined) {
          answer({
            status: 'refused',
            reason: 'no_credential',
            detail: 'no push credential for this repository',
          });
          return;
        }
        const r = await workspace.idePush(c.ws, {
          ...(p.message === undefined ? {} : { message: p.message }),
          author: l.rec.spec.gitAuthor,
          gitToken: new SecretString(p.gitToken),
          ...(p.gitTokenUsername === undefined ? {} : { gitTokenUsername: p.gitTokenUsername }),
        });
        l.head = r.sha;
        const s = await workspace.ideGitStatus(c.ws).catch(() => null);
        answer({
          status: 'ok',
          branch: r.branch,
          head: r.sha,
          committed: r.committed,
          pushed: true,
          ...(s === null ? {} : { changedFiles: s.changedFiles, ahead: s.ahead }),
        });
        this.#send(l);
      } catch (err) {
        if (err instanceof SecretScanError) {
          answer({
            status: 'refused',
            reason: 'secret_found',
            detail: `possible secrets in the changes: ${err.findings
              .slice(0, 3)
              .map((f) => `${f.location} [${f.label}]`)
              .join('; ')}`.slice(0, 300),
          });
        } else if (err instanceof PushRejectedError) {
          answer({
            status: 'failed',
            reason: err.reason === 'stale-lease' ? 'not_fast_forward' : 'rejected',
            detail: err.message.slice(0, 300),
          });
        } else {
          answer({
            status: 'failed',
            reason: 'git_failed',
            detail: (err instanceof Error ? err.message : 'git failed').slice(0, 300),
          });
        }
      }
    });
  }

  async onFile(p: IdeFileRequestPayload): Promise<void> {
    const answer = (r: Omit<IdeFileDataPayload, 'requestId' | 'workspaceId'>): void => {
      void this.#d.channel
        .fileData({ requestId: p.requestId, workspaceId: p.workspaceId, ...r })
        .catch(() => undefined);
    };
    const l = this.#live.get(p.workspaceId);
    const c = l?.rec.checkout ?? null;
    if (c === null) {
      answer({ status: 'not_found' });
      return;
    }
    const base = c.kind === 'repository' ? c.ws.path : c.path;
    try {
      const realBase = await realpath(base);
      const target = await realpath(join(realBase, ...p.path.split('/'))).catch(() => null);
      if (target === null) {
        answer({ status: 'not_found' });
        return;
      }
      if (!isInside(realBase, target) || target === realBase || target.includes(`${sep}.git${sep}`)) {
        answer({ status: 'refused' });
        return;
      }
      const handle = await open(target, 'r');
      try {
        const st = await handle.stat();
        if (!st.isFile()) {
          answer({ status: 'not_found' });
          return;
        }
        if (st.size > IDE_LIMITS.fileMaxBytes) {
          answer({ status: 'too_large' });
          return;
        }
        const buf = Buffer.alloc(st.size);
        await handle.read(buf, 0, st.size, 0);
        if (buf.includes(0)) {
          answer({ status: 'binary' });
          return;
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        answer({ status: 'ok', text: text.slice(0, IDE_LIMITS.fileMaxBytes) });
      } finally {
        await handle.close();
      }
    } catch {
      answer({ status: 'binary' });
    }
  }

  // ============================================================================================= bridge

  /** The bridge extension's calls (wired by the factory into the loopback bridge server). */
  readonly bridgeHandler = {
    reference: async (
      workspaceId: string,
      r: { path: string; startLine: number; endLine: number },
    ): Promise<BridgeAnswer> => {
      if (this.gateway(workspaceId) === null)
        return { status: 'refused', message: 'Çalışma alanı çalışmıyor.' };
      await this.#d.channel.event({
        kind: 'reference',
        workspaceId,
        eventId: randomUUID(),
        at: this.#now().toISOString(),
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
      });
      return { status: 'ok', message: 'Sohbete eklendi.' };
    },
    terminal: async (workspaceId: string, r: { name: string }): Promise<BridgeAnswer> => {
      if (this.gateway(workspaceId) === null)
        return { status: 'refused', message: 'Çalışma alanı çalışmıyor.' };
      await this.#d.channel.event({
        kind: 'terminal.open',
        workspaceId,
        eventId: randomUUID(),
        at: this.#now().toISOString(),
        ...(r.name === '' ? {} : { name: r.name }),
      });
      return { status: 'ok', message: '' };
    },
    settings: (workspaceId: string): Promise<BridgeSettings> => {
      const l = this.#live.get(workspaceId);
      const sync = l === undefined || this.gateway(workspaceId) === null ? null : l.sync;
      return Promise.resolve(sync ?? { sync: false, settings: null, keybindings: null });
    },
    saveSettings: async (
      workspaceId: string,
      r: { file: 'settings' | 'keybindings'; content: string },
    ): Promise<BridgeAnswer> => {
      const l = this.#live.get(workspaceId);
      if (l === undefined || this.gateway(workspaceId) === null)
        return { status: 'refused', message: 'Çalışma alanı çalışmıyor.' };
      if (l.sync === null) return { status: 'refused', message: 'Ayar eşitleme bu oturumda kapalı.' };
      const eventId = randomUUID();
      const notice = this.#awaitNotice(eventId, this.#d.settingsTimeoutMs ?? 30_000);
      try {
        await this.#d.channel.event({
          kind: 'settings',
          workspaceId,
          eventId,
          at: this.#now().toISOString(),
          file: r.file,
          content: r.content,
        });
      } catch {
        this.#pendingPush.delete(eventId);
        return {
          status: 'failed',
          message: 'Ana sunucuya ulaşılamıyor; ayarlar birazdan yeniden denenecek.',
        };
      }
      const n = await notice;
      if (n === null) return { status: 'failed', message: 'Ana sunucu zamanında yanıt vermedi.' };
      if (n.status === 'ok') l.sync = { ...l.sync, [r.file]: r.content };
      return { status: n.status, message: n.message };
    },
    push: async (
      workspaceId: string,
      r: { message: string; pullRequest: boolean },
    ): Promise<BridgeAnswer> => {
      const l = this.#live.get(workspaceId);
      if (l === undefined || this.gateway(workspaceId) === null)
        return { status: 'refused', message: 'Çalışma alanı çalışmıyor.' };
      if (l.rec.spec.source.kind !== 'repository')
        return { status: 'refused', message: 'Bu çalışma alanının deposu yok.' };
      const eventId = randomUUID();
      const notice = this.#awaitNotice(eventId, this.#d.pushTimeoutMs ?? 180_000);
      try {
        await this.#d.channel.event({
          kind: 'push',
          workspaceId,
          eventId,
          at: this.#now().toISOString(),
          message: r.message,
          pullRequest: r.pullRequest,
        });
      } catch {
        this.#pendingPush.delete(eventId);
        return { status: 'failed', message: 'Ana sunucuya ulaşılamıyor; birazdan yeniden deneyin.' };
      }
      const n = await notice;
      if (n === null) return { status: 'failed', message: 'Ana sunucu zamanında yanıt vermedi.' };
      return { status: n.status, message: n.message, ...(n.url === undefined ? {} : { url: n.url }) };
    },
  };

  #awaitNotice(eventId: string, timeoutMs: number): Promise<IdeNoticePayload | null> {
    return new Promise<IdeNoticePayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingPush.delete(eventId);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.#pendingPush.set(eventId, (n) => {
        clearTimeout(timer);
        this.#pendingPush.delete(eventId);
        resolve(n);
      });
    });
  }

  /**
   * Worker shutdown: every IDE stops (ADR-0012 rule 4 — no child left behind); the files and the desired state stay,
   * so the master starts a wanted IDE again after the worker is back.
   */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    if (this.#statusTimer !== null) clearInterval(this.#statusTimer);
    if (this.#watchTimer !== null) clearInterval(this.#watchTimer);
    for (const wake of [...this.#pendingPush.values()])
      wake({ workspaceId: '', eventId: '', status: 'failed', message: 'Makine kapanıyor.' });
    await Promise.allSettled(
      [...this.#live.values()].map(async (l) => {
        if (l.proc === null) return;
        await this.#kill(l);
        l.rec.lastState = 'stopped';
        l.rec.lastDetail = 'the worker is stopping';
        await this.#save(l.rec).catch(() => undefined);
      }),
    );
  }
}

/** One loopback GET: the status code, or null (no answer). */
function loopbackGet(port: number, path: string, cookie?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        timeout: 5_000,
        agent: false,
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => {
      resolve(null);
    });
    req.end();
  });
}

/**
 * Readiness of a started server (launch.ts `readiness`): `readyPath` answers 200, then `anonymousPath` without the secret
 * must be refused with one of `anonymousStatus` — `open` when it is not, i.e. the server would serve anyone on the
 * machine's loopback — and, where given, `authedPath` with the secret must not be refused (`open` too: the secret scheme
 * does not work, so the start fails instead of leaving a login page).
 */
export async function waitIdeReady(
  port: number,
  r: IdeReadiness,
  timeoutMs: number,
): Promise<'ready' | 'open' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await loopbackGet(port, r.readyPath)) === 200) {
      const anonymous = await loopbackGet(port, r.anonymousPath);
      if (anonymous === null || !r.anonymousStatus.includes(anonymous)) return 'open';
      if (r.authedPath === undefined) return 'ready';
      const authed = await loopbackGet(port, r.authedPath, r.cookie);
      return authed === null || authed === 401 || authed === 403 ? 'open' : 'ready';
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return 'timeout';
}

/** W2 readiness of openvscode-server under `basePath` (kept for callers of the W2 signature). */
export function waitServerReady(
  port: number,
  basePath: string,
  timeoutMs: number,
): Promise<'ready' | 'open' | 'timeout'> {
  return waitIdeReady(
    port,
    {
      readyPath: `${basePath}/version`,
      anonymousPath: `${basePath}/`,
      anonymousStatus: [401, 403],
      cookie: '',
    },
    timeoutMs,
  );
}

/**
 * W2b: the platform rule of the IDE sandbox — null when the host runner's confinement may host a long-lived IDE server,
 * else why not. Linux: as W2 (any; bubblewrap when the per-attempt isolation is on). macOS: Seatbelt only. Windows: a
 * per-job account only (as the worker account the IDE — arbitrary code by design — could read the worker's own data
 * dir, its device key included).
 */
export function idePlatformRefusal(
  platform: NodeJS.Platform,
  confinement: string | null,
): { code: IdeUnavailableCode; detail: string } | null {
  if (platform === 'darwin' && confinement !== 'seatbelt')
    return {
      code: 'seatbelt_required',
      detail:
        'macOS: Tam IDE runs only under the Seatbelt sandbox (sandbox-exec), which is not in use on this machine',
    };
  if (platform === 'win32' && confinement !== 'job_user')
    return {
      code: 'windows_accounts_required',
      detail:
        'Windows: Tam IDE runs only as a per-job Windows account; prepare them (Machines > Sandbox & policy > Prepare)',
    };
  return null;
}

/**
 * W2b: the per-OS part of the IDE's sandbox request. Windows: a per-job account held for the whole run (its own
 * attempt id, so two IDEs never share one); elsewhere no job account (as W2). Everywhere: the bridge port reachable
 * (Seatbelt allows only the egress proxy otherwise), Unix sockets under the run dir (VS Code's IPC, code-server's
 * session socket), and the repository mirror read-only (the worktree's git metadata, for the IDE's own git).
 */
export function ideSandboxPlacement(
  platform: NodeJS.Platform,
  workspaceId: string,
  o: { readonly bridgePort: number | null; readonly runDir: string; readonly mirror: string | null },
): {
  attemptId: string;
  jobAccount: boolean;
  loopbackPorts: number[];
  unixSocketDirs: string[];
  readOnlyDirs: string[];
} {
  return {
    attemptId: platform === 'win32' ? SEGMENT(workspaceId) : 'run',
    jobAccount: platform === 'win32',
    loopbackPorts: o.bridgePort === null ? [] : [o.bridgePort],
    unixSocketDirs: [o.runDir],
    readOnlyDirs: o.mirror === null ? [] : [o.mirror],
  };
}

/** The loopback port of the bridge URL (`http://127.0.0.1:<port>/…`), or null. */
function bridgePort(url: string): number | null {
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Kills the process tree the previous worker process left (same boot). POSIX: its process group (the runner starts the
 * server detached). Windows (W2b): the job runner's tree (`taskkill /T /F`; the Job Object then ends the rest).
 */
function killStaleTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => {
        resolve();
      });
    });
  }
  try {
    process.kill(-pid, 0);
    process.kill(-pid, 'SIGKILL');
  } catch {
    // gone / not ours
  }
  return Promise.resolve();
}
