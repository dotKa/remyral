# ADR-0065: Update channel and version catalog — signed worker releases pulled by the master, runtime / tool versions from a separately signed catalog

- **Status:** Accepted
- **Date:** 2026-10-26
- **Deciders:** owner (decision 2026-10-26, approved as proposed), agent
- **Related:** p17-update-channel; [design note](../design/p17-update-channel.md); ADR-0063 (control-plane distribution
  and update trust), p2-signed-updates (worker releases, release key), p16-runtime-updates (unverified runtime
  updates, `fleet.unverifiedRuntimeUpdates`), p13-fleet-tools (the tools matrix), p16-ops-safety (rollout circuit
  breaker), ADR-0012 (runtime pins), ADR-0008 (truthful capabilities); migration 0159

## Context

A customer's self-hosted Remyral (ADR-0063) gets new worker releases only when someone uploads a signed `release.json`
in the console, and new runtime / tool versions only inside a worker release (AGENTS.md rule 12, ADR-0012). Without the
vendor or a terminal the fleet therefore stands still: the owner does not know a release exists, and a runtime that
ships a fix every few days (Claude Code, Codex) is weeks behind. p16-runtime-updates lets the owner install a newer
runtime *unverified*, resolved by the master straight from npm — useful, but every customer then trusts whatever the
registry serves on the day, and tools (git, Python, uv, cloudflared, ffmpeg, the browser) have no such path at all.

The owner decided (2026-10-26): worker releases arrive automatically from the vendor's release location — patch
releases are installed automatically (canary first), minor / major wait for "Güncelle"; runtime and tool versions are
decoupled from worker releases and come from a signed version catalog published weekly by an automated vendor process
under a separate, narrow key; the control plane keeps upgrading on the host (ADR-0063).

## Decision

1. **Worker release feed.** The release location of ADR-0063 also publishes `<release URL>/workers/feed.json` +
   `feed.sig.json` (Ed25519 over `remyral-worker-feed/v1\n` ‖ exact bytes, the **release key**) and every release's
   upload document `<release URL>/workers/<version>/release.json` (unchanged `sign.mjs build` output). The feed lists the
   releases newest first with version, channel, protocol versions, minimum Node, the artifact's SHA-256 / size, the
   SHA-256 / size of `release.json`, a summary and notes, and `catalogKeys` (the catalog public keys the release key
   vouches for, §5).
2. **The master pulls, verifies, imports.** It reads the feed from the URL (default: next to `UPDATE_FEED_URL`) and from
   the copy `remyral-ctl upgrade --check` caches on the host (read-only mount; a master without internet still learns
   about releases and, when the host cached it, gets the bundle). A feed is accepted only when signed by a key of
   `RELEASE_PUBLIC_KEYS` — never a key carried by the feed or the bundle. The newest release is downloaded (https, no
   redirects, size cap, the feed's SHA-256 checked while streaming) and goes through the same path as a manual upload
   (`publishRelease`: manifest signature against `RELEASE_PUBLIC_KEYS`, artifact hash, protocol, signed installer kits),
   audited as the system actor `update-channel`. Importing stores a release; it rolls nothing out by itself.
3. **Rollout policy** (owner setting, Ayarlar → Sürümler → Güncelleme kanalı; owner-only, step-up event
   `releases.publish`): `patch_auto` (default) — a release that differs from the stable channel's version only in the
   patch number is rolled out automatically; minor / major wait for "Güncelle"; `manual` — every release waits;
   `auto` — every release is rolled out automatically. "Güncelle" (`releases.publish`, step-up) starts the same rollout
   for a waiting release. **Canary first:** the machines marked canary (runtime-policy canary flag or update channel
   `canary`) get the version first through system-set targets; when every one of them reported `succeeded` (at least
   one) and the soak time passed (default 30 min) without a breaker hold, the stable channel is promoted to 100 % and the
   targets are cleared. A failed / rolled-back / refused canary stops the rollout (`canary_failed`, owner notified). No
   canary machine: the stable channel is promoted directly (the p16-ops-safety breaker still judges it). Downgrades are
   never automatic. The manual `release.json` upload and `release-import` stay (offline installs).
4. **Version catalog.** A separate document `<release URL>/catalog/catalog.json` + `catalog.sig.json`, Ed25519 over
   `remyral-version-catalog/v1\n` ‖ exact bytes with the **catalog key**: a monotonic `sequence`, `generatedAt`, per
   runtime (Claude Code, Codex, Pi, OpenCode) and per tool (browser, git, Python, uv, cloudflared, ffmpeg, Node) a list
   of exact versions with their integrity — runtimes: the npm root package version + sha512 and the complete lock tree
   (every tarball URL + sha512, the same form as the release's install manifest); tools: per platform the asset URL,
   SHA-256 and size — and a `verified` flag set only after the vendor's contract tests and canary.
5. **What a worker accepts** (the same function in the worker, the master and the vendor tool):
   - signed by a catalog key the worker trusts: compiled into its release (`sign.mjs build --catalog-key`) or the
     root-owned `updates.catalogKeys` (which replaces the compiled list, like `updates.releaseKeys`); never a key the
     master sends;
   - `sequence` greater than the accepted one (the same bytes again are idempotent); not dated in the future;
   - the catalog can change **versions and hashes only**: strict schema (no unknown field, no command, script, path or
     code), every runtime entry's root is the release's own package (`RUNTIME_PINS[rt].package`) at the version that
     brings the runtime version, every tarball URL is exactly `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz`,
     install-script packages only where the release's own lock has them flagged (they never run); every tool asset URL
     must equal the URL the worker code builds for that tool, platform and version (fixed hosts: github.com release
     downloads of the fixed repositories, api.nuget.org, cdn.playwright.dev, nodejs.org);
   - no version below the release's built-in pin (the floor), and no entry lower than the same item in the previously
     accepted catalog unless it is the release pin itself (the way back);
   - when the key that signed the stored catalog is no longer trusted (rotation), the stored catalog is dropped and the
     release pins apply until a catalog of a trusted key arrives (this also resets the sequence).
   Accepted entries are added to the worker's install sets: a **verified** runtime entry becomes the effective pin
   (capabilities as for a release pin, the release pin stays the one allowed way back); an **unverified** entry is
   installable only like a p16 unverified runtime update (the master offers it only while `fleet.unverifiedRuntimeUpdates`
   is on; the install is marked unverified, capabilities stay `unverified`). Tool entries become additional recipes
   (verified ones are the recipe the matrix offers). Nothing is installed or activated by the catalog itself: installs
   stay owner / admin actions (Araçlar ve sürümler "Güncelle", Toplu işlem, canary first). Node is listed for the
   matrix and the installer kits only: the worker never replaces its own Node (p2-signed-updates).
6. **Distribution.** The master reads the catalog like the feed (URL + host cache, `VERSION_CATALOG_KEYS` ∪ the
   verified feed's `catalogKeys`), keeps the newest accepted one (monotonic, exact bytes) and sends it to workers that
   advertise `version-catalog-v1` with the control message `APPLY_VERSION_CATALOG` (bytes + signature, ≤ 384 KiB)
   whenever their CAPABILITIES report an older sequence; the worker answers `VERSION_CATALOG_STATUS`. Behind the
   feature flag `VERSION_CATALOG` (`on` by default, `off` stops reading and distributing). The fleet matrix and
   "Güncelle" use the catalog versions; the release pins stay the floor and the fallback.
7. **Key model.** Release key: offline (vendor's machine / hardware token) — signs worker releases, installer kits,
   control-plane releases, both feeds. Catalog key: online but narrow — kept only by the automated catalog runner
   (0600 file or CI secret), signs only catalogs; generated by `scripts/release/catalog.mjs keygen`. Rotation: a worker
   release (release key) compiles `{old, new}` catalog keys and the feed lists both; catalogs move to the new key; the
   next release drops the old one. Revocation of a stolen catalog key = a patch release without it (installed
   automatically under the default policy) + dropping it from the feed.
8. **Runtime policies: `follow` or `hold`** (amends p3-runtime-policy; owner decision 2026-10-26). Finding on prod
   (2026-10-26): a runtime policy stored each runtime's version at save time (`default` v6 of 2026-10-16 still pinned
   Claude Code 2.1.296 / Codex 0.162.1 / Pi 1.1.0 / OpenCode 1.19.0 with `allowUnpinned: false` after worker 1.1.4
   moved the pins), and workers compare against the applied policy first — so neither a new release nor a catalog
   would ever take effect. A rule now has `pin: "follow" | "hold"`:
   - **follow** (the default): the machine uses its current verified catalog pin, else its release pin. The rule's
     `version` stays in the document only for workers older than this release (they still compare it) and is not
     shown; the saved version keeps matching while it is installed, so no machine stops on an upgrade.
   - **hold**: an explicit version, a deliberate freeze — the catalog and new releases do not move it; shown as
     "Tutuluyor: X" with who / when / why (`hold: { by, at, note }`, stamped by the master).
   - **Migration** (master start-up, a new policy version written by the system, audited `runtime_policy.pin_modes`):
     a rule whose version is a former release pin (`RELEASE_PIN_HISTORY`) or a catalog version becomes `follow`; any
     other version becomes `hold` (by "system", note "kept at the version stored before pin modes").
   - `allowUnpinned` stays but is labelled an unsafe override in the console and is never set automatically; upgrades
     never rely on it.
9. **Upgrade on demand** (owner decision 2026-10-26). In Araçlar ve sürümler the owner names a runtime or tool and an
   exact upstream version — also newer than the catalog. The master resolves it from the fixed official source with
   its published integrity: runtimes — npm's exact version document and `dist.integrity` of the release's own package;
   git (MinGit), uv, cloudflared, ffmpeg — the GitHub release of the fixed repository and the SHA-256 digest GitHub
   publishes for each asset (URL = the template). Never `latest` or a range; a version whose integrity the source does
   not publish is refused `no_official_checksum` (Python's NuGet package publishes SHA-512 only, the Playwright CDN
   publishes nothing, Node's SHASUMS need gpg on the master; those three come through the catalog, where the vendor hashes
   them). A canary-first fleet action installs it (runtimes: the p16 unverified install + `runtime.verify` on a canary,
   labelled verified / unverified; tools: `tool.install` carrying the published asset, which the worker re-checks
   against the fixed template and the checksum). On "Onayla" the rest of the fleet follows and every runtime policy
   gets a new version for that runtime — `hold` at that version (`follow` when it is the catalog's verified pin) with
   change note "owner upgrade, canary passed / failed / not verified" — so machines under a policy accept it without
   `allowUnpinned`; audited `owner_upgrade.start|confirm|rollback`. "Geri al" restores each policy's previous version
   and installs the previous version again. Owner-only (`updates.channel.write`, step-up event `releases.publish`).
10. **Control plane** unchanged (ADR-0063, `remyral-ctl upgrade` on the host). The host's daily check additionally
   caches the worker feed, the newest worker `release.json` and the catalog for the master (data only; the master
   verifies). A nightly unattended "patch upgrades" timer for the control plane is not added now (backlog
   `p17-ctl-nightly-patch`).

**Threat model.**

| Attacker holds | Can | Cannot | Mitigations |
| --- | --- | --- | --- |
| The catalog key | point the fixed packages / assets at **other published upstream versions** whose integrity matches what the upstream serves; mark them verified | change a source, host, package name, command, install script, path or any code; install anything by itself; go below the release pins; downgrade below what the fleet already accepted; reach the control plane | still a supply-chain risk **on upstream** (a malicious but published upstream version could be named): the `verified` flag (the master offers unverified entries only under the owner's policy), canary-first installs, installs are owner / admin actions, the monotonic sequence and per-item no-downgrade, rotation / revocation through a release |
| A compromised master | withhold catalogs or feeds (freeze: the fleet stays on what it has), re-send an old accepted catalog (refused: sequence), roll out a stored signed release (as today) | forge or alter a catalog or release (workers verify with their own keys), add a catalog key to a worker | worker-side verification, keys only from the release / root config |
| The release location / CDN / DNS | serve old, missing or garbage files | serve anything that verifies | signatures over exact bytes, SHA-256 of the bundle in the signed feed, monotonic sequence, versions never lower than installed |
| An owner session (or a stolen owner + code) | upgrade a runtime / tool to another **published** upstream version with its published integrity, canary first | install an arbitrary URL, package or binary (fixed sources / templates, checksums from the source) | owner-only, step-up, audited, canary first, one-click rollback |
| The release key | everything a release can do (unchanged, p2-signed-updates) | — | offline, rotation through `updates.releaseKeys`; the catalog key cannot sign a release or a feed (separate domains) |

## Alternatives considered

- **Runtime / tool versions only in worker releases** (status quo). Safe but slow; every runtime fix waits for a full
  worker release. Rejected by the owner.
- **The master resolving every version from upstream itself** (p16 for all tools). Each customer trusts the registry on
  the day and no vendor testing stands behind a version; tools have no integrity source (GitHub assets need a download
  and a hash). Kept only as the unverified path for runtimes.
- **Signing the catalog with the release key.** One key fewer, but the release key would have to be online every week
  for an automated process, and its theft is code execution on every machine. Rejected: a narrow online key whose
  theft yields only "other published versions".
- **The catalog carrying URLs / commands freely.** Would make the catalog key a code-execution key. Rejected: the
  worker builds every source from fixed templates; the catalog only names versions and hashes.
- **Distributing the catalog as an OPS_COMMAND.** OPS commands are one-shot and rate-limited per admin; the catalog is a
  desired state re-sent per session. A capability-negotiated control message like APPLY_WORKER_CONFIG fits.
- **Fully automatic minor / major releases.** Owner chose approval for those; `auto` exists as an explicit setting.

## Consequences

- New vendor routine (weekly, docs/ops/update-channel.md): `catalog.mjs build` → `test` → canary → `promote` → `sign`
  → `publish`, and per worker release `sign.mjs build --catalog-key …` + `sign.mjs feed`. Who: the vendor's automated
  catalog runner (catalog key) and the owner / Claude for releases (release key, offline).
- Deploy order: master before the worker release that advertises `version-catalog-v1` (closed feature enum, new
  control messages, `recipes` list up to 32).
- The master needs outbound https to the release location or the host cache; nothing changes for masters without both
  (manual upload stays).
- The catalog's runtime locks make it larger (≈ 20 KiB per runtime version); capped at 384 KiB so it fits one frame.

## Verification

- `packages/protocol/test/update-channel.test.ts`: feed and catalog signature, foreign key, tampered bytes, rotation,
  sequence / downgrade / floor, unknown package, unknown host, unknown tool, wrong tarball path, install scripts,
  future-dated, oversized; bump classification.
- `apps/worker/test/version-catalog.test.ts`: acceptance and persistence, refusal reasons, key rotation drop, merge into
  install sets and recipes (verified = effective pin, unverified marked), the daemon's status reply.
- `apps/master/test/integration/update-channel.test.ts`: feed reading (URL, offline cached file and bundle, unknown key,
  tampered, a bundle that is not the signed one), auto-install of a patch (canary first → soak → stable), approval of a
  minor, owner-only policy with step-up, canary failure, catalog acceptance (foreign key refused) and distribution to
  capable workers (once per session, not to a worker that refused it), the fleet view's catalog version.
  `apps/master/test/unit/fleet-tools-catalog.test.ts`: the matrix with catalog versions (pin, `catalog_pending`,
  unverified offers only under the policy, tools). `apps/master/test/unit/config.test.ts`: derived sources and keys.
- `scripts/test/update-channel-release.test.mjs`: `catalog.mjs keygen|sign|verify|publish`, `sign.mjs feed`, the
  script's URL templates equal the protocol's, a built catalog passes the worker's check.
- `apps/master/test/integration/owner-upgrade.test.ts`: pin mode migration (former pin → follow, other → hold by system),
  an owner hold records who held it, sources without official checksums refused (browser, Python, a GitHub release
  without digests), admins refused, a runtime upgrade canary first → confirm → a held policy version that a
  policy-applied machine runs → rollback to the previous policy version, a tool upgrade carrying the published asset.
  Worker: a held rule is not moved by a catalog, a following rule moves; a tool asset outside the template or with
  another checksum is refused.
- `apps/web/test/update-channel.test.tsx`: the Güncelleme kanalı tab (feed state, policy select with step-up, waiting
  releases with "Güncelle", catalog state) and the matrix's catalog label.
- UNVERIFIED until the first public release location exists: a real weekly catalog run against live upstreams, a
  customer master pulling a real feed.
