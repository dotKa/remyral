# Design note: `p0-worker-probe`

- **Task:** `p0-worker-probe` (A-FLEET-6). Feeds `p0-inventory` and `p0-compat-handson`.
- **Date:** 2026-10-12
- **Binding inputs:** ADR-0002 (Node 24, exact pins), ADR-0007 (sandbox profiles), ADR-0008 (truthful capabilities), ADR-0011 (Zod, stripped unknown fields), ADR-0012 (pins, fail-closed local servers, worker owns the process tree), `docs/compat/README.md`.

## Problem

The owner must inventory seven heterogeneous nodes (macOS, 2× Windows, 3× Linux, Raspberry Pi arm64) before a master exists. A manual inventory goes stale and is not machine-checkable. We need one file that runs with only Node 24 installed and prints a structured, truthful report.

## Shape

`apps/worker` (`@remyral/worker`), command `remyral-worker probe [--json] [--self-test] [--runtime <kind>] [--openhands-python <path>]`.

```
cli.ts ──► probe/probe.ts (orchestrator)
              ├── probe/host.ts        HostFacts (+ raw platform facts, never crash)
              ├── probe/tools.ts       git, docker/podman (+rootless), python ≥3.12, node, bwrap, WSL, uv
              ├── runtimes/detect.ts   locate binary → `--version` → compare with runtimes/pins.ts
              │      └── runtimes/matrix.ts  compat matrix → RuntimeCapabilities (ADR-0008)
              ├── runtimes/selftest.ts opt-in loopback server auth checks / --help checks
              └── probe/sandbox.ts     ADR-0007 profiles this host could offer
           probe/report.ts  ProbeReport Zod schema (single output contract)
           probe/format.ts  human table
system/types.ts   injectable System interface (exec, spawnServer, fs, os, env, http, ports, random)
system/node.ts    real implementation (only module that touches node:child_process / fs / os / net)
```

All OS and process interaction goes through `System`. Unit tests use an in-memory fake, so Windows-specific logic (PATHEXT, `.cmd` shims, `taskkill`, `wsl`, `python` vs `python3`) is tested on any OS. One smoke test runs the real probe on the CI/developer host and validates the output against `ProbeReport`.

## Decisions

1. **Binary lookup is a pure PATH walk**, not `which`/`where`. Same algorithm on all OSes (PATHEXT on Windows), testable with fakes, no dependency on `which` existing on minimal Linux images. A short list of well-known per-user install dirs (`~/.local/bin`, `~/.opencode/bin`, `%APPDATA%\npm`, …) is searched after PATH because a probe may run from a shell with a minimal PATH. The value of PATH is never printed.
2. **Version gate:** pins live only in `src/runtimes/pins.ts` (comment points at ADR-0012). Version strings are extracted with one semver regex from the documented `--version` output (`claude --version` → `2.1.x (Claude Code)`, `codex --version` → `codex-cli 0.162.1`, `pi --version`, `opencode --version`). OpenHands has no CLI version flag in the docs; we read `importlib.metadata.version('openhands-agent-server')` through the interpreter that owns the `agent-server` console script (sibling `python` in the venv / uv tool dir), then `python3`/`python`/`py -3`.
3. **Capabilities (ADR-0008):** the probe never contract-tests a capability, so every installed runtime reports every capability as `unverified`, with the compat-matrix evidence level (VL/VD/U/W) in the note. A runtime that is not installed reports `unsupported` (absent on this host). A version that differs from the pin adds `pinMismatch` to every note and a `runtime.pin_mismatch` warning. `authenticated` is always `unknown`: the probe never reads credential files or env values.
4. **Self-test (opt-in, `--self-test`):** loopback only, no credentials, no prompts.
   - OpenCode: `opencode serve --hostname 127.0.0.1 --port <free> --pure` with a random `OPENCODE_SERVER_PASSWORD`; `GET /global/health` without credentials must be 401, with Basic `opencode:<secret>` must be 200 (compat/opencode.md §2).
   - OpenHands: `<python> -m openhands.agent_server --host 127.0.0.1 --port <free>` with a random `OH_SESSION_API_KEYS_0` (env, never argv); wait for `/health`; `GET /api/conversations/count` without key must be 401, with `X-Session-API-Key` must be 200; `/server_info` version is compared to the pin (compat/openhands.md §3; route re-verified against 1.54.0 on 2026-10-12).
   - A 200 on the unauthenticated request means the server is **fail-open** → `selftest.fail_open` error.
   - Children get a minimal env allow-list (PATH, temp, locale, Windows system vars) plus an isolated temp `HOME`/XDG/APPDATA, so provider keys in the operator's shell are never inherited and the operator's runtime config is not read or written.
   - Claude Code, Codex, Pi: `--help` must exit 0 with output (their surfaces are stdio / in-process; nothing to bind).
   - Hard timeouts on every exec and every server start. Servers are spawned in their own process group (POSIX, `detached`) and killed as a group (SIGTERM → SIGKILL); on Windows `taskkill /PID <pid> /T /F`. Cleanup runs in `finally` and the temp dir is removed.
5. **Unsupported platforms never crash:** 32-bit arch, an OS outside darwin/linux/win32, or Node < 24 become `error` problems; `host.facts` is then `null` while `host.raw` still shows what was seen. A 64-bit kernel with a 32-bit userland (common on Raspberry Pi OS) is called out explicitly.
6. **Sandbox profiles (ADR-0007):** `container` only on Linux with a reachable Docker/Podman daemon that is not definitely rootful; `runtime-sandbox` lists installed runtimes that ship a native sandbox on this OS (all unverified); `host-restricted` is always offered but marked `ready: false` because the dedicated low-privilege OS user does not exist yet (`p3-sandbox`).
7. **Exit codes:** 0 whenever a report was produced (problems are data), 2 if the probe itself crashed or the arguments were invalid.
8. **Distribution:** `esbuild@0.28.2` (exact) bundles `src/cli.ts` + `@remyral/protocol` sources + Zod into `dist/remyral-worker.mjs`, ESM, `node24` target, shebang. Its postinstall is denied in `pnpm-workspace.yaml` (`allowBuilds: esbuild: false`); the platform binary comes from esbuild's optional dependency.

## Security review

| Risk | Mitigation |
|---|---|
| Secret disclosure in report/logs | No env values, credential files or tokens are read or printed. Self-test secrets are generated per run, passed via env, never logged, discarded. Reported runtime stderr is not included. |
| Opening a reachable agent server | Explicit `127.0.0.1` bind for both servers, random free port, auth verified before anything else; fail-open is reported as an error. Process group killed in `finally`. |
| Inheriting operator credentials into a child | Minimal env allow-list + isolated HOME for self-test children. |
| Runtime outbound traffic during self-test | We send no network requests besides loopback. The runtimes themselves may attempt startup egress (e.g. update/model catalogue checks); `OPENCODE_DISABLE_AUTOUPDATE=1` and `--pure` reduce it. **UNVERIFIED** that they make none. |
| Leftover processes | Group kill / `taskkill /T /F`, hard timeouts, cleanup in `finally`. Windows tree kill is **UNVERIFIED** until `p0-compat-handson`. |
| Hanging probe (e.g. Docker daemon stuck) | Every exec has a timeout and a bounded output buffer. |

## Not in scope

Installing runtimes, pairing, transport, Windows Job Objects (p3-sandbox), contract tests that could promote a capability to `supported` (p3-adapter-contract).

## Rollback

The probe is a standalone, read-only tool with no persistent state; rollback is deleting `apps/worker` and the two doc folders.
