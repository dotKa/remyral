import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assessBackups, backupNotifications } from '../../src/backups/health.js';
import { type BackupFiles, readBackupFiles, STATUS_MAX_BYTES } from '../../src/backups/status.js';

/** p10-backup-restore §6: health and notification rules over the backup service's status files. */

const NOW = new Date('2026-10-18T10:00:00.000Z');
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function run(over: Record<string, unknown> = {}) {
  return {
    runId: 'remana-prod-20261018T023000Z',
    startedAt: iso(7.5 * H),
    finishedAt: iso(7.4 * H),
    durationMs: 4000,
    outcome: 'ok' as const,
    tier: 'daily' as const,
    schemaVersion: '0075',
    dbBytes: 1000,
    dbSha256: 'a'.repeat(64),
    secrets: 'ok' as const,
    offsite: { status: 'uploaded' as const, target: 's3://b/remyral/ @ x', error: null },
    warnings: [],
    error: null,
    ...over,
  };
}
function drill(over: Record<string, unknown> = {}) {
  return {
    runId: 'remana-prod-20261018T040000Z',
    backupId: 'remana-prod-20261018T023000Z',
    startedAt: iso(6 * H),
    finishedAt: iso(6 * H - 9000),
    outcome: 'passed' as const,
    restoreMs: 5000,
    totalMs: 9000,
    dumpBytes: 1000,
    restoredBytes: 9000,
    checks: [{ name: 'row_counts', ok: true, detail: 'ok' }],
    error: null,
    ...over,
  };
}
function files(
  over: { status?: Record<string, unknown>; heartbeat?: Record<string, unknown> | null } = {},
): BackupFiles {
  const r = run();
  const d = drill();
  return {
    problems: [],
    status: {
      format: 'remana-backup-status/v1',
      env: 'prod',
      updatedAt: iso(H),
      offsite: {
        configured: true,
        target: 's3://b/remyral/ @ x',
        lastUploadAt: r.finishedAt,
        lastError: null,
      },
      encryption: { configured: true, recipients: 2 },
      storage: { backups: 3, bytes: 3000, freeBytes: 10_000 },
      lastBackup: r,
      lastSuccessfulBackup: r,
      backups: [r],
      lastDrill: d,
      lastSuccessfulDrill: d,
      drills: [d],
      ...over.status,
    },
    heartbeat:
      over.heartbeat === null
        ? null
        : {
            format: 'remana-backup-heartbeat/v1',
            env: 'prod',
            at: iso(60_000),
            startedAt: iso(48 * H),
            nextBackupAt: '2026-10-19T02:30:00.000Z',
            nextDrillAt: '2026-10-25T04:00:00.000Z',
            expectedIntervalMs: 24 * H,
            schedule: { mode: 'daily', intervalMinutes: null, timeOfDay: '02:30', drill: 'weekly sun 04:00' },
            retention: { daily: 7, weekly: 4, monthly: 3, keepRecentHours: 0 },
            ...over.heartbeat,
          },
  };
}

describe('backup health', () => {
  it('ok when everything reported recently succeeded', () => {
    expect(assessBackups(files(), NOW)).toEqual({ state: 'ok', reasons: [] });
    expect(backupNotifications(files(), NOW)).toEqual([]);
  });

  it('not configured before the service ever reported', () => {
    const h = assessBackups({ status: null, heartbeat: null, problems: [] }, NOW);
    expect(h.state).toBe('not_configured');
    expect(backupNotifications({ status: null, heartbeat: null, problems: [] }, NOW)).toEqual([]);
  });

  it('failed backup → failing + one critical backup.failed per run', () => {
    const failed = run({
      runId: 'remana-prod-20261018T090000Z',
      outcome: 'failed',
      error: 'pg_dump exited 1',
    });
    const f = files({ status: { lastBackup: failed } });
    const h = assessBackups(f, NOW);
    expect(h.state).toBe('failing');
    expect(h.reasons.map((r) => r.code)).toContain('backup_failed');
    const n = backupNotifications(f, NOW);
    expect(n).toEqual([
      expect.objectContaining({
        kind: 'backup.failed',
        severity: 'critical',
        dedupeKey: 'backup.failed:remana-prod-20261018T090000Z',
        link: '/settings/backups',
      }),
    ]);
    // The error text of the file is not copied into the notification.
    expect(JSON.stringify(n)).not.toContain('pg_dump exited 1');
  });

  it('partial backup (off-site failed) → warning notification naming what failed', () => {
    const partial = run({
      outcome: 'partial',
      offsite: { status: 'failed', target: 'x', error: 'HTTP 403' },
    });
    const n = backupNotifications(files({ status: { lastBackup: partial } }), NOW);
    expect(n[0]).toMatchObject({ kind: 'backup.failed', severity: 'warning' });
    expect(n[0]?.body).toContain('the off-site copy');
    expect(assessBackups(files({ status: { lastBackup: partial } }), NOW).state).toBe('warning');
  });

  it('overdue backups and a silent service', () => {
    const old = run({ finishedAt: iso(40 * H), startedAt: iso(40 * H) });
    const f = files({
      status: { lastBackup: old, lastSuccessfulBackup: old },
      heartbeat: { at: iso(2 * H) },
    });
    const h = assessBackups(f, NOW);
    expect(h.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['backup_overdue', 'service_stopped']),
    );
    const keys = backupNotifications(f, NOW).map((d) => d.dedupeKey);
    expect(keys).toEqual(
      expect.arrayContaining(['backup.overdue:remana-prod-20261018T023000Z', `backup.service:${iso(2 * H)}`]),
    );
    // interval mode: 1 h backups are overdue after 2.5 h
    const hourly = files({ heartbeat: { expectedIntervalMs: H } });
    expect(assessBackups(hourly, NOW).reasons.map((r) => r.code)).toContain('backup_overdue');
  });

  it('failed drill → restore_drill.failed with the failed check names; overdue drill → warning', () => {
    const bad = drill({
      outcome: 'failed',
      checks: [{ name: 'audit_chain', ok: false, detail: 'broken at 7' }],
    });
    const n = backupNotifications(files({ status: { lastDrill: bad } }), NOW);
    expect(n[0]).toMatchObject({
      kind: 'restore_drill.failed',
      severity: 'critical',
      dedupeKey: `restore_drill.failed:${bad.runId}`,
    });
    expect(n[0]?.body).toContain('audit_chain');
    const stale = drill({ startedAt: iso(9 * 24 * H) });
    const s = backupNotifications(files({ status: { lastDrill: stale, lastSuccessfulDrill: stale } }), NOW);
    expect(s).toEqual([
      expect.objectContaining({
        kind: 'restore_drill.failed',
        severity: 'warning',
        dedupeKey: `restore_drill.overdue:${stale.runId}`,
      }),
    ]);
    // drills switched off: no overdue alarm
    expect(
      backupNotifications(
        files({ status: { lastDrill: stale, lastSuccessfulDrill: stale }, heartbeat: { nextDrillAt: null } }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('missing owner key and off-site are reported in the console', () => {
    const h = assessBackups(
      files({
        status: {
          encryption: { configured: false, recipients: 0 },
          offsite: { configured: false, target: null, lastUploadAt: null, lastError: null },
        },
      }),
      NOW,
    );
    expect(h.state).toBe('warning');
    expect(h.reasons.map((r) => [r.code, r.level])).toEqual([
      ['no_owner_key', 'warning'],
      ['no_offsite', 'info'],
    ]);
  });
});

describe('status files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remyral-backup-status-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing files are not problems; malformed and oversized ones are', async () => {
    expect(await readBackupFiles(dir)).toEqual({
      status: null,
      heartbeat: null,
      standby: null,
      problems: [],
    });
    writeFileSync(join(dir, 'status.json'), '{"format":"other"}');
    writeFileSync(join(dir, 'heartbeat.json'), 'x'.repeat(STATUS_MAX_BYTES + 10));
    const r = await readBackupFiles(dir);
    expect(r.status).toBeNull();
    expect(r.problems).toEqual([
      'status.json has an unexpected format',
      'heartbeat.json could not be read (file too large)',
    ]);
  });

  it('parses a valid file and truncates long strings', async () => {
    const f = files();
    const long = run({ error: 'e'.repeat(5000), outcome: 'failed' });
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...f.status, lastBackup: long }));
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify(f.heartbeat));
    const r = await readBackupFiles(dir);
    expect(r.problems).toEqual([]);
    expect(r.status?.lastBackup?.error).toHaveLength(500);
    expect(r.heartbeat?.schedule.timeOfDay).toBe('02:30');
  });
});

/** p11-master-resilience: standby readiness (WAL shipping, base backups) in health, notifications and parsing. */
describe('standby readiness', () => {
  function standby(over: Record<string, unknown> = {}) {
    const base = {
      id: 'remana-prod-20261018T023100Z',
      startedAt: iso(7.4 * H),
      finishedAt: iso(7.3 * H),
      outcome: 'ok' as const,
      bytes: 5_000_000,
      startWalFile: '000000010000000000000004',
      offsite: { status: 'uploaded' as const, error: null },
      error: null,
    };
    return {
      format: 'remana-backup-standby/v1' as const,
      env: 'prod',
      updatedAt: iso(30_000),
      walArchive: { enabled: true },
      lastShippedSegment: '000000010000000000000009',
      lastShippedAt: iso(60_000),
      lastArchivedSegment: '000000010000000000000009',
      lastArchivedAt: iso(70_000),
      pendingSegments: 0,
      lagSeconds: 0,
      localSegments: 6,
      localBytes: 100_000,
      offsite: { configured: true, target: 's3://b/remyral/ @ x', lastError: null as string | null },
      gaps: [] as string[],
      lastBaseBackup: base,
      lastSuccessfulBaseBackup: base,
      ...over,
    };
  }
  const withStandby = (over: Record<string, unknown> = {}): BackupFiles => ({
    ...files(),
    standby: standby(over),
  });

  it('healthy standby adds nothing; disabled or absent standby is ignored', () => {
    expect(assessBackups(withStandby(), NOW)).toEqual({ state: 'ok', reasons: [] });
    expect(
      assessBackups(withStandby({ walArchive: { enabled: false }, lagSeconds: 99_999 }), NOW).state,
    ).toBe('ok');
    expect(backupNotifications(withStandby(), NOW)).toEqual([]);
  });

  it('WAL lag: warning over 10 min, failing over 60 min, one notification per stuck segment over 30 min', () => {
    expect(assessBackups(withStandby({ lagSeconds: 11 * 60, pendingSegments: 3 }), NOW)).toEqual({
      state: 'warning',
      reasons: [expect.objectContaining({ code: 'wal_lag', level: 'warning' })],
    });
    expect(backupNotifications(withStandby({ lagSeconds: 11 * 60 }), NOW)).toEqual([]);
    const f = withStandby({ lagSeconds: 65 * 60, pendingSegments: 20 });
    expect(assessBackups(f, NOW).state).toBe('failing');
    expect(backupNotifications(f, NOW)).toEqual([
      expect.objectContaining({
        kind: 'backup.failed',
        severity: 'critical',
        dedupeKey: 'standby.wal_lag:000000010000000000000009',
      }),
    ]);
  });

  it('gaps fail; upload errors, a failed or missing base backup warn', () => {
    expect(assessBackups(withStandby({ gaps: ['000000010000000000000007'] }), NOW).state).toBe('failing');
    const codes = (o: Record<string, unknown>) =>
      assessBackups(withStandby(o), NOW).reasons.map((r) => r.code);
    expect(codes({ offsite: { configured: true, target: null, lastError: 'HTTP 403' } })).toEqual([
      'wal_error',
    ]);
    expect(codes({ offsite: { configured: false, target: null, lastError: null } })).toEqual([
      'wal_local_only',
    ]);
    expect(codes({ lastSuccessfulBaseBackup: null, lastBaseBackup: null })).toEqual(['no_base']);
    const failedBase = {
      ...standby().lastBaseBackup,
      id: 'remana-prod-20261018T090000Z',
      outcome: 'failed',
      error: 'tar exited 2',
    };
    expect(codes({ lastBaseBackup: failedBase })).toEqual(['base_failed']);
    expect(backupNotifications(withStandby({ lastBaseBackup: failedBase }), NOW)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        dedupeKey: 'standby.base:remana-prod-20261018T090000Z',
      }),
    ]);
    const old = { ...standby().lastBaseBackup, finishedAt: iso(31 * H) };
    expect(codes({ lastSuccessfulBaseBackup: old })).toEqual(['base_overdue']);
  });

  it('standby.json is read and validated; an absent file is not a problem', async () => {
    const sdir = mkdtempSync(join(tmpdir(), 'remyral-standby-'));
    try {
      expect((await readBackupFiles(sdir)).standby).toBeNull();
      writeFileSync(join(sdir, 'standby.json'), JSON.stringify({ ...standby(), lagSeconds: 'x', extra: 1 }));
      const r = await readBackupFiles(sdir);
      expect(r.problems).toEqual([]);
      expect(r.standby).toMatchObject({ lagSeconds: 0, lastShippedSegment: '000000010000000000000009' });
      writeFileSync(join(sdir, 'standby.json'), JSON.stringify({ format: 'other' }));
      expect((await readBackupFiles(sdir)).problems).toEqual(['standby.json has an unexpected format']);
    } finally {
      rmSync(sdir, { recursive: true, force: true });
    }
  });
});
