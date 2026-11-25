import { describe, expect, it } from 'vitest';
import { desiredUpdate, inRollout, rolloutBucket } from '../../src/releases/rollout.js';

const ids = Array.from({ length: 2000 }, (_, i) => `wrk_${i.toString(32).padStart(26, 'a')}`);

describe('rollout percentage (p2-signed-updates)', () => {
  it('is deterministic per worker and release', () => {
    for (const id of ids.slice(0, 50)) {
      expect(rolloutBucket(id, '1.2.0')).toBe(rolloutBucket(id, '1.2.0'));
      expect(rolloutBucket(id, '1.2.0')).toBeGreaterThanOrEqual(0);
      expect(rolloutBucket(id, '1.2.0')).toBeLessThan(100);
    }
    // A known vector pins the hash input format (changing it would reshuffle every rollout).
    expect(rolloutBucket('wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa', '1.2.0')).toBe(79); // p17: remyral-rollout/v1 (buckets reshuffled once at the rename);
  });

  it('raising the percentage only adds workers (monotonic), 0% none, 100% all', () => {
    let previous = new Set<string>();
    for (const pct of [0, 1, 5, 10, 25, 50, 75, 100]) {
      const included = new Set(ids.filter((id) => inRollout(id, '1.2.0', pct)));
      for (const id of previous) expect(included.has(id)).toBe(true);
      previous = included;
    }
    expect(ids.filter((id) => inRollout(id, '1.2.0', 0))).toEqual([]);
    expect(ids.filter((id) => inRollout(id, '1.2.0', 100))).toHaveLength(ids.length);
  });

  it('is roughly uniform and differs between releases', () => {
    const tenPct = ids.filter((id) => inRollout(id, '1.2.0', 10)).length;
    expect(tenPct).toBeGreaterThan(140);
    expect(tenPct).toBeLessThan(260);
    const a = ids.filter((id) => inRollout(id, '1.2.0', 10));
    const b = new Set(ids.filter((id) => inRollout(id, '1.3.0', 10)));
    expect(a.filter((id) => b.has(id)).length).toBeLessThan(a.length / 2);
  });
});

describe('desired update', () => {
  const stable = new Map([['stable' as const, { version: '1.2.0', rolloutPercent: 100 }]]);
  const w = ids[0] ?? '';

  it('offers a newer channel version, never an equal or older one', () => {
    expect(desiredUpdate(w, '1.1.0', null, stable)).toEqual({
      version: '1.2.0',
      source: 'channel',
      rollback: false,
      force: false,
    });
    expect(desiredUpdate(w, '1.2.0', null, stable)).toBeNull();
    expect(desiredUpdate(w, '1.3.0', null, stable)).toBeNull();
    // A pre-release build of the same version is older.
    expect(desiredUpdate(w, '1.2.0-rc.1', null, stable)?.version).toBe('1.2.0');
    expect(desiredUpdate(w, 'dev-build', null, stable)?.version).toBe('1.2.0');
  });

  it('follows the worker’s channel and the rollout bucket', () => {
    const channels = new Map([
      ['stable' as const, { version: '1.2.0', rolloutPercent: 100 }],
      ['canary' as const, { version: '1.3.0-rc.1', rolloutPercent: 100 }],
    ]);
    const canary = { channel: 'canary' as const, targetVersion: null, rollback: false, force: false };
    expect(desiredUpdate(w, '1.1.0', canary, channels)?.version).toBe('1.3.0-rc.1');
    const outside = ids.find((id) => !inRollout(id, '1.2.0', 30)) ?? '';
    const inside = ids.find((id) => inRollout(id, '1.2.0', 30)) ?? '';
    const partial = new Map([['stable' as const, { version: '1.2.0', rolloutPercent: 30 }]]);
    expect(desiredUpdate(outside, '1.1.0', null, partial)).toBeNull();
    expect(desiredUpdate(inside, '1.1.0', null, partial)?.version).toBe('1.2.0');
  });

  it('an explicit target pins; a lower target needs an explicit rollback', () => {
    const pin = { channel: 'stable' as const, targetVersion: '1.1.5', rollback: false, force: true };
    expect(desiredUpdate(w, '1.1.0', pin, stable)).toEqual({
      version: '1.1.5',
      source: 'target',
      rollback: false,
      force: true,
    });
    expect(desiredUpdate(w, '1.1.5', pin, stable)).toBeNull(); // pinned: the channel's 1.2.0 is not offered
    expect(desiredUpdate(w, '1.2.0', pin, stable)).toBeNull(); // downgrade without rollback
    expect(desiredUpdate(w, '1.2.0', { ...pin, rollback: true }, stable)).toMatchObject({
      version: '1.1.5',
      rollback: true,
    });
  });
});
