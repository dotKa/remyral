# Worker updates — cut, sign, publish, roll out, roll back

Owner guide for signed worker auto-updates (`p2-signed-updates`). Design and security review:
[docs/design/p2-signed-updates.md](../design/p2-signed-updates.md). Installing a worker:
[worker-install.md](worker-install.md).

**In one sentence:** you sign releases offline with your own release key; the master only stores and
offers them; every worker verifies your signature with a key pinned in its build/config, a separate
root-run updater verifies it again, switches versions atomically, health-checks the restart and rolls
back on its own if the new version does not come up.

## 0. Once: create the release key (offline)

```sh
node scripts/release/sign.mjs keygen --out ~/remyral-release-key      # prints the public key + key id
```

- `release-key.pem` (0600) is the **only** thing that can produce an update every worker will run.
  Keep it off the master and off the workers: your own machine, an encrypted offline backup (two
  copies), ideally a hardware-backed vault. It is not the master's lease key and not a device key.
- Give the master the **public** key: `RELEASE_PUBLIC_KEYS=<public key>` in its environment (Coolify
  secret). Restart the master. Without it, uploads are refused with 503.
- Workers get the public key compiled into every release you build (below). For a worker installed from
  a non-release build, pass `--release-public-key <public key>` to the installer.

## 1. Cut and sign a release

```sh
git switch main && git pull && pnpm install && pnpm verify
node scripts/release/sign.mjs build --version 1.2.0 --channel stable --key ~/remyral-release-key/release-key.pem
#   → dist/release/1.2.0/{remyral-worker.mjs, manifest.json, manifest.sig.json, release.json, remyral-worker-updater.mjs}
node scripts/release/sign.mjs verify --dir dist/release/1.2.0 --public-key <public key>
```

- `--version` is a semantic version and must be higher than what runs in the fleet (workers refuse
  downgrades). The version, the supported protocol versions and the minimum Node (24.11.0) are written
  into the signed manifest automatically.
- `--channel canary` for a build that should reach only machines that opted into canary
  (`"updates": {"channel": "canary"}` in their root-owned config). To promote that exact build to stable
  later, re-sign the same bytes — no rebuild:
  `node scripts/release/sign.mjs sign --artifact dist/release/1.3.0-rc.1/remyral-worker.mjs --version 1.3.0-rc.1 --channel stable --key … --out dist/release/1.3.0-rc.1-stable`
  and upload that `release.json` (the master upgrades the release in place).

## 2. Publish

Console → **Settings** → **Worker releases** → **Show releases** → *Upload signed release.json* →
choose `dist/release/1.2.0/release.json` → confirm with your authenticator (step-up).

The master accepts it only if the signature verifies against `RELEASE_PUBLIC_KEYS`, the artifact matches
the manifest, and the build speaks a protocol version the master supports. Each upload — accepted or
refused — is in the audit log (`release.upload`).

**How the console uploads it (chunked, p6-release-upload).** A `release.json` with installer kits is
≈ 13 MB; one request that big trips reverse-proxy/CDN body limits and shows no progress. The console
hashes the file (SHA-256), then sends it in 2 MiB parts with a progress bar: a part that fails on the
network, with a 408/429/5xx or arrives corrupted is retried up to 3 more times (0.5 s, 1.5 s, 4.5 s),
*Cancel upload* drops it, and after a failure *Resume upload* sends only the parts the master lacks. On
success it shows the version the master verified with *Roll out to stable* (100 %; use the rollout form
for a partial rollout). The master assembles the parts, checks the whole-document SHA-256 and then runs
exactly the `POST /releases` verification and storage path — chunking changes transport, not trust.

API (admin = `releases.publish`, full session, CSRF header; all `write` class rate limits):

| Request | Notes |
| --- | --- |
| `POST /releases/uploads` `{totalBytes, sha256, partSize}` | **step-up**. `sha256` = lowercase hex of the whole file; `partSize` 64 KiB–4 MiB (default 4 MiB); `totalBytes` ≤ 48 MiB (the `POST /releases` limit). → `201 {id, partCount, received: [], expiresAt}`. 409 `too_many_uploads` beyond 2 open uploads per user. |
| `PUT /releases/uploads/:id/parts/:n` | Raw bytes, `Content-Type: application/octet-stream`, `X-Part-SHA256: <hex>`; `n` is 0-based; every part is exactly `partSize` except the last. Idempotent (a retry overwrites). 422 `part_checksum_mismatch`, 400 `part_size_mismatch` / `part_out_of_range`. No step-up (it only touches the caller's own pending bytes). |
| `GET /releases/uploads/:id` | `received` part indexes — to resume. |
| `POST /releases/uploads/:id/complete` | **step-up**. 409 `upload_incomplete` (names the missing parts; the upload stays). 422 `checksum_mismatch` / `document_invalid`, or any `POST /releases` refusal (`signature_invalid`, `artifact_mismatch`, …) — audited `release.upload` denied, upload dropped. Success: `201`/`200` with the release, exactly like `POST /releases`. |
| `DELETE /releases/uploads/:id` | Cancel; drops the parts. |

Uploads belong to the admin who started them (others get 404). The parts live in Postgres
(`worker_release_uploads`, `worker_release_upload_parts`, migration 0041) only until complete/cancel; an
upload without a new part for 1 hour expires (410 `upload_expired`) and is swept on the next start and
every 10 minutes. Each part must arrive within the master's 30 s request time limit — 2 MiB needs about
0.6 Mbit/s upstream.

The single-request `POST /releases` with the `release.json` body (admin, step-up) still works for
scripts and small documents.

### Publishing from the host (p6-release-import)

The same release can be published without the browser — e.g. by the operator's assistant, whose browser
automation cannot move a 13 MB file — through the control-plane host:

```sh
node scripts/release/publish.mjs --dir dist/release/1.2.0 --rollout stable:100 --dry-run   # check, print the command
node scripts/release/publish.mjs --dir dist/release/1.2.0 --rollout stable:100             # publish + roll out
#   → {"version":"1.2.0","created":true,"channel":"stable","sha256":"…","rollout":{"channel":"stable","rolloutPercent":100}}
```

- **Who may run it:** anyone with the deploy SSH access (the SSH host alias with sudo that
  `scripts/deploy/deploy.mjs` uses; `--host` / `REMYRAL_DEPLOY_HOST`, `--env staging`). No console login,
  no step-up: host access already outranks an admin session, and the release key — not the channel —
  is what makes a release trusted.
- **Same checks:** `publish.mjs` first verifies `release.json` locally against the release public key
  (`--public-key`, `REMYRAL_RELEASE_PUBLIC_KEYS`, or `~/remyral-release-key/release-key.pub`): manifest
  signature, artifact, installer index signature, its binding to the manifest and every kit. Then it
  streams the file over SSH (stdin; nothing secret on any command line) into
  `sudo docker compose -p remyral-<env> … exec -T master node dist/cli/release-import.js [--rollout …]`
  in the running master container. That CLI runs **exactly** the console's path (`publishRelease`:
  `RELEASE_PUBLIC_KEYS` signature, artifact integrity, protocol, signed installer kits, the 48 MiB
  limit). A tampered, foreign-signed or unsigned document is refused with exit 1 and the reason
  (`release refused (signature_invalid): …`); nothing is stored.
- **Rollout:** `--rollout <stable|canary>[:<percent>]` (default 100 %) runs the same promotion as
  *Roll out* / `PUT /releases/channels/:channel` after a successful import. The running master notices
  a channel changed outside its process within 30 s and offers it to connected workers (`release.promote`
  is audited at once). Without `--rollout` the release is only stored; roll it out in the console.
- **Audited:** `release.upload`, `release.installers.upload` and `release.promote` — accepted or refused —
  with actor `system` / `release-import` (no IP), so a host-side import is distinguishable from a console
  upload (actor `user`) in the audit log. `uploaded_by` of such a release is empty.
- `--dry-run` verifies locally, reads the deploy state (read-only) and prints the exact remote command;
  with `--offline --state-file <file>` it contacts nothing.
- Directly on the host (without the Mac script), the image mode is
  `sudo docker compose … exec -T master remyral-master release:import [--rollout stable:100] < release.json`.

## 3. Roll out

Recommended order:

1. **Canary machine(s):** opt one machine into canary (its config `updates.channel: "canary"`, or the
   API `POST /workers/<id>/update {"channel":"canary"}`), then *Roll out* the release on `canary`
   at 100 %.
2. **Stable, staged:** *Roll out* on `stable` at 10–25 %, watch the attempts table, then raise to 100 %.
   The same workers stay in the rollout when you raise the percentage.

What happens on each selected worker: it receives `UPDATE_AVAILABLE`, downloads over the authenticated
HTTPS endpoint, verifies everything, waits until no job runs (it drains itself meanwhile — shown as
`draining`, then `updating`), and the root updater activates the version, restarts the service and
checks that it connects and heartbeats within `updates.healthTimeoutSec` (default 90 s). The attempts
table shows `downloading → (deferred) → activating → succeeded | rolled_back | failed | refused`.

A single worker: API `POST /workers/<id>/update {"version":"1.2.0"}` pins it to that version (channel
promotions stop applying until you send `{"channel":"stable"}` again). Add `"force": true` only if
running jobs may be cancelled (they are reconciled by the master).

### Rollout circuit breaker (p16-ops-safety)

The master watches every channel rollout. When the machines that took the channel's version fail — update failed /
rolled back / timed out, a crash loop (≥ 4 sessions within the watch window after the update) or a lost heartbeat
within that window — at the policy's threshold (default 30 % of the judged machines, at least 1), or their job failure
rate rises by 30 points over their previous 7 days (at least 5 jobs), the rollout is **held**: no further machine is
offered the version, the percentage cannot be raised (`409 rollout_paused`, also for `release-import --rollout`),
offers not yet installing are withdrawn, admins get `release.rollout_paused`, the hold is audited
(`release.rollout.paused`). Settings → Worker releases → *Devre kesici* shows why and the failing machines:

- **Resume** (step-up): offers continue; failures before the resume are not counted again.
- **Roll back** (step-up): the channel points at the previous version again and every machine on the held version gets
  the explicit rollback below — to the version that machine updated from (the only one it accepts; for a machine that
  skipped the channel's previous version that is its own older version), else the channel's previous version. They
  stay pinned until you send them back to the channel after a fixed release.
- **Pause** by hand: the same hold (reason `manual`).

Thresholds: Settings → Operations safety → *Sürüm devre kesici* (security policy `rollout`, off switch included).
API: `GET /releases/breaker`, `POST /releases/channels/<channel>/{pause,resume,rollback}`.

## 4. Roll back

- **Automatic:** a version that does not come up healthy is rolled back by the updater on that
  machine (`rolled_back: health_check_failed`) and is not offered to it again.
- **Settings → Worker releases:** *Roll out* the previous release on the channel. Channels never downgrade anybody, so also
  send each updated worker an explicit rollback: `POST /workers/<id>/update {"version":"1.1.0","rollback":true}`
  (admin, step-up, audited). Workers accept a lower version only with this flag, and only the version they ran
  before and still keep under `versions/` (the updater's recorded previous version, with the same bytes): an
  explicit rollback to any other older release is refused `rollback_not_retained`. A machine that skipped the version
  you roll back to keeps its own previous version as the only rollback target: send it that version (the one it
  ran before the update; the breaker's *Roll back* does this by itself), or use the on-machine rollback below.
- **On the machine** (no master needed): `sudo node /opt/remyral-worker/remyral-worker-updater.mjs rollback`
  (macOS: `…/RemyralWorker/bin/remyral-worker-updater.mjs`, Windows: `%ProgramFiles%\RemyralWorker\…`)
  switches back to the previous retained version and restarts; `--to <version>` for another retained one (this local,
  root-only command is not limited to the previous version).
- **Floor:** after a security fix, set `"updates": {"minVersion": "1.2.0"}` in each worker's config —
  nothing below it is ever activated again, not even as a rollback.

## 5. Check a machine

```sh
sudo node /opt/remyral-worker/remyral-worker-updater.mjs status     # active version, retained, last outcome
journalctl -u remyral-worker-update                                 # Linux updater log
tail /Library/Logs/RemyralWorker/remyral-worker-updater.log          # macOS
Get-ScheduledTaskInfo RemyralWorkerUpdater                          # Windows
# p6-worker-boot-diagnostics (updater installed from 1.0.23 on): the updater's own log on every OS
tail <installDir>/state/updater.log            # Windows: %ProgramFiles%\RemyralWorker\state\updater.log
# the boot log of the worker (start / ready / fatal / early-exit records, written before worker.log exists)
tail <dataDir>/logs/boot.log                   # Windows: %ProgramData%\RemyralWorker\data\logs\boot.log
```

Without a shell (worker ≥ 1.0.23): Machines → <machine> → Activity → **Worker logs** → *Log: Boot* or *Updater*, and
Settings → **Worker releases** → a `rolled_back` / `failed` attempt → **Why?** (the evidence below).

Failure reasons you may see: `bad_signature` / `unknown_key` (not signed by a trusted key — investigate
the master), `sha256_mismatch` / `size_mismatch` (artifact altered), `downgrade_refused`,
`below_minimum_version`, `channel_not_allowed`, `protocol_incompatible`, `node_too_old` (upgrade Node
first), `updater_unavailable` (updater not installed: re-run the installer with
`remyral-worker-updater.mjs` next to the bundle), `updater_busy`, `health_check_failed`.

## 6. Rotate the release key

After step 5 record the rotation (it restarts the key's age in Settings → Operations safety → Keys and expiry):
`remyral-master secrets:rotated signing:release-key` in the master container, or the *Yenilendi* button.

1. `sign.mjs keygen --out ~/remyral-release-key-2`.
2. Master: `RELEASE_PUBLIC_KEYS=<old>,<new>`.
3. Build the next release with the old key, pinning both: `sign.mjs build … --key old.pem --also-trust <new public key>`; roll it out everywhere.
4. Re-run the installer on each machine (updates the root updater, which is never auto-updated) **or**
   set `"updates": {"releaseKeys": ["<old>", "<new>"]}` in its config.
5. From now on sign with the new key; later drop the old key from the master and the configs.

If the release key is **lost**: install a new key as in step 4 on each machine (root access needed).
If it is **stolen**: remove it from `RELEASE_PUBLIC_KEYS` immediately, set `updates.releaseKeys` to a
new key and `updates.minVersion` on every machine, and audit `release.upload` events.

## 7. Things that are not auto-updated

The root updater (`remyral-worker-updater.mjs`), Node itself and the service definitions change only when
you re-run the installer (`sudo ./install.sh --bundle … --manifest … --signature …`). This keeps every
change to root-run code a deliberate step on the machine.

## 8. Incident 2026-10-16: 1.0.22 rolled back on Windows without a log line

**What happened.** 09:00 UTC: the updater staged and activated 1.0.22 (built from `b3a1f87`) on the owner's
Windows 11 worker (`NT SERVICE\RemyralWorker`, shawl, Node 24.21.0) and rolled it back with
`health_check_failed`. `worker.log` has no line from 1.0.22: 1.0.21 `worker daemon stopped` at 09:01:02, then
1.0.21 `config loaded` at 09:02:53 after the rollback. `worker.log` only exists once the config is loaded, the
updater's own output on Windows went to a scheduled task's discarded stderr, and nobody had a shell on the machine —
so there was no evidence at all. The same bundle boots on macOS.

**What the analysis found** ([design note §1](../design/p6-worker-boot-diagnostics.md#1-problem-and-what-the-analysis-found)):
nothing that changed between 1.0.21 (`d31eef5`) and 1.0.22 runs before `config loaded`, no new module-level code
is platform-dependent, and both bundles boot identically under a simulated Windows host. The most likely cause is a
restart race in the updater (now fixed): `net.exe stop` exits 2 also when it gives up on a service that is still
stopping, the updater took that for "not started" and its immediate `net start` failed — 1.0.22 never ran. Other
candidates (the new bundle file unreadable for Node, e.g. an AV scan; a machine-specific crash or hang before the
config loaded) are recorded from 1.0.23 on. **Not confirmed** (no machine access).

**What changed (1.0.23, p6-worker-boot-diagnostics).**

- `<dataDir>/logs/boot.log`: the worker records `start`, `ready`, `fatal` (stage, redacted stack) and non-zero
  `exit` (with the stderr before the logger existed) from its first module on.
- `<installDir>/state/updater.log`: the updater's own log on every OS.
- On a failed health check the updater collects, **before** switching back: the boot verdict and the failed
  version's boot records, the service manager's capture of its stdout/stderr (Windows: shawl's
  `remyral-worker_rCURRENT.log` and `shawl_rCURRENT.log` under `%ProgramData%\RemyralWorker\logs`), its own log and
  the restart errors; the daemon sends them with the attempt's `UPDATE_STATUS` (or collects them itself next to an
  older updater). The panel shows them under **Why?**.
- Windows restart: after `net stop` the updater waits for `STOPPED` before `net start`, and retries a failed start
  once; a daemon whose handles linger after the stop exits after 10 s instead of running into shawl's stop timeout.

**How to diagnose now.**

| Verdict (Why?) | Meaning | Next step |
| --- | --- | --- |
| `never_started` + a `net.exe start` restart error | the service could not be started (restart race / SCM) | re-run the installer (updated updater); retry the update |
| `never_started`, no restart error | the service ran but Node did not run the new file | read *Service output* (Node's own error); check AV exclusions for `%ProgramFiles%\RemyralWorker` |
| `crashed` | the new version threw during start-up | the fatal record has the stage (`module-load` / `startup`) and the stack: fix, cut a new release |
| `exited` | start-up error exit (e.g. 78 configuration) | the record's `stderr` names the problem |
| `hung_before_ready` | started, never loaded its config | Service output; updater log for how the stop/restart went |
| `started` | loaded its config but did not connect and heartbeat in 90 s | Worker log of that time (network / master / pairing) |
| `no_boot_log` | the restored version predates 1.0.23 | as below |

For the 1.0.22 attempt itself (workers still on 1.0.21) the evidence is only on the machine: if machine
administration is enabled for that worker, a read-only machine-admin job (or anyone at the machine) can read
`Get-Content "$env:ProgramData\RemyralWorker\logs\remyral-worker_rCURRENT.log" -Tail 200`, the same for
`shawl_rCURRENT.log`, the System event log entries of the Service Control Manager around 09:00–09:03 UTC
(`Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'; StartTime=…}`), and
`node "$env:ProgramFiles\RemyralWorker\remyral-worker-updater.mjs" status`.

**Deploy order.** Master first (migration 0056, knows `logs-source-v1`), then worker release 1.0.23 to the fleet,
then re-run the installer on each machine (Windows first) so the updater gets its log file, the evidence collection
and the restart fix — the updater is never auto-updated (§7). Then retry the Windows update.

