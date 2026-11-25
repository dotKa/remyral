# p6-warm-caches — shared package caches per machine and project

Status: implemented 2026-10-16 (part of [p6-efficiency](p6-efficiency.md)). Decision: [ADR-0029](../adr/0029-shared-package-caches.md).
Migration 0054. Protocol: additive `ASSIGN_JOB.execution.packageCaches`, `CAPABILITIES.packageCaches`,
`workspace.packageCacheMaxBytes` in APPLY_WORKER_CONFIG, worker feature `package-caches-v1`. **Worker release
needed** (the master and console work without it: no cache is handed out, the machine card says "Not reported").

## 1. Problem

Every repository job starts in a fresh worktree with a fresh per-attempt `HOME`, so `npm ci`, `pnpm install`,
`pip install`, `cargo build` and `go build` download everything again — minutes per job on a home connection, and
impossible when the egress allowlist does not include the registries. Git objects are already shared (mirrors);
packages are not.

## 2. What is shared, with whom

One cache directory **per machine and project**, in the worker data dir, outside every workspace:

```
<dataDir>/caches/host/<key>/meta.json        {v, projectId, lastUsedAt}
<dataDir>/caches/host/<key>/{npm,pnpm,yarn,yarn-berry,pip,uv,cargo,go}/
<dataDir>/caches/.trash/                      evicted projects being deleted
```

`<key>` = the first 24 hex digits of sha256(`remyral-package-cache\n` + project id): project ids may contain `:`
(invalid in Windows paths) and a key can never name another project's directory. Every component is created with
`ensureDirInside` (refuses a planted symlink/junction or file; 0700).

A job gets the cache when **all** of these hold (`caches/policy.ts`, first "no" wins, reason logged):

| Rule | Why |
| --- | --- |
| The machine allows caches: local `packageCaches.enabled` (default true) and a limit above 0 | the owner's hard switch; the panel cannot turn it on |
| The project allows them: lease `execution.packageCaches` (`projects.package_caches`, default **on**) | opt-out per project; an older master never sends it → no cache |
| The source is **trusted** (`spec.sourceTrust === 'trusted'`) | an untrusted source never reads or writes a shared cache (poisoning, §5) |
| The profile is a host profile: `host-restricted`, `runtime-sandbox`, `unconfined` | `container` jobs get none (§3) |

Decision on the tiers (the question was "separate cache or none"): **none** for untrusted sources and for every
container job; one tier (`host`) for trusted host-profile jobs. Untrusted sources are already container-only
(ADR-0010 rule 3), so "no cache in containers" also covers them twice.

## 3. Why containers get none

- The container is the isolation boundary for untrusted code and nothing of a container run persists (read-only
  root, tmpfs HOME). A persistent writable host mount would be the first thing that does.
- A separate container-tier cache would only be shared between *trusted* container jobs — today nobody runs
  trusted jobs in containers on purpose (host profiles are faster), and the uid mapping of a writable bind mount
  under rootless Docker/Podman (container uid 10001 → a sub-uid) is unverified on our Linux workers.
- Follow-up if wanted: a per-project container tier mounted at `/home/remyral/.cache` etc. for trusted container
  jobs only, verified on a rootless Podman worker first.

## 4. Environment per package manager (verified against each tool's docs, 2026-10-16)

| Manager | Variables (value = `<project dir>/<manager>`) | Notes |
| --- | --- | --- |
| npm | `npm_config_cache` | content-addressed `cacache`, integrity-checked on read |
| pnpm | `pnpm_config_store_dir`; plus `npm_config_store_dir` when the repo has `pnpm-lock.yaml`/`pnpm-workspace.yaml` | pnpm ≥ 11 reads only `pnpm_config_*`; pnpm ≤ 10 reads `npm_config_*` (npm 11 warns about an unknown `store-dir` env key, hence only for pnpm repos). There is no `PNPM_STORE_DIR` variable. Store and worktree on different volumes → pnpm copies instead of hard-linking (still no download). |
| Yarn classic | `YARN_CACHE_FOLDER` | when the repo has no `.yarnrc.yml` |
| Yarn Berry | `YARN_GLOBAL_FOLDER` (→ `yarn-berry`) | when the repo has `.yarnrc.yml`. Berry replaces `cacheFolder` by `<globalFolder>/cache` while `enableGlobalCache` (default true) is on, and an env `YARN_CACHE_FOLDER` would override a zero-install repo's committed cache folder (its `.pnp.cjs` would then point outside the repo) — so it is never set for Berry repos. |
| pip | `PIP_CACHE_DIR` | |
| uv | `UV_CACHE_DIR` | different volume → uv copies (warns once) |
| Go | `GOMODCACHE` | Go makes the module cache read-only; eviction restores write permission first. `GOCACHE` (build cache) is not shared. |
| Cargo | `CARGO_HOME` = `<attempt sandbox>/cargo-home` | a per-attempt Cargo home whose `registry/index`, `registry/cache` and `git/db` are links (POSIX symlink, Windows junction — no privilege needed) into `<project dir>/cargo/…`. `config.toml`, `credentials.toml`, `bin/` and the extracted sources (`registry/src`, `git/checkouts`) stay per attempt: a shared Cargo config is a code-execution vector (`build.rustc-wrapper`, `target.*.runner`). Not set for `unconfined` (that profile keeps the worker user's own HOME and Cargo config). |

Hints are read from the workspace root before the runtime starts (`workspaceHints`); they only choose variables.

## 5. Sandbox rules (exactly the project dir, nothing more)

- **macOS host-restricted (Seatbelt)**: the project dir is added to the single `allow file-write*` rule and carved
  out of the data-dir read deny; `<dataDir>`, `<dataDir>/caches` and `<dataDir>/caches/host` allow path lookup only
  (`deny file-read-data` on each: no listing). Other projects' caches, the device key and the rest of the data dir
  stay unreadable. Live-tested with `/usr/bin/sandbox-exec` (`apps/worker/test/package-caches.test.ts`: writes its
  own cache; cannot read or plant into another project's cache; cannot list `caches/host`; cannot read the key).
- **Linux/Pi host-restricted, Windows host-restricted**: the host baseline has no per-attempt filesystem
  confinement (documented residual risk of host-native execution, ADR-0007); the runtime runs as the worker user,
  which owns the cache dirs (0700 under the data dir; on Windows the data dir's ACL). Nothing is widened. The usual
  rule applies: without filesystem confinement attempts run one at a time.
- **runtime-sandbox** (Claude Code bwrap/Windows sandbox, Codex sandbox): `SpawnContext.extraWritableRoots` adds the
  project dir to Claude Code `filesystem.allowWrite` and Codex `writableRoots` — the only addition.
- **unconfined**: gets the variables (it can write anywhere the worker user can anyway).
- **container**: the container runner refuses a context that carries a cache (`SandboxRequestError`).

## 6. Size limit and LRU sweep

- Limit: panel `workspace.packageCacheMaxBytes` (Machine → Configuration, "Package cache limit (GiB)"; only for
  `package-caches-v1` workers, otherwise the save is refused with `worker_update_required`), else the local file's
  `packageCaches.maxBytes`, default **10 GiB**; 0 = off and empties the caches.
- Eviction unit: one project's cache. `lastUsedAt` is written when an attempt takes the cache and when it returns
  it. After a return (debounced 30 s), after a configuration change and at start, the worker scans the sizes
  (regular files, symlinks not followed) and removes the least recently used projects **not in use** until the
  total fits. In use is counted in memory, set synchronously before the first await of a grant; an eviction marks
  the project before it renames it, and a grant waits for a running eviction — so a grant never sees a half-deleted
  dir. Removal: rename into `.trash` (atomic), then delete with write permission restored (Go). Leftovers in
  `.trash` are removed on the next sweep.
- A cache failure (I/O error, planted symlink) never fails a job: the job runs without a cache and the worker logs
  why.

## 7. Console and API

- Projects → Execution policy → **Package caches**: checkbox (admins, step-up), the risk sentence, read-only text for
  viewers. `GET /projects/:id/package-caches` (`projects.execution.read`), `PUT` `{enabled}` (`projects.execution.
  write`, step-up, audited `project.package_caches.update` with before/after).
- Machine → Overview → **Package caches** card: used of limit, per project the size per manager, "in use", last use,
  last eviction; link to Configuration for the limit. Data: `GET /fleet/overview` → `packageCaches` (stored from
  CAPABILITIES in `workers.package_caches`; a later CAPABILITIES without it keeps the last report).
- The worker re-sends CAPABILITIES after every sweep (sizes change after jobs).

## 8. Security review

Threats and mitigations (new threat-model row T-SBX-7):

1. **Cache poisoning (main threat).** A job writes a malicious artefact into the cache that a later job of the
   same project then installs and runs (npm lifecycle scripts, a built pip wheel, an extracted Go module, a Cargo
   build script) — bypassing the human review that a pushed branch gets.
   - Untrusted sources: no access at all (read or write). Container jobs: no access.
   - Blast radius: one project on one machine. A trusted job of project A cannot read or write B's cache (Seatbelt
     on macOS; on Linux/Windows the host baseline does not confine files per attempt — the same residual risk as for
     every other path the worker user owns, ADR-0007).
   - Integrity of what is shared: npm (`cacache` sha512 checked on read; lockfile `integrity`), pnpm (content-
     addressed store, `verify-store-integrity`), Cargo (only `.crate` archives, index and git db are shared; crate
     checksums from `Cargo.lock`; extracted sources and the Cargo config never are), Go (`go.sum` verifies downloads;
     **extracted module dirs are not re-verified on use** — `go mod verify` does), pip/uv (built wheels are **not**
     re-verified unless `--require-hashes`). These two are the residual risk, accepted for trusted sources and
     documented in the project setting's text ("a job can change what later jobs of this project install").
   - Controls: project opt-out (admin, step-up, audited), machine hard switch (`packageCaches.enabled: false`), limit
     0 empties the caches; the cache dir is outside the workspace, so nothing in it is ever committed or pushed.
   - Not done (and why): read-only cache + per-job overlay promoted after success (the original plan line) — host
     profiles have no overlay filesystem on macOS/Windows, and a "successful" malicious run would be promoted anyway;
     the integrity checks above are the real defence.
2. **Escaping the cache dir.** Every directory component is created/validated with `ensureDirInside` (no symlink,
   no file, inside the root). The project key is a hash. Eviction renames inside the cache root and deletes with
   `rm` (does not follow symlinks); size scans do not follow symlinks. The Cargo links are created by the worker and
   point into the project dir; an existing different entry is refused.
3. **Secrets.** Nothing secret is written to the cache by the worker; the shared Cargo part excludes
   `credentials.toml`; npm/pnpm/yarn auth stays in `.npmrc`/`.yarnrc.yml`, which are never shared (the attempt's
   HOME is per attempt). The report carries sizes and project ids only — no paths, no file names.
4. **Disk exhaustion.** Bounded by the limit (default 10 GiB) between sweeps; a single run can still write more than
   the limit until it returns (bounded by the per-job file-size limit and `workspace.minFreeBytes` for new jobs).
5. **Data-dir exposure on macOS.** The Seatbelt carve-out opens exactly the project dir (read+write) and three
   lookup-only parents; the live test proves the device key and other projects stay unreadable.
6. **Protocol.** All fields additive; the worker trusts only its own config for the machine switch and limit
   ceiling; `execution.packageCaches` can only *narrow* (absent = no). The master re-validates the stored report
   with the protocol schema before serving it.

## 9. Tests

- `apps/worker/test/package-caches.test.ts`: eligibility matrix (every host profile, untrusted × every profile,
  container, machine/project switches); environment per manager (POSIX, Windows paths, pnpm/Berry hints, Cargo);
  grants (layout, per-project isolation, `:` in ids, untrusted/container/opt-out create nothing, planted symlink →
  no cache, unconfined without Cargo); LRU sweep (order, in-use kept, report, trash emptied, limit 0, read-only Go
  tree, symlinks not followed); Seatbelt profile shape + **live sandbox-exec** test; host runner env injection for
  host-restricted and unconfined, none without a grant.
- `sandbox-container.test.ts`: the container runner refuses a cache context and starts nothing.
- `job-runner.test.ts`: a trusted host job with `execution.packageCaches` gets the grant in its sandbox context and
  `extraWritableRoots`, released at the end; absent/false → none.
- agent-adapters: Claude Code `allowWrite` and Codex `writableRoots` include the dir for runtime-sandbox.
- `managed-config.test.ts`: panel limit over the local value; protocol `messages.test.ts`.
- Master: unit (ASSIGN_JOB field only when allowed; stored report re-validation); integration
  `package-caches.test.ts` (setting default/RBAC/step-up/audit, CAPABILITIES stored → overview) and route coverage.
- Web: card texts and rendering, project section (switch, viewer read-only), overview parsing with/without report.

UNVERIFIED (needs real hardware): Windows junction creation and Go read-only removal on NTFS; Linux bwrap
(`runtime-sandbox`) writing into the cache; real `npm ci`/`pnpm install`/`pip`/`cargo`/`go` runs against the cache
on each OS. Blocking ticket: run one Node + one Python job twice on the Windows worker after the worker release and
check the second run's install time and the Machine → Package caches card.

## 10. Rollback / operations

- Migration 0054 only adds columns (forward-only; an older master ignores them).
- Switch off per project (Execution policy), per machine from the panel (limit 0) or locally
  (`"packageCaches": { "enabled": false }` in the worker config, a hard off). The worker then empties every cache not
  in use at the next sweep.
- Rolling the worker back to a release without the feature leaves `<dataDir>/caches` on disk (unused); delete it by
  hand if needed.
