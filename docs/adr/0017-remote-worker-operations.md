# ADR-0017: Remote worker operations from the panel

- **Status:** Accepted — owner requirement, 2026-10-14: the owner has no physical access to the machines
  and must install / upgrade / remove every agent runtime, log Claude Code (and Codex) into the owner's
  subscription, restart the worker service and read its logs and diagnostics from the panel. **Partially superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands was removed; the hash-pinned PyPI install of OpenHands no longer apply).
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-remote-ops`
- **Amends:** ADR-0014 §2 (who starts the subscription login: the worker, on request from the panel, instead of
  the owner at a terminal) and §3's "never offers a 'log in with Claude' flow in the console" (the console relays
  the runtime's *own* login; it never runs one of its own). ADR-0012 rule 5 and the runtime-setup runbook's "the
  platform never installs or upgrades a runtime" (the worker now can, from the pinned set only). ADR-0005, ADR-0006,
  ADR-0011, ADR-0015, ADR-0016 are unchanged and binding.
- **Related:** design note docs/design/p5-remote-ops.md, ops doc docs/ops/remote-ops.md, p7-supply-chain
  (runtime-checksums.json, runtime lockfiles), p5-worker-onboarding (worker-owned `<dataDir>/runtimes`).

## Context
ADR-0014 kept the platform entirely out of subscription logins: the owner logs in "interactively on that
machine". ADR-0012 / the runtime-setup runbook left installing runtimes to the owner, on each machine. With
seven machines and no physical (or routine shell) access this is not workable. The constraints that made
ADR-0014 necessary still hold: Anthropic's terms forbid a third party to collect, store or intermediate
Claude.ai credentials or session tokens, and AGENTS.md rule 4 forbids plaintext provider tokens in the
database or logs. A panel compromise must not become arbitrary code execution on every worker.

## Decision
1. **One signed control message per operation.** `OPS_COMMAND` (master → worker, additive in protocol 1.0, sent
   only to workers advertising `remote-ops-v1`) carries one operation, bound by an Ed25519 lease-key signature to
   the worker id, a command id and a ≤ 5-minute validity window. The worker verifies it (pinned
   `masterLeaseKeys`, else the session's keys), refuses expired and replayed commands (replay state persisted),
   and answers `OPS_UPDATE` (progress and result, ordered per command). Every request is admin + step-up +
   CSRF, audited (`worker.ops.<kind>`, result `worker.ops.result`) and rate-limited per worker and per user.
2. **Runtime installs come only from the pinned, checksummed set the worker bundles.** The panel names a
   runtime and a version — never a URL, package or command. The worker installs from its bundled install set
   (generated from the committed lockfiles and `runtime-checksums.json`): npm tarballs verified against their
   lockfile `sha512` before extraction by the worker's own extractor (no npm, no install scripts), OpenHands into
   a private venv with `pip --require-hashes --only-binary :all: --isolated --no-deps`, single-file binaries by
   `sha256`. Upgrades go only to versions in the set; the only allowed downgrade is to the previous pin
   (rollback). Installs live in the worker-owned `<dataDir>/runtimes/<runtime>/<version>/` with the bundled
   Node / a private venv — no system-wide change, no sudo. The entry executable's digest is recorded and
   re-checked; a modified install is not used.
3. **Subscription login is the runtime's own, run by the worker, relayed by the panel.** For Claude Code
   (`claude auth login --claudeai`) and Codex (`codex login --device-auth`) the worker starts the runtime's login
   command as its service user with its real HOME / config dir. It relays **only** an allow-listed https
   sign-in URL of the provider and a device code; the owner opens it on their own device. Where the flow shows a
   code to paste back (Claude Code), the panel relays it to the login process's stdin in memory only — never
   stored, logged or audited; it is useless without the PKCE verifier that never leaves the login process.
   **The resulting credential is never read, copied, stored or transmitted by the platform**; login state comes
   from the runtime's own status command (boolean / auth-method label). `CLAUDE_CODE_OAUTH_TOKEN` and
   `claude setup-token` remain forbidden. The worker passes no provider credential variable to the login process.
4. **Service operations.** Restart = optional drain (no new jobs, wait up to a deadline), clean stop, exit 75 for
   the service manager to restart (refused when the worker does not run under its service manager). Runtime
   restart = re-detect and rebuild the runtime's adapter. Logs = the worker's own log file (already redacted by the
   logger), re-redacted on the worker and again on the master, bounded and paged; kept in master memory only.
   Diagnostics = disk, Node, sandbox readiness, runtimes, service; redacted before they are stored.
5. **Local opt-out wins.** `remoteOps.disabled` in the root-owned local config turns operation groups off on a
   machine (`install`, `login`, `restart`, `logs`, `diagnostics`), like ADR-0015's local ceiling.

## Threat model impact
- **Panel / master compromise** (admin session + step-up, or the master itself) can now: install, upgrade or
  remove *pinned* runtime versions; restart workers; start a runtime login (the attacker would need the owner to
  complete it in their own browser — a phishing-shaped risk, mitigated by the always-fresh step-up, audit and the
  provider's own consent page); read redacted logs and diagnostics. It **cannot** run arbitrary code or fetch an
  arbitrary artifact (the worker installs only from its bundled, checksummed set; the message has no URL/command
  field), downgrade below the previous pin, read a subscription token, or bypass a local opt-out.
- **TLS-terminating proxy** cannot forge commands when `masterLeaseKeys` is pinned (as for ADR-0015/0016).
- **Supply chain:** a tampered registry/mirror is detected (integrity mismatch → nothing installed); a new pin
  needs a worker release (the install set is part of the signed worker bundle).

## Alternatives considered
- **`npm ci` on the worker** — rejected: npm reads user/global `.npmrc` (registry, scripts) from the service
  account's environment; the bundled Node may ship without npm; our own verified extractor is smaller to trust.
- **Distribute `CLAUDE_CODE_OAUTH_TOKEN` via the vault** — rejected (ADR-0014 §3, provider terms).
- **A pty-driven interactive login** — unnecessary: both pinned CLIs support a non-TTY flow (verified against
  Claude Code 2.1.296 and Codex 0.162.1 on 2026-10-14); a native pty dependency would be needed otherwise.
- **Free-form remote shell** — rejected: AGENTS.md rule 4 and ADR-0015's "the panel never chooses executables".

## Consequences
Migration 0032 (`worker_ops`, `workers.remote_ops`), actions `workers.ops.read/write`, three always-fresh
routes (login start, code paste-back, logout), Fleet → worker → Remote operations. The worker's adapter state
moves from `<dataDir>/runtimes/<rt>/reference` to `<dataDir>/runtime-state`; the macOS host sandbox opens
`<dataDir>/runtimes` read-only to jobs. Bumping a runtime pin now also regenerates the bundled install set
(`node scripts/security/runtime-install-manifest.mjs --write`, checked by `pnpm security:pins`).

## Verification
Protocol tests (signature binding, window, schema strips URLs/tokens), worker tests (fixture-registry installs,
tamper / wrong checksum / traversal / downgrade refused, real venv + pip `--require-hashes` against a local index,
login relay with fake CLIs asserting the token never leaves the worker and no credential file is opened, restart,
logs, diagnostics, Seatbelt carve-out live on macOS, daemon end-to-end), master integration (signed delivery,
step-up, RBAC, the pasted code absent from DB / audit / logs, redaction, rate limits), route coverage, web tests.
An opt-in online test installs the real pinned Codex from npmjs.org (`REMYRAL_ONLINE_TESTS=1`).

## Amendment 2026-10-27: removing a worker through its privileged helper (p17-worker-managed Part 3)

A new operation `worker.uninstall {purge}` (only to `worker-managed-v1` workers) and `helper.manage` (Part 4) are handed
by the worker, signature included, to the root/SYSTEM helper through the `sandbox.prepare` request file and trigger; the
helper verifies the master's signature, window and replay itself and runs fixed per-OS steps (the kit's uninstaller as
one script started detached, after reporting `accepted`). The route is admin + always-fresh step-up, audited; an offline
machine gets the command when it connects (cancellable until sent); the master revokes the worker only after the helper
accepted. `remoteOps.disabled: [restart]` refuses the removal locally, `[sandbox]` the helper management. Design:
docs/design/p17-worker-managed.md §3.
