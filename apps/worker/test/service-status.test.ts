import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { LINUX_SERVICE } from '../src/service/definitions.js';
import { StatusFileWriter, readStatusFile, STATUS_FILE } from '../src/service/status-file.js';
import {
  collectServiceStatus,
  formatServiceStatus,
  readStoreSummary,
  STATUS_EXIT,
} from '../src/service/status.js';
import { WorkerStore } from '../src/store/store.js';
import { FakeSystem, fail, ok } from './fake-system.js';
import { nodeOps, patchOps, pathHost, tempDir } from './helpers.js';

const itPosix = process.platform === 'win32' ? it.skip : it;

const systemctl = (state: string, pid: number, extra = '') =>
  `LoadState=loaded\nActiveState=${state}\nSubState=running\nMainPID=${String(pid)}\nExecMainCode=0\nExecMainStatus=0\nNRestarts=1\nUnitFileState=enabled\nUser=remyral-worker\n${extra}`;

async function setup(opts: { status?: { pid: number; state?: 'offline' | 'stopped' } } = {}) {
  const dir = await tempDir();
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ masterUrl: 'wss://m.example.com/v1/worker', workspaceRoot: join(dir, 'w'), dataDir }),
    { mode: 0o600 },
  );
  if (opts.status !== undefined) {
    const w = new StatusFileWriter({ ops: nodeOps(), dataDir, pid: opts.status.pid });
    await w.write(opts.status.state ?? 'offline', 0, opts.status.state === 'stopped' ? 'SIGTERM' : null);
  }
  return { dir, dataDir, configPath };
}

const linuxHost = () => pathHost({ platform: 'linux', isPrivileged: true });
const linuxSys = (stdout: string) => new FakeSystem({ platform: 'linux', exec: () => ok(stdout) });

describe('service status', () => {
  // Simulates a Linux service (POSIX paths).
  itPosix('live: the service main pid wrote the status file', async () => {
    const { configPath, dataDir } = await setup({ status: { pid: 4242 } });
    const r = await collectServiceStatus(linuxSys(systemctl('active', 4242)), nodeOps(), linuxHost(), {
      configPath,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.service).toMatchObject({ state: 'running', pid: 4242, restarts: 1 });
    expect(r.worker).toMatchObject({ state: 'offline', freshness: 'live', pid: 4242 });
    expect(r.config).toMatchObject({
      path: configPath,
      dataDir,
      masterUrl: 'wss://m.example.com/v1/worker',
      error: null,
    });
    expect(r.store).toBeNull();
    const text = formatServiceStatus(r);
    expect(text).toContain('remyral-worker.service (systemd): running, pid 4242, starts at boot, restarts 1');
    expect(text).toContain('Worker:   offline, 0 running job(s)');
    expect(text).toContain('empty (never paired)');
  });

  // Simulates a Linux service (POSIX paths).
  itPosix('stale: a crashed daemon left its last state behind (new pid after restart)', async () => {
    const { configPath } = await setup({ status: { pid: 1111 } });
    const r = await collectServiceStatus(linuxSys(systemctl('active', 2222)), nodeOps(), linuxHost(), {
      configPath,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.worker.freshness).toBe('stale');
    expect(formatServiceStatus(r)).toContain('STALE: daemon pid 1111 is gone');
  });

  // Simulates a Linux service (POSIX paths).
  itPosix('stopped gracefully; exit code 3 for an installed but stopped service', async () => {
    const { configPath } = await setup({ status: { pid: 1111, state: 'stopped' } });
    const out: string[] = [];
    const code = await main(
      ['service', 'status', '--config', configPath],
      linuxSys(
        'LoadState=loaded\nActiveState=inactive\nMainPID=0\nUnitFileState=enabled\nExecMainCode=1\nExecMainStatus=0\n',
      ),
      { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
      { ops: nodeOps(), pathHost: linuxHost() },
    );
    expect(code).toBe(STATUS_EXIT.notRunning);
    expect(out.join('')).toContain('stopped gracefully');
  });

  // Simulates a Linux service (POSIX paths).
  itPosix('exit code 0 and JSON output for a running service', async () => {
    const { configPath } = await setup({ status: { pid: 7 } });
    const out: string[] = [];
    const code = await main(
      ['service', 'status', '--config', configPath, '--json'],
      linuxSys(systemctl('active', 7)),
      { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
      { ops: nodeOps(), pathHost: linuxHost() },
    );
    expect(code).toBe(STATUS_EXIT.running);
    expect(JSON.parse(out.join(''))).toMatchObject({
      service: { name: LINUX_SERVICE.name },
      worker: { freshness: 'live' },
    });
  });

  it('exit code 4 when the service is not installed or the manager cannot be asked', async () => {
    const { configPath } = await setup();
    const io = { stdout: () => undefined, stderr: () => undefined };
    const host = { ops: nodeOps(), pathHost: linuxHost() };
    expect(
      await main(['service', 'status', '--config', configPath], linuxSys('LoadState=not-found\n'), io, host),
    ).toBe(STATUS_EXIT.unknown);
    expect(
      await main(
        ['service', 'status', '--config', configPath],
        new FakeSystem({ platform: 'linux', exec: () => fail(1) }),
        io,
        host,
      ),
    ).toBe(STATUS_EXIT.unknown);
    expect(await main(['service', 'status', '--self-test'], linuxSys(''), io, host)).toBe(2);
  });

  // Simulates a Linux service (POSIX paths).
  itPosix('summarizes the durable store read-only (enrollment, leases, cursors, outbox)', async () => {
    const { configPath, dataDir } = await setup({ status: { pid: 9 } });
    const { store } = await WorkerStore.open(nodeOps(), dataDir);
    await store.setIdentity({
      workerId: 'w-7',
      publicKey: 'A'.repeat(43),
      enrolledAt: '2026-10-12T00:00:00.000Z',
    });
    await store.putLease({ jobId: 'j1', attemptId: 'a1', epoch: 3, expiresAt: '2026-10-12T00:10:00.000Z' });
    await store.recordMasterSeq(41);
    await store.outbox.append((seq) => ({ type: 'X', seq }));
    await store.flush();
    expect(await readStoreSummary(nodeOps(), dataDir)).toEqual({
      enrolled: true,
      workerId: 'w-7',
      enrolledAt: '2026-10-12T00:00:00.000Z',
      leases: 1,
      lastMasterSeq: 41,
      ackedOutboundSeq: 0,
      outboxEntries: 1,
    });
    const r = await collectServiceStatus(linuxSys(systemctl('active', 9)), nodeOps(), linuxHost(), {
      configPath,
    });
    if ('error' in r) throw new Error(r.error);
    expect(formatServiceStatus(r)).toContain('enrolled as w-7, 1 lease(s) held, outbox 1, master seq 41');
  });

  it('reports corrupt state without touching it', async () => {
    const { dataDir } = await setup();
    await writeFile(join(dataDir, 'state.json'), '{broken', { mode: 0o600 });
    expect(await readStoreSummary(nodeOps(), dataDir)).toEqual({
      error: expect.stringContaining('not valid JSON') as unknown,
    });
    expect(await nodeOps().readFile(join(dataDir, 'state.json'), 100)).toEqual(Buffer.from('{broken'));
  });

  // Simulates a Linux service (POSIX paths).
  itPosix('explains permission problems (non-root owner running status)', async () => {
    const { configPath, dataDir } = await setup({ status: { pid: 5 } });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const ops = patchOps({
      readFile: (path, max) =>
        path.startsWith(dataDir) ? Promise.reject(denied) : nodeOps().readFile(path, max),
    });
    const r = await collectServiceStatus(linuxSys(systemctl('active', 5)), ops, linuxHost(), {
      configPath,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.worker.error).toContain('permission denied (run as root/Administrator, or as the service user)');
    expect(r.store).toEqual({ error: expect.stringContaining('permission denied') as unknown });
  });

  // Simulates a Linux service (POSIX paths).
  itPosix('reports an invalid config but still asks the service manager', async () => {
    const { configPath } = await setup();
    await writeFile(configPath, JSON.stringify({ masterUrl: 'http://x', workspaceRoot: 'rel' }));
    const r = await collectServiceStatus(linuxSys(systemctl('active', 1)), nodeOps(), linuxHost(), {
      configPath,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.config.error).toMatch(/invalid config: masterUrl/);
    expect(r.service.state).toBe('running');
    expect(r.config.dataDir).toBe(LINUX_SERVICE.dataDir);
  });

  it('refuses platforms without a service integration', async () => {
    const r = await collectServiceStatus(
      new FakeSystem({ platform: 'freebsd' }),
      nodeOps(),
      pathHost({ platform: 'freebsd' }),
    );
    expect(r).toEqual({ error: 'no service integration for platform freebsd' });
  });
});

describe('status file', () => {
  it('is written 0600 and validated on read; garbage is reported, not trusted', async () => {
    const dir = await tempDir();
    const w = new StatusFileWriter({
      ops: nodeOps(),
      dataDir: dir,
      pid: 12,
      now: () => new Date('2026-10-13T00:00:00Z'),
    });
    await w.write('online', 1);
    expect(await readStatusFile(nodeOps(), dir)).toMatchObject({
      pid: 12,
      state: 'online',
      runningJobs: 1,
      stopReason: null,
    });
    if (process.platform !== 'win32') {
      expect(((await nodeOps().stat(join(dir, STATUS_FILE)))?.mode ?? 0) & 0o777).toBe(0o600);
    }
    await writeFile(join(dir, STATUS_FILE), JSON.stringify({ version: 1, pid: -1 }));
    expect(await readStatusFile(nodeOps(), dir)).toEqual({
      error: expect.stringContaining('not a valid status file') as unknown,
    });
    expect(await readStatusFile(nodeOps(), join(dir, 'missing'))).toBeNull();
  });

  it('a failing write is logged and never throws into the daemon', async () => {
    const warnings: string[] = [];
    const ops = patchOps({ writeNew: () => Promise.reject(new Error('ENOSPC')) });
    const w = new StatusFileWriter({
      ops,
      dataDir: await tempDir(),
      logger: { warn: (m) => warnings.push(m) },
    });
    await expect(w.write('online', 0)).resolves.toBeUndefined();
    expect(warnings).toEqual(['could not write the status file']);
  });
});
