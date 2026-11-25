# p19-verifier-jobs — platform verifier jobs are not "failed jobs"

- **Task:** `p19-verifier-jobs`. **Date:** 2026-10-29. **Migration:** 0193. **Worker release:** none.
- **Owner report (2026-10-29):** notifications "Auto-fix job <id> failed too: You are a VERIFIER started by the
  platform to check the…", "Job failed in sample-leads: Fix: You are a VERIFIER… (verification_failed)", "Alarm: Job
  failure spike" — "benim verifier olduğum işler failed bildirimi gönderiyor. bunu düzeltmemiz lazım … state
  eklenebilir veya daha uygun bir yol bul."
- **Builds on:** [p10-verify-health](p10-verify-health.md) (job verifications, §11 report-only jobs),
  [p15-auto-mode](p15-auto-mode.md) (automatic retries, auto-fix jobs), [p15-git-central](p15-git-central.md)
  (credentials right before each fetch / push), [p15-job-titles](p15-job-titles.md).

## 1. What happened (root causes, confirmed in code)

The failing job was the verifier of a job in `sample-leads` (a private GitHub repository): a report-only job
(`report_only_jobs.purpose = 'verify'`), created as the person who started the verified job, with no title (so every
surface showed its prompt, "You are a VERIFIER…").

1. **No git credential.** `GitFlowService.prepareDispatch` skips report-only jobs (p11-fixes-a: no `job_git` row, so no
   commit / push / merge gate). The worker asks for a job-scoped token right before its fetch (`CREDENTIAL_REQUEST`), and
   `GitHubWorkerCredentials.issue` granted one only to a trusted job **enrolled in git flow** (`job_git` row) — or an
   untrusted pinned pull-request head. A report-only job is never enrolled, so the answer was `unavailable`; the worker
   fetched anonymously: `GitCommandError: git fetch failed (exit 128): fatal: could not read Username for
   'https://github.com': terminal prompts disabled`. (`HostedWorkerCredentials` — GitLab / Bitbucket — had the same
   enrolment gate; a project vault credential, `execution.gitAuth`, was already sent to report-only jobs.)
2. **A transient retry storm, then failure.** The self-heal classifier calls that `git_auth` (transient), so the job
   ran 1 + 3 automatic retries (the "4×") and then failed for good.
3. **Treated like ordinary failed work.** The FAILED transition produced the generic `job.failed` notification, was
   counted by the `jobs.failure_spike` alert, and — the verifier being "created by a user" — auto mode opened a fix job
   "Fix: You are a VERIFIER…", which failed at git flow verification (diverged) and notified again. A fix
   job for a verifier is meaningless: the verifier's outcome belongs to the job it checks.

## 2. Credentials (fix 1)

A report-only job (`verify`, `health`, `integration-verify`) gets a credential for its checkout through the same path
as any job of the project (CREDENTIAL_REQUEST → `GitCredentialProvider.issue`), with **read** scope:

| Provider | Report-only job gets |
| --- | --- |
| GitHub App | a `contents: read, metadata: read` installation token for the project's repository, **whatever its source trust** (ADR-0010 forbids write credentials for untrusted sources, not read ones — the same rule as the untrusted pull-request head of ADR-0026). The worker uses it for its own fetch; it is never in the runtime's environment. |
| GitLab / Bitbucket | the connection credential, **only for a trusted source** (hosts cannot mint a read-only token on demand — the same gate as a trusted job of the project). The job is never pushed (no `pushResult`), so the credential is only used for the fetch. |
| Vault credential (`gitAuth`) | unchanged (was already sent). |

The repository must still be the project's configured one. Test: `test/unit/gitflow-credentials-report-only.test.ts`
(fails on the old code: `null` for the non-enrolled verifier).

## 3. State and presentation (fix 2)

**Decision: no new job state, no new verification state.** The verifier job keeps the job state machine (FAILED is
true: its run failed — retries, leases and audit depend on it). The checked job's verification already has the
fitting state: `job_verifications.state = 'error'` means "the verifier could not run" (p10-verify-health §3.2). What
was missing is *why* and *what this job is*:

- `job_verifications.error_cause` (migration 0193): a short cause id when the state is `error` — the self-heal
  classification of the verifier's failing transition (`git_auth`, `git_network`, `timeout`, `runtime_crash`, `login`,
  `disk_low`, `provider_error`, `machine_lost`, `cancelled`, `run_failed`) or a master reason (`not_started`,
  `no_report`, `verifier_missing`). Ids only — the failure text is untrusted and never echoed (`verify/causes.ts`).
- `report_only_jobs.checked_job_id` (migration 0193): the job a report job checks (verifier → verified job, integration
  verifier → the integration's root job, screenshot job → none), written in the creation transaction.
- **Platform marker** on job reads (`GET /jobs`, `GET /jobs/:id`: `platform: {purpose, checkedJobId, checkedTitle,
  outcome, errorCause} | null`, `verify/platform-marker.ts`). `outcome` is the checked job's verification as this
  verifier left it: `verified` (passed / warned), `issues` (failed), `unverifiable` (error), `running`; without a record
  (integration verifier, a retried verification) the verifier's own end (FAILED / CANCELLED / LOST → `unverifiable`).

Console (`apps/web/src/diyalog/job/platform.tsx`):

- a **"Doğrulama" badge**, the outcome as the state pill — **Doğrulandı / Doğrulama sorun buldu / Doğrulanamadı /
  Doğrulanıyor** — instead of "Başarısız", in the job list, the job header (with "Doğrulanan işi aç") and the chat
  result card; no "Yeniden çalıştır" / "Düzelt" for a verifier (running it again as ordinary work would drop its
  report-only marker);
- **titles**: set at creation in Turkish (`spec.title`): "Doğrula: <checked job's title>", "Sağlık kontrolü: <host>",
  "Entegrasyon doğrulaması: <root job's title>"; the console says them in the reader's language from the marker
  (`verifierJobs.title.*`, en: "Verify: …");
- the checked job's **Verification card** in state `error`: "Doğrulama çalıştırılamadı: repo okunamadı (git kimlik
  bilgisi yok)" and **"Doğrulamayı yeniden dene"**; the chat result card of the checked job shows "Doğrulama:
  <outcome>" (and the cause).

## 4. Not counted as failed work

`PLATFORM_JOB_SQL` (`verify/report-only.ts`): a report-only job, or an auto-fix job opened for one (history before this
change). Such jobs get:

- **no `job.failed` notification** (`notifications/producers.ts`);
- **no auto-fix job** (`self-heal/auto-fix.ts`: recorded as skipped, "platform verifier jobs never get an auto-fix
  job"); fix jobs of verifiers never got fixes of their own (existing rule);
- **no failure spike** (`alerts/rules.ts`), **not in the failure digest** ("Son 24 saat: X başarısız",
  `self-heal/service.ts`) nor in the weekly report's failed-jobs list (`efficiency/service.ts`);
- the **existing transient retries** only (unchanged; with the credential fixed the git_auth storm no longer happens).

They stay visible in the job lists with their badge. The OpenTelemetry `job failures` counter still counts every
FAILED transition (an operations metric, not a product statistic).

## 5. One notification, with an action

When a verification ends `error`, the checked job's owner (the verification's creator; with a held gate also the
project admins, as before) gets **one** `verify.failed` notification: title "Doğrulama çalıştırılamadı: <job title>",
body "Doğrulama çalıştırılamadı: <cause in plain words> … “Doğrulamayı yeniden dene”", link to the checked job. The
host name comes from the project's git provider ("repo okunamadı (GitHub kimlik bilgisi yok)"). The text is Turkish
(the console's default language; the notification store has no per-reader language). `failed` (content) keeps its
English text. The dedupe key includes the finish time, so a retried verification that fails again notifies again —
still once per run.

**Retry:** `POST /jobs/:id/verification/retry` — `jobs.create` in the job's project (creating a verifier job), CSRF,
body `{}` (1 KiB limit), audited `verify.retry` (success / denied). Only from `error`, only while the checked job is
SUCCEEDED (409 `verification_not_retryable` otherwise); the row goes back to `waiting`, the next verification tick
creates a new verifier as the job's creator (re-authorised then). The earlier verifier stays in the list
(`unverifiable`).

## 6. Chat / plan

- The checked job's result card in the chat shows the verification outcome; a verifier's card shows its outcome, no
  "Düzelt" / "Yeniden çalıştır".
- **Plan items follow the checked job**: a plan item linked to a verifier job reads the checked job's state
  (`followCheckedJobs` in the plan facts, `chat/plans.ts`) — a verifier that could not run never fails a plan item.

## 7. Data (migration 0193)

Additive: `report_only_jobs.checked_job_id` (+ index), `job_verifications.error_cause`. Back-fill: existing verifiers
linked to their checked job (verifications, integrations); existing report jobs whose title was only derived from the
verifier prompt get "Doğrula: <checked title>" / "Sağlık kontrolü" / "Entegrasyon doğrulaması" (a title a person edited
is kept). No job state or history is changed. Rollback: an older master ignores both columns.

## 8. Security review

| Concern | Answer |
| --- | --- |
| A read token for an untrusted job's verifier | Read scope only (ADR-0010 forbids write credentials); the repository must be the project's configured one; the worker uses it for its own fetch and never hands it to the runtime (p15-git-central). The verifier's prompt is master-built; the report is data. |
| Hosted credential for a trusted verifier | The same credential a trusted job of the project gets; the job is never pushed (no `pushResult`, no `job_git`). Untrusted: none. |
| Marking a job "platform" to hide its failures | `report_only_jobs` is written by the master in the creation transaction only — never from a request body; the marker is read-only on the API. |
| Retry abuse | `jobs.create` in the project (the same right as starting the verifier by hand), audited, only from `error`; the verifier is still re-authorised as the job's creator when created. |
| Notification text | From the cause id and the job's title only — never the failure text. |

## 9. Tests

- Unit: `gitflow-credentials-report-only.test.ts` (the reproduction), `verifier-jobs.test.ts` (titles, the spec's
  title, the production failure → `git_auth` → "repo okunamadı (GitHub kimlik bilgisi yok)", the marker's outcome
  rules, plan following).
- Integration (`test/integration/verifier-jobs.test.ts`, Postgres): verifier title and marker, the production failure
  → `error` + `git_auth`, the list's outcome, one Turkish `verify.failed` and no `job.failed`, no failure spike / digest,
  auto-fix skipped, retry (404 for an invisible project, 200, 409, a new verifier on the next tick, audit).
- Web: `diyalog-jobs.test.tsx` (badge + outcome, no run again), `diyalog-job.test.tsx` (header, cause + retry, helpers in
  tr / en), `chat-job-result.test.tsx` (the checked job's verification line).
