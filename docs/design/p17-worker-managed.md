# Design note: `p17-worker-managed` — the machines from the panel (wave 3 of "the whole management from the panel")

- **Task:** `p17-worker-managed`. **Date:** 2026-10-27. **Migrations:** `0166_worker_update_notice.sql` (Part 1),
  `0167_worker_settings.sql` (Part 2), `0168_worker_removal.sql` (Parts 3, 4).
- **Owner direction (2026-10-26):** "tüm yönetimi panelden sağlayabilmeliyiz". Gap list:
  the internal note `panel-yonetim-eksikleri` (not published), sections "Güncelleme" and "Makineler".
  Waves 1–2: [p17-host-actions](p17-host-actions.md), [p17-panel-settings](p17-panel-settings.md).
- **ADR:** [ADR-0015 amendment 2026-10-27](../adr/0015-panel-managed-workers.md) (local settings in the managed
  configuration), [ADR-0017 amendment 2026-10-27](../adr/0017-remote-worker-operations.md) (`worker.uninstall`),
  [ADR-0021 amendment 2026-10-27](../adr/0021-ai-machine-administration.md) (runtime paths, the helper's trigger,
  rootless Docker).
- **Feature flag:** one worker feature, `worker-managed-v1`, for the whole wave (CAPABILITIES `features` is bounded; its
  limit is raised from 64 to 96 at the same time). **Deploy order:** the master first (closed feature enum, new op kinds
  in a closed union), then the worker release. An older worker keeps working: the master sends it no `settings`, no
  `worker.uninstall` and no `helper.manage` (refused `worker_update_required` with reason `worker_managed`), and the
  panel says to update it or shows the manual command.

## 1. Part 1 — per-machine version control and a visible rollback

The API existed (`POST /workers/:id/update`, p2-signed-updates); the panel had no buttons and a silent rollback (e.g.
win-1 1.1.4 → 1.1.3, the new version did not report healthy) was only a line in the attempt history.

- **Makine → Yönetim → Sürüm** (`admin-update.tsx`): running version, channel, pin, the previous version; the updater's
  last result as an alert when it rolled back or failed — status, `from → to`, reason (`health_check_failed`) and the
  updater's own line (`1.1.4 did not connect and heartbeat within 90 s; 1.1.3 restored and healthy`).
- Owners / admins (`workers.update`, step-up): save the channel (clears a pin), pin a version (an older one is sent as
  `rollback: true`), "Önceki sürüme geri dön" (second press), "Yeniden dene" (re-targets the failed version: a new
  intent, so `offer` no longer skips it), remove the pin, "do not wait for jobs" (`force`). Offline: applied when it
  connects (the intent is stored; offers happen on session start).
- **Master:** `GET /fleet/overview` `release.lastAttempt` gains `id`, `fromVersion`, `detail`, `rollback`,
  `hasDiagnostics`, and `release.previousVersion` (the start version of the last succeeded attempt that reached the
  running version, only while that release is stored). A `rolled_back` / `failed` UPDATE_STATUS raises the notification
  `worker.update_failed` (owners and admins, warning, once per attempt: dedupe key = attempt id; migration 0166 widens
  the kinds).
- **Machine list:** a "geri alındı" / "güncelleme başarısız" badge linking to the Admin tab; the overview reason is an
  attention item carrying the updater's line.

## 2. Part 2 — the worker's local settings managed from the panel

**Shape.** APPLY_WORKER_CONFIG `settings` (spec and document, `WorkerSettings` in `packages/protocol/src/worker-managed.ts`),
sent only to `worker-managed-v1` workers (an older worker would strip the key and fail the document hash). The worker
reports `workerConfig.effective.settings`: the values in effect, the keys its local file pins, and the keys waiting for
a restart.

| Setting | Panel-managed | Rule |
| --- | --- | --- |
| `updates.enabled`, `updates.channel`, `updates.healthTimeoutSec` | yes | a key written in the local file pins it |
| `updates.minVersion` | yes | a floor: the higher of the local and the panel value |
| `updates.releaseKeys`, `updates.catalog`, `updates.catalogKeys`, `updates.installDir` | **no** | release-delivered / root-owned |
| `logLevel` | yes | applies at once (logger `setLevel`) |
| `telemetry.otlpEndpoint` (https) / off | yes | only when the local file has no `telemetry` (its headers file must never reach an endpoint the panel chose); the panel never sets a headers file |
| `assistant.disabled`, `assistant.maxSessions`, `assistant.sandbox` (`auto` / `required`) | yes | `sandbox: off` (host-native, for diagnosis) is local only; a locally written `disabled: true` is the owner's veto (pinned) |
| `remoteOps.npmRegistry` (https), `remoteOps.restartable`, `remoteOps.logFileBytes` | yes | artifacts are still checked against the release's checksums |
| `remoteOps.disabled` | **no** | the machine owner's local veto of remote operation groups |
| `packageCaches.enabled` | yes | pinned when written locally (`maxBytes` was already panel-managed: `workspace.packageCacheMaxBytes`) |
| `loginRecheckMinutes`, `usageProbeMinutes`, `claudeLockMaxAgeMinutes` (`settings.probes.*`) | yes | |
| `runtimes.<rt>.binary`, Pi `runtimes.pi.extensions` (`settings.runtimePaths`) | yes, **owner-only route** | see below |
| `runtimes.<rt>.containerBinary`, OpenCode `config` | no / already | `containerBinary` stays local; OpenCode config = the existing `runtimes.opencode.options` |
| `localCeiling.*` | **no** | the machine owner's veto; shown read-only (Yapılandırma → Yerel ayarlar) with why |
| `masterUrl`, `workspaceRoot`, `dataDir`, `keystore`, `secretStore`, `keychainPath`, `masterLeaseKeys`, `sandbox.*`, `skills.publicKeys`, `gitBinary`, `devFakeRuntime` | **no** | identity, trust roots and paths the worker needs before it can talk to the master |

**When it applies.** Most of these are read once when the daemon builds its components (update agent, telemetry exporter,
assistant host, probes, runtime adapters). The worker therefore lays the **stored** panel document's settings over the
local file **at start** (`startSettings` in `daemon/run.ts`: `settingsPlan` → `verifyRuntimePaths` → `withSettings`), and
reports a later change as `pendingRestart`; the panel links to Yönetim → Makine servisini yeniden başlat. The log level
is applied live. `remyral-worker doctor` / CLI commands read the local file only.

**Runtime paths (the decision).** A panel must never point a runtime at an arbitrary binary on its own. Accepted only
when **all** hold:
1. the owner sets them through `PUT /workers/:id/config/runtime-paths` (authz `machines.admin.enable` = owner,
   **always-fresh** step-up, audited `worker.runtime_paths`, config cause `runtime_paths`, migration 0167); the general
   editor refuses a change (`use_runtime_paths_route`), other edits carry them;
2. machine administration is enabled for the worker in the desired configuration (the owner already approved privileged
   administration of that machine, ADR-0021) — and in effect on the worker (not vetoed by
   `localCeiling.allowMachineAdmin: false`); switching it off drops the paths;
3. the protocol rules: an absolute path without `..` / control characters, the basename is the runtime's own executable
   (`claude`, `codex`, `pi`, `opencode`, optionally `.exe` / `.cmd`), extensions only for Pi and only `.js` / `.mjs` /
   `.ts`;
4. the worker's start-time check: absolute for its OS, outside the workspace root (agent-writable), an existing regular
   file (links resolved) not writable by group or others (POSIX; on Windows the ACL is the installer's). A failing path
   is not used (the local value stays) and is reported `invalid_value`. A path the local file writes pins it.

**The privileged updater.** `updates.*` are also the root/SYSTEM updater's settings, but the stored panel document lives
in the service account's data dir. The updater (`update/helper/config.ts`, `apply` / `rollback`) reads it as an
untrusted hint (no link, regular file, hash verified) and takes the panel values only in the narrowing direction:
`enabled: false`, a **higher** `minVersion`; `channel` and `healthTimeoutSec` only where the root-owned file does not
write them. Accepted risk: a compromised service account could forge `channel: canary` / another health timeout — it
still installs only releases signed with the trusted release keys, within 15–900 s.

## 3. Part 3 — removing a worker from the panel

**Path.** `worker.uninstall {purge}` is a signed OPS_COMMAND (bound to the worker id, command id and a ≤ 5 min window).
The worker cannot uninstall itself (its account owns neither the service nor the program files): it checks the
installed helper (`remana-manage-helper/v1` in `remyral-worker-updater.mjs`) and hands the command over through the
**prepare request file** — the same root/SYSTEM trigger as `sandbox.prepare` (Linux `remyral-worker-prepare.path`,
Windows the `RemyralWorkerUpdater` task's `apply`, macOS the updater's WatchPaths), so no new OS unit is needed. The
helper verifies signature (pinned `masterLeaseKeys`, else the keys it fetches from the master itself), window and replay
exactly as for prepare, then:

1. writes `accepted` with the planned steps to `<install>/state/manage-result.json`;
2. starts a detached script built from fixed constants (never from the request): Linux through `systemd-run --collect`
   (the end of the oneshot prepare unit would otherwise kill it), macOS in a new session, Windows a detached
   PowerShell; the script waits 15 s — long enough for the worker to relay `accepted` — and then does what the kit's
   uninstaller does: stop and remove the service, the update / prepare / admin triggers, the program files and the CLI
   wrapper; with `purge` also the config, the data dir with the device key and (Linux / macOS) the service user. A
   custom workspace root outside the data root is kept. It never deletes a directory that is not dedicated (`/`, a
   drive root, a top-level folder → `unsafe_layout`).

The worker relays `accepted` as `succeeded`; refusals (`helper_unavailable`, `helper_outdated` — an older helper answers
with a refused prepare result —, `bad_signature`, `disabled_locally` when `remoteOps.disabled` contains `restart`) and
`helper_timeout`.

**Master.** `POST /workers/:id/remove {purge}` — authz `machines.admin.run` (admin), **always-fresh** step-up (the
machine-admin approval rule: privileged work on a machine), audited `worker.remove.request` (denials too). The request is
stored (`worker_removals`, migration 0168; one open removal per machine), the worker is drained (no new jobs), and the
signed command goes out now — or, for an offline machine, when it next connects (`onWorkerConnected`); until it was sent
it can be cancelled (`DELETE`, step-up). When the helper accepted it (`succeeded`), the master **revokes** the worker as
the requesting admin (every credential, the socket closed; `worker.remove.result` + `worker.revoke`). A refusal or
failure keeps the worker; `GET /workers/:id/remove` shows the outcome and the kit's manual uninstall for the OS, and
"Revoke now" stays in Erişim. Why not revoke first: a revoked worker cannot authenticate, so it could never receive the
uninstall.

## 4. Part 4 — the machine-admin helper and rootless Docker from the panel

- **Helper trigger.** `helper.manage {admin_helper.install | admin_helper.remove}` takes the same path as Part 3. The
  helper writes the kit's **own** units — byte-identical copies of `infra/worker/linux/remyral-worker-admin.{path,service}`
  and `infra/worker/macos/com.remyral.worker.admin.plist` (a test compares them), with `@NODE@` replaced by the Node it
  runs with, as the kits do — and enables them; on Windows it registers `RemyralWorkerAdmin` exactly as install.ps1 does
  (SYSTEM, every minute, 780 min limit). The local veto (`localCeiling.allowMachineAdmin: false`) refuses an install.
  Route `POST /workers/:id/machine-admin/helper` — **owner** (`machines.admin.enable`), always-fresh step-up, audited.
  The broker cannot install itself; the prepare helper is the only privileged component every install has.
- **Rootless Docker.** A machine-admin job with a fixed task of this release (`setup: 'rootless-docker'` on
  `POST /workers/:id/machine-admin/tasks`, admin, always-fresh): the steps follow Docker's rootless guide
  (`docker-ce-rootless-extras`, `uidmap`, ≥ 65 536 subordinate ids, `dockerd-rootless-setuptool.sh install` as the
  worker user, `loginctl enable-linger`); every elevated command goes through the existing per-command approval (or the
  owner's auto-approve). Linux only (`setup_unsupported_os`). The job does not relax the hardened worker unit (an owner
  decision, docs/ops/worker-sandbox.md) and records with `machine_note` what remains.

## 5. Part 5 — cleanups

- **Legacy ACL (Windows).** The privileged updater removes, during its normal run and once per install (marker
  `<install>/state/legacy-acl-cleaned.json`), the allow entry of exactly `NT SERVICE\RemanaWorker` (its service SID,
  `icacls /remove:g`) from the data root, data dir, logs and workspace root. The worker's own account may not change
  ACLs, so it is the updater's job.
- **Disk hygiene and folders it may not delete.** A removal refused with EPERM / EACCES (on Windows the per-job
  accounts' sandbox folders) is skipped quietly and counted (`DiskHygieneRun.skipped`, additive) instead of raising an
  error; the machine page shows the count. Asking the SYSTEM helper to delete them was rejected: a SYSTEM recursive
  delete inside a folder agents can write is a junction / reparse-point risk; the slot controller has no delete path
  either (its accounts' cleanup is the job runner's).

## Verification

- Protocol: `worker-managed.test.ts` (settings bounds, local-only keys refused or stripped, path rules, ops schemas,
  manual commands, the rootless prompt), the full protocol suite.
- Worker: `worker-settings.test.ts` (overlay, pins, floor, telemetry, runtime paths on Linux / macOS / Windows shapes,
  start-time file checks, report and live log level, the updater's narrowing overlay), `worker-manage.test.ts` (helper
  signature / window / replay / worker binding, plan and per-OS scripts, safe-delete guard, admin units byte-identical to
  the kit, local veto, worker relay incl. outdated helper and timeout, legacy ACL), `disk-hygiene.test.ts` (skipped).
- Master integration: `releases.test.ts` (rollback notification, overview fields, retry re-offers), `worker-managed.test.ts`
  (settings delivery, older worker refused, runtime-paths route authz / always-fresh / machine admin / carried / dropped),
  `worker-removal.test.ts` (authz, always-fresh, older worker, signed command, revoke after accept, offline queue and
  cancel, refusal keeps the worker, owner-only helper install, rootless Docker task and OS refusal), route coverage,
  RBAC matrix, OpenAPI, fleet view.
- Web: `machine-update.test.tsx`, `machine-local-settings.test.tsx`, `machine-remove.test.tsx`, `disk-hygiene.test.tsx`.
- **Not verified live:** a real uninstall on Linux (systemd-run from the prepare unit), macOS (launchd killing a
  `setsid` child of the updater job) and Windows (the detached PowerShell outliving the scheduled task; the program
  folder removal while the helper's node.exe exits); the admin trigger install on each OS; the legacy ACL removal on the
  real Windows machine; rootless Docker on a real Debian / Ubuntu host with the hardened unit.

## Rollback

Master: the migrations are additive (an older master ignores the table, the cause and the kinds; it strips `settings`
from stored specs it parses). Worker: the master sends the new keys / ops only to `worker-managed-v1` workers. A machine
rolled back to an older release while its stored generation carries `settings` refuses that document (`hash_mismatch`:
the older build strips the key) and keeps its previous one; the panel shows the refusal and `worker_update_required`,
and removing the settings (or updating the machine again) clears it. The legacy-ACL marker and the uninstall scripts stay
in the install's state dir (harmless).
