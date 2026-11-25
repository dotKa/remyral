# CI/CD: deploy, release channels, image signing, rollback

Covers `p1-cicd` (acceptance A-SEC-6 together with p7-docs). Design rationale:
[docs/design/p1-cicd.md](../design/p1-cicd.md).

**CI.** The repository's GitHub Actions run on every push and pull request: `.github/workflows/ci.yml`
(`pnpm install --frozen-lockfile`, a dev stack, `pnpm verify`, `pnpm build`, a secret scan of the history) and
`.github/workflows/supply-chain.yml` (runtime pins and checksums, dependency audit, SBOM, image scan; also on a
schedule). CI does not deploy.

**Deploy.** Deployment is run by the operator from a machine that can reach the deploy host over SSH
(`scripts/deploy/deploy.mjs`). Nothing about the target is built in: the host comes from `--host` or
`REMYRAL_DEPLOY_HOST`, the console domains from `REMYRAL_DEPLOY_DOMAIN_PROD` / `REMYRAL_DEPLOY_DOMAIN_STAGING`;
a missing value stops the script before anything changes. §7 describes how the deploy itself could move into
GitHub Actions.

| File | Purpose |
|---|---|
| `scripts/deploy/deploy.mjs` | `deploy` / `rollback` / `status` / `keygen`; all I/O (git, ssh, rsync, docker on the host). |
| `scripts/deploy/plan.mjs` | Pure decisions: env layout, tag rules, rollback decision, prune list, health gate, record signing. |
| `scripts/test/deploy-plan.test.mjs`, `deploy-dry-run.test.mjs` | Unit tests of the planning logic + offline dry runs (no host contact, asserted). |

## 1. One-time setup (owner)

```sh
node scripts/deploy/deploy.mjs keygen --out ~/.config/remyral     # deploy-signing.pem (0600) + .pub
```

Keep `deploy-signing.pem` on the workstation and in the password manager (it never goes to the host). The deploy host
(`--host` / `REMYRAL_DEPLOY_HOST`, usually an SSH alias in `~/.ssh/config`) must work non-interactively
(`ssh <host> true`); the script always opens fresh connections (`ControlMaster=no`, `ControlPath=none`,
`BatchMode=yes`) — see [deploy-coolify.md §10](deploy-coolify.md#10-host-perimeter-and-access), SSH notes. The
pre-deploy backup needs `remyral-backup@<env>.service` (docs/ops/backups.md §5); without it, a deploy that
applies migrations is refused (override: `--skip-backup`).

## 2. Deploy

```sh
git status                       # must be clean; the release tag is the commit
node scripts/deploy/deploy.mjs --dry-run            # prints every step and command; reads state only
node scripts/deploy/deploy.mjs --verify             # pnpm verify first (needs the dev stack), then deploy
REMYRAL_ENV=staging node scripts/deploy/deploy.mjs   # staging: remyral-staging, /data/remyral/staging, staging domain
```

Steps (numbered exactly like the output):

1. **Preflight**: clean tree; tag = `git rev-parse --short=12 HEAD` (same scheme as the first manual deploy,
   e.g. `71a8691f0850`); `--verify` runs `pnpm verify`; signing key loaded (0600 enforced); SSH check.
2. **State**: `/data/remyral/<env>/deploy/releases.json` (both environments, for pruning). On the first run
   the release started by hand (deploy-coolify.md §6) is **adopted**: its running image IDs are signed and
   recorded with `/opt/remyral-src` as its source, so it is a valid rollback target.
3. **Ship**: `git archive <commit>` (tracked files only — no `.env`, secrets or `node_modules`) → rsync to
   `/opt/remyral-src-<tag>/` on the host, plus `.remyral-commit`.
4. **Build on the host**: `docker build` for `remyral-master:<tag>` and `remyral-web:<tag>` with OCI labels
   `revision=<commit>`/`version=<tag>`. An image already built from the same commit is reused (`--rebuild`).
5. **Record + sign**: image IDs (`sha256:…`) → release record `{env, tag, commit, images, migrations, builtAt,
   host}` signed with Ed25519 → `/data/remyral/<env>/deploy/records/<tag>.json` (+ local copy in
   `~/.local/state/remyral/deploy/<env>/`).
6. **Verify before rollout**: re-inspect the IDs on the host and verify record + signature.
7. **Pre-deploy backup** (`systemctl start remyral-backup@<env>`; blocks until uploaded).
8. **Migrate**: `release.env.next` pins `REMYRAL_MASTER_IMAGE`/`REMYRAL_WEB_IMAGE` **by image ID**, then
   `docker compose … --env-file stack.env --env-file release.env.next run --rm migrate`.
9. **Roll** `master` + `web` with `up -d --wait --no-deps` (Postgres/Redis are never recreated by an app
   deploy; infrastructure changes to those services need `--infra`).
10. **Health gate** (retries ~60 s): both containers `healthy`, running exactly the signed image IDs, and from
    the host through Traefik: `/api/auth/session` → 401, `/` serves the console, `/api/healthz` → 404.
11. **Keep** (`release.env.next` → `release.env`, state updated) or roll back (§5), then **prune**.

Compose invocation used for every step (both env files; the later one wins):
`docker compose -p remyral-<env> --project-directory /opt/remyral-src-<tag> --env-file /data/remyral/<env>/stack.env --env-file /data/remyral/<env>/deploy/release.env -f /opt/remyral-src-<tag>/infra/coolify/compose.yaml …`
— use the same for manual operations (`ps`, `logs`) so the pinned images are kept.

## 3. Release channels

| Channel | Environment | What gets there |
|---|---|---|
| staging | `REMYRAL_ENV=staging` (`console-staging.example.org`, own secrets/volumes) | any clean commit |
| production | `REMYRAL_ENV=prod` | a commit that ran on staging |

Promotion = deploying the **same commit** to prod: the images are reused (same image IDs as staging — the
build step skips because the revision label matches), so production runs bytes that were exercised on
staging. Each environment has its own signed record. Worker releases have their own channels
(stable/canary, docs/ops/worker-updates.md).

## 4. Image signing — what it does and does not assure

The host builds the images, so a signature can only attest **what the owner's deploy observed**: "image
IDs X/Y were produced on the host from commit C at time T and approved for env E". Verification before
every rollout and rollback (and in `status`) detects: a tag re-pointed to another image after the build,
a record edited on the host, a rollback to an image that was never approved, and an image ID swap in
`release.env` (the gate also checks the running containers' IDs). It does **not** protect against a host
compromised before/during the build (it could poison the build itself) — on a single host that both
builds and runs, nothing can; the real fix is building elsewhere (§7: CI build, registry, keyless cosign
with provenance verified by the host). cosign was not used now: it is not installed, and its normal flow
signs registry digests, which do not exist yet; an Ed25519 record (same construction as worker releases,
scripts/release/sign.mjs) gives the same assurance for local images without new dependencies.

## 5. Rollback

- **Automatic** (during `deploy`): if the gate fails and the schema did **not** change, the previous healthy
  release is verified and rolled back (`release.env` still points to it), then gated again; the new tag is
  recorded `failed`. If migrations ran, an older master would refuse the newer schema
  ("downgrade refused"), so the script **holds**: the new release stays, is recorded `failed`, and the
  command exits non-zero with the instructions — fix forward, or restore the pre-deploy backup
  (backups.md §7) and then `rollback`.
- **Manual**: `node scripts/deploy/deploy.mjs rollback [--to <tag>] [--dry-run]` — only to a healthy
  release still on the host; refused if the database schema is newer than that release expects.
- `status` prints the history and verifies the current record against the host.

## 6. Retention and pruning

Each environment keeps its current release plus the newest healthy ones up to `--keep` (default 3);
images (`remyral-master:<tag>`, `remyral-web:<tag>`) and `/opt/remyral-src-<tag>` beyond that, not protected by
**either** environment, are removed after a successful deploy. Records stay (small; audit trail). The
legacy `/opt/remyral-src` (first manual deploy) is never pruned automatically. BuildKit cache:
`sudo docker builder prune --filter until=168h` when disk gets tight.

## 7. Becoming a GitHub Actions pipeline

A possible next step — the decisions in `plan.mjs` stay; only the I/O moves:

1. **CI on every PR** (`.github/workflows/ci.yml`, in place): `pnpm install --frozen-lockfile`, `pnpm verify`;
   to add: nightly `pnpm e2e:compose`, `pnpm e2e:backup`, `pnpm e2e:fleet`.
   Branch protection: required checks, signed commits, no direct pushes to `main`.
2. **Build once** (`release.yml` on `main`): `docker/build-push-action` for `linux/amd64` with
   `provenance: mode=max` and `sbom: true`, push to a private registry (GHCR or ECR in the prod account)
   **by digest**; sign the digests with **keyless cosign** (GitHub OIDC → Fulcio, entry in Rekor). This
   replaces §4's host-built record: provenance now proves *which workflow on which commit* built the image.
3. **Deploy without SSH keys in CI**: GitHub OIDC → an AWS role allowed only `ssm:SendCommand` on the
   instance with one SSM document that runs the host half of `deploy.mjs` (pull by digest,
   `cosign verify --certificate-identity-regexp '^https://github.com/<org>/<repo>/.github/workflows/release.yml@refs/heads/main$' --certificate-oidc-issuer https://token.actions.githubusercontent.com`,
   backup, migrate, roll, gate, rollback). Compose switches to `REMYRAL_MASTER_IMAGE=<registry>/remyral-master@sha256:…`,
   `REMYRAL_PULL_POLICY=always` (deploy-coolify.md §2). Alternatively a Coolify resource with its deploy
   webhook, image variables set through the Coolify API.
4. **Channels as GitHub environments**: `staging` deploys automatically from `main`; `production` requires a
   reviewer (the owner) and deploys the **digest that passed staging** — never a rebuild.
5. **Secrets**: none in GitHub except the OIDC trust; the host keeps `stack.env`/`secrets/` (backups.md).

## 8. Tests

`pnpm test` runs `scripts/test/*.test.mjs` (Vitest project `scripts`): environment layout, tag rules,
rollback decision (keep / rollback / hold on schema change / no previous), manual rollback target, backup
policy, prune list across environments, state bookkeeping, gate evaluation, record signing (tamper,
substituted image, untrusted key), shell quoting, and offline dry runs of `deploy` (prod and staging) and
`rollback` asserting the exact step order and that neither `ssh` nor `rsync` is invoked.

**Not verified** (no access to the host from this task): a real run against the deploy host, multiple
`--env-file` support of the host's Compose (v2.17+ needed), `docker build` with BuildKit on the host,
the adoption of the manually started release. First real use: `--dry-run` (reads state only), then a
staging deploy.
