import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, Redactor } from '@remyral/observability';
import {
  type CustomToolInstall,
  type Diagnostics,
  type WorkerDoctorReport,
  type DiskHygieneRun,
  type InspectSection,
  type LeaseKey,
  type MachineInspectReport,
  LOG_LINES_PER_UPDATE,
  type OpsCommandPayload,
  opsCommandWindow,
  type OpsKind,
  type OpsOperation,
  type OpsUpdatePayload,
  type GitFixId,
  type GitFixReport,
  type UsageRefreshReport,
  type RemoteOpsReport,
  type RuntimeKind,
  type RuntimeVerifyReport,
  type CapabilityCheckResult,
  type SignedCapabilityEvidence,
  TERMINAL_OPS_STATES,
  type UnverifiedRuntimeSource,
  type ToolInventoryReport,
  type ToolRecipeId,
  verifyOpsCommand,
} from '@remyral/protocol';
import { ToolRefusal } from '../tools/installer.js';
import { type CodeImagesPort, codeImagesUpdate } from '../functions/code-images.js';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { InstallError } from './fetch.js';
import { InstallRefusal, type RuntimeInstaller } from './installer.js';
import { packLockfile } from '../mcp/lockfile.js';
import { RuntimeVerifyRefusal } from './verify-runtime.js';
import { CapabilityVerifyRefusal } from './verify-capabilities.js';
import type { LoginManager } from './login.js';
import { type FileLog, tailLog } from './logs.js';
import type { ServiceInfo } from './service-control.js';

/**
 * Worker side of remote operations (p5-remote-ops, ADR-0017): verifies each OPS_COMMAND, runs it and reports
 * OPS_UPDATE. Never trusts the command beyond its schema — signature (pinned `masterLeaseKeys`, else the
 * session's keys), validity window, replay, local opt-outs (`remoteOps.disabled`), and the installer's own
 * pinned-set / downgrade rules all apply here.
 */

export type OpsGroup = 'install' | 'login' | 'restart' | 'logs' | 'diagnostics' | 'sandbox' | 'verify';

const GROUP: Readonly<Record<OpsKind, OpsGroup | null>> = {
  'runtime.install': 'install',
  // p16-runtime-updates: a verification run installs into a scratch dir (an install; `remoteOps.disabled: [install]`).
  'runtime.verify': 'install',
  'runtime.remove': 'install',
  // p17-runtime-verify: a capability verification runs the agent with the machine's auth and spends tokens — its own
  // group, so a machine owner can refuse it locally (`remoteOps.disabled: [verify]`).
  'runtime.capabilities.verify': 'verify',
  'runtime.restart': 'restart',
  'login.start': 'login',
  'login.input': 'login',
  'login.status': 'login',
  'login.logout': 'login',
  'ops.cancel': null,
  'service.restart': 'restart',
  'logs.tail': 'logs',
  'diagnostics.run': 'diagnostics',
  'sandbox.prepare': 'sandbox',
  // p5-machine-admin: tool installs are installs; detection and inspection are read-only diagnostics.
  'tools.detect': 'diagnostics',
  'tool.install': 'install',
  'tool.remove': 'install',
  'machine.inspect': 'diagnostics',
  // p13-fleet-tools: custom installs are installs (a local `remoteOps.disabled: [install]` refuses them too).
  'tool.install.custom': 'install',
  'tool.remove.custom': 'install',
  // p14-mcp-core: tool discovery of a remote MCP server (a read; a local `remoteOps.disabled: [diagnostics]` refuses it).
  'mcp.probe': 'diagnostics',
  // p14-mcp-stdio: installing / removing a local MCP server package is an install (`remoteOps.disabled: [install]`).
  'mcp.install': 'install',
  'mcp.remove': 'install',
  // p14-code-images: pulling the pinned bases and building the code node images is an install.
  'code.images.prepare': 'install',
  // p15-git-central: fixing the worker account's git setup prepares the machine (`remoteOps.disabled: [sandbox]`).
  'git.fix': 'sandbox',
  // p15-usage-refresh: reading the usage windows is a read-only probe (`remoteOps.disabled: [diagnostics]` refuses it).
  'usage.refresh': 'diagnostics',
  // p16-doctor: the machine's doctor is a read-only check (`remoteOps.disabled: [diagnostics]` refuses it).
  'doctor.run': 'diagnostics',
  // p17-disk-selfclean: removing what the worker installed and cached is an install change (`remoteOps.disabled: [install]`).
  'disk.clean': 'install',
  // p17-worker-managed: removing the worker stops its service for good (`remoteOps.disabled: [restart]` refuses it);
  // installing / removing the machine-admin helper changes the machine's privileged setup (`[sandbox]` refuses it).
  'worker.uninstall': 'restart',
  'helper.manage': 'sandbox',
};

/** p5-machine-admin: the tool inventory, recipe installs and read-only inspection. */
export interface ToolsPort {
  report(): Promise<ToolInventoryReport>;
  detect(): Promise<ToolInventoryReport>;
  install(
    tool: ToolRecipeId,
    version: string,
    opts: {
      signal: AbortSignal;
      progress: (step: string, done?: number, total?: number) => void;
      /** p17-update-channel (owner upgrade): the asset of a version outside the recipes. */
      asset?: { url: string; sha256: string; size: number; build?: string | undefined };
    },
  ): Promise<{ version: string }>;
  remove(tool: ToolRecipeId, version: string): Promise<void>;
  /** p13-fleet-tools (ADR-0052): an admin-defined download (absent: refused `unsupported`). */
  readonly installCustom?: (
    spec: CustomToolInstall,
    opts: { signal: AbortSignal; progress: (step: string, done?: number, total?: number) => void },
  ) => Promise<{ version: string }>;
  readonly removeCustom?: (name: string, version: string) => Promise<void>;
  inspect(sections: readonly InspectSection[]): Promise<MachineInspectReport>;
}

const LOG_CHUNK_BYTES = 64 * 1024;
const SEEN_FILE = 'remote-ops-seen.json';
/** How long a finished command's last update is kept for re-sending after a reconnect. */
const KEEP_LAST_MS = 30 * 60_000;
/** p14-login-status-consistency: the longest a login operation's result waits for the runtime's re-probe. */
const REPROBE_WAIT_MS = 20_000;

export interface RemoteOpsDeps {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly installer: RuntimeInstaller;
  readonly login: LoginManager;
  readonly log: FileLog | null;
  /**
   * p6-worker-boot-diagnostics: the other log files `logs.tail` may read (`source: boot | updater`), fixed paths
   * from the config / install layout; null = not available on this machine.
   */
  readonly logSources?: { readonly boot: string | null; readonly updater: string | null };
  /** The logger's redactor (exact registered secrets + patterns). */
  readonly redactor: Pick<Redactor, 'redact'>;
  readonly logger: Logger;
  readonly keySource: () => { keys: readonly LeaseKey[]; pinned: boolean };
  readonly disabled: readonly OpsGroup[];
  readonly service: ServiceInfo;
  /**
   * Drain (optionally) and exit for the service manager. Resolves `restarting` once the exit is scheduled,
   * `drain_timeout` when jobs were still running at the deadline (the worker then accepts jobs again).
   */
  readonly restart: (drain: boolean, timeoutSec: number) => Promise<'restarting' | 'drain_timeout'>;
  /** Rebuild the runtime's adapter and re-probe it; returns the new probe's summary. */
  readonly restartRuntime: (runtime: RuntimeKind) => Promise<{ ok: boolean; detail?: string }>;
  /** Whether a job of `runtime` is running now (removal / repair of the active version waits). */
  readonly runtimeInUse: (runtime: RuntimeKind) => boolean;
  readonly diagnostics: () => Promise<Diagnostics>;
  /** p16-doctor: the machine's doctor for `doctor.run` (absent: refused). */
  readonly doctor?: () => Promise<WorkerDoctorReport>;
  /** p17-disk-selfclean: the disk hygiene run for `disk.clean` (absent: refused `unsupported`). */
  readonly diskClean?: () => Promise<DiskHygieneRun>;
  /** Installed / removed / logged in: CAPABILITIES should be re-sent. */
  readonly changed: () => void;
  /**
   * p14-login-status-consistency: re-probe `runtime` now (bypassing the registry's probe cache), so the CAPABILITIES
   * that `changed()` sends after a login / status check / logout carry the fresh `authenticated` state instead of a
   * cached probe from before the operation. Absent: no re-probe (tests, older wiring).
   */
  readonly reprobe?: (runtime: RuntimeKind) => Promise<void>;
  /** p5-sandbox-ops: runs `sandbox.prepare` (absent: refused `unsupported`). */
  readonly prepareSandbox?: (
    workerId: string,
    cmd: OpsCommandPayload,
    emit: (u: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>) => void,
  ) => Promise<void>;
  /**
   * p17-worker-managed: `worker.uninstall` / `helper.manage` through the privileged helper (absent: refused
   * `unsupported`).
   */
  readonly manage?: (
    workerId: string,
    cmd: OpsCommandPayload,
    emit: (u: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>) => void,
  ) => Promise<void>;
  /** p5-machine-admin: tools (absent: the tool operations are refused `unsupported`). */
  readonly tools?: ToolsPort;
  /** p14-mcp-core: runs `mcp.probe` (absent: refused `unsupported`). */
  readonly mcpProbe?: (
    op: Extract<OpsOperation, { kind: 'mcp.probe' }>,
    signal: AbortSignal,
  ) => Promise<
    | { readonly state: 'succeeded'; readonly report: NonNullable<OpsUpdatePayload['mcpProbe']> }
    | { readonly state: 'refused' | 'failed'; readonly reason: string; readonly detail: string }
  >;
  /**
   * p14-mcp-stdio: `mcp.install` / `mcp.remove` (absent: refused `unsupported`). `install` verifies the signed spec
   * itself, reports progress steps and returns the install report, or a refusal / failure with a stable reason.
   */
  readonly mcpInstall?: {
    install(
      op: Extract<OpsOperation, { kind: 'mcp.install' }>,
      opts: { readonly signal: AbortSignal; readonly progress: (step: string) => void },
    ): Promise<McpInstallOutcome>;
    remove(op: Extract<OpsOperation, { kind: 'mcp.remove' }>): Promise<McpInstallOutcome>;
  };
  /** p14-code-images: builds the code node images (absent: no container engine configured → refused). */
  readonly codeImages?: CodeImagesPort;
  /** p15-git-central: the worker account's git readiness and its safe fixes (absent: `git.fix` refused). */
  readonly gitFix?: (fixes: readonly GitFixId[]) => Promise<GitFixReport>;
  /**
   * p15-usage-refresh: read the subscription logins' usage windows now (`usage.refresh`; absent: refused `unsupported`).
   */
  readonly usageRefresh?: (filter: {
    readonly runtime?: RuntimeKind;
    readonly account?: string;
  }) => Promise<UsageRefreshReport>;
  /**
   * p16-runtime-updates: the automatable verification checks of a candidate version (`runtime.verify`; absent: refused
   * `unsupported`). Throws RuntimeVerifyRefusal before anything was installed.
   */
  readonly verifyRuntime?: (
    op: Extract<OpsOperation, { kind: 'runtime.verify' }>,
    opts: {
      readonly signal: AbortSignal;
      readonly progress: (step: string, done?: number, total?: number) => void;
    },
  ) => Promise<RuntimeVerifyReport>;
  /**
   * p17-runtime-verify: the capability scenario set through the real adapter (`runtime.capabilities.verify`; absent:
   * refused `unsupported`). Resolves with the signed evidence; throws CapabilityVerifyRefusal before anything ran.
   */
  readonly verifyCapabilities?: (
    commandId: string,
    op: Extract<OpsOperation, { kind: 'runtime.capabilities.verify' }>,
    opts: {
      readonly signal: AbortSignal;
      readonly progress: (step: string, results: readonly CapabilityCheckResult[]) => void;
    },
  ) => Promise<SignedCapabilityEvidence>;
  readonly clock?: () => Date;
}

/** The result of an `mcp.install` / `mcp.remove` (p14-mcp-stdio). */
export type McpInstallOutcome =
  | {
      readonly state: 'succeeded';
      readonly report?: NonNullable<OpsUpdatePayload['mcpInstall']>;
      readonly detail: string;
    }
  | {
      readonly state: 'refused' | 'failed' | 'cancelled';
      readonly reason: string;
      readonly detail: string;
    };

type Emit = (u: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>) => void;

interface Tracked {
  readonly kind: OpsKind;
  seq: number;
  last: OpsUpdatePayload | null;
  finishedAt: number | null;
  abort: AbortController | null;
}

export class RemoteOpsAgent {
  readonly #d: RemoteOpsDeps;
  readonly #log: Logger;
  #send: ((p: OpsUpdatePayload) => Promise<void>) | null = null;
  readonly #commands = new Map<string, Tracked>();
  /** commandId → expiry (ms): replay protection, persisted so a restart cannot re-run a command. */
  #seen = new Map<string, number>();

  private constructor(d: RemoteOpsDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'remote-ops' });
  }

  static async open(d: RemoteOpsDeps): Promise<RemoteOpsAgent> {
    const a = new RemoteOpsAgent(d);
    try {
      const raw = JSON.parse(await readFile(join(d.dataDir, SEEN_FILE), 'utf8')) as Record<string, number>;
      const now = a.#now();
      for (const [id, exp] of Object.entries(raw))
        if (typeof exp === 'number' && exp > now) a.#seen.set(id, exp);
    } catch {
      // none yet
    }
    return a;
  }

  #now(): number {
    return (this.#d.clock?.() ?? new Date()).getTime();
  }

  /** Where OPS_UPDATE goes (the daemon's control channel). */
  attach(send: (p: OpsUpdatePayload) => Promise<void>): void {
    this.#send = send;
  }

  /** After a reconnect: the last update of every recent command (a result may have been lost). */
  onSessionEstablished(): void {
    const now = this.#now();
    for (const [id, t] of this.#commands) {
      if (t.finishedAt !== null && now - t.finishedAt > KEEP_LAST_MS) {
        this.#commands.delete(id);
        continue;
      }
      if (t.last !== null) void this.#deliver(t.last);
    }
  }

  async report(): Promise<RemoteOpsReport> {
    const active =
      this.#d.login.active() ??
      [...this.#commands.entries()].find(
        ([, t]) => t.finishedAt === null && t.kind === 'runtime.install',
      )?.[0];
    return {
      runtimes: await this.#d.installer.report(),
      login: this.#d.login.report(),
      service: { manager: this.#d.service.manager, restartable: this.#d.service.restartable },
      logs: { available: this.#d.log?.available() ?? false, bytes: this.#d.log?.bytes() ?? 0 },
      ...(active === undefined ? {} : { activeCommand: active }),
    };
  }

  async #deliver(p: OpsUpdatePayload): Promise<void> {
    try {
      await this.#send?.(p);
    } catch (err) {
      this.#log.debug('OPS_UPDATE not sent (no session); kept for re-send', { commandId: p.commandId, err });
    }
  }

  #emitter(commandId: string, kind: OpsKind): Emit {
    const t: Tracked = this.#commands.get(commandId) ?? {
      kind,
      seq: 0,
      last: null,
      finishedAt: null,
      abort: null,
    };
    this.#commands.set(commandId, t);
    return (u) => {
      t.seq += 1;
      const payload: OpsUpdatePayload = { commandId, seq: t.seq, kind, ...u };
      if (TERMINAL_OPS_STATES.has(u.state)) t.finishedAt = this.#now();
      // Log chunks are not kept for re-send (bounded memory); the terminal state is.
      if (u.logs === undefined || TERMINAL_OPS_STATES.has(u.state)) t.last = payload;
      void this.#deliver(payload);
    };
  }

  async #remember(commandId: string, expiresAtMs: number): Promise<void> {
    const now = this.#now();
    for (const [id, exp] of this.#seen) if (exp <= now) this.#seen.delete(id);
    this.#seen.set(commandId, expiresAtMs);
    await atomicWriteFile(
      this.#d.ops,
      join(this.#d.dataDir, SEEN_FILE),
      JSON.stringify(Object.fromEntries(this.#seen)),
      { mode: 0o600 },
    ).catch((err: unknown) => {
      this.#log.warn('could not persist remote-ops replay state', { err });
    });
  }

  /**
   * Handles one OPS_COMMAND. Never throws: every outcome is an OPS_UPDATE (`refused` before anything ran,
   * `failed` / `succeeded` / `cancelled` after).
   */
  async onCommand(workerId: string | null, p: OpsCommandPayload): Promise<void> {
    const kind = p.op.kind;
    const emit = this.#emitter(p.commandId, kind);
    const refuse = (reason: string, detail?: string) => {
      this.#log.warn('remote operation refused', { commandId: p.commandId, kind, reason });
      emit({ state: 'refused', reason, ...(detail === undefined ? {} : { detail: detail.slice(0, 300) }) });
    };
    if (workerId === null) {
      refuse('not_enrolled');
      return;
    }
    const window = opsCommandWindow(p, this.#d.clock?.() ?? new Date());
    if (window !== 'ok') {
      refuse(window);
      return;
    }
    if (this.#seen.has(p.commandId)) {
      this.#log.warn('remote operation replayed; ignored', { commandId: p.commandId, kind });
      return; // never re-run, never answer (the original answer stands)
    }
    const { keys, pinned } = this.#d.keySource();
    const verdict = verifyOpsCommand(
      { workerId, commandId: p.commandId, issuedAt: p.issuedAt, expiresAt: p.expiresAt, op: p.op },
      p.signature,
      keys,
    );
    if (verdict !== 'ok') {
      if (keys.length > 0 || pinned) {
        refuse(verdict === 'missing' ? 'unsigned' : 'bad_signature');
        return;
      }
      this.#log.warn(
        'remote operation without a verifiable signature accepted: the master has no lease key',
        {
          commandId: p.commandId,
          kind,
        },
      );
    }
    const group = GROUP[kind];
    if (group !== null && this.#d.disabled.includes(group)) {
      refuse('disabled_locally', `remote ${group} is disabled in this worker's local config`);
      return;
    }
    await this.#remember(p.commandId, Date.parse(p.expiresAt) + 5 * 60_000);
    this.#log.info('remote operation accepted', { commandId: p.commandId, kind });
    try {
      if (p.op.kind === 'sandbox.prepare') {
        if (this.#d.prepareSandbox === undefined) emit({ state: 'refused', reason: 'unsupported' });
        else await this.#d.prepareSandbox(workerId, p, emit);
      } else if (p.op.kind === 'worker.uninstall' || p.op.kind === 'helper.manage') {
        if (this.#d.manage === undefined) emit({ state: 'refused', reason: 'unsupported' });
        else await this.#d.manage(workerId, p, emit);
      } else {
        await this.#run(p.commandId, p.op, emit);
      }
    } catch (err) {
      this.#log.error('remote operation failed unexpectedly', { commandId: p.commandId, kind, err });
      emit({ state: 'failed', reason: 'internal', detail: 'unexpected error on the worker (see its log)' });
    }
  }

  /**
   * p14-login-status-consistency: a login of `runtime` changed or was checked — the configured login (`default`) is
   * what the runtime's probe reads, so that probe is redone (bounded) before CAPABILITIES are re-sent; an added account
   * only changes the login report, which `changed()` re-sends anyway. Never throws.
   */
  async #loginChanged(runtime: RuntimeKind, account: string | undefined): Promise<void> {
    if (this.#d.reprobe !== undefined && (account === undefined || account === 'default')) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#d.reprobe(runtime),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, REPROBE_WAIT_MS);
          }),
        ]);
      } catch (err) {
        this.#log.warn('runtime re-probe after a login operation failed', { runtime, err });
      } finally {
        clearTimeout(timer);
      }
    }
    this.#d.changed();
  }

  async #run(commandId: string, op: OpsOperation, emit: Emit): Promise<void> {
    switch (op.kind) {
      case 'runtime.install':
        return this.#install(commandId, op.runtime, op.version, emit, op.unverified);
      case 'runtime.verify':
        return this.#verify(commandId, op, emit);
      case 'runtime.capabilities.verify':
        return this.#verifyCapabilities(commandId, op, emit);
      case 'runtime.remove': {
        const active = this.#d.installer.activeVersion(op.runtime);
        if (active === op.version && this.#d.runtimeInUse(op.runtime)) {
          emit({ state: 'refused', reason: 'runtime_in_use', detail: `${op.runtime} jobs are running` });
          return;
        }
        try {
          await this.#d.installer.remove(op.runtime, op.version);
        } catch (err) {
          if (err instanceof InstallRefusal) {
            emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
            return;
          }
          throw err;
        }
        await this.#d.restartRuntime(op.runtime).catch(() => undefined);
        this.#d.changed();
        emit({ state: 'succeeded', runtime: await this.#runtimeReport(op.runtime) });
        return;
      }
      case 'runtime.restart': {
        emit({ state: 'running' });
        await this.#d.installer.verify(op.runtime);
        const r = await this.#d.restartRuntime(op.runtime);
        this.#d.changed();
        emit({
          state: r.ok ? 'succeeded' : 'failed',
          ...(r.ok ? {} : { reason: 'runtime_unavailable' }),
          ...(r.detail === undefined ? {} : { detail: this.#d.redactor.redact(r.detail).slice(0, 300) }),
          runtime: await this.#runtimeReport(op.runtime),
        });
        return;
      }
      case 'login.start':
        // p13-runtime-accounts: `account` = an added account's own config dir (refused when unknown here).
        // p14-login-status-consistency: on success the runtime is re-probed and CAPABILITIES re-sent before the
        // result goes out, so the panel's next compatibility read already shows the new login.
        await this.#d.login.start(
          commandId,
          op.runtime,
          (u) => {
            if (u.state !== 'succeeded') {
              emit(u);
              return;
            }
            void this.#loginChanged(op.runtime, op.account).finally(() => {
              emit(u);
            });
          },
          op.account,
        );
        return;
      case 'login.input': {
        const r = this.#d.login.input(op.target, op.code);
        emit(
          r === 'ok'
            ? { state: 'succeeded' }
            : { state: 'refused', reason: r === 'not_found' ? 'login_not_found' : 'login_not_waiting' },
        );
        return;
      }
      case 'login.status': {
        // p10-claude-login-health: a flagged login is verified with a real request; usable clears the flag.
        const s = await this.#d.login.check(op.runtime, op.account);
        await this.#loginChanged(op.runtime, op.account);
        if (s.reason === 'account_unknown') {
          emit({
            state: 'refused',
            reason: 'account_unknown',
            detail: 'no such runtime account on this worker',
          });
          return;
        }
        emit({
          state: 'succeeded',
          login: {
            runtime: op.runtime,
            ...(op.account === undefined ? {} : { account: op.account }),
            expectsCode: false,
            status: s.status,
            ...(s.reason === undefined ? {} : { reason: s.reason }),
          },
        });
        return;
      }
      case 'login.logout': {
        const s = await this.#d.login.logout(op.runtime, op.account);
        await this.#loginChanged(op.runtime, op.account);
        if (s.reason === 'account_unknown') {
          emit({
            state: 'refused',
            reason: 'account_unknown',
            detail: 'no such runtime account on this worker',
          });
          return;
        }
        emit({
          state: s.status === 'logged_out' ? 'succeeded' : 'failed',
          ...(s.status === 'logged_out' ? {} : { reason: 'logout_not_confirmed' }),
          login: {
            runtime: op.runtime,
            ...(op.account === undefined ? {} : { account: op.account }),
            expectsCode: false,
            status: s.status,
          },
        });
        return;
      }
      case 'ops.cancel': {
        const t = this.#commands.get(op.target);
        const cancelled =
          this.#d.login.cancel(op.target) ||
          (t?.abort !== null && t?.abort !== undefined && t.finishedAt === null && (t.abort.abort(), true));
        emit(cancelled ? { state: 'succeeded' } : { state: 'refused', reason: 'not_running' });
        return;
      }
      case 'service.restart': {
        if (!this.#d.service.restartable) {
          emit({
            state: 'refused',
            reason: 'not_restartable',
            detail: 'the worker is not running under its service manager',
          });
          return;
        }
        emit({ state: 'running', progress: { step: op.drain ? 'drain' : 'stop' } });
        const r = await this.#d.restart(op.drain, op.drainTimeoutSec);
        emit(
          r === 'restarting'
            ? { state: 'succeeded', detail: 'restarting now' }
            : { state: 'failed', reason: 'drain_timeout', detail: 'jobs were still running at the deadline' },
        );
        return;
      }
      case 'logs.tail': {
        const source = op.source ?? 'worker';
        const path =
          source === 'worker'
            ? this.#d.log?.available() === true
              ? this.#d.log.path
              : null
            : (this.#d.logSources?.[source] ?? null);
        if (path === null || !existsSync(path)) {
          emit({
            state: 'failed',
            reason: 'logs_unavailable',
            detail: `no ${source} log file on this machine`,
          });
          return;
        }
        const { lines, truncated } = await tailLog({ path }, this.#d.redactor, {
          lines: op.lines,
          maxBytes: op.maxBytes,
        });
        const chunks: string[][] = [];
        let cur: string[] = [];
        let bytes = 0;
        for (const line of lines) {
          const b = Buffer.byteLength(line) + 8;
          if (cur.length >= LOG_LINES_PER_UPDATE || (bytes + b > LOG_CHUNK_BYTES && cur.length > 0)) {
            chunks.push(cur);
            cur = [];
            bytes = 0;
          }
          cur.push(line);
          bytes += b;
        }
        if (cur.length > 0 || chunks.length === 0) chunks.push(cur);
        chunks.forEach((c, i) => {
          const last = i === chunks.length - 1;
          emit({
            state: last ? 'succeeded' : 'running',
            logs: { lines: c, truncated, redacted: true, last },
          });
        });
        return;
      }
      case 'usage.refresh': {
        const refresh = this.#d.usageRefresh;
        if (refresh === undefined) {
          emit({
            state: 'refused',
            reason: 'unsupported',
            detail: 'this worker build cannot read usage windows now',
          });
          return;
        }
        emit({ state: 'running', progress: { step: 'usage_probe' } });
        const report = await refresh({
          ...(op.runtime === undefined ? {} : { runtime: op.runtime }),
          ...(op.account === undefined ? {} : { account: op.account }),
        });
        const read = report.results.filter((r) => r.outcome === 'read').length;
        const failed = report.results.filter((r) => r.outcome === 'failed').length;
        emit({
          state: failed > 0 && read === 0 ? 'failed' : 'succeeded',
          ...(failed > 0 && read === 0 ? { reason: 'usage_probe_failed' } : {}),
          detail: `${String(read)} read, ${String(failed)} failed, ${String(report.results.length - read - failed)} without a probe`,
          usageRefresh: report,
        });
        return;
      }
      case 'diagnostics.run': {
        emit({ state: 'running' });
        emit({ state: 'succeeded', diagnostics: await this.#d.diagnostics() });
        return;
      }
      case 'doctor.run': {
        const doctor = this.#d.doctor;
        if (doctor === undefined) {
          emit({ state: 'refused', reason: 'not_supported' });
          return;
        }
        emit({ state: 'running' });
        emit({ state: 'succeeded', doctor: await doctor() });
        return;
      }
      case 'disk.clean': {
        const clean = this.#d.diskClean;
        if (clean === undefined) {
          emit({ state: 'refused', reason: 'unsupported', detail: 'this worker build has no disk hygiene' });
          return;
        }
        emit({ state: 'running', progress: { step: 'clean' } });
        const run = await clean();
        emit({ state: 'succeeded', diskClean: run });
        return;
      }
      case 'sandbox.prepare':
      case 'worker.uninstall':
      case 'helper.manage':
        return; // handled in onCommand (needs the signed command itself)
      case 'tools.detect':
      case 'tool.install':
      case 'tool.remove':
      case 'machine.inspect':
      case 'tool.install.custom':
      case 'tool.remove.custom':
        return this.#tools(commandId, op, emit);
      case 'mcp.probe': {
        if (this.#d.mcpProbe === undefined) {
          emit({ state: 'refused', reason: 'unsupported', detail: 'this worker build has no MCP support' });
          return;
        }
        // No `running` first: a verification or secret refusal is a `refused` (nothing was contacted).
        const out = await this.#d.mcpProbe(op, new AbortController().signal);
        if (out.state === 'succeeded') emit({ state: 'succeeded', mcpProbe: out.report });
        else emit({ state: out.state, reason: out.reason, detail: out.detail.slice(0, 300) });
        return;
      }
      case 'mcp.install':
      case 'mcp.remove': {
        const port = this.#d.mcpInstall;
        if (port === undefined) {
          emit({
            state: 'refused',
            reason: 'unsupported',
            detail: 'this worker build runs no local MCP servers (mcp-stdio-v1)',
          });
          return;
        }
        if (op.kind === 'mcp.remove') {
          const out = await port.remove(op);
          if (out.state === 'succeeded') this.#d.changed();
          emit(
            out.state === 'succeeded'
              ? { state: 'succeeded', detail: out.detail.slice(0, 300) }
              : {
                  state: out.state,
                  reason: out.reason,
                  detail: this.#d.redactor.redact(out.detail).slice(0, 300),
                },
          );
          return;
        }
        const t = this.#commands.get(commandId);
        const abort = new AbortController();
        if (t !== undefined) t.abort = abort;
        emit({ state: 'accepted' });
        try {
          const out = await port.install(op, {
            signal: abort.signal,
            progress: (step) => {
              if (/^[a-z_]{1,32}$/.test(step)) emit({ state: 'running', progress: { step } });
            },
          });
          if (out.state === 'succeeded') {
            this.#d.changed();
            emit({
              state: 'succeeded',
              detail: out.detail.slice(0, 300),
              ...(out.report === undefined ? {} : { mcpInstall: out.report }),
            });
          } else {
            emit({
              state: out.state,
              reason: out.reason,
              detail: this.#d.redactor.redact(out.detail).slice(0, 300),
            });
          }
        } finally {
          if (t !== undefined) t.abort = null;
        }
        return;
      }
      case 'code.images.prepare': {
        const port = this.#d.codeImages;
        if (port === undefined) {
          emit({
            state: 'refused',
            reason: 'unsupported',
            detail: 'this worker has no container engine configured for code nodes (sandbox.container)',
          });
          return;
        }
        const t = this.#commands.get(commandId);
        const abort = new AbortController();
        if (t !== undefined) t.abort = abort;
        emit({ state: 'accepted' });
        try {
          const out = await port.prepare({
            signal: abort.signal,
            progress: (step, done, total) => {
              emit({
                state: 'running',
                progress: {
                  step,
                  ...(done === undefined ? {} : { done }),
                  ...(total === undefined ? {} : { total }),
                },
              });
            },
          });
          if (out.state === 'succeeded') this.#d.changed();
          const u = codeImagesUpdate(out);
          emit({ ...u, ...(u.detail === undefined ? {} : { detail: this.#d.redactor.redact(u.detail) }) });
        } finally {
          if (t !== undefined) t.abort = null;
        }
        return;
      }
      case 'git.fix': {
        const fix = this.#d.gitFix;
        if (fix === undefined) {
          emit({
            state: 'refused',
            reason: 'unsupported',
            detail: 'this worker build cannot fix its git setup',
          });
          return;
        }
        emit({ state: 'running', progress: { step: 'git_fix' } });
        const report = await fix(op.fixes);
        this.#d.changed();
        const failed = report.results.some((r) => r.outcome === 'failed');
        emit({
          state: failed ? 'failed' : 'succeeded',
          ...(failed ? { reason: 'git_fix_incomplete' } : {}),
          gitFix: report,
        });
        return;
      }
    }
  }

  async #tools(
    commandId: string,
    op: Extract<
      OpsOperation,
      {
        kind:
          | 'tools.detect'
          | 'tool.install'
          | 'tool.remove'
          | 'machine.inspect'
          | 'tool.install.custom'
          | 'tool.remove.custom';
      }
    >,
    emit: Emit,
  ): Promise<void> {
    const tools = this.#d.tools;
    if (tools === undefined) {
      emit({ state: 'refused', reason: 'unsupported', detail: 'this worker build has no tool support' });
      return;
    }
    switch (op.kind) {
      case 'tools.detect': {
        emit({ state: 'running' });
        const report = await tools.detect();
        this.#d.changed();
        emit({ state: 'succeeded', tools: report });
        return;
      }
      case 'machine.inspect': {
        emit({ state: 'running' });
        emit({ state: 'succeeded', inspect: await tools.inspect(op.sections) });
        return;
      }
      case 'tool.remove.custom': {
        if (tools.removeCustom === undefined) {
          emit({ state: 'refused', reason: 'unsupported', detail: 'this worker build has no custom tools' });
          return;
        }
        try {
          await tools.removeCustom(op.name, op.version);
        } catch (err) {
          if (err instanceof ToolRefusal) {
            emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
            return;
          }
          throw err;
        }
        const report = await tools.detect();
        this.#d.changed();
        emit({ state: 'succeeded', tools: report });
        return;
      }
      case 'tool.remove': {
        try {
          await tools.remove(op.tool, op.version);
        } catch (err) {
          if (err instanceof ToolRefusal) {
            emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
            return;
          }
          throw err;
        }
        const report = await tools.detect();
        this.#d.changed();
        emit({ state: 'succeeded', tools: report });
        return;
      }
      case 'tool.install':
      case 'tool.install.custom': {
        const installCustom = tools.installCustom;
        if (op.kind === 'tool.install.custom' && installCustom === undefined) {
          emit({ state: 'refused', reason: 'unsupported', detail: 'this worker build has no custom tools' });
          return;
        }
        const t = this.#commands.get(commandId);
        const abort = new AbortController();
        if (t !== undefined) t.abort = abort;
        emit({ state: 'accepted' });
        let lastProgressAt = 0;
        try {
          const progressOpts = {
            signal: abort.signal,
            progress: (step: string, done?: number, total?: number) => {
              const now = Date.now();
              if (now - lastProgressAt < 1000 && done !== total) return;
              lastProgressAt = now;
              emit({
                state: 'running',
                progress: {
                  step,
                  ...(done === undefined ? {} : { done }),
                  ...(total === undefined ? {} : { total }),
                },
              });
            },
          };
          const what = op.kind === 'tool.install' ? op.tool : op.recipe.name;
          const r =
            op.kind === 'tool.install'
              ? await tools.install(op.tool, op.version, {
                  ...progressOpts,
                  ...(op.asset === undefined ? {} : { asset: op.asset }),
                })
              : await (installCustom as NonNullable<ToolsPort['installCustom']>)(op.recipe, progressOpts);
          const report = await tools.detect();
          this.#d.changed();
          emit({ state: 'succeeded', detail: `installed ${what} ${r.version}`, tools: report });
        } catch (err) {
          if (err instanceof ToolRefusal) {
            emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
            return;
          }
          if (err instanceof InstallError) {
            emit({
              state: err.reason === 'cancelled' ? 'cancelled' : 'failed',
              reason: err.reason,
              detail: this.#d.redactor.redact(err.message).slice(0, 300),
            });
            return;
          }
          throw err;
        } finally {
          if (t !== undefined) t.abort = null;
        }
        return;
      }
    }
  }

  async #runtimeReport(runtime: RuntimeKind) {
    return (await this.#d.installer.report()).find((r) => r.runtime === runtime);
  }

  /** Progress callback for a long command: at most ~4 updates per second (lockfiles have hundreds of packages). */
  #progress(emit: Emit): (step: string, done?: number, total?: number) => void {
    let lastProgressAt = 0;
    return (step, done, total) => {
      const now = Date.now();
      if (now - lastProgressAt < 250 && done !== total) return;
      lastProgressAt = now;
      emit({
        state: 'running',
        progress: {
          step,
          ...(done === undefined ? {} : { done }),
          ...(total === undefined ? {} : { total }),
        },
      });
    };
  }

  /**
   * p17-runtime-verify: `runtime.capabilities.verify` — the capability scenarios through the real adapter; progress
   * updates carry the results so far, the final one the evidence signed by the device key.
   */
  async #verifyCapabilities(
    commandId: string,
    op: Extract<OpsOperation, { kind: 'runtime.capabilities.verify' }>,
    emit: Emit,
  ): Promise<void> {
    if (this.#d.verifyCapabilities === undefined) {
      emit({
        state: 'refused',
        reason: 'unsupported',
        detail: 'this worker cannot verify runtime capabilities',
      });
      return;
    }
    const t = this.#commands.get(commandId);
    const abort = new AbortController();
    if (t !== undefined) t.abort = abort;
    emit({ state: 'accepted' });
    try {
      const signed = await this.#d.verifyCapabilities(commandId, op, {
        signal: abort.signal,
        progress: (step, results) => {
          emit({
            state: 'running',
            progress: { step: step.replace(/[^a-z_]/g, '_').slice(0, 32) || 'running' },
            capabilityVerify: { final: false, results: [...results] },
          });
        },
      });
      const e = signed.evidence;
      const passed = e.results.filter((r) => r.status === 'passed').length;
      const failed = e.results.filter((r) => r.status === 'failed').length;
      emit({
        state: e.stoppedBy === 'cancelled' ? 'cancelled' : 'succeeded',
        ...(e.stoppedBy === 'cancelled' ? { reason: 'cancelled' } : {}),
        detail: `${op.runtime} ${op.version}: ${String(passed)} passed, ${String(failed)} failed${
          e.stoppedBy === undefined || e.stoppedBy === 'cancelled' ? '' : ` (stopped: ${e.stoppedBy})`
        }`,
        capabilityVerify: { final: true, signed },
      });
    } catch (err) {
      if (err instanceof CapabilityVerifyRefusal) {
        emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
        return;
      }
      throw err;
    } finally {
      if (t !== undefined) t.abort = null;
    }
  }

  /** p16-runtime-updates: `runtime.verify` — the automatable checks in a scratch dir (never the active install). */
  async #verify(
    commandId: string,
    op: Extract<OpsOperation, { kind: 'runtime.verify' }>,
    emit: Emit,
  ): Promise<void> {
    if (this.#d.verifyRuntime === undefined) {
      emit({ state: 'refused', reason: 'unsupported', detail: 'this worker cannot verify runtime versions' });
      return;
    }
    const t = this.#commands.get(commandId);
    const abort = new AbortController();
    if (t !== undefined) t.abort = abort;
    emit({ state: 'accepted' });
    try {
      const report = await this.#d.verifyRuntime(op, {
        signal: abort.signal,
        progress: this.#progress(emit),
      });
      emit({
        state: 'succeeded',
        detail: `${op.runtime} ${op.version}: ${report.passed ? 'automatable checks passed' : 'a required check failed'}`,
        runtimeVerify: report,
      });
    } catch (err) {
      if (err instanceof RuntimeVerifyRefusal) {
        emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
        return;
      }
      if (err instanceof InstallError && err.reason === 'cancelled') {
        emit({ state: 'cancelled', reason: 'cancelled' });
        return;
      }
      throw err;
    } finally {
      if (t !== undefined) t.abort = null;
    }
  }

  async #install(
    commandId: string,
    runtime: RuntimeKind,
    version: string,
    emit: Emit,
    unverified?: UnverifiedRuntimeSource,
  ): Promise<void> {
    const active = this.#d.installer.activeVersion(runtime);
    if (active === version && this.#d.runtimeInUse(runtime)) {
      emit({ state: 'refused', reason: 'runtime_in_use', detail: `${runtime} jobs are running` });
      return;
    }
    const t = this.#commands.get(commandId);
    const abort = new AbortController();
    if (t !== undefined) t.abort = abort;
    emit({ state: 'accepted' });
    const progress = this.#progress(emit);
    try {
      // p16-runtime-updates: a version outside the pinned set only with an unverified source (owner policy).
      const u =
        unverified === undefined
          ? null
          : await this.#d.installer.installUnverified(runtime, version, unverified, {
              signal: abort.signal,
              progress,
            });
      const r = u ?? (await this.#d.installer.install(runtime, version, { signal: abort.signal, progress }));
      const probe = await this.#d
        .restartRuntime(runtime)
        .catch(() => ({ ok: false, detail: 'probe failed' }));
      this.#d.changed();
      emit({
        state: 'succeeded',
        detail:
          `${r.action} ${r.version}${u === null ? '' : ' (unverified)'}${probe.ok ? '' : ` (runtime check: ${probe.detail ?? 'not ready'})`}`.slice(
            0,
            300,
          ),
        runtime: await this.#runtimeReport(runtime),
        ...(u === null
          ? {}
          : {
              runtimeInstall: {
                runtime,
                version,
                unverified: true,
                lockSha256: u.lockSha256,
                ...(u.lock === undefined ? {} : { lock: packLockfile('npm', u.lock) }),
              },
            }),
      });
    } catch (err) {
      if (err instanceof InstallRefusal) {
        emit({ state: 'refused', reason: err.reason, detail: err.message.slice(0, 300) });
        return;
      }
      if (err instanceof InstallError) {
        emit({
          state: err.reason === 'cancelled' ? 'cancelled' : 'failed',
          reason: err.reason,
          detail: this.#d.redactor.redact(err.message).slice(0, 300),
          runtime: await this.#runtimeReport(runtime),
        });
        return;
      }
      throw err;
    } finally {
      if (t !== undefined) t.abort = null;
    }
  }
}
