import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISK_HYGIENE_MARGIN_BYTES,
  DISK_HYGIENE_FEATURE,
  DiskHygieneReport,
  DiskHygieneRun,
  DiskHygieneSettings,
  OPS_KINDS,
  OpsOperation,
  OpsUpdatePayload,
  WorkerConfigSpec,
  WorkerFeatureList,
  WorkerToMaster,
} from '../src/index.js';
import { envelope, workerId, workerMessages } from './fixtures.js';

/**
 * p17-disk-selfclean: the worker's own disk cleanup on the wire — CAPABILITIES.diskHygiene, the `disk.clean` op and its
 * OPS_UPDATE, `workspace.diskHygiene` in the config, the `disk-hygiene-v1` feature.
 */

const GiB = 1024 ** 3;

const run = {
  trigger: 'low_disk',
  startedAt: '2026-10-25T10:00:00.000Z',
  finishedAt: '2026-10-25T10:00:09.000Z',
  freeBefore: GiB / 2,
  freeAfter: 3 * GiB,
  freedBytes: 2.5 * GiB,
  freed: [
    { category: 'temp', bytes: GiB / 2, items: 4 },
    { category: 'packageCaches', bytes: 2 * GiB, items: 1 },
  ],
  stillLow: false,
  errors: 0,
};

const report = {
  enabled: true,
  thresholdBytes: 2 * GiB,
  marginBytes: GiB,
  targetBytes: 3 * GiB,
  freeBytes: 3 * GiB,
  checkedAt: '2026-10-25T10:00:09.000Z',
  running: false,
  lastRun: run,
  nextLowDiskAt: '2026-10-25T10:30:09.000Z',
  nextDailyAt: '2026-10-26T09:00:00.000Z',
  usage: {
    at: '2026-10-25T10:00:09.000Z',
    dataDir: [
      { name: 'runtimes', bytes: GiB },
      { name: 'workspace-root', bytes: 9 * GiB },
      { name: 'other', bytes: 10 },
    ],
    workspaceRoot: [{ name: 'mirrors', bytes: 9 * GiB }],
  },
};

describe('disk hygiene wire (p17-disk-selfclean)', () => {
  it('the report and a run parse; categories, triggers and usage names are closed', () => {
    expect(DiskHygieneReport.parse(report)).toEqual(report);
    expect(DiskHygieneRun.safeParse({ ...run, trigger: 'cron' }).success).toBe(false);
    expect(
      DiskHygieneRun.safeParse({ ...run, freed: [{ category: 'docker', bytes: 1, items: 1 }] }).success,
    ).toBe(false);
    expect(DiskHygieneRun.safeParse({ ...run, freedBytes: -1 }).success).toBe(false);
    // A user's file or directory name can never be a usage entry.
    const named = (name: string) =>
      DiskHygieneReport.safeParse({
        ...report,
        usage: { ...report.usage, dataDir: [{ name, bytes: 1 }] },
      }).success;
    expect(named('caches')).toBe(true);
    expect(named('My Documents')).toBe(false);
    expect(named('../etc')).toBe(false);
    expect(DiskHygieneReport.safeParse({ ...report, lastRun: null, usage: null }).success).toBe(true);
  });

  it('CAPABILITIES carries diskHygiene with the feature; older messages without it still parse', () => {
    const caps = envelope('CAPABILITIES', {
      workerId,
      payload: {
        ...(workerMessages.CAPABILITIES.payload as Record<string, unknown>),
        features: ['remote-ops-v1', DISK_HYGIENE_FEATURE],
        diskHygiene: report,
      },
    });
    const parsed = WorkerToMaster.parse(caps);
    if (parsed.type !== 'CAPABILITIES') throw new Error(parsed.type);
    expect(parsed.payload.diskHygiene?.lastRun?.freedBytes).toBe(2.5 * GiB);
    expect(parsed.payload.features).toContain('disk-hygiene-v1');
    expect(WorkerToMaster.safeParse(workerMessages.CAPABILITIES).success).toBe(true);
    expect(WorkerFeatureList.parse([DISK_HYGIENE_FEATURE])).toEqual(['disk-hygiene-v1']);
  });

  it('disk.clean is an op without parameters; OPS_UPDATE carries the run', () => {
    expect(OPS_KINDS).toContain('disk.clean');
    expect(OpsOperation.parse({ kind: 'disk.clean', paths: ['/'] })).toEqual({ kind: 'disk.clean' });
    const u = OpsUpdatePayload.parse({
      commandId: '6f9c2e1a-3b4d-4c5e-8f60-718293a4b5c6',
      seq: 2,
      kind: 'disk.clean',
      state: 'succeeded',
      diskClean: run,
    });
    expect(u.diskClean?.freed).toHaveLength(2);
  });

  it('workspace.diskHygiene in the config: on / off and a bounded margin; absent means on', () => {
    const spec = (diskHygiene?: unknown) =>
      WorkerConfigSpec.safeParse({
        projects: [],
        allowedRuntimes: ['codex'],
        maxParallelJobs: 1,
        sandboxProfiles: [],
        workspace: diskHygiene === undefined ? {} : { diskHygiene },
        labels: {},
        runtimes: {},
      }).success;
    expect(spec()).toBe(true);
    expect(spec({ enabled: false })).toBe(true);
    expect(spec({ enabled: true, marginBytes: 5 * GiB })).toBe(true);
    expect(spec({ enabled: true, marginBytes: -1 })).toBe(false);
    expect(spec({ enabled: true, marginBytes: 2 * 1024 ** 4 })).toBe(false);
    expect(spec({ marginBytes: GiB })).toBe(false);
    expect(DiskHygieneSettings.parse({ enabled: true })).toEqual({ enabled: true });
    expect(DEFAULT_DISK_HYGIENE_MARGIN_BYTES).toBe(GiB);
  });
});
