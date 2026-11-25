import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnOwnedProcess } from '@remyral/agent-adapters';
import { createLogger } from '@remyral/observability';
import {
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  ServiceSpec,
  type ServiceSpecInput,
  type ServiceStatusPayload,
  signServiceControl,
  signServiceStart,
} from '@remyral/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TunnelSupervisor } from '../src/previews/supervisor.js';
import { ServiceManager, type ServiceManagerDeps } from '../src/services/manager.js';
import { ServiceLog } from '../src/services/log.js';
import { SecretString } from '../src/secrets/ref.js';
import { DEFAULT_LIMITS, type SandboxLaunchRequest, type SandboxRunner } from '../src/sandbox/types.js';
import type { Workspace } from '../src/workspace/manager.js';

/**
 * p15-services: the worker's service manager with real child processes (a node HTTP server started through
 * `sh -c`), a pass-through sandbox runner, a fake cloudflared (quick tunnel URL) and signed master messages:
 * start → healthy → tunnel URL, redacted logs, crash → restart policy → failed, TTL expiry, stop / restart, worker
 * restart (records reloaded, started again), refusals, and the job → service worktree hand-off.
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const logger = createLogger({ sink: () => undefined });
const WORKER = 'wrk_services_test';
const SECRET = 'canary-secret-value-12345';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const raw = String(publicKey.export({ format: 'jwk' }).x);
const KEY = { kid: leaseKeyId(raw), publicKey: raw };

const SERVER = `
const http = require('node:http');
const port = Number(process.env.PORT);
console.log('secret is ' + process.env.API_KEY);
if (process.env.CRASH === '1') { console.error('crashing'); setTimeout(() => process.exit(3), 100); }
else http.createServer((q, s) => { s.writeHead(q.url === '/health' ? 200 : 404); s.end('ok'); })
  .listen(port, '127.0.0.1', () => console.log('ready on ' + port));
process.on('SIGTERM', () => process.exit(0));
`;

const FAKE_CF = `#!/usr/bin/env node
console.error('INF Requesting new quick Tunnel on trycloudflare.com...');
setTimeout(() => {
  console.error('INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
  console.error('INF |  https://bright-fox-sample.trycloudflare.com                                             |');
  console.error('INF Registered tunnel connection connIndex=0');
}, 50);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

let dir = '';
let root = '';
let wsPath = '';
let statuses: ServiceStatusPayload[] = [];
let released: string[] = [];
let claims: string[] = [];
const managers: ServiceManager[] = [];

const passThrough: SandboxRunner = {
  profile: 'host-restricted',
  kind: 'test:passthrough',
  confiner: () => {
    throw new Error('unused');
  },
  launch: (req: SandboxLaunchRequest) =>
    spawnOwnedProcess({
      command: req.command,
      args: req.args,
      cwd: req.workspacePath,
      env: req.env,
      inheritEnv: [],
      ...(req.secretEnv === undefined ? {} : { secretEnv: req.secretEnv }),
      stdin: 'ignore',
    }),
};

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'rw-services-')));
  root = join(dir, 'root');
  wsPath = join(root, 'jobs', 'job_01', 'att_01');
  await mkdir(wsPath, { recursive: true });
  await writeFile(join(wsPath, 'server.js'), SERVER);
  await writeFile(join(dir, 'fake-cloudflared'), FAKE_CF);
  await chmod(join(dir, 'fake-cloudflared'), 0o755);
  statuses = [];
  released = [];
  claims = [];
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  await rm(dir, { recursive: true, force: true });
});

const ws = (): Workspace => ({
  projectId: 'shop',
  jobId: 'job_01',
  attemptId: 'att_01',
  epoch: 1,
  path: wsPath,
  branch: 'rac/job_01/att_01',
  repositoryUrl: 'https://example.com/shop.git',
  baseRef: 'main',
  baseCommit: 'a'.repeat(40),
  mirrorPath: join(root, 'mirrors', 'x.git'),
});

function manager(over: Partial<ServiceManagerDeps> = {}): ServiceManager {
  let m: ServiceManager | null = null;
  const tunnels = new TunnelSupervisor({
    dataDir: join(dir, 'data'),
    subdir: 'services/tunnels',
    cloudflared: () => Promise.resolve(join(dir, 'fake-cloudflared')),
    logger,
    onState: (id, state, detail) => m?.onConnectorState(id, state, detail),
    onUrl: (id, url) => {
      m?.onConnectorUrl(id, url);
    },
    stopGraceMs: 500,
  });
  m = new ServiceManager({
    dataDir: join(dir, 'data'),
    workspace: {
      root,
      prepare: () => Promise.reject(new Error('no checkouts in this test')),
      release: (w) => {
        released.push(w.path);
        return Promise.resolve();
      },
    },
    runner: () => passThrough,
    limits: DEFAULT_LIMITS,
    egressAllow: [],
    allowedProfiles: () => ['host-restricted'],
    secretStore: {
      kind: 'file',
      location: 'test',
      accessControlVerified: true,
      set: () => Promise.resolve(),
      get: (n: string) =>
        Promise.resolve(n === 'vault-abc' || n === 'gateway' ? new SecretString(SECRET) : null),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    } as unknown as ServiceManagerDeps['secretStore'],
    keys: () => [KEY],
    channel: {
      status: (p) => {
        statuses.push(p);
        return Promise.resolve();
      },
      logs: () => Promise.resolve(),
      workerId: () => WORKER,
    },
    tunnels,
    claimJobWorkspace: (jobId, attemptId, serviceId) => {
      claims.push(`claim:${serviceId}`);
      return jobId === 'job_01' && attemptId === 'att_01' ? ws() : null;
    },
    releaseJobClaim: (_j, _a, serviceId) => {
      claims.push(`unclaim:${serviceId}`);
    },
    logger,
    backoffMs: [100],
    stopGraceMs: 1000,
    sampler: () => Promise.resolve({ memoryBytes: 1024, cpuPercent: 1 }),
    ports: { listening: () => Promise.resolve(true), listeners: (_p, c) => Promise.resolve([...c]) },
    bootId: () => 'boot-1',
    ...over,
  });
  managers.push(m);
  return m;
}

const port = (): number => 41_000 + Math.floor(Math.random() * 2000);

function spec(over: Partial<ServiceSpecInput> = {}): ReturnType<typeof ServiceSpec.parse> {
  return ServiceSpec.parse({
    serviceId: randomUUID(),
    projectId: 'shop',
    name: 'web',
    source: { kind: 'job', jobId: 'job_01', attemptId: 'att_01' },
    cwd: null,
    command: `"${process.execPath}" server.js`,
    env: {},
    secretEnv: { API_KEY: 'secret:vault-abc' },
    port: port(),
    health: { kind: 'http', path: '/health', intervalSec: 2, startPeriodSec: 5 },
    restart: { policy: 'on-failure', maxRestarts: 2, windowSec: 600 },
    sandboxProfile: 'host-restricted',
    limits: {},
    expiresAt: null,
    tunnel: 'none',
    ...over,
  });
}

function startMsg(s: ReturnType<typeof spec>, revision = 1, signed = true): MasterToWorker {
  const issuedAt = new Date().toISOString();
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'SERVICE_START',
    messageId: randomUUID(),
    seq: 0,
    ts: issuedAt,
    correlationId: 'svc',
    workerId: WORKER,
    payload: {
      spec: s,
      revision,
      issuedAt,
      ...(signed
        ? {
            signature: signServiceStart(
              { workerId: WORKER, revision, issuedAt, spec: s },
              KEY.kid,
              privateKey,
            ),
          }
        : {}),
    },
  } as MasterToWorker;
}

function control(serviceId: string, op: 'stop' | 'restart' | 'remove'): MasterToWorker {
  const issuedAt = new Date().toISOString();
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'SERVICE_CONTROL',
    messageId: randomUUID(),
    seq: 0,
    ts: issuedAt,
    correlationId: 'svc',
    workerId: WORKER,
    payload: {
      serviceId,
      op,
      reason: `${op} by test`,
      issuedAt,
      signature: signServiceControl({ workerId: WORKER, serviceId, op, issuedAt }, KEY.kid, privateKey),
    },
  } as MasterToWorker;
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(statuses.slice(-4))}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const last = (id: string): ServiceStatusPayload | undefined =>
  statuses.filter((s) => s.serviceId === id).at(-1);

describePosix('ServiceManager', { timeout: 30_000 }, () => {
  it('starts a signed service: healthy, quick tunnel URL, redacted bounded logs, no job slot', async () => {
    const m = manager();
    await m.load();
    const s = spec({ tunnel: 'quick' });
    expect(await m.onMessage(startMsg(s))).toBe(true);
    await waitFor(() => last(s.serviceId)?.state === 'running' && last(s.serviceId)?.health === 'healthy');
    const withUrl = await waitFor(() => statuses.find((x) => x.tunnel?.url !== undefined));
    expect(withUrl.tunnel?.url).toBe('https://bright-fox-sample.trycloudflare.com');
    await waitFor(() => last(s.serviceId)?.tunnel?.state === 'running');
    expect(claims).toEqual([`claim:${s.serviceId}`]);
    expect(m.report().services).toEqual([
      expect.objectContaining({ serviceId: s.serviceId, state: 'running' }),
    ]);
    // Logs: the secret value never reaches the file.
    const log = new ServiceLog(join(dir, 'data', 'services', s.serviceId));
    const tail = await log.tail(100);
    const text = tail.lines.map((l) => l.text).join('\n');
    expect(text).toContain('ready on');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(SECRET);
    // A re-send of the same revision does not start a second process.
    const pid = last(s.serviceId)?.pid;
    await m.onMessage(startMsg(s));
    expect(last(s.serviceId)?.pid).toBe(pid);
  });

  it('a local secret in secretEnv only when the machine exposes it to the project (default deny)', async () => {
    const denied = manager();
    await denied.load();
    const s = spec({ secretEnv: { API_KEY: 'secret:gateway' }, health: { kind: 'none' } });
    await denied.onMessage(startMsg(s));
    const failed = await waitFor(() =>
      last(s.serviceId)?.state === 'failed' ? last(s.serviceId) : undefined,
    );
    expect(failed.detail).toContain('API_KEY');
    expect(failed.detail).toContain('does not expose');
    const allowed = manager({
      jobSecretExposure: () =>
        Promise.resolve({
          entries: { gateway: ['shop'] },
          problem: null,
          allows: (n, p) => n === 'gateway' && p === 'shop',
        }),
    });
    await allowed.load();
    const s2 = spec({ secretEnv: { API_KEY: 'secret:gateway' }, health: { kind: 'none' } });
    await allowed.onMessage(startMsg(s2));
    await waitFor(() => last(s2.serviceId)?.state === 'running');
  });

  it('crash → restart per policy → failed after the restart limit', async () => {
    const m = manager();
    await m.load();
    const s = spec({ env: { CRASH: '1' }, health: { kind: 'none' } });
    await m.onMessage(startMsg(s));
    await waitFor(() => statuses.some((x) => x.serviceId === s.serviceId && x.state === 'restarting'));
    const failed = await waitFor(() => (last(s.serviceId)?.state === 'failed' ? last(s.serviceId) : null));
    expect(failed.detail).toMatch(/gave up after 2 restarts/);
    expect(failed.restarts).toBe(2);
    expect(failed.exitCode).toBe(3);
  });

  it('the policy `never` ends on the first exit; TTL expiry stops it', async () => {
    const m = manager();
    await m.load();
    const a = spec({ env: { CRASH: '1' }, health: { kind: 'none' }, restart: { policy: 'never' } });
    await m.onMessage(startMsg(a));
    await waitFor(() => last(a.serviceId)?.state === 'failed');
    expect(statuses.some((x) => x.serviceId === a.serviceId && x.state === 'restarting')).toBe(false);
    const b = spec({
      name: 'ttl',
      health: { kind: 'none' },
      expiresAt: new Date(Date.now() + 1500).toISOString(),
    });
    await m.onMessage(startMsg(b));
    await waitFor(() => last(b.serviceId)?.state === 'running');
    const exp = await waitFor(() => (last(b.serviceId)?.state === 'expired' ? last(b.serviceId) : null));
    expect(exp.pid).toBeUndefined();
  });

  it('stop, restart and remove (signed); the worktree is released only after the job handed it over', async () => {
    const m = manager();
    await m.load();
    const s = spec({ health: { kind: 'tcp', intervalSec: 2, startPeriodSec: 5 } });
    await m.onMessage(startMsg(s));
    const first = await waitFor(() => (last(s.serviceId)?.state === 'running' ? last(s.serviceId) : null));
    await m.onMessage(control(s.serviceId, 'stop'));
    await waitFor(() => last(s.serviceId)?.state === 'stopped');
    await m.onMessage(control(s.serviceId, 'restart'));
    const again = await waitFor(() => (last(s.serviceId)?.state === 'running' ? last(s.serviceId) : null));
    expect(again.pid).not.toBe(first.pid);
    // An unsigned control is ignored.
    const bad = control(s.serviceId, 'stop') as Extract<MasterToWorker, { type: 'SERVICE_CONTROL' }>;
    await m.onMessage({ ...bad, payload: { ...bad.payload, op: 'remove' } });
    expect(last(s.serviceId)?.state).toBe('running');
    // The job still runs: remove drops the claim, never deletes the job's worktree.
    await m.onMessage(control(s.serviceId, 'remove'));
    await waitFor(() => claims.includes(`unclaim:${s.serviceId}`));
    expect(released).toEqual([]);
    // Handed over by the runner (job ended) and removed: the worktree is released.
    const t = spec({ name: 'api', health: { kind: 'none' } });
    await m.onMessage(startMsg(t));
    await waitFor(() => last(t.serviceId)?.state === 'running');
    expect(m.adoptJobCheckout('job_01', 'att_01')).toBe(true);
    expect(released).toEqual([]);
    await m.onMessage(control(t.serviceId, 'remove'));
    await waitFor(() => released.length === 1);
    expect(released).toEqual([wsPath]);
  });

  it('a restarted worker starts its services again (records reloaded, checkout kept)', async () => {
    const m = manager();
    await m.load();
    const s = spec({ health: { kind: 'none' } });
    await m.onMessage(startMsg(s));
    const before = await waitFor(() => (last(s.serviceId)?.state === 'running' ? last(s.serviceId) : null));
    expect(m.adoptJobCheckout('job_01', 'att_01')).toBe(true);
    await m.shutdown();
    managers.splice(managers.indexOf(m), 1);
    statuses = [];
    const killed: number[] = [];
    const m2 = manager({
      claimJobWorkspace: () => null, // the job is long gone
      killStale: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
    });
    await m2.load();
    const after = await waitFor(() => (last(s.serviceId)?.state === 'running' ? last(s.serviceId) : null));
    expect(after.pid).not.toBe(before.pid);
    // The clean shutdown left no pid to kill.
    expect(killed).toEqual([]);
  });

  it('refuses unsigned, stale-key, disallowed-profile and over-limit starts', async () => {
    const m = manager({ maxServices: 1, allowedProfiles: () => ['container'] });
    await m.load();
    const a = spec();
    await m.onMessage(startMsg(a, 1, false));
    expect(last(a.serviceId)).toMatchObject({
      state: 'refused',
      detail: expect.stringContaining('missing') as unknown,
    });
    await m.onMessage(startMsg(a));
    expect(last(a.serviceId)).toMatchObject({
      state: 'refused',
      detail: expect.stringContaining('profile') as unknown,
    });
    const m2 = manager({ maxServices: 1 });
    await m2.load();
    const b = spec({ health: { kind: 'none' } });
    await m2.onMessage(startMsg(b));
    await waitFor(() => last(b.serviceId)?.state === 'running');
    const c = spec({ name: 'two' });
    await m2.onMessage(startMsg(c));
    expect(last(c.serviceId)).toMatchObject({
      state: 'refused',
      detail: expect.stringContaining('at most 1') as unknown,
    });
    // A job that is not on this machine: no worktree to run from.
    const d = spec({ name: 'gone', source: { kind: 'job', jobId: 'job_99', attemptId: 'att_9' } });
    await m.onMessage(startMsg(d));
    expect(last(d.serviceId)?.state).toBe('refused');
  });

  it('p21-service-egress: the project network policy reaches the service sandbox; a new policy restarts it', async () => {
    const seen: SandboxLaunchRequest['network'][] = [];
    const recording: SandboxRunner = {
      ...passThrough,
      launch: (req) => {
        seen.push(req.network);
        return passThrough.launch(req);
      },
    };
    const m = manager({ runner: () => recording, egressAllow: ['api.anthropic.com'] });
    await m.load();
    const hosts = (n: SandboxLaunchRequest['network']): string[] =>
      n.mode === 'none' ? [] : n.targets.map((t) => t.host);
    const lastSeen = (): SandboxLaunchRequest['network'] => {
      const n = seen.at(-1);
      if (n === undefined) throw new Error('no sandbox launch recorded');
      return n;
    };
    // Without spec.network (an older master): model APIs only, and the refusal says why.
    const old = spec({ name: 'old', health: { kind: 'none' } });
    await m.onMessage(startMsg(old));
    await waitFor(() => last(old.serviceId)?.state === 'running');
    expect(seen.at(-1)).toMatchObject({ mode: 'allowlist' });
    expect(hosts(lastSeen())).toEqual(['api.anthropic.com']);
    expect(seen.at(-1)).toMatchObject({ refusalHint: expect.stringContaining('did not send') as unknown });
    // allowlist with the npm preset: the registry is reachable from the service.
    const npm = { mode: 'allowlist' as const, hosts: ['registry.npmjs.org', 'registry.yarnpkg.com'] };
    const s = spec({ name: 'web', health: { kind: 'none' }, network: npm });
    await m.onMessage(startMsg(s));
    await waitFor(() => last(s.serviceId)?.state === 'running');
    const first = lastSeen();
    expect(first.mode).toBe('allowlist');
    expect(hosts(first)).toEqual(['api.anthropic.com', 'registry.npmjs.org', 'registry.yarnpkg.com']);
    const pid = last(s.serviceId)?.pid;
    // The same policy at a higher revision (the master re-sends on a policy change): no restart.
    await m.onMessage(startMsg(s, 2));
    expect(last(s.serviceId)?.pid).toBe(pid);
    const launches = seen.length;
    // `web` mode at the next revision: restarted under the new rules.
    await m.onMessage(startMsg({ ...s, network: { mode: 'web', hosts: [] } }, 3));
    await waitFor(() => seen.length > launches && last(s.serviceId)?.state === 'running');
    expect(seen.at(-1)?.mode).toBe('web');
    expect(last(s.serviceId)?.pid).not.toBe(pid);
  });

  it('p22-worker-limits: a run that failed after a policy 403 is not restarted and names the host', async () => {
    let launches = 0;
    const refusing: SandboxRunner = {
      ...passThrough,
      launch: (req) => {
        launches++;
        // The egress proxy refuses the registry (the install fails), then the command exits 1.
        req.onEgressDecision?.({
          target: 'registry.npmjs.org:443',
          allowed: false,
          reason: 'not-allowlisted',
        });
        return passThrough.launch({ ...req, command: '/bin/sh', args: ['-c', 'exit 1'] });
      },
    };
    const m = manager({ runner: () => refusing });
    await m.load();
    const s = spec({ name: 'install', health: { kind: 'none' }, network: { mode: 'none', hosts: [] } });
    await m.onMessage(startMsg(s));
    const st = await waitFor(() => (last(s.serviceId)?.state === 'failed' ? last(s.serviceId) : null));
    expect(st.detail).toContain('registry.npmjs.org');
    expect(st.detail).not.toContain(':443');
    expect(st.detail).toContain('not restarted');
    expect(st.detail).toContain('Ağ erişimi');
    expect(st.detail?.length ?? 0).toBeLessThanOrEqual(300);
    expect(launches).toBe(1);
    expect(statuses.filter((x) => x.serviceId === s.serviceId).some((x) => x.state === 'restarting')).toBe(
      false,
    );
  });

  it('p22-worker-limits: an allowed request or a floor refusal keeps the restart policy', async () => {
    let launches = 0;
    const allowing: SandboxRunner = {
      ...passThrough,
      launch: (req) => {
        launches++;
        req.onEgressDecision?.({ target: 'registry.npmjs.org:443', allowed: true, reason: 'allowlisted' });
        // A private address is the floor, not the project's policy: not a reason to stop retrying.
        req.onEgressDecision?.({ target: '10.0.0.1:443', allowed: false, reason: 'forbidden-address' });
        return passThrough.launch({ ...req, command: '/bin/sh', args: ['-c', 'exit 1'] });
      },
    };
    const m = manager({ runner: () => allowing });
    await m.load();
    const s = spec({ name: 'crash', health: { kind: 'none' } });
    await m.onMessage(startMsg(s));
    const st = await waitFor(() => (last(s.serviceId)?.state === 'failed' ? last(s.serviceId) : null));
    expect(st.detail).toContain('gave up after');
    expect(launches).toBe(3);
  });
});
