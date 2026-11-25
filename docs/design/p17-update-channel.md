# Design note: `p17-update-channel` — worker releases pulled by the master, a signed version catalog for runtimes and tools

- **Task:** `p17-update-channel`. **Date:** 2026-10-26. **ADR:** [ADR-0065](../adr/0065-update-channel-and-version-catalog.md).
  **Migration:** `0159_update_channel.sql` (after `0158_disk_hygiene` on main).
- **Owner decision (2026-10-26, approved as proposed):** a customer's self-hosted Remyral gets worker releases and
  runtime / tool versions without the vendor or a terminal. Patch releases install automatically (canary first),
  minor / major wait for "Güncelle"; runtime / tool versions come from a weekly signed catalog under a separate, narrow
  key; the control plane keeps `remyral-ctl` (ADR-0063).
- **Builds on:** ADR-0063 (release location, host-cached feed, trust model), p2-signed-updates (release key, release
  registry, channels, targets, attempts), p6-release-import (`publishRelease`), p16-ops-safety (rollout breaker),
  p13-fleet-tools (matrix, bulk actions, canary first), p16-runtime-updates (unverified runtime installs, policy
  `fleet.unverifiedRuntimeUpdates`), p5-remote-ops (pinned install sets), p5-machine-admin (tool recipes).
- **Worker release:** required for the catalog (feature `version-catalog-v1`, new control messages, catalog keys
  compiled in). **Deploy order:** master first (closed feature enum, the new messages, `toolInventory.recipes` ≤ 32).
- **Guides:** vendor routine [docs/ops/update-channel.md](../ops/update-channel.md); worker releases
  [docs/ops/worker-updates.md](../ops/worker-updates.md); control plane [docs/ops/selfhost-release.md](../ops/selfhost-release.md).

## 1. Pieces

| Piece | Where |
| --- | --- |
| Feed + catalog schemas, signatures, acceptance rules, tool URL templates, bump classification | `packages/protocol/src/update-channel.ts` |
| Control messages `APPLY_VERSION_CATALOG` / `VERSION_CATALOG_STATUS`, CAPABILITIES `versionCatalog`, feature `version-catalog-v1` | `packages/protocol/src/{master,worker}-messages.ts`, `worker-features.ts` |
| Vendor: catalog build / test / promote / sign / publish, catalog key | `scripts/release/catalog.mjs`, `catalog-lib.mjs` |
| Vendor: worker release feed (release key), catalog keys compiled into a release | `scripts/release/sign.mjs feed`, `sign.mjs build --catalog-key` |
| Master: worker feed, import, policy, canary-first rollout | `apps/master/src/update-channel/{feed,service,rollout,routes}.ts` |
| Master: catalog store and distribution | `apps/master/src/update-channel/catalog.ts` |
| Master: matrix with catalog versions | `apps/master/src/fleet-tools/{matrix,service}.ts` |
| Worker: catalog keys, store, acceptance, merge into install sets / recipes | `apps/worker/src/catalog/*`, hooks in `daemon/run.ts`, `remote-ops/installer.ts`, `tools/*` |
| Host cache | `infra/selfhost/remyral-ctl` (`upgrade --check` also caches `workers/` and `catalog/`) |
| Web | Ayarlar → Sürümler → **Güncelleme kanalı** tab; Araçlar ve sürümler "katalog" label |

## 2. Release location layout

```
<release URL>/feed.json, feed.sig.json, <x.y.z>/…           control plane (ADR-0063, unchanged)
<release URL>/workers/feed.json, workers/feed.sig.json       worker release feed   (release key, remyral-worker-feed/v1)
<release URL>/workers/<x.y.z>/release.json                   the upload document of sign.mjs build (unchanged format)
<release URL>/catalog/catalog.json, catalog/catalog.sig.json version catalog       (catalog key, remyral-version-catalog/v1)
```

Signature documents are `{ keyId, signature }` (keyId = first 16 hex of SHA-256 of the raw public key) over context ‖
the exact file bytes, as everywhere else. Feed (`remyral-worker-feed`, ≤ 1 MiB): `schema`, `name`, `channel`,
`generatedAt`, `catalogKeys[]` (0–4), `releases[]` newest first — `version`, `channel`, `publishedAt`,
`protocolVersions`, `minNode`, `sha256` / `size` (the worker artifact), `bundle { path: "<v>/release.json", sha256,
size }`, `summary` (≤ 300), `notes` (≤ 8000). Catalog: §5.

## 3. Master: the worker release feed and the rollout

**Sources.** `WORKER_FEED_URL` (default: `workers/feed.json` next to `UPDATE_FEED_URL`) every 6 h and on "Şimdi
kontrol et"; `WORKER_FEED_FILE` (default: `workers/feed.json` next to `UPDATE_FEED_FILE`, the host cache) every 5 min.
Same boundaries as the control-plane feed (https, no redirects, 10 s, size cap); the verified feed with the newer
`generatedAt` wins; a failure keeps the last good one and is reported (`unreachable`, `unknown_key`, `bad_signature`,
`malformed`, `too_large`). Verified against `RELEASE_PUBLIC_KEYS` only. Nothing configured → the tab says so and the
manual upload is the way.

**Import.** When the feed's newest release (of the master's channel, `stable`) is not stored yet: the bundle comes from
the host cache (`workers/<v>/release.json`) or `<feed URL dir>/<bundle.path>` (https, no redirects, ≤ 48 MiB, SHA-256
and size of the signed feed checked before parsing), then `publishRelease(…, actor system:update-channel)` — the very
path of the console upload and `release-import`. A refusal is stored on the release row of the channel state
(`import_failed` + code) and not retried for 6 h. Only the newest release is imported (older ones stay a click away:
"Güncelle" imports what it needs).

**Policy** (`update_channel_settings`, one row): `patch_auto` (default) | `manual` | `auto`, `soak_minutes` (default
30). The state per feed release (`update_channel_releases`): `available` → `importing` → `imported` →
`awaiting_approval` | `rolling_out` (`canary` → `fleet`) → `done`, or `import_failed` / `canary_failed` / `skipped`
(a newer release superseded it before it started). Classification against the stable channel's version: same major and
minor, higher patch → patch. No stable channel yet (fresh install) → the first release is imported; with `patch_auto`
it waits like a minor (the owner's first "Güncelle"), with `auto` it rolls out.

**Canary first** (`apps/master/src/update-channel/rollout.ts`, tick every 30 s): canary machines = enrolled, not
revoked / archived workers with `worker_runtime_policies.canary` or update channel `canary`, not pinned by an admin
target. Stage `canary`: a system target (`requested_by` NULL, recorded in `update_channel_rollouts.canary_workers`) per
canary machine, offered at once to connected ones. The stage passes when every canary machine that took the offer
reported `succeeded`, at least one did, and `soak_minutes` passed since the last success; it fails on `failed`,
`rolled_back` or `refused` (`canary_failed`, admins notified, targets cleared). A canary machine that never took the
offer within 6 h does not block. Stage `fleet`: `ReleaseService.promote('stable', v, 100, system)` and the system
targets are cleared (only those still equal to what the rollout set). The p16-ops-safety breaker judges the stable
rollout as before. A newer release that starts supersedes an unfinished rollout (its targets are cleared first).

**Routes** (`apps/master/src/update-channel/routes.ts`):

| Route | Authz | Step-up | What |
| --- | --- | --- | --- |
| `GET /update-channel` | `releases.read` (viewer+) | — | feed state (source, checked at, error, key id), policy, releases with state, rollout progress, catalog state (sequence, entries, per-worker acceptance counts) |
| `POST /update-channel/check` | `releases.publish` | — | re-read feed and catalog now (single flight) |
| `PUT /update-channel/policy` | `updates.channel.write` (owner) | event `releases.publish` | `{ policy, soakMinutes }`, audited `update_channel.policy` |
| `POST /update-channel/releases/:version/install` | `releases.publish` (admin+) | event `releases.publish` | "Güncelle": import if needed, start the canary-first rollout; audited `update_channel.install` |

Audit: `update_channel.import` (success / failure, code), `update_channel.rollout.started|canary_passed|canary_failed|
done|superseded`, `update_channel.catalog.accepted|refused`, plus the existing `release.upload` / `release.promote` /
`worker.update.*` of the paths reused.

## 4. Data (migration 0159)

`update_channel_settings` (one row: policy, soak minutes, updated by / at), `update_channel_feed` (one row: last
verified feed bytes + signature + source + key id, checked at, error), `update_channel_releases` (version, bump,
state, error code, imported at, rollout started / finished), `update_channel_rollouts` (version, stage, canary workers,
started, stage changed, finished, outcome), `version_catalogs` (sequence PK, exact bytes, signature, key id, generated
at, received at, source), `worker_version_catalogs` (worker, reported sequence, key id, last status / reason, at).
Additive; rollback: an older master ignores the tables (and the system targets it may have left are ordinary targets).

## 5. The version catalog

```
{ "schema": 1, "name": "remyral-version-catalog", "sequence": 42, "generatedAt": "2026-10-26T08:00:00.000Z",
  "runtimes": { "codex": [ { "version": "0.165.0", "packageVersion": "0.165.0", "integrity": "sha512-…",
                             "verified": true, "verifiedAt": "…", "packages": [ {path, name, version, resolved,
                             integrity, optional?, os?, cpu?, libc?} … ], "scripts": [] } ], … },
  "tools": { "uv": [ { "version": "0.13.6", "verified": false,
                       "assets": { "linux-x64": { "url": "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz",
                                                  "sha256": "…", "size": 16682639 }, … } } ],
             "browser": [ { "version": "1250", "build": "157.0.8100.2", "playwright": "1.65.0", … } ], … } }
```

`checkVersionCatalog(bytes, signature, { keys, previous, floor, now })` (protocol; worker, master and vendor tool):

| Rule | Refusal (whole catalog) |
| --- | --- |
| ≤ 384 KiB; signature document; key among the trusted ones; Ed25519 over context ‖ bytes | `too_large`, `invalid_signature_document`, `unknown_key`, `bad_signature` |
| strict schema (no unknown fields anywhere) | `invalid_catalog` |
| `generatedAt` not more than 24 h ahead | `future_dated` |
| `sequence` > accepted (same bytes: `already_current`, not an error) | `not_newer` |
| runtime root = `RUNTIME_PINS[rt].package` at `runtimePackageVersion(rt, version)` with the entry's integrity | `unknown_package`, `version_mismatch` |
| every tarball on `registry.npmjs.org`, exactly `/<name>/-/<file>-<version>.tgz`; safe `node_modules/…` paths ending in the name | `unknown_host`, `unknown_source` |
| install-script packages ⊆ the release lock's flagged ones | `install_script_refused` |
| tool known; asset platform known; URL host the tool's fixed host; URL = the template | `unknown_tool`, `unknown_host`, `unknown_source` |
| the highest verified version of an item not below the previous accepted catalog's, unless it is the release pin or the item is dropped (back to the pin) | `version_downgrade` |

Per entry (not a refusal): below the release floor → ignored (`below_release_pin`; normal in a fleet of mixed worker
versions). The templates (`toolAssetUrl`) are the only place a source exists; the worker's built-in recipes are built
from the same templates (a test pins today's URLs).

**Worker** (`apps/worker/src/catalog/`): keys = `updates.catalogKeys` (root config; replaces) or the compiled-in
`__REMYRAL_CATALOG_KEYS__` (≤ 2); `updates.catalog: false` refuses every catalog. Store `<dataDir>/catalog/{catalog.json,
catalog.sig.json}` (0600, written atomically, re-verified at start: a catalog whose key is no longer trusted is dropped).
Merge: a verified runtime entry ≥ the pin is added to the install set and becomes `pinned` (the release pin becomes
`previous`, the one way back); the probe and the job gate compare with it (policy pins still win). Unverified entries
are added as installable versions reported in `remoteOps.runtimes[].catalogUnverified`; installing one records it like
a p16 unverified install (`unverified: { pin }`). Tool entries become recipes (`catalog: { verified }` in the recipe
report; a verified one first, so the matrix offers it). Node entries are not installable on the worker. CAPABILITIES
`versionCatalog { sequence, keyId, generatedAt, skipped[] }`; `VERSION_CATALOG_STATUS { sequence, outcome: accepted |
already_current | refused, reason? }`.

**Master** (`apps/master/src/update-channel/catalog.ts`): sources `VERSION_CATALOG_URL` / `VERSION_CATALOG_FILE`
(defaults next to the feeds), keys `VERSION_CATALOG_KEYS` ∪ the verified worker feed's `catalogKeys`, the same check
with the stored newest catalog as `previous` and `RUNTIME_PINS` as floor; stores accepted catalogs (keeps the last
10). Distribution when `VERSION_CATALOG=on` (default): on CAPABILITIES of a `version-catalog-v1` worker whose sequence
is lower (or missing) → `APPLY_VERSION_CATALOG`; at most once per worker and sequence per session.

**Matrix** (p13): runtime cells take the worker's (catalog-extended) `available` / `pinned`, so "Güncelle" installs the
verified catalog version through the existing pinned path; an unverified catalog version is the cell's
`unverifiedAction` (policy on, `catalog: true`) and is dispatched as a plain `runtime.install` (the worker has the
source). Tool cells take the verified catalog recipe. The catalog view per item gets `catalog { version, verified,
sequence }`; a newer verified catalog version a worker has not got yet → `blocked: catalog_pending` (or
`worker_update_required` for workers without the feature).

## 5a. Runtime policies: follow or hold (ADR-0065 §8)

`RuntimePolicyRule.pin?: 'follow' | 'hold'` and `hold?: { by, at, note }` (protocol, additive). Worker:
`effectivePin(policy, runtime, followPin, installed)` — `hold` → the rule's version (source `policy`); a following rule's
saved version while it is installed (no stop on upgrade); otherwise the catalog's verified pin (source `catalog`) unless
the installed version is the release pin, else the release pin (`compiled`). `policyPins` (probe override) = holds +
catalog pins of runtimes not running their release pin. Master: `put` stamps `hold.by/at` on a new hold; the template
and new rules are `follow`; the worker view reports `pinMode` and, for follow rules, the pin the worker reports; the p3
canary evidence checks installed = version only for holds; `migratePinModes` (start-up, idempotent) writes one system
policy version per policy whose rules lack a mode (follow when the version is in `RELEASE_PIN_HISTORY` ∪ current pins ∪
catalog versions, else hold). Web (Ayarlar → Runtime'lar): "Güncel sürümü takip et (önerilen)" / "X sürümünde sabit
tut"; a hold shows "Tutuluyor: X" with who, when and the note; "Sabitlenmemiş sürüme izin ver (güvensiz istisna)".

## 5b. Upgrade on demand (ADR-0065 §9)

`apps/master/src/update-channel/upgrade.ts` (`OwnerUpgradeService`), table `owner_upgrades`, routes `GET /owner-upgrades`
(`releases.read`), `POST /owner-upgrades`, `POST /owner-upgrades/:id/confirm|rollback` (`updates.channel.write`, step-up).
Start: resolve (runtimes `RuntimeReleases.resolve`; tools the GitHub release by tag with asset digests) → fleet action
`runtime.install` (`unverified`, `ownerUpgrade`: not subject to `fleet.unverifiedRuntimeUpdates`) or `tool.install`
(`toolSource`: per platform the template URL + published SHA-256 + size; OPS `tool.install.asset`, only to
`version-catalog-v1` workers) with `canary-first`, plus `runtime.verify` on a canary. Confirm: the fleet action's
`continue` (its rule: the canary succeeded), then a policy version per policy (none stored → `default` from the template)
with change note "owner upgrade, canary passed / failed / not verified". Rollback: each policy back to its version before
(`RuntimePolicyService.rollback`), the open action cancelled, and an install of the previous version on every machine.
Worker: `ToolInstaller.install(tool, version, { asset })` builds the recipe only when the asset URL equals
`toolAssetUrl(...)`, then the normal verified download (SHA-256 + size before extraction).

## 6. Web

Ayarlar → Sürümler gets a tab **Güncelleme kanalı** (`?tab=channel`): source and last check ("Kaynak: sürüm adresi /
sunucudaki kopya", "Son kontrol", error in words, "Şimdi kontrol et"); policy select ("Yamalar otomatik, diğerleri
onayla" / "Hepsi onayla" / "Hepsi otomatik") saved with the authenticator code; release rows (version, bump label
"yama / küçük sürüm / büyük sürüm", state, summary, notes toggle) with "Güncelle" on waiting ones; rollout progress
(kanarya → filo, machines); the catalog card (sequence, generated, per item version + "doğrulandı / doğrulanmamış",
machines that accepted / refused with the reason). Araçlar ve sürümler: the version line says "katalog" with the
verified state; `catalog_pending` has its own reason text. TR + EN.

## 7. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Stolen catalog key pushes code | strict schema; sources only from fixed templates; root package fixed; scripts never run and ⊆ the release lock's; every tarball / asset hash-checked before extraction (existing installers) | protocol refusals, worker refusals |
| Stolen catalog key points at a malicious published upstream version | `verified` flag; unverified only under the owner's policy; canary-first installs; installs are human actions; revocation by a patch release | protocol, master matrix |
| Downgrade / replay / freeze | monotonic sequence, per-item no-downgrade, floor = release pins; freeze only keeps the current state | protocol, worker |
| Sequence exhaustion with a stolen key | stored catalog dropped (and sequence reset) when its key leaves the trusted set | worker |
| Compromised master forges a catalog or adds a key | workers verify with their own keys (release / root config) | worker |
| Feed / bundle substitution by the location / CDN | release-key signature, bundle SHA-256 in the signed feed, release manifest signature on import | master unit + integration |
| Automatic rollout bricks the fleet | patch only by default, canary first + soak, breaker, failed versions not re-offered, owner can switch to manual | integration |
| Policy changed by an admin / without a code | owner-only `updates.channel.write`, step-up event `releases.publish`, audited | integration, rbac matrix |
| Large / hostile downloads | https, no redirects, size caps, streaming hash, 6 h back-off after a failure | unit |

## 8. Tests

Listed in ADR-0065 §Verification. Counts are in the CHANGELOG entry.

## 9. Unverified / not done

- A real vendor run (`catalog.mjs build` against live npm / GitHub / NuGet / Playwright CDN, the contract tests on the
  candidates, a canary run) and a real customer master pulling a published feed: no public release location exists yet.
- The browser assets (~200 MB each) are hashed by downloading them; the weekly runner needs the bandwidth.
- Node in the catalog is informational (installer kits / matrix); a worker never replaces its own Node.
- Owner upgrades of Python (NuGet publishes SHA-512 only), the browser (no published checksum) and Node (signed SHASUMS
  need gpg on the master): refused; they come through the catalog.
- A nightly unattended control-plane patch timer in `remyral-ctl`: backlog `p17-ctl-nightly-patch`.
