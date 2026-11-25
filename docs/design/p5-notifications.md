# Design note: notifications — in-app, e-mail and webhook (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p5-notifications
- **Decisions applied:** ADR-0003 (Postgres outbox as the event source), ADR-0006 (secrets only via files,
  never in logs or messages), ADR-0009 §10 (step-up for privileged changes), p5-rbac authorization model
- **Builds on:** [p5-rbac.md](p5-rbac.md) (recipient scoping), [p4-approvals.md](p4-approvals.md),
  [p4-job-store.md](p4-job-store.md) (outbox), [p6-cost.md](p6-cost.md) (`usage.budget.threshold`)
- **Threat model:** T-SEC-1 (secrets in logs/messages), T-CP-3 (information disclosure across projects),
  T-CP-2 (stolen session redirecting notifications), SSRF via user-supplied URLs

## 1. Scope

| Piece | Where |
| --- | --- |
| Model, kinds, text sanitising | `apps/master/src/notifications/model.ts` |
| Recipient selection (mirrors RBAC) | `apps/master/src/notifications/recipients.ts` |
| Producers (outbox events → notifications, time-based sweep) | `apps/master/src/notifications/producers.ts` |
| Service: storage, outbox cursor, delivery queue, preferences | `apps/master/src/notifications/service.ts` |
| `Notifier` port, SMTP client, signed webhook | `notifier.ts`, `smtp.ts`, `webhook.ts` |
| REST | `apps/master/src/notifications/routes.ts` |
| Migration | `apps/master/migrations/0014_password_change_and_notifications.sql` (second half) |
| Console | `apps/web/src/shell/NotificationBell.tsx`, `apps/web/src/screens/NotificationSettingsPage.tsx`, `apps/web/src/api/notifications.ts` |

Web push was out of scope here; it was added later as a third outbound channel `push`
([p8-pwa.md](p8-pwa.md)). Channels: **in-app** (always on), **e-mail via SMTP** and a **generic webhook**,
both disabled by default and opt-in per user and kind.

## 2. Data (migration 0014)

- `notifications` — `recipient_id`, `kind`, `severity` (`info`/`warning`/`critical`), `title` (≤ 200),
  `body` (≤ 2000), `link` (console-relative path only; `//host` refused), `dedupe_key`, `created_at`,
  `read_at`. `UNIQUE (recipient_id, dedupe_key)` makes every producer idempotent.
- `notification_preferences` — `(user, kind, channel ∈ {email, webhook}) → enabled`. No row = off.
- `notification_targets` — per-user e-mail address and webhook URL.
- `notification_deliveries` — the dedicated delivery outbox: one row per notification and channel,
  `pending → sent | dead`, `attempts`, `next_attempt_at`, `last_error` (an error **code** such as
  `http_503`/`smtp_451`, never server text or an address). `dead` rows are the dead letter.
- `notification_consumer` + `notification_outbox_seen` — the producer's cursor over the shared `outbox`
  (initialised to the current maximum id, so existing history does not cause a notification storm).

Retention: notifications older than 90 days are deleted (hourly, with their deliveries).

## 3. Producers

| Kind | Source | Recipients (effective role per p5-rbac; disabled accounts never) | Severity |
| --- | --- | --- | --- |
| `approval.requested` | outbox `approval.requested` (**new, additive**: `ApprovalService.evaluate` writes it in the transaction that creates a pending request) | project role ≥ max(operator, request's approver role) — exactly who may decide | by risk: low/medium info, high warning, critical critical |
| `approval.expiring` | time-based sweep of pending requests | same as above | warning |
| `job.failed` | outbox `job.transition` with `to` = `FAILED` or `LOST` (existing) | project role ≥ operator | FAILED warning, LOST critical |
| `worker.offline` | time-based sweep of state: workers in state `offline` that still hold unreleased leases (no change to the fleet code; one notification per offline episode, keyed by the worker's last heartbeat) | owner/admin, plus operators of the projects of the leased jobs | critical |
| `budget.threshold` | outbox `usage.budget.threshold` (existing, p6-cost) | project budgets: project role ≥ viewer (as `GET /budgets`); other scopes: owner/admin | 80 % warning, 100 % critical |
| `worker.pending` | outbox `worker.pending` (**new, additive**: written by `PgDeviceDirectory` in the pairing transaction) | owner/admin | info |

New outbox topics (identifiers only, `job_id` NULL so per-job outbox consumers are unaffected; schemas in
`approvals/outbox.ts` and `workers/outbox.ts`): `approval.requested {requestId, jobId}` and
`worker.pending {workerId}`, each written inside the producer's existing transaction. Producer behaviour is
otherwise unchanged. "Worker offline" is observed from state instead of a hook: an extra statement in the
fleet's disconnect path measurably changed the timing of the existing reconnect race exercised by
`worker-identity.test.ts`, so the fleet code is left untouched.

"Expiring soon" = the last quarter of the request's lifetime, but at most 15 minutes before expiry, so a
short-lived request is not announced as expiring the moment it is created.

**Outbox consumption.** The shared `outbox` belongs to the dispatcher (`dispatched_at` is single-consumer),
so notifications only read it. One pass, in one transaction under `pg_try_advisory_xact_lock` (one pass at
a time across replicas): read unseen rows of the consumed topics above `floor_id`, produce notifications,
insert `notification_outbox_seen` — commit or roll back together (no loss, no duplicates). The floor then
advances over the prefix of rows older than a **settle window (5 min)** up to the first unseen row of ours;
identity ids are allocated before commit, so a transaction that commits late (but within the window) is
still picked up. Seen markers below the floor are deleted. Malformed payloads are skipped (marked seen).
Pruning of dispatched outbox rows (future ops task) must not delete rows above `notification_consumer.floor_id`.

**No secrets in text.** Titles and bodies are built from identifiers, enumerations, numbers and admin-set
names only — never from approval summaries, failure reasons, prompts or other text a runtime, repository or
worker supplied (worker host names are shown, as they are in the fleet view). As defence in depth every
text passes `@remyral/observability`'s `Redactor` (secret patterns), control characters are flattened and
lengths capped before storage.

## 4. Delivery

`NotificationService.notify()` inserts the in-app rows and, in the same statement batch, a
`notification_deliveries` row for every recipient who enabled the kind on a configured channel and has a
target. `deliverDue()` claims due rows with `FOR UPDATE SKIP LOCKED`, pushing `next_attempt_at` out by a
claim timeout (2 min) so a crash mid-send makes them due again (at-least-once; receivers deduplicate on the
notification `id`). Outcome: `sent`; transient failure → retry after 30 s × 2^(attempt−1) (max 1 h);
after 6 attempts or on a permanent failure → `dead` (logged at warn with ids and the error code only).
Targets are re-read at send time; a removed target, a disabled recipient or an un-configured channel
dead-letters the delivery.

`Notifier` port: `{ channel, acceptsTarget(target), send(message, target) }`, errors are
`DeliveryError(code, permanent)`.

- **SMTP** (`smtp.ts`, node:net/tls, no dependency): `starttls` (default, port 587) or implicit `tls`
  (465). TLS is mandatory — without STARTTLS in the EHLO reply the client stops before AUTH or the envelope
  (permanent error); certificates are always verified (`NOTIFY_SMTP_CA_FILE` adds trust anchors; there is
  no switch to disable verification). AUTH PLAIN only after TLS. Addresses are validated strictly (no
  CR/LF, brackets, separators), the subject is RFC 2047-encoded after removing control characters, the body
  is UTF-8 base64 (no dot or line-length issues), dot-stuffing is applied anyway. 5xx → permanent,
  4xx/network/TLS → transient. Replies from the server are never logged or stored.
- **Webhook** (`webhook.ts`): a user may register a URL only if it matches an allowlist entry
  (`NOTIFY_WEBHOOK_ALLOWLIST`: same origin and path prefix; https only; no credentials in the URL); the
  check is repeated at send time. Body: `{type:"remyral.notification", version:1, id, deliveryId, kind,
  severity, title, body, link, createdAt, recipient:{id, username}}`. Signature header
  `X-Remyral-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, "<t>.<body>")>` with a key ≥ 32 bytes
  from `NOTIFY_WEBHOOK_SECRET_FILE`; receivers verify in constant time and reject timestamps older than
  5 minutes (`verifyWebhookSignature`). Redirects are never followed (3xx → permanent), 10 s timeout,
  the response body is discarded unread. 408/429/5xx/network → transient, other 4xx → permanent.

Links in e-mail and webhooks are absolute when `NOTIFY_PUBLIC_URL` is set, else console-relative.

## 5. REST (all `config.authz: notifications.self`, global, viewer, self-only)

| Route | Notes |
| --- | --- |
| `GET /notifications?unread=&limit=&cursor=` | own rows only, newest first, opaque cursor, `unreadCount` |
| `POST /notifications/:id/read` | own row → 200; someone else's or missing → identical 404 |
| `POST /notifications/read-all` | own rows |
| `GET /notifications/preferences` | kinds × channels, channel availability, own targets |
| `PUT /notifications/preferences` | `{kinds?, email?, webhookUrl?}`; changing the e-mail address or webhook URL needs a step-up ≤ 10 min (`403 step_up_required`), toggles do not; invalid address `400 invalid_email`, URL off the allowlist `400 webhook_not_allowed`, enabling an unconfigured channel `400 channel_unavailable`; audited as `notification.preferences.update` with `emailTarget`/`webhookTarget` = `set`/`removed`/`unchanged` and the toggles — never the address or URL |

Added to the authz matrix (`EXPECTED`) and the route-coverage list.

## 6. Console

- **Bell** in the shell header (next to the account menu): unread badge (99+), polled every 30 s while the
  tab is visible and when the tab becomes visible again; dropdown with the latest 20 (severity dot, title, body,
  relative time), "Mark all read", link to the settings. Opening an entry marks it read and navigates —
  only console-relative links are followed (`safeLink` refuses `//host` and absolute URLs a second time).
  Background polling never signs a user out. All text is rendered as text.
- **Settings → Notifications**: e-mail address and webhook URL (disabled with an explanation when the
  operator has not configured the channel), table of kinds × In-app (always on) / E-mail / Webhook. Saving
  sends targets only when they changed, through `useStepUp().run`.

## 7. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `NOTIFY_INTERVAL_MS` | 15000 | producer + delivery loop |
| `NOTIFY_PUBLIC_URL` | — | absolute links in outbound messages |
| `NOTIFY_SMTP_HOST` | — | e-mail disabled when unset |
| `NOTIFY_SMTP_PORT` / `NOTIFY_SMTP_SECURITY` | 587 / `starttls` | `tls` for implicit TLS; no plain-text mode exists |
| `NOTIFY_SMTP_FROM` | — | required with a host |
| `NOTIFY_SMTP_USERNAME` / `NOTIFY_SMTP_PASSWORD_FILE` | — | password only from a file |
| `NOTIFY_SMTP_CA_FILE` | — | extra trusted CA (PEM) |
| `NOTIFY_WEBHOOK_ALLOWLIST` | — | comma-separated https URL prefixes; webhook disabled when unset |
| `NOTIFY_WEBHOOK_SECRET_FILE` | — | HMAC key file (≥ 32 bytes), required with an allowlist |

Use a trailing `/` in allowlist prefixes (`https://hooks.example.com/remyral/`), otherwise
`/remyral-other` also matches the prefix `/remyral`.

## 8. Security review

| Threat | Control | Verified by |
| --- | --- | --- |
| Information disclosure across projects (T-CP-3) | Recipients computed with the RBAC rules (global roles, membership ∧ account-role ceiling, disabled accounts excluded); approvals only to those who may decide; REST scoped to the caller's own rows, foreign ids answer the same 404 as missing ones. | `notifications.test.ts` producer tests (non-members, viewers, disabled user, other project), "another user's notification answers 404", RBAC matrix |
| Secrets in notifications or outbound messages (T-SEC-1) | Text from identifiers/enums only; untrusted free text never copied; `Redactor` + control-character flattening + length caps; SMTP/webhook credentials only from files, never logged; delivery errors stored as codes. | approval summary / failure reason / prompt canary, e-mail body check, log canary (SMTP password, HMAC key, targets), unit tests for `cleanText` |
| Stolen session redirects notifications elsewhere (T-CP-2) | Changing e-mail or webhook target needs a step-up; CSRF on every write; audited (flags only). | preferences test (stale step-up → 403) |
| SSRF / data exfiltration via webhook URLs | Operator allowlist (origin + path prefix, https, no userinfo), re-checked at send time, no redirects, timeout, response discarded. | unit allowlist and status tests, `webhook_not_allowed` |
| Forged webhook calls at the receiver | HMAC-SHA256 over timestamp and body, constant-time verification, 5-minute replay window. | unit and integration signature checks |
| E-mail interception / downgrade | TLS mandatory (STARTTLS required or implicit TLS), certificate verification always on, AUTH only after TLS. | unit: STARTTLS missing → nothing sent, untrusted cert refused, only EHLO/STARTTLS in clear |
| Header injection / malformed mail | Strict address validation (also in the DB check), RFC 2047 subject without control characters, base64 body, dot-stuffing. | unit tests |
| Open redirect / phishing via links | Links are console-relative paths (`^/(?!/)…`) in DB, service and UI. | unit and component tests |
| Notification storm / DoS | Idempotent dedupe keys, cursor initialised at deploy, batch limits, advisory lock per pass, retention. | idempotency test |
| Lost or duplicated events | Seen-marking in the producing transaction; settle window for late commits; deliveries at-least-once with stable ids. | cursor test, retry/dead-letter test |

Residual risks:

- An e-mail address is not verified by a confirmation mail (the user typed it under a step-up); a typo sends
  notifications to a stranger. Follow-up: confirmation link.
- The webhook HMAC key is shared by all users' webhooks (one receiver secret per installation); receivers
  must still authorise by `recipient`.
- A transaction committing more than 5 minutes after its outbox row was allocated could be skipped by the
  producer (statement timeout is 30 s, so only an unusually long transaction can hit this).
- Approval requests created before this release get no `approval.requested` notification (they may still
  get `approval.expiring`).
- `worker.offline` is detected by the sweep (every `NOTIFY_INTERVAL_MS`), so a worker that goes offline and
  comes back within one interval is not reported.

## 9. Tests

- `apps/master/test/integration/notifications.test.ts` — each producer and its recipients (project scoping,
  decider roles, viewers, disabled user, other project), idempotency, cursor and `dispatched_at` untouched,
  REST own-only/404/CSRF/paging, preferences (step-up, allowlist, invalid address, audit without targets),
  TLS e-mail through the fake SMTP server, signed webhook, retries with backoff, dead letter after the last
  attempt and on a permanent error, unconfigured channel, log canary.
- `apps/master/test/unit/notification-channels.test.ts` — SMTP (STARTTLS, implicit TLS, TLS required,
  untrusted certificate, 5xx/4xx mapping, unreachable server, header injection, dot-stuffing), webhook
  (allowlist, signature and replay window, status mapping, no redirect), text sanitising.
- `apps/master/test/unit/config.test.ts` — channel configuration defaults and validation.
- `apps/web/test/notifications.test.tsx` — bell (badge, list as text, mark read + navigate, mark all read,
  30 s polling, empty state, unsafe links), Settings (toggles without step-up, target change with step-up,
  server error message).
- Test-only TLS material: `apps/master/test/fixtures/tls/test-only-localhost.{cert,key}.pem` (self-signed,
  localhost/127.0.0.1; never used outside tests).

## 10. Rollback

Revert the code. The additive outbox topics then have no consumer; other outbox consumers (the dispatcher) must filter by topic, as they already must for `usage.budget.threshold`.
Tables can stay; to remove them: `DROP TABLE notification_deliveries, notification_preferences,
notification_targets, notification_outbox_seen, notification_consumer, notifications;`.
