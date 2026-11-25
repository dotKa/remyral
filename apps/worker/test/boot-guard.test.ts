import { link, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Redactor } from '@remyral/observability';
import { MAX_UPDATE_DIAGNOSTICS_BYTES, UpdateDiagnostics } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  bootVerdict,
  collectUpdateDiagnostics,
  fitDiagnostics,
  readTailSafe,
  serviceOutputFiles,
} from '../src/boot/diagnostics.js';
import { BOOT_LOG, BootGuard, BootLog, bootLogDir } from '../src/boot/guard.js';
import type { PathHost } from '../src/config/paths.js';
import { isWindows, tempDir } from './helpers.js';

// p6-worker-boot-diagnostics: the boot guard (boot.log) and the update-failure evidence built from it.

const host = (platform: NodeJS.Platform, env: Record<string, string> = {}, privileged = true): PathHost => ({
  platform,
  env: (n) => env[n],
  homedir: () => (platform === 'win32' ? 'C:\\Users\\svc' : '/home/svc'),
  isPrivileged: privileged,
});

/** A token shape the default redaction rules recognise (GitHub PAT). */
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

describe('boot log location (before the config is loaded)', () => {
  it('Windows service: %ProgramData%\\RemyralWorker\\data\\logs when the config names no dataDir', () => {
    const files: Record<string, string> = {
      'D:\\PD\\RemyralWorker\\config.json': JSON.stringify({ masterUrl: 'wss://m.example/v1' }),
    };
    expect(bootLogDir(host('win32', { ProgramData: 'D:\\PD' }), ['run'], (p) => files[p] ?? null)).toBe(
      'D:\\PD\\RemyralWorker\\data\\logs',
    );
    // No config at all (a broken install) still gives the per-OS fallback.
    expect(bootLogDir(host('win32', {}), ['run'], () => null)).toBe(
      'C:\\ProgramData\\RemyralWorker\\data\\logs',
    );
  });

  it('uses the dataDir of the config it will load (--config, REMYRAL_WORKER_CONFIG), ignoring junk', () => {
    const files: Record<string, string> = {
      'E:\\cfg\\worker.json': JSON.stringify({ dataDir: 'E:\\rw\\data' }),
      '/etc/alt.json': JSON.stringify({ dataDir: '/srv/rw' }),
      '/etc/remyral-worker/config.json': '{not json',
    };
    const read = (p: string) => files[p] ?? null;
    expect(bootLogDir(host('win32'), ['run', '--config', 'E:\\cfg\\worker.json'], read)).toBe(
      'E:\\rw\\data\\logs',
    );
    expect(bootLogDir(host('linux', { REMYRAL_WORKER_CONFIG: '/etc/alt.json' }), ['run'], read)).toBe(
      '/srv/rw/logs',
    );
    expect(bootLogDir(host('linux'), ['run', '--config=/etc/alt.json'], read)).toBe('/srv/rw/logs');
    // Unparseable config → the location's default data dir.
    expect(bootLogDir(host('linux'), ['run'], read)).toBe('/var/lib/remyral-worker/logs');
    // A relative dataDir is not trusted.
    files['/etc/remyral-worker/config.json'] = JSON.stringify({ dataDir: 'relative/dir' });
    expect(bootLogDir(host('linux'), ['run'], read)).toBe('/var/lib/remyral-worker/logs');
    expect(bootLogDir(host('darwin'), ['run'], () => null)).toBe(
      '/Library/Application Support/RemyralWorker/data/logs',
    );
  });
});

describe('boot guard records', () => {
  const records = async (dir: string) =>
    (await readFile(join(dir, BOOT_LOG), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('start → fatal (redacted, bounded) → exit with the stderr written before ready', async () => {
    const dir = join(await tempDir('rw-boot-'), 'logs');
    const g = new BootGuard({ log: new BootLog(dir), version: '1.0.23', argv: ['run'], platform: 'win32' });
    g.start();
    g.observeStderr(`remyral-worker: config invalid near ${TOKEN}\n`);
    const err = new Error(`cannot load module (token ${TOKEN})`);
    g.fatal(err, 'uncaughtException');
    g.exit(1);
    const r = await records(dir);
    expect(r.map((x) => x.event)).toEqual(['start', 'fatal', 'exit']);
    expect(r[0]).toMatchObject({
      version: '1.0.23',
      platform: 'win32',
      stage: 'module-load',
      command: 'run',
    });
    expect(r[1]).toMatchObject({ origin: 'uncaughtException', error: { name: 'Error' } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r[2]).toMatchObject({ code: 1 });
    expect(String(r[2]?.stderr)).toContain('config invalid');
    if (!isWindows) expect((await stat(join(dir, BOOT_LOG))).mode & 0o777).toBe(0o600);
  });

  it('ready moves to the loaded data dir, stops buffering stderr; exits 0 / 75 are not recorded', async () => {
    const root = await tempDir('rw-boot-');
    const g = new BootGuard({ log: new BootLog(join(root, 'peeked')), version: '1.0.23', argv: ['run'] });
    g.start();
    g.entered();
    expect(g.stage).toBe('startup');
    g.ready(join(root, 'real'));
    g.observeStderr('a JSON log line after ready\n');
    g.exit(0);
    g.exit(75);
    g.exit(2);
    expect((await records(join(root, 'peeked'))).map((x) => x.event)).toEqual(['start']);
    const real = await records(join(root, 'real', 'logs'));
    expect(real.map((x) => x.event)).toEqual(['ready', 'exit']);
    expect(real[1]).toMatchObject({ code: 2, stage: 'running' });
    expect(real[1]?.stderr).toBeUndefined();
  });

  it('is bounded: rotates into boot.log.1 and never throws when it cannot write', async () => {
    const dir = join(await tempDir('rw-boot-'), 'logs');
    const log = new BootLog(dir, 2048);
    const g = new BootGuard({ log, version: '1.0.23', argv: ['run'] });
    for (let i = 0; i < 40; i++) g.start();
    expect((await stat(join(dir, BOOT_LOG))).size).toBeLessThanOrEqual(2048);
    expect((await stat(join(dir, `${BOOT_LOG}.1`))).size).toBeLessThanOrEqual(2048);
    // A file where the directory should be: append fails quietly.
    const blocked = join(await tempDir('rw-boot-'), 'file');
    await writeFile(blocked, 'x');
    expect(new BootLog(join(blocked, 'logs')).append(JSON.parse('{}') as never)).toBe(false);
    expect(new BootLog('').append(JSON.parse('{}') as never)).toBe(false);
  });
});

const rec = (event: string, version: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts,
    event,
    version,
    pid: 1,
    platform: 'win32',
    arch: 'x64',
    node: '24.21.0',
    stage: 'x',
    ...extra,
  });

describe('boot verdict', () => {
  const since = new Date('2026-10-16T09:01:03.000Z');
  const at = '2026-10-16T09:01:04.000Z';
  const before = '2026-10-16T08:00:00.000Z';

  it.each([
    ['no file', null, 'no_boot_log'],
    ['empty / no records', 'garbage\n', 'no_boot_log'],
    [
      'only the old version ran',
      `${rec('start', '1.0.21', at)}\n${rec('ready', '1.0.21', at)}`,
      'never_started',
    ],
    ['the new version started long before (other attempt)', rec('start', '1.0.22', before), 'never_started'],
    [
      'crashed',
      `${rec('start', '1.0.22', at)}\n${rec('fatal', '1.0.22', at, { origin: 'uncaughtException' })}`,
      'crashed',
    ],
    [
      'config error',
      `${rec('start', '1.0.22', at)}\n${rec('fatal', '1.0.22', at, { origin: 'config' })}\n${rec('exit', '1.0.22', at, { code: 78 })}`,
      'exited',
    ],
    ['non-zero exit', `${rec('start', '1.0.22', at)}\n${rec('exit', '1.0.22', at, { code: 9 })}`, 'exited'],
    ['hung', rec('start', '1.0.22', at), 'hung_before_ready'],
    ['started, no heartbeat', `${rec('start', '1.0.22', at)}\n${rec('ready', '1.0.22', at)}`, 'started'],
  ])('%s', (_name, text, verdict) => {
    expect(bootVerdict(text, '1.0.22', since)).toBe(verdict);
  });
});

describe('update diagnostics', () => {
  const since = new Date('2026-10-16T09:01:03.000Z');
  const at = '2026-10-16T09:01:04.000Z';

  it('Windows: boot records of the failed version, its shawl-captured stderr, the shawl and updater logs — redacted', async () => {
    const files: Record<string, string> = {
      'C:\\ProgramData\\RemyralWorker\\data\\logs\\boot.log': [
        rec('start', '1.0.21', '2026-10-16T08:00:00.000Z'),
        rec('start', '1.0.22', at),
        rec('fatal', '1.0.22', at, { origin: 'uncaughtException', error: { message: `boom ${TOKEN}` } }),
      ].join('\n'),
      'C:\\ProgramData\\RemyralWorker\\logs\\remyral-worker_rCURRENT.log': [
        'file:///C:/Program%20Files/RemyralWorker/remyral-worker.mjs:123',
        `TypeError: x is not a function (${TOKEN})`,
        JSON.stringify({ msg: 'config loaded', version: '1.0.21' }),
      ].join('\r\n'),
      'C:\\ProgramData\\RemyralWorker\\logs\\shawl_rCURRENT.log':
        '2026-10-16 09:01:04 [INFO] Command exited with code 1\n',
      'C:\\Program Files\\RemyralWorker\\state\\updater.log': `${JSON.stringify({ msg: 'activated; restarting the worker service' })}\n`,
    };
    const d = await collectUpdateDiagnostics({
      collectedBy: 'updater',
      platform: 'win32',
      env: (n) => (n === 'ProgramData' ? 'C:\\ProgramData' : undefined),
      dataDir: 'C:\\ProgramData\\RemyralWorker\\data',
      updaterLog: 'C:\\Program Files\\RemyralWorker\\state\\updater.log',
      version: '1.0.22',
      since,
      read: (p) => Promise.resolve(files[p] ?? null),
      restartErrors: [
        `net.exe start RemyralWorker failed (2): The service is starting or stopping. ${TOKEN}`,
      ],
      redactor: new Redactor(),
    });
    expect(UpdateDiagnostics.safeParse(d).success).toBe(true);
    expect(d.verdict).toBe('crashed');
    expect(d.bootLog).toHaveLength(2); // only the failed version's records
    expect(d.serviceOutput).toEqual([
      'file:///C:/Program%20Files/RemyralWorker/remyral-worker.mjs:123',
      expect.stringContaining('TypeError: x is not a function'),
      '[shawl] 2026-10-16 09:01:04 [INFO] Command exited with code 1',
    ]); // the restored version's JSON log line is left out
    expect(d.updaterLog).toHaveLength(1);
    expect(d.restartErrors?.[0]).toContain('net.exe start');
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('never_started: shows what did run instead; macOS reads the launchd log; nothing readable → no_boot_log', async () => {
    const d = await collectUpdateDiagnostics({
      collectedBy: 'worker',
      platform: 'darwin',
      env: () => undefined,
      dataDir: '/Library/Application Support/RemyralWorker/data',
      updaterLog: null,
      version: '1.0.22',
      since,
      read: (p) =>
        Promise.resolve(
          p.endsWith(BOOT_LOG)
            ? rec('start', '1.0.21', at)
            : p === '/Library/Logs/RemyralWorker/remyral-worker.log'
              ? 'node: bad option\n'
              : null,
        ),
      redactor: new Redactor(),
    });
    expect(d).toMatchObject({ verdict: 'never_started', serviceOutput: ['node: bad option'] });
    expect(d.bootLog).toHaveLength(1);
    expect(serviceOutputFiles('linux', () => undefined)).toEqual({ output: null, wrapper: null });
    const none = await collectUpdateDiagnostics({
      collectedBy: 'worker',
      platform: 'linux',
      env: () => undefined,
      dataDir: '/var/lib/remyral-worker',
      updaterLog: '/opt/remyral-worker/state/updater.log',
      version: '1.0.22',
      since: null,
      read: () => Promise.resolve(null),
      redactor: new Redactor(),
    });
    expect(none).toEqual({ collectedBy: 'worker', verdict: 'no_boot_log', redacted: true });
  });

  it('stays within the protocol bound by dropping the oldest lines', () => {
    const long = 'x'.repeat(1900);
    const d = fitDiagnostics({
      collectedBy: 'updater',
      verdict: 'crashed',
      bootLog: Array.from({ length: 40 }, () => long),
      serviceOutput: Array.from({ length: 40 }, () => long),
      updaterLog: Array.from({ length: 40 }, () => long),
      redacted: true,
    });
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(MAX_UPDATE_DIAGNOSTICS_BYTES);
    expect(UpdateDiagnostics.safeParse(d).success).toBe(true);
    expect(d.updaterLog).toBeUndefined(); // dropped first
    expect(d.bootLog?.length).toBeGreaterThan(0);
  });
});

describe.skipIf(isWindows)('safe tail reader (privileged updater reading the data dir)', () => {
  it('reads the end of a file from a line boundary; refuses links and files of another owner', async () => {
    const dir = await tempDir('rw-tail-');
    const path = join(dir, 'boot.log');
    await writeFile(path, `${'a'.repeat(50)}\nline-2\nline-3\n`);
    expect(await readTailSafe(path, 20)).toBe('line-2\nline-3\n');
    expect(await readTailSafe(path, 1024)).toContain('line-2');
    const me = (await stat(path)).uid;
    expect(await readTailSafe(path, 1024, { ownerUid: me })).toContain('line-3');
    expect(await readTailSafe(path, 1024, { ownerUid: me + 1 })).toBeNull();
    const lnk = join(dir, 'link.log');
    await symlink(path, lnk);
    expect(await readTailSafe(lnk, 1024)).toBeNull();
    await mkdir(join(dir, 'd'));
    expect(await readTailSafe(join(dir, 'd'), 1024)).toBeNull();
    expect(await readTailSafe(join(dir, 'missing'), 1024)).toBeNull();
    // A hard link keeps the target's owner: with ownerUid it is only accepted when that owner matches.
    await link(path, join(dir, 'hard.log'));
    expect(await readTailSafe(join(dir, 'hard.log'), 1024, { ownerUid: me + 1 })).toBeNull();
  });
});
