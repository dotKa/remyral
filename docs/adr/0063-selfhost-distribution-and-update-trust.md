# ADR-0063: Self-hosted distribution — signed control-plane releases, a host-side installer / upgrader, update trust

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** owner (direction 2026-10-23: single-company, self-hosted product), agent
- **Related:** p16-selfhost-onboarding; [design note](../design/p16-selfhost-onboarding.md); ADR-0005 (worker
  identity), ADR-0009 (owner bootstrap), the p1-cicd signed deploy record (docs/ops/cicd.md §4), p2-signed-updates
  (worker releases, scripts/release/sign.mjs), ADR-0039 (backups / standby), ADR-0062 (doctor); migration 0148

## Context

Until now the control plane was deployed only by the vendor onto its own EC2 host (`scripts/deploy/deploy.mjs`: the
tree is built on the host, image IDs are Ed25519-signed, health-gated, rolled back). A customer installs Remyral for one
company on their own Linux host and must be able to install and upgrade it without the repository, SSH access by the
vendor or a default password, and must be able to trust what they pull. The dependency policy pins every external
input; cosign is neither pinned nor installed anywhere (docs/ops/cicd.md §4). The master must never get the Docker
socket (it would make a web vulnerability a host takeover).

## Decision

1. **Release = signed manifest + bundle on any static HTTPS location, images in any OCI registry.** A version
   `x.y.z` publishes `<release URL>/<x.y.z>/{manifest.json, manifest.sig.json, compose.yaml, compose.selfhost.yaml,
   remyral-ctl, install.sh, NOTES.md, INSTALL.md, KURULUM.md}` and a channel feed `<release URL>/feed.json` +
   `feed.sig.json`. The registry is configurable (`--registry`, default design: GHCR under the vendor org,
   `ghcr.io/<org>/remyral-{master,web,backup}`); a customer mirror is supported with `remyral-ctl --registry <prefix>`
   (the digest stays, so a mirror cannot change content).
2. **Signing: Ed25519 with the vendor's offline release key** — the construction of the worker releases and the deploy
   record (context string ‖ exact bytes, `{ keyId, signature }`), new domains `remyral-control-plane-release/v1` and
   `remyral-control-plane-feed/v1`. The manifest names every image **by registry manifest digest**
   (`repo@sha256:…`, multi-arch index), the SHA-256 of every bundle file, the migrations head, the minimum worker
   version, `minUpgradeFrom` and the breaking notes; release notes come from the CHANGELOG section. cosign is not
   adopted now (not pinned; adds a binary to every customer host); provenance attestations from buildx
   (`--provenance=mode=max --sbom=true`) are pushed with the images and can be verified with cosign later without a
   format change.
3. **Verification on the customer host by `remyral-ctl` with OpenSSL ≥ 3** (`openssl pkeyutl -verify -rawin`) — no
   Node, no Python, no new tool. Order: signature → file hashes → pull by digest → the daemon's own digest check →
   compare `RepoDigests`. Any failure stops before anything is pulled or changed.
4. **Update trust model.** The trust root is the published `install.sh` (fetched over HTTPS; its key id is published
   in the guide for an out-of-band comparison). After the first install the trusted keys live in `<data>/trust/keys`;
   every later manifest and feed is verified against **those**, never against keys carried by the new bundle. A
   verified manifest may name `trustedKeys` (rotation: the old key signs a manifest that introduces the new key; up to
   four keys). A downgrade is refused by `upgrade` (only `rollback` to a release still on the host).
5. **The upgrade runs on the host, never from the console.** `remyral-ctl upgrade` = verify → pull → stop the master →
   pre-upgrade backup through the backup service (failure aborts and restarts the master) → migrate → start → health
   gate (healthy containers running exactly the signed images, `/api/status` ok, the console served through the
   proxy) → automatic image rollback when the schema did not change; otherwise **hold** (an older master refuses a
   newer schema) and print `remyral-ctl rollback --to <old> --restore-backup <id>`, a destructive step the owner runs
   deliberately (`--yes`). The master only **reads** the signed feed for the owners' "Güncelleme mevcut" banner
   (`UPDATE_FEED_URL` and/or the copy the host's daily `remyral-ctl upgrade --check` caches, mounted read-only), so a
   master without outbound internet still learns about releases and no master can be tricked into installing one.
6. **Self-hosted proxy:** Traefik (the pinned digest of the Coolify stand-in) in `compose.selfhost.yaml`, routing by the
   same labels as Coolify. Its Docker provider reads the socket **read-only**, constrained to the `remana-prod`
   project; it is the only container with the socket. TLS modes: `letsencrypt` (ACME HTTP-01, entry-point default
   resolver), `cloudflare` (proxied DNS, origin certificate or the default certificate with "Full"), `proxy` (the
   customer's reverse proxy; trusted proxy CIDRs → `forwardedHeaders.trustedIPs`, `TRUST_PROXY_HOPS=2`).
7. **First owner without a shell password prompt:** `remyral-ctl install` asks the master for a one-time setup token
   (`remyral-master setup:token`), prints it once; `/setup` creates the first owner with it (only SHA-256 stored,
   single use, 24 h, refused for good once any account exists, advisory-locked against races, rate-limited); the
   normal first login with mandatory authenticator enrollment follows (ADR-0009 unchanged). `admin:create` stays.
8. **Linux only for the control plane** (x86_64 / aarch64, Docker ≥ 24, compose ≥ 2.24). Windows and macOS are
   supported as worker machines, not as control-plane hosts; the installer refuses them.

## Alternatives considered

- **Keyless cosign (GitHub OIDC → Fulcio, Rekor).** Strong provenance, but requires the build on GitHub Actions
  (the repository is private and builds run on the vendor's machine today), cosign on every customer host, and
  Rekor reachability for verification. Kept as the next step (docs/ops/cicd.md §7); the manifest already pins digests,
  so adding a cosign check later is additive.
- **Signing only the image tags / trusting the registry.** A tag can be moved; a compromised registry account could
  substitute images. Rejected: digests in a signed manifest.
- **Self-update from the console (Docker socket in the master or a privileged updater sidecar).** Turns a console or
  session compromise into code execution on the host. Rejected; the console shows the command.
- **A Node / Go installer binary.** One more artifact to build, sign and trust per architecture; bash + OpenSSL are on
  every supported host. Rejected for now.
- **Traefik file provider instead of the Docker socket.** Avoids the socket but duplicates every route of the
  compose labels (two sources of truth that drift). Rejected for now; a socket proxy can replace the direct mount
  later without changing the routes.

## Consequences

- New vendor step per release: `control-plane.mjs images` (build + push, multi-arch), `bundle`, `feed`, upload of the
  out dir (docs/ops/selfhost-release.md). The release key must be kept offline; losing it means a new install.sh.
- Customers need OpenSSL 3 (Ubuntu 22.04+, Debian 12+, RHEL 9+); older distributions are unsupported.
- A failed upgrade after the schema advanced is not rolled back automatically; the documented restore loses the
  writes made by the new release between the backup and the restore (the master is stopped during backup and
  migration, so only the minutes of the failed start are at stake).
- The Docker socket is mounted read-only into Traefik; a Traefik compromise reads the Docker API (documented risk).

## Verification

- `scripts/test/selfhost-ctl.test.mjs`: the release tool signs real bundles; the published `install.sh` runs against a
  fake Docker and accepts them; a foreign key, a manifest changed after signing, a file that does not match and an
  image without the signed digest abort before any pull; upgrade order (stop → backup → migrate → start), automatic
  rollback, hold + restore, doctor, uninstall.
- `apps/master/test/integration/selfhost-onboarding.test.ts`: setup token (expiry, single use, concurrent claims, hashed,
  closed after the first account), wizard progress, the feed (unknown key, tampered bytes, off-line file copy).
- UNVERIFIED until the first public release: a real run on a fresh Linux host (Traefik ACME, the read-only root of the
  Traefik container, compose `--wait` with the overlay), multi-arch `buildx --push` to GHCR.

## Amendment 2026-10-24: the console's domain from the setup wizard (p17-domain-wizard)

Owner direction 2026-10-24: "kurulumda domaini terminalden setlememi söylüyor. bunu terminale gitmeden kurulum
sihirbazında ayarlayabilmeliyim." Design: [p17-domain-wizard](../design/p17-domain-wizard.md); migration 0151.

1. **The public address is a stored setting.** `console_domain_setting` (owner-editable in Kurulum sihirbazı → Alan
   adı ve erişim) wins over `PUBLIC_ORIGIN` / the origin of `NOTIFY_PUBLIC_URL`, which stay the default. Every link
   builder (install commands, GitHub App callbacks, pull request links, automation / workflow webhook URLs, outgoing
   webhook payload links, notification links, the TLS check, the ops "console host is protected" lists) reads it at
   the moment it builds a link — no restart. Saving is owner-only (`console.domain.write`), step-up event
   `console.domain` (on in Dengeli / Sıkı), audited (`console.domain.set|clear|request|applied|rolled_back|failed|
   refused|expired|cancel`).
2. **A remyral-ctl host applies a new domain without a terminal — still on the host, never by the master.** The
   master gets no Docker socket and runs no host command. It writes a **request** into `<data>/host/requests` (the only
   host path it can write; mounted only by `compose.selfhost.yaml`), Ed25519-signed with its lease-signing key under
   the domain `remyral-host-domain-change/v1` (context ‖ exact bytes, like the release signatures), carrying only data:
   `id`, `nonce`, `domain`, `tls` (`letsencrypt` | `cloudflare` | `proxy`), `email`, `previousDomain`, `createdAt`,
   `expiresAt` (15 min). `remyral-ctl apply-pending`, run as root by a systemd path unit on the request file and a
   one-minute timer the installer sets up, verifies the signature against the public half of
   `<data>/secrets/lease-signing.pem` (the only accepted key), re-validates every field with the rules of
   `remyral-ctl install --domain/--tls/--email`, refuses expired requests, replayed nonces and a `previousDomain` that
   is not the served one, then changes only `REMYRAL_DOMAIN`, `REMYRAL_TLS_MODE`, `REMYRAL_ACME_EMAIL` in stack.env, the
   Traefik static configuration for the TLS mode, and recreates master + web (+ proxy). The previous name keeps
   answering through a Traefik file-provider route to the same services until the new one is healthy (and an hour
   after); the new name must pass the health gate (master / web healthy, `/api/status`, the console through the proxy,
   with Let's Encrypt a publicly trusted certificate) within 5 minutes, else stack.env and the proxy configuration are
   restored and the old name is gated again (`rolled_back`). Results and a heartbeat go to `<data>/host/status`
   (root-owned, read-only for the master); the setting follows only an `applied` result.
3. **Installs without the applier** (Coolify / EC2, routing elsewhere; no heartbeat): saving changes only the setting;
   the wizard says what the platform's operator must route. No terminal command is the primary path any more.

**Threat model (what a compromised master can do with this).** It can sign a request — so it can make the host switch
the console to **another DNS name within the install rules** (a lower-case DNS name, one of the three TLS modes, an
e-mail address of plain characters), and with it the ACME e-mail. It cannot run a command, choose a file, a port, an
image, a mount, a label or a Traefik rule beyond the host name: the host reads only the signed fields, validates each
with a fixed expression before use and writes them through its own templates; the request file is copied as a regular
file only (no symlinks, size-capped), consumed before anything runs, and its nonce is remembered. A switch to a name the
attacker controls already follows from a compromised master today (it can change the stored address, i.e. where links
point); on the host the effect is bounded by the health gate (a name that does not reach this host is rolled back) and
is visible (audit, `remyral-ctl status`, the domain history in `<data>/state/domain-history`). Not mitigated: a
compromised master can keep requesting changes (each needs the 15-minute window and a fresh nonce; the owner sees
them); with the lease-signing key a compromised master could already impersonate the master to workers, so the key adds
no new trust. The applier never trusts the request's `previousDomain` for anything but a staleness check.

Rejected: the master calling the Docker API or a privileged sidecar (the original rejection stands); the host pulling
requests from the master's HTTP API (needs a host credential and the master reachable from the host's root context —
the shared file is simpler and works with the master stopped); an unsigned request file (any process able to write the
directory could change the domain).

## Amendment 2026-10-26: more host request kinds — update, rollback, backups (p17-host-actions)

Owner direction 2026-10-26: "tüm yönetimi panelden sağlayabilmeliyiz … eksiklerin hepsini kapatalım". Design:
[p17-host-actions](../design/p17-host-actions.md); migrations 0160, 0161. Decision 5 ("the upgrade runs on the host,
never from the console") stands: the console now **asks** the host for it.

1. **A closed list of request kinds besides `domain-change`:** `upgrade`, `rollback`, `backup-run`, `backup-drill`,
   `backup-restore`, `backup-config`, `backup-offsite`. Each has **its own signature domain** `remyral-host-<kind>/v1`
   (lease-signing key, context ‖ exact bytes), its own file `requests/<kind>.json` and **a closed set of string fields**.
   `remyral-ctl apply-pending` refuses a request whose shape is anything else (an extra, missing or nested field, a
   quote, backslash or control character, an oversized line or file) before it reads a value; checks the window
   (expiry, at most one hour, not dated ahead), consumes the nonce, re-validates every value with a fixed expression and
   runs only its own code path for the kind. Results go to `status/<kind>-result.json` (state, step, detail, the last
   output lines without any line naming a secret).
2. **Upgrade and rollback run the existing code paths** (`remyral-ctl upgrade --to V`, `rollback --to V
   [--restore-backup ID]`) as a child under the applier's lock: the signed feed, the manifest, the file hashes and the
   image digests are verified again on the host exactly as for an operator; the master's choice of version is only a
   request.
3. **Backup settings are applied by the host into stack.env / backup-config** (not read by the backup service from the
   master), so the backup image keeps trusting only its host files. The off-site keys are stored sealed in the master
   and cross to the host only inside a `backup-offsite` request, which the host writes into `offsite.env` (0600).
4. Owners only; `upgrade` / `rollback` and `backup-restore` need an always-fresh authenticator code (safe-core events
   `host.update`, `backups.restore`); the other backup changes follow the security policy (`backups.manage`). Every
   request and outcome is audited. Without an applier (Coolify / EC2) nothing is written; the console shows what the
   operator runs.

**Threat model — what a compromised master (or a stolen lease-signing key with write access to `<data>/host/requests`)
can do with each kind** (in every case it cannot choose a command, a file path, an image, a registry, a mount, a port or
a Traefik rule: the host builds them from its own templates; the request carries data, never commands):

| Kind | What it can make the host do | Bounded by |
| --- | --- | --- |
| `upgrade` | upgrade to a **newer release that the vendor signed** and that is in the vendor-signed feed (the host verifies with its own trusted keys, never the master's); force past breaking-change confirmation (`acceptBreaking=yes`) | release signature + digests on the host; pre-upgrade backup; health gate with automatic image rollback or hold; downgrade refused |
| `rollback` | go back to a **release still on the host** (signed when installed, verified again); with `restoreDatabase=yes` replace the database with **a backup of this host** — the writes since that backup are lost | the replaced database is kept renamed (`remyral_replaced_<stamp>`), not dropped; the release set on disk; health gate; visible in audit, `remyral-ctl status`, `state/host-history` |
| `backup-run` / `backup-drill` | take a backup / run a drill now (load; disk use within the retention) | a fixed reason slug; the drill restores into a throw-away database inside the backup container |
| `backup-restore` | replace the live database with a backup of this host (data loss since that backup) | as `rollback` with restore: the old database is kept renamed; migrate forward; health gate |
| `backup-config` | change the schedule (≥ 15 min / daily), retention (down to the newest backup), turn drills or WAL archiving off, and **add an encryption recipient it controls** | the runner's ranges (retention never keeps nothing); 2–10 age public keys; existing backups untouched; **an added recipient waits 72 h on the host (time lock, below)**; visible (audit, heartbeat, the Yedekler screen) |
| `backup-offsite` | send **future** off-site copies to a bucket it controls, or turn the off-site copy off | the copies are age-encrypted to the recipients; existing copies stay; **a new target waits 72 h on the host (time lock, below)**; visible (audit, the heartbeat's target) |
| `backup-change-cancel` | withdraw a change waiting for the time lock | can only make the host do less |

~~Not mitigated~~ **Mitigated by a host-enforced time lock (p17-panel-settings Part 0, 2026-10-27).** The most
sensitive pair: with `backup-config` (its own key among the recipients) **and** `backup-offsite` (its own bucket) a
compromised master would receive future backups it can decrypt — the database (which it can read anyway) and the
**secrets archive: stack.env with the database owner / superuser passwords** and the key files. That is more than the
runtime role it has (the owner role could, for instance, disable the audit log's append-only triggers).

**The time lock** (`remyral-ctl apply-pending`, design [p17-panel-settings §2](../design/p17-panel-settings.md)):

- A `backup-config` request that **adds** an encryption recipient, and a `backup-offsite` request that **changes the
  target** (bucket, endpoint, region or access key — or sets a first one), is not applied at once. The host records
  **its own first-seen time** (`date +%s` when it processed the request — never the master-signed `createdAt`) in
  root-owned state (`<data>/state/backup-pending/`, 0700; the off-site keys of a waiting target 0600) and applies the
  change **72 hours** later (`BACKUP_CHANGE_WAIT_S`, a constant — not configurable) on its one-minute run. The result
  file says `scheduled` with "waits until <time>".
- Until then nothing the backup service reads changes: recipients.txt keeps the current set (secrets archives are
  never written with a recipient set that is still waiting) and offsite.env the current target.
- Everything else stays immediate: the schedule, retention, drill and WAL settings, **removing** a recipient (while at
  least two current recipients stay), a prefix / path-style change within the same target, turning the off-site copy
  off. A later request without the addition (or with the current target) withdraws the waiting change ("superseded");
  the same addition again keeps the first-seen time; a new key restarts the wait.
- **Cancel:** a new request kind `backup-change-cancel` (field `change` = recipients | offsite | all; signed under
  `remyral-host-backup-change-cancel/v1` like the others) withdraws a waiting change. It can only make the host do
  less. On the host, `remyral-ctl backup-change show | cancel | confirm` — `confirm` (root) applies at once: the
  operator is the trust anchor the console is not.
- **Visibility:** the heartbeat lists waiting changes (`backup.pending`: change, request id, since, until, the added
  keys or the target without credentials) and the last outcomes (`backup.changes`); the console shows them first and in
  red on Ayarlar → Yedekler with "İptal et", as a never-dismissible row in "Senden bekleyenler", and notifies **every
  owner** in-app and **by e-mail regardless of the per-kind preference** when one appears and again 24 h before it
  takes effect (kind `backup.change_pending`, audited `backups.change.pending|applied|cancelled|superseded`).
  `remyral-ctl status` prints "WAITING … takes effect <time>" with the cancel command.

What is left: a compromised master can also hide the panel notice and suppress the e-mail (it renders the console and
sends the mail), and it can keep re-requesting after each cancel. It **cannot shorten the host's wait** (the time is the
host's, in a directory it cannot write, and a backdated `createdAt` is refused by the one-hour window anyway), cannot
make a secrets archive go to a waiting recipient or target, and cannot hide the change from `remyral-ctl status` or
the host's state files. Owners who suspect the master should check `remyral-ctl status` on the host; the 72 hours are
the window for that. Rejected: a code shown on the host's console (needs a terminal, which is what the panel removes);
a second owner's approval in the console (the same compromised master renders and counts it).

Not mitigated: a compromised master can request these repeatedly (one open request at a time, each audited and shown
to the owners) and can make backups less useful going forward (retention, off-site target). It cannot make the host run
an unsigned release, delete existing backups or the replaced database, or read anything from the host. The lease-signing
key adds no new trust (a master with it can already impersonate itself to workers).

Rejected: a privileged updater sidecar or the Docker socket for the master (decision 5); the backup service reading its
settings from the master (it would make the backup trust the master it backs up); carrying the off-site keys in a
host-readable sealed file encrypted to a host key (no host key pair exists; the 0700 requests directory consumed within a
minute is the smaller change, and the master holds the keys anyway).
