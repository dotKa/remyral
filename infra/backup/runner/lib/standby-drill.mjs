/* global setTimeout */
// Standby part of the weekly restore drill (p11-master-resilience): the newest local base backup is extracted into a
// throw-away data directory, the local WAL archive is replayed into it (restore_command), the server promotes at the
// end of the archive, and the result is checked — the same path a standby restore on a fresh host takes
// (scripts/ops/standby-restore.mjs), without any network (Unix socket only, like the logical drill).
import { chownSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAuditChain } from './audit-chain.mjs';
import { listBaseBackups } from './basebackup.mjs';
import { compareMigrations, loadMigrationFiles, PsqlSession, SESSION_SETTINGS, sha256File } from './pg.mjs';
import { errorText } from './status.mjs';
import { parseWalName, walChainSince, walGaps } from './wal.mjs';

const SAFE_PATH = /^\/[A-Za-z0-9/._-]+$/;

/** restore_command replaying the gzip'd local copies; a missing file ends recovery (exit ≠ 0, nothing written). */
export function localRestoreCommand(walDir) {
  if (!SAFE_PATH.test(walDir)) throw new Error('unsafe WAL directory path');
  return `test -f ${walDir}/%f.gz && gunzip -c ${walDir}/%f.gz > %p`;
}

/** Lines appended to postgresql.auto.conf of a restored base (later lines win). */
export function recoveryConf({ restoreCommand, targetTime = null }) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  return [
    '',
    '# remyral standby restore (p11-master-resilience): removed again after promotion',
    `restore_command = ${q(restoreCommand)}`,
    "recovery_target_timeline = 'latest'",
    ...(targetTime ? [`recovery_target_time = ${q(targetTime)}`, "recovery_target_action = 'promote'"] : []),
    "archive_mode = 'off'",
    '',
  ].join('\n');
}

/** Runs a small node script as the drill user (who owns the scratch directories). */
async function asDrillUser(tools, cfg, script, args) {
  return tools.run(process.execPath, ['-e', script, ...args], {
    uid: cfg.drillUser.uid,
    gid: cfg.drillUser.gid,
  });
}

const WRITE_FILES = `
const fs = require('node:fs');
const [dir, json] = process.argv.slice(1);
for (const [name, content, mode, append] of JSON.parse(json)) {
  const p = require('node:path').join(dir, name);
  if (append) fs.appendFileSync(p, content); else fs.writeFileSync(p, content, { mode });
}`;

/**
 * Restores the newest local base + WAL into `scratchDir` (created here, owned by the drill user) and checks it.
 * `serverOptions(sockDir)`: the throw-away server's options (drill.mjs scratchServerOptions). Returns
 * `{ checks, standby }`; never throws (failures become a failed check). The caller stops nothing: this function
 * stops its own server.
 */
export async function runStandbyDrill(
  cfg,
  { tools, scratchDir, sockDir, serverOptions, clock = () => new Date(), log = () => undefined },
) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: String(detail).slice(0, 500) });
  const standby = {
    at: clock().toISOString(),
    outcome: 'failed',
    baseId: null,
    targetTime: null,
    recoveredTo: null,
    replayedSegments: 0,
    restoreMs: null,
    error: null,
  };
  const user = { uid: cfg.drillUser.uid, gid: cfg.drillUser.gid };
  const dataDir = join(scratchDir, 'data');
  let started = false;
  try {
    const base = listBaseBackups(cfg)[0];
    if (!base) throw new Error('WAL archiving is on but there is no local base backup yet');
    standby.baseId = base.id;
    const tarPath = join(cfg.root, 'base', base.manifest.files.base.name);
    const actual = await sha256File(tarPath);
    const intact =
      actual.sha256 === base.manifest.files.base.sha256 && actual.bytes === base.manifest.files.base.bytes;
    add(
      'standby_base_integrity',
      intact,
      intact
        ? `${base.id}: ${String(actual.bytes)} bytes, SHA-256 matches`
        : `${base.id}: differs from its manifest`,
    );
    if (!intact) throw new Error('the base backup does not match its manifest');

    const walDir = join(cfg.root, 'wal');
    const local = existsSync(walDir)
      ? readdirSync(walDir)
          .filter((f) => f.endsWith('.gz') && parseWalName(f.slice(0, -3)))
          .map((f) => f.slice(0, -3))
      : [];
    const chain = walChainSince(local, base.manifest.startWalFile);
    const segments = chain.filter((n) => parseWalName(n).kind === 'segment');
    const gaps = walGaps(segments);
    const startPresent = segments.includes(base.manifest.startWalFile);
    add(
      'standby_wal_chain',
      startPresent && gaps.length === 0,
      startPresent && gaps.length === 0
        ? `${String(segments.length)} segments from ${base.manifest.startWalFile} to ${segments.at(-1)}`
        : `${startPresent ? '' : `start segment ${base.manifest.startWalFile} missing; `}${gaps.length ? `gaps at ${gaps.join(', ')}` : ''}`,
    );
    if (!startPresent || gaps.length > 0) throw new Error('the local WAL chain is incomplete');
    const newest = segments.at(-1);
    standby.targetTime = statSync(join(walDir, `${newest}.gz`)).mtime.toISOString();

    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    chownSync(scratchDir, user.uid, user.gid);
    await asDrillUser(tools, cfg, 'require("node:fs").mkdirSync(process.argv[1], { mode: 0o700 })', [
      dataDir,
    ]);
    const t0 = Date.now();
    await tools.run('tar', ['-x', '-z', '-f', tarPath, '-C', dataDir], { ...user });
    const files = [
      ['backup_label', base.manifest.labelFile, 0o600, false],
      ['recovery.signal', '', 0o600, false],
      ['postgresql.auto.conf', recoveryConf({ restoreCommand: localRestoreCommand(walDir) }), 0o600, true],
    ];
    if (base.manifest.tablespaceMap)
      files.push(['tablespace_map', base.manifest.tablespaceMap, 0o600, false]);
    await asDrillUser(tools, cfg, WRITE_FILES, [dataDir, JSON.stringify(files)]);
    await asDrillUser(tools, cfg, WRITE_FILES, [
      scratchDir,
      JSON.stringify([['pg_hba.conf', 'local all all trust\n', 0o600, false]]),
    ]);
    await asDrillUser(tools, cfg, 'require("node:fs").chmodSync(process.argv[1], 0o700)', [dataDir]);

    log(`drill: replaying ${String(segments.length)} WAL segments onto base ${base.id}`);
    const start = tools.run(
      'pg_ctl',
      [
        '-D',
        dataDir,
        '-l',
        join(scratchDir, 'server.log'),
        '-w',
        '-t',
        '900',
        '-o',
        // Hot standby needs max_connections etc. ≥ the primary's: keep the restored postgresql.conf values.
        `${serverOptions(sockDir).replace(/ ?-c max_connections=\d+/, '')} -c hba_file=${join(scratchDir, 'pg_hba.conf')} -c hot_standby=on`,
        'start',
      ],
      { ...user, cwd: scratchDir },
    );
    try {
      await start;
    } catch (err) {
      const tail = await tools
        .run(
          process.execPath,
          [
            '-e',
            'try{process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8").trim().split("\\n").slice(-6).join(" | "))}catch{}',
            join(scratchDir, 'server.log'),
          ],
          { ...user, allowFail: true },
        )
        .then((r) => r.stdout.slice(0, 900))
        .catch(() => '');
      throw new Error(`the standby server did not start: ${tail}`, { cause: err });
    }
    started = true;
    const env = { PGHOST: sockDir, PGUSER: 'postgres', PGPASSWORD: '', PGDATABASE: 'remyral' };
    const session = PsqlSession.open(tools, { env, ...user });
    try {
      let promoted = false;
      for (let i = 0; i < 900 && !promoted; i += 1) {
        promoted = (await session.queryJson('SELECT to_json(NOT pg_is_in_recovery())')) === true;
        if (!promoted) await new Promise((r) => setTimeout(r, 1000));
      }
      standby.restoreMs = Date.now() - t0;
      const replayed = await session.queryJson('SELECT to_json(pg_last_xact_replay_timestamp())');
      standby.recoveredTo = replayed === null ? null : new Date(replayed).toISOString();
      standby.replayedSegments = segments.length;
      add(
        'standby_replay',
        promoted,
        promoted
          ? `promoted after ${String(segments.length)} segments in ${String(standby.restoreMs)} ms; last replayed commit ${standby.recoveredTo ?? 'none since the base'}`
          : 'still in recovery after 15 minutes',
      );
      if (!promoted) throw new Error('the standby did not promote');
      for (const s of SESSION_SETTINGS) await session.query(s);
      const applied =
        (await session.queryJson(
          "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN '[]'::json ELSE (SELECT coalesce(json_agg(json_build_object('version', version, 'checksum', checksum) ORDER BY version), '[]'::json) FROM schema_migrations) END",
        )) ?? [];
      if (existsSync(cfg.migrationsDir)) {
        const cmp = compareMigrations(applied, loadMigrationFiles(cfg.migrationsDir));
        add(
          'standby_schema',
          cmp.ok && applied.length >= base.manifest.schema.count,
          cmp.ok
            ? `${String(applied.length)} applied migrations match this release (base had ${String(base.manifest.schema.count)})`
            : `unknown: ${cmp.unknown.join(', ') || '-'}; edited: ${cmp.mismatched.join(', ') || '-'}`,
        );
      }
      const hasAudit =
        (await session.queryJson("SELECT to_json(to_regclass('public.audit_events') IS NOT NULL)")) === true;
      if (hasAudit) {
        const chainRes = await verifyAuditChain((sql) => session.queryJson(sql));
        add(
          'standby_audit_chain',
          chainRes.ok,
          chainRes.ok
            ? `${String(chainRes.checked)} events verified; head ${chainRes.headId ?? '∅'}`
            : `broken at ${chainRes.brokenAtId} (${chainRes.reason})`,
        );
      }
    } finally {
      await session.close();
    }
    standby.outcome = checks.every((c) => c.ok) ? 'passed' : 'failed';
    if (standby.outcome === 'failed')
      standby.error = `checks failed: ${checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(', ')}`;
  } catch (err) {
    standby.outcome = 'failed';
    standby.error = errorText(err);
    if (!checks.some((c) => !c.ok)) add('standby_replay', false, standby.error);
  } finally {
    if (started) {
      await tools.run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
        ...user,
        allowFail: true,
      });
    }
  }
  return { checks, standby };
}
