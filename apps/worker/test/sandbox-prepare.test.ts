import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { type OpsCommandPayload, type OpsUpdatePayload, signOpsCommand } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { createSandboxRunners } from '../src/sandbox/factory.js';
import { SandboxSettings } from '../src/sandbox/config.js';
import { PREPARE_HELPER_MARKER, prepareRequestPath } from '../src/sandbox/prepare-shared.js';
import { SandboxPreparer } from '../src/sandbox/prepare.js';
import { buildSandboxStatus, privilegedHelperAvailable } from '../src/sandbox/status.js';
import { powershellExe } from '../src/sandbox/host/windows-jobrun.js';
import { WINDOWS_JOB_SLOTS_PS1 } from '../src/sandbox/host/windows-job-slots.generated.js';
import {
  JOB_SLOTS_FILE,
  masterOrigin,
  PrivilegedPreparer,
  SERVICE_RESTART_FILE,
  type Exec,
} from '../src/update/helper/prepare.js';
import { prepareResultPath } from '../src/sandbox/prepare-shared.js';
import { tempDir } from './helpers.js';

const logger = createLogger({ sink: () => undefined });

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return { privateKey, pinned: [{ kid: 'kid-1', publicKey: pub }] };
}

function command(
  workerId: string,
  privateKey: ReturnType<typeof keys>['privateKey'],
  op: OpsCommandPayload['op'] = { kind: 'sandbox.prepare', privileged: true, localLogin: true },
  at = new Date(),
): OpsCommandPayload {
  const cmd = {
    commandId: randomUUID(),
    issuedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 120_000).toISOString(),
    op,
  };
  return { ...cmd, signature: signOpsCommand({ workerId, ...cmd }, 'kid-1', privateKey) };
}

async function layout(platform: NodeJS.Platform = 'linux') {
  const root = await tempDir('prep-');
  const cfgDir = join(root, 'etc');
  const data = join(root, 'data');
  const install = join(root, 'install');
  const ws = join(root, 'ws');
  for (const d of [cfgDir, data, install, ws]) await mkdir(d, { recursive: true });
  const configPath = join(cfgDir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ masterUrl: 'wss://m.example.com/v1/worker', workspaceRoot: ws, dataDir: data }),
  );
  return { root, configPath, data, install, ws, platform };
}

/** Records commands; answers like a Debian host where podman is missing and installs succeed. */
function fakeExec(
  log: string[][],
  over: Record<string, { code: number; stdout?: string; stderr?: string }> = {},
): Exec {
  return (file, args) => {
    log.push([file, ...args]);
    const key = [file, ...args].join(' ');
    const hit = Object.entries(over).find(([k]) => key.startsWith(k))?.[1];
    if (hit !== undefined)
      return Promise.resolve({ code: hit.code, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' });
    if (key === '/usr/bin/env podman --version')
      return Promise.resolve({ code: 127, stdout: '', stderr: 'not found' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

describe('privileged prepare (helper, p5-sandbox-ops)', () => {
  it('runs the fixed Linux allowlist after verifying the master signature, never twice', async () => {
    const l = await layout('linux');
    const k = keys();
    const execLog: string[][] = [];
    const etc = join(l.root, 'etc-sys');
    await mkdir(etc, { recursive: true });
    await writeFile(join(etc, 'subuid'), 'pi:100000:65536\n');
    await writeFile(join(etc, 'subgid'), 'pi:100000:65536\n');
    const helper = new PrivilegedPreparer({
      platform: 'linux',
      configPath: l.configPath,
      dataDir: l.data,
      installDir: l.install,
      pinnedKeys: k.pinned,
      masterUrl: 'wss://m.example.com/v1/worker',
      logger,
      exec: fakeExec(execLog),
      osRelease: () => Promise.resolve('ID=debian\nVERSION_ID="13"\n'),
      etcDir: etc,
    });
    expect(await helper.processPending()).toBeNull();
    const cmd = command('wrk_1', k.privateKey);
    await mkdir(join(l.data, 'sandbox'), { recursive: true });
    await writeFile(
      prepareRequestPath('linux', l.data),
      JSON.stringify({ v: 1, workerId: 'wrk_1', command: cmd }),
    );
    const r = await helper.processPending();
    expect(r?.state).toBe('done');
    const byId = Object.fromEntries((r?.steps ?? []).map((s) => [s.id, s]));
    expect(byId.config_worker_user?.state).toBe('done');
    expect(byId.config_local_login?.state).toBe('done');
    expect(byId.container_engine_install?.state).toBe('done');
    expect(byId.container_subids?.state).toBe('done');
    expect(byId.container_subids?.detail).toContain('196608-262143');
    expect(byId.container_service).toMatchObject({
      state: 'needs_owner',
      code: 'unit_hardening_blocks_rootless',
    });
    expect(r?.restartRequired).toBe(true);
    // Only the compiled-in package list, never anything from the request.
    expect(execLog).toContainEqual([
      'apt-get',
      'install',
      '-y',
      '--no-install-recommends',
      'podman',
      'uidmap',
      'slirp4netns',
      'fuse-overlayfs',
    ]);
    expect(execLog).toContainEqual([
      'usermod',
      '--add-subuids',
      '196608-262143',
      '--add-subgids',
      '196608-262143',
      'remyral-worker',
    ]);
    const cfg = JSON.parse(await readFile(l.configPath, 'utf8')) as { sandbox: Record<string, unknown> };
    expect(cfg.sandbox).toMatchObject({
      workerUser: 'remyral-worker',
      keepHome: true,
      container: { engine: 'podman' },
    });
    // never twice
    expect(await helper.processPending()).toBeNull();
  });

  it('refuses forged, unsigned, expired and non-privileged requests; keys come from the master, not the worker', async () => {
    const l = await layout('linux');
    const k = keys();
    const other = keys();
    const fetched: string[] = [];
    const helper = new PrivilegedPreparer({
      platform: 'linux',
      configPath: l.configPath,
      dataDir: l.data,
      installDir: l.install,
      pinnedKeys: null,
      masterUrl: 'wss://m.example.com/v1/worker',
      logger,
      exec: fakeExec([]),
      fetchKeys: (origin) => {
        fetched.push(origin);
        return Promise.resolve(k.pinned);
      },
      osRelease: () => Promise.resolve(null),
    });
    await mkdir(join(l.data, 'sandbox'), { recursive: true });
    const write = (c: OpsCommandPayload, workerId = 'wrk_1') =>
      writeFile(prepareRequestPath('linux', l.data), JSON.stringify({ v: 1, workerId, command: c }));
    await write(command('wrk_1', other.privateKey));
    expect(await helper.processPending()).toMatchObject({ state: 'refused', reason: 'bad_signature' });
    expect(fetched).toEqual(['https://m.example.com']);
    // a signature for another worker does not transfer
    await write(command('wrk_2', k.privateKey), 'wrk_1');
    expect(await helper.processPending()).toMatchObject({ state: 'refused', reason: 'bad_signature' });
    const unsigned = command('wrk_1', k.privateKey);
    delete (unsigned as { signature?: unknown }).signature;
    await write(unsigned);
    expect(await helper.processPending()).toMatchObject({ state: 'refused', reason: 'unsigned' });
    await write(command('wrk_1', k.privateKey, undefined, new Date(Date.now() - 3_600_000)));
    expect(await helper.processPending()).toMatchObject({ state: 'refused', reason: 'expired' });
    await write(
      command('wrk_1', k.privateKey, { kind: 'sandbox.prepare', privileged: false, localLogin: false }),
    );
    expect(await helper.processPending()).toMatchObject({
      state: 'refused',
      reason: 'not_a_privileged_prepare',
    });
    // the config was never touched
    expect(JSON.parse(await readFile(l.configPath, 'utf8'))).not.toHaveProperty('sandbox');
    expect(masterOrigin('wss://m.example.com:8443/v1/worker')).toBe('https://m.example.com:8443');
  });

  it('bound to this machine: a request validly signed for another worker is refused (replay from another machine)', async () => {
    const l = await layout('linux');
    const k = keys();
    const helper = (bound: boolean) =>
      new PrivilegedPreparer({
        platform: 'linux',
        configPath: l.configPath,
        dataDir: l.data,
        installDir: l.install,
        pinnedKeys: k.pinned,
        masterUrl: 'wss://m.example.com/v1/worker',
        logger,
        exec: fakeExec([]),
        osRelease: () => Promise.resolve(null),
        binding: bound
          ? { state: 'bound', binding: { v: 1, workerId: 'wrk_1', boundAt: 'x', source: 'installer' } }
          : { state: 'unbound' },
      });
    await mkdir(join(l.data, 'sandbox'), { recursive: true });
    const write = (c: OpsCommandPayload, workerId: string) =>
      writeFile(prepareRequestPath('linux', l.data), JSON.stringify({ v: 1, workerId, command: c }));
    await write(command('wrk_2', k.privateKey), 'wrk_2');
    expect(await helper(true).processPending()).toMatchObject({ state: 'refused', reason: 'wrong_worker' });
    // Unbound machines keep the previous behaviour for these fixed-step requests.
    await write(command('wrk_2', k.privateKey), 'wrk_2');
    expect((await helper(false).processPending())?.state).not.toBe('refused');
    await write(command('wrk_1', k.privateKey), 'wrk_1');
    expect((await helper(true).processPending())?.state).not.toBe('refused');
  });

  it('Windows plan: worker user, local login, job runner install + self-test, installer ACLs, job slots', async () => {
    const l = await layout('win32');
    const k = keys();
    const execLog: string[][] = [];
    const env = { SystemRoot: 'C:\\Windows' };
    const helper = new PrivilegedPreparer({
      platform: 'win32',
      configPath: l.configPath,
      dataDir: l.data,
      installDir: l.install,
      pinnedKeys: k.pinned,
      masterUrl: 'wss://m.example.com/v1/worker',
      logger,
      env,
      exec: fakeExec(execLog, {
        [powershellExe(env)]: {
          code: 0,
          stdout:
            'remyral-job-slots {"ok":true,"generation":"0b5c8f8e-2d7a-4a50-9c7e-111111111111","count":4,"privilegesAdded":true}\r\n',
        },
      }),
      runFile: () => Promise.resolve({ code: 0, stdout: 'remyral-jobrun ok 2\r\n', stderr: '' }),
    });
    await mkdir(join(l.data, 'sandbox'), { recursive: true });
    await writeFile(
      prepareRequestPath('win32', l.data),
      JSON.stringify({ v: 1, workerId: 'w', command: command('w', k.privateKey) }),
    );
    // The config's own paths are Windows paths (the helper validates the edited file with the win32 schema).
    await writeFile(
      l.configPath,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: 'C:\\ProgramData\\RemyralWorker\\workspaces',
      }),
    );
    const r = await helper.processPending();
    expect(r?.steps.map((s) => [s.id, s.state])).toEqual([
      ['config_worker_user', 'done'],
      ['config_local_login', 'done'],
      ['job_runner_install', 'done'],
      ['workspace_acl', 'done'],
      ['job_slots_provision', 'done'],
    ]);
    // p9-windows-host-isolation: new privileges for the worker service need a restart.
    expect(r?.restartRequired).toBe(true);
    const cfg = JSON.parse(await readFile(l.configPath, 'utf8')) as { sandbox: Record<string, unknown> };
    expect(cfg.sandbox).toMatchObject({ workerUser: 'NT SERVICE\\RemyralWorker', keepHome: true });
    expect(execLog.slice(0, -1).every((c) => c[0] === 'icacls.exe')).toBe(true);
    expect(execLog[0]).toContain('*S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060:(RX)');
    // Fixed arguments only: count from the config default, the installer's service SID, the state dir.
    const slots = execLog.at(-1) ?? [];
    expect(slots[0]).toBe(powershellExe(env));
    expect(slots).toEqual(
      expect.arrayContaining([
        '-Count',
        '4',
        '-WorkerSid',
        'S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060',
      ]),
    );
    expect(slots[slots.indexOf('-StateDir') + 1]).toBe(join(dirname(l.configPath), 'job-slots'));
    expect(await readFile(join(l.install, JOB_SLOTS_FILE), 'utf8')).toBe(WINDOWS_JOB_SLOTS_PS1);
  });
});

describe('worker-side prepare', () => {
  it('reports every step, hands the signed command to the helper and relays its steps', async () => {
    const l = await layout(process.platform);
    const k = keys();
    await writeFile(join(l.install, 'remyral-worker-updater.mjs'), `// ${PREPARE_HELPER_MARKER}\n`);
    expect(await privilegedHelperAvailable(l.install)).toEqual({ available: true });
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: l.ws,
      dataDir: l.data,
      identity: {
        verified: true,
        username: 'w',
        uid: 1,
        problems: [],
        expectedUser: 'w',
        expectedUserSource: 'config',
      },
      namespaces: { usable: true, detail: 'ok' },
      jobRunner: { verified: true, script: 'x', source: 'data' },
    });
    const status = () =>
      buildSandboxStatus({
        runners,
        runnersError: null,
        enabledRuntimes: [],
        unconfined: 'not_enabled',
        workspaceRoot: l.ws,
        privilegedHelper: { available: true },
        freeBytes: 50 * 1024 ** 3,
      });
    const helper = new PrivilegedPreparer({
      platform: process.platform,
      configPath: l.configPath,
      dataDir: l.data,
      installDir: l.install,
      pinnedKeys: k.pinned,
      masterUrl: 'wss://m.example.com/v1/worker',
      logger,
      exec: fakeExec([], { '/usr/bin/env podman --version': { code: 0 } }),
      runFile: () => Promise.resolve({ code: 0, stdout: 'remyral-jobrun ok 1', stderr: '' }),
      osRelease: () => Promise.resolve('ID=debian'),
      etcDir: l.root,
    });
    let restarted = 0;
    const updates: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>[] = [];
    const prep = new SandboxPreparer({
      platform: process.platform,
      dataDir: l.data,
      installDir: l.install,
      runners: () => runners,
      status,
      changed: () => undefined,
      restart: () => {
        restarted++;
      },
      logger,
      pollMs: 20,
      helperTimeoutMs: 10_000,
    });
    const ctl = { stop: false };
    const loop = (async () => {
      while (!ctl.stop) {
        await helper.processPending();
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    await prep.run('wrk_1', command('wrk_1', k.privateKey), (u) => updates.push(u));
    ctl.stop = true;
    await loop;
    const last = updates.at(-1);
    expect(last?.state).toBe(
      updates.some((u) => u.prepare?.steps.some((s) => s.state === 'failed')) ? 'failed' : 'succeeded',
    );
    const ids = last?.prepare?.steps.map((s) => s.id) ?? [];
    expect(ids[0]).toBe('worker_user');
    expect(ids).toContain('helper_request');
    expect(ids).toContain('config_worker_user');
    expect(ids.at(-1)).toBe('recheck');
    expect(last?.prepare?.steps.find((s) => s.id === 'helper_request')?.state).toBe('done');
    expect(last?.prepare?.status?.profiles.map((p) => p.profile)).toEqual([
      'container',
      'runtime-sandbox',
      'host-restricted',
      'unconfined',
    ]);
    expect(restarted).toBe(1);
  });

  it('without a prepare-capable helper the privileged part needs the owner (one installer re-run)', async () => {
    const l = await layout(process.platform);
    await writeFile(join(l.install, 'remyral-worker-updater.mjs'), '// an older updater\n');
    const helper = await privilegedHelperAvailable(l.install);
    expect(helper.available).toBe(false);
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: l.ws,
      dataDir: l.data,
      identity: {
        verified: false,
        username: 'root',
        uid: 0,
        problems: ['running as root'],
        code: 'running_as_root',
        expectedUserSource: 'none',
      },
      namespaces: { usable: false, detail: 'refused' },
      jobRunner: { verified: false, code: 'job_runner_missing' },
    });
    const updates: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>[] = [];
    const prep = new SandboxPreparer({
      platform: process.platform,
      dataDir: l.data,
      installDir: l.install,
      runners: () => runners,
      status: () =>
        buildSandboxStatus({
          runners,
          runnersError: null,
          enabledRuntimes: [],
          unconfined: 'not_enabled',
          workspaceRoot: l.ws,
          privilegedHelper: helper,
          freeBytes: 50 * 1024 ** 3,
        }),
      changed: () => undefined,
      restart: () => undefined,
      logger,
    });
    const k = keys();
    await prep.run('wrk_1', command('wrk_1', k.privateKey), (u) => updates.push(u));
    const steps = updates.at(-1)?.prepare?.steps ?? [];
    expect(steps.find((s) => s.id === 'worker_user')).toMatchObject({
      state: 'needs_owner',
      code: 'running_as_root',
    });
    expect(steps.find((s) => s.id === 'helper_request')).toMatchObject({
      state: 'needs_owner',
      code: 'helper_unavailable',
    });
    const host = updates.at(-1)?.prepare?.status?.profiles.find((p) => p.profile === 'host-restricted');
    expect(host).toMatchObject({ ready: false, fix: 'owner' });
  });
});

// Live finding 2026-10-17 (Windows 1.0.29): new privileges reach the worker only with a new service logon, so the
// helper restarts the Windows service itself instead of the worker restarting node under the same service process.
describe('privileged prepare restarts the Windows service for new privileges (p9-windows-slots-service-restart)', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const slotsLine = (privilegesAdded: boolean) =>
    `remyral-job-slots {"ok":true,"generation":"0b5c8f8e-2d7a-4a50-9c7e-111111111111","count":4,"privilegesAdded":${String(privilegesAdded)}}\r\n`;

  async function windowsHelper(privilegesAdded: boolean, restartService?: () => Promise<void>) {
    const l = await layout('win32');
    const k = keys();
    await writeFile(
      l.configPath,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: 'C:\\ProgramData\\RemyralWorker\\workspaces',
        sandbox: { workerUser: 'NT SERVICE\\RemyralWorker' },
      }),
    );
    const sleeps: number[] = [];
    const helper = new PrivilegedPreparer({
      platform: 'win32',
      configPath: l.configPath,
      dataDir: l.data,
      installDir: l.install,
      pinnedKeys: k.pinned,
      masterUrl: 'wss://m.example.com/v1/worker',
      logger,
      env,
      exec: fakeExec([], { [powershellExe(env)]: { code: 0, stdout: slotsLine(privilegesAdded) } }),
      runFile: () => Promise.resolve({ code: 0, stdout: 'remyral-jobrun ok 2\r\n', stderr: '' }),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...(restartService === undefined ? {} : { restartService }),
    });
    const request = async () => {
      await mkdir(join(l.data, 'sandbox'), { recursive: true });
      await writeFile(
        prepareRequestPath('win32', l.data),
        JSON.stringify({
          v: 1,
          workerId: 'w',
          command: command('w', k.privateKey, {
            kind: 'sandbox.prepare',
            privileged: true,
            localLogin: false,
          }),
        }),
      );
    };
    return { l, helper, request, sleeps };
  }

  it('privilegesAdded: reports first, then a full service restart once; the worker is told not to restart itself', async () => {
    const seenAtRestart: unknown[] = [];
    let restarts = 0;
    const at = { install: '' };
    const t = await windowsHelper(true, async () => {
      restarts++;
      // the final result is already on disk when the service goes down
      seenAtRestart.push(JSON.parse(await readFile(prepareResultPath('win32', at.install), 'utf8')));
    });
    at.install = t.l.install;
    await t.request();
    const r = await t.helper.processPending();
    expect(r).toMatchObject({ state: 'done', restartRequired: true, serviceRestart: true });
    expect(r?.steps.find((s) => s.id === 'job_slots_provision')?.detail).toContain(
      'the helper restarts the RemyralWorker service',
    );
    expect(restarts).toBe(1);
    expect(seenAtRestart[0]).toMatchObject({ state: 'done', serviceRestart: true });
    expect(t.sleeps).toEqual([15_000]);
    const marker = JSON.parse(await readFile(join(t.l.install, 'state', SERVICE_RESTART_FILE), 'utf8')) as {
      commandId: string;
      state: string;
    };
    expect(marker).toMatchObject({ commandId: r?.commandId, state: 'done' });
    // idempotent: the same command and later runs without a request never restart again
    expect(await t.helper.processPending()).toBeNull();
    expect(await t.helper.processPending()).toBeNull();
    expect(restarts).toBe(1);
  });

  it('a restart that was due when the helper stopped is resumed once; a stale one is not; a failure is recorded', async () => {
    let restarts = 0;
    const t = await windowsHelper(true, () => {
      restarts++;
      return restarts === 1
        ? Promise.resolve()
        : Promise.reject(new Error('net.exe start RemyralWorker failed (2)'));
    });
    const markerPath = join(t.l.install, 'state', SERVICE_RESTART_FILE);
    await mkdir(dirname(markerPath), { recursive: true });
    const id = randomUUID();
    await writeFile(
      markerPath,
      JSON.stringify({ commandId: id, state: 'pending', requestedAt: new Date().toISOString() }),
    );
    expect(await t.helper.processPending()).toBeNull();
    expect(restarts).toBe(1);
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({ commandId: id, state: 'done' });
    expect(await t.helper.processPending()).toBeNull();
    expect(restarts).toBe(1);
    // stale
    await writeFile(
      markerPath,
      JSON.stringify({
        commandId: id,
        state: 'pending',
        requestedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
    expect(await t.helper.processPending()).toBeNull();
    expect(restarts).toBe(1);
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({ state: 'failed' });
    // a failing restart is recorded with the service-control message, never retried in a loop
    await writeFile(
      markerPath,
      JSON.stringify({ commandId: id, state: 'pending', requestedAt: new Date().toISOString() }),
    );
    expect(await t.helper.processPending()).toBeNull();
    expect(restarts).toBe(2);
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('net.exe start') as unknown,
    });
    expect(await t.helper.processPending()).toBeNull();
    expect(restarts).toBe(2);
  });

  it('no new privileges: no service restart; without a service control the old behaviour stays', async () => {
    let restarts = 0;
    const a = await windowsHelper(false, () => {
      restarts++;
      return Promise.resolve();
    });
    await a.request();
    const r = await a.helper.processPending();
    expect(r?.serviceRestart).toBeUndefined();
    expect(r?.restartRequired).toBe(false);
    expect(restarts).toBe(0);
    const b = await windowsHelper(true);
    await b.request();
    const r2 = await b.helper.processPending();
    expect(r2).toMatchObject({ state: 'done', restartRequired: true });
    expect(r2?.serviceRestart).toBeUndefined();
  });

  it('worker side: with serviceRestart from the helper the worker does not restart itself', async () => {
    const l = await layout(process.platform);
    const k = keys();
    await writeFile(join(l.install, 'remyral-worker-updater.mjs'), `// ${PREPARE_HELPER_MARKER}\n`);
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: l.ws,
      dataDir: l.data,
      identity: {
        verified: true,
        username: 'w',
        uid: 1,
        problems: [],
        expectedUser: 'w',
        expectedUserSource: 'config',
      },
      namespaces: { usable: true, detail: 'ok' },
      jobRunner: { verified: true, script: 'x', source: 'data' },
    });
    const cmd = command('wrk_1', k.privateKey);
    // A fake helper: answers the request with a final result that carries serviceRestart.
    const resPath = prepareResultPath(process.platform, l.install);
    await mkdir(dirname(resPath), { recursive: true });
    const ctl = { stop: false };
    const loop = (async () => {
      while (!ctl.stop) {
        const req = await readFile(prepareRequestPath(process.platform, l.data), 'utf8').catch(() => null);
        if (req !== null) {
          await writeFile(
            resPath,
            JSON.stringify({
              v: 1,
              commandId: cmd.commandId,
              state: 'done',
              steps: [{ id: 'job_slots_provision', state: 'done', privileged: true }],
              restartRequired: true,
              serviceRestart: true,
              updatedAt: new Date().toISOString(),
            }),
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    let restarted = 0;
    const updates: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>[] = [];
    const prep = new SandboxPreparer({
      platform: process.platform,
      dataDir: l.data,
      installDir: l.install,
      runners: () => runners,
      status: () =>
        buildSandboxStatus({
          runners,
          runnersError: null,
          enabledRuntimes: [],
          unconfined: 'not_enabled',
          workspaceRoot: l.ws,
          privilegedHelper: { available: true },
          freeBytes: 50 * 1024 ** 3,
        }),
      changed: () => undefined,
      restart: () => {
        restarted++;
      },
      logger,
      pollMs: 20,
      helperTimeoutMs: 10_000,
    });
    await prep.run('wrk_1', cmd, (u) => updates.push(u));
    ctl.stop = true;
    await loop;
    expect(restarted).toBe(0);
    expect(updates.at(-1)?.detail).toContain('the privileged helper restarts the RemyralWorker service');
  });
});
