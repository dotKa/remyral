import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, Redactor, type Logger } from '@remyral/observability';
import type { RuntimeKind } from '@remyral/protocol';
import {
  type CapabilitiesPayload,
  ChildRegistry,
  ContainerEngine,
  ContainerSandboxRunner,
  createNodeFileOps,
  createSandboxRunners,
  FileKeystore,
  FileSecretStore,
  JobRunner,
  LeaseKeyring,
  loadOrCreateDeviceKey,
  ManualSignals,
  RuntimeRegistry,
  type RuntimeSettings,
  runtimeGate,
  SANDBOX_DEFAULT_LIMITS,
  type SandboxPort,
  SecretRegistry,
  WorkerDaemon,
  workerCapabilities,
  WorkerStore,
  WorkspaceManager,
  type WorkspacePort,
  WsTransport,
} from '@remyral/worker';
import { PROJECT, REPO_URL } from './job-worker.js';
import { FACTS } from './raw-worker.js';

/**
 * A worker daemon with the **production job wiring** (runtime registry with the real adapter factories,
 * runtime-policy gate, sandbox runners, worker commit + push) driving real runtime binaries — the
 * p3-e2e path without credentials (scripted model providers). Differences from production, all test seams:
 *  - the job's https URL is mapped to a local bare repository (file://);
 *  - the worker identity is declared verified (the developer's account is an admin; Seatbelt still
 *    confines the runtime for real on macOS);
 *  - `sandbox: 'none'` runs without confinement (OpenCode: its scripted provider listens on 127.0.0.1,
 *    which the egress proxy rightly refuses);
 *  - `sandbox: 'container'` accepts Docker Desktop on macOS (`allowNonLinuxHost`).
 */
export interface RuntimeWorker {
  readonly daemon: WorkerDaemon;
  readonly runner: JobRunner;
  readonly registry: RuntimeRegistry;
  readonly lines: Record<string, unknown>[];
  readonly logger: Logger;
  stop(): Promise<void>;
}

/** Real WorkspaceManager on a file:// mirror, addressed by the job's https URL, with commit and push. */
export async function mappedGitWorkspace(root: string, fileUrl: string): Promise<WorkspacePort> {
  const mgr = await WorkspaceManager.create({
    root,
    projects: { [PROJECT]: [fileUrl] },
    allowFileUrls: true,
    minFreeBytes: 0,
  });
  const map = (url: string) => (url === REPO_URL ? fileUrl : url);
  return {
    root: mgr.root,
    git: mgr.git,
    checkRepository: (projectId, url) => mgr.checkRepository(projectId, map(url)),
    prepare: (req) =>
      mgr.prepare({ ...req, repository: { ...req.repository, url: map(req.repository.url) } }),
    release: (ws, outcome) => mgr.release(ws, outcome),
    commit: (ws, req) => mgr.commit(ws, req),
    push: (ws, req) => mgr.push(ws, req),
  };
}

export async function startRuntimeWorker(
  url: string,
  dataDir: string,
  opts: {
    readonly fileUrl: string;
    readonly runtime: RuntimeKind;
    readonly settings: RuntimeSettings;
    readonly sandbox: 'host' | 'none' | 'container';
    readonly containerImages?: Partial<Record<RuntimeKind | 'default', string>>;
    readonly maxParallelJobs?: number;
  },
): Promise<RuntimeWorker> {
  const ops = createNodeFileOps();
  const lines: Record<string, unknown>[] = [];
  const redactor = new Redactor();
  const logger = createLogger({
    level: 'debug',
    redactor,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const { store } = await WorkerStore.open(ops, dataDir);
  const keystore = new FileKeystore(ops, dataDir);
  const { key } = await loadOrCreateDeviceKey(keystore);
  const transport = new WsTransport({
    masterUrl: url,
    logger,
    workerVersion: '0.1.0-test',
    facts: () => ({ ...FACTS, hostname: 'runtime-worker' }),
    timing: { backoffBaseMs: 20, backoffMaxMs: 200 },
  });
  // As in production the workspace root is not inside the worker data dir: Seatbelt denies the runtime
  // every read of the data dir (device key, secrets), which would include its own worktree.
  const wsRoot = `${dataDir}-ws`;
  await mkdir(wsRoot, { mode: 0o700 });
  const workspace = await mappedGitWorkspace(wsRoot, opts.fileUrl);

  const registry = await RuntimeRegistry.create({
    enabled: [opts.runtime],
    auth: {},
    settings: { [opts.runtime]: opts.settings },
    stateRoot: join(dataDir, 'runtimes'),
    locate: () => Promise.resolve(null),
    logger,
  });
  await registry.refreshAll(true);

  let sandbox: SandboxPort | null = null;
  let runners: Awaited<ReturnType<typeof createSandboxRunners>> | null = null;
  if (opts.sandbox !== 'none') {
    runners = await createSandboxRunners({
      settings: {
        seatbelt: 'required',
        protectedHomes: [],
        keepHome: false,
        hostExtraWritable: [],
        allowKeychain: false,
        // p19-linux-host-isolation: master integration workers keep the host baseline (no bubblewrap self-check).
        linuxHostIsolation: 'off',
        linuxPrivateNetwork: 'off',
        linuxLoginStoreView: false,
        egressAllow: ['api.anthropic.com'],
        limits: {},
        container: {
          engine: 'docker',
          images: opts.containerImages ?? {},
          proxyImage: 'remyral/egress-proxy:0.1.0',
          egressNetwork: 'bridge',
          user: '10001:10001',
        },
      },
      workspaceRoot: workspace.root,
      dataDir,
      identity: { verified: true, username: 'test', uid: process.getuid?.() ?? null, problems: [] },
    });
    const container = new ContainerSandboxRunner({
      engine: new ContainerEngine({}),
      images: opts.containerImages ?? {},
      proxyImage: 'remyral/egress-proxy:0.1.0',
      allowNonLinuxHost: true,
    });
    const base = runners;
    sandbox = {
      runners: {
        runner: (profile) => (profile === 'container' ? container : base.runner(profile)),
        capabilities: async (o) => ({
          ...(await base.capabilities(o)),
          container: await container.check(o.runtime),
        }),
      },
      limits: SANDBOX_DEFAULT_LIMITS,
      egressAllow: ['api.anthropic.com'],
    };
    runners = { ...base, container };
  }

  const probe = registry.status(opts.runtime).probe;
  const baseCaps: CapabilitiesPayload = {
    runtimes: [
      {
        runtime: opts.runtime,
        version: probe?.version ?? 'unknown',
        installed: probe?.installed === true,
        authenticated: 'unknown',
        capabilities: {},
        ...(probe === null ? {} : { pinnedVersion: probe.pinnedVersion }),
        pinStatus: probe?.versionMatchesPin === true ? 'match' : 'mismatch',
      },
    ],
    sandboxProfiles: [],
    maxParallelJobs: opts.maxParallelJobs ?? 1,
    tools: [{ name: 'git', version: '2' }],
  };
  const capabilities = async (): Promise<CapabilitiesPayload> => {
    const caps = await workerCapabilities(baseCaps, {
      registry,
      runners,
      runnersError: null,
      enabledRuntimes: [opts.runtime],
      projects: [PROJECT],
    });
    // Unconfined test mode: advertise host-restricted (the job's profile) although nothing confines it.
    return opts.sandbox === 'none' ? { ...caps, sandboxProfiles: ['host-restricted'] } : caps;
  };

  const daemon = new WorkerDaemon({
    maxParallelJobs: opts.maxParallelJobs ?? 1,
    store,
    key,
    keystore,
    logger,
    transport,
    children: new ChildRegistry(),
    signals: new ManualSignals(),
    heartbeatIntervalMs: 200,
    load: () => Promise.resolve({ cpuPercent: 1, memoryFreeBytes: 1024, diskFreeBytes: 4096 }),
    capabilities,
    jobs: (d) =>
      new JobRunner({
        store,
        machine: d.machine,
        logger,
        channel: d,
        keyring: new LeaseKeyring(null),
        workspace,
        runtimes: runtimeGate({ registry, policy: () => null, auth: {} }),
        secretStore: new FileSecretStore(ops, dataDir),
        registry: new SecretRegistry(redactor.secrets),
        redactor,
        runtimeAuth: {},
        sandbox,
        ...(opts.sandbox === 'none' ? { allowUnconfined: true } : {}),
        timeouts: { startupMs: 90_000, cancelGraceMs: 2_000, cancelMs: 20_000, approvalMs: 120_000 },
        credentialTimeoutMs: 2_000,
      }),
  });
  await daemon.start();
  const runner = daemon.jobs as JobRunner | null;
  if (runner === null) throw new Error('runner not created');
  return {
    daemon,
    runner,
    registry,
    lines,
    logger,
    async stop() {
      await daemon.stop('test');
      await rm(wsRoot, { recursive: true, force: true });
    },
  };
}
