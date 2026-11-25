import { describe, expect, it } from 'vitest';
import {
  MAX_UPDATE_DIAGNOSTICS_BYTES,
  OpsOperation,
  UpdateDiagnostics,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';

// p6-worker-boot-diagnostics: UPDATE_STATUS evidence and the logs.tail source.

const envelope = (payload: unknown) => ({
  protocolVersion: '1.0',
  messageId: '0b0c3a59-8f0a-4a52-9a37-3c4f5f0e9a11',
  seq: 0,
  ts: '2026-10-16T09:03:00.000Z',
  correlationId: 'c-1',
  type: 'UPDATE_STATUS',
  workerId: 'w-1',
  payload,
});

const base = {
  attemptId: '7d0c4c1e-3c55-4c1e-9d6a-1f4f3b8a2b10',
  version: '1.0.22',
  phase: 'rolled_back',
  reason: 'health_check_failed',
  currentVersion: '1.0.21',
};

describe('UPDATE_STATUS diagnostics', () => {
  it('is optional and additive; a bounded, redacted object is accepted', () => {
    expect(WorkerToMaster.safeParse(envelope(base)).success).toBe(true);
    const d = {
      collectedBy: 'updater',
      verdict: 'never_started',
      bootLog: ['{"event":"start","version":"1.0.21"}'],
      serviceOutput: ['[shawl] Command exited with code 1'],
      restartErrors: ['net.exe start RemyralWorker failed (2)'],
      redacted: true,
    };
    expect(WorkerToMaster.safeParse(envelope({ ...base, diagnostics: d })).success).toBe(true);
  });

  it('refuses unknown verdicts, unredacted evidence, too many / too long lines and oversize objects', () => {
    const ok = { collectedBy: 'worker', verdict: 'started', redacted: true };
    expect(UpdateDiagnostics.safeParse(ok).success).toBe(true);
    expect(UpdateDiagnostics.safeParse({ ...ok, verdict: 'exploded' }).success).toBe(false);
    expect(UpdateDiagnostics.safeParse({ ...ok, redacted: false }).success).toBe(false);
    expect(
      UpdateDiagnostics.safeParse({ ...ok, bootLog: Array.from({ length: 41 }, () => 'x') }).success,
    ).toBe(false);
    expect(UpdateDiagnostics.safeParse({ ...ok, bootLog: ['x'.repeat(2001)] }).success).toBe(false);
    const big = Array.from({ length: 40 }, () => 'y'.repeat(1990));
    const oversize = { ...ok, bootLog: big, serviceOutput: big };
    expect(JSON.stringify(oversize).length).toBeGreaterThan(MAX_UPDATE_DIAGNOSTICS_BYTES);
    expect(UpdateDiagnostics.safeParse(oversize).success).toBe(false);
  });
});

describe('logs.tail source', () => {
  it('worker | boot | updater, absent = worker; nothing else (no paths)', () => {
    const op = { kind: 'logs.tail', lines: 100, maxBytes: 4096 };
    expect(OpsOperation.parse(op)).toEqual(op);
    for (const source of ['worker', 'boot', 'updater']) {
      expect(OpsOperation.parse({ ...op, source })).toMatchObject({ source });
    }
    expect(OpsOperation.safeParse({ ...op, source: 'C:\\Windows\\System32\\config\\SAM' }).success).toBe(
      false,
    );
    expect(WorkerFeature.parse('logs-source-v1')).toBe('logs-source-v1');
  });
});
