import { describe, expect, it } from 'vitest';
import { place, type PlacementJob, type PlacementWorker, score } from '../src/placement.js';

const job: PlacementJob = {
  project: 'genel',
  runtime: 'codex',
  sandboxProfile: 'container',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
};

function worker(over: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id: 'wrk_a',
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'linux',
    arch: 'x64',
    runtimes: [
      {
        runtime: 'codex',
        version: '0.162.1',
        installed: true,
        authenticated: 'yes',
        pinStatus: 'match',
        pinnedVersion: '0.162.1',
      },
    ],
    sandboxProfiles: ['container', 'host-restricted'],
    maxParallelJobs: 2,
    activeLeases: 0,
    allowedProjects: null,
    localProjects: ['genel'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    ...over,
  };
}

describe('p15-workspace-retention: the machine that keeps the files is preferred', () => {
  it('ranks the keeping machine first despite less free capacity, and says why', () => {
    const busy = worker({ id: 'wrk_keep', activeLeases: 1 });
    const free = worker({ id: 'wrk_free' });
    const plain = place(job, [busy, free]);
    expect(plain.kind === 'placed' ? plain.ranked[0]?.workerId : null).toBe('wrk_free');
    const r = place({ ...job, preferWorkers: ['wrk_keep'] }, [busy, free]);
    expect(r.kind).toBe('placed');
    if (r.kind !== 'placed') return;
    expect(r.ranked[0]?.workerId).toBe('wrk_keep');
    expect(r.ranked[0]?.breakdown.preferred).toBe(1);
    expect(r.ranked[1]?.breakdown.preferred).toBeUndefined();
    expect(r.explanation).toContain('keeps the files');
  });

  it('is only a preference: an ineligible keeping machine does not block the job', () => {
    const r = place({ ...job, preferWorkers: ['wrk_off'] }, [
      worker({ id: 'wrk_off', connected: false, state: 'offline' }),
      worker({ id: 'wrk_on' }),
    ]);
    expect(r.kind === 'placed' ? r.ranked[0]?.workerId : null).toBe('wrk_on');
  });

  it('leaves the score unchanged without a preference', () => {
    expect(score(job, worker()).breakdown).not.toHaveProperty('preferred');
  });
});
