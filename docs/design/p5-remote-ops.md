# Design note: `p5-remote-ops` — operate workers remotely from the panel

- **Task:** `p5-remote-ops`. Owner requirement 2026-10-14: without physical access to the machines, the owner must
  install / upgrade / remove every agent runtime, log Claude Code (and Codex) into the owner's subscription,
  restart the worker service and see logs and diagnostics — from the panel.
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0017 (this decision), ADR-0014 (subscription logins stay on the machine), ADR-0012
  (pins), ADR-0011 (additive protocol), ADR-0015 (panel-managed workers, local ceiling), ADR-0006 (no secret
  values on the master, redaction), p7-supply-chain (lockfiles, `runtime-checksums.json`), p5-worker-onboarding
  (worker-owned `<dataDir>/runtimes`, private Node 24), p5-rbac, p5-stepup-window.

## Shape

```
packages/protocol/src/remote-ops.ts      OPS_COMMAND (op union, signature over worker/command/window/op digest),
                                         OPS_UPDATE (state, progress, login relay, log chunk, diagnostics),
                                         CAPABILITIES.remoteOps, feature `remote-ops-v1`, LOGIN_URL_HOSTS
scripts/security/runtime-install-manifest.mjs  lockfiles + runtime-checksums.json → bundled install set
infra/worker/runtimes/openhands/requirements.txt  hash-pinned universal OpenHands lock (uv pip compile)
apps/worker/src/remote-ops/              manifest (platform selection, version policy), fetch (verified
                                         download), tar (defensive extractor), installers (npm / PyPI / binary,
                                         entry resolution), installer (layout, state, integrity), login (relay),
                                         logs (file log + tail), diagnostics, service-control, agent (verify +
                                         dispatch), install-manifest.generated.ts
apps/worker/src/daemon, runtimes, sandbox  OPS_COMMAND in the background, OPS_UPDATE, restart exit 75, managed
                                         installs preferred by the registry, Seatbelt read-only carve-out
apps/master/migrations/0032_remote_ops   worker_ops, workers.remote_ops / remote_ops_at
apps/master/src/remote-ops/              service (request, preflight, sign + send, updates, memory relay,
                                         redaction, rate limits, lost detection), routes
apps/web                                 Fleet → worker → Remote operations (Runtimes, login dialog, Operations,
                                         History)
```

## 1. Protocol

`OPS_COMMAND {commandId, issuedAt, expiresAt, op, signature}` with `op` one of `runtime.install {runtime,
version}` (install, upgrade, rollback, repair), `runtime.remove`, `runtime.restart`, `login.start | login.status
| login.logout {runtime: claude-code | codex}`, `login.input {target, code}`, `ops.cancel {target}`,
`service.restart {drain, drainTimeoutSec}`, `logs.tail {lines ≤ 2000, maxBytes ≤ 256 KiB}`, `diagnostics.run`.
No field can carry a URL, package name or command; unknown fields are stripped (ADR-0011). The signature is the
master lease key over `remana-ops-command/v1\n<workerId>\n<commandId>\n<issuedAt>\n<expiresAt>\n<sha256(canonical
op)>`; the window is ≤ 5 min with ±2 min skew.

`OPS_UPDATE {commandId, seq, kind, state, reason?, detail?, progress?, login?, logs?, diagnostics?, runtime?}`,
`state ∈ accepted | running | waiting_for_user | succeeded | failed | refused | cancelled`. A `login` part holds
only `url` (https, host in `LOGIN_URL_HOSTS`: claude.com, claude.ai, platform.claude.com, console.anthropic.com,
auth.openai.com), `userCode` (`ABCD-EFGHI` shape) and `expectsCode`. A `logs` part is ≤ 200 lines of ≤ 4 KiB
and asserts `redacted: true`.

`CAPABILITIES.remoteOps`: per runtime the method, whether this host can install it (platform packages, Python ≥
3.12), pinned / previous version, installable versions, installed versions with integrity, active version; login
states from the runtimes' own status commands; service manager + restartable; log availability.

## 2. Runtime installs (worker)

**Install set.** `install-manifest.generated.ts` is generated from `infra/worker/images/<rt>/package-lock.json`
(npm runtimes; every package with tarball URL, sha512 integrity, os/cpu/libc) and
`infra/worker/runtimes/openhands/requirements.txt` (361 packages, sha256 of every published file, universal
markers); the top-level integrity (npm) and the four openhands-* hash sets must equal `runtime-checksums.json`.
`pnpm security:pins` fails when the generated file is stale. A previous pin is kept installable by placing its
snapshot under `infra/worker/runtimes/<rt>/previous/` (`version.txt` + lockfile) when bumping.

**Version policy** (`decideTarget`): only versions in the set; a version below the active one only if it is the
previous pin; same version = repair. The master pre-checks against the worker's reported `available` list
(`version_not_available`), the worker decides (`version_not_pinned`, `downgrade_refused`).

**npm.** Packages are selected like npm does (non-optional always, optional by os/cpu/libc). Each tarball is
streamed to disk while hashing and **refused before extraction** on an integrity mismatch; the first failure
aborts the other downloads. The worker's own extractor strips `package/`, refuses absolute paths, `..`, drive
letters and backslashes, never creates links, devices or setuid bits (modes normalised to 0755/0644) and is
bounded in entries and bytes. No npm, no `.npmrc`, no install scripts. Entry: the native platform binary (Claude
Code `claude-agent-sdk-<os>-<arch>[-musl]/claude`, Codex `vendor/<triple>/bin/codex`, OpenCode
`opencode-<os>-<arch>[-musl]/bin/opencode` — what the images link) or, for Pi, its `bin` script run by the
worker's own Node (`process.execPath`, the private Node 24 of p5-worker-onboarding).

**PyPI (OpenHands).** `python -m venv <dir>/venv` with a host Python ≥ 3.12 (found on PATH: python3.13 /
python3.12 / python3 / python, `py` on Windows), then `pip --isolated install --require-hashes --only-binary :all:
--no-deps --no-cache-dir --index-url <index> -r requirements.txt`: user/site config and env overrides ignored,
every distribution hash-checked, wheels only (no build step runs package code). A venv cannot move, so it is built
in place and recorded only once complete; failures remove the directory.

**Binaries.** Supported by the install set format (`sha256`, size, per `<os>-<arch>`); no current pin uses it.

**Layout.** `<dataDir>/runtimes/<runtime>/<version>/` + `state.json` (0600, atomic: active version, installs,
entry sha256). npm installs are staged in `.staging-*` and renamed; leftovers of an interrupted install are
removed on start. The adapters' reference state moved to `<dataDir>/runtime-state` (old `reference` dirs are
removed) so the runtimes tree holds nothing but installs. The entry digest is verified on every start and on
demand; a `modified` install is not used (diagnostics problem `runtime.install_modified`, panel shows it; repair =
reinstall). Free space ≥ 1 GiB is required. Removing or repairing the active version is refused while a job of
that runtime runs (`runtime_in_use`); an upgrade leaves the previous version in place.

**Use.** The registry prefers: a binary named in the local config, then the managed install, then PATH. Claude
Code gets the managed CLI as `pathToClaudeCodeExecutable` (in the single-file release bundle no SDK platform
package exists, so this is how Claude Code becomes runnable). After an install / removal the registry is rebuilt,
re-probed and CAPABILITIES re-sent; the cached CLI probe is overridden by the managed version.

**Sandbox.** Seatbelt (macOS host profiles) denies the whole data dir to jobs; it now opens `<dataDir>/runtimes`
read-only (writes stay denied everywhere but the attempt's own dirs) and allows only metadata on the data dir
itself (no listing). Verified live on macOS. Linux host-restricted has no filesystem confinement beyond the
dedicated user (unchanged; installs are as protected as the worker's own files).

## 3. Login relay

The worker runs `claude auth login --claudeai` / `codex login --device-auth` with the allow-listed base env
(HOME etc. of the service user, plus `CLAUDE_CONFIG_DIR` / `CODEX_HOME` only if the worker itself has them),
`NO_COLOR`, `TERM=dumb`, `BROWSER=/usr/bin/true` (never opens a browser on the machine). Verified against the
pinned CLIs (2026-10-14, temp HOME): Claude Code without a TTY prints `If the browser didn't open, visit:
https://claude.com/cai/oauth/authorize?…redirect_uri=https://platform.claude.com/oauth/code/callback…` and reads
the code the callback page shows (`<code>#<state>`) from stdin (a wrong code: `Login failed: … 400`, exit 1);
Codex prints `https://auth.openai.com/codex/device` and a one-time code `XXXX-XXXXX` and polls by itself.

Output is scanned in memory (ANSI stripped, 64 KiB window) for an allow-listed, *complete* URL (terminated or
after 300 ms of quiet output) and, for Codex, the device code; nothing else of it is relayed, logged or stored. The
pasted code is written once to the login's stdin. On exit 0 the runtime's status command decides
(`claude auth status --json` → `loggedIn` / `authMethod`; `codex login status` → exit code / "Logged in using
ChatGPT"); the account e-mail the Claude status prints is dropped. Timeout 15 min; one login at a time per worker;
cancel kills the process group. Logout uses `claude auth logout` / `codex logout`.

Master: the URL / code are kept in memory per operation (cleared on its end, 15 min TTL), never in
`worker_ops`; the pasted code is sent in `OPS_COMMAND login.input` and dropped from the stored parameters, the audit
metadata and the logs.

## 4. Service operations

- **Restart.** `service.restart {drain, drainTimeoutSec}`: with drain the worker reports `draining` (no new jobs),
  waits until no job runs or gives up (`drain_timeout`, drain lifted); then the final `OPS_UPDATE succeeded`, a
  clean stop (children reaped, store flushed) and exit **75**. systemd (`Restart=on-failure`,
  `RestartPreventExitStatus=78`), launchd (`KeepAlive.SuccessfulExit=false`) and shawl (`--restart-if-not 0,78`)
  start it again. Restartable only under the service manager: systemd `INVOCATION_ID`, launchd
  `XPC_SERVICE_NAME=com.remyral.worker`, Windows heuristic (`NODE_ENV=production` + the service data dir);
  `remoteOps.restartable` overrides. Replay state is persisted, so a restart command never runs twice.
- **Runtime restart.** Runtime servers are per job (ADR-0012); "restart" re-verifies the install, rebuilds the
  runtime's reference adapter and re-probes it. Running jobs keep their adapter.
- **Logs.** The logger tees every (already redacted) JSON line to `<dataDir>/logs/worker.log` (0600, dir 0700,
  rotated at `remoteOps.logFileBytes`, default 4 MiB, one older generation). `logs.tail` re-redacts each line with
  the logger's redactor (exact registered secrets + patterns), bounds lines / bytes and sends chunks ≤ 64 KiB; the
  master redacts again on receipt and on every read and keeps ≤ 2000 lines per operation in memory (15 min).
- **Diagnostics.** Node version vs 24, OS, uptime, memory, free space of data dir / workspace root / runtimes,
  sandbox readiness (the runners' own checks), per runtime source (config / managed / path / none), version,
  enabled, auth readiness, install integrity, service manager state; problems with codes. Redacted on the
  worker and before storage.

## 5. Master API and authorization

| Route | Action | Step-up |
| --- | --- | --- |
| `GET /workers/:id/ops` | `workers.ops.read` (admin) | — |
| `GET /workers/:id/ops/:opId?after=n` | `workers.ops.read` | — |
| `POST /workers/:id/runtimes/:runtime/install` `{version}` | `workers.ops.write` (admin) | standard |
| `POST /workers/:id/runtimes/:runtime/remove` `{version}` | `workers.ops.write` | standard |
| `POST /workers/:id/runtimes/:runtime/restart` | `workers.ops.write` | standard |
| `POST /workers/:id/runtimes/:runtime/login` | `workers.ops.write` | **always-fresh** |
| `POST /workers/:id/ops/:opId/input` `{code}` | `workers.ops.write` | **always-fresh** |
| `POST /workers/:id/runtimes/:runtime/logout` | `workers.ops.write` | **always-fresh** |
| `POST /workers/:id/runtimes/:runtime/login-status` | `workers.ops.write` | standard |
| `POST /workers/:id/ops/:opId/cancel` | `workers.ops.write` | standard |
| `POST /workers/:id/restart` `{drain, drainTimeoutSec}` | `workers.ops.write` | standard |
| `POST /workers/:id/logs` `{lines, maxBytes}` | `workers.ops.write` | standard |
| `POST /workers/:id/diagnostics` | `workers.ops.write` | standard |

Refusals: `worker_update_required` (no `remote-ops-v1`), `worker_offline`, `worker_quarantined`,
`version_not_available`, `not_restartable`, `login_in_progress`, `login_not_waiting`, `code_already_sent`,
`op_finished`, 429 `rate_limited` (per worker 60 / 10 min, install-remove-restart 10 / 10 min, per admin
120 / 10 min; the refusal is audited). Operations without news are marked `lost` (`no_answer`) after 10 min
(install 45 min, login 20 min). Every request is audited `worker.ops.<kind>` with its parameters (never a code);
the worker's terminal result is audited `worker.ops.result` (success / denied / failure).

## 6. Security review

- **Panel compromise can now run installs — but only pinned and checksummed artifacts.** The command has no URL,
  package or command field; the worker installs only from the install set compiled into its signed release;
  every byte is checked (sha512 / sha256 / pip `--require-hashes`) before it is used; no install script or build
  step runs; downgrade only to the previous pin. Worst case: churn (install / remove / restart), mitigated by
  step-up, rate limits, audit and the local opt-out `remoteOps.disabled`. Releasing a new install set needs the
  release key (p2-signed-updates), not panel access.
- **Forged / replayed commands.** Signature bound to worker, command, window and operation digest; pinned
  `masterLeaseKeys` protect against a TLS-terminating proxy; persisted replay set; ±2 min skew, ≤ 5 min window.
  Without any trusted key (a dev master) unsigned commands are accepted with a warning, as for ADR-0015/0016.
- **Login relay.** The platform handles: an https URL of the provider's sign-in page, a device code, and (Claude)
  an authorization code the owner pastes. The authorization code cannot be exchanged without the PKCE verifier,
  which exists only inside the login process on the worker; it is never stored, logged or audited (tests assert
  its absence from every table and the master log). The resulting token is written by the runtime to its own
  store and **never read** by the worker (tests run the relay under an fs spy: no credential file is opened) or
  sent anywhere (tests assert no token in any update or log). A compromised panel could start a login and try to
  get the owner to approve it — the provider's consent page names the client, the login needs always-fresh
  step-up and is audited, and the owner initiates logins themselves. Only allow-listed hosts are relayed (worker)
  and rendered as links (master re-check, panel re-check, `rel="noopener noreferrer"`).
- **Log redaction.** Three passes: the logger (exact secrets + patterns) before the line is written, the worker's
  redactor again when tailing (catches secrets registered after the line was written), the master's pattern pass
  on receipt and on read. Lines are never stored in Postgres. Residual risk: a secret that matches no pattern and
  was never registered with the worker (e.g. printed by a third-party tool) — the same residual risk as job logs
  (ADR-0006).
- **Sandbox.** The Seatbelt carve-out exposes only the installs (read-only) and the data dir's metadata;
  device key, vault key, secret store and state stay unreadable to jobs (live test). On Linux/Windows host profiles
  the installs are as protected as the rest of the worker's files (same user); container jobs use images.
- **Restart.** Exit 75 only under a service manager; a worker started by hand refuses (it could not come back).
  Drain lets running jobs finish; without drain they stop and the master reconciles their leases (ADR-0004).
- **Disk / resource abuse.** Install needs ≥ 1 GiB free; tarballs ≤ 512 MiB each, extraction ≤ 2 GiB / 100k
  entries; logs ≤ 2 × logFileBytes on disk.

## 7. Platform matrix (honest)

| | linux x64 | linux arm64 (Pi) | macOS arm64 | macOS x64 | Windows x64 |
| --- | --- | --- | --- | --- | --- |
| npm install (fixture registry, tar, integrity, layout) | CI unit tests (ubuntu runner, UNVERIFIED here) | UNVERIFIED | **tested** | UNVERIFIED | skipped (POSIX fixtures) — UNVERIFIED |
| real pinned Codex install from npmjs.org (opt-in) | — | — | **run once** (2026-10-14) | — | — |
| venv + pip `--require-hashes` (local index) | needs python3.12+ on the runner | UNVERIFIED | **tested** | UNVERIFIED | UNVERIFIED |
| OpenHands full lock resolves wheels-only | UNVERIFIED | UNVERIFIED | **dry-run ok** (uv, py3.12) | UNVERIFIED | UNVERIFIED |
| login relay (fake CLIs) | CI | UNVERIFIED | **tested** | UNVERIFIED | skipped (sh wrappers) — UNVERIFIED |
| real `claude auth login` / `codex login --device-auth` output | — | — | **observed** (temp HOME, not completed) | — | — |
| Claude login as a service account (macOS keychain of `_remyralworker`) | n/a | n/a | **UNVERIFIED** (the CLI may need a login keychain) | UNVERIFIED | n/a |
| restart exit 75 → service manager restart | unit-tested detection; real systemd UNVERIFIED | UNVERIFIED | daemon test (exit code); launchd UNVERIFIED | UNVERIFIED | detection heuristic UNVERIFIED |
| Seatbelt carve-out | n/a | n/a | **live test** | UNVERIFIED | n/a |

Blocking follow-up: `p5-remote-ops-hosts` (backlog) — run install / login / restart on each real OS of the fleet.

## Rollback

- Migration 0032 is additive (one table, two nullable columns). An older master ignores them; workers without
  `remote-ops-v1` never receive OPS_COMMAND.
- Worker: rolling back to a build without remote ops leaves `<dataDir>/runtimes/<rt>/<version>` in place but
  unused (the older registry uses PATH / config binaries again and recreates `<dataDir>/runtimes/<rt>/reference`);
  delete the tree by hand if wanted. `remoteOps.disabled: [...]` turns groups off without a rollback.
- A bad runtime version: roll back to the previous pin from the panel, or remove it.

## Operational metrics

Per worker: managed runtimes (active / installed / integrity), login states and when they were checked, last
operations with state and reason (History). Audit: `worker.ops.<kind>`, `worker.ops.result`, rate-limit denials.
Master log: `remote operation sent`, `remote operation update`; worker log: `remote operation accepted|refused`,
`runtime installed|removed`, `login started|finished|failed`.

## Tests

`packages/protocol/test/remote-ops.test.ts`; `apps/worker/test/remote-ops-installer.test.ts` (install set,
platform selection, version policy, tar, fixture-registry installs, tamper, wrong checksum, traversal, upgrade /
rollback / downgrade refused, modified install, interrupted install, PyPI with fake processes, real venv + pip
against a local index with a tampered hash, opt-in online Codex), `remote-ops-login.test.ts` (fake Claude / Codex
CLIs, token never leaves the worker, no credential file opened, no provider env passed, wrong code, foreign URL,
cancel, busy, timeout), `remote-ops-agent.test.ts` (signature / window / replay incl. after restart / local
opt-out, restart, runtime restart, logs redaction and bounds, re-send after reconnect),
`remote-ops-live.test.ts` (running daemon: feature, install, CAPABILITIES, logs, diagnostics, restart exit),
`remote-ops-sandbox.test.ts` (Seatbelt profile + live macOS); `apps/master/test/integration/remote-ops.test.ts`
(feature gate, RBAC, step-up, signed delivery, idempotent updates, login relay without storing the code,
redaction, rate limit, lost), `rbac-matrix`, `route-coverage` (always-fresh list); `apps/web/test/remote-ops.test.tsx`.
