// p12-diyalog Faz 4: the shared frame and parts of the secondary screens — routing fallback, the "thread'de aç"
// targets and the card-hash landing in the ops thread, the token bridge scope, and the parts' roles.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { cardKeyFromHash, useCardHash } from '../src/diyalog/ops/cardHash';
import { diyalogScreen } from '../src/diyalog/screens/routes';
import { ScreenFrame, SegTabs } from '../src/diyalog/screens/ScreenFrame';
import {
  Meter,
  Panel,
  Row,
  Rows,
  SlotCells,
  Sparkline,
  StatTile,
  StatTiles,
  ThreadLink,
  agoText,
  threadHref,
} from '../src/diyalog/screens/parts';

describe('Faz 4 routing', () => {
  it('every former classic route has a Diyalog screen; unknown paths are left to the route table', () => {
    expect(diyalogScreen('/nope')).toBeNull();
    // p15-classic-removal (docs/design/p15-classic-removal.md §2): every path of the classic route table.
    for (const p of [
      '/jobs',
      '/jobs/new',
      '/jobs/templates',
      '/jobs/templates/new',
      '/jobs/templates/t1',
      '/jobs/templates/t1/edit',
      '/jobs/workflows/r1',
      '/automations',
      '/automations/new',
      '/automations/a1',
      '/automations/a1/edit',
      '/approvals',
      '/approvals/ap1',
      '/deploys',
      '/deploys/d1',
      '/outputs',
      '/uptime',
      '/uptime/m1',
      '/machines',
      '/machines/add',
      '/machines/w1',
      '/projects',
      '/projects/p1',
      '/skills',
      '/context',
      '/usage',
      '/usage/reports/r1',
      '/audit',
      '/settings',
      '/settings/profile',
      '/settings/security',
      '/settings/devices',
      '/settings/runtimes',
      '/settings/models',
      '/settings/credentials',
      '/settings/integrations',
      '/settings/integrations/github/callback',
      '/settings/integrations/github/installed',
      '/settings/chat',
      '/settings/users',
      '/settings/releases',
      '/settings/backups',
      '/settings/context',
      '/settings/notifications',
    ])
      expect(diyalogScreen(p), p).not.toBeNull();
  });
});

describe('thread targets', () => {
  it('a job opens its own thread; a decision opens its card in the ops thread', () => {
    expect(threadHref({ kind: 'job', id: 'j 1' })).toBe('/jobs/j%201');
    expect(threadHref({ kind: 'approval', id: 'ap-1' })).toBe('/needs#kart=approval:ap-1');
    expect(threadHref({ kind: 'deploy', id: 'd/1' })).toBe('/needs#kart=deploy:d%2F1');
  });

  it('parses the card hash (and refuses junk)', () => {
    expect(cardKeyFromHash('#kart=approval:ap-1')).toBe('approval:ap-1');
    expect(cardKeyFromHash('#kart=deploy:d%2F1')).toBe('deploy:d/1');
    expect(cardKeyFromHash('#benden-bekleyen')).toBeNull();
    expect(cardKeyFromHash('#kart=')).toBeNull();
    expect(cardKeyFromHash('#kart=%E0%A4%A')).toBeNull();
  });

  it('lands on the card once it is in the thread', async () => {
    function Thread(): ReactNode {
      useCardHash();
      const [shown, setShown] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setShown(true);
            }}
          >
            yükle
          </button>
          {shown ? (
            <article data-card="approval:ap-1" aria-label="kart">
              onay
            </article>
          ) : null}
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/#kart=approval:ap-1']}>
        <Thread />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'yükle' }));
    const card = await screen.findByRole('article', { name: 'kart' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(card);
    expect(card.getAttribute('tabindex')).toBe('-1');
  });

  it('ThreadLink names what it opens', () => {
    render(
      <MemoryRouter>
        <ThreadLink target={{ kind: 'job', id: 'j1' }} about="Login testini düzelt" />
      </MemoryRouter>,
    );
    const a = screen.getByRole('link', { name: "Login testini düzelt: thread'de aç" });
    expect(a.getAttribute('href')).toBe('/jobs/j1');
  });
});

describe('token bridge', () => {
  it('lives only under the Diyalog scope', () => {
    const css = readFileSync(join(__dirname, '../src/diyalog/diyalog.css'), 'utf8');
    const rules = [...css.matchAll(/^([^\n{}@/*][^\n{]*)\{/gm)].map((m) => (m[1] ?? '').trim());
    const bridge = rules.filter((r) => r.includes('.dy-bridge'));
    expect(bridge.length).toBeGreaterThan(0);
    for (const r of bridge) expect(r.startsWith("[data-ui='diyalog']")).toBe(true);
    // Every classic semantic token is remapped (a missing one would leave a classic colour in a Diyalog screen).
    const classic = readFileSync(join(__dirname, '../src/index.css'), 'utf8');
    const tokens = new Set([...classic.matchAll(/^\s*(--c-[a-z0-9-]+):/gm)].map((m) => m[1]));
    // p12-diyalog-final: the same rule also scopes the log viewer (`.dy-log`).
    const block = /\[data-ui='diyalog'\] :is\(\.dy-bridge, \.dy-log\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const t of tokens) expect(block).toContain(`${t ?? ''}:`);
  });
});

function Where(): ReactNode {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}

describe('ScreenFrame and parts', () => {
  it('frames a screen: one h1, the main landmark, the document title, bridge scope', () => {
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
              title="Makineler"
              purpose="Ajanları çalıştıran makineler."
              back={{ to: '/', label: 'Sohbet' }}
            >
              <p>içerik</p>
            </ScreenFrame>
          </div>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Makineler' })).toBeTruthy();
    const main = screen.getByRole('main');
    expect(main.closest('.dy-bridge')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Sohbet' }).getAttribute('href')).toBe('/');
    expect(document.title).toBe('Makineler · Remyral');
  });

  it('SegTabs are URL tabs with arrow keys', async () => {
    render(
      <MemoryRouter initialEntries={['/x']}>
        <SegTabs
          label="Görünüm"
          items={[
            { id: 'list', label: 'Liste' },
            { id: 'queue', label: 'Kuyruk', count: 3 },
          ]}
        >
          {(t) => <p>panel {t}</p>}
        </SegTabs>
        <Where />
      </MemoryRouter>,
    );
    expect(screen.getByText('panel list')).toBeTruthy();
    screen.getByRole('tab', { name: 'Liste' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText('panel queue')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('?tab=queue');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Kuyruk/ }));
  });

  it('meters, sparklines, slot cells and tiles speak in words', () => {
    render(
      <MemoryRouter>
        <Panel title="Pencereler" count="2">
          <Meter label="Claude Code 5 saat" value={72} text="%72, 56 dk sonra" mark={80} />
          <Sparkline points={[10, 20, 72]} summary="Son 24 saat: %10’dan %72’ye" />
          <Sparkline points={[5]} summary="Veri yok" />
          <SlotCells used={2} max={4} waiting={1} label="2 / 4 slot dolu, 1 bekliyor" />
          <StatTiles label="Özet">
            <StatTile label="Çevrim içi" value="4 / 5" note="1 kapalı" tone="red" />
          </StatTiles>
          <Rows label="Makineler">
            <Row title="atlas-win-01" meta="windows · x64" trail="2/3" />
          </Rows>
        </Panel>
      </MemoryRouter>,
    );
    expect(screen.getByRole('region', { name: /Pencereler/ })).toBeTruthy();
    const m = screen.getByRole('meter', { name: 'Claude Code 5 saat' });
    expect(m.getAttribute('aria-valuenow')).toBe('72');
    expect(m.getAttribute('aria-valuetext')).toBe('%72, 56 dk sonra');
    expect(screen.getByRole('img', { name: 'Son 24 saat: %10’dan %72’ye' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Veri yok' }).textContent).toBe('—');
    expect(screen.getByRole('img', { name: '2 / 4 slot dolu, 1 bekliyor' }).children).toHaveLength(4);
    expect(screen.getByText('Çevrim içi').tagName).toBe('DT');
    expect(screen.getByRole('list', { name: 'Makineler' })).toBeTruthy();
  });

  it('relative time in Turkish', () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(agoText(null, now)).toBe('—');
    expect(agoText('2026-10-19T11:59:30Z', now)).toBe('az önce');
    expect(agoText('2026-10-19T11:57:00Z', now)).toBe('3 dk önce');
    expect(agoText('2026-10-19T09:00:00Z', now)).toBe('3 sa önce');
    expect(agoText('2026-10-15T12:00:00Z', now)).toBe('4 gün önce');
  });
});
