import { messagesFor } from '@remyral/i18n';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/api/chat';
import { goalResumeLine } from '../src/diyalog/chat/rows';
import { Markdown } from '../src/screens/chat/markdown';

/**
 * p22-goal-line: a goal's resume turn is written by the
 * platform, so it is one quiet line, not the person's message; and a Markdown escape shows the character alone
 * ("coolify.deploy \(production\)" showed its backslashes).
 */
describe('p22-goal-line', () => {
  const msg = (content: string): ChatMessage =>
    ({
      id: 'm1',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      meta: { origin: 'goal' },
    }) as never;

  it('a goal resume turn reads as the assistant checking the goal, with its title', () => {
    const tr = messagesFor('tr');
    const en = messagesFor('en');
    const text =
      'Hedefe devam: sample-leads: Tüm tekliflerin tarihini 9 Kasım yap — kendi kontrol zamanın geldi. Hedef kaydını oku.';
    expect(goalResumeLine(tr, msg(text))).toBe(
      'Asistan hedefi kontrol ediyor: sample-leads: Tüm tekliflerin tarihini 9 Kasım yap',
    );
    expect(goalResumeLine(en, msg('Resume the goal: Ship **it** — your check is due.'))).toBe(
      'The assistant checks the goal: Ship it',
    );
    expect(goalResumeLine(tr, msg('something else'))).toBe('Asistan hedefi kontrol ediyor');
  });

  it('Markdown backslash escapes render the character without the backslash', () => {
    const { container } = render(
      <Markdown
        text={
          '**Deploy başarıyla bitti:** coolify.deploy \\(production\\) d85e6d64 \\*x\\* a\\_b `\\(kept\\)`'
        }
      />,
    );
    expect(container.textContent).toBe(
      'Deploy başarıyla bitti: coolify.deploy (production) d85e6d64 *x* a_b \\(kept\\)',
    );
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Deploy başarıyla bitti:');
  });
});
