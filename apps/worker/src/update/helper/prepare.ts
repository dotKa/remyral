import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { Logger } from '@remyral/observability';
import {
  LeaseKey,
  opsCommandWindow,
  type PrepareStep,
  type PrepareStepId,
  verifyOpsCommand,
} from '@remyral/protocol';
import { z } from 'zod';
import * as nodePath from 'node:path';
import { workerConfigSchema } from '../../config/schema.js';
import { INSTALLER_WORKER_USERS, windowsServiceSid } from '../../sandbox/host/identity.js';
import {
  isEmbeddedJobRunner,
  JOBRUN_FILE,
  powershellExe,
  selfTestJobRunner,
  WINDOWS_JOBRUN_PS1,
  type RunFile,
} from '../../sandbox/host/windows-jobrun.js';
import { WINDOWS_JOB_SLOTS_PS1 } from '../../sandbox/host/windows-job-slots.generated.js';
import { provisionCount, slotStateDir } from '../../sandbox/host/windows-slots.js';
import {
  MAX_PREPARE_REQUEST_BYTES,
  PREPARE_HELPER_MARKER,
  PrepareRequest,
  type PrepareResult,
  prepareRequestPath,
  prepareResultPath,
} from '../../sandbox/prepare-shared.js';
import type { BindingRead } from '../../machine-admin/binding.js';
import { readUntrustedFile, UnsafeFileError } from '../files.js';
import type { ManageResult } from '../manage-shared.js';
import type { ManageHelper } from './manage.js';

/** Windows: tries of the result file's rename while the worker may hold it open for reading (see #writeResult). */
const RESULT_WRITE_ATTEMPTS = 5;
const RESULT_WRITE_RETRY_MS = 200;

/**
 * Privileged sandbox preparation (p5-sandbox-ops, ADR-0019) — part of the root/SYSTEM helper of
 * p2-signed-updates (`remyral-worker-updater.mjs`), never of the worker.
 *
 * The worker can only *ask*: it writes the signed OPS_COMMAND it received into its own data dir. This module
 *  1. reads that file defensively (no symlink, regular file, ≤ 64 KiB) and parses it strictly;
 *  2. accepts only `sandbox.prepare` with `privileged: true`, inside its validity window, never twice (its own
 *     replay set in the install dir);
 *  3. verifies the master's Ed25519 signature over worker id, command id, window and operation — with
 *     `masterLeaseKeys` pinned in the root-owned config, else the keys the master publishes at
 *     `GET <master>/v1/worker/lease-keys` fetched by the helper itself over TLS (never keys the worker supplies);
 *  4. runs its **fixed, versioned allowlist** for this OS. No step takes a path, URL, package or command from the
 *     panel or the worker: account names are the installer's constants, packages a compiled-in list, ACLs the
 *     installer's, config keys a fixed set; `localLogin` (signed) only decides whether the local-login keys are
 *     written.
 *  5. writes per-step results to `<install>/state/prepare-result.json` (root-owned, world-readable).
 *
 * Marker for the worker: remana-prepare-helper/v1 (PREPARE_HELPER_MARKER).
 */
export const PREPARE_HELPER = PREPARE_HELPER_MARKER;

/** Distribution packages for rootless Podman (fixed; never from a request). */
export const APT_PACKAGES = ['podman', 'uidmap', 'slirp4netns', 'fuse-overlayfs'] as const;
export const DNF_PACKAGES = ['podman', 'shadow-utils', 'slirp4netns', 'fuse-overlayfs'] as const;
/** p19-linux-host-isolation: the package name is `bubblewrap` on Debian/Ubuntu/Raspberry Pi OS and Fedora/RHEL. */
export const BUBBLEWRAP_PACKAGE = 'bubblewrap';
const SUBID_COUNT = 65536;

export type Exec = (
  file: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const nodeExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        windowsHide: true,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(opts.env === undefined ? {} : { env: opts.env }),
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });

export interface PrivilegedPrepareDeps {
  readonly platform: NodeJS.Platform;
  /** Root/admin-owned worker config (read and, for the fixed keys, rewritten in place). */
  readonly configPath: string;
  readonly dataDir: string;
  readonly installDir: string;
  /** Pinned `masterLeaseKeys` of the config (null = fetch from the master). */
  readonly pinnedKeys: readonly LeaseKey[] | null;
  readonly masterUrl: string;
  readonly logger: Logger;
  readonly exec?: Exec;
  /** Fetches the master's published lease keys (default: HTTPS GET on the config's master origin). */
  readonly fetchKeys?: (origin: string) => Promise<readonly LeaseKey[]>;
  readonly now?: () => Date;
  /** Test seams. */
  readonly runFile?: RunFile;
  readonly osRelease?: () => Promise<string | null>;
  readonly etcDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Full stop/start of the worker's OS service (the updater's service control: on Windows `net stop` + wait for
   * STOPPED + `net start` with one retry, p6-worker-boot-diagnostics). Used when a step needs a new service logon
   * (`serviceRestart`); without it the worker restarts itself as before.
   */
  readonly restartService?: () => Promise<void>;
  /**
   * The worker id this machine's helper serves (root-owned `<install>/state/admin-binding.json`). When bound, a
   * request signed for any other worker is refused (replayed from another machine); unbound machines keep today's
   * behaviour for these fixed-step requests (machine-admin sessions require the binding).
   */
  readonly binding?: BindingRead;
  /** How long the helper waits after its final result before restarting the service (default 15 s). */
  readonly serviceRestartDelayMs?: number;
  /**
   * p17-worker-managed: `worker.uninstall` / `helper.manage` arrive through the same request file and trigger; after the
   * same signature, window and replay checks they are handed to this (absent: refused as before).
   */
  readonly manage?: ManageHelper;
  readonly sleep?: (ms: number) => Promise<void>;
}

const SEEN_FILE = 'prepare-seen.json';
/** `<install>/state/prepare-service-restart.json`: one service restart per command id, resumable. */
export const SERVICE_RESTART_FILE = 'prepare-service-restart.json';
/** A pending restart older than this is not resumed (the worker has long reported; the owner restarts). */
const SERVICE_RESTART_RESUME_MS = 10 * 60_000;
const ServiceRestartMarker = z.object({
  commandId: z.string().max(64),
  state: z.enum(['pending', 'done', 'failed']),
  requestedAt: z.string().max(40),
  detail: z.string().max(300).optional(),
});
type ServiceRestartMarker = z.infer<typeof ServiceRestartMarker>;
const LeaseKeysResponse = z.object({ keys: z.array(LeaseKey).max(8) });

/** `wss://host/v1/worker` → `https://host` (ws:// only for a loopback development master). */
export function masterOrigin(masterUrl: string): string {
  const u = new URL(masterUrl);
  const scheme = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : null;
  if (scheme === null) throw new Error(`unsupported master URL ${masterUrl}`);
  return `${scheme}//${u.host}`;
}

export async function fetchMasterLeaseKeys(origin: string): Promise<readonly LeaseKey[]> {
  const res = await fetch(`${origin}/v1/worker/lease-keys`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`lease keys: HTTP ${String(res.status)}`);
  const text = await res.text();
  if (text.length > 16 * 1024) throw new Error('lease keys: response too large');
  return LeaseKeysResponse.parse(JSON.parse(text)).keys;
}

/**
 * `restart`: the worker restarts (its local config changed). `serviceRestart`: the worker's whole OS service must
 * restart (new service logon), which the helper does itself after reporting.
 */
type StepOut = Omit<PrepareStep, 'id' | 'privileged'> & { restart?: boolean; serviceRestart?: boolean };
type StepFn = () => Promise<StepOut>;

export class PrivilegedPreparer {
  readonly #d: PrivilegedPrepareDeps;
  readonly #p: typeof nodePath;
  readonly #exec: Exec;

  constructor(d: PrivilegedPrepareDeps) {
    this.#d = d;
    this.#p = nodePath;
    this.#exec = d.exec ?? nodeExec;
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date();
  }

  get #resultPath(): string {
    return prepareResultPath(this.#d.platform, this.#d.installDir);
  }

  /**
   * Windows: the worker polls the result file while the helper replaces it, and a rename over a file another process
   * has open fails with EPERM / EBUSY / EACCES (seen on a CI runner) — retried a few times, like the update agent's
   * health file.
   */
  async #writeResult(r: PrepareResult): Promise<void> {
    const path = this.#resultPath;
    await mkdir(this.#p.dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(r)}\n`, { mode: 0o644 });
    if (this.#d.platform !== 'win32') await chmod(tmp, 0o644);
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!busy || attempt >= RESULT_WRITE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, RESULT_WRITE_RETRY_MS));
      }
    }
  }

  async #seen(): Promise<Record<string, number>> {
    try {
      const raw = JSON.parse(
        await readFile(this.#p.join(this.#d.installDir, 'state', SEEN_FILE), 'utf8'),
      ) as unknown;
      return raw !== null && typeof raw === 'object' ? (raw as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  async #remember(commandId: string, until: number): Promise<void> {
    const now = this.#now().getTime();
    const seen = Object.fromEntries(Object.entries(await this.#seen()).filter(([, t]) => t > now));
    seen[commandId] = until;
    const path = this.#p.join(this.#d.installDir, 'state', SEEN_FILE);
    await mkdir(this.#p.dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(seen), { mode: 0o600 });
  }

  /**
   * Processes a pending request, if any. Returns null when there is none; otherwise the final result (also
   * written to the result file). The request file is left in place (the helper never writes into the worker's
   * data dir); a processed command id is never run again.
   */
  async processPending(): Promise<PrepareResult | null> {
    const r = await this.processRequest();
    return r === null || !('restartRequired' in r) ? null : r;
  }

  /**
   * p17-worker-managed: like {@link processPending}, also for `worker.uninstall` / `helper.manage` (their result is a
   * ManageResult, written to manage-result.json).
   */
  async processRequest(): Promise<PrepareResult | ManageResult | null> {
    const reqPath = prepareRequestPath(this.#d.platform, this.#d.dataDir);
    let raw: Buffer | null;
    try {
      raw = await readUntrustedFile(reqPath, MAX_PREPARE_REQUEST_BYTES);
    } catch (err) {
      this.#d.logger.warn('prepare request refused', {
        reason: err instanceof UnsafeFileError ? err.message : 'unreadable',
      });
      return null;
    }
    await this.#resumeServiceRestart();
    if (raw === null) return null;
    let req: PrepareRequest;
    try {
      req = PrepareRequest.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      this.#d.logger.warn('prepare request is not a valid document; ignored');
      return null;
    }
    const cmd = req.command;
    const seen = await this.#seen();
    if (seen[cmd.commandId] !== undefined) return null; // processed already: never twice
    // p17-worker-managed: removal and helper management share this trigger; their results go to manage-result.json.
    const manage =
      (cmd.op.kind === 'worker.uninstall' || cmd.op.kind === 'helper.manage') && this.#d.manage !== undefined
        ? this.#d.manage
        : null;
    const refuse = async (reason: string, detail: string): Promise<PrepareResult | ManageResult> => {
      if (manage !== null) {
        await this.#remember(cmd.commandId, Date.parse(cmd.expiresAt) + 10 * 60_000);
        return manage.refuse(cmd.commandId, reason, detail);
      }
      const r: PrepareResult = {
        v: 1,
        commandId: cmd.commandId,
        state: 'refused',
        reason,
        detail: detail.slice(0, 300),
        steps: [],
        restartRequired: false,
        updatedAt: this.#now().toISOString(),
      };
      await this.#remember(cmd.commandId, Date.parse(cmd.expiresAt) + 10 * 60_000);
      await this.#writeResult(r);
      this.#d.logger.warn('privileged prepare refused', { commandId: cmd.commandId, reason });
      return r;
    };
    if (manage === null && (cmd.op.kind !== 'sandbox.prepare' || !cmd.op.privileged)) {
      return refuse('not_a_privileged_prepare', 'only sandbox.prepare with privileged: true is accepted');
    }
    const window = opsCommandWindow(cmd, this.#now());
    if (window !== 'ok') return refuse(window, 'the signed command is outside its validity window');
    const binding = this.#d.binding;
    if (binding?.state === 'bound' && req.workerId !== binding.binding.workerId) {
      return refuse(
        'wrong_worker',
        `the request is signed for worker ${req.workerId}, this machine serves ${binding.binding.workerId}`,
      );
    }
    let keys: readonly LeaseKey[];
    try {
      keys =
        this.#d.pinnedKeys ??
        (await (this.#d.fetchKeys ?? fetchMasterLeaseKeys)(masterOrigin(this.#d.masterUrl)));
    } catch (err) {
      return refuse(
        'keys_unavailable',
        `cannot obtain the master's lease keys: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const verdict = verifyOpsCommand(
      {
        workerId: req.workerId,
        commandId: cmd.commandId,
        issuedAt: cmd.issuedAt,
        expiresAt: cmd.expiresAt,
        op: cmd.op,
      },
      cmd.signature,
      keys,
    );
    if (verdict !== 'ok') {
      return refuse(
        verdict === 'missing' ? 'unsigned' : 'bad_signature',
        'the request does not carry a valid master signature',
      );
    }
    await this.#remember(cmd.commandId, Date.parse(cmd.expiresAt) + 10 * 60_000);
    if (manage !== null) {
      this.#d.logger.info('privileged manage request accepted', {
        commandId: cmd.commandId,
        kind: cmd.op.kind,
      });
      if (cmd.op.kind === 'worker.uninstall') return manage.uninstall(cmd.commandId, cmd.op.purge);
      if (cmd.op.kind === 'helper.manage') return manage.helper(cmd.commandId, cmd.op.action);
    }
    if (cmd.op.kind !== 'sandbox.prepare') return null;
    this.#d.logger.info('privileged prepare accepted', { commandId: cmd.commandId });
    return this.#runSteps(cmd.commandId, cmd.op.localLogin);
  }

  async #runSteps(commandId: string, localLogin: boolean): Promise<PrepareResult> {
    const plan = this.#plan(localLogin);
    const steps: PrepareStep[] = plan.map(([id]) => ({ id, state: 'pending', privileged: true }));
    let restartRequired = false;
    let serviceRestart = false;
    const write = (state: PrepareResult['state']): Promise<void> =>
      this.#writeResult({
        v: 1,
        commandId,
        state,
        steps,
        restartRequired,
        updatedAt: this.#now().toISOString(),
      });
    await write('running');
    for (const [i, [id, fn]] of plan.entries()) {
      steps[i] = { id, state: 'running', privileged: true };
      await write('running');
      try {
        const r = await fn();
        if (r.restart === true) restartRequired = true;
        if (r.serviceRestart === true) {
          restartRequired = true;
          if (this.#d.restartService !== undefined) serviceRestart = true;
        }
        steps[i] = {
          id,
          privileged: true,
          state: r.state,
          ...(r.code === undefined ? {} : { code: r.code }),
          ...(r.detail === undefined ? {} : { detail: r.detail.slice(0, 300) }),
        };
      } catch (err) {
        steps[i] = {
          id,
          privileged: true,
          state: 'failed',
          code: 'step_error',
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        };
      }
      this.#d.logger.info('privileged prepare step', { commandId, step: id, state: steps[i].state });
    }
    const final: PrepareResult = {
      v: 1,
      commandId,
      state: 'done',
      steps,
      restartRequired,
      ...(serviceRestart ? { serviceRestart: true } : {}),
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeResult(final);
    // After the result is written: the worker relays it to the master first, then loses its process.
    if (serviceRestart) await this.#restartServiceAfterReport(commandId);
    return final;
  }

  // ------------------------------------------------------------------------- service restart (new logon)

  get #restartMarkerPath(): string {
    return this.#p.join(this.#d.installDir, 'state', SERVICE_RESTART_FILE);
  }

  async #readRestartMarker(): Promise<ServiceRestartMarker | null> {
    try {
      const parsed = ServiceRestartMarker.safeParse(
        JSON.parse(await readFile(this.#restartMarkerPath, 'utf8')),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async #writeRestartMarker(m: ServiceRestartMarker): Promise<void> {
    await mkdir(this.#p.dirname(this.#restartMarkerPath), { recursive: true });
    await writeFile(this.#restartMarkerPath, JSON.stringify(m), { mode: 0o600 });
  }

  /**
   * Live finding 2026-10-17 (Windows 1.0.29): the privileges `job_slots_provision` grants reach the worker only with
   * a new service logon; the worker's own restart only restarts node under the same shawl service process and keeps
   * the old token. So the helper (SYSTEM) stops and starts the service itself — once per command id: the marker is
   * written before the restart, a run interrupted in between resumes it (`processPending`), a finished one never
   * repeats.
   */
  async #restartServiceAfterReport(commandId: string): Promise<void> {
    const have = await this.#readRestartMarker();
    if (have?.commandId === commandId && have.state !== 'pending') return;
    const requestedAt = have?.commandId === commandId ? have.requestedAt : this.#now().toISOString();
    await this.#writeRestartMarker({ commandId, state: 'pending', requestedAt });
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(this.#d.serviceRestartDelayMs ?? 15_000);
    await this.#doServiceRestart(commandId, requestedAt);
  }

  async #doServiceRestart(commandId: string, requestedAt: string): Promise<void> {
    const restart = this.#d.restartService;
    if (restart === undefined) return;
    this.#d.logger.warn('privileged prepare restarts the worker service (new privileges need a new logon)', {
      commandId,
    });
    try {
      await restart();
      await this.#writeRestartMarker({ commandId, state: 'done', requestedAt });
      this.#d.logger.info('worker service restarted', { commandId });
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await this.#writeRestartMarker({ commandId, state: 'failed', requestedAt, detail });
      this.#d.logger.error('worker service restart failed; restart the RemyralWorker service by hand', {
        commandId,
        detail,
      });
    }
  }

  /** A restart that was due but did not happen (the helper was stopped in between) is done now, if still recent. */
  async #resumeServiceRestart(): Promise<void> {
    const m = await this.#readRestartMarker();
    if (m?.state !== 'pending') return;
    const age = this.#now().getTime() - Date.parse(m.requestedAt);
    if (!(age >= 0 && age <= SERVICE_RESTART_RESUME_MS)) {
      await this.#writeRestartMarker({ ...m, state: 'failed', detail: 'not resumed: too old' });
      return;
    }
    await this.#doServiceRestart(m.commandId, m.requestedAt);
  }

  /**
   * p19-auto-bwrap (sandbox prerequisites are installed automatically, without a click): the fixed `bubblewrap_install`
   * step without a request, run by the Linux prepare unit (root, network) each time it starts — after an update
   * activation (`apply` starts it, {@link requestSandboxPackages}) or a signed request. Same compiled-in package, no
   * input from the master or the worker, a no-op when `bwrap` is present. Best effort: logged, never throws; the worker
   * notices the new binary itself (LinuxIsolationController.watchBwrap) — no restart.
   */
  async ensureSandboxPackages(): Promise<StepOut | null> {
    if (this.#d.platform !== 'linux') return null;
    try {
      const r = await this.#bubblewrapInstall();
      const installed = r.restart === true;
      const out: StepOut = {
        state: r.state,
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(r.detail === undefined ? {} : { detail: r.detail }),
      };
      if (installed) this.#d.logger.info('bubblewrap installed automatically', { detail: out.detail });
      else if (out.state !== 'done') {
        this.#d.logger.warn('automatic bubblewrap install did not succeed', {
          state: out.state,
          code: out.code,
          detail: out.detail,
        });
      }
      return out;
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.#d.logger.warn('automatic bubblewrap install failed', { detail });
      return { state: 'failed', code: 'step_error', detail };
    }
  }

  #plan(localLogin: boolean): [PrepareStepId, StepFn][] {
    const steps: [PrepareStepId, StepFn][] = [
      ['config_worker_user', () => this.#configWorkerUser()],
      ['config_local_login', () => this.#configLocalLogin(localLogin)],
    ];
    if (this.#d.platform === 'win32') {
      steps.push(['job_runner_install', () => this.#jobRunnerInstall()]);
      steps.push(['workspace_acl', () => this.#windowsAcls()]);
      steps.push(['job_slots_provision', () => this.#jobSlots()]);
    } else if (this.#d.platform === 'linux') {
      steps.push(['container_engine_install', () => this.#containerEngineInstall()]);
      steps.push(['container_subids', () => this.#containerSubids()]);
      steps.push(['container_service', () => Promise.resolve(this.#containerService())]);
      // p19-linux-host-isolation: bubblewrap for per-attempt host isolation (and the runtimes' own sandboxes).
      steps.push(['bubblewrap_install', () => this.#bubblewrapInstall()]);
    }
    return steps;
  }

  // ------------------------------------------------------------------------------- config (fixed keys)

  async #editConfig(mutate: (sandbox: Record<string, unknown>) => string[]): Promise<{ changed: string[] }> {
    const text = await readFile(this.#d.configPath, 'utf8');
    const json = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const sandbox =
      json.sandbox !== null && typeof json.sandbox === 'object' && !Array.isArray(json.sandbox)
        ? (json.sandbox as Record<string, unknown>)
        : {};
    const changed = mutate(sandbox);
    if (changed.length === 0) return { changed };
    json.sandbox = sandbox;
    const parsed = workerConfigSchema(this.#d.platform).safeParse(json);
    if (!parsed.success) throw new Error('the edited config would not be valid; left unchanged');
    // In place (same file, same owner and ACL): never a rename from a temp file the service could see.
    await writeFile(this.#d.configPath, `${JSON.stringify(json, null, 2)}\n`);
    return { changed };
  }

  async #configWorkerUser(): Promise<Omit<PrepareStep, 'id' | 'privileged'> & { restart?: boolean }> {
    const user = INSTALLER_WORKER_USERS[this.#d.platform];
    if (user === undefined) return { state: 'skipped', code: 'unsupported_os' };
    let current: unknown;
    const { changed } = await this.#editConfig((s) => {
      current = s.workerUser;
      if (typeof current === 'string' && current !== '') return [];
      s.workerUser = user;
      return ['sandbox.workerUser'];
    });
    if (changed.length > 0) return { state: 'done', detail: `sandbox.workerUser = ${user}`, restart: true };
    return {
      state: 'done',
      detail: `already set (${String(current)})`,
    };
  }

  async #configLocalLogin(
    localLogin: boolean,
  ): Promise<Omit<PrepareStep, 'id' | 'privileged'> & { restart?: boolean }> {
    if (!localLogin) return { state: 'skipped', detail: 'no runtime of this worker uses local-login' };
    const home = this.#d.platform === 'darwin' ? await this.#macHome() : null;
    const { changed } = await this.#editConfig((s) => {
      const out: string[] = [];
      if (s.keepHome !== true) {
        s.keepHome = true;
        out.push('sandbox.keepHome');
      }
      if (this.#d.platform === 'darwin') {
        if (s.allowKeychain !== true) {
          s.allowKeychain = true;
          out.push('sandbox.allowKeychain');
        }
        if (home !== null) {
          const have = Array.isArray(s.hostExtraWritable) ? (s.hostExtraWritable as unknown[]) : [];
          const want = ['.claude', '.claude.json', '.codex', '.config'].map((n) => `${home}/${n}`);
          const missing = want.filter((w) => !have.includes(w));
          if (missing.length > 0) {
            s.hostExtraWritable = [...have, ...missing];
            out.push('sandbox.hostExtraWritable');
          }
        }
      }
      return out;
    });
    return changed.length > 0
      ? { state: 'done', detail: `set ${changed.join(', ')}`, restart: true }
      : { state: 'done', detail: 'local-login settings already in place' };
  }

  async #macHome(): Promise<string | null> {
    const r = await this.#exec('/usr/bin/dscl', ['.', '-read', '/Users/_remyralworker', 'NFSHomeDirectory']);
    const m = /NFSHomeDirectory:\s*(\/\S+)/.exec(r.stdout);
    return r.code === 0 && m?.[1] !== undefined ? m[1] : null;
  }

  // ---------------------------------------------------------------------------------------- Windows

  async #jobRunnerInstall(): Promise<Omit<PrepareStep, 'id' | 'privileged'>> {
    const target = this.#p.join(this.#d.installDir, JOBRUN_FILE);
    if (!(await isEmbeddedJobRunner(target))) {
      await writeFile(target, WINDOWS_JOBRUN_PS1);
    }
    const test = await selfTestJobRunner(target, this.#d.runFile, this.#d.env ?? process.env);
    return test.ok
      ? { state: 'done', detail: `${target}: ${test.detail}` }
      : { state: 'failed', code: 'job_runner_selftest_failed', detail: test.detail };
  }

  /** The installer's ACLs again (install.ps1): data root protected, the service SID only what it needs. */
  windowsAclCommands(workspaceRoot: string): string[][] {
    const p = this.#p;
    const sid = windowsServiceSid('RemyralWorker');
    const root = p.dirname(this.#d.configPath);
    const logs = p.join(root, 'logs');
    const cmds: string[][] = [
      [root, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${sid}:(RX)`],
      [this.#d.configPath, '/grant:r', `*${sid}:(R)`],
      [this.#d.dataDir, '/grant:r', `*${sid}:(OI)(CI)M`],
      [logs, '/grant:r', `*${sid}:(OI)(CI)M`],
    ];
    if (workspaceRoot.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) {
      cmds.push([workspaceRoot, '/grant:r', `*${sid}:(OI)(CI)M`]);
    } else {
      cmds.push([
        workspaceRoot,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F',
        `*${sid}:(OI)(CI)M`,
      ]);
    }
    return cmds;
  }

  async #windowsAcls(): Promise<Omit<PrepareStep, 'id' | 'privileged'>> {
    const cfg = JSON.parse((await readFile(this.#d.configPath, 'utf8')).replace(/^\uFEFF/, '')) as {
      workspaceRoot?: unknown;
    };
    if (typeof cfg.workspaceRoot !== 'string') return { state: 'failed', code: 'no_workspace_root' };
    for (const args of this.windowsAclCommands(cfg.workspaceRoot)) {
      const r = await this.#exec('icacls.exe', [...args, '/Q'], { timeoutMs: 600_000 });
      if (r.code !== 0) {
        return {
          state: 'failed',
          code: 'icacls_failed',
          detail: `${args[0] ?? ''}: ${(r.stderr || r.stdout).trim()}`.slice(0, 300),
        };
      }
    }
    return { state: 'done', detail: 'data root, data dir, logs and workspace root ACLs re-applied' };
  }

  /**
   * p9-windows-host-isolation: create / rotate the per-job accounts with the embedded `remyral-job-slots.ps1`
   * (written next to the worker, admin-owned). Fixed arguments only: the count from the root-owned config, the
   * installer's service SID, the state dir next to config.json and the worker-managed runtime/tool dirs.
   */
  async #jobSlots(): Promise<StepOut> {
    const p = this.#p;
    const cfg = JSON.parse((await readFile(this.#d.configPath, 'utf8')).replace(/^\uFEFF/, '')) as {
      maxParallelJobs?: unknown;
      sandbox?: { windowsJobSlots?: unknown };
    };
    const configured = cfg.sandbox?.windowsJobSlots;
    const count = provisionCount(
      typeof configured === 'number' ? configured : undefined,
      typeof cfg.maxParallelJobs === 'number' ? cfg.maxParallelJobs : undefined,
    );
    if (count === 0) {
      return {
        state: 'skipped',
        code: 'job_slots_disabled',
        detail: 'sandbox.windowsJobSlots is 0: host jobs run one at a time',
      };
    }
    const script = p.join(this.#d.installDir, JOB_SLOTS_FILE);
    const have = await readFile(script, 'utf8').catch(() => null);
    if (have?.replace(/\r\n/g, '\n') !== WINDOWS_JOB_SLOTS_PS1)
      await writeFile(script, WINDOWS_JOB_SLOTS_PS1);
    const r = await this.#exec(
      powershellExe(this.#d.env ?? process.env),
      jobSlotsArgs({
        script,
        count,
        stateDir: slotStateDir(p.dirname(this.#d.configPath)),
        workerSid: windowsServiceSid('RemyralWorker'),
        readDirs: [
          p.join(this.#d.dataDir, 'runtimes'),
          p.join(this.#d.dataDir, 'tools'),
          p.join(this.#d.dataDir, 'mcp'),
        ],
      }),
      { timeoutMs: 600_000 },
    );
    const result = parseJobSlotsResult(r.stdout);
    if (r.code !== 0 || result?.ok !== true) {
      return {
        state: 'failed',
        code: result?.code ?? 'job_slots_provision_failed',
        detail: (result?.detail ?? `exit ${String(r.code)}: ${(r.stderr || r.stdout).trim()}`).slice(0, 300),
      };
    }
    return {
      state: 'done',
      detail: `${String(result.count ?? count)} per-job account(s), passwords rotated${
        result.privilegesAdded === true
          ? this.#d.restartService === undefined
            ? '; new privileges: restart the RemyralWorker service'
            : '; the helper restarts the RemyralWorker service so the worker gets its new privileges'
          : ''
      }`,
      // A new service logon, not a restart of the worker process (live finding 2026-10-17).
      ...(result.privilegesAdded === true ? { serviceRestart: true } : {}),
    };
  }

  // ------------------------------------------------------------------------------------------ Linux

  async #osRelease(): Promise<string | null> {
    if (this.#d.osRelease !== undefined) return this.#d.osRelease();
    return readFile('/etc/os-release', 'utf8').catch(() => null);
  }

  /** `apt` (Debian/Ubuntu/Raspberry Pi OS), `dnf` (Fedora/RHEL family) or null. */
  async packageManager(): Promise<'apt' | 'dnf' | null> {
    const text = await this.#osRelease();
    if (text === null) return null;
    const field = (k: string): string[] =>
      (new RegExp(`^${k}="?([^"\\n]*)"?$`, 'm').exec(text)?.[1] ?? '').toLowerCase().split(/\s+/);
    const ids = [...field('ID'), ...field('ID_LIKE')];
    if (ids.some((i) => ['debian', 'ubuntu', 'raspbian'].includes(i))) return 'apt';
    if (ids.some((i) => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'].includes(i))) return 'dnf';
    return null;
  }

  async #containerEngineInstall(): Promise<Omit<PrepareStep, 'id' | 'privileged'> & { restart?: boolean }> {
    const have = await this.#exec('/usr/bin/env', ['podman', '--version']);
    if (have.code !== 0) {
      const pm = await this.packageManager();
      if (pm === null) {
        return {
          state: 'needs_owner',
          code: 'distribution_unsupported',
          detail:
            'only Debian/Ubuntu (apt) and Fedora/RHEL (dnf) are prepared automatically; install rootless Podman by hand',
        };
      }
      const env = {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        DEBIAN_FRONTEND: 'noninteractive',
        LANG: 'C',
      };
      if (pm === 'apt') {
        const u = await this.#exec('apt-get', ['update'], { timeoutMs: 900_000, env });
        if (u.code !== 0)
          return { state: 'failed', code: 'apt_update_failed', detail: u.stderr.trim().slice(-300) };
        const r = await this.#exec('apt-get', ['install', '-y', '--no-install-recommends', ...APT_PACKAGES], {
          timeoutMs: 1_800_000,
          env,
        });
        if (r.code !== 0)
          return { state: 'failed', code: 'apt_install_failed', detail: r.stderr.trim().slice(-300) };
      } else {
        const r = await this.#exec('dnf', ['install', '-y', ...DNF_PACKAGES], { timeoutMs: 1_800_000, env });
        if (r.code !== 0)
          return { state: 'failed', code: 'dnf_install_failed', detail: r.stderr.trim().slice(-300) };
      }
    }
    // Point the worker at Podman unless the owner chose an engine explicitly.
    const { changed } = await this.#editConfig((s) => {
      const c =
        s.container !== null && typeof s.container === 'object' && !Array.isArray(s.container)
          ? (s.container as Record<string, unknown>)
          : {};
      if (c.engine !== undefined) return [];
      c.engine = 'podman';
      s.container = c;
      return ['sandbox.container.engine'];
    });
    return {
      state: 'done',
      detail: `podman installed${changed.length > 0 ? '; sandbox.container.engine = podman' : ''}`,
      ...(changed.length > 0 ? { restart: true } : {}),
    };
  }

  /**
   * p19-linux-host-isolation: the distribution's `bubblewrap` package (fixed name, no argument from the request). The
   * worker restarts afterwards so its namespace check and the isolation self-check see it.
   */
  async #bubblewrapInstall(): Promise<Omit<PrepareStep, 'id' | 'privileged'> & { restart?: boolean }> {
    const have = await this.#exec('/usr/bin/env', ['bwrap', '--version']);
    if (have.code === 0)
      return { state: 'done', detail: `already installed (${have.stdout.trim().slice(0, 60)})` };
    const pm = await this.packageManager();
    if (pm === null) {
      return {
        state: 'needs_owner',
        code: 'distribution_unsupported',
        detail:
          'only Debian/Ubuntu (apt) and Fedora/RHEL (dnf) are prepared automatically; install bubblewrap by hand',
      };
    }
    const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive', LANG: 'C' };
    if (pm === 'apt') {
      const u = await this.#exec('apt-get', ['update'], { timeoutMs: 900_000, env });
      if (u.code !== 0)
        return { state: 'failed', code: 'apt_update_failed', detail: u.stderr.trim().slice(-300) };
      const r = await this.#exec(
        'apt-get',
        ['install', '-y', '--no-install-recommends', BUBBLEWRAP_PACKAGE],
        {
          timeoutMs: 900_000,
          env,
        },
      );
      if (r.code !== 0)
        return { state: 'failed', code: 'apt_install_failed', detail: r.stderr.trim().slice(-300) };
    } else {
      const r = await this.#exec('dnf', ['install', '-y', BUBBLEWRAP_PACKAGE], { timeoutMs: 900_000, env });
      if (r.code !== 0)
        return { state: 'failed', code: 'dnf_install_failed', detail: r.stderr.trim().slice(-300) };
    }
    return {
      state: 'done',
      detail: 'bubblewrap installed; the worker restarts and checks per-attempt isolation',
      restart: true,
    };
  }

  async #containerSubids(): Promise<Omit<PrepareStep, 'id' | 'privileged'>> {
    const user = INSTALLER_WORKER_USERS.linux ?? 'remyral-worker';
    const etc = this.#d.etcDir ?? '/etc';
    const files = ['subuid', 'subgid'] as const;
    const texts = await Promise.all(files.map((f) => readFile(`${etc}/${f}`, 'utf8').catch(() => '')));
    const present = texts.map((t) => t.split('\n').some((l) => l.startsWith(`${user}:`)));
    if (present.every(Boolean)) return { state: 'done', detail: `${user} already has subordinate ids` };
    let maxEnd = 100_000;
    for (const t of texts) {
      for (const line of t.split('\n')) {
        const m = /^[^:]+:(\d+):(\d+)$/.exec(line.trim());
        if (m !== null) maxEnd = Math.max(maxEnd, Number(m[1]) + Number(m[2]));
      }
    }
    const start = Math.ceil(maxEnd / SUBID_COUNT) * SUBID_COUNT;
    const range = `${String(start)}-${String(start + SUBID_COUNT - 1)}`;
    const args: string[] = [];
    if (present[0] !== true) args.push('--add-subuids', range);
    if (present[1] !== true) args.push('--add-subgids', range);
    const r = await this.#exec('usermod', [...args, user], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    return r.code === 0
      ? { state: 'done', detail: `subordinate ids ${range} for ${user}` }
      : { state: 'failed', code: 'usermod_failed', detail: r.stderr.trim().slice(0, 300) };
  }

  #containerService(): Omit<PrepareStep, 'id' | 'privileged'> {
    return {
      state: 'needs_owner',
      code: 'unit_hardening_blocks_rootless',
      detail:
        "the hardened worker unit (NoNewPrivileges, RestrictSUIDSGID, no capabilities, ProtectHome) blocks rootless Podman's setuid newuidmap; relaxing it is the owner's decision (docs/ops/worker-sandbox.md)",
    };
  }
}

/** The Linux prepare unit (infra/worker/linux/remyral-worker-prepare.service): root, network, may write /usr. */
export const LINUX_PREPARE_UNIT = 'remyral-worker-prepare.service';

/**
 * p19-auto-bwrap: what `apply` does on Linux (update activation and boot). The update unit has no network and a
 * read-only /usr (remyral-worker-update.service hardening), so it cannot install a package itself; when `bwrap` is
 * missing it starts the prepare unit (fixed name, `--no-block`), whose `prepare` runs
 * {@link PrivilegedPreparer.ensureSandboxPackages}. Other platforms: nothing. Never throws.
 */
export async function requestSandboxPackages(d: {
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly logger: Logger;
}): Promise<'skipped' | 'present' | 'requested' | 'failed'> {
  if (d.platform !== 'linux') return 'skipped';
  try {
    const have = await d.exec('/usr/bin/env', ['bwrap', '--version'], { timeoutMs: 15_000 });
    if (have.code === 0) return 'present';
    const r = await d.exec('systemctl', ['start', '--no-block', LINUX_PREPARE_UNIT], { timeoutMs: 30_000 });
    if (r.code === 0) {
      d.logger.info('bubblewrap missing: the prepare unit installs it', { unit: LINUX_PREPARE_UNIT });
      return 'requested';
    }
    d.logger.warn('bubblewrap missing and the prepare unit could not be started', {
      unit: LINUX_PREPARE_UNIT,
      detail: (r.stderr || r.stdout).trim().slice(0, 300),
    });
    return 'failed';
  } catch (err) {
    d.logger.warn('bubblewrap check failed', {
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return 'failed';
  }
}

export const JOB_SLOTS_FILE = 'remyral-job-slots.ps1';

/** Fixed PowerShell arguments of the provisioning script (p9-windows-host-isolation). */
export function jobSlotsArgs(o: {
  script: string;
  count: number;
  stateDir: string;
  workerSid: string;
  readDirs: readonly string[];
}): string[] {
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > 16) throw new RangeError('count must be 1..16');
  if (!/^S-1-5(-\d{1,10}){1,14}$/.test(o.workerSid)) throw new RangeError(`not a SID: ${o.workerSid}`);
  for (const d of o.readDirs) if (d.includes('|')) throw new RangeError(`'|' in a path: ${d}`);
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    o.script,
    '-Count',
    String(o.count),
    '-StateDir',
    o.stateDir,
    '-WorkerSid',
    o.workerSid,
    '-ReadDirs',
    o.readDirs.join('|'),
  ];
}

const JobSlotsResult = z.object({
  ok: z.boolean(),
  code: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(2000).optional(),
  count: z.number().int().optional(),
  generation: z.string().max(64).optional(),
  privilegesAdded: z.boolean().optional(),
});

/** The script's last `remyral-job-slots {json}` line, or null. */
export function parseJobSlotsResult(stdout: string): z.infer<typeof JobSlotsResult> | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('remyral-job-slots '))
    .at(-1);
  if (line === undefined) return null;
  try {
    return JobSlotsResult.parse(JSON.parse(line.slice('remyral-job-slots '.length)));
  } catch {
    return null;
  }
}

/** Removes a stale result file of an earlier command (installers; tests). */
export async function clearPrepareResult(platform: NodeJS.Platform, installDir: string): Promise<void> {
  await rm(prepareResultPath(platform, installDir), { force: true });
}
