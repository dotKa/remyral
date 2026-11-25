# Worker probe: inventory a node

`remyral-worker probe` inventories one machine: host facts, tools (git, Docker/Podman, Python, Node, bubblewrap, WSL, uv), the five agent runtimes with their versions compared to the pins (ADR-0012), and the ADR-0007 sandbox profiles the host could offer. Its JSON report replaces the manual node inventory (`p0-inventory`) and is the input for `p0-compat-handson`.

The probe is read-only. It never reads credential files, never prints environment values, and makes no network calls except to `127.0.0.1` during the optional self-test. Design: [docs/design/p0-worker-probe.md](../design/p0-worker-probe.md).

## 1. Build the file (once, on a dev machine)

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @remyral/worker bundle        # → apps/worker/dist/remyral-worker.mjs
shasum -a 256 apps/worker/dist/remyral-worker.mjs
```

Copy `remyral-worker.mjs` to each node (scp, USB stick, shared folder). It is a single self-contained file; only Node.js 24 is needed. Check the SHA-256 on the node before running it (`shasum -a 256 remyral-worker.mjs`, or `Get-FileHash remyral-worker.mjs` in PowerShell).

## 2. Install Node.js 24 LTS

Use Node **24.x** (ADR-0002). Check with `node --version`; the probe reports `host.node_too_old` for anything older.

### macOS (arm64 / x64)

Either the official installer from <https://nodejs.org/dist/latest-v24.x/> (`node-v24.*.pkg`), or Homebrew:

```sh
brew install node@24
echo 'export PATH="$(brew --prefix node@24)/bin:$PATH"' >> ~/.zprofile && exec zsh -l
node --version
```

### Windows (PowerShell)

Download and run the x64 MSI `node-v24.*-x64.msi` from <https://nodejs.org/dist/latest-v24.x/>, then open a **new** PowerShell window:

```powershell
node --version
```

### Linux x64 (Debian/Ubuntu/Fedora, any distro)

Official binary tarball, checksum-verified:

```sh
cd /tmp
V=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o 'node-v24[^ ]*-linux-x64.tar.xz' | head -1)
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$V"
curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep " $V\$" | sha256sum -c -
sudo mkdir -p /opt/node24 && sudo tar -xJf "$V" -C /opt/node24 --strip-components=1
echo 'export PATH=/opt/node24/bin:$PATH' >> ~/.profile && . ~/.profile
node --version
```

### Raspberry Pi OS (64-bit)

The Pi must run the **64-bit** OS; no runtime supports 32-bit (compat/README.md §3). A 64-bit kernel with a 32-bit userland is a common trap, so check all three:

```sh
uname -m                     # aarch64
getconf LONG_BIT             # 64   (userland)
dpkg --print-architecture    # arm64
```

If any of them says `armv7l`, `32` or `armhf`, reinstall with "Raspberry Pi OS (64-bit)" before going on. Then install Node exactly as for Linux x64 above, with `linux-arm64` in place of `linux-x64`.

## 3. Run the probe

Run as the user that will later run the worker, from a normal login shell (so runtimes installed in per-user locations are found).

```sh
node remyral-worker.mjs probe                                   # human-readable table
node remyral-worker.mjs probe --json > "probe-$(hostname).json" # macOS / Linux / Pi
```

Windows PowerShell 5.1 writes UTF-16 with `>`; let `cmd` do the redirection so the file is plain UTF-8:

```powershell
cmd /c "node remyral-worker.mjs probe --json > probe-%COMPUTERNAME%.json"
```

Optional flags:

| Flag | Effect |
|---|---|
| `--self-test` | Loopback-only checks, no credentials, no model calls: OpenCode is started on `127.0.0.1:<random port>` with a random per-run secret and must answer 401 without and 200 with it (a 200 without it is reported as `selftest.fail_open`); Claude Code, Codex and Pi get a `--help` check. Child processes are always killed afterwards. Takes up to ~2 minutes. |
| `--runtime <kind>` | Only probe one runtime: `claude-code`, `codex`, `pi`, `opencode` (OpenHands and `--openhands-python` were removed, ADR-0023). |

Recommended for the inventory: `probe --json --self-test`.

Exit code 0 means a report was written, even if it contains problems; exit code 2 means the probe itself failed (bad arguments or a crash, message on stderr).

## 4. Hand in the result

1. Open the JSON and skim it. It contains the hostname, OS, hardware sizes, tool/runtime versions and binary paths (which include the local user name). It must not contain any secret; if you see one, do not share the file and report a bug (see [SECURITY.md](../../SECURITY.md)).
2. Keep the JSON local: it describes one of your machines. If you attach it to an issue or share it for support, redact the hostname, user name and paths first. Re-running replaces the file.
3. Anything with severity `error` in `problems` must be fixed before the machine runs jobs (typical: 32-bit OS, Node < 24). `runtime.pin_mismatch` warnings mean the runtime must be reinstalled at the pinned version before hands-on tests.

## Reading the report

- `runtimes[].pinStatus`: `match`, `mismatch`, `unknown` (version unreadable), `not-installed`. Pins: `packages/protocol/src/runtime-pins.ts` (mirrors ADR-0012).
- `runtimes[].capabilities`: protocol `RuntimeCapabilities`. Every capability of an installed runtime is `unverified` until the p3 contract tests prove it (ADR-0008); the note carries the compat-matrix evidence level and, if applicable, `pinMismatch`. `authenticated` is always `unknown`.
- `sandboxProfiles[]`: `available` = the host has what the profile needs; `ready` stays `false` until the dedicated worker OS user and job sandbox exist (p3-sandbox).
- Schema: `ProbeReport` in `apps/worker/src/probe/report.ts`, `schemaVersion: 1`.
