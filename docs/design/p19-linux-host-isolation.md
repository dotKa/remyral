# Design note: `p19-linux-host-isolation` — parallel host jobs on Linux, and honest capacity advice

- **Task:** `p19-linux-host-isolation` (replaces the open `p9-linux-host-isolation`; follow-ups
  `p19-linux-host-isolation-live`, `p19-linux-net-isolation`, `p19-linux-local-login-parallel`). **Date:** 2026-10-29.
- **Owner report (2026-10-29):** the assistant told the owner to raise the "host-restricted yuva sayısı" under
  Makineler → makine → Sandbox ve politika / Yapılandırma — no such setting exists. Owner: "ikisini de sıraya al" →
  (1) Linux per-job isolation so host attempts can run in parallel, (2) the assistant gives honest capacity advice.
- **Decision record:** [ADR-0067](../adr/0067-linux-per-attempt-bubblewrap-views.md) (amends ADR-0007 §host-restricted,
  T-SBX-4; Linux counterpart of ADR-0034).
- **Migration:** none. **Protocol:** additive (`SandboxCheckId` / `PrepareStepId` `host_isolation`, `PrepareStepId`
  `bubblewrap_install`, confinement `filesystem: 'bwrap'`, features `host-isolation-linux-v1`, `assistant-capacity-v1`).
  **Worker release needed:** yes (both parts). **Prompt rule:** 56 (renumber at merge if another branch took 56).

## 1. Problem

Per-profile concurrency is derived on the worker (`apps/worker/src/sandbox/profile-slots.ts`) from how the host runner
separates concurrent attempts: macOS Seatbelt → `maxParallelJobs`; Windows per-job accounts → min(healthy accounts,
`maxParallelJobs`); otherwise 1 and exclusive. On Linux the host runner had no per-attempt confinement
(`filesystemConfinement: 'none'`), so every `host-restricted` / `runtime-sandbox` attempt ran alone. Raising "En çok
paralel iş" did not change that, and no per-profile setting exists — the assistant invented one.

## 2. Options (Linux, the existing EC2 Ubuntu worker, unchanged service account)

| Option | Verdict |
|---|---|
| **bubblewrap view per attempt** (chosen) | Unprivileged at job time (user namespaces), works under the hardened unit (`RestrictNamespaces` is deliberately not set there), one binary from the distribution, verifiable by a self-check with the exact arguments, degrades to today's behaviour when missing. |
| Per-job Unix users (ADR-0034 style) | Needs root to create users and a privileged path at every spawn (the unit sets `NoNewPrivileges`, an empty capability bounding set, `RestrictSUIDSGID`: no setuid helper, no `sudo`), ACL bookkeeping per attempt, sweeps; a much larger privileged surface. |
| Landlock | Kernel-enforced, unprivileged, but Node cannot apply rulesets (needs a helper binary); does not hide `/proc` of the same account by itself. |
| Containers only | Already parallel; the owner wants host jobs. |

## 3. Design

### 3.1 The view (`apps/worker/src/sandbox/host/linux-isolation.ts`, `buildHostBwrapArgs`)

```
bwrap --unshare-user --unshare-ipc [--unshare-pid] --die-with-parent
      --ro-bind / /  --dev /dev  --tmpfs /dev/shm  --proc /proc  --tmpfs /tmp
      --tmpfs <dataDir>                     # and <workspaceRoot> unless it lies inside the data dir
      --ro-bind <dataDir>/{runtimes,tools,mcp}   --ro-bind <mirror>/objects
      [--bind <workerHome>]                 # local-login only
      --bind <package cache> --bind <added account folder>
      --bind <sandboxDir>  --bind <worktree>  --ro-bind <worktree>/.git
      --tmpfs <protected home path> --remount-ro … / --ro-bind /dev/null <protected file>
      --remount-ro <dataDir>  --chdir <worktree>  -- <rlimits prelude> <runtime …>
```

Later mounts cover earlier ones; the masks are remounted read-only last, so a write into another attempt's path fails
instead of landing in memory. Every path is an argv element (no shell, no interpolation); paths must be absolute and
free of NUL / newline. The rlimits prelude runs outside (its limits are inherited); the tree killer, reaper (token in
`/proc/<pid>/environ`), memory sampling and preview port ownership work from the worker's side as before (the worker
owns the attempts' user namespaces).

Mirrors Seatbelt's carve-outs exactly (data dir readable only for runtimes / tools / MCP, caches, account folders;
workspace root only the attempt's own dirs and mirror objects). `HOME_LOGIN_STORES` (`.claude`, `.claude.json`,
`.claude.lock`, `.codex`, `.local/share/opencode`, `.pi/agent`) and `hostExtraWritable` are masked for attempts that do
not use the worker's login.

### 3.2 HOME and subscription logins

- An attempt whose `authMode` is `local-login` (with `keepHome`) keeps the worker HOME, bound **read-write**: Claude
  Code's legacy lock next to `.claude`, the atomic rewrite of `~/.claude.json` and Codex's `~/.codex` behave exactly as
  before. Its protected paths stay masked.
- Every other attempt gets its own HOME in the sandbox dir, also when `keepHome` is set (as on Windows per-job
  accounts) — it never sees the worker's login stores.
- Because local-login attempts share a writable home (a planted `~/.gitconfig` could reach another), `selectProfile`
  runs a local-login attempt beside another local-login host attempt only when both belong to the same job family
  (ADR-0034 addendum 2's family rule, which also avoids the parent / sub-job deadlock). API-key attempts run beside
  anything that has a view. Not reported as `CAPABILITIES.localLogin` (that would make the master hold API-key jobs
  too): the worker declines such an attempt transiently (`(T-SBX-4)`), the queue offers it again.

### 3.3 Why other attempts' processes do not help (verified 2026-10-29)

Each attempt is in its own user namespace. The kernel's ptrace access check (`cap_ptrace_access_check`) refuses
`/proc/<pid>/root`, `cwd`, `environ` and `mem` of a process in a sibling user namespace even for the same uid. Verified
in Ubuntu 24.04 / bubblewrap 0.9 (docker `--privileged`, run as an unprivileged user): attempt B ran
`cat /proc/<A's pid>/root/<A's worktree>/marker` and `/proc/<pid>/environ` for every visible pid — all "Permission
denied". A PID namespace additionally hides the process list, but a new procfs in one is refused when the parent
mount namespace has locked submounts on `/proc` — exactly what systemd's `ProtectKernelTunables` /
`ProtectKernelLogs` create: `bwrap: Can't mount proc on /newroot/proc: Operation not permitted` (verified by bind-
mounting `/proc/sys` read-only before running bwrap). Without a PID namespace the fresh procfs mounts fine there. So
the self-check tries the PID namespace first and falls back; both variants passed the full probe in that test.

### 3.4 Proof before parallelism: the cross-attempt self-check

`LinuxIsolationController.verify()` (worker start in the background, and the Prepare step `host_isolation`):

1. `sandbox.linuxHostIsolation: "off"` → `host_isolation_disabled`.
2. `bwrap` on PATH, else `host_isolation_bwrap_missing` ("sudo apt install bubblewrap …" or privileged Prepare);
   root-owned and not group/world-writable, else `host_isolation_bwrap_untrusted`.
3. Two probe attempts under `<root>/jobs/hi-check-<rand>/{a,b}` + `sandboxes/…` with markers, and a marker file in the
   data dir. B runs (`sleep`) in its view while A probes, then the roles swap. A must write/read its own worktree and
   tmp, and must NOT: read B's worktree / sandbox markers, list B's worktree, read the data-dir marker or list it,
   reach B through `/proc/<pid>/root` or find B's token in any `/proc/<pid>/environ`, write `/usr`, create B's path.
   Afterwards the worker checks B's real worktree is unchanged (no planted file).
4. PID namespace first; `Can't mount proc` → again without; namespace errors → `host_isolation_userns_refused`; any
   failed expectation → `host_isolation_selftest_failed` with the failing checks named.

Only an `active` result makes `filesystemConfinement` `bwrap`. The result is kept in memory (a few hundred ms, re-run
at every start and Prepare, so a bubblewrap removed later is noticed at the next start; a spawn with a missing binary
fails that attempt).

### 3.5 Selection, slots, status

- `selectProfile` (`policy.ts`): `bwrap` applies to `host-restricted` only; `runtime-sandbox` keeps the `none` rules
  (alone). A view attempt is refused (busy, transient) while an `unconfined` or `runtime-sandbox` attempt runs, and a
  local-login view attempt while another family's local-login host attempt runs; with the running attempts unknown,
  conservatively alone (the job runner now always passes them: function jobs are left out of the list as of the
  count).
- `profileSlots`: `host-restricted` = `maxParallelJobs`, not exclusive; `runtime-sandbox` 1 + exclusive.
- `hostRestrictedConcurrency()` = `maxParallelJobs` with `bwrap`.
- Sandbox card: check `host_isolation` (ok / warning / failed with code, detail, fix), host-restricted confinement
  `filesystem: 'bwrap'` and the note "each attempt in its own bubblewrap view; subscription-login jobs run one job
  family at a time"; without the view the note is the controller's reason ("one attempt at a time: bubblewrap is not
  installed …"); runtime-sandbox on Linux shows "Parallel: one at a time" with why. The web card shows, under a ready
  host profile, the `host_isolation` state and — when missing — a catalog hint per code (Turkish / English) with the
  fix ("bubblewrap kurulu değil … sudo apt install bubblewrap …").
- Prepare: helper step `bubblewrap_install` (apt-get / dnf, fixed package `bubblewrap`, restart after install), then
  the worker step `host_isolation` (re-runs the self-check).

### 3.6 Egress

Unchanged and still applied: the per-job loopback egress proxy (`HTTPS_PROXY` …) is started as before and reachable
because the network namespace is shared; it is not enforced by the OS on Linux (`egress: proxy_env_only`, as before).
Unsharing the network needs a relay into each view (follow-up `p19-linux-net-isolation` — implemented behind
`sandbox.linuxPrivateNetwork`, off by default: [p22-worker-limits](p22-worker-limits.md) §2).

## 4. Security review (T-SBX-4 update, Linux)

| Threat | Mitigation | Residual |
|---|---|---|
| A reads / modifies B's worktree, scratch, git view | Not in A's view (masked workspace root, only own dirs bound back); self-check proves it on the machine, concurrently | — |
| A reaches B through `/proc` | Different user namespaces: kernel refuses `/proc/<pid>/root`, `cwd`, `environ`, `mem`; PID namespace where available | Without a PID namespace: B's process list and command lines are visible; A may signal B's processes (same uid — as on macOS) |
| A reads worker secrets (device key, vault, config state) | Data dir masked except runtimes / tools / MCP, cache, account folder (Seatbelt parity); self-check reads a data-dir marker | `/etc/remyral-worker/config.json` stays readable (worker-group file; as before and as on macOS); no secrets in it by design |
| A plants files B executes | B's dirs are not in A's view; package caches are per project (concurrent attempts of one project share it, as on macOS/Windows); `/tmp`, `/dev/shm` private; host read-only | local-login attempts of one family share the worker home |
| A leaves a daemon behind | `--die-with-parent`; PID namespace: init death kills all; otherwise the token reaper as before | as before without PID namespace |
| Replaced bwrap binary | must be root-owned, not group/world-writable | — |
| Network | unchanged: proxy env, shared loopback | loopback ports, abstract Unix sockets, other jobs' proxies (as macOS/Windows) |
| runtime-sandbox attempt (no view) next to a view attempt | refused both ways (busy) | — |

No new privilege: the worker runs bwrap unprivileged; the privileged helper only installs a fixed distribution
package (same pattern as Podman, signed request, no argument from the panel).

## 5. Failure modes

- bubblewrap missing / untrusted / user namespaces refused / check failed / switched off → one at a time, Sandbox card
  says why and how to fix; nothing else changes.
- Kernel or AppArmor refuses user namespaces (Ubuntu 24.04 `kernel.apparmor_restrict_unprivileged_userns=1` and no
  `bwrap-userns-restrict` profile) → `host_isolation_userns_refused` with the remedy.
- The unit hardening refuses a private procfs in a PID namespace → user + mount namespaces only (still isolated).
- bubblewrap uninstalled after the check → the next spawn fails with a clear error; the next start / Prepare turns the
  isolation off.

## 6. Part 2 — honest capacity advice

- **Read tool.** `describe_worker` returns `capacity` (`apps/master/src/chat/capacity.ts`, pure): `maxParallelJobs` and
  where it is set (“En çok paralel iş / Max parallel jobs”, Makineler → <machine> → Yapılandırma → Genel, or
  `draft_worker_config_change maxParallelJobs`), the local ceiling (`localCeiling.maxParallelJobs` from the config
  report), `hostIsolation` (os, confinement seatbelt / job_user / bwrap / none, state code and detail), per ready
  profile `parallel` (CAPABILITIES.profileConcurrency), `runsAlone` (exclusiveProfiles), `limitedBy`
  (`max_parallel_jobs` | `no_isolation` | `per_job_accounts` | `runtime_sandbox_nesting` | `unconfined_profile`), `why`
  and the worker's note, `subscriptionLogins`, `advice` (only real steps: raise maxParallelJobs when it is the limit;
  Linux: install bubblewrap via privileged Prepare or `sudo apt install bubblewrap`, allow user namespaces, run
  Prepare, update the worker release — gated on `host-isolation-linux-v1` —, or the container profile; Windows: per-job
  accounts via privileged Prepare / `sandbox.windowsJobSlots`) and `noOtherSetting`.
- **Prompt rule 57.** Capacity questions → describe_worker; answer only from `capacity`; never invent a setting; raise
  “En çok paralel iş” only for a profile whose `limitedBy` is `max_parallel_jobs`; the fixes per `limitedBy`.
- **Gating.** `assistant-capacity-v1`: for a turn on a worker without it, `capacity.rule` carries the rule text
  (older assistants have no rule 57). `host-isolation-linux-v1`: a Linux worker without it is told to update first.

## 7. Tests

- `apps/worker/test/linux-host-isolation.test.ts` (20): view arguments (order, masks, bound-back paths, home handling,
  path checks), probe verdicts, self-check (PID namespace, procfs fallback, leak, user namespaces, missing / untrusted
  bubblewrap, switched off), Prepare step, profile slots, selection (parallel, blockers, local-login family rule,
  unknown attempts), host runner argv (bwrap, per-attempt HOME with keepHome, local-login home, runtime-sandbox
  without view), Sandbox card (bwrap / missing).
- `apps/worker/test/linux-host-isolation.integration.test.ts` (Linux with bwrap only): the real self-check, and two
  concurrent attempts through the real host runner — B cannot read A's worktree (directly, `/proc/<pid>/root`,
  `/proc/<pid>/environ`), nor the data dir, and its write never reaches A.
- `apps/master/test/unit/chat-capacity.test.ts`, `apps/master/test/integration/chat-capacity.test.ts` (DB),
  `packages/agent-adapters/test/assistant-capacity.test.ts`, web `diyalog-w3-machine-config.test.tsx`.

## 8. UNVERIFIED

1. The real systemd unit on the EC2 worker (`ProtectProc=invisible`, `ProtectKernelTunables`, `PrivateDevices`,
   AppArmor of the installed Ubuntu): expected — PID namespace refused, user + mount namespaces active. Verified only
   in a privileged Docker container with a simulated read-only `/proc/sys`.
2. Ubuntu 24.04's AppArmor userns restriction on the EC2 image (whether `bwrap-userns-restrict` is loaded).
3. Real runtimes inside the view: Claude Code / Codex / OpenCode / Pi with API keys; Claude Code local-login token
   refresh with the read-write home; OpenCode's loopback server; git with the per-attempt view and mirror alternates;
   package managers with the shared cache; MCP stdio probes.
4. Raspberry Pi OS (arm64) bubblewrap.
5. The privileged `bubblewrap_install` step through the installed helper (the helper must be of this release).
