# Design note: `p16-runtime-updates` — unverified runtime updates, the automatic verification pipeline, honest update buttons

- **Task:** `p16-runtime-updates`. **Date:** 2026-10-23. **Migration:** `0141_runtime_updates.sql` (after `0140_workflow_quality` on
  main; renumber at merge if a parallel change takes it).
- **ADR:** [ADR-0012](../adr/0012-runtime-integration-surfaces.md) amendment 2026-10-23 (a version above the release pin
  may be installed by owner policy, always `unverified`); [ADR-0056](../adr/0056-owner-configurable-security-policy-and-autonomy.md)
  amendment (the policy gets `fleet.unverifiedRuntimeUpdates`).
- **Owner decision (2026-10-23, explicit):** a runtime version newer than the worker release's pin must be installable,
  marked "doğrulanmamış", through a security-policy setting that is **on by default in every preset** ("varsayılan açık
  olsun"). Off = today's behaviour (pin only).
- **Diagnosis (prod, 2026-10-23):** runtimes are pinned per worker release (`RUNTIME_PINS`: claude-code 2.1.296, codex
  0.162.1, pi 1.1.0, opencode 1.19.0). The version feed shows newer versions (claude-code 2.1.309, codex 0.164.0, pi
  1.4.0, opencode 1.19.4), so the matrix counted "9 güncelleme"; the cells were `blocked = release_update_required`,
  `#plan` answered `version_not_available`, `POST /fleet/tools/actions` 409 `nothing_to_do` — and the console swallowed it.
- **Builds on:** p13-fleet-tools (matrix, bulk actions, canary-first), p5-remote-ops (signed OPS_COMMAND, the worker's
  own installer and checks), p14-mcp-stdio (npm resolution with `--package-lock-only --ignore-scripts`, lock sharing,
  verify-before-unpack), p3-runtime-policy (pins, canary), ADR-0008 (truthful capabilities).
- **Worker release:** required (new op fields, the `runtime.verify` op, the installer path, capability flag, the
  assistant tool and prompt rule 40). Master first: an older worker never gets an unverified install (feature gate).

## 1. The policy setting

`SecurityPolicyDocument.fleet.unverifiedRuntimeUpdates: boolean` — a new section like `apiTokens`. **true in Serbest,
Dengeli and Sıkı.** Effective value, patch, minimal document and `changedPaths` follow the existing pattern, so a change
is audited by the existing `security.policy.update` entry with the path `fleet.unverifiedRuntimeUpdates` (console or
chat channel) and a new policy version. Read by the master only (the worker never sees the security policy):

| Setting | Off (today's behaviour) | On (default) |
| --- | --- | --- |
| Install a version outside the worker's pinned set | skip `unverified_updates_disabled` (409 lists it) | allowed, `unverified` |
| Jobs on an installed unverified version | not placed (`runtime_version_unverified`, as before) | placed; capabilities stay `unverified` |
| Automatic verification on a canary | not run | daily + on a feed change |
| Rollback to the pin | always allowed | always allowed |

## 2. Install path (master → worker)

1. **Resolve (master).** `RuntimeReleases.resolve(runtime, version)` reads the exact version document
   `https://registry.npmjs.org/<package>/<version>` (feed boundaries: `VERSION_FEED_HOSTS`, https, no redirects, no
   credentials, 10 s, 4 MiB) and takes `dist.integrity` (sha512 SRI, required) — never `latest`, never a range. Packages
   are the release's own roots (`@openai/codex`, `@earendil-works/pi-coding-agent`, `opencode-ai`; Claude Code: the agent
   SDK `@anthropic-ai/claude-agent-sdk` whose `claudeCodeVersion` must equal the requested CLI version — the SDK version
   is derived from the pinned SDK line, `0.3.<cli patch>`, and refused when the field differs). The answer is stored in
   `runtime_candidates (runtime, version)` with the package, package version and integrity.
2. **Plan.** `runtime.install` with `unverified: true` (or a requested version outside the worker's set) per machine:
   `unverified_updates_disabled` (policy off), `worker_update_required` (no `runtime-unverified-v1`),
   `platform_unsupported`, `unverified_install_unavailable` (the worker has no npm next to its Node), `version_not_newer`
   (only versions above the pin; going back is the pin), `already_current`, `not_operable`. A version in the pinned set
   always takes the pinned path.
3. **Send.** The signed OPS_COMMAND `runtime.install` carries `unverified: { package, packageVersion, integrity, lock? }`
   (covered by the command signature). The first machine resolves the dependency tree itself; its lock is stored on the
   candidate and sent to every later machine, so the fleet runs the same tree (p14-mcp-stdio pattern).
4. **Worker.** `RuntimeInstaller.installUnverified` re-checks everything: the runtime has an npm install set, the
   package equals the release's root for that runtime, the version is above the pin and not in the pinned set, the
   machine is not busy and has the free space. Without a lock it runs the worker's own npm (`install --package-lock-only
   --ignore-scripts --omit=dev`, empty user/global npmrc, registry fixed to registry.npmjs.org, env limited to the proxy
   variables). The lock must be v3, every package from registry.npmjs.org with a sha512, no links; the root must be
   exactly `package@packageVersion` with the signed integrity; packages with install scripts are refused unless the
   pinned lock of the same runtime has the same package flagged (scripts never run anyway — opencode-ai, protobufjs,
   @google/genai today). Every tarball is downloaded by the worker's own fetcher and checked against its sha512
   **before** extraction (the pinned installs' code path). After staging: the runtime's own `--version` must print the
   requested version (Claude Code: also the SDK's `claudeCodeVersion`), else the stage is removed
   (`version_mismatch`). Then it becomes the active version; state.json records `unverified: { pin, package,
   packageVersion, lockSha256 }`. Same unprivileged, worker-owned layout as before (`<dataDir>/runtimes/<rt>/<v>/`).
5. **Truthful labels.** The probe compares with the pin, so every capability is `unverified` with
   `installed version X differs from pinned Y` (ADR-0008 unchanged). CAPABILITIES marks the runtime
   `unverifiedUpdate: true` (stored as `worker_runtimes.unverified_update`); the remote-ops report marks the installed
   version `unverified: { pin }`. The console badge: **Doğrulanmamış sürüm (pin: X)**.
6. **Jobs still run.** The worker gate admits a job on the active, intact, owner-installed unverified version (as if the
   rule had `allowUnpinned` + `allowUnverified` for exactly that version); placement treats such a runtime as usable
   while the policy is on. Unsupported capabilities stay refused.
7. **Rollback** is `runtime.install` of the pin: always allowed below an unverified active version (the installer's
   downgrade rule now also accepts the current pin); an intact earlier install is re-activated without a download. One
   button per machine ("Pin’e geri dön (X)") and fleet-wide (Toplu işlem, version = pin). Canary-first works unchanged.

## 3. The verification pipeline — what is automated and what is not

`RuntimeVerificationService` (master, every hour and right after a feed refresh that changed a runtime's latest
version; at most one run per runtime version per 24 h after a failure, a pass is final): for each runtime whose feed
version is above the release pin and allowed by the policy, it resolves the candidate (§2.1) and sends `runtime.verify`
to **one connected canary machine** (`worker_runtime_policies.canary`, `runtime-unverified-v1`, platform supported).
No canary → the console says so; nothing runs elsewhere. Actor: system (`runtime-verify`), audited
`worker.ops.runtime.verify` and `fleet.runtime.verify` with the outcome.

The worker installs the candidate into a scratch dir `<dataDir>/runtime-verify/<rt>/<v>/` (never activated, removed
afterwards) and runs the checks it can run without credentials:

| Check | How | Required |
| --- | --- | --- |
| `integrity` | lock root = signed registry integrity; every tarball sha512 before unpacking | yes |
| `version` | `<runtime> --version` prints the requested version | yes |
| `bundled_version` | Claude Code: the SDK's `claudeCodeVersion` | Claude Code |
| `help` / `server_auth` | `--help` exits 0 with output; OpenCode: loopback server with a random password, 401 without / 200 with it, version from `/global/health` | yes |
| `adapter_probe` | the adapter's own `probe()` on the scratch executable (no session, no model request) reports the version | yes |
| `headless_prompt` | **skipped** — needs a model credential and spends tokens; the live suites stay manual | no |
| `contract_suite` | **skipped** — the adapter contract kit with scripted providers runs in the repository's test suites (p3), not on a worker | no |

A run where every required check passed makes the version a **verified candidate** (`runtime_candidates.verify_state =
passed`, checks, machine, OS/arch, lock). This is exactly "the automatable subset passed on one machine" — it is not a
contract test, the version stays `unverified` in capabilities until it is the release pin. The console shows the
candidate with its checks and a download of the lock.

**Promotion** (the owner, or the Claude-run release process): `node scripts/release/promote-runtime-pin.mjs --runtime
<rt> --version <v> --lock <package-lock.json from the console>` rewrites the mechanical pin sources (runtime-pins.ts,
runtime-checksums.json, the image package.json / lock, the previous-pin snapshot, the adapter pin constant, the dev
runtimes image ARG, the docs rows `pnpm security:pins` checks) and regenerates the install manifest; it prints what
stays human: ADR-0012 note, the compat checklist, Claude Code's SDK dependency of @remyral/agent-adapters + `pnpm
install`, CHANGELOG, a worker release. The master never commits or releases anything.

## 4. Console

- Matrix cells (runtime): `unverifiedAction` (version from the feed, when the policy and the worker allow it),
  `unverifiedActive: { version, pin }`, `rollback: { version }`, and `blocked` codes for the rest. Summary:
  `updates`, `installable` (an action exists — pinned or unverified), `releaseRequired` (only a worker release can bring
  it). Badge: "N güncelleme" with "K kurulabilir · M worker sürümü gerektirir".
- Every skip reason has Turkish text (`version_not_available` → "Bu sürüm bu worker sürümünde sabit değil" with the
  button "Doğrulanmamış olarak kur", `worker_update_required`, `machine_admin_required`, `already_current`,
  `not_operable`, `unverified_updates_disabled`, `version_not_newer`, `runtime_release_not_found`, …). A 409 `nothing_to_do`
  is never swallowed: the dialog lists the server's per-machine reasons.
- Makine → Runtime’lar: badge "Doğrulanmamış sürüm (pin: X)", "Doğrulanmamış olarak kur (Y)", "Pin’e geri dön (X)".
- Araçlar ve sürümler: "Doğrulama adayları" panel (state, checks, machine, lock download, "Şimdi doğrula").
- Ayarlar → Güvenlik: switch "Doğrulanmamış runtime güncellemeleri".

## 5. Assistant

`worker_release_status` and the fleet descriptions mention the option; new draft tool `draft_runtime_update` (runtime,
version | latest, machines | all, rollout, `unverified`, `rollback`) → card kind `runtime_update` → the same
`FleetToolsService.create` with the caller's permissions (admin, step-up event of `POST /fleet/tools/actions`). Prompt
rule 40: say "doğrulanmamış" and the pin, never call an unverified version verified, offer the rollback.

## 6. Data (migration 0141)

`runtime_candidates` (resolved release + lock + verification state), `runtime_verifications` (one row per run),
`worker_runtimes.unverified_update`, `worker_ops.kind` + `runtime.verify`, `chat_drafts.kind` + `runtime_update`.
Additive; rollback: the old master ignores the columns and tables.

## 7. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| A tampered / republished tarball | registry integrity read by the master, signed into the command; npm lock root must match it; every tarball sha512-checked before unpacking | worker installer fixtures |
| Arbitrary package via the op | worker accepts only the runtime's root package; master builds it from the catalog | worker refusal test |
| `@latest` drift | exact version documents only; the lock pins the tree; one lock fleet-wide | master unit |
| Install scripts | `--ignore-scripts`, scripts never run; new script packages refused | worker test |
| Weaker path than the pinned one | same signed OPS_COMMAND, admin + step-up, rate limits, canary-first, unprivileged dir | integration |
| Silent unverified use | capabilities `unverified`, badge, audit `fleet.tools.action` with `unverified: true`, policy off stops placement | integration |
| Verification that pretends | only the listed checks; headless prompt / contract suite reported `skipped`; "verified candidate" ≠ supported | design + UI text |
| Master without outbound internet | `FLEET_TOOLS_FEED=off` → resolve refused `feed_disabled`, nothing installed | unit |

## 8. Tests

protocol (schemas, digest covers `unverified`), worker (installUnverified with fixture registry + fixture lock, refusals,
version check, rollback re-activation, verify op checks, gate admission), master unit (matrix cells / summary, plan
reasons, resolve), master integration (policy default on, unverified action accepted and routed with the source, policy
off, skip reasons in the 409, rollback to the pin, verification recorded, lock stored and reused), web (buttons, reason
texts, 409 list, badge, security switch).

## 9. Unverified

A real unverified install on the production machines (Windows: npm next to the service's Node), the opencode
`server_auth` check on Windows, Claude Code's bundled SDK JS (0.3.296 in the worker) driving a newer CLI — exactly why
those versions stay `unverified`.
