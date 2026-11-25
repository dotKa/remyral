import { describe, expect, it } from 'vitest';
import {
  type ActiveJob,
  checkJobLimits,
  concurrencyHolds,
  DEFAULT_QUOTA_POLICY,
  effectiveJobLimits,
  fairOrder,
  type JobConsumption,
  pauseUntil,
  type ProviderPause,
  type QueuedJob,
  type QuotaPolicy,
  workerQuotaBlocks,
} from '../src/index.js';
import { eligibility, type PlacementWorker } from '../src/placement.js';

const NOW = new Date('2026-10-13T12:00:00Z');
const policy = (over: Partial<QuotaPolicy> = {}): QuotaPolicy => ({ ...DEFAULT_QUOTA_POLICY, ...over });
const usage = (over: Partial<JobConsumption> = {}): JobConsumption => ({
  records: 1,
  tokens: 0,
  tokensUnknownRecords: 0,
  turns: 0,
  turnsUnknownRecords: 0,
  costUsd: 0,
  costComplete: true,
  wallTimeMs: 0,
  ...over,
});

describe('effectiveJobLimits', () => {
  it('takes the smallest defined value per limit; defaults never widen a job', () => {
    expect(
      effectiveJobLimits(
        { maxCostUsd: 5, maxWallTimeSec: 600 },
        { maxCostUsd: 2, maxTokens: 1000 },
        undefined,
        { maxTokens: 5000, maxTurns: 10 },
      ),
    ).toEqual({ maxCostUsd: 2, maxTokens: 1000, maxTurns: 10, maxWallTimeSec: 600 });
  });
  it('ignores negative and non-finite values', () => {
    expect(effectiveJobLimits({ maxTokens: -1, maxTurns: Number.NaN })).toEqual({});
  });
});

describe('checkJobLimits', () => {
  it('ok below every limit', () => {
    expect(checkJobLimits({ maxTokens: 100, maxTurns: 5 }, usage({ tokens: 99, turns: 4 }))).toEqual({
      kind: 'ok',
    });
  });
  it('exceeded at the limit, first in a fixed order', () => {
    const v = checkJobLimits({ maxTokens: 100, maxTurns: 5 }, usage({ tokens: 100, turns: 9 }));
    expect(v).toMatchObject({ kind: 'exceeded', limit: 'maxTokens', used: 100, max: 100 });
  });
  it('a known lower bound over the limit is exceeded even with gaps (p6-cost)', () => {
    const v = checkJobLimits({ maxCostUsd: 1 }, usage({ costUsd: 1.5, costComplete: false }));
    expect(v).toMatchObject({ kind: 'exceeded', limit: 'maxCostUsd' });
    if (v.kind === 'exceeded') expect(v.message).toContain('+');
  });
  it('an incomplete figure below the limit is incomplete, never ok', () => {
    expect(checkJobLimits({ maxCostUsd: 1 }, usage({ costUsd: 0.2, costComplete: false }))).toMatchObject({
      kind: 'incomplete',
      limit: 'maxCostUsd',
    });
    expect(checkJobLimits({ maxTurns: 10 }, usage({ turns: 2, turnsUnknownRecords: 1 }))).toMatchObject({
      kind: 'incomplete',
      limit: 'maxTurns',
    });
  });
  it('wall time in seconds', () => {
    expect(checkJobLimits({ maxWallTimeSec: 60 }, usage({ wallTimeMs: 61_000 }))).toMatchObject({
      kind: 'exceeded',
      limit: 'maxWallTimeSec',
    });
  });
});

describe('concurrency', () => {
  const active: ActiveJob[] = [
    { project: 'a', runtime: 'codex', workerId: 'w1' },
    { project: 'a', runtime: 'claude-code', workerId: 'w2' },
    { project: 'b', runtime: 'codex', workerId: 'w3' },
  ];
  it('holds a job when its project or runtime is full', () => {
    const p = policy({ projects: { a: { maxConcurrent: 2 } }, runtimes: { codex: { maxConcurrent: 2 } } });
    expect(concurrencyHolds({ project: 'a', runtime: 'codex' }, active, p).map((h) => h.code)).toEqual([
      'project_concurrency',
      'runtime_concurrency',
    ]);
    expect(concurrencyHolds({ project: 'b', runtime: 'claude-code' }, active, p)).toEqual([]);
  });
  it('no limits configured: no holds', () => {
    expect(concurrencyHolds({ project: 'a', runtime: 'codex' }, active, policy())).toEqual([]);
  });
  it('a provider account shared by several workers counts once', () => {
    const p = policy({
      accounts: [{ id: 'sub-1', runtime: 'codex', maxConcurrent: 1, workers: ['w1', 'w9'] }],
    });
    // w1 runs a codex job of the account → w9 (same account) is full too; w3 is not a member.
    expect(workerQuotaBlocks('w9', 'codex', p, active, [], NOW).map((r) => r.code)).toEqual([
      'account_concurrency',
    ]);
    expect(workerQuotaBlocks('w3', 'codex', p, active, [], NOW)).toEqual([]);
    // Another runtime on the same worker is not part of the account.
    expect(workerQuotaBlocks('w9', 'claude-code', p, active, [], NOW)).toEqual([]);
  });
});

describe('provider pauses', () => {
  const p = policy({ accounts: [{ id: 'sub-1', runtime: 'codex', workers: ['w1', 'w2'] }] });
  const pause = (over: Partial<ProviderPause>): ProviderPause => ({
    id: 'p1',
    scope: 'worker_runtime',
    workerId: 'w5',
    runtime: 'codex',
    accountId: null,
    resumeAt: new Date(NOW.getTime() + 60_000),
    ...over,
  });
  it('pauses one runtime on one worker', () => {
    const pauses = [pause({})];
    expect(workerQuotaBlocks('w5', 'codex', p, [], pauses, NOW)[0]).toMatchObject({
      code: 'provider_paused',
      permanent: false,
    });
    expect(workerQuotaBlocks('w5', 'claude-code', p, [], pauses, NOW)).toEqual([]);
    expect(workerQuotaBlocks('w6', 'codex', p, [], pauses, NOW)).toEqual([]);
  });
  it('an account pause covers every member worker', () => {
    const pauses = [pause({ scope: 'account', workerId: null, accountId: 'sub-1' })];
    expect(workerQuotaBlocks('w2', 'codex', p, [], pauses, NOW).map((r) => r.code)).toEqual([
      'provider_paused',
    ]);
    expect(workerQuotaBlocks('w5', 'codex', p, [], pauses, NOW)).toEqual([]);
  });
  it('an expired pause no longer blocks', () => {
    const pauses = [pause({ resumeAt: new Date(NOW.getTime() - 1) })];
    expect(workerQuotaBlocks('w5', 'codex', p, [], pauses, NOW)).toEqual([]);
  });
  it('pause end: reset time clamped, else the default backoff', () => {
    const d = DEFAULT_QUOTA_POLICY;
    expect(pauseUntil(NOW, null, d).getTime()).toBe(NOW.getTime() + 900_000);
    expect(pauseUntil(NOW, new Date(NOW.getTime() + 3_600_000), d).getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(pauseUntil(NOW, new Date(NOW.getTime() + 30 * 86_400_000), d).getTime()).toBe(
      NOW.getTime() + 86_400_000,
    );
    expect(pauseUntil(NOW, new Date(NOW.getTime() - 5_000), d).getTime()).toBe(NOW.getTime() + 60_000);
  });
  it('placement reports quota blocks as transient exclusions', () => {
    const w: PlacementWorker = {
      id: 'w5',
      state: 'online',
      connected: true,
      capabilitiesKnown: true,
      os: 'linux',
      arch: 'x64',
      runtimes: [
        { runtime: 'codex', version: '1', installed: true, authenticated: 'yes', pinStatus: 'match' },
      ],
      sandboxProfiles: ['container'],
      maxParallelJobs: 2,
      activeLeases: 0,
      allowedProjects: null,
      localProjects: null,
      history: { succeeded: 0, failed: 0, lost: 0 },
      projectAffinity: 0,
      quotaBlocks: workerQuotaBlocks('w5', 'codex', p, [], [pause({})], NOW),
    };
    const reasons = eligibility(
      {
        project: 'a',
        runtime: 'codex',
        sandboxProfile: 'container',
        secretWorkers: [],
        declinedBy: [],
        failedOn: [],
      },
      w,
    );
    expect(reasons).toEqual([expect.objectContaining({ code: 'provider_paused', permanent: false })]);
  });
});

describe('fairOrder', () => {
  const at = (s: number) => new Date(NOW.getTime() - s * 1000);
  const job = (id: string, project: string, ageSec: number, priority = 0): QueuedJob => ({
    id,
    project,
    priority,
    createdAt: at(ageSec),
  });

  it('interleaves projects instead of draining the busiest first', () => {
    const queued = [
      job('a1', 'a', 50),
      job('a2', 'a', 49),
      job('a3', 'a', 48),
      job('a4', 'a', 47),
      job('b1', 'b', 10),
    ];
    expect(fairOrder(queued, new Map(), DEFAULT_QUOTA_POLICY, NOW).slice(0, 2)).toEqual(['a1', 'b1']);
  });

  it('accounts for load: the project with fewer active/recent jobs goes first', () => {
    const queued = [job('a1', 'a', 50), job('b1', 'b', 1)];
    expect(fairOrder(queued, new Map([['a', 1]]), DEFAULT_QUOTA_POLICY, NOW)).toEqual(['b1', 'a1']);
  });

  it('weights: a weight-2 project gets two picks per pick of a weight-1 project', () => {
    const queued = [
      ...['a1', 'a2', 'a3', 'a4'].map((id, i) => job(id, 'a', 100 - i)),
      ...['b1', 'b2', 'b3', 'b4'].map((id, i) => job(id, 'b', 100 - i)),
    ];
    const p = policy({ projects: { a: { weight: 2 } } });
    const order = fairOrder(queued, new Map(), p, NOW).slice(0, 6);
    expect(order.filter((id) => id.startsWith('a'))).toHaveLength(4);
    expect(order.filter((id) => id.startsWith('b'))).toHaveLength(2);
  });

  it('priority orders within a project; aging lifts long-waiting jobs', () => {
    const queued = [job('low-old', 'a', 600, 0), job('high-new', 'a', 1, 5)];
    // 600 s of waiting at 60 s per point = +10 > 5.
    expect(fairOrder(queued, new Map(), DEFAULT_QUOTA_POLICY, NOW)).toEqual(['low-old', 'high-new']);
    const fresh = [job('low-new', 'a', 1, 0), job('high-new', 'a', 2, 5)];
    expect(fairOrder(fresh, new Map(), DEFAULT_QUOTA_POLICY, NOW)).toEqual(['high-new', 'low-new']);
  });

  it('no starvation: a single-slot fleet serves a light project at its next start under a flood', () => {
    // Simulated dispatch rounds: one slot, finished at the end of each round; project "flood" keeps 20
    // high-priority jobs queued (refilled every round), project "light" submits one low-priority job after
    // flood already started a few. Starts within the fairness window are the scheduler's memory.
    let queued: QueuedJob[] = Array.from({ length: 20 }, (_, i) =>
      job(`f${String(i)}`, 'flood', 1000 - i, 10),
    );
    const starts = new Map<string, number>();
    let next = 100;
    const served: string[] = [];
    for (let round = 0; round < 8; round++) {
      if (round === 3) queued.push(job('light', 'light', 0, -40));
      const first = fairOrder(queued, starts, DEFAULT_QUOTA_POLICY, NOW)[0] ?? '';
      served.push(first);
      const picked = queued.find((j) => j.id === first);
      if (picked) starts.set(picked.project, (starts.get(picked.project) ?? 0) + 1);
      queued = queued.filter((j) => j.id !== first);
      queued.push(job(`f${String(next++)}`, 'flood', 0, 10));
    }
    expect(served.indexOf('light')).toBe(3);
    // Without fairness memory (empty load every round) the flood's priority would win every round.
    const noMemory = fairOrder(
      [...queued, job('light2', 'light', 0, -40)],
      new Map(),
      DEFAULT_QUOTA_POLICY,
      NOW,
    );
    expect(noMemory[0]).not.toBe('light2');
  });

  it('is deterministic and returns every job once', () => {
    const queued = [job('x', 'p', 5), job('y', 'q', 5), job('z', 'p', 4)];
    const a = fairOrder(queued, new Map(), DEFAULT_QUOTA_POLICY, NOW);
    expect(a).toEqual(fairOrder([...queued].reverse(), new Map(), DEFAULT_QUOTA_POLICY, NOW));
    expect([...a].sort()).toEqual(['x', 'y', 'z']);
  });
});
