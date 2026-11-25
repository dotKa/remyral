#!/usr/bin/env node
// remyral-backup — backup service of the control plane (p10-backup-restore, docs/ops/backup-restore.md).
//
//   remyral-backup daemon                 schedule backups (BACKUP_TIME / BACKUP_INTERVAL_MINUTES) and weekly drills
//   remyral-backup run [--reason R]       one backup now (exit 0: ok/partial, 1: failed)
//   remyral-backup drill [--backup ID]    one restore drill now (exit 0: passed, 1: failed)
//   remyral-backup status                 status.json + heartbeat
//   remyral-backup list                   local backups of this environment
//   remyral-backup check                  configuration and database reachability (deploy-time check)
//   remyral-backup verify-file FILE --sha256 HEX   compare a file's SHA-256 (DR helper; works anywhere with node)
//   remyral-backup base                   one physical base backup now (WAL archiving on; standby restore input)
//   remyral-backup wal-ship               one WAL shipping pass now (local copy, off-site upload, prune)
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { parseArgs } from 'node:util';
import { listBackups, runBackup } from './lib/backup.mjs';
import { baseBackupDue, runBaseBackup } from './lib/basebackup.mjs';
import { loadConfig, loadOffsite, loadRecipients } from './lib/config.mjs';
import { runDrill } from './lib/drill.mjs';
import { PsqlSession, sha256File } from './lib/pg.mjs';
import { localTools } from './lib/proc.mjs';
import { expectedIntervalMs, nextBackupAt, nextDrillAt } from './lib/schedule.mjs';
import { S3Target } from './lib/s3.mjs';
import { readStatus } from './lib/status.mjs';
import { readStandby, shipWal } from './lib/wal.mjs';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    reason: { type: 'string', default: 'manual' },
    backup: { type: 'string' },
    sha256: { type: 'string' },
  },
});
const command = positionals[0] ?? 'help';
const log = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

function writeHeartbeat(cfg, info) {
  mkdirSync(cfg.statusDir, { recursive: true, mode: 0o755 });
  const file = join(cfg.statusDir, 'heartbeat.json');
  writeFileSync(
    `${file}.tmp`,
    `${JSON.stringify({ format: 'remana-backup-heartbeat/v1', env: cfg.env, ...info }, null, 2)}\n`,
    { mode: 0o644 },
  );
  renameSync(`${file}.tmp`, file);
}

const asDate = (s) => (s ? new Date(s) : null);

/** One WAL shipping pass with the current off-site configuration and recipients (both re-read every pass). */
function shipOnce(cfg) {
  const off = loadOffsite(cfg);
  const rec = loadRecipients(cfg);
  const offsite =
    off === null || off.error
      ? null
      : { target: new S3Target(off), prefix: off.prefix, describe: off.describe };
  return shipWal(cfg, { tools: localTools, offsite, recipients: rec.recipients, log });
}

async function daemon(cfg) {
  const startedAt = new Date();
  let stopping = false;
  let timer = null;
  let wake = null;
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    wake?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // The heartbeat keeps beating while a long backup or drill runs (the master alarms after 30 min of silence).
  let latest = null;
  const beat = setInterval(() => {
    if (latest) writeHeartbeat(cfg, { ...latest, at: new Date().toISOString() });
  }, 60_000);
  beat.unref();
  // p11-master-resilience: WAL shipping on its own timer (a long backup or drill must not delay it: RPO ≤ 5 min).
  let shipping = false;
  const ship = cfg.walArchive.enabled
    ? setInterval(() => {
        if (shipping) return;
        shipping = true;
        shipOnce(cfg)
          .catch((err) => log(`wal: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            shipping = false;
          });
      }, cfg.walShipIntervalMs)
    : null;
  ship?.unref();
  log(
    `daemon started for ${cfg.env}: ${cfg.schedule.intervalMinutes ? `every ${String(cfg.schedule.intervalMinutes)} min` : `daily ${String(cfg.schedule.timeOfDay.h).padStart(2, '0')}:${String(cfg.schedule.timeOfDay.m).padStart(2, '0')} UTC`}`,
  );
  while (!stopping) {
    const now = new Date();
    const status = readStatus(cfg.statusDir, cfg.env);
    const nb = nextBackupAt({
      now,
      lastAttemptAt: asDate(status.lastBackup?.startedAt),
      lastSuccessAt: asDate(status.lastSuccessfulBackup?.finishedAt),
      schedule: cfg.schedule,
    });
    const nd = nextDrillAt({
      now,
      lastDrillAt: asDate(status.lastDrill?.startedAt),
      hasBackup: status.lastSuccessfulBackup !== null,
      schedule: cfg.schedule,
    });
    latest = {
      at: now.toISOString(),
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      nextBackupAt: nb.toISOString(),
      nextDrillAt: nd?.toISOString() ?? null,
      expectedIntervalMs: expectedIntervalMs(cfg.schedule),
      schedule: {
        mode: cfg.schedule.intervalMinutes ? 'interval' : 'daily',
        intervalMinutes: cfg.schedule.intervalMinutes,
        timeOfDay: `${String(cfg.schedule.timeOfDay.h).padStart(2, '0')}:${String(cfg.schedule.timeOfDay.m).padStart(2, '0')}`,
        drill: cfg.schedule.drill.enabled
          ? `weekly ${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][cfg.schedule.drill.weekday]} ${String(cfg.schedule.drill.timeOfDay.h).padStart(2, '0')}:${String(cfg.schedule.drill.timeOfDay.m).padStart(2, '0')}`
          : 'off',
      },
      retention: cfg.retention,
    };
    writeHeartbeat(cfg, latest);
    try {
      if (now >= nb) {
        log('backup: starting');
        const r = await runBackup(cfg, { reason: 'scheduled', log });
        log(
          `backup ${r.runId}: ${r.outcome}${r.error ? ` (${r.error})` : ''}${r.warnings.length ? ` — ${r.warnings.join('; ')}` : ''}`,
        );
        continue;
      }
      if (cfg.walArchive.enabled) {
        const sb = readStandby(cfg.statusDir, cfg.env);
        if (
          baseBackupDue({
            now,
            lastSuccessAt: asDate(sb.lastSuccessfulBaseBackup?.finishedAt),
            lastAttemptAt: asDate(sb.lastBaseBackup?.startedAt),
          })
        ) {
          log('base: starting');
          const r = await runBaseBackup(cfg, { log });
          log(`base ${r.id}: ${r.outcome}${r.error ? ` (${r.error})` : ''}`);
          continue;
        }
      }
      if (nd && now >= nd) {
        log('drill: starting');
        const r = await runDrill(cfg, { log });
        log(`drill ${r.runId}: ${r.outcome}${r.error ? ` (${r.error})` : ''}`);
        continue;
      }
    } catch (err) {
      // Lock held by a manual run: try again on the next tick.
      log(`skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, 60_000);
    });
  }
  clearInterval(beat);
  if (ship) clearInterval(ship);
  log('daemon stopped');
}

async function check(cfg) {
  const out = { env: cfg.env, root: cfg.root, problems: [] };
  const rec = loadRecipients(cfg);
  out.recipients = rec.recipients.length;
  if (rec.error) out.problems.push(rec.error);
  const off = loadOffsite(cfg);
  out.offsite = off === null ? 'not configured' : off.error ? `invalid: ${off.error}` : off.describe;
  if (off?.error) out.problems.push(off.error);
  out.walArchive = cfg.walArchive.enabled ? 'on' : 'off';
  if (cfg.walArchive.enabled) {
    if (!existsSync(join(cfg.pgdataDir, 'PG_VERSION')))
      out.problems.push(`WAL archiving is on but ${cfg.pgdataDir} is not a data directory (pgdata mount)`);
    if (!existsSync(cfg.walArchiveDir))
      out.problems.push(`WAL archiving is on but ${cfg.walArchiveDir} does not exist (wal-archive mount)`);
  }
  if (!cfg.pgEnv.PGPASSWORD) out.problems.push('REMYRAL_DB_BACKUP_PASSWORD is not set');
  else {
    const s = PsqlSession.open(localTools, { env: cfg.pgEnv });
    try {
      out.database = await s.queryJson(
        "SELECT json_build_object('server', current_setting('server_version'), 'readOnly', current_setting('default_transaction_read_only'), 'user', current_user)",
      );
    } catch (err) {
      out.problems.push(`database: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await s.close();
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return out.problems.length === 0 ? 0 : 1;
}

async function main() {
  if (command === 'verify-file') {
    const file = positionals[1];
    if (!file || !/^[0-9a-f]{64}$/.test(opts.sha256 ?? ''))
      throw new Error('usage: verify-file FILE --sha256 <64 hex>');
    const r = await sha256File(file);
    const ok = r.sha256 === opts.sha256;
    process.stdout.write(`${ok ? 'OK' : 'MISMATCH'} ${file} ${String(r.bytes)} bytes sha256 ${r.sha256}\n`);
    return ok ? 0 : 1;
  }
  const cfg = loadConfig();
  switch (command) {
    case 'daemon':
      await daemon(cfg);
      return 0;
    case 'run': {
      const r = await runBackup(cfg, { reason: opts.reason, log });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.outcome === 'failed' ? 1 : 0;
    }
    case 'drill': {
      const r = await runDrill(cfg, { backup: opts.backup ?? null, log });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.outcome === 'passed' ? 0 : 1;
    }
    case 'status': {
      const status = readStatus(cfg.statusDir, cfg.env);
      const heartbeat = (() => {
        try {
          return JSON.parse(readFileSync(join(cfg.statusDir, 'heartbeat.json'), 'utf8'));
        } catch {
          return null;
        }
      })();
      const standby = readStandby(cfg.statusDir, cfg.env);
      process.stdout.write(`${JSON.stringify({ status, heartbeat, standby }, null, 2)}\n`);
      return 0;
    }
    case 'list':
      for (const b of listBackups(cfg)) {
        process.stdout.write(
          `${b.id}  ${b.manifest.tier.padEnd(8)} schema ${b.manifest.schema.version}  db ${String(b.manifest.files.db.bytes)} B  secrets ${b.manifest.files.secrets ? 'yes' : 'no'}  off-site ${b.manifest.offsite ? 'yes' : 'no'}\n`,
        );
      }
      return 0;
    case 'check':
      return check(cfg);
    case 'base': {
      if (!cfg.walArchive.enabled) throw new Error('WAL archiving is off (PG_WAL_ARCHIVE=on in stack.env)');
      const r = await runBaseBackup(cfg, { reason: opts.reason, log });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.outcome === 'failed' ? 1 : 0;
    }
    case 'wal-ship': {
      if (!cfg.walArchive.enabled) throw new Error('WAL archiving is off (PG_WAL_ARCHIVE=on in stack.env)');
      const r = await shipOnce(cfg);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.error ? 1 : 0;
    }
    default:
      process.stdout.write(
        readFileSync(new URL(import.meta.url), 'utf8')
          .split('\n')
          .slice(1, 13)
          .join('\n')
          .replace(/^\/\/ ?/gm, '') + '\n',
      );
      return command === 'help' ? 0 : 64;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`remyral-backup: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
