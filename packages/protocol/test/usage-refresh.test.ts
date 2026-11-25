import { describe, expect, it } from 'vitest';
import {
  OpsOperation,
  OpsUpdatePayload,
  RuntimeUsageSnapshot,
  USAGE_REFRESH_FEATURE,
  UsageIdentity,
  UsageRefreshReport,
  WorkerFeature,
} from '../src/index.js';

/** p15-usage-refresh (docs/design/p15-usage-refresh.md): identity on snapshots, the usage.refresh op and its report. */

const snap = {
  runtime: 'claude-code',
  auth: 'subscription',
  store: 'claude',
  source: 'probe',
  observedAt: '2026-10-22T12:00:00.000Z',
  windows: [{ id: 'five_hour', kind: 'session', usedPercent: 9, resetsAt: '2026-10-22T16:20:00.000Z' }],
} as const;

describe('usage identity', () => {
  it('a hashed key (32 hex) and a masked hint; nothing else', () => {
    expect(UsageIdentity.safeParse({ key: 'a'.repeat(32), hint: 'a…@example.com' }).success).toBe(true);
    expect(UsageIdentity.safeParse({ key: 'a'.repeat(32) }).success).toBe(true);
    expect(UsageIdentity.safeParse({ key: 'alex@example.com' }).success).toBe(false);
    expect(UsageIdentity.safeParse({ key: 'A'.repeat(32) }).success).toBe(false);
    expect(UsageIdentity.safeParse({ key: 'a'.repeat(32), hint: 'x\u0007y' }).success).toBe(false);
    expect(UsageIdentity.safeParse({ key: 'a'.repeat(32), hint: 'h'.repeat(65) }).success).toBe(false);
  });

  it('snapshots carry it optionally (older workers send none)', () => {
    expect(RuntimeUsageSnapshot.safeParse(snap).success).toBe(true);
    const withId = RuntimeUsageSnapshot.parse({
      ...snap,
      identity: { key: 'b'.repeat(32), hint: 'y…@x.io' },
    });
    expect(withId.identity?.key).toBe('b'.repeat(32));
  });
});

describe('usage.refresh', () => {
  it('the op: all logins, one runtime, or one account; nothing else', () => {
    expect(OpsOperation.safeParse({ kind: 'usage.refresh' }).success).toBe(true);
    expect(OpsOperation.safeParse({ kind: 'usage.refresh', runtime: 'codex' }).success).toBe(true);
    expect(
      OpsOperation.safeParse({ kind: 'usage.refresh', runtime: 'claude-code', account: 'ae6rh2mm' }).success,
    ).toBe(true);
    expect(OpsOperation.safeParse({ kind: 'usage.refresh', runtime: 'pi' }).success).toBe(false);
    expect(OpsOperation.safeParse({ kind: 'usage.refresh', account: 'Not-An-Id' }).success).toBe(false);
  });

  it('the report: per-login outcomes and up to 24 snapshots', () => {
    const report = {
      results: [
        { runtime: 'claude-code', account: 'default', outcome: 'read' },
        { runtime: 'codex', account: 'default', outcome: 'failed' },
      ],
      snapshots: Array.from({ length: 24 }, () => snap),
    };
    expect(UsageRefreshReport.safeParse(report).success).toBe(true);
    expect(UsageRefreshReport.safeParse({ ...report, snapshots: [...report.snapshots, snap] }).success).toBe(
      false,
    );
    expect(
      UsageRefreshReport.safeParse({
        ...report,
        results: [{ runtime: 'codex', account: 'default', outcome: 'maybe' }],
      }).success,
    ).toBe(false);
    const update = {
      commandId: '7f6c2f5e-1d1b-4b9a-9c55-2a7f0f0c7a11',
      seq: 2,
      kind: 'usage.refresh',
      state: 'succeeded',
      usageRefresh: report,
    };
    expect(OpsUpdatePayload.safeParse(update).success).toBe(true);
  });

  it('the feature is known to the master', () => {
    expect(WorkerFeature.safeParse(USAGE_REFRESH_FEATURE).success).toBe(true);
  });
});
