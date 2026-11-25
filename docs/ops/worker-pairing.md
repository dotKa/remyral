# Pairing a worker machine

How an owner or admin connects a machine to the master. The worker only ever connects **outbound** (`wss://<master>/v1/worker`); nothing has to be opened on the router. Design and security review: [docs/design/p2-transport.md](../design/p2-transport.md).

## 1. Install — Machines → **Add machine** (recommended)

Everything the machine needs comes from the panel; Node.js 24 is installed automatically when it is missing. Design and security review: [docs/design/p5-worker-onboarding.md](../design/p5-worker-onboarding.md).

1. In the console open **Machines → Add machine** (owner/admin) and pick the system: Linux x64, Linux arm64 / Raspberry Pi (64-bit Raspberry Pi OS only), macOS Apple silicon / Intel, Windows x64.
2. Copy the two lines to the machine and run them — in a terminal (Linux/macOS) or in **PowerShell opened as Administrator** (Windows). Example for Linux:

   ```sh
   curl -fsSL --proto '=https' --tlsv1.2 -o remyral-bootstrap.sh 'https://<master>/v1/worker/install/<version>/linux/bootstrap.sh' && echo '<sha256>  remyral-bootstrap.sh' | sha256sum -c -
   sudo sh remyral-bootstrap.sh
   ```

   The first line stops unless the script is exactly the one the console describes. The script downloads the installer kit, refuses it unless its SHA-256 matches the release-key-signed installer index, keeps it in the program directory and runs its installer, which
   - checks every kit file against `SHA256SUMS` and installs the **signed** worker release through the updater (release signature verified again);
   - uses a system-wide, root-owned Node 24 if there is one; otherwise downloads the pinned Node (`infra/worker/node/pin.env`) from nodejs.org, checks `SHASUMS256.txt` against its pinned hash and — where `gpgv` exists (Debian, Ubuntu, Raspberry Pi OS) — its OpenPGP signature against the vendored Node release keys, checks the archive hash and installs it **privately** (`/opt/remyral-worker/node`, `/Library/Application Support/RemyralWorker/node`, `%ProgramFiles%\RemyralWorker\node`). The system Node, PATH and other users are not touched;
   - creates the service account and service, writes the minimal config (`masterUrl` + `workspaceRoot`) and starts the worker;
   - prints the **pairing code** and **fingerprint**. Continue with §3.
3. **Without internet access to the master's install URLs** (or with `INSTALLER_PUBLIC_DOWNLOADS=false`): press **Download installer bundle**, copy the file to the machine, check its SHA-256 (shown in the console) and run the three lines shown under the button (`tar -xzf …` / `Expand-Archive …`, then `install.sh --master-url …` / `install.ps1 -MasterUrl …`). Offline verification with your own copy of the release public key: `node scripts/release/sign.mjs verify-installers --dir <dir with index.json, index.sig.json and the kit> --public-key <key>` (index files: `https://<master>/v1/worker/install/<version>/index.json` and `index.sig.json`).
4. **Re-run = repair/upgrade.** Running the commands of a newer release again upgrades the bundle, the updater and (if the pin changed) the private Node; the config and the device key are kept. Extra installer options can be appended to the run line, e.g. `sudo sh remyral-bootstrap.sh --no-start`, `--private-node` (always use the pinned Node), `--node /path/to/node`, `--node-dist-url https://mirror/…` (hashes stay pinned).

Troubleshooting: *"no worker release with installer kits"* → build kits for the release dir that was uploaded (`node scripts/release/sign.mjs installers --dir dist/release/<version> --key <release-key.pem>`) and upload `release.json` again (Settings → Worker releases); *"PUBLIC_ORIGIN is not configured"* → set `PUBLIC_ORIGIN=https://<console host>` on the master (the Coolify compose sets it from `REMYRAL_DOMAIN`); *"installer kit SHA-256 mismatch"* → do not run anything, download again from the console; *"SHASUMS256.txt … refusing"* / *"signature does NOT verify"* → the Node download was tampered with or the mirror is wrong.

## 1b. Install by hand (development, or without the console)

1. Install Node.js 24 (see [worker-probe.md §2](worker-probe.md#2-install-nodejs-24-lts)).
2. Build the single-file worker on a dev machine and copy it over (check the SHA-256 on the node):

   ```sh
   pnpm --filter @remyral/worker bundle      # → apps/worker/dist/remyral-worker.mjs
   shasum -a 256 apps/worker/dist/remyral-worker.mjs
   ```

3. Create the config file (the worker refuses world-writable or foreign-owned config files):

   | OS | Path (service install) | Path (per user) |
   |---|---|---|
   | Linux / Raspberry Pi | `/etc/remyral-worker/config.json` | `$XDG_CONFIG_HOME/remyral-worker/config.json` |
   | macOS | `/Library/Application Support/RemyralWorker/config.json` | `~/Library/Application Support/RemyralWorker/config.json` |
   | Windows | `%ProgramData%\RemyralWorker\config.json` | — |

   ```json
   {
     "masterUrl": "wss://master.example.com",
     "workspaceRoot": "/srv/remyral/workspaces"
   }
   ```

   `masterUrl` must be `wss://`; `ws://` is accepted only for `127.0.0.1` / `localhost` / `[::1]` (local development). `chmod 600` the file on Linux/macOS.

   That is all the local file needs (ADR-0015): **projects, runtimes, parallelism, sandbox profiles, runtime auth and labels are set in the panel** (§4a), not on the machine. The file keeps only what the worker needs to connect and prove its identity (`masterUrl`, `workspaceRoot`/`dataDir`, keystore, update and skills trust keys, optional `masterLeaseKeys`, telemetry, secret store) plus machine-local facts a panel must never choose (runtime executable paths, Pi extension files, sandbox runner settings). An optional **local ceiling** pins a machine at install time (§4b).

## 2. Pair

On the machine:

```sh
node remyral-worker.mjs pair            # uses masterUrl from the config
# or explicitly: node remyral-worker.mjs pair --master wss://master.example.com
```

It prints, for example:

```
Pairing with wss://master.example.com

  Pairing code: K7QX-M2PD
  Fingerprint:  SHA256:21FE-31DF-A154-A261-626B-F854-046F-D227-1B7B-ED4B-6ABE-45AA-5887-7EF4-7F97-21B9

In the console open Machines, check that the fingerprint of the pending worker matches the one
above, enter the pairing code and approve. The request expires after 10 minutes.

Waiting for approval (request expires 2026-10-13T10:10:00.000Z) …
```

The first run generates the device key (`<dataDir>/device-key.json`, mode 0600). The private key never leaves the machine; only the public key goes to the master.

## 3. Approve in the console

1. Sign in (password + authenticator code) and open **Machines**. The machine is listed under **Waiting to pair** with host name, platform and fingerprint.
2. **Compare the fingerprint** character by character with the one on the machine's screen. If it differs, press **Deny** — someone else is trying to enroll.
3. Type the **pairing code** shown on the machine and press **Approve**. The console asks for a fresh authenticator code (step-up) if the last one is older than 10 minutes.
4. The machine prints `Approved: this machine is worker wrk_…` and exits 0.

Rules enforced by the master: a code works once and for 10 minutes; 5 wrong codes deny the enrollment; at most 5 pairing requests per IP per 10 minutes and 20 pending requests in total. Approve/deny/connect events are in the audit log (`worker.pairing.request`, `worker.approve`, `worker.deny`, `worker.session.start`).

Equivalent REST calls (full session cookie + `X-CSRF-Token`, step-up within 10 minutes): `GET /workers`, `POST /workers/<id>/approve {"pairingCode":"K7QX-M2PD"}`, `POST /workers/<id>/deny`.

## 4. Run

```sh
node remyral-worker.mjs run
```

The daemon authenticates with its device key (challenge-response), shows **online** in Machines, reports its capabilities and heartbeats, and reconnects by itself (exponential backoff) after network loss or master restarts. Logs are JSON lines on stderr.

Running it as an OS service (systemd / launchd / Windows Service) with automatic start after reboot is covered by the service-installer tasks (`p2-service-linux`, `p2-service-macos`, `p2-service-windows`); until then run it in a terminal multiplexer or a user session.

## 4a. Configure the worker from the panel (ADR-0015)

Open **Machines → <machine> → Configuration** (admin; every save asks for a fresh authenticator code):

- **Projects** — tick the projects this machine may run. Only projects with a registered repository can be ticked (**Projects → project → Repository**, i.e. `PUT /projects/:id/git`); the worker receives that repository URL, never a free-text one. You can also assign machines from the project side (**Projects → project → Workers**).
- **Runtimes**, **max parallel jobs** (0 = take no jobs), **sandbox profiles**, **runtime auth** per runtime (`local-login` = the runtime's own login on the machine, ADR-0014; or a **worker-store secret name** created with `remyral-worker secret set <name>` — never the secret value), default **model profile**, **workspace** options and **labels**.
- **Save** creates a new *generation*. The master signs it and sends it to the online worker, which re-validates it, applies it **without a restart** and reports back. The tab shows *applied* / *pending* / *rejected* with the reason, the applied vs desired generation, drift (anything the worker's local ceiling blocks) and the **history** with **Roll back**.
- **Machines → Bulk change** applies one change (add/remove a project, runtimes, parallelism, labels) to several workers at once.

An existing worker whose local file still lists `workspace.projects`, `allowedRuntimes` or `maxParallelJobs` keeps running exactly as before (*Unmanaged — local file*) until you press **Take over from local file**, which pre-fills the editor with what the worker runs today (registered projects only). Every change is audited (`worker.config.update`, `worker.config.rejected`) and owners/admins get a *Worker configuration* notification.

REST: `GET|PUT /workers/<id>/config`, `GET /workers/<id>/config/history`, `POST /workers/<id>/config/rollback`, `POST /workers/config/bulk`, `GET|PUT /projects/<id>/workers` (admin, step-up, CSRF on writes; actions `workers.config.read|write`, `projects.workers.read|write`).

## 4b. Optional: pin a machine with a local ceiling

For a machine you want hard-limited whatever the panel says, add `localCeiling` to its config file at install time:

```json
{
  "masterUrl": "wss://master.example.com",
  "workspaceRoot": "/srv/remyral/workspaces",
  "localCeiling": {
    "repoHosts": ["github.com"],
    "allowedRuntimes": ["claude-code", "codex"],
    "maxParallelJobs": 2,
    "sandboxProfiles": ["container"]
  }
}
```

`projects` (project → repository URLs), `repoHosts` (`host` or `*.suffix`), `allowedRuntimes`, `maxParallelJobs` and `sandboxProfiles` are all optional. **The ceiling always wins**: the worker runs *panel ∩ ceiling* and reports everything it blocked (`blocked_by_local_ceiling`), which the Configuration tab and job placement show. Legacy keys keep their meaning as ceiling/pins: a non-empty `workspace.projects` is the projects ceiling, a non-empty `allowedRuntimes` the runtime ceiling, a written `maxParallelJobs` the parallelism ceiling; `runtimeAuth.<runtime>` and a `model`/`provider`/`config` in `runtimes.<runtime>` pin that runtime's auth/settings; `workspace.minFreeBytes` is a floor. Remove those keys (and restart the service once) to let the panel manage the machine fully.

## 5. Drain, rotate, revoke

In **Machines**, open a machine:

- **Drain** — the worker finishes running jobs and accepts no new ones; the intent survives reconnects.
- **Rotate key** — the online worker generates a new device key, signs the change with old and new key and reconnects with the new one. With `WORKER_ROTATION_REQUIRES_APPROVAL=true` on the master (default; Ayarlar → Sunucu ayarları → Oturumlar overrides it) the new key waits until you press **Approve new key**. The key list shows `active`, `pending`, `superseded` and `revoked` keys.
- **Revoke** — press it twice, confirm with your authenticator: the worker's connection is closed within a second, it is quarantined, and its key is never accepted again (not even for re-pairing). To bring the machine back, delete `<dataDir>/device-key.json` on it and pair it again as a new worker.

REST: `POST /workers/<id>/drain`, `/rotate` (202), `/approve-rotation`, `/revoke` — all with step-up. Audit actions: `worker.drain`, `worker.rotate.request`, `worker.rotate`, `worker.rotate.approve`, `worker.revoke`.

## 6. Removing a worker

A denied enrollment, a worker that failed pairing and a revoked worker stay **quarantined** forever — their key is never accepted again — so they would sit in the Machines list as "never seen". Remove them from the list instead:

1. In **Machines**, open the machine, go to its **Admin** tab and press **Remove from list**, then **Confirm remove**, and confirm with your authenticator (step-up).
2. The worker disappears from the list, the overview, placement and the offline alerts. Nothing is deleted: the worker's row, its device keys and the whole audit trail stay, and its key stays refused (a new `pair` from the same machine still gets `Enrollment denied` / `revoked`).
3. Tick **Show archived** below the list to see removed workers; open one and press **Unarchive** to put it back.

Only a worker that can never work again can be removed: quarantined (denied, too many wrong codes, revoked) or offline with no active/pending key, not connected, without a job lease or a running job. A still-enrolled worker is refused (`409 not_archivable`) — **Revoke** it first; a pending enrollment must be **Denied** first; a worker that still holds work answers `409 has_work` until the job is reconciled.

REST: `POST /workers/<id>/archive`, `POST /workers/<id>/unarchive` (admin, step-up, CSRF; action `workers.archive`), `GET /workers?archived=1`. Audit actions: `worker.archive`, `worker.unarchive`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ws:// is only allowed for 127.0.0.1, localhost or [::1]` (exit 78) | Use `wss://` for a remote master. |
| `master refused the upgrade with HTTP 429` in the log | Too many connection attempts from this IP; the worker backs off automatically. |
| `The master refused the pairing request: pairing code already used` | Run `pair` again — every run uses a new code. |
| `Enrollment denied` (exit 1) | An admin denied this key; it will never be accepted. Delete `<dataDir>/device-key.json` and pair again only if that was a mistake. |
| Worker shows **quarantined** | Denied, too many wrong codes, or revoked. Re-pairing needs a new key (see above). To clean up the list, **Remove from list** (§6). |
| Log: `this device key was superseded and no rotated key is available` | The master activated a rotated key this machine does not have (or someone else rotated it). Revoke the worker in the console and pair the machine again. |
| `stored enrollment does not match the device key` | The key file was replaced; the worker clears the enrollment and must be paired again. |
| Configuration tab: **rejected** `bad_signature` / `unsigned` | The worker pins `masterLeaseKeys` that do not include the master's current lease key: update the pin in the local file (or remove it) and restart the worker. |
| Configuration tab: **pending** for a long time | The worker is offline or runs a build without `worker-config-v1` (status *unsupported*): update the worker. |
| Jobs wait with `project_not_assigned` / `repo_not_registered` / `blocked_by_local_ceiling` | Assign the project to the worker, register the project's repository, or widen the machine's local ceiling. |
