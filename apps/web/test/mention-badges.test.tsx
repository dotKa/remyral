// p12-mention-badges (docs/design/p8-chat-attachments-mentions.md §3.1): mentions in sent messages as badges (per
// type, links, the facts card, unresolved state, no injection) and the composer's atomic tokens (insert, Backspace /
// Delete as one unit, arrows skip, the chip row mirrors the text, paste and IME stay plain text).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInput, SendExtras } from '../src/api/chat';
import { messagesFor } from '@remyral/i18n';
import { MentionText, resetMentionFacts } from '../src/diyalog/chat/MentionBadge';
import { Composer } from '../src/diyalog/ops/Composer';
import {
  findTokens,
  liveMentions,
  segmentMentions,
  tokenAt,
  unplacedMentions,
} from '../src/screens/chat/mentionText';
import { fakeFetch, type Handler } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const MISSING_TEXT = messagesFor('tr').chat.mention.missing;

const JOB = '00000000-0000-4000-8000-0000000000e1';
const THREAD = '00000000-0000-4000-8000-0000000000c2';
const FOLDER = '00000000-0000-4000-8000-0000000000f1';
const INPUT: ChatInput = { images: 'supported', pdf: true, mentions: true, reason: null };

const alpha = { type: 'project', id: 'alpha', project: 'alpha', label: 'Alpha' } as const;

function stub(routes: Record<string, Handler>): ReturnType<typeof fakeFetch> {
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  return f;
}

beforeEach(() => {
  resetMentionFacts();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mention tokens in text', () => {
  it('finds only the refs’ @labels at word boundaries; look-alikes stay text', () => {
    const refs = [
      alpha,
      { type: 'project', id: 'alpha-web', project: 'alpha-web', label: 'Alpha web' } as const,
    ];
    const text = 'see @Alpha web, @Alpha. mail@Alpha @Alphabet @nobody (@Alpha)';
    const segs = segmentMentions(text, refs);
    const tokens = segs.filter((s) => s.kind === 'mention');
    // Longest label wins at one `@`; `mail@Alpha` and `@Alphabet` are not tokens; `@nobody` is not a ref.
    expect(tokens.map((t) => [t.text, t.mention.id])).toEqual([
      ['@Alpha web', 'alpha-web'],
      ['@Alpha', 'alpha'],
      ['@Alpha', 'alpha'],
    ]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(unplacedMentions('nothing here', refs)).toEqual(refs);
  });

  it('keeps one ref per token left (shared labels) and acts on a token as one unit', () => {
    const a = { type: 'job', id: 'j1', label: 'fix' } as const;
    const b = { type: 'job', id: 'j2', label: 'fix' } as const;
    expect(liveMentions('@fix and @fix', [a, b])).toEqual([a, b]);
    expect(liveMentions('@fix and @fx', [a, b])).toEqual([a]);
    expect(liveMentions('@fi', [a, b])).toEqual([]);
    const r = findTokens('hi @fix ok', [a]);
    expect(r).toHaveLength(1);
    expect(tokenAt(r, 7, 'Backspace')?.start).toBe(3);
    expect(tokenAt(r, 3, 'Backspace')).toBeNull();
    expect(tokenAt(r, 3, 'Delete')?.end).toBe(7);
    expect(tokenAt(r, 5, 'ArrowRight')?.end).toBe(7);
    expect(tokenAt(r, 8, 'ArrowLeft')).toBeNull();
  });
});

function renderText(text: string, mentions: unknown[]): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <div data-role="me">
        <MentionText text={text} meta={{ mentions }} />
      </div>
    </MemoryRouter>,
  );
}

describe('badges in a sent message', () => {
  it('renders each type as a link with a type-named accessible name and its target', () => {
    stub({});
    renderText('@Alpha @Kur @atlas @rapor.md @Eski @Notlar', [
      alpha,
      { type: 'job', id: JOB, project: 'alpha', label: 'Kur' },
      { type: 'worker', id: 'wrk_1', project: null, label: 'atlas' },
      { type: 'output', id: `file:${JOB}:ws-report`, project: 'alpha', label: 'rapor.md' },
      { type: 'thread', id: THREAD, project: null, label: 'Eski' },
      { type: 'folder', id: FOLDER, project: null, label: 'Notlar' },
    ]);
    const href = (name: string): string | null => screen.getByRole('link', { name }).getAttribute('href');
    expect(href('Proje: Alpha')).toBe('/projects/alpha');
    expect(href('İş: Kur')).toBe(`/jobs/${JOB}`);
    expect(href('Makine: atlas')).toBe('/machines/wrk_1');
    expect(href('Çıktı: rapor.md')).toBe(
      `/outputs?project=alpha&item=${encodeURIComponent(`file:${JOB}:ws-report`)}`,
    );
    expect(href('Sohbet: Eski')).toBe(`/chat/${THREAD}`);
    expect(href('Klasör: Notlar')).toBe(`/outputs?folder=${FOLDER}`);
    // All inline: nothing left for the row under the text.
    expect(screen.queryByRole('list', { name: 'Bahsedilenler' })).toBeNull();
    const kinds = screen.getAllByTestId('mention-badge').map((b) => b.getAttribute('data-mention'));
    expect(kinds).toEqual(['project', 'job', 'worker', 'output', 'thread', 'folder']);
  });

  it('keeps look-alike text plain and shows refs the text does not name in a row', () => {
    stub({});
    renderText('ping @Beta and email a@Alpha', [alpha]);
    expect(screen.getByTestId('mention-text').textContent).toBe('ping @Beta and email a@Alpha');
    expect(screen.queryByRole('link', { name: 'Proje: Beta' })).toBeNull();
    const row = screen.getByRole('list', { name: 'Bahsedilenler' });
    expect(within(row).getByRole('link', { name: 'Proje: Alpha' })).toBeTruthy();
  });

  it('never renders markup from a crafted label or text', () => {
    stub({});
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = renderText(`look @${evil} <b>x</b> [a](javascript:alert(1))`, [
      { type: 'project', id: 'alpha', project: 'alpha', label: evil },
      { type: 'job', id: 'javascript:alert(1)', project: null, label: '<script>x</script>' },
    ]);
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(screen.getByRole('link', { name: `Proje: ${evil}` }).getAttribute('href')).toBe('/projects/alpha');
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href')).not.toMatch(/javascript/);
  });

  it('shows an invalid ref as a muted, struck-through badge without a link', () => {
    stub({});
    renderText('@kayıp', [{ type: 'job', id: 'not-a-uuid', project: null, label: 'kayıp' }]);
    const badge = screen.getByRole('img', { name: `İş: kayıp (${MISSING_TEXT})` });
    expect(badge.hasAttribute('data-missing')).toBe(true);
    expect(badge.getAttribute('title')).toContain(MISSING_TEXT);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('focus opens the facts card; a job the viewer cannot read turns into the unresolved badge', async () => {
    const f = stub({
      [`GET /api/jobs/${JOB}`]: () => ({ status: 404, body: { error: 'not_found', message: 'Not found.' } }),
    });
    renderText('@Kur', [{ type: 'job', id: JOB, project: 'alpha', label: 'Kur' }]);
    const link = screen.getByRole('link', { name: 'İş: Kur' });
    fireEvent.focus(link);
    const card = await screen.findByRole('tooltip');
    expect(link.getAttribute('aria-describedby')).toBe(card.id);
    await waitFor(() => {
      expect(card.textContent).toContain('Erişim yok ya da bulunamadı.');
    });
    expect(link.hasAttribute('data-missing')).toBe(true);
    expect(link.getAttribute('aria-label')).toBe(`İş: Kur (${MISSING_TEXT})`);
    // Read once per ref.
    fireEvent.blur(link);
    fireEvent.focus(link);
    expect(f.requests.filter((r) => r.url === `/api/jobs/${JOB}`)).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a failed read is not "not found"; a project shows its own facts without a request', async () => {
    const f = stub({
      [`GET /api/jobs/${JOB}`]: () => ({ status: 500, body: { error: 'internal', message: 'x' } }),
    });
    renderText('@Kur @Alpha', [{ type: 'job', id: JOB, project: 'alpha', label: 'Kur' }, alpha]);
    const job = screen.getByRole('link', { name: 'İş: Kur' });
    fireEvent.focus(job);
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('Ayrıntılar okunamadı.');
    });
    expect(job.hasAttribute('data-missing')).toBe(false);
    fireEvent.blur(job);
    fireEvent.focus(screen.getByRole('link', { name: 'Proje: Alpha' }));
    const card = await screen.findByRole('tooltip');
    expect(card.textContent).toContain('Proje');
    expect(card.textContent).toContain('alpha');
    expect(f.requests.some((r) => r.url.includes('/projects'))).toBe(false);
  });
});

describe('the composer’s mention tokens', () => {
  function setup(): { onSend: ReturnType<typeof vi.fn>; box: HTMLTextAreaElement } {
    stub({
      'GET /api/chat/mentions?q=': () => ({
        status: 200,
        body: { items: [{ ...alpha, detail: 'repository' }] },
      }),
    });
    const onSend = vi.fn((_t: string, _e?: SendExtras) => Promise.resolve());
    render(
      <MemoryRouter>
        <Composer onSend={onSend} input={INPUT} />
      </MemoryRouter>,
    );
    return { onSend, box: screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' }) };
  }

  async function pickAlpha(box: HTMLTextAreaElement, before = ''): Promise<void> {
    const start = box.value;
    await userEvent.type(box, `${before}@`);
    await screen.findByRole('option', { name: /Alpha/ });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(box.value).toBe(`${start}${before}@Alpha `);
    });
  }

  it('a pick inserts the readable token, a typed chip and the tint under it; the ref is sent', async () => {
    const { onSend, box } = setup();
    await pickAlpha(box, 'bak ');
    const chips = screen.getAllByTestId('dy-picked-mention');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain('Proje');
    const mark = within(screen.getByTestId('dy-mention-highlight')).getByText('@Alpha');
    expect(mark.tagName).toBe('MARK');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('bak @Alpha', {
        mentions: [{ type: 'project', id: 'alpha', project: 'alpha' }],
      });
    });
  });

  it('Backspace removes the whole token and its chip; the picker does not reopen on it', async () => {
    const { box } = setup();
    await pickAlpha(box, 'bak ');
    await userEvent.keyboard('{Backspace}');
    expect(box.value).toBe('bak @Alpha');
    expect(screen.queryByTestId('dy-mention-picker')).toBeNull();
    await userEvent.keyboard('{Backspace}');
    await waitFor(() => {
      expect(box.value).toBe('bak ');
    });
    expect(screen.queryByTestId('dy-picked-mention')).toBeNull();
    expect(screen.queryByTestId('dy-mention-highlight')).toBeNull();
  });

  it('arrows step over a token, Delete removes it from its start', async () => {
    const { box } = setup();
    await pickAlpha(box, 'a ');
    await userEvent.type(box, 'b');
    expect(box.value).toBe('a @Alpha b');
    box.setSelectionRange(8, 8);
    await userEvent.keyboard('{ArrowLeft}');
    expect(box.selectionStart).toBe(2);
    await userEvent.keyboard('{ArrowRight}');
    expect(box.selectionStart).toBe(8);
    box.setSelectionRange(2, 2);
    await userEvent.keyboard('{Delete}');
    await waitFor(() => {
      expect(box.value).toBe('a  b');
    });
    expect(screen.queryByTestId('dy-picked-mention')).toBeNull();
  });

  it('removing the chip removes its token; editing a token drops its ref', async () => {
    const { onSend, box } = setup();
    await pickAlpha(box, 'x ');
    await userEvent.click(screen.getByRole('button', { name: 'Bahsi kaldır: Alpha' }));
    await waitFor(() => {
      expect(box.value).toBe('x ');
    });
    await pickAlpha(box, '');
    // An edit inside the token (here: the text replaced) breaks it — the chip row follows the text.
    fireEvent.change(box, { target: { value: 'x @Alpxha ' } });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-picked-mention')).toBeNull();
    });
    await userEvent.type(box, 'y{Enter}');
    await waitFor(() => {
      expect(onSend).toHaveBeenCalled();
    });
    expect(onSend.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('pasted "@Label" text stays plain text (no ref), and IME keys are left to the browser', async () => {
    const { onSend, box } = setup();
    await userEvent.click(box);
    await userEvent.paste('@Alpha selam');
    expect(box.value).toBe('@Alpha selam');
    expect(screen.queryByTestId('dy-picked-mention')).toBeNull();
    // A composing Backspace (Turkish / CJK IME) is never taken over.
    const notPrevented = fireEvent.keyDown(box, { key: 'Backspace', isComposing: true });
    expect(notPrevented).toBe(true);
    fireEvent.keyDown(box, { key: 'Escape' });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(onSend).toHaveBeenCalled();
    });
    expect(onSend.mock.calls[0]?.[1]).toBeUndefined();
  });
});
