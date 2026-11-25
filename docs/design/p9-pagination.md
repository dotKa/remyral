# p9-pagination — every list screen pages

Status: implemented (2026-10-17). Owner request: "list screens must have pagination." Migration
`0073_list_pagination.sql` (two indexes). No protocol, worker or assistant-tool contract change.

## 1. Inventory (before)

| Screen | Endpoint | Before |
| --- | --- | --- |
| Jobs → All jobs | `GET /jobs` | keyset cursor (50), "Load more" |
| Jobs → Queue | `GET /queue` | whole queue (bounded by the queued jobs; drag-and-drop reorder needs it whole) |
| Audit | `GET /audit` | keyset cursor (50), "Load more" |
| Outputs | `GET /outputs` | limit/offset + total (30), "Show more" |
| Notifications (bell) | `GET /notifications` | keyset cursor, only the first 20 shown |
| Automation runs | `GET /automations/:id/runs` | `limit` + `before` timestamp, no cursor |
| Uptime checks / incidents | `GET /uptime/monitors/:id/checks`, `…/incidents` | `limit` only (newest N) |
| Uptime monitors | `GET /uptime/monitors` | `limit` ≤ 200 (up to 500 monitors exist: some unreachable) |
| Deploys (ops actions) | `GET /deploy/actions` | `limit` ≤ 200 only |
| Approvals | `GET /approvals` | `limit` ≤ 500 only (default 100) |
| Chat thread list | `GET /chat/threads` | first 100 only |
| Release update attempts | `GET /releases` | newest 100 attempts only |
| Users, Projects, Machines, Templates, Skills, Automations, Context, Credentials, Models, Schedules, project members | `GET /users`, `/projects`, `/workers`, `/templates`, `/skills`, `/automations`, `/context/docs`, `/vault/credentials`, `/models`, `/schedules`, `/projects/:id/members` | everything (bounded admin lists) |
| Trusted devices, routing rules, runtime policies, budgets, reports, deletion receipts | per-user / per-runtime / small | everything or a small `limit` (unchanged) |

## 2. API contract

One response shape for paged lists: `{ items, nextCursor?, total? }` (`apps/master/src/http/pagination.ts`). Existing
collection keys stay where clients depend on them (`workers`, `skills`, `attempts`), with the page fields next to them.

- **Keyset (cursor)** for append-heavy lists: jobs, audit, notifications, automation runs, uptime checks and incidents,
  ops actions, approvals, chat threads, release update attempts. Query `?limit=&cursor=`. The cursor is opaque
  (versioned base64url JSON, ≤ 512 chars) and carries the last row's sort key — timestamps as Postgres text with full
  microsecond precision (`to_json(ts) #>> '{}'`), never a JS `Date` — and its id; the next page is `(key, id) < (…)` in
  the list's order (`>` for the ascending pending-approvals order), so the id breaks ties and rows appended while
  someone pages never shift or repeat later pages. Each cursor names its list (`s`: `automations.runs`,
  `uptime.checks`, `approvals.pending`, …): a cursor of another list or another order is refused. A malformed or foreign
  cursor is `400 invalid_cursor`. No `total` (not cheap on these tables).
- **Offset** for bounded admin lists: `?limit=&offset=` (offset ≤ 100 000), response adds `total`. These services
  already load the whole list (already filtered by the caller's authorization) and their order is deterministic, so the
  slice is taken in memory; uptime monitors page in SQL (`count(*) OVER ()` for the total). **Without `limit`
  everything is returned**, exactly as before (worker, CLI, web pickers).
- **Caps** (`400` above): jobs 200, audit 200, notifications 100, runs 200, checks 500, incidents 200, ops actions 200,
  approvals 500, chat threads 200, release attempts 200, offset lists 500 (monitors 200).
- **Defaults** keep older clients' results: runs 50, checks 100, incidents 50, ops actions 50, approvals 100, threads 100,
  attempts 100; `GET /automations/:id/runs?before=` without a cursor still answers the old way.
- **Ordering fixes**: ops actions and approvals had no (or an ascending) id tie-breaker; chat threads ordered by
  `updated_at DESC, id ASC`. All keyset orders are now `(key DESC, id DESC)` (pending approvals `(expires_at, id)`
  ascending). A chat thread that gets a message while someone pages moves to the top (it is on the first page again).
- **Indexes** (migration 0073): `ops_actions (created_at DESC, id DESC)` and `approval_requests (created_at DESC, id
  DESC)` for the unscoped owner/admin reads; the other orders already have indexes (`jobs_created_keyset_idx`,
  `automation_runs_automation_idx`, `uptime_checks_monitor_idx`, `uptime_incidents_monitor_idx`, `chat_threads_user`,
  `worker_update_attempts_*`, `notifications`, `audit_events` by id).
- **Assistant tools** call the services directly (`list`, `runs`, `incidents`, `checks`, `listThreads` keep their
  signatures and bounded defaults); the paged variants are new methods (`runsPage`, `checksPage`, `incidentsPage`,
  `listPage`, `listThreadsPage`). No tool contract changed, so no worker release.

## 3. Authorization

Unchanged: every route keeps its `config.authz`; paging only narrows the rows the old query returned. Project-scoped
lists put the visibility filter in the same `WHERE` as the keyset condition, so a cursor never reaches another project's
rows (tested: a viewer of one project pages through that project's ops actions, approvals and monitors only, with that
project's total). Cursors carry no authority — a forged cursor only moves the start position inside the caller's own
result and is validated (regex + timestamp/uuid/bigint shape) before it is bound as a parameter, never interpolated.

## 4. Web

- `components/Pagination.tsx`: one bar for every list — "Showing a–b of n" (or "Showing a–b" when the total is
  unknown), "Page x of y" / "Page x", Previous / Next (First / Last where useful), a "Rows" select (25 / 50 / 100). Real
  buttons with accessible names, an `aria-live` summary, 44 px targets and wrapping on phones. It renders nothing for a
  list that fits on one page of 25.
- `lib/pager.ts`: the position lives in the URL — `?page=&pageSize=` (offset and client lists) or `?cursor=&page=`
  (keyset lists; `page` is the number shown) — so pages can be linked, reloaded and stepped with back / forward. Two lists
  on one screen use a prefix (`?checksCursor=…&incidentsPage=…`). A filter change resets to page 1 (`withoutPage` in
  the filter's own URL update, or `list.reset()` for filters kept in component state); the page size is kept. Keyset
  "Previous" uses the earlier pages' cursors kept in the history entry's state; a page opened from a link goes back to
  page 1. An `invalid_cursor` answer (old link, other filters) restarts at page 1.
  - `useCursorList` (server keyset lists; optional background refresh of page 1 only — Jobs keeps its 15 s refresh),
    `useOffsetList` (server offset lists with total), `useClientPage` (bounded lists the screen already has whole and
    filters / searches in the browser — paging happens after the filter, so the pages match what is shown).
- Screens: Jobs (keyset, 50 per page as before), Audit (keyset, 50), Outputs (offset with total, replaces "Show more"),
  automation runs, uptime monitors (offset), monitor checks and incidents (keyset, prefixed), Deploys, Approvals, release
  update attempts (keyset); Users, Projects, Machines, Templates, Automations, Skills, Context, Credentials, Models, vault
  keys, Context versions and receipts, Usage tables, project members (client pages).
- Streams keep "Load more": the chat thread list (appends the next 100; a refresh after a new message re-reads as many
  as were shown, up to 200) and the notification bell (appends 20 older ones). Chat messages keep "Show earlier
  messages".
- Details: Projects fetches per-project machine counts only for the shown page; uptime status counts still cover the
  whole filtered list (one `limit=1` request per status reads its `total` when the list spans pages); the Deploys
  "N actions wait for approval" notice has its own request; Approvals pages each tab separately (`pending` /
  `decided` prefixes) — the Decided tab reads the unfiltered newest-first list and hides pending rows, so a page can
  hold fewer than 25 (a master `status=decided` filter would fix it; follow-up); column sorting in a DataTable orders
  the rows of the shown page, so screens with a default name order sort the whole list before paging;
  `lib/pageReset.ts` (`useResetPageOn`) resets to page 1 when a filter in component state changes but keeps a linked
  `?page=` on first render.
- Not paged: trusted devices (at most 10 per user), the machine history timeline (a stream with "Show more"), the
  workflow runs strip on Jobs (`GET /workflows` has no paging; shows the 10 most recent), Jobs → Queue (owned by p9-queue-priority; drag-and-drop reorder works on the whole queue, which is bounded
  by the queued jobs), the Outputs tree's per-node "Show more" (a tree, not a list), small fixed lists.

## 5. Tests

- Master integration `test/integration/pagination.test.ts`: every changed keyset endpoint walks all pages with a small
  limit and matches the SQL order (equal sort keys broken by id), a row appended between pages does not shift later pages,
  caps → 400, malformed and foreign-list cursors → 400 `invalid_cursor`, old no-parameter defaults, offset lists page
  with a stable total, authorization unchanged (viewer: 403 on users, 404 on another project's actions, own project's
  rows and totals only). Unit `test/unit/pagination.test.ts` for the helpers.
- Web: the component (rendering, keyboard, sizes, URL), Jobs / Audit / Outputs / automation runs / uptime checks /
  deploys paging, client paging on Users and Projects, chat and notification "Load more".

## 6. Rollback

Revert the commit; migration 0073 only adds two indexes (harmless if left). Clients that send no page parameters see
the same results before and after.
