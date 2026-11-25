import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentAdapter, type FakeAdapterOptions, FakeRuntimeAdapter } from '@remyral/agent-adapters';
import { createLogger, Redactor, type Logger } from '@remyral/observability';
import type { WorkerFeature } from '@remyral/protocol';
import {
  type CapabilitiesPayload,
  ChildRegistry,
  createNodeFileOps,
  FileKeystore,
  FileSecretStore,
  JobRunner,
  LeaseKeyring,
  loadOrCreateDeviceKey,
  ManualSignals,
  type ProcessMemorySampler,
  type SandboxPort,
  SecretRegistry,
  WorkerDaemon,
  WorkerStore,
  WorkspaceManager,
  type WorkspacePort,
  WsTransport,
  type BlobPut,
  httpBlobPut,
} from '@remyral/worker';
import { FACTS } from './raw-worker.js';

/** The repository URL jobs name (JobSpec only allows https/ssh); the worker maps it to a local bare repo. */
export const REPO_URL = 'https://git.example.test/acme/app.git';
export const PROJECT = 'acme';

export const JOB_CAPS: CapabilitiesPayload = {
  runtimes: [
    {
      runtime: 'codex',
      version: '0.0.0-fake',
      installed: true,
      authenticated: 'yes',
      capabilities: { approval: { status: 'supported' }, cancel: { status: 'supported' } },
      pinnedVersion: '0.0.0-fake',
      pinStatus: 'match',
    },
  ],
  sandboxProfiles: ['host-restricted'],
  maxParallelJobs: 2,
  projects: [PROJECT],
  tools: [{ name: 'git', version: '2' }],
};

export function jobSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: 'codex',
    prompt: 'fix the bug',
    repository: { url: REPO_URL, baseRef: 'main', workBranch: 'feature' },
    sandboxProfile: 'host-restricted',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
    ...over,
  };
}

/** A bare repository with one commit on `main`, as a file:// URL. */
export async function createBareRepo(dirs: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rw-repo-'));
  dirs.push(root);
  const bare = join(root, 'app.git');
  const work = join(root, 'work');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.test',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.test',
      },
      stdio: 'ignore',
    });
  git(root, 'init', '--bare', '--initial-branch=main', bare);
  await mkdir(work);
  git(work, 'init', '--initial-branch=main');
  await writeFile(join(work, 'README.md'), '# app\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'initial');
  git(work, 'push', bare, 'main');
  return pathToFileURL(bare).toString();
}

/** Real WorkspaceManager on a file:// mirror, addressed by the job's https URL (test-only mapping). */
export async function mappedWorkspace(
  root: string,
  fileUrl: string,
  projects: readonly string[] = [PROJECT],
  /** p16-git-providers: the https URL jobs name (default REPO_URL). */
  repoUrl: string = REPO_URL,
): Promise<WorkspacePort> {
  const mgr = await WorkspaceManager.create({
    root,
    projects: Object.fromEntries(projects.map((p) => [p, [fileUrl]])),
    allowFileUrls: true,
    minFreeBytes: 0,
  });
  const map = (url: string) => (url === repoUrl ? fileUrl : url);
  return {
    root: mgr.root,
    git: mgr.git,
    checkRepository: (projectId, url) => mgr.checkRepository(projectId, map(url)),
    prepare: (req) =>
      mgr.prepare({ ...req, repository: { ...req.repository, url: map(req.repository.url) } }),
    release: (ws, outcome) => mgr.release(ws, outcome),
    commit: (ws, req) => mgr.commit(ws, req),
    push: (ws, req) => mgr.push(ws, req),
    // p5-research-workspace: scratch directories for workspace jobs.
    prepareScratch: (req) => mgr.prepareScratch(req),
    releaseScratch: (ws, outcome) => mgr.releaseScratch(ws, outcome),
    // p10-approval-pause: the kept worktree / scratch dir of a paused attempt.
    reopen: (req) => mgr.reopen({ ...req, repository: { ...req.repository, url: map(req.repository.url) } }),
    reopenScratch: (req) => mgr.reopenScratch(req),
  };
}

export interface JobWorker {
  daemon: WorkerDaemon;
  runner: JobRunner;
  transport: WsTransport;
  store: WorkerStore;
  adapter: FakeRuntimeAdapter;
  logger: Logger;
  lines: Record<string, unknown>[];
  stop(): Promise<void>;
  /** Simulates a crash: the socket and timers die, nothing is reported. */
  kill(): Promise<void>;
}

export async function startJobWorker(
  url: string,
  dataDir: string,
  opts: {
    fileUrl: string;
    /** p16-git-providers: the https URL jobs name that maps to fileUrl (default REPO_URL). */
    repoUrl?: string;
    fake?: FakeAdapterOptions;
    adapter?: AgentAdapter;
    capabilities?: CapabilitiesPayload;
    renewFraction?: number;
    selfFenceGraceMs?: number;
    credentialTimeoutMs?: number;
    /** Projects in the worker's repository allowlist (default: PROJECT only). */
    projects?: readonly string[];
    /** p6-skills: the worker's own trusted skills keys (config `skills.publicKeys`). */
    skillKeys?: readonly string[];
    /** p14-skill-import: the panel skills keys of the worker's managed config (part of skillKeys). */
    panelSkillKeys?: readonly string[];
    /** Worker config `runtimeAuth` (p7-secrets-scan canary: a secret-ref runtime credential). */
    runtimeAuth?: ConstructorParameters<typeof JobRunner>[0]['runtimeAuth'];
    /**
     * p5-research-workspace: workspace projects of this worker (effective config `workspaces`). When set, the
     * worker advertises `workspace-v1` and reports these projects too.
     */
    workspaces?: Readonly<Record<string, { egress: 'none' | 'allowlist' | 'web'; allowHosts: string[] }>>;
    /** p6-capacity-advice: the worker's process-tree memory sampler (absent: nothing measured). */
    memory?: ProcessMemorySampler;
    /** p6-quota-scheduling: adapters for runtimes other than codex (list them in `capabilities` too). */
    extraAdapters?: Readonly<Partial<Record<string, AgentAdapter>>>;
    /** p8-orchestration: extra features to advertise (e.g. `subtasks-v1`), added to the default ones. */
    features?: readonly WorkerFeature[];
    /**
     * p9-queue-priority: sandbox runners for the job runner (e.g. a Windows-like host runner without filesystem
     * confinement, so T-SBX-4 refusals happen). Absent: no runners, everything runs unconfined (the default).
     */
    sandbox?: SandboxPort;
    /** p10-claude-login-health: the run → login report (the daemon's LoginManager rule in production). */
    onRuntimeLogin?: ConstructorParameters<typeof JobRunner>[0]['onRuntimeLogin'];
    /** p11-master-resilience: the runner's monotonic lease clock (chaos: the master's fake clock). */
    leaseClock?: () => number;
    /** p13-runtime-accounts: the worker's runtime accounts (ASSIGN_JOB `execution.account` resolves against them). */
    accounts?: ConstructorParameters<typeof JobRunner>[0]['accounts'];
    /**
     * p14-mcp-core: external MCP servers for jobs — the keys specs verify with (JobRunner `mcp`). Advertise `mcp-v1`
     * through `features`.
     */
    mcp?: { readonly keys: readonly string[]; readonly allowed?: boolean; readonly egress?: boolean };
    /** p14-workflow-engine 14.3: function-job executors (JobRunner `functions`); advertise function-v1 via `features`. */
    functions?: ConstructorParameters<typeof JobRunner>[0]['functions'];
    /**
     * p17-object-storage: large outputs through the blob store — `true` uses the production uploader against this
     * master (and advertises `blob-upload-v1`); a function is a custom uploader.
     */
    blobPut?: true | BlobPut;
  },
): Promise<JobWorker> {
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
    facts: () => ({ ...FACTS, hostname: 'job-worker' }),
    timing: { backoffBaseMs: 20, backoffMaxMs: 200 },
  });
  const wsRoot = join(dataDir, 'ws');
  await mkdir(wsRoot, { recursive: true, mode: 0o700 }); // recursive: restarts reuse the data dir
  const workspace = await mappedWorkspace(wsRoot, opts.fileUrl, opts.projects, opts.repoUrl);
  const adapter = new FakeRuntimeAdapter({ runtime: 'codex', ...opts.fake });
  const workspaces = opts.workspaces;
  const caps: CapabilitiesPayload = opts.capabilities ?? {
    ...JOB_CAPS,
    ...(opts.projects === undefined ? {} : { projects: [...opts.projects] }),
    ...(workspaces === undefined
      ? {}
      : {
          projects: [...(opts.projects ?? JOB_CAPS.projects ?? []), ...Object.keys(workspaces)],
          features: ['workspace-v1' as const],
        }),
  };
  if (opts.features !== undefined) {
    caps.features = [...new Set([...(caps.features ?? []), ...opts.features])];
  }
  if (opts.blobPut !== undefined)
    caps.features = [...new Set([...(caps.features ?? []), 'blob-upload-v1' as const])];
  const blobPut =
    opts.blobPut === undefined
      ? undefined
      : opts.blobPut === true
        ? httpBlobPut({ masterUrl: url, workerVersion: '0.1.0-test' })
        : opts.blobPut;
  const daemon = new WorkerDaemon({
    maxParallelJobs: caps.maxParallelJobs,
    store,
    key,
    keystore,
    logger,
    transport,
    children: new ChildRegistry(),
    signals: new ManualSignals(),
    heartbeatIntervalMs: 100,
    load: () => Promise.resolve({ cpuPercent: 1, memoryFreeBytes: 1024, diskFreeBytes: 4096 }),
    capabilities: () => Promise.resolve(caps),
    jobs: (d) =>
      new JobRunner({
        store,
        machine: d.machine,
        logger,
        channel: d,
        keyring: new LeaseKeyring(null),
        workspace,
        adapters: (rt) => (rt === 'codex' ? (opts.adapter ?? adapter) : (opts.extraAdapters?.[rt] ?? null)),
        secretStore: new FileSecretStore(ops, dataDir),
        registry: new SecretRegistry(redactor.secrets),
        redactor,
        runtimeAuth: opts.runtimeAuth ?? {},
        ...(workspaces === undefined ? {} : { workspaces: () => workspaces }),
        // The in-memory fake runtime starts no process; sandbox runners are covered by p3-sandbox suites.
        sandbox: opts.sandbox ?? null,
        allowUnconfined: opts.sandbox === undefined,
        timeouts: { cancelGraceMs: 200, cancelMs: 5_000, approvalMs: 60_000 },
        credentialTimeoutMs: opts.credentialTimeoutMs ?? 2_000,
        ...(opts.skillKeys === undefined ? {} : { skillKeys: opts.skillKeys }),
        ...(opts.panelSkillKeys === undefined ? {} : { panelSkillKeys: () => opts.panelSkillKeys ?? [] }),
        ...(opts.memory === undefined ? {} : { memory: opts.memory }),
        ...(opts.renewFraction === undefined ? {} : { renewFraction: opts.renewFraction }),
        ...(opts.selfFenceGraceMs === undefined ? {} : { selfFenceGraceMs: opts.selfFenceGraceMs }),
        ...(opts.onRuntimeLogin === undefined ? {} : { onRuntimeLogin: opts.onRuntimeLogin }),
        ...(opts.leaseClock === undefined ? {} : { leaseClock: opts.leaseClock }),
        ...(opts.accounts === undefined ? {} : { accounts: opts.accounts }),
        ...(opts.functions === undefined ? {} : { functions: opts.functions }),
        ...(blobPut === undefined ? {} : { blobPut }),
        ...(opts.mcp === undefined
          ? {}
          : {
              mcp: {
                keys: () => opts.mcp?.keys ?? null,
                allowed: () => opts.mcp?.allowed !== false,
                egress: () => opts.mcp?.egress !== false,
              },
            }),
      }),
  });
  await daemon.start();
  const r = daemon.jobs as JobRunner | null;
  if (r === null) throw new Error('runner not created');
  return {
    daemon,
    runner: r,
    transport,
    store,
    adapter,
    logger,
    lines,
    async stop() {
      await daemon.stop('test');
    },
    async kill() {
      // Silence the runs (a dead process reports nothing) and cut the connection without a goodbye.
      await r.stop();
      await transport.stop();
    },
  };
}
