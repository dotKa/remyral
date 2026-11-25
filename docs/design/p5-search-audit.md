# Design note: search, filters, audit explorer and export of task records (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p5-search-audit (acceptance A-UX-5, export half: "users can export task records"; context
  deletion per retention policy is a separate task)
- **Decisions applied:** ADR-0009 (roles, step-up for privileged actions), ADR-0006 §4 (redaction),
  ADR-0003/0004 (jobs, attempts, leases are read, never written)
- **Builds on:** [p1-master-auth.md](p1-master-auth.md) (audit hash chain), [p4-job-store.md](p4-job-store.md),
  [p4-approvals.md](p4-approvals.md)
- **Threat model:** T-OPS-3 (audit tampering / repudiation), T-SEC-1/2 (secrets in API responses and
  exports), T-CP-3 (broken authorization), T-CP-4 (SQL injection), T-INJ-4 (hostile text in the console)

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Query builder | `apps/master/src/audit/sql.ts` | Parameter collector (`$n` placeholders only), LIKE escaping, opaque keyset cursors. |
| Audit query | `apps/master/src/audit/query.ts` | `AuditQuery.list / get / verify / exportRows / chainHead`. Read-only. |
| Export machinery | `apps/master/src/audit/export.ts` | JSON Lines / CSV encoders, defence-in-depth redaction, running SHA-256, manifest, size limits, export audit events. |
| Audit routes | `apps/master/src/audit/routes.ts` | `GET /audit`, `GET /audit/events/:id`, `GET /audit/verify`, `GET /audit/export`. |
| Chain range check | `apps/master/src/audit/audit.ts` | `verifyChainRange()` (new); `verifyChain()` unchanged, now delegating to it. |
| Jobs read model | `apps/master/src/jobs/query.ts` | `JobQuery.list / detail / exportRecords` — reads only; no change to `JobStore` behaviour. |
| Jobs read routes | `apps/master/src/jobs/read-routes.ts` | `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/export`. |
| Migration | `apps/master/migrations/0008_search_audit.sql` | `pg_trgm`, search expression + trigram index, filter indexes. |
| Console | `apps/web/src/screens/AuditPage.tsx`, `JobsPage.tsx`, `records.tsx`, `apps/web/src/api/{audit,jobs,download}.ts` | Audit explorer, jobs list + detail, export download through the step-up dialog. |

## 2. Authorization (role model, ADR-0009)

| Route | owner | admin | operator | viewer | Extra |
| --- | --- | --- | --- | --- | --- |
| `GET /audit`, `GET /audit/events/:id` | ✓ | ✓ | 403 | 403 | — |
| `GET /audit/verify` | ✓ | ✓ | 403 | 403 | rate-limited, audited (`audit.verify`) |
| `GET /audit/export` | ✓ | ✓ | 403 | 403 | step-up ≤ 10 min, rate-limited, audited |
| `GET /jobs`, `GET /jobs/:id` | ✓ | ✓ | ✓ | ✓ | — |
| `GET /jobs/:id/export` | ✓ | ✓ | ✓ | 403 | step-up ≤ 10 min, rate-limited, audited |

The audit log reveals who did what across the whole installation (usernames, IPs, user agents), so it is
an owner/admin view. Job records are readable by every role (viewers supervise), but a bulk, portable copy
of a task record is a data-exfiltration step, so export needs at least `operator` and a fresh TOTP. All
denials (role, step-up, rate limit) of the privileged endpoints are written to the audit log with outcome
`denied`. Every route requires a full session (route-coverage test).

## 3. Audit search

### Filters

`from`/`to` (ISO timestamps, `occurred_at` half-open `[from, to)`), `actorType`, `actorId` (exact),
`action` (prefix, e.g. `auth.` or `job.transition`), `target` (exact), `outcome`, `q` (free text),
`limit` (1–200, default 50), `cursor`.

### Keyset pagination and stability

Results are ordered by `id DESC`. The cursor is the opaque base64url encoding of `{"v":1,"id":"<last id>"}`
and the next page is `id < $cursor`. This is stable under concurrent inserts by construction:
`AuditLog.append` allocates `nextval('audit_events_id_seq')` *while holding the chain's transaction-scoped
advisory lock*, so ids become visible in strictly increasing order (a smaller id is always committed before a
larger one is allocated). A row inserted while a user pages can only get an id above every id already seen,
so it never shifts, duplicates or hides rows on later pages — unlike `OFFSET`. The integration test pages
through the log while a concurrent writer appends and checks the union is exactly the initial snapshot.

### Free-text search: trigram, not full-text

`q` is split on whitespace into up to 8 terms; each term must occur (case-insensitive substring) in the
search text `action || ' ' || coalesce(actor_id, '') || ' ' || coalesce(target, '') || ' ' || metadata::text`
(the actor id is included so worker ids and user ids are findable), wrapped in the IMMUTABLE function
`audit_search_text(...)` so the expression index and the query use the identical expression.

Why `pg_trgm` + `ILIKE` and not `tsvector`:

- What people search for in an audit log are **identifiers**: UUIDs (or their first 8 characters), dotted
  actions (`auth.login.password`), worker ids (`mac-mini-01`), routes (`POST /approvals/…`), IPs. The text
  search parser splits and stems these (`auth.login.password` becomes one `host`-like token or several, UUID
  prefixes don't match a whole-UUID lexeme, `english` stemming changes `denied`), so prefix/infix lookups
  fail or need per-token `:*` tricks. Substring semantics are what users expect.
- A GIN trigram index serves `ILIKE '%term%'` for terms of ≥ 3 characters; shorter terms still work
  (sequential scan bounded by the other filters and `statement_timeout`).
- `pg_trgm` is a *trusted* extension since PostgreSQL 13, so a non-superuser database owner can create it
  (managed Postgres included). Verified available on the pinned `postgres:18.6` image.
- Ranking is not needed: results stay in id order (newest first), which is what an audit explorer shows.

Terms are bound as parameters and LIKE metacharacters (`\`, `%`, `_`) are escaped, so a term is always a
literal substring. Metadata is searched exactly as stored, i.e. **already redacted** at write time
(`redactMetadata`): a secret that never reached the table cannot be found or shown. The `metadata::text` form
also matches keys, which is useful (`q=reason`).

### Chain verification over a range

`GET /audit/verify?fromId=&toId=` (or `from`/`to` timestamps, resolved to the id range) runs
`verifyChainRange`: the expected `prev_hash` of the first row is the stored hash of its predecessor (or the
genesis hash at id 1), then every row's hash is recomputed in id order. It reports `ok`, `checked`, the range,
the head hash, and on failure `brokenAtId` + `reason` (`prev_hash_mismatch` | `hash_mismatch`). A range check
trusts the predecessor row; only a full check (no bounds) proves the chain from genesis. The run is audited
(`audit.verify`, outcome `success` or `failure`) and rate-limited (default 10 / min / user).

## 4. Jobs read API

- `GET /jobs?state=&project=&runtime=&worker=&from=&to=&limit=&cursor=` — `state` accepts a comma-separated
  list of job states; `runtime` matches `spec->>'runtime'`; `worker` matches jobs with any attempt on that
  worker; `from`/`to` bound `created_at`. Order `created_at DESC, id DESC`; the cursor carries both
  (`created_at` as Postgres text with microseconds, so no precision is lost in JavaScript). New jobs get
  `created_at = now()` and appear on page 1 only; keyset never skips or repeats rows already paged.
- `GET /jobs/:id` — job, **sanitised spec**, attempts, transition history, leases (epochs, holders, expiry,
  release reason; lease tokens are never stored), approval summary (each request with action, risk, status,
  votes) and dependencies.

**Spec sanitising** (defence in depth; the store validates specs but a user can still paste a token into
a prompt or a URL): credentials in `repository.url` (`https://user:token@host/...`) are removed, then the
whole spec goes through `@remyral/observability` `redactDeep` with the default pattern rules (GitHub/AWS/
Anthropic/OpenAI/Slack tokens, private keys, bearer headers, …).

## 5. Export

| | `GET /audit/export?format=jsonl\|csv&<audit filters>` | `GET /jobs/:id/export` |
| --- | --- | --- |
| Content | audit events matching the filters, ascending id, bounded above by the head id at start | one task record: `job`, `transition`*, `attempt`*, `lease`*, `approval`*, `approval_decision`*, `dependency`* lines |
| Formats | JSON Lines, CSV | JSON Lines |
| Limits | 100 000 records or 50 MiB body (whichever first) | 100 000 records or 50 MiB |

### Manifest

The last line of every export is the manifest; every byte before it is the body:

```json
{"type":"manifest","manifest":{"version":1,"kind":"audit","format":"jsonl","generated_at":"…","generated_by":"<user id>","filters":{…},"record_count":123,"body_bytes":45678,"sha256":"<hex of body>","truncated":false,"next_cursor":null,"redacted_records":0,"chain_head":{"id":"…","hash":"…"}}}
```

In CSV the manifest is the single line `#manifest,<the same JSON, CSV-quoted>`. Verification:
`head -n -1 export.jsonl | sha256sum` equals `sha256`. The manifest is written only after the last record,
so **a download without a manifest line is incomplete** (connection lost or a server error mid-stream).

- **Streamed:** rows are read in keyset batches of 500 and encoded into a Node `Readable`; memory is bounded
  by one batch. Audit exports are bounded above by the head id captured at the start (stable snapshot without
  a long transaction).
- **Size-limited:** when a limit is reached the export stops, sets `truncated: true` and gives
  `next_cursor`, which continues the export (`cursor=` parameter, ascending). A single task record is far
  below the limits; if one ever exceeds them the job export reports `truncated: true` without a
  continuation cursor.
- **Rate-limited:** 20 exports per 10 minutes per user (Redis, shared by replicas; fails closed).
- **Step-up required:** the session's last TOTP must be ≤ 10 minutes old (`403 step_up_required`).
- **Audited (fail-closed):** `audit.export.started` / `job.export.started` (filters, format) is written
  *before* the first byte; if that write fails nothing is exported. `….completed` carries the manifest
  (count, bytes, SHA-256, truncation) and `….failed` is written if the stream breaks. Denials are
  `audit.export` / `job.export` with outcome `denied` and a reason.
- **No secrets:** every record passes through `redactDeep` (default pattern rules, key-based redaction)
  before encoding; the number of records it changed is reported as `redacted_records`. Audit metadata is
  already key-redacted at write time; job specs are sanitised as in §4. For audit rows `prev_hash`/`hash`
  are included (hex) so an export can be checked against the chain; a row changed by the export-time
  redaction will no longer hash to its stored value, which `redacted_records` makes explicit.
- **CSV formula injection:** cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`
  (audit targets and user agents are attacker-influenced). Quotes are doubled, every cell is quoted.

## 6. Console

- **Audit** (`/audit`): filter bar (time range, actor type/id, action prefix, target, outcome, free text),
  results as a table on wide screens and stacked cards on phones, keyset "Load more", a detail drawer with
  the redacted metadata as escaped JSON (`<pre>`, text only), **Verify chain** (reports the first broken
  link) and **Export** (JSON Lines / CSV) through the step-up dialog. Operators and viewers see a
  "requires owner or admin" notice instead of the explorer.
- **Jobs** (`/jobs`, `/jobs/:id`): filter bar (state, project, runtime, worker), list with "Load more",
  detail with the transition timeline, attempts, leases, approvals, the sanitised spec, and **Export task
  record** (operator+, step-up).
- Downloads are fetched with `fetch` (so `403 step_up_required` can trigger the dialog and retry), turned into
  a `Blob` and saved via an object URL; nothing is rendered as HTML.

## 7. Migration 0008

`CREATE EXTENSION IF NOT EXISTS pg_trgm`; IMMUTABLE `audit_search_text(action, actor_id, target, metadata)`;
`GIN (audit_search_text(...) gin_trgm_ops)`; `audit_events (target, id)`, `audit_events (outcome, id)`;
`jobs (created_at DESC, id DESC)`, `jobs ((spec->>'runtime'), created_at)`, `job_attempts (worker_id, job_id)`.
Indexes are built inside the migration transaction (not `CONCURRENTLY`); tables are small at this stage.
Rollback: forward-only runner — a follow-up migration drops the indexes/function; the extension can stay.

## 8. Tests

- Unit (`test/unit/search-audit.test.ts`): parameter builder never interpolates values (hostile inputs
  `'; DROP TABLE …`, `%`, `_`, `\`, NUL appear only in the parameter array), LIKE escaping, cursor encode/decode
  and tamper rejection, CSV quoting + formula neutralisation, manifest hash, redaction of tokens.
- Integration on real Postgres (`test/integration/search-audit.test.ts`): filters, search (incl. UUID prefix
  and LIKE metacharacters as literals), pagination stability with a concurrent writer, verify (ok, range,
  tampered row detected via a trigger-bypassing session), authz matrix (owner/admin/operator/viewer per route),
  step-up required, export manifest hash = SHA-256 of the body, truncation + continuation, export audited
  (started + completed with the same hash), rate limit, no secret in job export/detail.
- Web (`apps/web/test/audit.test.tsx`, `jobs.test.tsx`): filter → request query, load more, drawer shows
  escaped metadata, verify result, export with step-up retry, role notice; jobs list/detail timeline.

## 9. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| T-CP-4 SQL injection via filters/search/cursor | One builder; only `$n` placeholders; static SQL fragments; Zod validation of every query parameter (enums, lengths, ISO timestamps, UUIDs); LIKE metacharacters escaped; cursors are validated JSON, never SQL. Unit test asserts hostile strings appear only in params. | — |
| T-CP-3 broken authz | Role check inside each handler before any query; matrix tested per route and role; detail routes reveal the same data as list routes for the same role. | Since p5-rbac-api: roles come from the central `config.authz` rules and jobs are scoped to the caller's project memberships ([p5-rbac.md](p5-rbac.md)). |
| T-SEC-1/2 secrets in responses/exports | Audit metadata redacted at write; exports and job detail pass `redactDeep` (pattern rules) again; repository URL credentials stripped; lease tokens never stored; canary test. | Pattern redaction cannot catch unknown secret formats in free-text prompts. |
| Bulk exfiltration | Owner/admin (audit) / operator+ (job); step-up; per-user rate limit; size cap; every export audited fail-closed with its SHA-256. | A legitimate admin can still export the whole log in 100k-row pieces — by design, and audited. |
| T-OPS-3 tampering | Exports carry `prev_hash`/`hash` and the chain head; `/audit/verify` detects edited/deleted rows; manifests let an off-host copy be checked later. | Range verification trusts the predecessor row; full verification is O(n). |
| DoS via expensive search / verify | `limit ≤ 200`; ≤ 8 terms × ≤ 100 chars; trigram index; `statement_timeout` 30 s per query; verify and export rate-limited. | Short (< 3 char) terms scan; bounded by the timeout. |
| T-INJ-4 hostile text in UI | Actions, targets, user agents, metadata, prompts and summaries are rendered as React text (escaped), JSON in `<pre>`; no `dangerouslySetInnerHTML`. | — |
| CSV injection | Formula prefixes neutralised, all cells quoted. | — |
| Response integrity | Manifest-last design: an interrupted download lacks the manifest; `….failed` audit event on stream errors. | — |

Operational metrics: export and verify outcomes are visible in the audit log itself (`audit.export.*`,
`job.export.*`, `audit.verify`); request duration/status are in the master's structured request logs.
