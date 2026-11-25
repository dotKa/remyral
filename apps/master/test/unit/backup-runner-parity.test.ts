import { describe, expect, it } from 'vitest';
import {
  canonicalJson as runnerCanonical,
  eventHashHex,
} from '../../../../infra/backup/runner/lib/audit-chain.mjs';
import { canonicalJson, eventHash, GENESIS_HASH } from '../../src/audit/hash.js';

/**
 * p10-backup-restore: the backup runner verifies restored audit chains with its own copy of the hash (it has no
 * access to the master's code inside the backup image). This keeps both implementations identical.
 */
describe('audit hash parity: master eventHash = backup runner eventHashHex', () => {
  const cases = [
    {
      id: '1',
      occurredAt: new Date('2026-10-18T02:30:05.123Z'),
      actorType: 'user',
      actorId: 'u-1',
      action: 'auth.login',
      target: null,
      outcome: 'success',
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (ünïcode ✓)',
      metadata: { z: 1, a: [true, null, { y: 'x', b: 2.5 }], s: 'quote " and \\ backslash' },
      prevHash: GENESIS_HASH,
    },
    {
      id: '9007199254740993',
      occurredAt: new Date('2027-01-01T00:00:00.000Z'),
      actorType: 'system',
      actorId: null,
      action: 'backup.drill',
      target: 'remana-prod-20261018T040000Z',
      outcome: 'failure',
      ip: null,
      userAgent: null,
      metadata: {},
      prevHash: Buffer.alloc(32, 0xab),
    },
  ];

  it('hashes identical rows identically', () => {
    for (const c of cases) {
      const master = eventHash(c).toString('hex');
      const runner = eventHashHex({
        ...c,
        occurredAt: c.occurredAt.toISOString(),
        prevHash: c.prevHash.toString('hex'),
      });
      expect(runner).toBe(master);
    }
  });

  it('canonical JSON is the same function', () => {
    const v = { b: [1, { d: null, c: 'x' }], a: { y: false, x: 0 } };
    expect(runnerCanonical(v)).toBe(canonicalJson(v));
  });
});
