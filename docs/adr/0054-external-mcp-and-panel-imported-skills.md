# ADR-0054: External MCP servers for jobs, and panel-imported skills

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (request 2026-10-20: agents should use MCP servers; adding outside skills should not need
  manual signing; skills and MCP servers should be installable from the chat). The four recommended decisions of
  docs/design/p14-mcp-skills.md §10 were approved on 2026-10-20 ("Kararlar (2026-10-20, sahibi önerileri onayladı)",
  the internal note `mcp-skill` (not published)). Implemented in phases by `p14-skill-import` (P0 + P1) and later p14 tasks.
- **Amends:** ADR-0021 §7 (the panel skills key now also signs skills imported in the panel, not only chat drafts);
  ADR-0018 / ADR-0025 are unchanged (no external MCP for the assistant).
- **Related:** docs/design/p14-mcp-skills.md (full design, phases, threat table), p6-skills, ADR-0010, ADR-0016,
  ADR-0019, ADR-0031, ADR-0034, ADR-0045, ADR-0052.

## Context
Skills reach jobs only as signed bundles. The upload route accepted only bundles signed offline with the owner's key
(`scripts/skills/sign.mjs`), which the owner finds an unnecessary step. The master already holds a second, panel
skills key (ADR-0021) that workers trust through their signed managed configuration, used only for chat-written skills
an admin confirms. Agents have no external MCP servers; repository MCP configs are ignored on every runtime.

## Decision
1. **Skills: panel import without manual signing (P1).** An admin imports a skill from a folder, a zip or a GitHub
   folder link. The master builds a **preview** (`skill_imports`, 24 h): the files in today's layout, findings (a
   secret, a file outside the layout, a binary file or a limit violation **blocks**; executable content, risky
   instructions, hosts, missing name / description are warnings; moved / skipped files and the license are info), the
   suggested id / title / description / version and a diff against the latest version. Publishing is admin +
   **always-fresh step-up**; the panel key signs it, the version stores its **provenance** (`upload | zip | github |
   catalog | chat` with repo / path / ref / commit / file name / import id, immutable), the **owners get a critical
   notification** (`skills.panel_published`) on every panel-signed publish (imports and chat drafts), and every step is
   audited (`skill.import.preview|publish|discard`). The offline upload path (`POST /skills`) is unchanged.
2. **GitHub reads are pinned and fixed-host.** The pasted link is parsed into owner / repo / ref / folder; the master
   only ever requests `https://api.github.com` (no redirects, no cookies, 10 s, ≤ 4 MiB per response, ≤ 80 requests per
   import): the ref is resolved to a commit SHA, trees are walked by SHA, every blob is read by SHA and checked against
   its git blob hash. Public repositories need no credentials; for a private one the panel GitHub App's read-only
   installation token for that repository is used when the App is installed there. 30 GitHub imports / user / minute.
3. **Skill trust per project (owner decision 1).** Panel-signed skills are valid in every project by default. A project
   can be set to **"yalnız çevrimdışı imzalı"** (`project_skill_settings.trust = 'offline-only'`, admin + step-up,
   audited). The master then refuses to assign a skill without an offline-signed version to it (409
   `skill_trust_offline_only`), refuses to publish an import straight into it, never resolves a panel-signed version for
   its jobs (also for "all projects" assignments) and fails closed if a job pinned one before the switch. It also sends
   `ASSIGN_JOB.execution.skillTrust: "offline-only"` with the skills; workers with the new feature **`skill-trust-v1`**
   verify those bundles without their panel keys and decline the job if one is panel-signed (defence in depth against
   a master bug or a tampered outbox row; older workers ignore the field and still receive only offline-signed skills).
4. **MCP installs (owner decision 2):** admin + a fresh TOTP every time (always-fresh step-up), like machine tools.
5. **MCP tool policy after install (owner decision 3):** every tool starts as `ask`; the card suggests read-only tools
   to allow; tools not in the policy are denied.
6. **Skill limits (owner decision 4):** 64 files / 512 KiB per skill / 640 KiB per job, text only — delivered with the
   `skills-layout-v2` worker feature in P2 (not needed for P1: imports that fit today's layout of 32 files / 128 KiB
   need no worker release; larger ones are blocked with a "wider layout comes later" finding). Raising
   `MAX_JOB_SKILL_BYTES` past the 512 KiB ASSIGN_JOB frame needs an out-of-band delivery or a larger frame — designed in
   P2, not by flag alone.
7. **External MCP servers are for jobs only** (P3–P5, design §2): a signed spec per server version (own context
   `remana-mcp/v1`), project switch default off, vault-bound secrets, per-attempt egress, stdio packages pre-installed
   by canary-first fleet actions with lockfiles, metadata-only call audit. The assistant never gets external MCP.
   Migration 0102 creates the MCP catalog tables now; the CHECK widenings they need (chat draft kinds, fleet / remote-op
   kinds, approval action `tool.mcp`, notification `mcp.installed`) come with the phases that write them.

## Addendum — P2 (`p14-skill-catalogs`, 2026-10-20)

Implemented as designed in docs/design/p14-mcp-skills.md §12; three choices the design left open:

1. **Delivery past the frame: out of band, by digest — not a larger frame.** ASSIGN_JOB carries skills inline up to
   160 KiB of files; the rest travel as their signed manifests (`skills.deferred`) and the worker pulls each file with
   `SKILL_FILE_REQUEST` (manifest SHA-256 + path) over its authenticated session. The master serves only skills pinned
   to that job and only to the holder of its live lease; the worker trusts none of it — it verifies the signature at
   admission with its own keys and the size + SHA-256 of every file against the signed manifest before anything is
   materialised. The 512 KiB frame cap stays as it is for every message type.
2. **Layout is chosen per version, automatically.** A skill that fits today's layout is signed `schema: 1` and goes to
   every worker as before; only larger / wider ones are `schema: 2` and need the worker feature `skills-layout-v2`.
   Older workers are excluded by placement (`skill_layout_unsupported`), never sent a v2 or deferred skill.
3. **Catalogs are GitHub repositories only; skills.sh is left out.** Its documented API requires a Vercel OIDC token
   (only apps deployed on Vercel can obtain one) and its open search endpoint is undocumented (AGENTS.md rule 12).
   The built-in source is `github.com/anthropics/skills`; admins add others (≤ 10, step-up, audited). Listings are read
   through the fixed host api.github.com pinned to a commit and cached on the master for 6 h; imports from them use
   the P1 pipeline pinned to the listing's commit. Chat installs (`propose_skill_install`) are cards that need an admin
   and an always-fresh step-up like `POST /skills/imports/:id/publish`; researched text is fenced untrusted data.

Worker release: `skills-layout-v2` (and the new assistant tools, which the worker registers from its own build).
Migration 0105 (additive: wider CHECKs, `skill_catalog_sources`, chat draft kind `skill_import`).

## Addendum — P3 (`p14-mcp-core`, 2026-10-21)

Implemented as designed in docs/design/p14-mcp-skills.md §13 (remote servers only; stdio is in the spec format but
refused until P4). Choices the design left open:

1. **P3 publishes directly, no preview step.** An admin enters a remote spec (URL, header slots, hosts, runtimes) and
   publishes it with an always-fresh step-up (decision 2); the panel skills key signs it with the context
   `remana-mcp/v1`. Previews resolving registry / npm / PyPI references come with P4 / P5.
2. **Tool policy seeding (decision 3):** a new server has no rules, so every tool is denied until a worker-side probe
   lists the tools; the first successful probe then writes one `ask` rule per tool. Unlisted (later added) tools stay
   denied. Project rules replace the all-projects rules for that project.
3. **Enforcement is the adapter's, per call, on every runtime** — not only the runtime's own allow lists: Claude Code
   through a PreToolUse hook, Codex through `default_tools_approval_mode="prompt"` (each MCP call becomes an approval
   request the adapter answers), OpenCode through an `ask` permission for `x-<id>_*`, Pi through the gate
   extension. A call that ran without the adapter's decision fails the job. `ask` becomes a normal approval request
   with the new action `tool.mcp` (admin, risk high, floor = default).
4. **Secrets only in env and in the attempt-private 0600 Claude config file**, never on argv; Pi is supported only
   with API-key accounts (with the machine's own login it would read the user's `~/.pi/agent/mcp.json`).
5. **The probe runs in the worker process** (worker network, https only, no redirects, private addresses refused),
   not in a sandboxed attempt; acceptable for remote servers, and P4's stdio probe must run sandboxed.

Worker release: `mcp-v1`. Migration 0107 (additive). Per-runtime behaviours that need a real run are listed in
§13.4 (UNVERIFIED until P6).

## Alternatives considered
- **Offline-only for uploads, a one-command signer** — strongest, but it is exactly the step the owner rejected, needs
  the key on a laptop and does not work from a phone or the chat.
- **Panel import without a per-project tier** — simpler, but leaves owners who want the old guarantee for a sensitive
  project no way to keep it short of vetoing panel skills per machine.
- **Fetch any URL / raw.githubusercontent.com for imports** — more convenient and avoids the API rate limit, but turns
  the master into a fetcher of user-chosen hosts (SSRF) or adds a second host; the API by SHA keeps one fixed host and
  gives a hash per blob.

## Consequences
- For projects left at the default, skill integrity rests on the master plus an admin's fresh TOTP — the same anchor
  chat-written skills already had. A master-host compromise that also reads the panel key file can sign skills without
  a TOTP; mitigations: critical owner notification per publish, offline-only projects, `localCeiling.allowPanelSkills:
  false` per machine, revocation by unsetting `SKILLS_PANEL_KEY_FILE`.
- Unauthenticated GitHub API calls are limited to 60 / hour per IP; a skill of n files costs about n + 3 requests. Heavy
  importers should connect the GitHub App (its token is used for repositories it can see).
- Worker release needed only for the worker-side trust check (`skill-trust-v1`); master-side enforcement works with
  every worker.
- Rollback: code rollback leaves migration 0102 unused (additive); unsetting the panel key stops every panel-signed
  version from verifying (jobs referencing them become infeasible, visibly).

## Addendum — P5 (`p14-mcp-chat`, 2026-10-21)

- Chat research and install of MCP servers as designed in §4: `search_mcp_servers` reads the official MCP Registry
  (v0.1), npm and PyPI as data from compiled hosts; `propose_mcp_install` and Yetenekler → Keşfet share one preview
  pipeline (`mcp_previews`, migration 0114) whose facts the master resolves itself. Confirming needs admin + an
  always-fresh code (decision 2) and publishes, assigns, installs canary first and probes; tools start as `ask`
  (decision 3), the card only suggests read-only tools, and a write-named tool claiming `readOnlyHint` is never
  suggested. The project's MCP switch is turned on only when the person ticks it. Typosquat / new / low-download /
  deprecated warnings are the master's own. Details: design §15.

## Verification
- `apps/master/test/unit/skill-import.test.ts` (analysis, zip reader, GitHub source, ASSIGN_JOB field),
  `apps/master/test/integration/skill-import.test.ts` (preview → publish, always-fresh step-up, secret block,
  provenance, notification, audit, trust enforcement through a real worker daemon),
  `apps/worker/test/skills-verify.test.ts` (offline-only refusals), `apps/web/test/skill-import.test.tsx`; route
  coverage, RBAC matrix, step-up and rate-policy tests list the new routes.
- Live: an import from `github.com/anthropics/skills` on the production panel and a job on a real worker (P6,
  UNVERIFIED until run).
