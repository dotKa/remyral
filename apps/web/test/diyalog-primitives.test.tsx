// p12-diyalog Faz 0: the Diyalog primitives — rendering, roles, reduced motion, theme scope.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { toastByTestId } from './toasts';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chip } from '../src/diyalog/Chip';
import { CodeBlock } from '../src/diyalog/CodeBlock';
import { Countdown, remainingSpoken, remainingText } from '../src/diyalog/Countdown';
import { KeyValue } from '../src/diyalog/KeyValue';
import { CardButton, LiveCard } from '../src/diyalog/LiveCard';
import { Message } from '../src/diyalog/Message';
import { ChipStrip, Rail, RailSection } from '../src/diyalog/Rail';
import { cardFor, registerCard } from '../src/diyalog/registry';
import { runtimeCode, RuntimeMark } from '../src/diyalog/RuntimeMark';
import { StateBadge } from '../src/diyalog/StateBadge';
import { Thread } from '../src/diyalog/Thread';

function scoped(ui: ReactNode, theme?: 'light' | 'dark'): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <div data-ui="diyalog" data-testid="scope" {...(theme === undefined ? {} : { 'data-theme': theme })}>
        {ui}
      </div>
    </MemoryRouter>,
  );
}

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

afterEach(() => {
  vi.useRealTimers();
});

describe('Diyalog primitives (p12-diyalog Faz 0)', () => {
  it('Thread is a polite log; items present at first stand still, later ones rise in once', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const r = scoped(
      <Thread
        label="Operasyon sohbeti"
        items={items}
        itemKey={(i) => i.id}
        renderItem={(i) => <p>{i.id}</p>}
      />,
    );
    const log = screen.getByRole('log', { name: 'Operasyon sohbeti' });
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    expect(within(log).getAllByRole('listitem')).toHaveLength(2);
    expect(log.querySelector('[data-fresh]')).toBeNull();
    r.rerender(
      <MemoryRouter>
        <div data-ui="diyalog">
          <Thread
            label="Operasyon sohbeti"
            items={[...items, { id: 'c' }]}
            itemKey={(i) => i.id}
            renderItem={(i) => <p>{i.id}</p>}
          />
        </div>
      </MemoryRouter>,
    );
    const fresh = screen.getByRole('log').querySelectorAll('[data-fresh]');
    expect([...fresh].map((e) => e.getAttribute('data-key'))).toEqual(['c']);
    expect(fresh[0]?.className).toContain('dy-enter');
  });

  it('Thread renders the newest window and shows earlier items on request; busy hides the empty state', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `m${String(i)}` }));
    scoped(
      <Thread
        label="T"
        items={items}
        windowSize={2}
        itemKey={(i) => i.id}
        renderItem={(i) => <p>{i.id}</p>}
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['m3', 'm4']);
    await user.click(screen.getByRole('button', { name: 'Daha eski 2 öğeyi göster' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('Thread: busy marks the log and suppresses the empty state', () => {
    scoped(
      <Thread label="T" items={[]} busy itemKey={() => ''} renderItem={() => null} empty={<p>boş</p>} />,
    );
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('boş')).toBeNull();
  });

  it('Message: me, assistant, agent (runtime colour), system (warn)', () => {
    scoped(
      <>
        <Message role="me" at="2026-10-19T10:00:00Z" atText="13:00" author="Alex">
          Günaydın
        </Message>
        <Message role="assistant" meta="operasyon asistanı">
          Merhaba
        </Message>
        <Message role="agent" runtime="codex" author="Codex">
          Buldum
        </Message>
        <Message role="system" tone="warn" icon="xc">
          ridge-lnx-03 koptu
        </Message>
      </>,
    );
    expect(screen.getByText('Günaydın').closest('[data-role]')?.getAttribute('data-role')).toBe('me');
    expect(screen.getByText('Remyral')).toBeTruthy();
    expect(screen.getByText('operasyon asistanı')).toBeTruthy();
    const agent = screen.getByText('Buldum').closest('[data-role="agent"]');
    expect(agent?.querySelector('.bg-dy-cx')).not.toBeNull();
    const sys = screen.getByText('ridge-lnx-03 koptu').closest('[data-role="system"]');
    expect(sys?.className).toContain('text-dy-red-ink');
    expect(screen.getByText('13:00').getAttribute('dateTime')).toBe('2026-10-19T10:00:00Z');
  });

  it('LiveCard: an article named by its title; resolved collapses to the outcome and reopens', async () => {
    const user = userEvent.setup();
    scoped(
      <>
        <LiveCard
          kind={{ label: 'Onay', icon: 'shield', tone: 'amber' }}
          state={<StateBadge state="needs" />}
          title="Vitest 5’e geç"
          actions={<CardButton variant="warn">Onayla</CardButton>}
          hint="Onay kod ister"
        >
          <p>Ajan diyor ki</p>
        </LiveCard>
        <LiveCard
          kind={{ label: 'Deploy', icon: 'rocket', tone: 'teal' }}
          title="vitrin-web production"
          resolved="Onaylandı, 12:40"
        >
          <p>deploy ayrıntısı</p>
        </LiveCard>
      </>,
    );
    const open = screen.getByRole('article', { name: 'Vitest 5’e geç' });
    expect(within(open).getByRole('button', { name: 'Onayla' })).toBeTruthy();
    expect(within(open).getByText('Onay kod ister')).toBeTruthy();
    const done = screen.getByRole('article', { name: 'vitrin-web production' });
    expect(done.hasAttribute('data-resolved')).toBe(true);
    expect(within(done).getByText('deploy ayrıntısı').closest('[hidden]')).not.toBeNull();
    const toggle = within(done).getByRole('button', { name: 'Ayrıntılar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(within(done).getByText('deploy ayrıntısı').closest('[hidden]')).toBeNull();
    expect(within(done).getByRole('button', { name: 'Gizle' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('StateBadge: word + icon per state; only running breathes', () => {
    scoped(
      <>
        <StateBadge state="running" />
        <StateBadge state="failed" />
        <StateBadge state="stale" label="Bayat, 18 dk" />
      </>,
    );
    const running = screen.getByText('Çalışıyor');
    expect(running.querySelector('svg')?.getAttribute('class')).toContain('dy-breathe');
    expect(screen.getByText('Başarısız').querySelector('.dy-breathe')).toBeNull();
    expect(screen.getByText('Bayat, 18 dk').getAttribute('data-state')).toBe('stale');
  });

  it('Countdown: ticks, names the time in minutes, fires onExpire once', () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-19T12:00:00Z');
    vi.setSystemTime(start);
    stubReducedMotion(false);
    const onExpire = vi.fn();
    scoped(
      <Countdown
        label="Bayatlamaya"
        until={new Date(start + 62_000).toISOString()}
        from={new Date(start - 58_000).toISOString()}
        onExpire={onExpire}
      />,
    );
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('1:02');
    expect(timer.getAttribute('aria-label')).toBe('Bayatlamaya: 2 dakika kaldı');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('timer').textContent).toBe('1:00');
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole('timer').textContent).toBe('süre doldu');
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('timer').closest('[data-motion]')?.getAttribute('data-motion')).toBe('full');
  });

  it('Countdown: reduced motion is detected (the track stops gliding; numbers still update)', () => {
    stubReducedMotion(true);
    scoped(<Countdown label="Duraklamaya" until={new Date(Date.now() + 600_000).toISOString()} />);
    expect(screen.getByRole('timer').closest('[data-motion]')?.getAttribute('data-motion')).toBe('reduce');
  });

  it('remaining time formats', () => {
    expect(remainingText(41 * 60_000 + 35_000)).toBe('41:35');
    expect(remainingText(2 * 3600_000 + 5 * 60_000 + 9_000)).toBe('2:05:09');
    expect(remainingText(-5)).toBe('0:00');
    expect(remainingSpoken(125 * 60_000)).toBe('2 saat 5 dakika');
    expect(remainingSpoken(60 * 60_000)).toBe('1 saat');
  });

  it('Chip: link, button and static forms; hot is amber', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    scoped(
      <>
        <Chip to="/jobs" value="3" label="3 iş çalışıyor">
          çalışıyor
        </Chip>
        <Chip onClick={onClick}>Filtre</Chip>
        <Chip hot value="5">
          karar
        </Chip>
      </>,
    );
    expect(screen.getByRole('link', { name: '3 iş çalışıyor' }).getAttribute('href')).toBe('/jobs');
    await user.click(screen.getByRole('button', { name: 'Filtre' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByText('karar').className).toContain('bg-dy-amber-soft');
  });

  it('RuntimeMark: cc/cx/pi/oc colours with the name written out; compact keeps an accessible name', () => {
    expect(['claude-code', 'codex', 'pi', 'opencode', 'openhands'].map(runtimeCode)).toEqual([
      'cc',
      'cx',
      'pi',
      'oc',
      null,
    ]);
    scoped(
      <>
        <RuntimeMark runtime="claude-code" />
        <RuntimeMark runtime="opencode" compact />
      </>,
    );
    expect(screen.getByText('Claude Code').getAttribute('data-runtime')).toBe('cc');
    expect(screen.getByRole('img', { name: 'OpenCode' }).getAttribute('data-runtime')).toBe('oc');
  });

  it('CodeBlock: copies the exact command and announces it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    scoped(<CodeBlock code="pnpm install --no-frozen-lockfile" />);
    await user.click(screen.getByRole('button', { name: 'Kopyala' }));
    expect(writeText).toHaveBeenCalledWith('pnpm install --no-frozen-lockfile');
    // p17-toasts-shortcuts: the result is a toast (none in this bare render: the queue); the label still changes.
    await waitFor(() => {
      expect(toastByTestId('dy-copied')?.title).toBe('Komut kopyalandı');
    });
    expect(screen.getByRole('button', { name: 'Kopyalandı' })).toBeTruthy();
  });

  it('KeyValue: a description list', () => {
    scoped(
      <KeyValue
        rows={[
          { k: 'Dal', v: 'int/7c1e09ab', mono: true },
          { k: 'Makine', v: 'kestrel-mac' },
        ]}
      />,
    );
    const terms = screen.getAllByRole('term').map((e) => e.textContent);
    const defs = screen.getAllByRole('definition').map((e) => e.textContent);
    expect(terms).toEqual(['Dal', 'Makine']);
    expect(defs).toEqual(['int/7c1e09ab', 'kestrel-mac']);
  });

  it('Rail, RailSection and ChipStrip: labelled landmarks', () => {
    scoped(
      <>
        <Rail label="Bağlam">
          <RailSection title="Makineler" count="4/12" countLabel="4 / 12 slot dolu">
            <p>satırlar</p>
          </RailSection>
        </Rail>
        <ChipStrip
          label="Bağlam özeti"
          chips={[{ key: 'n', text: 'karar', value: '2', hot: true, to: '/' }]}
        />
      </>,
    );
    const rail = screen.getByRole('complementary', { name: 'Bağlam' });
    expect(within(rail).getByRole('region', { name: /Makineler/ })).toBeTruthy();
    expect(within(rail).getByLabelText('4 / 12 slot dolu')).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Bağlam özeti' })).getByRole('link')).toBeTruthy();
  });

  it('theme: tokens live only inside the [data-ui=diyalog] scope; data-theme overrides the scheme', () => {
    scoped(<p>x</p>, 'dark');
    expect(screen.getByTestId('scope').getAttribute('data-theme')).toBe('dark');
    // The classic console has no data-ui attribute: nothing outside the scope picks up Diyalog tokens.
    expect(document.documentElement.hasAttribute('data-ui')).toBe(false);
  });

  it('registry: known card types and a generic fallback (never dropped)', () => {
    expect(cardFor('draft:ops_action').kind.label).toBe('Deploy');
    expect(cardFor('needs:failed').kind.tone).toBe('red');
    // p12-diyalog Faz 1: the ops thread types are registered; anything else falls back to the generic card.
    expect(cardFor('limit:paused').kind.tone).toBe('violet');
    expect(cardFor('approval:request').kind.label).toBe('Onay');
    expect(cardFor('future:kind').kind.label).toBe('Kayıt');
    registerCard('future:kind', { kind: { label: 'Yeni', icon: 'pause', tone: 'violet' } });
    expect(cardFor('future:kind').kind.tone).toBe('violet');
  });
});
