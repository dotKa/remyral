import { describe, expect, it } from 'vitest';
import { eligibility, place, type PlacementJob, type PlacementWorker, score } from '../src/placement.js';

const job: PlacementJob = {
  project: 'acme',
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
    localProjects: ['acme'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    ...over,
  };
}

const codes = (w: PlacementWorker, j: PlacementJob = job) => eligibility(j, w).map((r) => r.code);
const coded = (w: PlacementWorker, j: PlacementJob) =>
  eligibility(j, w).map((r) => `${r.code}:${String(r.permanent)}`);

describe('function jobs (p14-workflow-engine 14.3, ADR-0055)', () => {
  const http: PlacementJob = { ...job, function: { type: 'network' } };
  const code: PlacementJob = { ...job, function: { type: 'code' } };
  const bare = worker({ runtimes: [], sandboxProfiles: [], maxParallelJobs: 1, activeLeases: 1 });

  it('needs function-v1 (transient: the node waits for an updated worker); no runtime, profile or AI slot', () => {
    expect(coded(bare, http)).toEqual(['function_unsupported:false']);
    expect(place(http, [bare]).kind).toBe('waiting');
    // A busy AI machine (1/1 AI slots) still takes a function job: it holds no AI slot.
    expect(codes({ ...bare, functionSupported: true }, http)).toEqual([]);
    // An ordinary job on the same machine still needs its runtime and a slot.
    expect(codes({ ...bare, functionSupported: true })).toContain('runtime_not_installed');
  });

  it('code needs function-code-v1 (a ready container engine), not just function-v1', () => {
    expect(codes({ ...bare, functionSupported: true }, code)).toEqual(['function_unsupported']);
    expect(codes({ ...bare, functionSupported: true, functionCodeSupported: true }, code)).toEqual([]);
  });

  it('p15-watches: a probe needs watch-checks-v1, not just function-v1', () => {
    const probe: PlacementJob = { ...job, function: { type: 'probe' } };
    expect(coded({ ...bare, functionSupported: true }, probe)).toEqual(['function_unsupported:false']);
    expect(codes({ ...bare, functionSupported: true, watchChecksSupported: true }, probe)).toEqual([]);
  });

  it('waits while every function slot is in use; scores on function slots', () => {
    expect(coded(worker({ functionSupported: true, functionActive: 8 }), http)).toEqual([
      'no_free_function_slot:false',
    ]);
    expect(codes(worker({ functionSupported: true, functionActive: 2, functionSlots: 2 }), http)).toEqual([
      'no_free_function_slot',
    ]);
    expect(score(http, worker({ functionSupported: true, activeLeases: 2 })).breakdown.capacity).toBe(1);
  });

  it('offline machines make it wait (queued), never fail', () => {
    const r = place(http, [worker({ functionSupported: true, connected: false, state: 'offline' })]);
    expect(r.kind).toBe('waiting');
  });

  it('a bound vault credential pins it to the workers holding it', () => {
    const bound: PlacementJob = { ...job, function: { type: 'network', credentialWorkers: ['wrk_b'] } };
    expect(codes(worker({ functionSupported: true }), bound)).toEqual(['credential_missing']);
    expect(codes(worker({ id: 'wrk_b', functionSupported: true }), bound)).toEqual([]);
  });

  it('a managed worker needs the project, not the label runtime', () => {
    const managed = {
      supported: true,
      desiredGeneration: 1,
      appliedGeneration: 1,
      rejected: null,
      assignedProjects: ['acme'],
      assignedRuntimes: [],
      effectiveProjects: ['acme'],
      effectiveRuntimes: [],
      blocked: {},
    };
    expect(codes(worker({ functionSupported: true, managed }), http)).toEqual([]);
    expect(
      codes(worker({ functionSupported: true, managed: { ...managed, assignedProjects: [] } }), http),
    ).toEqual(['project_not_assigned']);
  });
});
