// p12-diyalog-default (visual tour, docs/design/p12-diyalog-visual-tour.md): layout-stability rules found by measuring
// layout shift in the harness. jsdom has no layout, so these pin the structure that keeps heights stable: placeholders
// that hold a loaded element's place, late or optional panels placed after the content they used to push, and one
// render for reads that land together. The measured numbers are in the tour checklist.
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { JobApprovalCard } from '../src/diyalog/job/cards';
import { ScreenFrame } from '../src/diyalog/screens/ScreenFrame';
import { RailClock } from '../src/diyalog/ShellExtras';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

/** Every read answers an empty page except the paths in `hold`, which wait until released. */
function stubFetch(hold: readonly string[]): {
  waiting: (path: string) => boolean;
  release: (path: string, body: unknown) => void;
} {
  const waiting = new Map<string, (r: Response) => void>();
  const empty = {
    items: [],
    nextCursor: null,
    workers: [],
    entries: [],
    otherLimits: [],
    pools: [],
    total: 0,
    unreadCount: 0,
    pauses: [],
    projects: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api/, '');
      if (hold.some((h) => path.startsWith(h)))
        return new Promise<Response>((resolve) => {
          waiting.set(path, resolve);
        });
      return Promise.resolve(
        new Response(JSON.stringify(empty), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }),
  );
  return {
    waiting: (path) => waiting.has(path),
    release: (path, body) => {
      const r = waiting.get(path);
      if (r === undefined) throw new Error(`nothing waits for ${path}`);
      r(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  };
}

function inApp(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialState={signedIn}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {});

afterEach(() => {
  window.localStorage.clear();
});

describe('Diyalog layout stability (p12-diyalog-default)', () => {
  it('Home (p17-needs-page): the needs summary keeps its height while it loads, and the panels are drawn at once', async () => {
    const api = stubFetch(['/ops-thread']);
    inApp('/');
    const tile = await screen.findByTestId('dy-home-needs');
    expect(tile.dataset.state).toBe('loading');
    // A fixed minimum height and placeholder chips: the quick access and the panels never move when the count lands.
    expect(tile.className).toContain('min-h-[10.5rem]');
    expect(screen.getByTestId('dy-home-needs-pending')).toBeTruthy();
    // The panels no longer wait for the decisions (their height no longer depends on them).
    expect(await screen.findByTestId('dy-home-running')).toBeTruthy();
    expect(screen.getByTestId('dy-home-quick')).toBeTruthy();
    expect(screen.queryByTestId('dy-decisions-skeleton')).toBeNull();
    await act(async () => {
      api.release('/ops-thread', { items: [], nextCursor: null });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('dy-home-needs').dataset.state).toBe('clear');
    });
    expect(screen.getByTestId('dy-home-needs').className).toContain('min-h-[10.5rem]');
  });

  it('Needs page: card-sized decision placeholders until the decisions are drawn', async () => {
    const api = stubFetch(['/ops-thread']);
    inApp('/needs');
    const skeleton = await screen.findByTestId('dy-decisions-skeleton');
    // Live-card sized (19 rem), not two thin rows.
    expect(skeleton.querySelector('span')?.className).toContain('h-[19rem]');
    await act(async () => {
      api.release('/ops-thread', { items: [], nextCursor: null });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-decisions-skeleton')).toBeNull();
    });
  });

  it('Jobs: the optional workflow runs come after the job list (they no longer push it down)', async () => {
    const api = stubFetch(['/workflows']);
    inApp('/jobs');
    const list = await screen.findByTestId('job-list');
    // The runs are asked for only once the list is drawn (before that its placeholder is shorter than the list).
    await waitFor(() => {
      expect(api.waiting('/workflows')).toBe(true);
    });
    await act(async () => {
      api.release('/workflows', {
        runs: [
          {
            id: 'run-1',
            project: 'acme',
            name: 'release-check',
            version: 2,
            state: 'running',
            createdAt: new Date().toISOString(),
            endedAt: null,
          },
        ],
      });
      await Promise.resolve();
    });
    const runs = await screen.findByTestId('workflow-runs');
    expect(list.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Uptime: the status summary is there from the start ("—"), not added when the list arrives', async () => {
    stubFetch(['/uptime/monitors']);
    inApp('/uptime');
    const down = await screen.findByTestId('uptime-count-down');
    expect(down.textContent).toContain('—');
    expect(down.querySelector('button')?.disabled).toBe(true);
  });

  it('the rail clock keeps its slot before the first server sync', async () => {
    let answer: ((r: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ) as unknown as typeof fetch;
    render(<RailClock fetchImpl={fetchImpl} />);
    const pending = screen.getByTestId('server-clock-pending');
    expect(pending.getAttribute('aria-hidden')).toBe('true');
    expect(pending.textContent).toBe('00:00UTC');
    await act(async () => {
      answer?.(new Response(null, { status: 204, headers: { date: new Date().toUTCString() } }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('server-clock-pending')).toBeNull();
    });
    expect(screen.getByTestId('server-clock')).toBeTruthy();
  });

  it('ScreenFrame: facts still loading keep their row', () => {
    stubFetch(['/notifications']);
    const frame = (facts: ReactNode): ReactNode => (
      <MemoryRouter>
        <AuthProvider initialState={signedIn}>
          <ScreenFrame title="Deneme" facts={facts}>
            <p>içerik</p>
          </ScreenFrame>
        </AuthProvider>
      </MemoryRouter>
    );
    const { rerender } = render(frame(null));
    expect(screen.getByTestId('dy-facts-pending').className).toContain('min-h-[1.625rem]');
    rerender(frame(<span>3 açık</span>));
    expect(screen.queryByTestId('dy-facts-pending')).toBeNull();
    expect(screen.getByText('3 açık').parentElement?.className).toContain('min-h-[1.625rem]');
  });

  it('a job approval card holds an approval card’s height while the request is read', () => {
    stubFetch(['/approvals/']);
    render(
      <MemoryRouter>
        <JobApprovalCard
          requestId="ap-1"
          action="bash"
          description="rm -rf node_modules"
          at={new Date().toISOString()}
          state="AWAITING_APPROVAL"
          onDecided={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('dy-approval-pending').className).toContain('h-[41rem]');
  });
});
