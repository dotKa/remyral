import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ChatDraft } from '../src/api/chat';
import { CardStrip } from '../src/diyalog/chat/CardStrip';
import type { StripCard } from '../src/diyalog/ops/timeline';
import { I18nProvider } from '../src/i18n/I18nProvider';

/**
 * p19-autonomy-aware: cards that ran without the person's click fold into one small line; cards that wait keep the
 * strip.
 */
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const now = new Date().toISOString();
const draft = (id: string, state: string, result: Record<string, unknown> | null): StripCard => {
  const d: ChatDraft = {
    id,
    threadId: THREAD,
    kind: 'job',
    title: `Job ${id}`,
    payload: {},
    project: 'shop',
    state,
    result,
    createdAt: now,
    expiresAt: now,
    decidedAt: state === 'proposed' ? null : now,
  };
  return { kind: 'draft', key: `draft:${id}`, d };
};

function show(cards: StripCard[]): void {
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <I18nProvider>
        <CardStrip cards={cards} threadId={THREAD} turnOpen={false} onChanged={() => undefined} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('cards that ran by themselves (p19-autonomy-aware)', () => {
  it('fold into one line next to a card that still waits', () => {
    show([
      draft('a', 'confirmed', { jobId: '11111111-1111-4111-8111-111111111111', autoRun: true }),
      draft('b', 'confirmed', { jobId: '33333333-3333-4333-8333-333333333333', autoRun: true }),
      draft('c', 'proposed', null),
    ]);
    expect(screen.getAllByTestId('strip-card')).toHaveLength(1);
    const toggle = screen.getByTestId('strip-auto-toggle');
    expect(toggle.textContent).toMatch(/2 (kart kendiliğinden çalıştı|cards ran by themselves)/);
    expect(screen.queryAllByTestId('strip-auto-card')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('strip-auto-card')).toHaveLength(2);
  });

  it('a card the person confirmed stays a normal card', () => {
    show([draft('d', 'confirmed', { jobId: '44444444-4444-4444-8444-444444444444' })]);
    expect(screen.getAllByTestId('strip-card')).toHaveLength(1);
    expect(screen.queryByTestId('strip-auto')).toBeNull();
  });
});
