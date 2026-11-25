# Design note: `p9-windows-host-isolation` — parallel host jobs on Windows through per-job accounts

- **Task:** `p9-windows-host-isolation` (follow-ups `p9-windows-host-isolation-live`, `p9-linux-host-isolation`,
  `p9-windows-worker-token-privileges`). **Date:** 2026-10-17.
- **Owner decision (2026-10-17):** run host-profile jobs in parallel on Windows now.
- **Decision record:** [ADR-0034](../adr/0034-windows-per-job-accounts.md) (amends ADR-0007 §host-restricted, T-SBX-4).
- **Coordinates with:** `p9-queue-priority` (ADR-0033, `profile-slots-v1`): this task supplies the number the worker
  reports as `profileConcurrency['host-restricted']` (`SandboxRunners.hostRestrictedConcurrency()`).
- **Migration:** none. **Protocol:** additive (`SandboxCheckId` `job_slots`, `PrepareStepId` `job_slots` /
  `job_slots_provision`, `SandboxProfileStatus.concurrency` / `concurrencyNote`). **Worker release needed:** yes.
  **Privileged helper:** the installer kit must be re-run once on the Windows machine (the helper is never auto-updated).

## 1. Problem

`selectProfile` (apps/worker/src/sandbox/policy.ts) refused a second host attempt when `filesystemConfinement` was
`none` (T-SBX-4): on Windows every host attempt ran as the worker service account `NT SERVICE\RemyralWorker`, so two
attempts could read and modify each other's workspaces, scratch, git views and package caches. A Windows worker with
`maxParallelJobs: 3` therefore ran host jobs one at a time (declining the others with a T-SBX-4 text).

## 2. Current state per OS (from code, 2026-10-17)

| OS | `host-restricted` confinement | Parallel today? |
|---|---|---|
| macOS | Seatbelt per attempt (`host/seatbelt.ts`): writes only to the attempt's dirs, reads of other attempts, the data dir and protected homes denied, network only to the job's proxy → `filesystemConfinement: 'seatbelt'` | **Yes**, up to `maxParallelJobs`. Shared on purpose: the worker HOME login dirs of `local-login` (`hostExtraWritable`, keychain), loopback ports, process list. |
| Linux / Pi | None beyond the worker user (`HostRestrictedRunner.filesystemConfinement` is `seatbelt` only on darwin). bubblewrap is used only *inside* `runtime-sandbox` (the runtime's own sandbox), and `runtime-sandbox` goes through the same host check → `none` | **No**: host-restricted and runtime-sandbox run one at a time. The `container` profile (rootless Podman/Docker) is parallel. **Gap** → `p9-linux-host-isolation` (per-job uids or a bwrap filesystem view; not in this task). |
| Windows (before) | Job Object limits, attempt dirs ACL'd to SYSTEM/Administrators/worker — all attempts are the same account → `none` | **No** (T-SBX-4). |
| Windows (this task) | Every attempt runs as its own local account `remyral-job-<n>`, its dirs ACL'd to it → `filesystemConfinement: 'job_user'` | **Yes**, up to the verified accounts ∩ `maxParallelJobs`; else one at a time as before. |

`unconfined` (ADR-0019) stays one at a time everywhere: it *is* the worker account by design, and while it runs no
host attempt starts (it could read their workspaces).

## 3. Design

### 3.1 The account pool (privileged, `job_slots_provision`)

`infra/worker/windows/remyral-job-slots.ps1` (embedded in the signed bundle like the job runner, written next to the
worker by the helper, run as SYSTEM by the `RemyralWorkerUpdater` task's privileged Prepare — fixed arguments only):

- local group `remyral-job-slots`; accounts `remyral-job-1..N` (members of it and of `BUILTIN\Users`, by SID — group
  names are localised on tr-TR); password never expires, user may not change it, hidden from the sign-in screen;
- a **new random password per account on every run** (27 random bytes → 36 base64 chars + one per character class);
  it exists only as a DPAPI **LocalMachine** blob (`entropy remana-job-slot-v1`) in
  `C:\ProgramData\RemyralWorker\job-slots\remyral-job-<n>.cred`; that folder is protected (SYSTEM full, Administrators
  full, the worker service SID read) — never readable by a slot account;
- group rights (LSA): `SeBatchLogonRight` only; **denied** `SeDenyInteractiveLogonRight`,
  `SeDenyRemoteInteractiveLogonRight`, `SeDenyNetworkLogonRight`, `SeDenyServiceLogonRight`;
- worker service SID: `SeAssignPrimaryTokenPrivilege` + `SeIncreaseQuotaPrivilege` (CreateProcessAsUser, §3.2). A
  newly granted privilege reaches the service token only with a new **service logon**: the helper (SYSTEM) then stops
  and starts the RemyralWorker service itself after reporting (§9 — a restart of the worker process is not enough);
- `remyral-job-slots` may read (RX) `<dataDir>\runtimes` and `<dataDir>\tools` (worker-managed runtimes, MinGit,
  cloudflared — the rest of the data dir stays worker-only);
- accounts above N (up to 16) are disabled; `slots.json` (accounts, SIDs, group SID, worker SID, a new `generation`)
  is written last.

N = `sandbox.windowsJobSlots` from the root-owned config, else max(`maxParallelJobs` of the local file, 4), clamped to
1..16. `windowsJobSlots: 0` is the owner's local off switch (no accounts provisioned, the worker never uses them).
`-Remove` deletes accounts, group, rights and state (uninstall; manual today).

### 3.2 How a job runs as a slot account (verified API facts, not guesses)

Today (verified 2026-10-14) `remyral-jobrun.ps1` creates a Job Object, `CreateProcessW` (same account) suspended,
assigns, resumes, forwards the three std handles, waits. New: the spec may carry
`runAs: { user: "remyral-job-<n>", credentialFile }` (the script refuses any other user name). The runner (still the
worker account) decrypts the blob (`ProtectedData.Unprotect`, LocalMachine), calls
`LogonUserW(user, ".", pw, LOGON32_LOGON_BATCH)`, wipes the password buffer, enables its two privileges and calls
`CreateProcessAsUserW(token, …, CREATE_SUSPENDED, …)` with the same handle list and `lpDesktop = ""`. The Job Object
stays in the runner process (worker account): kill-on-close, limits and cancellation are unchanged.

Microsoft's API reference (Context7 `/websites/learn_microsoft_en-us_windows_win32`, 2026-10-17): *"CreateProcessAsUser
must have the SE_INCREASE_QUOTA_NAME privilege and may require the SE_ASSIGNPRIMARYTOKEN_NAME privilege if the token is
not assignable. CreateProcessWithLogonW requires no special privileges, but the specified user account must be allowed
to log on interactively. … CreateProcessWithTokenW must have the SE_IMPERSONATE_NAME privilege."* Choice:

| Option | Why (not) |
|---|---|
| **LogonUser(BATCH) + CreateProcessAsUser** (chosen) | Slots need only batch logon (interactive/RDP/network denied). The runner keeps its std-handle list and suspended-assign-resume sequence unchanged. Costs two privileges for the worker service (granted by the helper). |
| CreateProcessWithLogonW | No privileges, but the account must be allowed to **log on interactively** — contradicts the hardening; goes through the seclogon service. |
| CreateProcessWithTokenW | Needs SeImpersonate (services usually hold it), but runs through seclogon; std-handle and job behaviour not verified; still needs a password for the token. |
| S4U (no password) | `LsaLogonUser` with S4U returns a usable primary token only to a caller holding **SeTcbPrivilege** (SYSTEM); the worker must not. Task Scheduler S4U tasks (run by SYSTEM) have no std pipes to the worker and no job object — a different execution model; rejected for now. |
| Restricted tokens (no accounts) | Same user SID as the worker; would need a per-slot restricting SID on every ACL the runtime touches (HKCU, profile, Program Files); breaks runtimes; not what the owner asked for. |

So a password exists, but only in the DPAPI blob that SYSTEM writes and only the worker service (and admins) can read.

### 3.3 Per attempt (worker, `HostRestrictedRunner` on win32, restricted mode)

Acquired at the attempt's first spawn (one account per attempt, reference counted across its spawns):

| Path | ACL / grant |
|---|---|
| attempt worktree, attempt sandbox dir (git view, runtime state dir, TEMP, HOME, APPDATA, LOCALAPPDATA) | protected DACL: SYSTEM F, Administrators F, worker F, **slot M**, `OWNER RIGHTS (S)` |
| the project mirror's `objects` (git alternates) | + slot RX, for the attempt only |
| the project's package cache dirs (ADR-0029) | + slot M, for the attempt only |
| `local-login` (`keepHome`): worker's `.claude`, `.claude.json`, `.codex` (or `hostExtraWritable`) | **nothing** (§9.3, was: group M — two slots sharing one subscription login broke it live): local-login attempts run as the worker account, one at a time; the worker removes any slot entry from these stores before using the pool |
| `<dataDir>\runtimes`, `<dataDir>\tools` | group RX (helper) |
| data dir, config, `job-slots\` (credentials), other attempts | nothing → denied |

`OWNER RIGHTS` with only SYNCHRONIZE removes the owner's implicit READ_CONTROL/WRITE_DAC, so the slot cannot strip the
worker's entries from files it creates by ordinary permission changes (the worker can always read and delete them).
icacls changes are serialised in the runner (two attempts editing one mirror's DACL must not race).

The job runner spec (which names the account) is written to `<dataDir>\sandbox\specs\` — worker-only — never to the
attempt's TEMP, where a running slot process could swap it to get a process as the worker account.

After the attempt's **last** process: the account stays taken while it is cleaned — a sweep runs **as the slot**
through the job runner (`Unregister-ScheduledTask` for tasks it registered for itself, then
`taskkill /F /FI "USERNAME eq remyral-job-<n>"` for processes started outside the job via WMI/COM/tasks), then the
mirror/cache grants and the slot's workspace entry are revoked; then the account is free. Any failure **quarantines**
the account until the next Prepare (fewer parallel slots, never a dirty one). The sandbox dir (TEMP/HOME/APPDATA) is
deleted as before.

### 3.4 Proof before parallelism: cross-access self-test

`runSlotSelfTest` (worker, unprivileged; Prepare step `job_slots`, and in the background after a start when no current
result exists): per account a directory with exactly the attempt ACL and a marker file; then each account runs a
PowerShell probe through the job runner (`-EncodedCommand`, ASCII, culture-independent output) that prints its own SID
and tries: write/read its own dir (must succeed), read/list/write the **next account's** dir, list the data dir, list
`job-slots\`, read its own credential blob (all must be **denied**). Pass = every account reports its own SID (proves
`runAs` really switched accounts) and every expectation holds. The result (`<dataDir>\sandbox\job-slots-selftest.json`)
counts only for the same pool generation **and** the same job runner digest. Results are shown in Machines → Sandbox
(`job_slots` check, per-account detail in the Prepare step).

### 3.5 Gating, policy, reporting

- `WindowsSlotController.status()` is active only when: identity verified and its SID is the pool's `workerSid`, job
  runner verified, `slots.json` valid, self-test passed for this generation + runner, at least one account healthy.
  Otherwise host attempts run as before (worker account, one at a time) and the status says why, with a fix:
  `job_slots_unprovisioned` / `_invalid` / `_worker_mismatch` / `_selftest_failed` → Prepare (privileged);
  `job_slots_unverified` / `_quarantined` → Prepare; `job_slots_disabled` → owner (`windowsJobSlots: 0`).
- `HostRestrictedRunner.filesystemConfinement` = `job_user` while active. `selectProfile` for `job_user`: refuse if a
  non-host attempt (unconfined) runs; refuse if host attempts ≥ `concurrency`; both texts carry `(T-SBX-4)` so
  `p9-queue-priority` classifies them as transient. `none` keeps the old rule (now with a Prepare hint on Windows).
- `hostRestrictedConcurrency()`: `job_user` → min(healthy accounts, effective `maxParallelJobs`); `seatbelt` →
  `maxParallelJobs`; `none` → 1. Sandbox status: `host-restricted.concurrency` + `concurrencyNote`; the web card shows
  "Parallel: up to N — …".
- p9-queue-priority wiring: `profileConcurrency['host-restricted'] = hostRestrictedConcurrency()`, and
  `host-restricted` leaves `exclusiveProfiles` when `filesystemConfinement` is not `none` (done at the merge of both
  branches; see the commit).

## 4. Security review (T-SBX-4 update)

| Threat | Mitigation | Residual |
|---|---|---|
| Attempt A reads/modifies attempt B's workspace, scratch, git view, runtime state | Different accounts; protected DACLs per attempt; self-test proves denial on this machine before parallelism | — |
| A reads worker secrets (device key, secret store, config, slot passwords) | Data dir, config dir and `job-slots\` grant nothing to slots (probe checks data dir, `job-slots\` and the slot's own blob) | Worker-managed runtimes/tools dirs are readable (binaries, not secrets) |
| A gets a process as the worker account | Spec files in the worker-only data dir; runner refuses any `runAs` user but `remyral-job-<n>`; runner script re-verified before each launch | — |
| A keeps running after its attempt (WMI/COM/scheduled task) and attacks the next attempt on the same account | Sweep as the account: own scheduled tasks unregistered, own processes killed; account busy until done; failure → quarantine | A task the sweep cannot enumerate (UNVERIFIED that `Get-ScheduledTask` lists a non-admin's own tasks) |
| A plants files B later executes | B's dirs are B's only; package caches per project (ADR-0029) — concurrent attempts of the same project share them, as on macOS | World-writable locations (`C:\Users\Public`, new dirs in `C:\ProgramData`) are a channel between cooperating attempts; nothing the worker or B reads by default |
| Slot account abused for logon | Interactive, RDP, network, service logon denied; batch only; hidden; random 36-char password rotated on every Prepare | — |
| Password exposure | DPAPI LocalMachine blob + folder ACL; decrypted only inside the job runner, buffer wiped after LogonUser | Readable by the worker service and admins (they control the machine anyway) |
| Worker service gains privileges | `SeAssignPrimaryTokenPrivilege`, `SeIncreaseQuotaPrivilege` (needed by CreateProcessAsUser) | A compromised worker could start processes with tokens it obtains; it already holds `SeImpersonatePrivilege` as a service. **Finding:** host attempts that still run as the worker account (fallback, unconfined) inherit that token's privileges — follow-up `p9-windows-worker-token-privileges` (start them with a privilege-stripped restricted token). Slot attempts run as plain users without them — an improvement |
| What an attempt can still observe | — | Process list (names/PIDs of other accounts; not their command lines or memory), loopback ports (dev servers, the per-job egress proxies of other jobs — a slot could use another job's wider proxy allowlist; OpenCode servers are password-protected), named pipes created with default DACLs (Everyone read), ~~shared login state with `local-login`~~ (removed in §9.3: slots never get the login store), machine-wide state (installed software, environment of the system). Preview tunnels (p8): `owned` port checks use the job's process tree, so B cannot publish A's port as its own; a `declared` port may be served by another attempt (port squatting) — unchanged residual of p8 |
| Egress | Unchanged: proxy environment only on Windows (not enforced) | As before |

## 5. Failure modes

- Pool missing / invalid / for another SID → one at a time + reason (Sandbox card). Self-test failed → one at a time,
  `failed` check with the per-account detail. Window station: if a slot process cannot initialise user32 (exit
  `0xC0000142`), the self-test fails (the probe is PowerShell, which loads user32) → one at a time; fix = grant the
  slot group the worker's window station/desktop (follow-up, only if seen live).
- Prepare rotates passwords while attempts run: running attempts keep their token; the sweep reads the new blob; the
  pool adopts held accounts so none is handed out twice.
- `SeAssignPrimaryTokenPrivilege` not yet in the token (no service restart since provisioning): before the self-test the
  worker checks its own token (`whoami /priv`); if it lacks the privileges the check reads `job_slots_service_restart`
  ("restart the RemyralWorker service …", fix: owner), no self-test runs and no failed result is stored. The helper
  restarts the service itself when it added the privileges (§9). Should the runner still fail with "does not hold …",
  a stored result with that message reads the same way, and a failed result never outlives a worker start (§9).
- All accounts quarantined → `job_slots_quarantined`, one at a time until Prepare.

## 6. Tests

`apps/worker/test/sandbox-windows-slots.test.ts` (fake Windows command runner): icacls argument construction (attempt
DACL, grants, revokes, file vs. dir), `slots.json` validation, pool allocation / reference counting / cleaning /
quarantine / adoption, probe script (ASCII, quoting) and verdicts (wrong SID, leaked read, errors), the self-test end to
end (ACL per account, probe as each account against its neighbour, spec files in the data dir, cleanup), controller
gating (every fallback code), `selectProfile` with `job_user`, the host runner on win32 (ACLs, mirror grant, `runAs`
spec, APPDATA, third attempt refused, sweep + revoke, account free again, quarantine), status/factory (`job_slots`
check, concurrency, `windowsJobSlots: 0`, Linux = 1), worker Prepare step, helper arguments/result parsing and the
embedded scripts. `sandbox-prepare.test.ts`: the helper's Windows plan with `job_slots_provision` and the restart;
the helper's service restart after its result (once per command, resumed, stale, failed), the worker not restarting
itself on `serviceRestart`; token check (`whoami /priv`), `job_slots_service_restart` and the self-test re-run at worker
start after a failed result (§9).
Windows-only integration test (real accounts): `describe.skipIf(!win32 || REMYRAL_WINDOWS_SLOT_IT !== '1')`.

## 7. UNVERIFIED (needs the owner's Windows machine; Claude verifies after the release)

1. `remyral-job-slots.ps1` as SYSTEM on Windows 11 tr-TR: accounts, group, LSA rights, DPAPI blobs, ACLs, `slots.json`.
2. `LogonUserW(BATCH)` + `CreateProcessAsUserW` from the virtual service account after the restart (privileges present
   and enabled), `lpDesktop = ""` window station behaviour, std handles reaching the worker.
3. The cross-access self-test passing (and failing when an ACL is loosened by hand).
4. `icacls` `*S-1-3-4:(OI)(CI)(S)` syntax and its effect; `/remove:g` propagation on a large worktree (time).
5. Runtimes as a slot without a loaded profile (HKCU = `.DEFAULT`): Claude Code (`local-login` and API key), Codex, git
   (MinGit from `<dataDir>\tools`), npm with the package cache.
6. The sweep: `Get-ScheduledTask` as a non-admin lists its own tasks; `taskkill /FI USERNAME` as the account.
7. Two host jobs actually running at once on the machine, each in its own account.
8. Worker features that read the job's process tree for processes of another account: per-job memory sampling
   (p6-capacity-advice) and preview port ownership (p8, `netstat -ano` + parent PIDs) — expected to work (process
   table and PIDs are visible across accounts), not yet seen live.

## 8. Deploy and rollback

Worker release (bundle carries both scripts). Then on the Windows PC **once**: re-run the installer kit as
Administrator (updates the privileged helper — it is never auto-updated). Then Fleet → machine → Sandbox → **Prepare**
with "privileged helper" ticked: the helper creates the accounts and, when it granted the privileges, restarts the
RemyralWorker service (new logon, §9); after the restart the worker runs the self-test by itself (or run Prepare again). The card shows "Per-job Windows accounts: ok"
and "Parallel: up to N". Rollback: `"sandbox": { "windowsJobSlots": 0 }` in the local config (host jobs one at a
time immediately after a restart) or the previous worker release; the accounts can be removed with
`remyral-job-slots.ps1 -Remove -StateDir C:\ProgramData\RemyralWorker\job-slots -WorkerSid <service SID>` as admin.

## 9. Live findings (owner's Windows worker, 2026-10-17)

1. **Descriptions over 48 characters** (fixed in fc569ec): `New-LocalGroup` / `New-LocalUser` refuse a
   `-Description` longer than 48 characters, so the first privileged Prepare failed. Shortened; a test keeps every
   description within the limit.
2. **The worker restart did not bring the new privileges** (task `p9-windows-slots-service-restart`). On 1.0.29
   `job_slots_provision` created `remyral-job-1..4` and granted `NT SERVICE\RemyralWorker` both privileges (verified
   with `secedit`), then "the worker restarts". That restart (`requestRestart` → the daemon exits, shawl starts node
   again) kept the **same service process** (shawl started 03:04:05; node restarted 03:06:35 under it), so the token
   still came from the old service logon. Every slot of the self-test failed with `the worker account does not hold
   SeAssignPrimaryTokenPrivilege` (`EnablePrivilege` → `ERROR_NOT_ALL_ASSIGNED`). A manual `Restart-Service
   RemyralWorker` fixed it — but the self-test did not re-run by itself, because a failed result for the same pool
   generation and job runner was already stored.

   Fix:
   - **Helper restarts the service.** A step may now ask for `serviceRestart` (only `job_slots_provision` with
     `privilegesAdded`). The helper writes its final result first (with `serviceRestart: true`, plus
     `restartRequired`), waits 15 s so the worker can relay it, then stops and starts the service through the
     updater's own service control (`osServiceControl`: `net stop`, wait for STOPPED, `net start` with one retry —
     p6-worker-boot-diagnostics). Idempotent: `<install>\state\prepare-service-restart.json` holds
     `{commandId, state: pending|done|failed}`; a `pending` restart interrupted by the end of the helper run is
     resumed once by the next run if it is under 10 minutes old, a `done` or `failed` one never repeats (a failed
     restart is logged to `updater.log`; the card then says what to do, below).
   - **Worker does not restart itself** when the result carries `serviceRestart` (it still does for config changes
     and on other OSes); its Prepare detail says the helper restarts the service.
   - **Token check before the self-test.** A valid `slots.json` means the privileged step granted the privileges
     (LSA; the script grants them on every run). The worker reads its own token with `whoami /priv /fo csv /nh`
     (privilege names are not localised): if a privilege is missing the check is `job_slots_service_restart` —
     "restart the RemyralWorker service: … were granted, but this worker's token lacks them (Restart-Service
     RemyralWorker as Administrator, or privileged Prepare again; a worker process restart keeps the old token)" —
     and no self-test runs, so no failed result is stored. `whoami` unusable → unknown, the self-test runs as before.
   - **Freshness.** At worker start the self-test now also runs when the stored result is a failure
     (`job_slots_selftest_failed`, `job_slots_service_restart`), not only when none is current; a stored failure with
     the missing-privilege message reads as `job_slots_service_restart` until the token has been checked.

   Security: the restart is a fixed service-control call (the installer's service name, no argument from the request
   or the worker) and happens only after a master-signed, verified privileged Prepare whose own step granted new
   privileges; the marker lives in the admin-owned install state dir (mode 0600) and holds no secret. The worker's
   `whoami` runs by absolute path and only reads its own token. No new privilege or input path.

   Compatibility: `serviceRestart` is optional in the result file. A new worker with an old helper gets the old
   behaviour plus the clear `job_slots_service_restart` reason (the owner restarts the service once). An old worker
   (strict schema) with a new helper would not parse the new field and keep waiting; the helper's service restart
   ends that wait — only possible after a rollback, since the helper comes with the installer kit of the same
   release. The helper is never auto-updated: the installer kit must be re-run once for the helper part.
   UNVERIFIED-LIVE until that re-run and a privileged Prepare on the machine.


3. **Parallel subscription logins broke the login** (task `p9-windows-slots-local-login`, Windows 1.0.31, slots
   active, self-test ok, "Parallel: up to 3"). Two Claude Code `local-login` jobs started at once as `remyral-job-1`
   and `remyral-job-2`; both shared the worker's subscription login through the §3.3 grant (`remyral-job-slots` Modify
   on `C:\Windows\ServiceProfiles\RemyralWorker\.claude` and `.claude.json`). Both failed within seconds: *"Failed to
   refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh"* (`login_expired`,
   `runtime_crashed`). Afterwards a single job as the worker account failed the same way and the panel showed "The
   Claude Code login on win-1 has expired". Lock dirs left: `%USERPROFILE%\.claude.lock` and
   `.claude\.oauth_refresh.lock` (owner `NT SERVICE\RemyralWorker`). Mitigation on the PC: `sandbox.windowsJobSlots: 0`.

   **How Claude Code refreshes (read from the shipped CLI, not guessed).** Strings of the pinned CLI 2.1.296 (the
   `claude` binary of `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.296`) and of 2.1.281 — the same code in both:
   a refresh takes two `proper-lockfile`-style mkdir locks, `lockfilePath: <config dir>\.oauth_refresh.lock`
   (`stale: 60000`, `update: 5000`) and a legacy lock `${realpath(config dir)}.lock` **next to** the config dir —
   `%USERPROFILE%\.claude.lock`, in the profile root. On `ELOCKED` it retries 5 times 1–2 s apart, then returns
   `lock_busy` / `lock_timeout` (→ the message above; `lock_error` for any other lock failure, e.g. no right to create
   the lock dir, or the re-read of the credentials under the lock failing). Under the lock it re-reads the
   credentials, posts the refresh token and stores the response's **new** refresh token with a compare-and-swap
   (`save_failed` when the write fails: the new tokens then live only in that process's memory while the stored
   refresh token was already consumed — every later refresh gets `invalid_grant`, i.e. "login expired"). Claude Code
   documents no read-only credential mode (Context7 `/websites/code_claude`: `CLAUDE_CONFIG_DIR` per account only),
   and a long-lived subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) would be a subscription token injected into a job,
   refused by ADR-0014.

   **Cause (most likely; the exact sequence is UNVERIFIED on the PC).** Two processes of *different* accounts
   refreshing one store: the slot accounts may write inside `.claude` (group Modify) but have no right in the profile
   root, so they can neither create nor clear the legacy `.claude.lock` there, nor atomically replace `.claude.json`
   (temp file + rename in the profile root); a lock dir left by one account cannot be broken as stale by another; and
   with refresh-token rotation a refresh whose result is not persisted leaves the stored login consumed — which matches
   "even a single job as the worker account fails afterwards". Sharing one subscription login across concurrently
   running accounts is the design error, not a missing ACL: even with perfect ACLs, N processes sharing one rotating
   refresh token depend on one lock every account must be able to take *and* break.

   **Options.**

   | Option | Verdict |
   |---|---|
   | (a) `local-login` attempts never run on a slot: they run as the worker account (its own login store, lock dirs it owns), one at a time and alone; slots only for runtimes whose auth is per process (secret-ref API keys / vault, or none) | **Chosen.** No credential store shared between accounts; isolation of slot attempts unchanged (an attempt as the worker account could read slot dirs, so it never runs next to them — the existing T-SBX-4 rule for worker-account attempts). Cost: subscription jobs on Windows run one at a time (as before ADR-0034). |
   | (b) refresh broker: the worker refreshes once before launching slots and hands each a read-only copy | Rejected: no read-only credential mode — Claude Code refreshes (and writes) whenever its access token nears expiry, so N copies would rotate the refresh token from N places (the same failure, silently), and a copy puts subscription tokens into a job's own files. |
   | (c) a separate login per slot account (`CLAUDE_CONFIG_DIR` per slot) | Rejected: N logins per runtime for the owner, slots have no interactive logon, N subscription sessions per machine. |
   | (d) widen the ACLs (profile root writable for the group) | Rejected: every slot attempt — API-key ones too — could write the worker's profile and read the subscription tokens; does not fix rotation races. |

   **Fix.**
   - `policy.ts`: `JobSandboxRequirements.authMode` (from the job's env plan, so a model profile with an API key counts
     as secret-ref). With `job_user` a `local-login` attempt is accepted only on an otherwise idle worker, otherwise a
     transient refusal (`busy`, `(T-SBX-4)`: *"subscription logins (local-login) run one at a time, as the worker
     account and alone …"*) — p9-queue-priority keeps the job queued and offers it again when a slot frees. API-key
     attempts wait while a local-login attempt runs ("… worker account itself (unconfined, or a subscription login)").
     macOS (Seatbelt: one account, Claude Code's own lock works) and `none` are unchanged.
   - `jobs/runner.ts`: `authMode` goes into the selection and into the `SandboxContext`; `hostAttempts` (attempts that
     hold a slot) leaves local-login attempts out.
   - `host/runner.ts`: a `local-login` context never takes a slot (worker account, the worker-only attempt ACL as
     before). Attempts on a slot always get a per-attempt HOME/USERPROFILE, also with `keepHome` (the worker's profile
     is not theirs). The §3.3 grant of the login dirs to the group is **removed** (option `sharedLoginDirs` gone).
   - `host/windows-login-store.ts` + `WindowsSlotController.checkLoginStores()`: on every `verify` (worker start in
     the background, the `job_slots` step of every Prepare) the worker lists the ACL of each existing login store
     (`%USERPROFILE%\.claude`, `.claude.json`, `.codex`, plus `hostExtraWritable`) with `icacls`; if it names the slot
     group or a slot account (by name or raw SID) it takes ownership back (`/setowner *<worker SID> /T /C` — a slot
     that replaced a file there owns it and could otherwise rewrite its DACL), removes the group
     (`/remove:g *<group SID> /T /C`) and re-checks. Until the check has passed the pool is not used
     (`job_slots_unchecked`, "checking that the subscription login store is not shared …"); if it fails, the
     `job_slots` check is **failed** with `job_slots_login_shared` (fix: Prepare; the detail names the manual `icacls`).
     The worker owns its profile, so no privileged step is needed.
   - Status: the host-restricted note is "for API-key runtimes; subscription logins run one at a time (each API-key
     attempt runs as its own Windows account)"; the card renders **"Parallel: up to 3 for API-key runtimes;
     subscription logins run one at a time"**; the `job_slots` detail says the same.
   - Reporting to the master is unchanged (`profileConcurrency['host-restricted'] = N`): the master does not know a
     job's auth mode on a given worker, and the transient decline is exactly the p9-queue-priority path for "not now,
     here". Per-auth placement would be a master change without extra safety.
   - **Contention vs expiry** (`@remyral/agent-adapters` `claudeLoginFailureCause`): the lock texts ("another Claude
     Code process is refreshing", "Lock acquisition failed after N attempts", `oauth_refresh_lock_*`) are
     `refresh_contention`, every other login failure `expired`. The Claude adapter reports it as
     `SessionResult.loginFailure` (additive). The worker keeps the code `login_expired` (master and web logic
     unchanged) but says why: JOB_RESULT message *"… another runtime process sharing it was refreshing it at the same
     time (or exited mid-refresh), which can leave the stored login unusable; log in again … — subscription logins now
     run one at a time"*, and login report reason `login_refresh_contention` (Remote operations card: "Two Claude Code
     runs refreshed the shared subscription login at the same time …", same **Log in again** button; the job page
     sentence via `reasons.ts`). The remedy is the panel's existing re-login in both cases.

   **Security review.** Removes a credential exposure: before, every slot attempt — API-key jobs too — could read and
   write the owner's subscription tokens through the group grant. Now no slot account has an entry on the login
   stores, ownership is back with the worker, and the pool stays off while that is not proven. A local-login attempt
   runs as the worker account with the worker-only attempt ACL (the pre-ADR-0034 model) and never next to another
   attempt, so it cannot read a slot attempt's directories. The icacls calls take fixed arguments (paths from the
   worker's own profile or the owner's root-owned config; SIDs validated). Residual: a slot process still running at
   upgrade time keeps handles it already opened (attempts are short; the check runs before the pool is used after a
   start). Local-login attempts still inherit the worker token's privileges (`p9-windows-worker-token-privileges`).

   **Re-enabling slots on the PC** (after this release is installed there; Claude does it): delete the key
   `windowsJobSlots` from the `sandbox` section of `C:\ProgramData\RemyralWorker\config.json` — edit the file in place
   as Administrator so its ACL stays (`NT SERVICE\RemyralWorker` must keep **(R)**; if the file was replaced, re-grant:
   `icacls C:\ProgramData\RemyralWorker\config.json /grant "NT SERVICE\RemyralWorker:(R)"`) — then
   `Restart-Service RemyralWorker`, then Sandbox → Prepare (the worker part is enough; the accounts exist). Expected:
   `job_slots` ok and "Parallel: up to 3 for API-key runtimes; subscription logins run one at a time". The Claude Code
   login needs one **Log in again** (it was consumed on 2026-10-17). Two subscription jobs queued at once then run one
   after the other. Keeping `windowsJobSlots: 0` changes nothing (host jobs one at a time).

   Tests: `apps/worker/test/sandbox-windows-slots-local-login.test.ts` (store paths, ACL detection, unshare
   arguments, unshare + re-check, fail closed, controller gate, factory start check + status note,
   `job_slots_login_shared` failed check, selectProfile local-login vs secret-ref vs macOS, profile slots, host runner:
   local-login → no `runAs`, no grant, keepHome; API key → slot + per-attempt HOME); `auth-failure.test.ts` (cause
   classification, adapter `loginFailure`); `job-runner.test.ts` (contention message + cause);
   `claude-auth-health.test.ts` (login reason); web `sandbox.test.tsx`, `remote-ops.test.tsx`,
   `p6-primitives.test.tsx`. UNVERIFIED-LIVE: the icacls take-back on the PC's real profile (ownership of files a slot
   replaced), and two subscription jobs queued at once running one after the other.

4. **Sub-job deadlock on the subscription login** (task `p9-subjob-local-login-deadlock`, Windows 1.0.34): a Claude
   Code parent (local-login) waited for its Codex sub-job (local-login), which waited for the machine to be idle.
   The "alone" rule of §9.3 is now per login store and per job family:
   [p9-subjob-local-login.md](p9-subjob-local-login.md) (ADR-0034 addendum 2).

5. **Assistant vs job refresh race after a wake-up** (task `p10-claude-login-health`, Windows 1.0.37): the ops chat
   assistant's Claude Code process and a starting job refreshed the same login at once; the job lost the lock race and
   the worker marked the login expired although it was fine. The per-store rule now covers assistant sessions too (a
   shared login gate), a lost race no longer marks the login, a Check verifies a marked login with a real request, and
   placement waits for a re-login instead of failing: [p10-claude-login-health.md](p10-claude-login-health.md).
