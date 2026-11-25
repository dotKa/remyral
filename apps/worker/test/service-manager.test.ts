import { describe, expect, it } from 'vitest';
import {
  LINUX_SERVICE,
  MACOS_SERVICE,
  WINDOWS_SERVICE,
  serviceDefinition,
} from '../src/service/definitions.js';
import {
  parseLaunchctlPrint,
  parseScQuery,
  parseSystemctlShow,
  queryServiceManager,
} from '../src/service/manager.js';
import { FakeSystem, fail, ok } from './fake-system.js';

// Fixtures follow the real output formats (systemd 257 `systemctl show`, macOS 26
// `launchctl print`, Windows 11 `sc.exe queryex` / `sc.exe qc`).

const SYSTEMCTL_RUNNING = `LoadState=loaded
ActiveState=active
SubState=running
Result=success
MainPID=4242
ExecMainCode=0
ExecMainStatus=0
NRestarts=2
UnitFileState=enabled
User=remyral-worker
`;

describe('systemd (systemctl show)', () => {
  it('parses a running, enabled service with restarts', () => {
    expect(parseSystemctlShow(LINUX_SERVICE, SYSTEMCTL_RUNNING)).toMatchObject({
      manager: 'systemd',
      installed: true,
      state: 'running',
      pid: 4242,
      enabled: true,
      restarts: 2,
      account: 'remyral-worker',
      lastExitCode: null,
      error: null,
    });
  });

  it('reports a crash by signal while waiting for the restart', () => {
    const s = parseSystemctlShow(
      LINUX_SERVICE,
      'LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nResult=signal\nMainPID=0\nExecMainCode=2\nExecMainStatus=9\nNRestarts=3\nUnitFileState=enabled\n',
    );
    expect(s).toMatchObject({ state: 'starting', pid: null, lastSignal: 'signal 9', restarts: 3 });
  });

  it('reports exit 78 (not restarted) as failed', () => {
    const s = parseSystemctlShow(
      LINUX_SERVICE,
      'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=0\nExecMainCode=1\nExecMainStatus=78\nNRestarts=0\nUnitFileState=enabled\n',
    );
    expect(s).toMatchObject({ state: 'failed', lastExitCode: 78, restarts: 0 });
  });

  it('maps inactive/disabled and not-found', () => {
    expect(
      parseSystemctlShow(
        LINUX_SERVICE,
        'LoadState=loaded\nActiveState=inactive\nMainPID=0\nUnitFileState=disabled\nExecMainCode=1\nExecMainStatus=0\n',
      ),
    ).toMatchObject({ state: 'stopped', enabled: false, lastExitCode: 0 });
    expect(parseSystemctlShow(LINUX_SERVICE, 'LoadState=not-found\nActiveState=inactive\n')).toMatchObject({
      installed: false,
      state: 'stopped',
    });
    expect(parseSystemctlShow(LINUX_SERVICE, 'garbage').error).toMatch(/LoadState/);
  });

  it('queries systemctl with explicit properties and the unit name', async () => {
    const sys = new FakeSystem({ platform: 'linux', exec: () => ok(SYSTEMCTL_RUNNING) });
    const s = await queryServiceManager(sys, LINUX_SERVICE);
    expect(s.state).toBe('running');
    const call = sys.execCalls[0];
    expect(call?.file).toBe('systemctl');
    expect(call?.args).toContain('--property=NRestarts');
    expect(call?.args.at(-1)).toBe('remyral-worker.service');
  });

  it('reports a missing systemctl as unknown, not as stopped', async () => {
    const sys = new FakeSystem({
      platform: 'linux',
      exec: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' }),
    });
    const s = await queryServiceManager(sys, LINUX_SERVICE);
    expect(s).toMatchObject({ installed: null, state: 'unknown' });
    expect(s.error).toContain('ENOENT');
  });
});

const LAUNCHCTL_RUNNING = `system/com.remyral.worker = {
\tactive count = 1
\tpath = /Library/LaunchDaemons/com.remyral.worker.plist
\ttype = LaunchDaemon
\tstate = running

\tprogram = /usr/local/bin/node
\targuments = {
\t\t/usr/local/bin/node
\t\trun
\t}

\tusername = _remyralworker
\tgroupname = _remyralworker
\truns = 3
\tpid = 777
\tlast exit code = (never exited)
\tresource coalition = {
\t\tstate = active
\t}
}
`;

describe('launchd (launchctl print)', () => {
  it('parses a running daemon; runs - 1 = restarts; nested state lines are ignored', () => {
    expect(parseLaunchctlPrint(MACOS_SERVICE, LAUNCHCTL_RUNNING)).toMatchObject({
      installed: true,
      state: 'running',
      pid: 777,
      restarts: 2,
      account: '_remyralworker',
      lastExitCode: null,
    });
  });

  it('reports a non-zero last exit while not running as failed', () => {
    const s = parseLaunchctlPrint(
      MACOS_SERVICE,
      'system/com.remyral.worker = {\n\tstate = not running\n\truns = 5\n\tlast exit code = 78: Function not implemented\n}\n',
    );
    expect(s).toMatchObject({ state: 'failed', lastExitCode: 78, pid: null, restarts: 4 });
    const signalled = parseLaunchctlPrint(
      MACOS_SERVICE,
      'x = {\n\tstate = spawn scheduled\n\tlast exit code = 0\n\tlast terminating signal = Killed: 9\n}\n',
    );
    expect(signalled).toMatchObject({ state: 'starting', lastSignal: 'Killed: 9' });
  });

  it('treats launchctl exit 113 as not installed', async () => {
    const sys = new FakeSystem({ platform: 'darwin', exec: () => fail(113, 'Could not find service') });
    expect(await queryServiceManager(sys, MACOS_SERVICE)).toMatchObject({
      installed: false,
      state: 'stopped',
    });
    expect(sys.execCalls[0]?.args).toEqual(['print', 'system/com.remyral.worker']);
  });
});

const SC_QUERYEX = `
SERVICE_NAME: RemyralWorker
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 6120
        FLAGS              :
`;
const SC_QC = `[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: RemyralWorker
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 2   AUTO_START  (DELAYED)
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : "C:\\Program Files\\RemyralWorker\\shawl.exe" run --name RemyralWorker -- node
        DISPLAY_NAME       : Remyral Worker
        SERVICE_START_NAME : NT SERVICE\\RemyralWorker
`;

describe('Windows SCM (sc.exe)', () => {
  it('parses queryex + qc', () => {
    expect(parseScQuery(WINDOWS_SERVICE, SC_QUERYEX, SC_QC)).toMatchObject({
      installed: true,
      state: 'running',
      pid: 6120,
      enabled: true,
      account: 'NT SERVICE\\RemyralWorker',
      lastExitCode: 0,
    });
  });

  it('uses SERVICE_EXIT_CODE for a service-specific error (shawl did not restart exit 78)', () => {
    const stopped = SC_QUERYEX.replace('4  RUNNING', '1  STOPPED')
      .replace('WIN32_EXIT_CODE    : 0  (0x0)', 'WIN32_EXIT_CODE    : 1066  (0x42a)')
      .replace('SERVICE_EXIT_CODE  : 0  (0x0)', 'SERVICE_EXIT_CODE  : 78  (0x4e)')
      .replace('PID                : 6120', 'PID                : 0');
    expect(parseScQuery(WINDOWS_SERVICE, stopped)).toMatchObject({
      state: 'failed',
      lastExitCode: 78,
      pid: null,
      enabled: null,
    });
  });

  it('parses the state number even when the state name is localized', () => {
    expect(parseScQuery(WINDOWS_SERVICE, SC_QUERYEX.replace('4  RUNNING', '4  WIRD AUSGEFÜHRT')).state).toBe(
      'running',
    );
  });

  it('treats sc.exe 1060 as not installed and asks qc only for an existing service', async () => {
    const missing = new FakeSystem({ platform: 'win32', exec: () => fail(1060, 'OpenService FAILED 1060') });
    expect(await queryServiceManager(missing, WINDOWS_SERVICE)).toMatchObject({ installed: false });
    expect(missing.execCalls).toHaveLength(1);
    const present = new FakeSystem({
      platform: 'win32',
      exec: (_f, args) => ok(args[0] === 'qc' ? SC_QC : SC_QUERYEX),
    });
    expect(await queryServiceManager(present, WINDOWS_SERVICE)).toMatchObject({ enabled: true, pid: 6120 });
    expect(present.execCalls.map((c) => c.args[0])).toEqual(['queryex', 'qc']);
  });
});

describe('serviceDefinition', () => {
  it('has one definition per supported OS', () => {
    expect(serviceDefinition('linux')?.manager).toBe('systemd');
    expect(serviceDefinition('darwin')?.manager).toBe('launchd');
    expect(serviceDefinition('win32')?.manager).toBe('scm');
    expect(serviceDefinition('freebsd')).toBeNull();
  });
});
