# p16-webhooks-out — outgoing webhooks for external automation

- **Status:** implemented (branch `p16-webhooks-out`), not deployed
- **Owner request (2026-10-23):** an outgoing webhook catalog so external automation (n8n, Zapier, a CI, a chat bot)
  can react to what happens in Remyral — jobs, approvals, merges, deploys, workflow and automation runs, machines,
  releases, expiring secrets, the cost brake — without polling the API. Single-company install. Complements the API
  tokens (p16-api-tokens, ADR-0058): tokens let a system call Remyral, webhooks let Remyral call it.
- **ADR:** [ADR-0059](../adr/0059-outgoing-webhooks.md) (the trust-model change: master-originated requests to admin
  chosen URLs, the owner's internal-target list).
- **Migration:** `0144_webhooks_out.sql` (0142 ops-safety and 0143 observability are taken; renumber at merge if
  another parallel change takes it).

## 1. Scope

| In | Out |
| --- | --- |
| A versioned event catalog (protocol, Zod, examples, OpenAPI `webhooks`) | Inbound webhooks (automations already have them) |
| Subscriptions: https target, event types, optional project, opt-in redacted details, custom headers, active / paused | Per-user webhooks (the old notification webhook channel stays as it is) |
| HMAC-SHA256 signature with a timestamp, rotation with overlap, secret shown once | Payload templating / transformations |
| Durable outbox, at-least-once with a stable delivery id, retries with backoff + jitter, auto-disable | Exactly-once delivery (impossible over HTTP; the receiver deduplicates) |
| Multi-master safe sending, redelivery, a test button, the delivery log | Strict per-subscription ordering (documented best effort) |
| Console (Ayarlar → Webhook'lar), API page section, assistant read tool + draft card | Prompts, logs, diffs or agent output in any payload |

## 2. Event catalog (protocol `webhooks.ts`, catalog version 1)

Envelope (every delivery body):

```json
{ "id": "<event uuid>", "type": "job.failed", "catalogVersion": 1, "occurredAt": "2026-10-23T09:30:00.000Z",
  "project": "website", "data": { … } }
```

| Group | Types | `data` |
| --- | --- | --- |
| Jobs | `job.created`, `job.started`, `job.succeeded`, `job.failed`, `job.cancelled`, `job.awaiting_approval` | `job {id, title, project, state, runtime, link}`, `transition {from, to, trigger}`, `actor {type}`, opt-in `reason` |
| Approvals | `approval.requested`, `approval.decided`, `merge.decided` | `approval {id, action, kind, risk, status, approvals, requiredApprovals, expiresAt, link}`, `job {…}`, `decidedBy {type}`, opt-in `summary` / `reason` |
| Deploys | `deploy.started`, `deploy.succeeded`, `deploy.failed` | `deploy {id, kind, env, project, state, target, jobId, urls, via, link}`, opt-in `error` |
| Workflow runs | `workflow.run.started / succeeded / failed / cancelled` | `run {id, workflowId, workflowName, project, state, trigger, link}`, opt-in `reason` |
| Automations | `automation.run.started / succeeded / failed` | `run {id, automationId, automationName, project, state, trigger, jobId, workflowRunId, link}`, opt-in `reason` |
| Fleet (global) | `worker.online`, `worker.offline`, `release.rollout_paused` | `worker {id, name, os, arch, version, link}`, `closeCode`; `rollout {holdId, channel, version, rolloutPercent, previousVersion, reason, link}` |
| Safety | `secret.expiring` (global), `cost.brake` (global or project) | `secret {item, dueAt, thresholdDays, link}`; `brake {scope, window, windowStart, level, spentUsd, limitUsd, mode, link}` |
| — | `webhook.test` | `subscriptionId`, `message` (only the test button) |

Rules:

- Every data schema is **strict**: the producer validates before storing, so a field the catalog does not document can
  never be sent (a prompt, a log line, a token). Titles and names pass through the secret redactor (`cleanText`).
  A job's title is its short title (p15-job-titles; derived from the prompt's first line when none was given — the
  same title every console screen and notification shows), never the prompt.
- Free text (failure reasons, approval summaries, deploy errors) exists only in the **opt-in details** fields
  (subscription `includeDetails`), redacted and cut to 500 characters.
- Links are absolute when the master knows its public URL (`NOTIFY_PUBLIC_URL`), else console-relative.
- Compatibility: within a catalog version fields are only added; receivers ignore unknown fields. A breaking change is a
  new `catalogVersion`.
- Global events (`worker.*`, `release.rollout_paused`, `secret.expiring`) have `project: null` and reach only
  subscriptions without a project.

## 3. Producer — the audit log as the transactional outbox

Instead of adding outbox writes to every source module, the producer tails `audit_events`:

- Every state transition and privileged action is already audited (AGENTS.md rule 7) — most of them **in the same
  transaction** as the change (`job.create`, `job.transition`, `approval.request`, `approval.decide`,
  `release.rollout.paused`, `secret.expiry.notice`, `cost.brake.*`, `workflow.run.start` …). So "audit row committed"
  ⇔ "change committed".
- Audit ids become visible **in commit order**: `AuditLog.append` takes a transaction-scoped advisory lock, then
  allocates the id, and the lock is held until commit. A later id therefore cannot commit before an earlier one, and a
  plain cursor `id > floor` never skips a row (unlike the shared `outbox`, which needs a settle window).
- Two audit entries were added where none existed: `ops.action.start` (the start of an ops action's execution →
  `deploy.started`) and `automation.run.finish` (a run's outcome → `automation.run.succeeded / failed`).
- `WebhookService.consume()` (one producer at a time: `pg_try_advisory_xact_lock`, cursor row `FOR UPDATE`) reads up
  to 500 audit rows above `webhook_consumer.floor_id`, maps each relevant one with `eventsFromAudit` (catalog.ts; reads
  titles / names / states, the event's own state comes from the audit entry), and inserts one `webhook_deliveries` row
  per matching **active** subscription — in the transaction that advances the cursor. A crash never loses or
  duplicates a delivery; `UNIQUE (subscription_id, event_id)` makes a replay harmless. A mapping error is isolated in a
  savepoint, logged (ids only) and skipped.
- Event ids are derived (`sha256("remyral-webhook-event:<auditId>:<type>")` as a v8 UUID): the same event has the same id
  for every subscription.
- No active subscription → the cursor jumps to the newest audit id (no backlog when the first webhook is made; a paused
  webhook does not collect events).
- `deploy.*` are the deploy-like ops kinds (`coolify.deploy / restart / rollback`, `pages.deploy / rollback /
  publish`); DNS records, Pages project / domain and preview tunnels are not deploys.

## 4. Subscriptions and targets

`webhook_subscriptions`: name, url, project (null = all projects + global events), `event_types`, `include_details`,
headers, sealed secret (+ previous for the overlap), state `active | paused | disabled`, failure counter, timestamps.

Target floor (`targets.ts`, checked on save **and before every attempt**):

- `https://` only, no credentials in the URL, no fragment, ports 443 / 8443;
- never loopback, private (RFC 1918, CGNAT, ULA), link-local / cloud metadata, multicast, internal names (`localhost`,
  `*.internal`, `*.lan` …) or odd IPv4 spellings — `isForbiddenHost` of the workflow egress floor (ADR-0055 K1);
- the sender resolves the host inside the socket's `lookup` and refuses if **any** resolved address is non-public
  (`guardedLookup` of the ops client — no DNS-rebinding window);
- **internal targets:** exact `https://host[:port]` origins on the owner's list (`webhook_settings.internal_origins`,
  `PUT /webhooks/settings`, owner, event `security.policy`, audited before / after) skip only the address checks.

Custom headers: at most 10; names set by Remyral or HTTP (`host`, `content-*`, `user-agent`, `x-remyral-*`, `cookie`,
`sec-*` …) refused; values without control characters; a credential-like name (`authorization`, `*token*`, `*secret*`,
`*key*`, `*auth*`, `*signature*`, `password`) must be marked secret — its value is **sealed** (AES-256-GCM, HKDF sub-key
`webhooks-out`, AAD per subscription and header) and never returned (a hint only). The vault is not used: vault
credentials are sealed for workers, while the master itself sends webhooks.

## 5. Signing and secrets

- Secret: `whsec_` + 32 random bytes (base64url); the HMAC key is the UTF-8 bytes of that string. Stored sealed
  (`webhook-secret:<id>` AAD); shown **once** — in the create answer, or once on request (`POST /webhooks/:id/secret`)
  for a webhook the assistant created (its secret never passes the chat), then only a rotation gives a new one.
- `X-Remyral-Signature: t=<unix seconds>,v1=<hex>` — HMAC-SHA256 over `<t>.<raw body>`. During a rotation overlap the
  header carries a second `v1` for the previous secret (default 24 h, 0–168 h), the new one first.
- Receivers: constant-time compare against any `v1`, refuse `|now − t| > 300 s` (replay), deduplicate on
  `X-Remyral-Delivery`. `verifySignature` in `signing.ts` is the reference; the console shows a Node.js snippet.
- Other headers: `X-Remyral-Delivery` (delivery id, stable across retries and redeliveries), `X-Remyral-Event-Id`,
  `X-Remyral-Event`, `X-Remyral-Attempt`, `User-Agent: Remyral-Webhooks/1 (catalog v1)`, `Content-Type: application/json`.

## 6. Delivery

- `deliverDue()` claims due deliveries of active subscriptions with one `UPDATE … WHERE id IN (SELECT … FOR UPDATE OF
  x SKIP LOCKED)` that sets a fresh `claim_token`, `claimed_until = now + 60 s` and `attempts + 1`. Several masters
  never claim the same row; a master that dies mid-request leaves the delivery due again after the lease (at-least-once,
  same delivery id). Results are written only `WHERE claim_token = <ours>` — a stale sender cannot overwrite a newer
  attempt.
- One attempt: 10 s deadline for connect + TLS + response, no redirects, no keep-alive, response read up to 4 KiB and 1
  KiB kept (control characters removed, secrets redacted); errors are fixed codes (`timeout`, `dns`,
  `address_refused`, `target_refused`, `tls`, `connect`, `network`, `http_<status>`).
- Any 2xx = delivered. Otherwise retry after **1 min, 5 min, 30 min, 2 h, 6 h, 24 h** (±10 % jitter) — 7 attempts —
  then `failed`. Every non-2xx is retried (receivers sometimes answer 4xx while being redeployed).
- **Auto-disable:** each failed attempt increments the subscription's `consecutive_failures`; a success resets it. At
  15 (option) the subscription becomes `disabled` (`disabled_reason = consecutive_failures`), audited
  `webhook.disabled`, owners and admins get the `webhook.disabled` notification. Its pending deliveries wait; resuming
  (step-up) resets the counter and they continue.
- **Ordering (best effort):** due deliveries are sent in event order, one at a time per subscription and pass,
  subscriptions in parallel (4); a delivery in backoff does not block newer ones. Receivers order by `occurredAt`.
- **Redelivery:** `POST /webhooks/:id/deliveries/:did/redeliver` puts a finished delivery back to pending (same id, same
  body, the attempt number continues). **Test:** `POST /webhooks/:id/test` sends a `webhook.test` at once (one attempt,
  any state, not counted for auto-disable) and answers with the attempt.
- Housekeeping (hourly): finished deliveries older than 30 days are deleted (attempts cascade); pending ones that old
  are expired.

## 7. Authorization, step-up, tokens

| Action | Who | Step-up event | Token scope |
| --- | --- | --- | --- |
| `webhooks.read` — list, catalog, settings, delivery log | admin+ | — | `admin` |
| `webhooks.write` — create, change, resume, rotate, reveal | admin+ | `integrations.webhooks` (balanced) | session only |
| `webhooks.write` — pause, delete, test, redeliver | admin+ | none (route without the step-up hook) | session only |
| `webhooks.internal` — internal targets | owner | `security.policy` (safe core) | session only |

Every change is audited (`webhook.create / update / pause / resume / delete / secret.rotate / secret.reveal / test /
redeliver / settings.update`, `webhook.disabled` by the system); audit metadata names the target **origin** only (a
URL path can carry a receiver token).

## 8. Console

Ayarlar → Webhook'lar (`/settings/webhooks`, owners and admins): create form (events grouped as in the catalog; global
events disabled for a project webhook; details switch; custom headers with a secret flag), the secret shown once with a
verification snippet, the list (state, target, project, events, last-24-hour counts, consecutive failures, headers by
name, secret hint, overlap end, "secret not shown yet", the disabled explanation), buttons Test / Pause / Resume /
Rotate (overlap 0, 1, 24, 72, 168 h) / Show secret (once) / Delivery log / Delete (two-step), the delivery log (status
filter, attempts, HTTP code, latency, error in words, next attempt, details with every attempt, the response excerpt and
the exact body, redeliver, older pages) and İç hedefler (owner edits, others read). Ayarlar → API shows the catalog from
`/openapi.json` (`webhooks`: headers, verification, retry schedule, each event with its example). TR + EN (`webhooks`
namespace). The chat card `webhook` shows the action, name, target origin, project, details and events.

## 9. Assistant

- `list_webhooks` (read): webhooks with target origin only, events, state, failures, 24-hour counts, header names,
  whether the secret was shown; `failures: true` adds the recent failed attempts (event, attempts, HTTP status, error).
- `draft_webhook` (draft, card kind `webhook`): `op: create | pause | resume`. The tool pre-checks the catalog names and
  the target floor; confirming runs `WebhookService.create / setState` — the console's path (validation, audit). The
  security policy decides direct vs card and the code (`eventOfDraft`: `integrations.webhooks`, pause → `chat.cards`).
  A created webhook's secret is not revealed (`reveal: false`); the console shows it once.
- Prompt rule 43 (rule 42 belongs to p16-observability).

## 10. Security review

- **SSRF:** the static floor + connect-time resolution check + no redirects; internal origins only by the owner with a
  code, audited; a target that loses its allowance is refused at send time (`target_refused`).
- **Secrets:** signing secret and secret header values sealed with an HKDF sub-key of the master key; never logged,
  never in list answers, the assistant never sees them; secret-bearing answers are `cache-control: no-store`.
- **Data exposure:** strict schemas; no prompts / logs / diffs; details opt-in and redacted; project-scoped webhooks
  never receive global or other projects' events; webhooks are admin-only (they see every project anyway).
- **Replay:** timestamped signature, receivers' tolerance window, stable delivery id for deduplication.
- **DoS / cost:** at most 50 subscriptions, 100 deliveries per pass, 10 s per attempt, 4 KiB read, retention 30 days.
- **Abuse by a receiver:** response bodies are never interpreted, only an excerpt kept (redacted).

## 11. Tests

- Protocol: every type documented with a parsing example; strictness; global / project rule; catalog version.
- Master unit: signing (tolerance, rotation, malformed headers), target floor (all internal spellings, internal
  origins, ports), header rules, event id stability, error codes.
- Master integration (real Postgres + Redis, local HTTPS receiver with the test-only localhost certificate): egress
  refusals (http, loopback, private, metadata, IPv6, internal names, credentials, ports) and the connect-time refusal;
  owner-only internal targets; a job lifecycle (`job.created → started → succeeded`, signatures, links, no prompt,
  project filter, once only); details only where opted in, redacted; rotation overlap (two `v1`, then one); the test
  button; pause / resume; retries on the fake clock with a stable delivery id and attempt numbers; redelivery;
  auto-disable with the notification and resume; a target refused at send time; two masters delivering 12 events
  exactly once; a fenced claim (a stale sender cannot overwrite); an automation deploy emitting
  `deploy.started → automation.run.started → deploy.succeeded → automation.run.succeeded`; `/openapi.json` `webhooks`.
- Chat integration: `draft_webhook` create (direct under Serbest), refused internal target, no secret in the chat,
  `list_webhooks`, reveal once, pause direct, resume as a card that needs a code.
- Web: the screen (create with a code, secret once, project vs global events, test / pause / resume / reveal / delete,
  rotate, delivery log with details and redelivery, internal targets owner vs admin), API page parsing, the chat card.

## 12. Rollback

Older masters ignore the tables. To remove: see the header of `0144_webhooks_out.sql`. Turning the feature off without
a rollback: pause or delete the webhooks (no delivery is created without an active subscription).
