# Installing a worker as an OS service

This guide turns a machine into a Remyral worker that starts at boot, restarts after a crash and runs as its own low-privilege account. Design and security review: [docs/design/p2-service-install.md](../design/p2-service-install.md).

What you need on every OS:

- **Node.js 24**, installed system-wide (not nvm, not a per-user Homebrew): Linux NodeSource/apt or the nodejs.org tarball under `/usr/local`; macOS the nodejs.org `.pkg`; Windows the nodejs.org `.msi`. The installers refuse a Node binary that a normal user could replace.
- The worker bundle `remyral-worker.mjs` and the `infra/worker/<os>/` folder of the repository. Build it once on a dev machine and note its SHA-256:

  ```sh
  pnpm install --frozen-lockfile && pnpm --filter @remyral/worker bundle
  shasum -a 256 apps/worker/dist/remyral-worker.mjs
  ```

- The master URL, `wss://<master-host>/v1/worker`.

**Signed releases (recommended, p2-signed-updates):** install from a release directory made by `scripts/release/sign.mjs build` and pass its manifest and signature instead of `--bundle-sha256` — `--manifest manifest.json --signature manifest.sig.json` (Windows: `-Manifest`/`-Signature`). The bundle is then verified against your release key and installed through the privileged updater `remyral-worker-updater.mjs` (taken from next to the bundle, or `--updater`), which is also set up to apply automatic updates (systemd path unit `remyral-worker-update.path`, LaunchDaemon `com.remyral.worker.updater`, scheduled task `RemyralWorkerUpdater`). Cutting, publishing, rolling out and rolling back releases: [worker-updates.md](worker-updates.md).

Every installer is safe to run again (it only changes what differs) and has a dry-run mode that prints every action without changing anything — run that first. Pairing (approving the new worker in the dashboard and comparing its fingerprint) is described in [worker-pairing.md](worker-pairing.md).

## Linux (x64 / arm64, Raspberry Pi OS 64-bit)

Requires systemd. On a Raspberry Pi use the **64-bit** Raspberry Pi OS (`uname -m` → `aarch64`).

### Install

```sh
cd infra/worker/linux
./install.sh --dry-run --bundle /path/to/remyral-worker.mjs --master-url wss://master.example.com/v1/worker
sudo ./install.sh --bundle /path/to/remyral-worker.mjs --bundle-sha256 <sha256> \
     --master-url wss://master.example.com/v1/worker
```

Options: `--workspace-root DIR` (default `/var/lib/remyral-worker/workspaces`), `--max-parallel-jobs N`, `--node PATH`, `--no-start`, `--replace-config`. The installer creates:

| What | Where | Owner / mode |
|---|---|---|
| Service account | `remyral-worker` (system user, no login shell, locked password) | — |
| Program | `/opt/remyral-worker/remyral-worker.mjs`, CLI `/usr/local/bin/remyral-worker` | root, read-only for the worker |
| Config | `/etc/remyral-worker/config.json` | `root:remyral-worker 0640` |
| State, device key, home, workspaces | `/var/lib/remyral-worker` | `remyral-worker 0700` |
| Service | `/etc/systemd/system/remyral-worker.service` (hardened, restart on failure) | root |

An existing config is never overwritten; edit it (`sudoedit /etc/remyral-worker/config.json`) and run `sudo systemctl restart remyral-worker`, or re-run with `--replace-config`.

### Pair

```sh
journalctl -u remyral-worker | grep pairingCode        # pairing code + fingerprint
sudo -u remyral-worker remyral-worker identity show --data-dir /var/lib/remyral-worker
```

Always run `identity show` **as `remyral-worker`**: run as root it would create a root-owned key that the service then refuses. Approve in the dashboard after comparing the fingerprint ([worker-pairing.md](worker-pairing.md)).

### Start, stop, status, logs

```sh
remyral-worker service status          # service + worker state + store summary (sudo for full detail)
sudo systemctl stop remyral-worker     # graceful: running jobs are cancelled, up to 60 s
sudo systemctl start remyral-worker
sudo systemctl restart remyral-worker
journalctl -u remyral-worker -f        # JSON lines, secrets redacted
```

`service status` exit codes: 0 running, 3 installed but stopped, 4 not installed. The service restarts automatically after a crash (5 s, growing to 5 min on systemd ≥ 254 while it keeps crashing). It does **not** restart after exit code 78 — that means the config, a file permission or the keystore is wrong; the journal says what to fix, then `sudo systemctl restart remyral-worker`.

### Optional: container profile (rootless Docker or Podman)

The service itself runs without any privileges, so it cannot start a rootless container engine. If this worker should offer the `container` profile, run the engine as a separate user service of `remyral-worker` (never the root Docker socket):

```sh
sudo loginctl enable-linger remyral-worker
sudo -u remyral-worker -H XDG_RUNTIME_DIR=/run/user/$(id -u remyral-worker) \
     dockerd-rootless-setuptool.sh install        # or: systemctl --user enable --now podman.socket
```

and point the worker at its socket with a drop-in (`sudo systemctl edit remyral-worker`):

```ini
[Service]
Environment=DOCKER_HOST=unix:///run/user/<uid>/docker.sock
ReadWritePaths=/run/user/<uid>
```

This step is optional and not done by the installer; `remyral-worker probe` shows whether the profile is available.

### Uninstall

```sh
sudo ./uninstall.sh --dry-run
sudo ./uninstall.sh            # keeps config, device key, state, workspaces and the account
sudo ./uninstall.sh --purge    # removes everything — then revoke the worker in the dashboard
```

A plain uninstall followed by a new install resumes with the same identity (no re-pairing).

## macOS (Apple silicon / Intel)

Install Node 24 with the official `.pkg` from <https://nodejs.org/dist/latest-v24.x/> (it installs a root-owned `/usr/local/bin/node`). Homebrew's Node belongs to your user account and is refused, because anyone who can replace it could run code as the worker.

### Install

```sh
cd infra/worker/macos
./install.sh --dry-run --bundle /path/to/remyral-worker.mjs --master-url wss://master.example.com/v1/worker
sudo ./install.sh --bundle /path/to/remyral-worker.mjs --bundle-sha256 <sha256> \
     --master-url wss://master.example.com/v1/worker
```

Same options as on Linux. The installer creates:

| What | Where | Owner / mode |
|---|---|---|
| Service account | `_remyralworker` (hidden, no shell, no password, id 400–499) | — |
| Program | `/Library/Application Support/RemyralWorker/bin/remyral-worker.mjs`, CLI `/usr/local/bin/remyral-worker` | root, read-only for the worker |
| Config | `/Library/Application Support/RemyralWorker/config.json` | `root:_remyralworker 0640` |
| State, device key, home, workspaces | `/Library/Application Support/RemyralWorker/data` | `_remyralworker 0700` |
| Logs | `/Library/Logs/RemyralWorker/remyral-worker.log` | `_remyralworker:admin 0640` |
| LaunchDaemon | `/Library/LaunchDaemons/com.remyral.worker.plist` | root |

The worker account cannot read your home folder or your keychain. It starts at boot (no login needed) and is restarted 10 s after a crash.

### Pair

```sh
grep pairingCode /Library/Logs/RemyralWorker/remyral-worker.log
sudo -u _remyralworker remyral-worker identity show --data-dir "/Library/Application Support/RemyralWorker/data"
```

Then approve it in the dashboard ([worker-pairing.md](worker-pairing.md)).

### Start, stop, status, logs

```sh
sudo remyral-worker service status
sudo launchctl kill SIGTERM system/com.remyral.worker      # graceful stop; stays stopped
sudo launchctl kickstart -k system/com.remyral.worker      # (re)start
tail -f /Library/Logs/RemyralWorker/remyral-worker.log
```

Unlike systemd, launchd cannot tell a configuration error apart from a crash: if the log repeats an error every 10 s (exit code 78 in `service status`), fix the config or permission it names; the next retry picks it up.

### Uninstall

```sh
sudo ./uninstall.sh --dry-run
sudo ./uninstall.sh            # keeps config, device key, state, workspaces, logs and the account
sudo ./uninstall.sh --purge    # removes everything — then revoke the worker in the dashboard
```

## Windows 10 / 11

Install Node 24 with the official `.msi` from <https://nodejs.org/dist/latest-v24.x/> **for all users** (it goes to `C:\Program Files\nodejs`). A per-user install (under `C:\Users\…`, nvm-windows) is refused. Run everything below in an **elevated** PowerShell ("Run as administrator").

The installer downloads the service wrapper [shawl](https://github.com/mtkennerly/shawl) v1.9.0 from GitHub and checks its SHA-256 before using it. On a machine without internet access, download `shawl-v1.9.0-win64.zip` elsewhere and pass `-ShawlZip <path>`.

### Install

```powershell
cd infra\worker\windows
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun -Bundle C:\Downloads\remyral-worker.mjs -MasterUrl wss://master.example.com/v1/worker
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Bundle C:\Downloads\remyral-worker.mjs -BundleSha256 <sha256> `
    -MasterUrl wss://master.example.com/v1/worker
```

Options: `-WorkspaceRoot D:\RemyralWork`, `-MaxParallelJobs N`, `-Node <path>`, `-NoStart`, `-ReplaceConfig`. The installer creates:

| What | Where | Access |
|---|---|---|
| Service | `RemyralWorker` ("Remyral Worker"), automatic (delayed) start, restarts on failure | runs as the virtual account `NT SERVICE\RemyralWorker` (no password, cannot log on) |
| Program | `C:\Program Files\RemyralWorker\` (`remyral-worker.mjs`, `shawl.exe`, `remyral-worker.cmd`) | Administrators write, users read |
| Config | `C:\ProgramData\RemyralWorker\config.json` | Administrators/SYSTEM; the service can only read it |
| State, device key | `C:\ProgramData\RemyralWorker\data` | Administrators/SYSTEM + the service account only |
| Workspaces | `C:\ProgramData\RemyralWorker\workspaces` | same |
| Logs | `C:\ProgramData\RemyralWorker\logs` | same |

### Pair

```powershell
Select-String pairingCode C:\ProgramData\RemyralWorker\logs\remyral-worker_rCURRENT.log
```

The log line contains the pairing code and the fingerprint; approve the worker in the dashboard after comparing them ([worker-pairing.md](worker-pairing.md)). `& "C:\Program Files\RemyralWorker\remyral-worker.cmd" identity show` (elevated) prints the same fingerprint.

### Start, stop, status, logs

```powershell
& "C:\Program Files\RemyralWorker\remyral-worker.cmd" service status
Stop-Service RemyralWorker        # graceful: running jobs are cancelled (up to 60 s)
Start-Service RemyralWorker
Restart-Service RemyralWorker
Get-Content C:\ProgramData\RemyralWorker\logs\remyral-worker_rCURRENT.log -Wait -Tail 50
Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager' } -MaxEvents 20 |
    Where-Object Message -match 'Remyral'
```

The worker restarts 10 s after a crash; if the wrapper itself dies, Windows restarts the service (10 s, 30 s, 60 s). It stays stopped after exit code 78 — a configuration or permission problem described in the log; fix it and `Start-Service RemyralWorker`.

### Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1          # keeps C:\ProgramData\RemyralWorker
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge   # removes it — then revoke the worker in the dashboard
```
