import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG, EXIT_CRASH } from '../src/cli.js';
import { configLocations } from '../src/config/paths.js';
import { LINUX_SERVICE, MACOS_SERVICE, WINDOWS_SERVICE } from '../src/service/definitions.js';
import {
  launchdWouldRestart,
  parsePlist,
  parseUnit,
  readInfra,
  systemdWouldRestart,
  unitValue,
  type PlistValue,
} from './service-files.js';
import { pathHost } from './helpers.js';

/** Child grace of the daemon's shutdown (daemon.ts default) — the stop timeout must exceed it. */
const CHILD_GRACE_SECONDS = 10;

const seconds = (v: string | undefined): number => {
  const m = /^(\d+)(s|min)?$/.exec(v ?? '');
  if (m?.[1] === undefined) throw new Error(`cannot parse duration ${String(v)}`);
  return Number(m[1]) * (m[2] === 'min' ? 60 : 1);
};

describe('macOS: infra/worker/macos/com.remyral.worker.plist', () => {
  const plist = parsePlist(readInfra('macos/com.remyral.worker.plist')) as Record<string, PlistValue>;
  const systemMac = configLocations(pathHost({ platform: 'darwin', isPrivileged: true }))[0];

  it('runs the bundle as the hidden role account with the system config', () => {
    expect(plist.Label).toBe(MACOS_SERVICE.name);
    expect(plist.UserName).toBe(MACOS_SERVICE.account);
    expect(plist.GroupName).toBe(MACOS_SERVICE.account);
    expect(plist.ProgramArguments).toEqual([
      '@NODE@',
      '/Library/Application Support/RemyralWorker/bin/remyral-worker.mjs',
      'run',
      '--config',
      MACOS_SERVICE.configPath,
    ]);
    expect(systemMac?.configPath).toBe(MACOS_SERVICE.configPath);
    expect(systemMac?.defaultDataDir).toBe(MACOS_SERVICE.dataDir);
    expect(plist.WorkingDirectory).toBe(MACOS_SERVICE.dataDir);
    expect((plist.EnvironmentVariables as Record<string, string>).HOME).toBe(`${MACOS_SERVICE.dataDir}/home`);
    expect(MACOS_SERVICE.workspaceRoot.startsWith(`${MACOS_SERVICE.dataDir}/`)).toBe(true);
  });

  it('restarts after crashes, not after a clean exit; throttled', () => {
    expect(plist.RunAtLoad).toBe(true);
    expect(launchdWouldRestart(plist, { code: EXIT_CRASH, signal: null })).toBe(true);
    expect(launchdWouldRestart(plist, { code: null, signal: 'SIGKILL' })).toBe(true);
    expect(launchdWouldRestart(plist, { code: null, signal: 'SIGSEGV' })).toBe(true);
    expect(launchdWouldRestart(plist, { code: 0, signal: null })).toBe(false);
    // launchd cannot exempt exit codes: 78 is retried (throttled) — documented, and the
    // definition must not claim otherwise.
    expect(launchdWouldRestart(plist, { code: EXIT_CONFIG, signal: null })).toBe(true);
    expect(MACOS_SERVICE.noRestartExitCodes).toEqual([]);
    expect(plist.ThrottleInterval).toBeGreaterThanOrEqual(10);
  });

  it('stops gracefully within the stop timeout; logs and umask', () => {
    expect(plist.ExitTimeOut).toBe(MACOS_SERVICE.stopTimeoutSeconds);
    expect(plist.ExitTimeOut).toBeGreaterThan(CHILD_GRACE_SECONDS * 2);
    expect(plist.AbandonProcessGroup).toBeUndefined(); // leftover job processes are killed
    expect(plist.StandardErrorPath).toBe(MACOS_SERVICE.logs);
    expect(plist.StandardOutPath).toBe(MACOS_SERVICE.logs);
    expect(plist.Umask).toBe(0o077);
    expect(plist.ProcessType).toBe('Standard');
  });

  it('installer and uninstaller use the same names and paths', () => {
    const install = readInfra('macos/install.sh');
    const uninstall = readInfra('macos/uninstall.sh');
    for (const script of [install, uninstall]) {
      expect(script).toContain(`SERVICE_USER=${MACOS_SERVICE.account}`);
      expect(script).toContain(`LABEL=${MACOS_SERVICE.name}`);
      expect(script).toContain('BASE_DIR="/Library/Application Support/RemyralWorker"');
      expect(script).toContain('--dry-run');
    }
    expect(install).toContain('DATA_DIR="$BASE_DIR/data"');
    expect(install).toContain('CONFIG_FILE="$BASE_DIR/config.json"');
  });
});

describe('Windows: infra/worker/windows/install.ps1 (shawl + SCM)', () => {
  const ps1 = readInfra('windows/install.ps1');
  const constant = (name: string) => {
    const m =
      new RegExp(`^\\$${name} = '([^']*)'`, 'm').exec(ps1) ??
      new RegExp(`^\\$${name} = (\\d+)`, 'm').exec(ps1);
    if (m?.[1] === undefined) throw new Error(`constant $${name} not found`);
    return m[1];
  };
  const systemWin = configLocations(
    pathHost({
      platform: 'win32',
      isPrivileged: true,
      env: (n) => (n === 'ProgramData' ? 'C:\\ProgramData' : undefined),
    }),
  )[0];

  /** shawl: `--restart-if-not <codes>` restarts the command unless it exited with one of them. */
  const shawlWouldRestart = (code: number) =>
    !constant('NoRestartExitCodes').split(',').map(Number).includes(code);

  it('service name, virtual account and data layout match the daemon', () => {
    expect(constant('ServiceName')).toBe(WINDOWS_SERVICE.name);
    expect(constant('ServiceAccount')).toBe(WINDOWS_SERVICE.account);
    expect(systemWin?.configPath).toBe(WINDOWS_SERVICE.configPath);
    expect(systemWin?.defaultDataDir).toBe(WINDOWS_SERVICE.dataDir);
    expect(ps1).toContain("ConfigPath = Join-RemyralPath $pd 'config.json'");
    expect(ps1).toContain("DataDir    = Join-RemyralPath $pd 'data'");
    expect(ps1).toContain("LogDir     = Join-RemyralPath $pd 'logs'");
    expect(WINDOWS_SERVICE.workspaceRoot).toBe('C:\\ProgramData\\RemyralWorker\\workspaces');
  });

  it('restarts crashes, not a clean stop or a config error; stop timeout covers job cancel', () => {
    expect(shawlWouldRestart(EXIT_CRASH)).toBe(true);
    expect(shawlWouldRestart(1)).toBe(true);
    expect(shawlWouldRestart(0xc0000005)).toBe(true); // access violation
    expect(shawlWouldRestart(0)).toBe(false);
    expect(shawlWouldRestart(EXIT_CONFIG)).toBe(false);
    expect(WINDOWS_SERVICE.noRestartExitCodes).toEqual([EXIT_CONFIG]);
    expect(Number(constant('StopTimeoutMs')) / 1000).toBe(WINDOWS_SERVICE.stopTimeoutSeconds);
    expect(WINDOWS_SERVICE.stopTimeoutSeconds).toBeGreaterThan(CHILD_GRACE_SECONDS * 2);
  });

  it('pins shawl by version and SHA-256', () => {
    expect(constant('ShawlVersion')).toBe('1.9.0');
    expect(constant('ShawlZipUrl')).toBe(
      'https://github.com/mtkennerly/shawl/releases/download/v1.9.0/shawl-v1.9.0-win64.zip',
    );
    expect(constant('ShawlZipSha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(constant('ShawlExeSha256')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Linux: infra/worker/linux/remyral-worker.service', () => {
  const unit = parseUnit(readInfra('linux/remyral-worker.service'));
  const svc = (key: string) => unitValue(unit, 'Service', key);
  const systemLinux = configLocations(pathHost({ platform: 'linux', isPrivileged: true }))[0];

  it('runs the bundle as the dedicated user with the system config the daemon expects', () => {
    expect(svc('User')).toBe(LINUX_SERVICE.account);
    expect(svc('Group')).toBe(LINUX_SERVICE.account);
    expect(svc('ExecStart')).toBe(
      `@NODE@ /opt/remyral-worker/remyral-worker.mjs run --config ${LINUX_SERVICE.configPath}`,
    );
    expect(systemLinux?.configPath).toBe(LINUX_SERVICE.configPath);
    expect(systemLinux?.defaultDataDir).toBe(LINUX_SERVICE.dataDir);
    expect(svc('ReadWritePaths')?.split(/\s+/)).toContain(LINUX_SERVICE.dataDir);
    expect(LINUX_SERVICE.workspaceRoot.startsWith(`${LINUX_SERVICE.dataDir}/`)).toBe(true);
  });

  it('restarts on crashes but not after a clean stop or a config error (exit 78)', () => {
    expect(EXIT_CONFIG).toBe(78);
    expect(systemdWouldRestart(unit, { code: EXIT_CRASH, signal: null })).toBe(true);
    expect(systemdWouldRestart(unit, { code: 1, signal: null })).toBe(true); // unhandled rejection
    expect(systemdWouldRestart(unit, { code: null, signal: 'SIGKILL' })).toBe(true); // OOM / kill -9
    expect(systemdWouldRestart(unit, { code: null, signal: 'SIGSEGV' })).toBe(true);
    expect(systemdWouldRestart(unit, { code: null, signal: 'SIGABRT' })).toBe(true);
    expect(systemdWouldRestart(unit, { code: 0, signal: null })).toBe(false); // graceful stop
    expect(systemdWouldRestart(unit, { code: EXIT_CONFIG, signal: null })).toBe(false);
    expect(unitValue(unit, 'Unit', 'StartLimitIntervalSec')).toBe('0'); // never give up
    expect(seconds(svc('RestartSec'))).toBeGreaterThanOrEqual(1);
    expect(LINUX_SERVICE.noRestartExitCodes).toEqual([EXIT_CONFIG]);
  });

  it('stops gracefully: SIGTERM to the daemon only, long enough to cancel jobs', () => {
    expect(svc('KillMode')).toBe('mixed');
    expect(svc('KillSignal') ?? 'SIGTERM').toBe('SIGTERM');
    const timeout = seconds(svc('TimeoutStopSec'));
    expect(timeout).toBeGreaterThan(CHILD_GRACE_SECONDS * 2);
    expect(timeout).toBe(LINUX_SERVICE.stopTimeoutSeconds);
    expect(svc('OOMPolicy')).toBe('continue');
  });

  it('is hardened (ADR-0007, T-SBX-1)', () => {
    const expected: Record<string, string> = {
      NoNewPrivileges: 'yes',
      ProtectSystem: 'strict',
      ProtectHome: 'true',
      PrivateTmp: 'yes',
      RestrictSUIDSGID: 'yes',
      LockPersonality: 'yes',
      CapabilityBoundingSet: '',
      AmbientCapabilities: '',
      UMask: '0077',
      StandardOutput: 'journal',
      StandardError: 'journal',
    };
    for (const [key, value] of Object.entries(expected)) expect([key, svc(key)]).toEqual([key, value]);
    // Breaks V8's JIT; must stay off.
    expect(svc('MemoryDenyWriteExecute')).toBeUndefined();
  });

  it('backoff drop-in only adds systemd >= 254 keys', () => {
    const dropIn = parseUnit(readInfra('linux/restart-backoff.conf'));
    expect([...(dropIn.get('Service')?.keys() ?? [])].sort()).toEqual(['RestartMaxDelaySec', 'RestartSteps']);
  });

  it('installer and uninstaller use the same names and paths', () => {
    const install = readInfra('linux/install.sh');
    const uninstall = readInfra('linux/uninstall.sh');
    for (const script of [install, uninstall]) {
      expect(script).toContain(`SERVICE_USER=${LINUX_SERVICE.account}`);
      expect(script).toContain(`SERVICE_NAME=${LINUX_SERVICE.name}`);
      expect(script).toContain(`DATA_DIR=${LINUX_SERVICE.dataDir}`);
      expect(script).toContain('--dry-run');
    }
    expect(install).toContain('CONFIG_FILE=$ETC_DIR/config.json');
    expect(install).toContain('ETC_DIR=/etc/remyral-worker');
  });
});
