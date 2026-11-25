import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  spawnOwnedProcess,
  type ConfinedSpawn,
  type OwnedProcess,
  type ProcessConfiner,
  type SpawnPlan,
} from '@remyral/agent-adapters';
import type { RuntimeKind } from '@remyral/protocol';
import { accountFolderReclaimArgs } from '../../accounts/accounts.js';
import { assertSafeSegment } from '../../workspace/ids.js';
import { ensureDirInside, isInside } from '../../workspace/paths.js';
import { startEgressProxy, type EgressDecision, type EgressProxy, type Lookup } from '../egress/proxy.js';
import { SandboxRequestError, SandboxUnavailableError } from '../errors.js';
import { normalizeNetworkPolicy } from '../network.js';
import type { FilesystemConfinement, ProfileCapability } from '../policy.js';
import type { SandboxContext, SandboxLaunchRequest, SandboxRunner } from '../types.js';
import type { WorkerIdentity } from './identity.js';
import { posixLimitsPrelude, windowsJobObjectKiller } from './limits.js';
import {
  buildHostBwrapArgs,
  HOME_LOGIN_STORES,
  type LinuxIsolationController,
  type LoginStoreHome,
  netnsRelayArgv,
  startEgressRelay,
  VIEW_EGRESS_SOCKET,
} from './linux-isolation.js';
import { reapingTreeKiller, SANDBOX_TOKEN_ENV, type SweepResult } from './reaper.js';
import { buildSeatbeltProfile } from './seatbelt.js';
import {
  assertJobRunnerIntact,
  jobRunnerArgs,
  jobRunnerSpec,
  powershellExe,
  restrictAttemptAcl,
  runFile,
  type JobRunnerState,
  type RunFile,
} from './windows-jobrun.js';
import type { WindowsSlotController } from './windows-slot-controller.js';
import {
  icacls,
  runAsSpec,
  slotAttemptAclArgs,
  slotGrantArgs,
  slotRevokeArgs,
  sweepCommandLine,
  writeJobSpec,
  type JobSlot,
} from './windows-slots.js';

/**
 * ADR-0007 `host-restricted`: the runtime runs natively as the dedicated worker
 * OS user (verified at start), with a minimal environment, cwd = the attempt
 * worktree, rlimits / a Job Object, and on macOS a Seatbelt profile confining
 * writes to the attempt, denying reads of secrets and other attempts, and
 * allowing network only to a per-job loopback egress proxy.
 *
 * Without Seatbelt (Linux/Pi host, Windows) there is no per-attempt filesystem
 * or network confinement beyond the OS user: `filesystemConfinement: 'none'`,
 * which `selectProfile` turns into "one attempt at a time" and the runtime's
 * permission policy must deny network tools. That is the documented residual
 * risk of host-native execution.
 *
 * Windows (p5-sandbox-ops): the runtime is started by the `remyral-jobrun.ps1` job runner inside a Job Object
 * (memory, processes, CPU, kill-on-close); the attempt's directories get a protected DACL (SYSTEM,
 * Administrators, the worker's own SID); egress is the proxy environment only (not enforced by the OS).
 *
 * Windows per-job accounts (p9-windows-host-isolation): when the account pool is provisioned and its cross-access
 * self-test passed (`windowsSlots`), each attempt runs as its own `remyral-job-<n>` account: its directories are
 * restricted to that account (plus SYSTEM, Administrators, the worker), the mirror objects and package caches it
 * needs are granted to it for the attempt only, TEMP/APPDATA/HOME are per attempt, and after its last process the
 * account's leftovers are killed and its grants revoked. `filesystemConfinement` is then `job_user`, which lets
 * `selectProfile` run as many host attempts as there are healthy accounts.
 *
 * Linux per-attempt isolation (p19-linux-host-isolation, ADR-0066): once the cross-attempt self-check passed
 * (`linuxIsolation`), each restricted attempt runs inside its own bubblewrap view (linux-isolation.ts): its own user,
 * mount and IPC namespace (PID too where the host allows it), the host read-only, the data dir and workspace root
 * hidden except this attempt's own dirs. `filesystemConfinement` is then `bwrap`, which lets `selectProfile` run host
 * attempts in parallel. `runtime-sandbox` attempts are not wrapped (the runtime's own bubblewrap cannot nest in ours):
 * they keep the `none` rules. A subscription-login attempt keeps the worker HOME read-write; every other attempt gets
 * a per-attempt HOME, also with `keepHome` (as on Windows per-job accounts).
 *
 * ADR-0019 `unconfined` (`mode: 'unconfined'`): the same runner without any confinement — the worker user's own
 * HOME and environment, no proxy, no Seatbelt, no ACL change — but with the same verified-identity requirement
 * (never root/SYSTEM/admin), the same resource limits (rlimits / Job Object) and the same tree kill. Offered only
 * when the panel allowed it and the local ceiling does not forbid it (`unconfinedAllowed`).
 */

export type { FilesystemConfinement };

export interface HostRunnerOptions {
  /** Tests: where an unconfined attempt's short $TMPDIR is made (default: the OS temp dir; p21-short-tmp). */
  readonly shortTmpBase?: string;
  readonly identity: WorkerIdentity;
  /** Real path of the workspace root. */
  readonly workspaceRoot: string;
  /** Worker data dir (device key, secrets) — never readable by the runtime. */
  readonly workerDataDir: string;
  /** Subtrees of the data dir jobs may read (p5-remote-ops: managed runtime installs). */
  readonly readableInDataDir?: readonly string[];
  readonly platform?: NodeJS.Platform;
  /** macOS: use Seatbelt (`required` refuses if unavailable). Default `required` on macOS. */
  readonly seatbelt?: 'required' | 'off';
  /** Result of `seatbeltStatus()`; default true (checked by the factory). */
  readonly seatbeltAvailable?: boolean;
  /** Extra homes whose secrets are denied (e.g. the machine owner's). The worker user's HOME is always included. */
  readonly protectedHomes?: readonly string[];
  /** Writable runtime state dirs for `local-login` (e.g. ~/.claude); empty by default. */
  readonly extraWritable?: readonly string[];
  /** Keep the worker user's HOME (local-login) instead of a fresh per-attempt HOME. */
  readonly keepHome?: boolean;
  readonly allowKeychain?: boolean;
  /** Seatbelt: allow listening sockets (loopback servers; Seatbelt cannot limit the interface). Default false. */
  readonly allowListen?: boolean;
  /** Runtimes that serve their API on loopback and therefore may listen (SandboxContext.runtime). */
  readonly listenRuntimes?: readonly RuntimeKind[];
  /** Windows: the located and self-tested job runner (windows-jobrun.ts); re-read per call (Prepare refreshes it). */
  readonly windowsJobRunner?: () => JobRunnerState | undefined;
  /** Windows: restrict the attempt's dirs to SYSTEM/Administrators/the worker SID (default true). */
  readonly windowsAttemptAcl?: boolean;
  /** Tests: process runner for icacls. */
  readonly runFile?: RunFile;
  /**
   * Windows: the per-job account pool (p9-windows-host-isolation); restricted attempts that do not use a
   * subscription login (`ctx.authMode !== 'local-login'`) use it while active. The slots never get the worker's
   * login store (p9-windows-slots-local-login): a local-login attempt runs as the worker account, alone.
   */
  readonly windowsSlots?: WindowsSlotController;
  /** Linux: the per-attempt bubblewrap isolation (p19-linux-host-isolation); used while its self-check passed. */
  readonly linuxIsolation?: LinuxIsolationController;
  /**
   * p22-worker-limits (`sandbox.linuxLoginStoreView`, default off): a subscription-login attempt in a bubblewrap view
   * gets a private home with only the login stores writable ({@link loginStoreHome}) instead of the worker HOME
   * read-write — then local-login attempts of different job families may run in parallel.
   */
  readonly linuxLoginStoreView?: boolean;
  /** ADR-0019: this instance runs the `unconfined` profile. */
  readonly mode?: 'restricted' | 'unconfined';
  /** ADR-0019: panel `allowUnconfined` and the local ceiling allow `unconfined` (checked per call). */
  readonly unconfinedAllowed?: () => { allowed: boolean; code?: string; detail?: string };
  /**
   * Tests only: run although the identity is not verified (the test machine's user
   * is an admin). Never reachable from configuration.
   */
  readonly unsafeAllowUnverifiedIdentityForTests?: boolean;
  /** Egress proxy decisions (audit/metrics). */
  readonly onEgressDecision?: (d: EgressDecision & { jobId: string }) => void;
  /** Tests only: upstream address filter of the in-process proxy. */
  readonly proxyIsForbidden?: (address: string) => boolean;
  /** Tests only: DNS of the in-process proxy. */
  readonly proxyLookup?: Lookup;
  /** Processes that escaped the process group and were killed / only reported (alarm). */
  readonly onEscapedProcesses?: (r: SweepResult & { jobId: string }) => void;
}

/** Per-call options of the host confiner. */
export interface HostConfineOptions {
  /**
   * p19-linux-host-isolation: the attempt runs the runtime's own sandbox (`runtime-sandbox`): no per-attempt bubblewrap
   * view around it (bubblewrap does not nest), the pre-isolation host baseline instead.
   */
  readonly runtimeSandbox?: boolean;
}

/** p21-short-tmp: longest $TMPDIR left as is (a socket name under it still fits in ~104 bytes). */
export const SHORT_TMP_MAX = 64;

export class HostRestrictedRunner implements SandboxRunner {
  readonly profile: 'host-restricted' | 'runtime-sandbox' | 'unconfined';
  readonly #limitsKind: string;
  readonly #o: HostRunnerOptions;
  readonly #platform: NodeJS.Platform;
  readonly #unconfined: boolean;
  /** Live confined spawns (for the exclusive-orphan rule of the reaper). */
  #active = 0;
  /** Windows per-job accounts: what each attempt's slot was granted (revoked after its last process). */
  readonly #slotGrants = new Map<
    string,
    { workspace: string; dirs: string[]; loginFolder?: string | undefined }
  >();
  /** icacls changes run one at a time (two attempts adding entries to one mirror must not race). */
  #aclQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: HostRunnerOptions) {
    this.#o = opts;
    this.#platform = opts.platform ?? process.platform;
    this.#unconfined = opts.mode === 'unconfined';
    this.profile = this.#unconfined ? 'unconfined' : 'host-restricted';
    this.#limitsKind = this.#platform === 'win32' ? 'job-object' : 'rlimits';
  }

  /** Implementation label, e.g. `host-restricted:seatbelt`, `host-restricted:bwrap` (read per call). */
  get kind(): string {
    if (this.#unconfined) return `unconfined:${this.#limitsKind}`;
    const fs = this.filesystemConfinement;
    return `host-restricted:${fs === 'seatbelt' || fs === 'bwrap' ? fs : this.#limitsKind}`;
  }

  get filesystemConfinement(): FilesystemConfinement {
    if (this.#unconfined) return 'none';
    if (this.#platform === 'darwin' && (this.#o.seatbelt ?? 'required') === 'required') return 'seatbelt';
    if (this.#platform === 'win32' && this.#o.windowsSlots?.activePool() != null) return 'job_user';
    if (this.#platform === 'linux' && this.#o.linuxIsolation?.active() != null) return 'bwrap';
    return 'none';
  }

  /** Windows job runner state (for the status report). */
  get windowsJobRunner(): JobRunnerState | undefined {
    return this.#o.windowsJobRunner?.();
  }

  /** Readiness for `selectProfile`. */
  check(): ProfileCapability & {
    filesystemConfinement: FilesystemConfinement;
    egressEnforced: boolean;
    loginStoreView: boolean;
  } {
    const fs = this.filesystemConfinement;
    const base = {
      filesystemConfinement: fs,
      egressEnforced: fs === 'seatbelt',
      // p22-worker-limits: local-login attempts in a login-store view (they then run beside other families).
      loginStoreView: fs === 'bwrap' && this.#o.linuxLoginStoreView === true,
    };
    if (!this.#o.identity.verified && this.#o.unsafeAllowUnverifiedIdentityForTests !== true) {
      return {
        ...base,
        ready: false,
        reasonCode: 'worker_identity_unsafe',
        reason: `worker OS user not acceptable: ${this.#o.identity.problems.join('; ')}`,
        remedy:
          'run the worker service as the dedicated low-privilege worker user and set sandbox.workerUser (docs/ops/worker-sandbox.md)',
      };
    }
    if (this.#unconfined) {
      const a = this.#o.unconfinedAllowed?.() ?? { allowed: false, code: 'unconfined_not_enabled' };
      if (!a.allowed) {
        return {
          ...base,
          ready: false,
          reasonCode: 'profile_not_allowed',
          reason:
            a.detail ??
            'the unconfined profile is off for this worker (panel: Machines > <machine> > Sandbox & policy > allow unconfined)',
          remedy:
            a.code === 'unconfined_forbidden_locally'
              ? 'the machine owner forbids it in the local config (localCeiling.allowUnconfined)'
              : 'an admin enables "allow unconfined" for this worker in the panel (step-up, audited)',
        };
      }
    }
    if (this.#platform === 'win32') {
      const jr = this.#o.windowsJobRunner?.();
      if (jr === undefined || !jr.verified) {
        return {
          ...base,
          ready: false,
          reasonCode: 'limits_unsupported',
          reason: `the Windows job runner is not usable (${jr?.code ?? 'job_runner_missing'}${
            jr?.detail === undefined ? '' : `: ${jr.detail}`
          })`.slice(0, 900),
          remedy:
            'run Machines > <machine> > Sandbox & policy > Prepare (verifies the job runner); docs/ops/worker-sandbox.md',
        };
      }
    }
    if (fs === 'seatbelt' && this.#o.seatbeltAvailable === false) {
      return {
        ...base,
        ready: false,
        reasonCode: 'profile_unsupported_on_os',
        reason: 'sandbox-exec is required for host profiles on macOS but is not usable on this host',
        remedy:
          'check /usr/bin/sandbox-exec (deprecated by Apple); without it macOS workers cannot run host jobs',
      };
    }
    return { ...base, ready: true };
  }

  confiner(ctx: SandboxContext, opts: HostConfineOptions = {}): ProcessConfiner {
    const bwrap = this.#bwrapFor(opts);
    return {
      // runtime-sandbox under the Linux isolation runs without the view: its label says so.
      kind:
        bwrap === null && this.filesystemConfinement === 'bwrap'
          ? `host-restricted:${this.#limitsKind}`
          : this.kind,
      confine: (plan) => this.#confine(ctx, plan, opts),
    };
  }

  /**
   * p21-short-tmp: a shorter $TMPDIR when the attempt's own is too long for Unix socket paths (POSIX only): the private
   * tmpfs /tmp of a bubblewrap view, or for an unconfined attempt a fresh 0700 dir under the OS temp dir (removed with
   * the attempt). Otherwise null (the attempt's tmp stays — seatbelt and plain host attempts may write only there).
   */
  async #shortTmp(tmp: string, bwrap: boolean): Promise<{ path: string; owned: boolean } | null> {
    if (this.#platform === 'win32' || tmp.length <= SHORT_TMP_MAX) return null;
    if (bwrap) return { path: '/tmp', owned: false };
    if (!this.#unconfined) return null;
    const base = this.#o.shortTmpBase ?? tmpdir();
    if (base.length > SHORT_TMP_MAX - 16) return null;
    return { path: await mkdtemp(join(base, 'rmy-')), owned: true };
  }

  /** The bubblewrap view of a restricted Linux attempt, or null (not Linux, unconfined, runtime-sandbox, inactive). */
  #bwrapFor(opts: HostConfineOptions): ReturnType<LinuxIsolationController['active']> {
    if (this.#unconfined || opts.runtimeSandbox === true || this.#platform !== 'linux') return null;
    return this.#o.linuxIsolation?.active() ?? null;
  }

  async launch(req: SandboxLaunchRequest, opts: HostConfineOptions = {}): Promise<OwnedProcess> {
    return spawnOwnedProcess({
      command: req.command,
      args: req.args,
      cwd: req.workspacePath,
      env: req.env,
      inheritEnv: [],
      ...(req.secretEnv ? { secretEnv: req.secretEnv } : {}),
      ...(req.stdin ? { stdin: req.stdin } : {}),
      ...(req.maxBufferBytes ? { maxBufferBytes: req.maxBufferBytes } : {}),
      confiner: this.confiner(req, opts),
    });
  }

  async #confine(ctx: SandboxContext, plan: SpawnPlan, opts: HostConfineOptions): Promise<ConfinedSpawn> {
    const ready = this.check();
    if (!ready.ready) {
      throw new SandboxUnavailableError(
        this.profile,
        ready.reasonCode ?? 'worker_identity_unsafe',
        ready.reason ?? '',
        ready.remedy ?? '',
      );
    }
    assertSafeSegment('jobId', ctx.jobId);
    assertSafeSegment('attemptId', ctx.attemptId);
    const root = await realpath(this.#o.workspaceRoot);
    const workspace = await realpath(ctx.workspacePath);
    if (!isInside(join(root, 'jobs'), workspace) || workspace === join(root, 'jobs')) {
      throw new SandboxRequestError(
        'workspacePath',
        `${workspace} is not an attempt dir under ${join(root, 'jobs')}`,
      );
    }
    const network = normalizeNetworkPolicy(ctx.network);
    // Per-attempt scratch: the git view's sandbox dir, or a fresh one under sandboxes/.
    // The runner owns the scratch it creates itself; a git view's or the job runner's (`ctx.sandboxDir`) is theirs.
    const ownsSandboxDir = ctx.git === undefined && ctx.sandboxDir === undefined;
    const sandboxDir =
      ctx.git?.sandboxDir ??
      ctx.sandboxDir ??
      (await ensureDirInside(root, ['sandboxes', ctx.jobId, ctx.attemptId]));
    const tmp = join(sandboxDir, 'tmp');
    const home = join(sandboxDir, 'home');
    // Windows per-job account (p9-windows-slots-local-login): only attempts without a subscription login; they get a
    // per-attempt HOME even with `keepHome` (the worker's profile, and its login store, are not theirs).
    // p13-runtime-accounts: an added account's login (its own folder) is lent to the slot for this attempt only.
    const lent =
      ctx.authMode === 'local-login' &&
      ctx.loginFolder !== undefined &&
      this.#o.windowsSlots?.accountLending() === true;
    const pool =
      this.#platform === 'win32' &&
      !this.#unconfined &&
      ctx.jobAccount !== false &&
      (ctx.authMode !== 'local-login' || lent)
        ? (this.#o.windowsSlots?.activePool() ?? null)
        : null;
    // p19-linux-host-isolation: in a bubblewrap view only a subscription-login attempt keeps the worker HOME.
    const bwrap = this.#bwrapFor(opts);
    const keepHome =
      this.#o.keepHome === true && pool === null && (bwrap === null || ctx.authMode === 'local-login');
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    if (!keepHome) await mkdir(home, { recursive: true, mode: 0o700 });
    // p21-short-tmp: a Unix socket path is at most ~104–108 bytes, and tools put sockets under $TMPDIR (tsx's
    // `<tmp>/tsx-<uid>/<pid>.pipe`, esbuild, language servers); a deep sandbox dir fails them with `listen EINVAL`.
    // Linux with bubblewrap: the view's own /tmp is a private tmpfs. Unconfined: a short private dir of its own.
    const shortTmp = await this.#shortTmp(tmp, bwrap !== null);
    const realSandbox = await realpath(sandboxDir);

    let proxy: EgressProxy | undefined;
    /** p22-worker-limits: the host side of the attempt's egress relay (private network namespace). */
    let relay: { socket: string; close(): Promise<void> } | undefined;
    this.#active++;
    let released = false;
    /** Windows per-job account: released after its processes ended, before the dirs go. */
    let releaseSlot: (() => Promise<void>) | undefined;
    let specFile: string | undefined;
    const dispose = async (): Promise<void> => {
      if (!released) {
        released = true;
        this.#active--;
      }
      if (specFile !== undefined) await rm(specFile, { force: true }).catch(() => undefined);
      const slotDone = releaseSlot;
      releaseSlot = undefined;
      await slotDone?.();
      await relay?.close();
      relay = undefined;
      await proxy?.close();
      proxy = undefined;
      if (ownsSandboxDir) await rm(realSandbox, { recursive: true, force: true });
      else await rm(tmp, { recursive: true, force: true });
      if (shortTmp?.owned === true)
        await rm(shortTmp.path, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      const token = randomBytes(16).toString('hex');
      const env: Record<string, string> = {
        ...plan.env,
        TMPDIR: shortTmp?.path ?? tmp,
        TMP: shortTmp?.path ?? tmp,
        TEMP: shortTmp?.path ?? tmp,
        [SANDBOX_TOKEN_ENV]: token,
      };
      // Unconfined keeps the worker user's own HOME (its local logins); restricted gets a per-attempt HOME.
      if (!keepHome && !this.#unconfined) {
        env.HOME = home;
        env.USERPROFILE = home;
      }
      if (ctx.git) Object.assign(env, ctx.git.hostEnv);
      // p6-warm-caches (ADR-0029): the project's shared package cache (the grant names its own directories only).
      if (ctx.packageCaches !== undefined) Object.assign(env, ctx.packageCaches.env);
      if (!this.#unconfined && (network.mode === 'allowlist' || network.mode === 'web')) {
        const runnerDecision = this.#o.onEgressDecision;
        const launchDecision = ctx.onEgressDecision;
        const onDecision =
          runnerDecision === undefined && launchDecision === undefined
            ? undefined
            : (d: EgressDecision & { jobId: string }): void => {
                runnerDecision?.(d);
                launchDecision?.(d);
              };
        proxy = await startEgressProxy({
          allow: network.targets,
          anyPublicHttps: network.mode === 'web',
          ...(network.refusalHint === undefined ? {} : { refusalHint: network.refusalHint }),
          host: '127.0.0.1',
          port: 0,
          ...(onDecision
            ? {
                onDecision: (d: EgressDecision) => {
                  onDecision({ ...d, jobId: ctx.jobId });
                },
              }
            : {}),
          ...(this.#o.proxyIsForbidden ? { isForbidden: this.#o.proxyIsForbidden } : {}),
          ...(this.#o.proxyLookup ? { lookup: this.#o.proxyLookup } : {}),
        });
        Object.assign(env, {
          HTTPS_PROXY: proxy.url,
          https_proxy: proxy.url,
          HTTP_PROXY: proxy.url,
          http_proxy: proxy.url,
          NO_PROXY: '',
          no_proxy: '',
          NODE_USE_ENV_PROXY: '1',
        });
      }

      if (this.#platform === 'win32') {
        const runner = this.#o.windowsJobRunner?.();
        if (runner === undefined) throw new SandboxRequestError('windowsJobRunner', 'no job runner');
        const script = await assertJobRunnerIntact(runner, this.#o.workerDataDir);
        let slot: JobSlot | undefined;
        if (pool !== null) {
          const lease = pool.acquire(ctx.attemptId);
          if (lease === null) {
            throw new SandboxUnavailableError(
              this.profile,
              'profile_unsupported_on_os',
              'every per-job Windows account is busy; concurrent attempts need one each (T-SBX-4)',
              'retry when a running attempt finishes',
            );
          }
          const held = lease.slot;
          slot = held;
          releaseSlot = () => this.#releaseSlot(ctx.attemptId, held);
          if (lease.first) await this.#prepareSlot(ctx, held, workspace, realSandbox);
          // APPDATA / LOCALAPPDATA of the worker account are not readable by the slot: per attempt instead.
          const appData = join(realSandbox, 'home', 'AppData');
          await mkdir(join(appData, 'Roaming'), { recursive: true });
          await mkdir(join(appData, 'Local'), { recursive: true });
          env.APPDATA = join(appData, 'Roaming');
          env.LOCALAPPDATA = join(appData, 'Local');
        } else if (!this.#unconfined && this.#o.windowsAttemptAcl !== false) {
          const sid = this.#o.identity.sid;
          if (sid !== undefined && sid !== null) {
            await restrictAttemptAcl([workspace, realSandbox], sid, this.#o.runFile ?? runFile);
          }
        }
        const spec = jobRunnerSpec([plan.command, ...plan.args], workspace, ctx.limits);
        // The spec decides the account (runAs): it lives in the worker-only data dir, never in the attempt's tmp.
        specFile = await writeJobSpec(
          this.#o.workerDataDir,
          slot === undefined ? spec : { ...spec, runAs: runAsSpec(slot) },
        );
        return {
          command: powershellExe(),
          args: jobRunnerArgs(script, specFile),
          cwd: workspace,
          env,
          treeKiller: windowsJobObjectKiller(undefined, { tree: slot === undefined }),
          dispose,
        };
      }

      const prelude = posixLimitsPrelude(ctx.limits, this.#platform);
      let argv = [...prelude, plan.command, ...plan.args];
      if (bwrap !== null) {
        // p22-worker-limits: its own network namespace unless the worker must reach it on loopback.
        const privateNet = bwrap.privateNetwork && this.#privateNetworkFor(ctx);
        if (privateNet && proxy !== undefined) relay = await startEgressRelay(proxy.port, bwrap.relayBase);
        // p22-worker-limits: a subscription-login attempt in a login-store view (opt-in).
        const loginView =
          keepHome && ctx.authMode === 'local-login' && this.#o.linuxLoginStoreView === true
            ? await this.#loginStoreHome(plan, realSandbox)
            : null;
        let inner = [plan.command, ...plan.args];
        if (relay !== undefined && proxy !== undefined) {
          inner = netnsRelayArgv(bwrap.node, VIEW_EGRESS_SOCKET, proxy.port, plan.command, plan.args);
        }
        if (loginView?.seed !== undefined) {
          // The worker's ~/.claude.json as a private copy (Claude Code rewrites it atomically: the home is a tmpfs).
          inner = [
            '/bin/sh',
            '-c',
            LOGIN_SEED_SCRIPT,
            'remyral-home',
            loginView.seed.from,
            loginView.seed.to,
            ...inner,
          ];
        }
        argv = [
          ...prelude,
          bwrap.bwrap,
          ...(await this.#bwrapArgs(
            ctx,
            plan,
            { workspace, root, sandboxDir: realSandbox, keepHome },
            bwrap,
            {
              ...(privateNet
                ? {
                    privateNetwork:
                      relay === undefined
                        ? {}
                        : { relay: { hostSocket: relay.socket, viewSocket: VIEW_EGRESS_SOCKET } },
                  }
                : {}),
              ...(loginView === null ? {} : { loginStoreHome: loginView.view }),
              ...(relay === undefined ? {} : { node: bwrap.node }),
            },
          )),
          '--',
          ...inner,
        ];
      } else if (this.filesystemConfinement === 'seatbelt') {
        const homes = new Set<string>();
        const workerHome = plan.env.HOME ?? process.env.HOME;
        for (const h of [
          ...(this.#o.protectedHomes ?? []),
          ...(workerHome === undefined ? [] : [workerHome]),
        ]) {
          homes.add(await realOrSelf(h));
        }
        const sb = buildSeatbeltProfile({
          workspace,
          sandboxDir: realSandbox,
          workspaceRoot: root,
          workerDataDir: await realOrSelf(this.#o.workerDataDir),
          ...(this.#o.readableInDataDir === undefined
            ? {}
            : { readableInDataDir: await Promise.all(this.#o.readableInDataDir.map(realOrSelf)) }),
          mirrorObjects: ctx.git?.mirrorObjects,
          homes: [...homes],
          ...(this.#o.allowKeychain === undefined ? {} : { allowKeychain: this.#o.allowKeychain }),
          ...(this.#o.allowListen === true ||
          ctx.listen === true ||
          (ctx.runtime !== undefined && this.#o.listenRuntimes?.includes(ctx.runtime) === true)
            ? { allowListen: true }
            : {}),
          ...(this.#o.extraWritable === undefined
            ? {}
            : { extraWritable: await Promise.all(this.#o.extraWritable.map(realOrSelf)) }),
          // p13-runtime-accounts: the account folder lies in the data dir: writable for this attempt (like a cache).
          ...(ctx.loginFolder === undefined ? {} : { loginDirs: [await realOrSelf(ctx.loginFolder)] }),
          proxyPort: proxy?.port,
          // p19-ide W2b: the IDE's bridge port, its IPC sockets under the run dir, its mirror read-only.
          ...(ctx.loopbackPorts === undefined || ctx.loopbackPorts.length === 0
            ? {}
            : { loopbackPorts: [...ctx.loopbackPorts] }),
          ...(ctx.unixSocketDirs === undefined || ctx.unixSocketDirs.length === 0
            ? {}
            : { unixSocketDirs: await Promise.all(ctx.unixSocketDirs.map(realOrSelf)) }),
          ...(ctx.readOnlyDirs === undefined || ctx.readOnlyDirs.length === 0
            ? {}
            : { readOnlyDirs: await Promise.all(ctx.readOnlyDirs.map(realOrSelf)) }),
          ...(ctx.packageCaches === undefined
            ? {}
            : { cacheDirs: await Promise.all(ctx.packageCaches.dirs.map(realOrSelf)) }),
        });
        argv = [...sb.argv, ...argv];
      }
      const [command, ...args] = argv;
      const onEscaped = this.#o.onEscapedProcesses;
      const treeKiller = reapingTreeKiller({
        token,
        startedAtMs: Date.now(),
        // Every recent orphan of the user is ours only on the verified dedicated user with one attempt.
        orphans: () => (this.#o.identity.verified && this.#active <= 1 ? 'all-recent' : 'in-dirs'),
        dirs: [workspace, realSandbox],
        deps: { platform: this.#platform, uid: process.getuid?.() ?? -1, selfPid: process.pid },
        ...(onEscaped
          ? {
              onSweep: (r: SweepResult) => {
                onEscaped({ ...r, jobId: ctx.jobId });
              },
            }
          : {}),
      });
      return { command: command ?? '/bin/sh', args, cwd: workspace, env, treeKiller, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  // ------------------------------------------------------------------ Linux per-attempt view

  /**
   * p22-worker-limits: whether an attempt in a view may lose the host network — not when the worker reaches it on
   * loopback: services and IDE servers (`listen`, `loopbackPorts`), loopback API runtimes (OpenCode), jobs that may
   * open preview links (`hostNetwork`), or a machine that lets every attempt listen (`allowListen`).
   */
  #privateNetworkFor(ctx: SandboxContext): boolean {
    if (ctx.listen === true || ctx.hostNetwork === true || this.#o.allowListen === true) return false;
    if ((ctx.loopbackPorts?.length ?? 0) > 0) return false;
    return !(ctx.runtime !== undefined && this.#o.listenRuntimes?.includes(ctx.runtime) === true);
  }

  /**
   * p22-worker-limits: the login-store view of a local-login attempt — the worker HOME as a private tmpfs with its
   * entries read-only (caches fresh), the login stores read-write, their trusted configuration read-only (created
   * empty when missing, so an attempt cannot plant one for the next), and `~/.claude.json` as a private copy.
   */
  async #loginStoreHome(
    plan: SpawnPlan,
    sandboxDir: string,
  ): Promise<{ view: LoginStoreHome; seed?: { from: string; to: string } } | null> {
    const raw = plan.env.HOME ?? process.env.HOME;
    if (raw === undefined) return null;
    const home = await realOrSelf(raw);
    const entries = await readdir(home).catch(() => [] as string[]);
    const readOnly = entries
      .filter((n) => !LOGIN_STORE_TOP.has(n) && !FRESH_HOME_ENTRIES.has(n))
      .map((n) => join(home, n));
    const extra = await Promise.all((this.#o.extraWritable ?? []).map(realOrSelf));
    const stores = [
      ...LOGIN_STORE_DIRS.map((r) => join(home, r)),
      ...extra.filter((p) => p.startsWith(`${home}/`)),
    ];
    const protect: string[] = [];
    for (const { store, files, dirs } of LOGIN_STORE_PROTECTED) {
      const dir = join(home, store);
      if ((await lstat(dir).catch(() => null))?.isDirectory() !== true) continue;
      for (const f of files) {
        const p = join(dir, f);
        if ((await lstat(p).catch(() => null)) === null) {
          await writeFile(p, f.endsWith('.json') ? '{}\n' : '', { mode: 0o600, flag: 'wx' }).catch(
            () => undefined,
          );
        }
        protect.push(p);
      }
      for (const d of dirs) {
        const p = join(dir, d);
        await mkdir(p, { recursive: true, mode: 0o700 }).catch(() => undefined);
        protect.push(p);
      }
    }
    const view: LoginStoreHome = { home, readOnly, stores, protect };
    const claudeJson = join(home, '.claude.json');
    if ((await lstat(claudeJson).catch(() => null))?.isFile() !== true) return { view };
    const seedDir = join(sandboxDir, 'login-seed');
    await mkdir(seedDir, { recursive: true, mode: 0o700 });
    const from = join(seedDir, 'claude.json');
    await copyFile(claudeJson, from);
    return { view, seed: { from, to: claudeJson } };
  }

  /** The attempt's bubblewrap arguments (linux-isolation.ts) from its context; every path resolved. */
  async #bwrapArgs(
    ctx: SandboxContext,
    plan: SpawnPlan,
    dirs: { workspace: string; root: string; sandboxDir: string; keepHome: boolean },
    bwrap: { pidNamespace: boolean },
    extra2: {
      privateNetwork?: { relay?: { hostSocket: string; viewSocket: string } };
      loginStoreHome?: LoginStoreHome;
      node?: string;
    } = {},
  ): Promise<string[]> {
    const workerHomeRaw = plan.env.HOME ?? process.env.HOME;
    const workerHome = workerHomeRaw === undefined ? undefined : await realOrSelf(workerHomeRaw);
    const homes = new Set<string>();
    for (const h of [...(this.#o.protectedHomes ?? []), ...(workerHome === undefined ? [] : [workerHome])]) {
      homes.add(await realOrSelf(h));
    }
    const extra = await Promise.all((this.#o.extraWritable ?? []).map(realOrSelf));
    const shared = dirs.keepHome ? workerHome : undefined;
    // An attempt that does not use the worker's subscription login sees none of its login stores.
    const loginStores =
      shared === undefined
        ? [...extra, ...(workerHome === undefined ? [] : HOME_LOGIN_STORES.map((r) => join(workerHome, r)))]
        : [];
    return buildHostBwrapArgs(
      {
        workspace: dirs.workspace,
        sandboxDir: dirs.sandboxDir,
        workspaceRoot: dirs.root,
        workerDataDir: await realOrSelf(this.#o.workerDataDir),
        readableInDataDir: await Promise.all((this.#o.readableInDataDir ?? []).map(realOrSelf)),
        mirrorObjects:
          ctx.git?.mirrorObjects === undefined ? undefined : await realOrSelf(ctx.git.mirrorObjects),
        // p19-ide W2b: the IDE's repository mirror (read-only, for its own git).
        // p22-worker-limits: the Node binary of the in-view egress forwarder (it may lie below the data dir).
        readOnly: [
          ...(await Promise.all((ctx.readOnlyDirs ?? []).map(realOrSelf))),
          ...(extra2.node === undefined ? [] : [await realOrSelf(extra2.node)]),
        ],
        writable: [
          ...(ctx.packageCaches === undefined
            ? []
            : await Promise.all(ctx.packageCaches.dirs.map(realOrSelf))),
          ...(ctx.loginFolder === undefined ? [] : [await realOrSelf(ctx.loginFolder)]),
          // local-login: login state dirs the owner configured outside the worker HOME stay writable.
          ...(shared === undefined ? [] : extra.filter((p) => !(p === shared || p.startsWith(`${shared}/`)))),
        ],
        homes: [...homes],
        mask: loginStores,
        sharedHome: shared,
        pidNamespace: bwrap.pidNamespace,
        ...(extra2.privateNetwork === undefined ? {} : { privateNetwork: extra2.privateNetwork }),
        ...(extra2.loginStoreHome === undefined ? {} : { loginStoreHome: extra2.loginStoreHome }),
      },
      dirs.workspace,
    );
  }

  // ------------------------------------------------------------------ Windows per-job accounts

  #acl(args: readonly string[]): Promise<void> {
    const next = this.#aclQueue.then(() => icacls(args, this.#o.runFile ?? runFile));
    this.#aclQueue = next.catch(() => undefined);
    return next;
  }

  /** First spawn of an attempt on its slot: restrict its dirs to the slot, grant what it needs to read. */
  async #prepareSlot(
    ctx: SandboxContext,
    slot: JobSlot,
    workspace: string,
    sandboxDir: string,
  ): Promise<void> {
    const workerSid = this.#o.identity.sid;
    if (workerSid === undefined || workerSid === null) {
      throw new SandboxRequestError('identity', 'the worker SID is unknown; per-job accounts need it');
    }
    const grants: string[] = [];
    const lent =
      ctx.authMode === 'local-login' && this.#o.windowsSlots?.accountLending() === true
        ? ctx.loginFolder
        : undefined;
    this.#slotGrants.set(ctx.attemptId, { workspace, dirs: grants, loginFolder: lent });
    await this.#acl(slotAttemptAclArgs(workspace, workerSid, slot.sid));
    await this.#acl(slotAttemptAclArgs(sandboxDir, workerSid, slot.sid));
    // The attempt's private git dir reads the mirror's objects through `alternates`: read-only, this attempt only.
    const mirrorObjects = ctx.git?.mirrorObjects;
    if (mirrorObjects !== undefined) {
      await this.#acl(slotGrantArgs(mirrorObjects, slot.sid, 'RX'));
      grants.push(mirrorObjects);
    }
    for (const dir of ctx.packageCaches?.dirs ?? []) {
      await this.#acl(slotGrantArgs(dir, slot.sid, 'M'));
      grants.push(dir);
    }
    // p19-ide W2b: further read-only directories (the IDE's repository mirror), revoked with the other grants.
    for (const dir of ctx.readOnlyDirs ?? []) {
      await this.#acl(slotGrantArgs(dir, slot.sid, 'RX'));
      grants.push(dir);
    }
    // p13-runtime-accounts: the account's folder (config dir + its refresh locks) for this attempt only. The master and
    // the worker policy run one attempt per account at a time; the folder is taken back after the last process.
    if (lent !== undefined) {
      this.#o.windowsSlots?.markLent(lent);
      await this.#acl(slotGrantArgs(lent, slot.sid, 'M'));
    }
  }

  /**
   * After the attempt's last process: remove what the account still runs or scheduled outside the job, revoke its
   * grants and its entry on the workspace; only then is the account free. A failure quarantines the account (no
   * attempt gets it again until the next Prepare).
   */
  async #releaseSlot(attemptId: string, slot: JobSlot): Promise<void> {
    const r = this.#o.windowsSlots?.anyPool()?.release(attemptId);
    if (r !== null && r !== undefined && !r.last) return;
    const grants = this.#slotGrants.get(attemptId);
    this.#slotGrants.delete(attemptId);
    const problems: string[] = [];
    await this.#sweepSlot(slot).catch((err: unknown) => {
      problems.push(`sweep: ${err instanceof Error ? err.message : String(err)}`);
    });
    for (const dir of [...(grants?.dirs ?? []), ...(grants === undefined ? [] : [grants.workspace])]) {
      await this.#acl(slotRevokeArgs(dir, slot.sid)).catch((err: unknown) => {
        problems.push(`revoke ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    // p13-runtime-accounts: the lent account folder goes back to the worker (owner and entries; `/T` — files the slot
    // created there are its own). A failure quarantines the slot; the folder stays marked so the next verify retries.
    const folder = grants?.loginFolder;
    const workerSid = this.#o.identity.sid;
    if (folder !== undefined && workerSid !== undefined && workerSid !== null) {
      const taken = { ok: true };
      for (const args of accountFolderReclaimArgs(folder, workerSid, [slot.sid])) {
        await this.#acl(args).catch((err: unknown) => {
          taken.ok = false;
          problems.push(`take back ${folder}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      if (taken.ok) this.#o.windowsSlots?.markReturned(folder);
    }
    // The pool may have been reloaded meanwhile (Prepare): finish on the current one.
    const pool = this.#o.windowsSlots?.anyPool();
    if (problems.length > 0) pool?.quarantine(slot.index, problems.join('; '));
    pool?.finish(attemptId);
  }

  /** `taskkill` as the slot account itself (it may end its own processes; the worker account may not). */
  async #sweepSlot(slot: JobSlot): Promise<void> {
    const runner = this.#o.windowsJobRunner?.();
    if (runner?.script === undefined || !runner.verified) throw new Error('no verified job runner');
    const file = await writeJobSpec(this.#o.workerDataDir, {
      v: 1,
      commandLine: sweepCommandLine(slot),
      cwd: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      memoryBytes: 256 * 1024 ** 2,
      maxProcesses: 4,
      cpuRatePercent: 100,
      runAs: runAsSpec(slot),
    });
    try {
      const r = await (this.#o.runFile ?? runFile)(
        powershellExe(),
        jobRunnerArgs(runner.script, file),
        60_000,
      );
      // taskkill exits 128 when the account runs nothing any more; 120 is the job runner's own failure.
      if (r.code === 120) throw new Error(`job runner: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
}

/** p22-worker-limits: top-level home entries that are login stores (bound read-write or copied, never read-only). */
const LOGIN_STORE_TOP = new Set(['.claude', '.claude.json', '.claude.lock', '.codex', '.pi']);
/** p22-worker-limits: login store directories of a login-store view (read-write). */
const LOGIN_STORE_DIRS = HOME_LOGIN_STORES.filter((r) => r !== '.claude.json' && r !== '.claude.lock');
/** p22-worker-limits: home caches a login-store view starts fresh (a read-only one would fail installs). */
const FRESH_HOME_ENTRIES = new Set(['.cache', '.npm', '.yarn', '.pnpm-store', '.bun', '.gradle', '.m2']);
/**
 * p22-worker-limits: configuration inside the login stores that a runtime trusts and executes or follows (settings
 * with hooks and MCP servers, instructions, commands, agents, skills, plugins, extensions): read-only in a login-store
 * view, so a local-login attempt cannot plant it for another job family.
 */
export const LOGIN_STORE_PROTECTED: readonly {
  readonly store: string;
  readonly files: readonly string[];
  readonly dirs: readonly string[];
}[] = [
  {
    store: '.claude',
    files: ['settings.json', 'settings.local.json', 'CLAUDE.md'],
    dirs: ['commands', 'agents', 'hooks', 'skills', 'plugins', 'output-styles'],
  },
  { store: '.codex', files: ['config.toml', 'AGENTS.md'], dirs: ['prompts', 'skills'] },
  { store: '.pi/agent', files: ['settings.json', 'AGENTS.md'], dirs: ['extensions', 'skills', 'prompts'] },
];
/** `sh -c` prelude of a login-store view: copy the ~/.claude.json seed into the private home, then exec the command. */
const LOGIN_SEED_SCRIPT = 'cp "$1" "$2" || exit 125; shift 2; exec "$@"';

/** Seatbelt matches resolved paths (`/var` → `/private/var`); missing paths are kept as given. */
async function realOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}
