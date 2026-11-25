# Design note: `p16-chat-complete` — edit / regenerate / retry, restart re-run, export & share, dictation, job log & diff reads

- **Task:** `p16-chat-complete`. **Date:** 2026-10-23. **Migration:** `0138_chat_complete.sql` (additive).
- **Owner request:** close the remaining ops-chat gaps of the internal note `bilinen-eksikler` (not published) (wave 1, "Sohbet" and
  "Sohbet küçükleri").
- **Builds on:** p5-ops-chat (turns, drafts, history on the master), p5-ops-chat-next (replica bus), p15-chat-failover
  (re-run once, `rerun_of`, tool-call accounting), p15-model-picker (runtime model catalog, `DyModelPicker`),
  p8-chat-attachments-mentions, p15-chat-zip, p10-semantic-defaults-chat, p12-diyalog.
- **No new ADR:** no new trust boundary. Every change is a master / console change on existing paths; sharing adds a
  second reader to a conversation and keeps every linked resource behind the reader's own permission.
- **Worker release:** needed only for the three new assistant tools and rule 37 (the tool list and the system prompt
  are compiled into the worker's assistant host). Everything else is master + web.

## 1. Edit, regenerate, retry

### 1.1 Fork model (edit)

Linear history with supersede marks — no tree. Editing user message *M* (any non-superseded user message of the
caller's own conversation):

1. *M* and every later non-superseded row (user, assistant, tool, error rows) are marked superseded
   (`chat_messages.superseded_at`, `superseded_by` = the new message's id) in the same transaction that appends
   the edited text as a **new** user message at the end (`meta.editOf = M.id`).
2. The model history is built from the rows **before** *M* that are not superseded; superseded rows never reach a
   model again (history, the stored-turn path, re-runs).
3. Open cards (`proposed` drafts) of the superseded turns are dismissed (`result.reason = 'superseded'`); decided
   cards stay what they are (they are facts).
4. Attachments of *M* move to the new message (same rows, `message_id` re-pointed); mentions and site uploads are
   resolved again as the sender (a mention that became invisible is dropped as on any send); the text is scrubbed
   again.
5. The console hides superseded rows: each superseded block collapses into one line "N mesaj düzenlendi · göster"
   where it stood; expanded rows are dimmed and read-only. Export includes only the current branch (a line says how
   many earlier versions were left out).

Why linear: the thread stays one ordered list (seq, unread counts, stream, search and the cards strip keep working);
an edit is "the conversation from here on is replaced", which is what an operator means; nothing is deleted
(audit / accounting keep the turns and the superseded rows stay readable).

### 1.2 Regenerate and retry

`POST /chat/threads/:id/regenerate {messageId?, runtime?, model?, mode?: 'regenerate' | 'retry', acknowledgeActions?}`
re-answers the **last** non-superseded user message (`messageId`, when given, must be it: `409 not_last_message`).
Every row after it is superseded (`superseded_by` = the new turn's id) and a new turn answers the stored message
through the same stored-turn path a replica dispatch / failover re-run uses (`#sendStoredTurn`; a peer replica
gets it over the bus with the runtime and model on the `chat_turns` row).

- **Another model:** `runtime` must be an assistant engine the answering machine reports ready (`GET /chat/status`
  gains `engines` of that machine); `model` is a model id (the catalog's validation, `modelIdIssue`) or absent (the
  setting's model when the runtime is the configured one, else the runtime's default). The answer is labelled with
  the engine and model it came from (`meta.regenerated`).
- **Retry** is the same call with `mode: 'retry'`, offered on the error line of a failed, lost or cancelled last turn
  (one click). Audit: `chat.turn.regenerate` / `chat.turn.retry` / `chat.message.edit`.

### 1.3 Replay safety — one rule, the failover rule

The failover re-run (p15-chat-failover §5) never replays a turn that received a non-read tool call. That counter is
now **persisted** (`chat_turns.actions`, incremented when the call arrives, before it runs) so it survives a master
restart and every replica sees it. Edit, regenerate and retry ask over the turns they would replace:

- the turns = turns answering the target user message(s) (`chat_turns.message_id`) plus turns of the rows being
  superseded;
- `actions > 0` on any of them → `409 turn_acted` with `effects` (the non-read tool rows: tool name and summary; the
  cards: kind, title, state). The console shows "Bu yanıt şunları yaptı: …" and asks; the call is repeated with
  `acknowledgeActions: true` (audited with the count). Nothing is replayed blindly.
- the automatic restart re-run (§2) never runs when `actions > 0` — the thread gets the error line and a Retry button.

## 2. Master restart: re-run once

A turn runs in the memory of the replica that holds the assistant worker's connection. When that process stops, its
open turns stay `sent` / `running` in the database. New:

- `chat_turns.runner` — the replica that sends the turn to its worker (bus replica id, or the process id with no bus);
  `chat_turns.message_id` — the user message it answers; `chat_turns.origin` (`regenerate | retry | edit | restart`).
- **Orphan:** an open turn created before this process started whose runner is neither this process nor a live peer
  replica (bus presence). A turn of a live peer is never touched.
- **Recovery** runs on each chat sweep during the first 5 minutes after start (the assistant worker needs a few
  seconds to reconnect). An orphan is claimed with the guarded `finishTurn(… 'lost')` update — exactly one replica
  wins across replicas. The winner re-runs it **once** when: it did not act (`actions = 0`), its message was never
  re-run (`rerun_of IS NULL`), it is younger than 30 minutes, at most 20 re-runs per start, and a machine can answer
  now; the thread gets one notice "Panel yeniden başlarken yanıt kesildi; mesajın yeniden yanıtlanıyor" (`meta.notice
  = 'chat-failover'`, `cause = 'restart'`) and the new turn has `rerun_of` = the lost turn, `origin = restart`. While
  no machine can answer, the orphan waits for the next sweep (inside the window); after the window, or when it acted,
  it ends with the error line ("The answer was interrupted when the master restarted…", with the acted detail) and the
  console offers Retry. The periodic stale sweep (2 × turn timeout) uses the same ending (error line, no re-run).
- Closes the known gap "master yeniden başlarken kesilen yanıt".

## 3. Export

`GET /chat/threads/:id/export?format=markdown|json` (owner or a shared reader; audited `chat.thread.export`).

- One document model built on the master (`chat/export.ts`) for the **caller's** view: title, owner, dates; the
  current branch's messages (author, time, text); per user message its attachments (name, kind, size) and mentions;
  tool rows as one "Araçlar" line; the cards with their **final** state (kind, title, state, decided at) and links the
  caller can open (job, run, deploy); notices. Never card payloads, never attachment bytes.
- **Redaction:** user text is scrubbed at send (p15-chat-vault), answers and tool summaries are redacted when stored;
  the export runs the master's redactor over every text again (rows written before a rule existed are covered).
  Vault chips export as `{{credential:NAME}}` (a name, never a value).
- **Markdown** is rendered on the master and downloaded (`text/markdown`, `attachment`).
- **PDF:** the console's print view (`/chat/:id/yazdir`) renders the JSON model with print styles and opens the
  browser's print dialog ("PDF olarak kaydet"). No server-side PDF engine, no third-party CDN, no CSP change: the view is
  part of the console bundle (scripts / styles from `'self'`). Robust in every browser that prints.

## 4. Share and hand over

- `chat_thread_shares (thread_id, user_id, granted_by, created_at)`. The owner adds / removes readers
  (`PUT|DELETE /chat/threads/:id/shares/:userId`, audited `chat.thread.share` / `chat.thread.unshare`); a reader can
  leave (DELETE self). Readers find it under **Paylaşılanlar** (`GET /chat/shared`; the first plain page of
  `GET /chat/threads` carries the same list as `shared`, so the console needs no extra request) and open it read-only: no
  composer, no edit / regenerate / retry, no card buttons, no rename / archive / delete, no knowledge or watches; the
  live stream and attachments are readable.
- **Per-viewer permissions** (`chat/share.ts`): the thread view of a reader is filtered for the reader — a card whose
  project the reader cannot read becomes `{restricted: true}` (no title, payload or result; the console says "erişimin
  yok"), project-less cards only for admins; mention chips of invisible items lose their label; related-knowledge items
  the reader cannot read are dropped (other conversations always); site upload facts of unreadable projects are
  hidden. Job result cards and links load through the reader's own API calls (404 → "erişimin yok"). The words of the
  conversation are shared as written — that is what sharing means; the owner chooses.
- **Hand over:** `POST /chat/threads/:id/transfer {userId, keepAccess}` (owner, audited `chat.thread.transfer`): the
  thread, its cards (open ones dismissed: they were prepared with the old owner's permissions), its attachments move to
  the new owner; the old owner's pins / groups / tags / user-scope search vectors of it are removed and the thread is
  re-indexed for the new owner; active watches end ("conversation handed over"); pending question cards are cancelled;
  with `keepAccess` the old owner stays as a reader. Turns stay with who used them (usage accounting).
- Candidates: `GET /chat/share/users?q=` — active users (id, username) matching the text, never the caller.

## 5. Dictation

Composer mic button over the browser's `SpeechRecognition` / `webkitSpeechRecognition` (Chrome, Edge, Safari):
`lang` from the UI language (`tr-TR` / `en-US`), `interimResults` shown live in the field, final text kept, Stop
ends it; the button is not rendered where the API is missing. Audio is handled by the browser's own engine (Chrome
sends it to its speech service; the console never receives audio). Headers: neither the master (helmet) nor the web
image sets `Permissions-Policy`, so the microphone keeps the browser default (`self` for the top-level console) — no
header change; the CSP does not govern the browser's own recognition service.

## 6. Assistant read tools (worker release)

- `read_job_log {jobId, source?: log|events, stream?, eventKind?, query?, latestFirst?, cursor?, limit?}` — the job's
  stored log chunks or agent events, redacted (the live store's read-time pass + the chat redactor), paged with a
  cursor, newest first by default, for running and finished jobs; `jobs.read` in the job's project (invisible → not
  found).
- `read_job_diff {jobId, file?, offset?, limit?}` — changed files (path, status, +/-) of the job's verified branch vs
  its base and the unified diff of a page of files (or one file), capped at 40 KB per call; only once the platform
  verified the branch (otherwise it says why); same permission.
- `list_site_upload_files {uploadId, offset?, limit?}` — every path (and size) of a site upload, paged (the turn
  context keeps the first 25 and says to page on).
- Rule 37: diagnose from the log / diff instead of guessing.

## 7. Small items

- The job page's cancel dialog and the chat image lightbox use `DyDialog` and the i18n catalog.
- The chat `.zip` chip defaults to the conversation's own project (thread project), then the remembered one, then the
  first.

## 8. Security

- Edit / regenerate / retry / export / share / transfer are owner actions on the caller's own conversation (a
  reader's attempt is 404 like any foreign thread); CSRF on every write; audits for edit, regenerate, retry, export,
  share, unshare, transfer.
- A shared reader never gains a permission: every card / link / mention is checked for the reader. The reader's live
  stream carries rows (draft, message, tool, thread, watch events) only as a bare signal; the console re-reads the
  filtered thread through REST, so a card payload of a project the reader cannot read never reaches them.
- The restart re-run uses only stored inputs (the user's message, its context rebuilt as the sender) and never a
  turn that acted.
- New tools are read-only and check `jobs.read` / `deploy.read` per call; output is redacted and fenced as data.

## 9. Rollback

Additive. An older master ignores the new columns (superseded rows would show again and reach the history) and the
shares table (readers lose access). To drop: `DROP TABLE chat_thread_shares; ALTER TABLE chat_messages DROP COLUMN
superseded_at, DROP COLUMN superseded_by; ALTER TABLE chat_turns DROP COLUMN message_id, DROP COLUMN actions, DROP
COLUMN runner, DROP COLUMN origin;`.

## 10. Tests

Master integration (`chat-complete.test.ts`, `chat-restart.test.ts`, real Postgres, real worker on fake engines):
edit forks, regenerate with another engine / model, retry, `409 turn_acted` then acknowledged, restart re-run once with
two replicas recovering concurrently (and not after an action), export content and redaction, share read-only +
per-resource filtering, transfer + audit, `read_job_log` / `read_job_diff` / `list_site_upload_files` permission and
paging. Web: edit / regenerate / retry controls, acted dialog, superseded fold, export menu and print view, share
dialog, shared section, mic states with a mocked SpeechRecognition, DyDialog replacements, zip project default.
Protocol: tool schemas.
