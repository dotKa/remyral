# ADR-0007: Execution sandbox per OS

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p3-sandbox, p7-sandbox-escape, AGENTS.md rule 5, threat model T-SBX

## Context
Agent code runs on personal machines. AGENTS.md: scoped workspace, isolated parallel worktrees, sandbox on supported systems, clearly restricted host-native execution.

## Decision
Execution profiles, chosen per job by policy and worker capability:

| Profile | Where | Isolation |
|---|---|---|
| `container` | Linux x64/arm64 with rootless Docker or Podman | Job container, workspace bind-mounted, non-root, read-only root fs, dropped caps, seccomp default, network policy (egress allowlist via proxy). Default for Linux. |
| `runtime-sandbox` | Any OS where the runtime ships its own sandbox (e.g. Codex Seatbelt/Landlock, Claude Code sandbox) | Runtime's native sandbox restricted to the workspace, plus our host-native restrictions. Exact availability from compat research. |
| `host-restricted` | macOS, Windows, Pi | Dedicated low-privilege OS user per worker, workspace under a worker-owned root, runtime permission mode set to ask/deny for shell & network beyond allowlist, no access to the interactive user's home/keychain. Requires explicit project policy opt-in. |

Compatibility research (docs/compat/README.md §4.6) showed runtime sandboxes are partial (Codex Seatbelt still allows reading `~/.ssh`; Claude Code sandboxes Bash only; Pi and OpenCode have none). Therefore the dedicated low-privilege OS user is **mandatory for every profile** on macOS, Windows and the Pi, not only for `host-restricted`.

The worker refuses a job whose policy requires a profile it cannot provide (truthful capability, ADR-0008). The workspace root is the only writable path we grant; cwd escapes are checked before spawn.

## Consequences
Windows/macOS jobs are weaker-isolated; policy must reflect that (e.g. no untrusted PRs on host-restricted workers).

## Verification
p7-sandbox-escape suite per profile: write outside workspace, read `~/.ssh`, reach metadata/private IPs, spawn listener — all denied or alarmed.

## Implementation notes (p3-sandbox, 2026-10-13)

Where reality differs from the decision text (details: docs/design/p3-sandbox.md):

1. **`runtime-sandbox` is not offered on macOS.** Seatbelt cannot nest (`sandbox_apply: Operation not permitted`, verified on macOS 26.6), so a runtime's own Seatbelt cannot run inside the host-restricted Seatbelt that confines the whole runtime tree. Running the runtime's sandbox *instead* would be weaker (Codex reads `~/.ssh`, Claude sandboxes Bash only). On macOS `host-restricted` is the strongest host profile; `runtime-sandbox` is offered for Codex on Linux/Windows hosts and Claude Code on Linux.
2. **Host-restricted without per-attempt confinement** (Linux/Pi host, Windows) runs one attempt at a time; parallel attempts on those hosts need `container`.
3. **Parallel attempts and git:** the agent gets a per-attempt git dir (alternates to the read-only mirror objects); the shared mirror and the worktree's `.git` are never writable by it, and the worker records the result with its own commit.
4. **Listening sockets on macOS:** Seatbelt cannot restrict a listener to loopback, so listening is denied unless a runtime that serves on loopback needs it (`allowListen`).
5. The container profile was verified on Docker Desktop (linux/arm64 VM); rootless Linux engines, the Pi and Windows remain UNVERIFIED (p7-sandbox-escape).

## Amendment (ADR-0019, 2026-10-14)

A fourth profile, `unconfined` (runtime as the worker's service account, no filesystem or egress confinement, limits
and identity rules kept), offered only when the worker's panel configuration allows it, the local ceiling does not
forbid it and the job's project opted in; never for untrusted sources, never as a fallback. The dedicated worker
user may be inferred when the worker runs as its installer's account. The Windows host runner is the
`remyral-jobrun.ps1` job runner (Job Object via PowerShell `Add-Type`), verified on real Windows 11. See
[ADR-0019](0019-sandbox-ops-and-unconfined-profile.md).
