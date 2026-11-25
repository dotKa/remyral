import type { ServiceDefinition } from '../../service/definitions.js';
import { queryServiceManager } from '../../service/manager.js';
import type { System } from '../../system/types.js';
import type { ServiceControl } from './updater.js';

/** Stop waits up to the unit's 60 s stop timeout; leave room for the start. */
const RESTART_TIMEOUT_MS = 150_000;

export interface ServiceControlOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  /** Windows: how long to wait for the service to reach STOPPED after `net stop` (default: stop timeout + 30 s). */
  readonly stopWaitMs?: number;
  /** Windows: poll interval while waiting (default 1 s). */
  readonly pollMs?: number;
}

/**
 * Restarts the worker service through the OS service manager, with fixed arguments only
 * (p2-service-install names). Run as root/SYSTEM by the privileged updater.
 *
 * Windows (p6-worker-boot-diagnostics): `net.exe stop` exits 2 both for "the service is not started" and for "the
 * service could not be stopped" (it gives up while the service is still STOP_PENDING — shawl waits up to its
 * 60 s stop timeout for node). A `net start` issued then fails and the new version never runs, which looks exactly
 * like a version that died before its first log line. So after the stop the updater waits until the SCM reports
 * STOPPED, and retries the start once if it still fails. Every failure is thrown with the command's own message,
 * which the updater records in the attempt's diagnostics.
 */
export function osServiceControl(
  sys: System,
  def: ServiceDefinition,
  options: ServiceControlOptions = {},
): ServiceControl {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = async (file: string, args: string[], okCodes: readonly number[] = [0]) => {
    const r = await sys.exec(file, args, { timeoutMs: RESTART_TIMEOUT_MS });
    if (r.exitCode === null || !okCodes.includes(r.exitCode)) {
      const detail = (r.stderr || r.stdout).trim().split('\n')[0] ?? '';
      throw new Error(`${file} ${args.join(' ')} failed (${r.spawnError ?? String(r.exitCode)}): ${detail}`);
    }
  };
  /** Waits until the SCM reports the service stopped (or failed = stopped with an exit code). */
  const waitStopped = async (): Promise<string> => {
    const deadline = Date.now() + (options.stopWaitMs ?? (def.stopTimeoutSeconds + 30) * 1000);
    for (;;) {
      const st = await queryServiceManager(sys, def);
      if (st.state === 'stopped' || st.state === 'failed' || st.installed === false) return st.state;
      if (Date.now() >= deadline) return st.error ?? st.state;
      await sleep(options.pollMs ?? 1000);
    }
  };
  return {
    async restart() {
      switch (def.manager) {
        case 'systemd':
          await run('systemctl', ['restart', def.name]);
          return;
        case 'launchd':
          await run('launchctl', ['kickstart', '-k', `system/${def.name}`]);
          return;
        case 'scm': {
          // `net stop/start` wait for the state change (sc.exe does not). 2: not started — or not stopped in time,
          // which the wait below tells apart.
          await run('net.exe', ['stop', def.name], [0, 2]);
          const state = await waitStopped();
          // Still stopping after the wait: a start cannot succeed. Unknown (sc.exe unusable): try the start anyway.
          if (state === 'stopping' || state === 'running') {
            throw new Error(
              `${def.name} did not reach STOPPED after net stop (state: ${state}); not started`,
            );
          }
          try {
            await run('net.exe', ['start', def.name]);
          } catch (first) {
            await sleep(options.pollMs === undefined ? 5000 : options.pollMs * 5);
            const now = await queryServiceManager(sys, def);
            // "already started" / started late: the health check decides from here.
            if (now.state === 'running' || now.state === 'starting') return;
            await waitStopped();
            try {
              await run('net.exe', ['start', def.name]);
            } catch (second) {
              const m = (e: unknown) => (e instanceof Error ? e.message : String(e));
              throw new Error(`${m(first)}; retry: ${m(second)}`, { cause: second });
            }
          }
          return;
        }
      }
    },
    async mainPid() {
      // Under the Windows SCM the service process is the shawl wrapper, not node: not comparable.
      if (def.manager === 'scm') return null;
      const state = await queryServiceManager(sys, def);
      return state.pid;
    },
  };
}
