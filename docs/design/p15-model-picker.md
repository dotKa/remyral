# p15-model-picker — choose models from a list, defaults per runtime and machine (+ lightbox fix)

- **Task:** `p15-model-picker`. **Date:** 2026-10-23.
- **Owner request:** "makinelerde varsayılan modeller kullanılıyor, modelleri el ile yazıyoruz; desteklenen modeller
  listelensin ve bu modellerden istediğimizi seçebilelim."
- **Builds on:** [p5-credentials-models](p5-credentials-models.md) (model profiles, `model_defaults`, worker
  configuration `runtimes.<kind>.model`), [p3-runtime-policy](p3-runtime-policy.md) (policy profiles),
  [p6-smart-routing](p6-smart-routing.md) (routing before defaults), [p11-usage-limit-fallback](p11-usage-limit-fallback.md).
- **Migration:** 0137 (0136 is reserved for the parallel chat-failover work). **Worker release:** yes
  (`runtime-models-v1`). **Protocol:** additive in 1.0. No new ADR: amends the p5-credentials-models resolution order
  (§4 below).

## 1. What was typed by hand (inventory)

| Place (Diyalog) | Field | Now |
| --- | --- | --- |
| Ayarlar → Modeller → profile form | provider model id | picker (selected runtimes' models; Pi / OpenCode ids fill provider + model) |
| Ayarlar → Modeller → Varsayılanlar | profile only | picker: profiles + catalog models + custom id (new: model-id defaults) |
| Makineler → makine → Yapılandırma → Runtime ve modeller | Claude Code / Codex model, Pi provider + model, OpenCode model | picker per runtime with "Bu makinede mevcut" (Pi keeps its provider field for provider-only setups) |
| İş oluştur (composer) | model profile select | picker: profiles + catalog models + custom |
| Şablon formu | free text "Model profili" | picker |
| Workflow editor → step / workflow defaults | free text model | picker (step runtime, else workflow runtime) |
| Proje → Politika → kullanım limiti yedekleri | free text profile | picker (profiles + models) |
| Kullanım → Uygulama → genel limit yedekleri | "codex, opencode:kimi-k2" text | one row per fallback: runtime + picker (the text form broke on ids with `:`) |
| Ayarlar → Sohbet → model profile / fallback model profile | profile selects | picker: profiles + models (new: model ids stored) |
| Assistant `draft_job` / `draft_automation` `modelProfile` | profile ids only (`[a-z0-9._-]`) | profile id **or** catalog model id (Pi / OpenCode `provider/model`) |

The classic console (`apps/web/src/screens/*`) is unchanged apart from reading the new default shape.

## 2. Where the list comes from

**Built-in catalog** (`packages/protocol/src/runtime-models.ts`, `BUILTIN_RUNTIME_MODEL_CATALOG`,
`RUNTIME_MODEL_CATALOG_VERSION = 2026.10.23-1`): per runtime the ids, display names, alias / exact model, what an alias
resolves to, context window, notes, access (subscription / API key) where known. Sources (verified 2026-10-23 with the
ctx7 docs and the installed CLIs): Claude Code `--model` aliases (`fable`, `opus`, `sonnet`, `haiku`, `best`,
`opusplan`) and full ids from code.claude.com/docs/en/model-config (`[1m]` suffixes are left out: the model id rule has
no brackets); Codex `codex debug models --bundled` (codex-cli 0.163.0, visibility `list`); Pi / OpenCode `provider/model`
for Anthropic / OpenAI only. It is maintained by hand and ships with a master / worker release (never fetched at run
time); bump the version whenever it changes.

**Machine lists** (worker `apps/worker/src/runtimes/models.ts`, CAPABILITIES `runtimeModels`, feature
`runtime-models-v1`): read-only list commands, no model request, plain helper environment (no credential injected),
30 s timeout, bounded output, cached 6 h, re-listed when the runtimes are reconfigured:

| Runtime | Command | Parsed |
| --- | --- | --- |
| OpenCode | `opencode models` | `provider/model` per line (configured providers) |
| Pi | `pi --list-models` | table `provider model context …` → `provider/model` + context (models with a key) |
| Codex | `codex debug models`, else `codex debug models --bundled` | JSON `models[].slug` (visibility ≠ `hide`) — refreshed for the login's account |
| Claude Code | — (no list command) | the release catalog's aliases + ids (`source: builtin`), only when installed |

A failed command is reported `failed` with one redacted line; ≤ 500 models per runtime (`truncated`). Verified against
opencode 1.19.0 / pi 0.85.1 / codex-cli 0.163.0 on the dev Mac; pins are opencode 1.19.0, pi 1.1.0, codex 0.162.1 —
**pi 1.1.0 and codex 0.162.1 output unverified** (a different shape falls back to `failed`, the console to the catalog).

**Merge** (`mergeRuntimeModels`, master `GET /models/runtimes`): catalog models first (catalog order), then models only
machines listed; each with the machines it was seen on (and the login kind). Machines without the feature are listed as
`supported: false` (the picker says "makinenin güncellenmesi gerekiyor"). Per-account lists (several Claude / Codex
accounts on one machine) are not separated: the list is the default login's.

## 3. API

- `GET /models/runtimes?runtime=&project=` (every console role): `{catalogVersion, runtimes: [{runtime, models,
  machines, defaults: {global, project, machines}}]}`.
- `PUT /models/defaults` takes `model` (a model id, validated like every model field; secret scan) instead of
  `profileId`; exactly one. `GET /models` defaults carry `{profileId, model}`.
- `PUT /chat/settings` takes `model` / `fallbackModel` (exclusive with the profile; absent = unchanged while the
  engine stays).
- Assistant read tool `list_runtime_models {runtime?, project?, query?}` (≤ 60 models per runtime, machines,
  `updateNeeded`, defaults); draft `modelProfile` accepts catalog ids.

## 4. Defaults and precedence

job's model > routing rule > **project** default (profile or model id → the job's `model`) > global default profile
(as before) > **machine's own default** (`runtimes.<kind>.model` / `modelProfile`) > **global default model id** >
the runtime's own default.

The global model-id default is *soft*: the master puts it in `JobSpec.defaultModel` (never trusted from a submitter);
the worker uses it only when its configuration names no model for the runtime and its runtime policy defines no
profiles (`runtime-gate.ts`). Older workers strip the field — their own default applies (no breakage, but the global
default model only takes effect after the worker update). The global *profile* default keeps its old (hard)
behaviour — parity.

## 5. The picker (`DyModelPicker`)

Searchable combobox (`role=combobox` + `listbox`, ↑/↓/Enter/Escape; Escape never closes an enclosing dialog), rendered
in place (works inside modal drawers). Order: "Varsayılan (runtime'ın kendi seçimi)" (or the caller's default text,
e.g. "Varsayılan: sonnet"), model profiles, "Bu makinede mevcut" (with a machine) / "Makinelerde mevcut", "Katalog",
"Özel model adı…". The custom id is validated with `modelIdIssue` (exactly the old free-text rule, so nothing that
worked typed by hand breaks); a value not in the list shows an "Özel" badge and a note. When the master cannot answer,
the built-in catalog of the console's bundle is offered.

## 6. Security

Model ids only cross the wire; list commands get no credential (the helper environment), outputs are parsed, bounded
and never logged; a failed command's line is redacted (`key=` / `token=` / `sk-`). Defaults stay admin + step-up and
audited (`model.default.set` metadata now has `model`); chat settings stay `chat.admin` + step-up.

## 7. Lightbox fix (found during the screenshot tour)

Opened from the Çıktılar drawer the image lightbox was portalled into `document.body`: outside `[data-ui="diyalog"]`
(no `--dy-lightbox` backdrop, white text on the page) and below the drawer — a modal `<dialog>` lives in the top layer
and makes the rest of the page inert. `DyLightbox` now portals into the nearest open `<dialog>`, else the Diyalog scope
root (`lightboxHost`); web tests assert both.

## 8. Rollback

Web + master roll back together; migration 0137 is additive (see its header for the clean-up of model-id rows before
an old master). Workers: an older worker ignores `defaultModel` and reports no list.

## 9. Unverified

Real fleet: `pi --list-models` 1.1.0 and `codex debug models` 0.162.1 output, Windows / Raspberry Pi runs of the list
commands, Codex refresh on ChatGPT subscription vs API key logins, the real assistant using `list_runtime_models`.
