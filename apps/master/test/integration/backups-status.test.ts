import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

/**
 * p10-backup-restore §6: GET /backups/status (owners/admins only, status only) and the backup / restore-drill
 * notifications raised from the backup service's status files — once per event.
 */
const PASSWORD = 'quartz-meadow-lantern-7';

describeIntegration('backups status API and notifications (integration)', () => {
  const h = new Harness();
  const dir = mkdtempSync(join(tmpdir(), 'remyral-backups-it-'));
  let owner: Client;
  let ownerId: string;
  let adminId: string;
  let operatorId: string;
  let operator: Client;

  const iso = (msAgo: number) => new Date(h.clock.now().getTime() - msAgo).toISOString();
  const run = (over: Record<string, unknown> = {}) => ({
    runId: 'remana-prod-20261012T023000Z',
    startedAt: iso(9 * 3_600_000),
    finishedAt: iso(9 * 3_600_000 - 4000),
    durationMs: 4000,
    outcome: 'ok',
    tier: 'daily',
    schemaVersion: '0075',
    dbBytes: 1024,
    dbSha256: 'a'.repeat(64),
    secrets: 'ok',
    offsite: { status: 'not_configured', target: null, error: null },
    warnings: [],
    error: null,
    ...over,
  });
  const drill = (over: Record<string, unknown> = {}) => ({
    runId: 'remana-prod-20261012T040000Z',
    backupId: 'remana-prod-20261012T023000Z',
    startedAt: iso(8 * 3_600_000),
    finishedAt: iso(8 * 3_600_000 - 9000),
    outcome: 'passed',
    restoreMs: 1200,
    totalMs: 9000,
    dumpBytes: 1024,
    restoredBytes: 9000,
    checks: [{ name: 'row_counts', ok: true, detail: '170 tables match' }],
    error: null,
    ...over,
  });
  function write(status: Record<string, unknown>, heartbeatAgoMs = 60_000) {
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({
        format: 'remana-backup-status/v1',
        env: 'prod',
        updatedAt: iso(0),
        offsite: { configured: false, target: null, lastUploadAt: null, lastError: null },
        encryption: { configured: true, recipients: 2 },
        storage: { backups: 1, bytes: 2048, freeBytes: 1_000_000 },
        lastBackup: run(),
        lastSuccessfulBackup: run(),
        backups: [run()],
        lastDrill: drill(),
        lastSuccessfulDrill: drill(),
        drills: [drill()],
        ...status,
      }),
    );
    writeFileSync(
      join(dir, 'heartbeat.json'),
      JSON.stringify({
        format: 'remana-backup-heartbeat/v1',
        env: 'prod',
        at: iso(heartbeatAgoMs),
        startedAt: iso(48 * 3_600_000),
        nextBackupAt: iso(-15 * 3_600_000),
        nextDrillAt: iso(-6 * 86_400_000),
        expectedIntervalMs: 86_400_000,
        schedule: { mode: 'daily', intervalMinutes: null, timeOfDay: '02:30', drill: 'weekly sun 04:00' },
        retention: { daily: 7, weekly: 4, monthly: 3, keepRecentHours: 0 },
      }),
    );
  }
  async function notes(userId: string) {
    const { rows } = await h.db.pool.query<{ kind: string; severity: string; title: string; link: string }>(
      "SELECT kind, severity, title, link FROM notifications WHERE recipient_id = $1 AND kind IN ('backup.failed', 'restore_drill.failed') ORDER BY created_at, title",
      [userId],
    );
    return rows;
  }

  beforeAll(async () => {
    await h.start({ backups: { statusDir: dir } });
    ownerId = await h.createUser('bk-owner', PASSWORD, 'owner');
    adminId = await h.createUser('bk-admin', PASSWORD, 'admin');
    operatorId = await h.createUser('bk-operator', PASSWORD, 'operator');
    owner = (await enroll(h, 'bk-owner', PASSWORD)).client;
    operator = (await enroll(h, 'bk-operator', PASSWORD)).client;
  });
  afterAll(async () => {
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('owners see the status; operators are refused', async () => {
    const empty = await owner.req('GET', '/backups/status');

    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      configured: true,
      health: { state: 'not_configured' },
      lastBackup: null,
    });

    write({});
    const res = await owner.req('GET', '/backups/status');
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      env: 'prod',
      health: { state: 'ok', reasons: [{ level: 'info', code: 'no_offsite' }] },
      lastBackup: { runId: 'remana-prod-20261012T023000Z', outcome: 'ok' },
      lastDrill: { outcome: 'passed' },
      heartbeat: { schedule: { timeOfDay: '02:30' } },
    });
    // no off-site configured is information, not a warning
    expect(JSON.stringify(body)).not.toMatch(/sha256":"a{64}/); // the dump hash is not part of the API body
    expect((await operator.req('GET', '/backups/status')).statusCode).toBe(403);
    expect(body.standby).toMatchObject({ enabled: false, lastStandbyDrill: null, lastBaseBackup: null });
  });

  it('p11-master-resilience: standby readiness from standby.json and the last standby drill', async () => {
    const base = {
      id: 'remana-prod-20261012T023100Z',
      startedAt: iso(9 * 3_600_000),
      finishedAt: iso(9 * 3_600_000 - 4000),
      outcome: 'ok',
      bytes: 5_000_000,
      startWalFile: '000000010000000000000004',
      offsite: { status: 'uploaded', error: null },
      error: null,
    };
    const standbyDrill = drill({
      standby: {
        at: iso(8 * 3_600_000),
        outcome: 'passed',
        baseId: base.id,
        targetTime: iso(8.1 * 3_600_000),
        recoveredTo: iso(8.2 * 3_600_000),
        replayedSegments: 12,
        restoreMs: 3000,
        error: null,
      },
    });
    write({ drills: [standbyDrill], lastDrill: standbyDrill, lastSuccessfulDrill: standbyDrill });
    writeFileSync(
      join(dir, 'standby.json'),
      JSON.stringify({
        format: 'remana-backup-standby/v1',
        env: 'prod',
        updatedAt: iso(0),
        walArchive: { enabled: true },
        lastShippedSegment: '000000010000000000000010',
        lastShippedAt: iso(30_000),
        lastArchivedSegment: '000000010000000000000010',
        lastArchivedAt: iso(40_000),
        pendingSegments: 4,
        lagSeconds: 720,
        localSegments: 13,
        localBytes: 1000,
        offsite: { configured: true, target: 's3://b/remyral/ @ x', lastError: null },
        gaps: [],
        lastBaseBackup: base,
        lastSuccessfulBaseBackup: base,
      }),
    );
    try {
      const body = (await owner.req('GET', '/backups/status')).json<Record<string, unknown>>();
      expect(body.standby).toEqual({
        enabled: true,
        lastShippedSegment: '000000010000000000000010',
        lastShippedAt: iso(30_000),
        lastArchivedSegment: '000000010000000000000010',
        lastArchivedAt: iso(40_000),
        lagSeconds: 720,
        pendingSegments: 4,
        localSegments: 13,
        offsiteConfigured: true,
        lastError: null,
        gaps: [],
        lastBaseBackup: {
          id: base.id,
          startedAt: base.startedAt,
          finishedAt: base.finishedAt,
          outcome: 'ok',
          bytes: 5_000_000,
          offsite: 'uploaded',
          error: null,
        },
        lastSuccessfulBaseBackupAt: base.finishedAt,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
        lastStandbyDrill: expect.objectContaining({
          outcome: 'passed',
          replayedSegments: 12,
          baseId: base.id,
        }),
      });
      expect(body.health).toMatchObject({ state: 'warning' });
      expect(JSON.stringify(body.health)).toMatch(/wal_lag/);
    } finally {
      rmSync(join(dir, 'standby.json'), { force: true });
      write({});
    }
  });

  it('a failed backup and a failed drill notify owners and admins once each', async () => {
    write({
      lastBackup: run({
        runId: 'remana-prod-20261012T110000Z',
        outcome: 'failed',
        error: 'pg_dump exited 1',
      }),
      lastDrill: drill({
        runId: 'remana-prod-20261012T111500Z',
        outcome: 'failed',
        error: 'checks failed: audit_chain',
        checks: [{ name: 'audit_chain', ok: false, detail: 'broken at 7 (hash_mismatch)' }],
      }),
    });
    expect(await h.app.backups.tick()).toBe(4); // 2 events × (owner + admin)
    expect(await h.app.backups.tick()).toBe(0);
    for (const id of [ownerId, adminId]) {
      expect(await notes(id)).toEqual([
        {
          kind: 'backup.failed',
          severity: 'critical',
          title: 'Backup failed: remana-prod-20261012T110000Z',
          link: '/settings/backups',
        },
        {
          kind: 'restore_drill.failed',
          severity: 'critical',
          title: 'Restore drill failed: remana-prod-20261012T023000Z',
          link: '/settings/backups',
        },
      ]);
    }
    expect(await notes(operatorId)).toEqual([]);
    const res = await owner.req('GET', '/backups/status');
    expect(res.json<{ health: { state: string } }>().health.state).toBe('failing');
  });

  it('a silent backup service is reported once per outage', async () => {
    write({}, 2 * 3_600_000);
    const created = await h.app.backups.tick();
    expect(created).toBe(2);
    expect(await h.app.backups.tick()).toBe(0);
    const titles = (await notes(ownerId)).map((n) => n.title);
    expect(titles).toContain('Backup service stopped');
  });
});
