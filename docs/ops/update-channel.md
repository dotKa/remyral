# Update channel and version catalog — vendor routine and keys

[ADR-0065](../adr/0065-update-channel-and-version-catalog.md) · [design note](../design/p17-update-channel.md). This page
is for the **vendor** (who publishes Remyral) and for the **owner of a self-hosted install** (what to do once).

## 1. Keys: which signs what, where it lives

| Key | Signs (domain) | Lives | Trusted by |
| --- | --- | --- | --- |
| **Release key** (Ed25519) | worker releases `remyral-worker-release/v1`, installer kits `remyral-worker-installers/v1`, control-plane releases and feed `remyral-control-plane-*/v1`, **the worker release feed** `remyral-worker-feed/v1` | **offline**: the vendor's machine (`~/remyral-release-key/release-key.pem`, 0600) or a hardware token, plus an offline backup. Never on a server, never in CI. | the master (`RELEASE_PUBLIC_KEYS`, on self-hosted installs by default the installed `CONTROL_PLANE_RELEASE_KEYS`), workers (compiled in / `updates.releaseKeys`), `remyral-ctl` (`<data>/trust/keys`) |
| **Catalog key** (Ed25519) | the version catalog only, `remyral-version-catalog/v1` | **online but narrow**: only the weekly catalog runner — a 0600 file on that machine or the CI secret of that one job. Its theft lets an attacker name *other published upstream versions* of the fixed packages (with the upstream's integrity), nothing else (ADR-0065 threat model). | workers (compiled into the release with `sign.mjs build --catalog-key`, or `updates.catalogKeys` in the root-owned config), the master (`VERSION_CATALOG_KEYS` ∪ the `catalogKeys` the release-key-signed worker feed lists) |
| Master lease-signing key | OPS commands, policies, configuration | the master's data dir | workers (session) |

Create the catalog key once: `node scripts/release/catalog.mjs keygen --out ~/remyral-catalog-key` (prints the public key
and key id). Put the private key only on the catalog runner; publish the public key by building the next worker release
with `--catalog-key <pub>` and listing it in the feed (`sign.mjs feed --catalog-key <pub>`).

**Rotation.** New key K2: build a worker release with `--catalog-key K1 --catalog-key K2`, list both in the feed; once the
fleet runs it, sign catalogs with K2; the next release (and feed) drops K1. Workers drop a stored catalog whose key they
no longer trust (and start the sequence again). **Revocation** of a stolen catalog key: a patch release without it
(installed automatically under the default policy) and a feed without it.

## 2. Release location layout

```
<release URL>/feed.json, feed.sig.json, <x.y.z>/…             control plane (docs/ops/selfhost-release.md)
<release URL>/workers/feed.json, workers/feed.sig.json         worker release feed (release key)
<release URL>/workers/<x.y.z>/release.json                     sign.mjs build output
<release URL>/catalog/catalog.json, catalog/catalog.sig.json   version catalog (catalog key)
```

## 3. Per worker release (owner or Claude, release key — offline)

1. `node scripts/release/sign.mjs build --version X.Y.Z --channel stable --key ~/remyral-release-key/release-key.pem --catalog-key <catalog pub>`
2. `mkdir -p <site>/workers/X.Y.Z && cp dist/release/X.Y.Z/release.json <site>/workers/X.Y.Z/`
3. Release notes: a `## [worker X.Y.Z]` section in CHANGELOG.md (the feed's summary and notes).
4. `node scripts/release/sign.mjs feed --site <site> --key ~/remyral-release-key/release-key.pem --catalog-key <catalog pub>`
5. Upload `<site>/workers/` to the release URL (the same upload step as the control-plane bundle).

Customers' masters import it within 6 h (or at once with "Şimdi kontrol et"); patch releases roll out canary first by
themselves, minor / major wait for "Güncelle". **Deploy order:** a master that understands `version-catalog-v1` before
the first worker release that advertises it.

## 4. Weekly catalog routine (catalog runner, catalog key — automated)

Who: the vendor's scheduled catalog job (weekly, Monday 06:00 UTC), on the one machine that holds the catalog key. A
human (owner or Claude) promotes entries after the canary.

1. `node scripts/release/catalog.mjs build --out draft.json` — newest upstream releases, exact versions, integrity:
   runtimes with their full npm lock (`npm install --package-lock-only --ignore-scripts`), tools downloaded and SHA-256
   hashed (GitHub's published asset digest must agree; Node's SHASUMS256 signature is verified with the vendored keys).
   Everything is `verified: false`. Pin a version with `--runtime codex=0.165.0` / `--tool uv=0.13.6`; leave an item out
   with `--skip browser`.
2. `node scripts/release/catalog.mjs test --draft draft.json` — each runtime candidate from its lock, then the
   repository's real-binary contract suites (scripted providers, no credentials). Claude Code is `unsupported` here (its
   suites need the adapter's SDK at that version — it stays unverified until a release moves the SDK).
3. Canary: the vendor's canary machine installs the unverified entries (sign and publish the draft first as an
   unverified catalog, or install them with "Belirli bir sürüme yükselt") and runs real jobs.
4. `node scripts/release/catalog.mjs promote --draft draft.json --entry runtime:codex@0.165.0 --canary "mac canary, 3 jobs"`
   for each entry that passed (runtimes need passed contract tests).
5. `node scripts/release/catalog.mjs sign --draft draft.json --key <catalog key> --site <site>` — the next sequence,
   structural checks (templates, registry tarballs, no verified downgrade, ≤ 384 KiB).
6. `node scripts/release/catalog.mjs publish --site <site> --to <release location working dir> --public-key <catalog pub>`
   and sync it to the release URL.

Never sign a catalog with the release key; never put the release key on the catalog runner.

## 5. Owner of a self-hosted install — once

- Nothing to configure for the URL mode: `remyral-ctl` already sets `UPDATE_FEED_URL`; the worker feed and the catalog
  are read next to it, and the daily `remyral-ctl upgrade --check` caches them (and the newest worker bundle) for masters
  without internet. The master verifies worker releases with the installed release key.
- Choose the policy in Ayarlar → Sürümler → Güncelleme kanalı (default: patches automatic). Mark one machine as canary
  (Makine → Runtime’lar → kanarya) so automatic rollouts start there.
- Kill switch for the catalog: `VERSION_CATALOG=off` in stack.env (Coolify: the resource's environment variables), then
  recreate the master (`remyral-ctl install` re-run, or a Coolify redeploy).
- The other settings of this feature are passed to the master the same way and are empty (= default) unless set:
  `WORKER_FEED_URL`, `WORKER_FEED_FILE`, `VERSION_CATALOG_URL`, `VERSION_CATALOG_FILE`, `VERSION_CATALOG_KEYS`,
  `FLEET_TOOLS_FEED`. Before p17-host-actions the compose file did not pass them, so a value in stack.env had no
  effect; `scripts/test/compose-env.test.mjs` now fails the build when the master reads a variable that compose does
  not pass (or list as deliberately not passed).
