// p17-worker-managed Parts 3 and 4 — removal from the panel and the machine-admin helper, worker and privileged helper:
// the signed command goes through the prepare trigger; the helper re-verifies it, refuses replays / bad signatures /
// vetoes, plans and starts the per-OS uninstall (Linux via systemd-run, macOS, Windows), installs / removes the
// admin trigger with the kit's own units; the worker relays accepted / refused / an outdated helper / a timeout.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@remyral/observability';
import { type OpsCommandPayload, type OpsUpdatePayload, signOpsCommand } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ManageRequester } from '../src/remote-ops/manage.js';
import { prepareRequestPath, prepareResultPath } from '../src/sandbox/prepare-shared.js';
import {
  LINUX_ADMIN_PATH_UNIT,
  LINUX_ADMIN_SERVICE_UNIT,
  MACOS_ADMIN_PLIST,
} from '../src/update/helper/admin-trigger.js';
import {
  linuxUninstallScript,
  macosUninstallScript,
  ManageHelper,
  psQuote,
  safeToRemove,
  shQuote,
  uninstallSteps,
  windowsAdminTaskScript,
  windowsUninstallScript,
} from '../src/update/helper/manage.js';
import { hasLegacyEntry, legacySid, removeLegacyAcl } from '../src/update/helper/legacy-acl.js';
import { type Exec, PrivilegedPreparer } from '../src/update/helper/prepare.js';
import { MANAGE_HELPER_MARKER, ManageResult, manageResultPath } from '../src/update/manage-shared.js';
import { tempDir } from './helpers.js';

const itPosix = process.platform === 'win32' ? it.skip : it;

const logger = createLogger({ sink: () => undefined });
const repo = fileURLToPath(new URL('../../../', import.meta.url));

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return { privateKey, pinned: [{ kid: 'kid-1', publicKey: pub }] };
}

function command(
  workerId: string,
  privateKey: ReturnType<typeof keys>['privateKey'],
  op: OpsCommandPayload['op'],
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

async function layout() {
  const root = await tempDir('manage-');
  const cfgDir = join(root, 'etc', 'remyral-worker');
  const data = join(root, 'var', 'lib', 'remyral-worker');
  const install = join(root, 'opt', 'remyral-worker');
  const systemd = join(root, 'systemd');
  for (const d of [cfgDir, data, install, systemd]) await mkdir(d, { recursive: true });
  const configPath = join(cfgDir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      masterUrl: 'wss://m.example.com/v1/worker',
      workspaceRoot: join(data, 'ws'),
      dataDir: data,
    }),
  );
  return { root, configPath, data, install, systemd };
}

function recorder(over: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) {
  const log: string[][] = [];
  const exec: Exec = (file, args) => {
    log.push([file, ...args]);
    const key = [file, ...args].join(' ');
    const hit = Object.entries(over).find(([k]) => key.startsWith(k))?.[1];
    return Promise.resolve({ code: hit?.code ?? 0, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' });
  };
  return { log, exec };
}

function helperFor(
  l: Awaited<ReturnType<typeof layout>>,
  k: ReturnType<typeof keys>,
  opts: { allowMachineAdmin?: boolean } = {},
) {
  const ex = recorder();
  const spawned: string[][] = [];
  const manage = new ManageHelper({
    platform: 'linux',
    configPath: l.configPath,
    dataDir: l.data,
    installDir: l.install,
    nodePath: '/usr/bin/node',
    allowMachineAdmin: opts.allowMachineAdmin ?? true,
    logger,
    exec: ex.exec,
    systemdDir: l.systemd,
    spawnDetached: (file, args) => {
      spawned.push([file, ...args]);
      return Promise.resolve();
    },
  });
  const helper = new PrivilegedPreparer({
    platform: 'linux',
    configPath: l.configPath,
    dataDir: l.data,
    installDir: l.install,
    pinnedKeys: k.pinned,
    masterUrl: 'wss://m.example.com/v1/worker',
    logger,
    exec: ex.exec,
    manage,
  });
  return { helper, spawned, execLog: ex.log };
}

async function hand(l: { data: string }, cmd: OpsCommandPayload, workerId = 'wrk_1'): Promise<void> {
  await mkdir(join(l.data, 'sandbox'), { recursive: true });
  await writeFile(prepareRequestPath('linux', l.data), JSON.stringify({ v: 1, workerId, command: cmd }));
}

async function result(install: string): Promise<ManageResult> {
  return ManageResult.parse(JSON.parse(await readFile(manageResultPath(install), 'utf8')));
}

describe('privileged helper: worker.uninstall', () => {
  // Simulates a Linux host (systemd-run, POSIX paths).
  itPosix(
    'verifies the signature, writes accepted with the plan, then starts the fixed script via systemd-run; never twice',
    async () => {
      const l = await layout();
      const k = keys();
      const { helper, spawned } = helperFor(l, k);
      const cmd = command('wrk_1', k.privateKey, { kind: 'worker.uninstall', purge: true });
      await hand(l, cmd);
      const r = await helper.processRequest();
      expect(r).toMatchObject({ state: 'accepted', commandId: cmd.commandId });
      const written = await result(l.install);
      expect(written.steps.map((s) => s.id)).toEqual([
        'service_stop',
        'triggers_remove',
        'service_remove',
        'program_remove',
        'data_purge',
        'user_remove',
      ]);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.slice(0, 5)).toEqual([
        'systemd-run',
        '--unit',
        `remyral-worker-uninstall-${cmd.commandId.slice(0, 8)}`,
        '--collect',
        '--quiet',
      ]);
      const script = await readFile(join(l.install, 'state', 'uninstall.sh'), 'utf8');
      expect(script).toContain('systemctl stop remyral-worker.service');
      expect(script).toContain(`rm -rf ${shQuote(l.install)} /usr/local/bin/remyral-worker`);
      expect(script).toContain('userdel remyral-worker');
      // Replay: the same command id is never run again.
      await hand(l, cmd);
      expect(await helper.processRequest()).toBeNull();
      expect(spawned).toHaveLength(1);
    },
  );

  it('refuses a forged or expired command into manage-result.json (and runs nothing)', async () => {
    const l = await layout();
    const k = keys();
    const other = keys();
    const { helper, spawned } = helperFor(l, k);
    const forged = command('wrk_1', other.privateKey, { kind: 'worker.uninstall', purge: false });
    await hand(l, forged);
    expect(await helper.processRequest()).toMatchObject({ state: 'refused', reason: 'bad_signature' });
    expect((await result(l.install)).commandId).toBe(forged.commandId);
    const old = command(
      'wrk_1',
      k.privateKey,
      { kind: 'worker.uninstall', purge: false },
      new Date(Date.now() - 3_600_000),
    );
    await hand(l, old);
    expect(await helper.processRequest()).toMatchObject({ state: 'refused', reason: 'expired' });
    // Bound to the worker id the master signed for.
    const elsewhere = command('wrk_2', k.privateKey, { kind: 'worker.uninstall', purge: false });
    await hand(l, elsewhere, 'wrk_1');
    expect(await helper.processRequest()).toMatchObject({ state: 'refused', reason: 'bad_signature' });
    expect(spawned).toEqual([]);
  });

  it('never deletes a directory that is not dedicated (/, a drive root, a top-level folder)', async () => {
    expect(safeToRemove('linux', '/')).toBe(false);
    expect(safeToRemove('linux', '/opt')).toBe(false);
    expect(safeToRemove('linux', '/opt/remyral-worker')).toBe(true);
    expect(safeToRemove('linux', 'relative/dir')).toBe(false);
    expect(safeToRemove('win32', 'C:\\')).toBe(false);
    expect(safeToRemove('win32', 'C:\\ProgramData')).toBe(false);
    expect(safeToRemove('win32', 'C:\\ProgramData\\RemyralWorker')).toBe(true);
    const spawned: string[][] = [];
    const m = new ManageHelper({
      platform: 'linux',
      configPath: '/config.json',
      dataDir: '/var/lib/remyral-worker',
      installDir: '/opt/remyral-worker',
      nodePath: '/usr/bin/node',
      allowMachineAdmin: true,
      logger,
      writeText: () => Promise.resolve(),
      spawnDetached: (f, a) => {
        spawned.push([f, ...a]);
        return Promise.resolve();
      },
    });
    expect(await m.uninstall(randomUUID(), true)).toMatchObject({
      state: 'refused',
      reason: 'unsafe_layout',
    });
    expect(spawned).toEqual([]);
  });
});

describe('uninstall scripts per OS (the kits’ uninstallers as one fixed script)', () => {
  it('Linux keeps data without purge and removes the triggers, the program and the CLI wrapper', () => {
    const s = linuxUninstallScript(
      {
        installDir: '/opt/remyral-worker',
        configDir: '/etc/remyral-worker',
        dataDir: '/var/lib/remyral-worker',
      },
      false,
    );
    expect(s).toContain('systemctl disable --now remyral-worker-admin.path');
    expect(s).toContain('systemctl disable --now remyral-worker-prepare.path');
    // The prepare service is the helper's own unit: never stopped from inside it.
    expect(s).not.toContain('disable --now remyral-worker-prepare.service');
    expect(s).toContain("'/etc/systemd/system/remyral-worker-prepare.service'");
    expect(s).not.toContain('/etc/remyral-worker');
    expect(s).not.toContain('userdel');
    expect(uninstallSteps('linux', false)).not.toContain('data_purge');
  });

  it('macOS removes the updater job last and quotes paths with spaces', () => {
    const base = '/Library/Application Support/RemyralWorker';
    const s = macosUninstallScript(
      { installDir: `${base}/bin`, configDir: base, dataDir: `${base}/data` },
      true,
    );
    expect(s).toContain(`rm -rf '${base}/bin' '${base}/node' '${base}/installer'`);
    expect(s).toContain('dscl . -delete /Users/_remyralworker');
    expect(s.trim().split('\n').at(-1)).toBe(
      'launchctl bootout system/com.remyral.worker.updater 2>/dev/null || true',
    );
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it('Windows deletes the tasks and the service, retries the program folder, keeps data without purge', () => {
    const l = {
      installDir: 'C:\\Program Files\\RemyralWorker',
      configDir: 'C:\\ProgramData\\RemyralWorker',
      dataDir: 'C:\\ProgramData\\RemyralWorker\\data',
    };
    const keep = windowsUninstallScript(l, false);
    expect(keep).toContain('schtasks.exe /Delete /TN RemyralWorkerAdmin /F');
    expect(keep).toContain('sc.exe delete RemyralWorker');
    expect(keep).toContain("'C:\\Program Files\\RemyralWorker'");
    expect(keep).not.toContain("'C:\\ProgramData\\RemyralWorker'");
    expect(windowsUninstallScript(l, true)).toContain("'C:\\ProgramData\\RemyralWorker'");
    // ASCII only (Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page).
    expect(Buffer.from(windowsUninstallScript(l, true), 'utf8').every((b) => b < 128)).toBe(true);
    expect(uninstallSteps('win32', true)).not.toContain('user_remove');
    expect(psQuote("O'Brien")).toBe("'O''Brien'");
  });
});

describe('privileged helper: helper.manage (machine-admin helper)', () => {
  it('installs the kit’s units with the Node path and enables the path unit; removes them again', async () => {
    const l = await layout();
    const k = keys();
    const { helper, execLog } = helperFor(l, k);
    const install = command('wrk_1', k.privateKey, { kind: 'helper.manage', action: 'admin_helper.install' });
    await hand(l, install);
    const r = await helper.processRequest();
    expect(r).toMatchObject({ state: 'done' });
    expect((r as ManageResult).steps).toEqual([
      { id: 'admin_helper_install', state: 'done', detail: 'remyral-worker-admin.path enabled' },
    ]);
    const unit = await readFile(join(l.systemd, 'remyral-worker-admin.service'), 'utf8');
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /opt/remyral-worker/remyral-worker-updater.mjs admin-session',
    );
    expect(await readFile(join(l.systemd, 'remyral-worker-admin.path'), 'utf8')).toBe(LINUX_ADMIN_PATH_UNIT);
    expect(execLog).toContainEqual(['systemctl', 'enable', '--now', 'remyral-worker-admin.path']);
    const remove = command('wrk_1', k.privateKey, { kind: 'helper.manage', action: 'admin_helper.remove' });
    await hand(l, remove);
    expect(await helper.processRequest()).toMatchObject({ state: 'done' });
    await expect(readFile(join(l.systemd, 'remyral-worker-admin.path'), 'utf8')).rejects.toThrow();
  });

  it('the local veto refuses an install', async () => {
    const l = await layout();
    const k = keys();
    const { helper } = helperFor(l, k, { allowMachineAdmin: false });
    const cmd = command('wrk_1', k.privateKey, { kind: 'helper.manage', action: 'admin_helper.install' });
    await hand(l, cmd);
    expect(await helper.processRequest()).toMatchObject({ state: 'refused', reason: 'disabled_locally' });
  });

  it('the Windows task matches the kit (SYSTEM, every minute, 780 min limit)', () => {
    const s = windowsAdminTaskScript(
      'C:\\Program Files\\RemyralWorker\\node\\node.exe',
      'C:\\Program Files\\RemyralWorker\\remyral-worker-updater.mjs',
      'C:\\ProgramData\\RemyralWorker\\config.json',
    );
    expect(s).toContain("-UserId 'S-1-5-18'");
    expect(s).toContain('-ExecutionTimeLimit (New-TimeSpan -Minutes 780)');
    expect(s).toContain('-RepetitionInterval (New-TimeSpan -Minutes 1)');
    expect(s).toContain("Register-ScheduledTask -TaskName 'RemyralWorkerAdmin'");
    expect(s).toContain('admin-session --config "C:\\ProgramData\\RemyralWorker\\config.json"');
  });

  it('the embedded units are byte-identical to the installer kit’s', async () => {
    expect(LINUX_ADMIN_PATH_UNIT).toBe(
      await readFile(join(repo, 'infra/worker/linux/remyral-worker-admin.path'), 'utf8'),
    );
    expect(LINUX_ADMIN_SERVICE_UNIT).toBe(
      await readFile(join(repo, 'infra/worker/linux/remyral-worker-admin.service'), 'utf8'),
    );
    expect(MACOS_ADMIN_PLIST).toBe(
      await readFile(join(repo, 'infra/worker/macos/com.remyral.worker.admin.plist'), 'utf8'),
    );
  });
});

describe('worker side: hands the command over and relays the helper', () => {
  async function requester(opts: { marker?: boolean; timeoutMs?: number } = {}) {
    const l = await layout();
    await writeFile(
      join(l.install, 'remyral-worker-updater.mjs'),
      opts.marker === false ? '// old helper\n' : `// ${MANAGE_HELPER_MARKER}\n`,
    );
    const r = new ManageRequester({
      platform: 'linux',
      dataDir: l.data,
      installDir: l.install,
      logger,
      pollMs: 5,
      helperTimeoutMs: opts.timeoutMs ?? 2_000,
    });
    return { l, r };
  }
  const collect = () => {
    const out: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>[] = [];
    return { out, emit: (u: (typeof out)[number]) => void out.push(u) };
  };

  it('an uninstall is succeeded as soon as the helper accepted it', async () => {
    const { l, r } = await requester();
    const k = keys();
    const cmd = command('wrk_1', k.privateKey, { kind: 'worker.uninstall', purge: false });
    const c = collect();
    const run = r.run('wrk_1', cmd, c.emit);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(prepareRequestPath('linux', l.data), 'utf8').catch(() => '{}'),
          ) as unknown,
      )
      .toMatchObject({ v: 1, workerId: 'wrk_1', command: { commandId: cmd.commandId } });
    await mkdir(join(l.install, 'state'), { recursive: true });
    await writeFile(
      manageResultPath(l.install),
      JSON.stringify({
        v: 1,
        commandId: cmd.commandId,
        state: 'accepted',
        detail: 'the worker is removed in about 15 s',
        steps: [{ id: 'service_stop', state: 'pending' }],
        updatedAt: new Date().toISOString(),
      }),
    );
    await run;
    expect(c.out.at(0)).toMatchObject({ state: 'running', progress: { step: 'helper_request' } });
    expect(c.out.at(-1)).toMatchObject({
      state: 'succeeded',
      manage: {
        steps: [
          { id: 'helper_request', state: 'done' },
          { id: 'service_stop', state: 'pending' },
        ],
      },
    });
  });

  it('an older helper (refused prepare result) is reported as helper_outdated; no helper → refused at once', async () => {
    const { l, r } = await requester();
    const k = keys();
    const cmd = command('wrk_1', k.privateKey, { kind: 'worker.uninstall', purge: false });
    const c = collect();
    const run = r.run('wrk_1', cmd, c.emit);
    await mkdir(join(l.install, 'state'), { recursive: true });
    await writeFile(
      prepareResultPath('linux', l.install),
      JSON.stringify({
        v: 1,
        commandId: cmd.commandId,
        state: 'refused',
        reason: 'not_a_privileged_prepare',
        steps: [],
        restartRequired: false,
        updatedAt: new Date().toISOString(),
      }),
    );
    await run;
    expect(c.out.at(-1)).toMatchObject({ state: 'refused', reason: 'helper_outdated' });

    const old = await requester({ marker: false });
    const c2 = collect();
    await old.r.run(
      'wrk_1',
      command('wrk_1', k.privateKey, { kind: 'worker.uninstall', purge: false }),
      c2.emit,
    );
    expect(c2.out).toEqual([expect.objectContaining({ state: 'refused', reason: 'helper_unavailable' })]);
  });

  it('no answer within the deadline is helper_timeout; a failed helper step fails the op', async () => {
    const { r } = await requester({ timeoutMs: 30 });
    const k = keys();
    const c = collect();
    await r.run(
      'wrk_1',
      command('wrk_1', k.privateKey, { kind: 'helper.manage', action: 'admin_helper.install' }),
      c.emit,
    );
    expect(c.out.at(-1)).toMatchObject({ state: 'failed', reason: 'helper_timeout' });

    const second = await requester();
    const cmd = command('wrk_1', k.privateKey, { kind: 'helper.manage', action: 'admin_helper.install' });
    const c2 = collect();
    const run = second.r.run('wrk_1', cmd, c2.emit);
    await mkdir(join(second.l.install, 'state'), { recursive: true });
    await writeFile(
      manageResultPath(second.l.install),
      JSON.stringify({
        v: 1,
        commandId: cmd.commandId,
        state: 'done',
        reason: 'command_failed',
        steps: [
          {
            id: 'admin_helper_install',
            state: 'failed',
            code: 'command_failed',
            detail: 'systemctl enable: no',
          },
        ],
        updatedAt: new Date().toISOString(),
      }),
    );
    await run;
    expect(c2.out.at(-1)).toMatchObject({
      state: 'failed',
      reason: 'command_failed',
      detail: 'systemctl enable: no',
    });
  });
});

describe('p17-worker-managed Part 5: the pre-rename service account’s ACL entry (Windows, privileged updater)', () => {
  const SID = legacySid();
  const show = (lines: string[]) => ({ code: 0, stdout: lines.join('\r\n'), stderr: '' });

  it('matches exactly NT SERVICE\\RemanaWorker (by name or SID), not a longer name', () => {
    expect(SID).toMatch(/^S-1-5-80(-\d+){5}$/);
    expect(hasLegacyEntry('C:\\ProgramData\\RemyralWorker NT SERVICE\\RemanaWorker:(OI)(CI)(M)')).toBe(true);
    expect(hasLegacyEntry(`C:\\data *${SID}:(OI)(CI)(M)`)).toBe(true);
    expect(hasLegacyEntry('C:\\data NT SERVICE\\RemanaWorker2:(OI)(CI)(M)')).toBe(false);
    expect(hasLegacyEntry('C:\\data NT SERVICE\\RemyralWorker:(OI)(CI)(M)')).toBe(false);
  });

  it('removes the allow entry where present, once per install (marker); a failure leaves no marker', async () => {
    const install = await tempDir('legacy-');
    const calls: string[][] = [];
    const exec: Exec = (file, args) => {
      calls.push([file, ...args]);
      if (args.length === 1) {
        if (args[0] === 'C:\\missing') return Promise.resolve({ code: 2, stdout: '', stderr: 'not found' });
        return Promise.resolve(
          args[0] === 'C:\\ProgramData\\RemyralWorker\\data'
            ? show([
                `${args[0]} NT SERVICE\\RemanaWorker:(OI)(CI)(M)`,
                '  NT SERVICE\\RemyralWorker:(OI)(CI)(M)',
              ])
            : show([`${args[0] ?? ''} NT SERVICE\\RemyralWorker:(OI)(CI)(M)`]),
        );
      }
      return Promise.resolve({ code: 0, stdout: 'Successfully processed 1 files', stderr: '' });
    };
    const dirs = ['C:\\ProgramData\\RemyralWorker', 'C:\\ProgramData\\RemyralWorker\\data', 'C:\\missing'];
    expect(await removeLegacyAcl({ installDir: install, dirs, exec, logger })).toEqual([
      'C:\\ProgramData\\RemyralWorker\\data',
    ]);
    expect(calls.filter((c) => c.includes('/remove:g'))).toEqual([
      ['icacls.exe', 'C:\\ProgramData\\RemyralWorker\\data', '/remove:g', `*${SID}`, '/C', '/Q'],
    ]);
    // Second normal run: nothing to do (marker).
    expect(await removeLegacyAcl({ installDir: install, dirs, exec, logger })).toBeNull();

    const again = await tempDir('legacy-');
    const failing: Exec = (_f, args) =>
      Promise.resolve(
        args.length === 1
          ? show([`${args[0] ?? ''} NT SERVICE\\RemanaWorker:(OI)(CI)(M)`])
          : { code: 5, stdout: '', stderr: 'Access is denied.' },
      );
    expect(await removeLegacyAcl({ installDir: again, dirs: ['C:\\x'], exec: failing, logger })).toEqual([]);
    // Not marked: the next run tries again.
    expect(await removeLegacyAcl({ installDir: again, dirs: ['C:\\x'], exec: failing, logger })).toEqual([]);
  });
});
