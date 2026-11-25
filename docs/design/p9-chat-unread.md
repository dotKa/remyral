# p9-chat-unread — unread conversations in the ops chat

Status: implemented (2026-10-17). Owner request: "in the chat, the conversation (session) list must indicate conversations
that have unread messages". Within [ADR-0018](../adr/0018-ops-chat-assistant-on-worker.md) (threads private per user);
no new ADR. Migration `0074_chat_unread.sql` (renumber at merge if a parallel change took the number). Master + web
deploy; no worker release (nothing on the assistant host changes).

## 1. Before / after

Before, a watch firing (p6-chat-notify), a deploy note, a report note or an answer finishing in a conversation the user
was not looking at left no trace in the list: the user had to open every conversation to find news.

Now each conversation has a **read position per user**; the list shows conversations with news in bold with a count, the
Chat item in the navigation carries the total, and the browser tab title starts with it ("(3) Jobs · Remyral Agent
Cluster") on every page.

## 2. Data (migration 0074)

`chat_thread_reads (thread_id, user_id, last_read_seq, last_read_at)`, primary key (thread, user), cascade on thread and
user delete. Threads are private to their owner today; keying by (thread, user) keeps one position per reader if threads
are ever shared, and every query still filters on `chat_threads.user_id = caller`.

- `last_read_seq`: the highest message `seq` the user has seen (0: nothing). It only moves forward.
- `last_read_at`: when it last moved forward (not touched by a repeated call).
- Backfill: every existing thread starts read at `next_seq - 1` — no flood of badges right after the deploy.
- A thread without a row counts from 0 (a new conversation's first answer is unread until viewed).

**What counts as unread** — messages after `last_read_seq` with role:

| Role | Counts | Why |
| --- | --- | --- |
| `assistant` | yes | answers and every master note (watch fired / expired, deploy on success, reports, queue waiting note) — all are written as `assistant` with `meta.notice` / `meta` |
| `error` | yes | a failed answer is the outcome the user waits for |
| `user` | **never** | the user's own messages |
| `tool` | no | tool call summaries and confirmation notes are part of a turn, not news on their own |

**Cost.** The list query adds a `LEFT JOIN chat_thread_reads` and per thread a guarded sub-count: when
`next_seq - 1 <= last_read_seq` (nothing new of any role) no message row is touched; otherwise a range scan of the new
partial index `chat_messages_unread (thread_id, seq) WHERE role IN ('assistant','error')`, stopped at 100 (`UNREAD_CAP`,
shown as "99+"). The summary (`GET /chat/unread`) does the same over the caller's non-archived threads that have anything
new. Threads per user are capped at 500.

## 3. API (`apps/master/src/chat/routes.ts`, `chat.use`)

| Route | Does |
| --- | --- |
| `GET /chat/threads` | rows gain `unreadCount` (0..100) |
| `POST /chat/threads/:id/read` `{seq?}` | marks read up to `seq` (default: the latest message), clamped to `[0, last message]`, never backwards; returns `{threadId, lastReadSeq, lastReadAt, unreadCount}` (what is still unread after a partial read). Idempotent. 404 for another user's / unknown thread. CSRF. 240 / min per user (`chat-read`) → 429 + `retry-after` |
| `POST /chat/threads/read-all` | "Mark all as read": every conversation of the caller (archived ones too); `{updated}`. CSRF. 30 / min per user |
| `GET /chat/unread` | `{total, threads}` over the caller's conversations that are **not archived** (the nav badge and the tab title). An archived conversation still shows its own count in the archive list |

The client sends the `seq` of the newest message it has rendered, so a message that arrives between render and request is
not marked read unseen.

## 4. Console

- **List** (`ThreadList`): a conversation with `unreadCount > 0` that is not the open one gets a semibold title and an
  accent count pill ("99+" above 99); the link's accessible name is "<title>, 3 unread". "Mark all as read" appears while
  other conversations have unread messages. The list reloads every 15 s while the page is visible, when it becomes
  visible again, and at once on `invalidate('chat')` (this tab read a conversation or saw a new message) — the "existing
  live / poll mechanism": the open conversation's SSE stream already refreshes it; other conversations have no stream,
  so their answers and fired watches arrive through the poll.
- **Phone layout**: the drawer toggle carries a dot ("Conversations, 3 unread") for unread messages in other conversations
  (from the unfiltered list).
- **Marking read** (`useMarkRead` in `ChatPage`): when the conversation opens and whenever its newest loaded message
  changes, if `document.visibilityState === 'visible'` **and** `document.hasFocus()`; otherwise it waits for
  `visibilitychange` / window `focus`. A new message it may not mark yet still fires `invalidate('chat')` so the badge and
  title update. Failures (429, network) are silent and retried on the next chance; the client never repeats a mark for
  a seq it already marked.
- **Navigation badge**: `useNavBadges` adds `/chat` from `GET /chat/unread` (same 30 s visible-page poll as approvals /
  machines, plus `invalidate('chat')`); label "Chat, N unread"; the bottom bar's "More" sum includes it when Chat sits there.
- **Tab title**: `useUnreadTitle` in `AppShell` prefixes "(N) " and re-applies it when a page sets its own title later
  (a `MutationObserver` on `<title>`); the prefix is removed at 0 and on sign-out (unmount).

## 5. Tests

- `apps/master/test/integration/chat-unread.test.ts`: counting rules (user / tool never, assistant / watch note / error
  yes; unread again after a later note), idempotent + monotonic + clamped mark, `last_read_at` unchanged by a repeat,
  validation (negative, non-integer, unknown field → 400), privacy (other user's thread 404 both ways, no cross rows,
  mark-all only own, viewer allowed), session + CSRF required, archived left out of the summary but counted in the archive
  list, cap at 100, cascade on delete, per-user rate limit (other users unaffected), and the migration backfill (applied
  on a database migrated up to the previous migration with existing messages → starts read).
- `apps/web/test/chat-unread.test.tsx`: bold + count + "99+", none on the open conversation, drawer dot, mark all, mark
  on open with the rendered seq, no mark while hidden or unfocused, catch-up on focus, mark on a streamed message, badge
  refresh for a background message, silent retry after a 429, Chat nav badge + tab title, `titleWithUnread` /
  `useUnreadTitle` behaviour.

## 6. Security review

- **Authorization.** All three routes are `chat.use` (viewer+), the same action as every thread route. The write resolves
  the thread with `id AND user_id = caller` inside the single `INSERT … SELECT` — another user's or an unknown thread
  inserts nothing and answers 404 (indistinguishable, as for every thread route). `read-all` and the summary are scoped to
  `chat_threads.user_id = caller`. No new information is disclosed: counts are of the caller's own messages.
- **CSRF / session.** The two writes are cookie-authenticated mutations under the global CSRF check (tested: 403 without
  the token, 401 without a session).
- **Abuse.** Per-user Redis rate limits (240 / min single, 30 / min all); bodies are strict (`seq` integer ≥ 0 within int4,
  no other fields). The work per request is bounded (one row upsert; counts stop at 100; ≤ 500 threads per user).
- **Integrity.** The position is monotonic (`GREATEST`) and clamped to the thread's last message, so a client cannot push
  it past the end (future messages would otherwise be pre-marked) or move it back. Concurrent marks from two tabs race
  harmlessly (upsert, max wins).
- **Audit.** Reading is not a privileged action or a state transition of the platform (per-user view state); it is not
  written to the audit log.
- **Privacy of the tab title.** Only a number appears in the title (no conversation titles or content).

## 7. Rollback

Web first or together: an older console ignores `unreadCount` and the new routes. The master can roll back to the
previous image; the table and index are unused by it (forward-only migrations: leave them; dropping is a separate
migration if ever needed).
