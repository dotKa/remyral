import { describe, expect, it } from 'vitest';
import { busyBackoffMs, MAX_BUSY_BACKOFF_MS } from '../../src/queue/declines.js';
import { localLoginFacts, slotCounts, slotLease } from '../../src/queue/facts.js';
import { waitCategory } from '../../src/queue/service.js';

/** p9-queue-local-login-accounting: master-side pieces without a database. */
describe('subscription-login facts', () => {
  const ll = { runtimes: ['claude-code', 'codex'], exclusiveProfiles: ['host-restricted'] };

  it('localLogin is used only from profile-slots-v1 workers and only when it names runtimes and profiles', () => {
    expect(localLoginFacts(['profile-slots-v1'], ll)).toEqual(ll);
    expect(localLoginFacts([], ll)).toBeUndefined();
    expect(localLoginFacts(['profile-slots-v1'], null)).toBeUndefined();
    expect(
      localLoginFacts(['profile-slots-v1'], { runtimes: ['gpt'], exclusiveProfiles: [] }),
    ).toBeUndefined();
    expect(
      localLoginFacts(['profile-slots-v1'], { runtimes: ['codex'], exclusiveProfiles: [] }),
    ).toBeUndefined();
  });

  it('slot counts: total, per profile, and the attempts running with the subscription login', () => {
    const leases = [
      { profile: 'host-restricted', runtime: 'codex', ownCredential: false },
      { profile: 'host-restricted', runtime: 'codex', ownCredential: true },
      { profile: 'host-restricted', runtime: 'opencode', ownCredential: false },
      { profile: 'container', runtime: 'claude-code', ownCredential: false },
    ];
    expect(slotCounts(leases, ll)).toEqual({
      activeLeases: 4,
      profileActive: { 'host-restricted': 3, container: 1 },
      localLoginActive: 1,
      slotLeases: leases,
    });
    expect(slotCounts(leases, undefined).localLoginActive).toBe(0);
    expect(slotCounts([], ll)).toEqual({
      activeLeases: 0,
      profileActive: {},
      localLoginActive: 0,
      slotLeases: [],
    });
  });

  it('a busy-declined job’s pending re-ask holds no slot (SQL condition)', () => {
    const sql = slotLease('l', 'j');
    expect(sql).toContain('l.released_at IS NULL');
    expect(sql).toContain("j.state = 'RESERVED'");
    expect(sql).toContain("sd.kind = 'transient'");
  });

  it('the wait category of the new reason', () => {
    expect(waitCategory('subscription_login_exclusive')).toBe('subscription_login');
  });
});

describe('busy decline back-off', () => {
  it('doubles with every further busy decline of the same worker, capped, never below the worker’s ask', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => busyBackoffMs(5_000, n))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(busyBackoffMs(5_000, 1_000)).toBe(MAX_BUSY_BACKOFF_MS);
    expect(busyBackoffMs(600_000, 1)).toBe(600_000);
    expect(busyBackoffMs(15_000, 0)).toBe(15_000);
  });
});
