import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Redactor } from '@remyral/observability';
import { WorkerDoctorReport } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_DOCTOR_ERRORS, EXIT_OK, main } from '../src/cli.js';
import { masterOrigin, runWorkerDoctor, type WorkerDoctorDeps } from '../src/doctor/doctor.js';
import { readDoctorConfig } from '../src/doctor/host.js';
import { createNodeFileOps } from '../src/fs/ops.js';
import { runProbe } from '../src/probe/probe.js';
import { FakeSystem, ok } from './fake-system.js';

const itPosix = process.platform === 'win32' ? it.skip : it;

/**
 * p16-doctor (docs/design/p16-doctor.md §3): `remyral-worker doctor` with fixtures — a healthy machine, an offline
 * master, a name that does not resolve, a wrong clock, a world-writable data directory, an unreadable config; the
 * report is redacted and valid; the CLI prints it, exits 1 on errors and writes `--out` (json / zip) without
 * overwriting a file.
 */
const NOW = new Date('2026-10-23T12:00:00.000Z');
const GH = `ghp_${'W'.repeat(36)}`;
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const sys = () =>
  new FakeSystem({
    platform: 'linux',
    arch: 'x64',
    machine: 'x86_64',
    env: { PATH: '/usr/bin' },
    files: { '/usr/bin/git': '', '/usr/bin/codex': '' },
    exec: (file) => {
      if (file === '/usr/bin/git') return ok('git version 2.47.2');
      if (file === '/usr/bin/codex') return ok('codex-cli 0.162.1');
      return undefined;
    },
  });

function deps(over: Partial<WorkerDoctorDeps> = {}): WorkerDoctorDeps {
  const s = sys();
  return {
    mode: 'local',
    workerVersion: '1.0.75',
    host: { platform: 'linux', release: '6.8.0', arch: 'x64', node: 'v24.11.0' },
    now: () => NOW,
    config: () =>
      Promise.resolve({
        path: '/etc/remyral-worker/config.json',
        error: null,
        masterUrl: 'wss://remyral.example.com/workers',
        dataDir: '/var/lib/remyral-worker',
        workspaceRoot: '/srv/remyral/work',
        allowedRuntimes: ['codex'],
      }),
    lookup: () => Promise.resolve(['203.0.113.7']),
    connect: () => Promise.resolve({ validTo: new Date(NOW.getTime() + 60 * 86_400_000), error: null }),
    http: () => Promise.resolve({ status: 200, date: NOW.toUTCString(), error: null }),
    service: () =>
      Promise.resolve({
        manager: 'systemd',
        installed: true,
        state: 'running',
        freshness: 'live',
        error: null,
      }),
    directory: () => Promise.resolve('ok'),
    disk: () => Promise.resolve({ freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
    // A ready container profile (the fake host has no engine; one test below uses the raw probe).
    probe: async () => ({
      ...(await runProbe(s, { selfTest: false, runtime: null })),
      sandboxProfiles: [{ profile: 'container', available: true, ready: true, notes: [] }],
    }),
    npmVersion: () => Promise.resolve('11.6.2'),
    redactor: new Redactor(),
    timeoutMs: 2_000,
    ...over,
  };
}

const codes = (r: WorkerDoctorReport) => r.findings.map((f) => `${f.check}:${f.code}:${f.severity}`);

describe('worker doctor (p16-doctor)', () => {
  it('a healthy machine: every check passes; the report is valid and names only the master origin', async () => {
    const r = WorkerDoctorReport.parse(await runWorkerDoctor(deps()));
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(r.master).toBe('https://remyral.example.com');
    for (const c of [
      'config:ok:ok',
      'master.dns:ok:ok',
      'master.connect:ok:ok',
      'master.http:ok:ok',
      'clock:ok:ok',
      'service:ok:ok',
      'directories:ok:ok',
      'disk:ok:ok',
      'node:ok:ok',
      'node.npm:ok:ok',
      'git:ok:ok',
    ])
      expect(codes(r)).toContain(c);
  });

  it('an offline master: unreachable is an error, the clock is not checked, the rest still runs', async () => {
    const r = await runWorkerDoctor(
      deps({ connect: () => Promise.resolve({ validTo: null, error: 'ECONNREFUSED' }) }),
    );
    expect(codes(r)).toContain('master.connect:unreachable:error');
    expect(codes(r)).toContain('clock:not_checked:info');
    expect(codes(r)).not.toContain('master.http:ok:ok');
    expect(codes(r)).toContain('git:ok:ok');
    expect(r.findings[0]?.severity).toBe('error');
    // A certificate the machine does not trust is told apart.
    const tls = await runWorkerDoctor(
      deps({ connect: () => Promise.resolve({ validTo: null, error: 'CERT_HAS_EXPIRED' }) }),
    );
    expect(codes(tls)).toContain('master.connect:tls_failed:error');
    // A hanging connect times out instead of blocking the report.
    const hang = await runWorkerDoctor(deps({ connect: () => new Promise(() => undefined), timeoutMs: 50 }));
    expect(codes(hang)).toContain('master.connect:unreachable:error');
  });

  it('bad DNS: the name does not resolve; nothing is connected', async () => {
    let connected = false;
    const r = await runWorkerDoctor(
      deps({
        lookup: () =>
          Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
        connect: () => {
          connected = true;
          return Promise.resolve({ validTo: null, error: null });
        },
      }),
    );
    expect(codes(r)).toContain('master.dns:dns_failed:error');
    expect(r.findings.find((f) => f.code === 'dns_failed')?.params).toMatchObject({
      host: 'remyral.example.com',
      code: 'ENOTFOUND',
    });
    expect(connected).toBe(false);
  });

  it('a wrong clock: 5 minutes ahead of the master is an error, 70 s a warning, 1 s fine', async () => {
    const at = (ms: number) =>
      deps({
        http: () =>
          Promise.resolve({ status: 200, date: new Date(NOW.getTime() - ms).toUTCString(), error: null }),
      });
    const five = await runWorkerDoctor(at(5 * 60_000));
    expect(codes(five)).toContain('clock:skew:error');
    expect(five.findings.find((f) => f.check === 'clock')?.params).toEqual({ seconds: 300 });
    expect(codes(await runWorkerDoctor(at(70_000)))).toContain('clock:skew:warning');
    expect(codes(await runWorkerDoctor(at(1_000)))).toContain('clock:ok:ok');
    const down = await runWorkerDoctor(
      deps({ http: () => Promise.resolve({ status: 503, date: NOW.toUTCString(), error: null }) }),
    );
    expect(codes(down)).toContain('master.http:master_unavailable:error');
  });

  it('local problems: invalid config, world-writable data dir, low disk, stopped service, old Node, expiring certificate', async () => {
    const r = await runWorkerDoctor(
      deps({
        config: () =>
          Promise.resolve({
            path: '/etc/remyral-worker/config.json',
            error: `invalid: token ${GH}`,
            masterUrl: null,
            dataDir: '/var/lib/remyral-worker',
            workspaceRoot: null,
            allowedRuntimes: [],
          }),
        directory: () => Promise.resolve('world_writable'),
        disk: () => Promise.resolve({ freeBytes: 100 * 1024 * 1024, totalBytes: 100 * 1024 ** 3 }),
        service: () =>
          Promise.resolve({
            manager: 'systemd',
            installed: true,
            state: 'failed',
            freshness: 'stale',
            error: null,
          }),
        host: { platform: 'linux', release: '6.8.0', arch: 'x64', node: 'v22.1.0' },
      }),
    );
    for (const c of [
      'config:invalid:error',
      'directories:world_writable:error',
      'disk:low:error',
      'service:not_running:error',
      'node:too_old:error',
    ])
      expect(codes(r)).toContain(c);
    expect(JSON.stringify(r)).not.toContain(GH);
    const cert = await runWorkerDoctor(
      deps({
        connect: () => Promise.resolve({ validTo: new Date(NOW.getTime() + 2 * 86_400_000), error: null }),
      }),
    );
    expect(codes(cert)).toContain('master.connect:cert_expiring:error');
    // Sandbox prerequisites: the fake host has no container engine and no bubblewrap.
    const bare = await runWorkerDoctor(
      deps({ probe: () => runProbe(sys(), { selfTest: false, runtime: null }) }),
    );
    expect(codes(bare)).toContain('sandbox:none_ready:error');
  });

  it('p17-disk-selfclean: with a low disk the last own cleanup is shown; with enough disk it is not', async () => {
    const run = {
      trigger: 'low_disk' as const,
      startedAt: '2026-10-25T09:59:00.000Z',
      finishedAt: '2026-10-25T10:00:00.000Z',
      freeBefore: 1,
      freeAfter: 2,
      freedBytes: 300 * 1024 * 1024,
      freed: [{ category: 'logs' as const, bytes: 300 * 1024 * 1024, items: 2 }],
      stillLow: true,
      errors: 0,
    };
    const asked: string[] = [];
    const low = await runWorkerDoctor(
      deps({
        disk: () => Promise.resolve({ freeBytes: 100 * 1024 * 1024, totalBytes: 100 * 1024 ** 3 }),
        diskHygiene: (dataDir) => {
          asked.push(dataDir);
          return Promise.resolve(run);
        },
      }),
    );
    const f = low.findings.find((x) => x.code === 'last_cleanup');
    expect(f).toMatchObject({ check: 'disk', severity: 'info', params: { freedMiB: 300, stillLow: true } });
    expect(asked.length).toBe(1);
    const fine = await runWorkerDoctor(deps({ diskHygiene: () => Promise.resolve(run) }));
    expect(codes(fine)).not.toContain('disk:last_cleanup:info');
  });

  it('the master URL: ws:// loopback is plain, a non-URL refused', () => {
    expect(masterOrigin('ws://127.0.0.1:3000/ws')).toEqual({
      origin: 'http://127.0.0.1:3000',
      host: '127.0.0.1',
      port: 3000,
      tls: false,
    });
    expect(masterOrigin('wss://[::1]/ws')).toMatchObject({ host: '::1', port: 443, tls: true });
    expect(masterOrigin('ftp://x')).toBeNull();
    expect(masterOrigin(null)).toBeNull();
  });

  // Simulates a Linux host (POSIX config locations).
  itPosix('reads the config without creating or changing anything', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rw-doctor-'));
    dirs.push(d);
    const ops = createNodeFileOps();
    const host = {
      platform: 'linux' as const,
      env: () => undefined,
      homedir: () => d,
      isPrivileged: false,
    };
    const missing = await readDoctorConfig(ops, host, join(d, 'nope.json'));
    expect(missing.error).toContain('does not exist');
    const data = join(d, 'data');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        join(d, 'c.json'),
        JSON.stringify({
          masterUrl: 'wss://m.example.com/ws',
          workspaceRoot: join(d, 'ws'),
          dataDir: data,
        }),
      ),
    );
    const c = await readDoctorConfig(ops, host, join(d, 'c.json'));
    expect(c).toMatchObject({ error: null, masterUrl: 'wss://m.example.com/ws', dataDir: data });
    await expect(stat(data)).rejects.toThrow();
  });

  it('the CLI: a readable report, --json, exit 1 on errors, --out json / zip, never overwriting', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
    expect(await main(['doctor'], sys(), io, { doctor: deps() })).toBe(EXIT_OK);
    expect(out.join('')).toContain('remyral-worker doctor');
    expect(out.join('')).toContain('0 error(s)');
    out.length = 0;
    const bad = deps({ lookup: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) });
    expect(await main(['doctor', '--json'], sys(), io, { doctor: bad })).toBe(EXIT_DOCTOR_ERRORS);
    expect(WorkerDoctorReport.parse(JSON.parse(out.join(''))).summary.error).toBeGreaterThan(0);
    const d = await mkdtemp(join(tmpdir(), 'rw-doctor-out-'));
    dirs.push(d);
    const zipPath = join(d, 'doctor.zip');
    expect(await main(['doctor', '--out', zipPath], sys(), io, { doctor: deps() })).toBe(EXIT_OK);
    const zip = await readFile(zipPath);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    const name = zip.subarray(30, 30 + nameLen).toString('utf8');
    expect(name).toBe('doctor.json');
    const size = zip.readUInt32LE(18);
    const body = zip.subarray(30 + nameLen, 30 + nameLen + size);
    const json = (zip.readUInt16LE(8) === 8 ? inflateRawSync(body) : body).toString('utf8');
    expect(WorkerDoctorReport.parse(JSON.parse(json)).mode).toBe('local');
    if (process.platform !== 'win32') expect((await stat(zipPath)).mode & 0o077).toBe(0);
    // An existing file is never overwritten.
    expect(await main(['doctor', '--out', zipPath], sys(), io, { doctor: deps() })).toBe(2);
    const jsonPath = join(d, 'doctor.json');
    expect(await main(['doctor', '--out', jsonPath], sys(), io, { doctor: deps() })).toBe(EXIT_OK);
    expect(WorkerDoctorReport.parse(JSON.parse(await readFile(jsonPath, 'utf8'))).workerVersion).toBe(
      '1.0.75',
    );
    // Options of other commands are refused.
    expect(await main(['doctor', '--master', 'wss://x'], sys(), io)).toBe(2);
  });
});
