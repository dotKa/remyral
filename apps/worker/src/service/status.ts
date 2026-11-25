import type { z } from 'zod';
import { resolveConfigPath } from '../config/load.js';
import { pathApi, type PathHost } from '../config/paths.js';
import { workerConfigSchema } from '../config/schema.js';
import { FileTooLargeError, errnoCode, type FileOps } from '../fs/ops.js';
import { OUTBOX_FILE, STATE_FILE } from '../store/store.js';
import { StoreState } from '../store/schema.js';
import type { System } from '../system/types.js';
import { serviceDefinition, type ServiceDefinition } from './definitions.js';
import { queryServiceManager, type ServiceManagerState } from './manager.js';
import { readStatusFile, type StatusFileContent } from './status-file.js';

/** LSB `status` exit codes: 0 running, 3 not running, 4 unknown / not installed. */
export const STATUS_EXIT = { running: 0, notRunning: 3, unknown: 4 } as const;

export interface LocalStoreSummary {
  enrolled: boolean;
  workerId: string | null;
  enrolledAt: string | null;
  /** Leases restored from disk; after a restart they await reconciliation with the master. */
  leases: number;
  lastMasterSeq: number;
  ackedOutboundSeq: number;
  /** Lines in outbox.jsonl (upper bound of unacknowledged events). */
  outboxEntries: number;
}

export interface ServiceStatusReport {
  service: ServiceManagerState;
  config: { path: string | null; dataDir: string | null; masterUrl: string | null; error: string | null };
  /** Daemon lifecycle from status.json, judged against the service manager. */
  worker: {
    state: StatusFileContent['state'] | null;
    runningJobs: number | null;
    pid: number | null;
    since: string | null;
    updatedAt: string | null;
    /** `live`: written by the running daemon; `stale`: the daemon that wrote it is gone. */
    freshness: 'live' | 'stale' | 'stopped' | 'missing';
    error: string | null;
  };
  store: LocalStoreSummary | { error: string } | null;
}

function readError(path: string, error: unknown): string {
  const code = errnoCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return `${path}: permission denied (run as root/Administrator, or as the service user)`;
  }
  return `cannot read ${path}: ${(error as Error).message}`;
}

async function readText(ops: FileOps, path: string, max: number): Promise<string | null> {
  const raw = await ops.readFile(path, max);
  return raw === null ? null : raw.toString('utf8').replace(/^\uFEFF/, '');
}

/** Config without side effects: no dataDir creation, no permission enforcement (that is `run`'s job). */
async function readConfig(
  ops: FileOps,
  host: PathHost,
  explicitPath: string | undefined,
  def: ServiceDefinition,
): Promise<ServiceStatusReport['config']> {
  let path: string | null = null;
  let dataDir: string | null = null;
  try {
    const resolved = await resolveConfigPath(ops, host, { explicitPath });
    path = resolved.path;
    dataDir = resolved.defaultDataDir;
    const text = await readText(ops, path, 64 * 1024);
    if (text === null) return { path, dataDir, masterUrl: null, error: `${path} does not exist` };
    const parsed = workerConfigSchema(host.platform).safeParse(JSON.parse(text));
    if (!parsed.success) {
      const issues = (parsed.error as z.ZodError).issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return { path, dataDir, masterUrl: null, error: `invalid config: ${issues.join('; ')}` };
    }
    return { path, dataDir: parsed.data.dataDir ?? dataDir, masterUrl: parsed.data.masterUrl, error: null };
  } catch (error) {
    const message =
      path === null
        ? ((error as Error).message.split('\n')[0] ?? 'no config')
        : error instanceof SyntaxError
          ? `${path} is not valid JSON`
          : readError(path, error);
    return { path: path ?? def.configPath, dataDir: dataDir ?? def.dataDir, masterUrl: null, error: message };
  }
}

/** Read-only summary of the durable store (never repairs or quarantines anything). */
export async function readStoreSummary(
  ops: FileOps,
  dataDir: string,
): Promise<LocalStoreSummary | { error: string } | null> {
  const p = pathApi(ops.platform);
  const statePath = p.join(dataDir, STATE_FILE);
  let text: string | null;
  try {
    text = await readText(ops, statePath, 1024 * 1024);
  } catch (error) {
    return { error: readError(statePath, error) };
  }
  if (text === null) return null;
  let state: StoreState;
  try {
    const parsed = StoreState.safeParse(JSON.parse(text));
    if (!parsed.success) return { error: `${statePath} is invalid (the daemon will quarantine it on start)` };
    state = parsed.data;
  } catch {
    return { error: `${statePath} is not valid JSON (the daemon will quarantine it on start)` };
  }
  let outboxEntries: number;
  const outboxPath = p.join(dataDir, OUTBOX_FILE);
  try {
    const outbox = await readText(ops, outboxPath, 16 * 1024 * 1024);
    outboxEntries = outbox === null ? 0 : outbox.split('\n').filter((l) => l.trim() !== '').length;
  } catch (error) {
    if (!(error instanceof FileTooLargeError)) return { error: readError(outboxPath, error) };
    outboxEntries = -1;
  }
  return {
    enrolled: state.identity !== null,
    workerId: state.identity?.workerId ?? null,
    enrolledAt: state.identity?.enrolledAt ?? null,
    leases: state.leases.length,
    lastMasterSeq: state.cursors.lastMasterSeq,
    ackedOutboundSeq: state.cursors.ackedOutboundSeq,
    outboxEntries,
  };
}

function judgeWorker(
  service: ServiceManagerState,
  status: StatusFileContent | null | { error: string },
): ServiceStatusReport['worker'] {
  const empty = { state: null, runningJobs: null, pid: null, since: null, updatedAt: null };
  if (status === null) return { ...empty, freshness: 'missing', error: null };
  if ('error' in status) return { ...empty, freshness: 'missing', error: status.error };
  const fields = {
    state: status.state,
    runningJobs: status.runningJobs,
    pid: status.pid,
    since: status.startedAt,
    updatedAt: status.updatedAt,
    error: null,
  };
  if (status.state === 'stopped') return { ...fields, freshness: 'stopped' };
  // systemd and launchd start node directly, so the main pid must match. Under the Windows
  // SCM the service process is the shawl wrapper, whose pid differs from node's.
  const live =
    service.state === 'running' &&
    (service.manager === 'scm' || service.pid === null || service.pid === status.pid);
  return { ...fields, freshness: live ? 'live' : 'stale' };
}

export interface ServiceStatusOptions {
  configPath?: string | undefined;
}

export async function collectServiceStatus(
  sys: System,
  ops: FileOps,
  host: PathHost,
  options: ServiceStatusOptions = {},
): Promise<ServiceStatusReport | { error: string }> {
  const def = serviceDefinition(host.platform);
  if (def === null) return { error: `no service integration for platform ${host.platform}` };
  const [service, config] = await Promise.all([
    queryServiceManager(sys, def),
    readConfig(ops, host, options.configPath, def),
  ]);
  const dataDir = config.dataDir ?? def.dataDir;
  const [status, store] = await Promise.all([
    readStatusFile(ops, dataDir).catch((error: unknown) => ({ error: readError(dataDir, error) })),
    readStoreSummary(ops, dataDir),
  ]);
  return { service, config: { ...config, dataDir }, worker: judgeWorker(service, status), store };
}

export function statusExitCode(report: ServiceStatusReport): number {
  if (report.service.state === 'running') return STATUS_EXIT.running;
  if (report.service.installed === true) return STATUS_EXIT.notRunning;
  return STATUS_EXIT.unknown;
}

export function formatServiceStatus(r: ServiceStatusReport): string {
  const s = r.service;
  const svcParts: string[] = [];
  if (s.installed === false) svcParts.push('not installed');
  else if (s.error !== null) svcParts.push(`unknown (${s.error})`);
  else {
    svcParts.push(s.state);
    if (s.pid !== null) svcParts.push(`pid ${String(s.pid)}`);
    if (s.enabled !== null) svcParts.push(s.enabled ? 'starts at boot' : 'NOT started at boot');
    if (s.restarts !== null) svcParts.push(`restarts ${String(s.restarts)}`);
    if (s.lastExitCode !== null) {
      svcParts.push(
        `last exit ${String(s.lastExitCode)}${s.lastExitCode === 78 ? ' (configuration problem — see the logs)' : ''}`,
      );
    }
    if (s.lastSignal !== null) svcParts.push(`last signal ${s.lastSignal}`);
    if (s.account !== null) svcParts.push(`account ${s.account}`);
  }

  const w = r.worker;
  let worker: string;
  if (w.error !== null) worker = w.error;
  else if (w.freshness === 'missing')
    worker = 'no status recorded yet (daemon never started with this data directory)';
  else if (w.freshness === 'stopped') worker = `stopped gracefully at ${w.updatedAt ?? '?'}`;
  else {
    worker = `${w.state ?? '?'}, ${String(w.runningJobs ?? 0)} running job(s), since ${w.since ?? '?'}`;
    if (w.freshness === 'stale')
      worker += ` — STALE: daemon pid ${String(w.pid)} is gone (crashed or killed)`;
  }

  let store: string;
  if (r.store === null) store = 'empty (never paired)';
  else if ('error' in r.store) store = r.store.error;
  else {
    store =
      (r.store.enrolled ? `enrolled as ${r.store.workerId ?? '?'}` : 'not enrolled (pairing pending)') +
      `, ${String(r.store.leases)} lease(s) held` +
      `, outbox ${r.store.outboxEntries < 0 ? 'over 16 MiB' : String(r.store.outboxEntries)}` +
      `, master seq ${String(r.store.lastMasterSeq)}`;
  }

  return [
    `Service:  ${s.name} (${s.manager}): ${svcParts.join(', ')}`,
    `Worker:   ${worker}`,
    `Store:    ${store}`,
    `Config:   ${r.config.path ?? '?'}${r.config.error === null ? '' : ` — ${r.config.error}`}`,
    `Master:   ${r.config.masterUrl ?? '?'}`,
    `Data dir: ${r.config.dataDir ?? '?'}`,
    '',
  ].join('\n');
}
