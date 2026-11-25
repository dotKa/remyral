# Design note: `p17-panel-settings` — owner settings from the panel (wave 2 of "the whole management from the panel")

- **Task:** `p17-panel-settings`. **Date:** 2026-10-27. **Migrations:** `0162_backup_change_lock.sql` (Part 0),
  `0163_panel_settings.sql` (Parts 1–3, 5, 6), `0164_user_recovery.sql` (Part 4), `0165_maintenance_jobs.sql` (Part 7).
- **Owner direction (2026-10-26):** "tüm yönetimi panelden sağlayabilmeliyiz". Gap list:
  the internal note `panel-yonetim-eksikleri` (not published). Wave 1 was
  [p17-host-actions](p17-host-actions.md) (the host request path, backups, control-plane upgrade).
- **ADR:** [ADR-0063 amendment 2026-10-26](../adr/0063-selfhost-distribution-and-update-trust.md#amendment-2026-10-26-more-host-request-kinds-update-rollback-backups-p17-host-actions)
  — the "Not mitigated" risk of the recipient / off-site pair is now mitigated by the host time lock (Part 0);
  [ADR-0056 amendment 2026-10-27](../adr/0056-owner-configurable-security-policy-and-autonomy.md) (step-up events
  `settings.panel`, `users.recover`, `maintenance.run`); [ADR-0021 amendment 2026-10-27](../adr/0021-ai-machine-administration.md)
  (the panel skills key generated and rotated in the master).

## 1. Principle

Owner-relevant settings that exist only as environment variables become **master-stored settings edited in the
panel**: owners (admins where the role model already allows), step-up where security-relevant, audited, versioned
where it fits. The environment variable stays the **default / bootstrap value** (and the kill switch where it is one
today); the panel shows the effective value and its source ("panel" / "ortam değişkeni"). Secrets are stored sealed
(SecretBox, like the support SMTP and the storage integration), never returned to the browser, edited as write-only
fields with "değiştir". Values are read at use time where feasible; otherwise the panel says "yeniden başlatma gerekir"
and offers the restart only through the wave-1 host request path.

## 2. Part 0 — host time lock for backup recipients and the off-site target (security, first)

**Risk closed** (ADR-0063 amendment, previously "Not mitigated"): a compromised master could add its own age recipient
(`backup-config`) and point the off-site copy at its own bucket (`backup-offsite`), then receive the next secrets
archive (stack.env with the database owner / superuser passwords).

**Host (`infra/selfhost/remyral-ctl`, `apply-pending`):**

| Request | Immediate | Waits 72 h (host clock) |
| --- | --- | --- |
| `backup-config` | schedule, retention, drill, WAL; removing recipients while ≥ 2 current ones stay | the requested recipient set when it **adds** a key this host does not use yet |
| `backup-offsite` `set` | prefix / path style within the same target | another bucket, endpoint, region or access key — or a first target |
| `backup-offsite` `clear` | off; a waiting target is withdrawn | — |
| `backup-change-cancel` (new, field `change` = recipients / offsite / all) | withdraws a waiting change | — |

- **First-seen time:** `date +%s` when this host processed the request, stored with the change in
  `<data>/state/backup-pending/{recipients,offsite}` (root, directory 0700, files 0600; the waiting off-site keys in
  `offsite.env` next to it). The signed `createdAt` is never used (a request dated more than an hour back is refused by
  the window rule anyway). `BACKUP_CHANGE_WAIT_S=259200` is a constant, not configurable.
- **Same change again** keeps the first-seen time (a waiting key requested again, the same target with another prefix);
  **a new key or target** restarts the wait; a request **without** the addition / with the current target withdraws
  the waiting change (`superseded`) — the latest owner intent wins, and it can only shrink what the host does.
- **During the wait** recipients.txt and offsite.env are untouched, so every archive is encrypted to the old set and
  goes to the old target (tested: the fake backup service records the recipients of each run).
- **Applying:** each `apply-pending` run (the one-minute timer) applies a change whose time came (re-validated: 2–10
  age keys); `remyral-ctl backup-change confirm --yes` (root) applies at once, `cancel` withdraws, `show` lists.
- **Result / heartbeat:** the request's result state is `scheduled` with "… waits until <time> (host time lock)"; the
  heartbeat's `backup` block adds `pending` (change, request id, since, until, the added keys / the target without
  credentials) and `changes` (the last five outcomes: applied / cancelled / superseded / refused);
  `remyral-ctl status` prints "WAITING … takes effect <time>" with the cancel command.

**Master:** `host_action_requests.state` gains `scheduled` (final; audited `host.<kind>.scheduled` as a success).
`BackupChangeWatch` (orchestrator tick, `backup-change-watch`) reads the heartbeat's waiting changes into
`backup_change_notices` (key: change + the host's first-seen time) and notifies **every owner** once when one appears and
once 24 h before it takes effect — kind `backup.change_pending`, severity critical, in-app and **by e-mail regardless of
the per-kind preference** (`NotificationService.notify(…, { mandatory: ['email'] })`) — and records the outcome when it
leaves the heartbeat (audit `backups.change.pending|applied|cancelled|superseded|gone`). Routes:
`GET /backups/pending-changes` (`host.actions.read`, owners), `POST /backups/changes/cancel` (`backups.manage`, owners,
no step-up: it can only withdraw). `HostActionService.submit` reconciles first, so a request that expired since the
last tick no longer blocks the cancel.

**Console:** Ayarlar → Yedekler shows "Bekleyen yedek değişiklikleri" first (red, the added keys / the target, the
time, "İptal et", "Hepsini iptal et", the host commands); a waiting key stays in the recipients list marked "bekliyor"
(saving the schedule keeps it waiting; removing it and saving withdraws it). "Senden bekleyenler" lists each waiting
change as a never-dismissible row with a countdown.

**What is left** (ADR): a compromised master can hide the panel notice and suppress the e-mail, and request again after
a cancel; it cannot shorten the host's wait, cannot get an archive encrypted to a waiting key or sent to a waiting
target, and cannot hide it from `remyral-ctl status`. Rejected: a code on the host's console (needs a terminal); a
second owner's approval in the console (rendered and counted by the same master).

**Tests:** `scripts/test/selfhost-ctl.test.mjs` (the host's first-seen time, a backdated `createdAt` refused, a
re-request keeps the time, a new key restarts it, removal / prefix / clear immediate, archives during the wait use the
old recipients, applied after 72 h, cancel by request and on the host, `status` output, no key in the heartbeat or
status); `apps/master/test/integration/backup-manage.test.ts` (view, pending list, owners-only, notice + mandatory
e-mail + reminder, cancel request signature and fields, outcome resolution and audit, `scheduled` state);
`apps/web/test/backup-manage.test.tsx` (the red section and cancel, the marked key, the `scheduled` state, the needs
row).

## 3. The settings catalog (Parts 1–3, 6)

`apps/master/src/panel-settings/` — `registry.ts` (the closed catalog: key, section, kind, the environment variable it
overrides, rules), `service.ts`, `routes.ts`, `env.ts` (the environment's value per key), `consumers.ts` (live adapters
and the per-section rules). Table `panel_settings` (one row per key the panel sets; a secret is sealed — AES-256-GCM
under the HKDF sub-key `panel-settings`, AAD `panel-setting:<key>` — and `value` is NULL), `panel_settings_state`
(version) and `panel_settings_history` (one row per save: the changed keys with their non-secret before / after; a
secret only as `set` / `generated` / `cleared`).

- **Precedence:** the panel value, else the environment variable (its value or its default). "Ortam değişkenine dön"
  deletes the row. A kill switch of the environment stays one: `SEARCH_PROVIDER=off`, `MEMORY_AUTO_LEARN=off`.
- **Reads:** synchronous from memory — loaded at start, reloaded by the orchestrator tick when the version changed (other
  instances), at once after a save here; listeners re-apply what needs it (the log sink, the managed configuration of
  machines). Every consumer reads at use time; **nothing in the catalog needs a restart** (the `restart` flag exists
  for later keys).
- **Routes:** `GET /panel-settings/:section` (`settings.panel.read`, admin+: effective value, environment value,
  source, `secretSet` only), `PUT /panel-settings/:section` (`settings.panel.write`, owners, step-up event
  `settings.panel` — safe core; `version` refuses a stale save, `confirm[]` answers a section's question),
  `GET /panel-settings/history`. Audit `settings.panel.update` (section, version, keys, non-secret changes).
- **Secrets:** write-only ("Değiştir"); a secret the master **generates** (the webhook HMAC key, the VAPID key pair,
  the skills panel key) is returned once in the save's answer — the webhook key because receivers must be configured
  with it, the VAPID / skills keys only as their public half — and never again.

### Settings moved from the environment to the panel

| Section | Panel key | Environment variable (now the default) | Applied |
| --- | --- | --- | --- |
| Bildirimler | `notify.webhook.allowlist` | `NOTIFY_WEBHOOK_ALLOWLIST` | per delivery / preference save |
| | `notify.webhook.secret` (secret, generated) | `NOTIFY_WEBHOOK_SECRET_FILE` | per delivery |
| | `push.vapidKey` (secret, generated pair) | `PUSH_VAPID_PRIVATE_KEY_FILE` | per delivery; a new pair removes the subscriptions after a confirmation |
| | `push.subject` | `PUSH_VAPID_SUBJECT` | per delivery |
| | `push.endpointAllowlist` | `PUSH_ENDPOINT_ALLOWLIST` | per subscription |
| | the one SMTP (support settings) | `NOTIFY_SMTP_*` | re-read after a save and every 15 s |
| Arama | `search.provider` (`bedrock` / `http`) | `SEARCH_PROVIDER` (`off` stays the kill switch) | provider refresh after a save and every indexer pass |
| | `search.http.url`, `.model`, `.key` (secret), `.dimensions` | `SEARCH_HTTP_URL`, `_MODEL`, `_KEY_FILE`, `_DIMENSIONS` | same |
| Ağ | `net.trustProxyHops` | `TRUST_PROXY_HOPS` | per request (Fastify's trust function reads it) |
| | `net.clientIpHeader`, `net.clientIpSources` | `TRUSTED_CLIENT_IP_HEADER`, `TRUSTED_CLIENT_IP_SOURCES` | per request (the resolver is rebuilt on change) |
| Oturumlar | `auth.rememberIdleDays`, `auth.rememberAbsoluteDays`, `auth.trustedDeviceDays` | `AUTH_REMEMBER_IDLE_DAYS`, `AUTH_REMEMBER_ABSOLUTE_DAYS`, `AUTH_TRUSTED_DEVICE_DAYS` | per sign-in (existing sessions keep their lifetime) |
| | `workers.rotationApproval` | `WORKER_ROTATION_REQUIRES_APPROVAL` | per rotation |
| İşler | `jobs.loginWaitMinutes` | `LOGIN_WAIT_MINUTES` | per placement |
| | `jobs.outputMaxFiles` (p17-output-limits, 1–2000) | `JOB_OUTPUT_MAX_FILES` (default 500) | per assignment (recorded on the attempt) |
| Loglar | `logs.retentionDays`, `logs.level`, `logs.requests` | `LOG_STORE_RETENTION_DAYS`, `LOG_STORE_LEVEL`, `LOG_STORE_REQUESTS` | from the next line / purge |
| Hafıza | `memory.autoLearn` (`MEMORY_AUTO_LEARN=off` stays the kill switch), `memory.duplicateThreshold`, `memory.chatPerThreadDay` | `MEMORY_AUTO_LEARN`, `MEMORY_DUPLICATE_THRESHOLD`, `MEMORY_CHAT_PER_THREAD_DAY` | per pass / comparison |
| Workflow motoru | `workflow.engineV2`, `workflow.engineV2ForV1` | `WORKFLOW_ENGINE_V2`, `WORKFLOW_ENGINE_V2_FOR_V1` | per run start |
| Coolify koruması | `ops.internalOrigins`, `ops.controlPlaneUuids`, `ops.controlPlaneAddresses` | `OPS_INTERNAL_ORIGINS`, `OPS_CONTROL_PLANE_COOLIFY_UUIDS`, `OPS_CONTROL_PLANE_ADDRESSES` | per action (live set / list) |
| Anahtarlar | `skills.panelKey` (internal, generated), `skills.panelKeyRetired` | `SKILLS_PANEL_KEY_FILE` | per signature / delivery; machines by managed config |
| | `notify.webhook.nextSecret` (internal, generated) | — | during a rotation |

### What stays environment-only, and why

- **Bootstrap and trust roots:** `DATABASE_URL`, `REDIS_URL`, `TOTP_KEY_FILE` (the master key itself),
  `LEASE_SIGNING_KEY_FILE` (the host applier's trust root — §7), `RELEASE_PUBLIC_KEYS`, `CONTROL_PLANE_RELEASE_KEYS`,
  `VERSION_CATALOG_KEYS`, `SKILLS_PUBLIC_KEYS` (the owner's **offline** skills key; the panel key is separate),
  `HOST_APPLIER_DIR`, `BACKUP_STATUS_DIR`, `BLOB_DATA_DIR`: a panel setting cannot be trusted to name the keys and paths
  that decide what the master trusts.
- **Process-level settings read before the database:** `HOST`, `PORT`, `LOG_LEVEL`, `BODY_LIMIT_BYTES`,
  `SHUTDOWN_TIMEOUT_MS`, `DATABASE_POOL_MAX`, `METRICS_*`, `OTEL_*`, `TRACE_*`, `RATE_LIMIT_SCALE` (the owner's request
  budgets are already in the security policy `limits`).
- **Kill switches kept in the environment:** `SEARCH_PROVIDER=off`, `MEMORY_AUTO_LEARN=off`, `RELATED_WORK(_CONTEXT)`,
  `VERSION_CATALOG`, `FLEET_TOOLS_FEED`, `INSTALLER_PUBLIC_DOWNLOADS`, `GITFLOW_PLAIN_GIT`.
- **Vendor / operator feeds:** `UPDATE_FEED_*`, `WORKER_FEED_*`, `VERSION_CATALOG_*` (the gap list's [S] items).
- **SSO / OIDC** (`SSO_*`, `OIDC_*`, `COOLIFY_SSO_HOST`): Coolify SSO is integrated from Coolify's side (owner
  2026-10-26); unchanged.
- `NOTIFY_SMTP_CA_FILE` (a CA file), `NOTIFY_PUBLIC_URL` (replaced by the console address of p17-domain-wizard),
  `PUBLIC_ORIGIN`, `AUTH_STEP_UP_*` (the security policy's step-up window supersedes them).

## 4. Part 1 — notification channels

- **One SMTP configuration:** the owner's SMTP stored sealed with the support settings (p16-doctor `support_settings`,
  edited with `PUT /support/settings`) is used by the support mail **and** the notification e-mail; without it,
  `NOTIFY_SMTP_*`. `MailSettings` caches it (re-read after a support save and every 15 s on the tick);
  `DynamicSmtpNotifier` rebuilds the client when it changes. `GET /panel-settings/mail` shows source, host, port, TLS,
  sender, user name and whether a password is set; `POST /panel-settings/mail/test` (owners, step-up) sends a test
  message to the given or the caller's address and answers a closed error code (`settings.mail.test` audited).
- **Webhook:** `DynamicWebhookNotifier` over the effective allowlist and secret (the allowlist is checked again at send
  time, so removing an entry stops deliveries at once). A section rule: an allowlist needs a secret.
- **Web Push:** the master generates the VAPID pair (EC P-256) — the private PEM is sealed, the public key served by
  `GET /notifications/push`; the subject and the push-service allowlist are panel settings. A new pair invalidates every
  browser subscription: the save asks `push_key_change` (with the device count) and, confirmed, removes them
  (`notifications.push.reset` audited); people turn push on again in Ayarlar → Cihazlar.
- `NotificationService` asks each channel `available()` (a panel-configured channel can come and go) and gained
  `notify(…, { mandatory: ['email'] })` for security notices that must reach owners whatever their preference.

## 5. Parts 2 and 3 — search provider, network, sessions

- **Search:** `BedrockIntegration` gets the panel's choice on every refresh: `http` builds the HTTP embedding provider
  from the effective `SEARCH_HTTP_*` values (panel → environment; source "panel" when any of them comes from the panel),
  `bedrock` keeps the Bedrock panel / env path even when the environment says `http`; `SEARCH_PROVIDER=off` stays the
  kill switch. A save refreshes the provider at once (audited as a provider change); other instances on their next
  indexer pass. Rule: `http` needs URL, model and key.
- **Network:** the trust function of Fastify reads `net.trustProxyHops` per request; the client-IP header resolver is
  rebuilt when its settings change. The section view shows the client IP the master sees for this request, the socket
  address and `X-Forwarded-For`. Before a save the master computes this request's client IP under the new settings
  (`clientIpUnder`, the proxy-addr walk + the header rule); if it differs, the save answers `client_ip_would_change`
  (current / after) and goes through only with the owner's confirmation (`confirm: ['client_ip_change']`). Rules: a
  header needs sources and ≥ 1 hop; sources only with a header; every source a valid IP / CIDR.
- **Sessions:** remember-me idle ≤ absolute; 0 turns a feature off; read per sign-in (existing sessions keep theirs).
  Worker key rotation approval and the login wait are read per use. Decision on "into the security policy": these keys
  have no preset values, so they live in the versioned panel settings and are edited under the safe-core
  `settings.panel` event (ADR-0056 amendment) rather than in the preset document.

## 6. Part 4 — recovery of other users

`apps/master/src/users/recovery.ts`, routes `POST /users/:id/recover` (`reset-mfa` / `reset-password` / `unlock`),
`GET /users/recovery-requests`, `POST /users/recovery-requests/:id/approve | cancel` — all always-fresh except cancel.

- **Who:** owners recover anyone but themselves; admins recover operators and viewers (the role model keeps account
  changes an owner's; an admin may get a stuck colleague back in). Never oneself (`self_change`).
- **What:** the same operations as `admin:reset`. `reset-password` generates a one-time password (144 bits, the
  account-creation rule) returned **once** to the person who applies it and sets `password_change_required`; it is
  never stored or audited in clear. `reset-mfa` clears the authenticator and recovery codes. Both end every session and
  trusted device; `unlock` only clears the lock.
- **Another owner:** with a third active owner (neither requester nor target), the reset waits as a request (24 h) that
  that owner approves (Ayarlar → Kullanıcılar and "Senden bekleyenler"); the requester and the target cannot approve.
  **Decision:** with exactly two owners the only possible approver is the locked-out owner, so the requester's
  always-fresh code is the control and the reset applies directly (audited, both notified).
- **Notified:** the user (in-app and by e-mail whatever the preference) and the other owners (`account.recovery`).
  Audit `user.recover.<action>` (+ `.request`, `.cancel`), never the password.

## 7. Part 5 — key rotation

`apps/master/src/panel-settings/keys.ts`; `GET /panel-settings/keys`, `GET /panel-settings/keys/:item/dry-run?action=`,
`POST /panel-settings/keys/:item/:action` (owners, always-fresh, audited `keys.<item>.<action>`).

| Key | Decision |
| --- | --- |
| Webhook HMAC | **online, two steps.** `prepare` generates the next secret (shown once) and every delivery carries `X-Remyral-Signature-Next` signed with it; `activate` makes it the key (the second header stops); `cancel` drops it. Dry run: the receivers with webhooks on. |
| Skills panel key | **online.** `rotate` generates a new Ed25519 key in the master (sealed); the previous public key stays trusted as retired (≤ 4) so published skills / MCP specs keep verifying; machines receive the set by managed configuration; `retire` drops them (dry run: panel-signed versions, managed machines). ADR-0021 amendment. |
| Lease-signing key | **host procedure.** It is the remyral-ctl applier's trust root (the host verifies requests with the public half of the key *file*); workers may pin it locally (`masterLeaseKeys` in config.json — not managed config) and the update helper / machine-admin verify admin commands with the pin; there is no overlap support in the signer (one key announced). A master-made key would break the host applier and pinned machines, and letting the master write the key file would let it replace the host's trust root. The panel shows the exact steps (new key on the host, pinned machines first, swap, restart, `secrets:rotated file:lease-key`). |
| Master key (`TOTP_KEY_FILE`) | **host procedure, not a rotation.** It is the root of every sealed value (authenticator secrets, panel secrets, integration tokens, webhook secrets …) and of the HMAC peppers of recovery codes and API tokens, which cannot be re-derived; "re-encrypt the TOTP secrets in one transaction" would leave every other sealed value unreadable. The panel shows the incident procedure (backup, new key with the master stopped, re-enrolment / re-entry of secrets, `secrets:rotated file:totp-key`). |

## 8. Part 6 — logs, memory, workflow engine 2, OPS_*

- Logs: `LogSink.configure` / `LogStore.configure` apply retention (0 = off), level and request lines from the next line.
- Memory: `MemorySuggestionService` reads `tune()` — the duplicate threshold (a live threshold pair), the chat
  suggestions per thread per day and the auto-learning switch — per use; `MEMORY_AUTO_LEARN=off` keeps the learner
  absent whatever the panel says.
- Workflow engine 2: the engine reads its flags through getters. `POST /panel-settings/workflows/check` runs
  `workflow:normalise-check` (the CLI's `checkStoredDefinitions`, read-only, audited `settings.workflow.check`) and
  shows its report; turning `workflow.engineV2ForV1` on runs the check itself and refuses the switch while a definition
  fails (`workflow_check_failed`). Rule: v1-on-engine-2 needs engine 2.
- OPS_*: the Coolify / DNS guards get live sets / lists (`LiveSet`, `liveList`) over the effective values; the guarded
  fetch keeps a set-like value as is.

## 9. Part 7 — maintenance jobs

`apps/master/src/maintenance/`, table `maintenance_jobs`, routes `GET /maintenance/jobs[/:id]` (`maintenance.read`,
admin+), `POST /maintenance/jobs` (`maintenance.run`, owners, step-up event `maintenance.run`), `POST
/maintenance/jobs/:id/cancel`.

- **Kinds and reuse:** `blobs-migrate` (modes `to-store`, `to-db`, `move-local`, `move-s3` → `migrateBlobs` /
  `moveBlobs`, which gained `signal` and `onCount`), `search-backfill` (every kind → `searchBackfill`, now shared with
  the CLI), `memory-autolearn` (all or chosen projects → `autoLearnBackfill` per project).
- **Dry run first:** a real run is refused (`maintenance_dry_run_required`) until a dry run of the same kind and
  parameters finished within the hour.
- **One at a time per kind** (unique index over running jobs; `maintenance_running`).
- **Progress / heartbeat:** counts, the step and the last lines every 3 s (and a heartbeat every 30 s); an open job
  without a heartbeat for 2 minutes is failed "interrupted" by any instance's tick (the commands are idempotent).
- **Cancel:** a flag read at the next progress write (and an abort at once on the same instance); the CLI cores stop
  between rows / batches / projects.
- Audit `maintenance.<kind>.start | done | failed | cancelled`, `maintenance.cancel`.

## 10. Console

Ayarlar → **Sunucu ayarları** (`/settings/server-settings`, owners edit, admins read): one tab per section, each field
with its source line ("Kaynak: panel / ortam değişkeni (ENV)"), the environment value, "Ortam değişkenine dön"; secrets
as "Ayarlı / Ayarlı değil" with "Değiştir" and "Sunucuda üret"; generated values shown once; the network tab shows the
detected client IP; confirmations for an IP change and a new push key; Bildirimler adds the SMTP block (source, edit,
test send); Workflow motoru adds the pre-check; **Anahtarlar** (dry run → apply, the host procedures); **Bakım** (dry
run, start, progress, cancel, report). Ayarlar → Kullanıcılar: "Hesap kurtarma" in the user dialog (admins see it for
operators / viewers), the waiting owner recoveries with "Onayla"; "Senden bekleyenler" lists them.

## 11. Tests

- `apps/master/test/integration/panel-settings.test.ts` — views (env value / source, secrets only "set", the internal
  key hidden), authz (viewer / admin / owner) and step-up, validation per key and per section, stale version,
  precedence and "back to env", history and audit without secrets, webhook (generated once, sealed at rest, signs
  deliveries, allowlist applied at once), push (VAPID generated, public key served, confirmation, subscriptions
  removed), SMTP (one configuration, test send over STARTTLS), sessions (`/auth/options`), network (detected IP,
  confirmation, applied per request), workflows / OPS live, search HTTP provider from the panel and back, another
  instance's reload; unit: `LiveSet` / `liveList`.
- `apps/master/test/integration/panel-settings-ops.test.ts` — recovery (who may whom, always-fresh, self refused,
  sessions ended, one-time password never audited, `password_change_required`, mandatory e-mail, second-owner approval
  with two / three owners), keys (procedures, offline refusal, webhook overlap signatures, activate, skills key rotate /
  retired / retire, no private key in audit), the workflow pre-check and its gate, maintenance (unavailable without a
  provider, dry run required, done with report, one at a time, cancel flag, interrupted by the tick, audit).
- `apps/web/test/server-settings.test.tsx` — section form (source lines, changed values only, back to env), write-only
  and generated secrets, the client-IP confirmation round trip, keys (procedure, dry run before apply, shown once),
  maintenance (start waits for a dry run, progress), workflow pre-check report, user recovery (one-time password).
- Existing suites adjusted: route coverage / step-up always-fresh list, rbac matrix, security-policy safe core.
- **Unverified here:** a real SMTP / push service with the panel configuration, a long `blobs:migrate` on a real bucket
  from the panel, a multi-instance master picking up saves on the tick (tested by a direct version bump), the CLIs
  (`search:backfill`, `memory:autolearn`) do not apply the panel's HTTP search choice (they use the Bedrock panel /
  environment as before).
