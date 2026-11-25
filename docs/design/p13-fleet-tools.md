# Design note: `p13-fleet-tools` — tool and runtime versions across the fleet, bulk updates, custom tools

- **Task:** `p13-fleet-tools`. Owner feedback 2026-10-20 (screenshot of Machine → Araçlar listing "git bulunamadı
  sistem" next to "git 2.56.0.2 worker kurdu"): *"Bu ekranda listede worker tarafından kurulanlar ve sistem
  tarafındakiler ayırt edilmeli, tab yapabiliriz. Ayrıca claude, codex vs. tool'ların hepsinin versiyon kontrolü
  yapılmalı. Hatta tüm makinelerdeki tool'lar kolayca güncellenebilmeli veya hepsine bir tool veya özel araç
  kurulabilmeli."*
- **Date:** 2026-10-20
- **Decision record:** ADR-0052 (custom tool installs — the one new security boundary).
- **Binding inputs:** ADR-0017 (remote ops: signed OPS_COMMAND, worker re-checks), ADR-0021 (machine admin: owner
  opt-in per machine, every elevated command approved, local veto), p3-runtime-policy (pins, canary, promote,
  rollback), p5-machine-admin §2 (inventory, release recipes), ADR-0009 (step-up), ADR-0011 (additive protocol).
- **Owner note (TR):** docs/guide/tr/makine-yonetimi.md → "Araçlar ve sürümler".

## Shape

```
packages/protocol  fleet-tools.ts: normalizeVersion / compareVersions / versionStatus, resolveEffectiveTools,
                   CustomToolRecipe (+ issues), CustomToolInstall, customPackageCommands / customPackagePrompt,
                   CUSTOM_TOOL_HOSTS, VERSION_FEED_HOSTS, RESERVED_TOOL_NAMES; tools.ts EffectiveTool +
                   ToolInventoryReport.effective (additive); remote-ops.ts OPS tool.install.custom / tool.remove.custom;
                   feature custom-tools-v1
apps/worker        tools/detect.ts (system hits inside the tools dir are not "system"; custom entries with their own
                   version check), inventory.ts (report.effective with the configured gitBinary), installer.ts
                   (installCustom / removeCustom into tools/custom/<name>/<version>/), tool-env.ts (custom bin dirs
                   appended to PATH), remote-ops/agent.ts (the two ops, group `install`), daemon gate customAllowed,
                   localCeiling.allowCustomTools
apps/master        migration 0100; fleet-tools/ catalog.ts, feed.ts (VersionFeedService), matrix.ts (pure),
                   recipes.ts (CustomRecipeStore), service.ts (FleetToolsService: view, bulk actions, dispatch, sync,
                   continue / retry / cancel, tick, digest), routes.ts; remote-ops kinds; notification tools.updates;
                   config FLEET_TOOLS_FEED
apps/web           Makine → Araçlar (Etkin rows, Sistem / Worker’ın kurdukları tabs, filters, chips, update button),
                   Makine → Runtime’lar version line, /machines/tools "Araçlar ve sürümler" (matrix, Toplu işlem,
                   actions, Özel araçlar, digest switch), Machines and Home badge "N güncelleme"
```

## 1. Machine → Araçlar: system vs worker, and the effective one

- The inventory already had `source: system | managed`. Two fixes on the worker:
  - A PATH hit whose path lies inside `<dataDir>/tools` (e.g. MinGit's `cmd` added to the machine PATH) is the managed
    install; the system entry becomes "not found" so one install is never listed as both.
  - `toolInventory.effective` (additive) says which install jobs use: the worker config's `gitBinary` (git) → the
    newest found managed install (its bin dir goes in front of the runtimes' PATH, tool-env.ts) → the first found
    system install. `resolveEffectiveTools` is shared; the panel computes it itself for older workers.
- The tab shows "Etkin" rows first ("git — Etkin: worker’ın kurduğu 2.56.0.2 · sistemde bulunamadı"; a shadowed
  install is named "kullanılmıyor"), then tabs **Sistem** / **Worker’ın kurdukları** (custom tools marked "özel")
  with counts and filters bulundu / bulunamadı / güncelleme var. Every earlier feature (Yeniden tara, Makineyi incele,
  recipes, elevated install through machine admin) stays.

## 2. Versions: installed, pin, latest

- **Installed:** runtimes from `worker_runtimes` (present rows; source `managed` when the remote-ops report's active
  version is it, else `path`); tools from the effective inventory entry.
- **Pin:** runtimes — the pin the worker compared against (its applied runtime policy, else `RUNTIME_PINS`); managed
  tools — the release recipe version the worker reports; system tools have no pin of ours. The browser recipe is a
  Chromium revision, compared through the Playwright release behind it (`PLAYWRIGHT_PIN` 1.64.1).
- **Latest:** read by the **master** (never the panel or the worker) every 6 h and on "Sürümleri şimdi kontrol et"
  (admin + step-up), cached in `tool_version_feed`:

  | Item | Source |
  | --- | --- |
  | claude-code, codex, pi, opencode, browser (Playwright) | `registry.npmjs.org/<pkg>/latest` |
  | git (Git for Windows), uv, cloudflared, ffmpeg (gyan.dev builds) | `api.github.com/repos/<repo>/releases/latest` |
  | python (python.org's Windows package) | `api.nuget.org/v3-flatcontainer/python/index.json` |
  | node (latest LTS) | `nodejs.org/dist/index.json` |

  Only https on `VERSION_FEED_HOSTS`, checked before each request; `redirect: 'error'`, no credentials or cookies, a
  fixed User-Agent, 10 s timeout, 4 MiB body cap, one request per distinct source. A failure stores `ok = false` and a
  short reason and keeps the last good version → the panel says **kontrol edilemedi**. `FLEET_TOOLS_FEED=off`
  disables reading (masters without outbound internet: **henüz kontrol edilmedi**).
- **Status** (`versionStatus`): `not_found`; `pin_differs` (a pin applies and the installed version is another one);
  `update_available` (the source has a newer one); `current`; `unknown`.
- **Action per cell:** runtime → `runtime.install` of the pin when the worker's pinned set (`available`) has it and it
  differs; managed tool → `tool.install` of the release recipe; Linux without the tool → `tool.elevated` (machine
  admin); custom → `custom.install`. Otherwise a `blocked` code: `release_update_required` (upstream is newer than
  anything this worker release can install — versions only come with a release, AGENTS.md rule 12),
  `worker_update_required`, `platform_unsupported`, `machine_admin_not_enabled`, `not_operable`.

## 3. Fleet view and bulk actions

`GET /fleet/tools` (viewer+) returns catalog × machines. A bulk action (`fleet_tool_actions` + one
`fleet_tool_action_targets` row per machine) is planned per machine (version, or a skip reason such as
`version_not_available`, `already_current`, `machine_admin_not_enabled`), then dispatched:

| Kind | Route / authz | Per target |
| --- | --- | --- |
| `tool.install`, `tool.remove`, `runtime.install` | `POST /fleet/tools/actions`, `workers.ops.write`, step-up | `RemoteOpsService.request` (signed OPS_COMMAND; pinned-set preflight; per-machine and per-admin rate limits) |
| `tool.elevated` | `POST /fleet/tools/admin-actions`, `machines.admin.run`, always-fresh | `MachineAdminService.createTask` with the release's elevated recipe |
| `custom.install` (package step) | same | `createTask` with `customPackagePrompt` (fixed command list) |
| `custom.install` / `custom.remove` (download step) | same | OPS_COMMAND `tool.install.custom` / `tool.remove.custom` |

- **Offline machines** keep their target `queued` until they reconnect (session hook + 15 s tick) or the action
  expires (1–168 h, default 24; machine administration at most 24 h) → `expired`. `worker_offline` / `rate_limited`
  refusals requeue; at most 10 attempts.
- **Deferred dispatch** re-checks that the creator is still an enabled owner / admin (`actor_not_authorised`
  otherwise). The step-up was given for this action when it was created; each machine-admin command still needs its
  approval at run time.
- **Canary first** (default for runtimes in the dialog): targets on canary machines (`worker_runtime_policies.canary`)
  run first, the others are `held`; `continue` (admin + step-up) is refused while a canary target is open
  (`canary_running`) or failed (`canary_not_verified`). The runtime **pin** itself is still set in Settings →
  Runtimes (canary → promote → rollback, p3-runtime-policy); the fleet action installs a version of the worker's
  pinned set, and the dialog links there.
- `retry` (failed / expired), `cancel` (what has not left; sent operations finish on their machine), progress per
  machine (op / job state followed through `RemoteOpsService.op`, which also marks lost operations), audit
  `fleet.tools.action`, `.continue`, `.retry`, `.cancel`, `.done`.

## 4. Custom tools (ADR-0052)

- Recipe (`CustomToolRecipe`): name (`^[a-z][a-z0-9-]{1,31}$`, not a reserved tool name), title, version, per platform
  either **download** `{url, sha256, size, format zip|tgz|raw, strip?, entry}` — https on `CUSTOM_TOOL_HOSTS`, SHA-256
  and size mandatory, entry a safe relative path (Windows: .exe/.cmd/.bat) — or **package** `{manager winget | brew |
  apt | dnf | npm | pipx, package}` with a per-manager id syntax and OS check; version check `{binary?, args}` (fixed
  argument syntax, no shell). Stored in `custom_tool_recipes`; create / replace / delete are `machines.admin.run` +
  always-fresh step-up, audited with host + sha256 per platform; secret-looking text is refused.
- A download install travels as `tool.install.custom` carrying only that platform's download. The worker re-validates
  host and path, refuses unless machine administration is enabled for it by the owner and its local ceiling allows
  machine admin and custom tools (`localCeiling.allowCustomTools`), downloads with the pinned SHA-256 and size before
  extracting anything (the release recipes' code path), and records the entry digest (a modified install is not
  reported or used). Custom bin dirs go at the **end** of the runtimes' PATH.
- A package install is a machine-admin job whose prompt lists the exact commands built from the validated ids
  (e.g. `npm install -g <pkg>@<v>`, `winget install --id <id> --exact …`); each elevated command is approved unless
  full access is allowed.

## 5. Notifications and badge

`tools.updates` (owners and admins), Mondays from 08:00 UTC, once per ISO week (dedupe `tools.updates:<week>`), when
the fleet has updates or pin differences; switch "Haftalık güncelleme özeti" (`PUT /fleet/tools/settings`, admin +
step-up, default on). Machines and Home show "N güncelleme" (`summary.updates`).

## 6. Data (migration 0100)

`tool_version_feed`, `custom_tool_recipes`, `fleet_tool_actions`, `fleet_tool_action_targets`, `fleet_tool_settings`
(one row), `worker_ops.kind` + `tool.install.custom` / `tool.remove.custom`, notification kind `tools.updates`. Additive:
rolling back the code leaves the tables unused.

## Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Bulk path weaker than the single-machine path | Each target is the same remote op / machine-admin job; release recipes and runtime installs: admin + step-up; elevated and custom: admin + always-fresh; machine admin per machine opt-in unchanged | integration fleet-tools (403 viewer, step_up_required, wrong_route), rbac-matrix, route-coverage, step-up unit |
| Queued action used long after the admin left | Expiry (≤ 7 d, ≤ 24 h for machine admin); creator re-checked at dispatch; cancel | integration expiry; service `actor_not_authorised` |
| Compromised / careless admin downloads a malicious binary | Allowlisted hosts (master and worker), mandatory SHA-256 + size, owner's machine-admin opt-in + local veto, unprivileged install into the worker's dir, appended (not prepended) to PATH, reserved names, audit with host + digest | protocol / master unit, worker fleet-tools, integration custom tools |
| Command injection through package ids / check args | Regex-validated ids per manager, fixed command templates, check args regex, no shell for version checks | protocol fleet-tools |
| Feed SSRF / data exfiltration | Fixed URLs built from the catalog, host allowlist, no redirects, no credentials, bounded body | master unit + integration feeds |
| Feed answer spoofing | Latest is informational only: nothing is installed from a feed; installs use release pins / admin recipes | design |
| Duplicate side effects (at-least-once dispatch) | Target state machine; one op per send; worker replay protection on command ids | integration |

Residual risks: a release artefact host (e.g. github.com) hosts anyone's files — the SHA-256 the admin enters is
the real gate, so the admin must take it from the publisher; brew / winget as SYSTEM / root behave differently per
machine (brew runs as the console user) — UNVERIFIED on real machines.

## Verification

- protocol `fleet-tools.test.ts`; worker `fleet-tools.test.ts`; master `unit/fleet-tools.test.ts`,
  `integration/fleet-tools.test.ts`, rbac-matrix, route-coverage, step-up; web `fleet-tools.test.tsx` + the existing
  machine tab suites.
- **UNVERIFIED (needs the Windows worker):** a real `tool.install.custom` and the new inventory classification on
  desktop-pc after the worker release; winget / brew package installs; live feeds from the production master.
