// p15-chat-cards-scroll item 3 (scrolling while a message streams must not be pulled back down): live
// views follow their end only while the reader is there. The reader's own upward scroll stops following at once (even a
// few pixels from the end); back at the end it follows again. The Sohbet thread is covered in
// diyalog-scroll-anchor.test.tsx; here the rule itself and the job page's activity log.
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../src/diyalog/job/ActivityLog';
import type { LogRow } from '../src/diyalog/job/log';
import { FOLLOW_PX, followAfterScroll, INTENT_MS, watchScrollIntent } from '../src/lib/scrollIntent';

describe('followAfterScroll / watchScrollIntent', () => {
  it('the reader’s own upward scroll stops following; the end follows again; page-made scrolls never count', () => {
    const at = { top: 970, lastTop: 1000, distanceToEnd: 30 };
    // Up 30 px by the reader, still inside FOLLOW_PX: stop.
    expect(followAfterScroll({ following: true, ...at, userInput: true })).toBe(false);
    // The same movement without input (a list shrinking, scroll anchoring): unchanged.
    expect(followAfterScroll({ following: true, ...at, userInput: false })).toBe(true);
    // Back at the end (moving down): follow again.
    expect(
      followAfterScroll({ following: false, top: 1000, lastTop: 900, distanceToEnd: 0, userInput: true }),
    ).toBe(true);
    // Down but still far from the end: unchanged.
    expect(
      followAfterScroll({
        following: false,
        top: 500,
        lastTop: 400,
        distanceToEnd: FOLLOW_PX + 1,
        userInput: true,
      }),
    ).toBe(false);
  });

  it('counts wheel / touch / key / pointer input as the reader’s for a short while; a wheel turned up calls onUp', () => {
    let now = 1_000;
    const el = document.createElement('div');
    const up = vi.fn();
    const intent = watchScrollIntent(el, up, () => now);
    expect(intent.recent()).toBe(false);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }));
    expect(intent.recent()).toBe(true);
    expect(up).not.toHaveBeenCalled();
    now += INTENT_MS + 1;
    expect(intent.recent()).toBe(false);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
    expect(up).toHaveBeenCalledTimes(1);
    intent.dispose();
    now += INTENT_MS + 1;
    el.dispatchEvent(new Event('keydown'));
    expect(intent.recent()).toBe(false);
  });
});

function row(i: number): LogRow {
  return {
    kind: 'text',
    key: `r${String(i)}`,
    at: new Date(Date.UTC(2026, 9, 22, 10, 0, i)).toISOString(),
    group: 'agent',
    icon: 'bubble',
    who: 'agent',
    text: `Satır ${String(i)}`,
    body: null,
    markdown: false,
    error: false,
  };
}

function Log(props: { readonly n: number }): ReactNode {
  return (
    <MemoryRouter>
      <ActivityLog
        rows={Array.from({ length: props.n }, (_, i) => row(i))}
        runtime="claude-code"
        now={null}
        partial={false}
        logsHref="/jobs/x?tab=logs"
        onApproval={() => undefined}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('job activity log follow', () => {
  it('a reader scrolling up a little is not pulled back by new rows; at the end it follows again', () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      fn(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    let height = 1000;
    const view = render(<Log n={5} />);
    const box = screen.getByTestId('dy-log-box');
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 200 });
    const follow = screen.getByTestId('dy-log-follow');
    view.rerender(<Log n={6} />);
    expect(box.scrollTop).toBe(1000);
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    const scrollBy = (top: number): void => {
      act(() => {
        box.dispatchEvent(new WheelEvent('wheel', { deltaY: top < box.scrollTop ? -10 : 10 }));
        box.scrollTop = top;
        box.dispatchEvent(new Event('scroll'));
      });
    };
    // The browser clamps the follow scroll to the real end (no input: still following) …
    act(() => {
      box.scrollTop = 800;
      box.dispatchEvent(new Event('scroll'));
    });
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    // … then the reader moves up 20 px — inside the old "near the end" zone: following stops at once.
    scrollBy(780);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    height = 1100;
    view.rerender(<Log n={8} />);
    expect(box.scrollTop).toBe(780);
    expect(screen.getByTestId('dy-now-pill').textContent).toMatch(/2/);
    // Back at the end: following again, the count is gone.
    scrollBy(900);
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('dy-now-pill')).toBeNull();
    height = 1200;
    view.rerender(<Log n={9} />);
    expect(box.scrollTop).toBe(1200);
  });
});
