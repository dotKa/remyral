# ADR-0040: A job that hits a usage limit waits for the reset or continues on a fallback — it is not failed

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** owner (request 2026-10-18: "saat limitleriyle ilgili de fallback mekanizması yapılsın");
  implemented by `p11-usage-limit-fallback`
- **Amends:** ADR-0014 §5 (a usage limit pauses that runtime — now per store / credential / model, one notice per
  limit), ADR-0036 (PAUSED also for a usage-limit wait; a resume may switch runtime in the same workspace), ADR-0018 /
  ADR-0025 (the chat assistant gets a fallback engine), p6-quota-scheduling (per-job fallbacks stay; a project policy
  adds fallbacks for jobs that name none).
- **Related:** docs/design/p11-usage-limit-fallback.md (design + security review §10), ADR-0004, ADR-0008, ADR-0010,
  AGENTS.md rules 6, 7.

## Context
Runtimes on subscriptions stop at their provider's usage limits (Claude Code 5-hour and weekly windows, the Opus weekly
cap, Codex plan limits; API keys at quotas). Detection existed (p6), and the master paused the runtime on that machine,
but the job that hit the limit ended FAILED (its work released with the worktree), every job that hit it sent its own
notification, nothing said when it reset, only jobs with an explicit fallback list could move on, nothing guarded paid
fallbacks, and the chat assistant just errored.

## Decision
1. **Typed detection.** Adapters classify a failure as `usage_limited` (with kind, model scope, the reset and the
   runtime's redacted words), a login problem (never waited out) or a transient fault (never a limit). The worker adds
   the scope — the subscription login store, an API credential, or one model — and reports `JOB_RESULT.error.usageLimit`.
2. **Policy per project with a workspace default:** `auto` (default: wait when the reset is at most `maxWaitHours`,
   default 6, away; else fall back when a fallback can run; else wait), `wait`, `fallback`, `fail` (the old behaviour);
   an ordered fallback list of runtimes and catalog profiles (the same runtime with an API-key profile counts); and
   `allowPaidFallback` (off by default).
3. **Waiting keeps the workspace.** On workers with `usage-limit-park-v1` the limited run is parked like an approval
   pause (worktree, sandbox dir, runtime session kept) and the job goes to PAUSED; at the reset (+ jitter) the same
   attempt resumes on the same machine under a new epoch. A fallback may continue the parked attempt on that machine
   with another runtime (fresh session in the same worktree, continuation note); if no option can start there it is
   restarted elsewhere as a new attempt. Older workers: the job goes to RETRY_WAIT and is requeued at the reset (or at
   once for a fallback). A usage-limit wait never cancels a job.
4. **Cost safety.** Without `allowPaidFallback` a fallback never runs with an API key: profiles with a credential are
   dropped and machines whose runtime uses an API key are blocked for fallback options. Budgets apply to every option,
   on resume too.
5. **Scheduler awareness and notices.** One episode per store / account / credential (and model): runtime-wide limits
   pause the store (p4 provider pause), credential and model-scoped limits hold only the options that use them. One
   notification per episode when it starts and one when it resets.
6. **Chat.** An engine at its limit is skipped until its reset; the chat says when it works again and, with a fallback
   engine configured, answers the same message there. The user's message is never dropped.

## Alternatives considered
- **Always requeue as a new attempt (no parking).** Simpler and works with every worker, but loses the work done so far
  (the attempt branch is only pushed on success). Kept as the path for older workers.
- **Keep the run alive until the reset.** Holds the machine slot and the lease for hours; a worker restart loses it.
- **Fall back automatically to any configured runtime.** Rejected for cost: an API-key fallback can bill a lot; it needs
  an explicit project opt-in.
- **A new job instead of a resumed attempt.** Breaks the job's identity (links, chat watches, approvals, sub-job trees);
  the same job and attempt continue instead.

## Consequences
- Migration 0088 (`usage_limit_defaults`, `projects.usage_limit_policy`, `usage_limit_episodes`, `usage_limit_hits`,
  `job_pauses.cause/resume_at/usage_limit/resume_options`, `chat_settings.fallback_*`, `chat_engine_limits`, two
  notification kinds appended to the current constraint lists).
- Worker release (`usage-limit-park-v1`, typed limit info, assistant detection, resume with another runtime).
- Paused time no longer counts against the master's wall-time backstop.
- Jobs that hit a limit are no longer FAILED by default; dashboards counting failures see fewer, the queue shows them
  as paused / waiting.

## Verification
Adapter parsers with real-ish texts per runtime; protocol schemas and the decision rule; worker park / resume (same
and other runtime); master integration with real worker daemons and a fake clock (park → auto resume at reset, one
notice per store, scheduler holds, fallback in the same workspace, requeue paths, paid and budget guards, policy API);
chat engine fallback; web UI. UNVERIFIED live: the exact limit texts of real Claude Max / ChatGPT Codex accounts and a
real session resumed after a limit.

## Amended 2026-10-20 by [ADR-0049](0049-runtime-accounts.md) (`p13-runtime-accounts`)
On machines with runtime accounts a limit holds only the account that hit it (no runtime-wide pause), the first fallback is the same runtime with another account (same machine first, in the same workspace), and `allowPaidFallback` also governs API-key accounts (authoritative: never used automatically or as a fallback while off).
