# Design note: `p5-sandbox-ops` — Windows host sandbox, opt-in unconfined profile, sandbox status and Prepare

- **Task:** `p5-sandbox-ops`. Owner decision 2026-10-14 ("both", and "sandbox oluşturmayı panelden yapabilmeliyiz").
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0019 (this decision), ADR-0007 (profiles), ADR-0008 (truthful capabilities), ADR-0011
  (additive protocol), ADR-0014 (local login), ADR-0015 (panel config, local ceiling), ADR-0017 (remote ops),
  p2-signed-updates (privileged helper), p5-stepup-window (always-fresh class).

## Shape

```
packages/protocol/src/common.ts         SandboxProfile + 'unconfined'; CONFINED_SANDBOX_PROFILES for older peers
packages/protocol/src/sandbox-ops.ts    SandboxStatusReport (profiles, checks, codes, fixes), PrepareStep/Report,
                                        feature sandbox-ops-v1
packages/protocol (remote-ops, …)       OPS_COMMAND sandbox.prepare {privileged, localLogin}; OPS_UPDATE.prepare;
                                        CAPABILITIES.sandboxStatus; ASSIGN_JOB execution.unconfinedOptIn;
                                        worker config allowUnconfined (+ reports)
infra/worker/windows/remyral-jobrun.ps1  the Windows job runner (embedded: apps/worker/src/sandbox/host/
                                        windows-jobrun.generated.ts, scripts/release/gen-windows-jobrun.mjs)
apps/worker/src/sandbox/                host/windows-jobrun.ts (locate, verify, self-test, ACLs), host/runner.ts
                                        (Windows launch, unconfined mode), host/identity.ts (inference, SID match,
                                        whoami by absolute path), policy.ts, factory.ts, status.ts, prepare.ts,
                                        prepare-shared.ts
apps/worker/src/update/helper/prepare.ts privileged prepare (helper side): verify, fixed allowlist, results
infra/worker/linux/remyral-worker-prepare.{path,service}; macOS updater WatchPaths; installers write workerUser
apps/master/migrations/0036_sandbox_ops.sql
apps/master/src/sandbox-ops/            routes + service: Sandbox card, Prepare, unconfined switch, project
                                        execution policy, public lease keys
apps/master (worker-config, remote-ops, orchestration, composer, chat, notifications, scheduler)
apps/web                                Fleet → worker → Sandbox card; Projects → Execution policy; composer
                                        `unconfined` option and placement links; login dialog note
```

## 1. Windows job runner (replaces `remyral-jobrun.exe`)

`remyral-jobrun.ps1` (ASCII, case-sensitive operators only) compiles a small C# class with `Add-Type` (the .NET
Framework compiler that ships with Windows) and:

1. creates a Job Object: `KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION`, `JOB_MEMORY` = `sandbox.limits.memoryBytes`,
   `ACTIVE_PROCESS` = `sandbox.limits.pids`, CPU rate hard cap = `limits.cpus / logical CPUs`, and an I/O completion
   port for limit notifications (one `remyral-jobrun: job memory/process limit reached` line on stderr);
2. `CreateProcessW` with `CREATE_SUSPENDED`, a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` of exactly the three standard
   handles (deduplicated), `AssignProcessToJobObject` (terminates the child if that fails), `ResumeThread`;
3. waits, propagates the child's exit code, `TerminateJobObject` for leftovers; killing the runner (taskkill /F) closes
   the job handle and Windows kills the whole job.

The worker passes a spec file (`{v, commandLine, cwd, memoryBytes, maxProcesses, cpuRatePercent}`; the command line is
quoted by the worker with the CommandLineToArgvW rules) and starts
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
-File remyral-jobrun.ps1 -SpecFile <file>`. The spec is deleted on read. Exit 120 = the runner itself failed.

**Location and integrity.** `sandbox.windowsJobHelper` (an owner-placed `.ps1`) → `<install>\remyral-jobrun.ps1` if its
CRLF-normalised SHA-256 equals the embedded one (installed by install.ps1 or the privileged Prepare) →
`<dataDir>\sandbox\remyral-jobrun.ps1`, written from the embedded text and **re-verified before every launch** (a job
runs as the same account and could replace it for the next job). `-SelfTest` (a limited job running `cmd /c exit 7`)
must pass before host profiles are offered; Constrained Language Mode, a GPO execution policy or a broken compiler are
reported (`job_runner_selftest_failed`) instead of failing jobs.

**Why not an .exe.** No toolchain or code signing on the release machine; unsigned helpers trip SmartScreen/Defender;
the PowerShell route needs nothing that stock Windows 10/11 lack. Cost: ~3.1 s per runtime start (C# compile), measured.

**Per-attempt ACL.** Before launch the attempt worktree and sandbox dir get `icacls /inheritance:r /grant:r
SYSTEM:F Administrators:F <worker SID>:M` (OI)(CI). Under the default layout this equals the inherited ACL; for a
custom workspace root it is what keeps other local users out.

**Egress.** `HTTPS_PROXY` etc. point at the per-job egress proxy, as on other host profiles. Windows does not enforce
it: a process that ignores proxy variables reaches the network directly (as on Linux host-restricted). Documented.

## 2. Dedicated worker user

Installers write `sandbox.workerUser`. `evaluateIdentity` infers it when unset and the process runs as the installer
account (Windows: token user SID = service SID of `RemyralWorker`, computed like `sc.exe showsid`; POSIX: the user
name). A configured `NT SERVICE\X` is matched by SID. The report carries `expectedUserSource` (config / inferred /
none) and a code (`worker_user_unset`, `running_as_admin`, …). **Chosen: inference** for existing installs (no
config write needed, works after a normal worker update); the privileged Prepare also writes the key.

**Bug found on the real machine:** `whoami` was run with a POSIX-only PATH, so on Windows it was never found, the
token groups came back empty and a member of Administrators was *not* recognised. Fixed (absolute
`%SystemRoot%\System32\whoami.exe`), verified on Windows 11.

## 3. Unconfined profile

`HostRestrictedRunner` in `mode: 'unconfined'`: same identity requirement, same limits (rlimits prelude / job
runner), same tree killer and per-attempt scratch; keeps the worker user's HOME/USERPROFILE (its local logins), no
proxy, no Seatbelt, no ACL change. `selectProfile`: untrusted → refused; not in the effective allowed profiles →
`profile_not_allowed`; no project opt-in → `unconfined_not_opted_in`; runner not ready → its reason; another attempt
running → refused (one at a time, T-SBX-4).

**Gating.** Worker: `effective.sandboxProfiles` contains `unconfined` only when the applied panel document has
`allowUnconfined: true` and the ceiling does not forbid it (`localCeiling.allowUnconfined: false` or a
`localCeiling.sandboxProfiles` list without it — a pre-existing list therefore forbids it, conservatively). The local
file alone never enables it. Master: `allowUnconfined` is changed only by `PUT /workers/:id/sandbox/unconfined`
(cause `unconfined`, always-fresh, audit `worker.sandbox.unconfined`, critical `worker.config` notification); every
other cause carries the current value (edit/bulk/rollback cannot flip it; the general editor gets
`use_unconfined_route`). `sandboxProfiles` may not contain `unconfined` (`unconfined_needs_allow_flag`).

**Compatibility (ADR-0011).** Enum values are not additive for older parsers, so: the key is sent only to
`sandbox-ops-v1` workers and only when true; workers never put `unconfined` into `sandboxReadiness`, diagnostics or a
ceiling report, and into `sandboxProfiles` / the effective report only when a master that knows it enabled it;
`UPDATE_POLICY.allowedSandboxProfiles` and default specs use `CONFINED_SANDBOX_PROFILES`; `execution.unconfinedOptIn`
is sent only with unconfined jobs (which only `sandbox-ops-v1` workers receive).

**Project policy.** `GET/PUT /projects/:id/execution {hostExecution, unconfined}` — the first UI for the existing
`host_execution` opt-in, plus `unconfined_execution`; unconfined requires host execution.

## 4. Status, Prepare, privileged helper

**Status.** `buildSandboxStatus` turns the runners' own checks into `SandboxStatusReport` (sent in CAPABILITIES,
stored in `workers.sandbox_status`): per profile `ready`, `code`, `reason`, `remedy`, `fix`, dependent checks and the
confinement it gives here; checks `worker_identity`, `worker_user`, `job_runner`, `seatbelt`, `bubblewrap`,
`container_engine`, `container_rootless`, `container_images`, `disk_space`, `privileged_helper`,
`unconfined_policy`. The helper is "available" when the installed updater bundle carries the marker
`remana-prepare-helper/v1`.

**Prepare (worker).** Steps per OS — Windows: worker_user, job_runner (rewrite + self-test), disk_space; macOS:
worker_user, seatbelt, disk_space; Linux: worker_user, bubblewrap, container_engine, container_images, disk_space —
then (privileged) helper_request with the helper's own steps relayed, then recheck. Every change is an OPS_UPDATE with
all steps; the final one carries the new status. Steps that only the owner can do are `needs_owner` with why.

**Privileged hand-over.** The worker writes `{v, workerId, command}` (the OPS_COMMAND exactly as signed) to
`<dataDir>/sandbox/prepare-request.json`. Triggers: Windows — the existing `RemyralWorkerUpdater` SYSTEM task (each
minute) runs `apply`, which now also processes prepare requests; macOS — the updater LaunchDaemon's WatchPaths;
Linux — new `remyral-worker-prepare.path` → `remyral-worker-prepare.service` (`updater prepare`, root, with network
for packages; the update unit keeps `PrivateNetwork`). The helper reads the request with `O_NOFOLLOW`, size cap,
strict schema; accepts only `sandbox.prepare` with `privileged: true`, inside the window, not seen before (replay set
in the install dir); verifies the signature with pinned `masterLeaseKeys` or keys fetched from
`GET <master>/v1/worker/lease-keys` (TLS, no redirects, 15 s); writes per-step results to
`<install>/state/prepare-result.json` (world-readable, root-owned). Steps:

| OS | Steps (fixed) | Not automated (needs_owner) |
| --- | --- | --- |
| Windows | `config_worker_user`, `config_local_login` (keepHome), `job_runner_install` (+ self-test as SYSTEM), `workspace_acl` (install.ps1's ACLs) | — |
| Linux | `config_worker_user`, `config_local_login`, `container_engine_install` (apt: podman uidmap slirp4netns fuse-overlayfs / dnf: podman shadow-utils slirp4netns fuse-overlayfs; then `sandbox.container.engine: podman` unless set), `container_subids` | `container_service`: the hardened worker unit (NoNewPrivileges, RestrictSUIDSGID, empty capability set, ProtectHome) blocks rootless Podman's setuid `newuidmap`; relaxing it weakens every job's confinement — owner decision. `container_images`: the release ships no image build contexts. Other distributions. |
| macOS | `config_worker_user`, `config_local_login` (keepHome, allowKeychain, hostExtraWritable for ~/.claude, ~/.claude.json, ~/.codex, ~/.config of `_remyralworker`) | Seatbelt itself (Apple tooling) |

When the helper changed the local config the worker restarts under its service manager after reporting.
Machines installed before this release have an updater without the marker: the card says so and the owner re-runs
the installer kit once (the helper is never auto-updated, p2-signed-updates).

## 5. Login → auth

**Chosen: automatic.** After `login.start` reports `succeeded`, the master (remote-ops service → worker-config
service) stores a generation with cause `login` that enables the runtime and sets `auth: local-login` — only when the
worker is panel-managed and the runtime has no auth. Alternative "Use this login for jobs" button rejected: the owner
already confirmed with an always-fresh step-up to log in *for this worker*; a second click is friction, and the
change is audited, visible in History and reversible. Explicit choices (a vault credential, an API key) are never
replaced. The login dialog says what happened.

## 6. Panel

Fleet → worker → **Sandbox** card (viewer+: read; admin: Prepare with the privileged checkbox, per-step progress;
"Allow unconfined…" behind a danger notice → always-fresh). Deep link `/fleet?worker=<id>&section=sandbox`, used by
the composer's placement reasons and by the chat assistant (`describe_worker.sandboxStatus` / `sandboxCard`, rule 7
of its system prompt). Projects → **Execution policy**. Composer offers `unconfined` with the reason when blocked.

## Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Panel/master compromise enables unconfined and runs agent code with the worker account's rights | always-fresh step-up for the worker switch *and* the project opt-in, critical owner notification, audit, untrusted sources refused, identity rule (never root/SYSTEM/admin), local veto `localCeiling.allowUnconfined: false` | On machines without the local veto an attacker with admin + second factor gets the worker account's rights (its data dir, logins, network). Owner should set the veto on machines that must never run unconfined. |
| Panel compromise drives privileged Prepare | fixed allowlist in the release-key-signed updater; no URL/package/path/command parameter; steps only move the machine toward the installer's own state; signed + windowed + replay-protected | Can trigger package installs from the distro's configured repositories and keepHome/keychain settings for local-login (signed `localLogin`). |
| Worker account (agent escape) forges a prepare request | helper verifies the master signature for that worker id with keys it obtains itself; replay set root-owned | A replay of a *genuine* recent command inside its 2-min window is refused by the replay set; a TLS-intercepting proxy without pinned `masterLeaseKeys` could forge keys (same as the worker session itself). |
| Job replaces the data-dir job runner for the next job | digest re-check before every launch, rewrite from the embedded text; installer copy preferred | A same-account job can already do anything the worker account can (Windows has no per-attempt filesystem confinement). |
| Job escapes the Job Object | child created suspended and assigned before it runs; kill-on-close on runner death | Nested jobs are allowed by Windows; a breakaway flag needs `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, which is not set. |
| Egress on Windows/Linux host profiles | proxy env + runtime permission policy | not enforced by the OS (documented) |
| Login → auth changes what jobs use | only when unset, audited cause `login`, visible in History, notification as any config change | — |
| Old masters/workers mis-parse `unconfined` | feature gate + confined lists for older peers (§3) | — |

## Platform verification (honest)

| | Windows 11 x64 (real, PS 5.1, tr-TR) | Linux | macOS (dev Mac) |
| --- | --- | --- | --- |
| job runner: memory + process limits, exit code, stdio, quoting, cancel/tree kill, kill-on-close, orphans, bad spec | **verified** (as Administrator) | n/a | n/a |
| job runner self-test as SYSTEM (privileged Prepare's context) | **verified** (temporary task, removed) | n/a | n/a |
| job runner as `NT SERVICE\RemyralWorker` (the production account) | UNVERIFIED (would require reconfiguring the production service; the panel's Prepare verifies it on the machine) | n/a | n/a |
| host runner + unconfined runner end to end (fake runtime), per-attempt ACL, proxy env | **verified** with an injected verified identity (the test user is an admin and is correctly refused) | unit tests | unit tests |
| identity facts, service-SID inference, `sc.exe showsid` equality | **verified** | unit tests | unit tests |
| privileged prepare (signature, replay, forgery; Windows steps incl. ACLs) against a temp layout | **verified** as Administrator | unit tests only — UNVERIFIED on systemd (Docker e2e harness not run: ~2 GB free disk) | unit tests only — UNVERIFIED |
| installer plan tests (Install.Tests.ps1) | **103 assertions passed** | `bash -n` | `bash -n`, `plutil -lint` |

## Rollback

Migration 0036 is additive (columns, widened CHECKs). Turning `unconfined` off is one panel action (or the local
veto). An older worker ignores everything new; an older master ignores `sandboxStatus`. Reverting the worker leaves
`<dataDir>/sandbox/` (job runner copy, request file) — harmless.
