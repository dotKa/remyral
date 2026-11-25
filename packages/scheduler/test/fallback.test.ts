import { describe, expect, it } from 'vitest';
import {
  combinedWaitReasons,
  earliestUntil,
  holdAllowsFallback,
  passedOverReason,
  placementAllowsFallback,
  runtimeOptions,
} from '../src/fallback.js';
import { place, type PlacementJob, type PlacementRuntime, type PlacementWorker } from '../src/placement.js';
import { DEFAULT_QUOTA_POLICY, workerQuotaBlocks } from '../src/quotas.js';

/** p6-quota-scheduling: fallback runtime selection (pure part). */

const job = (runtime: string): PlacementJob => ({
  project: 'acme',
  runtime,
  sandboxProfile: 'container',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
});

const rt = (runtime: string, over: Partial<PlacementRuntime> = {}): PlacementRuntime => ({
  runtime,
  version: '1',
  installed: true,
  authenticated: 'yes',
  pinStatus: 'match',
  pinnedVersion: '1',
  ...over,
});

function worker(id: string, over: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id,
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'linux',
    arch: 'x64',
    runtimes: [rt('claude-code'), rt('codex')],
    sandboxProfiles: ['container'],
    maxParallelJobs: 1,
    activeLeases: 0,
    allowedProjects: null,
    localProjects: ['acme'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    ...over,
  };
}

const NOW = new Date('2026-10-16T10:00:00Z');
const pause = {
  id: 'p1',
  scope: 'worker_runtime' as const,
  workerId: 'w1',
  runtime: 'claude-code',
  accountId: null,
  resumeAt: new Date('2026-10-16T15:00:00Z'),
};

/** Placement of `runtime` with provider pauses applied the way the quota admission does. */
function placeWithPauses(runtime: string, workers: PlacementWorker[]) {
  return place(
    job(runtime),
    workers.map((w) => {
      const blocks = workerQuotaBlocks(w.id, runtime, DEFAULT_QUOTA_POLICY, [], [pause], NOW);
      return blocks.length === 0 ? w : { ...w, quotaBlocks: blocks };
    }),
  );
}

describe('fallback runtimes', () => {
  it('lists the job runtime first, then the fallbacks in order', () => {
    expect(
      runtimeOptions({ runtime: 'claude-code' }, [{ runtime: 'codex' }, { runtime: 'pi' }]).map(
        (o) => `${String(o.index)}:${o.runtime}`,
      ),
    ).toEqual(['0:claude-code', '1:codex', '2:pi']);
    expect(runtimeOptions({ runtime: 'codex' }, undefined)).toHaveLength(1);
  });

  it('a paused runtime falls through; the pause end is kept on the reason', () => {
    const r = placeWithPauses('claude-code', [worker('w1')]);
    expect(r.kind).toBe('waiting');
    expect(placementAllowsFallback(r)).toBe(true);
    if (r.kind === 'placed') throw new Error('unexpected');
    expect(earliestUntil(r.summary, 'provider_paused')).toBe('2026-10-16T15:00:00.000Z');
    expect(passedOverReason('claude-code', r.summary)).toBe(
      'claude-code: provider_paused until 2026-10-16T15:00:00.000Z [w1]',
    );
    // The fallback places on the same machine.
    expect(placeWithPauses('codex', [worker('w1')]).kind).toBe('placed');
  });

  it('not installed / not logged in falls through (infeasible or waiting alike)', () => {
    const notInstalled = place(job('claude-code'), [worker('w1', { runtimes: [rt('codex')] })]);
    expect(notInstalled.kind).toBe('infeasible');
    expect(placementAllowsFallback(notInstalled)).toBe(true);
    const loggedOut = place(job('claude-code'), [
      worker('w1', { runtimes: [rt('claude-code', { authenticated: 'no' }), rt('codex')] }),
    ]);
    expect(placementAllowsFallback(loggedOut)).toBe(true);
  });

  it('a machine that is only busy with the runtime makes the job wait for it', () => {
    const r = place(job('claude-code'), [
      worker('w1', { activeLeases: 1 }),
      worker('w2', { runtimes: [rt('codex')] }),
    ]);
    expect(r.kind).toBe('waiting');
    expect(placementAllowsFallback(r)).toBe(false);
  });

  it('a placed option never falls through', () => {
    expect(placementAllowsFallback(place(job('codex'), [worker('w1')]))).toBe(false);
  });

  it('only runtime holds fall through', () => {
    const h = (code: string) => ({ code, permanent: false, message: code, workers: [] }) as never;
    expect(holdAllowsFallback([h('runtime_concurrency')])).toBe(true);
    expect(holdAllowsFallback([h('runtime_concurrency'), h('project_hold')])).toBe(false);
    expect(holdAllowsFallback([h('budget_exceeded')])).toBe(false);
    expect(holdAllowsFallback([])).toBe(false);
  });

  it('combines wait reasons of all options, naming the fallback', () => {
    const r = (code: string) => ({ code, permanent: false, message: 'm', workers: ['w1'] }) as never;
    expect(
      combinedWaitReasons([
        { runtime: 'claude-code', index: 0, reasons: [r('provider_paused')] },
        { runtime: 'codex', index: 1, reasons: [r('runtime_not_authenticated')] },
      ]).map((x) => x.message),
    ).toEqual(['m', 'fallback codex: m']);
  });
});
