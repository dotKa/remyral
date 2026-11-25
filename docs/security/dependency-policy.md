# Dependency and supply-chain policy

- **Applies to:** every external input of the build and of the fleet — npm packages (workspace and runtime
  images), container images, GitHub Actions, the pnpm/Node toolchain and the five agent runtimes
- **Owner:** the project owner (approves dependency changes and allowlist entries)
- **Design:** [docs/design/p7-supply-chain.md](../design/p7-supply-chain.md) · threat model T-SUP-1/3, T-INJ-3
- **Date:** 2026-10-14

## 1. Pinning rules (enforced by `pnpm security:pins`, part of `pnpm verify`)

1. Every dependency is an **exact version** (`.npmrc save-exact=true`); `workspace:*` for internal packages.
2. `pnpm install --frozen-lockfile` everywhere (CI, Dockerfiles). Every lockfile entry carries a `sha512` integrity
   and comes from `registry.npmjs.org` (`blockExoticSubdeps: true`).
3. **Minimum release age 24 h** (`minimumReleaseAge: 1440`): a version younger than a day is not resolved.
   Exceptions go to `minimumReleaseAgeExclude` with an exact version, only for an emergency patch (§4) or a
   deliberately reviewed toolchain bump, and are removed at the next routine update.
4. Container images by `@sha256` digest (multi-arch index), Actions by full commit SHA with the tag in a comment.
5. npm installs inside images use a committed lockfile (`npm ci --ignore-scripts`); install scripts stay off
   (`allowBuilds` in `pnpm-workspace.yaml` lists the packages whose build scripts are *refused*).
6. Downloads in Dockerfiles are verified with a pinned `sha256sum -c` in the same `RUN`.

## 2. Review rules for dependency changes

A diff that touches any of the following is **security-relevant** and needs the owner's explicit review
(T-INJ-3: agents must not add dependencies unreviewed; for agent branches the git-flow review flags
manifests, lockfiles, Dockerfiles, compose files and CI config — `apps/master/src/gitflow/flags.ts`):
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, any `Dockerfile*`, compose files,
`.github/workflows/*`, `infra/worker/images/**`, `packages/protocol/src/runtime-pins.ts`,
`scripts/security/vuln-allowlist.json`.

For every **new** dependency the reviewer checks: it is necessary (node built-ins preferred, AGENTS.md), it is
maintained, its install scripts (refused by default), its transitive tree in the lockfile diff, and that the
package name is the intended one (typosquatting). For **updates**: changelog/breaking changes, lockfile diff
limited to the intended packages, `pnpm security:scan` passes.

## 3. Update cadence

| What | Cadence | How |
|---|---|---|
| npm dependencies (workspace) | monthly, plus on any gating advisory | bump exact versions, `pnpm install`, `pnpm verify`, `pnpm security:sbom && pnpm security:scan` |
| Base images (node, nginx, postgres, redis, traefik, garage) | monthly, and when an allowlisted OS advisory has a rebuilt upstream image | resolve the tag's current index digest (registry `HEAD …/manifests/<tag>`), replace the digest everywhere (`pnpm security:pins` finds misses), rebuild, inspected SBOM + scan |
| GitHub Actions | quarterly | `git ls-remote --tags` → commit SHA, keep the tag comment |
| pnpm / Node | with the Node LTS minor releases | `packageManager`, `.nvmrc`, Dockerfile `PNPM_VERSION`, node image digest |
| Agent runtimes | per [p3-runtime-policy.md §7](../design/p3-runtime-policy.md) (canary worker first) | update `pins.ts`, adapter constants, docs/compat, ADR-0012, `infra/worker/images/<rt>/` lockfile (`npm install --package-lock-only --ignore-scripts --save-exact <pkg>@<ver>`), `runtime-checksums.json`; keep the old pin installable for rollback by moving its lock to `infra/worker/runtimes/<rt>/previous/` (+ `version.txt`); regenerate the worker's install set (`node scripts/security/runtime-install-manifest.mjs --write`, p5-remote-ops); `pnpm security:pins && pnpm security:runtime-checksums` |
| Scheduled scan | weekly (CI `supply-chain` workflow) | a new advisory fails the scheduled run → triage within the SLA below |

Updates are deliberate, reviewed changes on this cadence; there is no automated update bot (Dependabot, Renovate):
several pins must change together (runtime pins, checksums, docs tables, image lockfiles, the worker's install set),
which `pnpm security:pins` checks and a bot cannot do.

## 4. Triage SLA and emergency patch path

| Severity of a gating finding | Fix or allowlist within |
|---|---|
| critical, or known exploited | 24 h (emergency path) |
| high | 7 days |
| moderate / low / OS with fix | 30 days (next routine update at the latest) |

**Emergency path** (critical advisory or a compromised package/runtime release):

1. Stop exposure first: for a runtime, roll the runtime policy back / disable the runtime (p3-runtime-policy);
   for the control plane, roll back to the previous signed release (docs/ops/cicd.md) if the deployed version is
   affected.
2. Patch on a branch: bump to the fixed version (add a time-boxed `minimumReleaseAgeExclude` entry if the fix is
   younger than 24 h — note it in the PR), or, if no fix exists, a pnpm `overrides` entry to a safe version.
3. `pnpm verify`, `pnpm security:sbom && pnpm security:scan`, owner review, deploy through the normal signed
   release path (never by hand on the host).
4. Record the incident in the audit log / CHANGELOG; remove the exclude entry at the next routine update.

## 5. Allowlist (`scripts/security/vuln-allowlist.json`)

Only when the finding is not exploitable in our use, or no fixed version exists yet. Every entry: advisory `id`
(or alias), `package`, `sboms` scope where the finding is image-specific, `reason` (why not exploitable / what we
are waiting for), `owner`, `expires` ≤ 90 days ahead. Expired entries fail the gate; unused ones are removed.
Allowlist changes follow §2.

## 6. SBOMs and evidence

`pnpm security:sbom` writes CycloneDX 1.7 SBOMs to `dist/sbom/`; CI keeps them 90 days as an artifact. Before a
control-plane release run `node scripts/security/sbom.mjs --inspect master=<built tag> --inspect web=<built tag>`
and `pnpm security:scan` against the images that will be deployed. Deeper image scanners (syft/grype, trivy) may
be added later as pinned container images; they are not required by this policy.

**OpenHands on worker hosts** — removed with OpenHands ([ADR-0023](../adr/0023-remove-openhands.md)); no Python
package set is installed on workers any more.

## 7. Follow-ups (not yet implemented)

- Sign the SBOM `manifest.json` with the release key and reference its hash from the control-plane release record.
- Move the Node base images from Debian 12 (bookworm) to Debian 13 (trixie): removes most of the 152 unfixed
  Debian 12 advisories reported today (needs a full image + worker installer re-test).
