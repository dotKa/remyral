import type { Messages } from '@remyral/i18n';
import { useErrorText } from '../../i18n/errors';
import { useLocale, useT } from '../../i18n/I18nProvider';
import { fill } from '@remyral/i18n';
import { useDictation } from './dictation';
import { useScrollEdges } from '../scrollEdges';
import { type FocusRequest, useComposerFocus, useDictationShortcut, useDockHeight } from './composerKeys';
import { altAria, altLabel } from '../../shell/keys';
import { DICTATION_LETTER } from '../../shell/shortcuts';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ChatInput, SendExtras } from '../../api/chat';
import { listTemplates, type Template } from '../../api/templates';
import { cx } from '../../components/ui';
import { ACCEPT } from '../../screens/chat/attachment-files';
import { AttachmentTray } from '../../screens/chat/Attachments';
import { type PickedMention, MAX_MENTIONS, useMentions } from '../../screens/chat/MentionPicker';
import {
  clearPendingCodeRefs,
  codeRefId,
  codeRefLabel,
  removePendingCodeRef,
  usePendingCodeRefs,
} from '../code/refs';
import type { TokenRange } from '../../screens/chat/mentionText';
import { MentionIcon } from '../chat/MentionBadge';
import { inputAllows, useAttachments, zipExtras } from '../../screens/chat/useAttachments';
import {
  expandSlash,
  matchCommands,
  planCommand,
  planSlashCommand,
  SLASH_COMMANDS,
  type SlashCommand,
  slashQuery,
} from '../compose/slash';
import { usePhoneSheet, useRoomAbove } from '../floating';
import { useShake } from '../codeMotion';
import { Swap } from '../motionKit';
import { DyIcon } from '../icons';
import { credentialToken, pastedSecretToken, suggestCredentialName } from '@remyral/protocol/chat-secrets';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { forgetSecret, type PastedSecret, protectText } from '../vault/pastedSecrets';
import { SaveSecretPanel } from '../vault/SaveSecretPanel';

/**
 * p12-diyalog: the home composer — writes to the ops chat (Faz 1). Enter sends, Shift+Enter starts a new line; the
 * field grows with the text up to a few lines. What the assistant drafts from it arrives in the thread as a card to
 * confirm; nothing runs without that confirmation.
 *
 * Faz 3 (docs/design/p12-diyalog.md §11.3): slash commands (`/iş`, `/yayınla`, `/onaylar`, `/limitler`, `/makine`,
 * `/iptal`, `/yeniden`) from a list that opens on `/` at the start of the field and from a row of quick chips; `@`
 * mentions of projects, jobs, machines, outputs and folders (the chat's own picker data, `GET /chat/mentions`; the
 * master resolves each again as the sender); "Şablondan" picks a saved template. On sending, a command becomes the
 * person's words plus one intent line the assistant understands (compose/slash.ts) — no new tool, no new rights.
 * Parity with the chat screen's composer: files by the attach button (camera on phones), paste and drag-and-drop
 * (uploaded to the conversation at once, the chat's own tray), and Stop while the assistant answers.
 */

function ClipIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />
    </svg>
  );
}

/** p16-chat-complete: the dictation button's microphone. */
function MicIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

function CameraIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export interface ComposerSeed {
  readonly text: string;
  /** Changes every time the same seed is asked for again. */
  readonly n: number;
}

/** The quick chips: every slash command with its short label. */
function quickChips(
  w: Messages['home']['composer']['quick'],
): readonly { readonly cmd: SlashCommand; readonly label: string }[] {
  const label = (name: string): string => {
    switch (name) {
      case '/iş':
        return w.newJob;
      case '/yayınla':
        return w.publish;
      case '/onaylar':
        return w.approvals;
      case '/limitler':
        return w.limits;
      case '/makine':
        return w.machine;
      case '/iptal':
        return w.cancel;
      default:
        return w.retry;
    }
  };
  return SLASH_COMMANDS.map((c) => ({ cmd: c, label: label(c.name) }));
}

function Kbd(props: { readonly children: ReactNode }): ReactNode {
  return <kbd className="rounded border border-dy-line-2 px-1 font-dy-mono">{props.children}</kbd>;
}

/** Saved templates for "Şablondan" (read when the picker opens). */
function TemplatePicker(props: {
  readonly onPick: (t: Template) => void;
  readonly onClose: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const w = useT().home.composer;
  const [items, setItems] = useState<Template[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    listTemplates({ state: 'active' }).then(
      (t) => {
        if (live) setItems(t);
      },
      (err: unknown) => {
        if (live) setFailed(sayError(err));
      },
    );
    searchRef.current?.focus();
    return () => {
      live = false;
    };
  }, []);
  const shown = (items ?? [])
    .filter((t) =>
      `${t.title} ${t.description} ${t.tags.join(' ')}`
        .toLocaleLowerCase('tr')
        .includes(q.toLocaleLowerCase('tr')),
    )
    .slice(0, 12);
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    } else if (e.key === 'ArrowDown' && shown.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % shown.length);
    } else if (e.key === 'ArrowUp' && shown.length > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = shown[active];
      if (t !== undefined) props.onPick(t);
    }
  };
  return (
    <div
      className="absolute right-0 bottom-full left-0 z-20 mb-2 rounded-xl border border-dy-line-2 bg-dy-card p-1.5 shadow-dy-pop"
      data-testid="dy-template-picker"
    >
      <input
        ref={searchRef}
        type="search"
        value={q}
        placeholder={w.templateSearch}
        aria-label={w.templateSearchLabel}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[active] === undefined ? undefined : `${listId}-${String(active)}`}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
        className="mb-1 w-full rounded-lg border border-dy-line-2 bg-dy-card px-2.5 py-1.5 text-base outline-none focus:border-dy-teal sm:text-sm"
      />
      {failed !== null ? (
        <p role="alert" className="m-0 px-2.5 py-2 text-[0.8125rem] text-dy-red-ink">
          {w.templatesError({ error: failed })}
        </p>
      ) : items === null ? (
        <p role="status" className="m-0 px-2.5 py-2 text-[0.8125rem] text-dy-muted">
          {w.templatesLoading}
        </p>
      ) : shown.length === 0 ? (
        <p role="status" className="m-0 px-2.5 py-2 text-[0.8125rem] text-dy-muted">
          {items.length === 0 ? w.noTemplates : w.noMatchingTemplates}
        </p>
      ) : (
        <ul
          id={listId}
          role="listbox"
          aria-label={w.templates}
          className="m-0 max-h-64 list-none overflow-y-auto p-0"
        >
          {shown.map((t, i) => (
            <li
              key={t.id}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onMouseEnter={() => {
                setActive(i);
              }}
              onClick={() => {
                props.onPick(t);
              }}
              className={cx(
                'grid cursor-pointer gap-0.5 rounded-lg px-2.5 py-[7px] text-sm',
                i === active && 'bg-dy-sunk',
              )}
            >
              <span className="font-bold">{t.title}</span>
              <span className="truncate text-[0.78125rem] text-dy-muted">
                {[t.project ?? w.allProjects, t.description].filter((x) => x !== '').join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * p12-mention-badges: the picked tokens tinted under the (transparent-background) field. The textarea stays the only
 * editor — IME, Turkish keyboards, mobile selection and undo stay the browser's; this layer only paints, with the
 * field's own font, padding and wrapping, and follows its scroll.
 */
function TokenHighlight(props: {
  readonly text: string;
  readonly tokens: readonly TokenRange<PickedMention>[];
  readonly layerRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  props.tokens.forEach((t, i) => {
    if (t.start > last) parts.push(props.text.slice(last, t.start));
    parts.push(
      <mark key={String(i)} className="dy-mention-mark" data-mention={t.mention.type}>
        {props.text.slice(t.start, t.end)}
      </mark>,
    );
    last = t.end;
  });
  parts.push(`${props.text.slice(last)} `);
  return (
    <div
      ref={props.layerRef}
      aria-hidden="true"
      data-testid="dy-mention-highlight"
      className="pointer-events-none absolute inset-0 overflow-hidden py-1.5 text-base leading-[1.45] [overflow-wrap:break-word] whitespace-pre-wrap text-transparent sm:text-[0.9375rem]"
    >
      {parts}
    </div>
  );
}

export function Composer(props: {
  readonly onSend: (text: string, extras?: SendExtras) => Promise<void>;
  /** The assistant is answering: sending waits for it (the master runs one turn at a time). */
  readonly busy?: boolean | undefined;
  /**
   * p22-chat-queue: while `busy`, a message is still sent — the master queues it for the next turn (the send button
   * says so). Absent: sending is blocked while busy.
   */
  readonly queue?: boolean | undefined;
  /** Puts this text in the field and focuses it ("Yeni iş" → `/iş `). */
  readonly seed?: ComposerSeed | null | undefined;
  /** What the engine takes besides text (null / absent: text only, no mentions — an older master). */
  readonly input?: ChatInput | null | undefined;
  /** The conversation to upload files into (created on demand); absent: no attachments. */
  readonly ensureThread?: (() => Promise<string>) | undefined;
  /** Stops the answer being written. */
  readonly onStop?: (() => void) | undefined;
  /**
   * p12-diyalog-w4: nothing can be written (an archived conversation, the assistant unavailable) — the field, the
   * chips and the buttons are disabled; `placeholder` says why.
   */
  readonly disabled?: boolean | undefined;
  readonly placeholder?: string | undefined;
  /** p16-chat-complete: the conversation's own project — a dropped .zip defaults to it. */
  readonly threadProject?: string | null | undefined;
  /**
   * p17-toasts-shortcuts: put the caret here for this navigation (the chat screen opened, a conversation opened,
   * "Yeni sohbet") — on desktop always, on touch only for an explicit "Yeni sohbet" (composerKeys.ts).
   */
  readonly focusRequest?: FocusRequest | undefined;
  /**
   * p18-plan-mode: plan mode of the conversation — the "Planla" chip, `/plan <metin>`, the violet edge and its line with
   * ✕. `ready` false: the answering machine lacks the plan tools (the chip says so, disabled). Absent: no plan mode.
   */
  readonly plan?:
    | {
        readonly on: boolean;
        readonly ready: boolean;
        readonly onToggle: (on: boolean) => Promise<void>;
      }
    | undefined;
  /** p18-plan-mode: what sits right above the composer (the phone's plan pill). */
  readonly top?: ReactNode;
  /**
   * p20-quick: the security policy lets the assistant act directly — the placeholder and the
   * hint say what happens to a request (a card / runs at once); null / absent: unknown, they promise neither.
   */
  readonly direct?: boolean | null | undefined;
}): ReactNode {
  const sayError = useErrorText();
  const all = useT();
  const { locale } = useLocale();
  const w = all.home.composer;
  const direct = props.direct ?? null;
  const fullPlaceholder =
    direct === null ? w.placeholderUnknown : direct ? w.placeholderDirect : w.placeholder;
  const decisionsHint =
    direct === null ? w.decisionsHintUnknown : direct ? w.decisionsHintDirect : w.decisionsHint;
  // p17-ui-polish: next to the attach / microphone buttons a phone fits a short placeholder on one line.
  const phone = usePhoneSheet();
  const mentionTypes = all.chat.mention.types;
  const quick = quickChips(w.quick);
  const locked = props.disabled === true;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // p17-chat-send-motion: a failed send shakes the box once (the text stays); a sent one brings the empty field up.
  const failShake = useShake();
  const sentPulse = useShake();
  const [caret, setCaret] = useState(0);
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [template, setTemplate] = useState<{ id: string; title: string } | null>(null);
  const [picker, setPicker] = useState(false);
  // p15-chat-vault: secrets pasted into the field (their values only in this tab's memory; the field has tokens).
  const [secrets, setSecrets] = useState<readonly PastedSecret[]>([]);
  const [savingSecret, setSavingSecret] = useState<string | null>(null);
  const [subscriptionRemoved, setSubscriptionRemoved] = useState(false);
  const authState = useOptionalAuth()?.state;
  const vaultAdmin =
    authState?.kind === 'signedIn' && (authState.user.role === 'owner' || authState.user.role === 'admin');
  const tv = all.chatVault;
  const ref = useRef<HTMLTextAreaElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const errId = useId();
  const slashId = useId();
  const mentions = useMentions({
    enabled: props.input !== null && props.input !== undefined,
    text,
    setText,
    inputRef: ref,
  });
  // p19-ide W1: code references collected with "Sohbete ekle" (code viewer / diff); sent as `code` mentions.
  const pendingCode = usePendingCodeRefs();
  const codeChips = props.input === null || props.input === undefined ? [] : pendingCode;
  const fileRef = useRef<HTMLInputElement>(null);
  // p12-diyalog-cmdk: the upward pickers never run off the top of the visible viewport (keyboard included).
  const pickerAnchor = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const allow = inputAllows(props.input);
  const canAttach = allow.any && props.ensureThread !== undefined && !locked;
  const att = useAttachments({
    ensureThread: props.ensureThread,
    input: props.input,
    threadProject: props.threadProject ?? null,
  });
  // p16-chat-complete: dictation through the browser's own speech recognition (no button where it is missing).
  const tv2 = all.chatComplete.voice;
  const dictation = useDictation({
    lang: locale === 'en' ? 'en-US' : 'tr-TR',
    base: () => text,
    onText: (next) => {
      setText(next.slice(0, 8000));
    },
  });
  // p17-toasts-shortcuts: Option / Alt + D toggles dictation; the caret on arrival; the dock's height for the toasts.
  useDictationShortcut(ref, dictation, dictation.supported && !locked);
  useComposerFocus(ref, props.focusRequest, locked);
  const dockRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  useScrollEdges(quickRef);
  useDockHeight(dockRef);
  const micKeys = altLabel(DICTATION_LETTER);
  const hasFiles = att.readyIds.length > 0 || att.zips.items.length > 0;
  const addFiles = (files: readonly File[]): void => {
    if (files.length > 0 && canAttach) att.add(files);
  };

  // Grow with the content (no layout animation; height set before paint). p22-classic-removal §4: an empty field is
  // measured with its placeholder, and again when the field's width changes — a placeholder that wraps (a narrower
  // column, the details panel opening, the longer "direct" wording arriving) was cut in half by a one-line field.
  const placeholderText = props.placeholder ?? (phone ? w.placeholderShort : fullPlaceholder);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const fit = (): void => {
      el.style.height = 'auto';
      let h = el.scrollHeight;
      if (el.value === '' && el.placeholder !== '') {
        el.value = el.placeholder;
        h = el.scrollHeight;
        el.value = '';
      }
      el.style.height = `${String(Math.min(h, 168))}px`;
    };
    fit();
    if (typeof ResizeObserver !== 'function') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [text, placeholderText]);

  const seed = props.seed;
  useEffect(() => {
    if (seed === null || seed === undefined) return;
    setText(seed.text);
    setError(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
      setCaret(seed.text.length);
    });
  }, [seed]);

  const q = slashClosed ? null : slashQuery(text, caret);
  const tp = all.plan;
  const plan = props.plan;
  const commands =
    q === null
      ? []
      : matchCommands(
          q,
          plan === undefined ? SLASH_COMMANDS : [planSlashCommand(tp.mode.slashHint), ...SLASH_COMMANDS],
        );
  const [planError, setPlanError] = useState<string | null>(null);
  const togglePlan = (on: boolean): void => {
    if (plan === undefined) return;
    setPlanError(null);
    plan.onToggle(on).catch((err: unknown) => {
      setPlanError(tp.mode.failed({ error: sayError(err) }));
    });
  };
  const slashOpen = commands.length > 0 && !mentions.open;
  const pickerRoom = useRoomAbove(slashOpen || mentions.open, pickerAnchor);
  // p22-chat-queue: a queueing composer keeps sending while the assistant answers.
  const queueing = props.busy === true && props.queue === true;
  const blocked = sending || (props.busy === true && !queueing) || locked;

  function insertCommand(c: SlashCommand): void {
    const rest = text.replace(/^\/\S*\s?/, '');
    const next = `${c.name} ${rest}`;
    setText(next);
    setSlashClosed(true);
    setError(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }

  /** p15-chat-vault: the pasted secrets whose token is still in the field. */
  const liveSecrets = secrets.filter((x) => text.includes(pastedSecretToken(x.handle, x.provider)));

  function insertAtCaret(insert: string): void {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      const f = ref.current;
      if (f === null) return;
      f.focus();
      f.setSelectionRange(start + insert.length, start + insert.length);
      setCaret(start + insert.length);
    });
  }

  function addSecrets(found: readonly PastedSecret[]): void {
    if (found.length === 0) return;
    setSecrets((prev) => [...prev, ...found.filter((f) => !prev.some((p) => p.handle === f.handle))]);
  }

  function secretSaved(s: PastedSecret, name: string): void {
    setText((cur) => cur.split(pastedSecretToken(s.handle, s.provider)).join(credentialToken(name)));
    forgetSecret(s.handle);
    setSecrets((prev) => prev.filter((p) => p.handle !== s.handle));
    setSavingSecret(null);
  }

  function removeSecret(s: PastedSecret): void {
    setText((cur) => cur.split(pastedSecretToken(s.handle, s.provider)).join(''));
    setSecrets((prev) => prev.filter((p) => p.handle !== s.handle));
    if (savingSecret === s.handle) setSavingSecret(null);
  }

  async function send(): Promise<void> {
    if (blocked || att.busy) return;
    if (text.trim() === '' && template === null && !hasFiles) return;
    // p15-chat-vault: a typed (not pasted) secret is replaced too — nothing secret-looking leaves this page.
    const guarded = protectText(text);
    addSecrets(guarded.secrets);
    const safe = guarded.text;
    // p18-plan-mode: `/plan <metin>` turns plan mode on and sends the words; `/plan` alone switches the mode.
    const planCmd = plan === undefined ? null : planCommand(safe);
    if (planCmd !== null && plan !== undefined) {
      if (!plan.ready) {
        setError(tp.mode.unavailable);
        return;
      }
      if (planCmd.arg === '' && !hasFiles) {
        togglePlan(!plan.on);
        setText('');
        return;
      }
    }
    const out =
      planCmd !== null
        ? { ok: true as const, text: planCmd.arg }
        : safe.trim() === '' && template === null
          ? { ok: true as const, text: '' }
          : expandSlash(safe, template);
    if (!out.ok) {
      setError(out.message);
      return;
    }
    setSending(true);
    setError(null);
    try {
      // p15-chat-zip: sites are uploaded first (progress on their chips); a failure keeps everything for a retry.
      const zip = await zipExtras(att.zips);
      if (zip === null) return;
      const refs = [
        ...mentions.picked.map((m) => ({
          type: m.type,
          id: m.id,
          ...(m.project === undefined ? {} : { project: m.project }),
        })),
        ...codeChips.map((r) => ({ type: 'code' as const, id: codeRefId(r), project: r.project })),
      ].slice(0, MAX_MENTIONS);
      const extras: SendExtras = {
        ...zip,
        ...(att.readyIds.length > 0 ? { attachments: att.readyIds } : {}),
        ...(refs.length === 0 ? {} : { mentions: refs }),
        ...(planCmd !== null ? { mode: 'plan' as const } : {}),
      };
      await props.onSend(out.text, Object.keys(extras).length === 0 ? undefined : extras);
      setText('');
      setSubscriptionRemoved(false);
      setTemplate(null);
      setSlashClosed(false);
      mentions.clear();
      if (codeChips.length > 0) clearPendingCodeRefs();
      att.sent();
      sentPulse.shake();
    } catch (err) {
      setError(w.sendFailed({ error: sayError(err) }));
      failShake.shake();
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashActive((i) => (i + 1) % commands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActive((i) => (i - 1 + commands.length) % commands.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
        const c = commands[slashActive] ?? commands[0];
        if (c !== undefined) {
          e.preventDefault();
          insertCommand(c);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashClosed(true);
        return;
      }
    }
    if (mentions.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const activeDesc = slashOpen
    ? `${slashId}-${String(Math.min(slashActive, commands.length - 1))}`
    : mentions.open && mentions.items.length > 0
      ? mentions.optionId(mentions.active)
      : undefined;

  return (
    <div
      ref={dockRef}
      className="dy-composer-dock sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-[4] px-3 pt-6 pb-3 sm:px-6 md:bottom-0 md:pb-4"
    >
      <form
        className="relative mx-auto grid max-w-[780px] gap-1.5"
        aria-label={w.form}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        onDragOver={(e: DragEvent<HTMLFormElement>) => {
          if (!canAttach || ![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          setDragging(false);
        }}
        onDrop={(e: DragEvent<HTMLFormElement>) => {
          setDragging(false);
          const files = [...e.dataTransfer.files];
          if (!canAttach || files.length === 0) return;
          e.preventDefault();
          addFiles(files);
        }}
      >
        {props.top}
        {dragging ? (
          <div
            className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-[14px] border-2 border-dashed border-dy-teal bg-dy-teal-soft/80 text-sm font-bold text-dy-teal-ink"
            data-testid="dy-drop-overlay"
          >
            {w.drop}
          </div>
        ) : null}
        {liveSecrets.length > 0 || subscriptionRemoved ? (
          <div
            role="status"
            data-testid="dy-secret-warning"
            className="grid gap-2 rounded-xl border border-dy-amber/40 bg-dy-amber-soft p-3 text-[0.8125rem] text-dy-ink"
          >
            <p className="m-0 font-bold">{tv.warning.title}</p>
            {liveSecrets.length === 0 ? null : (
              <p className="m-0">
                {liveSecrets.length === 1
                  ? tv.warning.one({ what: tv.providers[liveSecrets[0]?.provider ?? 'generic'] })
                  : tv.warning.many({ n: liveSecrets.length })}{' '}
                {vaultAdmin ? tv.warning.offer : tv.warning.adminOnly}
              </p>
            )}
            {subscriptionRemoved ? <p className="m-0">{tv.warning.subscription}</p> : null}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {liveSecrets.map((x) => (
                <li key={x.handle} className="grid gap-1.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="dy-mention" data-mention="secret">
                      <DyIcon name="key" className="dy-mention-icon" />
                      <span className="dy-mention-label">{tv.providers[x.provider]}</span>
                    </span>
                    {vaultAdmin ? (
                      <button
                        type="button"
                        className="dy-press rounded-full border border-dy-line-2 bg-dy-card px-2.5 py-0.5 font-bold"
                        aria-expanded={savingSecret === x.handle}
                        onClick={() => {
                          setSavingSecret(savingSecret === x.handle ? null : x.handle);
                        }}
                      >
                        {tv.warning.save}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="dy-press rounded-full px-2 py-0.5 text-dy-muted"
                      onClick={() => {
                        removeSecret(x);
                      }}
                    >
                      {tv.warning.remove}
                    </button>
                  </span>
                  {savingSecret === x.handle ? (
                    <SaveSecretPanel
                      value={x.value}
                      provider={x.provider}
                      initialName={suggestCredentialName(x.provider, [])}
                      onSaved={(c) => {
                        secretSaved(x, c.name);
                      }}
                      onCancel={() => {
                        setSavingSecret(null);
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <AttachmentTray
          items={att.items}
          errors={att.errors}
          hint={props.input?.images === 'model-dependent' ? w.imagesModel : null}
          onRemove={att.remove}
          zips={att.zips}
        />
        {/* p22-classic-removal §4: the chips are a row of their own (the dock is opaque behind them, chat.css). From
            768 px they wrap; narrower they scroll sideways and the hidden edge fades (`data-more`, useScrollEdges). */}
        <div
          ref={quickRef}
          role="toolbar"
          aria-label={w.quickActions}
          className="dy-edge-fade -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] md:flex-wrap md:overflow-x-visible"
          data-testid="dy-quick"
        >
          {plan === undefined ? null : (
            <button
              type="button"
              aria-pressed={plan.on}
              disabled={locked || (!plan.ready && !plan.on)}
              onClick={() => {
                togglePlan(!plan.on);
              }}
              title={plan.ready ? tp.mode.hint : tp.mode.unavailable}
              data-testid="dy-plan-chip"
              className={cx(
                'dy-press inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.8125rem] font-bold whitespace-nowrap disabled:opacity-50',
                plan.on
                  ? 'border-dy-violet bg-dy-violet-soft text-dy-violet'
                  : 'border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-violet',
              )}
            >
              <DyIcon name="flag" className="size-3.5" />
              {tp.mode.chip}
              {plan.ready ? null : <span className="sr-only">{` — ${tp.mode.unavailable}`}</span>}
            </button>
          )}
          {quick.map(({ cmd, label }) => (
            <button
              key={cmd.name}
              type="button"
              disabled={locked}
              onClick={() => {
                insertCommand(cmd);
              }}
              title={cmd.hint}
              className="dy-press inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dy-line-2 bg-dy-card px-2.5 py-1 text-[0.8125rem] whitespace-nowrap text-dy-ink disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-teal"
            >
              <code className="font-dy-mono text-[0.78125rem] text-dy-teal-ink">{cmd.name}</code>
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={picker}
            aria-haspopup="listbox"
            disabled={locked}
            onClick={() => {
              setPicker((p) => !p);
            }}
            className="dy-press inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dy-line-2 bg-dy-card px-2.5 py-1 text-[0.8125rem] whitespace-nowrap text-dy-ink disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-teal"
          >
            <DyIcon name="file" className="size-3.5" />
            {w.fromTemplate}
          </button>
        </div>
        {template !== null || mentions.picked.length > 0 || codeChips.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={w.added}>
            {template === null ? null : (
              <li className="inline-flex items-center gap-1 rounded-full bg-dy-teal-soft py-0.5 pr-1 pl-2.5 text-[0.8125rem] text-dy-teal-ink">
                <DyIcon name="file" className="size-3.5" />
                {w.template({ title: template.title })}
                <button
                  type="button"
                  aria-label={w.removeTemplate({ title: template.title })}
                  onClick={() => {
                    setTemplate(null);
                  }}
                  className="grid size-6 place-items-center rounded-full [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card"
                >
                  <DyIcon name="xc" className="size-3.5" />
                </button>
              </li>
            )}
            {mentions.picked.map((m) => (
              <li
                key={`${m.type}:${m.id}`}
                data-mention={m.type}
                data-testid="dy-picked-mention"
                className="dy-mention-chip inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-dy-line-2 bg-dy-card py-0.5 pr-1 pl-2 text-[0.8125rem]"
              >
                <MentionIcon type={m.type} />
                <span className="text-dy-muted">{mentionTypes[m.type]}</span>
                <span className="truncate" title={m.label}>{`@${m.label}`}</span>
                <button
                  type="button"
                  aria-label={w.removeMention({ label: m.label })}
                  onClick={() => {
                    mentions.remove(m);
                  }}
                  className="grid size-6 place-items-center rounded-full [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
                >
                  <DyIcon name="xc" className="size-3.5" />
                </button>
              </li>
            ))}
            {codeChips.map((r) => {
              const label = codeRefLabel(r);
              return (
                <li
                  key={`code:${r.project}:${codeRefId(r)}`}
                  data-mention="code"
                  data-testid="dy-picked-code"
                  className="dy-mention-chip inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-dy-line-2 bg-dy-card py-0.5 pr-1 pl-2 text-[0.8125rem]"
                >
                  <MentionIcon type="code" />
                  <span className="text-dy-muted">{mentionTypes.code}</span>
                  <span
                    className="truncate font-dy-mono text-[0.75rem]"
                    title={`${r.project} · ${label}`}
                    translate="no"
                  >
                    {label}
                  </span>
                  <button
                    type="button"
                    aria-label={all.code.chat.remove({ label })}
                    onClick={() => {
                      removePendingCodeRef(r);
                    }}
                    className="grid size-6 place-items-center rounded-full [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
                  >
                    <DyIcon name="xc" className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="relative" ref={pickerAnchor}>
          {picker ? (
            <TemplatePicker
              onPick={(t) => {
                setTemplate({ id: t.id, title: t.title });
                setPicker(false);
                ref.current?.focus();
              }}
              onClose={() => {
                setPicker(false);
                ref.current?.focus();
              }}
            />
          ) : null}
          {slashOpen ? (
            <ul
              id={`${slashId}-list`}
              role="listbox"
              aria-label={w.commands}
              style={pickerRoom === null ? undefined : { maxHeight: pickerRoom }}
              className="absolute right-0 bottom-full left-0 z-20 m-0 mb-2 list-none overflow-y-auto overscroll-contain rounded-xl border border-dy-line-2 bg-dy-card p-1.5 shadow-dy-pop"
            >
              {commands.map((c, i) => (
                <li
                  key={c.name}
                  id={`${slashId}-${String(i)}`}
                  role="option"
                  aria-selected={i === Math.min(slashActive, commands.length - 1)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onMouseEnter={() => {
                    setSlashActive(i);
                  }}
                  onClick={() => {
                    insertCommand(c);
                  }}
                  className={cx(
                    'grid cursor-pointer grid-cols-[90px_minmax(0,1fr)] gap-2.5 rounded-lg px-2.5 py-[7px] text-sm sm:grid-cols-[110px_minmax(0,1fr)]',
                    i === Math.min(slashActive, commands.length - 1) && 'bg-dy-sunk',
                  )}
                >
                  <code className="font-dy-mono text-dy-teal-ink">{c.name}</code>
                  <span className="text-dy-muted">{c.hint}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {mentions.open ? (
            <div
              style={pickerRoom === null ? undefined : { maxHeight: Math.min(288, pickerRoom) }}
              className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-dy-line-2 bg-dy-card p-1.5 shadow-dy-pop"
              data-testid="dy-mention-picker"
            >
              {mentions.items.length === 0 ? (
                <p className="m-0 px-2.5 py-2 text-[0.8125rem] text-dy-muted" role="status">
                  {mentions.loading ? w.searching : w.noMatch}
                </p>
              ) : (
                <ul
                  id={mentions.listId}
                  role="listbox"
                  aria-label={w.mentionSuggestions}
                  className="m-0 list-none p-0"
                >
                  {mentions.items.map((item, i) => (
                    <li
                      key={`${item.type}:${item.id}`}
                      id={mentions.optionId(i)}
                      role="option"
                      aria-selected={i === mentions.active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                      }}
                      onMouseEnter={() => {
                        mentions.setActive(i);
                      }}
                      onClick={() => {
                        mentions.pick(item);
                      }}
                      className={cx(
                        'flex cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-[7px] text-sm',
                        i === mentions.active && 'bg-dy-sunk',
                      )}
                    >
                      <span className="inline-flex w-20 shrink-0 items-center gap-1 self-center text-[0.75rem] text-dy-muted">
                        <MentionIcon type={item.type} />
                        {mentionTypes[item.type]}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.detail === null ? null : (
                        <span className="max-w-[40%] shrink-0 truncate text-[0.75rem] text-dy-muted">
                          {item.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {plan?.on === true ? (
            <div
              className="mb-1.5 flex min-w-0 items-center gap-2 rounded-[10px] bg-dy-violet-soft px-3 py-1.5 text-[0.8125rem] font-bold text-dy-violet"
              role="status"
              data-testid="dy-plan-mode"
            >
              <DyIcon name="flag" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{tp.mode.label}</span>
              <button
                type="button"
                aria-label={tp.mode.leave}
                title={tp.mode.leave}
                onClick={() => {
                  togglePlan(false);
                }}
                className="dy-press grid size-11 shrink-0 place-items-center rounded-[8px] sm:size-7"
                data-testid="dy-plan-mode-leave"
              >
                <DyIcon name="xc" className="size-4" />
              </button>
            </div>
          ) : null}
          <div
            data-shake={failShake.attr}
            data-testid="dy-composer-box"
            data-plan-mode={plan?.on === true ? '' : undefined}
            className={cx(
              'flex items-end gap-1.5 rounded-[14px] border bg-dy-card py-2 pr-2 pl-1.5 shadow-dy',
              error !== null
                ? 'border-dy-red'
                : plan?.on === true
                  ? 'border-dy-violet focus-within:border-dy-violet'
                  : 'border-dy-line-2 focus-within:border-dy-teal',
            )}
          >
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              accept={allow.images ? ACCEPT : ACCEPT.replace(/image\/[a-z]+,/g, '')}
              multiple
              data-testid="dy-file-input"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <input
              ref={cameraRef}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              aria-label={w.attach}
              title={
                canAttach
                  ? allow.images
                    ? w.attachHint
                    : w.attachNoImages({ reason: allow.reason ?? w.imagesUnsupported })
                  : (allow.reason ?? w.noFiles)
              }
              disabled={!canAttach}
              onClick={() => fileRef.current?.click()}
              className="dy-press grid size-9 shrink-0 place-items-center rounded-[10px] text-dy-muted disabled:opacity-40 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              <ClipIcon />
            </button>
            {canAttach && allow.images ? (
              <button
                type="button"
                aria-label={w.camera}
                onClick={() => cameraRef.current?.click()}
                className="dy-press grid size-9 shrink-0 place-items-center rounded-[10px] text-dy-muted [@media(pointer:fine)]:hidden"
              >
                <CameraIcon />
              </button>
            ) : null}
            {dictation.supported && !locked ? (
              <button
                type="button"
                aria-label={dictation.listening ? tv2.stop : tv2.start}
                aria-pressed={dictation.listening}
                aria-keyshortcuts={altAria(DICTATION_LETTER)}
                title={tv2.withKeys({ label: dictation.listening ? tv2.stop : tv2.start, keys: micKeys })}
                data-testid="dy-composer-mic"
                onClick={() => {
                  if (dictation.listening) dictation.stop();
                  else dictation.start();
                }}
                className={cx(
                  'dy-press grid size-9 shrink-0 place-items-center rounded-[10px]',
                  dictation.listening
                    ? 'bg-dy-red-soft text-dy-red-ink'
                    : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                )}
              >
                <MicIcon />
              </button>
            ) : null}
            {/* p17-chat-send-motion: the text being sent lifts and fades (`data-sending`), never blocking typing; once
                sent, the empty field comes up (`data-sent`). */}
            <div
              className="dy-m-field relative flex min-w-0 flex-1"
              data-sending={sending ? '' : undefined}
              data-sent={sentPulse.attr}
            >
              {mentions.tokens.length === 0 ? null : (
                <TokenHighlight text={text} tokens={mentions.tokens} layerRef={layerRef} />
              )}
              <textarea
                ref={ref}
                rows={1}
                value={text}
                disabled={locked}
                data-testid="dy-composer-field"
                data-chat-composer
                maxLength={8000}
                aria-label={w.message}
                aria-autocomplete={slashOpen || mentions.open ? 'list' : undefined}
                aria-expanded={slashOpen || mentions.open ? true : undefined}
                aria-controls={slashOpen ? `${slashId}-list` : mentions.open ? mentions.listId : undefined}
                aria-activedescendant={activeDesc}
                aria-describedby={[
                  error === null ? null : errId,
                  hintId,
                  phone && props.placeholder === undefined ? `${hintId}-full` : null,
                ]
                  .filter((x) => x !== null)
                  .join(' ')}
                aria-invalid={error === null ? undefined : true}
                placeholder={placeholderText}
                onChange={(e) => {
                  setText(e.target.value);
                  setCaret(e.target.selectionStart);
                  if (e.target.value === '' || !e.target.value.startsWith('/')) setSlashClosed(false);
                  setSlashActive(0);
                  if (error !== null) setError(null);
                  mentions.sync();
                }}
                onSelect={(e) => {
                  setCaret(e.currentTarget.selectionStart);
                  mentions.sync();
                }}
                onBlur={mentions.hide}
                onKeyDown={onKeyDown}
                onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
                  const files = [...e.clipboardData.files];
                  if (files.length === 0 || !canAttach) {
                    // p15-chat-vault: a pasted secret never sits in the field — its token does.
                    const pasted = e.clipboardData.getData('text/plain');
                    const p = protectText(pasted, { pasted: true });
                    if (p.text === pasted) return; // plain text paste
                    e.preventDefault();
                    addSecrets(p.secrets);
                    if (p.removed > 0) setSubscriptionRemoved(true);
                    insertAtCaret(p.text);
                    return;
                  }
                  e.preventDefault();
                  addFiles(files);
                }}
                onScroll={(e) => {
                  if (layerRef.current !== null) layerRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                className="relative max-h-[168px] min-h-9 w-full flex-1 resize-none disabled:cursor-not-allowed border-0 bg-transparent px-0 py-1.5 text-base leading-[1.45] text-dy-ink outline-none placeholder:text-dy-faint focus-visible:outline-none sm:text-[0.9375rem]"
              />
            </div>
            {props.busy === true && props.onStop !== undefined ? (
              <button
                type="button"
                onClick={props.onStop}
                aria-label={w.stop}
                title={w.stop}
                className="dy-press grid size-9 shrink-0 place-items-center rounded-[10px] border border-dy-line-2 bg-dy-card text-dy-ink"
              >
                <span className="size-3 rounded-[3px] bg-current" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="submit"
              disabled={blocked || att.busy || (text.trim() === '' && template === null && !hasFiles)}
              aria-label={sending ? w.sending : queueing ? w.queue : w.send}
              title={queueing ? w.queueHint : undefined}
              data-sending={sending ? '' : undefined}
              data-queueing={queueing ? '' : undefined}
              className="dy-press dy-m-send-btn grid size-9 shrink-0 place-items-center rounded-[10px] bg-dy-teal text-dy-on-fill disabled:opacity-45"
            >
              {/* p17-chat-send-motion: the arrow and the sending dot swap through a short blur (Swap). */}
              <Swap k={sending ? 'sending' : 'idle'} className="grid place-items-center">
                {sending ? (
                  <span className="dy-breathe size-2 rounded-full bg-current" aria-hidden="true" />
                ) : (
                  <DyIcon name="send" />
                )}
              </Swap>
            </button>
          </div>
        </div>
        {error === null ? null : (
          <p id={errId} role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {error}
          </p>
        )}
        {planError === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink" data-testid="dy-plan-mode-error">
            {planError}
          </p>
        )}
        {/* p16-chat-complete: dictation state (announced politely) and why it stopped. */}
        <p className="sr-only" role="status" data-testid="dy-composer-listening">
          {dictation.listening ? tv2.listening : ''}
        </p>
        {dictation.error === null ? null : (
          <p
            role="alert"
            className="m-0 text-[0.8125rem] text-dy-red-ink"
            data-testid="dy-composer-mic-error"
          >
            {dictation.error.kind === 'denied'
              ? tv2.denied
              : fill(tv2.failed, { error: dictation.error.code })}
          </p>
        )}
        {/* p17-ui-polish: a phone shows the short placeholder; the full sentence stays in the field's description. */}
        {phone && props.placeholder === undefined ? (
          <p id={`${hintId}-full`} className="sr-only">
            {fullPlaceholder}
          </p>
        ) : null}
        <p
          id={hintId}
          className="m-0 hidden flex-wrap gap-x-3.5 gap-y-1 text-[0.75rem] text-dy-faint sm:flex"
        >
          <span>
            <Kbd>↵</Kbd> {w.keys.send}
          </span>
          <span>
            <Kbd>⇧</Kbd> <Kbd>↵</Kbd> {w.keys.newLine}
          </span>
          <span>
            <Kbd>/</Kbd> {w.keys.command} <Kbd>@</Kbd> {w.keys.mention}
          </span>
          <span>
            <Kbd>{'j'}</Kbd> <Kbd>{'k'}</Kbd> {w.keys.cards} <Kbd>{'a'}</Kbd> <Kbd>{'d'}</Kbd> {w.keys.decide}
          </span>
          <span>{props.busy === true ? (queueing ? w.queueHint : w.answering) : decisionsHint}</span>
        </p>
      </form>
    </div>
  );
}
