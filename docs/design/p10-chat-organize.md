# p10-chat-organize — pin, group and tag conversations; star messages; the chat's right sidebar

Status: implemented (2026-10-18). Owner request (batch 2026-10-18): organise the conversation list (pins, user-defined
groups, coloured tags), star messages inside a conversation, and a right sidebar with quick access to what a conversation
produced (starred messages, media, links, files, jobs / work created). Within
[ADR-0018](../adr/0018-ops-chat-assistant-on-worker.md) (threads private per user); no new ADR. Migration
`0080_chat_organize.sql` (renumber at merge if a parallel change took the number). Master + web deploy; no worker release
(the assistant and its tools do not change).

## 1. Data (migration 0080)

All organisation is **per user** and keyed by (thread, user) like `chat_thread_reads` (p9-chat-unread), so it stays
private if threads are ever shared; today every query also filters on `chat_threads.user_id = caller`.

| Table | Key | Notes |
| --- | --- | --- |
| `chat_thread_pins` | (thread, user) | `pinned_at`; at most **20** pins per user (409 `too_many_pins`) |
| `chat_groups` | id; unique (user, lower(name)) | name 1–60, `position`, `collapsed`; at most **50** per user |
| `chat_thread_groups` | (thread, user) | a thread is in **at most one** group; composite FK (user, group) → `chat_groups (user_id, id)` so a row can never point at another user's group; deleting a group ungroups its threads |
| `chat_tags` | id; unique (user, lower(name)) | name 1–40, `color` from a fixed palette of 9 names (no free CSS); at most **100** per user |
| `chat_thread_tags` | (thread, tag) | composite FK (user, tag) → `chat_tags (user_id, id)`; at most **10** tags per thread |
| `chat_message_stars` | (message, user) | `thread_id`, `starred_at`; only `user` / `assistant` messages; at most **2 000** per user |

Everything cascades with the thread, the message, the group / tag and the user.

## 2. API (all `chat.use`, the caller's own conversations only)

Reads:

- `GET /chat/threads` — unchanged default (newest activity first, keyset "Load more"). Each row gains `pinnedAt`,
  `groupId`, `tagIds`; the response gains `organize: {groups, tags, pinned}` (the caller's groups with thread counts,
  tags with counts, number of pins) so the console needs no extra request. New optional filters that combine with `q`,
  `archived` and the cursor: `pinned=true|false`, `group=<id>|none`, `tag=<id>`. `pinned=true` returns the pinned
  section ordered by pin time (newest pin first, ≤ 20, no cursor).
- `GET /chat/threads/:id` gains `starred: string[]` (ids of the caller's starred messages in that conversation).
- `GET /chat/organize` — groups and tags alone (the dialogs).
- `GET /chat/threads/:id/assets?kind=starred|media|links|files|jobs` and `GET /chat/assets?kind=…` (all the caller's
  conversations) — the sidebar; keyset-paged (`limit` ≤ 50, opaque cursor bound to the kind and scope).

Writes (CSRF, rate limited 120/min per user, bucket `chat-organize`; no audit: personal organisation, like read state):

- `PUT /chat/threads/:id/pin {pinned}`, `PUT /chat/threads/:id/group {groupId|null}`, `PUT /chat/threads/:id/tags
  {tagIds}` (replaces the set), `PUT /chat/messages/:id/star {starred}`.
- `POST /chat/groups`, `PATCH /chat/groups/:id {name?, collapsed?, position?}`, `DELETE /chat/groups/:id`;
  `POST /chat/tags`, `PATCH /chat/tags/:id {name?, color?}`, `DELETE /chat/tags/:id`.

Another user's thread, message, group or tag is a **404** (same message as a missing one — no oracle). A group or tag id
in a body that the caller does not own is a 404 too; the composite foreign keys enforce it again in the database.

## 3. Sidebar aggregation (read model, no new copies)

| Kind | Source | Jump target |
| --- | --- | --- |
| starred | `chat_message_stars` ⨝ `chat_messages` (snippet ≤ 200 chars) | the message |
| media | sent image attachments (`chat_attachments`), and image artifacts of jobs this conversation created | the message that carried it / the draft's tool line |
| files | sent PDF / text attachments, and the other output artifacts of those jobs (not pruned) | as above |
| links | `http(s)` URLs in user / assistant messages, extracted by Postgres (`regexp_matches`, ≤ 50 per message), deduplicated per page (the console dedupes across pages), with the domain | the newest message that has it |
| jobs | the conversation's drafts of kinds job, workflow_run, automation(_change), ops_action, machine_task, tool_install, monitor, job_resume, skill — with the draft state and, once confirmed, the live state of the job / run / automation / deploy it created | the draft's tool line |

Bounds: a page reads at most 50 items; links scan at most 5 windows of 200 messages per request. Job state and job
artifacts are shown only when the caller can still read the project (`jobs.read` on the row's project) — a revoked
project shows the draft without its live state and without its files. Artifact URLs are the existing
`/jobs/:id/artifacts/:artifactId` routes (which re-check `jobs.read`).

## 4. Console

- **List.** The default list keeps its request (`GET /chat/threads`): pinned conversations come in their own section at
  the top (fetched with `pinned=true` only when `organize.pinned > 0`), then one collapsible section per group (fetched
  with `group=<id>&pinned=false` while expanded, with its own "Load more"), then the rest of the stream (rows that are
  pinned or grouped are shown in their section only). A search, a tag filter or "Show archived" switch to one flat
  filtered list where rows show their pin, group and tag chips. Unread counts (p9-chat-unread) appear in every section.
- **Moving.** Drag a conversation onto a group header (or "No group") on desktop; everywhere (phones) the "⋯" menu has
  Pin / Unpin, "Move to group…" and "Tags…" — dialogs with large tap targets. Tag management (create / rename / recolour
  / delete) is under "Tags" next to the filter.
- **Stars.** A star button in each user / assistant message's action row (visible on hover / focus, always on touch;
  `aria-pressed`, keyboard reachable); a long press on a message (touch) toggles it too.
- **Sidebar.** A "Details" button in the conversation's top bar opens the right sidebar; **closed by default**, the
  open / closed choice is remembered per user in `localStorage` (`remyral.chat.sidebar.<userId>`, read and written in
  try/catch). Tabs: Starred, Media, Links, Files, Jobs; a toggle "All my conversations". Each item jumps to its message
  (earlier messages are revealed; another conversation is opened first) and briefly highlights it. On phones the sidebar
  is a full-screen sheet with a close button; Escape closes it.

## 5. Assistant

No new tools. The assistant's thread-related tools (`list_threads`-like lookups do not exist; mentions of `thread` resolve
only the sender's own conversations) never read the organisation tables, so another user's pins, groups, tags or stars
cannot reach a model. A test pins this (`chat-organize.test.ts`, "assistant mentions").

## 6. Security review

- Privacy: every query filters by the caller; composite FKs make a cross-user group / tag reference impossible even for
  a buggy query; 404 for foreign ids. Tested across two users.
- Input: names are trimmed, control characters removed, length-checked; colours are a closed enum (no CSS injection);
  ids are UUIDs (Zod). Limits on pins, groups, tags, tags per thread, stars.
- Abuse: writes rate limited per user; reads bounded (page ≤ 50, link scan windows bounded).
- Links: shown as text + domain, opened with `rel="noopener noreferrer nofollow"` and `target="_blank"`; only `http(s)`
  survives parsing (no `javascript:`); external images are never loaded (media shows only same-origin attachments and
  artifacts).
- No secrets are added; no audit rows (personal organisation, consistent with read state).

## 7. Rollback

Forward-only migration; rolling back the code leaves the tables unused (older masters ignore them; the console's extra
fields are optional). Dropping the six tables removes the feature's data only.
