# Threat Model — Remyral

- **Status:** Living document. It is kept current with the code: a change that adds or moves a trust boundary updates
  it in the same pull request. There is no separate sign-off.
- **First written:** 2026-10-12
- **Method:** asset/trust-boundary enumeration + STRIDE per boundary + agent-specific threats. Each threat lists mitigations and the backlog task that implements or tests them.
- **Review cadence:** at every phase gate and whenever a new runtime, transport, or data store is added.

## 1. System summary

A control plane (dashboard, master API, Postgres, Redis; self-hosted on one Linux host, for example an AWS EC2 instance with Docker Compose or Coolify) dispatches coding jobs to worker daemons on machines the owner controls — any mix of macOS, Windows, Linux and Raspberry Pi, personal computers as well as servers. Workers connect outbound over WSS, check out repositories into scoped workspaces, and run one of four coding-agent runtimes (Claude Code, Codex, Pi, OpenCode; OpenHands was removed, ADR-0023), which call LLM providers and execute code.

## 2. Assets

| ID | Asset | Why it matters |
|---|---|---|
| AS-1 | LLM provider credentials / subscription logins | Direct financial loss, account takeover |
| AS-2 | Git credentials (App key, installation tokens) | Code tampering, supply-chain compromise of downstream users |
| AS-3 | Source code of private repositories | Confidentiality, IP |
| AS-4 | Worker host machines (often personal computers) | Full compromise of the owner's personal data, lateral movement in home networks |
| AS-5 | Master control plane (API, DB, Redis) | Command of the entire fleet |
| AS-6 | Worker device keys | Impersonation of a worker, receipt of jobs and secrets |
| AS-7 | Audit log and job history | Accountability, forensics |
| AS-8 | Context/memory store | May contain sensitive project knowledge |
| AS-9 | Backups | Contain everything above |
| AS-10 | Budget (provider spend) | Runaway agents, abuse |

## 3. Actors

| Actor | Trust |
|---|---|
| Owner/admin (authenticated, MFA) | Trusted, but can make mistakes; privileged actions need step-up |
| Operator/viewer | Partially trusted, role-limited |
| Coding agent (LLM) | **Untrusted output**: follows whatever instructions it reads |
| Repository content, issues, PRs, dependencies | **Untrusted input** |
| External contributor / fork PR author | Hostile by assumption |
| Internet attacker | Hostile |
| Compromised/rogue worker | Hostile after compromise |
| LLM provider / upstream runtime project | Third party; supply-chain risk |
| Local user of a worker machine (family member, malware) | Untrusted relative to other workers' data |

## 4. Trust boundaries

```
 [Browser/Mobile] --TB1 (internet, TLS, OIDC+MFA)--> [Ingress/Coolify] --TB2--> [Master API]
 [Master API] --TB3--> [Postgres] / [Redis]          (container network)
 [Worker daemon] --TB4 (internet, outbound WSS, device signature)--> [Master API]
 [Worker daemon] --TB5 (process/OS boundary, sandbox)--> [Runtime process + agent tools]
 [Runtime] --TB6 (internet)--> [LLM provider] ; [Workspace] --TB7--> [Git remote]
 [Repository content] --TB8 (data→instructions)--> [Agent context]
 [Admin] --TB9 (Tailscale + SSM)--> [EC2 host / Coolify admin]
```

TB8 is the distinctive boundary of this system: data crossing it becomes instructions to an actor with code execution.

## 5. Threats and mitigations

Severity: **C**ritical / **H**igh / **M**edium / **L**ow (impact × likelihood, pre-mitigation).

### T-INJ — Prompt injection and malicious repository instructions (TB8)

| ID | Threat | Sev | Mitigations | Tasks | Verified by |
|---|---|---|---|---|---|
| T-INJ-1 | Repo file (AGENTS.md, README, code comment, issue) instructs the agent to exfiltrate env vars/keys | C | Secrets not present in agent env beyond the model key (ADR-0006); egress allowlist; redaction of known secret values; canary secrets in tests | p3-secrets-worker, p3-sandbox, p7-secrets-scan | p7-secrets-scan 2026-10-13: an agent printing its credentials is redacted end to end (`secrets-canary-e2e.test.ts`) |
| T-INJ-2 | Injected instruction to push to protected branch / merge / deploy | C | Gated outside the model by policy engine; no git write credentials in untrusted jobs; merges only via integrator + human approval (ADR-0010) | p4-approvals, p4-git-flow |  |
| T-INJ-3 | Injection to modify CI config, add malicious dependency or backdoor in a PR | H | Human review of diffs before protected merge; CI-config and dependency-manifest changes flagged as high-risk in review UI; SBOM diff | p4-git-flow, p5-live, p7-supply-chain |  |
| T-INJ-4 | Injected text in logs/events crafted to manipulate the dashboard (XSS, terminal escape sequences) | H | Treat all agent output as untrusted: escape HTML, strip/neutralize ANSI control sequences except a safe subset, CSP without `unsafe-inline` | p5-live |  |
| T-INJ-5 | Instructions leak between projects through shared memory/context | H | Namespaced context with permission checks at retrieval; provenance recorded (ADR-0010 §4) | p6-context-model, p6-context-policy |  |
| T-INJ-6 | Repository-provided skills (`.claude/skills`, `.agents/skills`, `.codex/skills`, `.opencode/`, `.pi/skills`) loaded by a runtime as trusted capabilities | H | Runtimes load only the signed skills the worker materialised in a private state dir; project setting sources / discovery off; codex repo skills (loaded even for untrusted workspaces, VL 0.162.1) disabled by path | p6-skills | p6-skills 2026-10-14: real codex-cli 0.162.1 `skills/list` shows repo skills disabled (`packages/agent-adapters/test/skills.test.ts`) |
| T-INJ-7 | The worker user's own runtime configuration (Codex `CODEX_HOME/config.toml` MCP servers, hooks, `notify`, plugins / apps; OpenCode `~/.opencode` MCP servers and plugins) runs programs or adds tools inside a job | H | Codex: `-c features.{hooks,plugins,remote_plugin,apps,skill_mcp_dependency_install,computer_use,browser_use,browser_use_external,memories}=false`, `notify=[]`, every configured MCP server disabled per thread (`config/read`), an MCP server starting fails the job; OpenCode: `--pure`, foreign MCP entries disabled through `OPENCODE_CONFIG_CONTENT`, effective-config check; Claude Code: `settingSources: []`, `strictMcpConfig`, `plugins: []`; Pi: `--no-extensions --no-mcp --no-skills` | p14-codex-mcp-isolation | 2026-10-20: real codex-cli 0.162.1 and opencode 1.19.0 with hostile user configs, markers absent (`user-config-real.test.ts`, `opencode-real.test.ts`) |

### T-SBX — Sandbox escape and host compromise (TB5)

| ID | Threat | Sev | Mitigations | Tasks |
|---|---|---|---|---|
| T-SBX-1 | Agent shell reads/writes outside the workspace (`~/.ssh`, browser profiles, keychains) | C | Dedicated low-privilege OS user per worker; container profile on Linux; runtime sandbox where available; path checks; host-restricted profile requires opt-in (ADR-0007) | p3-sandbox, p7-sandbox-escape |
| T-SBX-2 | Agent opens a listening port / reverse shell | H | Egress allowlist via proxy; no inbound firewall rules; alarm on unexpected listeners | p3-sandbox, p6-alerts |
| T-SBX-3 | Container escape via Docker socket or privileged container | C | Rootless Docker/Podman; never mount the Docker socket into jobs or the API (ARCHITECTURE "Deployment") | p3-sandbox, p1-coolify |
| T-SBX-4 | Parallel jobs interfere through shared caches/worktrees | M | Per-job worktree; shared mirror objects read-only; package caches per project, written only by trusted host jobs through package managers that lock and verify their own stores (T-SBX-7); cleanup on completion. Host attempts without per-attempt confinement run one at a time; on Windows each concurrent attempt runs as its own `remyral-job-<n>` account with ACL'd dirs, enabled only after an on-machine cross-access self-test (ADR-0034). Residual: shared loopback ports / egress proxies, process list, default-DACL named pipes, world-writable machine dirs, shared local-login state; Linux/Pi host profiles stay serial (`p9-linux-host-isolation`) | p3-workspace, p6-warm-caches, p9-windows-host-isolation |
| T-SBX-6 | Runtime server credential readable from agent tools (OpenCode password via `ps`; OpenHands was removed, ADR-0023) lets an approved tool self-approve further actions | H | Detection + job failure, container profile, approval reported degraded (ADR-0012 implementation notes) | p3-adapter-opencode, p7-sandbox-escape |
| T-SBX-7 | Cache poisoning: a job writes a malicious artefact into a shared package cache that later jobs install and run, bypassing branch review | H | ADR-0029: caches per machine *and project*; only trusted sources on host profiles; untrusted and container jobs get none; Seatbelt opens exactly the project's cache dir; no package-manager config shared (per-attempt `CARGO_HOME`, `.npmrc`); project opt-out (step-up, audited) and machine hard switch; size limit + LRU. Residual: built pip/uv wheels and extracted Go modules are not re-verified on use | p6-warm-caches |
| T-SBX-5 | Agent consumes host resources (fork bomb, disk fill) on a personal machine | M | cgroups/Job Objects limits, disk quotas per workspace, runaway-agent stop | p3-sandbox, p4-quotas |

### T-WRK — Rogue or compromised worker (TB4)

| ID | Threat | Sev | Mitigations | Tasks | Verified by |
|---|---|---|---|---|---|
| T-WRK-1 | Stolen device key used to impersonate a worker and receive jobs/repo tokens | H | Key in OS keystore; challenge-response; fingerprint approval; anomaly detection (new IP + new facts) → quarantine; revocation enforced immediately (ADR-0005) | p2-pairing, p2-identity-rotation |  |
| T-WRK-2 | Compromised worker reports fake results / fake success | H | Verification step on a different worker or CI; results reference commits verifiable on the Git remote; truthful-capability contract | p4-dag, p4-git-flow |  |
| T-WRK-3 | Compromised worker floods master (DoS) or sends oversized messages | M | Per-worker rate limits, message size limits, bounded buffers, backpressure | p2-transport, p7-rate-limit | p7-rate-limit 2026-10-13: per-worker session budget, per-IP/total socket caps, per-worker downloads — `abuse.test.ts`; frame/rate/backpressure limits — `worker-gateway.test.ts` |
| T-WRK-4 | Worker abuses tokens beyond its job scope | H | Per-job, per-repo, short-lived Git tokens; project allowlist bound to worker role. Since ADR-0015 the allowlist comes from the panel (registered repositories only, signed per-worker generations, admin + step-up + audit + notification) intersected with an optional local ceiling that always wins; a panel compromise can widen a worker only to registered repositories | p3-secrets-worker, p4-scheduler, p5-managed-workers | p5-managed-workers 2026-10-14: `worker-config.test.ts`, `worker-config-e2e.test.ts`, worker `managed-config*.test.ts` |
| T-WRK-5 | Rogue enrollment (attacker pairs their own machine) | H | Pairing code single-use, 10-min expiry, rate-limited, requires admin approval with fingerprint match | p2-pairing |  |

### T-CP — Control plane (TB1, TB2, TB3, TB9)

| ID | Threat | Sev | Mitigations | Tasks | Verified by |
|---|---|---|---|---|---|
| T-CP-1 | Unauthenticated access to API/dashboard/Coolify admin | C | Forward-auth on all routes; password + mandatory TOTP (ADR-0009); Coolify admin only via Tailscale; public port scan in gates | p1-auth, p1-coolify, p1-gate | p5-coolify-sso 2026-10-14 (owner decision): Coolify admin at `coolify.<domain>` behind a Traefik forward-auth gate (owner/admin console session) + OIDC sign-in with step-up, instead of Tailscale-only; ports 8000/6001/6002 stay closed — docs/design/p5-coolify-sso.md §7, `apps/master/test/integration/coolify-sso*.test.ts` |
| T-CP-2 | Session hijack / CSRF | H | Server-side sessions, SameSite=Strict, CSRF tokens for state-changing requests, short sessions, step-up for privileged actions | p1-auth, p5-rbac-api | p7-rate-limit 2026-10-13: CSRF on every state-changing route (route registry), login JSON-only, session rotation on step-up and role elevation, absolute/idle timeouts — `apps/master/test/integration/abuse.test.ts`; p5-remember-device 2026-10-14: opt-in remembered sessions (7 d idle / 30 d) and trusted devices (hashed, rotated, reuse-detected, revoked on credential/authority change; step-up never skipped by the device cookie) — `trusted-devices.test.ts`, `remember-me.test.ts`; p5-stepup-window 2026-10-14 (owner decision): on a remember-me or trusted-device session one TOTP (login or step-up) satisfies step-up for the rest of that session (`AUTH_STEP_UP_TRUSTED`, default `session`). **Risk:** a stolen long-lived session cookie that has stepped up reaches privileged actions (approvals, merges, secrets, worker approval, Open Coolify) for the session's life. **Mitigations:** `__Host-` HttpOnly Secure SameSite=Strict cookie, id rotation on every step-up, device binding (revoking the device or any credential/authority change drops the session back to the 10-minute window), idle 7 d / absolute 30 d, audit of every privileged action and `auth.step_up` with its scope, notifications, the **always-fresh class** (password change, revoke all devices, user create/role/disable/enable; MFA reset and recovery-code regeneration CLI-only; future credential-vault reveal) needing a TOTP from the last 10 min on every session, and the kill switch "Log out everywhere" (ends every session and device trust, no step-up needed); `AUTH_STEP_UP_TRUSTED=off` restores the 10-minute rule with a configuration change (restart, no code change) — docs/design/p5-remember-device.md §8, `stepup-window.test.ts`, `coolify-sso.test.ts` |
| T-CP-3 | Broken authorization (IDOR across projects) | H | Central authz middleware + per-endpoint authz test matrix | p5-rbac-api |  |
| T-CP-4 | SQL/command injection in master | H | Parameterized queries only; Zod validation of every input; no shelling out from the API | p1-master-skeleton |  |
| T-CP-5 | EC2 compromise exposes DB, KMS-wrapped secrets | C | SSM instead of SSH; IMDSv2; least-privilege IAM; KMS decrypt scoped to master role; patching; no Docker socket in public containers | p1-aws-account, p1-iac |  |
| T-CP-6 | Redis exposed / unauthenticated | H | Redis only on the internal container network with AUTH; no published port | p1-data-services |  |

### T-SEC — Secret leakage (cross-cutting)

| ID | Threat | Sev | Mitigations | Tasks | Verified by |
|---|---|---|---|---|---|
| T-SEC-1 | Secrets in logs, events, transcripts, artifacts | C | Two-stage redaction (worker exact-value + master pattern); canary tests | p3-secrets-worker, p7-secrets-scan | p7-secrets-scan 2026-10-13: canary job secret / runtime credential / git credential leaked into every event kind, logs, memory, approval, summary, crash: absent from every table column and the master/worker logs (`secrets-canary-e2e.test.ts`) |
| T-SEC-2 | Secrets in dashboard JS / API responses | C | Write-only secret API; bundle scan in CI | p7-secrets-scan | p7-secrets-scan 2026-10-13: every GET route + SSE stream canary-free (`secrets-canary-e2e.test.ts`); CI web bundle scan with build-env canaries |
| T-SEC-3 | Secrets committed by agents into Git | H | Pre-push secret scan on worker; GitHub push protection | p4-git-flow, p7-secrets-scan | p7-secrets-scan 2026-10-13: CI `pnpm scan:secrets --history` for this repository (agent branches: p4-git-flow pre-push scan) |
| T-SEC-4 | Backups leak data | H | Encrypted backups in separate account/region, restricted IAM, retention | p1-backups, p7-dr-drill |  |
| T-SEC-5 | Job outputs / blobs exposed through object storage (public bucket, leaked keys, forwarded links, a worker writing elsewhere) | H | Private bucket, least-privilege key (objects under a prefix, no listing / ACL); keys sealed, owner-only with a fresh code, never sent to workers; one-key / one-size / one-hash upload grants fenced by the live lease, read-back verification; presigned GETs ≤ 1 h with a forced attachment; share links hashed, ≤ 30 days, revocable, audited; local blob mirror encrypted in the backup | p17-object-storage | `object-storage.test.ts`, `blobs-s3.test.ts` (signature-checking fake), `blobs-s3-interop.test.ts` (SeaweedFS); design §9 |

### T-SUP — Supply chain

| ID | Threat | Sev | Mitigations | Tasks |
|---|---|---|---|---|
| T-SUP-1 | Malicious update of a runtime (npm/pypi) installed on all workers | C | Version pinning per runtime with checksum; staged rollout (one worker first); upgrade/rollback policy; lockfile installs + recorded registry checksums (§9) | p3-runtime-policy, p7-supply-chain |
| T-SUP-2 | Malicious worker daemon update pushed through our updater | C | Signed releases verified by worker with pinned public key; separately authenticated update channel (ARCHITECTURE "Deployment") | p2-signed-updates |
| T-SUP-3 | Compromised dependency in our own code | H | Exact pins, lockfile, SBOM, vulnerability scanning, review of dependency updates | p7-supply-chain |
| T-SUP-4 | Malicious or tampered skill (instructions/scripts) distributed to every worker of a project, by a compromised master, DB row or outbox | H | Skills signed offline with a separate Ed25519 skills key; master verifies on upload and re-verifies before delivery; every worker verifies against the keys in its own root-owned config before materialising; per-job pinning by manifest hash; scripts never run outside the job sandbox | p6-skills |

### T-OPS — Availability, integrity and repudiation

| ID | Threat | Sev | Mitigations | Tasks |
|---|---|---|---|---|
| T-OPS-1 | Duplicate side effects after reconnect/crash (double commit, double PR) | H | Leases + fencing + idempotency (ADR-0004) | p4-leases, p4-chaos |
| T-OPS-2 | Runaway agent spends budget | H | Run budgets, provider quotas, kill switch, alarms | p4-quotas, p6-alerts |
| T-OPS-3 | Audit log tampering / repudiation of approvals | M | Append-only audit table, hash-chained entries, off-host export | p1-audit-schema |
| T-OPS-4 | Control-plane outage strands running jobs | M | Workers keep running within lease grace, buffer events, reconcile on reconnect | p2-replay, p4-recovery |
| T-OPS-5 | Data loss (DB) | H | Off-host backups, restore drills | p1-backups, p7-dr-drill |

## 6. Residual risks and trust assumptions

1. **Host-native execution on macOS/Windows/Pi is weaker than containers.** Accepted only with the `host-restricted` profile, a dedicated OS user and project opt-in; untrusted sources never run there.
2. **Redaction cannot catch unknown secrets.** Mitigated by not giving agents secrets and by retention limits.
3. **LLM providers see source code sent to them.** Inherent; project policy decides which providers a project may use.
4. **Upstream runtimes may change behaviour between versions.** Mitigated by pinning and contract tests per version.

5. **The master is trusted with the machines it administers.** Machine administration (ADR-0021,
   [docs/ops/machine-admin.md](../ops/machine-admin.md)) is off on every machine until an owner turns it on in the
   panel, but a machine's local ceiling (`localCeiling.allowMachineAdmin`) allows it unless the machine's owner forbids
   it at install time (`--no-machine-admin` / `-NoMachineAdmin`). A compromised master, or a stolen lease-signing key,
   can therefore turn the switch on, install the helper's trigger and sign sessions and commands: it is root / SYSTEM on
   every machine without the local veto. Step-up codes and approvals are controls *of the master* and do not bind a
   master that is no longer the owner's. Not affected: worker updates (signed with the offline release key) and
   machines with the local veto.
6. **The Serbest (permissive) security preset removes human checks.** It waives the authenticator code for everything
   outside the safe core and lets approvals pass by themselves (ADR-0056). It is meant for a single-person, closed
   installation and is chosen explicitly; a fresh installation starts on Dengeli, and an upgrade never changes the
   preset an installation already has.
7. **Host jobs can fall back to no filesystem confinement.** When `host-restricted` cannot confine an attempt (Linux
   without a usable bubblewrap view — Ubuntu 24.04's default —, Windows before the per-job accounts are provisioned),
   the worker runs host jobs one at a time as its own service account instead of refusing them
   ([docs/ops/worker-sandbox.md](../ops/worker-sandbox.md#host-jobs-without-filesystem-confinement-none)). Job code
   can then read the worker's device key, its local secret store and other jobs' workspaces, write the helper's request
   files, and connect out directly. The Sandbox card shows `host_unconfined_fallback`; machine administration is refused
   in this state unless the machine's owner opts in with `localCeiling.allowMachineAdmin: true`. The separate
   `unconfined` profile (ADR-0019) is never a fallback: it needs an admin switch per machine and a project opt-in.

## 7. Assumptions and decisions

- **Untrusted sources:** fork PRs and any content from outside the installation's organisation (external issues / PR
  comments, third-party dependencies, fetched web content) are untrusted by default. Repository content is treated as
  data, never authority (ADR-0010), also in private repositories: prompt injection can arrive through dependencies and
  fetched web content.
- **Worker machines are not shared with untrusted people.** A dedicated worker OS user (ADR-0007) stays mandatory
  because it protects the machine owner's own data from the agents; an installation whose machines are shared should
  treat other local users as untrusted actors (§3) and prefer the container profile.
- **Runaway-agent spend:** limits are configurable in the console per project / runtime / provider (tokens, turns,
  wall time, and dollars where known), with platform defaults (p4-quotas).
- **Subscriptions:** subscription logins of the runtimes are used through worker-local login (ADR-0014); they never
  leave the machine.

## 9. Supply-chain and external dependency scan review (p7-supply-chain, 2026-10-14) — A-SEC-4

Evidence: [docs/design/p7-supply-chain.md](../design/p7-supply-chain.md) §1–§4, policy
[dependency-policy.md](dependency-policy.md), CI workflow `.github/workflows/supply-chain.yml`.

| Threat | Mitigation now in place | Verified by |
|---|---|---|
| T-SUP-1 runtime update | exact pins in one source (`pins.ts`) checked against adapters, docs, ADR-0012, images and recorded registry checksums; runtime images install from committed lockfiles (`npm ci --ignore-scripts`, transitive integrity); staged rollout via runtime policy (p3) | `pnpm security:pins` (every `pnpm verify`), `pnpm security:runtime-checksums` (CI: npm integrity of every runtime lockfile package, PyPI sha256, ghcr digest); the four runtime images rebuilt from the lockfiles and report the pins |
| T-SUP-2 worker update | unchanged: Ed25519-signed releases (p2-signed-updates) | existing tests |
| T-SUP-3 our dependencies | exact pins, frozen lockfile with integrity, 24 h minimum release age, exotic sub-deps blocked, install scripts refused, Actions by SHA, images by digest; SBOMs; `pnpm audit --prod` + registry signatures + OSV scan with expiring allowlist, weekly | first scan 2026-10-14: workspace and runtime lockfiles **0 advisories**; image findings fixed (npm removed from master/egress-proxy) or allowlisted with expiry (21 npm-in-node-base advisories for runtime images until 2026-11-13; 2 Alpine advisories in upstream images until 2026-10-28) |
| T-INJ-3 malicious dependency in a PR | dependency/CI paths flagged in the git-flow review; policy §2 review checklist; SBOM diff available per CI run | p4-git-flow flags; policy |

**Residual (owner decision):** 152 Debian 12 advisories without a Debian 12 fix in the `node:24-bookworm-slim`
base (curl, glibc, util-linux, openssl, …) are informational; moving the bases to Debian 13 is a follow-up
(policy §7). OpenHands agent-server/agent-canvas and garage images were not inspected (not present locally).

**Review (A-SEC-4):** the scan runs in CI (`supply-chain` workflow, also weekly); its latest artifact, not the snapshot
above, is the current state.
