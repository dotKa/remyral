import { useErrorText } from '../../i18n/errors';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { searchMentions, type MentionItem } from '../../api/chat';
import { type EverywhereResult, searchEverywhere } from '../../api/chatKnowledge';
import { useAuth } from '../../auth/AuthProvider';
import { cx } from '../../components/ui';
import { mentionHref } from '../../screens/chat/MentionPicker';
import { fallbackText } from '../chat/MeaningResults';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon, type IconName } from '../icons';
import { useSettingsGroups } from '../screens/settings/SettingsFrame';
import { rank } from './match';
import { readRecent, rememberRecent } from './recent';
import { type PaletteIndex, type PaletteItem, palettePages, type SectionId, settingsPages } from './sources';

/**
 * p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.1): the command palette of the Diyalog shell — ⌘K / Ctrl+K, the
 * rail's "Ara" button (and the phone top-bar search). One field reaches every screen and tab, the caller's
 * conversations (pinned first), jobs (title, id prefix, state), approvals waiting, machines, projects, outputs,
 * automations, templates and the shell's actions; "Yapay zeka ile ara" searches by meaning through the existing
 * permission-checked search (`GET /chat/search/everywhere`), and "Asistana sor" opens a new Sohbet with the question.
 *
 * Instant by design: no open / close animation (keyboard, many times a day), the index is prefetched on idle, the
 * typed query is matched locally first (Turkish-aware fuzzy, `match.ts`) and the master's `@`-search fills in what
 * the snapshot does not hold. Combobox + grouped listbox ARIA, a result count for screen readers, native modal
 * `<dialog>` (focus trap, Escape closes, focus returns to where it was).
 */

export { ASK_STATE_KEY } from './opener';
import { ASK_STATE_KEY } from './opener';

import { FOCUS_COMPOSER_STATE } from '../ops/composerKeys';
import { altLabel } from '../../shell/keys';
import { NEW_JOB_LETTER } from '../../shell/shortcuts';

// p14-web-perf-2: the shortcut and its label live in ./shortcut (the shell loads this module lazily).
export { paletteKeyLabel, usePaletteShortcut } from './shortcut';

const MENTION_SECTION: Readonly<Record<string, SectionId>> = {
  project: 'projects',
  thread: 'chats',
  job: 'jobs',
  worker: 'machines',
  output: 'outputs',
  folder: 'outputs',
};
const MENTION_ICON: Readonly<Record<string, IconName>> = {
  project: 'folder',
  thread: 'bubble',
  job: 'jobs',
  worker: 'cpu',
  output: 'tray',
  folder: 'folder',
};
const MENTION_KEY: Readonly<Record<string, string>> = {
  project: 'project',
  thread: 'chat',
  job: 'job',
  worker: 'machine',
  output: 'output',
  folder: 'folder',
};

function fromMention(m: MentionItem): PaletteItem | null {
  const to = mentionHref(m);
  const section = MENTION_SECTION[m.type];
  if (to === null || section === undefined) return null;
  return {
    id: `${MENTION_KEY[m.type] ?? m.type}:${m.id}`,
    section,
    label: m.label,
    hint: m.detail ?? m.project ?? undefined,
    icon: MENTION_ICON[m.type] ?? 'search',
    to,
  };
}

const KIND_ICON: Readonly<Record<string, IconName>> = {
  own_chat: 'bubble',
  project_chat: 'msg',
  context_doc: 'brain',
  job_summary: 'jobs',
};

/** Section order with a query (empty query: recent, approvals, chats, actions, pages). */
const ORDER: readonly SectionId[] = [
  'actions',
  'pages',
  'chats',
  'approvals',
  'jobs',
  'machines',
  'projects',
  'outputs',
  'automations',
  'templates',
  'ai',
];
const PER_SECTION = 6;

interface Section {
  readonly id: SectionId;
  readonly items: readonly PaletteItem[];
  /** Matches in total (more than shown when capped). */
  readonly total: number;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => {
      setV(value);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [value, ms]);
  return v;
}

export function CommandPalette(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly index: PaletteIndex;
  readonly onHelp: () => void;
  readonly onAll: () => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT().palette;
  const opener = useRef<Element | null>(null);
  const { open, onClose } = props;
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      d.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
      const el = opener.current;
      opener.current = null;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={t.dialog}
      data-testid="dy-palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="dy-surface dy-palette mx-auto mt-[max(0.75rem,min(12vh,6rem),env(safe-area-inset-top))] mb-auto max-h-[min(36rem,calc(100dvh-1.5rem))] w-[min(40rem,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-[16px] border border-dy-line bg-dy-card p-0 text-dy-ink shadow-dy-pop backdrop:bg-dy-scrim"
    >
      {open ? <PaletteBody {...props} /> : null}
    </dialog>
  );
}

function PaletteBody(props: {
  readonly onClose: () => void;
  readonly index: PaletteIndex;
  readonly onHelp: () => void;
  readonly onAll: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const { onClose, onHelp, onAll, index } = props;
  const all = useT();
  const t = all.palette;
  const navigate = useNavigate();
  const { state: auth, actions: authActions } = useAuth();
  const userId = auth.kind === 'signedIn' ? auth.user.id : 'anonymous';
  const settings = useSettingsGroups();
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [ai, setAi] = useState(false);
  const [active, setActive] = useState(0);
  const query = q.trim();
  const recent = useMemo(() => readRecent(userId), [userId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The master's `@` search (projects, own conversations, outputs, jobs, machines, folders the caller may see).
  const remoteQ = useDebounced(query, 150);
  const [remote, setRemote] = useState<{ q: string; items: readonly PaletteItem[] }>({ q: '', items: [] });
  useEffect(() => {
    if (ai || remoteQ.length < 2) return;
    let live = true;
    searchMentions(remoteQ.slice(0, 100)).then(
      (list) => {
        if (live) setRemote({ q: remoteQ, items: list.flatMap((m) => fromMention(m) ?? []) });
      },
      () => undefined, // the local snapshot still answers
    );
    return () => {
      live = false;
    };
  }, [remoteQ, ai]);

  // Search with AI (meaning; keyword fallback) — only in that mode, from 3 characters, debounced.
  const aiQ = useDebounced(query, 400);
  const [found, setFound] = useState<{ q: string; result: EverywhereResult } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => {
    if (!ai || aiQ.length < 3) return;
    let live = true;
    setAiBusy(true);
    setAiError(null);
    searchEverywhere(aiQ.slice(0, 500)).then(
      (r) => {
        if (!live) return;
        setFound({ q: aiQ, result: r });
        setAiBusy(false);
      },
      (err: unknown) => {
        if (!live) return;
        setAiError(sayError(err));
        setAiBusy(false);
      },
    );
    return () => {
      live = false;
    };
  }, [ai, aiQ]);

  const actions = useMemo((): PaletteItem[] => {
    const a = (id: string, label: string, icon: IconName, keywords: string, hint?: string): PaletteItem => ({
      id: `action:${id}`,
      section: 'actions',
      label,
      icon,
      keywords,
      action: id,
      hint,
    });
    return [
      a('new-chat', t.action.newChat, 'bubble', 'new chat conversation yeni sohbet'), // i18n-ignore: search keywords
      a('new-job', t.action.newJob, 'plus', 'new job composer yeni iş formu', altLabel(NEW_JOB_LETTER)), // i18n-ignore: search keywords
      a('all', t.action.all, 'grid', 'all screens more tüm ekranlar'), // i18n-ignore: search keywords
      a('help', t.action.help, 'term', 'keyboard shortcuts help klavye kısayolları', '?'), // i18n-ignore: search keywords
      a('logout', t.action.logout, 'key', 'logout sign out çıkış yap'), // i18n-ignore: search keywords
    ];
  }, [t]);

  const basePages = useMemo(() => palettePages(all), [all]);
  const pages = useMemo(
    () => [...basePages, ...settingsPages(settings, all.nav.settings)],
    [basePages, settings, all],
  );

  const sections = useMemo((): Section[] => {
    const cap = (id: SectionId, list: readonly PaletteItem[], n = PER_SECTION): Section => ({
      id,
      items: list.slice(0, n),
      total: list.length,
    });
    if (ai) {
      const askItem: PaletteItem[] =
        query === ''
          ? []
          : [
              {
                id: 'ai:ask',
                section: 'ai',
                label: t.ai.ask({ query }),
                icon: 'send',
                action: 'ask',
                hint: t.ai.askHint,
              },
            ];
      const hits =
        found === null || found.q !== aiQ
          ? []
          : found.result.items.flatMap((h): PaletteItem[] => {
              const to = h.link ?? (h.project !== null ? `/projects/${encodeURIComponent(h.project)}` : null);
              if (to === null) return [];
              return [
                {
                  id: `ai:${h.kind}:${h.id}`,
                  section: 'ai',
                  label: h.title,
                  hint: [(t.aiKind as Readonly<Record<string, string>>)[h.kind], h.project, h.snippet]
                    .filter((x) => x !== null && x !== '')
                    .join(' · '),
                  icon: KIND_ICON[h.kind] ?? 'search',
                  to,
                  badge: h.match === 'semantic' ? t.ai.bySemantic : t.ai.byKeyword,
                },
              ];
            });
      return [{ id: 'ai', items: [...askItem, ...hits], total: hits.length }];
    }
    if (query === '') {
      const out: Section[] = [];
      if (recent.length > 0) out.push(cap('recent', recent, 5));
      if (index.approvals.length > 0) out.push(cap('approvals', index.approvals, 4));
      if (index.chats.length > 0) out.push(cap('chats', index.chats, 5));
      out.push(cap('actions', actions, actions.length));
      out.push(cap('pages', basePages, 8));
      return out;
    }
    const local: Record<SectionId, readonly PaletteItem[]> = {
      recent: [],
      actions,
      pages,
      chats: index.chats,
      approvals: index.approvals,
      jobs: index.jobs,
      machines: index.machines,
      projects: index.projects,
      outputs: [],
      automations: index.automations,
      templates: index.templates,
      ai: [],
    };
    const fromServer = remote.q !== '' && query.startsWith(remote.q) ? remote.items : [];
    const out: Section[] = [];
    for (const id of ORDER) {
      if (id === 'ai') {
        out.push({
          id: 'ai',
          total: 0,
          items: [
            {
              id: 'ai:search',
              section: 'ai',
              label: t.ai.search({ query }),
              icon: 'brain',
              action: 'ai-mode',
              hint: t.ai.searchHint,
            },
            {
              id: 'ai:ask',
              section: 'ai',
              label: t.ai.ask({ query }),
              icon: 'send',
              action: 'ask',
              hint: t.ai.askHint,
            },
          ],
        });
        continue;
      }
      const ranked = rank(
        query,
        local[id],
        (i) => `${i.label} ${i.hint ?? ''}`,
        (i) => i.keywords ?? '',
      );
      const seen = new Set(ranked.map((i) => i.id));
      const extra = fromServer.filter((i) => i.section === id && !seen.has(i.id));
      const all = [...ranked, ...extra];
      if (all.length > 0) out.push(cap(id, all));
    }
    return out;
  }, [ai, query, found, aiQ, recent, index, actions, pages, basePages, remote, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const total = sections.reduce((n, s) => n + (s.id === 'ai' && !ai ? 0 : s.total), 0);
  const current = Math.min(active, Math.max(flat.length - 1, 0));
  useEffect(() => {
    setActive(0);
  }, [query, ai]);
  const optionId = (i: number): string => `${baseId}-o${String(i)}`;
  useEffect(() => {
    // jsdom has no scrollIntoView: typed as optional here.
    const el: { scrollIntoView?: (o: ScrollIntoViewOptions) => void } | null = document.getElementById(
      `${baseId}-o${String(current)}`,
    );
    if (el !== null && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [current, flat, baseId]);

  const go = useCallback(
    (to: string, state?: Record<string, unknown>) => {
      onClose();
      void navigate(to, state === undefined ? undefined : { state });
    },
    [navigate, onClose],
  );

  const choose = (item: PaletteItem | undefined): void => {
    if (item === undefined) return;
    if (item.to !== undefined) {
      rememberRecent(userId, item);
      go(item.to);
      return;
    }
    switch (item.action) {
      case 'new-chat':
        // p17-toasts-shortcuts: an explicit "Yeni sohbet" — the caret goes to the composer.
        go('/chat?yeni=1', { [FOCUS_COMPOSER_STATE]: true });
        return;
      case 'new-job':
        go('/jobs/new');
        return;
      case 'all':
        onClose();
        onAll();
        return;
      case 'help':
        onClose();
        onHelp();
        return;
      case 'logout':
        onClose();
        void authActions.logout().catch(() => undefined);
        return;
      case 'ai-mode':
        setAi(true);
        inputRef.current?.focus();
        return;
      case 'ask':
        if (query !== '') go('/chat?yeni=1', { [ASK_STATE_KEY]: query.slice(0, 4000) });
        return;
      default:
        return;
    }
  };

  const sectionStarts = useMemo(() => {
    const starts: number[] = [];
    let n = 0;
    for (const s of sections) {
      starts.push(n);
      n += s.items.length;
    }
    return starts;
  }, [sections]);

  function onKey(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + d + flat.length) % flat.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[current]);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (sectionStarts.length === 0) return;
      const at = sectionStarts.reduce((k, s, i) => (s <= current ? i : k), 0);
      const n = sectionStarts.length;
      const next = e.shiftKey ? (at - 1 + n) % n : (at + 1) % n;
      setActive(sectionStarts[next] ?? 0);
      return;
    }
    if (e.key === 'Backspace' && q === '' && ai) {
      e.preventDefault();
      setAi(false);
    }
  }

  const status = ai
    ? query.length < 3
      ? t.ai.minChars
      : aiBusy
        ? t.ai.busy
        : aiError !== null
          ? t.ai.failed({ reason: aiError })
          : found !== null && found.q === aiQ
            ? t.ai.resultCount({ n: total, keyword: found.result.mode === 'keyword' })
            : ''
    : query === ''
      ? ''
      : t.resultCount({ n: total });

  let n = -1;
  return (
    <div className="flex max-h-[inherit] flex-col">
      <div className="flex items-center gap-2 border-b border-dy-line px-3 py-2">
        <DyIcon name={ai ? 'brain' : 'search'} className="size-[18px] shrink-0 text-dy-muted" />
        {ai ? (
          <span className="shrink-0 rounded-full bg-dy-violet-soft px-2 py-0.5 text-[0.75rem] font-bold text-dy-violet">
            {t.ai.badge}
          </span>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={flat.length > 0 ? optionId(current) : undefined}
          aria-label={ai ? t.ai.toggle : t.inputLabel}
          aria-describedby={`${baseId}-status`}
          placeholder={ai ? t.ai.placeholder : t.placeholder}
          value={q}
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
          }}
          onKeyDown={onKey}
          data-testid="dy-palette-input"
          className="h-11 min-w-0 flex-1 border-0 bg-transparent text-base text-dy-ink outline-none placeholder:text-dy-faint"
        />
        <button
          type="button"
          aria-pressed={ai}
          onClick={() => {
            setAi((v) => !v);
            inputRef.current?.focus();
          }}
          title={t.ai.toggleTitle}
          data-testid="dy-palette-ai"
          className={cx(
            'dy-press inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[0.78125rem] font-bold',
            ai
              ? 'bg-dy-violet-soft text-dy-violet'
              : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
          )}
        >
          <DyIcon name="brain" className="size-4" />
          <span className="hidden sm:inline">{t.ai.toggle}</span>
          <span className="sm:hidden">{t.ai.toggleShort}</span>
        </button>
      </div>
      <p id={`${baseId}-status`} role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      <div
        ref={listRef}
        id={`${baseId}-list`}
        role="listbox"
        aria-label={ai ? t.ai.results : t.results}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
      >
        {sections.map((s) => (
          <div key={s.id} role="group" aria-label={t.section[s.id]} className="mb-1">
            <div
              aria-hidden="true"
              className="flex items-baseline justify-between px-2.5 pt-2 pb-1 text-[0.75rem] font-bold tracking-[0.02em] text-dy-faint uppercase"
            >
              <span>{t.section[s.id]}</span>
              {s.total > 0 && (query !== '' || s.id === 'ai') ? (
                <span className="font-dy-mono font-medium tabular-nums normal-case">
                  {s.total > s.items.length
                    ? `${String(s.items.length)} / ${String(s.total)}`
                    : String(s.total)}
                </span>
              ) : null}
            </div>
            {s.items.map((item) => {
              n += 1;
              const i = n;
              const on = i === current;
              return (
                <div
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={on}
                  data-section={s.id}
                  onMouseMove={() => {
                    if (!on) setActive(i);
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={() => {
                    choose(item);
                  }}
                  className={cx(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-1.5 sm:min-h-10',
                    on && 'bg-dy-sunk',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      'grid size-7 shrink-0 place-items-center rounded-[8px]',
                      on ? 'bg-dy-card text-dy-teal-ink shadow-dy' : 'text-dy-muted',
                    )}
                  >
                    <DyIcon name={item.icon} className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[0.875rem] font-medium">{item.label}</span>
                    {item.hint === undefined ? null : (
                      <span className="truncate text-[0.75rem] text-dy-muted">{item.hint}</span>
                    )}
                  </span>
                  {item.badge === undefined ? null : (
                    <span
                      className={cx(
                        'shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-bold',
                        item.badge === t.ai.bySemantic
                          ? 'bg-dy-violet-soft text-dy-violet'
                          : 'bg-dy-sunk text-dy-muted',
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                  {on ? (
                    <kbd
                      aria-hidden="true"
                      className="hidden font-dy-mono text-[0.75rem] text-dy-faint sm:inline"
                    >
                      ↵
                    </kbd>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {!ai && query !== '' && total === 0 ? (
          <p className="m-0 px-2.5 py-3 text-[0.84375rem] text-dy-muted" data-testid="dy-palette-empty">
            {t.empty({ query })}
          </p>
        ) : null}
        {ai ? (
          <p className="m-0 px-2.5 py-2 text-[0.78125rem] text-dy-faint" data-testid="dy-palette-ai-status">
            {status}
            {found !== null && found.q === aiQ && found.result.fallbackReason !== null
              ? ` — ${fallbackText(all, found.result.fallbackReason)}.`
              : ''}
          </p>
        ) : null}
      </div>
      <div className="hidden items-center gap-4 border-t border-dy-line px-3 py-2 text-[0.75rem] text-dy-faint sm:flex">
        <span>
          <kbd className="font-dy-mono">↑↓</kbd> {t.keys.move}
        </span>
        <span>
          <kbd className="font-dy-mono">↵</kbd> {t.keys.open}
        </span>
        <span>
          <kbd className="font-dy-mono">Tab</kbd> {t.keys.section}
          {/* i18n-ignore: key name */}
        </span>
        <span>
          <kbd className="font-dy-mono">Esc</kbd> {t.keys.close}
          {/* i18n-ignore: key name */}
        </span>
        <span className="ml-auto">{t.visibleOnly}</span>
      </div>
    </div>
  );
}
