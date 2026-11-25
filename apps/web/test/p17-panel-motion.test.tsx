// p17-panel-motion (docs/design/p17-panel-motion.md): the motion helpers decide WHEN something may move — never on the
// first render of a list, never for a bulk load, never under reduced motion — and measure what CSS cannot (a card's
// height, a row's old place). jsdom has no layout and no Web Animations: boxes, ResizeObserver and Element.animate are
// small models here.
import { act, render, renderHook, screen } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeTicks, useShake } from '../src/diyalog/codeMotion';
import { StepBar } from '../src/diyalog/job/StepBar';
import type { JobStep } from '../src/diyalog/job/steps';
import {
  ARRIVAL_MS,
  BURST_MAX,
  FLIP_MAX,
  STAGGER_MAX,
  Swap,
  useArrivals,
  useChangeCount,
  useFlip,
  useSmoothHeight,
} from '../src/diyalog/motionKit';

import { StateBadge } from '../src/diyalog/StateBadge';
import { Thread } from '../src/diyalog/Thread';

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: reduce && q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// ------------------------------------------------------------------ a tiny layout + Web Animations model

interface Fake {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly el: HTMLElement;
  cancel: () => void;
}
let animations: Fake[] = [];
const observers = new Set<{ cb: () => void; targets: Set<Element> }>();

function installAnimate(): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const a: Fake = { keyframes, options, el: this, cancel: vi.fn() };
      animations.push(a);
      return { ...a, addEventListener: vi.fn() };
    },
  });
}

/** Fire every ResizeObserver watching `el` (or all). */
function resized(el?: Element): void {
  act(() => {
    for (const o of observers) if (el === undefined || o.targets.has(el)) o.cb();
  });
}

beforeEach(() => {
  animations = [];
  observers.clear();
  stubReducedMotion(false);
  installAnimate();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly entry: { cb: () => void; targets: Set<Element> };
      constructor(cb: () => void) {
        this.entry = { cb, targets: new Set() };
        observers.add(this.entry);
      }
      observe(el: Element): void {
        this.entry.targets.add(el);
      }
      unobserve(): void {
        // not needed
      }
      disconnect(): void {
        observers.delete(this.entry);
      }
    },
  );
  vi.stubGlobal('innerHeight', 800);
});

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.useRealTimers();
});

// ------------------------------------------------------------------ arrivals

describe('useArrivals', () => {
  it('the first list stands still; later keys arrive in burst order (stagger, capped) for ARRIVAL_MS', () => {
    let now = 10_000;
    const { result, rerender } = renderHook(({ keys }: { keys: string[] }) => useArrivals(keys, true, now), {
      initialProps: { keys: ['a', 'b'] },
    });
    expect(result.current.size).toBe(0);
    const burst = Array.from({ length: STAGGER_MAX + 3 }, (_, i) => `n${String(i)}`);
    rerender({ keys: ['a', 'b', ...burst] });
    expect(result.current.get('n0')).toBe(0);
    expect(result.current.get('n1')).toBe(1);
    expect(result.current.get(`n${String(STAGGER_MAX + 2)}`)).toBe(STAGGER_MAX);
    expect(result.current.has('a')).toBe(false);
    now += ARRIVAL_MS;
    rerender({ keys: ['a', 'b', ...burst] });
    expect(result.current.size).toBe(0);
  });

  it('waits for the first ready, non-empty list; an older page and a backlog burst are history', () => {
    const now = 5_000;
    const { result, rerender } = renderHook(
      ({ keys, ready }: { keys: string[]; ready: boolean }) => useArrivals(keys, ready, now),
      { initialProps: { keys: [] as string[], ready: true } },
    );
    rerender({ keys: ['a'], ready: false });
    rerender({ keys: ['a', 'b'], ready: true });
    expect(result.current.size).toBe(0);
    // Older items loaded above everything known.
    rerender({ keys: ['o1', 'o2', 'a', 'b'], ready: true });
    expect(result.current.size).toBe(0);
    // More than BURST_MAX new at once (a reconnect backlog).
    const backlog = Array.from({ length: BURST_MAX + 1 }, (_, i) => `x${String(i)}`);
    rerender({ keys: ['o1', 'o2', 'a', 'b', ...backlog], ready: true });
    expect(result.current.size).toBe(0);
    rerender({ keys: ['o1', 'o2', 'a', 'b', ...backlog, 'c'], ready: true });
    expect([...result.current]).toEqual([['c', 0]]);
  });

  it('Thread: the opening items stand still, a burst rises in staggered, `itemProps` names the entrance', () => {
    const view = (ids: string[]): ReactNode => (
      <div data-ui="diyalog">
        <Thread
          label="Sohbet"
          items={ids}
          itemKey={(i) => i}
          itemProps={(i) => ({ 'data-enter': i.startsWith('me') ? 'me' : undefined })}
          renderItem={(i) => <p>{i}</p>}
        />
      </div>
    );
    const r = render(view(['a', 'b']));
    expect(document.querySelectorAll('.dy-enter')).toHaveLength(0);
    r.rerender(view(['a', 'b', 'me1', 'c']));
    const me = document.querySelector<HTMLElement>('[data-key="me1"]');
    const c = document.querySelector<HTMLElement>('[data-key="c"]');
    expect(me?.className).toContain('dy-enter');
    expect(me?.dataset.enter).toBe('me');
    expect(me?.style.getPropertyValue('--dy-i')).toBe('');
    expect(c?.style.getPropertyValue('--dy-i')).toBe('1');
  });
});

// ------------------------------------------------------------------ state swaps

describe('state swaps', () => {
  it('useChangeCount is 0 on the first render and counts real changes only', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useChangeCount(v), {
      initialProps: { v: 'needs' },
    });
    expect(result.current).toBe(0);
    rerender({ v: 'needs' });
    expect(result.current).toBe(0);
    rerender({ v: 'running' });
    expect(result.current).toBe(1);
  });

  it('StateBadge cross-fades a new state in, never on first render nor for a label-only change; one label at a time', () => {
    const r = render(<StateBadge state="needs" label="Onay bekliyor" />);
    const first = screen.getByText('Onay bekliyor');
    expect(first.className).not.toContain('dy-m-swap');
    r.rerender(<StateBadge state="running" label="Çalışıyor 3/5" />);
    const running = screen.getByText('Çalışıyor 3/5');
    expect(running.className).toContain('dy-m-swap');
    expect(screen.queryByText('Onay bekliyor')).toBeNull();
    r.rerender(<StateBadge state="running" label="Çalışıyor 4/5" />);
    // Same element: the label changes in place (no second swap).
    expect(screen.getByText('Çalışıyor 4/5')).toBe(running);
  });

  it('Swap marks only a changed value', () => {
    const r = render(<Swap k="a">A</Swap>);
    expect(screen.getByText('A').hasAttribute('data-swap')).toBe(false);
    r.rerender(<Swap k="b">B</Swap>);
    expect(screen.getByText('B').hasAttribute('data-swap')).toBe(true);
  });

  it('StepBar: a step that starts fills (todo segments are scaled to 0, then grow); the first render has no swap', () => {
    const steps = (s2: JobStep['status']): JobStep[] => [
      { key: 'queue', label: 'Kuyruk', status: 'done', note: null },
      { key: 'start', label: 'Çalıştırma', status: s2, note: null },
    ];
    const r = render(
      <MemoryRouter>
        <StepBar steps={steps('todo')} />
      </MemoryRouter>,
    );
    const seg = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-step="start"] .dy-m-fill');
    expect(seg()?.style.transform).toBe('scaleX(0)');
    expect(document.querySelector('[data-swap]')).toBeNull();
    r.rerender(
      <MemoryRouter>
        <StepBar steps={steps('current')} />
      </MemoryRouter>,
    );
    expect(seg()?.style.transform).toBe('');
    expect(document.querySelector('[data-step="start"] [data-swap]')).not.toBeNull();
  });
});

// ------------------------------------------------------------------ height

function HeightBox(props: { readonly children: ReactNode; readonly reduce?: boolean }): ReactNode {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useSmoothHeight(outer, inner);
  return (
    <div data-ui="diyalog" data-motion={props.reduce === true ? 'reduce' : undefined}>
      <div ref={outer} data-testid="outer">
        <div ref={inner} data-testid="inner">
          {props.children}
        </div>
      </div>
    </div>
  );
}

describe('useSmoothHeight', () => {
  let h = 100;
  let top = 50;
  beforeEach(() => {
    h = 100;
    top = 50;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'outer' ? h : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top, bottom: top + h, height: h, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect,
    );
  });
  /** The content changes to `text` (a DOM mutation) and the box's natural height becomes `next`. */
  async function change(
    r: ReturnType<typeof render>,
    text: string,
    next: number,
    reduce = false,
  ): Promise<void> {
    h = next;
    r.rerender(<HeightBox reduce={reduce}>{text}</HeightBox>);
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('records the first size, then eases a content change from the old height to the new one', async () => {
    const r = render(<HeightBox>kart</HeightBox>);
    resized();
    expect(animations).toHaveLength(0);
    await change(r, 'kart ve karar satırı', 180);
    expect(animations).toHaveLength(1);
    expect(animations[0]?.keyframes).toEqual([{ height: '100px' }, { height: '180px' }]);
    expect(animations[0]?.options.duration).toBe(220);
    expect(screen.getByTestId('outer').hasAttribute('data-dy-resizing')).toBe(true);
  });

  it('a size change that is not a content change (image, fonts, window) is recorded, never animated', async () => {
    const r = render(<HeightBox>kart</HeightBox>);
    h = 160;
    resized();
    expect(animations).toHaveLength(0);
    // The next content change eases from the recorded 160, not from the stale 100.
    await change(r, 'kart 2', 200);
    expect(animations[0]?.keyframes).toEqual([{ height: '160px' }, { height: '200px' }]);
  });

  it('stands still under reduced motion (system or in-app), out of view, for tiny changes and inside a resizing card', async () => {
    stubReducedMotion(true);
    const r = render(<HeightBox>kart</HeightBox>);
    await change(r, 'b', 200);
    expect(animations).toHaveLength(0);
    r.unmount();
    stubReducedMotion(false);
    h = 100;
    const r2 = render(<HeightBox reduce>kart</HeightBox>);
    await change(r2, 'b', 200, true);
    expect(animations).toHaveLength(0);
    r2.unmount();
    h = 100;
    const r3 = render(<HeightBox>kart</HeightBox>);
    await change(r3, 'b', 101);
    expect(animations).toHaveLength(0);
    top = 2_000;
    await change(r3, 'c', 400);
    expect(animations).toHaveLength(0);
    top = 50;
    h = 500;
    r3.rerender(
      <HeightBox>
        <div data-dy-resizing="">iç kart</div>
      </HeightBox>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(animations).toHaveLength(0);
  });

  it('never scrolls the window', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    const r = render(<HeightBox>kart</HeightBox>);
    await change(r, 'uzun kart', 300);
    expect(animations).toHaveLength(1);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ FLIP

function List(props: { readonly ids: readonly string[] }): ReactNode {
  const ref = useRef<HTMLUListElement>(null);
  useFlip(ref);
  return (
    <div data-ui="diyalog">
      <ul ref={ref} data-testid="list">
        {props.ids.map((id) => (
          <li key={id} data-flip-key={id}>
            {id}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe('useFlip', () => {
  let width = 300;
  beforeEach(() => {
    width = 300;
    // Rows stack 40 px apart in DOM order; the list is their offset parent.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.flipKey === undefined) return 0;
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 40;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.flipKey === undefined ? null : this.parentElement;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const y = this instanceof HTMLElement ? this.offsetTop : 0;
      return { top: y, bottom: y + 40, height: 40, left: 0, right: 0, width: 0, x: 0, y } as DOMRect;
    });
  });

  it('does nothing on the first render; a reorder glides the moved rows from their old place', () => {
    const r = render(<List ids={['a', 'b', 'c']} />);
    expect(animations).toHaveLength(0);
    r.rerender(<List ids={['c', 'a', 'b']} />);
    const by = new Map(animations.map((a) => [a.el.dataset.flipKey, a.keyframes[0]?.transform]));
    expect(by.get('c')).toBe('translate(0px,80px)');
    expect(by.get('a')).toBe('translate(0px,-40px)');
    expect(by.get('b')).toBe('translate(0px,-40px)');
    expect(animations[0]?.options.duration).toBe(220);
  });

  it('an insertion above moves the rows below; a new row is left to its own entrance', () => {
    const r = render(<List ids={['a', 'b']} />);
    r.rerender(<List ids={['n', 'a', 'b']} />);
    expect(animations.map((a) => a.el.dataset.flipKey).sort()).toEqual(['a', 'b']);
  });

  it('stands still for a re-render with the same order, a width change, reduced motion and long lists', () => {
    const r = render(<List ids={['a', 'b']} />);
    r.rerender(<List ids={['a', 'b']} />);
    expect(animations).toHaveLength(0);
    width = 500;
    r.rerender(<List ids={['b', 'a']} />);
    expect(animations).toHaveLength(0);
    stubReducedMotion(true);
    r.rerender(<List ids={['a', 'b']} />);
    expect(animations).toHaveLength(0);
    stubReducedMotion(false);
    const long = Array.from({ length: FLIP_MAX + 1 }, (_, i) => `k${String(i)}`);
    r.rerender(<List ids={long} />);
    r.rerender(<List ids={[...long].reverse()} />);
    expect(animations).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ code field

describe('authenticator code feedback', () => {
  it('ticks fill with the digits; a refused code turns them red; an accepted one green', () => {
    const r = render(<CodeTicks n={3} state="idle" />);
    const ticks = (): HTMLElement[] => [
      ...screen.getByTestId('code-ticks').querySelectorAll<HTMLElement>('i'),
    ];
    expect(ticks().filter((i) => i.hasAttribute('data-on'))).toHaveLength(3);
    expect(screen.getByTestId('code-ticks').getAttribute('aria-hidden')).toBe('true');
    r.rerender(<CodeTicks n={0} state="error" />);
    expect(ticks().every((i) => i.className.includes('bg-dy-red'))).toBe(true);
    r.rerender(<CodeTicks n={6} state="ok" />);
    expect(ticks().every((i) => i.className.includes('bg-dy-green'))).toBe(true);
  });

  it('useShake restarts the shake on every wrong code (a / b) and is off until the first one', () => {
    const { result } = renderHook(() => useShake());
    expect(result.current.attr).toBeUndefined();
    act(() => {
      result.current.shake();
    });
    expect(result.current.attr).toBe('a');
    act(() => {
      result.current.shake();
    });
    expect(result.current.attr).toBe('b');
  });
  // The card flow (wrong code → shake + red ticks, typing clears them) is in diyalog-ops.test.tsx.
});
