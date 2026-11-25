// p17-ui-polish: the layout / UX pass after the screen review.
import { loadCatalog, messagesFor } from '@remyral/i18n';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Row, Rows, ThreadLink } from '../src/diyalog/screens/parts';

function scoped(ui: ReactNode): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <div data-ui="diyalog">{ui}</div>
    </MemoryRouter>,
  );
}

function stubPhone(phone: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: phone && q.includes('max-width'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function jobRow(): ReactNode {
  return (
    <Rows label="İşler">
      <Row
        compact
        testId="row"
        title="Login testini düzelt"
        meta={<span>mobil-app</span>}
        trail={<span data-testid="figures">7 dk</span>}
        actions={<ThreadLink target={{ kind: 'job', id: 'j1' }} about="Login testini düzelt" />}
      />
    </Rows>
  );
}

describe('row actions on phones (item 1)', () => {
  it('the thread link keeps its accessible name; its visible label hides on phones only', () => {
    stubPhone(false);
    scoped(jobRow());
    const link = screen.getByRole('link', { name: "Login testini düzelt: thread'de aç" });
    expect(link.getAttribute('href')).toBe('/jobs/j1');
    expect(within(link).getByText('thread’de aç').className).toContain('max-sm:sr-only');
  });

  it('a compact row on a desktop keeps the figures in the trailing column', () => {
    stubPhone(false);
    scoped(jobRow());
    const row = screen.getByTestId('row');
    expect(row.hasAttribute('data-dy-compact')).toBe(true);
    expect(screen.getByTestId('figures').closest('.dy-rowc-meta')).toBeNull();
    expect(screen.getByTestId('figures').closest('.dy-rowc-end')).not.toBeNull();
  });

  it('a compact row on a phone ends its meta line with the figures (no line of its own)', () => {
    stubPhone(true);
    scoped(jobRow());
    expect(screen.getAllByTestId('figures')).toHaveLength(1);
    expect(screen.getByTestId('figures').closest('.dy-rowc-meta')).not.toBeNull();
    // The actions stay (as icon buttons) beside the title.
    expect(screen.getByTestId('thread-link').closest('.dy-rowc-actions')).not.toBeNull();
  });
});

describe('composer placeholder on phones (item 8)', () => {
  it('the catalog has a short phone placeholder in both languages', async () => {
    const tr = messagesFor('tr').home.composer;
    const en = (await loadCatalog('en')).home.composer;
    expect(tr.placeholderShort.length).toBeLessThan(tr.placeholder.length / 2);
    expect(en.placeholderShort.length).toBeLessThan(en.placeholder.length / 2);
  });
});

describe('harness fixtures for the screens the review could not see (item 10)', () => {
  it('Sunucu ayarları: every section, the mail settings, the keys and the maintenance jobs parse', async () => {
    const { screenRoute } = await import('../src/diyalog/harness/screens');
    const { PANEL_SECTIONS, parseSection } = await import('../src/api/panelSettings');
    const get = (path: string): unknown => {
      const r = screenRoute(path)
        .map((f) => f(new URL(`http://h/api${path}`), 'GET'))
        .find((b) => b !== undefined);
      return r;
    };
    for (const s of PANEL_SECTIONS) {
      const view = parseSection(get(`/panel-settings/${s}`));
      expect(view.section).toBe(s);
      expect(view.fields.length).toBeGreaterThan(0);
    }
    expect(get('/panel-settings/mail')).toMatchObject({ source: 'panel' });
    expect((get('/panel-settings/keys') as { items: unknown[] }).items).toHaveLength(4);
    expect((get('/maintenance/jobs') as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});
