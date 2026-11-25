import { describe, expect, it } from 'vitest';
import { type PendingEntry, pairingNetwork, pendingSlot } from '../../src/workers/directory.js';

const policy = { maxPending: 6, maxPendingPerNetwork: 3 };
const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, min));
let n = 0;
const entry = (network: string, min: number): PendingEntry => ({
  workerId: `w${String(++n)}`,
  network,
  expiresAt: at(min),
});

describe('pending pairing slots', () => {
  it('groups requests by IPv4 /24 and IPv6 /64 (IPv4-mapped counts as IPv4)', () => {
    expect(pairingNetwork('203.0.113.7')).toBe('203.0.113.0/24');
    expect(pairingNetwork('::ffff:203.0.113.9')).toBe('203.0.113.0/24');
    expect(pairingNetwork('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(pairingNetwork('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(pairingNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('caps one network, then evicts from the most crowded network, never a machine alone in its network', () => {
    const flood = [entry('A', 1), entry('A', 2), entry('A', 3)];
    expect(pendingSlot(flood, 'A', policy)).toEqual({ kind: 'network_full' });
    expect(pendingSlot(flood, 'L', policy)).toEqual({ kind: 'ok' });
    // Full: three from A, two from B, one legitimate machine alone in L.
    const full = [...flood, entry('B', 4), entry('B', 5), entry('L', 0)];
    // A newcomer from a fresh network pushes out A's oldest entry (A has the most).
    expect(pendingSlot(full, 'N', policy)).toEqual({ kind: 'evict', workerId: flood[0]?.workerId });
    // A's own devices cannot push anybody out (nobody holds two more than A would) ...
    const after = [...full.slice(1), entry('N', 6)];
    expect(pendingSlot(after, 'A', policy)).toEqual({ kind: 'full' });
    // ... and the lone machine in L is never the victim, whoever asks.
    const spread = [entry('A', 1), entry('B', 2), entry('C', 3), entry('D', 4), entry('E', 5), entry('L', 0)];
    expect(pendingSlot(spread, 'N', policy)).toEqual({ kind: 'full' });
  });
});
