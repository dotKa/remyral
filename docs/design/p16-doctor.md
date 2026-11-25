# Design note: doctor / diagnostics and the support report (p16-doctor)

- **Status:** Implemented (in review)
- **Date:** 2026-10-23
- **Backlog:** p16-doctor (builds on p16-observability, p16-ops-safety, p5-remote-ops, p5-notifications)
- **Owner goal:** "doctor/diagnostic özelliğide getirelim. sorun varsa bize rapor alıp mail ile iletebilirler." —
  customers (self-hosted, one company) run diagnostics in one click and send the vendor a report by e-mail.
- **Decisions applied:** [ADR-0062](../adr/0062-diagnostics-support-report.md) (the support report may leave the
  installation), ADR-0006 (redaction before anything leaves a process), ADR-0017 (signed remote operations), ADR-0056
  (security policy: a new step-up event `support.report`)
- **Migration:** 0147 (`doctor_runs`, `doctor_problems`, `support_settings`, `support_reports`,
  `workers.clock_skew_ms`; notification kind `doctor.problem`, chat draft kind `support_report`, worker op
  `doctor.run`) — renumber at merge if taken
- **Prompt rule:** 46 (45 is taken by the git providers branch) — renumber at merge
- **Threat model:** T-SEC-1 (secrets in logs / telemetry), T-CP-3 (cross-project disclosure), data leaving the
  installation (new, ADR-0062)

## 1. Scope

| Piece | Where |
| --- | --- |
| Master checks (24 named checks) | `apps/master/src/doctor/checks.ts` |
| Runs, machine doctors, the daily light run and its "new problems" notification | `apps/master/src/doctor/service.ts` |
| Support report: build (zip), preview, download, send; support settings (address, SMTP) | `apps/master/src/doctor/support.ts`, `zip.ts`, `mail.ts`, `config-summary.ts` |
| Routes (`/doctor*`, `/support/*`) | `apps/master/src/doctor/routes.ts` |
| SMTP submission shared with the notification e-mail (multiple recipients, a built message) | `apps/master/src/notifications/smtp.ts` (`SmtpClient`) |
| Worker clock skew from heartbeats | `apps/master/src/workers/sessions.ts` |
| Machine doctor (`remyral-worker doctor`, remote op `doctor.run`) | `apps/worker/src/doctor/*`, `cli.ts`, `remote-ops/agent.ts`, `daemon/run.ts` |
| Wire: findings, the machine report, the op, `doctor-v1`, support sections, assistant tools | `packages/protocol/src/doctor.ts`, `remote-ops.ts`, `worker-features.ts`, `assistant.ts` |
| Console: Ayarlar → Tanılama (doctor, machine doctors, support report, support settings), the chat card | `apps/web/src/diyalog/screens/settings/DiagnosticsView.tsx`, `api/doctor.ts`, `drafts/summary.ts`, `packages/i18n/src/*/doctor.ts` |
| Assistant: `run_diagnostics`, `draft_support_report`, rule 46 | `apps/master/src/chat/tools.ts`, `drafts.ts`, `packages/agent-adapters/src/assistant.ts` |

## 2. Master checks

Each check reads what the master already has and returns findings: one `ok` finding when nothing is wrong, else one
per problem (at most 12 per check, the rest summarised as `more`). A finding is `{check, code, severity, message, fix,
docs, params, subject}` (`@remyral/protocol` `DoctorFinding`): closed check ids and codes, English text (the report's
language and the console's fallback), small parameters the console fills into its Turkish / English sentence
(`doctor.findings.master.<check>.<code>`), the console page or guide section that fixes it, and the thing it is about
(a job id, a machine id …) as its identity. A check that throws or takes longer than 10 s becomes `check_failed`.

| Check | Light | Finds |
| --- | --- | --- |
| `db.reachable`, `redis.reachable` | ✓ | `SELECT 1` / `PING`, slow > 500 ms, unreachable / timeout |
| `db.migrations` | ✓ | files of this build not in `schema_migrations` (error), migrations of a newer build (warning) |
| `disk` | ✓ | host data volume / Docker disk ≥ 85 % / 95 % (status snapshot) |
| `master.web` | ✓ | the web container probe |
| `queue.backlog` | ✓ | oldest QUEUED ≥ 5 min (warning), ≥ 1 h (error) |
| `queue.stuck` | ✓ | RESERVED / STARTING / RUNNING / VERIFYING with a lease expired > 2 min, without a lease > 10 min, CANCELLING > 30 min |
| `queue.approval_orphan` | ✓ | AWAITING_APPROVAL > 30 min with no pending approval request ("nothing to decide") |
| `queue.leases_expired` | ✓ | unreleased leases expired > 2 min |
| `workers.offline` | ✓ | no paired machine; machines offline / not seen for 2 min |
| `workers.disk` | ✓ | below `workspace.minFreeBytes` (error, `disk_low`), below 2× (warning) |
| `workers.clock` | ✓ | heartbeat skew ≥ 60 s (warning), ≥ 120 s (error; the ops command window) |
| `workers.outdated` | | worker version older than the stable channel |
| `workers.login` | | installed runtime with `authenticated = no` |
| `workers.sandbox` | | no ready profile in the machine's sandbox status |
| `workers.git` | | git missing, blocking git readiness problems |
| `expiry` | ✓ | the ops-safety registry (cached outside checks): expired (error), urgent (warning), soon (info) |
| `integrations` | | Coolify / Cloudflare last test failed or unusable, GitHub App key / permissions, GitLab / Bitbucket connections whose last test failed (p16-git-providers; their token expiry is in `expiry`) |
| `chat.assistant` | ✓ | the chat cannot answer (error); no ready backup machine (info) |
| `version_feed` | | sources failing their last check |
| `backups` | ✓ | not configured (warning); the backup health reasons |
| `errors.burst` | | HTTP 5xx of the last hour; ≥ 20 / ≥ 200 error lines in the log store in the last hour, top components |
| `webhooks.disabled` | ✓ | webhooks turned off after repeated failures |
| `cost.brake` | ✓ | engaged ceilings (blocking in block mode = error) |

Clock skew: the master stores `now − HEARTBEAT.ts` per worker (`workers.clock_skew_ms`, bounded ±1 day) on every
heartbeat — network latency is included, hence the 60 s floor. Only a reading of the last 30 minutes counts.

## 3. Machine doctor

`remyral-worker doctor [--config] [--json] [--out <file.json|file.zip>]` runs on the machine without the master: the
config is parsed read-only (nothing is created or repaired, unlike `run`), then DNS of the master host → TCP / TLS
(the certificate's end; `CERT_*` / `UNABLE_TO_*` codes told apart from refused / timed out) → `GET <origin>/api/status`
(200 ok, 503 = the master is up but its database or Redis is not) and its `Date` header against the local clock
(±60 s warning, ±120 s error; not compared when the master does not answer), the OS service (`service status`), the
data directory and the workspace root (exists, writable, not world-writable), free disk (< 2 GiB warning, < 512 MiB
error), Node (≥ 24) and npm next to it, git, the runtimes (allowed but not installed, installed but not signed in,
version against the pin — never an identity or a token), the sandbox profiles and the probe's own errors. Every step has
a timeout (8 s; the probe 60 s). Strings pass the Redactor; the report is `WorkerDoctorReport` (≤ 64 findings). Exit 0
without errors, 1 with errors, 2 on a crash. `--out` writes a new file (mode 0600, never overwrites) — JSON, or a zip
with `doctor.json` + `doctor.txt` to attach to a support request by hand.

Remote: the master sends `OPS_COMMAND doctor.run` only to `doctor-v1` workers (signed, windowed, rate-limited and
audited like every remote op; group `diagnostics`, so a local `remoteOps.disabled: [diagnostics]` refuses it). The
worker answers `OPS_UPDATE doctor` (redacted again by the master before it is stored in `worker_ops.result`). Older
workers get `diagnostics.run`; its problems become findings (`worker.*`). `POST /doctor/runs {machines: true}` asks
every connected machine at once and waits up to 20 s (slower answers stay `pending` and show up in the machine list
later); `POST /doctor/machines/:id` asks one.

## 4. Daily light run

An hourly pass runs the light checks when the last daily run is older than 23 h — claimed under an advisory lock with a
placeholder row, so two masters never both run it (a failed run deletes its claim). Its warning / error findings are
upserted into `doctor_problems` by identity (`check|code|subject`): a problem never seen, or seen again after it was
resolved, is new; problems of the checks that ran and are no longer found are marked resolved. New problems produce one
`doctor.problem` notification to owners and admins (critical when one is an error; e-mail / push per their preferences)
listing up to eight; a day with nothing new sends nothing. Manual runs never notify.

## 5. Support report

`POST /support/reports {sections, hours, description}` builds one zip and stores it for 24 hours (`support_reports`,
the bytes cleared afterwards, the facts kept); `GET /support/reports/:id` is its preview (every file with its section,
size, SHA-256 and record count, the Markdown summary exactly as packed, the recipient, the user's cc address, whether
SMTP is ready, the cap); `GET …/download` the zip (audited); `POST …/send` the mail.

| File | Section | Content |
| --- | --- | --- |
| `report.md` | always | the summary: release, sections, doctor counts, the customer's description, the problems with fixes, machines, contents |
| `manifest.json` | always | schema, id, sections, every file with size and SHA-256, the redaction statement |
| `description.txt` | when given | the customer's words |
| `doctor.json` | doctor | the newest full run of the last hour (else a fresh one, without asking the machines) |
| `workers/<id>.json` | workers | the machines' doctor results of that run, else the newest of the last 24 h from the operations log |
| `status.json` | status | the status snapshot |
| `versions.json` | versions | master release / Node / schema, worker release channels, machines with OS, worker and runtime versions |
| `config.json` | config | an **allowlist** of configuration keys (§5.1) and the security policy preset |
| `logs.jsonl` | logs | warn / error lines of the last 1–72 h (default 24) from the log store, ≤ 5000 lines / 4 MiB, a `truncated` marker |
| `failed-jobs.json` | failed_jobs | FAILED / LOST / BLOCKED jobs of the window (≥ 24 h, ≤ 50): ids, project, runtime, times, last trigger and reason, attempts, machine |
| (same file) | job_prompts | + title and prompt (≤ 4000 characters) — **never preselected**; the console warns |

### 5.1 Redaction

Layers: (1) every source is metadata by construction — closed codes, ids, numbers, the allowlisted configuration
(`config-summary.ts`: per key `value` (booleans, numbers, short strings without `://`), `present`, `count` or
`origin`; a secret-looking last segment is refused even if listed; anything not listed is absent — `databaseUrl` is
only "present"); (2) every value passes `redactDeep` with the default pattern rules, secret-looking keys and the exact
SMTP passwords this master knows (the support SMTP and the notification SMTP); (3) the serialised text of every file
passes the Redactor once more. Tests seed a GitHub token and passwords into raw log rows (written past the capture
redaction), the configuration, the SMTP settings and a job prompt and assert none of them is in the bundle.

## 6. Sending

- **Recipient:** `support_settings.email`, default `old-support@example.com`, changed only by the owner. A copy (`ccMe`) goes
  to the sender's own notification e-mail (Settings → Notifications), nothing else — the request cannot name an
  address.
- **SMTP:** the owner-configured server in Ayarlar → Tanılama (host, port, STARTTLS / TLS, sender, user name, password
  sealed with the HKDF sub-key `support-smtp` of the master key, never returned or logged), else the master's
  notification SMTP (`NOTIFY_SMTP_*`, its password from the file). The vault cannot be used: vault values are sealed in
  the browser to the machines' keys and the master cannot open them (ADR-0016). TLS is mandatory, certificates are
  verified (the shared `SmtpClient`).
- **Cap:** attached up to 10 MB (the zip is deflated); above it the mail carries the summary only and says so, the
  console offers the download.
- **Audit:** `support.report.send` (success or failure with the SMTP error code): actor, to, cc, size, sections, SHA-256,
  attached, source (console / chat), which SMTP. Also `support.report.build`, `support.report.download`,
  `support.settings.update` (never the password), `doctor.run`.
- **Policy:** `support.report` (admin) and `support.settings` (owner) belong to the new step-up event `support.report`
  (category data): off in Serbest, on in Dengeli and Sıkı. Running the doctor, previewing and downloading are
  `doctor.run` (admin, no code, an admin API token may use them).

## 7. Assistant

`run_diagnostics {machines?}` (read, `doctor.run`) returns the problems with fixes and links, the passed checks and —
with machines — every machine's summary and problems. `draft_support_report {description, sections?, hours?, ccMe?}`
(draft, `support.report`) is a card whose confirmation builds and sends the report through the same service; the
security policy decides whether it runs at once (Serbest) or waits for a code (event `support.report`). Rule 46: look
first, answer with severity / finding / fix, send machines that cannot reach the master to `remyral-worker doctor`,
draft the report with the user's own words, keep job prompts out unless agreed, never claim a send without `sentTo`.

## 8. Security review

- **Data leaving the installation** (ADR-0062): only on an explicit send by an owner / admin, to the owner's address,
  under the security policy, previewed (exact files) and audited with the bundle's hash. Nothing is sent automatically;
  the daily run only notifies inside the installation.
- **Secrets:** §5.1; the SMTP password sealed at rest, never in an answer, audit entry or log; the support settings need
  the owner and the step-up event.
- **Header injection:** recipients are checked addresses, the subject an encoded word with control characters removed,
  the attachment name fixed.
- **Abuse / load:** report bundles ≤ 50 MB, logs capped, kept 24 h; remote doctor ops go through the remote ops rate
  limits; the daily run is single-flight across masters; all checks are reads with timeouts.
- **Cross-project disclosure:** admin-only (owners and admins see every project anyway); job prompts only on request.
- **Worker:** the doctor is read-only (no config written, no directory created); `--out` refuses an existing path.

## 9. Rollback

Revert the commits; migration 0147 is additive (an older master ignores the tables and the column; drop them by hand, see
the migration header). To switch off without a revert: do not use the page; the daily pass can be stopped by setting
`doctor.intervalMs` to 0 in main.ts (no environment variable on purpose — it only notifies).

## 10. Tests

- `apps/master/test/integration/doctor.test.ts` — permissions; seeded problems (approval with nothing to decide,
  offline machine, expired API token, worker clock 5 min behind from a raw heartbeat); a `doctor-v1` raw worker answering
  `doctor.run` (redacted); the bundle (files, sections, unticking, job prompts only on request, every seeded secret
  absent, download audited, manifest hashes); support settings (owner only, sealed password); sending through a fake
  STARTTLS SMTP server (attachment hash, cc, AUTH, audit) with Serbest / Sıkı step-up; the attachment cap; the daily run
  notifying only new and returning problems.
- `apps/master/test/unit/doctor.test.ts` — config allowlist, zip writer, MIME message, old-worker mapping.
- `apps/master/test/integration/chat-direct.test.ts` — `run_diagnostics`, `draft_support_report` sent at once in
  Serbest and waiting for a code when the event is on; operators refused.
- `apps/worker/test/doctor.test.ts` — healthy machine, offline master, untrusted certificate, a hanging connect, bad
  DNS, wrong clock, 503 master, local problems, read-only config, the CLI (`--json`, exit codes, `--out` json / zip,
  no overwrite). `remote-ops-agent.test.ts` — `doctor.run` answered, refused without a doctor and when diagnostics are
  disabled locally.
- `packages/protocol/test/doctor.test.ts`, `packages/agent-adapters/test/assistant-doctor.test.ts`,
  `apps/web/test/diagnostics.test.tsx` (run, findings in Turkish, machines, sections, preview, send with cc, cap,
  settings owner / admin).
