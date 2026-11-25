import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatCidr, ipAllowed, parseCidr } from '../../src/api-tokens/cidr.js';
import {
  bearerOf,
  crc32,
  generateToken,
  hashToken,
  parseToken,
  TOKEN_PATTERN,
  tokenHint,
} from '../../src/api-tokens/format.js';
import {
  FallbackConcurrencyGuard,
  MemoryConcurrencyGuard,
  scaleTokenLimits,
  TOKEN_REQUEST_LIMITS,
} from '../../src/api-tokens/limits.js';
import {
  reachableScopes,
  scopeForAction,
  TOKEN_SCOPE_OF,
  TOKEN_SCOPES,
} from '../../src/api-tokens/scopes.js';
import { GRANTABLE_EVENTS, tokenState } from '../../src/api-tokens/service.js';
import { TokenUsageCounter } from '../../src/api-tokens/usage.js';
import { ACTION_NAMES } from '../../src/authz/model.js';
import { CORE_EVENTS } from '../../src/security-policy/events.js';
import { applyPatch, effectivePolicy, PRESETS } from '../../src/security-policy/model.js';

describe('token format (p16-api-tokens)', () => {
  it('generates recognisable tokens with a valid checksum', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pat = generateToken('personal');
      const sa = generateToken('service');
      expect(pat).toMatch(/^ryl_pat_[0-9A-Za-z]{46}$/);
      expect(sa).toMatch(/^ryl_sa_[0-9A-Za-z]{46}$/);
      expect(parseToken(pat)).toBe('personal');
      expect(parseToken(sa)).toBe('service');
      seen.add(pat);
    }
    expect(seen.size).toBe(200);
  });

  it('rejects typos, foreign prefixes and bad checksums without a lookup', () => {
    const t = generateToken('personal');
    const last = t.at(-1) === 'A' ? 'B' : 'A';
    expect(parseToken(`${t.slice(0, -1)}${last}`)).toBeNull();
    expect(parseToken(t.replace('ryl_pat_', 'rmn_xyz_'))).toBeNull();
    expect(parseToken(`${t}x`)).toBeNull();
    expect(parseToken('ghp_abc')).toBeNull();
    expect(TOKEN_PATTERN.test(t)).toBe(true);
  });

  it('CRC-32 is the IEEE/zlib checksum', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });

  it('hints show only the prefix and four characters on each side', () => {
    const t = generateToken('service');
    expect(tokenHint(t)).toBe(`ryl_sa_${t.slice(7, 11)}…${t.slice(-4)}`);
    expect(tokenHint(t)).not.toContain(t.slice(11, -4));
  });

  it('hashes with a key: the same token under another key is a different hash', () => {
    const t = generateToken('personal');
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    expect(hashToken(k1, t).equals(hashToken(k1, t))).toBe(true);
    expect(hashToken(k1, t).equals(hashToken(k2, t))).toBe(false);
    expect(hashToken(k1, t)).toHaveLength(32);
  });

  it('reads only the Bearer scheme', () => {
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf('bearer  abc ')).toBe('abc');
    expect(bearerOf('Basic abc')).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
    expect(bearerOf(['Bearer a', 'Bearer b'])).toBeUndefined();
  });
});

describe('IP ranges', () => {
  it('parses IPv4 / IPv6 ranges and single addresses', () => {
    expect(formatCidr(parseCidr('10.0.0.0/8') ?? { address: '', prefix: 0, family: 'ipv4' })).toBe(
      '10.0.0.0/8',
    );
    expect(parseCidr('192.0.2.7')).toMatchObject({ prefix: 32, family: 'ipv4' });
    expect(parseCidr('2001:DB8::/32')).toMatchObject({ address: '2001:db8::', prefix: 32, family: 'ipv6' });
    for (const bad of ['10.0.0.0/33', 'x', '10.0.0.0/8/1', '::/129', '10.0.0.0/-1', '']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });

  it('matches addresses, also IPv4-mapped IPv6', () => {
    expect(ipAllowed('203.0.113.9', [])).toBe(true);
    expect(ipAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false);
  });
});

describe('scopes', () => {
  it('decide every catalogued action (scope or session only)', () => {
    expect(Object.keys(TOKEN_SCOPE_OF).sort()).toEqual([...ACTION_NAMES].sort());
    for (const a of ACTION_NAMES) {
      const s = TOKEN_SCOPE_OF[a];
      if (s !== null) expect(TOKEN_SCOPES).toContain(s);
    }
  });

  it('keep account, token, user and security writes session only', () => {
    for (const a of [
      'session.self',
      'tokens.self',
      'tokens.admin',
      'serviceaccounts.read',
      'serviceaccounts.manage',
      'users.manage',
      'security.write',
      'chat.use',
      'previews.reveal',
      'vault.write',
      'machines.admin.enable',
    ]) {
      expect(scopeForAction(a), a).toBeNull();
    }
    expect(scopeForAction('nope.nope')).toBeNull();
    expect(scopeForAction(undefined)).toBeNull();
  });

  it('a role reaches only the scopes it can use', () => {
    expect(reachableScopes('viewer')).toEqual(['read']);
    expect(reachableScopes('operator')).toEqual(['read', 'jobs:write', 'approvals', 'deploy']);
    expect(reachableScopes('admin')).toEqual([...TOKEN_SCOPES]);
  });
});

describe('policy and grants', () => {
  it('every preset refuses event grants by default; Sıkı caps tokens at 90 days', () => {
    for (const p of Object.values(PRESETS)) expect(p.apiTokens.eventGrants).toBe(false);
    expect(PRESETS.siki.apiTokens.maxDays).toBe(90);
    expect(PRESETS.serbest.apiTokens).toEqual({ personal: true, maxDays: 365, eventGrants: false });
    const doc = applyPatch({ preset: 'serbest' }, { apiTokens: { eventGrants: true, maxDays: 30 } });
    expect(doc.apiTokens).toEqual({ eventGrants: true, maxDays: 30 });
    expect(effectivePolicy(doc).customized).toBe(true);
  });

  it('the safe core can never be granted', () => {
    for (const e of CORE_EVENTS) expect(GRANTABLE_EVENTS).not.toContain(e);
    expect(GRANTABLE_EVENTS).toContain('machines.fleet');
  });

  it('token state', () => {
    const now = new Date('2026-10-23T00:00:00Z');
    expect(tokenState({ revokedAt: null, expiresAt: new Date('2026-10-24T00:00:00Z') }, now)).toBe('active');
    expect(tokenState({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
    expect(tokenState({ revokedAt: now, expiresAt: new Date('2027-01-01T00:00:00Z') }, now)).toBe('revoked');
  });
});

describe('limits', () => {
  it('scales budgets but not the concurrency cap', () => {
    const s = scaleTokenLimits(TOKEN_REQUEST_LIMITS, 2);
    expect(s.perToken.read.max).toBe(1200);
    expect(s.concurrency).toBe(TOKEN_REQUEST_LIMITS.concurrency);
  });

  it('the in-process guard holds at most max slots per key', async () => {
    const g = new MemoryConcurrencyGuard();
    expect(await g.acquire('t', 2)).toBe(true);
    expect(await g.acquire('t', 2)).toBe(true);
    expect(await g.acquire('t', 2)).toBe(false);
    expect(await g.acquire('u', 2)).toBe(true);
    await g.release('t');
    expect(await g.acquire('t', 2)).toBe(true);
  });

  it('falls back to per-process slots while the shared guard fails, and releases where it acquired', async () => {
    let failing = true;
    const primary = new MemoryConcurrencyGuard();
    const flaky = {
      acquire: (k: string, m: number) =>
        failing ? Promise.reject(new Error('down')) : primary.acquire(k, m),
      release: (k: string) => primary.release(k),
    };
    const errors: unknown[] = [];
    const g = new FallbackConcurrencyGuard(flaky, (e) => errors.push(e));
    expect(await g.acquire('t', 1)).toBe(true);
    expect(await g.acquire('t', 1)).toBe(false);
    failing = false;
    await g.release('t');
    expect(await g.acquire('t', 1)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('usage counter', () => {
  it('writes the first use at once and adds up the rest until the flush', async () => {
    const writes: { id: string; count: number }[][] = [];
    const c = new TokenUsageCounter(
      {
        addUses: (e) => {
          writes.push(e.map(({ id, count }) => ({ id, count })));
          return Promise.resolve();
        },
      },
      () => undefined,
      60_000,
    );
    const t0 = new Date('2026-10-23T10:00:00Z');
    c.record('a', t0, '192.0.2.1');
    await Promise.resolve();
    c.record('a', new Date(t0.getTime() + 1_000), '192.0.2.1');
    c.record('a', new Date(t0.getTime() + 2_000), '192.0.2.2');
    expect(writes).toEqual([[{ id: 'a', count: 1 }]]);
    await c.flush();
    expect(writes.at(-1)).toEqual([{ id: 'a', count: 2 }]);
    // A minute later the next use is written at once again.
    c.record('a', new Date(t0.getTime() + 62_000), null);
    await Promise.resolve();
    expect(writes.at(-1)).toEqual([{ id: 'a', count: 1 }]);
  });
});
