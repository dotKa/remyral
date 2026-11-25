import { generateKeyPairSync } from 'node:crypto';
import { signTimeLimit, type TimeLimitBinding, verifyTimeLimit } from '@remyral/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunClock } from '../src/jobs/run-clock.js';

/**
 * p15-autonomy (docs/design/p15-autonomy.md §10): a running attempt's time limit changes without a restart — the run
 * clock takes the new budget (time used stays, approval waits still do not count), and SET_TIME_LIMIT is signed.
 */
describe('RunClock.setBudget (SET_TIME_LIMIT)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('extends a running budget: the run goes on past the old limit and ends at the new one', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const clock = new RunClock({ budgetMs: 10_000, onExpired: expired });
    clock.start();
    vi.advanceTimersByTime(8_000);
    expect(clock.setBudget(20_000)).toBe(12_000);
    vi.advanceTimersByTime(5_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(7_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('shortens it; a budget already used up ends the run at once', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const clock = new RunClock({ budgetMs: 60_000, onExpired: expired });
    clock.start();
    vi.advanceTimersByTime(30_000);
    expect(clock.setBudget(10_000)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('while waiting for an approval the new budget applies once the clock runs again', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const clock = new RunClock({ budgetMs: 10_000, onExpired: expired });
    clock.start();
    vi.advanceTimersByTime(4_000);
    clock.waitStarted('a');
    expect(clock.setBudget(30_000)).toBe(26_000);
    vi.advanceTimersByTime(3_600_000);
    expect(expired).not.toHaveBeenCalled();
    clock.waitEnded('a');
    vi.advanceTimersByTime(25_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});

describe('SET_TIME_LIMIT signature', () => {
  it('verifies against the lease key and refuses any changed field', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const b: TimeLimitBinding = {
      workerId: 'w1',
      jobId: '00000000-0000-4000-8000-000000000001',
      attemptId: '00000000-0000-4000-8000-000000000002',
      epoch: 3,
      changeId: '00000000-0000-4000-8000-000000000003',
      seq: 1,
      maxDurationSec: 7200,
      changedBy: 'u1',
      issuedAt: '2026-10-21T12:00:00.000Z',
    };
    const sig = signTimeLimit(b, 'k1abc', privateKey);
    const jwk = publicKey.export({ format: 'jwk' });
    const keys = [{ kid: 'k1abc', publicKey: String(jwk.x) }];
    expect(verifyTimeLimit(b, sig, keys as never)).toBe('ok');
    expect(verifyTimeLimit({ ...b, maxDurationSec: 7201 }, sig, keys as never)).toBe('bad_signature');
    expect(verifyTimeLimit({ ...b, workerId: 'w2' }, sig, keys as never)).toBe('bad_signature');
    expect(verifyTimeLimit(b, undefined, keys as never)).toBe('missing');
    expect(verifyTimeLimit(b, { ...sig, kid: 'other' }, keys as never)).toBe('unknown_key');
  });
});
