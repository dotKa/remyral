import { describe, expect, it } from 'vitest';
import { BUSY_CODES, placementAllowsFallback } from '../src/fallback.js';
import {
  configuredUrgentReserve,
  DEFAULT_URGENT_RESERVE,
  effectiveUrgentReserve,
  eligibility,
  explainPlacement,
  familyHoldsSlot,
  place,
  type PlacementJob,
  type PlacementWorker,
  reservedSlots,
  visibleSlots,
} from '../src/placement.js';
import { DEFAULT_QUOTA_POLICY, fairOrder, ownerHolds, priorityTier, type QueuedJob } from '../src/quotas.js';

/** p9-queue-priority (docs/design/p9-queue-priority.md): scheduler unit tests. */

const hostJob: PlacementJob = {
  project: 'acme',
  runtime: 'claude-code',
  sandboxProfile: 'host-restricted',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
};

function windows(over: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id: 'desktop-pc',
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'win32',
    arch: 'x64',
    runtimes: [
      {
        runtime: 'claude-code',
        version: '2.1.0',
        installed: true,
        authenticated: 'yes',
        pinStatus: 'match',
        pinnedVersion: '2.1.0',
      },
    ],
    sandboxProfiles: ['host-restricted', 'unconfined'],
    maxParallelJobs: 3,
    activeLeases: 0,
    allowedProjects: null,
    localProjects: ['acme'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    ...over,
  };
}

const codes = (j: PlacementJob, w: PlacementWorker) => eligibility(j, w).map((r) => r.code);

describe('decline = wait (transient declines)', () => {
  it('a busy decline excludes the worker transiently while it still runs as much as when it declined', () => {
    const job: PlacementJob = {
      ...hostJob,
      busyDeclines: [{ workerId: 'desktop-pc', activeLeases: 1, until: '2026-10-17T10:00:30.000Z' }],
    };
    const busy = eligibility(job, windows({ activeLeases: 1 }));
    expect(busy.map((r) => r.code)).toEqual(['declined_busy']);
    expect(busy[0]?.permanent).toBe(false);
    expect(busy[0]?.message).toMatch(/^waiting: desktop-pc busy for host-restricted/);
    expect(busy[0]?.until).toBe('2026-10-17T10:00:30.000Z');
    // Re-eligible as soon as its active count drops.
    expect(codes(job, windows({ activeLeases: 0 }))).toEqual([]);
  });

  it('the production case waits instead of failing: one Windows worker, the only machine, busy', () => {
    const job: PlacementJob = {
      ...hostJob,
      busyDeclines: [{ workerId: 'desktop-pc', activeLeases: 1, until: '2026-10-17T10:00:30.000Z' }],
    };
    const r = place(job, [windows({ activeLeases: 1 })]);
    expect(r.kind).toBe('waiting');
    // A permanent decline (the pre-p9 behaviour) would have made it infeasible.
    expect(place({ ...hostJob, declinedBy: ['desktop-pc'] }, [windows({ activeLeases: 1 })]).kind).toBe(
      'infeasible',
    );
  });

  it('busy codes keep a job waiting for the machine instead of switching to a fallback runtime', () => {
    for (const c of ['no_free_slot', 'no_free_profile_slot', 'urgent_slot_reserved', 'declined_busy']) {
      expect(BUSY_CODES.has(c)).toBe(true);
    }
    const r = place({ ...hostJob, busyDeclines: [{ workerId: 'desktop-pc', activeLeases: 1, until: 'x' }] }, [
      windows({ activeLeases: 1 }),
    ]);
    expect(placementAllowsFallback(r)).toBe(false);
  });
});

describe('per-profile slots (profile-slots-v1)', () => {
  const reported = {
    profileConcurrency: { 'host-restricted': 1, unconfined: 1, container: 3 },
    exclusiveProfiles: ['host-restricted', 'unconfined'],
  } as const;

  it('a full profile is a transient no_free_profile_slot with "busy for <profile>"', () => {
    const w = windows({ ...reported, activeLeases: 1, profileActive: { 'host-restricted': 1 } });
    const r = eligibility(hostJob, w);
    expect(r.map((x) => x.code)).toEqual(['no_free_profile_slot']);
    expect(r[0]?.permanent).toBe(false);
    expect(r[0]?.message).toBe(
      'waiting: desktop-pc busy for host-restricted (1/1 host-restricted slot in use)',
    );
    expect(place(hostJob, [w]).kind).toBe('waiting');
  });

  it('an exclusive profile waits while anything else runs on the worker', () => {
    const w = windows({
      ...reported,
      sandboxProfiles: ['container', 'host-restricted'],
      activeLeases: 1,
      profileActive: { container: 1 },
    });
    expect(codes(hostJob, w)).toEqual(['no_free_profile_slot']);
    // A container job is not exclusive: it may join.
    expect(codes({ ...hostJob, sandboxProfile: 'container' }, w)).toEqual([]);
  });

  it('a profile with free slots and no exclusivity is eligible; a profile reported with 0 slots is permanent', () => {
    const w = windows({
      profileConcurrency: { 'host-restricted': 3 },
      activeLeases: 2,
      profileActive: { 'host-restricted': 2 },
    });
    expect(codes(hostJob, w)).toEqual([]);
    const zero = eligibility(hostJob, windows({ profileConcurrency: { 'host-restricted': 0 } }));
    expect(zero.map((r) => [r.code, r.permanent])).toEqual([['sandbox_profile_unavailable', true]]);
  });

  it('a worker without the feature is bounded by maxParallelJobs only', () => {
    expect(codes(hostJob, windows({ activeLeases: 1 }))).toEqual([]);
  });
});

describe('urgent slot reservation (owner decision 5a)', () => {
  it('keeps one slot for urgent jobs when the machine has at least two', () => {
    expect(visibleSlots(3, 'normal', 1)).toBe(2);
    expect(visibleSlots(3, 'background', 1)).toBe(2);
    expect(visibleSlots(3, 'urgent', 1)).toBe(3);
    expect(visibleSlots(1, 'normal', 1)).toBe(1); // single slot: no reservation
    expect(visibleSlots(2, 'normal', 2)).toBe(1); // never all slots
    expect(visibleSlots(4, 'normal', 2)).toBe(2);
    expect(visibleSlots(4, 'normal', 0)).toBe(4);
    expect(reservedSlots(3, undefined, undefined)).toBe(0); // absent fact = no reservation
  });

  it('normal and background jobs see slots-1; an urgent job may take the reserved slot', () => {
    const job: PlacementJob = { ...hostJob, sandboxProfile: 'container' };
    const w = windows({ sandboxProfiles: ['container'], activeLeases: 2, urgentReserve: 1 });
    const normal = eligibility({ ...job, priorityClass: 'normal' }, w);
    expect(normal.map((r) => r.code)).toEqual(['urgent_slot_reserved']);
    expect(normal[0]?.permanent).toBe(false);
    expect(normal[0]?.message).toMatch(/kept for urgent \(Acil\) jobs on desktop-pc/);
    expect(codes({ ...job, priorityClass: 'background' }, w)).toEqual(['urgent_slot_reserved']);
    expect(codes({ ...job, priorityClass: 'urgent' }, w)).toEqual([]);
    // The explanation says the urgent job used the reserved slot.
    const urgent = { ...job, priorityClass: 'urgent' as const };
    const r = place(urgent, [w]);
    expect(r.kind).toBe('placed');
    if (r.kind === 'placed') expect(r.explanation).toMatch(/took the slot kept for urgent \(Acil\) jobs/);
    expect(
      explainPlacement(
        urgent,
        [
          {
            workerId: w.id,
            score: 1,
            breakdown: { capacity: 0, reliability: 0, affinity: 0, retryPenalty: 0, success: 0, speed: 0 },
          },
        ],
        [w],
      ),
    ).toMatch(/Acil/);
  });

  it('p11-fixes-a: the default reserve (null) applies only from 3 usable slots; an explicit setting from 2', () => {
    const job: PlacementJob = { ...hostJob, sandboxProfile: 'container', priorityClass: 'normal' };
    const two = (over: Partial<PlacementWorker>) =>
      windows({ sandboxProfiles: ['container'], maxParallelJobs: 2, activeLeases: 1, ...over });
    // 2 slots, default: both slots run normal jobs.
    expect(codes(job, two({ urgentReserve: null }))).toEqual([]);
    expect(effectiveUrgentReserve(two({ urgentReserve: null }), 'container')).toBe(0);
    // 2 slots, an admin's explicit 1: kept as before.
    expect(codes(job, two({ urgentReserve: 1 }))).toEqual(['urgent_slot_reserved']);
    // 3 slots, default: one slot kept for Acil.
    const three = windows({ sandboxProfiles: ['container'], activeLeases: 2, urgentReserve: null });
    expect(effectiveUrgentReserve(three, 'container')).toBe(1);
    expect(codes(job, three)).toEqual(['urgent_slot_reserved']);
    expect(configuredUrgentReserve(null, 3)).toBe(DEFAULT_URGENT_RESERVE);
    expect(configuredUrgentReserve(null, 2)).toBe(0);
    expect(configuredUrgentReserve(2, 2)).toBe(2);
    expect(configuredUrgentReserve(undefined, 4)).toBe(0); // absent fact = no reservation
  });

  it('p11-fixes-a: a family member may use the reserved slot while its family holds a slot on the machine', () => {
    const lease = (jobId: string, family: string) => ({
      jobId,
      family,
      profile: 'container',
      runtime: 'claude-code',
      ownCredential: false,
    });
    const w = windows({
      sandboxProfiles: ['container'],
      activeLeases: 2,
      urgentReserve: 1,
      slotLeases: [lease('coord', 'coord'), lease('other', 'other')],
    });
    const base: PlacementJob = { ...hostJob, sandboxProfile: 'container', priorityClass: 'normal' };
    // The coordinator's own sub-job (or integration / resolution job): the parent waits for it here — no reserve.
    expect(codes({ ...base, jobId: 'child', family: 'coord' }, w)).toEqual([]);
    expect(familyHoldsSlot({ jobId: 'child', family: 'coord' }, w)).toBe(true);
    // Another family's job, a root job, or a job without facts: the reserve applies.
    expect(codes({ ...base, jobId: 'x', family: 'x' }, w)).toEqual(['urgent_slot_reserved']);
    expect(codes({ ...base, jobId: 'y', family: 'elsewhere' }, w)).toEqual(['urgent_slot_reserved']);
    expect(codes(base, w)).toEqual(['urgent_slot_reserved']);
    // The exception never goes past a full machine.
    expect(codes({ ...base, jobId: 'child', family: 'coord' }, { ...w, activeLeases: 3 })).toEqual([
      'no_free_slot',
    ]);
  });

  it('full slots stay no_free_slot for everyone', () => {
    const w = windows({ sandboxProfiles: ['container'], activeLeases: 3, urgentReserve: 1 });
    expect(codes({ ...hostJob, sandboxProfile: 'container', priorityClass: 'urgent' }, w)).toEqual([
      'no_free_slot',
    ]);
  });
});

describe('priority classes in the dispatch order', () => {
  const NOW = new Date('2026-10-17T10:00:00.000Z');
  const job = (id: string, project: string, priority: number, ageSec: number): QueuedJob => ({
    id,
    project,
    priority,
    createdAt: new Date(NOW.getTime() - ageSec * 1000),
  });

  it('classes come from the stored priority bands', () => {
    expect([priorityTier(50), priorityTier(49), priorityTier(-49), priorityTier(-50)]).toEqual([
      'urgent',
      'normal',
      'normal',
      'background',
    ]);
  });

  it('urgent first, background last, across projects and despite fair share', () => {
    const order = fairOrder(
      [job('bg-old', 'a', -50, 7200), job('n1', 'a', 0, 60), job('u1', 'b', 50, 1), job('n2', 'b', 0, 30)],
      new Map([['b', 10]]), // project b is heavy: fair share would put a first within a class
      DEFAULT_QUOTA_POLICY,
      NOW,
    );
    expect(order).toEqual(['u1', 'n1', 'n2', 'bg-old']);
  });

  it('aging never lifts a background job into the normal class, but orders within the class', () => {
    // Two hours of aging = +120 points: still background.
    const order = fairOrder(
      [job('bg-old', 'a', -50, 7200), job('bg-new', 'a', -50, 0), job('n', 'a', 0, 0)],
      new Map(),
      DEFAULT_QUOTA_POLICY,
      NOW,
    );
    expect(order).toEqual(['n', 'bg-old', 'bg-new']);
  });

  it('fair share still applies within a class', () => {
    const order = fairOrder(
      [job('a1', 'a', 0, 10), job('a2', 'a', 0, 9), job('b1', 'b', 0, 1)],
      new Map([['a', 2]]),
      DEFAULT_QUOTA_POLICY,
      NOW,
    );
    expect(order[0]).toBe('b1');
  });
});

describe('per-user / per-automation limits', () => {
  const active = [
    { project: 'acme', userId: 'ayse', automationId: null },
    { project: 'acme', userId: 'ayse', automationId: null },
    { project: 'acme', userId: 'ayse', automationId: 'nightly' },
    { project: 'other', userId: 'mehmet', automationId: null },
  ];

  it('off by default', () => {
    expect(ownerHolds({ project: 'acme', userId: 'ayse', automationId: null }, active, {})).toEqual([]);
  });

  it('holds a person at their per-project limit (automation jobs do not count against them)', () => {
    const holds = ownerHolds({ project: 'acme', userId: 'ayse', automationId: null }, active, {
      maxPerUser: 2,
    });
    expect(holds.map((h) => h.code)).toEqual(['user_concurrency']);
    expect(holds[0]?.message).toMatch(/2\/2 jobs in project acme/);
    expect(
      ownerHolds({ project: 'acme', userId: 'ayse', automationId: null }, active, { maxPerUser: 3 }),
    ).toEqual([]);
    expect(
      ownerHolds({ project: 'other', userId: 'mehmet', automationId: null }, active, { maxPerUser: 2 }),
    ).toEqual([]);
  });

  it('holds an automation at its limit', () => {
    const job = { project: 'acme', userId: 'ayse', automationId: 'nightly' };
    expect(ownerHolds(job, active, { maxPerAutomation: 1 }).map((h) => h.code)).toEqual([
      'automation_concurrency',
    ]);
    expect(ownerHolds(job, active, { maxPerAutomation: 2, maxPerUser: 1 })).toEqual([]);
  });
});
