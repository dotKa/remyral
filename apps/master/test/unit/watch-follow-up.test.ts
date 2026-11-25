import { describe, expect, it } from 'vitest';
import { autonomyBlock, directDecision, type DirectDecisionInput } from '../../src/chat/direct.js';
import { endReasonText, followUpText } from '../../src/chat/watch-follow-up.js';
import { effectivePolicy } from '../../src/security-policy/model.js';

/** p19-watch-follow-up: a watch that ended unmet hands the conversation back to the assistant. */
const turn: DirectDecisionInput = {
  tool: 'restart_service',
  execute: false,
  propose: false,
  byUser: false,
  proposeAware: true,
};

describe('watch follow-up turns (p19-watch-follow-up)', () => {
  it('runs only service (re)starts at once; every other draft stays a card', () => {
    expect(directDecision({ ...turn, followUp: true })).toEqual({ run: 'watch' });
    expect(directDecision({ ...turn, tool: 'start_service', followUp: true })).toEqual({ run: 'watch' });
    expect(directDecision({ ...turn, tool: 'stop_service', followUp: true })).toEqual({ run: null });
    expect(directDecision({ ...turn, tool: 'draft_deploy', followUp: true })).toEqual({ run: null });
    // Not a follow-up: a system turn keeps cards.
    expect(directDecision(turn)).toEqual({ run: null });
    // The assistant's own proposal stays a card.
    expect(directDecision({ ...turn, followUp: true, propose: true })).toEqual({ run: null });
  });

  it('the autonomy block tells the assistant what runs in a follow-up turn', () => {
    const b = autonomyBlock({
      byUser: false,
      proposeAware: true,
      plan: null,
      codeFreshUntil: null,
      followUp: true,
      policy: effectivePolicy({ preset: 'serbest' }),
    });
    expect(b).toContain('run_at_once_follow_up');
    expect(b).toContain('start_service / restart_service');
  });

  it('says why the watch ended, in the conversation’s language', () => {
    expect(endReasonText('tr', 'expired', 'Servis henüz ayakta değil')).toBe(
      'süresi içinde gerçekleşmedi (son kontrol: Servis henüz ayakta değil)',
    );
    expect(endReasonText('tr', 'never:never', 'Servis durdu (failed): exit 1')).toBe(
      'Servis durdu (failed): exit 1',
    );
    expect(endReasonText('en', 'never:gone', null)).toBe('the watched record is gone');
    const text = followUpText('tr', 'tasarim-onizleme', 'Servis durdu (failed)');
    expect(text.startsWith('Takip sonuçsuz bitti: tasarim-onizleme — Servis durdu (failed).')).toBe(true);
    expect(text).toContain('tam olarak ne yapması gerektiğini');
  });
});
