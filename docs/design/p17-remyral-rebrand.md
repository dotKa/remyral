# Plan: `p17-remyral-rebrand` — Remana Agentic Ops → **Remyral**

- **Status:** plan for owner review (2026-10-23). Nothing renamed yet.
- **Owner decision:** the product is now **Remyral**. Brand kit: `brand/remyral/` (logos, `brand-tokens.json`,
  `tokens.css`, brand board `assets/reference/brand-board.png`). Tagline: "Many agents. One intelligence." /
  "Collective intelligence for a more capable world".
- **Logo use (owner):** the colour logo as **PNG** (`assets/png/primary*.png`, `stacked*.png`, `icon*.png`); black
  and white as **SVG** (`assets/svg/mono-navy-vector.svg`, `mono-white-vector.svg`). The kit's README notes the
  `*-vector.svg` paths are traced approximations — check them at small sizes before use.
- **Palette:** Deep Navy `#0A1F3D`, Electric Teal `#00D1B2`, Soft Cyan `#7DD3F7`, Off White `#F6FAFF`, Slate `#94A3B8`,
  Electric Blue `#1266FF`. **Type:** Plus Jakarta Sans (primary), Inter (secondary), JetBrains Mono (code).

## Scope today

`git grep` (excluding the backlog): "Remana" 1 370 hits in 456 files, "remana" 5 949 in 1 689 files, "REMANA" 702 in
247 files; 13 package manifests use `@remana/*`; 105 `REMANA_*` env names; 60 files mention `example.org`; 40 files use
the token prefix `ryl_` or `X-Remana-*` headers.

## Principle: rename what people see, keep what machines depend on

Visible names change at once. Identifiers that installed workers, API clients, webhook receivers, scripts and
backups depend on are **not** renamed in place: they get a Remyral name **plus** the old one as an alias, and the old
one is retired only in a later major release. This keeps every running worker, token and integration working.

## Phases

### Phase 1 — Visible brand (no compatibility risk)
1. **Console (Diyalog):** product name, logo in the rail / login / setup / onboarding, favicon, PWA manifest and icons
   (from `assets/png/icon-*.png`), page titles, e-mail templates, notification titles, PDF / Markdown exports, report
   bundle headers, update banner, "Hakkında".
2. **Theme:** map the brand palette onto the Diyalog tokens (`--dy-*`: teal → Electric Teal / a darker accessible
   teal for text on light, ink → Deep Navy, page → Off White, info → Electric Blue), re-check contrast (WCAG AA) in
   light and dark; switch fonts to Plus Jakarta Sans / Inter / JetBrains Mono, **self-hosted** (CSP: no Google Fonts
   CDN), with the existing size scale kept so layouts don't shift.
3. **Texts:** i18n catalogs TR + EN ("Remana" → "Remyral", glossary entry), assistant system prompt and rule texts
   ("Remana operasyon asistanı" → "Remyral …"), owner guides (now `docs/guide/tr`), README, CHANGELOG entry.
4. **Worker side visible strings:** installer screens, `remana-worker doctor` output headings, Windows service display
   name, macOS launchd label description (labels themselves stay — Phase 2).
5. **Presentation deck**: logos, palette, name; redeploy with the new name.

### Phase 2 — Aliases (backwards compatible)
- CLIs: `remyral-worker`, `remyral-master`, `remyral-ctl` added; `remana-*` stay as aliases (same binary).
- Env: `REMYRAL_*` read first, `REMANA_*` still read (a startup notice lists the old names in use).
- API tokens: new prefix `ryl_pat_` / `ryl_sa_` for new tokens; `ryl_*` stay valid until they expire.
- Webhooks: send `X-Remyral-Signature` / `-Delivery` **and** the `X-Remana-*` headers (subscription setting to drop
  the old ones); docs show the new names.
- Installer / data dir: new installs use `/var/lib/remyral`; existing `/var/lib/remana` keeps working (no move).
- Docker images: publish under `remyral-*` names too (same digests).
- Domain: new console address (owner to choose, e.g. `app.remyral.<tld>`); the old `console.example.org`
  redirects; worker configs keep the old URL until a worker update rewrites it (the master answers on both).

### Phase 3 — Internal rename (optional, later major release)
npm scope `@remana/*` → `@remyral/*`, repository name, database/role names, Redis key prefixes, systemd/launchd unit
names, `pg` database `remana`. Only with a migration path and a deprecation window; no functional gain, so it waits.

## Owner decisions (2026-10-23)
- Everything becomes **Remyral** — visible brand AND internal identifiers (CLIs, env, token prefixes, headers, package
  scope, images, paths). **No aliases are kept** ("eski alanları korumamıza gerek yok").
- **remyral.com is the marketing site.** The running system keeps its domain (`console.example.org`; no DNS change, owner 2026-10-23). Support / contact e-mail **info@remyral.com**.
- Theme: brand palette + fonts on the current Diyalog look (recolour, not a redesign) unless the owner asks otherwise.
- The setup wizard gets a **domain step** (current public address, TLS state, DNS check, the `remyral-ctl domain set`
  command); the public origin becomes an owner setting for links and e-mails.
- Live system cut-over: no domain change; a worker release migrates installed workers in place (service, config
  dir, env names); data names (Postgres database, volumes) of the existing installation move in one maintenance step.

## Decisions needed from the owner (answered above)
1. **Domain:** which domain/subdomain for the console and the public site (and the support address — still
   old-support@example.com?).
2. **Product naming:** "Remyral" alone, or "Remyral Agent Cluster" / "Remyral Ops" for this product line?
3. **Theme depth:** only recolour the current Diyalog look with the brand palette and fonts (recommended, low risk),
   or a visual redesign along the brand board (gradients, glass, network imagery)?
4. **Repository / GitHub org:** keep `<owner>/<repo>` for now (recommended) or move now?
5. **Phase 2 timing:** together with Phase 1, or after Phase 1 is live?

## Order of work (after decisions)
1. Phase 1 as one branch (theme + assets + texts), screenshots of the main screens for owner review before deploy.
2. Deck rebrand in parallel (no code risk).
3. Phase 2 as its own branch with compatibility tests (old CLI names, env, token prefix, webhook headers).

## Implementation: p17-remyral-core (identifiers; the visible brand/theme is a separate branch)

Superseding the Phase 2/3 alias plan above (owner: no aliases): identifiers are renamed outright — npm scope
`@remyral/*`, CLIs and bins (`remyral-worker`, `remyral-worker-updater`, `remyral-master` image, `remyral-ctl`,
`remyral-backup`, `remyral-limits`), installers, service names (`remyral-worker.service`, `com.remyral.worker`,
`RemyralWorker`), data/config dirs, env names `REMYRAL_*`, API token prefixes `ryl_pat_` / `ryl_sa_` (same checksum
scheme), webhook headers `X-Remyral-*`, Docker image / compose / container / volume / network alias defaults, metric
names `remyral_*`, MCP server names, git trailers (`Remyral-Attempt`, `Remyral-Merge`), support address
`info@remyral.com` (migration 0149 changes the stored value only while it is still `old-support@example.com`). New installs
use database and roles `remyral` / `remyral_*`.

**The running system keeps its domain** (`console.example.org`, staging `console-staging.example.org`) and
its installation names (compose project `remana-<env>`, `/data/remana/<env>`, volumes, backup unit) as settings
(`/etc/remyral/deploy.env`, stack.env pins). Cut-over steps: `docs/ops/remyral-cutover.md` (deleted with the
transition code; not part of this repository). The transition code was single-use,
marked `p17-cutover`, and is deleted — see "Cut-over done" below.

### Frozen on purpose (still `remana`)

| Kind | Constants | Why |
| --- | --- | --- |
| HKDF info of keys for data at rest | `remana/totp-secret/v1`, `remana/recovery-code/v1`, `remana/<label>/v1` (SecretBox sub-keys: api-token, automation-webhook, git-host, github-app, github-user-token, ops-integrations, preview-tunnels, push-keys, sso-state, support-smtp, webhooks-out, workflow-wait), `remana-credential-seal/v1`, `remana-vault-key/v1`, `remana-job-slot-v1` (Windows DPAPI entropy) | renaming makes stored secrets, token hashes, TOTP and sealed credentials unreadable |
| Master ↔ worker signature domains | `remana-worker-auth/v1`, `remana-worker-rotate/v1`, `remana-lease/v1`, `remana-credential-delivery/v1`, `remana-approval-mode/v1`, `remana-assistant-turn/v1`, `remana-ops-command/v1`, `remana-machine-admin/v1`, `remana-machine-admin-session/v1`, `remana-service-control/v1`, `remana-service-start/v1`, `remana-service-tunnel/v1`, `remana-tunnel-start/v1`, `remana-tunnel-stop/v1`, `remana-time-limit/v1`, `remana-worker-config/v1`, `remana-mcp/v1`, `remana-skill/v1`, `remana-admin-helper/v1`, `remana-prepare-helper/v1` | installed workers (and their never-auto-updated privileged helpers) sign / verify them; a change needs its own protocol transition |
| Stored signed / hashed formats | spec kinds `remana.skill`, `remana.mcp`; `remana.skills/v1`, `remana.mcp/v1`, `remana.context.bundle/v1`, `remana.mcp.tree/v1`, `remana-prompt-v1`, `remana-inputs-v1`, `remana-usage-identity/v1` | signatures and digests stored in the database / on workers |
| Backups | formats `remana-backup/v1`, `remana-backup-manifest/v1`, `remana-base-manifest/v1`, `remana-backup-status/v1`, `remana-backup-heartbeat/v1`, `remana-backup-standby/v1`; backup ids `remana-<env>-<stamp>`; default off-site prefix `remana` | existing archives, retention, restore and the WAL standby read them; the deployed IAM policies name the prefix |
| Database objects of applied migrations | GUCs `remana.context_purge` / `remana.context_prune`, `remana_watch*` functions and NOTIFY channel, ref namespace `refs/remana/checkpoints/` (CHECK constraint), the MCP id reservation `remana*` | migrations are checksummed and never edited |
| Keychain | macOS service attribute `remana-worker` | items already stored on Macs |
| Live installation / owner resources | domains `*.example.org`, `infra/coolify-sso/*`, `infra/monitoring/{cloudformation,cloudwatch-agent}.json`, `compose.awslogs.yaml`, `container-stats.*`, `install-host.sh`, `infra/backup/aws/*`, the repository `remana-agent-cluster` / org `<owner>` | they describe resources that exist under these names |

Renamed outright although hashed/signed, because only the master uses them and nothing long-lived depends on them:
setup token, release download token, rotation nonce, pairing code (`remyral-*/v1`), rollout buckets
(`remyral-rollout/v1`: buckets reshuffle once), deploy records (`remyral-deploy-record/v1`), installer index
(`remyral-worker-installers/v1`), control-plane release / feed / manifest (`remyral-control-plane-*`; no pre-rename
self-host installation exists, §6 of the cut-over).

### Signing-domain transition (worker releases)
`remyral-worker-release/v1` (manifest `remyral-worker`) is the domain. Installed workers verify only
`remana-worker-release/v1`, so the transition release is signed under it (`sign.mjs --legacy-domain`, manifest
`remana-worker`) and installed by their own updater; builds from it on accept both. Later releases are current-signed;
the master records each release's domain (migration 0149) and offers a current-signed release only to workers on the
transition release or newer, stepping older ones to it. The legacy acceptance was p17-cutover code and is removed
(below): only `remyral-worker-release/v1` verifies now, the `worker_releases.signing_domain` column stays unused.

### Cut-over done (2026-10-25, p17-cutover-cleanup)

Every machine runs under the Remyral identity (win-1: `NT SERVICE\RemyralWorker`,
`C:\ProgramData\RemyralWorker`; ip-10-0-0-12: `remyral-worker`, `/var/lib/remyral-worker`; worker 1.1.2 / 1.1.3),
the control plane deploys from `/opt/remyral-src-*` with `remyral-*` images, `migrate-env` ran and the database and
roles are `remyral` / `remyral_*` (2026-10-24). One commit removed the transition code:

- worker: the pre-rename install detection (`migration/remana-to-remyral/`: legacy flavor, service / dir / account /
  log / admin-trigger names, `migrate-legacy`) and the 1.1.1 load-time tolerances (pre-rename `sandbox.workerUser`,
  runtime `state.json` launch paths in the pre-rename data dir);
- installer kits: no in-place migration any more. A kit that finds a pre-rename install refuses before changing
  anything and points to the 1.1.1 kit (`/v1/worker/install/1.1.1/<os>/…`), which still migrates;
- protocol / master / release tooling: the legacy release signing domain (`remana-worker-release/v1`, manifest
  `remana-worker`), `sign.mjs --legacy-domain`, the master's transition-release gate;
- deploy: `migrate-env`, the pre-rename preflight, pre-rename image repositories and pre-rename source directories (prune,
  adoption, rollback refusal), the `remana-backup` fallback; `scripts/cutover/` (incl. `db-rename-remyral.sh`);
- the disk hygiene also removes the pre-rename service's logs left in the worker's logs dir
  (`remana-worker_rCURRENT.log`, `remana-worker_r*.log`).

Kept because they still protect data, marked `p17-prerename-backups` (remove when no backup made before 2026-10-24 is
within retention — with the default 7/4/3 retention after 2027-02-01, check off-site copies too): the drill's
`remana_*` roles (`infra/backup/runner/lib/pre-rename-roles.mjs`, dumps made before the role rename) and the standby
restore's recognition of a pre-rename stack.env (`scripts/ops/lib/pre-rename-backups.mjs`). Untouched: migrations
(0149 stays), the frozen identifiers above, `infra/monitoring` (`REMANA_*` there are that tool's own names, not
fallbacks).

## Implementation: p17-remyral-brand (visible brand, Diyalog console)

Phase 1 of the plan for the console (owner decisions above): the product is **Remyral** everywhere the console, its
e-mails, exports and the assistant speak; the Diyalog look is recoloured (not redesigned); the setup wizard gets the
domain step. Identifiers were renamed by p17-remyral-core.

### Brand theme

The brand palette mapped onto the existing Diyalog tokens (`apps/web/src/diyalog/diyalog.css`; the classic `--c-*`
tokens in `index.css` get the same values). Meaning colours (amber, red, green, violet) and the runtime colours of
Claude Code / Codex keep their hues; only values that failed AA were moved.

| Token | Role | Light (was) | Dark (was) | Brand source |
| --- | --- | --- | --- | --- |
| `--dy-bg` | page / rail | `#ecf1f8` (`#eef1f6`) | `#040d1c` (`#10141c`) | Off White tint / Deep Navy, darker |
| `--dy-thread` | reading surface | `#f6faff` (`#f8f9fc`) | `#071429` (`#151a24`) | **Off White** / navy |
| `--dy-card` | cards | `#ffffff` | `#0d2140` (`#1c2230`) | white / navy step |
| `--dy-sunk` | wells, code | `#edf2f8` (`#f1f3f8`) | `#081731` (`#141922`) | |
| `--dy-line`, `--dy-line-2` | separators | `#d8e2ee`, `#bfccdb` | `#1a3152`, `#29446a` | navy tints |
| `--dy-ink` | text, primary button | `#0a1f3d` (`#182031`) | `#e9f0f9` (`#e6eaf2`) | **Deep Navy** / Off White |
| `--dy-muted` | secondary text | `#42526b` (`#556079`) | `#a9b7ca` (`#a0aabd`) | |
| `--dy-faint` | tertiary text | `#52627a` (`#5f6982`) | `#94a3b8` (`#8791a5`) | dark: **Slate** |
| `--dy-me`, `--dy-me-ink` | the user's bubble | `#13305a` / white | `#d5e2f3` / `#0a1f3d` | navy |
| `--dy-teal` | accent text, solid fills, focus | `#00786a` (`#0d6c74`) | `#00d1b2` (`#4dbfc4`) | light: teal derived from Electric Teal (5.39:1 on white); dark: **Electric Teal** |
| `--dy-teal-ink` | links, accent text on soft | `#00665a` (`#0a5a61`) | `#5fe3cd` (`#7fd6d9`) | |
| `--dy-teal-soft` | accent wash | `#daf5ef` (`#ddf0f0`) | `#06363a` (`#16302f`) | |
| `--dy-on-fill` | text on solid fills | white | `#061328` (`#121620`) | navy |
| `--dy-oc` | OpenCode runtime colour | `#1266ff` (`#2f6fc4`) | `#7dd3f7` (`#6aa6f2`) | **Electric Blue** / **Soft Cyan** |
| `--dy-pi` | Pi runtime colour | `#976800` (`#a87300`, was 4.10:1) | unchanged | AA fix |
| `--dy-field` | form field border (≥ 3:1) | `#7d8aa1` (`#848da1`) | `#607898` (`#677289`) | |
| `--dy-cmd-bg` | command blocks | `#061328` (`#141a26`) | `#020812` (`#0d1117`) | navy |
| `--dy-primary` (dark) | primary button fill | — | `#c9d6e6` (`#c9d2e1`) | |
| `--dy-brand` (new) | the brand mark, selection tint | `#00d1b2` | `#00d1b2` | **Electric Teal**, never text on light |
| `--dy-brand-tile` (new) | the tile behind the colour symbol | `#0a1f3d` | `#0a1f3d` | **Deep Navy** (the app icon) |

Electric Teal on white is 1.95:1, so on light it is never text or a meaningful fill: text, links and solid fills use
the derived `#00786a` / `#00665a`; the bright teal is the brand mark (`--dy-brand`: the symbol's tile accents, the
assistant's phone marker, the selection tint). Shadows, the scrim and the lightbox take the navy hue. Every pair the
console draws, computed with the WCAG 2.x formula (`test/diyalog-polish.test.tsx` enforces the text pairs, the field
boundary and the dark primary):

| Pair (text on surface) | Light | Dark | Needed |
| --- | --- | --- | --- |
| `ink` on `bg` | 14.50 (#0a1f3d / #ecf1f8) | 16.95 (#e9f0f9 / #040d1c) | ≥ 4.5 |
| `ink` on `thread` | 15.70 (#0a1f3d / #f6faff) | 16.03 (#e9f0f9 / #071429) | ≥ 4.5 |
| `ink` on `card` | 16.45 (#0a1f3d / #ffffff) | 13.98 (#e9f0f9 / #0d2140) | ≥ 4.5 |
| `ink` on `sunk` | 14.62 (#0a1f3d / #edf2f8) | 15.54 (#e9f0f9 / #081731) | ≥ 4.5 |
| `muted` on `bg` | 6.98 (#42526b / #ecf1f8) | 9.55 (#a9b7ca / #040d1c) | ≥ 4.5 |
| `muted` on `thread` | 7.56 (#42526b / #f6faff) | 9.04 (#a9b7ca / #071429) | ≥ 4.5 |
| `muted` on `card` | 7.92 (#42526b / #ffffff) | 7.88 (#a9b7ca / #0d2140) | ≥ 4.5 |
| `muted` on `sunk` | 7.04 (#42526b / #edf2f8) | 8.76 (#a9b7ca / #081731) | ≥ 4.5 |
| `faint` on `bg` | 5.46 (#52627a / #ecf1f8) | 7.59 (#94a3b8 / #040d1c) | ≥ 4.5 |
| `faint` on `thread` | 5.92 (#52627a / #f6faff) | 7.18 (#94a3b8 / #071429) | ≥ 4.5 |
| `faint` on `card` | 6.20 (#52627a / #ffffff) | 6.26 (#94a3b8 / #0d2140) | ≥ 4.5 |
| `faint` on `sunk` | 5.51 (#52627a / #edf2f8) | 6.96 (#94a3b8 / #081731) | ≥ 4.5 |
| `teal-ink` on `bg` | 6.07 (#00665a / #ecf1f8) | 12.37 (#5fe3cd / #040d1c) | ≥ 4.5 |
| `teal-ink` on `thread` | 6.57 (#00665a / #f6faff) | 11.70 (#5fe3cd / #071429) | ≥ 4.5 |
| `teal-ink` on `card` | 6.89 (#00665a / #ffffff) | 10.21 (#5fe3cd / #0d2140) | ≥ 4.5 |
| `teal-ink` on `sunk` | 6.12 (#00665a / #edf2f8) | 11.35 (#5fe3cd / #081731) | ≥ 4.5 |
| `teal` on `card` | 5.39 (#00786a / #ffffff) | 8.22 (#00d1b2 / #0d2140) | ≥ 4.5 |
| `amber` on `card` | 5.32 (#9c5c00 / #ffffff) | 8.41 (#f0b048 / #0d2140) | ≥ 4.5 |
| `red` on `card` | 5.29 (#c23b33 / #ffffff) | 5.90 (#f07a70 / #0d2140) | ≥ 4.5 |
| `green` on `card` | 5.33 (#1d7a4c / #ffffff) | 7.79 (#5cc98d / #0d2140) | ≥ 4.5 |
| `violet` on `card` | 5.93 (#6a4bd1 / #ffffff) | 5.97 (#a58ef7 / #0d2140) | ≥ 4.5 |
| `on-fill` on `teal` | 5.39 (#ffffff / #00786a) | 9.51 (#061328 / #00d1b2) | ≥ 4.5 |
| `on-fill` on `amber` | 5.32 (#ffffff / #9c5c00) | 9.73 (#061328 / #f0b048) | ≥ 4.5 |
| `on-fill` on `red` | 5.29 (#ffffff / #c23b33) | 6.83 (#061328 / #f07a70) | ≥ 4.5 |
| `on-fill` on `cc` | 5.23 (#ffffff / #7454d9) | 6.90 (#061328 / #a58ef7) | ≥ 4.5 |
| `on-fill` on `cx` | 4.51 (#ffffff / #13875f) | 8.72 (#061328 / #47c795) | ≥ 4.5 |
| `on-fill` on `pi` | 4.89 (#ffffff / #976800) | 9.32 (#061328 / #e2b04a) | ≥ 4.5 |
| `on-fill` on `oc` | 4.81 (#ffffff / #1266ff) | 11.08 (#061328 / #7dd3f7) | ≥ 4.5 |
| `cc` on `card` | 5.23 (#7454d9 / #ffffff) | 5.97 (#a58ef7 / #0d2140) | ≥ 4.5 |
| `cx` on `card` | 4.51 (#13875f / #ffffff) | 7.54 (#47c795 / #0d2140) | ≥ 4.5 |
| `pi` on `card` | 4.89 (#976800 / #ffffff) | 8.06 (#e2b04a / #0d2140) | ≥ 4.5 |
| `oc` on `card` | 4.81 (#1266ff / #ffffff) | 9.58 (#7dd3f7 / #0d2140) | ≥ 4.5 |
| `teal-ink` on `teal-soft` | 6.00 (#00665a / #daf5ef) | 8.37 (#5fe3cd / #06363a) | ≥ 4.5 |
| `amber-ink` on `amber-soft` | 6.83 (#7a4800 / #fff1d6) | 9.76 (#f6c877 / #2e2412) | ≥ 4.5 |
| `red-ink` on `red-soft` | 6.44 (#9a2a23 / #fce6e3) | 8.19 (#f7a39b / #331a19) | ≥ 4.5 |
| `me-ink` on `me` | 13.14 (#ffffff / #13305a) | 12.54 (#0a1f3d / #d5e2f3) | ≥ 4.5 |
| `field` on `card` | 3.49 (#7d8aa1 / #ffffff) | 3.54 (#607898 / #0d2140) | ≥ 3 |
| `teal` on `bg` | 4.75 (#00786a / #ecf1f8) | 9.97 (#00d1b2 / #040d1c) | ≥ 3 |
| `teal` on `thread` | 5.14 (#00786a / #f6faff) | 9.43 (#00d1b2 / #071429) | ≥ 3 |
| `card` on `primary` | 16.45 (#ffffff / #0a1f3d) | 10.88 (#0d2140 / #c9d6e6) | ≥ 4.5 |
| `cmd-ink` on `cmd-bg` | 15.86 (#e6eef8 / #061328) | 17.16 (#e6eef8 / #020812) | ≥ 4.5 |
| `brand` on `brand-tile` | 8.43 (#00d1b2 / #0a1f3d) | 8.43 (#00d1b2 / #0a1f3d) | ≥ 3 |
| `brand` on `card` | 1.95 (#00d1b2 / #ffffff) | 8.22 (#00d1b2 / #0d2140) | decorative only |

**Type.** Inter (UI text, `--font-dy`, `--font-sans`), Plus Jakarta Sans (headings h1–h3 inside Diyalog surfaces,
`--font-dy-display`), JetBrains Mono (ids, hashes, code). Self-hosted variable woff2 (one file per subset covers every
weight), latin + latin-ext, copied unchanged from `@fontsource-variable/{inter,plus-jakarta-sans,jetbrains-mono}@5.3.0`
(integrity in `src/fonts.css`; the same files remyral.com serves) — CSP `font-src 'self'`, no CDN. Atkinson
Hyperlegible and IBM Plex are removed. The build preloads Inter latin (`perf-plugin.ts`). Sizes and line heights are
unchanged. Inter is a little wider than Atkinson at the same size: the rail items grow from 64 to 78 px (rail 76 →
86 px) so the longest single label word fits — measured in Inter 500 10.5 px: "Otomasyonlar" 70.0 px,
"Workflow’lar" 63.5, "Automations" 63.4, "bekleyenler" 58.3 (label box 74 px). That fixes the "Otomasyonl / ar"
break without shortening any owner wording.

### Brand assets

From the approved PNGs only (colour logo as PNG, owner decision); `apps/web/scripts/brand-assets.mjs` derives them
with the e2e Chromium (no image library), outputs committed:

| File | What |
| --- | --- |
| `src/assets/brand/logo-on-light.png`, `logo-on-dark.png` | the lock-up: navy wordmark on light, white wordmark on dark — the remyral.com files (its `scripts/brand_assets.py`: approved primary PNG, tightly cropped, wordmark pixels white on dark). `BrandLogo` shows one by the theme (CSS, so `data-theme` overrides work) — login, setup, sign-in steps, the wizard, the print / PDF export |
| `src/assets/brand/symbol.png` | the colour symbol cropped by alpha; `BrandSymbol` puts it on the navy tile — the rail's home link, the assistant's avatar |
| `public/icon-192.png`, `icon-512.png` | PWA icon: colour symbol on a Deep Navy rounded tile (the board's app icon) |
| `public/icon-maskable-512.png` | full-bleed navy, symbol within the 80 % safe zone |
| `public/apple-touch-icon.png` | 180 px, full-bleed navy |
| `public/badge-96.png` | the symbol's silhouette in white (Android uses the alpha) |
| `public/favicon.ico` | the kit's favicon (16/32/48) |
| `public/favicon.svg` | navy tile + the colour symbol as an embedded PNG (not the traced vector, which the kit marks as approximate) |
| `public/brand/logo-on-*.png` | the lock-ups for the offline page (precached with the shell) |

Manifest: `name` / `short_name` "Remyral", navy theme / background colour; `index.html` title "Remyral" and theme
colours of the new page backgrounds.

### Copy

- `packages/i18n` TR + EN: "Remana" / "Remana Agent Cluster" → "Remyral" (product name alone, also in page titles
  "… · Remyral"), Turkish suffixes by vowel harmony after the final "a…l": Remyral’ın, Remyral’a, Remyral’ı,
  Remyral’da, Remyral’dan, Remyral’la. Glossary: "Remyral" in the product names, `remana` and
  `remyral agent cluster` in its `avoid` list (the catalog test rejects them in Turkish copy).
- Assistant: speaker "Remyral", role line "operasyon asistanı" / "operations assistant"; the system prompt opens "You
  are Remyral, the operations assistant of the Remyral platform". The job rules keep "the Remyral Agent Cluster" (their
  bundle hash is a golden value of `packages/memory`; agents only read it).
- Master: TOTP issuer "Remyral" (new authenticator entries; existing ones keep their label, codes are unaffected),
  OpenAPI title "Remyral master API", notification e-mail footer "Remyral notification", GitHub App description,
  the Markdown chat export ends with "Exported with Remyral · remyral.com" (the print / PDF page shows the lock-up
  and the same line). Support mail, support report, PR bodies, trailers and chat notes already said Remyral (core).
- Worker: unit / service descriptions "Remyral worker…" (systemd units, Windows service description).
- Update banner "Güncelleme mevcut: Remyral 1.1.0", PWA "Remyral’ın yeni sürümü hazır", offline page with the lock-up.

### Wizard: domain step and counter

`ONBOARDING_STEPS` (master and console) gain `domain` after `organisation` — "Alan adı ve erişim" / "Domain and
access", read-only, nothing detected (the owner marks it):

- **Public address** — `PUBLIC_ORIGIN` as the installers overview reports it (missing: why links and install
  commands need it).
- **TLS certificate** — the "Keys and expiry" item `tls:public-origin` (the master's TLS handshake to the public
  origin): valid until date + days, expired, not checked, or the check error; a not publicly trusted certificate gets
  a warning. "Sertifikayı şimdi denetle" runs `POST /ops-safety/expiry/check` (admin, audited, no code — it reads
  dates only).
- **Console access** — this browser's origin equals the public origin: reachable; otherwise the address in use and a
  link to open the public one (the browser cannot probe another origin under the console's CSP).
- **Changing it** — on a remyral-ctl install (the update feed is configured): `sudo remyral-ctl install --domain
  <new> --version <installed>`; `install` re-applies the installed release with the stored choices and only the flags
  given change (it refuses another version, hence `--version`), `REMYRAL_DOMAIN` → `PUBLIC_ORIGIN`. Other installs
  (Coolify / EC2): the deployment's `PUBLIC_ORIGIN`. A dedicated `remyral-ctl domain set` was not added: re-running
  install already does it, with its health gate. **Superseded by [p17-domain-wizard](p17-domain-wizard.md)
  (2026-10-24):** the step is a form; the address is a stored setting and a remyral-ctl host applies a new domain
  itself (signed request → `remyral-ctl apply-pending`), no terminal.

Counter: the master counts every step but the completion (now 9). The list numbers those 1–9 and marks the last
entry ("Hazırsın") with a flag instead of "10", so "2/9 adım" matches the list (it said "2/8" next to 9 numbered
rows).

### Light / dark switch

Owner addition: **Açık / Koyu / Sistem** (Sistem is the default and follows `prefers-color-scheme`), in the account
menu and in Ayarlar → Profil → Görünüm ve dil.

- **Stored per account on the master** (the user-preference mechanism of the language): migration 0150
  `users.theme` (NULL = system, CHECK light / dark), `PUT /me/theme {theme}` (own row, CSRF, no step-up, audited as
  `user.theme.change` on a change), `GET /auth/session` → `theme`. A change made on another device is applied when the
  session is read (`ThemeSync`).
- **No flash:** this browser keeps a copy in localStorage (`remyral.theme`, every access in try/catch); the classic
  script `public/theme-boot.js` (loaded from `<head>`, CSP `script-src 'self'`, no inline script) marks `<html
  data-theme>` before the first paint — also on the sign-in / setup screens and the offline page. Blocked storage:
  the system theme applies.
- **CSS:** the dark token blocks match `:root:not([data-theme='light']) [data-ui='diyalog']…` under the dark media query
  and `:root[data-theme='dark'] [data-ui='diyalog']…` otherwise (the classic `--c-*`, the ANSI colours and the offline
  page the same way); a scope root's own `data-theme` (harness, tests) still wins. Every Diyalog colour token now has a
  light and a dark value (`test/theme-switch.test.tsx`; shape and easing tokens are theme-independent).

### Screenshots, English demo data, Turkish style

- `apps/web/e2e/deck-shots.spec.ts` takes the sales / website set in Turkish (default) and in English
  (`DECK_LOCALE=en`: user locale en, browser en-US, and an English demo organisation — `e2e/deck-seed-en.ts`
  translates every seed query, transaction clients included); `DECK_VIEWPORT`, `DECK_ALL_DARK`, `DECK_LOGIN` give the
  review set. The seed marks the setup wizard completed (no setup card in the sales shots). The English run showed
  Turkish job states, "… önce" and chat day separators in the English console (catalog not passed to
  `jobStatePill` / `agoText` / `buildTimeline`); fixed.
- remyral.com v6 set (2026-10-28): user john.doe, English project ids in both languages (customer-portal,
  marketing-site, mobile-app, work areas content-studio and market-research). The tour shots 02 → 06 → 05 → 09 → 15 show
  one job (the invoice PDF export); a last test moves it to its merge decision after the running shots and filters the
  audit trail on it. 16: a real engine-2 run of a weekly content calendar (Claude Code plans, writes and reviews; Codex
  only generates the images, per-step `runtime`) stopped by the engine at its approval step; 17: the research job's
  outputs (report, CSV, chart). Needs `WORKFLOW_ENGINE_V2=true` in the environment (the e2e master inherits it). The
  work area is allowlisted only on an offline machine (pi-edge), so its step jobs wait (transient) and the spec finishes
  them in the database before a worker process sees them.
- Plan mode set 18 (2026-10-28, p18-plan-mode W1 + W2): `DECK_ONLY=18` seeds two planned conversations through the
  master's own `ChatPlanService` / `QuestionService` (master/dist on the e2e pool, as the plan tools call them; tool
  lines carry the turn's meta) — "Fatura PDF dışa aktarma lansmanı" (executing, 3/8, job items derived from the seeded
  research / newsletter / PDF jobs by the service's own tick, one decision) and "Kasım kampanyası" (in review, plan mode
  on, two decisions with a recommended option). Only when 18 is taken, so 02 / 03 keep their conversation list. Shots:
  18 / 18-plan-panel-items (column, top and scrolled to the current item), 18b (review card + decisions), 18c (plan-mode
  composer, header badge), 18d (phone 390x844 @3x: pill, sheet 50 % and 90 %). Seen: a decision's tool line also makes a
  plan card (the strip shows the plan card once per plan tool line); the slash chips stay Turkish in English
  (`/iş`, `/yayınla`, …).
- Owner style rule: no circumflex in Turkish copy ("yapay zeka", "hala", "kağıt", "resmi"); all occurrences replaced
  and `pnpm check:i18n` fails on â / î / û in the TR catalogs (docs/design/i18n-glossary.md).

### Compatibility, rollback

One additive migration (0150 `users.theme`), one new route (`PUT /me/theme`) and one more session field; no
protocol change (one more onboarding step id; an older console would reject the new id in the
onboarding view, but console and master ship together). Rollback: the previous web image and master (the column is ignored by older code). A **worker
release** carries the assistant prompt wording and the unit descriptions; until then installed workers keep the old
prompt sentence (no functional effect).

### Unverified

- Real devices: the installed PWA icon / maskable crop on Android and iOS, the SVG favicon with an embedded PNG in
  Safari and Firefox (Chromium only here).
- The print / PDF export in dark mode prints the white wordmark if the browser keeps the dark theme (as before for the
  text colours).
- The domain step against a real self-hosted install (re-running `remyral-ctl install --domain`) — the command follows
  `infra/selfhost/remyral-ctl` (validate_install_flags, the same-release check) and its tests, not a live run.
