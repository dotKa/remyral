import { describe, expect, it } from 'vitest';
import { BUSY_CODES, placementAllowsFallback } from '../src/fallback.js';
import {
  effectiveUrgentReserve,
  eligibility,
  parallelSlots,
  place,
  type PlacementJob,
  type PlacementRuntime,
  type PlacementWorker,
  runsWithExclusiveLogin,
} from '../src/placement.js';

/**
 * p9-queue-local-login-accounting (docs/design/p9-queue-priority.md §12): subscription logins run one at a time on a
 * Windows worker with per-job accounts; the master knows it from CAPABILITIES.localLogin instead of asking.
 */

const runtime = (name: string): PlacementRuntime => ({
  runtime: name,
  version: '1.0.0',
  installed: true,
  authenticated: 'yes',
  pinStatus: 'match',
  pinnedVersion: '1.0.0',
});

const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  project: 'acme',
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
  ...over,
});

/** windows-worker-1 on 2026-10-17: worker 1.0.32, 3 slots, urgent reserve 1, per-job accounts for host jobs. */
function desktop(over: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id: 'desktop-pc',
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'win32',
    arch: 'x64',
    runtimes: [runtime('claude-code'), runtime('codex')],
    sandboxProfiles: ['host-restricted'],
    maxParallelJobs: 3,
    activeLeases: 0,
    allowedProjects: null,
    localProjects: ['acme'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    profileConcurrency: { 'host-restricted': 3 },
    exclusiveProfiles: [],
    profileActive: {},
    urgentReserve: 1,
    localLogin: { runtimes: ['claude-code', 'codex'], exclusiveProfiles: ['host-restricted'] },
    localLoginActive: 0,
    ...over,
  };
}

const reasons = (j: PlacementJob, w: PlacementWorker) => eligibility(j, w);

describe('subscription logins run one at a time (CAPABILITIES.localLogin)', () => {
  it('production case: 1 running of 3 → both queued subscription-login jobs wait on the login, not on a slot', () => {
    const w = desktop({ activeLeases: 1, localLoginActive: 1, profileActive: { 'host-restricted': 1 } });
    for (const rt of ['codex', 'claude-code']) {
      const r = reasons(job({ runtime: rt }), w);
      expect(r.map((x) => x.code)).toEqual(['subscription_login_exclusive']);
      expect(r[0]?.permanent).toBe(false);
      expect(r[0]?.message).toBe(
        'Claude Code / Codex subscription logins run one at a time on desktop-pc (shared login); API-key jobs can run in parallel (1 running)',
      );
    }
    const result = place(job(), [w]);
    expect(result.kind).toBe('waiting');
    expect(placementAllowsFallback(result)).toBe(false);
    expect(BUSY_CODES.has('subscription_login_exclusive')).toBe(true);
  });

  it('a subscription-login job runs on an idle machine', () => {
    expect(reasons(job(), desktop())).toEqual([]);
    expect(place(job(), [desktop()]).kind).toBe('placed');
  });

  it('it also waits while only API-key jobs run (it must run alone)', () => {
    const w = desktop({ activeLeases: 2, localLoginActive: 0 });
    expect(reasons(job(), w).map((x) => x.code)).toEqual(['subscription_login_exclusive']);
  });

  it('an API-key job waits while a subscription-login job runs, and runs beside other API-key jobs', () => {
    const apiKey = job({ runtime: 'opencode' });
    const w = desktop({ runtimes: [runtime('codex'), runtime('opencode')] });
    expect(runsWithExclusiveLogin(apiKey, w)).toBe(false);
    const blocked = reasons(apiKey, { ...w, activeLeases: 1, localLoginActive: 1 });
    expect(blocked.map((x) => x.code)).toEqual(['subscription_login_exclusive']);
    expect(blocked[0]?.message).toMatch(/subscription-login job is running on desktop-pc; it runs alone/);
    expect(reasons(apiKey, { ...w, activeLeases: 1, localLoginActive: 0 })).toEqual([]);
  });

  it('a job with its own model-profile credential is an API-key job even for a subscription runtime', () => {
    const own = job({ ownCredential: true });
    expect(runsWithExclusiveLogin(own, desktop())).toBe(false);
    expect(reasons(own, desktop({ activeLeases: 1, localLoginActive: 0 }))).toEqual([]);
  });

  it('other profiles and workers without the report are not affected', () => {
    const container = job({ sandboxProfile: 'container' });
    const w = desktop({
      sandboxProfiles: ['host-restricted', 'container'],
      activeLeases: 1,
      localLoginActive: 1,
    });
    expect(reasons(container, w).map((x) => x.code)).not.toContain('subscription_login_exclusive');
    const old = desktop({ localLogin: undefined, activeLeases: 1 });
    expect(reasons(job(), old).map((x) => x.code)).not.toContain('subscription_login_exclusive');
  });
});

describe('urgent reserve only where ≥ 2 parallel slots can be used (D)', () => {
  it('only subscription-login runtimes on the machine: no reserve (only one-at-a-time work can run)', () => {
    const w = desktop();
    expect(parallelSlots(w, 'host-restricted')).toBe(0);
    expect(effectiveUrgentReserve(w, 'host-restricted')).toBe(0);
    // An API-key job (own credential) with 2 running still sees all 3 slots: no "2/3 slots in use … kept for Acil".
    const r = reasons(job({ ownCredential: true }), desktop({ activeLeases: 2 }));
    expect(r.map((x) => x.code)).not.toContain('urgent_slot_reserved');
  });

  it('an API-key runtime on the machine: the reserve applies to the parallel slots', () => {
    const w = desktop({ runtimes: [runtime('codex'), runtime('opencode')] });
    expect(parallelSlots(w, 'host-restricted')).toBe(3);
    expect(effectiveUrgentReserve(w, 'host-restricted')).toBe(1);
    const r = reasons(job({ runtime: 'opencode' }), { ...w, activeLeases: 2 });
    expect(r.map((x) => x.code)).toEqual(['urgent_slot_reserved']);
    expect(reasons(job({ runtime: 'opencode', priorityClass: 'urgent' }), { ...w, activeLeases: 2 })).toEqual(
      [],
    );
  });

  it('a runtime not logged in or not enabled on the machine does not count as parallel work', () => {
    const notAuthed = { ...runtime('opencode'), authenticated: 'no' as const };
    expect(parallelSlots(desktop({ runtimes: [runtime('codex'), notAuthed] }), 'host-restricted')).toBe(0);
  });

  it('an exclusive profile or a profile limited to one slot keeps nothing for Acil', () => {
    const w = desktop({ localLogin: undefined });
    expect(effectiveUrgentReserve({ ...w, exclusiveProfiles: ['host-restricted'] }, 'host-restricted')).toBe(
      0,
    );
    expect(
      effectiveUrgentReserve({ ...w, profileConcurrency: { 'host-restricted': 1 } }, 'host-restricted'),
    ).toBe(0);
    expect(
      effectiveUrgentReserve({ ...w, profileConcurrency: { 'host-restricted': 2 } }, 'host-restricted'),
    ).toBe(1);
    // Without per-profile reports the machine's slots count (pre-existing behaviour).
    expect(
      effectiveUrgentReserve(
        { ...w, profileConcurrency: undefined, exclusiveProfiles: undefined },
        'host-restricted',
      ),
    ).toBe(1);
  });
});
