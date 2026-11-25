import type { ExecResult, System } from '../system/types.js';
import type { ServiceDefinition, ServiceManagerKind } from './definitions.js';

/** What the OS service manager says about the worker service (read-only query). */
export interface ServiceManagerState {
  manager: ServiceManagerKind;
  name: string;
  /** `false` when the manager does not know the service; `null` if it could not be asked. */
  installed: boolean | null;
  state: 'running' | 'starting' | 'stopping' | 'stopped' | 'failed' | 'unknown';
  pid: number | null;
  /** Start at boot (systemd enabled / launchd loaded / SCM auto start). */
  enabled: boolean | null;
  /** Exit status of the last run, when the manager reports one. */
  lastExitCode: number | null;
  /** Signal that ended the last run (POSIX), e.g. `SIGKILL` / `Killed: 9`. */
  lastSignal: string | null;
  /** Restarts after failures (systemd NRestarts; launchd runs - 1). */
  restarts: number | null;
  /** Account the manager starts the service as, when it reports it. */
  account: string | null;
  /** Why `installed`/`state` could not be determined. */
  error: string | null;
}

const QUERY_TIMEOUT_MS = 10_000;

function base(def: ServiceDefinition): ServiceManagerState {
  return {
    manager: def.manager,
    name: def.name,
    installed: null,
    state: 'unknown',
    pid: null,
    enabled: null,
    lastExitCode: null,
    lastSignal: null,
    restarts: null,
    account: null,
    error: null,
  };
}

function execError(what: string, r: ExecResult): string {
  if (r.spawnError !== undefined) return `${what} could not be run (${r.spawnError})`;
  if (r.timedOut) return `${what} timed out`;
  const detail = (r.stderr || r.stdout).trim().split('\n')[0] ?? '';
  return `${what} exited with ${String(r.exitCode)}${detail === '' ? '' : `: ${detail}`}`;
}

const int = (value: string | undefined): number | null => {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return null;
  return Number(value.trim());
};

// --- systemd --------------------------------------------------------------------------------

export const SYSTEMD_PROPERTIES = [
  'LoadState',
  'ActiveState',
  'SubState',
  'Result',
  'MainPID',
  'ExecMainCode',
  'ExecMainStatus',
  'NRestarts',
  'UnitFileState',
  'User',
] as const;

/** Parses `systemctl show -p … <unit>` (`Key=Value` lines). */
export function parseSystemctlShow(def: ServiceDefinition, stdout: string): ServiceManagerState {
  const p = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) p.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const s = base(def);
  const load = p.get('LoadState');
  if (load === undefined) return { ...s, error: 'systemctl show returned no LoadState' };
  if (load === 'not-found') return { ...s, installed: false, state: 'stopped' };
  s.installed = true;
  const active = p.get('ActiveState');
  s.state =
    active === 'active' || active === 'reloading'
      ? 'running'
      : active === 'activating'
        ? 'starting'
        : active === 'deactivating'
          ? 'stopping'
          : active === 'failed'
            ? 'failed'
            : active === 'inactive'
              ? 'stopped'
              : 'unknown';
  // "activating (auto-restart)" is the RestartSec wait after a crash.
  if (active === 'activating' && p.get('SubState') === 'auto-restart') s.state = 'starting';
  const pid = int(p.get('MainPID'));
  s.pid = pid !== null && pid > 0 ? pid : null;
  const ufs = p.get('UnitFileState');
  s.enabled = ufs === undefined || ufs === '' ? null : ufs === 'enabled';
  // ExecMainCode is a CLD_* code: 1 exited (status = exit code), 2 killed / 3 dumped (status = signal).
  const code = int(p.get('ExecMainCode'));
  const status = int(p.get('ExecMainStatus'));
  if (code === 1) s.lastExitCode = status;
  else if ((code === 2 || code === 3) && status !== null) s.lastSignal = `signal ${String(status)}`;
  s.restarts = int(p.get('NRestarts'));
  const user = p.get('User');
  s.account = user === undefined || user === '' ? null : user;
  return s;
}

// --- launchd --------------------------------------------------------------------------------

/** Parses `launchctl print system/<label>` (only the top-level `key = value` lines). */
export function parseLaunchctlPrint(def: ServiceDefinition, stdout: string): ServiceManagerState {
  const p = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    // Top-level properties are indented by exactly one tab; nested blocks by more.
    const m = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && !p.has(m[1])) p.set(m[1], m[2].trim());
  }
  const s = base(def);
  if (!p.has('state')) return { ...s, error: 'launchctl print returned no state' };
  s.installed = true;
  // launchd only prints a job that is bootstrapped (loaded), which is what RunAtLoad needs.
  s.enabled = true;
  const state = p.get('state') ?? '';
  s.state =
    state === 'running'
      ? 'running'
      : state === 'spawn scheduled' || state === 'xpcproxy'
        ? 'starting'
        : state === 'not running' || state === 'waiting'
          ? 'stopped'
          : 'unknown';
  s.pid = int(p.get('pid'));
  const exit = /^(-?\d+)/.exec(p.get('last exit code') ?? '');
  s.lastExitCode = exit?.[1] === undefined ? null : Number(exit[1]);
  s.lastSignal = p.get('last terminating signal') ?? null;
  const runs = int(p.get('runs'));
  s.restarts = runs === null ? null : Math.max(0, runs - 1);
  s.account = p.get('username') ?? null;
  if (s.state === 'stopped' && s.lastExitCode !== null && s.lastExitCode !== 0) s.state = 'failed';
  return s;
}

// --- Windows SCM ------------------------------------------------------------------------------

/** SERVICE_STATUS dwCurrentState values; sc.exe prints the number before the (localized) name. */
const SCM_STATES: Record<number, ServiceManagerState['state']> = {
  1: 'stopped',
  2: 'starting',
  3: 'stopping',
  4: 'running',
  5: 'starting', // CONTINUE_PENDING
  6: 'stopping', // PAUSE_PENDING
  7: 'stopped', // PAUSED
};

/** Parses `sc.exe queryex <name>` and (optionally) `sc.exe qc <name>`. */
export function parseScQuery(def: ServiceDefinition, queryex: string, qc = ''): ServiceManagerState {
  const field = (text: string, key: string) =>
    new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim();
  const s = base(def);
  const state = int(field(queryex, 'STATE')?.split(/\s+/)[0]);
  if (state === null) return { ...s, error: 'sc.exe queryex returned no STATE' };
  s.installed = true;
  s.state = SCM_STATES[state] ?? 'unknown';
  const pid = int(field(queryex, 'PID'));
  s.pid = pid !== null && pid > 0 ? pid : null;
  const win32 = int(field(queryex, 'WIN32_EXIT_CODE')?.split(/\s+/)[0]);
  const specific = int(field(queryex, 'SERVICE_EXIT_CODE')?.split(/\s+/)[0]);
  // ERROR_SERVICE_SPECIFIC_ERROR (1066): the real code is SERVICE_EXIT_CODE (shawl reports the
  // wrapped command's exit code this way when it does not restart it).
  s.lastExitCode = win32 === 1066 ? specific : win32;
  if (s.state === 'stopped' && s.lastExitCode !== null && s.lastExitCode !== 0) s.state = 'failed';
  const start = int(field(qc, 'START_TYPE')?.split(/\s+/)[0]);
  s.enabled = start === null ? null : start === 2; // 2 = AUTO_START (incl. delayed)
  s.account = field(qc, 'SERVICE_START_NAME') ?? null;
  return s;
}

/** Asks the OS service manager about the worker service. Never throws. */
export async function queryServiceManager(sys: System, def: ServiceDefinition): Promise<ServiceManagerState> {
  const opts = { timeoutMs: QUERY_TIMEOUT_MS };
  switch (def.manager) {
    case 'systemd': {
      const args = ['show', '--no-pager', ...SYSTEMD_PROPERTIES.map((p) => `--property=${p}`), def.name];
      const r = await sys.exec('systemctl', args, opts);
      if (r.exitCode !== 0) return { ...base(def), error: execError('systemctl show', r) };
      return parseSystemctlShow(def, r.stdout);
    }
    case 'launchd': {
      const r = await sys.exec('launchctl', ['print', `system/${def.name}`], opts);
      // 113: "Could not find service … in domain for system" — not loaded / not installed.
      if (r.exitCode === 113) return { ...base(def), installed: false, state: 'stopped', enabled: false };
      if (r.exitCode !== 0) return { ...base(def), error: execError('launchctl print', r) };
      return parseLaunchctlPrint(def, r.stdout);
    }
    case 'scm': {
      const r = await sys.exec('sc.exe', ['queryex', def.name], opts);
      // 1060: ERROR_SERVICE_DOES_NOT_EXIST.
      if (r.exitCode === 1060) return { ...base(def), installed: false, state: 'stopped', enabled: false };
      if (r.exitCode !== 0) return { ...base(def), error: execError('sc.exe queryex', r) };
      const qc = await sys.exec('sc.exe', ['qc', def.name], opts);
      return parseScQuery(def, r.stdout, qc.exitCode === 0 ? qc.stdout : '');
    }
  }
}
