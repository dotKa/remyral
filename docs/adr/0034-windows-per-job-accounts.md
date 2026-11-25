# ADR-0034: Per-job Windows accounts for parallel host-restricted attempts

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** owner (run host-profile jobs in parallel on Windows now), agent
- **Related:** `p9-windows-host-isolation`, `p9-queue-priority` (ADR-0033, `profile-slots-v1`), ADR-0007, ADR-0019,
  ADR-0029, threat model T-SBX-4; design [p9-windows-host-isolation.md](../design/p9-windows-host-isolation.md)

## Context
ADR-0007 runs host profiles as one dedicated low-privilege worker account. Without per-attempt filesystem confinement
(Linux/Pi host profiles, Windows) concurrent attempts of that one account can read and change each other's workspaces,
so the worker runs them one at a time (T-SBX-4). macOS confines each attempt with Seatbelt and is parallel. Windows has
no Seatbelt equivalent the worker can apply to an arbitrary runtime; it does have per-account ACLs. The owner wants
host jobs on the Windows machine to run in parallel.

## Decision
1. On Windows each concurrent `host-restricted` / `runtime-sandbox` attempt runs as its own local account
   `remyral-job-<n>` from a pool of 1..16 (default max(`maxParallelJobs`, 4); `sandbox.windowsJobSlots`, `0` = off).
2. The pool is created and its passwords rotated only by the privileged helper's Prepare step `job_slots_provision`
   (SYSTEM, fixed embedded script, fixed arguments). Accounts get batch logon only — interactive, RDP, network and
   service logon are denied — and are hidden. Each random password is stored only as a DPAPI LocalMachine blob in a
   folder readable by SYSTEM, Administrators and the worker service, never by a slot account.
3. The worker service gets `SeAssignPrimaryTokenPrivilege` and `SeIncreaseQuotaPrivilege`; the job runner logs the
   account on (`LOGON32_LOGON_BATCH`) and starts the runtime with `CreateProcessAsUser` inside the worker-owned Job
   Object. The runner accepts no account name other than `remyral-job-<n>`; its spec lives in the worker-only data dir.
4. Each attempt's directories get a protected DACL (SYSTEM, Administrators, worker full; the slot modify; `OWNER RIGHTS`
   synchronize only); the mirror objects and package caches it needs are granted to its account for the attempt only.
   After its last process the account removes its own scheduled tasks and processes, the grants are revoked, and only
   then is the account free; any cleanup failure quarantines the account until the next Prepare.
5. Parallelism is enabled only after a cross-access self-test on the machine (each account denied its neighbour's
   directory, the data dir and the credential store; each running as its own SID) passed for the current pool
   generation and job runner. Otherwise host attempts keep running one at a time as the worker account, and the
   Sandbox card says why and what fixes it.
6. The worker reports host concurrency (`hostRestrictedConcurrency()`, `profileConcurrency['host-restricted']`):
   verified healthy accounts ∩ `maxParallelJobs` on Windows, `maxParallelJobs` with Seatbelt, 1 otherwise.
   `unconfined` stays exclusive.

## Alternatives considered
- **CreateProcessWithLogonW** — needs no privileges, but the account must be allowed to log on interactively; rejected
  (hardening).
- **CreateProcessWithTokenW** — needs SeImpersonate; runs through seclogon; handle/job behaviour unverified.
- **S4U, no password** — a usable S4U token needs SeTcbPrivilege (SYSTEM); Task Scheduler S4U tasks have no std pipes
  or job object for the worker; rejected for now.
- **Restricted tokens with per-slot restricting SIDs** — same user SID, would need every system ACL the runtime
  touches to carry the slot SID; breaks runtimes.
- **Keep one at a time** — the owner decided against it.

## Consequences
- Windows host jobs run in parallel after a one-time installer re-run (helper update) and a privileged Prepare.
- The worker service holds two more privileges (it already holds SeImpersonate as a service). Slot attempts no longer
  inherit the service token's privileges — an improvement over today's host attempts; attempts that still run as the
  worker account are a follow-up (`p9-windows-worker-token-privileges`).
- Residual: shared loopback ports and egress proxies, process list, default-DACL named pipes, world-writable machine
  locations, shared `local-login` state (as on macOS).
- Linux/Pi host profiles stay one at a time (`p9-linux-host-isolation`).

## Verification
Unit tests with a fake Windows runner (`apps/worker/test/sandbox-windows-slots.test.ts`, `sandbox-prepare.test.ts`);
a Windows-only integration test (`REMYRAL_WINDOWS_SLOT_IT=1`); live on the owner's Windows machine after the release:
privileged Prepare → `job_slots` ok, "Parallel: up to N", two host jobs running at once under different accounts
(`p9-windows-host-isolation-live`).

## Addendum 2026-10-17: subscription logins are never shared with per-job accounts (`p9-windows-slots-local-login`)
Live on Windows 1.0.31 two Claude Code `local-login` jobs ran at once on `remyral-job-1/2`, sharing the worker's
subscription login through a `remyral-job-slots` grant on `.claude` / `.claude.json` (Decision 4's shared login state,
"as on macOS"). Both failed on Claude Code's OAuth refresh lock and the login stayed unusable afterwards (refresh-token
rotation; the slots cannot take or break the legacy lock in the worker's profile root). Decision amended:

7. `local-login` attempts (subscription logins) never run as a per-job account: they run as the worker account, one at
   a time and only on an otherwise idle worker (transient decline otherwise); per-job accounts are used only for
   runtimes whose auth is per process (secret-ref API keys / vault, or none), each with a per-attempt HOME. The slots
   get no entry on the worker's login stores; the worker removes an old one (and takes back ownership) and uses the
   pool only after proving that (`job_slots_login_shared` otherwise). Reported concurrency stays N for the profile;
   the Sandbox card says "Parallel: up to N for API-key runtimes; subscription logins run one at a time".

Rejected: a refresh broker with read-only copies (Claude Code has no read-only credential mode — every copy would
refresh and rotate), a login per slot account, wider ACLs. Details, the verified lock behaviour of the pinned CLI and
the security review: [design §9.3](../design/p9-windows-host-isolation.md). Consequence: the "shared `local-login`
state" residual is gone on Windows; subscription jobs on Windows are sequential again.

## Addendum 2 2026-10-17: exclusivity per login store and per job family (`p9-subjob-local-login-deadlock`)
Live on Windows 1.0.34 a Claude Code job (local-login) asked a Codex sub-job (local-login) and waited for it; decision 7
kept the child queued until the parent's wait ran out — a deadlock. "Alone" served two reasons with narrower scopes:
the OAuth refresh race exists only between processes of the **same login store** (Claude Code `.claude`, Codex
`.codex`), and the missing filesystem isolation of worker-account attempts (T-SBX-4) matters only between **unrelated**
jobs — a job and its agent-requested sub-jobs (ADR-0031: same project, same creator, prompts, inputs and results flow
between them by design) already share their data. Decision 7 amended:

7a. With per-job Windows accounts a `local-login` attempt (worker account) starts only when no `unconfined` attempt
    runs, every running attempt belongs to its job family (ASSIGN_JOB `execution.family`, master-derived from
    `job_subtasks.root_job_id`; same project), and no running `local-login` attempt uses the same login store
    (conservative: one per store, although same-account refreshes use Claude Code's mkdir lock correctly — macOS
    Seatbelt keeps its parallel same-store behaviour). An API-key slot attempt starts beside a worker-account attempt
    only within that attempt's family. Unrelated jobs keep the full exclusivity. The worker reports
    `CAPABILITIES.localLogin.stores`; the master mirrors the rule (`subscription_login_busy` /
    `subscription_login_exclusive`) and tells a waiting parent `blocked_by_parent` when its queued sub-job can only run
    once the parent ends.

Residual risk accepted: family members may read and modify each other's working files while both run (no new
information flow beyond what delegation already carries; pushes, approvals and secret scans stay per job). Details and
the security review: [p9-subjob-local-login.md](../design/p9-subjob-local-login.md).

## Addendum 3 2026-10-20: an added runtime account's folder may be lent to one per-job account (`p13-runtime-accounts`)
[ADR-0049](0049-runtime-accounts.md): an **added** subscription account keeps its login in its own folder under the worker data dir (config dir and both refresh locks inside it). With the pool active and those folders taken back since the worker started, its attempt runs on a slot that gets Modify on that one folder for that attempt only (granted at the first spawn, then owner + entries taken back after the last process; one attempt per account at a time). The configured login (`default`, in the worker profile) keeps decision 7 / 7a unchanged. Details: [p13-runtime-accounts.md](../design/p13-runtime-accounts.md) §2.1.
