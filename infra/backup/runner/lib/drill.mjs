// Restore drill (p10-backup-restore §5): the latest local backup is restored into a throw-away Postgres that
// listens on no TCP port (Unix socket in a private directory), checked against its manifest, and destroyed.
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { PRE_RENAME_DB_ROLES } from './pre-rename-roles.mjs'; // p17-prerename-backups (see that file)
import { ensureDirs, listBackups } from './backup.mjs';
import { acquireLock } from './lock.mjs';
import { backupId, drillReportFile, localFiles, parseBackupId } from './naming.mjs';
import { loadMigrationFiles, PsqlSession, SESSION_SETTINGS, sha256File, verifyRestored } from './pg.mjs';
import { localTools } from './proc.mjs';
import { runStandbyDrill } from './standby-drill.mjs';
import { errorText, readStatus, recordDrill, writeStatus } from './status.mjs';

const noop = () => undefined;
const REPORT_KEEP_DAYS = 26 * 7;

/** postgres options of the throw-away server: no TCP, private socket, durability off (it is discarded). */
/** Roles a drill creates before pg_restore (the dump's owner and grants name them). */
export const DRILL_ROLES = Object.freeze([
  'remyral_owner',
  'remyral_app',
  'remyral_backup',
  ...PRE_RENAME_DB_ROLES, // p17-prerename-backups
]);

export function scratchServerOptions(sockDir) {
  if (!/^[A-Za-z0-9/._-]+$/.test(sockDir)) throw new Error('unsafe socket directory path');
  return [
    "-c listen_addresses=''",
    `-c unix_socket_directories=${sockDir}`,
    '-c unix_socket_permissions=0700',
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
    '-c shared_buffers=64MB',
    '-c maintenance_work_mem=64MB',
    '-c max_connections=10',
    '-c max_wal_size=2GB',
    '-c autovacuum=off',
  ].join(' ');
}

/** Removes a directory as the drill user (its files are owned by that user; root here has no DAC_OVERRIDE). */
async function removeAsDrillUser(tools, cfg, dir) {
  if (!existsSync(dir)) return;
  await tools.run(
    process.execPath,
    ['-e', 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })', dir],
    {
      uid: cfg.drillUser.uid,
      gid: cfg.drillUser.gid,
      allowFail: true,
    },
  );
  rmSync(dir, { recursive: true, force: true });
}

/** Last lines of the throw-away server's log (read as the drill user, who owns it). */
async function serverLogTail(tools, cfg, file) {
  const r = await tools.run(
    process.execPath,
    [
      '-e',
      'try{process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8").trim().split("\\n").slice(-5).join(" | "))}catch{}',
      file,
    ],
    { uid: cfg.drillUser.uid, gid: cfg.drillUser.gid, allowFail: true },
  );
  return r.stdout.slice(0, 800);
}

function pruneReports(cfg, now) {
  const dir = join(cfg.root, 'drills');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const m = /^(remana-[a-z0-9-]+-\d{8}T\d{6}Z)\.drill\.json$/.exec(f);
    const p = m ? parseBackupId(m[1]) : null;
    if (p && p.env === cfg.env && now.getTime() - p.at.getTime() > REPORT_KEEP_DAYS * 86_400_000) {
      rmSync(join(dir, f), { force: true });
    }
  }
}

/** Runs one drill. Never throws for a failed drill (recorded and returned); throws only when the lock is held. */
export async function runDrill(
  cfg,
  { tools = localTools, clock = () => new Date(), backup: wanted = null, log = noop } = {},
) {
  ensureDirs(cfg);
  const lock = acquireLock(cfg.root, 'restore drill');
  const startedAt = clock();
  const drillId = backupId(cfg.env, startedAt);
  const report = {
    runId: drillId,
    backupId: null,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    outcome: 'failed',
    restoreMs: null,
    totalMs: null,
    dumpBytes: null,
    restoredBytes: null,
    checks: [],
    error: null,
    standby: null,
  };
  const user = cfg.drillUser;
  const scratchRoot = join(cfg.root, '.drill');
  const scratch = join(scratchRoot, drillId);
  let serverStarted = false;
  const dataDir = join(scratch, 'data');
  // The socket lives on the container's tmpfs: some bind mounts (Docker Desktop) cannot hold Unix sockets.
  const sockDir = join(cfg.socketBase ?? '/tmp', `remyral-drill-${drillId.slice(-16)}`);
  try {
    // Leftovers of an interrupted drill.
    if (existsSync(scratchRoot))
      for (const d of readdirSync(scratchRoot)) await removeAsDrillUser(tools, cfg, join(scratchRoot, d));

    const backups = listBackups(cfg);
    const chosen = wanted ? backups.find((b) => b.id === wanted) : backups[0];
    if (!chosen) throw new Error(wanted ? `backup ${wanted} not found` : 'no local backup to restore');
    report.backupId = chosen.id;
    const { manifest } = chosen;
    const dumpPath = join(cfg.root, localFiles(chosen.id).dump);

    const actual = await sha256File(dumpPath);
    report.dumpBytes = actual.bytes;
    const intact = actual.sha256 === manifest.files.db.sha256 && actual.bytes === manifest.files.db.bytes;
    report.checks.push({
      name: 'dump_integrity',
      ok: intact,
      detail: intact
        ? `${String(actual.bytes)} bytes, SHA-256 matches the manifest`
        : 'size or SHA-256 differs from the manifest',
    });
    if (!intact) throw new Error('the dump does not match its manifest');

    const fs = statfsSync(cfg.root);
    const free = Number(fs.bavail) * Number(fs.bsize);
    const need = actual.bytes * 4 + 512 * 1024 * 1024;
    if (free < need)
      throw new Error(`not enough free disk for a drill (${String(free)} free, ${String(need)} needed)`);

    mkdirSync(scratchRoot, { recursive: true, mode: 0o711 });
    chmodSync(scratchRoot, 0o711);
    mkdirSync(scratch, { mode: 0o700 });
    rmSync(sockDir, { recursive: true, force: true });
    mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    chownSync(scratch, user.uid, user.gid);
    chownSync(sockDir, user.uid, user.gid);
    const asUser = { uid: user.uid, gid: user.gid };

    log(`drill: restoring ${chosen.id} into a throw-away server`);
    await tools.run(
      'initdb',
      ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-instructions'],
      { ...asUser, cwd: scratch },
    );
    try {
      await tools.run(
        'pg_ctl',
        [
          '-D',
          dataDir,
          '-l',
          join(scratch, 'server.log'),
          '-w',
          '-t',
          '180',
          '-o',
          scratchServerOptions(sockDir),
          'start',
        ],
        {
          ...asUser,
          cwd: scratch,
        },
      );
    } catch (err) {
      throw new Error(
        `the throw-away server did not start: ${await serverLogTail(tools, cfg, join(scratch, 'server.log'))}`,
        { cause: err },
      );
    }
    serverStarted = true;
    const sockEnv = { PGHOST: sockDir, PGUSER: 'postgres', PGPASSWORD: '', PGDATABASE: 'postgres' };
    const admin = PsqlSession.open(tools, { env: sockEnv, ...asUser });
    try {
      for (const role of DRILL_ROLES) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await admin.query('CREATE DATABASE remyral OWNER remyral_owner');
    } finally {
      await admin.close();
    }

    const t0 = Date.now();
    const fd = openSync(dumpPath, 'r');
    try {
      await tools.run('pg_restore', ['--exit-on-error', '--no-password', '--dbname=remyral'], {
        ...asUser,
        stdin: fd,
        env: sockEnv,
      });
    } finally {
      closeSync(fd);
    }
    report.restoreMs = Date.now() - t0;

    const session = PsqlSession.open(tools, { env: { ...sockEnv, PGDATABASE: 'remyral' }, ...asUser });
    try {
      for (const s of SESSION_SETTINGS) await session.query(s);
      const migrations = existsSync(cfg.migrationsDir) ? loadMigrationFiles(cfg.migrationsDir) : null;
      report.checks.push(
        ...(await verifyRestored({ queryJson: (sql) => session.queryJson(sql), manifest, migrations })),
      );
      report.restoredBytes = Number(await session.queryJson("SELECT to_json(pg_database_size('remyral'))"));
    } finally {
      await session.close();
    }
    // p11-master-resilience: with WAL archiving on, also restore the newest base + local WAL (standby path).
    if (cfg.walArchive?.enabled) {
      if (serverStarted) {
        await tools.run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
          uid: user.uid,
          gid: user.gid,
          allowFail: true,
        });
        serverStarted = false;
      }
      const standbyDir = join(scratchRoot, `${drillId}-standby`);
      try {
        const r = await runStandbyDrill(cfg, {
          tools,
          scratchDir: standbyDir,
          sockDir,
          serverOptions: scratchServerOptions,
          clock,
          log,
        });
        report.checks.push(...r.checks);
        report.standby = r.standby;
      } finally {
        await removeAsDrillUser(tools, cfg, standbyDir).catch(noop);
      }
    }
    report.outcome = report.checks.every((c) => c.ok) ? 'passed' : 'failed';
    if (report.outcome === 'failed')
      report.error = `checks failed: ${report.checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(', ')}`;
  } catch (err) {
    report.outcome = 'failed';
    report.error = errorText(err);
  } finally {
    if (serverStarted) {
      await tools.run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
        uid: user.uid,
        gid: user.gid,
        allowFail: true,
      });
    }
    await removeAsDrillUser(tools, cfg, scratch).catch(noop);
    await removeAsDrillUser(tools, cfg, sockDir).catch(noop);
    const finished = clock();
    report.finishedAt = finished.toISOString();
    report.totalMs = finished.getTime() - startedAt.getTime();
    try {
      const file = join(cfg.root, drillReportFile(drillId));
      writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      pruneReports(cfg, finished);
      writeStatus(cfg.statusDir, recordDrill(readStatus(cfg.statusDir, cfg.env), report), finished);
    } finally {
      lock.release();
    }
  }
  return report;
}
