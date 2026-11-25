import { posix, win32 } from 'node:path';

/** What path resolution needs from the host; injectable so every OS is tested everywhere. */
export interface PathHost {
  platform: NodeJS.Platform;
  env(name: string): string | undefined;
  homedir(): string;
  /** root on POSIX (euid 0); on Windows always `true` (services run as LocalSystem / a service account). */
  isPrivileged: boolean;
}

export type ConfigScope = 'system' | 'user';

export interface ConfigLocation {
  scope: ConfigScope;
  configPath: string;
  /** Default dataDir for this scope when the config file does not set one. */
  defaultDataDir: string;
}

export const CONFIG_ENV = 'REMYRAL_WORKER_CONFIG';

export function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Candidate config locations in priority order.
 *
 * | OS      | system (service)                                         | user (dev / per-user agent)                                   |
 * |---------|----------------------------------------------------------|---------------------------------------------------------------|
 * | Linux   | /etc/remyral-worker/config.json, data /var/lib/remyral-worker | $XDG_CONFIG_HOME/remyral-worker/config.json, data $XDG_STATE_HOME/remyral-worker |
 * | macOS   | /Library/Application Support/RemyralWorker/config.json     | ~/Library/Application Support/RemyralWorker/config.json        |
 * | Windows | %ProgramData%\RemyralWorker\config.json                     | (none: the worker runs as a Windows Service)                  |
 *
 * A privileged process only looks at the system location, so a root daemon never
 * reads a file an unprivileged user controls.
 */
export function configLocations(host: PathHost): ConfigLocation[] {
  const home = host.homedir();
  switch (host.platform) {
    case 'win32': {
      const programData = host.env('ProgramData') ?? host.env('PROGRAMDATA') ?? 'C:\\ProgramData';
      const base = win32.join(programData, 'RemyralWorker');
      return [
        {
          scope: 'system',
          configPath: win32.join(base, 'config.json'),
          defaultDataDir: win32.join(base, 'data'),
        },
      ];
    }
    case 'darwin': {
      const system: ConfigLocation = {
        scope: 'system',
        configPath: '/Library/Application Support/RemyralWorker/config.json',
        defaultDataDir: '/Library/Application Support/RemyralWorker/data',
      };
      if (host.isPrivileged) return [system];
      const base = posix.join(home, 'Library', 'Application Support', 'RemyralWorker');
      return [
        {
          scope: 'user',
          configPath: posix.join(base, 'config.json'),
          defaultDataDir: posix.join(base, 'data'),
        },
        system,
      ];
    }
    default: {
      const system: ConfigLocation = {
        scope: 'system',
        configPath: '/etc/remyral-worker/config.json',
        defaultDataDir: '/var/lib/remyral-worker',
      };
      if (host.isPrivileged) return [system];
      const xdgConfig = absOr(host.env('XDG_CONFIG_HOME'), posix.join(home, '.config'));
      const xdgState = absOr(host.env('XDG_STATE_HOME'), posix.join(home, '.local', 'state'));
      return [
        {
          scope: 'user',
          configPath: posix.join(xdgConfig, 'remyral-worker', 'config.json'),
          defaultDataDir: posix.join(xdgState, 'remyral-worker'),
        },
        system,
      ];
    }
  }
}

/** XDG: relative values must be ignored. */
function absOr(value: string | undefined, fallback: string): string {
  return value !== undefined && posix.isAbsolute(value) ? value : fallback;
}
