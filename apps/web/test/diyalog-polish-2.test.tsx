// p14-diyalog-polish-2 (docs/design/p14-diyalog-polish-2.md): the named tokens (segment lift, scrim, elevation edge,
// dark primary) in every theme block, the motion budget (≤ 200 ms, exits faster than entries, reduced motion), the
// page frame (the top-bar title appears once the h1 has scrolled away; phone action rows stay on one line), flat
// sections and bare panels, row-shaped skeletons and grouped row actions.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { Panel, Row, Rows, SkeletonRows } from '../src/diyalog/screens/parts';
import { ScreenFrame } from '../src/diyalog/screens/ScreenFrame';

const css = readFileSync(join(__dirname, '../src/diyalog/diyalog.css'), 'utf8');
const motion = readFileSync(join(__dirname, '../src/diyalog/motion.css'), 'utf8');

const block = (re: RegExp): string => re.exec(css)?.[1] ?? '';
const light = block(/\[data-ui='diyalog'\] \{([^}]*)\}/);
const darkMedia = block(/\[data-ui='diyalog'\]:not\(\[data-theme='light'\]\) \{([^}]*)\}/);
const darkAttr = block(/\[data-ui='diyalog'\]\[data-theme='dark'\] \{([^}]*)\}/);

function hex(blockText: string, name: string): string | undefined {
  return new RegExp(`--dy-${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i').exec(blockText)?.[1];
}
function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('tokens', () => {
  it('the named values exist in the light block and in both dark blocks', () => {
    for (const name of ['shadow-seg', 'scrim', 'edge', 'primary', 'r-card', 'r-band', 'r-ctl'])
      expect(light, name).toMatch(new RegExp(`--dy-${name}:`));
    for (const name of ['shadow-seg', 'scrim', 'edge', 'primary']) {
      expect(darkMedia, name).toMatch(new RegExp(`--dy-${name}:`));
      expect(darkAttr, name).toMatch(new RegExp(`--dy-${name}:`));
    }
  });

  it('dark primary is quieter than the text ink and still reads 4.5:1 with its label (card ink)', () => {
    const primary = hex(darkMedia, 'primary');
    const ink = hex(darkMedia, 'ink');
    const card = hex(darkMedia, 'card');
    expect(primary).toBeDefined();
    expect(contrast(primary ?? '', card ?? '')).toBeGreaterThanOrEqual(4.5);
    expect(luminance(primary ?? '')).toBeLessThan(luminance(ink ?? ''));
    expect(hex(darkAttr, 'primary')).toBe(primary);
  });

  it('no copied segment shadow or scrim literal is left (outside the workflow editor, owned elsewhere)', () => {
    const dir = join(__dirname, '../src/diyalog');
    for (const f of files(dir)) {
      if (f.includes(join('screens', 'workflows'))) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/shadow-\[0_1px_2px_rgba?\(24[_,]32[_,]49(\/0\.1\)|,\.12\))/);
      expect(src, f).not.toMatch(/backdrop:bg-\[rgb\(12_17_28/);
      expect(src, f).not.toMatch(/\bbg-black\/\d+/);
    }
  });
});

describe('motion budget', () => {
  const durations = (text: string): number[] =>
    [...text.matchAll(/(?:transition|animation)[^;{}]*?(\d+)ms/g)].map((m) => Number(m[1]));

  it('every transition / animation in motion.css is ≤ 200 ms', () => {
    const all = durations(motion);
    expect(all.length).toBeGreaterThan(10);
    for (const d of all) expect(d).toBeLessThanOrEqual(200);
  });

  it('diyalog.css: one-shot moments ≤ 200 ms (the breath and the countdown track are ambient, not transitions)', () => {
    const shots = [...css.matchAll(/animation: (dy-[a-z]+) (\d+)ms/g)];
    expect(shots.length).toBeGreaterThan(2);
    for (const [, name, ms] of shots) expect(Number(ms), name).toBeLessThanOrEqual(200);
    for (const d of durations(css.replace(/transition: transform 1s linear;/, '')))
      expect(d).toBeLessThanOrEqual(200);
  });

  it('exits are faster than entries for sheets and drawers', () => {
    expect(motion).toMatch(/\.dy-m-sheet \{\s*transition: transform 160ms/);
    expect(motion).toMatch(/\.dy-m-sheet\[data-state='open'\] \{\s*transition: transform 200ms/);
    expect(motion).toMatch(/dialog\.dy-dialog\[data-size='sheet'\] \{\s*transition: transform 160ms/);
  });

  it('the new moments are scoped and stop under reduced motion', () => {
    for (const sel of ['.dy-notice', '.dy-rows > li', '.dy-bar-title'])
      expect(css).toContain(`[data-ui='diyalog'] ${sel}`);
    const reduce =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-ui='diyalog'\] \.dy-notice([\s\S]*?)\n\}\n/.exec(
        css,
      );
    expect(reduce?.[0]).toContain('details::details-content');
    expect(css).toMatch(/\[data-motion='reduce'\] :is\(\.dy-notice, \.dy-rows > li/);
  });
});

function frame(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{"error":"not_found","message":"x"}', { status: 404 }))),
  );
  render(
    <MemoryRouter>
      <AuthProvider
        initialState={{
          kind: 'signedIn',
          user: { id: 'u1', username: 'alex', role: 'owner' },
          session: null,
          remainingRecoveryCodes: null,
        }}
      >
        <div data-ui="diyalog">
          <ScreenFrame
            title="İşler"
            purpose="Her iş."
            actions={
              <>
                <button type="button">Yeni iş</button>
                <button type="button">Otomasyonlar</button>
              </>
            }
          >
            <p>içerik</p>
          </ScreenFrame>
        </div>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('page frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('without IntersectionObserver the top bar keeps the title', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    frame();
    const bar = document.querySelector('.dy-bar-title');
    expect(bar?.textContent).toBe('İşler');
    expect(bar?.getAttribute('data-shown')).toBe('true');
  });

  it('the top-bar title shows only once the h1 has scrolled under the bar', () => {
    let fire: ((e: { isIntersecting: boolean }[]) => void) | null = null;
    class IO {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        fire = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', IO);
    frame();
    const bar = document.querySelector('.dy-bar-title');
    expect(bar?.getAttribute('data-shown')).toBe('false');
    act(() => {
      fire?.([{ isIntersecting: false }]);
    });
    expect(bar?.getAttribute('data-shown')).toBe('true');
    act(() => {
      fire?.([{ isIntersecting: true }]);
    });
    expect(bar?.getAttribute('data-shown')).toBe('false');
  });

  it('the header actions are one row that never wraps on phones', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    frame();
    const row = screen.getByRole('button', { name: 'Otomasyonlar' }).parentElement;
    expect(row?.className).toContain('dy-action-row');
    expect(row?.className).toContain('max-sm:flex-nowrap');
    expect(row?.className).toContain('max-sm:overflow-x-auto');
  });
});

describe('sections, skeletons and rows', () => {
  it('a panel is a flat card (border, elevation edge, no drop shadow); a bare panel has no card', () => {
    render(
      <>
        <Panel title="Kart" testId="card">
          <p>a</p>
        </Panel>
        <Panel title="Çıplak" bare testId="bare">
          <p>b</p>
        </Panel>
      </>,
    );
    const card = screen.getByTestId('card').className;
    expect(card).toContain('border');
    expect(card).toContain('shadow-dy-edge');
    expect(card).not.toMatch(/\bshadow-dy\b(?!-)/);
    const bare = screen.getByTestId('bare').className;
    expect(bare).not.toContain('border');
    expect(bare).not.toContain('bg-dy-card');
    expect(screen.getByRole('heading', { name: 'Çıplak' })).toBeTruthy();
  });

  it('skeleton rows take the shape of a row list', () => {
    render(<SkeletonRows label="İşler yükleniyor" rows={4} />);
    const s = screen.getByRole('status', { name: 'İşler yükleniyor' });
    expect(s.getAttribute('aria-busy')).toBe('true');
    expect(s.children).toHaveLength(4);
    for (const row of s.children) {
      expect(row.className).toContain('border-t');
      expect(row.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('row actions are one group (they scroll, not wrap, on phones); rows lists carry the entry hook', () => {
    render(
      <Rows label="Liste">
        <Row
          testId="r"
          title="hotfix-flow"
          trail={<span>3 adım</span>}
          actions={
            <>
              <button type="button">Aç</button>
              <button type="button">Arşivle</button>
            </>
          }
        />
      </Rows>,
    );
    const group = screen.getByRole('button', { name: 'Arşivle' }).parentElement;
    expect(group?.className).toContain('dy-action-row');
    expect(group?.contains(screen.getByRole('button', { name: 'Aç' }))).toBe(true);
    expect(screen.getByRole('list', { name: 'Liste' }).className).toContain('dy-rows');
  });
});
