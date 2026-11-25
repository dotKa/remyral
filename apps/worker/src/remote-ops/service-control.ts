import { serviceDefinition, type ServiceManagerKind } from '../service/definitions.js';

/**
 * Remote restart (p5-remote-ops §4): the worker drains (optionally), stops cleanly and exits with
 * {@link EXIT_RESTART}; its service manager starts it again. All three shipped service definitions restart on
 * a non-zero exit other than 78 (systemd `Restart=on-failure` + `RestartPreventExitStatus=78`, launchd
 * `KeepAlive.SuccessfulExit=false`, shawl `--restart-if-not 0,78`). A worker started by hand (no service
 * manager) cannot come back by itself, so it refuses a remote restart.
 */
export const EXIT_RESTART = 75;

export interface ServiceInfo {
  readonly manager: ServiceManagerKind | 'none';
  readonly restartable: boolean;
}

/**
 * Detects whether this process runs under the shipped service definition: systemd sets `INVOCATION_ID` for
 * every unit it starts; launchd sets `XPC_SERVICE_NAME` to the job label; on Windows the service (shawl) runs
 * the worker with `NODE_ENV=production` and the service's data dir (heuristic, UNVERIFIED on a real host).
 */
export function detectService(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  dataDir: string,
): ServiceInfo {
  const def = serviceDefinition(platform);
  if (def === null) return { manager: 'none', restartable: false };
  switch (def.manager) {
    case 'systemd':
      return env.INVOCATION_ID !== undefined && env.INVOCATION_ID !== ''
        ? { manager: 'systemd', restartable: true }
        : { manager: 'none', restartable: false };
    case 'launchd':
      return env.XPC_SERVICE_NAME === def.name
        ? { manager: 'launchd', restartable: true }
        : { manager: 'none', restartable: false };
    case 'scm':
      return env.NODE_ENV === 'production' && dataDir.toLowerCase() === def.dataDir.toLowerCase()
        ? { manager: 'scm', restartable: true }
        : { manager: 'none', restartable: false };
  }
}
