# Design note: local CI/CD to the control-plane host (P1)

- **Status:** Implemented (local path; GitHub Actions path documented in docs/ops/cicd.md §7)
- **Date:** 2026-10-13
- **Backlog:** p1-cicd (A-SEC-6 with p7-docs); feeds p7-supply-chain
- **Decisions applied:** ADR-0002 (toolchain), deploy-coolify.md (compose bundle, env namespacing),
  p1-backups (pre-deploy backup, restore for rollbacks across migrations)
- **Threat model:** T-OPS (bad deploy / data loss), supply chain (p7-supply-chain)

## 1. Constraints

No GitHub repository, no registry, no Coolify resource: images are built on the EC2 host from an rsynced
tree and started with `docker compose -p remyral-<env>`. The owner runs deploys from a Mac over the
deploy host's SSH alias (`REMYRAL_DEPLOY_HOST`). Migrations are forward-only and an older master refuses a newer schema.

## 2. Decisions

| Concern | Decision | Why |
|---|---|---|
| Shape | One Node script (`deploy.mjs`, I/O only) + a pure module (`plan.mjs`) | All decisions are unit-testable without a host; the dry run uses the same code path as a real run (each step prints its command and is skipped). |
| Release identity | tag = 12-char commit sha; clean tree required | Same scheme as the first manual deploy; a tag names exactly one tree; never `latest`. |
| What is shipped | `git archive` of the commit → rsync to `/opt/remyral-src-<tag>` | Only tracked files reach the host (no `.env`, secrets, `node_modules`); one directory per release keeps the matching compose file for rollback. |
| Image pinning | `release.env` sets `REMYRAL_*_IMAGE=sha256:<id>`, passed as a second `--env-file` after `stack.env` | IDs are immutable (tags can be re-pointed); no edit of `stack.env` (secrets) is ever needed; Compose accepts image IDs (checked locally). |
| Rollout | `up -d --wait --no-deps master web`; migrate first via `run --rm migrate` | An app deploy never recreates Postgres/Redis (e.g. when the compose file adds an env var to `postgres`); `--infra` does that deliberately. |
| Health gate | container health + running image ID == signed ID + smoke curls through Traefik from the host (deploy-coolify.md §6) | Proves the new containers serve real traffic through the real proxy, not just that a process started. |
| Rollback | automatic only when the schema did not advance; otherwise hold with instructions | Rolling images back over a migration would crash-loop ("downgrade refused"); a DB restore is a human decision. |
| Pre-deploy backup | required when migrations are pending (unless `--skip-backup`) | Makes "restore then roll back" possible. |
| Signing | Ed25519 release record over image IDs (+ commit, env, schema) by the owner's key; verified before every rollout/rollback | cosign needs a registry digest for its normal flow and is not installed; this gives the achievable assurance for host-built images (docs/ops/cicd.md §4). |
| Retention | keep current + newest healthy releases up to N=3 per environment; prune images + source dirs not protected by any environment | Bounded disk on a small host; staging's releases are never pruned by a prod deploy. |

**Approval policy (AGENTS.md rule 10).** A deploy happens only when the owner runs the script (that is the
human approval); the only automatic action is restoring the release that was running before, and only
when no migration ran. Production in the GitHub Actions version requires an environment reviewer
(cicd.md §7). Agents never run `deploy.mjs` against production on their own.

## 3. Security review

- **Secrets**: the script never reads `stack.env`/`secrets/`; nothing secret is printed; the signing key stays
  on the Mac (0600 enforced). The shipped tree is `git archive` output (tracked files only).
- **Command construction**: every remote command is an argv joined with POSIX single-quoting (`shq`);
  tags, env names and image IDs are validated by regex before use; `rm -rf` only for paths matching
  `/opt/remyral-src-<12 hex>`.
- **Integrity**: release records are signed; the host can't forge them; tampering is detected at rollout,
  rollback and `status` (tests cover edited payload, substituted image, untrusted key).
- **Limits (accepted)**: a host compromised before the build can poison images — only off-host builds fix
  that (§7 of cicd.md). The deploy state file on the host is bookkeeping, never trusted for signatures.

## 4. Rollback of this change

The script is additive. To deploy by hand again, follow deploy-coolify.md §6 with
`--env-file /data/remana/<env>/deploy/release.env` added, or delete that file to fall back to the image
variables in `stack.env`.
