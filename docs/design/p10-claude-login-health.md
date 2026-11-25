# Design note: `p10-claude-login-health` — subscription logins that recover by themselves

Status: implemented (2026-10-18). Builds on p5-claude-auth-health, p9-windows-slots-local-login
([p9-windows-host-isolation.md §9.3](p9-windows-host-isolation.md)) and p9-subjob-local-login-deadlock
([p9-subjob-local-login.md](p9-subjob-local-login.md)). No ADR, no migration. Also carries two p10-approval-pause
fixes from the same live session (§8).

## 1. Live findings (prod, 2026-10-18, Windows worker 1.0.37, Claude Code `local-login`, the PC had been off ~19 h)

1. The first job after the wake-up failed within seconds: `login_expired` "Failed to refresh OAuth token: another
   Claude Code process is refreshing it or exited mid-refresh". Right after, the ops chat assistant (Claude Code engine,
   same worker account, same `.claude`) answered fine — the login was valid. The job lost the OAuth refresh race to the
   assistant's own Claude Code process (both started with an access token that expired during the 19 h). p9 made
   subscription-login exclusivity per login store **for jobs**; the assistant host was not part of it.
2. The worker then flagged Claude Code signed out (`markExpired` with `login_refresh_contention`), so the next job
   failed at once — `no eligible worker: runtime_not_authenticated` (FAILED instead of waiting). Machines → Runtimes →
   **Check** reported *Succeeded*, yet the state stayed "Signed out": the flag overrides `claude auth status`, which
   only reads the stored credential and always says logged in.

## 2. How Claude Code refreshes (pinned CLI 2.1.296, read from the shipped binary)

- `.oauth_refresh.lock` in the config dir and the legacy `${realpath(config dir)}.lock` next to it (`%USERPROFILE%\.claude.lock`),
  both `proper-lockfile` directories with `stale: 60000, update: 5000`: a live holder touches the mtime every 5 s; one
  untouched for 60 s is stale **by the CLI's own rule**. 2.1.296 also writes `.oauth_refresh.lock.owner`
  (pid / process start / lock birth time) and may take over a lock whose holder provably died.
- On `ELOCKED` it retries 5 times 1–2 s apart, then gives up (`OAuthRefreshLockContendedError`, "Lock acquisition
  failed after N attempts: another process is refreshing" / "another Claude Code process is refreshing it").
- Under the lock it re-reads the credentials and, if another process refreshed meanwhile, uses that result
  (`tengu_oauth_token_refresh_race_resolved`). A **same-account** loser therefore never consumes the refresh token: the
  login stays fine. (The 2026-10-17 breakage of §9.3 needed two *different* accounts that could not take/break each
  other's locks — no longer possible: subscription logins never run on a slot account.)
- `claude auth status --json` reads the stored credential only (no request); there is no "verify" command.

## 3. Design

### 3.1 One login gate per store for jobs **and** the assistant (worker)

`apps/worker/src/runtimes/login-gate.ts` — `LoginStoreGate`: a FIFO mutex per login store (`loginStoreOf(runtime)`,
the p9 mapping: `claude`, `codex`, …), created once in the job wiring and shared by:

- the job runner: a `local-login` attempt takes it right before the runtime starts (`#startSession`) and releases it
  at the first sign that the runtime talked to the model (first assistant message, tool call / result, approval
  request), at the end of the event stream, or in `#finish` — whichever comes first;
- the assistant host: a `local-login` session takes it before `engine.start` (fresh session) or before a turn is sent
  to a running session (a refresh can be due at any turn), and releases it at the first streamed text or the end of
  the turn;
- the login probe (§3.3).

Bounds so the gate can never hang anything: a hold ends by itself after 60 s (the CLI's own stale threshold), a waiter
proceeds after 120 s (logged; degraded to the CLI's own lock), an aborted job / cancelled turn stops waiting at once.
API-key (`secret-ref`) attempts and sessions never take it. Contention between the assistant and a job now becomes a
short wait instead of a failed job.

### 3.2 Stale locks after a wake / resume (worker)

`sweepClaudeLocks` (p5-claude-auth-health) removed lock entries older than 10 min **only when no Claude process of the
worker user ran** — with the assistant's long-lived session that was almost never. New rule for the two refresh locks
(`.oauth_refresh.lock`, `.claude.lock`): older than `refreshStaleMs` (default 2 min, twice the CLI's 60 s) → no live
holder by the CLI's own rule → removed even while a Claude process runs. On POSIX the entry must be owned by the
worker user (`lstat().uid`); a foreign entry is never touched (on Windows the scanned directories are the worker
account's own profile; a failed `rm` is only logged). Config locks (`.claude.json.lock`, `.credentials.json.lock`, …)
keep the old rule. The `.oauth_refresh.lock.owner` record and credential files never match the name pattern. The sweep
now also runs as the gate's `prepare` hook for the `claude` store (so before assistant sessions too) and after a wake
(§3.3).

### 3.3 Contention is not an expiry; the flag recovers by itself (worker)

- `applyRunLogin` (worker `remote-ops/login.ts`, used by the daemon): a run that failed with `refresh_contention`
  leaves the runtime signed in (only logged, `noteContention`); a real login failure flags it; a successful run — now
  also a successful subscription-login **assistant** turn — clears it. The job itself fails with its own code
  `login_refresh_contention` ("… the login itself was not changed — run the job again"), not `login_expired`.
- `LoginManager.check` (the panel's **Check**, `login.status` op): status command first; when the worker has the login
  flagged and the status command says logged in, a **usability probe** decides: one minimal real request
  (`claude -p "Reply with the single word OK." --output-format json --max-turns 1 --no-session-persistence
  --strict-mcp-config --tools ""`, flags verified in the pinned CLI) under the store gate, in an empty temp dir, with
  the login-relay environment. `is_error: false` → the flag is cleared at once and CAPABILITIES go out; a login-failure
  text → stays `login_expired`; anything else (network, timeout, a lost race) → stays flagged as `login_unverified`.
  The probe output is scanned in memory and dropped (never logged or relayed). A healthy login is never probed.
- `LoginHealthMonitor` (`remote-ops/login-health.ts`): every `loginRecheckMinutes` (worker config, default 10, 0 = off)
  each flagged login is checked the same way; a 30 s ticker notices a wall-clock gap ≥ 2 min (sleep / power off), then
  runs the lock sweep and re-checks flagged logins at once. Recovery re-sends CAPABILITIES, so waiting jobs (§3.4) start
  without anyone pressing Check.

Cost: a probe is one tiny request on the owner's subscription, only while a login is flagged (at most every 10 min);
while the login really is expired the request fails at the refresh, before any model call.

### 3.4 A signed-out machine makes jobs wait, bounded (scheduler + master)

- `PlacementJob.loginWait = { since, until, expired }` (additive). With it, `runtime_not_authenticated` is
  **transient** — "Claude Code needs a login on <machine> — waiting (until …; Machines → … → Log in again)" — until the
  wait ends; afterwards (or without `loginWait`, e.g. composer previews) permanent as before ("… still signed out on …
  after the job waited for a login until …"). `PlacementReason` / `ReasonSummary` gain `waitingSince`.
- Orchestrator: only when a placement excluded a machine for `runtime_not_authenticated`, it reads the job's stored
  schedule status, keeps the first `waitingSince` (else now) and re-places with the wait — no extra query otherwise.
  `LOGIN_WAIT_MINUTES` (master env, default 30, 0 = fail at once, the old behaviour) → `timing.loginWaitMs`.
- Notice once: the queue service's tick step (`queue-wait-notices`) tells the job's creator — kind `job.waiting`,
  severity warning, "Claude Code needs a login on <machine>", link to the machine's Runtimes card (**Log in again**) —
  once per machine, runtime and day (dedupe key `runtime.login:<worker>:<runtime>:<date>`, plus an in-process memo), not
  once per waiting job. Audited `job.login_wait.notify`. No new notification kind (no migration).
- Web: the job / queue reason sentence says the job waits and starts by itself after a re-login; the contention
  sentence says "the login is fine — run the job again".

## 4. Security review

- No credential is read, copied, logged or transmitted: the gate is in-process; the janitor matches only lock names;
  the probe uses the runtime's own CLI with the login-relay environment (allow-listed variables, no secrets) in an empty
  temporary directory and keeps only a three-valued verdict. ADR-0014 rule 4 (login state only via the runtime) holds.
- The probe sends a fixed prompt with all tools disabled (`--tools ""`, `--strict-mcp-config`, one turn, nothing
  persisted) — no workspace, no repository, no tool execution. It runs only for a login the worker itself flagged, on
  an owner-triggered Check or the bounded background schedule (config can turn the latter off).
- Lock removal is narrower than before for foreign entries (uid check) and wider only where the CLI itself considers
  the lock dead (> 2 × its stale threshold, kept fresh every 5 s by a live holder). A wrongly removed lock could at
  worst let two refreshes overlap — the same-account CLI resolves that under its re-read (§2).
- The gate cannot starve the machine: bounded hold / wait, abort-aware; FIFO per store.
- Waiting instead of failing keeps a job queued up to `LOGIN_WAIT_MINUTES`; the job's other permanent reasons still
  fail it at once; the notice goes only to the job's creator (in-app + their opted-in channels), no new data exposed.

## 5. Failure modes

| Case | Behaviour |
|---|---|
| Assistant turn and job start together after a wake | the second waits for the first's first model output (seconds) |
| A holder hangs before any output | its hold ends after 60 s; next holder proceeds |
| Stale refresh lock (power cut mid-refresh) | removed by the janitor when > 2 min old (start, assistant start, wake) |
| Lost race anyway (an outside process) | job fails `login_refresh_contention`, runtime stays signed in |
| Real expiry | runtime flagged; jobs wait up to 30 min; owner told once; Check / re-check / a good run clears it |
| Check while the network is down | flag stays (`login_unverified`), next re-check retries |
| Old worker (no probe / no gate) | master still makes jobs wait (it only reads `authenticated: no`) |
| Old master | worker changes stand alone; jobs fail at once as before |

## 6. Tests

- Worker `claude-login-health.test.ts`: gate order / per-store parallelism / housekeeping / max hold / max wait /
  abort; refresh lock touched 30 s ago kept, foreign uid kept, own removed while a process runs; `applyRunLogin`
  (contention vs expiry vs ok, API-key runtimes); Check without flag = status only; flagged + probe usable / expired /
  inconclusive; probe through the gate in an empty temp dir; probe classification and argument order; monitor re-check
  cadence, single recovery report, no probes when healthy, wake gap → housekeeping + immediate re-check; assistant:
  local-login turn waits for a starting job and runs after it, next turn gated again, API-key session never waits.
- Worker `job-runner.test.ts`: local-login attempt holds the gate until the first assistant message, a concurrent start
  waits; API-key attempt never gates; contention result code / message. `claude-auth-health.test.ts` updated for the
  refresh-lock rule.
- Scheduler `placement.test.ts`: permanent without wait, transient within, permanent after, signed-in machine placed.
- Master integration `login-health.test.ts` (real Postgres + Redis, real worker daemon + job runner, real
  `LoginManager` rule, fake Claude Code runtime): a lost race fails only that job and the next job runs; a real expiry
  flags the runtime, the next two jobs **wait** (transient reason), one notice to the owner; a Check with a failing
  probe keeps the flag, a Check with a working probe clears it and both jobs run; after the wait the job fails with
  "still signed out".
- Web `p6-primitives.test.tsx`: the two new sentences.

## 7. Deploy and rollback

- Master + web deploy (scheduler / orchestrator / queue notice / reasons), optional env `LOGIN_WAIT_MINUTES`.
- **Worker release needed** for the gate, the janitor rule, contention handling, Check probe, background re-check and
  wake detection (and §8). Optional worker config `loginRecheckMinutes`.
- Rollback: `LOGIN_WAIT_MINUTES=0` restores fail-at-once; `loginRecheckMinutes: 0` stops background probes; an older
  worker release restores the previous worker behaviour. No migration, no data change.
- UNVERIFIED-LIVE (needs the Windows PC): a job and a chat turn started together after a wake on win-1; the
  probe and the janitor on the real `C:\Windows\ServiceProfiles\RemyralWorker` profile; the wake detection across a real
  sleep / power cycle.

## 8. Addendum: two p10-approval-pause fixes from the same live session

1. **Workspace jobs could never be resumed on a sandboxed worker** (win-1, project *genel*: approve →
   `paused_workspace_missing: the sandbox configuration of this worker changed since the pause` → "Could not resume —
   paused again"). Nothing had changed: the parked record's `paths.gitView` is `false` for every scratch (workspace)
   attempt — it has no git view — and the resume compared it with "a sandbox is configured" (`true`). The comparison
   now applies to repository attempts only (a repository attempt that ran with a per-attempt git view reopens only with
   one); every refusal logs the field and both values (`paused attempt cannot be resumed here`, `field`, `kept`,
   `now`). The record fingerprints only what reopening depends on (attempt, paused epoch, runtime, kind, git view for
   repository attempts, the kept paths inside the workspace root and retention) — no volatile status (login state,
   slots, load, timestamps other than retention). Tests: `approval-pause.test.ts` (scratch job on a sandboxed worker
   pauses and resumes; a refused resume names `pausedEpoch`).
2. **The interrupt the pause asks for was shown as an error.** Stopping Claude Code for a pause interrupts the running
   turn; the CLI ends it with an `error_during_execution` result ("[ede_diagnostic] result_type=user …
   stop_reason=tool_use"), which the adapter streamed as an `error` event. The outcome was already right (the runner
   reports a paused run as `cancelled` + `paused`, never failed), but the timeline showed an error. The adapter now drops
   that one result error while a cancel / pause it requested is in progress. Test: `park.test.ts`.
