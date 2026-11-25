# Runbook: operating workers remotely (runtimes, login, restart, logs, diagnostics)

- **Applies to:** workers advertising `remote-ops-v1` (this release and later), master with migration 0032
- **Audience:** owners / admins, from the panel — no shell on the machine needed
- **Design:** [docs/design/p5-remote-ops.md](../design/p5-remote-ops.md), ADR-0017 (amends ADR-0014)

Machines → <machine> → **Runtimes** (logins, installs) and **Activity** (logs, diagnostics, history). Every action asks for an authenticator code (step-up); login actions
always need a code from the last 10 minutes. Everything is audited (Audit → `worker.ops.*`).

## 1. Install, upgrade, roll back, remove a runtime

Runtimes tab, one card per runtime (Claude Code, Codex, OpenCode, Pi). OpenHands was removed
([ADR-0023](../adr/0023-remove-openhands.md)): remove a managed OpenHands install from each worker **before**
upgrading that worker to a release without OpenHands (an upgraded worker no longer lists it; then delete
`<dataDir>/runtimes/openhands/` on the host by hand).

| Button | What happens on the worker |
| --- | --- |
| Install `<pin>` | downloads the pinned version from the public registry, checks every file against the checksums bundled in the worker release, installs into `<dataDir>/runtimes/<runtime>/<version>/` |
| Upgrade to `<pin>` | the same for the current pin; the old version stays installed (for rollback) |
| Roll back to `<previous>` | only to the previous pin; any other downgrade is refused |
| Reinstall | repairs an install whose executable was modified (shown "modified, not used") |
| Remove `<version>` | deletes it; removing the active version makes the runtime unavailable here (unless a local binary exists) |
| Restart runtime | re-detects the runtime and re-probes it (running jobs keep theirs) |

Then enable the runtime for the worker (Configuration → Runtimes & models) as before.

- "Not installable here": the platform has no package for this OS/arch.
- Integrity / download failures (`integrity_mismatch`, `download_failed`) leave nothing installed. An
  `integrity_mismatch` means the registry or a mirror served something else than the pinned bytes: do not retry
  blindly — check `pnpm security:runtime-checksums` and the network path.
- A version not in the list cannot be requested: new pins arrive with a worker release (regenerated install set).
- Mirror: set `remoteOps.npmRegistry` / `remoteOps.pypiIndex` (https) in the machine's local config; the
  checksums still apply.

## 2. Log a runtime into your subscription (Claude Code, Codex)

1. Set the runtime's auth to **local login** (Configuration → Runtimes & models) if not done yet.
2. Runtimes tab → the runtime → **Log in**. The worker starts the runtime's own login.
3. A dialog shows the provider's sign-in link (claude.com / auth.openai.com) — open it on **your** phone or laptop
   and sign in with your subscription.
   - **Claude Code:** after signing in, the page shows a code. Paste it into the dialog → **Send code**.
   - **Codex:** enter the one-time code shown in the dialog on the sign-in page; the worker finishes by itself.
4. The dialog shows "Logged in"; the card shows the state from the runtime's own status command.

The login token stays in the runtime's own store on that machine; the platform never sees it. **Check**
refreshes the state (e.g. after a subscription expired → "Expired": log in again). **Log out** runs the
runtime's own logout. One login at a time per worker; a login gives up after 15 minutes.

**Login expired after a failed run (p5-claude-auth-health).** When a Claude Code run fails with "Failed to refresh
OAuth token" (also "another Claude Code process is refreshing it or exited mid-refresh"), a 401 or another
expired-login message, the job fails with code `login_expired`, its page shows a **Re-login** link to the machine's Runtimes tab,
and the worker reports the runtime `authenticated: no` (no new subscription jobs are placed there) with the login
"Expired" and reason `login_expired` — even if **Check** still says logged in, because the status command only
reads the stored credential. A successful login, or a later successful run, clears it. Before each Claude Code
start the worker removes stale lock entries (`.oauth_refresh.lock`, `.claude.lock`, `.claude.json.lock`,
`.credentials.json.lock`) in the worker user's home, `~/.claude` and `CLAUDE_CONFIG_DIR` when they are older than
10 minutes (`claudeLockMaxAgeMinutes` in the local config) and no Claude process of the worker user runs; removals
are logged (`removed stale Claude Code lock(s)`). Windows service profile: `C:\Windows\ServiceProfiles\RemyralWorker\`.

**Self-recovering subscription logins (p10-claude-login-health, [design](../design/p10-claude-login-health.md)).**
- Jobs and ops-chat sessions that use the same subscription login start one after the other (a per-login gate held
  until the runtime's first answer, at most 60 s), so they no longer race for the OAuth refresh after a wake-up.
- A run that only lost that race ("another Claude Code process is refreshing it") fails with
  `login_refresh_contention` — run the job again; the runtime **stays signed in**. Only a real expiry marks it expired.
- **Check** on an expired-marked login sends one minimal request through the runtime (no tools, nothing stored): if it
  works, the mark is cleared at once; otherwise the login stays "Expired" (`login_expired`, or `login_unverified` when
  the check could not tell, e.g. no network). The worker repeats this every 10 min while marked
  (`loginRecheckMinutes`, 0 = off) and right after the machine wakes up (also removing refresh locks untouched for
  more than 2 min — the CLI itself counts them stale after 60 s — even while a Claude process runs; POSIX: only locks
  owned by the worker user).
- While a runtime is signed out on a machine, jobs that need it **wait** (reason "Claude Code needs a login on … —
  waiting") for up to `LOGIN_WAIT_MINUTES` (master env, default 30; 0 = fail at once) and start by themselves after
  the re-login; the job's creator gets one notice per machine and day with the **Log in again** link.
- p11-limit-visibility: the subscription logins' **usage windows** (Claude Code 5-hour / weekly / per model, Codex
  primary / secondary) are read every 10 min with the runtimes' read-only calls (no model request, never a credential
  file; under the same login gate) and seen in jobs / chat turns — Runtimes tab → "Runtime limits", Home, Usage →
  Enforcement. `usageProbeMinutes` in the worker config (default 10, minimum 2; 0 = only what runs report).

## 3. Restart, logs, diagnostics (Operations tab)

- **Restart worker:** with "wait for running jobs" the worker stops taking jobs, waits up to the given time, then
  restarts through its service manager (exit 75). If jobs are still running at the deadline the restart is
  cancelled (`drain_timeout`) and the worker takes jobs again. Without waiting, running jobs stop and are
  reconciled by the master. Only offered when the worker runs under its service manager.
- **Fetch logs:** the last N lines of the worker's own log (`<dataDir>/logs/worker.log`), redacted on the worker
  and again on the master; shown for a few minutes, never stored in the database. The **Log** selector
  (p6-worker-boot-diagnostics, worker ≥ 1.0.23, feature `logs-source-v1`) also reads the **boot** log
  (`<dataDir>/logs/boot.log`: start / ready / fatal / early-exit records written before the logger exists — the
  place to look when a version dies before its first `worker.log` line) and the **updater** log
  (`<installDir>/state/updater.log`, the privileged updater's own log). Fixed files only; no path is a parameter.
  An older worker answers `409 worker_update_required` for boot / updater.
- **Run diagnostics:** Node version, disk space, sandbox readiness, runtimes (source, version, integrity, auth),
  service manager state and a list of problems.

## 4. Turning remote operations off on a machine

In the root-owned local config of that machine (needs one shell visit):

```json
{ "remoteOps": { "disabled": ["install", "login", "restart", "logs", "diagnostics"] } }
```

Any subset works; the panel then gets `disabled_locally`. `remoteOps.restartable: false|true` overrides the
service-manager detection; `remoteOps.logFileBytes` sizes the log file (default 4 MiB, two generations).

## 5. Troubleshooting

| Shown | Meaning / action |
| --- | --- |
| `worker_update_required` | the worker build predates remote ops — update it (Settings → Worker releases) |
| `worker_offline` | the worker is not connected; operations need a live session |
| `runtime_in_use` | a job of that runtime is running; retry after it finished |
| `not_restartable` | the worker was started by hand, not by its service |
| `lost` / `no_answer` | the worker never answered (disconnected, restarted); check Diagnostics, retry |
| `unsigned` / `bad_signature` | the worker pins `masterLeaseKeys` that do not match the master's key |
| `login_failed` | wrong or expired pasted code, or the provider refused; start the login again |
| `insufficient_disk` | < 1 GiB free in the data dir |
| 429 | too many operations on this worker (10 installs/removes/restarts per 10 min) |

## 6. Rollback

Migration 0032 is additive. A worker rolled back to an older build ignores `<dataDir>/runtimes/<rt>/<version>`
and uses PATH / configured binaries again (the directory can be deleted). A runtime rollback is the "Roll back"
button.
