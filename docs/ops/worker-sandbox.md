# Worker sandbox operations (p3-sandbox)

Design and security review: [docs/design/p3-sandbox.md](../design/p3-sandbox.md). ADR-0007.

## Dedicated worker OS user (mandatory for host profiles)

Run the worker service as a dedicated, unprivileged user and name it in the config (the installers do this; see "Dedicated account and Prepare" below):

```json
{ "sandbox": { "workerUser": "_remyral" } }
```

The worker refuses host profiles (`sandbox_unavailable`, reason `worker_identity_unsafe`) when it runs as root/SYSTEM, as a member of `admin`/`sudo`/`wheel`/`root`/`docker`/`lxd`/`libvirt`/`disk` or BUILTIN\Administrators, as the macOS console (logged-in GUI) user, or as anyone other than `workerUser`. Rootless Docker/Podman do not need the `docker` group.

The workspace root and the worker data dir must be owned by that user, mode 0700.

## Host jobs without filesystem confinement (`none`)

`host-restricted` confines each attempt with **Seatbelt** (macOS, always), a **bubblewrap view** (Linux) or a
**per-job Windows account** (Windows). When the Linux view or the Windows accounts are not available, the worker does
not refuse host jobs: it **falls back to no filesystem confinement** and runs them one at a time. The job itself does
not say so — check the machine's Sandbox card. It happens on Linux when bubblewrap is missing or not root-owned, when
the kernel refuses unprivileged user namespaces (**Ubuntu 24.04 does by default**), when the cross-attempt self-check
failed or `sandbox.linuxHostIsolation` is `"off"`; on Windows until the per-job accounts are provisioned and
self-tested, or with `sandbox.windowsJobSlots: 0`.

What `none` means precisely — the job's code (the runtime, its tools, anything a repository's scripts start):

- runs **as the worker's own service account** (`remyral-worker`, `NT SERVICE\RemyralWorker`) with the job's resource
  limits (rlimits / Job Object) and, on Windows, a privilege-stripped token;
- can **read everything that account can**: the worker's device key and its local secret store (both `file` under the
  data dir by default — `keystore` / `secretStore` in the config), the stored panel configuration, other jobs'
  workspaces and caches; whoever has the device key can act as this worker towards the master;
- can **write into the data dir**, including the request files the root/SYSTEM helper reads (`machine-admin/`,
  `updates/`, `sandbox/`) — the helper still verifies the master's signatures, but this is why machine administration
  is refused in this state (below);
- has **no enforced egress**: the job gets `HTTPS_PROXY` / `HTTP_PROXY` pointing at its proxy, but nothing stops a
  direct connection (Linux: the worker unit's systemd hardening still applies — read-only system, no home dirs).

The Sandbox card shows host-restricted with "no file system boundary", the code `host_unconfined_fallback`, the cause
and what to do. **Machine administration** is refused while host jobs are unconfined (the worker:
`machine_admin_host_unconfined`; the root/SYSTEM helper checks on its own: `host_unconfined`), unless the machine's
owner opts in explicitly with `"localCeiling": { "allowMachineAdmin": true }` (installers: `--allow-machine-admin`;
[machine-admin.md](machine-admin.md)).

Real confinement instead:

- **Linux:** a bubblewrap view per attempt (the Linux section below), on Ubuntu 24.04 with the next step; or the
  container profile.
- **Windows:** per-job accounts (the Windows section below).

### Ubuntu 24.04: let bubblewrap create user namespaces

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`: a program without an AppArmor profile that allows
it cannot use unprivileged user namespaces, so bubblewrap fails (`setting up uid map: Permission denied`) and the card
shows `host_isolation_userns_refused`. Give bubblewrap (only) that permission, as root:

```sh
sudo apt install bubblewrap
sysctl kernel.apparmor_restrict_unprivileged_userns     # 1 = restricted (the default)
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/bwrap
sudo -u remyral-worker /usr/bin/bwrap --unshare-user --ro-bind / / /bin/true && echo userns-ok
```

Then Machines → <machine> → **Sandbox & policy → Prepare** (or restart the worker): the card shows "bubblewrap: own
view per attempt". The profile lets every local account start bubblewrap with a user namespace — appropriate on a
machine dedicated to the worker. The system-wide alternative, `kernel.apparmor_restrict_unprivileged_userns=0` in
`/etc/sysctl.d/`, lifts Ubuntu's restriction for every program and is not recommended.

## Linux: container profile

1. Rootless Docker (`dockerd-rootless-setuptool.sh install`) or Podman for the worker user. Rootful daemons are refused.
2. Build the images (never pulled at job time):
   `node infra/worker/images/build.mjs --only base,egress-proxy,<runtime…>` (runtimes: `pi`, `codex`, `claude-code`, `opencode`).
3. Pin them in the config, by digest in production (`docker image inspect --format '{{.Id}}' remyral/runtime-pi:0.1.0`):

```json
{ "sandbox": { "container": { "engine": "docker", "images": { "pi": "remyral/runtime-pi@sha256:…", "default": "remyral/runtime-base@sha256:…" }, "proxyImage": "remyral/egress-proxy@sha256:…" } } }
```

Leftovers after a crash: `docker rm -f $(docker ps -aq --filter label=remyral.sandbox)`; `docker network prune --filter label=remyral.sandbox=job`.

## macOS: host-restricted with Seatbelt

`/usr/bin/sandbox-exec` must work (deprecated by Apple, functional on macOS 26.6). The worker checks it at start; if it stops working after an OS update, host jobs are refused. `sandbox.protectedHomes` should list the owner's home (`/Users/<owner>`) in addition to the worker user's. For `local-login` runtimes set `keepHome: true`, the runtime's state dir in `hostExtraWritable`, and — for Claude Code, which keeps its login in the Keychain — `allowKeychain: true` (the worker user's keychain only).

## Windows: host-restricted with a Job Object

Verified on a real Windows 11 (PowerShell 5.1, tr-TR), 2026-10-14 — see docs/design/p5-sandbox-ops.md for what was
run as which account. The runtime is started by the job runner `remyral-jobrun.ps1` inside a Job Object (memory,
process count, CPU cap, kill-on-close). Nothing to install: the worker carries the script, writes it to
`<dataDir>\sandbox\` (or uses the identical copy install.ps1 puts next to it) and self-tests it at start and on
**Machines → <machine> → Sandbox & policy → Prepare**. If the self-test fails (`job_runner_selftest_failed`), PowerShell `Add-Type`
is blocked on the machine (Constrained Language Mode / AppLocker / WDAC, or a GPO-enforced execution policy) — allow
it for the worker account or use another machine. Each attempt's folders are restricted to SYSTEM, Administrators and
the worker account. Egress goes through the per-job proxy *environment*; Windows does not enforce it. Without per-job
accounts (below) host attempts have **no filesystem confinement at all** — they run as the worker service account
([above](#host-jobs-without-filesystem-confinement-none)) — and run one at a time.

Since job runner version 3 (p22-worker-limits) an attempt that runs as the worker account (no per-job accounts,
`unconfined`, services, IDE) is started with a **privilege-stripped** copy of the worker's token
(`CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE`: every privilege except `SeChangeNotifyPrivilege` deleted —
`SeImpersonate`, `SeAssignPrimaryToken`, `SeIncreaseQuota` are not in the child's token). The self-test fails
(`job_runner_selftest_failed`) if the stripped token still holds another privilege.

### Windows: parallel host jobs with per-job accounts (p9-windows-host-isolation, ADR-0034)

Each concurrent host attempt runs as its own local account `remyral-job-<n>`; its folders are restricted to that
account (plus SYSTEM, Administrators and the worker). Design and security review:
[p9-windows-host-isolation.md](../design/p9-windows-host-isolation.md). **UNVERIFIED on a real machine** until the
live check (`p9-windows-host-isolation-live`).

Turn it on (once per Windows machine):

1. Update the worker to this release (Settings → Worker releases, or automatic).
2. **Re-run the installer kit as Administrator** (`install.ps1` from the kit) — this updates the privileged helper,
   which is never updated automatically. Until then the Sandbox card shows `job_slots_unprovisioned` and Prepare's
   privileged part does not know the new step.
3. Machines → <machine> → **Sandbox & policy → Prepare**, with "privileged helper" ticked (authenticator code). The helper (SYSTEM,
   runs once a minute) creates the accounts, grants the two privileges and, about 15 s after reporting, **restarts the
   RemyralWorker service** itself (a full stop/start: new privileges reach the service only with a new service logon —
   a restart of the worker process alone keeps the old token). After the restart the worker runs the cross-access
   self-test by itself (a few seconds per account); a failed result from before the restart never blocks that.
   Running Prepare again re-runs the self-test immediately. If the card shows `job_slots_service_restart`
   ("restart the RemyralWorker service …": the privileges are granted but not in the worker's token — e.g. an older
   helper, or the helper's restart failed, see `updater.log`), run `Restart-Service RemyralWorker` as Administrator once.
4. The card shows **Per-job Windows accounts: ok** and on host-restricted **Parallel: up to N**.

What the privileged step does (fixed script `remyral-job-slots.ps1`, no parameters from the panel):

| Item | Value |
|---|---|
| Accounts | `remyral-job-1` … `remyral-job-N`; N = `sandbox.windowsJobSlots`, else max(`maxParallelJobs`, 4), max 16 |
| Group | `remyral-job-slots` (+ `BUILTIN\Users`); batch logon only; interactive, RDP, network, service logon **denied**; hidden from sign-in |
| Passwords | random, rotated on every privileged Prepare; only as DPAPI (LocalMachine) blobs in `C:\ProgramData\RemyralWorker\job-slots\` (SYSTEM, Administrators, worker read) |
| Worker service | `SeAssignPrimaryTokenPrivilege`, `SeIncreaseQuotaPrivilege` (needed to start a process as another account) |
| Read access for slots | `<dataDir>\runtimes`, `<dataDir>\tools` (worker-managed runtimes, MinGit, cloudflared) |

Per attempt the worker grants its account the attempt's folders (modify), the project's git objects (read) and package
caches (modify), and revokes them afterwards; leftover processes and scheduled tasks of the account are removed. A
cleanup failure takes the account out of service until the next Prepare (fewer parallel jobs, never a dirty account).
**Subscription logins (`local-login`) never run on a per-job account** (p9-windows-slots-local-login, design §9.3):
parallel processes sharing one subscription login race on its OAuth refresh and can leave it unusable (seen live on
1.0.31). A local-login job runs as the worker account, alone (other jobs wait — a transient decline, the job stays
queued); API-key (secret-ref) jobs run in parallel on the accounts with a per-attempt HOME. The card shows
**Parallel: up to N for API-key runtimes; subscription logins run one at a time**. The accounts get no access to the
worker's login folders (`.claude`, `.claude.json`, `.codex`, `hostExtraWritable`): at every start and Prepare the
worker removes a `remyral-job-slots` entry left by older releases (and takes ownership back) and uses the accounts only
after that check (`job_slots_login_shared` if it fails — run Prepare; manual fix:
`icacls "<profile>\.claude" /remove:g remyral-job-slots /T` and the same for `.claude.json`, `.codex`).

If a subscription run failed with "another Claude Code process is refreshing it" (Runtimes tab: "Two Claude Code
runs refreshed the shared subscription login at the same time"), the stored login is probably consumed: **Log in
again** on the machine's Runtimes tab.

Card codes: `job_slots_unprovisioned` (no accounts — steps 2–3), `job_slots_unverified` (self-test not run for these
accounts — Prepare), `job_slots_selftest_failed` (an account could reach another's folder or the secrets — see the
step detail; host jobs stay one at a time), `job_slots_service_restart` (privileges granted but not yet in the worker's
token — restart the RemyralWorker service), `job_slots_worker_mismatch` (prepared for another service account —
privileged Prepare), `job_slots_quarantined` (every account failed its cleanup — Prepare), `job_slots_login_shared` (the subscription login
store still grants the accounts access and could not be taken back — Prepare, or the manual icacls above),
`job_slots_disabled` (owner switch below).

Turn it off on a machine (host jobs one at a time again after a worker restart):

```json
{ "sandbox": { "windowsJobSlots": 0 } }
```

Turn it back on: delete the `windowsJobSlots` key from the `sandbox` section of
`C:\ProgramData\RemyralWorker\config.json` (edit in place as Administrator so the file keeps its ACL;
`NT SERVICE\RemyralWorker` needs **(R)** on it — after replacing the file:
`icacls C:\ProgramData\RemyralWorker\config.json /grant "NT SERVICE\RemyralWorker:(R)"`), `Restart-Service
RemyralWorker`, then Sandbox → Prepare. Only with a release that has p9-windows-slots-local-login (subscription logins
one at a time) — on older releases keep it at `0` on machines that use `local-login`.

Remove the accounts (as Administrator, e.g. after uninstalling):
`powershell -ExecutionPolicy Bypass -File "<install dir>\remyral-job-slots.ps1" -Remove -StateDir C:\ProgramData\RemyralWorker\job-slots -WorkerSid <SID of NT SERVICE\RemyralWorker>`
(`sc.exe showsid RemyralWorker` prints the SID).

### macOS and Linux

macOS host jobs are already parallel (Seatbelt confines each attempt).

### Linux: parallel host jobs with per-attempt bubblewrap views (p19-linux-host-isolation, ADR-0067)

Each `host-restricted` attempt runs in its own bubblewrap view: its own user, mount and IPC namespace (and PID
namespace where the host allows a private `/proc` there), the host read-only, the worker data dir and workspace root
hidden except the attempt's own worktree / sandbox dir, its mirror's objects, the worker-managed runtimes / tools / MCP
servers, its package cache. Design and security review: [p19-linux-host-isolation.md](../design/p19-linux-host-isolation.md).

Turn it on (once per Linux / Raspberry Pi machine):

1. Update the worker to this release.
2. Install bubblewrap: Machines → <machine> → **Sandbox & policy → Prepare** with "privileged helper" ticked (the
   helper installs the distribution's `bubblewrap` package with apt / dnf and restarts the worker), or by hand:
   `sudo apt install bubblewrap` (Fedora / RHEL: `sudo dnf install bubblewrap`).
3. Prepare again (or wait for the worker's start-up check): the `host_isolation` check runs two probe attempts at once
   and must find them isolated. The card shows **Per-attempt Linux isolation: ok**, host-restricted "bubblewrap: own
   view per attempt" and **Parallel: up to N** (N = "Max parallel jobs").

Card codes (`host_isolation`): `host_isolation_bwrap_missing` (step 2), `host_isolation_bwrap_untrusted` (the `bwrap`
on PATH is not root-owned or is group/world-writable — install the distribution package),
`host_isolation_userns_refused` (unprivileged user namespaces refused — Ubuntu 24.04's default: see
[Ubuntu 24.04](#ubuntu-2404-let-bubblewrap-create-user-namespaces); other kernels `kernel.unprivileged_userns_clone=1`), `host_isolation_unverified` (not checked yet — Prepare),
`host_isolation_selftest_failed` (an attempt could reach another's files — the detail names the check; host jobs stay
one at a time), `host_isolation_disabled` (owner switch below).

What stays sequential: `runtime-sandbox` (the runtime's own bubblewrap cannot nest in the view) and subscription-login
(`local-login`) jobs of different job families (they keep the worker home read-write). API-key jobs run in parallel.
The worker unit's hardening (`ProtectKernelTunables`, `ProtectKernelLogs`) refuses a private `/proc` in a PID
namespace; the worker then isolates attempts by user + mount namespaces only (each attempt sees, but cannot reach,
the others' processes) — no unit change is needed.

Turn it off on a machine (host jobs one at a time again after a worker restart):

```json
{ "sandbox": { "linuxHostIsolation": "off" } }
```

Two opt-in settings (p22-worker-limits, [design](../design/p22-worker-limits.md)); both **off** by default until their
live check passed on the machine (design §2.6 / §3.4), then a worker restart. Since p22-sandbox-settings
([design](../design/p22-sandbox-settings.md)) both are also set from the panel — Makineler → <machine> → Yapılandırma →
Yerel ayarlar → **Linux sandbox ayarları** (or the assistant's `draft_worker_config_change sandbox`), worker release with
`worker-sandbox-settings-v1`; a key written in the local file below pins it there:

```json
{ "sandbox": { "linuxPrivateNetwork": "auto", "linuxLoginStoreView": true } }
```

- `linuxPrivateNetwork: "auto"` — after the cross-attempt check a network check runs; when it passes, an attempt that
  serves nothing to the worker gets its own network namespace (only its own loopback; the egress proxy through a Unix
  socket relay; other jobs' proxies and servers, host loopback services and abstract sockets are gone). Services, IDE
  servers, OpenCode and jobs that may open preview links keep the host network. A failed network check keeps the host
  network and says why in the `host_isolation` detail ("network: shared with the host (…)").
- `linuxLoginStoreView: true` — subscription-login attempts get a private home (entries read-only, caches fresh, the
  runtimes' login stores read-write, their settings / hooks / instructions / commands / plugins read-only — missing ones
  are created empty) and a private copy of `~/.claude.json`; they then run in parallel across job families.

## Dedicated account and Prepare from the panel

New installs write `sandbox.workerUser`; older installs are recognised when the service runs as the installer's
account (`NT SERVICE\RemyralWorker` by its service SID, `remyral-worker`, `_remyralworker`). The Sandbox card lists every
profile with its reason code and what fixes it. **Prepare** fixes what the worker can; with "privileged helper" it also
hands the signed command to the root/SYSTEM updater, which runs its fixed list (Windows: workerUser, keepHome for
local-login, job runner next to the worker, installer ACLs; Linux: config keys, Podman from apt/dnf, subordinate ids;
macOS: config keys incl. keychain for local-login). Machines installed before this release need the installer kit
re-run once for the privileged part. Opt out locally: `"remoteOps": { "disabled": ["sandbox"] }`.

Linux: Prepare installs rootless Podman but reports `container_service` as owner work — the hardened worker unit
(NoNewPrivileges, RestrictSUIDSGID, no capabilities, ProtectHome) blocks rootless Podman's setuid `newuidmap`; relaxing
it is a deliberate trade-off. Images are still built by hand (below).

## Unconfined profile (ADR-0019)

The runtime runs as the worker's service account with no filesystem or egress confinement; limits, timeouts and the
admin/root refusal still apply, untrusted sources are refused, attempts run one at a time. Needs both: Machines → <machine>
→ Sandbox → "Allow unconfined" (admin, fresh authenticator code, owners notified) and Projects → Execution policy →
"Unconfined" for the job's project; the job asks for `sandboxProfile: "unconfined"`. Forbid it on a machine whatever
the panel says:

```json
{ "localCeiling": { "allowUnconfined": false } }
```

(a `localCeiling.sandboxProfiles` list without `unconfined` forbids it too).

## Shared package caches (ADR-0029)

Trusted host-profile jobs of a project reuse the machine's npm / pnpm / Yarn / pip / uv / Cargo / Go downloads from
`<dataDir>/caches/host/<project key>/` (untrusted sources and container jobs never get one). Local config:

```json
"packageCaches": { "enabled": true, "maxBytes": 10737418240 }
```

`enabled: false` is the owner's hard off switch (the panel cannot turn caches on); `maxBytes` is the limit unless the
panel sets Machine → Configuration → "Package cache limit" (0 = off and empty). Least recently used projects are
evicted after jobs finish. Projects switch caches off under Execution policy → Package caches. The macOS Seatbelt
profile opens only the project's cache dir. Details: [p6-warm-caches.md](../design/p6-warm-caches.md).

## Limits

`sandbox.limits` (`memoryBytes`, `cpus`, `pids`, `fileSizeBytes`, `openFiles`, `tmpBytes`); defaults 4 GiB, 2 CPUs, 512 pids, 2 GiB files, 4096 files, 1 GiB tmp. On POSIX hosts `pids` is RLIMIT_NPROC of the whole worker user.

## Egress

`sandbox.egressAllow` (default `api.anthropic.com`, `api.openai.com`): host names only, port 443 unless given. The proxy logs one JSON line per decision.

Workspace jobs (p5-research-workspace, [workspaces.md](workspaces.md)) add the workspace's hosts (`allowlist`) or,
with egress `web`, any public host on port 443 (sidecar env `REMYRAL_EGRESS_MODE=web`; decisions with reason
`public-web`). The forbidden address ranges and the IP-literal refusal apply in every mode. Container workers need
the egress-proxy image of this release for `web`.

Repository projects (p14-repo-egress, [design](../design/p14-repo-egress.md)): Projects → Policy → Network access
(none — the default, model APIs only · allowlist — presets such as npm / PyPI / GitHub plus hosts · web) reaches
workers with `repo-egress-v1` as ASSIGN_JOB `execution.repoEgress` and is added to the job's proxy on top of
`sandbox.egressAllow` and the MCP hosts; workers without the feature keep model APIs only. A refused tunnel answers
403 with `X-Remyral-Egress: not-allowlisted | forbidden-address | bad-request` and a text body naming the policy and
where to change it (container jobs: sidecar env `REMYRAL_EGRESS_HINT`, needs the egress-proxy image of this release).
