import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunClock } from '../src/jobs/run-clock.js';

/**
 * p20-job-clock (docs/design/p20-job-clock.md): a question to a person stops the run clock like an approval wait;
 * the waits are reported apart.
 */
describe('RunClock question holds (p20-job-clock)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not count a question wait; the job does not expire while the question is open', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const clock = new RunClock({ budgetMs: 10_000, onExpired: expired });
    clock.start();
    vi.advanceTimersByTime(4_000);
    clock.holdStarted('q1:a');
    expect(clock.waiting).toBe(true);
    expect(clock.waitingFor()).toBe('question');
    vi.advanceTimersByTime(3_600_000);
    expect(expired).not.toHaveBeenCalled();
    expect(clock.activeMs()).toBe(4_000);
    clock.holdEnded('q1:a');
    expect(clock.waitingFor()).toBeNull();
    vi.advanceTimersByTime(5_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a question hold survives the runtime moving on (other tool events while the question tool blocks)', () => {
    vi.useFakeTimers();
    const clock = new RunClock({ budgetMs: 60_000, onExpired: () => undefined });
    clock.start();
    clock.holdStarted('q1:a');
    clock.waitsCleared();
    clock.touch();
    vi.advanceTimersByTime(10_000);
    expect(clock.activeMs()).toBe(0);
    expect(clock.waiting).toBe(true);
    clock.holdEnded('unknown');
    expect(clock.waiting).toBe(true);
    clock.holdEnded('q1:a');
    vi.advanceTimersByTime(1_000);
    expect(clock.activeMs()).toBe(1_000);
  });

  it('stays stopped while an approval or a question is open; overlapping holds count once per kind', () => {
    vi.useFakeTimers();
    const clock = new RunClock({ budgetMs: 60_000, onExpired: () => undefined });
    clock.start();
    vi.advanceTimersByTime(1_000);
    clock.holdStarted('q1:a');
    clock.holdStarted('q2:b');
    vi.advanceTimersByTime(2_000);
    clock.waitStarted('appr-1');
    expect(clock.waitingFor()).toBe('approval');
    vi.advanceTimersByTime(3_000);
    clock.holdEnded('q1:a');
    clock.holdEnded('q2:b');
    // The approval still holds the clock.
    vi.advanceTimersByTime(4_000);
    expect(clock.activeMs()).toBe(1_000);
    clock.waitEnded('appr-1');
    vi.advanceTimersByTime(500);
    expect(clock.activeMs()).toBe(1_500);
    expect(clock.waitsMs()).toEqual({ approvalMs: 7_000, questionMs: 5_000 });
  });

  it('reports budget, run time, remaining, the waits apart, what it waits for and the idle time', () => {
    vi.useFakeTimers();
    const clock = new RunClock({ budgetMs: 600_000, usedMs: 60_000, onExpired: () => undefined });
    expect(clock.report().idleSec).toBeNull();
    clock.start();
    vi.advanceTimersByTime(30_000);
    clock.touch();
    clock.holdStarted('q:x');
    vi.advanceTimersByTime(120_000);
    expect(clock.report()).toEqual({
      budgetSec: 600,
      activeSec: 90,
      remainingSec: 510,
      approvalWaitSec: 0,
      questionWaitSec: 120,
      waiting: 'question',
      idleSec: 120,
    });
    clock.holdEnded('q:x');
    clock.setBudget(1_200_000);
    clock.stop();
    vi.advanceTimersByTime(60_000);
    expect(clock.report()).toMatchObject({
      budgetSec: 1200,
      activeSec: 90,
      questionWaitSec: 120,
      waiting: null,
    });
  });

  it('a hold before start keeps the clock from running when it starts; stop() closes open waits', () => {
    vi.useFakeTimers();
    const clock = new RunClock({ budgetMs: 10_000, onExpired: () => undefined });
    clock.holdStarted('q:early');
    clock.start();
    vi.advanceTimersByTime(5_000);
    expect(clock.activeMs()).toBe(0);
    clock.stop();
    vi.advanceTimersByTime(5_000);
    expect(clock.waitsMs().questionMs).toBe(5_000);
    clock.holdEnded('q:early');
    expect(clock.activeMs()).toBe(0);
  });
});
