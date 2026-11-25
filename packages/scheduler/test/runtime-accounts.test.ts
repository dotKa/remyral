import { describe, expect, it } from 'vitest';
import {
  accountExclusion,
  chooseAccounts,
  type JobAccountFacts,
  type PlacementAccount,
} from '../src/accounts.js';
import { BUSY_CODES, placementAllowsFallback } from '../src/fallback.js';
import {
  accountEligibility,
  eligibility,
  hasLoginExclusion,
  place,
  type PlacementJob,
  type PlacementRuntime,
  type PlacementWorker,
  type SlotLeaseFact,
} from '../src/placement.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §3): several Claude Code / Codex accounts per machine —
 * usable accounts, reasons, exclusivity per login store (two subscriptions = two parallel subscription jobs), the
 * family rule only for worker-account logins, strategies, the skip threshold and the authoritative paid switch.
 */

const runtime = (name: string): PlacementRuntime => ({
  runtime: name,
  version: '1.0.0',
  installed: true,
  authenticated: 'yes',
  pinStatus: 'match',
  pinnedVersion: '1.0.0',
});

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const FAMILY_B = '22222222-2222-4222-8222-222222222222';

const acct = (id: string, over: Partial<PlacementAccount> = {}): PlacementAccount => ({
  id,
  kind: 'subscription',
  store: id === 'default' ? 'claude' : `claude-${id}`,
  lendable: id !== 'default',
  isDefault: id === 'default',
  position: id === 'default' ? 0 : 1,
  login: 'ok',
  paused: false,
  usedPercent: null,
  active: 0,
  ...over,
});

const facts = (over: Partial<JobAccountFacts> = {}): JobAccountFacts => ({
  allowPaid: false,
  fallback: false,
  strategy: 'balanced',
  order: [],
  skipPercent: 90,
  ...over,
});

const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  project: 'genel',
  runtime: 'claude-code',
  sandboxProfile: 'host-restricted',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
  family: FAMILY_B,
  jobId: FAMILY_B,
  accounts: facts(),
  ...over,
});

const lease = (over: Partial<SlotLeaseFact> = {}): SlotLeaseFact => ({
  jobId: FAMILY_A,
  family: FAMILY_A,
  profile: 'host-restricted',
  runtime: 'claude-code',
  ownCredential: false,
  ...over,
});

/** The owner's Windows PC with per-job accounts: two Claude Code accounts (the configured one and an added one). */
function pc(
  accounts: readonly PlacementAccount[],
  leases: readonly SlotLeaseFact[] = [],
  over: Partial<PlacementWorker> = {},
): PlacementWorker {
  const profileActive: Record<string, number> = {};
  for (const l of leases) profileActive[l.profile] = (profileActive[l.profile] ?? 0) + 1;
  return {
    id: 'desktop-pc',
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'win32',
    arch: 'x64',
    runtimes: [runtime('claude-code'), runtime('codex')],
    sandboxProfiles: ['host-restricted'],
    maxParallelJobs: 4,
    activeLeases: leases.length,
    allowedProjects: null,
    localProjects: ['genel'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    profileConcurrency: { 'host-restricted': 4 },
    exclusiveProfiles: [],
    profileActive,
    urgentReserve: 0,
    localLogin: {
      runtimes: ['claude-code', 'codex'],
      exclusiveProfiles: ['host-restricted'],
      stores: { 'claude-code': 'claude', codex: 'codex' },
    },
    slotLeases: leases,
    accounts: { 'claude-code': accounts },
    ...over,
  };
}

const codes = (j: PlacementJob, w: PlacementWorker) => eligibility(j, w).map((r) => r.code);

describe('which accounts can take a job', () => {
  it('excludes paused, signed-out and limited accounts; honours a pin and exclusions', () => {
    const j = job();
    expect(accountExclusion(j, 'w', acct('a1', { paused: true }))).toBe('paused');
    expect(accountExclusion(j, 'w', acct('a1', { login: 'needs_login' }))).toBe('needs_login');
    expect(accountExclusion(j, 'w', acct('a1', { limitedUntil: '2026-10-19T15:00:00Z' }))).toBe('limited');
    expect(
      accountExclusion(job({ accounts: facts({ pin: { workerId: 'w', account: 'a2' } }) }), 'w', acct('a1')),
    ).toBe('not_pinned');
    expect(
      accountExclusion(
        job({ accounts: facts({ exclude: [{ workerId: 'w', account: 'a1' }] }) }),
        'w',
        acct('a1'),
      ),
    ).toBe('excluded');
    expect(accountExclusion(j, 'w', acct('a1'))).toBeNull();
  });

  it('the paid switch is authoritative: an added API-key account only with it, never the default key as a fallback', () => {
    const key = acct('k1', { kind: 'api_key', store: undefined, lendable: true });
    expect(accountExclusion(job(), 'w', key)).toBe('paid');
    expect(accountExclusion(job({ accounts: facts({ allowPaid: true }) }), 'w', key)).toBeNull();
    // A person's explicit pin is honoured (documented exception).
    expect(
      accountExclusion(job({ accounts: facts({ pin: { workerId: 'w', account: 'k1' } }) }), 'w', key),
    ).toBeNull();
    // Legacy API-key machine (its configured auth is a key): ordinary jobs yes, fallbacks only with the switch.
    const own = acct('default', { kind: 'api_key', store: undefined });
    expect(accountExclusion(job(), 'w', own)).toBeNull();
    expect(accountExclusion(job({ accounts: facts({ fallback: true }) }), 'w', own)).toBe('paid');
    expect(
      accountExclusion(job({ accounts: facts({ fallback: true, allowPaid: true }) }), 'w', own),
    ).toBeNull();
  });
});

describe('exclusivity per login store', () => {
  it('two added subscription accounts on one machine run two unrelated subscription jobs in parallel', () => {
    const w = pc([acct('default', { lendable: false }), acct('a1'), acct('a2')], [lease({ account: 'a1' })]);
    // a1 is busy (lent to the running job's per-job account); a2 runs beside it on its own per-job account.
    expect(codes(job(), w)).toEqual([]);
    expect(accountEligibility(job(), w)?.eligible.map((a) => a.id)).toEqual(['a2']);
    expect(place(job(), [w]).kind).toBe('placed');
  });

  it('the configured (default) login runs as the worker account: an unrelated lent-account job waits for it', () => {
    const w = pc([acct('default', { lendable: false }), acct('a1')], [lease({ account: 'default' })]);
    expect(codes(job(), w)).toEqual(['subscription_login_exclusive']);
    // … and its own sub-job may use the lent account beside it.
    expect(codes(job({ family: FAMILY_A }), w)).toEqual([]);
  });

  it('the same account never runs twice at once — inside the family too', () => {
    const w = pc([acct('a1')], [lease({ account: 'a1', family: FAMILY_B, jobId: FAMILY_A })]);
    const r = eligibility(job(), w);
    expect(r.map((x) => x.code)).toEqual(['subscription_login_busy']);
    expect(r[0]?.message).toMatch(/its only usable account is in use/);
    expect(BUSY_CODES.has('subscription_login_busy')).toBe(true);
  });

  it('a worker-account login (the default store) still shares the machine only with its own family', () => {
    const w = pc([acct('default', { lendable: false })], [lease({ runtime: 'codex', account: 'default' })], {
      accounts: { 'claude-code': [acct('default', { lendable: false })] },
    });
    expect(codes(job(), w)).toEqual(['subscription_login_exclusive']);
    expect(codes(job({ family: FAMILY_A }), w)).toEqual([]);
  });

  it('a lent account waits while another family runs a worker-account login (it could read the slot dirs)', () => {
    const w = pc(
      [acct('default', { lendable: false }), acct('a1')],
      [lease({ runtime: 'codex', ownCredential: false })],
      {
        accounts: {
          'claude-code': [acct('default', { lendable: false }), acct('a1')],
          codex: [acct('default', { store: 'codex', lendable: false })],
        },
      },
    );
    expect(codes(job(), w)).toEqual(['subscription_login_exclusive']);
  });

  it('no exclusivity where attempts are confined anyway (macOS Seatbelt): logins run in parallel as before', () => {
    const w = pc(
      [acct('default', { lendable: false }), acct('a1', { lendable: false })],
      [lease({ account: 'default' })],
      {
        os: 'darwin',
        localLogin: { runtimes: ['claude-code'], exclusiveProfiles: [], stores: { 'claude-code': 'claude' } },
      },
    );
    expect(accountEligibility(job(), w)?.eligible.map((a) => a.id)).toEqual(['default', 'a1']);
    expect(codes(job(), w)).toEqual([]);
  });
});

describe('reasons when no account can take the job', () => {
  it('every account limited → account_limited with the earliest reset (lets the next runtime option try)', () => {
    const w = pc([
      acct('default', { limitedUntil: '2026-10-19T18:00:00Z' }),
      acct('a1', { limitedUntil: '2026-10-19T16:00:00Z' }),
    ]);
    const r = eligibility(job(), w);
    expect(r.map((x) => x.code)).toEqual(['account_limited']);
    expect(r[0]?.until).toBe('2026-10-19T16:00:00Z');
    expect(r[0]?.permanent).toBe(false);
    expect(placementAllowsFallback(place(job(), [w]))).toBe(true);
  });

  it('every account signed out → the login wait of p10 (runtime_not_authenticated)', () => {
    const w = pc([acct('default', { login: 'needs_login' }), acct('a1', { login: 'needs_login' })]);
    expect(codes(job(), w)).toEqual(['runtime_not_authenticated']);
    expect(hasLoginExclusion(place(job(), [w]))).toBe(true);
  });

  it('one account signed out is no reason when another one works (per-account login)', () => {
    const w = pc([acct('default', { login: 'needs_login' }), acct('a1')], [], {
      runtimes: [{ ...runtime('claude-code'), authenticated: 'no' }],
    });
    expect(codes(job(), w)).toEqual([]);
  });

  it('paused / paid / pinned elsewhere → account_unavailable naming each', () => {
    const w = pc([
      acct('default', { paused: true, label: 'Kişisel Max' }),
      acct('k1', { kind: 'api_key', store: undefined }),
    ]);
    const r = eligibility(job(), w);
    expect(r.map((x) => x.code)).toEqual(['account_unavailable']);
    expect(r[0]?.message).toContain('Kişisel Max (default): paused');
    expect(r[0]?.message).toContain('k1: an API key (billed per token)');
    const pinned = eligibility(job({ accounts: facts({ pin: { workerId: 'other', account: 'a9' } }) }), w);
    expect(pinned[0]?.message).toBe('the job is pinned to a Claude Code account on other');
  });

  it('a job with its own credential (model-profile key) ignores accounts', () => {
    const w = pc([acct('default', { paused: true })]);
    expect(codes(job({ ownCredential: true }), w)).toEqual([]);
  });

  it('machines without accounts keep the p9 rules', () => {
    const w = pc([], [lease()], { accounts: undefined });
    expect(codes(job(), w)).toEqual(['subscription_login_busy', 'subscription_login_exclusive']);
  });
});

describe('choosing the account (strategy)', () => {
  const ranked = (list: readonly (readonly [string, readonly PlacementAccount[]])[]) =>
    list.map(([workerId, accounts]) => ({ workerId, accounts }));

  it('balanced (default): the account with the fewest running jobs, then the lower usage', () => {
    const picks = chooseAccounts(
      job(),
      ranked([
        ['w1', [acct('default', { active: 1, usedPercent: 10 }), acct('a1', { active: 0, usedPercent: 40 })]],
        ['w2', [acct('default', { active: 0, usedPercent: 20 })]],
      ]),
    );
    expect(picks.map((p) => `${p.workerId}/${p.account.id}`)).toEqual(['w2/default', 'w1/a1', 'w1/default']);
  });

  it('fill_first: the policy order, unlisted accounts after (default first)', () => {
    const j = job({
      accounts: facts({ strategy: 'fill_first', order: ['w2/claude-code/a7', 'w1/claude-code/a1'] }),
    });
    const picks = chooseAccounts(
      j,
      ranked([
        ['w1', [acct('default'), acct('a1')]],
        ['w2', [acct('a7'), acct('default')]],
      ]),
    );
    expect(picks.map((p) => `${p.workerId}/${p.account.id}`)).toEqual([
      'w2/a7',
      'w1/a1',
      'w1/default',
      'w2/default',
    ]);
  });

  it('least_used: the lowest usage first (unknown counts as unused)', () => {
    const j = job({ accounts: facts({ strategy: 'least_used' }) });
    const picks = chooseAccounts(
      j,
      ranked([
        ['w1', [acct('default', { usedPercent: 55 }), acct('a1', { usedPercent: 12 })]],
        ['w2', [acct('default', { usedPercent: null })]],
      ]),
    );
    expect(picks.map((p) => `${p.workerId}/${p.account.id}`)).toEqual(['w2/default', 'w1/a1', 'w1/default']);
  });

  it('accounts at or above the skip threshold go last; subscriptions before API keys', () => {
    const j = job({ accounts: facts({ allowPaid: true }) });
    const picks = chooseAccounts(
      j,
      ranked([
        [
          'w1',
          [
            acct('default', { usedPercent: 93 }),
            acct('k1', { kind: 'api_key', store: undefined, usedPercent: null }),
            acct('a1', { usedPercent: 50, active: 2 }),
          ],
        ],
      ]),
    );
    expect(picks.map((p) => p.account.id)).toEqual(['a1', 'k1', 'default']);
  });

  it('a lent account before a worker-account login (the latter would hold the machine alone)', () => {
    const picks = chooseAccounts(job(), ranked([['w1', [acct('default', { lendable: false }), acct('a1')]]]));
    expect(picks.map((p) => p.account.id)).toEqual(['a1', 'default']);
  });

  it("one account per machine (today's fleets): the machine rank decides", () => {
    const picks = chooseAccounts(
      job(),
      ranked([
        ['w9', [acct('default', { active: 3 })]],
        ['w1', [acct('default', { active: 0 })]],
      ]),
    );
    expect(picks.map((p) => p.workerId)).toEqual(['w9', 'w1']);
  });
});
