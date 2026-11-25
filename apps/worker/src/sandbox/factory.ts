import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeKind, SandboxProfile } from '@remyral/protocol';
import { existingAccountFolders } from '../accounts/accounts.js';
import { checkBwrapNamespaces, findBwrap, nodeExec, type NamespaceCheck } from '../probe/bwrap.js';
import type { SandboxSettings } from './config.js';
import { ContainerEngine } from './container/engine.js';
import { ContainerSandboxRunner } from './container/runner.js';
import { verifyWorkerIdentity, type WorkerIdentity } from './host/identity.js';
import { LinuxIsolationController, type StartProcess } from './host/linux-isolation.js';
import { HostRestrictedRunner, type FilesystemConfinement } from './host/runner.js';
import { seatbeltStatus } from './host/seatbelt.js';
import { locateJobRunner, type JobRunnerState, type RunFile } from './host/windows-jobrun.js';
import { loginStorePaths } from './host/windows-login-store.js';
import { WindowsSlotController, type SlotControllerDeps } from './host/windows-slot-controller.js';
import type { WorkerSandboxCapabilities } from './policy.js';
import { RuntimeSandboxRunner } from './runtime-sandbox.js';
import type { SandboxRunner } from './types.js';

/**
 * Wires the three profile runners from the worker config. The daemon calls
 * `createSandboxRunners` once at start (identity is verified then) and
 * `capabilities()` per job for `selectProfile`. Integration into the daemon's
 * job path is p4 work (daemon/ is outside this task).
 */
/** Runtimes whose adapter talks to a server the runtime starts on 127.0.0.1. */
export const LOOPBACK_SERVER_RUNTIMES: ReadonlySet<RuntimeKind> = new Set(['opencode']);

export interface SandboxRunners {
  readonly identity: WorkerIdentity;
  readonly platform: NodeJS.Platform;
  readonly container: ContainerSandboxRunner;
  readonly host: HostRestrictedRunner;
  readonly runtimeSandbox: RuntimeSandboxRunner;
  /** ADR-0019: the `unconfined` runner (ready only when the panel allowed it and the ceiling does not forbid it). */
  readonly unconfined: HostRestrictedRunner;
  /** macOS: whether sandbox-exec works (factory check). */
  readonly seatbeltAvailable: boolean;
  /** Linux: the bubblewrap namespace check. */
  readonly namespaces: NamespaceCheck | undefined;
  /** Windows: the job runner (located + self-tested). */
  jobRunner(): JobRunnerState | undefined;
  /** Windows: locate / rewrite / self-test the job runner again (sandbox.prepare). */
  refreshJobRunner(): Promise<JobRunnerState | undefined>;
  /** Windows: the per-job account pool (p9-windows-host-isolation); undefined elsewhere or when turned off. */
  readonly windowsSlots: WindowsSlotController | undefined;
  /** Linux: the per-attempt bubblewrap isolation (p19-linux-host-isolation); undefined elsewhere. */
  readonly linuxIsolation: LinuxIsolationController | undefined;
  /**
   * Attempts of `host-restricted` (and `runtime-sandbox`, which runs on it) this worker can isolate from each other
   * at once: 1 without per-attempt confinement (T-SBX-4); the verified per-job accounts (∩ maxParallelJobs) on
   * Windows; maxParallelJobs with Seatbelt (macOS) and with verified bubblewrap views (Linux, host-restricted only).
   * For CAPABILITIES.profileConcurrency (p9-queue-priority).
   */
  hostRestrictedConcurrency(): number;
  runner(profile: SandboxProfile): SandboxRunner;
  capabilities(opts: {
    runtime: RuntimeKind;
    runningAttempts: number;
    /** Of them, attempts of host-restricted / runtime-sandbox (they hold the per-job accounts). */
    hostAttempts?: number;
  }): Promise<WorkerSandboxCapabilities>;
}

/** The worker's install dir (the bundle's directory), where install.ps1 puts remyral-jobrun.ps1. */
export function defaultInstallDir(): string | undefined {
  const entry = process.argv[1];
  return entry === undefined || entry === '' ? undefined : dirname(entry);
}

export async function createSandboxRunners(opts: {
  settings: SandboxSettings;
  workspaceRoot: string;
  dataDir: string;
  platform?: NodeJS.Platform;
  identity?: WorkerIdentity;
  /** Tests: result of the bwrap namespace check instead of running it. */
  namespaces?: NamespaceCheck;
  /** ADR-0019: panel `allowUnconfined` ∩ local ceiling, read per check (hot reload). Default: never. */
  unconfinedAllowed?: () => { allowed: boolean; code?: string; detail?: string };
  /** Windows: install dir holding an installer-placed remyral-jobrun.ps1 (default: the bundle's dir). */
  installDir?: string;
  /** Tests: job runner state instead of locating + self-testing it. */
  jobRunner?: JobRunnerState;
  /** Tests: process runner (job runner self-test, icacls). */
  runFile?: RunFile;
  /** Effective maxParallelJobs (read per call; managed config can change it). Default 1. */
  maxParallelJobs?: () => number;
  /** Windows: `<config dir>\job-slots` (p9-windows-host-isolation); absent = no per-job accounts. */
  slotStateDir?: string;
  /** Tests: controller dependencies (state reads, self-test). */
  slotDeps?: Partial<SlotControllerDeps>;
  /** Readiness changed outside a request (background self-test finished): re-send CAPABILITIES. */
  onChanged?: () => void;
  /** Linux tests: bubblewrap lookup and process starter of the isolation self-check. */
  linuxIsolation?: {
    findBwrap?: () => Promise<string | null>;
    start?: StartProcess;
    trusted?: (bwrap: string) => Promise<string | null>;
  };
}): Promise<SandboxRunners> {
  const platform = opts.platform ?? process.platform;
  const s = opts.settings;
  const identity = opts.identity ?? (await verifyWorkerIdentity({ expectedUser: s.workerUser, platform }));
  const seatbelt = s.seatbelt;
  // `required` but unusable → the host runner refuses instead of running unconfined.
  const seatbeltAvailable = platform === 'darwin' ? (await seatbeltStatus(platform)).available : false;
  const installDir = opts.installDir ?? defaultInstallDir();
  const locate = (): Promise<JobRunnerState> =>
    locateJobRunner({
      configured: s.windowsJobHelper,
      installDir,
      dataDir: opts.dataDir,
      ...(opts.runFile === undefined ? {} : { run: opts.runFile }),
    });
  let jobRunner: JobRunnerState | undefined =
    platform === 'win32' ? (opts.jobRunner ?? (await locate())) : undefined;
  const maxParallel = opts.maxParallelJobs ?? (() => 1);
  // p9-windows-host-isolation: per-job accounts, unless the owner turned them off (`windowsJobSlots: 0`).
  const windowsSlots =
    platform === 'win32' && opts.slotStateDir !== undefined && s.windowsJobSlots !== 0
      ? new WindowsSlotController({
          stateDir: opts.slotStateDir,
          workspaceRoot: opts.workspaceRoot,
          dataDir: opts.dataDir,
          workerSid: identity.sid ?? null,
          identityVerified: identity.verified,
          jobRunner: () => jobRunner,
          // p9-windows-slots-local-login: the slots never get the worker's subscription login store.
          loginStores: loginStorePaths(s.hostExtraWritable),
          // p13-runtime-accounts: added accounts' folders are lent per attempt and taken back on every verify.
          accountFolders: () => existingAccountFolders(opts.dataDir, (p) => readdir(p)),
          ...(opts.runFile === undefined ? {} : { run: opts.runFile }),
          ...opts.slotDeps,
        })
      : undefined;
  // Loads the pool and the stored self-test result; runs the self-test in the background when none is current
  // (it starts PowerShell once per account, so the worker does not wait for it).
  await windowsSlots?.reload().catch(() => undefined);
  const common = {
    identity,
    workspaceRoot: opts.workspaceRoot,
    workerDataDir: opts.dataDir,
    // p14-mcp-stdio: local MCP server installs (`<dataDir>/mcp`) are readable too, never writable.
    // p14-repo-egress: worker-managed tools (`<dataDir>/tools`, on the job's PATH) are readable, never writable.
    readableInDataDir: [
      join(opts.dataDir, 'runtimes'),
      join(opts.dataDir, 'mcp'),
      join(opts.dataDir, 'tools'),
      // p19-ide W2b: the verified IDE server install (`<dataDir>/ide/server`; never the extension cache or records).
      join(opts.dataDir, 'ide', 'server'),
    ],
    platform,
    windowsJobRunner: () => jobRunner,
    ...(opts.runFile === undefined ? {} : { runFile: opts.runFile }),
  };
  const unconfined = new HostRestrictedRunner({
    ...common,
    mode: 'unconfined',
    unconfinedAllowed: opts.unconfinedAllowed ?? (() => ({ allowed: false, code: 'unconfined_not_enabled' })),
  });
  // p19-linux-host-isolation (ADR-0066): per-attempt bubblewrap views once the cross-attempt self-check passed.
  const readable = [
    join(opts.dataDir, 'runtimes'),
    join(opts.dataDir, 'mcp'),
    join(opts.dataDir, 'tools'),
    join(opts.dataDir, 'ide', 'server'),
  ];
  const linuxIsolation =
    platform === 'linux'
      ? new LinuxIsolationController({
          mode: s.linuxHostIsolation,
          // p22-worker-limits: the network self-check runs after the cross-attempt one.
          privateNetwork: s.linuxPrivateNetwork,
          platform,
          workspaceRoot: opts.workspaceRoot,
          dataDir: opts.dataDir,
          readableInDataDir: readable,
          findBwrap: opts.linuxIsolation?.findBwrap ?? (() => findBwrap()),
          ...(opts.linuxIsolation?.start === undefined ? {} : { start: opts.linuxIsolation.start }),
          ...(opts.linuxIsolation?.trusted === undefined ? {} : { trusted: opts.linuxIsolation.trusted }),
        })
      : undefined;
  const host = new HostRestrictedRunner({
    identity,
    workspaceRoot: opts.workspaceRoot,
    workerDataDir: opts.dataDir,
    // p5-remote-ops: worker-managed runtime installs stay readable (read-only) for the jobs that run them.
    // p14-mcp-stdio: local MCP server installs (`<dataDir>/mcp`) are readable too, never writable.
    // p14-repo-egress: worker-managed tools (`<dataDir>/tools`, on the job's PATH) are readable, never writable.
    readableInDataDir: [
      join(opts.dataDir, 'runtimes'),
      join(opts.dataDir, 'mcp'),
      join(opts.dataDir, 'tools'),
      // p19-ide W2b: the verified IDE server install (`<dataDir>/ide/server`; never the extension cache or records).
      join(opts.dataDir, 'ide', 'server'),
    ],
    platform,
    seatbelt,
    seatbeltAvailable,
    protectedHomes: s.protectedHomes,
    extraWritable: s.hostExtraWritable,
    keepHome: s.keepHome,
    allowKeychain: s.allowKeychain,
    windowsJobRunner: () => jobRunner,
    ...(opts.runFile === undefined ? {} : { runFile: opts.runFile }),
    // p9-windows-slots-local-login: local-login attempts never run on a slot (the login store stays the worker's).
    ...(windowsSlots === undefined ? {} : { windowsSlots }),
    ...(linuxIsolation === undefined ? {} : { linuxIsolation }),
    // p22-worker-limits: local-login attempts in a login-store view (opt-in; off by default).
    linuxLoginStoreView: s.linuxLoginStoreView,
    // Loopback API servers (OpenCode serve) must accept the worker's connection.
    // Seatbelt cannot limit listening to loopback (p3-sandbox decision 5), so only these runtimes get it.
    listenRuntimes: [...LOOPBACK_SERVER_RUNTIMES],
  });
  const container = new ContainerSandboxRunner({
    engine: new ContainerEngine({ binary: s.container.engine }),
    images: s.container.images,
    proxyImage: s.container.proxyImage,
    egressNetwork: s.container.egressNetwork,
    user: s.container.user,
    platform,
  });
  // Linux: the runtime sandboxes are bubblewrap; verify namespaces once at start (handson finding 2).
  const namespaces =
    opts.namespaces ??
    (platform === 'linux' ? await checkBwrapNamespaces(nodeExec, await findBwrap(), platform) : undefined);
  const runtimeSandbox = new RuntimeSandboxRunner(host, platform, namespaces);
  const hostConcurrency = (fs: FilesystemConfinement): number =>
    fs === 'seatbelt' || fs === 'bwrap'
      ? Math.max(1, Math.min(64, maxParallel()))
      : fs === 'job_user' && windowsSlots !== undefined
        ? windowsSlots.concurrency(maxParallel())
        : 1;
  // Also after a failed result (live 2026-10-17): a failure stored before this process started — e.g. the token
  // lacked the new privileges until the service restarted — must not keep the pool off until the next Prepare.
  // p9-windows-slots-local-login: always once at start — the login-store check gates the pool (a current passing
  // self-test is not repeated by a non-forced verify).
  const slotCode = windowsSlots?.status().code;
  if (
    windowsSlots !== undefined &&
    slotCode !== 'job_slots_unprovisioned' &&
    slotCode !== 'job_slots_invalid'
  ) {
    void windowsSlots
      .verify()
      .then(() => opts.onChanged?.())
      .catch(() => undefined);
  }
  // p19-linux-host-isolation: the self-check runs in the background (two short probe attempts); host jobs run one at a
  // time until it passed.
  if (linuxIsolation !== undefined && s.linuxHostIsolation !== 'off') {
    void linuxIsolation
      .verify()
      .then((st) => {
        opts.onChanged?.();
        // p19-auto-bwrap: bubblewrap installed later (helper after an update, or by hand) opens the slots, no restart.
        if (st.code === 'host_isolation_bwrap_missing') linuxIsolation.watchBwrap(() => opts.onChanged?.());
      })
      .catch(() => undefined);
  }
  return {
    identity,
    platform,
    container,
    host,
    runtimeSandbox,
    unconfined,
    seatbeltAvailable,
    namespaces,
    jobRunner: () => jobRunner,
    refreshJobRunner: async () => {
      if (platform !== 'win32') return undefined;
      jobRunner = await locate();
      return jobRunner;
    },
    windowsSlots,
    linuxIsolation,
    hostRestrictedConcurrency: () => hostConcurrency(host.filesystemConfinement),
    runner: (profile) =>
      profile === 'container'
        ? container
        : profile === 'runtime-sandbox'
          ? runtimeSandbox
          : profile === 'unconfined'
            ? unconfined
            : host,
    capabilities: async ({ runtime, runningAttempts, hostAttempts }) => {
      const hostCap = host.check();
      const runtimeCap = runtimeSandbox.check(runtime);
      return {
        platform,
        container: await container.check(runtime),
        hostRestricted: { ...hostCap, concurrency: hostConcurrency(hostCap.filesystemConfinement) },
        runtimeSandboxes: runtimeCap.ready ? [runtime] : [],
        unconfined: unconfined.check(),
        runningAttempts,
        ...(hostAttempts === undefined ? {} : { hostAttempts }),
      };
    },
  };
}
