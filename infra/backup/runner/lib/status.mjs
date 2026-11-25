// status.json (p10-backup-restore §6): what the console shows and the master's alerts read. Written atomically,
// 0644 in a 0755 directory (the master reads it read-only as uid 10001). Holds no secret: times, sizes, hashes,
// outcomes, short error texts produced by the runner itself.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUS_FORMAT = 'remana-backup-status/v1';
const HISTORY = 20;

export function emptyStatus(env) {
  return {
    format: STATUS_FORMAT,
    env,
    updatedAt: null,
    heartbeatAt: null,
    daemon: null,
    schedule: null,
    offsite: { configured: false, target: null, lastUploadAt: null, lastError: null },
    encryption: { recipients: 0, configured: false },
    storage: { backups: 0, bytes: 0, freeBytes: null },
    lastBackup: null,
    lastSuccessfulBackup: null,
    backups: [],
    lastDrill: null,
    lastSuccessfulDrill: null,
    drills: [],
  };
}

export function readStatus(dir, env) {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    if (s?.format === STATUS_FORMAT && s.env === env) return { ...emptyStatus(env), ...s };
  } catch {
    // missing or unreadable: start fresh
  }
  return emptyStatus(env);
}

export function writeStatus(dir, status, now = new Date()) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const next = { ...status, updatedAt: now.toISOString() };
  const tmp = join(dir, `.status.${String(process.pid)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, join(dir, 'status.json'));
  return next;
}

/** Adds a backup run (newest first, bounded) and updates the "last" pointers. Pure. */
export function recordBackup(status, run) {
  const backups = [run, ...status.backups.filter((b) => b.runId !== run.runId)].slice(0, HISTORY);
  return {
    ...status,
    lastBackup: run,
    lastSuccessfulBackup: run.outcome === 'failed' ? status.lastSuccessfulBackup : run,
    backups,
  };
}

/** Adds a drill result (newest first, bounded). Pure. */
export function recordDrill(status, drill) {
  const drills = [drill, ...status.drills.filter((d) => d.runId !== drill.runId)].slice(0, HISTORY);
  return {
    ...status,
    lastDrill: drill,
    lastSuccessfulDrill: drill.outcome === 'passed' ? drill : status.lastSuccessfulDrill,
    drills,
  };
}

/** Shortens an error for the status file (no stack, no control characters). */
export function errorText(err) {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 500);
}
