# ADR-0029: Shared package caches per machine and project, outside the workspace

- **Status:** Accepted
- **Date:** 2026-10-16
- **Deciders:** owner (p6-efficiency plan "hepsini planlayalım ve tamamlayalım"); implemented by `p6-warm-caches`
- **Amends:** ADR-0007 ("the attempt worktree is the only writable project path") for one more writable path on host
  profiles: the project's package cache dir.
- **Related:** docs/design/p6-warm-caches.md (design + security review), docs/design/p6-efficiency.md, ADR-0010
  (untrusted sources run only in containers), ADR-0015 (panel-managed configuration, local ceiling), ADR-0019
  (unconfined), threat model T-SBX-4 / T-SBX-7.

## Context
Every repository job re-downloads its dependencies (npm, pnpm, Yarn, pip, uv, Cargo, Go) into a fresh per-attempt
HOME. That costs minutes per job and fails outright when the egress allowlist does not include the registries. A
shared cache is the obvious fix, but it is a persistent, writable path shared between jobs: whatever one job writes
into it, a later job may install and execute (cache poisoning), without the human review a pushed branch gets.

## Decision
1. **One cache per machine and project**, in `<dataDir>/caches/host/<sha256 key>/<manager>/`, never inside a
   workspace. A grant names exactly that one directory.
2. **Only trusted sources on host profiles** (`host-restricted`, `runtime-sandbox`, `unconfined`) get it, and only
   when the project allows it (`projects.package_caches`, default on, lease `execution.packageCaches`; absent = no)
   and the machine allows it (local `packageCaches.enabled`, a hard off switch; limit above 0).
3. **Untrusted sources and every container job get no cache at all** — no separate tier. (A container tier for
   trusted container jobs is a possible follow-up after a rootless-Podman verification.)
4. **The sandbox opens exactly the project dir**: Seatbelt write allow + read carve-out (parents lookup-only); the
   runtime's own sandbox (`allowWrite` / `writableRoots`) adds it; the container runner refuses a cache context.
   Linux/Windows host baselines are unchanged (no per-attempt filesystem confinement, ADR-0007 residual risk).
5. **Package managers are pointed at it by environment only** (`npm_config_cache`, `pnpm_config_store_dir` [+
   `npm_config_store_dir` for pnpm repos], `YARN_CACHE_FOLDER` or for Berry repos `YARN_GLOBAL_FOLDER`,
   `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GOMODCACHE`, and a per-attempt `CARGO_HOME` whose registry index/cache and git
   db link into the shared dir). No configuration file is shared — Cargo's `config.toml`/`credentials.toml`/`bin`
   and every `.npmrc` stay per attempt.
6. **Size limit per machine** (panel `workspace.packageCacheMaxBytes`, else local `packageCaches.maxBytes`, default
   10 GiB) with LRU eviction per project, never of a project in use.

## Alternatives considered
- *Read-only shared cache + per-job writable overlay, promoted after a successful job* (the first p6-efficiency
  sketch): no overlay filesystem for host profiles on macOS/Windows, and a malicious run that succeeds is promoted
  anyway. Rejected; the package managers' own integrity checks plus trust/profile/project scoping are the defence.
- *One machine-wide cache for all projects*: larger blast radius for poisoning; rejected.
- *A separate cache tier for untrusted/container jobs*: would persist state of untrusted code on the host and needs a
  writable bind mount (unverified uid mapping). Rejected in favour of "none".
- *Sharing `CARGO_HOME` wholesale*: shares `config.toml` (rustc-wrapper/runner = code execution) and credentials.
  Rejected.

## Consequences
- Faster repeat installs on host workers; offline installs from a warm cache work where egress is restricted.
- Residual risk, accepted for trusted sources and stated in the console: built pip/uv wheels and extracted Go
  modules are not re-verified on use, so a job can influence what later jobs of the same project install. Admins can
  switch caches off per project (step-up, audited) or per machine.
- Worker release required; the master/console degrade gracefully (no cache handed out, "Not reported").
- New disk use on workers, bounded by the limit between sweeps.

## Verification
- Unit + live Seatbelt tests in `apps/worker/test/package-caches.test.ts` (eligibility, isolation between projects,
  untrusted/container get nothing, LRU, sandbox rules), container refusal, job-runner wiring, adapter sandbox roots,
  master integration test for the setting and reports.
- On hardware (open): the Windows worker's second Node/Python job reuses the cache; the machine card shows it.
