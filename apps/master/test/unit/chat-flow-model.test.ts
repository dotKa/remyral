import { describe, expect, it } from 'vitest';
import { approvalTexts, eventKey, outputSummary, plainLine } from '../../src/chat/flow-model.js';

/** p17-chat-flow: the bounded, secret-free texts of the chat's workflow cards (pure). */
describe('chat flow model (p17-chat-flow)', () => {
  it('plainLine folds control characters and clips', () => {
    expect(plainLine('a\n\tb\u2028c', 10)).toBe('a b c');
    expect(plainLine('x'.repeat(20), 5)).toBe('xxxx…');
  });

  it('outputSummary: AI summaries, strings, single ports, JSON; redacted; nothing for pruned data', () => {
    expect(outputSummary({ summary: 'Fixed the login test', branch: 'b', commits: [] })).toBe(
      'Fixed the login test',
    );
    expect(outputSummary('done')).toBe('done');
    expect(outputSummary({ ports: { out: { ok: true } } })).toBe('{"ok":true}');
    expect(outputSummary({ ports: { a: 1, b: 2 } })).toBe('{"a":1,"b":2}');
    expect(outputSummary(null)).toBeNull();
    expect(outputSummary({ $pruned: true })).toBeNull();
    const secret = outputSummary({ token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }) ?? '';
    expect(secret).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect((outputSummary('y'.repeat(1000)) ?? '').length).toBeLessThanOrEqual(300);
  });

  it('approvalTexts: title one line, details bounded, JSON details stringified', () => {
    expect(approvalTexts({ title: 'Ship\nit?', details: 'notes' })).toEqual({
      title: 'Ship it?',
      details: 'notes',
    });
    expect(approvalTexts({ title: '', details: { a: 1 } })).toEqual({ title: null, details: '{"a":1}' });
    expect(approvalTexts(null)).toEqual({ title: null, details: null });
    expect((approvalTexts({ details: 'd'.repeat(5000) }).details ?? '').length).toBe(2000);
  });

  it('eventKey', () => {
    expect(eventKey('approval', 'ABCDEF00-0000-4000-8000-000000000000')).toBe(
      'approval:abcdef00-0000-4000-8000-000000000000',
    );
  });
});
