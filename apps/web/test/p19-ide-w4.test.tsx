import { createFormatter, messagesFor } from '@remyral/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { CardStrip } from '../src/diyalog/chat/CardStrip';
import { assistantCodeCardHref, parseAssistantCodeCard } from '../src/diyalog/code/refs';
import { draftEvent } from '../src/diyalog/drafts/event';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { chatItems, type StripCard } from '../src/diyalog/ops/timeline';
import { I18nProvider } from '../src/i18n/I18nProvider';

/**
 * p19-ide W4 (docs/design/p19-ide.md §6, §9 W4): the assistant's "Aç" cards (open_code / open_diff on a tool line's
 * `meta.codeCard`) — parsed strictly, linked to the viewer / reviewer, never opened by themselves — and the
 * "Değişiklik iste" card of draft_review_changes.
 */
const TR = messagesFor('tr');
let EN = messagesFor('tr');
const fmtTr = createFormatter('tr');
beforeAll(() => {
  EN = messagesFor('en');
});
const SHA = 'a'.repeat(40);
const JOB = '22222222-2222-4222-8222-222222222222';
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';

describe('the assistant code card (p19-ide W4)', () => {
  it('parses only the known fields and builds the links itself', () => {
    const code = parseAssistantCodeCard({
      kind: 'code',
      project: 'shop',
      path: 'src/app.ts',
      sha: SHA,
      refLabel: 'main',
      startLine: 40,
      endLine: 58,
      href: 'https://evil.example/', // ignored
    });
    expect(code).toEqual({
      kind: 'code',
      project: 'shop',
      path: 'src/app.ts',
      sha: SHA,
      refLabel: 'main',
      startLine: 40,
      endLine: 58,
    });
    expect(code === null ? '' : assistantCodeCardHref(code)).toBe(
      `/projects/shop/code?ref=${SHA}&path=src%2Fapp.ts&L=40-58`,
    );
    const job = parseAssistantCodeCard({
      kind: 'diff',
      project: 'shop',
      job: JOB,
      path: 'src/a.ts',
      files: 3,
    });
    expect(job === null ? '' : assistantCodeCardHref(job)).toBe(
      `/projects/shop/code/jobs/${JOB}?path=src%2Fa.ts`,
    );
    const cmp = parseAssistantCodeCard({
      kind: 'diff',
      project: 'shop',
      base: 'main',
      head: 'feature/x',
      pr: 7,
    });
    expect(cmp === null ? '' : assistantCodeCardHref(cmp)).toBe(
      '/projects/shop/code/compare?base=main&head=feature%2Fx',
    );
    for (const bad of [
      null,
      { kind: 'code', project: 'shop', path: '../etc/passwd', sha: SHA },
      { kind: 'code', project: 'shop', path: 'a.ts', sha: 'main' },
      { kind: 'code', project: 'a b', path: 'a.ts', sha: SHA },
      { kind: 'diff', project: 'shop', base: 'main' },
      { kind: 'diff', project: 'shop', base: 'main', head: 'x y' },
      { kind: 'link', project: 'shop' },
    ])
      expect(parseAssistantCodeCard(bad)).toBeNull();
  });

  it('a tool line with a code card puts an "Aç" card into the turn’s strip', () => {
    const at = new Date().toISOString();
    const items = chatItems({
      thread: { id: THREAD, title: 'Kod', archived: false, createdAt: at, updatedAt: at },
      messages: [
        { id: 'm1', seq: 1, role: 'user', content: 'göster', meta: null, turnId: null, createdAt: at },
        {
          id: 'm2',
          seq: 2,
          role: 'tool',
          content: 'open_code: ok',
          meta: {
            name: 'open_code',
            isError: false,
            codeCard: {
              kind: 'code',
              project: 'shop',
              path: 'src/app.ts',
              sha: SHA,
              refLabel: 'main',
              startLine: 3,
            },
          },
          turnId: 't',
          createdAt: at,
        },
        {
          id: 'm3',
          seq: 3,
          role: 'assistant',
          content: 'Karttan açabilirsin.',
          meta: null,
          turnId: 't',
          createdAt: at,
        },
      ] as never,
      drafts: [],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
    });
    const strip = items.find((i) => i.kind === 'cards');
    expect(strip?.kind === 'cards' ? strip.cards.map((c) => c.kind) : []).toEqual(['code']);
  });

  it('renders as a link the user clicks — nothing navigates by itself', () => {
    const card = parseAssistantCodeCard({
      kind: 'code',
      project: 'shop',
      path: 'src/app.ts',
      sha: SHA,
      refLabel: 'main',
      startLine: 3,
      endLine: 9,
      note: 'Sepet boşken burada patlıyor.',
    });
    if (card === null) throw new Error('card');
    const cards: StripCard[] = [{ kind: 'code', key: 'code:m2', card, at: new Date().toISOString() }];
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <I18nProvider>
          <CardStrip cards={cards} threadId={THREAD} turnOpen={false} onChanged={() => undefined} />
        </I18nProvider>
      </MemoryRouter>,
    );
    const strip = screen.getByTestId('strip-card');
    expect(strip.textContent).toContain('src/app.ts:3-9');
    // The provider's language follows the browser (English in jsdom); both catalogs have the words.
    expect(strip.textContent).toMatch(/Açmaya hazır|Ready to open/);
    const open = screen.getByRole('link', { name: /^(Aç|Open)$/ });
    expect(open.getAttribute('href')).toBe(`/projects/shop/code?ref=${SHA}&path=src%2Fapp.ts&L=3-9`);
    fireEvent.click(screen.getByTestId('strip-details'));
    expect(screen.getByTestId('code-card-body').textContent).toContain('Sepet boşken burada patlıyor.');
    expect(screen.getByTestId('code-card-open').getAttribute('href')).toBe(open.getAttribute('href'));
  });
});

describe('the "Değişiklik iste" card (p19-ide W4)', () => {
  const payload = {
    target: 'admin',
    op: 'code.request_changes',
    event: 'chat.cards',
    project: 'shop',
    jobId: JOB,
    jobTitle: 'Sepeti düzelt',
    headSha: SHA,
    note: 'API aynı kalsın.',
    comments: [{ path: 'src/app.ts', side: 'new', startLine: 4, endLine: 6, body: 'Boş sepeti ele al.' }],
    openThreads: 2,
  };

  it('names its area and shows the job, the line comments and the note', () => {
    expect(draftKindText('settings_change', TR, payload)).toBe('Kod incelemesi');
    expect(draftKindText('settings_change', EN, payload)).toBe('Code review');
    const s = summarizeDraft({ kind: 'settings_change', payload }, TR, fmtTr);
    expect(s.key).toEqual(
      expect.arrayContaining([
        { k: 'İşlem', v: 'Değişiklik iste' },
        { k: 'Proje', v: 'shop' },
        { k: 'İş', v: 'Sepeti düzelt' },
        { k: 'Satır yorumları', v: 'src/app.ts:4-6 — Boş sepeti ele al.' },
        { k: 'Genel not', v: 'API aynı kalsın.' },
      ]),
    );
    expect(s.details.map((d) => d.v).join('\n')).toMatch(/Hiçbir branch’e doğrudan yazılmaz/);
    expect(s.details.map((d) => d.v).join('\n')).toMatch(/açık 2 inceleme yorumu/);
    expect(draftEvent('settings_change', payload)).toBe('chat.cards');
  });
});
