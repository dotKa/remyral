/**
 * What the installers in `infra/worker/<os>/` create, per OS (p2-service-*). The
 * `service status` command and the definition tests use these values, so the
 * worker and the shipped service definitions cannot silently drift apart.
 */

export type ServiceManagerKind = 'systemd' | 'launchd' | 'scm';

export interface ServiceDefinition {
  manager: ServiceManagerKind;
  /** Unit name / launchd label / Windows service name. */
  name: string;
  /** Dedicated low-privilege account the daemon runs as (ADR-0007). */
  account: string;
  configPath: string;
  dataDir: string;
  workspaceRoot: string;
  /** Where the daemon's own (redacted JSON) logs go. */
  logs: string;
  /** Exit codes after which the service manager must NOT restart the daemon. */
  noRestartExitCodes: readonly number[];
  /** Seconds the manager waits after the stop request before killing the process tree. */
  stopTimeoutSeconds: number;
}

/** Exit code for operator-fixable problems (sysexits EX_CONFIG; see cli.ts). */
export const EXIT_CONFIG_CODE = 78;

export const LINUX_SERVICE: ServiceDefinition = {
  manager: 'systemd',
  name: 'remyral-worker.service',
  account: 'remyral-worker',
  configPath: '/etc/remyral-worker/config.json',
  dataDir: '/var/lib/remyral-worker',
  workspaceRoot: '/var/lib/remyral-worker/workspaces',
  logs: 'journalctl -u remyral-worker',
  noRestartExitCodes: [EXIT_CONFIG_CODE],
  stopTimeoutSeconds: 60,
};

export const MACOS_SERVICE: ServiceDefinition = {
  manager: 'launchd',
  name: 'com.remyral.worker',
  account: '_remyralworker',
  configPath: '/Library/Application Support/RemyralWorker/config.json',
  dataDir: '/Library/Application Support/RemyralWorker/data',
  workspaceRoot: '/Library/Application Support/RemyralWorker/data/workspaces',
  logs: '/Library/Logs/RemyralWorker/remyral-worker.log',
  // launchd's KeepAlive cannot exclude exit codes: 78 is retried every ThrottleInterval.
  noRestartExitCodes: [],
  stopTimeoutSeconds: 60,
};

export const WINDOWS_SERVICE: ServiceDefinition = {
  manager: 'scm',
  name: 'RemyralWorker',
  account: 'NT SERVICE\\RemyralWorker',
  configPath: 'C:\\ProgramData\\RemyralWorker\\config.json',
  dataDir: 'C:\\ProgramData\\RemyralWorker\\data',
  workspaceRoot: 'C:\\ProgramData\\RemyralWorker\\workspaces',
  logs: 'C:\\ProgramData\\RemyralWorker\\logs',
  noRestartExitCodes: [EXIT_CONFIG_CODE],
  stopTimeoutSeconds: 60,
};

export function serviceDefinition(platform: NodeJS.Platform): ServiceDefinition | null {
  switch (platform) {
    case 'linux':
      return LINUX_SERVICE;
    case 'darwin':
      return MACOS_SERVICE;
    case 'win32':
      return WINDOWS_SERVICE;
    default:
      return null;
  }
}
