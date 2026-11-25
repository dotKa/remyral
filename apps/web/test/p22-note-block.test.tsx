import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/api/chat';
import { ChatRow } from '../src/diyalog/chat/rows';
import { Message } from '../src/diyalog/Message';

/**
 * p22-note-block (one-line rows that look alike are easy to confuse, so platform notes get their own shape): the turns
 * the platform writes into a conversation are a centred info block, apart from the person's bubbles and from the
 * one-line event / tool rows.
 */
describe('p22-note-block', () => {
  const row = (origin: string, content: string, meta: Record<string, unknown> = {}) => {
    const m = {
      id: `m-${origin}`,
      threadId: 't1',
      role: 'user',
      content,
      createdAt: '2026-11-16T12:27:00Z',
      meta: { origin, ...meta },
    } as unknown as ChatMessage;
    return { kind: 'row', key: m.id, at: m.createdAt, row: { kind: 'message', m, drafts: [] } } as const;
  };

  it("goal, watch, plan and late-result turns render as note blocks, never as the person's bubble", () => {
    const cases = [
      row('goal', 'Hedefe devam: Tarama birleştirmesi merge (c5c1f50e) — durdu. Hedef kaydını oku.'),
      row('watch', 'Beklediğin şey bitti: Deploy — koşul sağlandı.'),
      row('plan', 'Plana devam: sıradaki madde: Test (p-1)'),
      row('tool_result', 'late', { lateResult: { tool: 'export_workfiles' } }),
    ];
    for (const item of cases) {
      const { container, unmount } = render(
        <MemoryRouter>
          <ChatRow item={item as never} me="alex" />
        </MemoryRouter>,
      );
      expect(container.querySelector('[data-role="note"]')).not.toBeNull();
      expect(container.querySelector('[data-role="me"]')).toBeNull();
      expect(container.querySelector('[data-role="system"]')).toBeNull();
      expect(container.textContent).not.toContain('alex');
      unmount();
    }
  });

  it('a note is a centred, bordered block with its time under the text; event lines stay one rule-flanked line', () => {
    const { container } = render(
      <>
        <Message role="note" icon="flag" at="2026-11-16T12:27:00Z" atText="15:27">
          Asistan hedefi kontrol ediyor: X
        </Message>
        <Message role="system" icon="term" at="2026-11-16T12:27:00Z" atText="15:27">
          17 araç kullanıldı
        </Message>
      </>,
    );
    const note = container.querySelector('[data-role="note"]');
    expect(note?.className).toContain('justify-center');
    const box = note?.firstElementChild;
    expect(box?.className).toContain('border');
    expect(box?.className).toContain('bg-dy-sunk');
    expect(box?.lastElementChild?.tagName).toBe('TIME');
    expect(container.querySelector('[data-role="system"]')?.className).toContain('before:h-px');
  });
});
