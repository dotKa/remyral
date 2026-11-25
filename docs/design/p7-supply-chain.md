# Design note: P7 supply chain — pinned deps, SBOM, vulnerability scanning, signed releases, update policy

- **Status:** Implemented
- **Date:** 2026-10-14
- **Backlog:** `p7-supply-chain` (A-SEC-4: "Threat model and external dependency scan reviewed")
- **Builds on:** [p1-cicd.md](p1-cicd.md) (Ed25519 release records over image IDs),
  [p2-signed-updates.md](p2-signed-updates.md) (signed worker releases), [p3-runtime-policy.md](p3-runtime-policy.md)
  (staged runtime upgrades), [p3-sandbox.md](p3-sandbox.md) (runtime images), ADR-0002 (toolchain), ADR-0012 (runtime pins)
- **Threat model:** T-SUP-1 (malicious runtime update), T-SUP-3 (compromised dependency of our code), T-INJ-3
  (malicious dependency added in a PR); review in [threat-model.md §9](../security/threat-model.md)
- **Policy:** [docs/security/dependency-policy.md](../security/dependency-policy.md) (cadence, review rules, emergency path)

## 1. Pinning audit (`scripts/security/pin-audit.mjs`)

One script checks every external input of the build and runs in `pnpm verify` (offline, < 1 s):

| Input | Rule | State found → fixed |
|---|---|---|
| `package.json` (14) | every spec exact or `workspace:*`; `packageManager` exact | already exact (`.npmrc save-exact=true`) |
| `pnpm-lock.yaml` | every resolution has `sha512` integrity, registry only (no tarball/git/directory) | 501/501 ok; pnpm itself is integrity-pinned via `packageManagerDependencies` |
| `pnpm-workspace.yaml` | `minimumReleaseAge` explicit ≥ 1440, `blockExoticSubdeps` not disabled | relied on the pnpm 11+ defaults → **made explicit** (`1440`, `true`) so a default change cannot weaken them |
| Dockerfiles (12) | external `FROM`/`COPY --from` by `@sha256` (ARG defaults resolved); npm installs exact **and `--ignore-scripts`**; pip/uv `==`; `curl`/`wget` followed by `sha256sum -c` in the same `RUN` | `infra/worker/linux/test` and `infra/worker/windows/test` used tags → **pinned** (plus `node-images.sh` for the `--build-arg` overrides of the e2e scripts); the four runtime images ran `npm install -g` **with install scripts and unlocked transitive deps** → **lockfile installs** (§4) |
| compose files (5) | external `image:` by digest | `infra/dev/compose.yaml` used tags → **pinned to the production digests** |
| workflows | every `uses:` by full commit SHA | `actions/checkout@v5`, `actions/setup-node@v5` → **SHA-pinned** (`v5.1.0`, `v5.0.0`, verified with `gh api`) |

`apt-get install` in our images is deliberately not version-pinned: Debian security updates should land on every
rebuild; the result is fixed by the image ID that the release record signs (p1-cicd) and listed by the inspected
SBOM (§2). Locally built images (`remyral/…`, `remyral-…`) are exempt because they are built from pinned bases.

## 2. SBOMs (`pnpm security:sbom` → `dist/sbom/`)

**Tool choice:** pnpm ≥ 11 has a built-in `pnpm sbom` (CycloneDX 1.7, lockfile-only; verified with ctx7 against
the pnpm docs and `pnpm sbom --help` of the pinned pnpm 12.11.2). It needs no new dependency, no download and no
extra binary to trust, so it is preferred over `@cyclonedx/cyclonedx-npm` or syft. (The root script is
`security:sbom` because `pnpm sbom` is the built-in command.)

| File | Content |
|---|---|
| `workspace.cdx.json` | all workspace dependencies, prod + dev (the CI toolchain is supply chain too) |
| `app-{master,web,worker}.cdx.json` | production closure of each deployable (`--filter … --prod`) |
| `image-<name>.cdx.json` | one per image we build (master, web, runtime-base, runtime-{pi,codex,opencode,claude-code}, egress-proxy) or deploy (postgres, redis, traefik, garage, OpenHands agent-server, OpenHands agent-canvas) |
| `manifest.json` | file list with sha256, component count and mode |

Image SBOMs have two modes:

- **declared** (default, CI): pinned base image(s) as `pkg:oci/…@sha256` components + exactly what our Dockerfile
  adds from a lockfile (the app's production closure, or the runtime image's committed `package-lock.json`).
- **inspected** (`--inspect name=localTag` / `--inspect-available`, release time): a locally present image is
  opened with `docker run --rm --network none` (never pulled) and its real content is listed — dpkg status
  (with the Debian *source* package, which is what OSV indexes), Alpine `installed` db (with origin), every
  `node_modules` package and Python `*.dist-info`. This covers the base image's OS layer and the npm bundled
  with Node. The inspection script reads files only; the mode, image ref and image ID are recorded as
  `remyral:*` properties.

Syft/Trivy were not used: they would be a ~100 MB download to trust, and the dpkg/apk/node_modules listing above is
what they would report for these images. Deeper scanners remain an option in the policy (§6 of the policy).

## 3. Vulnerability scanning

1. `pnpm security:audit` = `pnpm audit --prod` (GitHub advisory DB via the registry) **and** `pnpm audit
   signatures` (registry signatures of all 501 installed packages verified).
2. `pnpm security:scan` = `scripts/security/vuln-scan.mjs`: every `*.cdx.json` → distinct packages → OSV
   `querybatch` (npm/PyPI by purl; Debian/Alpine by ecosystem + source package) → advisory details → gate.
   **Why not the osv-scanner binary:** it would be another executable to download, pin and trust; OSV's public
   API is the same database and a ~250-line node script (built-in `fetch`) answers the same question for our
   ecosystems. The workspace SBOM *is* the lockfile, so "OSV scan of the lockfile and of the SBOMs" is one pass.
3. **Gate** (exit 1): any advisory on an npm/PyPI component; an OS advisory **with a fix published for that
   distribution release** (the fix is matched per OSV ecosystem — a fix in Debian 14 does not count for Debian 12);
   an invalid/expired allowlist entry. Unfixed OS advisories are reported (`--fail-on-os-unfixed` to gate them).
4. **Allowlist** `scripts/security/vuln-allowlist.json`: `id` (or alias), optional `package`, optional `sboms`
   globs (accepting a finding for one image never accepts it for another), `reason` (≥ 20 chars), `owner`,
   `expires` (≤ 90 days ahead; expired = failure). Unused entries are warned about.

### 3.1 Findings of the first run (2026-10-14, 18 SBOMs, 913 distinct packages)

| Scope | Result | Action |
|---|---|---|
| Workspace lockfile (493), apps | **0** (`pnpm audit`: 0; OSV: 0) | — |
| Runtime lockfiles (pi 119, claude-code 111, opencode 13, codex 7) | **0** | — |
| npm bundled with `node:24-bookworm-slim` (current upstream digest): brace-expansion 5.0.7 (5), undici 6.27.0 (6), ip-address 10.2.0 (7), tar 7.5.19, http-cache-semantics 4.2.0 (no fix), postcss-selector-parser 7.1.4 — 21 advisories, 10 high | in master, runtime-base/-images, egress-proxy | **fixed** for master and egress-proxy (npm/corepack removed from the runtime images — they run `node` only; verified: node runs, npm gone). **Allowlisted** for `image-runtime-*` until 2026-11-13: npm runs there only at build time (`npm ci` of our lockfile) and inside the sandboxed job container; fix = next node:24 refresh |
| Alpine zlib 1.3.2-r0 (ALPINE-CVE-2026-85091), nghttp2 1.69.0-r0 (ALPINE-CVE-2026-58055) | postgres, redis, traefik, web (nginx) | fixed packages exist but the upstream images at the pinned tags are not rebuilt (registry digest == pinned digest today) → **allowlisted until 2026-10-28**, bump on rebuild |
| Debian 12 OS layer of `node:24-bookworm-slim` | 152 advisories without a Debian 12 fix (curl 26, glibc 23, util-linux 11, openssl 7, …) | informational; recommendation in the threat-model review: move the bases to `node:24-trixie-slim` (Debian 13) in a separate, tested change |
| OpenHands agent-server, agent-canvas, garage | declared only (not present locally; never pulled) | **UNVERIFIED**: inspect on the next pull |

The master image SBOM in this run is *declared*: the locally present `remyral-master:dev` predates the npm removal,
and the master image was not rebuilt here (Docker load limits on the dev machine). The removal itself was verified
on the pinned base image.

## 4. Runtime pins are supply chain (`scripts/security/runtime-pins.mjs`)

- **Lockfile installs for runtime images.** `infra/worker/images/<runtime>/{package.json,package-lock.json}`
  pin the full transitive tree with `sha512` integrity; the Dockerfiles run `npm ci --ignore-scripts` and link the
  binary (OpenCode and Claude Code: the platform binary, as in `Dockerfile.runtimes`; the Claude image now installs
  the Agent SDK pin `0.3.296`, i.e. the same CLI bytes the worker's SDK runs, instead of `@anthropic-ai/claude-code`).
  All four images were rebuilt (linux/arm64) and report the pinned versions (`pi 1.1.0`, `codex-cli 0.162.1`,
  `opencode 1.19.0`, `2.1.296 (Claude Code)`).
- **`infra/worker/images/runtime-checksums.json`** records the published checksums: npm `dist.integrity` of each
  pinned package, PyPI sha256 of every OpenHands 1.54.0 file, the OpenHands agent-server index digest.
- **Offline check** (in `pnpm verify`): `pins.ts` (imported directly, Node type stripping) ↔ adapter constants ↔
  `@remyral/agent-adapters` SDK dependency and its `pnpm-lock.yaml` integrity ↔ `docs/compat/README.md` §1 ↔
  ADR-0012 decision table ↔ `docs/ops/runtime-setup.md` ↔ runtime image package/lock/Dockerfile ↔
  `Dockerfile.runtimes` ARGs ↔ `runtime-checksums.json`.
- **Online check** (`pnpm security:runtime-checksums`, CI): npm registry integrity of the pins **and of every
  package in the four runtime lockfiles** (platform binaries included), PyPI sha256 of every published file (a new
  unrecorded file fails), ghcr.io digest of the OpenHands tag (a moved tag fails for review).
- **"Runtime-policy defaults":** the master's `default` policy carries no pins; without a policy the worker uses
  `RUNTIME_PINS`. An exported policy can be compared with `--policy <file>` (drift = WARN, as staged upgrades are
  legitimate, p3-runtime-policy §7).

## 5. Signed releases (existing, reviewed)

Worker releases: Ed25519 manifest signatures verified by the worker against pinned keys (p2-signed-updates).
Control-plane deploys: Ed25519 release records over image IDs, verified before every rollout/rollback (p1-cicd).
New here: the SBOM `manifest.json` carries a sha256 per SBOM so a release record can reference it; signing the SBOM
manifest with the release key and attaching it to the record is listed as a follow-up in the policy (§7) because it
changes the deploy record format.

## 6. CI (`.github/workflows/supply-chain.yml`)

Push, PR, weekly schedule (new advisories without a code change) and manual: pins → runtime checksums (online) →
`pnpm audit --prod` + signatures → SBOMs → OSV scan → SBOMs + report uploaded as an artifact (90 days). The
existing `ci.yml` runs `pnpm security:pins` through `pnpm verify` on all four OSes.

## 7. Security review

- **New network access:** the scan and the online runtime check call `api.osv.dev`, `registry.npmjs.org`,
  `pypi.org`, `ghcr.io` with package names/versions only (public data); no credentials, no repository content.
- **Image inspection** runs third-party images with `--network none`, read-only commands, `--rm`; images are never
  pulled by the script. It runs as root *inside* the container (to read package databases) — acceptable for
  images we deploy anyway; never run it on untrusted images.
- **Allowlist abuse:** entries need reason/owner/expiry ≤ 90 days, can be scoped to SBOMs, and are code-reviewed
  (dependency-policy §2: allowlist changes are security-relevant diffs).
- **Residual risks:** OS packages from `apt-get`/the base image are not version-locked (mitigated by digest-pinned
  bases, signed image IDs and inspected SBOMs); `npm install -g pnpm@12.11.2` in the master/web build stages is
  verified only by the registry's integrity (build stage only; the lockfile's `packageManagerDependencies` pin
  pnpm with integrity for developers/CI); OpenHands uv installs (`Dockerfile.runtimes`, hosts) are `==`-pinned
  but not hash-pinned (the online check verifies the published hashes).

## 8. Tests

`scripts/test/supply-chain.test.mjs` (19 tests): repository is fully pinned; each pin rule fails on the pre-fix
inputs (tag-only `FROM`, `actions/checkout@v5`, `npm install -g` without `--ignore-scripts`, ranges, unverified
`curl`, unpinned uv); allowlist validation/expiry/scoping; OCI purls; lockfile components; dpkg/apk/npm/PyPI
inspection parsing; OSV query building, per-ecosystem fix matching, gate rules; runtime pins agree and drift in
pins, checksums or docs is detected; policy comparison.

## 9. Rollback

All changes are additive except the image Dockerfiles: reverting `infra/worker/images/*/Dockerfile` restores the
previous `npm install -g` builds; reverting the master/egress Dockerfile lines restores npm in those images. The CI
workflow can be disabled without affecting `ci.yml`; `pnpm security:pins` can be removed from `verify`.
