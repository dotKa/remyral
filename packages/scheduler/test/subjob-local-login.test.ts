import { describe, expect, it } from 'vitest';
import { BUSY_CODES } from '../src/fallback.js';
import {
  eligibility,
  loginStoreOf,
  place,
  type PlacementJob,
  type PlacementRuntime,
  type PlacementWorker,
  type SlotLeaseFact,
  withoutJobLease,
} from '../src/placement.js';

/**
 * p9-subjob-local-login-deadlock (docs/design/p9-subjob-local-login.md §4): with `localLogin.stores` the
 * subscription-login rule is per login store and per job family — a Codex sub-job runs beside its Claude Code parent.
 */

const runtime = (name: string): PlacementRuntime => ({
  runtime: name,
  version: '1.0.0',
  installed: true,
  authenticated: 'yes',
  pinStatus: 'match',
  pinnedVersion: '1.0.0',
});

const PARENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  project: 'genel',
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
  ...over,
});

const lease = (over: Partial<SlotLeaseFact> = {}): SlotLeaseFact => ({
  jobId: PARENT,
  family: PARENT,
  profile: 'host-restricted',
  runtime: 'claude-code',
  ownCredential: false,
  ...over,
});

const STORES = { 'claude-code': 'claude', codex: 'codex' };

/** windows-worker-1 (worker 1.0.35+): per-job accounts, both runtimes on the subscription login, store report. */
function desktop(leases: readonly SlotLeaseFact[], over: Partial<PlacementWorker> = {}): PlacementWorker {
  const profileActive: Record<string, number> = {};
  for (const l of leases) profileActive[l.profile] = (profileActive[l.profile] ?? 0) + 1;
  return {
    id: 'desktop-pc',
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'win32',
    arch: 'x64',
    runtimes: [runtime('claude-code'), runtime('codex'), runtime('opencode')],
    sandboxProfiles: ['host-restricted'],
    maxParallelJobs: 3,
    activeLeases: leases.length,
    allowedProjects: null,
    localProjects: ['genel'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    profileConcurrency: { 'host-restricted': 3 },
    exclusiveProfiles: [],
    profileActive,
    urgentReserve: 1,
    localLogin: {
      runtimes: ['claude-code', 'codex'],
      exclusiveProfiles: ['host-restricted'],
      stores: STORES,
    },
    localLoginActive: leases.filter((l) => !l.ownCredential && l.runtime !== 'opencode').length,
    slotLeases: leases,
    ...over,
  };
}

const codes = (j: PlacementJob, w: PlacementWorker) => eligibility(j, w).map((r) => r.code);

describe('subscription logins per login store and job family (localLogin.stores)', () => {
  it('the live case: a Codex sub-job (local-login) runs beside its Claude Code parent (local-login)', () => {
    const w = desktop([lease()]);
    expect(codes(job({ family: PARENT }), w)).toEqual([]);
    expect(place(job({ family: PARENT }), [w]).kind).toBe('placed');
  });

  it('an unrelated Codex job waits: the machine runs another job (worker-account attempts never mix families)', () => {
    const w = desktop([lease()]);
    const r = eligibility(job({ family: OTHER }), w);
    expect(r.map((x) => x.code)).toEqual(['subscription_login_exclusive']);
    expect(r[0]?.permanent).toBe(false);
    expect(r[0]?.message).toBe(
      'desktop-pc is running another job (1); a Codex subscription-login job runs as the worker account, so it starts when the machine is free or runs only its own parent / sub-jobs',
    );
    // A job without a family is never "the same family".
    expect(codes(job(), w)).toEqual(['subscription_login_exclusive']);
  });

  it('the same login store waits — inside the family too (one attempt per store)', () => {
    const w = desktop([lease()]);
    const inFamily = eligibility(job({ runtime: 'claude-code', family: PARENT }), w);
    expect(inFamily.map((x) => x.code)).toEqual(['subscription_login_busy']);
    expect(inFamily[0]?.message).toBe(
      'waiting for the Claude Code subscription login on desktop-pc to be free: one Claude Code job at a time uses it (shared login; 1 running)',
    );
    expect(codes(job({ runtime: 'claude-code', family: OTHER }), w)).toEqual([
      'subscription_login_busy',
      'subscription_login_exclusive',
    ]);
    expect(BUSY_CODES.has('subscription_login_busy')).toBe(true);
  });

  it('API-key jobs: beside a login job of their own family yes, of another family no; without login jobs as before', () => {
    const w = desktop([lease()]);
    expect(codes(job({ runtime: 'opencode', family: PARENT }), w)).toEqual([]);
    const r = eligibility(job({ runtime: 'opencode', family: OTHER }), w);
    expect(r.map((x) => x.code)).toEqual(['subscription_login_exclusive']);
    expect(r[0]?.message).toMatch(
      /^a Claude Code subscription-login job of another job is running on desktop-pc/,
    );
    // Own credential = API key, also for a login runtime.
    expect(codes(job({ ownCredential: true, family: OTHER }), w)).toEqual(['subscription_login_exclusive']);
    // Only API-key jobs running: an API-key job of any family runs in parallel.
    const api = desktop([lease({ runtime: 'opencode', ownCredential: true, family: OTHER, jobId: OTHER })]);
    expect(codes(job({ runtime: 'opencode', family: PARENT }), api)).toEqual([]);
    // … but a login job waits for the other family's API-key job (it would run as the worker account beside it).
    expect(codes(job({ family: PARENT }), api)).toEqual(['subscription_login_exclusive']);
  });

  it('an idle machine takes any login job; a family of three fits while the stores differ', () => {
    expect(codes(job({ runtime: 'claude-code', family: OTHER }), desktop([]))).toEqual([]);
    const w = desktop([lease(), lease({ jobId: OTHER, runtime: 'codex' })], { urgentReserve: 0 });
    expect(codes(job({ runtime: 'opencode', family: PARENT }), w)).toEqual([]);
    // (With the default reserve the last free slot is kept for Acil, family or not.)
    expect(codes(job({ runtime: 'opencode', family: PARENT }), { ...w, urgentReserve: 1 })).toEqual([
      'urgent_slot_reserved',
    ]);
    expect(codes(job({ runtime: 'codex', family: PARENT }), w)).toEqual(['subscription_login_busy']);
  });

  it('workers without `stores` keep the old global rule (a sub-job waits for its parent)', () => {
    const w = desktop([lease()], {
      localLogin: { runtimes: ['claude-code', 'codex'], exclusiveProfiles: ['host-restricted'] },
    });
    expect(codes(job({ family: PARENT }), w)).toEqual(['subscription_login_exclusive']);
  });

  it('leases without details count as another family', () => {
    const w = desktop([lease()], { slotLeases: undefined });
    expect(codes(job({ family: PARENT }), w)).toEqual(['subscription_login_exclusive']);
  });

  it('loginStoreOf: the reported store, else the runtime name', () => {
    const ll = {
      runtimes: ['claude-code', 'pi'],
      exclusiveProfiles: [],
      stores: { 'claude-code': 'claude' },
    };
    expect(loginStoreOf('claude-code', ll)).toBe('claude');
    expect(loginStoreOf('pi', ll)).toBe('pi');
  });

  it('withoutJobLease: the counterfactual behind blocked_by_parent', () => {
    const w = desktop([
      lease(),
      lease({ jobId: OTHER, family: OTHER, runtime: 'opencode', ownCredential: true }),
    ]);
    const without = withoutJobLease(w, PARENT);
    expect(without.activeLeases).toBe(1);
    expect(without.localLoginActive).toBe(0);
    expect(without.profileActive).toEqual({ 'host-restricted': 1 });
    expect(without.slotLeases?.map((l) => l.jobId)).toEqual([OTHER]);
    // Claude Code child of the parent: blocked by the parent (same store), free without it.
    const child = job({ runtime: 'claude-code', family: PARENT });
    expect(codes(child, desktop([lease()]))).toEqual(['subscription_login_busy']);
    expect(codes(child, withoutJobLease(desktop([lease()]), PARENT))).toEqual([]);
    // Unknown job or no details: unchanged.
    expect(withoutJobLease(w, 'nope')).toBe(w);
    const bare = desktop([lease()], { slotLeases: undefined });
    expect(withoutJobLease(bare, PARENT)).toBe(bare);
  });
});
