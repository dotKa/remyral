import { useErrorText } from '../../i18n/errors';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { type DroppedMention, type SendExtras, type ThreadDetail, UUID_RE } from '../../api/chat';
import { DyNotice } from '../forms';
import { type RelatedUse, relatedOf } from '../../api/chatKnowledge';
import { useMarkRead } from '../../screens/chat/chatStatus';
import { useAuth } from '../../auth/AuthProvider';
import { StarProvider, useStars } from '../../screens/chat/organize/Stars';
import { DyHeaderTools } from '../topbar';
import { DyIcon } from '../icons';
import { Message } from '../Message';
import { SmoothHeight } from '../motionKit';
import { Composer, type ComposerSeed } from '../ops/Composer';
import { DraftItemCard } from '../ops/DraftCard';
import { wantsComposerFocus } from '../ops/composerKeys';
import { CardKeysProvider, useThreadKeys } from '../ops/keys';
import { ChatImages } from './ChatImages';
import { buildTimeline, chatItems, type TimelineItem } from '../ops/timeline';
import { useOpsChat } from '../ops/useOpsChat';
import { ASK_STATE_KEY } from '../palette/opener';
import { Thread } from '../Thread';
import { ChatQuestion } from '../questions/ChatQuestion';
import { CardsPreparing, CardStrip } from './CardStrip';
import { type ChatActions, ChatActionsContext } from './chatActions';
import { ChatRow, Typing } from './rows';
import { atEnd, firstUnreadKey, useReadPosition, useScrollAnchor } from './scrollAnchor';
import '../ops/register';
import { NEW_JOB_HASH } from './route';
import { editMessage, regenerate } from '../../api/chatComplete';
import { RegenerateDialog, useActedGuard } from './MessageControls';
import { SupersededFold } from './SupersededFold';
import { QueuedMessages } from './QueuedMessages';
import { StartProject } from './StartProject';
import { setPlanMode } from '../../api/plans';
import { PlanContext } from '../plan/PlanCard';
import { usePlan } from '../plan/planStore';
import { MentionText } from './MentionBadge';
import { composerOrigin, landSend, type PendingSend, pendingKey } from './sendMotion';
import { ReadOnlyContext, type TurnControls, TurnControlsContext } from './turnControls';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog Faz 3 (docs/design/p12-diyalog.md §11): the Sohbet screen in the Diyalog language — `/chat` (the most
 * recently active conversation, or a new one on the first message) and `/chat/:id`. One conversation as a thread: the
 * person's and the assistant's messages (copy, star, files, mentions, Outputs / watch links), the assistant's drafts as
 * cards (a job draft is the editable card, every other kind a Diyalog draft card), the answer as it is written, and
 * the Faz 3 composer (slash commands, quick chips, @mentions, templates, files, Stop). `#yeni-is` ("Yeni iş") starts a
 * request with `/iş `.
 *
 * p12-diyalog-parity (§13): `embedded` — the Sohbet screen (SohbetScreen) puts the conversation list, the header
 * (title, rename, menu, assistant line, details toggle, top-bar tools), knowledge and watches and the details panel
 * around this thread; it then hides its own top bar, reports the conversation (`onDetail`), reloads on `version`,
 * starts a new conversation with `fresh`, and jumps to a message (`jumpRef`, `?m=`). Read marks while the tab is
 * visible and focused, "Used N related items" under answers and a "Yeni mesajlar" pill are added here for every use.
 */

/** p12-diyalog-w4: the empty conversation's suggestions (the classic chat's four); a tap sends at once. */
export function suggestions(t: Messages): readonly string[] {
  const s = t.chat.thread.suggestions;
  return [s.idle, s.research, s.failedToday, s.approvals];
}

export { chatRouteId, NEW_JOB_HASH } from './route';

type Row =
  | TimelineItem
  | { readonly kind: 'live'; readonly key: string }
  /** p17-chat-send-motion: the person's message while it is being sent (sendMotion.ts). */
  | { readonly kind: 'pending'; readonly key: string; readonly p: PendingSend };

/** p12-chat-scroll-anchor: the line above the first message that arrived since the reader last read the conversation. */
export function UnreadDivider(): ReactNode {
  const t = useT().chat.thread;
  return (
    <div
      role="separator"
      aria-label={t.unread}
      data-testid="unread-divider"
      className="mb-3 flex items-center gap-3 text-[0.75rem] font-bold text-dy-teal-ink"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-dy-teal opacity-50" />
      <span aria-hidden="true">{t.unread}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-dy-teal opacity-50" />
    </div>
  );
}

/** p12-diyalog-parity: the related items each answer used (those of the user message that started its turn). */
function relatedByAnswer(detail: ThreadDetail | null): Map<string, RelatedUse> {
  const out = new Map<string, RelatedUse>();
  let pending: RelatedUse | null = null;
  for (const m of detail?.messages ?? []) {
    if (m.role === 'user') pending = relatedOf(m.meta);
    else if (m.role === 'assistant' && pending !== null) {
      out.set(m.id, pending);
      pending = null;
    }
  }
  return out;
}

/** p12-diyalog-parity: jump to a message (`?m=` or the details panel): scroll it into the middle and tint it briefly. */
function useJump(
  ready: boolean,
  jumpRef: RefObject<((id: string) => void) | null> | undefined,
  beforeJump: () => void,
): { missing: boolean; dismiss: () => void; atOpen: boolean } {
  const [target, setTarget] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [params, setParams] = useSearchParams();
  const fromLink = params.get('m');
  // p12-chat-scroll-anchor: a `?m=` link positions the conversation on open (before the unread anchor / the bottom).
  const [atOpen] = useState(() => fromLink !== null && UUID_RE.test(fromLink));
  const beforeRef = useRef(beforeJump);
  beforeRef.current = beforeJump;
  useEffect(() => {
    if (jumpRef === undefined) return;
    jumpRef.current = (id) => {
      setMissing(false);
      setTarget(id);
    };
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef]);
  useEffect(() => {
    if (fromLink === null) return;
    if (UUID_RE.test(fromLink)) setTarget(fromLink);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('m');
        return next;
      },
      { replace: true },
    );
  }, [fromLink, setParams]);
  useEffect(() => {
    if (target === null || !ready) return;
    setTarget(null);
    const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`);
    if (row === null) {
      setMissing(true);
      return;
    }
    beforeRef.current();
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof row.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    row.setAttribute('data-jump', 'true');
    setTimeout(() => {
      row.removeAttribute('data-jump');
    }, 2000);
  }, [target, ready]);
  return {
    atOpen,
    missing,
    dismiss: () => {
      setMissing(false);
    },
  };
}

export function DiyalogChat(props: {
  readonly threadId: string | null;
  /** p12-diyalog-parity: inside SohbetScreen (its header replaces this screen's top bar). */
  readonly embedded?: boolean | undefined;
  /** A new conversation ("Yeni sohbet"): created by the first message. */
  readonly fresh?: boolean | undefined;
  /** The conversation shown (null while loading / none). */
  readonly onDetail?: ((d: ThreadDetail | null) => void) | undefined;
  /** Bumped by the screen after a change to this conversation (rename, archive, knowledge): reload. */
  readonly version?: number | undefined;
  readonly jumpRef?: RefObject<((id: string) => void) | null> | undefined;
  /** p18-plan-mode: opens the plan panel ("Planı incele" on the plan card). */
  readonly onOpenPlan?: (() => void) | undefined;
  /** p18-plan-mode: above the composer (the phone's plan pill). */
  readonly composerTop?: ReactNode;
}): ReactNode {
  const sayError = useErrorText();
  const all = useT();
  const fmt = useFormat();
  const t = all.chat.thread;
  const chat = useOpsChat(props.threadId, { fresh: props.fresh === true });
  const { state } = useAuth();
  const me = state.kind === 'signedIn' ? state.user.username : '';
  const location = useLocation();
  const { hash, key: locationKey } = location;
  const navState: unknown = location.state;
  // p12-diyalog-cmdk: "Asistana sor" in the command palette opens a new conversation with the question in the router
  // state (never the URL — a link cannot send a message on someone's behalf); it is sent once, when the new
  // conversation is ready and the composer is not locked.
  const askRef = useRef<string | null>(
    props.fresh === true &&
      navState !== null &&
      typeof navState === 'object' &&
      typeof (navState as Record<string, unknown>)[ASK_STATE_KEY] === 'string'
      ? ((navState as Record<string, unknown>)[ASK_STATE_KEY] as string).trim().slice(0, 4000) || null
      : null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useThreadKeys(rootRef);

  const detail = chat.chat.status === 'ready' ? chat.chat.detail : null;
  const threadId = detail?.thread.id ?? null;
  const { onDetail, version } = props;
  // p12-chat-scroll-anchor: before paint, so the screen's knowledge strip lands in the same frame as the opening position.
  useLayoutEffect(() => {
    onDetail?.(detail);
  }, [detail, onDetail]);
  const firstVersion = useRef(version);
  const reloadRef = useRef(chat.reload);
  reloadRef.current = chat.reload;
  useEffect(() => {
    if (version !== firstVersion.current) reloadRef.current();
  }, [version]);
  // p12-chat-scroll-anchor: the read position before this screen's own read mark (in parallel with the conversation
  // when its id is in the URL); the rows are rendered once it is known, so the first paint is already in place.
  const status = chat.chat.status;
  const read = useReadPosition(
    props.threadId ?? threadId,
    props.fresh === true || status === 'none' || status === 'error',
  );
  const shownReady = status !== 'loading' && read.done;
  // The first unread row, decided once when the conversation opens: the divider stays until the reader leaves.
  const unreadLatch = useRef<{ readonly key: string | null } | null>(null);
  if (unreadLatch.current === null && shownReady)
    unreadLatch.current = { key: firstUnreadKey(detail?.messages ?? [], read.lastReadSeq) };
  const unreadKey = unreadLatch.current?.key ?? null;
  // p9-chat-unread: mark the conversation read up to its newest message while the tab is visible and focused.
  useMarkRead(threadId ?? '', detail === null || !read.done ? null : (detail.messages.at(-1)?.seq ?? 0));
  const related = useMemo(() => relatedByAnswer(detail), [detail]);
  const releaseRef = useRef<() => void>(() => undefined);
  const jump = useJump(shownReady && detail !== null, props.jumpRef, () => {
    releaseRef.current();
  });
  const stars = useStars(detail?.starred, () => undefined);
  const turnOpen = detail !== null && detail.turn !== null;
  const turnOpenRef = useRef(turnOpen);
  turnOpenRef.current = turnOpen;
  const streaming = turnOpen || chat.live !== null;
  // p15-chat-cards-scroll: while the answer is being written, its cards wait below it ("n kart hazırlanıyor") and
  // appear under the finished answer.
  const { rows, held } = useMemo(() => {
    // The day separators in the console's language ("Today, Saturday 24 October").
    const list: Row[] = buildTimeline([], chatItems(detail), new Date(), { t: all, f: fmt });
    let n = 0;
    if (streaming) {
      const lastUser = list.findLastIndex(
        (r) => r.kind === 'row' && r.row.kind === 'message' && r.row.m.role === 'user',
      );
      const at = list.findLastIndex((r) => r.kind === 'cards');
      const strip = list[at];
      if (strip?.kind === 'cards' && (at > lastUser || strip.pending)) {
        n = strip.cards.length;
        list.splice(at, 1);
      }
      list.push({ kind: 'live', key: 'live' });
    }
    return { rows: list, held: n };
  }, [detail, streaming, all, fmt]);

  // p17-chat-send-motion (sendMotion.ts): the message being sent waits in the thread as a pending bubble (before the
  // answer being written). Once the conversation has a newer user message than when the send started, that is the
  // sent message back from the master: it takes the pending bubble's thread key (`settled`, so the list item stays and
  // nothing enters twice) and settles in — the tail grows, the time fades in.
  const [pending, setPending] = useState<PendingSend | null>(null);
  const sendSeq = useRef(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const lastUserId = useMemo(() => detail?.messages.findLast((m) => m.role === 'user')?.id ?? null, [detail]);
  const lastUserRef = useRef(lastUserId);
  lastUserRef.current = lastUserId;
  const settled = useRef(new Map<string, string>());
  const landed = pending !== null && lastUserId !== null && lastUserId !== pending.before;
  if (landed) {
    const sent = rows.find((r) => r.kind === 'row' && r.row.kind === 'message' && r.row.m.id === lastUserId);
    if (sent !== undefined && !settled.current.has(sent.key))
      settled.current.set(sent.key, pendingKey(pending.n));
  }
  useEffect(() => {
    // A sent message not back yet (a failed re-read) arrives later like any other: no pending bubble waits for it.
    if (pending?.done === true) setPending(null);
  }, [pending]);
  const view = useMemo((): readonly Row[] => {
    if (pending === null || pending.done === true || landed) return rows;
    const at = rows.at(-1)?.kind === 'live' ? rows.length - 1 : rows.length;
    return [
      ...rows.slice(0, at),
      { kind: 'pending', key: pendingKey(pending.n), p: pending },
      ...rows.slice(at),
    ];
  }, [rows, pending, landed]);

  // p17-panel-motion: how each arriving row enters (motion.css) — the person's message from their side, a card tipping
  // up into place, and the finished answer that replaces the text streaming in its place not at all ("quiet").
  const quiet = useRef(new Set<string>());
  const known = useRef<ReadonlySet<string>>(new Set());
  const wasStreaming = useRef(false);
  if (streaming || wasStreaming.current)
    for (const r of rows)
      if (
        r.kind === 'row' &&
        r.row.kind === 'message' &&
        r.row.m.role === 'assistant' &&
        !known.current.has(r.key)
      )
        quiet.current.add(r.key);
  useLayoutEffect(() => {
    wasStreaming.current = streaming;
    known.current = new Set(rows.map((r) => r.key));
  }, [rows, streaming]);
  // p17-chat-send-motion: a pending bubble lands by itself (landSend / dy-m-send); the sent message settles in its place.
  const enterOf = (r: Row): Record<string, string | undefined> => ({
    'data-enter':
      r.kind === 'pending'
        ? 'quiet'
        : settled.current.has(r.key)
          ? 'settle'
          : r.kind === 'cards' || r.kind === 'draft' || r.kind === 'question' || r.kind === 'images'
            ? 'card'
            : r.kind === 'row' && r.row.kind === 'message' && r.row.m.role === 'user'
              ? 'me'
              : quiet.current.has(r.key)
                ? 'quiet'
                : undefined,
  });

  useEffect(() => {
    document.title = t.docTitle({ title: detail?.thread.title ?? all.chat.title });
  }, [detail?.thread.title, t, all.chat.title]);

  // Opens at the first unread message / where the reader left / the newest end (scrollAnchor.ts); then follows new
  // items while the reader is at the end, else a "Yeni mesajlar" pill (parity). Only new content counts: a poll
  // that returns the same conversation does not move the reader or raise the pill.
  const scroll = useScrollAnchor({
    threadId: props.fresh === true ? null : threadId,
    ready: shownReady,
    unread: unreadKey,
    jumping: jump.atOpen,
    content: rootRef,
  });
  releaseRef.current = scroll.release;
  const [unseen, setUnseen] = useState(false);
  const signature = `${String(view.length)}:${view.at(-1)?.key ?? ''}:${String(chat.live?.text.length ?? -1)}`;
  const lastSignature = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!scroll.positioned) return;
    const prev = lastSignature.current;
    lastSignature.current = signature;
    if (prev === null || prev === signature) return;
    if (scroll.following()) scroll.toBottom();
    else setUnseen(true);
  }, [signature, scroll]);
  // p17-chat-send-motion: the pending bubble lands from the composer — after the thread followed it to the end above,
  // so its place is final when it is measured.
  const flown = useRef(0);
  useLayoutEffect(() => {
    if (pending === null || flown.current === pending.n) return;
    const el = shellRef.current?.querySelector<HTMLElement>(
      `[data-pending-send="${String(pending.n)}"] [data-role="me"]`,
    );
    if (el === null || el === undefined) return;
    flown.current = pending.n;
    landSend(el, pending.from);
  }, [pending, view]);
  useEffect(() => {
    if (!unseen) return;
    const onScroll = (): void => {
      if (atEnd()) setUnseen(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [unseen]);

  // p17-toasts-shortcuts: every navigation here (the screen, a conversation, "Yeni sohbet") asks for the caret.
  const focusRequest = useMemo(
    () => ({ key: locationKey, explicit: wantsComposerFocus(navState) }),
    [locationKey, navState],
  );

  // "Yeni iş": the composer starts a request with `/iş `.
  const [seed, setSeed] = useState<ComposerSeed | null>(null);
  useEffect(() => {
    if (hash !== `#${NEW_JOB_HASH}`) return;
    setSeed((s) => ({ text: '/iş ', n: (s?.n ?? 0) + 1 })); // i18n-ignore: slash command token
  }, [hash, locationKey]);

  // p12-diyalog-w4: mentions the master left out of the last message (cleared on the next send).
  const [dropped, setDropped] = useState<readonly DroppedMention[]>([]);
  const [chipError, setChipError] = useState<string | null>(null);
  const sendRaw = chat.send;
  // p17-chat-flow: "Sohbette düzenle" — the workflow card the next message changes (cleared once sent or stopped).
  const [editing, setEditing] = useState<{ readonly id: string; readonly title: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const send = useCallback(
    async (text: string, given?: SendExtras): Promise<void> => {
      const target = editingRef.current;
      const extras: SendExtras | undefined =
        target === null ? given : { ...(given ?? {}), editDraft: target.id };
      setDropped([]);
      setChipError(null);
      const n = ++sendSeq.current;
      // Files only: no text to show on its way (the sent message arrives as usual). p22-chat-queue: while the
      // assistant answers the message waits in the queue (its bubble comes from the master), not in the thread.
      if (text.trim() !== '' && !turnOpenRef.current)
        setPending({ n, text, before: lastUserRef.current, from: composerOrigin(shellRef.current) });
      try {
        setDropped(await sendRaw(text, extras));
        if (target !== null) setEditing((cur) => (cur?.id === target.id ? null : cur));
        // Sent: the render that brings the message back hands it the pending bubble's place, then the record goes.
        setPending((p) => (p?.n === n ? { ...p, done: true } : p));
      } catch (err) {
        // Failed: the bubble goes at once (the composer keeps the text and shakes).
        setPending((p) => (p?.n === n ? null : p));
        throw err;
      }
    },
    [sendRaw],
  );
  const archived = detail?.thread.archived === true;
  const unavailable = !chat.available;
  const locked = archived || unavailable;
  const ready = chat.chat.status === 'none';
  useEffect(() => {
    const ask = askRef.current;
    if (ask === null || !ready || locked) return;
    askRef.current = null;
    send(ask).catch((err: unknown) => {
      setChipError(t.sendFailed({ error: sayError(err) }));
    });
  }, [ready, locked, send]);

  // p15-chat-cards-scroll: the job result card's "Düzelt" fills the composer; "Yeniden çalıştır" reloads after its card.
  const chatReload = chat.reload;
  const onOpenPlan = props.onOpenPlan;
  const planReady = chat.planReady;
  const chatActions = useMemo<ChatActions | null>(
    () =>
      threadId === null
        ? null
        : {
            threadId,
            ask: (text: string) => {
              setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }));
            },
            reload: chatReload,
            editDraft: (draft) => {
              setEditing({ id: draft.id, title: draft.title });
              setSeed((s) => ({ text: all.chatFlow.edit.prefix, n: (s?.n ?? 0) + 1 }));
            },
            // p18-plan-mode: the planning proposal's buttons send; "Planı incele" opens the panel.
            send: (text: string, opts?: { readonly plan?: boolean }) =>
              send(text, opts?.plan === true ? { mode: 'plan' } : undefined),
            planReady,
            ...(onOpenPlan === undefined ? {} : { openPlan: onOpenPlan }),
          },
    [threadId, chatReload, all, send, planReady, onOpenPlan],
  );
  const busy = turnOpen;
  // p18-plan-mode: the conversation's plan (thread view + stream) for the strip's plan cards; plan mode for the composer.
  const plan = usePlan(threadId, detail === null ? undefined : (detail.plan?.active ?? null));
  const planMode = detail?.plan?.mode != null;
  const ensure = chat.ensureThread;
  const planContext = useMemo(
    () =>
      threadId === null
        ? null
        : {
            plan,
            threadId,
            readOnly: detail?.access === 'reader',
            questions: detail?.questions ?? [],
            turnOpen,
            onChanged: chatReload,
          },
    [plan, threadId, detail?.access, detail?.questions, turnOpen, chatReload],
  );
  const composerPlan = useMemo(
    () => ({
      on: planMode,
      ready: planReady,
      onToggle: async (on: boolean) => {
        const id = await ensure();
        await setPlanMode(id, on);
        chatReload();
      },
    }),
    [planMode, planReady, ensure, chatReload],
  );

  // p16-chat-complete: edit / regenerate / retry (owner only; a shared reader reads).
  const reader = detail?.access === 'reader';
  const guard = useActedGuard();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const reloadChat = chat.reload;
  const controls = useMemo<TurnControls | null>(() => {
    if (detail === null || reader || threadId === null) return null;
    const current = detail.messages.filter((m) => m.supersededAt === undefined);
    const lastUser = current.findLast((m) => m.role === 'user');
    const after = lastUser === undefined ? [] : current.filter((m) => m.seq > lastUser.seq);
    const answer = after.findLast((m) => m.role === 'assistant');
    const lastLine = after.findLast(
      (m) => m.role === 'assistant' || (m.role === 'error' && m.meta?.notice === undefined),
    );
    const idle = !streaming && !locked;
    const act = (fn: (ack: boolean) => Promise<unknown>): void => {
      void guard.run(async (ack) => {
        await fn(ack);
        setEditingId(null);
        setOtherOpen(false);
        reloadChat();
      });
    };
    return {
      editable: new Set(idle ? current.filter((m) => m.role === 'user').map((m) => m.id) : []),
      lastAnswerId: idle && answer !== undefined && lastLine?.id === answer.id ? answer.id : null,
      retryId: idle && lastLine !== undefined && lastLine.role === 'error' ? lastLine.id : null,
      editingId,
      busy: guard.busy,
      error: guard.error,
      startEdit: (id) => {
        guard.clear();
        setEditingId(id);
      },
      edit: (id, text) => {
        act((ack) => editMessage(threadId, id, text, ack));
      },
      regenerate: () => {
        act((ack) => regenerate(threadId, { acknowledgeActions: ack }));
      },
      regenerateOther: () => {
        guard.clear();
        setOtherOpen(true);
      },
      retry: () => {
        act((ack) => regenerate(threadId, { mode: 'retry', acknowledgeActions: ack }));
      },
    };
  }, [detail, reader, threadId, streaming, locked, guard, editingId, reloadChat]);

  const renderRow = (r: Row): ReactNode => {
    switch (r.kind) {
      case 'day':
        return (
          <Message role="system">
            <span>{r.label}</span>
          </Message>
        );
      case 'row': {
        // data-message-id: the jump target (details panel, `?m=`).
        const row = (
          <div
            className="flex min-w-0 flex-col"
            data-row={r.row.kind === 'message' ? 'message' : 'tools'}
            data-message-id={r.row.kind === 'message' ? r.row.m.id : undefined}
          >
            <ChatRow
              item={r}
              me={me}
              related={r.row.kind === 'message' ? related.get(r.row.m.id) : undefined}
            />
          </div>
        );
        // p17-chat-send-motion: a sent message in its pending bubble's place keeps the same box (its height eases to
        // the message with its tools).
        return settled.current.has(r.key) ? <SmoothHeight>{row}</SmoothHeight> : row;
      }
      case 'pending':
        return (
          <SmoothHeight>
            <div className="flex min-w-0 flex-col" data-row="message" data-pending-send={String(r.p.n)}>
              <Message role="me" sending={all.shared.chat.sending} className="dy-m-send">
                <MentionText text={r.p.text} meta={null} />
              </Message>
            </div>
          </SmoothHeight>
        );
      case 'cards':
        return r.pending ? (
          <CardsPreparing n={r.cards.length} />
        ) : (
          <CardStrip
            cards={r.cards}
            threadId={threadId ?? ''}
            turnOpen={turnOpen}
            disabled={locked || reader}
            onChanged={chat.reload}
          />
        );
      // p20-chat-images: the images the turn showed (show_image), under its answer.
      case 'images':
        return <ChatImages images={r.images} />;
      case 'draft':
        return <DraftItemCard d={r.d} threadId={threadId ?? ''} onChanged={chat.reload} />;
      case 'question':
        return (
          <ChatQuestion
            set={r.q}
            threadId={threadId ?? ''}
            turnOpen={turnOpen}
            disabled={locked || reader}
            onAnswered={chat.reload}
          />
        );
      case 'live':
        // p17-chat-send-motion: the answer grows smoothly as it is written (its box eases to each new height).
        return (
          <SmoothHeight>
            <Typing
              text={chat.live?.text ?? ''}
              reconnecting={chat.reconnecting}
              done={chat.live?.done === true}
            />
            {held > 0 ? <CardsPreparing n={held} /> : null}
          </SmoothHeight>
        );
      case 'superseded':
        return <SupersededFold messages={r.messages} />;
      case 'ops':
        return null;
    }
  };

  return (
    <PlanContext.Provider value={planContext}>
      <ChatActionsContext.Provider value={chatActions}>
        <ReadOnlyContext.Provider value={reader}>
          <TurnControlsContext.Provider value={controls}>
            <CardKeysProvider>
              <StarProvider value={stars}>
                <div
                  className={
                    props.embedded === true
                      ? 'flex min-w-0 flex-1 flex-col'
                      : 'dy-surface flex min-h-dvh min-w-0 flex-col bg-dy-thread'
                  }
                  data-testid="dy-chat"
                  ref={shellRef}
                >
                  {props.embedded === true ? null : (
                    <div
                      data-dy-sticky=""
                      className="sticky top-0 z-[5] flex min-h-[53px] items-center gap-3 border-b border-dy-line bg-dy-thread/85 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-[14px] backdrop-saturate-150 sm:px-6"
                    >
                      <span
                        className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-dy-teal text-dy-on-fill"
                        aria-hidden="true"
                      >
                        <DyIcon name="bubble" />
                      </span>
                      <div className="min-w-0">
                        <h1 className="m-0 text-base font-extrabold">{all.chat.title}</h1>
                        {detail === null ? null : (
                          <p className="m-0 truncate text-[0.78125rem] text-dy-muted">
                            {detail.thread.title}
                          </p>
                        )}
                      </div>
                      <DyHeaderTools className="ml-auto" />
                    </div>
                  )}
                  <main id="main" tabIndex={-1} className="flex-1 px-3 pt-4 pb-4 outline-none sm:px-6">
                    <div
                      ref={rootRef}
                      className="mx-auto max-w-[780px]"
                      data-anchoring={scroll.settling ? '' : undefined}
                    >
                      {jump.missing ? (
                        <p
                          role="status"
                          className="m-0 mb-3 text-[0.8125rem] text-dy-amber-ink"
                          data-testid="jump-missing"
                        >
                          {t.jumpMissing}{' '}
                          <button type="button" className="underline" onClick={jump.dismiss}>
                            {t.close}
                          </button>
                        </p>
                      ) : null}
                      <Thread
                        label={all.chat.title}
                        items={shownReady ? view : []}
                        itemKey={(r) => settled.current.get(r.key) ?? r.key}
                        itemProps={enterOf}
                        renderItem={(r) => (
                          <>
                            {r.key === unreadKey ? <UnreadDivider /> : null}
                            {renderRow(r)}
                          </>
                        )}
                        reveal={unreadKey}
                        busy={!shownReady}
                        header={
                          chat.chat.status === 'error' ? (
                            <Message role="system" tone="warn" icon="xc">
                              {t.readError({ error: chat.chat.message })}
                            </Message>
                          ) : null
                        }
                        empty={
                          chat.chat.status === 'loading' ? null : (
                            <div
                              className="grid justify-items-center gap-1.5 py-10 text-center"
                              data-testid="dy-chat-empty"
                            >
                              <p className="m-0 text-[1.0625rem] font-bold">{t.emptyTitle}</p>
                              <p
                                className="m-0 max-w-[52ch] text-[0.875rem] text-dy-muted"
                                data-testid="dy-chat-empty-body"
                              >
                                {chat.direct === null
                                  ? t.emptyBodyUnknown
                                  : chat.direct
                                    ? t.emptyBodyDirect
                                    : t.emptyBody}
                              </p>
                              {threadId === null && !reader ? (
                                <StartProject
                                  value={chat.startProject}
                                  onChange={chat.setStartProject}
                                  disabled={locked || busy}
                                />
                              ) : null}
                              <ul
                                aria-label={t.suggestionsLabel}
                                className="m-0 mt-3 flex list-none flex-wrap justify-center gap-2 p-0"
                              >
                                {suggestions(all).map((s) => (
                                  <li key={s}>
                                    <button
                                      type="button"
                                      disabled={locked || busy}
                                      onClick={() => {
                                        send(s).catch((err: unknown) => {
                                          setChipError(t.sendFailed({ error: sayError(err) }));
                                        });
                                      }}
                                      className="dy-press inline-flex min-h-11 items-center rounded-full border border-dy-line-2 bg-dy-card px-4 text-[0.875rem] text-dy-ink disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-teal"
                                    >
                                      {s}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                              {chipError === null ? null : (
                                <p role="alert" className="m-0 mt-1 text-[0.8125rem] text-dy-red-ink">
                                  {chipError}
                                </p>
                              )}
                            </div>
                          )
                        }
                      />
                      {/* p22-chat-queue: messages written while Remyral answers wait here, under the answer. */}
                      {threadId === null || reader ? null : (
                        <QueuedMessages
                          threadId={threadId}
                          items={detail?.queued ?? []}
                          busy={busy}
                          onSendNow={chat.stop}
                          onChanged={chat.reload}
                        />
                      )}
                    </div>
                  </main>
                  {unseen ? (
                    <div className="pointer-events-none sticky bottom-[calc(9rem+env(safe-area-inset-bottom))] z-[6] flex justify-center md:bottom-[8rem]">
                      <button
                        type="button"
                        onClick={() => {
                          setUnseen(false);
                          scroll.toBottom();
                        }}
                        className="dy-pill dy-press pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-dy-ink px-3.5 py-1.5 text-[0.8125rem] font-bold text-dy-card shadow-dy-pop"
                      >
                        {t.newContent}
                      </button>
                    </div>
                  ) : null}
                  <p className="sr-only" role="status" aria-live="polite" data-testid="dy-answering">
                    {busy || chat.live !== null ? t.answering : ''}
                  </p>
                  {dropped.length === 0 ? null : (
                    <div className="mx-auto w-full max-w-[780px] px-3 sm:px-0" data-testid="mentions-dropped">
                      <DyNotice tone="amber" live>
                        {t.dropped({ n: dropped.length })}
                      </DyNotice>
                    </div>
                  )}
                  {guard.error !== null && editingId === null ? (
                    <div
                      className="mx-auto w-full max-w-[780px] px-3 sm:px-0"
                      data-testid="turn-action-error"
                    >
                      <DyNotice tone="red" live>
                        {guard.error}
                      </DyNotice>
                    </div>
                  ) : null}
                  {guard.dialog}
                  {otherOpen ? (
                    <RegenerateDialog
                      open
                      engines={chat.engines}
                      current={chat.runtime}
                      workerId={chat.workerId ?? undefined}
                      busy={guard.busy}
                      onClose={() => {
                        setOtherOpen(false);
                      }}
                      onSubmit={(runtime, model) => {
                        if (threadId === null) return;
                        void guard.run(async (ack) => {
                          await regenerate(threadId, {
                            runtime,
                            ...(model === null ? {} : { model }),
                            acknowledgeActions: ack,
                          });
                          setOtherOpen(false);
                          chat.reload();
                        });
                      }}
                    />
                  ) : null}
                  {reader ? (
                    <p
                      className="mx-auto mb-4 w-full max-w-[780px] px-3 text-[0.8125rem] text-dy-muted sm:px-0"
                      data-testid="shared-readonly"
                    >
                      {all.chatComplete.shared.placeholder}
                    </p>
                  ) : (
                    <>
                      {editing === null ? null : (
                        <EditingChip
                          title={editing.title}
                          onCancel={() => {
                            setEditing(null);
                          }}
                        />
                      )}
                      <Composer
                        onSend={send}
                        busy={busy}
                        queue
                        disabled={locked}
                        {...(archived
                          ? { placeholder: t.archivedPlaceholder }
                          : unavailable
                            ? { placeholder: t.unavailablePlaceholder }
                            : {})}
                        seed={seed}
                        input={chat.input}
                        ensureThread={chat.ensureThread}
                        onStop={chat.stop}
                        threadProject={detail?.knowledge?.project ?? null}
                        focusRequest={focusRequest}
                        plan={composerPlan}
                        top={props.composerTop}
                        direct={chat.direct}
                      />
                    </>
                  )}
                </div>
              </StarProvider>
            </CardKeysProvider>
          </TurnControlsContext.Provider>
        </ReadOnlyContext.Provider>
      </ChatActionsContext.Provider>
    </PlanContext.Provider>
  );
}

/** p17-chat-flow: above the composer while a message is a change request for a workflow card ("Sohbette düzenle"). */
function EditingChip(props: { readonly title: string; readonly onCancel: () => void }): ReactNode {
  const w = useT().chatFlow.edit;
  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-[780px] min-w-0 items-center gap-2 rounded-[10px] bg-dy-teal-soft px-3 py-1.5 text-[0.8125rem] text-dy-teal-ink"
      data-testid="chat-editing-draft"
      role="status"
    >
      <DyIcon name="pen" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{w.context({ title: props.title })}</span>
      <button
        type="button"
        onClick={props.onCancel}
        className="dy-press inline-flex min-h-8 shrink-0 items-center rounded-md px-2 font-bold"
        data-testid="chat-editing-cancel"
      >
        {w.cancel}
      </button>
    </div>
  );
}
