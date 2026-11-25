# ADR-0067: Per-attempt bubblewrap views for parallel host-restricted attempts on Linux

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** owner (2026-10-29: "ikisini de sıraya al" — parallel host jobs on Linux, and honest capacity advice), agent
- **Related:** `p19-linux-host-isolation` (was `p9-linux-host-isolation`), ADR-0007, ADR-0019, ADR-0033
  (`profile-slots-v1`), ADR-0034 (Windows per-job accounts), threat model T-SBX-4; design
  [p19-linux-host-isolation.md](../design/p19-linux-host-isolation.md)

## Context
ADR-0007 runs host profiles as one dedicated low-privilege worker account. On Linux nothing separated two concurrent
attempts of that account (`filesystemConfinement: 'none'`), so `host-restricted` and `runtime-sandbox` ran one at a
time and alone (T-SBX-4) while macOS (Seatbelt) and Windows (per-job accounts, ADR-0034) run them in parallel. The
owner's Linux EC2 worker queued every "Makinede (kısıtlı)" job behind the running one. The worker service must keep
its account and its systemd hardening; root must not be needed at job time.

## Decision
1. On Linux every `host-restricted` attempt runs inside **its own bubblewrap view**: its own user, mount and IPC
   namespace (and PID namespace where the host allows a private `/proc` there), the host read-only, a private
   `/dev`, `/dev/shm`, `/proc`, `/tmp`; the worker data dir and the workspace root replaced by empty read-only tmpfs
   with only this attempt's worktree and sandbox dir (read-write), its mirror's object store, the worker-managed
   runtime / tool / MCP installs (read-only), its package cache and an added account's login folder (read-write)
   bound back; the worktree's `.git` read-only; protected home paths masked. The network namespace stays shared
   (egress stays the per-job proxy environment, as before on Linux).
2. A subscription-login (`local-login`) attempt keeps the worker HOME read-write (its login store, refresh locks and
   atomic rewrites behave as before) and therefore runs beside other subscription-login attempts only within its job
   family; every other attempt gets a per-attempt HOME (also with `keepHome`) and sees none of the worker's login
   stores.
3. `runtime-sandbox` is not wrapped (the runtime's own bubblewrap cannot nest in the view): it keeps the old rules —
   one at a time, alone — and no bubblewrap-view attempt starts while an attempt without a view (`runtime-sandbox`,
   `unconfined`) runs.
4. Parallelism is enabled only after a **cross-attempt self-check** on the machine, with exactly the attempt
   arguments: two probe attempts run at once and each must reach its own dirs and must not reach the other's (directly,
   through `/proc/<pid>/root` or `/proc/<pid>/environ`), the worker data dir or the system dirs (writes). It runs at
   worker start (background) and in Prepare (`host_isolation` step). Without bubblewrap (a root-owned, not
   group/world-writable binary), user namespaces, or a passing check, host attempts run one at a time as before and
   the Sandbox card says why and what fixes it. `sandbox.linuxHostIsolation: "off"` is the owner's local switch.
5. The worker reports `filesystemConfinement: 'bwrap'`; `profileConcurrency['host-restricted']` = `maxParallelJobs`
   (not exclusive); `runtime-sandbox` and `unconfined` stay 1 and exclusive. Feature `host-isolation-linux-v1`.
6. The privileged helper may install the distribution's `bubblewrap` package (Prepare step `bubblewrap_install`,
   fixed package name, apt / dnf), like Podman.

## Alternatives considered
- **Per-job Unix users provisioned by an admin operation** (like ADR-0034) — needs root at provisioning, a privileged
  setuid/`sudo` path or helper at every spawn (the worker unit has `NoNewPrivileges`, an empty capability set and
  `RestrictSUIDSGID`), ACL bookkeeping per attempt and a cleanup sweep; rejected: bubblewrap needs none of that and
  works under the unchanged unit.
- **Landlock** — unprivileged and kernel-enforced, but needs a helper binary to apply rulesets (Node cannot make the
  syscalls) and leaves `/proc` of other attempts reachable through the same account unless combined with namespaces.
- **A PID namespace always** — refused under the worker unit's `ProtectKernelTunables` / `ProtectKernelLogs`
  (locked `/proc` submounts make a new procfs "too revealing": `bwrap: Can't mount proc on /newroot/proc`, verified).
  Not needed for isolation: each attempt's own user namespace already makes the kernel refuse `/proc/<pid>/root`,
  `cwd`, `environ` and `mem` of another attempt's processes (verified); used where available.
- **Unsharing the network** — the per-job egress proxy and OpenCode's server listen on the host loopback; a private
  network namespace needs a relay into each view. Left for a follow-up (egress was never enforced on Linux).
- **Keep one at a time / use the container profile** — the owner decided against it for host jobs.

## Consequences
- Linux / Pi host-restricted jobs run in parallel after `bubblewrap` is installed (Prepare with the privileged helper
  or `sudo apt install bubblewrap`) and the self-check passed; nothing else changes on the machine.
- Residual: attempts share the network namespace (loopback ports, abstract Unix sockets, each other's egress proxies),
  without a PID namespace they see (not reach) each other's process list and may signal each other's processes (as on
  macOS); subscription-login attempts of one job family share the worker home; `runtime-sandbox` stays sequential.
- Old masters must be deployed first: the new `SandboxCheckId` / `PrepareStepId` / confinement values are strict
  enums in CAPABILITIES.sandboxStatus (as with `job_slots`).

## Verification
Unit tests (`apps/worker/test/linux-host-isolation.test.ts`: arguments, self-check verdicts and fallbacks, profile
slots, selection, host runner argv, status, Prepare); a Linux-only integration test with real bubblewrap
(`linux-host-isolation.integration.test.ts`, skipped elsewhere); by hand in Ubuntu 24.04 + bubblewrap 0.9 (plain and
with a ProtectKernelTunables-like `/proc`). UNVERIFIED-LIVE on the owner's EC2 worker under the real systemd unit
(`p19-linux-host-isolation-live`).
