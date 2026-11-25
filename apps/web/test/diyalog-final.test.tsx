// p12-diyalog-final: the shared conventions of the Diyalog UI, once and native — the pager (classic contract + URL
// state), the dialog / side sheet, the notices (API error with its own Retry-After countdown, reason codes in
// Turkish), the two-step confirm, copy, the actor, the relative-time ticker, sortable lists, the log viewer, the
// SectionPage placeholder, the keyboard inset of the Sohbet composer — and no Diyalog file renders a classic
// component for any of them.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import type { LogRow } from '../src/components/LogLines';
import { describeReason, KNOWN_REASON_CODES } from '../src/lib/reasons';
import { messagesFor, reasonCodes } from '@remyral/i18n';
import { useClientPage } from '../src/lib/pager';
import { SECTIONS } from '../src/shell/sections';
import { DyConfirm, DyCopyButton } from '../src/diyalog/common/actions';
import { DyActor } from '../src/diyalog/common/actor';
import { DyLogView } from '../src/diyalog/common/logs';
import { DyApiError, DyReason } from '../src/diyalog/common/notices';
import { DyPager } from '../src/diyalog/common/pager';
import { DySortBar, sortRows, useSortParam } from '../src/diyalog/common/sort';
import { agoText, DyTime, whenText } from '../src/diyalog/common/time';
import { keyboardInset, useKeyboardInset } from '../src/diyalog/chat/viewport';
import { DyDialog } from '../src/diyalog/DyDialog';
import { DySectionPage, matchSection } from '../src/diyalog/screens/SectionPage';
import { USER } from './helpers';
import { toastByTestId } from './toasts';

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

function Where(): ReactNode {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}

function wrap(ui: ReactNode, path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialState={owner} channel={null}>
        <div data-ui="diyalog">
          {ui}
          <Where />
        </div>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('p12-diyalog-final — one native set of shared conventions', () => {
  it('pager: Turkish a–b / n, page x / y, first / previous / next / last, 25 / 50 / 100, URL state with a prefix', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 140 }, (_, i) => i);
    function List(): ReactNode {
      const { pageItems, pagination } = useClientPage(items, { label: 'Deneme sayfaları', prefix: 'x' });
      return (
        <>
          <p data-testid="first">{pageItems[0]}</p>
          <DyPager {...pagination} />
        </>
      );
    }
    wrap(<List />);
    const nav = screen.getByRole('navigation', { name: 'Deneme sayfaları' });
    expect(nav.textContent).toContain('1–25 / 140');
    expect(nav.textContent).toContain('Sayfa 1 / 6');
    expect(within(nav).getByRole<HTMLButtonElement>('button', { name: 'Önceki sayfa' }).disabled).toBe(true);
    await user.click(within(nav).getByRole('button', { name: 'Sonraki sayfa' }));
    await user.click(within(nav).getByRole('button', { name: 'Sonraki sayfa' }));
    expect(screen.getByTestId('where').textContent).toBe('?xPage=3');
    expect(screen.getByTestId('first').textContent).toBe('50');
    // From page 3: first and last.
    await user.click(within(nav).getByRole('button', { name: 'Son sayfa' }));
    expect(nav.textContent).toContain('126–140 / 140');
    await user.click(within(nav).getByRole('button', { name: 'İlk sayfa' }));
    expect(screen.getByTestId('first').textContent).toBe('0');
    await user.selectOptions(within(nav).getByLabelText('Satır'), '100');
    expect(screen.getByTestId('where').textContent).toContain('xPageSize=100');
    expect(nav.textContent).toContain('Sayfa 1 / 2');
  });

  it('pager: hidden when the list fits on one page; keyset lists show "Sayfa n" without a total', () => {
    const noop = (): void => undefined;
    const base = { label: 'L', pageSize: 25, onPrev: noop, onNext: noop, onPageSize: noop };
    const { container, rerender } = render(<DyPager {...base} page={1} count={20} hasNext={false} />);
    expect(container.querySelector('nav')).toBeNull();
    rerender(<DyPager {...base} page={2} count={25} hasNext total={null} />);
    expect(screen.getByRole('navigation').textContent).toContain('26–50');
    expect(screen.getByRole('navigation').querySelector('p')?.textContent).toMatch(/Sayfa 2$/);
  });

  it('dialog: native modal, title / description, Escape closes, focus returns; sheet size', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Host(props: { readonly open: boolean }): ReactNode {
      return (
        <>
          <button type="button">açan</button>
          <DyDialog open={props.open} onClose={onClose} title="Başlık" description="Açıklama" size="sheet">
            <button type="button">içerik</button>
          </DyDialog>
        </>
      );
    }
    const { rerender } = render(<Host open={false} />);
    screen.getByRole('button', { name: 'açan' }).focus();
    rerender(<Host open />);
    const dialog = screen.getByRole('dialog', { name: 'Başlık' });
    expect(dialog.getAttribute('data-size')).toBe('sheet');
    expect(within(dialog).getByText('Açıklama')).toBeTruthy();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Kapat' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<Host open={false} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'açan' }));
  });

  it('API error: the master message verbatim and its own Retry-After countdown in Turkish', () => {
    vi.useFakeTimers();
    const err = new ApiError(429, 'rate_limited', 'Too many attempts.', 65);
    render(<DyApiError error={err} />);
    expect(screen.getByTestId('api-error').textContent).toBe('Too many attempts.');
    expect(screen.getByTestId('retry-left').textContent).toBe('1 dk 05 sn sonra yeniden deneyebilirsin.');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('retry-left').textContent).toBe('1 dk 03 sn sonra yeniden deneyebilirsin.');
    act(() => {
      vi.advanceTimersByTime(70_000);
    });
    expect(screen.queryByTestId('retry-left')).toBeNull();
  });

  it('reasons: every mapped code has a Turkish sentence; fix labels in Turkish; unknown codes stay raw', () => {
    // p14-i18n-reasons: one catalog for both languages (typecheck keeps TR and EN in step).
    expect(reasonCodes(messagesFor('tr')).sort()).toEqual([...KNOWN_REASON_CODES].sort());
    const describeReasonTr = (raw: string, ctx?: Parameters<typeof describeReason>[1]) =>
      describeReason(raw, ctx, { locale: 'tr' });
    const offline = describeReasonTr('worker_offline: heartbeat lost', {
      workerId: 'w1',
      workerName: 'mac-1',
    });
    expect(offline.sentence).toBe('mac-1 makinesi çevrim dışı.');
    expect(offline.action?.label).toBe('Makineyi aç');
    expect(offline.action?.href).toBe('/machines?worker=w1');
    expect(describeReasonTr('something odd happened').sentence).toBe('something odd happened');
    expect(describeReasonTr('provider_paused').action?.label).toBe('Kullanımı aç');
    for (const code of KNOWN_REASON_CODES) {
      const info = describeReasonTr(`${code}: x`, { runtime: 'codex' });
      expect(info.sentence, code).not.toMatch(/\b(the|is|not|machine|runtime policy)\b/);
    }
    wrap(
      <DyReason
        reason="runtime_not_installed: codex missing"
        context={{ runtime: 'codex', workerId: 'w1' }}
      />,
    );
    expect(screen.getByText('Codex bu makinede kurulu değil.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Runtime kur' }).getAttribute('href')).toBe(
      '/machines?worker=w1&section=remote-ops',
    );
    expect(screen.getByText('Ayrıntı')).toBeTruthy();
  });

  it('confirm: the first press opens a confirm dialog (never inline); Escape cancels with focus back, the confirm runs it once', async () => {
    // p18-confirm-dialog: no confirmation is rendered next to the trigger; it is a small DyDialog.
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <DyConfirm
        label="Sil"
        confirmLabel="Evet, sil"
        question="Silinsin mi?"
        description="Geri alınamaz."
        onConfirm={run}
        testId="del"
      />,
    );
    const trigger = screen.getByTestId('del');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.queryByTestId('del-confirm')).toBeNull();
    expect(screen.getByTestId('del-dialog').hasAttribute('open')).toBe(false);
    trigger.focus();
    await user.click(trigger);
    expect(run).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('del-dialog');
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).getByRole('heading', { name: 'Silinsin mi?' })).toBeDefined();
    expect(dialog.textContent).toContain('Geri alınamaz.');
    // The trigger stays where it was; the question is not rendered next to it.
    expect(trigger.isConnected).toBe(true);
    expect(screen.getAllByText('Silinsin mi?').every((el) => dialog.contains(el))).toBe(true);
    // A destructive confirmation starts on Vazgeç (Enter must not destroy by accident).
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    // The native dialog turns Escape into `cancel` (jsdom does not run that browser behaviour).
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByTestId('del-confirm')).toBeNull();
    });
    expect(run).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
    await user.click(trigger);
    await user.click(within(await screen.findByTestId('del-dialog')).getByRole('button', { name: 'Vazgeç' }));
    expect(run).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(await screen.findByTestId('del-confirm'));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId('del-confirm')).toBeNull();
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('confirm: a non-destructive (warn) confirmation focuses its confirm button', async () => {
    const user = userEvent.setup();
    render(<DyConfirm label="Duraklat" variant="warn" onConfirm={vi.fn()} testId="pause" />);
    await user.click(screen.getByTestId('pause'));
    const dialog = await screen.findByTestId('pause-dialog');
    expect(within(dialog).getByRole('heading', { name: 'Emin misin?' })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByTestId('pause-confirm'));
  });

  it('copy: builds the text on click and announces the result', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const text = vi.fn(() => 'satır 1\nsatır 2');
    render(<DyCopyButton text={text} about="Günlüğü kopyala" />);
    expect(text).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Günlüğü kopyala' }));
    expect(writeText).toHaveBeenCalledWith('satır 1\nsatır 2');
    // p17-toasts-shortcuts: the result is a toast of the shell's toaster (none in this bare render: the queue).
    await waitFor(() => {
      expect(toastByTestId('dy-copied')?.title).toBe('Kopyalandı.');
    });
  });

  it('actor: the signed-in user, "Sen", system words in Turkish, unknown ids short in mono', () => {
    wrap(
      <>
        <DyActor actor={USER.id} />
        <DyActor actor={USER.id} you />
        <DyActor actor={{ type: 'system', id: null }} />
        <DyActor actor={{ type: 'worker', id: 'wrk_1234567890' }} />
        <DyActor actor={{ type: 'user', id: 'abcdef12-0000', username: 'ayse' }} />
        <DyActor actor={null} />
      </>,
    );
    expect(screen.getByText(USER.username)).toBeTruthy();
    expect(screen.getByText('Sen')).toBeTruthy();
    expect(screen.getByText('Sistem')).toBeTruthy();
    expect(screen.getByText('Makine wrk_1234')).toBeTruthy();
    expect(screen.getByText('ayse')).toBeTruthy();
    expect(screen.getByText('Bilinmiyor')).toBeTruthy();
  });

  it('relative time: Turkish words, a time ahead with "sonra", and DyTime moves on the shared 30 s clock', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    expect(agoText('2026-10-19T11:59:40.000Z', now)).toBe('az önce');
    expect(agoText('2026-10-19T11:57:00.000Z', now)).toBe('3 dk önce');
    expect(agoText('2026-10-19T09:00:00.000Z', now)).toBe('3 sa önce');
    expect(agoText('2026-10-15T12:00:00.000Z', now)).toBe('4 gün önce');
    expect(whenText('2026-10-19T12:46:00.000Z', now)).toBe('46 dk sonra');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);
    render(<DyTime iso="2026-10-19T11:59:50.000Z" />);
    expect(screen.getByText('az önce')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(screen.getByText('2 dk önce')).toBeTruthy();
  });

  it('sortable lists: toggles with the order in their names, kept in the URL; new key asc, flip, clear', async () => {
    const user = userEvent.setup();
    const rows = [
      { name: 'b', n: 2 },
      { name: 'a', n: 3 },
      { name: 'c', n: 1 },
    ];
    const KEYS = ['name', 'n'] as const;
    function List(): ReactNode {
      const [sort, setSort] = useSortParam(KEYS, { initial: { key: 'name', dir: 'asc' } });
      const shown = sortRows(rows, sort, {
        name: (a, b) => a.name.localeCompare(b.name),
        n: (a, b) => a.n - b.n,
      });
      return (
        <>
          <DySortBar keys={KEYS} labels={{ name: 'Ad', n: 'Sayı' }} sort={sort} onSort={setSort} testId="s" />
          <p data-testid="order">{shown.map((r) => r.name).join('')}</p>
        </>
      );
    }
    wrap(<List />);
    expect(screen.getByTestId('order').textContent).toBe('abc');
    expect(screen.getByRole('button', { name: 'Ad, artan' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Ad, artan' }));
    expect(screen.getByTestId('order').textContent).toBe('cba');
    expect(screen.getByTestId('where').textContent).toBe('?sort=name&dir=desc');
    await user.click(screen.getByRole('button', { name: 'Sayı' }));
    expect(screen.getByTestId('order').textContent).toBe('cba');
    expect(screen.getByRole('button', { name: 'Sayı, artan' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sayı, artan' }));
    await user.click(screen.getByRole('button', { name: 'Sayı, azalan' }));
    // A third press goes back to the default order (the server's), distinct from the initial sort.
    expect(screen.getByTestId('where').textContent).toBe('?sort=none');
    expect(screen.getByTestId('order').textContent).toBe('bac');
  });

  it('log viewer: gutter + time remembered in this browser, wall / elapsed, wrap, copy, count', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const t0 = Date.parse('2026-10-19T12:00:00.000Z');
    const rows: LogRow[] = [1, 2, 3].map((no) => ({
      kind: 'line',
      key: no,
      no,
      tsMs: t0 + no * 1000,
      startMs: t0,
      badge: null,
      tone: 'default',
      segments: [{ text: `satır ${String(no)}`, cls: '' }],
    }));
    render(
      <div data-ui="diyalog">
        <DyLogView
          label="Deneme günlüğü"
          rows={rows}
          copyText={() => 'satır 1\nsatır 2\nsatır 3'}
          count="3 satır"
          empty="Henüz satır yok."
          testId="lv"
        />
      </div>,
    );
    const lv = screen.getByTestId('lv');
    expect(lv.querySelector('.dy-log [role="log"]')).not.toBeNull();
    expect(within(lv).getByText('3 satır')).toBeTruthy();
    expect(within(lv).getByRole('button', { name: 'Satır kaydır' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    await user.click(within(lv).getByRole('button', { name: 'Satır kaydır' }));
    expect(within(lv).getByRole('button', { name: 'Satır kaydır' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.click(within(lv).getByRole('radio', { name: 'Geçen' }));
    expect(JSON.parse(window.localStorage.getItem('remyral.logs.timestamps') ?? '{}')).toEqual({
      show: true,
      mode: 'elapsed',
    });
    await user.click(within(lv).getByRole('button', { name: 'Kopyala' }));
    expect(writeText).toHaveBeenCalledWith('satır 1\nsatır 2\nsatır 3');
  });

  it('SectionPage: a section without a screen gets the Diyalog placeholder; Home and Sohbet never', () => {
    const s = SECTIONS.find((x) => x.path === '/skills');
    if (s === undefined) throw new Error('no section');
    wrap(<DySectionPage section={s} />);
    expect(screen.getByRole('heading', { level: 1, name: s.title })).toBeTruthy();
    expect(screen.getByTestId('empty-state').textContent).toContain('Bu bölümün ekranı henüz hazır değil.');
    expect(matchSection('/')).toBeNull();
    expect(matchSection('/chat')).toBeNull();
    expect(matchSection('/nope')).toBeNull();
    expect(matchSection('/skills')).not.toBeNull();
  });

  it('Sohbet composer on phones: the keyboard inset follows the visual viewport (--dy-kb)', () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(keyboardInset(800, { height: 500, offsetTop: 300 })).toBe(0);
    expect(keyboardInset(800, { height: 820, offsetTop: 0 })).toBe(0);
    const listeners = new Map<string, () => void>();
    const vv = {
      height: 520,
      offsetTop: 0,
      addEventListener: (t: string, f: () => void) => listeners.set(t, f),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    vi.stubGlobal('visualViewport', vv);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    function Probe(props: { readonly on: boolean }): ReactNode {
      useKeyboardInset(props.on);
      return null;
    }
    const { rerender, unmount } = render(<Probe on />);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--dy-kb')).toBe('324px');
    vv.height = 844;
    act(() => {
      listeners.get('resize')?.();
    });
    expect(root.style.getPropertyValue('--dy-kb')).toBe('0px');
    rerender(<Probe on={false} />);
    expect(root.style.getPropertyValue('--dy-kb')).toBe('');
    unmount();
  });

  it('no Diyalog file renders a classic shared component', () => {
    const root = join(__dirname, '../src/diyalog');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(root);
    const banned =
      /from '(?:\.\.\/)+components\/(Pagination|Dialog|ReasonNotice|Actor|DataTable|Tabs|EmptyState|StateChip|FullAccessBadge|PriorityClassPicker|CopyButton|PageHeader)'/;
    const bannedUi =
      /import \{[^}]*\b(ApiErrorNotice|Notice|Spinner|Button|ButtonLink|Card|TextField)\b[^}]*\} from '(?:\.\.\/)+components\/ui'/;
    const offenders = files.filter((p) => {
      const src = readFileSync(p, 'utf8');
      return banned.test(src) || bannedUi.test(src);
    });
    expect(offenders).toEqual([]);
    // p15-classic-removal: no classic chrome is left in the shell at all.
    const shell = readFileSync(join(root, 'DiyalogShell.tsx'), 'utf8');
    expect(shell).not.toMatch(/components\/Dialog|shell\/AccountMenu|shell\/NotificationBell|ClassicFrame/);
    expect(readFileSync(join(root, 'TopTools.tsx'), 'utf8')).not.toMatch(/ServerClock/);
  });
});
