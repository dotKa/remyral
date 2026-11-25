import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelTurn,
  type ChatInput,
  type DroppedMention,
  chatStreamUrl,
  getChatStatus,
  createThread,
  getThread,
  listThreadsPage,
  type SendExtras,
  sendMessage,
  type ThreadDetail,
} from '../../api/chat';
import { setThreadKnowledge, setThreadProjects } from '../../api/chatKnowledge';
import { ApiError, revalidateSession } from '../../api/client';
import { useErrorText } from '../../i18n/errors';
import { invalidate, onInvalidate } from '../../lib/invalidate';
import { remember, remembered } from '../../lib/remembered';
import { pushPlanEvent } from '../plan/planStore';
import { flowStreamOpened, pushFlowEvent } from '../chat/flowEvents';

/**
 * p12-diyalog Faz 1: the conversation side of the operations thread — the caller's most recently active ops chat
 * conversation (as in Faz 0), now live: the chat's own SSE stream (`/chat/threads/:id/stream`, the same one the chat
 * screen uses) brings the assistant's text as it is written and reloads on new messages, tool calls and drafts; a
 * poll stays as the fallback. Writing from the home is a real send to that conversation (a new one when there is
 * none yet).
 */
export type OpsChat =
  | { readonly status: 'loading' }
  | { readonly status: 'none' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly detail: ThreadDetail };

const CHAT_POLL_MS = 10_000;
/** p12-diyalog-w4: while the stream is closed and a turn runs, poll this often (the classic chat's rate). */
const FAST_POLL_MS = 2_000;
/** At most this many stream reopens per conversation after a session rotation (the classic bound). */
const MAX_REOPENS = 3;
/** p19-chat-stream-motion: at most this long an ended turn's text waits for the finished answer. */
const ENDED_MAX_MS = 4_000;

export interface OpsChatApi {
  readonly chat: OpsChat;
  /** The assistant's turn being written right now (from the stream), or null. */
  readonly live: {
    readonly id: string | null;
    readonly text: string;
    readonly reconnecting?: boolean;
    /**
     * p19-chat-stream-motion: the turn ended (`done` / `error`); the text stays until the re-read conversation has the
     * finished answer (no typing dots in between), then it goes in the same render.
     */
    readonly done?: boolean;
  } | null;
  /**
   * p17-chat-reconnect: the answering machine's connection dropped and the turn waits for it to come back (a quiet
   * state, not an error: it either continues or ends with the usual error line).
   */
  readonly reconnecting: boolean;
  readonly reload: () => void;
  /**
   * Sends `text`; creates the conversation first when the caller has none. Resolves with the mentions the master
   * left out (not visible to the sender, or gone).
   */
  readonly send: (text: string, extras?: SendExtras) => Promise<readonly DroppedMention[]>;
  /** p12-diyalog Faz 3: what the engine takes besides text (attachments, mentions); null: text only. */
  readonly input: ChatInput | null;
  /** p12-diyalog-w4: false while the assistant cannot answer (`GET /chat/status`): the composer locks. */
  readonly available: boolean;
  /** The conversation to upload into (created on demand, as the chat screen does). */
  readonly ensureThread: () => Promise<string>;
  /**
   * The project picked on the empty new conversation; the conversation is linked to it when it is
   * created (first message or upload). null: no project (the default, as before).
   */
  /** p18-multi-project W3: the new conversation's working projects (the primary first; empty: none). */
  readonly startProject: readonly string[];
  readonly setStartProject: (projects: string[]) => void;
  /** Stops the answer being written (the chat screen's Stop). */
  readonly stop: () => void;
  /** p16-chat-complete: the engines the answering machine has ready, and that machine (regenerate with another). */
  readonly engines: readonly string[];
  readonly runtime: string;
  readonly workerId: string | null;
  /** p18-plan-mode: the answering machine has the plan tools (plan mode can be turned on). */
  readonly planReady: boolean;
  /** p20-quick: the security policy lets the assistant act directly (null: unknown). */
  readonly direct: boolean | null;
}

/**
 * `threadId`: that conversation (the Sohbet screen); absent: the most recently active one (the home).
 * p12-diyalog-parity: `fresh` — a new conversation ("Yeni sohbet"): nothing is loaded until the first message creates it.
 */
export function useOpsChat(
  threadId0: string | null = null,
  opts: { readonly fresh?: boolean } = {},
): OpsChatApi {
  const fresh = opts.fresh === true;
  const sayError = useErrorText();
  // p14-web-perf: a conversation opened before in this tab shows its last transcript at once while it is re-read.
  const [chat, setChat] = useState<OpsChat>(() => {
    const last =
      threadId0 === null || fresh ? undefined : remembered<ThreadDetail>(`chat:thread:${threadId0}`);
    return last === undefined ? { status: 'loading' } : { status: 'ready', detail: last };
  });
  const [live, setLive] = useState<OpsChatApi['live']>(null);
  const threadId = chat.status === 'ready' ? chat.detail.thread.id : null;
  const wanted = useRef<string | null>(threadId0);

  const load = useCallback(async () => {
    try {
      let id = wanted.current;
      if (id === null && fresh) {
        setChat({ status: 'none' });
        return;
      }
      if (id === null) {
        const page = await listThreadsPage({ limit: 1 });
        id = page.items[0]?.id ?? null;
      }
      if (id === null) {
        setChat({ status: 'none' });
        return;
      }
      const detail = await getThread(id);
      wanted.current = id;
      remember(`chat:thread:${id}`, detail);
      // p19-chat-stream-motion: an ended turn's text leaves together with the answer that replaces it.
      if (detail.turn === null) setLive((cur) => (cur?.done === true ? null : cur));
      // p14-web-perf: an unchanged poll (every 10 s, up to 500 messages) keeps the same object: nothing re-renders.
      setChat((prev) =>
        prev.status === 'ready' && JSON.stringify(prev.detail) === JSON.stringify(detail)
          ? prev
          : { status: 'ready', detail },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setChat({ status: 'none' });
      else
        setChat({
          status: 'error',
          message: err instanceof ApiError ? sayError(err) : err instanceof Error ? err.message : String(err),
        });
    }
  }, [fresh, sayError]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, CHAT_POLL_MS);
    const off = onInvalidate(['chat'], () => {
      void load();
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [load]);

  // p12-diyalog-w4: whether a turn runs, for the fallback poll while the stream is closed.
  const running = (chat.status === 'ready' && chat.detail.turn !== null) || live !== null;
  const runningRef = useRef(running);
  runningRef.current = running;
  // p9-stepup-rotation-logout (as the classic chat): a stream refused because it raced a session rotation is reopened
  // with the browser's current cookie once the session is confirmed live; a fast poll covers the gap. Bounded.
  const [reopen, setReopen] = useState(0);
  const reopens = useRef(0);
  useEffect(() => {
    reopens.current = 0;
  }, [threadId]);

  // The chat's stream: deltas of the turn being written, reload on everything else.
  useEffect(() => {
    if (threadId === null || typeof EventSource === 'undefined') return;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const es = new EventSource(chatStreamUrl(threadId));
    const data = (m: MessageEvent<string>): Record<string, unknown> | null => {
      try {
        const v: unknown = JSON.parse(m.data);
        return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    es.addEventListener('ready', (m: MessageEvent<string>) => {
      // W4: a (re)opened stream — the workflow approval cards read their state once (what changed meanwhile).
      flowStreamOpened();
      const turn = data(m)?.turn as { id?: unknown; text?: unknown; state?: unknown } | null | undefined;
      if (turn && typeof turn.id === 'string')
        setLive({
          id: turn.id,
          text: typeof turn.text === 'string' ? turn.text : '',
          reconnecting: turn.state === 'reconnecting',
        });
    });
    es.addEventListener('turn', (m: MessageEvent<string>) => {
      const d = data(m);
      if (d && typeof d.id === 'string') {
        const id = d.id;
        const reconnecting = d.state === 'reconnecting';
        setLive((cur) =>
          cur?.id === id
            ? cur.reconnecting === reconnecting
              ? cur
              : { ...cur, reconnecting }
            : { id, text: '', reconnecting },
        );
      }
    });
    es.addEventListener('delta', (m: MessageEvent<string>) => {
      const d = data(m);
      if (d && typeof d.text === 'string') {
        const text = d.text;
        const turnId = typeof d.turnId === 'string' ? d.turnId : null;
        setLive((cur) => ({ id: cur?.id ?? turnId, text: (cur?.text ?? '') + text, reconnecting: false }));
      }
    });
    // p22-chat-queue: `queue` — the waiting messages changed (queued, edited, removed, delivered).
    for (const name of ['message', 'tool', 'draft', 'thread', 'watch', 'queue'])
      es.addEventListener(name, () => {
        // p17-chat-github: a renamed conversation also refreshes the conversation list.
        if (name === 'thread') invalidate('chat');
        void load();
      });
    // p18-plan-mode: the plan event carries the whole plan (the panel replaces its plan when `rev` is newer); a shared
    // reader's stream sends only a signal — then the thread view is read again.
    es.addEventListener('plan', (m: MessageEvent<string>) => {
      const d = data(m);
      if (d !== null && typeof d.plan === 'object' && d.plan !== null) pushPlanEvent(threadId, d);
      else void load();
      // p20-decisions: a decision closed, or a plan created (it replaces the last one) or ended, reaches every surface
      // at once — the conversation's decision cards fold (thread view), the badge, the home and /needs recount.
      if (d === null || d.change === 'decision' || d.change === 'state' || d.change === 'created') {
        invalidate('questions');
        if (d !== null && typeof d.plan === 'object' && d.plan !== null) void load();
      }
    });
    // p17-chat-flow leftover (W4): an approval step shown here was decided / closed elsewhere — its card reads it again.
    es.addEventListener('flow', (m: MessageEvent<string>) => {
      pushFlowEvent(data(m));
    });
    for (const name of ['done', 'error'])
      es.addEventListener(name, () => {
        setLive((cur) => (cur === null ? null : { ...cur, done: true }));
        void load().finally(() => {
          // A re-read that failed (or still sees the turn) does not keep the ended text forever.
          setTimeout(() => {
            setLive((cur) => (cur?.done === true ? null : cur));
          }, ENDED_MAX_MS);
        });
      });
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      poll ??= setInterval(() => {
        if (runningRef.current && document.visibilityState !== 'hidden') void load();
      }, FAST_POLL_MS);
      if (reopens.current >= MAX_REOPENS) return;
      void revalidateSession().then((alive) => {
        if (alive !== true || closed) return;
        reopens.current++;
        setReopen((n) => n + 1);
      });
    };
    return () => {
      closed = true;
      es.close();
      if (poll !== null) clearInterval(poll);
    };
  }, [threadId, load, reopen]);

  // p12-diyalog Faz 3: the engine's inputs (as the chat screen reads them; older masters: text only).
  const [input, setInput] = useState<ChatInput | null>(null);
  const [available, setAvailable] = useState(true);
  const [planReady, setPlanReady] = useState(false);
  const [direct, setDirect] = useState<boolean | null>(null);
  const [engines, setEngines] = useState<{
    list: readonly string[];
    runtime: string;
    workerId: string | null;
  }>({
    list: [],
    runtime: '',
    workerId: null,
  });
  useEffect(() => {
    let alive = true;
    getChatStatus().then(
      (s) => {
        if (!alive) return;
        setInput(s.input);
        setAvailable(s.available);
        setPlanReady(s.plan === true);
        setDirect(s.direct ?? null);
        setEngines({ list: s.engines ?? [], runtime: s.runtime, workerId: s.worker?.id ?? null });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const [startProject, setStartProject] = useState<readonly string[]>([]);
  const ensureThread = useCallback(async (): Promise<string> => {
    if (threadId !== null) return threadId;
    if (wanted.current !== null) return wanted.current;
    const created = await createThread();
    wanted.current = created.id;
    // p18-multi-project W3: one project links like before; several become the working projects (the first: primary).
    if (startProject.length === 1 && startProject[0] !== undefined)
      await setThreadKnowledge(created.id, { project: startProject[0] });
    else if (startProject.length > 1)
      await setThreadProjects(
        created.id,
        startProject.map((project) => ({ project })),
      );
    return created.id;
  }, [threadId, startProject]);

  const send = useCallback(
    async (text: string, extras?: SendExtras) => {
      const id = await ensureThread();
      // p22-chat-queue: while the assistant answers, the message waits for the next turn (the master decides).
      const r = await sendMessage(id, text, {}, { ...extras, queue: true });
      invalidate('chat');
      await load();
      return r.dropped;
    },
    [ensureThread, load],
  );

  const stop = useCallback(() => {
    if (threadId === null) return;
    cancelTurn(threadId).then(
      () => {
        setLive(null);
        void load();
      },
      () => undefined,
    );
  }, [threadId, load]);

  const reconnecting =
    live !== null
      ? live.reconnecting === true
      : chat.status === 'ready' && chat.detail.turn?.state === 'reconnecting';

  return {
    startProject,
    setStartProject,
    chat,
    live,
    reconnecting,
    reload: () => void load(),
    send,
    input,
    available,
    ensureThread,
    stop,
    engines: engines.list,
    runtime: engines.runtime,
    workerId: engines.workerId,
    planReady,
    direct,
  };
}
