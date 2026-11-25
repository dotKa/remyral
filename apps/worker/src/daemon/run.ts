import { hostFallback } from '../sandbox/host/fallback.js';
import { createLogger, Redactor, type LogSink, type Logger } from '@remyral/observability';
import { BOOT_LOG, currentBootGuard } from '../boot/guard.js';
import { pathApi } from '../config/paths.js';
import { dataLayout, defaultInstallDir as updateInstallDir, installLayout } from '../update/layout.js';
import { loadConfig } from '../config/load.js';
import type { PathHost } from '../config/paths.js';
import type { WorkerConfig } from '../config/schema.js';
import type { FileOps } from '../fs/ops.js';
import { createKeystore, loadOrCreateDeviceKey } from '../identity/keystore.js';
import { WORKER_VERSION } from '../probe/probe.js';
import { WorkerStore } from '../store/store.js';
import type { HostFacts } from '@remyral/protocol';
import type { TransportPort } from '../transport/port.js';
import { WsTransport } from '../transport/ws.js';
import { ChildRegistry } from './children.js';
import { jobRunnerFromConfig } from '../jobs/from-config.js';
import { WorkerDaemon, type DaemonStopInfo } from './daemon.js';
import { type CapabilitiesPayload, createLoadSampler } from './telemetry.js';
import type { ShutdownSignals } from './signals.js';
import { createUpdateAgent } from '../update/index.js';
import {
  CatalogStore,
  catalogPins,
  catalogRecipes,
  mergeInstallManifest,
  releaseFloor,
  trustedCatalogKeys,
} from '../catalog/index.js';
import { type Downloader, httpsDownloader } from '../update/download.js';
import { RUNTIME_PINS } from '@remyral/protocol';
import type {
  AssistantRuntime,
  RuntimeKind,
  RuntimePolicyDelivery,
  WorkerDoctorReport,
} from '@remyral/protocol';
import { workerCapabilities } from '../probe/capabilities.js';
import { RuntimePolicyStore, runtimePolicyHooks } from '../runtime-policy/index.js';
import { LeaseKeyring } from '../jobs/keyring.js';
import { ManagedConfig } from '../managed-config/index.js';
import type { SettingsContext } from '../managed-config/manager.js';
import {
  machineAdminInEffect,
  settingsPlan,
  verifyRuntimePaths,
  withSettings,
} from '../managed-config/settings.js';
import { WorkerConfigStore } from '../managed-config/store.js';
import { ManageRequester } from '../remote-ops/manage.js';
import { createSecretStore } from '../secrets/factory.js';
import { CredentialVault, trackVaultUse } from '../vault/index.js';
import {
  type AssistantEngine,
  DEFAULT_INHERITED_ENV,
  readClaudeSdkPackageInfo,
  resolveBundledClaudeBinary,
} from '@remyral/agent-adapters';
import { join } from 'node:path';
import { AssistantHost } from '../assistant/index.js';
import { LoginHealthMonitor } from '../remote-ops/login-health.js';
import { AssistantAttachmentFetcher } from '../assistant/attachments.js';
import { createAssistantEngines } from '../assistant/engines.js';
import { AssistantSandbox } from '../assistant/sandbox.js';
import { checkBwrapNamespaces, findBwrap, nodeExec } from '../probe/bwrap.js';
import { bwrapTrusted } from '../sandbox/host/linux-isolation.js';
import { limitsFromSettings } from '../sandbox/config.js';
import { seatbeltStatus } from '../sandbox/host/seatbelt.js';
import { planJobEnv, resolveJobEnv } from '../secrets/env.js';
import type { LoginRuntime, RuntimeAccountReport } from '@remyral/protocol';
import { constants as fsConstants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  ACCOUNTS_DIR,
  existingAccountFolders,
  findAccount,
  isAccountRuntime,
  removeAccountFolder,
  type RuntimeAccount,
  syncAccountFolders,
} from '../accounts/accounts.js';
import { sandboxReadiness } from '../probe/capabilities.js';
import { defaultInstallDir } from '../sandbox/factory.js';
import { SandboxPreparer } from '../sandbox/prepare.js';
import { buildSandboxStatus, privilegedHelperAvailable } from '../sandbox/status.js';
import {
  collectDiagnostics,
  detectService,
  FileLog,
  hostPlatform,
  INSTALL_MANIFEST,
  type InstallManifest,
  LoginManager,
  applyRunLogin,
  RemoteOpsAgent,
  RuntimeInstaller,
  runProcess,
  type RunFn,
} from '../remote-ops/index.js';
import type { SourceOptions } from '../remote-ops/fetch.js';
import { browserHint, openTools, ToolInventory } from '../tools/index.js';
import type { ManagedTool } from '../tools/installer.js';
import { jobToolDirs, managedToolEnv, resolveGitBinary, withJobToolDirs } from '../tools/tool-env.js';
import { GitReadiness } from '../workspace/git-readiness.js';
import type { ToolInventoryEntry } from '@remyral/protocol';
import { machineAdminReport } from '../machine-admin/report.js';
import { profileSlots } from '../sandbox/profile-slots.js';
import { McpInstaller } from '../mcp/install.js';
import { mcpInstallPort } from '../mcp/install-op.js';
import { runMcpProbe } from '../mcp/probe-op.js';
import { sandboxedStdioStarter } from '../mcp/probe-sandbox.js';
import { icacls, mcpInstallAclArgs } from '../sandbox/host/windows-slots.js';
import { RECIPES, UV_VERSION } from '../tools/recipes.js';
import { RuntimeModelLister } from '../runtimes/models.js';
import { runSelfTest } from '../runtimes/selftest.js';
import { createNodeSystem } from '../system/node.js';
import { verifyRuntime } from '../remote-ops/verify-runtime.js';
import { CapabilityVerifier } from '../remote-ops/verify-capabilities.js';
import { serviceOutputFiles } from '../boot/diagnostics.js';
import type { IdeGateway } from '../ide/gateway.js';
import { IdeStreams } from '../ide/streams.js';
import {
  DiskHygiene,
  fileHygieneState,
  hygieneSettings,
  logsSource,
  nodeHygieneFs,
  packageCachesSource,
  releasesSource,
  runtimesSource,
  tempSource,
  workspacesSource,
} from '../disk/index.js';

export interface RunWorkerDeps {
  ops: FileOps;
  host: PathHost;
  signals: ShutdownSignals;
  /** Defaults to the WebSocket transport to `config.masterUrl` (p2-transport). */
  transport?: TransportPort;
  /** Host facts for HELLO (required for the default transport). */
  facts?: () => Promise<HostFacts>;
  /**
   * Runtime/tool inventory for CAPABILITIES (p2-heartbeat-caps); usually a cached probe. Receives the applied
   * runtime policy (p3-runtime-policy) so pins are compared against it.
   */
  capabilities?: (
    maxParallelJobs: number,
    policy: RuntimePolicyDelivery | null,
    /** p17-update-channel: verified version-catalog pins the probe compares with (following rules). */
    followPins?: Partial<Record<RuntimeKind, string>>,
  ) => Promise<CapabilitiesPayload>;
  heartbeatIntervalMs?: number;
  /** Defaults to stderr. */
  logSink?: LogSink;
  configPath?: string | undefined;
  /** Located runtime executable (the probe's PATH/well-known-dir lookup) for the adapter registry. */
  locateRuntime?: (runtime: RuntimeKind) => Promise<string | null>;
  /** Called once the daemon is running (tests use it to trigger events). */
  onStarted?: (daemon: WorkerDaemon, config: WorkerConfig) => void;
  /**
   * p16-doctor: the machine's doctor for the remote op `doctor.run` (the CLI passes the real host; absent: the op is
   * refused and `doctor-v1` is not advertised).
   */
  doctor?: () => Promise<WorkerDoctorReport>;
  /** p2-signed-updates test seams: release downloader and environment for the install dir. */
  updates?: { download?: Downloader; env?: (name: string) => string | undefined };
  /** p5-ops-chat test seams: assistant engines (default: Claude Code; the fake with `devFakeRuntime`). */
  assistant?: {
    engines?: Partial<Record<AssistantRuntime, AssistantEngine>>;
    clock?: () => Date;
  };
  /** p5-remote-ops test seams: install set, sources, helper processes, environment, service. */
  remoteOps?: {
    manifest?: InstallManifest;
    source?: SourceOptions;
    run?: RunFn;
    env?: NodeJS.ProcessEnv;
    restartable?: boolean;
    /** Grace before the restart exit (lets the final OPS_UPDATE leave). Default 1 s. */
    restartDelayMs?: number;
    /** Clock for command validity windows (tests against a master with a fake clock). */
    clock?: () => Date;
    /** Free bytes required before an install (default 1 GiB). */
    minFreeBytes?: number;
    /** p16-runtime-updates test seam: the npm resolve step of unverified installs (writes package-lock.json). */
    resolveNpm?: (dir: string, opts: { readonly signal?: AbortSignal }) => Promise<void>;
    /** p16-runtime-updates test seam: the self-test of a verification candidate (default: runtimes/selftest.ts). */
    selfTest?: (
      runtime: RuntimeKind,
      launch: { file: string; args: readonly string[] },
      expectedVersion: string,
    ) => Promise<{ ok: boolean; detail: string }>;
  };
  /** p5-machine-admin test seams: tool detection, helper install dir. */
  tools?: {
    detect?: (managed: readonly ManagedTool[]) => Promise<ToolInventoryEntry[]>;
    source?: SourceOptions;
  };
  machineAdmin?: { installDir?: string | null };
  /**
   * p8-preview-tunnels test seams: `false` turns previews off; `cloudflared` replaces the lookup (a fake connector).
   */
  previews?:
    | false
    | {
        cloudflared?: () => Promise<{ path: string; version: string; source: 'managed' | 'system' } | null>;
      };
}

/**
 * `remyral-worker run`: load config → logger + redaction → store → keystore/device
 * key → daemon (offline) → wait for a shutdown signal. Throws ConfigError /
 * InsecurePermissionsError / KeystoreError before anything starts.
 */
export async function runWorker(deps: RunWorkerDeps): Promise<DaemonStopInfo> {
  const fileConfig = await loadConfig(deps.ops, deps.host, { explicitPath: deps.configPath });
  // p17-worker-managed: the panel's local settings (last applied document) laid over the local file before anything is
  // built from it; later changes wait for a restart (reported as pendingRestart), the log level applies at once.
  const settingsStart = await startSettings(deps.ops, fileConfig);
  const config = settingsStart.config;
  const redactor = new Redactor();
  // p5-remote-ops: every (already redacted) log line is also kept in <dataDir>/logs for remote viewing.
  const fileLog = new FileLog(config.dataDir, config.remoteOps.logFileBytes);
  const baseSink: LogSink =
    deps.logSink ??
    ((line) => {
      process.stderr.write(`${line}\n`);
    });
  const logger: Logger = createLogger({
    level: config.logLevel,
    redactor,
    sink: fileLog.tee(baseSink),
    fields: { service: 'remyral-worker', version: WORKER_VERSION },
  });
  // p6-worker-boot-diagnostics: from here on worker.log has everything; boot.log notes that the boot got this far.
  currentBootGuard()?.ready(config.dataDir);
  logger.info('config loaded', {
    source: config.source,
    masterUrl: config.masterUrl,
    workspaceRoot: config.workspaceRoot,
    dataDir: config.dataDir,
    maxParallelJobs: config.maxParallelJobs,
    allowedRuntimes: config.allowedRuntimes,
    keystore: config.keystore,
  });
  // ADR-0023: entries of the local file that named the removed OpenHands runtime were dropped.
  for (const notice of config.notices ?? []) logger.warn('config entry ignored', { notice });
  for (const b of settingsStart.context.bootBlocked) {
    logger.warn('panel setting not applied', { path: b.path, code: b.code, detail: b.detail });
  }
  if (settingsStart.corrupt) {
    logger.error(
      'stored panel configuration is unreadable; local settings apply until the master re-delivers',
    );
  }

  const { store, report } = await WorkerStore.open(deps.ops, config.dataDir);
  if (report.quarantinedCorruptState !== null) {
    logger.error('local state was corrupt; moved aside and started empty — leases need reconciliation', {
      movedTo: report.quarantinedCorruptState,
    });
  }
  if (report.outbox.droppedTornTail || report.outbox.droppedCorrupt > 0) {
    logger.warn('outbound buffer had damaged entries (interrupted write); they were dropped', {
      tornTail: report.outbox.droppedTornTail,
      corrupt: report.outbox.droppedCorrupt,
    });
  }
  if (report.removedTemps > 0)
    logger.info('removed leftovers of interrupted writes', { count: report.removedTemps });

  const keystore = createKeystore(config.keystore, deps.ops, config.dataDir);
  const { key, created } = await loadOrCreateDeviceKey(keystore);
  if (created)
    logger.info('generated a new device key', { fingerprint: key.fingerprint, keystore: keystore.kind });
  if (!keystore.accessControlVerified) {
    logger.warn('device key access control is not verified on this platform (Windows ACL: installer task)', {
      location: keystore.location,
    });
  }

  // p3-runtime-policy: the master-managed runtime policy last applied on this worker.
  const policies = await RuntimePolicyStore.open(deps.ops, config.dataDir);
  if (policies.corrupt) {
    logger.error(
      'stored runtime policy is unreadable; compiled-in pins apply until the master re-delivers it',
    );
  }
  const runtimePolicy = runtimePolicyHooks(policies.store, logger);
  // ADR-0015: panel-managed configuration (last applied document ∩ local ceiling), applied live.
  const keyring = new LeaseKeyring(config.masterLeaseKeys ?? null);
  const { managed } = await ManagedConfig.open(
    deps.ops,
    config,
    () => ({
      keys: keyring.keys,
      pinned: keyring.isPinned,
    }),
    logger,
    undefined,
    settingsStart.context,
  );
  // p17-worker-managed: the log level from the panel applies without a restart.
  managed.subscribe(() => {
    const want = managed.desiredSettings()?.values.logLevel;
    if (want !== undefined && want !== logger.level && logger.setLevel !== undefined) {
      logger.setLevel(want);
      managed.markLive({ logLevel: want });
      logger.info('log level changed by the panel', { level: want });
    }
  });
  // p5-credentials-models: the panel credential vault (X25519 key + index); values live in the secret store.
  const rawSecrets = createSecretStore(
    { secretStore: config.secretStore, dataDir: config.dataDir, keychainPath: config.keychainPath },
    deps.ops,
  );
  const { vault } = await CredentialVault.open({
    ops: deps.ops,
    dataDir: config.dataDir,
    secrets: rawSecrets,
    keySource: () => ({ keys: keyring.keys, pinned: keyring.isPinned }),
    logger,
  });
  managed.setVault(vault);
  vault.subscribe(() => {
    managed.refresh();
  });
  const secretStore = trackVaultUse(rawSecrets, (name) => {
    vault.markUsed(name);
  });
  const transport = deps.transport ?? defaultTransport(config, logger, deps.facts);
  // p19-ide W2 (ADR-0066): the STREAM_* plane for IDE workspaces, when the transport carries binary frames.
  let ideLookup: (workspaceId: string) => IdeGateway | null = () => null;
  const ideStreams =
    transport.setStreamHandler !== undefined && transport.sendBinary !== undefined
      ? new IdeStreams({
          logger,
          transport,
          workerId: () => store.identity?.workerId ?? null,
          gateway: (id) => ideLookup(id),
        })
      : null;
  if (ideStreams !== null) transport.setStreamHandler?.(ideStreams.handler());
  // p5-remote-ops: worker-managed runtime installs (pinned, checksummed) under <dataDir>/runtimes.
  const ro = deps.remoteOps ?? {};
  const env = ro.env ?? process.env;
  const helperEnv: Record<string, string> = {};
  for (const name of DEFAULT_INHERITED_ENV) {
    const v = env[name];
    if (v !== undefined) helperEnv[name] = v;
  }
  const run = ro.run ?? runProcess;
  const installer = await RuntimeInstaller.open({
    ops: deps.ops,
    dataDir: config.dataDir,
    manifest: ro.manifest ?? INSTALL_MANIFEST,
    host: hostPlatform(),
    nodePath: process.execPath,
    source: {
      ...(config.remoteOps.npmRegistry === undefined ? {} : { npmRegistry: config.remoteOps.npmRegistry }),
      ...ro.source,
    },
    logger,
    ...(ro.minFreeBytes === undefined ? {} : { minFreeBytes: ro.minFreeBytes }),
    // p16-runtime-updates: unverified installs run the worker's own npm and the runtime's `--version`.
    run,
    env,
    ...(ro.resolveNpm === undefined ? {} : { resolveNpm: ro.resolveNpm }),
  });
  // p5-machine-admin: tool inventory (cached), unprivileged recipe installs, read-only inspection.
  // p15-git-central: the worker account's git readiness, for the git jobs use (config → worker-installed → PATH).
  const gitReadiness = new GitReadiness({
    gitBinary: async () => {
      const r = resolveGitBinary(config.gitBinary, await tools.installer.installed());
      return { binary: r.binary, source: r.source };
    },
    env,
  });
  // p17-update-channel (ADR-0065): the accepted version catalog extends the runtime install set and the tool recipes.
  const releaseManifest = ro.manifest ?? INSTALL_MANIFEST;
  const versionCatalog = await CatalogStore.open({
    ops: deps.ops,
    dataDir: config.dataDir,
    keys: trustedCatalogKeys(config.updates.catalogKeys),
    enabled: config.updates.catalog,
    floor: releaseFloor(releaseManifest, RECIPES),
    logger,
  });
  let mergedManifest = mergeInstallManifest(releaseManifest, versionCatalog.catalog);
  const catalogPinsNow = (): Partial<Record<RuntimeKind, string>> => catalogPins(mergedManifest);
  installer.setManifest(mergedManifest);
  const tools = await openTools({
    ops: deps.ops,
    dataDir: config.dataDir,
    logger,
    redactor,
    log: fileLog,
    run,
    env: helperEnv,
    ...(deps.tools?.source === undefined ? {} : { source: deps.tools.source }),
    ...(config.gitBinary === undefined ? {} : { gitBinary: config.gitBinary }),
    // p13-fleet-tools (ADR-0052): custom installs only where the owner enabled machine administration (signed
    // managed config) and the local ceiling does not forbid machine administration or custom tools.
    customAllowed: () => {
      if (config.localCeiling?.allowCustomTools === false)
        return 'the local config forbids custom tools (localCeiling.allowCustomTools: false)';
      if (config.localCeiling?.allowMachineAdmin === false)
        return 'the local config forbids machine administration (localCeiling.allowMachineAdmin: false)';
      if (managed.effective.machineAdmin?.enabled !== true)
        return 'machine administration is not enabled for this worker (Machines → <machine> → Admin → Machine admin)';
      return null;
    },
    // The dev/test fake runtime never probes the real machine (tests stay hermetic and fast).
    ...(deps.tools?.detect !== undefined
      ? { detect: deps.tools.detect }
      : config.devFakeRuntime
        ? { detect: () => Promise.resolve([]) }
        : {}),
  });
  // p14-mcp-stdio (ADR-0054 P4): local MCP server installs (`<dataDir>/mcp`, read-only to jobs). Windows: the
  // per-job accounts get read + execute on each install (the slot group of the prepared job slots).
  let mcpAcl: ((dir: string) => Promise<'applied' | 'skipped'>) | null = null;
  const mcpStdioAllowed = () =>
    config.localCeiling?.allowMcp !== false && config.localCeiling?.allowMcpStdio !== false;
  let scriptBwrap: Promise<string | null> | null = null;
  const usableScriptBwrap = async (): Promise<string | null> => {
    if (process.platform !== 'linux') return null;
    const path = await findBwrap();
    if (path === null || (await bwrapTrusted(path)) !== null) return null;
    return (await checkBwrapNamespaces(nodeExec, path, process.platform)).usable === true ? path : null;
  };
  const mcpInstaller = await McpInstaller.open({
    ops: deps.ops,
    dataDir: config.dataDir,
    host: hostPlatform(),
    nodePath: process.execPath,
    run,
    env: process.env,
    logger,
    ...(deps.tools?.source === undefined ? {} : { source: deps.tools.source }),
    uv: async ({ signal }) => {
      const have = (await tools.installer.installed()).find(
        (t) => t.tool === 'uv' && t.version === UV_VERSION,
      );
      if (have !== undefined) return have.entry;
      return (await tools.installer.install('uv', UV_VERSION, signal === undefined ? {} : { signal })).entry;
    },
    acl: (dir) => (mcpAcl === null ? Promise.resolve('skipped' as const) : mcpAcl(dir)),
    // p19-install-scripts (ADR-0068): approved install scripts run inside bubblewrap on Linux when it is usable and
    // trusted; the protected homes are hidden from them (the data dir always is).
    scriptBwrap: () => (scriptBwrap ??= usableScriptBwrap()),
    scriptHide: [
      ...config.sandbox.protectedHomes,
      ...(typeof env.HOME === 'string' && env.HOME.startsWith('/') ? [env.HOME] : []),
    ],
  });
  mcpInstaller.subscribe(() => daemonRef?.refreshCapabilities());
  tools.installer.setCatalogRecipes(catalogRecipes(RECIPES, versionCatalog.catalog));
  versionCatalog.subscribe(() => {
    mergedManifest = mergeInstallManifest(releaseManifest, versionCatalog.catalog);
    installer.setManifest(mergedManifest);
    tools.installer.setCatalogRecipes(catalogRecipes(RECIPES, versionCatalog.catalog));
    daemonRef?.refreshCapabilities();
  });
  /** The catalog pins the probe compares with: not for a runtime that still runs its release pin (no false mismatch). */
  const probeFollowPins = (): Partial<Record<RuntimeKind, string>> => {
    const out: Partial<Record<RuntimeKind, string>> = {};
    for (const [rt, pin] of Object.entries(catalogPinsNow()) as [RuntimeKind, string][]) {
      if (installer.activeVersion(rt) !== RUNTIME_PINS[rt].version) out[rt] = pin;
    }
    return out;
  };
  const adminInstallDir =
    deps.machineAdmin?.installDir === undefined
      ? defaultInstallDir()
      : (deps.machineAdmin.installDir ?? undefined);
  // p5-claude-auth-health: bound once the login manager exists (it is created after the job wiring).
  let onRuntimeLogin:
    | ((
        runtime: RuntimeKind,
        state: 'expired' | 'ok',
        cause?: 'refresh_contention' | 'expired',
        account?: string,
      ) => void)
    | null = null;
  // p13-runtime-accounts: bound once the login manager exists (folders of added / removed accounts, their logins).
  let onAccountsChanged: ((accounts: readonly RuntimeAccount[]) => void) | null = null;
  // p15-model-picker: the runtimes' model lists (CAPABILITIES runtimeModels); none with the dev fake runtime.
  let runtimeModels: RuntimeModelLister | null = null;
  // Job runner: runtime registry (real adapters), sandbox runners, policy gate (read per job).
  const wiring = await jobRunnerFromConfig(config, {
    onRuntimeLogin: (runtime, state, cause, account) => {
      onRuntimeLogin?.(runtime, state, cause, account);
    },
    onAccountsChanged: (accounts) => {
      onAccountsChanged?.(accounts);
    },
    adminInstallDir: adminInstallDir ?? null,
    // p15-services: the machine owner can refuse services (localCeiling.allowServices: false).
    services: config.localCeiling?.allowServices !== false,
    // p19-ide W2: IDE workspaces (localCeiling.allowIde: false refuses them; no stream plane: none).
    ...(ideStreams === null
      ? {}
      : {
          ide: {
            allowed: config.localCeiling?.allowIde !== false,
            streams: ideStreams,
            // p19-ide W3: VSIX blobs and synced settings of an IDE start, from the master origin only.
            download: httpsDownloader({
              masterUrl: config.masterUrl,
              workerVersion: WORKER_VERSION,
              pathPrefixes: ['/v1/worker/ide/'],
            }),
            ...(consoleOriginOf(config.masterUrl) === null
              ? {}
              : { consoleUrl: consoleOriginOf(config.masterUrl) ?? '' }),
          },
        }),
    // p14-mcp-stdio: stdio servers of jobs start from these installs through the launcher.
    mcpStdio: { installer: mcpInstaller, nodePath: process.execPath, enabled: mcpStdioAllowed },
    toolHints: async (required) => (required.includes('browser') ? browserHint(tools.inventory) : null),
    // p5-live-fixes-2: git and the runtimes' PATH follow the worker-managed tools (installed any time).
    gitBinary: async () => resolveGitBinary(config.gitBinary, await tools.installer.installed()).binary,
    // p14-repo-egress (problem 2): + the read-only dirs of the worker's own Node (npm / npx) and of the system node /
    // the other inventory tools, appended after the runtime's PATH.
    toolEnv: async () =>
      withJobToolDirs(
        managedToolEnv(
          await tools.installer.installed(),
          process.platform,
          await tools.installer.installedCustom(),
        ),
        await jobToolDirs({
          execPath: process.execPath,
          detected: (await tools.inventory.snapshot().catch(() => null))?.tools ?? [],
          platform: process.platform,
          excluded: [config.dataDir, config.workspaceRoot, homedir()],
          writable: (d) =>
            access(d, fsConstants.W_OK).then(
              () => true,
              () => false,
            ),
        }),
      ),
    managed: (runtime) => installer.launch(runtime),
    unverifiedActive: (runtime) => installer.unverifiedActive(runtime),
    followPin: (runtime) => catalogPinsNow()[runtime] ?? null,
    ops: deps.ops,
    logger,
    redactor,
    policy: () => policies.store.policy,
    live: managed,
    keyring,
    secretStore,
    ...(deps.locateRuntime === undefined ? {} : { locate: deps.locateRuntime }),
    onPackageCachesChanged: () => daemonRef?.refreshCapabilities(),
    onSandboxChanged: () => daemonRef?.refreshCapabilities(),
    // p14-login-status-consistency: CAPABILITIES again once the adapters of a new configuration are in place.
    // p15-model-picker: a new configuration may install / remove a runtime — list its models again.
    onRuntimesReconfigured: () => {
      if (runtimeModels === null) daemonRef?.refreshCapabilities();
      else
        void runtimeModels
          .detect()
          .catch(() => null)
          .then(() => daemonRef?.refreshCapabilities());
    },
    // p8-preview-tunnels (ADR-0032): the worker-managed cloudflared, else one found on the machine (cached inventory).
    ...(deps.previews === false
      ? {}
      : {
          cloudflared:
            deps.previews?.cloudflared ??
            (async () => {
              const managedCf = (await tools.installer.installed()).find((t) => t.tool === 'cloudflared');
              if (managedCf !== undefined)
                return { path: managedCf.entry, version: managedCf.version, source: 'managed' as const };
              const inv = await tools.inventory.snapshot();
              const sys = inv?.tools.find(
                (t) => t.name === 'cloudflared' && t.found && t.source === 'system',
              );
              return sys?.path === undefined
                ? null
                : { path: sys.path, version: sys.version ?? 'unknown', source: 'system' as const };
            }),
        }),
  });
  ideLookup = (id) => wiring.ide()?.gateway(id) ?? null;
  if (!config.devFakeRuntime) {
    runtimeModels = new RuntimeModelLister({
      launch: (runtime) => wiring.registry.launch(runtime),
      authMode: (runtime) => managed.effective.runtimeAuth[runtime]?.mode ?? null,
      env: helperEnv,
      run,
    });
  }
  // Probe the adapters in the background (version, auth readiness, capability matrix): starting the daemon
  // must not wait for runtime CLIs; CAPABILITIES and every job admission refresh stale probes themselves.
  void wiring.registry.refreshAll(true).catch((err: unknown) => {
    logger.warn('initial runtime probe failed', { err });
  });

  const updates = createUpdateAgent(config, deps.ops, logger, { ...deps.updates, redactor });
  // p17-disk-selfclean: the worker cleans what it owns when the disk runs low (and lightly once a day).
  const hygieneFs = nodeHygieneFs(process.platform);
  const activeJobs = (): ReadonlySet<string> => {
    const j = daemonRef?.jobs ?? null;
    return j !== null && 'activeJobIds' in j
      ? (j as { activeJobIds(): ReadonlySet<string> }).activeJobIds()
      : new Set<string>();
  };
  const runningRuntimes = (): ReadonlySet<string> => {
    const j = daemonRef?.jobs ?? null;
    return j !== null && 'runningRuntimes' in j
      ? (j as { runningRuntimes(): ReadonlySet<string> }).runningRuntimes()
      : new Set<string>();
  };
  const updateData = dataLayout(deps.ops.platform, config.dataDir);
  // Windows: shawl writes the service output and its own log, rotated, into the program data `logs` dir.
  const wrapperLog = serviceOutputFiles(process.platform, (name) => env[name]).wrapper;
  const hygieneWs = wiring.workspace;
  const hygieneKept = wiring.workfiles;
  const hygiene = await DiskHygiene.open({
    fs: hygieneFs,
    dataDir: config.dataDir,
    workspaceRoot: hygieneWs?.root ?? config.workspaceRoot,
    settings: () =>
      hygieneSettings(managed.effective.workspace.minFreeBytes, managed.effective.workspace.diskHygiene),
    state: fileHygieneState(deps.ops, config.dataDir),
    logger: logger.child({ component: 'disk-hygiene' }),
    onChanged: () => daemonRef?.refreshCapabilities(),
    sources: [
      tempSource({
        fs: hygieneFs,
        dataDir: config.dataDir,
        workspaceRoot: hygieneWs?.root ?? config.workspaceRoot,
        activeJobs,
      }),
      logsSource({
        fs: hygieneFs,
        dirs: [
          fileLog.dir,
          ...(process.platform === 'win32' && wrapperLog !== null
            ? [pathApi('win32').dirname(wrapperLog)]
            : []),
        ],
      }),
      releasesSource({
        fs: hygieneFs,
        stagedDir: updateData.stagedDir,
        busy: () => updates?.inFlight() === true,
        pending: async () => {
          const raw = await deps.ops.readFile(updateData.requestFile, 4096).catch(() => null);
          if (raw === null) return null;
          try {
            const v = (JSON.parse(raw.toString('utf8')) as { version?: unknown }).version;
            return typeof v === 'string' && v !== WORKER_VERSION ? v : null;
          } catch {
            return null;
          }
        },
      }),
      workspacesSource({
        fs: hygieneFs,
        activeJobs,
        kept:
          hygieneKept === null
            ? null
            : {
                list: () => hygieneKept.list(),
                remove: (jobId, attemptId) => hygieneKept.remove(jobId, attemptId, 'expired'),
              },
        retained:
          hygieneWs === null
            ? null
            : {
                list: () => hygieneWs.listRetained(),
                dir: (jobId, attemptId) => hygieneWs.retainedPath(jobId, attemptId),
                remove: (jobId, attemptId) => hygieneWs.removeRetained(jobId, attemptId),
              },
      }),
      runtimesSource({
        fs: hygieneFs,
        runtimes: {
          installs: () => installer.installs(),
          busy: (runtime) => runningRuntimes().has(runtime) || installer.busy(runtime as RuntimeKind),
          remove: (runtime, version) => installer.remove(runtime as RuntimeKind, version),
        },
      }),
      packageCachesSource({
        caches: {
          candidates: () => wiring.packageCaches.candidates(),
          evict: (key) => wiring.packageCaches.evictForSpace(key),
        },
      }),
    ],
  });
  const detected = detectService(process.platform, env, config.dataDir);
  const restartable = ro.restartable ?? config.remoteOps.restartable ?? detected.restartable;
  const service = { manager: detected.manager, restartable };
  const loginBinary = (runtime: LoginRuntime): Promise<string | null> => {
    const fromRegistry = wiring.registry.source(runtime).binary;
    if (fromRegistry !== null || runtime !== 'claude-code') return Promise.resolve(fromRegistry);
    // Development checkouts: the CLI bundled with the worker's own Agent SDK dependency.
    try {
      return Promise.resolve(resolveBundledClaudeBinary(readClaudeSdkPackageInfo()) ?? null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const login = new LoginManager({
    binary: loginBinary,
    env,
    run,
    logger,
    gate: wiring.loginGate,
    // p13-runtime-accounts: an added subscription account's own config dir and store.
    account: (runtime, id) => {
      const a = findAccount(wiring.accounts(), runtime, id);
      return a?.kind === 'subscription' && a.loginDir !== undefined && a.store !== undefined
        ? { loginDir: a.loginDir, store: a.store }
        : null;
    },
  });
  const loginExpired = (runtime: RuntimeKind): boolean =>
    (runtime === 'claude-code' || runtime === 'codex') && login.isExpired(runtime);
  onRuntimeLogin = (runtime, state, cause, account) => {
    // p13-runtime-accounts: the flag belongs to the account the run used (added accounts are always logins).
    const acc = account === undefined ? undefined : findAccount(wiring.accounts(), runtime, account);
    const added = acc !== undefined && !acc.isDefault ? acc.id : undefined;
    const localLogin =
      acc !== undefined
        ? acc.kind === 'subscription'
        : managed.effective.runtimeAuth[runtime]?.mode === 'local-login';
    if (applyRunLogin(login, runtime, state, cause, localLogin, added)) daemonRef?.refreshCapabilities();
  };
  /** p13-runtime-accounts: status of every added subscription account (the runtime's own status command). */
  const checkAccountLogins = async (accounts: readonly RuntimeAccount[]): Promise<void> => {
    for (const a of accounts) {
      if (a.kind !== 'subscription' || a.isDefault || !isAccountRuntime(a.runtime)) continue;
      await login.status(a.runtime, a.id).catch(() => undefined);
    }
    daemonRef?.refreshCapabilities();
  };
  /**
   * p13-runtime-accounts: a new configuration — folders for added subscription accounts (owner-only), and the folders
   * of removed accounts logged out with the runtime's own command and deleted (their login goes with them).
   */
  const syncAccounts = async (accounts: readonly RuntimeAccount[]): Promise<void> => {
    try {
      const { stale } = await syncAccountFolders(config.dataDir, accounts, () =>
        existingAccountFolders(config.dataDir, (p) => readdir(p)),
      );
      for (const folder of stale) {
        const parts = folder.split(/[\\/]/);
        const id = parts[parts.length - 1] ?? '';
        const runtime = parts[parts.length - 2] ?? '';
        if (parts[parts.length - 3] !== ACCOUNTS_DIR || !isAccountRuntime(runtime)) continue;
        await login.logoutDir(runtime, join(folder, runtime === 'claude-code' ? '.claude' : '.codex'));
        login.forget(runtime, id);
        wiring.runtimeUsage.forget(runtime, id);
        await removeAccountFolder(config.dataDir, folder);
        logger.info('runtime account removed; its login folder was deleted', { runtime, account: id });
      }
    } catch (err) {
      logger.warn('runtime account folders could not be synchronised', { err });
    }
    await checkAccountLogins(accounts);
  };
  onAccountsChanged = (accounts) => {
    void syncAccounts(accounts);
  };
  // p5-ops-chat (ADR-0018): the assistant host — sessions of the runtime the panel selected for chat, with
  // this worker's own runtime auth (local login or a vault credential), tools relayed to the master.
  // p14-mcp-stdio: Windows — each MCP install gets a protected DACL (job accounts RX) once job slots are prepared.
  if (process.platform === 'win32') {
    mcpAcl = async (dir) => {
      const state = wiring.sandbox?.runners.windowsSlots?.state ?? null;
      if (state === null) return 'skipped';
      await icacls(mcpInstallAclArgs(dir, state.workerSid, state.group.sid));
      return 'applied';
    };
  }
  // p5-ops-chat-next (ADR-0025): the assistant sandbox profile — the assistant runtime may write only its
  // session dir, read neither the worker's secrets nor any workspace, and reach only the model API hosts.
  const sandboxRunners = wiring.sandbox?.runners ?? null;
  const seatbeltOk =
    process.platform === 'darwin'
      ? (sandboxRunners?.seatbeltAvailable ?? (await seatbeltStatus(process.platform)).available)
      : false;
  const bwrapPath = process.platform === 'linux' ? await findBwrap() : null;
  const bwrapUsable =
    process.platform === 'linux'
      ? (sandboxRunners?.namespaces ?? (await checkBwrapNamespaces(nodeExec, bwrapPath, process.platform)))
          .usable
      : null;
  const assistantSandbox = new AssistantSandbox({
    mode: config.devFakeRuntime ? 'off' : config.assistant.sandbox,
    workerDataDir: config.dataDir,
    workspaceRoot: config.workspaceRoot,
    readableInDataDir: [join(config.dataDir, 'runtimes')],
    protectedHomes: config.sandbox.protectedHomes,
    workerHome: env.HOME ?? env.USERPROFILE,
    allowKeychain: config.sandbox.allowKeychain,
    egressAllow: config.sandbox.egressAllow,
    limits: limitsFromSettings(config.sandbox.limits),
    seatbeltAvailable: () => seatbeltOk,
    bwrap: () => ({ path: bwrapPath, usable: bwrapUsable }),
    windowsJobRunner: () => sandboxRunners?.jobRunner(),
    windowsSid: sandboxRunners?.identity.sid ?? null,
    onEgressDecision: (d) => {
      if (!d.allowed) logger.warn('assistant egress refused', { target: d.target, reason: d.reason });
    },
  });
  // p8-chat-attachments-mentions: attachment bytes of running turns, pulled over the control channel.
  const attachmentFetcher = new AssistantAttachmentFetcher();
  const assistant = new AssistantHost({
    // p10-claude-login-health: assistant sessions and job attempts share the per-store login gate.
    loginGate: wiring.loginGate,
    runtimeUsage: wiring.runtimeUsage,
    onLoginUsable: (runtime, account) => {
      const added = account === undefined || account === 'default' ? undefined : account;
      if (applyRunLogin(login, runtime, 'ok', undefined, true, added)) daemonRef?.refreshCapabilities();
    },
    fetchAttachment: (turnId, ref, signal) => attachmentFetcher.fetch(turnId, ref, signal),
    sandbox: (input) => Promise.resolve(assistantSandbox.forSession(input)),
    sandboxReady: () => assistantSandbox.ready(),
    sandboxReport: () => assistantSandbox.report(),
    logger,
    redactor,
    engines:
      deps.assistant?.engines ??
      createAssistantEngines({
        dataDir: config.dataDir,
        sourceEnv: env,
        fake: config.devFakeRuntime,
        launch: (runtime) => wiring.registry.launch(runtime),
        claudeBinary: () => loginBinary('claude-code'),
        settings: (runtime) => {
          const s = managed.effective.runtimeSettings[runtime];
          if (s === undefined) return undefined;
          return {
            ...(s.model === undefined ? {} : { model: s.model }),
            ...(s.provider === undefined ? {} : { provider: s.provider }),
            ...(s.config === undefined ? {} : { config: s.config }),
            ...(s.extensions.length === 0 ? {} : { extensions: s.extensions }),
          };
        },
        allowUnpinned: (runtime) => policies.store.policy?.document.runtimes[runtime]?.allowUnpinned === true,
      }),
    keySource: () => ({ keys: keyring.keys, pinned: keyring.isPinned }),
    disabled: config.assistant.disabled,
    maxSessions: config.assistant.maxSessions,
    scratchRoot: join(config.dataDir, 'assistant'),
    runtimeAllowed: (runtime) => {
      const e = managed.effective;
      if (!e.allowedRuntimes.includes(runtime))
        return { ok: false, reason: `${runtime} is not enabled on this worker` };
      if (e.runtimeAuth[runtime] === undefined)
        return { ok: false, reason: `no login or credential is configured for ${runtime} on this worker` };
      return { ok: true };
    },
    auth: async (runtime, account) => {
      // p13-runtime-accounts: Settings → Chat may name an account of the runtime (absent / default = configured).
      const acc =
        account === undefined || account === 'default'
          ? undefined
          : findAccount(wiring.accounts(), runtime, account);
      if (account !== undefined && account !== 'default' && acc === undefined) {
        throw new Error(`no ${runtime} account ${account} on this worker (configuration not applied yet?)`);
      }
      const auth = acc?.auth ?? managed.effective.runtimeAuth[runtime];
      if (auth === undefined) throw new Error(`no login or credential is configured for ${runtime}`);
      const plan = planJobEnv(
        { runtime, auth, ...(acc?.loginDir === undefined ? {} : { loginDir: acc.loginDir }) },
        store.identity?.workerId ?? null,
      );
      const lease = wiring.secretRegistry.lease();
      try {
        const resolved = await resolveJobEnv(plan, { store: secretStore, lease, sourceEnv: env });
        return {
          authMode: plan.authMode === 'local-login' ? 'local-login' : 'secret-ref',
          secretEnv: resolved.secretEnv,
          ...(acc === undefined ? {} : { account: acc.id }),
          ...(acc?.loginDir === undefined ? {} : { loginDir: acc.loginDir }),
          ...(acc?.folder === undefined ? {} : { loginFolder: acc.folder }),
          ...(acc?.store === undefined ? {} : { store: acc.store }),
          release: () => {
            lease.release();
          },
        };
      } catch (err) {
        lease.release();
        throw err;
      }
    },
    ...(deps.assistant?.clock === undefined ? {} : { clock: deps.assistant.clock }),
  });
  /** p13-runtime-accounts: CAPABILITIES `runtimeAccounts` — kinds, stores, login states; never an identity. */
  const accountReports = (): RuntimeAccountReport[] =>
    wiring
      .accounts()
      .slice(0, 32)
      .map((a): RuntimeAccountReport => {
        const rep = a.kind === 'subscription' ? login.accountReport(a.runtime, a.id) : undefined;
        return {
          runtime: a.runtime,
          id: a.id,
          kind: a.kind,
          ...(a.store === undefined ? {} : { store: a.store }),
          ...(rep === undefined ? {} : { login: rep.status }),
          ...(rep?.reason === undefined ? {} : { reason: rep.reason }),
          ...(rep?.checkedAt === undefined ? {} : { checkedAt: rep.checkedAt }),
          ...(a.kind === 'api_key' && a.credentialId !== undefined
            ? { ready: vault.held(a.credentialId) }
            : {}),
          ...(a.kind === 'subscription' && a.folder !== undefined
            ? { lendable: wiring.sandbox?.runners.windowsSlots?.accountLending() === true }
            : {}),
        };
      });
  let daemonRef: WorkerDaemon | null = null;
  // p5-sandbox-ops: the Sandbox card's data and the prepare operation.
  const installDir = defaultInstallDir();
  const sandboxStatus = async () =>
    buildSandboxStatus({
      runners: wiring.sandbox?.runners ?? null,
      runnersError: wiring.sandboxError,
      enabledRuntimes: managed.effective.allowedRuntimes,
      unconfined: managed.effective.unconfined ?? 'not_enabled',
      ...(managed.effective.unconfinedParallel === true
        ? { unconfinedParallel: Math.max(1, managed.effective.maxParallelJobs) }
        : {}),
      workspaceRoot: config.workspaceRoot,
      privilegedHelper: await privilegedHelperAvailable(installDir),
    });
  // p17-worker-managed: worker.uninstall / helper.manage go to the privileged helper through the prepare trigger.
  const manageRequester = new ManageRequester({
    platform: process.platform,
    dataDir: config.dataDir,
    installDir,
    logger,
  });
  const preparer = new SandboxPreparer({
    platform: process.platform,
    dataDir: config.dataDir,
    installDir,
    runners: () => wiring.sandbox?.runners ?? null,
    status: sandboxStatus,
    changed: () => {
      daemonRef?.refreshCapabilities();
    },
    restart: () => {
      if (!service.restartable) {
        logger.warn(
          'the local config changed; restart the worker service to apply it (not restartable here)',
        );
        return;
      }
      logger.warn('restarting to apply the local config written by the privileged sandbox prepare');
      setTimeout(() => {
        void daemonRef?.requestRestart('sandbox prepare');
      }, 2000);
    },
    logger,
  });
  // p17-runtime-verify: "Doğrula" — the capability scenario set through the real adapter, signed evidence.
  const capabilityVerifier = new CapabilityVerifier({
    registry: wiring.registry,
    sandbox: wiring.jobSandbox,
    readiness: (runtime) => sandboxReadiness(wiring.sandbox?.runners ?? null, wiring.sandboxError, [runtime]),
    auth: () => managed.effective.runtimeAuth,
    secretStore,
    secretRegistry: wiring.secretRegistry,
    workspaceRoot: config.workspaceRoot,
    workerId: () => store.identity?.workerId ?? null,
    workerVersion: WORKER_VERSION,
    sign: (data) => {
      if (daemonRef === null) throw new Error('the daemon is not running');
      return daemonRef.signWithDeviceKey(data);
    },
    redact: (text) => redactor.redact(text),
    logger,
  });
  const remoteOps = await RemoteOpsAgent.open({
    ops: deps.ops,
    dataDir: config.dataDir,
    installer,
    login,
    log: fileLog,
    logSources: {
      boot: pathApi(deps.ops.platform).join(config.dataDir, 'logs', BOOT_LOG),
      updater: installLayout(
        deps.ops.platform,
        config.updates.installDir ?? updateInstallDir(deps.ops.platform, (name) => deps.host.env(name)),
      ).updaterLog,
    },
    redactor,
    logger,
    keySource: () => ({ keys: keyring.keys, pinned: keyring.isPinned }),
    disabled: config.remoteOps.disabled,
    service,
    restart: async (drain, timeoutSec) => {
      const d = daemonRef;
      if (d === null) return 'drain_timeout';
      if (drain) {
        d.setLocalDrain(true);
        const deadline = Date.now() + timeoutSec * 1000;
        while (d.runningJobCount() > 0) {
          if (Date.now() >= deadline) {
            d.setLocalDrain(false);
            return 'drain_timeout';
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      logger.warn('restarting for a remote operation; the service manager starts the worker again', {
        drain,
      });
      setTimeout(() => {
        void d.requestRestart('remote restart');
      }, ro.restartDelayMs ?? 1000);
      return 'restarting';
    },
    restartRuntime: async (runtime) => {
      await wiring.registry.rebuild();
      const s = await wiring.registry.refresh(runtime, true);
      if (s.unavailable !== null) {
        return { ok: false, detail: `${s.unavailable.code}: ${s.unavailable.message}` };
      }
      if (s.probe === null) return { ok: false, detail: 'probe failed' };
      return s.probe.installed
        ? { ok: true, detail: `version ${s.probe.version ?? 'unknown'}` }
        : { ok: false, detail: 'not installed' };
    },
    runtimeInUse: (runtime) => {
      const jobs = daemonRef?.jobs ?? null;
      return jobs !== null && 'runningRuntimes' in jobs
        ? (jobs as { runningRuntimes(): ReadonlySet<string> }).runningRuntimes().has(runtime)
        : false;
    },
    ...(deps.doctor === undefined ? {} : { doctor: deps.doctor }),
    // p17-disk-selfclean: "Şimdi temizle" — the disk hygiene now (light candidates, then the rest up to the target).
    diskClean: () => hygiene.run('manual'),
    diagnostics: () =>
      collectDiagnostics({
        workerVersion: WORKER_VERSION,
        dataDir: config.dataDir,
        workspaceRoot: config.workspaceRoot,
        installsRoot: installer.root,
        service,
        redactor,
        sandbox: async () =>
          (
            await sandboxReadiness(
              wiring.sandbox?.runners ?? null,
              wiring.sandboxError,
              managed.effective.allowedRuntimes,
            )
          ).map((r) => ({
            profile: r.profile,
            ready: r.ready,
            ...(r.reason === undefined ? {} : { reason: r.reason.slice(0, 300) }),
          })),
        runtimes: async () => {
          const statuses = await wiring.registry.refreshAll();
          const reports = await installer.report();
          return statuses.map((st) => {
            const src = wiring.registry.source(st.runtime);
            const rep = reports.find((r) => r.runtime === st.runtime);
            const active = rep?.installed.find((i) => i.version === rep.active);
            return {
              runtime: st.runtime,
              source: src.source,
              version: st.probe?.version ?? null,
              enabled: managed.effective.allowedRuntimes.includes(st.runtime),
              authenticated: loginExpired(st.runtime) ? 'no' : (st.probe?.authenticated ?? 'unknown'),
              ...(active === undefined ? {} : { integrity: active.integrity }),
              ...(st.unavailable === null || st.unavailable.code === 'runtime_not_enabled'
                ? {}
                : { problem: `${st.unavailable.code}: ${st.unavailable.message}`.slice(0, 300) }),
            };
          });
        },
      }),
    changed: () => {
      daemonRef?.refreshCapabilities();
    },
    // p14-login-status-consistency: a fresh probe (not the 60 s cache) before CAPABILITIES after a login operation.
    reprobe: async (runtime) => {
      await wiring.registry.refresh(runtime, true);
    },
    prepareSandbox: (workerId, cmd, emit) => preparer.run(workerId, cmd, emit),
    manage: (workerId, cmd, emit) => manageRequester.run(workerId, cmd, emit),
    ...(wiring.functions.codeImages === undefined ? {} : { codeImages: wiring.functions.codeImages }),
    // p15-git-central: safe fixes of the worker account's git setup (the machine page's Git card).
    gitFix: (fixes) => gitReadiness.fix(fixes),
    // p15-usage-refresh: `usage.refresh` reads the subscription logins' usage windows now.
    usageRefresh: (filter) => wiring.runtimeUsage.refresh(filter),
    // p16-runtime-updates: the automatable verification checks of a candidate version (scratch dir, never active).
    verifyRuntime: (op, opts) =>
      verifyRuntime(
        {
          installer,
          selfTest: ro.selfTest ?? candidateSelfTest,
          probe: (runtime, launch) =>
            wiring.registry.probeExecutable(
              runtime,
              launch,
              join(config.dataDir, 'runtime-state', runtime, 'verify'),
            ),
        },
        op,
        opts,
      ),
    // p17-runtime-verify: the capability verification (one at a time; evidence signed by the device key).
    verifyCapabilities: (commandId, op, opts) => capabilityVerifier.run(commandId, op, opts),
    tools: tools.port,
    // p14-mcp-core: tool discovery of a remote MCP server (spec verified with this worker's own keys).
    mcpProbe: (op, signal) =>
      runMcpProbe(op, {
        keys: () => {
          const all = [
            ...new Set([...(config.skills.publicKeys ?? []), ...(managed.effective.panelMcpKeys ?? [])]),
          ];
          return all.length === 0 ? null : all;
        },
        store: secretStore,
        workerId: store.identity?.workerId ?? null,
        allowMcp: config.localCeiling?.allowMcp !== false,
        signal,
        // p14-mcp-stdio: a stdio server is probed from its install, inside the host sandbox (never unconfined).
        ...(mcpStdioAllowed()
          ? {
              stdio: {
                installer: mcpInstaller,
                start: sandboxedStdioStarter({
                  workspaceRoot: config.workspaceRoot,
                  nodePath: process.execPath,
                  confiner: (() => {
                    const host = wiring.sandbox?.runners.host;
                    return host === undefined ? null : (ctx) => host.confiner(ctx);
                  })(),
                  limits: limitsFromSettings(config.sandbox.limits),
                }),
              },
            }
          : {}),
      }),
    // p14-mcp-stdio: mcp.install / mcp.remove (spec verified with this worker's own keys; local vetoes).
    mcpInstall: mcpInstallPort({
      installer: mcpInstaller,
      keys: () => {
        const all = [
          ...new Set([...(config.skills.publicKeys ?? []), ...(managed.effective.panelMcpKeys ?? [])]),
        ];
        return all.length === 0 ? null : all;
      },
      refusal: () =>
        config.localCeiling?.allowMcp === false
          ? 'this machine refuses external MCP servers (localCeiling.allowMcp: false)'
          : config.localCeiling?.allowMcpStdio === false
            ? 'this machine refuses local MCP servers (localCeiling.allowMcpStdio: false)'
            : null,
    }),
    ...(ro.clock === undefined ? {} : { clock: ro.clock }),
  });
  const daemon: WorkerDaemon = new WorkerDaemon({
    jobs: wiring.jobs,
    ...(updates === null ? {} : { updates }),
    maxParallelJobs: managed.effective.maxParallelJobs,
    store,
    key,
    keystore,
    logger,
    transport,
    children: new ChildRegistry(),
    signals: deps.signals,
    // p8-capacity-auto: one long-lived sampler (CPU-time deltas between heartbeats, memory pressure figures).
    // p15-merge-approvals item 4: free disk vs. the minimum under the workspace root (placement, machine page).
    load: createLoadSampler({
      dir: config.dataDir,
      workspace: { dir: config.workspaceRoot, minFreeBytes: () => managed.effective.workspace.minFreeBytes },
    }),
    runtimeUsage: wiring.runtimeUsage,
    runtimePolicy,
    managedConfig: { onApply: (workerId, payload) => managed.apply(workerId, payload) },
    assistant: {
      onTurn: (workerId, payload) => assistant.onTurn(workerId, payload),
      onToolResult: (payload) => {
        assistant.onToolResult(payload);
      },
      onCancel: (payload) => {
        assistant.onCancel(payload);
      },
      onAttachmentData: (payload) => {
        attachmentFetcher.onData(payload);
      },
      onDisconnected: () => {
        attachmentFetcher.onDisconnected();
        assistant.onDisconnected();
      },
      onResume: (payload) => {
        assistant.onResume(payload);
      },
      onStopping: () => assistant.onStopping(),
    },
    remoteOps: {
      onCommand: (workerId, payload) => remoteOps.onCommand(workerId, payload),
      onSessionEstablished: () => {
        remoteOps.onSessionEstablished();
      },
    },
    versionCatalog: { onApply: (payload) => versionCatalog.apply(payload) },
    vault: {
      onApply: (workerId, payload) => vault.apply(workerId, payload),
      onRevoke: (workerId, payload) => vault.revoke(workerId, payload),
      onRotateKey: () => vault.rotateKey(),
    },
    ...(deps.capabilities === undefined
      ? {}
      : {
          capabilities: async () => {
            const provider = deps.capabilities;
            if (provider === undefined) throw new Error('unreachable');
            const effective = managed.effective;
            const base = await provider(effective.maxParallelJobs, policies.store.policy, probeFollowPins());
            // Sandbox readiness from the runners' self-checks, adapter capability sets, project allowlist.
            const caps = await workerCapabilities(base, {
              registry: wiring.registry,
              runners: wiring.sandbox?.runners ?? null,
              runnersError: wiring.sandboxError,
              enabledRuntimes: effective.allowedRuntimes,
              projects: [...Object.keys(effective.projects), ...Object.keys(effective.workspaces)],
              allowedProfiles: effective.sandboxProfiles,
            });
            // p9-queue-priority: per-profile slots, from the same facts the profile selection enforces (T-SBX-4).
            const slots = profileSlots({
              maxParallelJobs: effective.maxParallelJobs,
              profiles: caps.sandboxProfiles,
              filesystemConfinement: wiring.sandbox?.runners.host.check().filesystemConfinement ?? 'none',
              // p9-windows-host-isolation (ADR-0034): per-job Windows accounts lift the host limit.
              hostConcurrency: wiring.sandbox?.runners.hostRestrictedConcurrency(),
              // p9-queue-local-login-accounting: subscription logins run one at a time with per-job accounts.
              // p13-runtime-accounts: an added subscription account makes the runtime a login runtime too.
              localLoginRuntimes: effective.allowedRuntimes.filter(
                (r) =>
                  effective.runtimeAuth[r]?.mode === 'local-login' ||
                  wiring.accounts().some((a) => a.runtime === r && a.kind === 'subscription'),
              ),
              // p19-unconfined-parallel: attempts without filesystem confinement run in parallel (machine setting).
              unconfinedParallel: effective.unconfinedParallel === true,
            });
            return {
              ...caps,
              maxParallelJobs: effective.maxParallelJobs,
              profileConcurrency: slots.profileConcurrency,
              exclusiveProfiles: slots.exclusiveProfiles,
              ...(slots.localLogin === undefined ? {} : { localLogin: slots.localLogin }),
              features: [
                'worker-config-v1' as const,
                'credential-vault-v1' as const,
                'remote-ops-v1' as const,
                'assistant-v1' as const,
                // p8-chat-attachments-mentions: ASSISTANT_TURN attachments / context, engine input report.
                'assistant-input-v1' as const,
                // p15-chat-execute-default: draft tools take `propose`; the master runs the user's commands at once.
                'assistant-propose-v1' as const,
                // p17-chat-reconnect: turns survive a transport reconnect (ASSISTANT_RESUME, re-sent updates).
                'assistant-resume-v1' as const,
                // p18-plan-mode: the plan tools, planItem on draft tools and the planning rule (52) of the prompt.
                'assistant-plan-v1' as const,
                // p18-assistant-gaps: workflow runs, job outputs, backups / updates, … tools and prompt rules 2–53.
                'assistant-ops-tools-v1' as const,
                // p18-multi-project W3 + W5: working projects, set_thread_projects / attach_workflow / draft_job_batch, rule 54.
                'assistant-projects-v1' as const,
                // p18-leftovers (1.2.2): draft_budget_change, GitHub triggers in the group card, rule 55.
                'assistant-budgets-v1' as const,
                // p18-project-bootstrap: describe_project_readiness, draft_project_network / _machines, rule 56.
                'assistant-project-setup-v1' as const,
                // p18-project-bootstrap: an empty repository starts from an empty first commit of its base branch.
                'workspace-empty-repo-v1' as const,
                'job-message-v1' as const,
                // p15-message-delivery: JOB_MESSAGE_STATUS receipts, dedupe by message id, non-blocking delivery.
                'job-message-receipts-v1' as const,
                'workspace-v1' as const,
                // p16-workflow-quality: repository-less workflow steps of repository projects (scratch directory).
                'repo-scratch-v1' as const,
                'sandbox-ops-v1' as const,
                // p5-full-access (ADR-0020): approvalPolicy "allow-all" with execution.autoApproveOptIn.
                'full-access-v1' as const,
                // p5-machine-admin (ADR-0021): machine-admin jobs, tool inventory, panel-signed skills.
                'machine-admin-v1' as const,
                // p17-worker-1-1-1: MACHINE_ADMIN_REQUEST carries the agent's purpose of each elevated command.
                'machine-admin-purpose-v1' as const,
                'tools-v1' as const,
                'panel-skills-v1' as const,
                // p5-openhands-model-headers: JobSpec.modelProfile (model string and credential reference).
                'model-profile-v1' as const,
                // p6-automations-next (ADR-0026): pinned pull request heads (quarantine mirror, container only).
                'pr-head-v1' as const,
                // p6-deploy-pipeline (ADR-0028): static site bundles (JobSpec.siteBundle).
                'site-bundle-v1' as const,
                // p6-warm-caches (ADR-0029): shared package caches, workspace.packageCacheMaxBytes.
                'package-caches-v1' as const,
                // p6-worker-boot-diagnostics: logs.tail `source` (worker | boot | updater).
                'logs-source-v1' as const,
                // p6-approval-mode-switch: SET_APPROVAL_POLICY (signed, fenced) → APPROVAL_POLICY_STATUS.
                'approval-mode-switch-v1' as const,
                // p15-autonomy: SET_TIME_LIMIT (signed, fenced) → TIME_LIMIT_STATUS; a running job keeps running.
                'time-limit-v1' as const,
                // p8-capacity-auto: sampled CPU on every OS + memory pressure figures in HEARTBEAT.load.
                'capacity-metrics-v1' as const,
                // p8-orchestration (ADR-0031): sub-job tools (SUBTASK_REQUEST / SUBTASK_STATUS) for allowed jobs.
                'subtasks-v1' as const,
                // p14-ask-user: ask_user / wait_for_answer (QUESTION_REQUEST / QUESTION_STATUS) and the assistant tool.
                'ask-user-v1' as const,
                // p20-job-clock: question waits stop the run clock; HEARTBEAT runningJobs[].clock / JOB_RESULT clock.
                'run-clock-v1' as const,
                // p22-timeout-continuity: a repository job stopped on its time limit commits and pushes its unfinished
                // work to the attempt branch within the delivery grace (JOB_RESULT partial).
                'timeout-delivery-v1' as const,
                // p22-sandbox-settings: APPLY_WORKER_CONFIG settings.sandbox (Linux host-sandbox switches).
                'worker-sandbox-settings-v1' as const,
                // p14-repo-egress: ASSIGN_JOB execution.repoEgress in the job's egress proxy (host and container).
                'repo-egress-v1' as const,
                // p21-service-egress: SERVICE_START / IDE_START spec.network in the service's / IDE's egress proxy.
                'service-egress-v1' as const,
                // p8-preview-tunnels (ADR-0032): supervised cloudflared connectors (TUNNEL_START / STOP).
                ...(wiring.previews() === null ? [] : ['preview-tunnels-v1' as const]),
                // p22-previews-inputs: container ports published on the worker's loopback for previews.
                ...(wiring.previews()?.containerPreviews() === true ? ['preview-container-v1' as const] : []),
                // p22-previews-inputs: sub-job inputs above 256 KiB staged as attempt artifacts (ws-subin-…).
                'subtask-staged-inputs-v1' as const,
                // p15-services: long-running services the worker owns (SERVICE_* messages, job tools, hand-off).
                ...(wiring.services() === null ? [] : ['services-v1' as const]),
                // p19-ide W2: IDE workspaces + the STREAM_* plane (CAPABILITIES.ide says whether this machine can run one).
                // p19-ide W4: IDE_GIT diff (read_workspace_diff) — with the IDE only.
                ...(wiring.ide() === null ? [] : ['ide-v1' as const, 'ide-diff-v1' as const]),
                // p19-ide W3: extensions from the master's cache + settings sync (same IDE manager).
                ...(wiring.ide() === null ? [] : ['ide-extensions-v1' as const]),
                // p19-ide W2b: macOS / Windows IDEs (code-server), CAPABILITIES.ide reasonCode / serverKind.
                ...(wiring.ide() === null ? [] : ['ide-platforms-v1' as const]),
                // p15-workspace-retention: kept working directories of workspace jobs (keep, seed, WORKFILES_*).
                ...(wiring.workfiles === null ? [] : ['workfiles-v1' as const]),
                // p16-zip-job-input: ASSIGN_JOB execution.inputBundle pulled into in/ (INPUT_BUNDLE_REQUEST).
                'input-bundle-v1' as const,
                // p17-object-storage: large outputs through the master's blob store (BLOB_UPLOAD_*), ARTIFACT_REF blobUploadId.
                'blob-upload-v1' as const,
                // p17-output-limits: execution.outputLimits (count over inline + blob, bytes decide the path, the
                // overflow zip), blobUpload.maxFiles above 20, JOB_RESULT outputs.
                'output-limits-v1' as const,
                // p10-publish-bundle (ADR-0038): `publish_site` through the preview channel (op publish).
                ...(wiring.previews() === null ? [] : ['site-publish-v1' as const]),
                // p12-deploy-feedback (ADR-0048): the in-job deploy tools through the preview channel.
                ...(wiring.previews() === null ? [] : ['deploy-feedback-v1' as const]),
                // p9-queue-priority (ADR-0033): profileConcurrency / exclusiveProfiles, LEASE_ACK.declineKind.
                'profile-slots-v1' as const,
                // p10-approval-pause (ADR-0036): PAUSE_JOB, execution.approvalWait / execution.resume.
                'approval-pause-v1' as const,
                // p11-master-resilience (ADR-0039): lease.offlineGraceMs, RENEW_LEASE.ackId, refusal fencing.
                'offline-grace-v1' as const,
                // p11-merge-pipeline (ADR-0041): deterministic integration steps (JobSpec.kind "integration").
                'integration-v1' as const,
                // p11-usage-limit-fallback (ADR-0040): park on a usage limit, resume with the same or another runtime.
                'usage-limit-park-v1' as const,
                // p11-session-continuity (ADR-0042): checkpoints, restart recovery, execution.resume{worker_restart}.
                'session-continuity-v1' as const,
                // p11-limit-visibility: HEARTBEAT runtimeUsage (usage-limit windows per login store).
                'runtime-usage-v1' as const,
                // p13-runtime-accounts (ADR-0049): several accounts per runtime (config, login relay, jobs, chat).
                'runtime-accounts-v1' as const,
                // p13-fleet-tools (ADR-0052): custom download installs, toolInventory.effective.
                'custom-tools-v1' as const,
                // p14-skill-import (ADR-0054): ASSIGN_JOB execution.skillTrust "offline-only".
                'skill-trust-v1' as const,
                // p14-skill-catalogs (ADR-0054): skill layout v2, deferred skills fetched with SKILL_FILE_REQUEST.
                'skills-layout-v2' as const,
                // p14-mcp-core (ADR-0054): external MCP servers for jobs, mcp.probe (not when the local file vetoes MCP).
                ...(config.localCeiling?.allowMcp === false ? [] : ['mcp-v1' as const]),
                // p14-workflow-engine 14.3 (ADR-0055): function jobs (HTTP / e-mail) beside the AI slots.
                'function-v1' as const,
                // p22-runtime-diagnostics: pinned certificates of function jobs (execution.tlsPins), tls_untrusted reports.
                'function-tls-pins-v1' as const,
                // p15-watches: loopback port checks of watches (probe function jobs).
                ...(wiring.functions.probe === undefined ? [] : ['watch-checks-v1' as const]),
                // K3: code nodes only while the container engine and the pinned code images are ready.
                ...((await wiring.functions.code?.ready().catch(() => false)) === true
                  ? ['function-code-v1' as const]
                  : []),
                // p14-code-images: the panel can build the code images here (container runners configured).
                ...(wiring.functions.codeImages === undefined ? [] : ['code-images-v1' as const]),
                // p15-git-central: fresh git credentials per fetch / push, job-local git config, git readiness, git.fix,
                // execution.gitAuth (project deploy key / HTTPS token from the vault).
                'git-central-v1' as const,
                // p15-usage-refresh: usage identity, usage.refresh, a probe after each run.
                'usage-refresh-v1' as const,
                // p15-model-picker: CAPABILITIES runtimeModels, JobSpec.defaultModel after the machine's own default.
                'runtime-models-v1' as const,
                // p16-runtime-updates: unverified runtime installs (owner policy), runtime.verify, unverifiedUpdate.
                'runtime-unverified-v1' as const,
                // p16-doctor: the remote op doctor.run (the same report as `remyral-worker doctor`).
                ...(deps.doctor === undefined ? [] : ['doctor-v1' as const]),
                // p14-mcp-stdio (ADR-0054 P4): local MCP packages (install, stdio probe, stdio servers in jobs).
                ...(mcpStdioAllowed() ? ['mcp-stdio-v1' as const] : []),
                // p19-install-scripts (ADR-0068): mcp.install `installScripts` (approved npm install scripts run).
                ...(mcpStdioAllowed() ? ['mcp-install-scripts-v1' as const] : []),
                // p17-disk-selfclean: own disk cleanup, CAPABILITIES diskHygiene, disk.clean, workspace.diskHygiene.
                'disk-hygiene-v1' as const,
                // p17-update-channel: APPLY_VERSION_CATALOG / VERSION_CATALOG_STATUS, CAPABILITIES versionCatalog.
                'version-catalog-v1' as const,
                // p17-worker-managed: APPLY_WORKER_CONFIG settings, worker.uninstall, helper.manage.
                'worker-managed-v1' as const,
                // p17-runtime-verify: runtime.capabilities.verify, CAPABILITIES verification, verifiedCapabilities.
                'runtime-capability-verify-v1' as const,
                // p19-linux-host-isolation (ADR-0066): per-attempt bubblewrap views on Linux, host_isolation check/step.
                'host-isolation-linux-v1' as const,
                // p19-unconfined-parallel: accepts `unconfinedParallel` in APPLY_WORKER_CONFIG.
                'unconfined-parallel-v1' as const,
                // p19-linux-host-isolation Part 2: the capacity prompt rule (advice only from describe_worker capacity).
                'assistant-capacity-v1' as const,
                // p19-repo-job-inputs: repository job input files in a scratch in/ next to the checkout (never committed).
                'repo-inputs-v1' as const,
                // p19-repo-job-inputs: prompt rule 58 (chat attachments / earlier outputs for repository jobs too).
                'assistant-repo-inputs-v1' as const,
                // p19-ide W4: read_code / list_code / read_workspace_diff / open_code / open_diff /
                // draft_review_changes and prompt rule 59.
                'assistant-code-v1' as const,
                // p20-chat-images: show_image / draft_screenshot and prompt rule 68.
                'assistant-images-v1' as const,
              ],
              ...(mcpStdioAllowed() ? { mcpInstalls: mcpInstaller.list() } : {}),
              // p15-git-central: never blocks CAPABILITIES on a detection (cached, refreshed in the background).
              ...((r) => (r === null ? {} : { gitReadiness: r }))(
                gitReadiness.snapshot(() => daemonRef?.refreshCapabilities()),
              ),
              runtimeAccounts: accountReports(),
              // p15-model-picker: never blocks CAPABILITIES on the list commands (cached, refreshed in the background).
              ...((r) => (r === null ? {} : { runtimeModels: r }))(
                runtimeModels?.snapshot(() => daemonRef?.refreshCapabilities()) ?? null,
              ),
              ...(await (async () => {
                // Never blocks CAPABILITIES on a detection: the cached inventory, refreshed in the background.
                const inv = await tools.inventory.snapshot(() => daemonRef?.refreshCapabilities());
                return inv === null ? {} : { tools: ToolInventory.capabilityTools(inv), toolInventory: inv };
              })()),
              machineAdmin: await machineAdminReport({
                enabled: effective.machineAdmin?.enabled === true,
                autoApprove: effective.machineAdmin?.autoApprove === true,
                localVeto: config.localCeiling?.allowMachineAdmin === false,
                installDir: adminInstallDir,
                workerId: store.identity?.workerId ?? null,
                // Security fix: host jobs without filesystem confinement and no explicit local opt-in.
                hostUnconfined: ((f) =>
                  config.localCeiling?.allowMachineAdmin === true || f === null || f.pending
                    ? null
                    : f.cause)(hostFallback(wiring.sandbox?.runners ?? null)),
                active: (() => {
                  const j = daemonRef?.jobs ?? null;
                  return j !== null && 'activeAdminSession' in j
                    ? (
                        j as {
                          activeAdminSession():
                            | { jobId: string; attemptId: string; sessionId: string; since: string }
                            | undefined;
                        }
                      ).activeAdminSession()
                    : undefined;
                })(),
              }),
              sandboxStatus: await sandboxStatus(),
              assistant: await assistant.report(),
              runtimes: applyManagedVersions(caps.runtimes, installer).map((r) =>
                loginExpired(r.runtime) ? { ...r, authenticated: 'no' as const } : r,
              ),
              remoteOps: await remoteOps.report(),
              workerConfig: managed.report(),
              credentialVault: vault.report(daemon.workerId(), (data) => daemon.signWithDeviceKey(data)),
              packageCaches: wiring.packageCaches.report(),
              ...(await (async () => {
                const pv = wiring.previews();
                return pv === null ? {} : { previewTunnels: await pv.report() };
              })()),
              ...((): {
                services?: ReturnType<NonNullable<ReturnType<typeof wiring.services>>['report']>;
              } => {
                const sv = wiring.services();
                return sv === null ? {} : { services: sv.report() };
              })(),
              ...(wiring.workfiles === null ? {} : { workfiles: wiring.workfiles.report() }),
              ...((): { ide?: ReturnType<NonNullable<ReturnType<typeof wiring.ide>>['report']> } => {
                const ide = wiring.ide();
                return ide === null ? {} : { ide: ide.report() };
              })(),
              diskHygiene: hygiene.report(),
              versionCatalog: versionCatalog.report(),
            };
          },
        }),
    ...(deps.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: deps.heartbeatIntervalMs }),
  });
  daemonRef = daemon;
  remoteOps.attach((payload) => daemon.sendOpsUpdate(payload));
  assistant.attach((payload) => daemon.sendAssistantUpdate(payload));
  attachmentFetcher.attach((payload) => daemon.sendAssistantAttachmentRequest(payload));
  // A new effective configuration changes the parallelism limit for the next job start (no restart).
  managed.subscribe((e) => {
    daemon.machine.setLimits({ maxParallelJobs: e.maxParallelJobs });
  });
  await daemon.start();
  // p15-workspace-retention: kept directories past their expiry (+ grace) are removed even while the master is away.
  if (wiring.workfiles !== null) {
    const wf = wiring.workfiles;
    void wf.sweep().catch(() => undefined);
    setInterval(() => {
      void wf.sweep().catch((err: unknown) => {
        logger.warn('kept workspace sweep failed', { err });
      });
    }, 60 * 60_000).unref();
  }
  // p13-runtime-accounts: folders of the accounts in effect, and their login states for CAPABILITIES.
  void syncAccounts(wiring.accounts());
  // p10-claude-login-health: flagged logins are re-checked in the background and right after a wake / resume.
  const loginHealth = new LoginHealthMonitor({
    login,
    logger,
    onChanged: () => {
      daemon.refreshCapabilities();
    },
    onWake: () => wiring.sweepClaudeLocks(),
    ...(config.loginRecheckMinutes === undefined ? {} : { recheckMs: config.loginRecheckMinutes * 60_000 }),
  });
  if (config.loginRecheckMinutes !== 0) loginHealth.start();
  // p11-limit-visibility: read-only usage-window probes of the subscription-login runtimes (0 = passive only).
  if (config.usageProbeMinutes !== 0) wiring.runtimeUsage.start();
  // p17-disk-selfclean: free-space checks (low-disk runs) and the daily light run.
  hygiene.start();
  // p6-warm-caches: first size scan (and an eviction if the limit shrank while the worker was stopped).
  void wiring.packageCaches.sweep().catch((err: unknown) => {
    logger.warn('package cache sweep failed', { err });
  });
  deps.onStarted?.(daemon, config);
  // Keep the process alive until stopped even while the transport waits between reconnects.
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    return await daemon.done;
  } finally {
    clearInterval(keepAlive);
    wiring.packageCaches.stop();
    hygiene.stop();
    loginHealth.stop();
    wiring.runtimeUsage.stop();
    await login.stopAll();
    tools.inventory.stop();
    await assistant.stop();
    fileLog.close();
  }
}

/**
 * The CLI probe behind CAPABILITIES is cached; a worker-managed install that is active (and intact) is the
 * executable the adapters use, so its version is what the runtime record shows.
 */
function applyManagedVersions(
  runtimes: CapabilitiesPayload['runtimes'],
  installer: RuntimeInstaller,
): CapabilitiesPayload['runtimes'] {
  return runtimes.map((r) => {
    const launch = installer.launch(r.runtime);
    if (launch === null) return r;
    // p16-runtime-updates: an owner-approved install outside the pinned set says so (capabilities stay unverified).
    const unverified = installer.unverifiedActive(r.runtime)?.version === launch.version;
    return {
      ...r,
      installed: true,
      version: launch.version,
      ...(unverified ? { unverifiedUpdate: true } : {}),
      ...(r.pinnedVersion === undefined
        ? {}
        : { pinStatus: launch.version === r.pinnedVersion ? ('match' as const) : ('mismatch' as const) }),
    };
  });
}

/** p19-ide W2: the console origin behind the master URL (`wss://host/…` → `https://host`), or null. */
export function consoleOriginOf(masterUrl: string): string | null {
  try {
    const u = new URL(masterUrl);
    const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    if (protocol !== 'https:' && protocol !== 'http:') return null;
    return `${protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function defaultTransport(
  config: WorkerConfig,
  logger: Logger,
  facts: (() => Promise<HostFacts>) | undefined,
): TransportPort {
  if (facts === undefined) throw new Error('host facts provider missing for the network transport');
  return new WsTransport({ masterUrl: config.masterUrl, logger, workerVersion: WORKER_VERSION, facts });
}

/**
 * p16-runtime-updates: `--help` (Claude Code, Codex, Pi) or the OpenCode loopback auth self-test on a verification
 * candidate — the same checks the probe runs on the active install (runtimes/selftest.ts).
 */
async function candidateSelfTest(
  runtime: RuntimeKind,
  launch: { file: string; args: readonly string[] },
  expectedVersion: string,
): Promise<{ ok: boolean; detail: string }> {
  const r = await runSelfTest(
    createNodeSystem(),
    runtime,
    { file: launch.file, prefixArgs: [...launch.args] },
    expectedVersion,
  );
  const failed = r.result.checks.filter((c) => !c.ok);
  return {
    ok: r.result.status === 'passed',
    detail:
      failed.length === 0
        ? r.result.checks.map((c) => c.name).join('; ')
        : failed.map((c) => `${c.name}${c.detail === undefined ? '' : `: ${c.detail}`}`).join('; '),
  };
}

/**
 * p17-worker-managed: reads the last applied panel document (read-only) and lays its `settings` over the local file —
 * runtime paths only after their start-time check. Returns the config the daemon starts with and the settings context
 * the managed configuration reports against.
 */
async function startSettings(
  ops: FileOps,
  file: WorkerConfig,
): Promise<{ config: WorkerConfig; context: SettingsContext; corrupt: boolean }> {
  const { store, corrupt } = await WorkerConfigStore.open(ops, file.dataDir);
  const delivery = store.delivery;
  const plan = settingsPlan(file, delivery?.document.settings, {
    machineAdmin: machineAdminInEffect(file, delivery),
    platform: ops.platform,
  });
  const verified = await verifyRuntimePaths(file, plan, ops.platform);
  return {
    config: withSettings(file, verified.values),
    context: { file, boot: verified.values, bootBlocked: verified.blocked, platform: ops.platform },
    corrupt,
  };
}
