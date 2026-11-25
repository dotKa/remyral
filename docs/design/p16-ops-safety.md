# Design note: `p16-ops-safety` — keys and expiry, the rollout circuit breaker, rate limits and the cost brake

- **Task:** `p16-ops-safety`. **Date:** 2026-10-23. **Migration:** `0142_ops_safety.sql` (after `0141_runtime_updates` on
  main; renumber at merge if a parallel change takes it).
- **ADR:** [ADR-0056](../adr/0056-owner-configurable-security-policy-and-autonomy.md) amendment 2026-10-23 — the policy
  gets three sections: `limits`, `costBrake`, `rollout`. No other trust-model change: every new action keeps an existing
  authorization action and step-up event.
- **Scope:** single-company self-hosted install (owner direction 2026-10-23), Diyalog UI only.
- **Builds on:** p16-api-tokens (token expiry notice, the per-token limiter), p7-rate-limit (per-IP / per-user budgets),
  p2-signed-updates + p6-release-import (channels, attempts, offers), p8-cost-efficiency (usage store, budgets, admission
  holds), p5-notifications (dedupe keys, outbox-free direct notify), p15-autonomy (the security policy).
- **Worker release:** needed only for the assistant (the `ops_safety_status` tool schema and prompt rule 41 are compiled
  into the worker's assistant host). Expiry, the breaker, the limits and the brake are master-only; an older worker keeps
  working and its assistant simply does not offer the tool.

## 1. Keys and expiry ("Anahtarlar ve süreler")

`ExpiryService` (apps/master/src/ops-safety/expiry.ts) builds one list from what the master knows or can check. It never
reads a secret: files are `stat`ed (mtime), stored keys are known by their recorded dates, the Cloudflare token by its
own verify endpoint, the certificate by a TLS handshake.

| Item (`id`) | Basis | Source | Recommended rotation |
| --- | --- | --- | --- |
| `token:<id>` API tokens | expiry | `api_tokens.expires_at` (their own 7-day notice stays `api_token.expiring`; not re-notified here) | — |
| `cloudflare:token` | expiry when the token has one, else rotation | `GET /accounts/{id}/tokens/verify` or `/user/tokens/verify` → `result.status`, `result.expires_on` (verified with Context7 against the Cloudflare API reference: `{id, status: active|disabled|expired, expires_on?, not_before?}`); age since `ops_integrations.updated_at` | 365 d |
| `github:app-key` | rotation | `github_app_connection.key_created_at` (the card's existing 180-day hint) | 180 d |
| `coolify:<connection>` | rotation | `coolify_connections.updated_at` + the stored last connection test (a failed test = state `error`) | 365 d |
| `tls:public-origin` | expiry | TLS handshake to `PUBLIC_ORIGIN` (else `NOTIFY_PUBLIC_URL`), SNI = host, peer certificate `valid_to`; verification off on purpose (an expired or self-signed certificate must be reported); trusted / issuer as detail | — |
| `signing:release-key` | rotation | first `uploaded_at` of a release signed with the key of the newest release; stampable without releases | 365 d |
| `file:totp-key`, `file:lease-key`, `file:webhook-hmac`, `file:skills-panel-key`, `file:oidc-signing-key`, `file:github-app-key` | rotation | file mtime (`*_FILE` paths) | 730 d (TOTP), 180 d (GitHub key file), else 365 d |
| `file:vapid-key` | age only | file mtime | — (a new key drops every push subscription) |
| `backup:age-identity` | rotation | stamp only (the identity lives off the master) — `unknown` until the owner records a date | 365 d |
| `vault:<id>` | expiry | new `vault_credentials.expires_at` (metadata an admin records; `PUT /ops-safety/vault/:id/expiry`) | — |

- **States:** `ok` (> 30 d or no date), `soon` (≤ 30 d), `urgent` (≤ 7 d), `expired` (due passed), `unknown` (no basis),
  `error` (the last outside check failed and gave no date).
- **Rotation stamps** (`secret_rotation_stamps`): "rotated at" after a runbook rotation — the console button (today), the
  CLI `remyral-master secrets:rotated <item> [--at ISO] [--note …]` / `--list` (any date in the past), the newest stamp
  restarts the age when it is newer than the source's own date. Audited `secret.rotation.recorded` (source console / cli).
- **Outside checks** (`secret_expiry_checks`): TLS and Cloudflare run at most every 6 h (the background pass) or on
  "Şimdi denetle" (`POST /ops-safety/expiry/check`). The stored detail is secret-free (status, issuer, error code).
- **Notices:** for every item with a due date, the tightest crossed threshold (30 / 14 / 7 / 1 days, 0 = expired) is
  inserted into `secret_expiry_notices (item, due_at, threshold)`; the insert that wins sends one `secret.expiring`
  notification to owners and admins (warning, critical from 7 days; dedupe key `secret.expiring:<item>:<due>:<t>`) and
  audits `secret.expiry.notice`. A new due date (a stamp, a renewed certificate) starts over. Skipped thresholds (a check
  that found an item already at 5 days) are not sent retroactively — one message for the current threshold.
- **Home:** the health panel shows "N anahtar ya da sertifika ilgi bekliyor" (owners / admins: the summary needs
  `security.read`), linking to the view.

## 2. Worker rollout circuit breaker

`RolloutBreaker` (apps/master/src/releases/breaker.ts), thresholds from the policy section `rollout`:

| Setting | Default (every preset) |
| --- | --- |
| `breaker` | on |
| `failurePercent` / `minFailures` | 30 % of the judged machines, at least 1 |
| `watchMinutes` | 30 (crash loop / heartbeat window after an update) |
| `jobFailureDelta` / `minJobs` | +30 points over the same machines' last 7 days, at least 5 jobs after the update |

- **Judged machines:** the latest channel attempt per worker for the channel's version since the last *resumed* hold of
  it. `failed` / `rolled_back` / `timed_out` → `update_failed`; `succeeded` → `crash_loop` when ≥ 4
  `worker.session.start` audits fall in the watch window, `heartbeat_lost` when it is not connected, silent ≥ 2 min and
  its last heartbeat lies inside the watch window; open attempts are `pending` (not judged). Job rates: ended attempts
  (succeeded / failed) on the succeeded machines after vs. 7 days before their update.
- **Trip** (on every final `UPDATE_STATUS` — `ReleaseService.observeOutcomes` — and every background pass): a
  `release_rollout_holds` row (one open hold per channel, partial unique index), with the evidence (numbers + failing
  machine ids / verdicts / reasons; no worker free text) and the rollback target (the most common registered lower
  `from_version`, else the newest lower release). Offers not yet installing are withdrawn (`superseded`), admins get
  `release.rollout_paused` (critical), audit `release.rollout.paused` (system actor `rollout-breaker`).
- **While held:** `ReleaseService.offer` offers the version to no further machine through the channel (explicit targets
  still work); `promote` refuses a higher percentage of the held version (`409 rollout_paused`) — also the host-side
  `release-import --rollout` and the chat's `manage_release`, which use the same method; a lower percentage is allowed;
  promoting another version supersedes the hold (audited `release.rollout.superseded`). Nothing is ever promoted
  automatically.
- **Resume** (`POST /releases/channels/:channel/resume`, `releases.publish` + the `releases.publish` step-up event):
  the hold is resolved, offers continue; failures before the resume are not counted again.
- **Roll back** (`…/rollback`): the hold is resolved `rolled_back`, the channel points at the previous version at the
  held percentage (channels never downgrade anyone) and every machine on the held version in that channel gets the
  documented explicit rollback target (`rollback: true`, docs/ops/worker-updates.md §4). The machines stay pinned until
  an admin sends them back to the channel after a fixed release.
- **Pause by hand** (`…/pause`): the same hold with reason `manual`.
- **Console:** Ayarlar → Worker sürümleri gets a "Devre kesici" panel above the channels: per channel the judged /
  failing / pending counts, a held rollout with its reason, the failing machines and Resume / Roll back (step-up).

## 3. Rate limits beyond sign-in

The policy section `limits` (defaults = the budgets enforced before, so nothing changes until the owner edits them):

| Setting | Default | Enforced by |
| --- | --- | --- |
| `userReadPerMinute` / `userWritePerMinute` | 600 / 120 | the p7 per-user hook (read / write route classes; other classes keep their fixed budgets) |
| `tokenReadPerMinute` / `tokenWritePerMinute` | 600 / 120 | the p16-api-tokens per-token hook (exports keep 20) |
| `chatPerMinute` / `chatPerHour` | 10 / 120 | `TurnGuard` before every new assistant turn (message, edit, regeneration), Redis fixed windows `chat-msg-min` / `chat-msg-hour`; on top of the existing `turnsPerUserPer10Min` chat setting |

A value left at its default keeps the configured budget exactly; a changed value is scaled like the configured class
budget (`RATE_LIMIT_SCALE`, test harnesses). Refusals are the existing `429 rate_limited` (the chat's with reason
`chat_messages`), audited once per window as before.

## 4. Model cost brake

The policy section `costBrake`: `mode` (`warn` in every preset — owner direction: conservative but non-blocking),
`dailyUsd` 50, `monthlyUsd` 500, `warnPercent` 80; per-project ceilings in `cost_brake_projects` (owners).

- **Spend:** the usage store's known dollars of the window (reported + estimated from the price table; subscription runs
  have no per-run cost, ADR-0014) plus the assistant's `chat_turns.cost_usd`, in the UTC day / month. Project ceilings
  count that project's job spend.
- **Crossings** (`cost_brake_events (scope, window, window_start, level)`): at `warnPercent` and at 100 % the owners get
  one `cost.brake` notification per scope, window and level (crossing straight to 100 % sends one), audited
  `cost.brake.warning` / `cost.brake.engaged`.
- **Block mode:** an exceeded, not lifted global ceiling (or the job's project ceiling) holds new **non-urgent** jobs at
  admission (`QuotaService.admit`, hold code `cost_brake`, until the window end) — urgent jobs (Acil) pass — and refuses
  new assistant turns (`429 cost_brake_active`). Running jobs are not stopped. Warn mode computes nothing on the dispatch
  path.
- **Lift** (`POST /cost-brake/lifts`, owners only, `quotas.write` + the `limits.budgets` step-up rule): 1–72 hours,
  global or one project, with a reason; audited `cost.brake.lift`; ending early `cost.brake.lift.end`.
- **Console:** a band on the home page and in the chat while a ceiling is reached (red when it holds work, amber in warn
  mode, every role — `GET /cost-brake` is `quotas.read`), a home health line, and the "Maliyet freni" panel (meters,
  mode / ceilings, lifts, project ceilings).

## 5. Routes and permissions

| Route | Action | Step-up |
| --- | --- | --- |
| `GET /ops-safety/expiry` | `security.read` (admin+) | — |
| `POST /ops-safety/expiry/check`, `POST /ops-safety/expiry/:item/rotated` | `security.write` (admin+) | — (a date, audited) |
| `PUT /ops-safety/vault/:id/expiry` | `vault.write` | — (metadata) |
| `GET /cost-brake` | `quotas.read` (every role; project ceilings of visible projects) | — |
| `POST /cost-brake/lifts`, `DELETE /cost-brake/lifts/:id`, `PUT /cost-brake/projects/:project` | `quotas.write` + owner role | `limits.budgets` |
| `GET /releases/breaker` | `releases.read` | — |
| `POST /releases/channels/:channel/{pause,resume,rollback}` | `releases.publish` | `releases.publish` |
| `PUT /security/policy` (new sections) | `security.write` | `security.policy` (safe core) |

New error codes (TR + EN): `expiry_item_unknown`, `rotation_date_invalid`, `rollout_paused`, `rollout_not_paused`,
`rollback_target_unknown`, `cost_brake_active` (variants day / month), `lift_hours_invalid`, `owner_required`.

## 6. Assistant

`ops_safety_status` (read; `part` all / expiry / rollout / cost) through `OpsSafetyReader` with the caller's
permissions; `get_settings` / `change_settings` carry the new policy sections. Prompt rule 41: answer from the tool with
dates, never claim a rotation, never raise a held rollout, explain warn vs block, lift or raise only on the owner's
explicit request.

## 7. Security review

- No secret is read, stored or shown: files by mtime, the Cloudflare token only through its own verify call by the
  stored token (no new storage), the certificate's dates only; the CLI never opens a key file.
- The TLS reader connects only to the configured public origin, with a timeout and no HTTP request.
- Every new state change is audited; holds and brake crossings are idempotent (unique keys) across replicas.
- The breaker can only *stop* offers; it never promotes or rolls back by itself. A rollback needs an admin with a code.
- The cost brake defaults to warn-only; block is the owner's explicit choice in the security policy (core step-up).
- Rate-limit overrides cannot remove the per-IP limits or the credential-attempt limits (unchanged).

## 8. Tests

- Master integration `ops-safety.test.ts` (real Postgres + Redis): TLS check against a local TLS server (fixture
  certificate) and a failing one; key file ages; thresholds 30 → 14 → 7 → 1 → expired once each and a fresh start after a
  stamp; stamp validation; vault expiry; Cloudflare verify with a fake; breaker trip on a rolled-back machine, withdrawn
  offer, notification, audit, `409 rollout_paused`, resume with a code (old failures not recounted, a new one trips again),
  rollback (channel + machine target + audit); rate limits per person / API token / chat at production scale; cost brake
  warn vs block (admission holds non-urgent only, chat 429), owner lift for N hours, project ceiling, owner-only.
- Master unit `ops-safety.test.ts`: thresholds, states, breaker verdicts (machine share, job spike, off), brake levels,
  policy sections (defaults, minimal document, changed paths, reset by a preset).
- Agent adapters: rule 41, the tool input, `change_settings` sections. Web `ops-safety.test.tsx`: the view, stamps,
  vault date, brake save / lift / admin, limits and breaker forms, the breaker panel in Worker sürümleri, the band.

## 9. Rollback

Code rollback: an older master ignores the tables and the policy sections (the strict schema of an older master would
reject a stored document with them — remove the three sections from `security_policy.document` before rolling the master
back, or the older master falls back to Sıkı and logs `security policy unreadable`). Data removal: see the migration
header.
