import { RunClockReport, timeWarningThresholdSec } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { jobTimeWarningText } from '../../src/chat/flow.js';
import { reasonWords } from '../../src/chat/job-result.js';
import { continueLimitSec, type TimeWarningFacts } from '../../src/jobs/job-clock.js';
import { TIMED_OUT_SQL } from '../../src/jobs/timed-out-sql.js';
import { KIND_INFO, NOTIFICATION_KINDS } from '../../src/notifications/model.js';

/** p20-job-clock (docs/design/p20-job-clock.md): the time warning, its note and "Aynı yerden devam et". */
describe('job clock (p20-job-clock)', () => {
  it('warns at 15 % of the limit, at least 2 and at most 10 minutes', () => {
    expect(timeWarningThresholdSec(600)).toBe(120);
    expect(timeWarningThresholdSec(3600)).toBe(540);
    expect(timeWarningThresholdSec(4 * 3600)).toBe(600);
  });

  it('a continuation gets the old limit plus half (at least 30 min more), within the maximum', () => {
    expect(continueLimitSec(3600, 12 * 3600)).toBe(3600 + 1800);
    expect(continueLimitSec(4 * 3600, 12 * 3600)).toBe(6 * 3600);
    expect(continueLimitSec(10 * 3600, 12 * 3600)).toBe(12 * 3600);
    expect(continueLimitSec(600, 12 * 3600)).toBe(600 + 1800);
  });

  it('the clock report is bounded and keeps the waits apart', () => {
    const ok = RunClockReport.safeParse({
      budgetSec: 3600,
      activeSec: 3000,
      remainingSec: 600,
      approvalWaitSec: 120,
      questionWaitSec: 3600,
      waiting: 'question',
      idleSec: 30,
    });
    expect(ok.success).toBe(true);
    expect(RunClockReport.safeParse({ budgetSec: -1 }).success).toBe(false);
  });

  const facts = (over: Partial<TimeWarningFacts> = {}): TimeWarningFacts => ({
    jobId: '00000000-0000-4000-8000-000000000001',
    title: 'Rapor',
    project: 'demo',
    limitSec: 3600,
    remainingSec: 480,
    progressing: true,
    maxAllowedSec: 12 * 3600,
    waiting: null,
    ...over,
  });

  it('the chat note says the time left, whether it progressed and what can be done', () => {
    const tr = jobTimeWarningText(facts(), '00000000 · Rapor', 'tr');
    expect(tr).toContain('İşin süresi azalıyor');
    expect(tr).toContain('yaklaşık 8 dk kaldı');
    expect(tr).toContain('süre sınırı 60 dk');
    expect(tr).toContain('Son 10 dakikada çalışmaya devam ediyor');
    expect(tr).toContain('en çok 660 dk daha');
    expect(jobTimeWarningText(facts({ progressing: false }), 'x', 'tr')).toContain('hiçbir şey yapmadı');
    expect(jobTimeWarningText(facts({ waiting: 'question' }), 'x', 'tr')).toContain(
      'bekleme süreye sayılmıyor',
    );
    expect(jobTimeWarningText(facts({ limitSec: 12 * 3600 }), 'x', 'tr')).toContain('daha fazla uzatılamaz');
    const en = jobTimeWarningText(facts(), 'x', 'en');
    expect(en).toContain('The job is running out of time');
    expect(en).toContain('Continue where it stopped');
  });

  it('a job that stopped on its limit says so and how to continue', () => {
    const end = {
      jobId: 'j',
      transitionId: 't',
      state: 'FAILED' as const,
      fromState: 'RUNNING',
      trigger: 'worker',
      attempts: 1,
      timedOut: true,
    };
    expect(reasonWords(end, 'tr')).toContain('Aynı yerden devam et');
    expect(reasonWords(end, 'en')).toContain('Continue where it stopped');
  });

  it('the timed-out SQL takes a fixed alias only', () => {
    expect(TIMED_OUT_SQL('j')).toContain("'max_duration_exceeded'");
    expect(TIMED_OUT_SQL('j')).toContain("'budget_exceeded: wall time%'");
    expect(() => TIMED_OUT_SQL('j; drop')).toThrow();
  });

  it('job.time_warning is a notification kind with a description', () => {
    expect(NOTIFICATION_KINDS).toContain('job.time_warning');
    expect(KIND_INFO['job.time_warning'].label).toContain('running out of time');
  });
});
