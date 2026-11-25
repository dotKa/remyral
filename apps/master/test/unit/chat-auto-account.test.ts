import type { PlacementAccount } from '@remyral/scheduler';
import { describe, expect, it } from 'vitest';
import { pickAutoFallbackAccount } from '../../src/chat/auto-account.js';

const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

function acc(id: string, over: Partial<PlacementAccount> = {}): PlacementAccount {
  return {
    id,
    kind: 'subscription',
    store: `claude-${id}`,
    lendable: true,
    isDefault: id === 'default',
    position: id === 'default' ? 0 : Number(id.slice(-1)),
    login: 'ok',
    paused: false,
    usedPercent: null,
    active: 0,
    ...over,
  };
}

const base = {
  workerId: W,
  runtime: 'claude-code',
  mainAccount: 'default',
  chatLimited: [] as string[],
  allowPaid: false,
  policy: { strategy: 'balanced' as const, order: [] as string[], skipPercent: 100 },
};

describe('chat "Otomatik" fallback account (p15-message-delivery item 2)', () => {
  it('picks another ready account of the same runtime, never the limited main one', () => {
    expect(pickAutoFallbackAccount({ ...base, accounts: [acc('default'), acc('a1'), acc('a2')] })).toBe('a1');
  });

  it('skips paused, signed-out, limited (job episode) and chat-limited accounts — like jobs', () => {
    const accounts = [
      acc('default'),
      acc('a1', { paused: true }),
      acc('a2', { login: 'needs_login' }),
      acc('a3', { limitedUntil: '2026-10-21T20:00:00.000Z' }),
      acc('a4'),
      acc('a5'),
    ];
    expect(pickAutoFallbackAccount({ ...base, accounts, chatLimited: ['a4'] })).toBe('a5');
    expect(pickAutoFallbackAccount({ ...base, accounts, chatLimited: ['a4', 'a5'] })).toBeNull();
  });

  it('a paid API key only with the paid switch; the default key never as a fallback', () => {
    const key = acc('k1', { kind: 'api_key', store: undefined });
    expect(pickAutoFallbackAccount({ ...base, accounts: [acc('default'), key] })).toBeNull();
    expect(pickAutoFallbackAccount({ ...base, accounts: [acc('default'), key], allowPaid: true })).toBe('k1');
    // The main account is an added one; the machine's own key is not used as a fallback without the switch.
    const ownKey = acc('default', { kind: 'api_key', store: undefined });
    expect(pickAutoFallbackAccount({ ...base, mainAccount: 'a1', accounts: [ownKey, acc('a1')] })).toBeNull();
  });

  it('subscriptions before API keys; the workspace order decides between equals', () => {
    const accounts = [acc('default'), acc('k1', { kind: 'api_key', store: undefined }), acc('a1'), acc('a2')];
    expect(
      pickAutoFallbackAccount({
        ...base,
        accounts,
        allowPaid: true,
        policy: {
          strategy: 'fill_first',
          order: [`${W}/claude-code/a2`, `${W}/claude-code/a1`],
          skipPercent: 100,
        },
      }),
    ).toBe('a2');
  });
});
