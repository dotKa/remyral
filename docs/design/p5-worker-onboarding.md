# Design note: `p5-worker-onboarding` — "Add machine" from the panel, signed installer kits, automatic Node 24

- **Task:** `p5-worker-onboarding` (owner requirement 2026-10-14: *download the worker files and infra install files from the panel; install Node v24 automatically when it is missing*).
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0005 (outbound-only worker, device key, fingerprint + pairing-code approval), ADR-0009 (admin + step-up for privileged changes), ADR-0015 (panel-managed workers: the local file is minimal), `p2-service-install` (root-owned Node 24, hardened services, idempotent installers), `p2-signed-updates` (offline release key, `sign.mjs`, `worker_releases`, privileged updater `adopt`), `p5-rbac` (deny by default, route coverage), `p7-supply-chain` (everything pinned and checked by `pnpm security:pins`).
- **Out of scope:** panel-side worker configuration (`p5-managed-workers`), remote runtime installation (`p5-remote-ops`; the kit layout leaves room, see §Layout), an enrollment token (decided against, §4).

## Problem

Until now adding a machine meant: build the bundle on the Mac, copy it and the `infra/worker/<os>` files over, install Node 24 by hand (system-wide, root-owned), run the installer with the right flags, then find the pairing code in the journal. The owner will rarely sit at the machines; after the first install everything is managed from the panel (ADR-0015). The first install therefore has to be one copy-paste per machine, must not depend on a pre-installed Node, and must stay as trustworthy as the signed update channel.

## Shape

```
infra/worker/node/pin.env             THE Node pin (version, SHA-256 of SHASUMS256.txt, signer, per-platform archive hashes)
infra/worker/node/keys/               vendored Node release keys (github.com/nodejs/release-keys, keys.list = active releasers)
infra/worker/node/install-node.sh     pinned private Node for linux/macos installers (bash 3.2)
infra/worker/{linux,macos}/install.sh private Node fallback, kit SHA256SUMS, signed release auto-detected, minimal config, pairing code printed
infra/worker/windows/install.ps1      same (plan actions InstallNode / PruneNode; Test-RemyralKitChecksums; ConvertFrom-RemyralPin)
packages/protocol/src/installer.ts    signed installer index (domain `remyral-worker-installers/v1`), kit checks
scripts/release/kit.mjs               deterministic tar.gz / zip writers, OpenPGP dearmor → gpgv keyring, kit builder
scripts/release/sign.mjs              build → also kits; `installers` (for an existing release dir); `verify-installers`
scripts/security/node-pin.mjs         offline pin consistency; --online re-verifies nodejs.org + signature; --update
apps/master/migrations/0031_worker_installers.sql
apps/master/src/installers/           service.ts (verify/store/serve), bootstrap.ts (pure script generator), routes.ts
apps/web/src/screens/fleet/AddMachinePage.tsx   Fleet → Add machine (/fleet/add)
infra/worker/linux/test/onboarding-e2e.sh       Docker e2e (bootstrap → kit → Node → service → pairing)
```

## Decisions

### 1. The installer kit is part of the signed release

A kit is one archive per OS (`remyral-worker-<v>-linux.tar.gz`, `-macos.tar.gz`, `-windows.zip`, ~1.1 MiB each) built by `sign.mjs` on the release-key holder's machine:

```
remyral-worker-<version>-<os>/
  install.* uninstall.* + service/launchd files (infra/worker/<os>)
  remyral-worker.mjs manifest.json manifest.sig.json     the signed release (p2-signed-updates)
  remyral-worker-updater.mjs                             verifies the release signature again (`adopt`)
  node/pin.env [install-node.sh nodejs-keyring.gpg]     the pinned Node bootstrap
  README.txt  SHA256SUMS
```

The kits are listed in an **installer index** (`schema, version, releaseManifestSha256, node.version, kits[{os,file,sha256,size}], createdAt`) signed with the **same offline release key** over `remyral-worker-installers/v1\n ‖ index bytes` — a different domain than the manifest signature, so neither can be replayed as the other (tested). The index is bound to the exact `manifest.json` bytes of the release; re-signing a canary build for stable makes its kits *stale*: the master stops serving them and lists the release under "without kits" until kits are rebuilt from the same release dir. Archives are deterministic (sorted entries, uid/gid 0, mtime = manifest `createdAt`), so a rebuild of the same inputs gives the same bytes. No new dependencies: ustar/gzip and zip/deflate are ~120 lines over `node:zlib` (`crc32`, Node ≥ 22.2).

`POST /releases` accepts an optional `installers {index, signature, kits[{os, content}]}` next to the release; `sign.mjs build|installers` writes it into `release.json`, so the existing upload button publishes both. The master verifies: index signature against `RELEASE_PUBLIC_KEYS`; index version = release version; every kit named in the index uploaded (and nothing else), size + SHA-256; index bound to the stored manifest. Identical re-upload = 200; different kits for the same manifest = `409 installers_exist` (immutable per release); stale kits are replaced. Every refusal is audited (`release.installers.upload` denied). If the release part succeeds and the kits are refused, the release stays (it was valid) and the error names the kit problem; uploading again is idempotent.

### 2. Bootstrap scripts: public, secret-free, pinned to the signed kit hash

`GET /v1/worker/install/<version>/<os>/bootstrap.sh|bootstrap.ps1` is generated from `PUBLIC_ORIGIN` (never the request's Host header), the version, the kit file name and the kit SHA-256 from the signed index. It downloads the kit from the same origin (`curl --proto =https --tlsv1.2` / `wget --https-only`, or `Invoke-WebRequest` with TLS 1.2), **refuses it unless the SHA-256 matches**, keeps it in the program directory (`/opt/remyral-worker/installer`, `/Library/Application Support/RemyralWorker/installer`, `%ProgramFiles%\RemyralWorker\installer` — root/admin-owned, so `uninstall` and repair stay available) and runs the kit's installer with `--master-url wss://<origin>/v1/worker` plus any extra arguments. The script is deterministic, so the console shows its SHA-256 and the command is "download, check, run":

```sh
curl -fsSL --proto '=https' --tlsv1.2 -o remyral-bootstrap.sh 'https://…/v1/worker/install/1.2.0/linux/bootstrap.sh' && echo '<sha256>  remyral-bootstrap.sh' | sha256sum -c -
sudo sh remyral-bootstrap.sh
```

(macOS: `shasum -a 256 -c -`; Windows: `Invoke-WebRequest … ; if ((Get-FileHash …).Hash -ne '<SHA>') { throw }` then `powershell -ExecutionPolicy Bypass -File .\remyral-bootstrap.ps1`.) `curl | sh` is deliberately not offered.

These routes, the kits (`…/<os>/<kit file>`) and the signed index (`…/<version>/index.json|index.sig.json`, for `sign.mjs verify-installers`) are **anonymous** (`config.auth: 'public'`): a machine being installed has no credential. That is allowed by the brief because they contain no secret and everything they fetch is verified. Bounds: only kits bound to the current manifest, 30 requests per IP per 10 minutes (own limiter bucket; class `worker-download` so the central hook does not double count), `cache-control: no-store`, `nosniff`, every response logged. `INSTALLER_PUBLIC_DOWNLOADS=false` turns all of it off (404); the console then offers only the signed-in bundle download. Releases were never secret (`p2-signed-updates`: the download token only kept them from being anonymous); the bundle is the same code that is in the repository.

### 3. Add machine screen (admin) and authz

`/fleet/add` (button **Add machine** on Fleet, admins only): pick Linux x64, Linux arm64 / Raspberry Pi (64-bit OS), macOS Apple silicon / Intel, Windows x64; it shows the two lines, the **Download installer bundle** button (`GET /installers/<v>/<os>/kit`, full session, audited `installer.download`), the kit SHA-256 and the manual steps for the bundle, the Node note and step 3 (approve in Fleet → Waiting for approval). Data: `GET /installers` (`installers.read`, admin) — current release (stable channel's if it has kits, else the newest with kits, flagged), kits, commands, `withoutKits`. Nothing is created on this screen, so it needs no step-up; uploading kits is `releases.publish` (admin + step-up, unchanged). New action `installers.read` (admin) in the authz model, rbac-matrix and route-coverage (two new allowlisted public routes, tested to 404 without uploads).

### 4. No enrollment token

Considered: a short-lived single-use token minted by the panel (admin + step-up) and passed to the installer so it could pre-register "machine X is installing". Decided **against**:
- it adds no security — approval still needs the fingerprint comparison and the pairing code (ADR-0005), and the token must not replace them;
- it would put a secret into a command line (shell history, screenshots, scroll-back) and need a table, expiry sweeps, a protocol field in the pairing request and a new failure mode;
- the only gain is a few minutes of "installing" status. The installer itself prints the pairing code and fingerprint as soon as the service runs, and the request appears under **Waiting for approval** within seconds (verified in the e2e: the code printed on the machine is the code the master received).
Revisit if remote, unattended installs (`p5-remote-ops`) need the panel to correlate an install with a request.

### 5. Node 24 bootstrap

- **One pin:** `infra/worker/node/pin.env` (`KEY=value`, parsed — never sourced — by bash, PowerShell and Node): `NODE_VERSION` (now 24.21.0), `NODE_DIST_URL`, `NODE_SHASUMS256_SHA256`, `NODE_SIGNER`, `NODE_SHA256_{linux_x64,linux_arm64,darwin_x64,darwin_arm64,win_x64}`. `scripts/security/node-pin.mjs` (run by `security:pins`) checks it offline (Node 24, ≥ `engines.node`, hashes present, signer in the vendored key list, every listed key file present); `--online` downloads SHASUMS256.txt + `.sig` from nodejs.org, **verifies the OpenPGP signature with `gpgv` against the vendored keys** and compares every hash; `--update 24.x.y` re-pins only after the signature verifies.
- **Verification on the machine:** SHASUMS256.txt must hash to the pinned value — so its signature (verified when the pin was made) is the one that counts even where no OpenPGP tool exists; where `gpgv` exists (Debian, Ubuntu, Raspberry Pi OS always: apt depends on it) the detached signature is verified **again** against the kit's `nodejs-keyring.gpg` (dearmored from `keys/*.asc`) and a failure is fatal; the archive's line in SHASUMS256.txt must equal the per-platform pin, and the archive must hash to it. macOS and Windows ship no OpenPGP verifier, so there the pinned hash of the signed file is the anchor (documented, not hidden). Linux/macOS use the `.tar.gz` archives (gzip is everywhere; `.tar.xz` needs xz), Windows the `.zip`; the Pi is `linux-arm64` (32-bit Raspberry Pi OS is refused with a hint).
- **Private prefix, nothing else touched:** `/opt/remyral-worker/node/node-v<v>-<plat>`, `/Library/Application Support/RemyralWorker/node/…`, `%ProgramFiles%\RemyralWorker\node\…` — root/admin-owned, not group/world-writable (T-SUP-2), not on PATH. Only the service definition, the updater unit and the CLI wrapper point at it. Staged on the same filesystem and renamed into place; a `.remyral-sha256` marker makes re-runs idempotent and lets a damaged copy be repaired.
- **Selection order:** `--node PATH` (unchanged, still strictly checked; `--allow-unsafe-node` unchanged) → the private Node if this installer manages one (kept at the pin: a re-run after a pin change upgrades it, old versions are pruned after the service points at the new one) → a usable system-wide Node 24 (root-owned, not in a home dir) → otherwise download the pinned one. A Node that is too old, in a home directory (nvm) or user-writable is now *left alone* and the private Node is used instead of failing. `--private-node` forces the private Node; `--node-dist-url` (`-NodeDistUrl`) points at a mirror (https only, plain http only for loopback) — integrity stays pinned.
- **Updating Node later:** a new pin ships with the next kit; re-running the installer (or the bootstrap of the new release) upgrades. The privileged updater never changes Node (`p2-signed-updates` §6 unchanged).

### 6. Installer flow and the minimal local config

download → bootstrap checks kit SHA-256 → `install.sh` checks `SHA256SUMS` of every kit file → Node (above) → service account, directories → the signed release is installed through `remyral-worker-updater.mjs adopt` (signature checked with the release key compiled into the updater; downgrades refused) → **minimal config**: `masterUrl` + `workspaceRoot` only (ADR-0015 §2; `dataDir` is not written because the worker's default for the system config location is exactly the installer's data dir; `--max-parallel-jobs` now writes an explicit `localCeiling.maxParallelJobs` instead of an operational value) → unit/plist/service → start → the installer waits up to 30 s for the daemon's log line and prints the **pairing code and fingerprint** → the master lists the request under **Waiting for approval**. A re-run keeps the config and the device key, repairs files and the private Node, and restarts only if something changed.

### Layout room for `p5-remote-ops`

Runtimes installed later by the worker (Claude Code, Codex, OpenHands, Pi, OpenCode) belong to the **worker-owned** data dir (`<dataDir>/runtimes/`), not the root-owned program dir: the kit and the install dir stay code the service account cannot modify. Nothing in this task creates that directory; the kit layout reserves no path for it on purpose.

## Security review

| Threat | Mitigation | Residual |
|---|---|---|
| **TOFU of the first download.** The very first bootstrap/kit comes from the master over TLS; the machine has nothing to verify it against yet | The command pins the bootstrap's SHA-256, the bootstrap pins the kit's SHA-256 from the release-key-signed index, the kit verifies the worker release signature again (`adopt`, release key compiled into the updater). The console shows the signing key id; the owner can verify a downloaded kit offline: `sign.mjs verify-installers --dir … --public-key <offline pub>` (and the index is downloadable) | Whoever controls the console page the owner copies from controls the command (see next rows). Same trust as typing a command from any web page |
| **Attacker with an admin session (stolen cookie + TOTP)** | Can read the commands and download kits (as anyone can anonymously). Cannot upload or replace kits without the offline release key (signature verified on upload; kits immutable per release; refusals audited). Cannot make a machine enrol without the owner comparing the fingerprint and entering the code | Can point the stable channel at another *signed* release (existing `releases.publish` power, step-up + audited) |
| **Attacker controlling the master process/host** | — | Can serve any page and any bootstrap script → code execution as root on a machine **being installed now**. The signature chain does not help a first install whose instructions come from the compromised host. Mitigations: install from a known-good session; compare the release key id shown with your offline record; for high assurance download the kit, `verify-installers` with the offline public key, then run `install.sh` from it. Machines already installed are not affected: they only accept updates signed with the pinned release key (`p2-signed-updates`) |
| **Malicious/compromised Node mirror or nodejs.org** | SHASUMS256.txt hash pinned (its signature verified at pin time with vendored keys), signature re-verified with `gpgv` where available, archive hashes pinned; tested refusals: swapped archive, altered SHASUMS256.txt, signature over other data, unreachable mirror | Trust in the Node release keys at pin time (vendored from github.com/nodejs/release-keys, reviewed in the pin change) |
| **Supply chain of the bootstrap itself** | Generated by the master from validated values only (quoted, character-checked; unit-tested), no secret inside, deterministic (hash shown) | — |
| **Path/archive tricks** | Kits are built by our own writer (no `..`, root-owned entries); `SHA256SUMS` lines with `..` are refused (Windows); the master serves only DB rows, never paths; the static path parameter is enum/regex-checked | — |
| **Abuse of anonymous downloads** | Per-IP limit (30/10 min), no-store, logged; can be switched off (`INSTALLER_PUBLIC_DOWNLOADS=false`) | Bandwidth of ~1 MiB per allowed request |
| **Private Node replaced by the service account** | Root-owned prefix, mode 755, outside the worker's writable paths (`ProtectSystem=strict` on Linux) | macOS/Windows rely on file ACLs (as for the bundle) |
| **System Node of other users changed** | Never touched (e2e checks the system node's hash and PATH) | — |

## Tests

- `packages/protocol/test/installer.test.ts` — signed index, kit checks, **domain separation** both ways, tampering, unknown key, malformed docs, oversized index, invalid indexes (file names, duplicates, Node major, unknown fields, empty).
- `scripts/test/installer-kit.test.mjs` — ustar (checksums, modes, root-owned, deterministic) and zip (`unzip -t`, deterministic) writers, extraction with the system `tar`, dearmor CRC-24, `sign.mjs installers` (kits, signed index, release.json), kit content + complete SHA256SUMS, `verify-installers` refusing a swapped kit and a forged index, bundle/manifest mismatch refused; node pin checks (wrong major, missing hash, unknown signer, missing keys, outdated vs engines, non-nodejs.org URL).
- `apps/master/test/integration/installers.test.ts` (real Postgres) — no kits; admin-only (`operator`, `viewer` 403); upload with a release; commands whose hash equals the served bootstrap, bootstrap pins the kit hash and contains no credential; anonymous kit/index downloads; wrong names 404; audited bundle download; refusals (foreign key, swapped kit, other manifest, kits exist, other version, kit missing) audited; idempotent re-upload; stable-channel selection; **stale after re-sign** and replacement; per-IP rate limit; no `PUBLIC_ORIGIN` (no commands, bootstrap 503, bundle works); `INSTALLER_PUBLIC_DOWNLOADS=false` (everything anonymous 404). Plus `route-coverage`, `rbac-matrix` (+1 action), `config` unit test.
- `apps/web/test/add-machine.test.tsx` — link from Fleet for admins, per-OS commands, bundle link, Pi / Windows notes, private Node path; no PUBLIC_ORIGIN → bundle only; no kits → how to publish; viewers get no data.
- Windows plan tests (`infra/worker/windows/test/run-tests.sh`, PowerShell 7 in Docker): pin parsing/refusals, no Node → `InstallNode` right after the program dir with pinned URL/hashes and the service + CLI using the private node, Node 22 left alone, idempotent re-run, upgrade + prune, `-PrivateNode`, mirror rules, minimal config, kit checksums (intact, changed, path escape).
- macOS (`apps/worker/test/service-installers.test.ts`, darwin): `--private-node` dry-run plans the pinned, verified download and the LaunchDaemon runs the private node; minimal config; `--node` + `--private-node` refused.
- **Linux e2e, real systemd in Docker** (`infra/worker/linux/test/onboarding-e2e.sh`, offline: fixture Node mirror signed by a throw-away OpenPGP key, kit signed by a throw-away release key, scripted master that serves the files and never approves): arm64 **without Node** (32 checks) and **with the node:24 image's Node** (27 checks): console command (download + checksum), bootstrap → kit → SHA256SUMS → signed adopt → pinned Node (gpgv verified) or system Node untouched → minimal config → service active → pairing code + fingerprint printed **and received by the master**, nothing approved, re-run keeps Node/config/device key, repair of a damaged Node, a kit with the wrong hash refused, uninstall from the kept kit. Node bootstrap without systemd (`node-arm64`, 20 checks; the same script runs as `node-x64` under qemu): fresh install, signature + hash, root-owned, not on PATH, idempotent, refusals (swapped archive, altered SHASUMS, bad signature, unreachable mirror), installer dry-run from the kit. `ONLINE=1` additionally installs the real pinned Node from nodejs.org with the vendored keys.

## Platform verification status

- **Linux arm64:** full flow verified on real systemd 257 (Debian 13) in Docker, with and without a preinstalled Node.
- **Linux x64: UNVERIFIED.** The `node-x64` case (Node bootstrap + refusals + installer dry-run under qemu) is written but could not run on 2026-10-14: pulling the amd64 Debian image timed out on the development machine's Docker. The systemd part is also **UNVERIFIED on x64** (qemu-user cannot run systemd's sandboxing — same limitation as `p2-service-install`; run `CASES="full-nonode full-node" onboarding-e2e.sh` on an x64 runner). **Raspberry Pi hardware: UNVERIFIED** (`p2-arm64`).
- **macOS:** dry-run with fakes only. **UNVERIFIED:** a real bootstrap + private Node install + LaunchDaemon on the fleet Mac (no account/daemon may be created on the development Mac) — joins the existing P2 blocking ticket.
- **Windows:** plan logic only (PowerShell 7 in Docker). **UNVERIFIED on real Windows:** `bootstrap.ps1`, `Invoke-WebRequest`/`Expand-Archive` on PowerShell 5.1, the private Node under `%ProgramFiles%`, service start with it — joins the existing Windows blocking ticket.
- **Online pin:** `node scripts/security/node-pin.mjs --online` verified 24.21.0 against nodejs.org with the vendored keys (2026-10-14).

## Rollback

- Turn the one-line install off: `INSTALLER_PUBLIC_DOWNLOADS=false` (bundle download stays); remove `PUBLIC_ORIGIN` to drop the commands.
- Code revert: the routes and screen disappear; migration 0031's tables stay unused (forward-only). Releases uploaded with kits keep working without them (the release part is unchanged).
- Machines installed with the private Node keep it; `--node /usr/local/bin/node` on a re-run switches back to a system Node (the private copy can then be deleted). Uninstall removes it with the program directory.

## Operational metrics

Audit: `release.installers.upload` (success/denied with reason), `installer.download`. Logs: `installer bootstrap served`, `installer kit served` (version, os, sha256). Alert idea (`p6-alerts`): many anonymous kit downloads from one IP, or uploads refused.
