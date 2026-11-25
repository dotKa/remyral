# Design note: `p17-host-actions` — update, rollback and backups from the console (wave 1 of "the whole management from the panel")

- **Task:** `p17-host-actions`. **Date:** 2026-10-26. **Migrations:** `0160_host_actions.sql`, `0161_backup_offsite.sql`.
- **ADR:** [ADR-0063 amendment 2026-10-26](../adr/0063-selfhost-distribution-and-update-trust.md#amendment-2026-10-26-more-host-request-kinds-update-rollback-backups-p17-host-actions)
  (request kinds, threat model per kind).
- **Owner direction (2026-10-26):** "tüm yönetimi panelden sağlayabilmeliyiz … eksiklerin hepsini kapatalım". The gap
  list is the internal note `panel-yonetim-eksikleri` (not published); this wave closes the two
  "fix first" items, the control-plane update / rollback and the backup section.
- **Builds on:** p17-domain-wizard (the signed host request, `remyral-ctl apply-pending`, the shared `<data>/host`),
  p16-selfhost-onboarding (`remyral-ctl upgrade / rollback`, the signed feed), p10-backup-restore and
  p11-master-resilience (the backup service, drills, WAL archiving), p17-object-storage (sealed keys, the S3 round trip).
- **Worker release:** none. **Host:** the new `remyral-ctl` arrives with the next control-plane release; an installation
  upgraded by an older `remyral-ctl` gets the new applier units from its daily `upgrade --check` (§6).

## 1. Principle

The master never gets the Docker socket and never runs a host command (ADR-0063). Everything that changes the host is
a **request**: the master writes a signed file into the only host directory it can write, the root-owned applier
verifies it, validates every field with fixed rules and runs **its own code path** for that kind. Installations
without the applier (Coolify / EC2, like the vendor's own) show "bu kurulumda host uygulayıcısı yok" and what the
operator runs instead — never a dead button.

## 2. Part 1 — fixes

- **Every master setting reaches the master.** `infra/coolify/compose.yaml` passes the master environment as an
  explicit list; 26 variables of `apps/master/src/config.ts` were missing (`VERSION_CATALOG*`, `WORKER_FEED_*`,
  `FLEET_TOOLS_FEED`, `RATE_LIMIT_SCALE`, `METRICS_*`, `JOB_CHECKPOINT_*`, `JOB_RESTART_MAX_RESUMES`,
  `NOTIFY_SMTP_CA_FILE`, `NOTIFY_INTERVAL_MS`, `GITHUB_API_URL`, `GITFLOW_*`, `BODY_LIMIT_BYTES`,
  `SHUTDOWN_TIMEOUT_MS`, `OTEL_SERVICE_NAME`, `AGENTMAGNIFY_INTERVAL_MS`). All are passed as `${VAR:-}` (empty = the
  config default). `scripts/test/compose-env.test.mjs` reads the `EnvSchema` keys of config.ts and fails when a key is
  neither passed in a layout (Coolify = compose.yaml; self-hosted = compose.yaml + compose.selfhost.yaml) nor on that
  layout's "not passed on purpose" list with a reason (today: `HOST_APPLIER_DIR` on Coolify).
- **`remyral-ctl install` keeps stack.env.** A re-run used to rewrite the file from scratch. It now edits it in place
  (`env_put` / `env_default`): lines it does not manage, comments and order stay; settings it only defaults (paths,
  release URL, update feed, `TRUST_PROXY_HOPS`) keep their value; only what the flags set and the trusted keys change.

## 3. The generalised request (all kinds)

| | |
| --- | --- |
| Files | `requests/<kind>.json` + `<kind>.sig.json` (master, uid 10001, 0600; the directory is 0700); result `status/<kind>-result.json` (root, 0644, read-only mount) |
| Signature | Ed25519 with the lease-signing key over `remyral-host-<kind>/v1\n` ‖ bytes — **one domain per kind** (a domain-change signature never opens an upgrade) |
| Shape | flat pretty JSON, string values only, exactly `kind id nonce createdAt expiresAt` + the kind's fields; no quote, backslash or control character, ≤ 1300 bytes a line, ≤ 8 KiB a file — checked **before any value is read** |
| Time | `expiresAt` in the future; `expiresAt - createdAt ≤ 1 h`; `createdAt` not more than 5 min ahead (master: 15 min) |
| Replay | the nonce is remembered (`state/host-nonces`, last 5000) and consumed before the handler runs |
| Consumption | regular files only (no symlink), copied capped into a 0700 temp dir and deleted before validation |
| Execution | a fixed handler per kind; upgrade / rollback / restore run `remyral-ctl` itself as a child under the lock the applier holds (`REMYRAL_CTL_LOCK_INHERITED`), streaming `[n] step` lines into the result |
| Result | `remyral-host-result/v1`: state (`applying`, `applied`, `rolled_back`, `held`, `failed`, `refused`), step, detail, the last 40 output lines **without lines that name a password / secret / token / key**, ANSI stripped, 400 characters each (the master filters again) |
| Heartbeat | `status/applier.json` adds `kinds`, `current`, `previous`, `releases` (on disk) and the `backup` block (§5); the master treats an applier without a kind as "too old" (`host_applier_outdated`: upgrade once by hand — the new request kinds come with the new `remyral-ctl`) |
| Units | the path unit watches every kind's file; `TimeoutStartSec=90min` (an upgrade pulls, backs up, migrates) |

Master side: `apps/master/src/host-actions/{files,service,routes}.ts`; table `host_action_requests` (one open request of
any kind, unique index; states as the result plus `pending`, `expired`, `cancelled`; non-secret `params`, the final
`step` / `detail` / `log`). The orchestrator tick reconciles results (also the new master after an upgrade restarted it);
a pending request expires after 15 min (the file is removed), an applying one fails after its kind's timeout (upgrade
3 h, backup 6 h, settings 30 min). Audit: `host.<kind>.request` (user), `host.<kind>.<state>` (system
`host-applier`), `host.request.cancel`, `backups.offsite.set|clear`.

## 4. Part 2 — control-plane update and rollback

- **Kinds:** `upgrade` (`version`, `fromVersion`, `acceptBreaking`), `rollback` (`version`, `fromVersion`, `backupId`,
  `restoreDatabase`).
- **Master checks:** owners (`host.update`), always-fresh step-up (safe-core event `host.update`); the version must be a
  newer release of the **verified** feed (`UpdateFeedService.release`), breaking changes need `acceptBreaking`; a
  rollback target must be in the heartbeat's `releases` and not the running one; a restore needs the backup id, the
  separate flag and the id typed again (`confirm`).
- **Host checks:** fixed expressions; `fromVersion` must be the running release (a stale request is refused); an upgrade
  must be newer; a rollback target must be on disk; `backupId` ⇔ `restoreDatabase=yes`; the dump must exist. The child
  `remyral-ctl upgrade --to V [--yes]` verifies the signed feed, the manifest and every file again and runs the existing
  path (stop master → pre-upgrade backup → migrate → start → gate → automatic image rollback or hold);
  `--yes` only with `acceptBreaking=yes` (otherwise it stops before anything changes).
- **Outcome mapping:** exit 0 → `applied`; "NOT rolled back" → `held` (the schema advanced; the console points at
  "Geri al" with the pre-upgrade backup); "rolled back to … (healthy)" → `rolled_back`; else `failed`.
- **Console:** Ayarlar → Sürümler → **Sunucu** (owners, `?tab=server`; the update banner's "Şimdi güncelle" opens it).
  The progress panel polls `GET /host-actions/requests/:id` every 3 s; while the master is stopped the proxy answers
  502 / 503 / 504 (or nothing) — the panel says "Sunucu yeniden başlıyor; bağlantı bekleniyor…" and keeps polling, then
  shows the final result and, after an update, offers to reload the page (the console's own bundle changed).
- **Not done (owner decision: off by default):** nightly automatic patch upgrades of the control plane — a later small
  step (a `REMYRAL_AUTO_PATCH` flag read by the daily `upgrade --check`, set by a request kind of its own).

## 5. Part 3 — backups

- **Kinds:** `backup-run` (`reason`, a slug of the owner's words — the words themselves go to the audit trail),
  `backup-drill` (`backupId` or empty), `backup-restore` (`backupId`, `restoreDatabase=yes`), `backup-config`
  (`time intervalMinutes keepDaily keepWeekly keepMonthly keepRecentHours drillEnabled drillWeekday drillTime
  walArchive recipients`), `backup-offsite` (`mode endpoint region bucket prefix pathStyle accessKeyId
  secretAccessKey`).
- **Where the settings live — decision: the host applies them into stack.env.** `backup-config` writes `BACKUP_*` and
  `PG_WAL_ARCHIVE` with `set_env_value` (only those keys) and `backup-config/recipients.txt`, then recreates the backup
  service (and Postgres when WAL archiving changed: a few seconds of database restart, said in the UI). A failure puts
  both files back. Rejected: a master-stored setting the backup service reads — it would make the backup image trust
  the master (a compromised master could change what the backup of the master contains) and needs a channel into the
  backup container; stack.env stays the one source the operator can read and back up. The applied values come back in
  the heartbeat's `backup` block (never a key); the backup service's own heartbeat shows the schedule it runs.
- **Rules (the runner's, re-checked on both sides):** HH:MM (UTC), interval 15–10080 min, retention ranges and "keeps
  something", weekday names, WAL on/off, **2–10 distinct age recipients** (`age1` + 58 bech32 characters — a private
  `AGE-SECRET-KEY-…` is refused). The private identity is made offline (`age-keygen`); the UI shows how and never takes
  it. **Known risk** (ADR amendment, "Not mitigated"): a compromised master that adds its own recipient and points the
  off-site copy at its own bucket receives future secrets archives (stack.env with the database owner / superuser
  passwords). Both changes are audited and visible. **Mitigated since p17-panel-settings Part 0:** a host-enforced
  72-hour time lock ([p17-panel-settings §2](p17-panel-settings.md)).
- **Off-site target:** stored sealed in the master like the storage integration (`backup_offsite_settings`, AES-256-GCM
  under the `ops-integrations` sub-key, AAD `backup-offsite`, fingerprint + last four characters shown), tested with the
  storage integration's put / head / get / delete round trip before it is stored (`offsite_test_failed` stores nothing);
  the keys of Ayarlar → Entegrasyonlar → Depolama can be reused. The keys reach the host **only** in the
  `backup-offsite` request (0600 file in the 0700 requests directory, consumed within a minute, removed by the master
  when it expires); the host writes `backup-config/offsite.env` (root 0600; the backup container reads it with
  `DAC_READ_SEARCH` on every run, nothing restarts) and never into a result, a log or the heartbeat (which shows
  `s3://bucket/prefix/ @ host`). A secret with a quote or backslash is refused (the request format cannot carry it).
- **Restore:** `remyral-ctl restore --backup ID --yes` (new; also usable by hand): stop master + backup → restore into
  `remyral_restore` → rename (the replaced database is kept as `remyral_replaced_<stamp>`) → migrate forward with the
  running release → start → health gate. A stop half-way starts the services again (`RESTART_ON_EXIT`); a backup with a
  newer schema than the running release is refused after the restore with the advice to upgrade first. The console
  shows the backup's time ("everything after … is lost") and schema, asks for the id typed again, a second click and an
  always-fresh authenticator code (safe-core event `backups.restore`).
- **Drill / backup now:** `remyral-ctl drill [--backup ID]` (new) / `remyral-ctl backup --reason R`, through the
  running backup service.
- **Console:** Ayarlar → Yedekler → Yedekleri yönet (owners): backup now with reason, drill, schedule / retention /
  drill / WAL / recipients (one save), off-site (test, save, turn off), the backup list with size and "verified by a
  drill", restore. Without an applier: the request buttons are not shown; "Satırları göster" prints the stack.env lines
  and the offsite.env lines (with a placeholder for the secret) the operator writes.

## 6. Rollout and compatibility

- The first upgrade **to** the release that brings this is done by hand (`sudo remyral-ctl upgrade`): the console of
  the older release has no Sunucu tab and its applier knows only `domain-change`. `upgrade` installs the new
  `remyral-ctl` into `/usr/local/bin`, so the applier is the new one from its next run. A heartbeat without `kinds`
  (an applier older than the master) shows "the applier is older" with that command; the domain change keeps working.
- New host + old master: the extra heartbeat fields are ignored; nothing writes the new request files.
- That first upgrade runs the previous `remyral-ctl`, which writes the previous path unit (domain-change only). The
  one-minute timer handles every kind anyway; the daily `remyral-ctl upgrade --check` of the new `remyral-ctl` rewrites
  the units when the path unit lacks `requests/upgrade.json`, so requests are picked up at once again.
- Coolify / EC2 (the vendor's production): no `HOST_APPLIER_DIR` → everything shows the operator path; the Part 1
  compose fix applies there with the next deploy (the new variables are empty = defaults).

## 7. Tests

- `scripts/test/compose-env.test.mjs` — every config.ts variable passed per layout or allow-listed.
- `scripts/test/selfhost-ctl.test.mjs` — install re-run keeps operator lines; per kind: signing (master's own writer),
  shape / extra or nested fields, a domain-change signature on an upgrade, expiry and the 1-hour window, replay, stale
  `fromVersion`, values outside the rules (no command runs), upgrade order and outcomes (applied / rolled back / held),
  rollback with and without restore, backup now / drill / restore order, settings into stack.env + recipients + the
  recreated services (Postgres on a WAL change), restore of both files on a failed start, the off-site keys only in
  offsite.env (0600) and nowhere in status, state, the requests directory or the docker log.
- `apps/master/test/integration/host-actions.test.ts`, `backup-manage.test.ts` — authz (owners), step-up, the request
  files (signature domain, exact field list, string values), one open request, results / expiry / cancel / unattributed
  refusal, the log filter, audit, the off-site round trip, sealing (no secret in responses, audit or the stored row).
- `apps/web/test/host-actions.test.tsx`, `backup-manage.test.tsx` — no-applier state (no request buttons, the operator's
  lines), the outdated applier, breaking-change confirmation, progress across the master restart (502 → reconnect →
  result → reload), rollback / restore confirmations (typed id, second confirmation, nothing sent before).
- **Unverified here:** a real Linux host (systemd path unit triggering on the new files, a real upgrade through the
  applier with the master restarting under a browser, `docker compose up --wait` of the backup service, Postgres restart
  with WAL archiving on, the backup container reading a root 0600 offsite.env); shellcheck is not installed on this
  machine.
