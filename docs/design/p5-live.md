# Design note: live job view — events, logs, read-only terminal, artifacts/diff, cancel (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p5-live (acceptance A-UX-2: real-time logs are ordered, searchable and safely redacted; A-UX-1:
  supervise and cancel from a phone)
- **Decisions applied:** ADR-0003 (Postgres is the source of truth), ADR-0004 (fencing, at-least-once
  delivery, idempotency), ADR-0006 §4 (two-stage redaction: worker exact-value + master pattern pass),
  ADR-0009 (sessions, step-up for privileged actions), ADR-0011 (additive within protocol 1.0)
- **Builds on:** [p2-transport.md](p2-transport.md) (sequenced worker messages, replay, per-worker `seq`),
  [p4-orchestration.md](p4-orchestration.md) (OrchestrationInbox fences EVENT / LOG_CHUNK / ARTIFACT_REF),
  [p4-approvals.md](p4-approvals.md) (approvals and the step-up decide flow),
  [p4-git-flow.md](p4-git-flow.md) (verified attempt branch, base/head shas), [p5-rbac.md](p5-rbac.md),
  [p5-search-audit.md](p5-search-audit.md) (trigram search, LIKE escaping, keyset cursors)
- **Threat model:** T-INJ-4 (hostile text / escape sequences in the dashboard), T-SEC-1 (secrets in logs,
  events, artifacts), T-CP-3 (cross-project disclosure), T-CP-5-style resource exhaustion of the API
  (security review §9)

## 1. Scope

| Piece | Where |
| --- | --- |
| Migration: `job_events`, `job_log_chunks`, `job_live_heads` | `apps/master/migrations/0019_live.sql` |
| Master redaction pass + chunk-boundary carry | `apps/master/src/live/redact.ts` |
| Store (append-only writes inside the inbox transaction, reads, search, retention) | `apps/master/src/live/store.ts` |
| Wake-up bus (Postgres `LISTEN/NOTIFY` + poll fallback) | `apps/master/src/live/bus.ts` |
| SSE stream (backfill → live tail, heartbeats, lag cut-off, connection limits) | `apps/master/src/live/stream.ts` |
| REST routes | `apps/master/src/live/routes.ts` |
| Wiring | `OrchestrationInbox` gets an optional `live` sink; `compose.ts` builds the store/bus/routes |
| Diff content | optional `GitProvider.patch()` (local + GitHub), `GitFlowService.patch()` |
| Console | `apps/web/src/screens/live/*` (panel, events, logs, terminal, artifacts/diff, cancel), `apps/web/src/lib/ansi.ts`, `apps/web/src/api/live.ts` |

Interactive terminal input is **not** part of this task (a later ADR). The "terminal" here is a read-only
view of the runtime's output streams.

## 2. What arrives and what was stored before

Workers send `EVENT` (normalized `AgentEvent`), `LOG_CHUNK` (`stream` ∈ stdout/stderr/runtime, per-stream
`chunkSeq`, ≤ 64 KiB, asserted `redacted: true`) and `ARTIFACT_REF` (name, media type, size, sha256 —
metadata only; `attempt.diff` is the content address of the pushed attempt diff) as sequenced messages.
The master's replay layer processes them exactly once per `(worker, seq)` in seq order, and the
`OrchestrationInbox` fences them: data messages are accepted for the job's `live` or `closed` lease of that
worker and refused (`stale`) otherwise. Until now the only copy was the raw `worker_inbox` journal (JSON
payload, worker-side redaction only, no ordering index per job, no search, no retention).

## 3. Persistence (migration 0019)

- **`job_live_heads (job_id, head)`** — a per-job counter. Every live row takes `head + 1` with
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`. The row lock is held until the inbox transaction commits,
  so per job the **stream sequence becomes visible in strictly increasing order** (a smaller value is
  always committed before a larger one is handed out). That is what makes `Last-Event-ID` resume gap-free
  — the same argument as the audit chain ids in p5-search-audit §3.
- **`job_events`** — append-only: `job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq,
  message_id, stream_seq, kind, payload jsonb (redacted), ts (worker envelope time), received_at,
  size_bytes`. `kind` ∈ the AgentEvent kinds + `artifact` (ARTIFACT_REF metadata) + `notice` (master
  markers such as "log limit reached"). Dedupe: `UNIQUE (job_id, message_id)` — a replayed or re-sent
  message (same messageId) is a no-op.
- **`job_log_chunks`** — append-only: `job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq,
  stream, chunk_seq, stream_seq, ts, received_at, text (redacted), size_bytes`. Dedupe:
  `UNIQUE (attempt_id, stream, chunk_seq)` (`ON CONFLICT DO NOTHING`) — a duplicate chunk under a
  different message id (worker restart re-sending its tail) is still dropped. GIN trigram index on `text`.
- **Order.** The canonical order of a job's output is `(attempt_no, worker_seq, chunk_seq)`; within one
  attempt the worker's outbox seq is the order the runtime produced it. The stream sequence is the
  *arrival* order (what the live tail appends); the REST API and the console sort by the canonical key,
  so a chunk that arrived late (out of order) lands at its place after a reload and is inserted in place
  by the console (it sorts its buffer by the canonical key).
- **Only accepted data is stored**: rows are written by the inbox inside the replay transaction, only when
  the fence outcome is `applied` (live/closed lease of that worker). Stale-epoch output (a zombie worker)
  is journaled in `worker_inbox` as before but never reaches the live view.
- **Per-job budget**: `maxLogBytesPerJob` (default 64 MiB). Beyond it chunks are not stored; one
  `notice` event `log_limit_reached` is stored instead (the worker's own journal still has them for 7-day
  forensics). Events are capped at 50 000 per job the same way.
- **Retention hook**: `LiveStore.purge(now, {retentionDays, batch})` deletes events/chunks of jobs whose
  state is terminal (`SUCCEEDED`, `FAILED`, `CANCELLED`) and unchanged for `retentionDays` (default 30) in
  bounded batches; `liveRetentionDays` / `liveSweepIntervalMs` in `MasterDeps` run it periodically (off by
  default, like the other sweepers). Jobs under a legal hold are out of scope (no such concept for jobs yet).

## 4. Master-side redaction (ADR-0006 second stage, T-SEC-1)

Before anything is stored the master runs the observability `Redactor` with the **pattern rules only**
(it never knows exact secret values — they stay on the worker):

- `LOG_CHUNK.data` → `Redactor.redact`. A secret split across two chunks of the same stream is caught by
  a **carry window**: the tail (`lookbehind()` characters) of the previous stored chunk of that
  `(attempt, stream)` is concatenated in front of the new text, spans are computed on the joined text, the
  new chunk gets its part replaced and, if a span starts in the previous chunk, the previous row is
  rewritten too (`UPDATE … SET text`), inside the same transaction. A live viewer may already have seen the
  first half of such a split token (a prefix of at most the chunk tail); a reload shows it redacted.
  Documented residual (§9).
- `EVENT.event` and `ARTIFACT_REF` → `redactDeep` (every string, sensitive keys replaced). Strings are
  additionally bounded (8 KiB per field for summaries; 64 KiB for message/memory text).
- The read routes pass every response through the same redactor again (defence in depth, as
  `GET /jobs/:id` does), so rows written before a rule was added are covered at read time.
- The `redacted: true` assertion of the worker is kept as a protocol invariant; the master does not trust
  it, it re-checks.

Canary test: a GitHub token that "slipped past" the worker (worker exact-value set did not contain it) is
sent as a LOG_CHUNK, split across two chunks, and as an event; it is absent from `job_log_chunks`,
`job_events`, the SSE stream and the search API, and `[REDACTED:github-token]` is present.

## 5. Live stream API — Server-Sent Events

`GET /jobs/:id/stream` (`jobs.read` with project scoping, like `GET /jobs/:id`; unknown and invisible jobs
are both 404).

**Why SSE and not WebSocket.** The stream is one-directional (the console sends commands through the
ordinary REST routes with CSRF and step-up); SSE is plain HTTP, so it goes through the reverse proxy, the
session cookie, the global auth/authz hooks and the CSP `connect-src 'self'` unchanged; `EventSource`
reconnects by itself and sends `Last-Event-ID`, which gives resume for free; there is no second
authentication path to secure (the worker WebSocket stays the only WS endpoint, and `canvas-dev`'s `/oh/*`
proxy is unaffected). Costs: one HTTP/1.1 connection per open job view (bounded, below) and text-only
frames, both acceptable.

Protocol:

- `id: <stream_seq>` on every data frame; `event: log | event | job | behind | bye`; `data:` one JSON
  object; `retry: 3000` once. Comments (`: hb`) every 15 s as heartbeat (keeps proxies from timing out).
- Resume: `Last-Event-ID` header (EventSource reconnect) or `?after=` (first connect after a REST
  backfill). Without either, the stream starts at the current head (no history: the console loads history
  through the REST routes first, then opens the stream after the head it has).
- **Backfill then live tail**: rows with `stream_seq > cursor` are read in pages of 200 (logs and events
  merged by stream_seq); then the connection waits for a wake-up from the bus (or the 2 s poll fallback)
  and reads again.
- **Backpressure without unbounded buffers**: the stream is pull-based — the next page is read only after
  the socket drained (`write()` returned true or `drain` fired). If the client is more than `maxLag`
  (default 2 000) rows behind the head — whether at connect (huge gap) or because it reads too slowly — the
  server sends `event: behind` with `{head}` and closes; the console then shows "You are behind — reload"
  and re-fetches through REST. Nothing is buffered per connection beyond one page.
- **Job state**: on every wake-up the job's `(state, version)` is compared and `event: job` sent on
  change (drives the state badge and the Cancel button).
- **Limits**: per user `maxPerUser` (default 6) concurrent streams per master process, global
  `maxTotal` (default 500); over the limit → `429 too_many_streams` (JSON, before hijack). A stream lives
  at most `maxAgeMs` (default 10 min) then sends `event: bye` and closes; EventSource reconnects with
  `Last-Event-ID`, which re-runs authentication and authorization (a revoked session or a removed
  project membership ends the view within that period).
- **Headers**: the route hijacks the reply, so the global `onSend` hook does not run; the stream writes
  `content-type: text/event-stream; charset=utf-8`, `cache-control: no-store`, `x-accel-buffering: no`,
  `x-content-type-options: nosniff` and the helmet headers it already set in `onRequest`.

`GET /jobs/:id/live` — summary: head stream seq, counts, attempts, artifact list and whether the
"terminal" view is supported (the runtime's `streaming` capability on the attempt's worker is `supported`
or `degraded`).

`GET /jobs/:id/logs?q=&stream=&attempt=&cursor=&limit=&tail=` — chunks in canonical order, keyset cursor
over `(attempt_no, worker_seq, chunk_seq)`; `tail=1` returns the last `limit` chunks (still ascending).
`q`: up to 8 whitespace-separated terms, each a case-insensitive substring (`ILIKE` with escaped `%_\`,
trigram index for terms ≥ 3 characters), `statement_timeout` 5 s, `limit` ≤ 500. Searching inside one chunk
only (a term split across chunks is not found — documented).

`GET /jobs/:id/events?kind=&cursor=&limit=&tail=` — events in canonical order (`tail=1`: the last ones); `approval_request` events are
joined with `approval_requests` (`job_id, attempt_id, approval_key`) to add the master's request id,
status and step-up flag, so the console can decide inline.

`GET /jobs/:id/diff` — the verified attempt diff (`base_sha...head_sha` from `job_git`) as text, ≤ 1 MiB
(`truncated` flag), pattern-redacted, through the project's git provider (`GitProvider.patch`, new and
optional). 404 `diff_unavailable` when the job has no verified git flow record or the provider has no
patch support. Never executed or rendered as markup.

## 6. Console (mobile first)

Job detail gets a **Live** card above the static sections: state badge, a full-width **Cancel job**
button (operator+, confirm dialog with a required reason → `POST /jobs/:id/cancel`; shown only in
cancellable states) and tabs:

- **Events** — timeline of normalized AgentEvents: messages (role, text), tool calls / results paired by
  `callId` and collapsible, status phases, usage increments, errors, artifacts; `approval_request` shows
  risk and description with inline **Approve / Deny** that use the existing `approveRequest/denyRequest`
  + step-up flow (reason required for deny), or a link to the Approvals inbox when already decided.
- **Logs** — virtualized line list (fixed row height, only the visible window plus overscan is in the
  DOM), stream filter, search box (server search; matching chunks), **Follow** toggle (auto-scroll; turns
  off when the user scrolls up), **Copy** (plain text of the visible filter, ANSI stripped).
- **Terminal** (when supported) — the same data as a read-only terminal: stdout + stderr interleaved,
  monospace on a dark surface, SGR colours, no input element.
- **Artifacts** — ARTIFACT_REF list (name, media type, size, sha256) and for `attempt.diff` a **View
  diff** that loads `/jobs/:id/diff` into a safe diff viewer (per-line classes for `+`/`-`/`@@`, text only).

**ANSI handling (`lib/ansi.ts`)** — a strict parser that turns text into `{text, style}` segments:

- Recognised and applied: **SGR only** (`ESC [ … m`) with parameters 0, 1, 2, 3, 4, 22, 23, 24, 30–37,
  39, 40–47, 49, 90–97, 100–107; 38/48 with `5;n` (n < 16) map onto the 16-colour palette, other 256/true
  colours are dropped. Styles become a fixed set of CSS classes (`ansi-fg-1` …), never inline styles or
  markup, so the CSP (`style-src 'self'`, no `unsafe-inline`) holds.
- Removed (never rendered, never interpreted): every other CSI sequence (cursor movement, erase, scroll
  regions, DEC private modes such as alternate screen / bracketed paste), **OSC** (`ESC ]` … BEL/ST —
  including OSC 52 clipboard writes, OSC 8 hyperlinks, title changes), DCS/SOS/PM/APC strings, single
  ESC sequences, C1 controls (0x80–0x9F, including 8-bit CSI/OSC), and C0 controls other than `\n` and
  `\t` (`\r` is treated as a line break for display; BEL, BS, etc. dropped). Unterminated sequences are
  discarded up to the end of the input (bounded scan, linear time).
- React renders the segments as text children of `<span className>`; there is no
  `dangerouslySetInnerHTML` anywhere in the panel (enforced by a test that greps the sources).

## 7. Tests

- `apps/master/test/unit/live.test.ts` (11) — pattern pass, carry window across chunks, deep events; SSE
  frame encoding (newlines in values cannot inject fields), Last-Event-ID parsing; patch cap.
- `apps/master/test/integration/live.test.ts` (8) — real master + Postgres, inbox driven through the real
  replay path by a real worker daemon (`sendSequenced`): ordering under out-of-order arrival and replay,
  dedupe (same messageId; same chunk under a new messageId), stale-epoch output not stored, canary secret
  that slipped past the worker (single and split) redacted in DB/stream/search, SSE backfill → live tail,
  resume with `Last-Event-ID`, `behind` marker, heartbeats, per-user connection limit (429), max age,
  authz and project scoping (viewer of another project → 404; no session → 401), search (`q`, stream,
  bounded limit), events with approval join, retention purge, the end-to-end fake runtime run.
- `apps/web/test/ansi.test.ts` (9) — SGR subset, OSC 52 / OSC 8 / CSI cursor / DEC private / DCS / C1 /
  8-bit CSI removed, unterminated sequences, HTML stays text.
- `apps/web/test/live.test.tsx` (14) — panel tabs, events timeline with tool call collapse, inline approve via
  step-up, deny reason, logs search/follow/copy, virtualization bounds, terminal, artifacts + diff viewer,
  cancel with confirm + reason, hostile text inert.
- `apps/web/e2e/live-csp.spec.ts` (Playwright, `csp` project) — a job with log lines containing
  `<script>`, an `<img onerror>` and an OSC 52 clipboard sequence renders under the master CSP: no script
  ran, no CSP violation, the clipboard was not written, the escape bytes are not in the DOM.

## 8. Rollback and operations

- Migration 0019 is additive (three new tables); rolling back the code leaves them unused. The worker
  protocol is unchanged.
- Metrics/logs: the stream logs open/close with `{jobId, userId, reason}` at debug, limit refusals at info;
  `LiveStore` logs dropped chunks over the budget once per job. Connection gauges are exposed through
  `app.live.stats()` (open streams total / per user) for the future metrics endpoint.
- Disk: bounded per job (64 MiB logs, 50 000 events) and by retention.

## 9. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| **T-INJ-4** hostile output in the dashboard (XSS, escape sequences) | Everything from runtimes/workers/repositories is rendered as React text; no `dangerouslySetInnerHTML` in the panel (source test); strict SGR-only ANSI parser removes OSC (incl. OSC 52 clipboard, OSC 8 links), cursor/erase CSI, DEC private modes, DCS/APC/PM/SOS, C1 and C0 controls; styles are class names from a fixed list; CSP `default-src 'self'`, no `unsafe-inline` (Playwright check with `<script>`, `onerror` and OSC 52); diff viewer renders lines as text; SSE `data:` is JSON (newlines cannot inject frames). | Visual spoofing inside the allowed SGR subset (e.g. fake "approved" text in green) — mitigated by rendering approvals from the master's own records, never from log text. |
| **T-SEC-1** secrets in logs/events/artifacts | Worker exact-value + stream redaction (unchanged) and the master pattern pass before storage, with a carry window across chunks; read-time redaction again; canary tests (single and split chunk, event, search, stream). Diff text is pattern-redacted. | Secrets that match no pattern and were not registered on the worker cannot be recognised (as before). A split token's first half may be streamed live before the second chunk arrives (rewritten in storage). |
| **T-CP-3** cross-project disclosure | Every route uses `jobs.read` with the job's project as resource (viewer+ member); invisible jobs are 404 like unknown ones; the stream re-authorizes at least every `maxAgeMs` (reconnect). | A membership removal takes effect for an open stream within 10 min. |
| Resource exhaustion (many streams, huge output) | Per-user and global stream limits (429), pull-based pages, lag cut-off (`behind`), heartbeats, max age, per-job storage budget, bounded search (`limit`, term count, `statement_timeout`), retention. | Limits are per master process (a multi-replica deployment multiplies them by the replica count). |
| Replay/duplicates corrupting the view (ADR-0004) | Writes happen in the replay transaction (exactly once per worker seq); `UNIQUE (job_id, message_id)` and `UNIQUE (attempt_id, stream, chunk_seq)`; only `applied` (fenced) data is stored. | — |
