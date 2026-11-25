import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isMentionType,
  type MentionItem,
  type MentionRef,
  type MentionType,
  searchMentions,
  UUID_RE,
} from '../../api/chat';
import { findTokens, liveMentions, tokenAt, tokenLabel, type TokenRange } from './mentionText';
import { codeMentionHref } from '../../diyalog/code/refs';

/**
 * `@` mentions in the ops chat (p8-chat-attachments-mentions): typing `@` at the start of a word opens a picker of
 * projects, the caller's conversations, Outputs items, jobs, machines and own folders (searched by the master as the caller); a
 * pick inserts `@label` and keeps a structured ref {type, id, project}. The master resolves each ref again, as the
 * sender, when the message is sent — the label is only for display.
 *
 * p12-mention-badges: a picked `@label` is one unit in the field — Backspace / Delete remove the whole token (and its
 * ref), ← / → step over it, the refs mirror the tokens left in the text (an edited token drops its ref) and removing a
 * chip removes its token. Copy and paste carry the readable `@label` text; pasted text never makes a ref.
 */

export const MAX_MENTIONS = 8;
const DEBOUNCE_MS = 150;

export interface PickedMention extends MentionRef {
  readonly label: string;
}

/** The `@query` the caret is in (start index of the `@` and the query), or null. */
export function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (m === null) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query };
}

const SAFE_ID = /^[A-Za-z0-9_.:+-]{1,320}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Console link of a mention target, or null for anything that does not look like a valid id. */
export function mentionHref(m: { type: string; id: string; project?: string | null }): string | null {
  const e = encodeURIComponent;
  switch (m.type) {
    case 'project':
      return PROJECT_ID.test(m.id) ? `/projects/${e(m.id)}` : null;
    case 'thread':
      return UUID_RE.test(m.id) ? `/chat/${m.id}` : null;
    case 'job':
      return UUID_RE.test(m.id) ? `/jobs/${m.id}` : null;
    case 'worker':
      return SAFE_ID.test(m.id) ? `/machines/${e(m.id)}` : null;
    case 'output':
      if (!SAFE_ID.test(m.id)) return null;
      return `/outputs?${new URLSearchParams({
        ...(typeof m.project === 'string' && PROJECT_ID.test(m.project) ? { project: m.project } : {}),
        item: m.id,
      }).toString()}`;
    // p8-outputs-folders: an own folder opens on Outputs.
    case 'folder':
      return UUID_RE.test(m.id) ? `/outputs?folder=${m.id}` : null;
    // p15-chat-vault: a vault credential opens in Settings → Credentials (metadata only).
    case 'credential':
      return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(m.id) ? `/settings/credentials#credential-${m.id}` : null;
    // p19-ide W1: a code reference opens the viewer at its file and lines.
    case 'code':
      return codeMentionHref(m.id, m.project);
    default:
      return null;
  }
}

/** `meta.mentions` of a user message (malformed entries skipped). */
export function metaMentions(
  meta: Record<string, unknown> | null,
): { type: MentionType; id: string; project: string | null; label: string }[] {
  const raw = meta?.mentions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (x === null || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    if (!isMentionType(o.type) || typeof o.id !== 'string' || o.id.length > 320) return [];
    return [
      {
        type: o.type,
        id: o.id,
        project: typeof o.project === 'string' ? o.project : null,
        label: typeof o.label === 'string' && o.label !== '' ? o.label.slice(0, 120) : o.id.slice(0, 40),
      },
    ];
  });
}

/**
 * The picker state for a textarea: the active `@query`, the results (debounced search), the highlighted entry,
 * the keyboard handling and the picked refs.
 */
export function useMentions(opts: {
  readonly enabled: boolean;
  readonly text: string;
  readonly setText: (t: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
}): {
  readonly open: boolean;
  readonly items: readonly MentionItem[];
  readonly active: number;
  readonly loading: boolean;
  readonly listId: string;
  readonly optionId: (i: number) => string;
  readonly picked: readonly PickedMention[];
  /** Where the picked mentions' `@label` tokens sit in the text (the field's highlight). */
  readonly tokens: readonly TokenRange<PickedMention>[];
  /** Call on input / caret moves. */
  readonly sync: () => void;
  /** True when the key was handled by the picker. */
  readonly onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly pick: (item: MentionItem) => void;
  readonly remove: (m: PickedMention) => void;
  readonly close: () => void;
  /** Hides the picker without dismissing the `@` (blur). */
  readonly hide: () => void;
  readonly clear: () => void;
  readonly setActive: (i: number) => void;
} {
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const { enabled, text, setText, inputRef } = opts;
  const seq = useRef(0);
  // The refs mirror the tokens left in the text; a removed or edited token drops its ref for good.
  const live = useMemo(() => liveMentions(text, picked), [text, picked]);
  const tokens = useMemo(() => findTokens(text, live), [text, live]);
  useEffect(() => {
    if (live.length !== picked.length) setPicked(live);
  }, [live, picked.length]);

  const setCaretSoon = useCallback(
    (caret: number) => {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el === null) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [inputRef],
  );

  const sync = useCallback(() => {
    const el = inputRef.current;
    if (!enabled || el === null) {
      setQuery(null);
      return;
    }
    const q = activeQuery(el.value, el.selectionStart);
    // The caret at the end of a picked token is not a new `@query`.
    if (q !== null && findTokens(el.value, live).some((t) => t.start === q.start)) {
      setQuery(null);
      return;
    }
    if (q !== null && q.start === dismissedAt) {
      setQuery(null);
      return;
    }
    if (q === null) setDismissedAt(null);
    setQuery((cur) => (cur?.start === q?.start && cur?.query === q?.query ? cur : q));
  }, [enabled, inputRef, dismissedAt, live]);

  const q = query?.query ?? null;
  useEffect(() => {
    if (q === null) {
      setItems([]);
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      searchMentions(q).then(
        (r) => {
          if (seq.current !== id) return;
          setItems(r.slice(0, 20));
          setActive(0);
          setLoading(false);
        },
        () => {
          if (seq.current !== id) return;
          setItems([]);
          setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [q]);

  const close = useCallback(() => {
    if (query !== null) setDismissedAt(query.start);
    setQuery(null);
  }, [query]);

  const pick = useCallback(
    (item: MentionItem) => {
      if (query === null) return;
      const label = tokenLabel(item.label) || item.id.slice(0, 40);
      const end = query.start + 1 + query.query.length;
      const next = `${text.slice(0, query.start)}@${label} ${text.slice(end)}`;
      setText(next);
      setPicked((list) =>
        list.some((m) => m.type === item.type && m.id === item.id) || list.length >= MAX_MENTIONS
          ? list
          : [
              ...list,
              {
                type: item.type,
                id: item.id,
                ...(item.project === null ? {} : { project: item.project }),
                label,
              },
            ],
      );
      setQuery(null);
      const caret = query.start + label.length + 2;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el === null) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [query, text, setText, inputRef],
  );

  /** p12-mention-badges: Backspace / Delete / ← / → on a picked token act on it as one unit. */
  const atomicKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const key = e.key;
      if (key !== 'Backspace' && key !== 'Delete' && key !== 'ArrowLeft' && key !== 'ArrowRight')
        return false;
      // IME composition (Turkish, CJK…) and modified keys (word / line moves, selections) stay the browser's.
      if (e.nativeEvent.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
      const el = inputRef.current;
      if (el === null || el.selectionStart !== el.selectionEnd) return false;
      const r = tokenAt(tokens, el.selectionStart, key);
      if (r === null) return false;
      e.preventDefault();
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const at = key === 'ArrowLeft' ? r.start : r.end;
        el.setSelectionRange(at, at);
        return true;
      }
      setText(`${text.slice(0, r.start)}${text.slice(r.end)}`);
      setQuery(null);
      setCaretSoon(r.start);
      return true;
    },
    [inputRef, tokens, text, setText, setCaretSoon],
  );

  const open = query !== null;
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (atomicKey(e)) return true;
      if (query === null) return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return true;
      }
      if (items.length === 0) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
        const item = items[active];
        if (item === undefined) return false;
        e.preventDefault();
        pick(item);
        return true;
      }
      return false;
    },
    [query, items, active, close, pick, atomicKey],
  );

  return {
    open,
    items,
    active,
    loading,
    listId,
    optionId: (i) => `${listId}-o${String(i)}`,
    picked: live,
    tokens,
    sync,
    onKeyDown,
    pick,
    // Removing a chip removes its token (and one space after it) from the text too.
    remove: (m) => {
      setPicked((list) => list.filter((x) => !(x.type === m.type && x.id === m.id)));
      const r = tokens.find((t) => t.mention.type === m.type && t.mention.id === m.id);
      if (r === undefined) return;
      const end = text.charAt(r.end) === ' ' ? r.end + 1 : r.end;
      setText(`${text.slice(0, r.start)}${text.slice(end)}`);
      setCaretSoon(r.start);
    },
    close,
    hide: () => {
      setQuery(null);
    },
    clear: () => {
      setPicked([]);
      setQuery(null);
    },
    setActive,
  };
}
