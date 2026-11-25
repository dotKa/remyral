# ADR-0049: Several Claude Code / Codex accounts per machine, chosen by a per-project strategy and switched at a usage limit

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (request 2026-10-19: "makinelere birden fazla Claude / Codex hesabı bağlanabilsin; Claude ve
  Codex API anahtarıyla da kullanılabilsin; session limitine göre otomatik hesap/makine değişsin; sohbetten veya panelden
  elle de değiştirilebilsin"; decisions 2026-10-19: default strategy balanced, paid API switch per project, default
  off, authoritative); implemented by `p13-runtime-accounts`
- **Amends:** ADR-0014 §1 (one auth per runtime → several accounts per runtime; the configured one is `default`),
  ADR-0034 addendum 7a (an added account's own login folder may be lent to one per-job account for one attempt),
  ADR-0040 §2–§5 (limits per account; a new first fallback "same runtime, another account"; the paid switch is also
  authoritative for API-key accounts), ADR-0046 §4 (an account's usage ranks its placement; nearly full accounts go
  last).
- **Related:** docs/design/p13-runtime-accounts.md (design + security review §9), ADR-0016, ADR-0017, ADR-0042.

## Context
Each machine had exactly one login per runtime (`~/.claude`, `~/.codex`) or one API key, and a usage limit paused the
runtime on that machine. The owner has several subscriptions and wants them used side by side, API keys usable as
accounts, automatic switching when one account hits its limit, and a manual switch — without the platform ever holding
a subscription credential (ADR-0014) and without weakening the Windows per-job isolation (ADR-0034).

## Decision
1. **Runtime account** = machine × runtime (Claude Code, Codex) × account: `subscription` (the runtime's own login in its
   own config dir on the worker, `<dataDir>/runtime-accounts/<runtime>/<id>/.claude|.codex`, set as `CLAUDE_CONFIG_DIR`
   / `CODEX_HOME`) or `api_key` (a vault credential sealed to the machine, ADR-0016). The machine's configured auth is
   the `default` account — nothing moves, nobody logs in again. The master stores only a label, the kind, an opaque id,
   the vault credential id and the login state the runtime reports; never a token, an email or an identity.
2. Added accounts travel in the signed panel configuration (`runtimes.<rt>.accounts`, only to `runtime-accounts-v1`
   workers; a machine without a panel configuration cannot get added accounts). The login relay, usage readings, expiry
   flags and usage-limit episodes are per account; ASSIGN_JOB names the account (`execution.account`).
3. **Exclusivity per account store.** Where the worker confines each attempt itself (macOS Seatbelt) logins run in
   parallel as before. With Windows per-job accounts an added account's folder is **lent** to the attempt's slot for that
   attempt only (granted, then taken back with owner + entries; one attempt per account; reclaimed at start, fail
   closed). The `default` login keeps addendum 7a (worker account, beside its own family only) — two subscription jobs
   at once on Windows therefore need two added accounts.
4. **Selection.** Placement ranks (machine, account) pairs: below the skip threshold (project setting, default 90 %)
   first, subscriptions before API keys, then the strategy (workspace default, per project: `balanced` (default),
   `fill_first` with an order, `least_used`), then the machine's score. With one account per machine and `balanced`, the
   machine score decides as before.
5. **Paid switch authoritative.** While the project's `allowPaidFallback` is off, an added API-key account is never used
   automatically nor as a fallback. Exceptions: a person's explicit pin of a job to an account; a model profile's own
   credential (ADR-0016 addendum); a machine whose configured auth is a key runs that runtime's ordinary jobs (never its
   fallbacks).
6. **Usage limits.** A limit of an account holds only that account (no runtime-wide pause). The first fallback is the
   same runtime with another account: on the same machine the parked attempt continues in the same workspace (fresh
   session, continuation note), else a new attempt on another machine; then ADR-0040's wait / runtime fallbacks. Audited
   `job.usage_limit.account_switch`; the timeline says "X hesabı limitte → Y hesabıyla sürdü".
7. **Manual switch** (`POST /jobs/:id/switch-account`, chat card `draft_account_action`): a waiting job is pinned; a
   usage-limit pause resumes with the account; a running job is parked (`PAUSE_JOB cause account_switch`) and resumed
   with it. Every account change is audited; writes need step-up (removing an account: always-fresh).
8. **Chat:** Settings → Chat names the engine's account and a fallback account, tried before the fallback engine.

## Alternatives considered
- **Move the configured login into an account folder** — would read / copy the runtime's credential files (ADR-0014)
  and break the macOS keychain lookup; a re-login of an added account achieves the same with the runtime's own flow.
- **A login per per-job account** (ADR-0034 §9.3 (c)) — N logins of one subscription racing on one refresh token;
  rejected again. Lending one account's folder to one attempt at a time is not that.
- **Account as a pure master-side quota grouping** (the p4 `accounts[]`) — cannot point a runtime at a login.
- **Route by the near-limit readings only, no per-account limits** — a hit would still stop the whole machine runtime.

## Consequences
- Migration 0096; worker release (`runtime-accounts-v1`); master first. Older workers keep the per-runtime rules.
- The agent of a job running with an account can read that account's credential (as with local-login jobs today).
- A cross-machine continuation starts from the prompt (ADR-0042 checkpoints are local).

## Verification
Scheduler tests (exclusions, reasons, exclusivity per store, the family rule only for worker-account logins,
strategies, threshold, paid switch); worker tests (account folders, login relay per account, migration of the default,
env per account for both runtimes, Seatbelt / Windows lend arguments, usage per account, policy); master integration
(accounts API with step-up and audit, parallel jobs on two accounts, paid switch, limit → another account in the same
workspace, manual switch of a waiting and a running job, chat tools); web tests. Live (owner, Windows worker):
docs/design/p13-runtime-accounts.md §12.

## Amended 2026-10-22 (`p15-usage-refresh`, [design](../design/p15-usage-refresh.md))
A usage-limit episode of one login holds every login of the **same provider account** (same usage identity) on other
machines, and an account's `usedPercent` is the newest reading of that account on any machine. Logins of unknown
identity keep the per-machine rule.
