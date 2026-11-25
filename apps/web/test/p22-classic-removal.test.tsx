// p22-classic-removal (docs/design/p22-classic-removal.md): the Faz 6 quality items that can be checked in code —
// keyboard moves in the conversation list, accessible names on icon-only controls (a static guard over the source),
// reduced motion for scripted scrolling, the long-thread render cost (memoized Markdown), the composer's quick-chip
// row (its own opaque row, a fade where it scrolls) and the old stored "classic" choice.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { configure, fireEvent, render, screen, within } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { rowTarget } from '../src/diyalog/chat/rowKeys';
import { scrollEdges } from '../src/diyalog/scrollEdges';
import { lockPageScroll, SCROLL_LOCK_ATTR, useScrollLock } from '../src/diyalog/scrollLock';
import { forgetLegacyUiChoice, LEGACY_UI_STORAGE_KEY } from '../src/lib/legacyUrl';
import { Markdown } from '../src/screens/chat/markdown';
import { type Handler, renderApp, sessionBody } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const SRC = join(__dirname, '../src');

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000e1';
const T2 = '00000000-0000-4000-8000-0000000000e2';
const T3 = '00000000-0000-4000-8000-0000000000e3';
const M1 = '00000000-0000-4000-8000-0000000000f1';
const NOW = new Date().toISOString();

function thread(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: 0,
    pinnedAt: null,
    groupId: null,
    tagIds: [],
  };
}

const ALL = [thread(T1, 'Birinci sohbet'), thread(T2, 'İkinci sohbet'), thread(T3, 'Üçüncü sohbet')];
const ok =
  (body: unknown = {}): Handler =>
  () => ({ status: 200, body });
const empty = { status: 200, body: { items: [], nextCursor: null } };

function routes(): Record<string, Handler> {
  const exact: Record<string, Handler> = {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok({
      enabled: true,
      available: true,
      code: null,
      message: null,
      worker: { id: 'w1', name: 'mac-1', online: true },
      runtime: 'claude-code',
      model: 'claude-sonnet-4-5',
      limits: { turnsPerUserPer10Min: 30, userDailyTokens: 2000000 },
    }),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/chat/threads': ok({
      items: ALL,
      organize: { groups: [], tags: [], pinned: 0 },
      nextCursor: null,
    }),
    [`GET /api/chat/threads/${T1}`]: ok({
      thread: thread(T1, 'Birinci sohbet'),
      messages: [
        { id: M1, seq: 1, role: 'assistant', content: 'Merhaba', meta: null, turnId: null, createdAt: NOW },
      ],
      drafts: [],
      turn: null,
      watches: [],
      starred: [],
    }),
    [`POST /api/chat/threads/${T1}/read`]: ok({
      threadId: T1,
      lastReadSeq: 1,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`GET /api/chat/threads/${T1}/assets?kind=starred&limit=30`]: () => empty,
    [`GET /api/chat/assets?kind=starred&limit=30&thread=${T1}`]: () => empty,
    'GET /api/templates?state=active': ok({ items: [] }),
    'GET /api/projects': ok({ items: [] }),
    'GET /api/workers': ok({ workers: [] }),
  };
  return new Proxy(exact, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      if (key.startsWith('GET /api/chat/mentions?q=')) return ok({ items: [] });
      return undefined;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('conversation list keyboard (§3)', () => {
  it('↓ from search enters the list; ↑ / ↓ / Home / End move between conversations; edges stay put', async () => {
    renderApp({ path: `/chat/${T1}`, initialState: owner, routes: routes() });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await within(nav).findByText('Üçüncü sohbet');
    const link = (title: string): HTMLElement => {
      const a = within(nav).getByText(title).closest('a');
      if (a === null) throw new Error(`no row link: ${title}`);
      return a;
    };
    const search = within(nav).getByRole('searchbox');
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(link('Birinci sohbet'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(link('İkinci sohbet'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(link('Üçüncü sohbet'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(link('Üçüncü sohbet'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(link('Birinci sohbet'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(link('Birinci sohbet'));
    // Modified keys and other targets are left alone (row menus keep their own keys).
    const menu = within(link('İkinci sohbet').closest('li') as HTMLElement).getByRole('button');
    menu.focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menu);
  });

  it('rowTarget ignores keys that are not list moves', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a data-row-link href="#a">a</a><a href="#x">x</a><a data-row-link href="#b">b</a>';
    const [a, , b] = [...root.querySelectorAll('a')];
    expect(rowTarget(root, a ?? null, 'ArrowDown')).toBe(b);
    expect(rowTarget(root, b ?? null, 'ArrowUp')).toBe(a);
    expect(rowTarget(root, a ?? null, 'Enter')).toBeNull();
    expect(rowTarget(root, null, 'Home')).toBeNull();
  });
});

describe('composer quick chips (§4)', () => {
  it('scrollEdges names the sides with hidden content', () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toBeNull();
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 })).toBe('end');
    expect(scrollEdges({ scrollLeft: 120, scrollWidth: 600, clientWidth: 300 })).toBe('start end');
    expect(scrollEdges({ scrollLeft: 300, scrollWidth: 600, clientWidth: 300 })).toBe('start');
  });

  it('the chip row is its own row with an edge fade while it scrolls; it wraps from 768 px', async () => {
    renderApp({ path: `/chat/${T1}`, initialState: owner, routes: routes() });
    const row = await screen.findByTestId('dy-quick');
    expect(row.className).toContain('dy-edge-fade');
    expect(row.className).toContain('md:flex-wrap');
    // Not an overlay: the chips and the field are separate rows of the composer form, the chips first.
    const field = screen.getByTestId('dy-composer-field');
    expect(row.contains(field)).toBe(false);
    expect(row.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getComputedStyle(row).position).not.toBe('absolute');
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 640 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 360 });
    fireEvent.scroll(row);
    expect(row.dataset.more).toBe('end');
    row.scrollLeft = 100;
    fireEvent.scroll(row);
    expect(row.dataset.more).toBe('start end');
  });

  it('the dock is opaque below its top padding (no thread text behind the chips)', () => {
    const css = readFileSync(join(SRC, 'diyalog/chat/chat.css'), 'utf8');
    expect(css).toMatch(
      /\.dy-composer-dock \{\s*background: linear-gradient\(to top, var\(--dy-thread\) calc\(100% - 1\.5rem\), transparent\);/,
    );
    const composer = readFileSync(join(SRC, 'diyalog/ops/Composer.tsx'), 'utf8');
    expect(composer).not.toContain('from-70%');
  });
});

describe('long threads (§5)', () => {
  it('Markdown is memoized on its text', () => {
    expect((Markdown as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

describe('old stored choice (§2)', () => {
  it('a stored "classic" choice is dropped; the one UI opens', () => {
    window.localStorage.setItem(LEGACY_UI_STORAGE_KEY, 'classic');
    forgetLegacyUiChoice();
    expect(window.localStorage.getItem(LEGACY_UI_STORAGE_KEY)).toBeNull();
  });
});

describe('plan open on a phone (§7)', () => {
  function Lock(props: { readonly on: boolean }): null {
    useScrollLock(props.on);
    return null;
  }
  const locked = (): boolean => document.documentElement.hasAttribute(SCROLL_LOCK_ATTR);

  it('useScrollLock holds the page while active and releases on close and unmount', () => {
    const view = render(<Lock on={false} />);
    expect(locked()).toBe(false);
    view.rerender(<Lock on />);
    expect(locked()).toBe(true);
    view.rerender(<Lock on={false} />);
    expect(locked()).toBe(false);
    view.rerender(<Lock on />);
    view.unmount();
    expect(locked()).toBe(false);
  });

  it('holds are counted: the page is released only when the last overlay goes; a release is idempotent', () => {
    const a = lockPageScroll();
    const b = lockPageScroll();
    a();
    a();
    expect(locked()).toBe(true);
    b();
    expect(locked()).toBe(false);
  });

  it('the lock stops page scroll and chaining; the half-snap list ends at the screen edge; the keyboard lifts the sheet', () => {
    const chat = readFileSync(join(SRC, 'diyalog/chat/chat.css'), 'utf8');
    expect(chat).toMatch(/html\[data-scroll-lock\] \{\s*overflow: hidden;\s*overscroll-behavior: none;/);
    const motion = readFileSync(join(SRC, 'diyalog/motion.css'), 'utf8');
    expect(motion).toMatch(/\.dy-plan-sheet-scroll \{\s*margin-bottom: var\(--dy-sheet-snap\);/);
    expect(motion).toContain('--dy-sheet-snap: max(0px, calc(40dvh - var(--dy-kb, 0px)));');
    expect(motion).toContain('bottom: var(--dy-kb, 0px);');
    const panel = readFileSync(join(SRC, 'diyalog/plan/PlanPanel.tsx'), 'utf8');
    expect(panel).toContain('useScrollLock(presence.mounted);');
    expect(panel).toContain("useScrollLock(props.state === 'open');");
    expect(panel).toContain('dy-plan-sheet-scroll');
  });
});

// ------------------------------------------------------------------------------------------- static guards (§3, §6)

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const NAME_ATTRS = new Set(['aria-label', 'aria-labelledby', 'title', 'label', 'name']);
const ICON_TAG = /Icon$|^svg$|^DyIcon$|^ChatIcon$|Glyph|Spinner|Chevron|Caret|^path$/;
const TEXT_TAG = /^(span|strong|em|b|small|kbd|code|i)$/;

/** Whether a JSX subtree can show text (conservative: any expression other than an icon element counts as text). */
function showsText(node: ts.Node, sf: ts.SourceFile): boolean {
  if (ts.isJsxText(node)) return node.text.trim() !== '';
  if (ts.isJsxExpression(node)) return node.expression === undefined ? false : showsText(node.expression, sf);
  if (ts.isConditionalExpression(node)) return showsText(node.whenTrue, sf) || showsText(node.whenFalse, sf);
  if (ts.isBinaryExpression(node)) return showsText(node.right, sf);
  if (ts.isParenthesizedExpression(node)) return showsText(node.expression, sf);
  if (node.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(node) && node.text === 'undefined') return false;
  if (ts.isJsxFragment(node)) return node.children.some((c) => showsText(c, sf));
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const open = ts.isJsxElement(node) ? node.openingElement : node;
    const tag = open.tagName.getText(sf);
    const srOnly = open.attributes.properties.some(
      (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'className' && a.getText(sf).includes('sr-only'),
    );
    if (srOnly) return true;
    if (ICON_TAG.test(tag)) return false;
    if (TEXT_TAG.test(tag)) return ts.isJsxElement(node) && node.children.some((c) => showsText(c, sf));
    return true;
  }
  return true;
}

describe('static guards', () => {
  const files = sourceFiles(SRC);

  it('every icon-only button and link has an accessible name (aria-label / title / label)', () => {
    const missing: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.tsx'))) {
      const sf = ts.createSourceFile(
        f,
        readFileSync(f, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (n: ts.Node): void => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
          const open = ts.isJsxElement(n) ? n.openingElement : n;
          const tag = open.tagName.getText(sf);
          // Native controls and links always; a `…Button` component when it is given children (a self-closing one
          // names itself: DyCopyButton, StarButton, … — checked as the native button inside it).
          const native = /^(button|a|Link|NavLink|summary)$/.test(tag);
          if (native || (/Button$/.test(tag) && ts.isJsxElement(n))) {
            const named = open.attributes.properties.some(
              (a) => ts.isJsxSpreadAttribute(a) || NAME_ATTRS.has(a.name.getText(sf)),
            );
            const text = ts.isJsxElement(n) && n.children.some((c) => showsText(c, sf));
            if (!named && !text) {
              const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
              missing.push(`${relative(SRC, f)}:${String(line + 1)} <${tag}>`);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(missing).toEqual([]);
  });

  it('scripted smooth scrolling always has a reduced-motion branch', () => {
    const bare: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/behavior:\s*'smooth'/.test(line)) bare.push(`${relative(SRC, f)}:${String(i + 1)}`);
        });
    }
    expect(bare).toEqual([]);
  });
});
