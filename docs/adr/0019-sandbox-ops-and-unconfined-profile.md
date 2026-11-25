# ADR-0019: Sandbox preparation from the panel, and an opt-in unconfined profile

- **Status:** Accepted — owner decision, 2026-10-14: "both" — a real restricted host mode on Windows
  *and* an opt-in unconfined (full machine) mode per worker switched on from the panel; plus "sandbox oluşturmayı
  panelden yapabilmeliyiz" — creating the sandbox must be possible from the panel, not only checking it.
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-sandbox-ops`
- **Amends:** ADR-0007 (a fourth profile `unconfined`; the dedicated-user rule now has an inferred form; the
  Windows `host-restricted` runner is a PowerShell job runner, not `remyral-jobrun.exe`). ADR-0017 (one more signed
  operation, `sandbox.prepare`, and the first operation the privileged helper of p2-signed-updates runs).
  ADR-0005/0006/0011/0014/0015 stay binding.
- **Related:** docs/design/p5-sandbox-ops.md (design + security review), docs/ops/worker-sandbox.md.

## Context
On the owner's real Windows 11 worker no job could run at all: `container` needs rootless Docker (Linux only),
`host-restricted` needed a `remyral-jobrun.exe` that was never written, and `sandbox.workerUser` was set by no
installer, so the identity check refused every host profile. The panel could not show why, and the ops assistant
told the owner to "prepare the sandbox" with no way to do so. The owner runs jobs on his own machines with his
own subscription logins and accepts running some trusted projects without confinement — but wants that to be an
explicit, visible, reversible choice per worker.

## Decision
1. **Windows `host-restricted` without a native binary.** `infra/worker/windows/remyral-jobrun.ps1` creates a Job
   Object through `Add-Type` C# on stock Windows PowerShell 5.1 (KILL_ON_JOB_CLOSE, job memory, active processes,
   CPU hard cap, die-on-unhandled-exception), starts the runtime suspended → assigned → resumed, inherits exactly
   the three standard handles, propagates the exit code and terminates leftovers. Its text is embedded in the
   signed worker bundle; the worker uses an installer-placed copy only if it is byte-identical, else writes its
   own copy and re-verifies it before every launch, and self-tests it before offering host profiles. Each
   attempt's directories get a protected DACL (SYSTEM, Administrators, the worker's SID). Egress is the per-job
   proxy environment, which Windows does not enforce (documented residual risk).
2. **Dedicated user from the installers.** The installers write `sandbox.workerUser` (Windows
   `NT SERVICE\RemyralWorker`, Linux `remyral-worker`, macOS `_remyralworker`). For existing installs the worker
   **infers** it when it runs as exactly that account — on Windows proven by the token's user SID equalling the
   service SID of `RemyralWorker`. The admin/SYSTEM/root/console refusals are unchanged.
3. **`unconfined` profile.** The runtime runs directly as the worker's service account: its own HOME and
   environment, no filesystem confinement, no egress restriction; the verified-identity rule, resource limits
   (rlimits / Job Object), timeouts and tree kill still apply. It is offered only when (a) the worker's panel
   configuration has `allowUnconfined: true` — set only through `PUT /workers/:id/sandbox/unconfined`, admin +
   always-fresh step-up, audited `worker.sandbox.unconfined`, critical notification to owners/admins; the general
   editor, bulk edits and rollbacks carry the current value and cannot flip it — and (b) the local ceiling does not
   forbid it (`localCeiling.allowUnconfined: false`, or a `localCeiling.sandboxProfiles` list without it). A job
   uses it only if it asks for `sandboxProfile: "unconfined"` and its project allows it
   (`PUT /projects/:id/execution`, admin + always-fresh, audited); untrusted sources are refused; attempts run one
   at a time. A worker never falls back to `unconfined` on its own. Placement says why it is not available
   (`unconfined_not_opted_in`, `unconfined_not_enabled`).
4. **Status and Prepare from the panel.** CAPABILITIES carries `sandboxStatus`: per profile ready / not ready with a
   machine-readable code, reason, remedy and who can fix it (`prepare`, `prepare_privileged`, `panel`, `owner`),
   plus the host checks behind it. `OPS_COMMAND sandbox.prepare {privileged, localLogin}` (admin + always-fresh,
   signed, audited) runs the worker's unprivileged steps and, with `privileged`, hands the **same signed command**
   to the root/SYSTEM helper. The helper verifies the master's signature itself (pinned `masterLeaseKeys`, else the
   keys the master publishes at `GET /v1/worker/lease-keys`, fetched by the helper over TLS — never keys the worker
   supplies), refuses expired and replayed commands, and runs a **fixed, versioned allowlist** compiled into the
   signed updater bundle: Windows — `sandbox.workerUser`, `keepHome` for local-login, install + self-test the job
   runner next to the worker, re-apply the installer's ACLs; Linux — the same config keys, Podman and its helpers
   from the distribution's packages (apt / dnf), subordinate ids for the worker user; macOS — the config keys plus
   keychain / state-dir settings for local-login. Nothing in a step comes from the panel or the worker but the
   signed `localLogin` boolean. Steps it cannot do are reported `needs_owner` with the reason.
5. **Login → auth.** When a Remote-operations login succeeds and the runtime has no auth in the worker's desired
   configuration, the master stores a new generation (cause `login`) that enables the runtime with
   `auth: local-login`. An existing auth is never replaced.

## Threat model impact (what a panel compromise can now do)
An attacker with an admin session plus a fresh second factor (or control of the master) can now: switch
`unconfined` on for a worker and opt a project in, then submit a trusted-looking job that runs as the worker's
service account without confinement — i.e. read and change everything that account can (its data dir, other
attempts, its own runtime logins) and reach any host. It **cannot**: get root/SYSTEM/admin (identity check, no
`unconfined` as root), bypass the owner's local ceiling, run untrusted sources unconfined, change what code the
privileged helper runs (a fixed allowlist in a release-key-signed bundle; no URL, package, path or command is a
parameter), or make the helper act without the master's signature. The owner is notified of every unconfined
switch, every step is audited, and Prepare's privileged steps only make the machine *more* prepared (packages from
the distribution's own repositories, the installer's own ACLs, the installer's own account name). Compared with
ADR-0017 the new worst case is "agent code with the worker account's full rights on machines whose owner did not
forbid `unconfined` locally" — the reason the switch is always-fresh, loud and locally vetoable.

A compromised **worker account** can write a prepare request, but the helper ignores it without a valid master
signature for that worker, inside its window, not seen before.

## Alternatives considered
- **A compiled `remyral-jobrun.exe`** — needs a build toolchain and code signing (SmartScreen / Defender flag unsigned
  helpers); the C# compiled by Windows' own .NET Framework through PowerShell needs nothing to install. Cost: ~3 s
  start-up per runtime launch (verified), acceptable for agent runs.
- **Pinning master lease keys at install for the helper** — breaks on key rotation and needs a shell to fix; the
  helper fetching published keys over TLS has the same trust root as the worker's own session, and pinned keys
  still win when configured.
- **A self-updating privileged helper** — would make root code changes panel-driven; rejected (p2-signed-updates
  keeps them a deliberate owner action). Consequence: machines installed before this release need the installer kit
  re-run once to get privileged Prepare (everything unprivileged works after a normal worker update).
- **Unconfined as a silent fallback** — rejected (ADR-0007/0008: never substitute a weaker profile).

## Consequences
Migration 0036 (`projects.unconfined_execution`, `workers.sandbox_status`, `worker_ops.kind` + `sandbox.prepare`,
config causes `unconfined` and `login`), feature `sandbox-ops-v1`, three always-fresh routes, a public read-only
route for the lease public keys, new actions `projects.execution.read/write`, Fleet → worker → Sandbox, Projects →
Execution policy. The Linux kit ships `remyral-worker-prepare.{path,service}`; the Windows kit `remyral-jobrun.ps1`.

## Verification
Real Windows 11 (PowerShell 5.1, tr-TR), 2026-10-14: job runner (memory and process limits, exit codes, stdio,
argument quoting, tree kill on cancel, kill-on-close, orphan cleanup, bad spec), the worker's host runner and
unconfined runner end to end, identity facts and the service-SID inference, privileged prepare against a temp
layout (signature, replay, forgery), job-runner self-test as SYSTEM, installer plan tests. Linux privileged prepare
and the macOS keychain step: unit tests only (UNVERIFIED on a real host). Details: docs/design/p5-sandbox-ops.md.
