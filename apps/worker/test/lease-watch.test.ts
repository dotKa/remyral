import { describe, expect, it } from 'vitest';
import { fenceDeadline, type LeaseWatch, watchPeriodMs } from '../src/jobs/lease-watch.js';

const base: LeaseWatch = {
  ttlMs: 90_000,
  selfFenceGraceMs: 90_000,
  offlineGraceMs: 0,
  confirmedAt: 1_000,
  ackConfirmedAt: null,
  connected: true,
  connectedSince: null,
};

describe('fenceDeadline (p11-master-resilience, ADR-0039)', () => {
  it('classic lease: confirmation + ttl + self-fence grace, connected or not', () => {
    expect(fenceDeadline(base)).toBe(181_000);
    expect(fenceDeadline({ ...base, connected: false })).toBe(181_000);
  });

  it('a grant does nothing until a renewal answered one of our acknowledgements', () => {
    expect(fenceDeadline({ ...base, offlineGraceMs: 900_000, connected: false })).toBe(181_000);
  });

  it('offline: dated by the acknowledgement send time, never by when the renewal arrived', () => {
    const w = {
      ...base,
      offlineGraceMs: 900_000,
      ackConfirmedAt: 500,
      confirmedAt: 60_000,
      connected: false,
    };
    expect(fenceDeadline(w)).toBe(500 + 90_000 + 900_000);
  });

  it('connected again: the classic rule restarts at the session start, capped by the offline deadline', () => {
    const w = { ...base, offlineGraceMs: 900_000, ackConfirmedAt: 1_000 };
    expect(fenceDeadline({ ...w, connectedSince: 600_000 })).toBe(600_000 + 180_000);
    expect(fenceDeadline({ ...w, connectedSince: 950_000 })).toBe(1_000 + 90_000 + 900_000);
    // Connected all along: exactly the classic rule.
    expect(fenceDeadline(w)).toBe(181_000);
  });

  it('never stricter than the classic rule', () => {
    const w = { ...base, offlineGraceMs: 10_000, ackConfirmedAt: 0, confirmedAt: 50_000, connected: false };
    expect(fenceDeadline(w)).toBe(50_000 + 180_000);
  });

  it('watch period: a quarter of the renewal interval, 50 ms … 1 s', () => {
    expect(watchPeriodMs(30_000)).toBe(1_000);
    expect(watchPeriodMs(500)).toBe(125);
    expect(watchPeriodMs(100)).toBe(50);
  });
});
