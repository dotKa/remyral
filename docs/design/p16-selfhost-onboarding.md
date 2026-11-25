# Design note: `p16-selfhost-onboarding` — installable, upgradable self-hosted product and a first-run wizard

- **Task:** `p16-selfhost-onboarding`. **Date:** 2026-10-23. **Migration:** `0148_selfhost_onboarding.sql` (after
  `0147_doctor`). **Prompt rule:** 47 (46 is p16-doctor). **ADR:** [ADR-0063](../adr/0063-selfhost-distribution-and-update-trust.md).
- **Scope:** single-company self-hosted install (owner direction 2026-10-23), Diyalog UI only.
- **Builds on:** p1-cicd (signed deploy record, health gate, rollback rules), p2-signed-updates (release key and
  signature construction), p10-backup-restore (backup service, restore runbook), ADR-0009 (owner + TOTP),
  p15-autonomy (security presets), p5-worker-onboarding (install commands), p16-doctor (master and worker doctor).
- **Guides:** customer EN [docs/ops/selfhost-install.md](../ops/selfhost-install.md), TR
  [docs/guide/tr/kurulum.md](../guide/tr/kurulum.md); vendor [docs/ops/selfhost-release.md](../ops/selfhost-release.md).
- **Worker release:** needed only for the assistant (prompt rule 47 is compiled into the worker's assistant host). No
  worker protocol change.

## 1. Pieces

| Piece | Where |
| --- | --- |
| Release tool (images, bundle, feed, verify) | `scripts/release/control-plane.mjs`, pure logic `control-plane-lib.mjs` |
| Installer / upgrader (bash; published as `install.sh` and `remyral-ctl`) | `infra/selfhost/remyral-ctl` |
| Traefik overlay for a plain Docker host | `infra/selfhost/compose.selfhost.yaml` (+ `infra/coolify/compose.yaml`) |
| First owner: setup token | `apps/master/src/setup/*`, CLI `setup:token`, web `/setup` (`diyalog/auth/setup.tsx`) |
| Setup wizard | `apps/master/src/onboarding/*`, web `/onboarding` (`diyalog/onboarding/*`) |
| Update feed + banner | `apps/master/src/updates/*`, web `DyServerUpdateBanner` |
| Host doctor | `apps/master/src/cli/doctor.ts` (`remyral-master doctor`), `remyral-ctl doctor` |

## 2. Release and trust

See ADR-0063. Manifest (`remyral-control-plane/v1`, pretty JSON — `remyral-ctl` reads it line by line *after* the
signature verified and validates every value): `version`, `channel`, `commit`, `createdAt`, `images.{master,web,backup}`
(`repo@sha256:…`), `minWorkerVersion`, `migrationsHead`, `minUpgradeFrom?`, `breaking[]`, `requirements`,
`trustedKeys[]`, `files{name: sha256}`. Feed: `releases[]` newest first with `summary` (≤ 300 chars, the first notes
line) and `notes` (≤ 8000 chars of the CHANGELOG section). The release key is the vendor's offline Ed25519 key
(`sign.mjs keygen`); the same key may sign worker and control-plane releases (different domains).

## 3. First owner

`remyral-ctl install` → after the health gate, if `users` is empty: `docker compose exec -T master remyral-master
setup:token` prints `rst_<32 base32>` on stdout (only that), stored as SHA-256 in `setup_tokens` (24 h, single use, a
new one withdraws the unused one, refused once any account exists). The installer shows it once with the URL
`https://<domain>/setup`. `POST /setup/owner` (public, 10 / 15 min per address, fails closed without Redis) checks the
username / password policy, takes an advisory lock, re-checks "no account", consumes the token and creates role
`owner`; audited `user.create` (actor `system:setup-token`) + `setup.token.claim` (denials too). The owner signs in
normally and must enroll the authenticator. `remyral-ctl setup-token` issues a new token while no account exists.

## 4. Update feed and banner

Master config: `REMYRAL_VERSION` (release.env), `UPDATE_FEED_URL` (stack.env, the bundle's release URL unless
`--no-update-check`), `UPDATE_FEED_FILE=/run/remyral-update/feed.json` (host dir `<data>/update`, written by
`remyral-ctl upgrade --check` — daily systemd timer installed by the installer), `CONTROL_PLANE_RELEASE_KEYS`
(trusted keys). `UpdateFeedService`: URL every 6 h (10 s timeout, no redirects, ≤ 1 MiB), file every 5 min; the
verified feed with the newer `generatedAt` wins, the last good one stays on failure (`error`: `unreachable`,
`unknown_key`, `bad_signature`, `malformed`, `too_large`). `GET /updates/status`, `POST /updates/check`
(`updates.read`, owner). Web: owners see "Güncelleme mevcut: Remyral x.y.z — <summary>" in the shell; "Notlar" shows
notes, breaking changes, the worker floor and `sudo remyral-ctl upgrade --to x.y.z`; "Bu sürüm için gizle" per version
(localStorage). Never automatic.

## 5. Setup wizard

`onboarding_state` (one row): organisation name, the owner's marks per step (`done` / `skipped`), `completed_at`. An
installation that already had accounts when 0148 ran is recorded as completed (owners of running systems never see
it). Facts are derived on read: `account` = the caller's TOTP enrolled, `machine` = an approved, not revoked / archived
worker, `git` = a GitHub App connection or a GitLab / Bitbucket connection, `project` = a project created by someone
(the seeded `genel` / `machines` workspaces do not count), `sample_job` = any SUCCEEDED job. Routes (`onboarding.manage`,
owner, no step-up — sensitive steps use their own routes and codes): `GET /onboarding`, `PUT /onboarding/organisation`,
`PUT /onboarding/steps/:step`, `POST /onboarding/complete`, `POST /onboarding/reopen`; all audited.

Web `/onboarding` (`?step=<id>` opens a step; without it the resume point):

| Step | URL | Shows / does | Done when |
| --- | --- | --- | --- |
| account | `/onboarding?step=account` | account + recovery-codes reminder, link to Ayarlar → Profil | detected (TOTP) |
| organisation | `?step=organisation` | name field → `PUT /onboarding/organisation` | name saved |
| security | `?step=security` | Serbest / Dengeli / Sıkı cards with the security catalog's plain explanations, "Şu an seçili"; choosing one = `PUT /security/policy {preset, resetOverrides}` with the authenticator code, then marks done | mark |
| machine | `?step=machine` | `GET /installers`: download + run command per OS (Linux / macOS / Windows) with copy; no release → how to upload one; link /machines/add | detected (approved machine) or mark |
| git | `?step=git` | links to Ayarlar → Entegrasyonlar (GitHub tab, GitLab / Bitbucket tab) | detected or mark |
| integrations | `?step=integrations` | links: Coolify / Cloudflare (ops tab), SMTP (Ayarlar → Bildirimler) | mark / skip |
| project | `?step=project` | link to Projeler | detected or mark |
| sample_job | `?step=sample_job` | the "README özetle" prompt → `/jobs/new` prefilled (the owner picks project and machine) | detected (a SUCCEEDED job) or mark |
| done | `?step=done` | "Hazırsın" with links (Sohbet, İşler, Makineler, Ayarlar), "Sihirbazı bitir" → complete | completed |

Every step except `done` has "Bu adımı atla" / "Tamamlandı say" (or "İşareti kaldır" / "Devam"). Pointers: the home
card "Kurulumu tamamla · n/8" and one line on the empty states of Makineler, Projeler and İşler (owners, until
completed). Admins and others: nothing (403 from the routes; the web does not ask).

## 6. Installer / upgrader

`remyral-ctl` (bash 3.2+, `set -euo pipefail`, `umask 077`): commands `install` (default for `install.sh`),
`upgrade [--to V] [--check]`, `rollback [--to V] [--restore-backup ID]`, `status`, `version`, `backup [--reason R]`,
`doctor`, `setup-token`, `uninstall [--purge-data]`; `--dry-run` everywhere it changes something, `--yes` for
non-interactive confirmation (breaking changes, restore, uninstall). Data dir (default `/var/lib/remyral`, 0700):
`stack.env` (0600, passwords generated once with `openssl rand`, never printed), `secrets/` (totp.key, lease-signing.pem
0400 owned by uid 10001), `release.env` (images by digest, version, release tag = commit[:12]), `release/<version>/`
(the verified bundle; three kept), `trust/keys`, `state/{current,history}`, `proxy/` (traefik.yml per TLS mode,
dynamic/tls.yml + certs for an own certificate), `letsencrypt/`, `backups/`, `backup-config/` (`--backup-recipient`
age key), `update/`. Prerequisites: Linux x86_64 / aarch64, root, Docker ≥ 24, compose ≥ 2.24, OpenSSL 3, curl,
memory ≥ 3.5 GiB (8 recommended), free disk ≥ 10 GiB (20 recommended), ports free (`ss`), `--skip-checks` downgrades
failures to warnings. Idempotent: a re-run keeps secrets and choices (stack.env), skips present images, prints no new
token (`--new-setup-token` / `setup-token` for that). Upgrade order and rollback rules: ADR-0063 §5. Doctor: runs
`remyral-master doctor` (p16-doctor checks with database, Redis and environment; exit 1 on errors) through
`compose exec`, a note for releases without it, and `remyral-worker doctor` if a worker is installed on the host.

## 7. Assistant

Rule 47: the wizard routes, the setup token is a server matter, upgrades only on the host (`remyral-ctl upgrade
--check` / `upgrade` / `rollback --restore-backup`), never claim an upgrade happened.

## 8. Security review

- No unauthenticated endpoint can do more than create the first owner with a valid one-time token; the routes refuse
  for good once any account exists (checked inside the locked transaction), so a leaked old token is useless.
- Token never logged or stored in clear; `remyral-ctl` reads it from stdout and prints it once (not into any file).
- Secrets: generated on the host, root-only files, never on a command line (passwords go into compose through the env
  file), never printed (tests assert stdout).
- Supply chain: images by digest from a signed manifest, OpenSSL verification before any change, downgrade refused,
  key rotation only through a verified manifest; the bundle's compose files are hashed in the manifest.
- The master gets no Docker socket and cannot trigger an upgrade; the banner only reads a signed feed.
- Traefik holds the socket read-only (constrained to the project); documented risk (ADR-0063).
- Destructive host steps (restore, purge) need `--yes` or an interactive confirmation; the replaced database is kept.

## 9. Tests and what is unverified

Tests: `scripts/test/selfhost-ctl.test.mjs` (22), `apps/master/test/integration/selfhost-onboarding.test.ts` (9),
`apps/web/test/selfhost-onboarding.test.tsx` (14), `packages/agent-adapters/test/assistant-selfhost.test.ts` (1),
rbac matrix rows. UNVERIFIED: shellcheck (not installed on the dev machine; the suite runs it when present); a real
install on a fresh Linux host (Traefik ACME issuance, Traefik with a read-only root and `cap_drop: ALL`, compose
`--wait` with the overlay, the systemd timer); `buildx --push` multi-arch to GHCR; `remyral-master doctor` inside the
image (built only by the next deploy); the restore path against a real Postgres (the commands are the runbook's §4).
