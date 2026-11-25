# ADR-0052: Admin-defined ("custom") tool installs and fleet-wide tool actions

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (feedback 2026-10-20: "tüm makinelerdeki tool'lar kolayca güncellenebilmeli veya hepsine
  bir tool veya özel araç kurulabilmeli"); implemented by `p13-fleet-tools`
- **Amends:** ADR-0021 §2 ("the archive URL, SHA-256 and size come from the signed worker bundle — never from the
  panel"): for custom tools they may now come from an admin-defined recipe, under the rules below. ADR-0017 gains the
  operations `tool.install.custom` / `tool.remove.custom`.
- **Related:** docs/design/p13-fleet-tools.md, docs/design/p5-machine-admin.md, p3-runtime-policy.

## Context
Machines need tools the release has no recipe for, and the owner wants to update or install tools on all machines at
once. Until now only release recipes (pinned in the signed worker bundle) could be installed unprivileged; anything
else needed a free-form machine-admin job per machine.

## Decision
1. **Bulk actions are fan-outs, never a new path.** A fleet action creates one target per machine that is executed
   exactly like the single-machine change: a signed remote operation (release recipes, runtime pinned set) or a
   machine-admin job (distribution packages, package-manager custom tools). Authorisation is that of the strongest
   target kind: admin + step-up for remote operations, admin + always-fresh step-up for machine administration.
   Offline machines get queued targets until the action expires (≤ 7 days, ≤ 24 h for machine administration);
   the creator must still be an enabled owner/admin when a target is dispatched.
2. **Custom recipes** are configuration written by admins with always-fresh step-up and audited (host + SHA-256 per
   platform). A download step must use https on a fixed host allowlist (`CUSTOM_TOOL_HOSTS`, compiled into master
   and worker) and carry the SHA-256 and size; the entry is a relative path inside the install dir; names of tools the
   platform detects itself are reserved. A package step is one of winget / brew / apt / dnf / npm / pipx with a
   validated package id; its fixed command list runs only as a machine-admin job (each elevated command approved).
3. **Worker enforcement.** `tool.install.custom` is refused unless the owner enabled machine administration for the
   worker (signed managed config) and the local ceiling does not forbid machine administration or custom tools
   (`localCeiling.allowCustomTools: false`). The worker re-validates host and path, verifies SHA-256 and size before
   extracting, installs unprivileged into `<dataDir>/tools/custom/<name>/<version>/`, records the entry digest and
   appends the bin dir to the END of the runtimes' PATH (a custom tool never shadows a system or release tool).
4. **Versions from upstream are information only.** The master reads "latest" from allowlisted feeds (npm registry,
   GitHub releases API, NuGet, nodejs.org) without credentials; nothing is installed because a feed says so. Runtime
   versions still come only from the worker release's pinned set and the runtime policy (ADR-0012 rule 1 unchanged).

## Consequences
- A compromised admin account with a fresh step-up can place a binary of its choosing from an allowlisted host into
  the worker's tools dir of machines whose owner enabled machine administration — the same population that admin can
  already run elevated machine-admin jobs on (after per-command approval). The SHA-256 makes the download exact, not
  trustworthy: admins must take it from the publisher.
- Owners who do not want this keep machine administration off, or set `localCeiling.allowCustomTools: false`.
- Rollback: the routes can be removed; installed custom tools stay until removed (`tool.remove.custom`) or their
  directory is deleted; migration 0100 is additive.

## Alternatives
- Custom downloads as AI machine-admin jobs only: no deterministic checksum check, elevated where unprivileged is
  enough. Rejected for downloads; kept for package managers (which need root/Administrator anyway).
- Any https host: rejected (exfiltration / internal-network fetches from workers; makes the audit meaningless).
