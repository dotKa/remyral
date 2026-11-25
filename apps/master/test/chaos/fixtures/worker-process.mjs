// A real worker daemon in its own OS process, so the chaos suite can SIGKILL it (p4-chaos). It wires the
// same stack as test/helpers/job-worker.ts (WorkerDaemon + JobRunner + real WorkspaceManager on a local bare
// repository + the fake runtime) from the built packages (`pnpm chaos` builds them first).
//
// Input: CHAOS_WORKER (JSON) {url, dataDir, fileUrl, repoUrl, project, tag, mode, features?}
//   features (p11-session-continuity): worker features to advertise (e.g. session-continuity-v1).
//   mode: 'normal' | 'drop-result' (JOB_RESULT frames are not transmitted: a partition after the push;
//         the message stays in the durable outbox) | 'stall-seq' (recording the master's sequence number
//         never completes: a slow disk between ASSIGN_JOB admission and the cursor write)
// Output: one JSON line per event on stdout: ready | spawn {jobId, attemptId} | result-dropped {jobId}.
// The process never exits by itself; the parent SIGKILLs it (or SIGTERMs it for a clean stop).
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { basicScript, FakeRuntimeAdapter } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  ChildRegistry,
  createNodeFileOps,
  FileKeystore,
  FileSecretStore,
  JobRunner,
  LeaseKeyring,
  loadOrCreateDeviceKey,
  ManualSignals,
  SecretRegistry,
  WorkerDaemon,
  WorkerStore,
  WorkspaceManager,
  WsTransport,
} from '@remyral/worker';

const cfg = JSON.parse(process.env.CHAOS_WORKER ?? '{}');
const emit = (ev, data = {}) => process.stdout.write(`${JSON.stringify({ ev, ...data })}\n`);

const FACTS = {
  os: 'darwin',
  osVersion: '26.0',
  arch: 'arm64',
  hostname: `chaos-${cfg.tag}`,
  cpuCount: 8,
  memoryBytes: 16 * 1024 ** 3,
  diskFreeBytes: 100 * 1024 ** 3,
};

const caps = {
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
  projects: [cfg.project],
  tools: [{ name: 'git', version: '2' }],
  ...(Array.isArray(cfg.features) ? { features: cfg.features } : {}),
};

/**
 * Fake runtime that writes `edit <path> <text>` prompt lines into the worktree and reports each spawn.
 * A prompt containing `hold-forever` never finishes (until the attempt is aborted or the process dies).
 * p11-session-continuity: `hold-until-restart` holds like `hold-forever` in the first process only (a marker file in the
 * data dir); after the worker process restarted, the resumed attempt finishes.
 */
class EditingAdapter extends FakeRuntimeAdapter {
  #held = new Map();
  async spawn(ctx) {
    emit('spawn', { jobId: ctx.jobId, attemptId: ctx.attemptId });
    for (const line of ctx.job.prompt.split('\n')) {
      const m = /^edit (\S+) (.*)$/.exec(line);
      if (m) await writeFile(join(ctx.workspaceRoot, m[1]), `${m[2] ?? ''}\n`);
    }
    const ref = await super.spawn(ctx);
    if (ctx.job.prompt.includes('hold-forever')) this.#held.set(ref.sessionId, ctx.signal);
    if (ctx.job.prompt.includes('hold-until-restart')) {
      const marker = join(cfg.dataDir, `held-${ctx.attemptId}`);
      if ((await stat(marker).catch(() => null)) === null) {
        await writeFile(marker, 'held\n');
        this.#held.set(ref.sessionId, ctx.signal);
        emit('holding', { jobId: ctx.jobId, attemptId: ctx.attemptId });
      } else {
        emit('resumed', { jobId: ctx.jobId, attemptId: ctx.attemptId });
      }
    }
    return ref;
  }
  async collectResult(ref) {
    const signal = this.#held.get(ref.sessionId);
    if (signal !== undefined && !signal.aborted) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
    }
    return super.collectResult(ref);
  }
}

const ops = createNodeFileOps();
const redactor = new Redactor();
const logger = createLogger({ level: 'info', redactor, sink: (line) => process.stderr.write(`${line}\n`) });
const { store } = await WorkerStore.open(ops, cfg.dataDir);
if (cfg.mode === 'stall-seq') {
  // The first master sequence number written after an ASSIGN_JOB never reaches the disk.
  const original = store.recordMasterSeq.bind(store);
  let stalled = false;
  store.recordMasterSeq = (seq) => {
    if (!stalled && store.leases.length > 0) {
      stalled = true;
      emit('seq-stalled', { seq });
      return new Promise(() => undefined);
    }
    return original(seq);
  };
}
const keystore = new FileKeystore(ops, cfg.dataDir);
const { key } = await loadOrCreateDeviceKey(keystore);
const ws = new WsTransport({
  masterUrl: cfg.url,
  logger,
  workerVersion: '0.1.0-chaos',
  facts: () => FACTS,
  timing: { backoffBaseMs: 20, backoffMaxMs: 200 },
});
const transport = {
  start: (o, h) => ws.start(o, h),
  stop: () => ws.stop(),
  reconnect: (r) => ws.reconnect(r),
  send: (message) => {
    if (cfg.mode === 'drop-result' && message.type === 'JOB_RESULT') {
      emit('result-dropped', { jobId: message.jobId });
      return new Promise(() => undefined); // never handed to the socket: the outbox keeps it
    }
    return ws.send(message);
  },
};
const wsRoot = join(cfg.dataDir, 'ws');
await mkdir(wsRoot, { recursive: true, mode: 0o700 });
const mgr = await WorkspaceManager.create({
  root: wsRoot,
  projects: { [cfg.project]: [cfg.fileUrl] },
  allowFileUrls: true,
  minFreeBytes: 0,
});
const map = (url) => (url === cfg.repoUrl ? cfg.fileUrl : url);
const workspace = {
  root: mgr.root,
  git: mgr.git,
  checkRepository: (projectId, url) => mgr.checkRepository(projectId, map(url)),
  prepare: (req) => mgr.prepare({ ...req, repository: { ...req.repository, url: map(req.repository.url) } }),
  release: (w, outcome) => mgr.release(w, outcome),
  commit: (w, req) => mgr.commit(w, req),
  push: (w, req) => mgr.push(w, req),
  // p10-approval-pause / p11-session-continuity: the kept worktree of a paused or restarted attempt.
  reopen: (req) => mgr.reopen({ ...req, repository: { ...req.repository, url: map(req.repository.url) } }),
};
const adapter = new EditingAdapter({ runtime: 'codex', script: basicScript });
const daemon = new WorkerDaemon({
  maxParallelJobs: 2,
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
      adapters: (rt) => (rt === 'codex' ? adapter : null),
      secretStore: new FileSecretStore(ops, cfg.dataDir),
      registry: new SecretRegistry(redactor.secrets),
      redactor,
      runtimeAuth: {},
      sandbox: null,
      allowUnconfined: true,
      timeouts: { cancelGraceMs: 200, cancelMs: 5_000, approvalMs: 60_000 },
      credentialTimeoutMs: 500,
    }),
});
process.once('SIGTERM', () => {
  void daemon.stop('SIGTERM').then(() => process.exit(0));
});
await daemon.start();
emit('ready');
