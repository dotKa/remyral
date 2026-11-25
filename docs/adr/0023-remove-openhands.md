# ADR-0023: Remove OpenHands from the platform

- **Status:** Accepted — owner decision, 2026-10-15, in chat: remove OpenHands completely — the interactive
  Canvas screen **and** the OpenHands runtime, adapter and installer.
- **Date:** 2026-10-15
- **Deciders:** owner; implemented by `p6-remove-openhands`
- **Supersedes:** [ADR-0013](0013-interactive-openhands-canvas.md) entirely; the OpenHands parts of
  [ADR-0012](0012-runtime-integration-surfaces.md) (OpenHands integration surface and pin `==1.54.0`, Python 3.12
  requirement, OpenHands hands-on rules), [ADR-0015](0015-panel-managed-workers.md) (`runtimes.openhands` settings),
  [ADR-0016](0016-credential-vault-sealed-to-workers.md) (OpenHands settings in the panel, model-profile base URL and
  request headers of p5-openhands-model-headers), [ADR-0017](0017-remote-worker-operations.md) (hash-pinned PyPI
  install of OpenHands), [ADR-0018](0018-ops-chat-assistant-on-worker.md) (interactive OpenHands sessions steered
  in Canvas) and [ADR-0020](0020-owner-controlled-full-permission.md) (OpenHands `NeverConfirm` mapping).
- **Related:** AGENTS.md rules 8–9, ACCEPTANCE.md, p6-remove-openhands, p5-canvas-links, p6-canvas-routes,
  p5-openhands-model-headers

## Context
- AGENTS.md rule 8 required five mandatory runtimes, OpenHands among them; ADR-0013 added an interactive OpenHands
  screen (Canvas, served by the master, `/oh/<jobId>/…` proxy tunnelled over a STREAM_* plane to a loopback Agent
  Server on the worker).
- ADR-0013 deliberately does **not** run OpenHands Automations (a separate scheduler next to ours). Without it the
  OpenHands screen is only a chat UI over one conversation — the platform's own job view, follow-up messages
  (`jobs.message`) and ops chat already cover that.
- What the OpenHands runtime adds (an agent loop with tools, confirmation, model choice through LiteLLM) is
  already provided by the remaining runtimes plus Remyral's own orchestration; Remyral's own automation system
  (schedules → automations) replaces OpenHands Automations.
- The integration had a high carrying cost: a Python 3.12 toolchain and hash-pinned PyPI wheel set on every
  worker, a separate install path, a route allowlist kept in step with Agent Server releases, a byte-stream tunnel,
  OpenHands-only model settings (LiteLLM base URL, extra request headers) and a runtime that needs a model profile
  (`model_required`).

## Decision
1. **Four runtimes remain:** Claude Code, Codex, Pi, OpenCode. `RuntimeKind` lists exactly these. AGENTS.md rule 8
   and ACCEPTANCE.md now require four runtimes; rule 9 (Canvas) is retired.
2. **Removed:** the Canvas screen and its build (`scripts/canvas/*`, `CANVAS_DIR`, Traefik `/canvas` and `/oh`
   routes), the master's interactive-session API, proxy, tunnel and Canvas housekeeping, the web Interactive page and
   "OpenHands session" links, the worker's interactive gateway/manager, the `interactive-openhands` job kind, the
   `openhands-session` route allowlist and the whole STREAM_* plane (its only target was `openhands-session`), the
   OpenHands adapter (client, schema, events, policy, workspace guard, capabilities, fixtures, tests), its runtime
   pin, install manifest entries, runtime checksums and `infra/worker/runtimes/openhands`, the `pypi` install method,
   OpenHands installer recipes and runtime checks, the LLM extra headers, the model catalog `baseUrl` / `headers`
   and the job model profile's `baseUrl` / `headers`, `model_required` (no remaining runtime lacks a model of its
   own) and the OpenHands-only model egress hosts. Generic model profiles, the catalog and defaults stay.
3. **Compatibility (protocol stays 1.0):** everything removed from the wire was feature-gated or additive.
   `RETIRED_RUNTIMES = ['openhands']` and `HistoricalRuntimeKind` exist for history only. Stored configuration and
   reports of older workers drop OpenHands when parsed (runtime lists, runtime-keyed records, CAPABILITIES runtime
   entries, remote-ops reports); the retired features `streams-v1` and `interactive-openhands` are dropped from
   CAPABILITIES. Any other unknown runtime or feature still fails validation.
4. **New use is refused** with the readable reason `runtime_removed`: jobs, workflows, schedules, drafts, catalog
   entries, defaults and worker configurations naming OpenHands, and interactive sessions.
5. **Master startup retirement routine** (idempotent): cancels non-terminal OpenHands jobs (reason
   `runtime_removed`), writes a new worker-configuration generation without OpenHands (cause `runtime_removed`) for
   every worker whose current generation names it, and a new active runtime-policy version without OpenHands for
   every policy whose active version names it (a canary version naming it is withdrawn, not rewritten) — so documents
   and hashes delivered to workers never carry it. Job cancellations are recorded as job transitions by the system
   actor `runtime-retirement`; the policy change is audited as `runtime_policy.retire_runtime`. The old interactive
   session endpoints answer `410 runtime_removed`; `/oh/*` and `/canvas/` no longer exist.
6. **Migration `0042`** (configuration only, never history): deletes OpenHands model defaults, archives
   OpenHands-only catalog profiles into `retired_model_profiles` and removes them from the catalog, strips
   OpenHands, `baseUrl` and `headers` from the remaining profiles, marks `worker_runtimes` OpenHands rows not
   present, allows worker-config cause `runtime_removed`, drops `jobs_interactive_idx`.
7. `docs/compat/openhands.md` moves to `docs/compat/archive/openhands.md` (historical evidence); the Canvas note
   the internal note `openhands-ekrani` (not published) says the screen was removed.

## Migration
- Existing OpenHands jobs, interactive sessions, attempts, events, usage records, context deliveries and audit
  entries stay in the database and remain readable: job lists and details render them as read-only history (filter
  by runtime still accepts `openhands`).
- Non-terminal OpenHands jobs are cancelled once at startup; nothing re-queues them.
- Operators uninstall OpenHands from workers (panel → Fleet → worker → Runtimes) **before** upgrading the workers
  (an upgraded worker no longer knows the OpenHands install), remove the Canvas directory from the control-plane
  host and check the archived profiles in `retired_model_profiles`.

## Alternatives considered
- **Keep the runtime, drop only the Canvas screen** — rejected by the owner: the runtime duplicates what Remyral and
  the four other runtimes already do, at the highest maintenance cost of all integrations.
- **Keep the STREAM_* plane as generic infrastructure** — rejected: no other feature uses it; dead transport code
  is attack surface. A future feature that needs streams brings them back with its own ADR.
- **Delete OpenHands history rows** — rejected: history is part of the audit trail (AGENTS.md rule 7).

## Consequences
- Positive: no Python toolchain or PyPI wheel set on workers; smaller protocol, transport, master and web surface;
  no Canvas build to verify; no OpenHands-only model settings.
- Negative: no interactive "native" agent screen; prompts that relied on OpenHands must use another runtime.
- Must now be true: tests prove new OpenHands jobs/configs/sessions are refused with a readable reason and historical
  OpenHands jobs still list and render; acceptance and backlog name four runtimes.

## Rollback
`git revert` of the p6-remove-openhands change set. Migration 0042 is configuration-only: archived profiles can be
restored from `retired_model_profiles`, defaults re-created in the panel; a reverted master also needs OpenHands
re-installed on the workers and the Canvas build re-fetched.

## Verification
`pnpm verify`; protocol tests for retired-runtime parsing; master tests for refusal (`runtime_removed`), the startup
retirement routine and history rendering; web tests for read-only history; `node scripts/backlog.mjs --check`.
