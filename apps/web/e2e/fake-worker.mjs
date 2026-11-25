// E2E only (p5-mobile, A-UX-1): a real worker daemon with the in-memory fake runtime, in its own process,
// against the e2e master's /v1/worker gateway. It wires the same stack as the master's integration and chaos
// harnesses (apps/master/test/helpers/job-worker.ts, test/chaos/fixtures/worker-process.mjs): WorkerDaemon +
// JobRunner + the real WorkspaceManager on a throw-away local bare repository, from the built packages.
//
// Input: FAKE_WORKER (JSON) {masterUrl, dataDir, project, repoUrl}
// Output: JSON lines on stdout: {ev:'pairing', code, fingerprint} | {ev:'paired'} | {ev:'ready'} |
//         {ev:'spawn', jobId} | {ev:'error', message}
// The prompt selects the fake runtime's script:
//   contains "[approval]" -> streams a few events, then asks for an in-run approval (git.push, high risk)
//   contains "[hold]"     -> streams a few events, then works "forever" (until cancelled)
//   otherwise             -> a short turn
// The process never exits by itself; the test SIGTERMs it.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workerDist = new URL('../../worker/dist/index.js', import.meta.url);
const adaptersDist = new URL('../../../packages/agent-adapters/dist/index.js', import.meta.url);
const observabilityDist = new URL('../../../packages/observability/dist/index.js', import.meta.url);
const W = await import(workerDist.href);
const { FakeRuntimeAdapter } = await import(adaptersDist.href);
const { createLogger, Redactor } = await import(observabilityDist.href);

const cfg = JSON.parse(process.env.FAKE_WORKER ?? '{}');
const emit = (ev, data = {}) => process.stdout.write(`${JSON.stringify({ ev, ...data })}\n`);

const FACTS = {
  os: 'linux',
  osVersion: '6.8',
  arch: 'arm64',
  hostname: 'pocket-runner',
  cpuCount: 4,
  memoryBytes: 8 * 1024 ** 3,
  diskFreeBytes: 64 * 1024 ** 3,
};

const caps = {
  runtimes: [
    {
      runtime: 'codex',
      version: '0.162.1',
      installed: true,
      authenticated: 'yes',
      capabilities: {
        streaming: { status: 'supported' },
        approval: { status: 'supported' },
        cancel: { status: 'supported' },
      },
      pinnedVersion: '0.162.1',
      pinStatus: 'match',
    },
  ],
  // The composer's default profile. The fake runtime starts no process, so no real sandbox runs it
  // (allowUnconfined below, as in the master's integration harness).
  sandboxProfiles: ['container'],
  sandboxReadiness: [{ profile: 'container', ready: true, runtimes: ['codex'] }],
  maxParallelJobs: 4,
  projects: [cfg.project],
  tools: [{ name: 'git', version: '2.50' }],
};

const say = (text, delayMs = 400) => ({
  kind: 'emit',
  delayMs,
  event: { kind: 'message', role: 'assistant', text },
});
const tool = (callId, toolName, inputSummary, outputSummary) => [
  { kind: 'emit', delayMs: 300, event: { kind: 'tool_call', callId, toolName, inputSummary } },
  { kind: 'emit', delayMs: 500, event: { kind: 'tool_result', callId, ok: true, outputSummary } },
];

/** @type {(prompt: string) => unknown[]} */
const script = (prompt) => {
  const head = [
    say('Reading the repository layout.'),
    ...tool('call-1', 'read_file', 'README.md', '1 line'),
    say('Planning the change: update the README and run the checks.'),
  ];
  if (prompt.includes('[approval]')) {
    return [
      ...head,
      {
        kind: 'approval',
        approvalId: 'push-1',
        action: 'git.push',
        description: 'Push the work branch to origin',
        risk: 'high',
      },
      say('Push approved; finishing up.'),
    ];
  }
  if (prompt.includes('[hold]')) {
    return [
      ...head,
      ...tool('call-2', 'bash', 'pnpm test --watch', 'running…').slice(0, 1),
      { kind: 'sleep', ms: 600_000 },
    ];
  }
  return [...head, say('done')];
};

class Adapter extends FakeRuntimeAdapter {
  async spawn(ctx) {
    emit('spawn', { jobId: ctx.jobId });
    return super.spawn(ctx);
  }
}

async function bareRepo(root) {
  const bare = join(root, 'app.git');
  const work = join(root, 'seed');
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.test',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.test',
      },
      stdio: 'ignore',
    });
  await mkdir(work, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', bare);
  git(work, 'init', '--initial-branch=main');
  await writeFile(join(work, 'README.md'), '# app\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'initial');
  git(work, 'push', bare, 'main');
  return pathToFileURL(bare).toString();
}

try {
  const ops = W.createNodeFileOps();
  const out = [];
  const paired = W.pairWorker({
    ops,
    host: {
      platform: process.platform,
      env: () => undefined,
      homedir: () => cfg.dataDir,
      isPrivileged: false,
    },
    signals: new W.ManualSignals(),
    facts: () => Promise.resolve(FACTS),
    out: (t) => {
      out.push(t);
      const text = out.join('');
      const code = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(text)?.[1];
      const fingerprint = /Fingerprint: +(SHA256:[0-9A-F-]+)/.exec(text)?.[1];
      if (code !== undefined && fingerprint !== undefined && !out.reported) {
        out.reported = true;
        emit('pairing', { code, fingerprint });
      }
    },
    masterUrl: cfg.masterUrl,
    dataDir: cfg.dataDir,
    logSink: () => undefined,
  });
  const outcome = await paired;
  if (outcome !== 'approved') throw new Error(`pairing ended: ${String(outcome)}`);
  emit('paired');

  const fileUrl = await bareRepo(join(cfg.dataDir, 'repo'));
  const redactor = new Redactor();
  const logger = createLogger({ level: 'warn', redactor, sink: (line) => process.stderr.write(`${line}\n`) });
  const { store } = await W.WorkerStore.open(ops, cfg.dataDir);
  const keystore = new W.FileKeystore(ops, cfg.dataDir);
  const { key } = await W.loadOrCreateDeviceKey(keystore);
  const transport = new W.WsTransport({
    masterUrl: cfg.masterUrl,
    logger,
    workerVersion: '0.1.0-e2e',
    facts: () => FACTS,
    timing: { backoffBaseMs: 50, backoffMaxMs: 500 },
  });
  const wsRoot = join(cfg.dataDir, 'ws');
  await mkdir(wsRoot, { recursive: true, mode: 0o700 });
  const mgr = await W.WorkspaceManager.create({
    root: wsRoot,
    projects: { [cfg.project]: [fileUrl] },
    allowFileUrls: true,
    minFreeBytes: 0,
  });
  const map = (url) => (url === cfg.repoUrl ? fileUrl : url);
  const workspace = {
    root: mgr.root,
    git: mgr.git,
    checkRepository: (projectId, url) => mgr.checkRepository(projectId, map(url)),
    prepare: (req) =>
      mgr.prepare({ ...req, repository: { ...req.repository, url: map(req.repository.url) } }),
    release: (w, o) => mgr.release(w, o),
    commit: (w, req) => mgr.commit(w, req),
    push: (w, req) => mgr.push(w, req),
  };
  const adapter = new Adapter({ runtime: 'codex', version: '0.162.1', script });
  const daemon = new W.WorkerDaemon({
    maxParallelJobs: caps.maxParallelJobs,
    store,
    key,
    keystore,
    logger,
    transport,
    children: new W.ChildRegistry(),
    signals: new W.ManualSignals(),
    heartbeatIntervalMs: 1_000,
    load: () =>
      Promise.resolve({ cpuPercent: 7, memoryFreeBytes: 6 * 1024 ** 3, diskFreeBytes: 60 * 1024 ** 3 }),
    capabilities: () => Promise.resolve(caps),
    jobs: (d) =>
      new W.JobRunner({
        store,
        machine: d.machine,
        logger,
        channel: d,
        keyring: new W.LeaseKeyring(null),
        workspace,
        adapters: (rt) => (rt === 'codex' ? adapter : null),
        secretStore: new W.FileSecretStore(ops, cfg.dataDir),
        registry: new W.SecretRegistry(redactor.secrets),
        redactor,
        runtimeAuth: {},
        // The in-memory fake runtime starts no process (as in the master's integration harness).
        sandbox: null,
        allowUnconfined: true,
        timeouts: { cancelGraceMs: 200, cancelMs: 5_000, approvalMs: 600_000 },
        credentialTimeoutMs: 2_000,
      }),
  });
  process.once('SIGTERM', () => {
    void daemon.stop('SIGTERM').then(() => process.exit(0));
  });
  await daemon.start();
  emit('ready');
} catch (err) {
  emit('error', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
