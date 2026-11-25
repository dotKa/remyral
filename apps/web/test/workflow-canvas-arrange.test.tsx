// p17-workflow-canvas (docs/design/p17-workflow-canvas.md §4): the arrange split button in the editor — the main
// part runs the remembered mode and shows its icon, the chevron opens the modes (menu button pattern), align needs a
// selection, the choice is remembered per browser, an arrangement is one undo step; the cards carry their family.
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { ARRANGE_KEY } from '../src/diyalog/screens/workflows/ArrangeMenu';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const WF = 'aaaaaaaa-1111-4111-8111-111111111111';
const empty = { status: 200, body: { items: [], nextCursor: null } };
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const state: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'operator' },
  session: null,
  remainingRecoveryCodes: null,
};

const START = { plan: { x: 0, y: 0 }, build: { x: 300, y: 0 }, verify: { x: 600, y: 0 } };
const DEFINITION = {
  name: 'release-check',
  inputs: { task: { required: true } },
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 1800 } },
  nodes: [
    { id: 'plan', role: 'planner', prompt: 'Plan {{inputs.task}}' },
    { id: 'build', role: 'executor', prompt: 'Build it' },
    { id: 'verify', role: 'verifier', prompt: 'Verify' },
  ],
  edges: [
    { from: 'plan', to: 'build' },
    { from: 'build', to: 'verify' },
  ],
  layout: { positions: START },
};

function routes(): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'acme',
            kind: 'repository',
            createdAt: iso(1e9),
            createdBy: null,
            members: 2,
            myRole: 'operator',
          },
        ],
      },
    }),
    [`GET /api/workflows/${WF}/definition`]: () => ({
      status: 200,
      body: {
        id: WF,
        project: 'acme',
        name: 'release-check',
        version: 3,
        latestVersion: 3,
        latestId: WF,
        archived: false,
        createdBy: 'ayse',
        createdAt: iso(3_600_000),
        hash: 'h3',
        promptsHidden: false,
        definition: DEFINITION,
      },
    }),
  };
}

/** A card's drawn position (React Flow's transform). */
function pos(id: string): { x: number; y: number } {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el?.style.transform ?? '');
  if (m === null) throw new Error(`no position for ${id}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function open(): Promise<void> {
  renderApp({ path: `/workflows/${WF}`, initialState: state, routes: routes() });
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid=workflow-node]')).toHaveLength(3);
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('arrange split button (p17-workflow-canvas)', { timeout: 30_000 }, () => {
  it('runs the chosen mode, remembers it, shows it on the main part; undo restores the positions', async () => {
    const user = userEvent.setup();
    await open();
    const main = screen.getByTestId('toolbar-tidy');
    expect(main.getAttribute('data-mode')).toBe('lr');
    expect(main.getAttribute('aria-label')).toBe('Düzenle: Soldan sağa');
    expect(pos('build')).toEqual(START.build);

    await user.click(screen.getByTestId('toolbar-arrange-menu'));
    const menu = await screen.findByTestId('arrange-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getAllByRole('menuitemradio').map((b) => b.getAttribute('data-testid'))).toEqual([
      'arrange-lr',
      'arrange-tb',
      'arrange-grid',
      'arrange-tree',
      'arrange-align',
    ]);
    // Nothing selected: align is shown but unavailable.
    expect(screen.getByTestId('arrange-align').getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByTestId('arrange-tb'));
    expect(screen.queryByTestId('arrange-menu')).toBeNull();
    expect(window.localStorage.getItem(ARRANGE_KEY)).toBe('tb');
    expect(screen.getByTestId('toolbar-tidy').getAttribute('data-mode')).toBe('tb');
    expect(screen.getByTestId('workflow-status').textContent).toBe('Grafik düzenlendi: Yukarıdan aşağıya.');
    await waitFor(() => {
      expect(pos('plan').y < pos('build').y && pos('build').y < pos('verify').y).toBe(true);
    });
    await waitFor(() => {
      expect(Math.abs(pos('plan').x - pos('build').x)).toBeLessThan(40);
    });

    // One undo step back to the saved places.
    await user.click(screen.getByTestId('toolbar-undo'));
    await waitFor(() => {
      expect(pos('build')).toEqual(START.build);
    });
    expect(pos('verify')).toEqual(START.verify);

    // The main part runs the remembered mode again.
    await user.click(screen.getByTestId('toolbar-tidy'));
    await waitFor(() => {
      expect(pos('plan').y < pos('verify').y).toBe(true);
    });
  });

  it('starts with the mode remembered by this browser', async () => {
    window.localStorage.setItem(ARRANGE_KEY, 'grid');
    await open();
    expect(screen.getByTestId('toolbar-tidy').getAttribute('data-mode')).toBe('grid');
  });

  it('align needs a selection: with a card selected it aligns it with its neighbours', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(ARRANGE_KEY, 'align');
    await open();
    // Remembered align without a selection: the main part waits.
    expect(screen.getByTestId<HTMLButtonElement>('toolbar-tidy').disabled).toBe(true);
    const el = document.querySelector('.react-flow__node[data-id="build"]');
    if (!(el instanceof HTMLElement)) throw new Error('no build');
    fireEvent.click(el);
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('toolbar-tidy').disabled).toBe(false);
    });
    await user.click(screen.getByTestId('toolbar-arrange-menu'));
    expect(screen.getByTestId('arrange-align').getAttribute('aria-disabled')).toBeNull();
    await user.click(screen.getByTestId('arrange-align'));
    expect(screen.getByTestId('workflow-status').textContent).toBe('3 kart hizalandı.');
  });

  it('keyboard: ↓ on the chevron opens on the first mode, Escape closes back to the chevron', async () => {
    const user = userEvent.setup();
    await open();
    const chevron = screen.getByTestId('toolbar-arrange-menu');
    expect(chevron.getAttribute('aria-haspopup')).toBe('menu');
    chevron.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-testid')).toBe('arrange-lr');
    });
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('arrange-tb');
    await user.keyboard('{End}');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('arrange-align');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('arrange-menu')).toBeNull();
    });
    expect(document.activeElement).toBe(chevron);
    await user.keyboard('{ArrowUp}');
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-testid')).toBe('arrange-align');
    });
  });

  it('cards carry their family (AI steps: ai) with the icon chip', async () => {
    await open();
    for (const card of document.querySelectorAll('[data-testid=workflow-node]')) {
      expect(card.getAttribute('data-family')).toBe('ai');
      expect(card.className).toContain('dy-wf-fam-ai');
      expect(card.querySelector('[data-testid=workflow-node-chip]')).not.toBeNull();
    }
  });
});
