import { hostFallback } from '../sandbox/host/fallback.js';
import { readJobSecretExposure } from '../secrets/exposure.js';
import type { McpInstaller } from '../mcp/install.js';
import { claudeLockDirs, osClaudeRunning, sweepClaudeLocks } from '../runtimes/claude-locks.js';
import { LoginStoreGate } from '../runtimes/login-gate.js';
import { createTelemetry, readHeadersFile, type Telemetry } from '@remyral/observability/telemetry';
import { dirname, join } from 'node:path';
import type { Logger, Redactor } from '@remyral/observability';
import type { RuntimeKind, RuntimePolicyDelivery } from '@remyral/protocol';
import type { WorkerConfig } from '../config/schema.js';
import type { WorkerDaemon } from '../daemon/daemon.js';
import type { FileOps } from '../fs/ops.js';
import type { SecretStore } from '../secrets/store.js';
import { RuntimeRegistry } from '../runtimes/registry.js';
import { createSecretStore } from '../secrets/factory.js';
import { SecretRegistry } from '../secrets/registry.js';
import { workspaceOptionsFromConfig } from '../workspace/from-config.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { LeaseKeyring } from './keyring.js';
import { osProcessTable, ProcessMemorySampler } from './memory.js';
import { JobRunner, type SandboxPort, type WorkspacePort } from './runner.js';
import { runtimeGate } from './runtime-gate.js';
import { limitsFromSettings } from '../sandbox/config.js';
import { createSandboxRunners, defaultInstallDir, type SandboxRunners } from '../sandbox/factory.js';
import { icacls, mcpInstallAclArgs, slotStateDir } from '../sandbox/host/windows-slots.js';
import { type EffectiveConfig, effectiveConfig } from '../managed-config/effective.js';
import { applyToolEnv, pathKey, type ToolEnv } from '../tools/tool-env.js';
import { PackageCaches } from '../caches/manager.js';
import { PreviewManager, type PreviewManagerDeps } from '../previews/manager.js';
import { TunnelSupervisor } from '../previews/supervisor.js';
import { ContainerPortForwarder } from '../previews/container.js';
import { ServiceManager } from '../services/manager.js';
import { osTreeSampler } from '../services/health.js';
import { IdeBridgeServer } from '../ide/bridge.js';
import { IdeExtensionCache } from '../ide/extensions.js';
import { IdeManager } from '../ide/manager.js';
import { IdeServerInstaller } from '../ide/server.js';
import { KeptWorkdirs } from '../workspace/kept.js';
import { type BlobPut, httpBlobPut } from '../workspace/blob-upload.js';
import { WORKER_VERSION } from '../version.js';
import { RuntimeUsageCollector } from '../runtimes/usage.js';
import type { AgentAdapter } from '@remyral/agent-adapters';
import { accountsOf, type RuntimeAccount } from '../accounts/accounts.js';
import { createCodeExecutor, DEFAULT_CODE_IMAGES, defaultExec } from '../functions/code.js';
import { CODE_IMAGE_CONTEXTS } from '../functions/code-images.generated.js';
import { type CodeImagesPort, createCodeImages } from '../functions/code-images.js';
import { NodeHttpExecutor } from '../functions/http.js';
import { NodeProbeExecutor } from '../functions/probe.js';
import { NodeSmtpExecutor } from '../functions/smtp.js';
import type { CodeExecutor, EmailExecutor, HttpExecutor, ProbeExecutor } from '../functions/types.js';

/** The live effective configuration (ADR-0015 ManagedConfig): current value + change notifications. */
export interface LiveConfigSource {
  readonly effective: EffectiveConfig;
  subscribe(listener: (e: EffectiveConfig) => void): () => void;
}

export interface JobWiring {
  /** Daemon job handler factory. */
  readonly jobs: (daemon: WorkerDaemon) => JobRunner;
  /** Runtime adapters (CAPABILITIES: per-runtime capability sets). */
  readonly registry: RuntimeRegistry;
  /** Profile runners (CAPABILITIES: sandbox readiness); null when they could not be created. */
  readonly sandbox: { readonly runners: SandboxRunners } | null;
  /**
   * p17-runtime-verify: the job sandbox port (runners, limits, model egress) for work confined like a job outside the
   * job runner (the capability verification); null when the runners could not be created.
   */
  readonly jobSandbox: SandboxPort | null;
  /** Why runners are missing (shown in CAPABILITIES readiness). */
  readonly sandboxError: string | null;
  /** Master lease keys (pinned or per session); also verifies panel configuration signatures. */
  readonly keyring: LeaseKeyring;
  /** Reference-counted redaction registration of injected secrets (shared with the assistant host). */
  readonly secretRegistry: SecretRegistry;
  /** p6-warm-caches (ADR-0029): the shared package caches (CAPABILITIES.packageCaches, sweeps). */
  readonly packageCaches: PackageCaches;
  /** p8-preview-tunnels (ADR-0032): the preview manager, once the daemon created the runner (null before / off). */
  readonly previews: () => PreviewManager | null;
  /** p15-services: the services this worker owns, once the daemon created the runner (null before / off). */
  readonly services: () => ServiceManager | null;
  /** p19-ide W2: the IDE workspaces this worker runs, once the daemon created the runner (null before / off). */
  readonly ide: () => IdeManager | null;
  /**
   * p15-workspace-retention: the kept working directories of workspace jobs (CAPABILITIES `workfiles`, sweeps); null
   * when the workspace root is unusable.
   */
  readonly workfiles: KeptWorkdirs | null;
  /**
   * p17-disk-selfclean: the workspace manager (its real root, retained failed workspaces); null when the workspace root
   * is unusable.
   */
  readonly workspace: WorkspaceManager | null;
  /**
   * p10-claude-login-health: one OAuth-refresh-prone start per subscription login store at a time, shared by job
   * attempts, the assistant host and the login probe.
   */
  readonly loginGate: LoginStoreGate;
  /** p10-claude-login-health: the stale Claude lock cleanup (wake / resume); a no-op with the fake runtime. */
  readonly sweepClaudeLocks: () => Promise<void>;
  /** p11-limit-visibility: the runtimes' usage-limit windows (jobs, assistant turns, probes) for HEARTBEAT. */
  readonly runtimeUsage: RuntimeUsageCollector;
  /** p13-runtime-accounts: this worker's runtime accounts in effect (configured + added). */
  readonly accounts: () => readonly RuntimeAccount[];
  /**
   * p14-workflow-engine 14.3: function job executors (HTTP / e-mail always; code only with container runners —
   * CAPABILITIES advertises `function-code-v1` while `code.ready()`).
   */
  readonly functions: {
    readonly http: HttpExecutor;
    readonly email: EmailExecutor;
    readonly code: CodeExecutor | undefined;
    /** p14-code-images: builds the code images (`code.images.prepare`; with the container runners only). */
    readonly codeImages: CodeImagesPort | undefined;
    /** p15-watches: loopback port checks of watches (CAPABILITIES advertises `watch-checks-v1`). */
    readonly probe: ProbeExecutor | undefined;
  };
}

/**
 * Builds the daemon's job runner from the worker config (production wiring):
 *  - workspace manager (a root that fails its safety checks disables job execution, never the daemon);
 *  - sandbox profile runners, created once at start (ADR-0007: without them every job is declined
 *    `sandbox_unavailable`, never run unconfined);
 *  - the runtime registry (real adapters of `@remyral/agent-adapters`; the fake only with the dev flag,
 *    which the config accepts only against a loopback dev master) and the runtime-policy gate;
 *  - secret store + redaction registry.
 */
export async function jobRunnerFromConfig(
  config: WorkerConfig,
  deps: {
    readonly ops: FileOps;
    readonly logger: Logger;
    readonly redactor: Redactor;
    /** The applied runtime policy (RuntimePolicyStore), read per job. */
    readonly policy?: () => RuntimePolicyDelivery | null;
    /** Located runtime executable (the probe's lookup); default: none (config `runtimes.<kind>.binary`). */
    readonly locate?: (runtime: RuntimeKind) => Promise<string | null>;
    /** p5-remote-ops: the worker-managed install of a runtime (preferred over `locate`). */
    readonly managed?: (runtime: RuntimeKind) => { file: string; args: readonly string[] } | null;
    /**
     * p16-runtime-updates: the active version of a runtime when it is an intact unverified install made through the
     * owner's policy (the job gate admits exactly that version); absent: none.
     */
    readonly unverifiedActive?: (runtime: RuntimeKind) => { version: string; pin: string } | null;
    /** p17-update-channel: the verified version-catalog pin per runtime (following policy rules compare with it). */
    readonly followPin?: (runtime: RuntimeKind) => string | null;
    /** ADR-0015: the live effective configuration (absent: the local file's values, fixed). */
    readonly live?: LiveConfigSource;
    /** Shared lease keyring (created here when absent). */
    readonly keyring?: LeaseKeyring;
    /**
     * p5-credentials-models: the secret store shared with the credential vault (wrapped to record vault
     * credential use); created from the config when absent.
     */
    readonly secretStore?: SecretStore;
    /**
     * p5-machine-admin: the install dir of the root/SYSTEM helper (where the elevated broker answers). Default: the
     * directory of the running bundle; null disables machine-admin jobs.
     */
    readonly adminInstallDir?: string | null;
    /** p5-machine-admin: prompt hint for jobs that require tools the worker manages (e.g. its browser). */
    readonly toolHints?: (tools: readonly string[]) => Promise<string | null>;
    /** p17-object-storage: PUTs of large outputs (test seam; default: HTTPS to the master / the presigned URL). */
    readonly blobPut?: BlobPut;
    /**
     * p5-live-fixes-2: the git executable for repository jobs, resolved per command (config → worker-managed
     * tool → PATH). Default: `config.gitBinary`, else `git` on PATH.
     */
    readonly gitBinary?: () => Promise<string>;
    /** p5-live-fixes-2: worker-managed tool dirs/variables for runtime processes of host profiles. */
    readonly toolEnv?: () => Promise<ToolEnv>;
    /** p5-claude-auth-health: a run failed with `login_expired` / a run succeeded (see JobRunnerDeps). */
    readonly onRuntimeLogin?: (
      runtime: RuntimeKind,
      state: 'expired' | 'ok',
      cause?: 'refresh_contention' | 'expired',
      account?: string,
    ) => void;
    /** p13-runtime-accounts: the accounts in effect changed (new configuration): folders, CAPABILITIES. */
    readonly onAccountsChanged?: (accounts: readonly RuntimeAccount[]) => void;
    /** p5-claude-auth-health: whether a Claude process of the worker user runs (default: the OS process list). */
    readonly claudeRunning?: () => Promise<boolean>;
    /** p6-capacity-advice: process-tree memory sampler (default: the OS process table; null: not measured). */
    readonly memory?: ProcessMemorySampler | null;
    /** p6-warm-caches: the package cache report changed (re-send CAPABILITIES). */
    readonly onPackageCachesChanged?: () => void;
    /** p9-windows-host-isolation: sandbox readiness changed in the background (re-send CAPABILITIES). */
    readonly onSandboxChanged?: () => void;
    /**
     * p14-login-status-consistency: the runtime registry finished rebuilding for a new configuration (auth mode,
     * enabled runtimes) — re-send CAPABILITIES. The CAPABILITIES sent right after APPLY_WORKER_CONFIG may be built
     * before the (async) rebuild swapped the adapters in, and would then keep the previous auth state.
     */
    readonly onRuntimesReconfigured?: () => void;
    /**
     * p8-preview-tunnels (ADR-0032): the cloudflared to run for preview connectors (worker-managed recipe, else one
     * on PATH). Absent: previews are off on this worker (no feature advertised).
     */
    /** p14-mcp-stdio: local MCP server installs (absent: stdio servers are declined). */
    readonly mcpStdio?: {
      readonly installer: McpInstaller;
      readonly nodePath: string;
      readonly enabled: () => boolean;
    };
    /** p15-services: false = no services on this machine (`localCeiling.allowServices: false`). */
    readonly services?: boolean;
    /**
     * p19-ide W2: the IDE workspaces — whether the owner allows them here (`localCeiling.allowIde`), the stream plane
     * (open streams per workspace, reset), the console origin for the bridge's "Konsola dön". Absent: no IDE.
     */
    readonly ide?: {
      readonly allowed: boolean;
      readonly streams: { countFor(workspaceId: string): number; resetWorkspace(workspaceId: string): void };
      readonly consoleUrl?: string;
      /** p19-ide W3: downloads from the master origin (VSIX blobs and settings of a start, with its token). */
      readonly download?: (path: string, token: string, maxBytes: number) => Promise<Buffer>;
    };
    readonly cloudflared?: () => Promise<{
      path: string;
      version: string;
      source: 'managed' | 'system';
    } | null>;
  },
): Promise<JobWiring> {
  const live: LiveConfigSource = deps.live ?? {
    effective: effectiveConfig(config, null).config,
    subscribe: () => () => undefined,
  };
  const keyring = deps.keyring ?? new LeaseKeyring(config.masterLeaseKeys ?? null);
  const initial = live.effective;
  let manager: WorkspaceManager | null = null;
  let workspace: WorkspacePort | null = null;
  try {
    manager = await WorkspaceManager.create({
      ...workspaceOptionsFromConfig(config, deps.logger),
      ...workspaceFromEffective(initial),
      ...(deps.gitBinary !== undefined
        ? { gitBinary: deps.gitBinary }
        : config.gitBinary === undefined
          ? {}
          : { gitBinary: config.gitBinary }),
    });
    workspace = manager;
  } catch (err) {
    deps.logger.error('workspace root unusable; jobs will be declined', { err });
  }
  // p15-workspace-retention: kept working directories live next to `jobs/` under the same (real) root.
  let workfilesDaemon: WorkerDaemon | null = null;
  let workfiles: KeptWorkdirs | null = null;
  if (manager !== null) {
    try {
      workfiles = await KeptWorkdirs.create({
        root: manager.root,
        logger: deps.logger.child({ component: 'workfiles' }),
        onChange: (status) => {
          void workfilesDaemon?.workfiles.status(status).catch(() => undefined);
        },
      });
    } catch (err) {
      deps.logger.error('kept workspaces unavailable; workspace jobs are released at the end', { err });
    }
  }
  let sandbox: SandboxPort | null = null;
  let runners: SandboxRunners | null = null;
  let sandboxError: string | null = workspace === null ? 'workspace root unusable' : null;
  if (workspace !== null) {
    try {
      runners = await createSandboxRunners({
        settings: config.sandbox,
        workspaceRoot: workspace.root,
        dataDir: config.dataDir,
        // p9-windows-host-isolation: parallel host attempts are bounded by the effective parallelism too.
        maxParallelJobs: () => live.effective.maxParallelJobs,
        slotStateDir: slotStateDir(dirname(config.source)),
        onChanged: () => deps.onSandboxChanged?.(),
        // ADR-0019: read on every check, so a new panel generation switches `unconfined` without a restart.
        unconfinedAllowed: () => {
          const u = live.effective.unconfined ?? 'not_enabled';
          return u === 'allowed'
            ? { allowed: true }
            : u === 'forbidden_locally'
              ? {
                  allowed: false,
                  code: 'unconfined_forbidden_locally',
                  detail: 'the panel allows the unconfined profile but the local config forbids it',
                }
              : { allowed: false, code: 'unconfined_not_enabled' };
        },
      });
      sandbox = {
        runners,
        limits: limitsFromSettings(config.sandbox.limits),
        egressAllow: config.sandbox.egressAllow,
      };
    } catch (err) {
      sandboxError = err instanceof Error ? err.message : 'sandbox runners unavailable';
      deps.logger.error('sandbox runners unavailable; jobs will be declined', { err });
    }
  }
  const secretStore =
    deps.secretStore ??
    createSecretStore(
      { secretStore: config.secretStore, dataDir: config.dataDir, keychainPath: config.keychainPath },
      deps.ops,
    );
  const secrets = new SecretRegistry(deps.redactor.secrets);
  if (config.devFakeRuntime) {
    deps.logger.warn('devFakeRuntime is enabled: jobs run on the fake runtime adapter (development only)');
  }
  const sweepLocks = async (dirs: readonly string[] = claudeLockDirs()): Promise<void> => {
    if (config.devFakeRuntime) return;
    await sweepClaudeLocks({
      dirs,
      claudeRunning: deps.claudeRunning ?? osClaudeRunning(),
      logger: deps.logger,
      ...(config.claudeLockMaxAgeMinutes === undefined
        ? {}
        : { maxAgeMs: config.claudeLockMaxAgeMinutes * 60_000 }),
    });
  };
  // p13-runtime-accounts: the accounts in effect (configured + added), recomputed when the configuration changes.
  let accountList: readonly RuntimeAccount[] = accountsOf(initial, config.dataDir);
  const accounts = (): readonly RuntimeAccount[] => accountList;
  // p10-claude-login-health: the janitor also runs before a gated start (assistant sessions included);
  // p13-runtime-accounts: for an added Claude Code account it sweeps that account's folder and config dir.
  const loginGate = new LoginStoreGate({
    logger: deps.logger,
    prepare: (store) => {
      if (store === 'claude') return () => sweepLocks();
      const a = accountList.find((x) => x.store === store && x.runtime === 'claude-code');
      return a?.folder === undefined || a.loginDir === undefined
        ? undefined
        : () => sweepLocks([a.folder ?? '', a.loginDir ?? '']);
    },
  });
  const registry = await RuntimeRegistry.create({
    enabled: initial.allowedRuntimes,
    auth: initial.runtimeAuth,
    settings: initial.runtimeSettings,
    // Adapter reference state; <dataDir>/runtimes holds the worker-managed installs (p5-remote-ops).
    stateRoot: join(config.dataDir, 'runtime-state'),
    locate: deps.locate ?? (() => Promise.resolve(null)),
    ...(deps.managed === undefined ? {} : { managed: deps.managed }),
    logger: deps.logger,
    fake: config.devFakeRuntime ? {} : null,
    // p5-claude-auth-health: stale OAuth-refresh / config locks of an earlier Claude process block every run.
    ...(config.devFakeRuntime ? {} : { beforeStart: { 'claude-code': () => sweepLocks() } }),
  });
  /** p13-runtime-accounts: one long-lived usage reader per added subscription account (its own config dir). */
  const accountReaders = new Map<string, AgentAdapter | null>();
  // p11-limit-visibility: probes only the runtimes running with the worker's own subscription login.
  const runtimeUsage = new RuntimeUsageCollector({
    logger: deps.logger,
    localLogin: () =>
      live.effective.allowedRuntimes.filter((r) => live.effective.runtimeAuth[r]?.mode === 'local-login'),
    reader: (runtime) => registry.status(runtime).reference,
    accounts: () =>
      accountList
        .filter((a) => a.kind === 'subscription' && a.loginDir !== undefined && a.store !== undefined)
        .map((a) => ({
          runtime: a.runtime,
          account: a.id,
          store: a.store ?? '',
          reader: () => {
            const key = `${a.runtime}#${a.id}`;
            if (!accountReaders.has(key)) {
              accountReaders.set(key, registry.createForAccount(a.runtime, a.id, a.loginDir ?? ''));
            }
            return accountReaders.get(key) ?? null;
          },
        })),
    gate: loginGate,
    ...(config.usageProbeMinutes === undefined || config.usageProbeMinutes === 0
      ? {}
      : { probeIntervalMs: config.usageProbeMinutes * 60_000 }),
  });
  for (const runtime of initial.allowedRuntimes) {
    const s = registry.status(runtime);
    if (s.unavailable !== null) {
      deps.logger.warn('runtime not available; its jobs will be declined', {
        runtime,
        code: s.unavailable.code,
        reason: s.unavailable.message,
      });
    }
  }
  // p6-otel: OTLP export only when configured (worker-to-collector, outbound like everything else).
  let telemetry: Telemetry | null = null;
  if (config.telemetry !== undefined) {
    telemetry = createTelemetry({
      serviceName: 'remyral-worker',
      redactor: deps.redactor,
      otlp: {
        endpoint: config.telemetry.otlpEndpoint,
        ...(config.telemetry.otlpHeadersFile === undefined
          ? {}
          : { headers: await readHeadersFile(config.telemetry.otlpHeadersFile) }),
      },
    });
  }
  const runtimes = runtimeGate({
    registry,
    policy: deps.policy ?? (() => null),
    auth: () => live.effective.runtimeAuth,
    modelProfiles: () => live.effective.modelProfiles,
    defaultModels: () => {
      const s = live.effective.runtimeSettings;
      const out: Partial<Record<RuntimeKind, string>> = {};
      for (const r of ['claude-code', 'codex'] as const) {
        const m = s[r]?.model;
        if (m !== undefined) out[r] = m;
      }
      return out;
    },
    // p15-model-picker: the machine names its own default (any runtime; Pi / OpenCode through the adapter settings).
    ownDefaultModel: (runtime) => live.effective.runtimeSettings[runtime]?.model !== undefined,
    ...(deps.unverifiedActive === undefined ? {} : { unverifiedActive: deps.unverifiedActive }),
    ...(deps.followPin === undefined ? {} : { followPin: deps.followPin }),
  });
  // ADR-0015 hot reload: a new panel configuration takes effect without a restart.
  live.subscribe((e) => {
    accountList = accountsOf(e, config.dataDir);
    accountReaders.clear();
    deps.onAccountsChanged?.(accountList);
    try {
      manager?.reconfigure(workspaceFromEffective(e));
    } catch (err) {
      deps.logger.error('new repository allowlist refused; keeping the previous one', { err });
    }
    registry
      .reconfigure({ enabled: e.allowedRuntimes, auth: e.runtimeAuth, settings: e.runtimeSettings })
      .then(() => deps.onRuntimesReconfigured?.())
      .catch((err: unknown) => {
        deps.logger.error('runtime registry reconfiguration failed', { err });
      });
  });
  // p6-warm-caches (ADR-0029): `<dataDir>/caches`, limit from the live configuration (re-read per use).
  const packageCaches = new PackageCaches({
    root: join(config.dataDir, 'caches'),
    settings: () => ({
      enabled: config.packageCaches.enabled,
      maxBytes: live.effective.workspace.packageCacheMaxBytes,
    }),
    logger: deps.logger.child({ component: 'package-caches' }),
    onChanged: () => deps.onPackageCachesChanged?.(),
  });
  live.subscribe(() => {
    packageCaches.scheduleSweep();
  });
  const memory =
    deps.memory === null ? null : (deps.memory ?? new ProcessMemorySampler({ read: osProcessTable() }));
  let previews: PreviewManager | null = null;
  let services: ServiceManager | null = null;
  let ide: IdeManager | null = null;
  const cloudflared = deps.cloudflared;
  const makePreviews = (daemon: WorkerDaemon, lease: PreviewManagerDeps['lease']): PreviewManager | null => {
    if (cloudflared === undefined) return null;
    let manager: PreviewManager | null = null;
    const supervisor = new TunnelSupervisor({
      dataDir: config.dataDir,
      cloudflared: async () => (await cloudflared().catch(() => null))?.path ?? null,
      logger: deps.logger,
      onState: (tunnelId, state, detail, restarts) => {
        manager?.onConnectorState(tunnelId, state, detail, restarts);
        daemon.refreshCapabilities();
      },
    });
    void supervisor.cleanStale();
    manager = new PreviewManager({
      supervisor,
      channel: {
        request: (jobId, payload) => daemon.previews.request(jobId, payload),
        status: (payload) => daemon.previews.status(payload),
        workerId: () => daemon.workerId(),
      },
      keys: () => keyring.keys,
      lease,
      cloudflared: async () => {
        const c = await cloudflared().catch(() => null);
        return c === null ? null : { version: c.version, source: c.source };
      },
      logger: deps.logger,
      // p22-previews-inputs (`preview-container-v1`): container-profile jobs publish their port on the loopback.
      ...(runners === null
        ? {}
        : {
            containers: new ContainerPortForwarder({
              binary: runners.container.engine.binary,
              clientEnv: runners.container.engine.clientEnv,
              containers: (jobId) => runners.container.jobContainers(jobId),
              exec: (args, timeoutMs) => runners.container.engine.exec(args, timeoutMs),
              logger: deps.logger,
            }),
          }),
    });
    return manager;
  };
  // p14-workflow-engine 14.3 (ADR-0055): function jobs. Code (K3) only where the container runners exist, the panel /
  // local ceiling leave the container profile on, and the engine + pinned code images are ready.
  const codeInner =
    runners === null ? undefined : createCodeExecutor({ engine: config.sandbox.container.engine });
  const code: CodeExecutor | undefined =
    codeInner === undefined
      ? undefined
      : {
          ready: async () =>
            live.effective.sandboxProfiles.includes('container') && (await codeInner.ready()),
          run: (spec, ctx) => codeInner.run(spec, ctx),
        };
  const codeImages: CodeImagesPort | undefined =
    codeInner === undefined || code === undefined
      ? undefined
      : createCodeImages({
          engine: config.sandbox.container.engine,
          exec: defaultExec,
          contexts: CODE_IMAGE_CONTEXTS,
          images: DEFAULT_CODE_IMAGES,
          ready: async () => {
            codeInner.invalidate?.();
            return code.ready();
          },
        });
  // p15-watches (watch-checks-v1): loopback port checks of watches.
  const functions = {
    http: new NodeHttpExecutor(),
    email: new NodeSmtpExecutor(),
    code,
    codeImages,
    probe: new NodeProbeExecutor(),
  };
  return {
    functions,
    registry,
    keyring,
    secretRegistry: secrets,
    sandbox: runners === null ? null : { runners },
    jobSandbox: sandbox,
    sandboxError,
    packageCaches,
    previews: () => previews,
    services: () => services,
    ide: () => ide,
    workfiles,
    workspace: manager,
    loginGate,
    sweepClaudeLocks: () => sweepLocks(),
    runtimeUsage,
    accounts,
    jobs: (daemon) => {
      let runner: JobRunner | null = null;
      workfilesDaemon = daemon;
      previews = makePreviews(daemon, (jobId) => runner?.previewLease(jobId));
      runner = new JobRunner({
        store: daemon.store,
        machine: daemon.machine,
        logger: deps.logger,
        channel: daemon,
        keyring,
        workspace,
        // p17-object-storage: large outputs straight to the blob store (`blob-upload-v1`).
        blobPut: deps.blobPut ?? httpBlobPut({ masterUrl: config.masterUrl, workerVersion: WORKER_VERSION }),
        runtimes,
        secretStore,
        jobSecretExposure: () => readJobSecretExposure(deps.ops, config.dataDir),
        registry: secrets,
        redactor: deps.redactor,
        runtimeAuth: () => live.effective.runtimeAuth,
        // p13-runtime-accounts: the accounts ASSIGN_JOB `execution.account` may name, and whether their folders may be
        // lent to Windows per-job accounts now.
        accounts,
        accountLending: () => runners?.windowsSlots?.accountLending() === true,
        allowedProfiles: () => live.effective.sandboxProfiles,
        // p19-unconfined-parallel: read per job, so a new panel generation applies without a restart.
        unconfinedParallel: () => live.effective.unconfinedParallel === true,
        workspaces: () => live.effective.workspaces,
        // p16-workflow-quality: scratch steps of these projects (JobSpec.workspace.scratch).
        repositoryProjects: () => Object.keys(live.effective.projects),
        sandbox,
        // ADR-0021: the offline keys of the local file plus the panel key(s) of the applied, signed configuration.
        skillKeys: () => {
          const local = config.skills.publicKeys ?? [];
          const panel = live.effective.panelSkillKeys ?? [];
          const all = [...new Set([...local, ...panel])];
          return all.length === 0 ? null : all;
        },
        // p14-skill-import: left out for "offline-signed only" projects (ASSIGN_JOB execution.skillTrust).
        panelSkillKeys: () => live.effective.panelSkillKeys ?? [],
        // p14-mcp-core (ADR-0054): MCP specs verify with the offline keys plus the panel keys the local file allows.
        mcp: {
          keys: () => {
            const all = [
              ...new Set([...(config.skills.publicKeys ?? []), ...(live.effective.panelMcpKeys ?? [])]),
            ];
            return all.length === 0 ? null : all;
          },
          allowed: () => config.localCeiling?.allowMcp !== false,
          egress: () => config.localCeiling?.allowMcpEgress !== false,
          ...(deps.mcpStdio === undefined ? {} : { stdio: deps.mcpStdio }),
        },
        machineAdmin: {
          ops: deps.ops,
          dataDir: config.dataDir,
          installDir:
            deps.adminInstallDir === null ? undefined : (deps.adminInstallDir ?? defaultInstallDir()),
          effective: () => {
            const m = live.effective.machineAdmin;
            return {
              enabled: m?.enabled === true,
              autoApprove: m?.autoApprove === true,
              forbiddenLocally:
                m?.forbiddenLocally === true || config.localCeiling?.allowMachineAdmin === false,
              hostUnconfined: (() => {
                if (config.localCeiling?.allowMachineAdmin === true) return null;
                const f = hostFallback(runners);
                return f === null ? null : { cause: f.cause, pending: f.pending };
              })(),
            };
          },
        },
        ...(telemetry === null ? {} : { telemetry }),
        ...(memory === null ? {} : { memory }),
        packageCaches,
        ...(deps.toolHints === undefined ? {} : { toolHints: deps.toolHints }),
        ...(deps.toolEnv === undefined ? {} : { toolEnv: deps.toolEnv }),
        ...(deps.onRuntimeLogin === undefined ? {} : { onRuntimeLogin: deps.onRuntimeLogin }),
        ...(previews === null ? {} : { previews }),
        loginGate,
        // p11-session-continuity: containers a crashed run left are removed before its attempt resumes.
        ...(runners === null
          ? {}
          : {
              stopAttemptContainers: (jobId: string, attemptId: string) =>
                runners.container.removeAttemptContainers(jobId, attemptId),
            }),
        runtimeUsage,
        functions,
        ...(workfiles === null ? {} : { workfiles }),
      });
      // p15-services (docs/design/p15-services.md): long-running services the worker owns, not a job.
      const svcRunner = runner;
      if (deps.services !== false && sandbox !== null && runners !== null) {
        let manager: ServiceManager | null = null;
        const tunnels =
          cloudflared === undefined
            ? null
            : new TunnelSupervisor({
                dataDir: config.dataDir,
                subdir: 'services/tunnels',
                cloudflared: async () => (await cloudflared().catch(() => null))?.path ?? null,
                logger: deps.logger,
                onState: (tunnelId, state, detail) => {
                  manager?.onConnectorState(tunnelId, state, detail);
                },
                onUrl: (tunnelId, url) => {
                  manager?.onConnectorUrl(tunnelId, url);
                },
              });
        void tunnels?.cleanStale();
        const sb = sandbox;
        const rn = runners;
        manager = new ServiceManager({
          dataDir: config.dataDir,
          workspace,
          runner: (profile) => {
            try {
              return rn.runner(profile);
            } catch {
              return null;
            }
          },
          limits: sb.limits,
          egressAllow: sb.egressAllow,
          allowedProfiles: () => live.effective.sandboxProfiles,
          secretStore,
          jobSecretExposure: () => readJobSecretExposure(deps.ops, config.dataDir),
          keys: () => keyring.keys,
          channel: {
            status: (payload) => daemon.services.status(payload),
            logs: (payload) => daemon.services.logs(payload),
            workerId: () => daemon.workerId(),
          },
          tunnels,
          claimJobWorkspace: (jobId, attemptId, serviceId) =>
            svcRunner.claimWorkspace(jobId, attemptId, serviceId),
          releaseJobClaim: (jobId, attemptId, serviceId) => {
            svcRunner.releaseClaim(jobId, attemptId, serviceId);
          },
          logger: deps.logger,
          // The worker-managed tools (node, pnpm, git …) on PATH, as for a job's runtime.
          ...(deps.toolEnv === undefined
            ? {}
            : {
                extraEnv: async () => {
                  const te = deps.toolEnv;
                  if (te === undefined) return {};
                  const pathName = pathKey(process.env, process.platform);
                  return applyToolEnv(
                    { [pathName]: process.env[pathName] ?? '' },
                    await te(),
                    process.platform,
                  );
                },
              }),
        });
        services = manager;
        runner.attachServices(manager);
        void manager.load().catch((err: unknown) => {
          deps.logger.error('services could not be loaded', { err });
        });
      }
      // p19-ide W2 (docs/design/p19-ide.md, ADR-0066): "Tam IDE" workspaces — openvscode-server under the services'
      // sandbox profile, reached only through the master's stream plane. Linux only (the manager reports why not).
      const ideDeps = deps.ide;
      if (ideDeps?.allowed === true && sandbox !== null && runners !== null) {
        const sb = sandbox;
        const rn = runners;
        let ideManager: IdeManager | null = null;
        const refused = { status: 'refused' as const, message: 'IDE hazır değil.' };
        const bridge = new IdeBridgeServer(
          {
            reference: (id, r) => ideManager?.bridgeHandler.reference(id, r) ?? Promise.resolve(refused),
            push: (id, r) => ideManager?.bridgeHandler.push(id, r) ?? Promise.resolve(refused),
            terminal: (id, r) => ideManager?.bridgeHandler.terminal(id, r) ?? Promise.resolve(refused),
            settings: (id) =>
              ideManager?.bridgeHandler.settings(id) ??
              Promise.resolve({ sync: false, settings: null, keybindings: null }),
            saveSettings: (id, r) =>
              ideManager?.bridgeHandler.saveSettings(id, r) ?? Promise.resolve(refused),
          },
          deps.logger,
        );
        const kept = workfiles;
        ideManager = new IdeManager({
          dataDir: config.dataDir,
          workspace: manager,
          runner: () => {
            try {
              return rn.runner('host-restricted');
            } catch {
              return null;
            }
          },
          limits: sb.limits,
          egressAllow: sb.egressAllow,
          allowedProfiles: () => live.effective.sandboxProfiles,
          // p19-ide W2b: macOS needs Seatbelt, Windows the per-job accounts (manager.ts idePlatformRefusal).
          sandboxCheck: () => {
            const c = rn.host.check();
            return { ready: c.ready, filesystemConfinement: c.filesystemConfinement, reason: c.reason };
          },
          keys: () => keyring.keys,
          channel: {
            status: (payload) => daemon.ide.status(payload),
            gitResult: (payload) => daemon.ide.gitResult(payload),
            fileData: (payload) => daemon.ide.fileData(payload),
            event: (payload) => daemon.ide.event(payload),
            workerId: () => daemon.workerId(),
          },
          server: new IdeServerInstaller({
            dataDir: config.dataDir,
            logger: deps.logger,
            // p19-ide W2b: Windows per-job accounts run the server: read + execute on the verified install only.
            ...(process.platform === 'win32'
              ? {
                  grantRead: async (dir: string) => {
                    const state = rn.windowsSlots?.state ?? null;
                    if (state === null) return false;
                    await icacls(mcpInstallAclArgs(dir, state.workerSid, state.group.sid));
                    return true;
                  },
                }
              : {}),
          }),
          bridge,
          streamsFor: (id) => ideDeps.streams.countFor(id),
          resetStreams: (id) => {
            ideDeps.streams.resetWorkspace(id);
          },
          ...(kept === null
            ? {}
            : {
                seed: async (jobId: string, attemptId: string, dest: string) =>
                  (await kept.seedLocal(jobId, attemptId, { path: dest, inDir: join(dest, 'in') })) !== null,
              }),
          ...(ideDeps.consoleUrl === undefined ? {} : { consoleUrl: ideDeps.consoleUrl }),
          // p19-ide W3: the offline VSIX cache and the master download of a start's extensions / settings.
          extensionCache: new IdeExtensionCache({ dataDir: config.dataDir, logger: deps.logger }),
          ...(ideDeps.download === undefined ? {} : { download: ideDeps.download }),
          sampler: osTreeSampler(),
          logger: deps.logger,
          ...(deps.toolEnv === undefined
            ? {}
            : {
                extraEnv: async () => {
                  const te = deps.toolEnv;
                  if (te === undefined) return {};
                  const pathName = pathKey(process.env, process.platform);
                  return applyToolEnv(
                    { [pathName]: process.env[pathName] ?? '' },
                    await te(),
                    process.platform,
                  );
                },
              }),
        });
        ide = ideManager;
        runner.attachIde(ideManager);
        const im = ideManager;
        void bridge
          .start()
          .then(() => im.load())
          .catch((err: unknown) => {
            deps.logger.error('IDE workspaces could not be loaded', { err });
          });
      }
      // p10-approval-pause: discard parked attempts past their retention (now and hourly).
      runner.startHousekeeping();
      return runner;
    },
  };
}

function workspaceFromEffective(e: EffectiveConfig) {
  return {
    projects: e.projects,
    retainFailed: e.workspace.retainFailed,
    minFreeBytes: e.workspace.minFreeBytes,
    submodules: e.workspace.submodules,
  };
}
