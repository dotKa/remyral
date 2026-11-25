# ADR-0021: AI-driven machine administration (elevated commands, panel skills key)

- **Status:** Accepted. Owner decisions, 2026-10-14:
  - The AI may run with elevated rights on machines the owner chooses, as an opt-in per worker. Only the owner can
    switch it on. It needs an always-fresh step-up, is audited and sends a critical notification. A local veto
    exists.
  - Skills written in the chat are signed by a panel-held key. The offline key stays the primary/backup key, and
    workers trust both.
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-machine-admin`
- **Amends:**
  - The identity rule of ADR-0007/0019/0020: a job never *runs* as root/SYSTEM, and that still holds. A
    machine-admin job may now *send single commands* through the privileged helper.
  - ADR-0017: the helper gains a third verb, `admin-session`.
  - p6-skills: a second trusted signer, the panel key, and an "All projects" assignment scope.
  - ADR-0011: additive, feature-gated (`machine-admin-v1`, `tools-v1`, `panel-skills-v1`).
- **Related:** docs/design/p5-machine-admin.md, docs/ops/machine-admin.md, migration 0038.

## Context
The owner wants the assistant to set up and maintain his own machines, for example installing a browser, Python or
Git, adding a service or reading what is installed. Until now every job ran as the worker's unprivileged service
account (`NT SERVICE\RemyralWorker`, `_remyralworker`, `remyral-worker`), and nothing on the platform could act
elevated except the update helper (ADR-0017), which only swaps verified worker releases. Skills could only be
published with the offline key, so the assistant could not write a reusable skill from the chat.

## Decision
1. **Machine admin mode.** It is a per-worker panel setting: operational `machineAdmin: {enabled, autoApprove}`.
   - `PUT /workers/:id/machine-admin` sets it. The caller must be the owner and pass an always-fresh step-up. The
     change is audited (`worker.machine_admin`, with before/after). Turning it on sends a critical
     notification to owners.
   - Turning it on adds the built-in **Machines** project (`machines`, a workspace project) to the worker's
     projects.
   - The machine can forbid it locally with `localCeiling.allowMachineAdmin: false`. That veto beats the panel, and
     the worker reports it.
2. **Job kind `machine-admin`.**
   - `JobSpec.kind: "machine-admin"` with `machineAdmin.workerId`. The job is always pinned to that worker, always
     in the Machines project, and runs on the Claude Code runtime.
   - Placement requires `machine-admin-v1` and the setting to be on (`machine_admin_unsupported` /
     `machine_admin_not_enabled`). Under `allow-all` it also requires the worker's `autoApprove`
     (`auto_approve_not_allowed`).
   - The default policy is `ask-all`. `allow-all` needs the Machines project's auto-approve (ADR-0020) **and** the
     worker's `autoApprove`.
3. **Authentication approach: the runtime stays unprivileged, single commands are brokered.**
   - The AI runtime keeps running as the service account, with that account's subscription login. It does not
     run as SYSTEM/root, because that would expose a SYSTEM token to the runtime, its MCP servers and its child
     processes.
   - Instead the runtime gets four in-process MCP tools (server `remyral-admin`): `admin_exec`, `admin_write_file`,
     `admin_read_file` and `machine_note`.
   - Each elevated command goes through these steps:
     1. The worker sends `MACHINE_ADMIN_REQUEST` with the op and its SHA-256 digest.
     2. The master decides. It grants, asks the owner through the approval `machine.admin` (admin, always-fresh
        step-up, critical, platform floor `require_approval`), or denies.
     3. If granted, the master signs a **command grant** with the lease key over worker, job, attempt, epoch,
        requestId, op digest and a window of at most 5 minutes.
     4. The worker writes the request and grant into its data directory.
     5. The **elevated broker** executes the command and writes the result into a directory only it can write.
   - The broker is started by the root/SYSTEM helper (`remyral-worker-updater.mjs admin-session`). On Windows the
     trigger is scheduled task `RemyralWorkerAdmin` (SYSTEM). On Linux it is `remyral-worker-admin.path`/`.service`.
     On macOS it is `com.remyral.worker.admin` (WatchPaths).
   - The broker starts only for a master-signed **session grant**. That grant is bound to worker, job, attempt,
     epoch and sessionId, and lasts at most 12 h.
   - At session start the broker reads the local veto from the root-owned config, and refuses the session if it is
     set. It verifies every grant against the pinned master lease keys (or the keys from `/v1/worker/lease-keys`),
     keeps a replay set, and stops on its end marker, on expiry, or when the worker's heartbeat goes stale
     (15 s × 3).
   - Every request, decision and result is stored in `machine_admin_commands`, shown in job events and audited.
4. **Tool inventory and recipes.**
   - The worker detects tools and reports `CAPABILITIES.toolInventory` (`tools-v1`). Placement uses it for the
     job's `tools` constraint, with aliases (`browser`, `container`).
   - Unprivileged recipes are pinned, checksummed downloads extracted by our own ZIP reader into
     `<dataDir>/tools/<tool>/<version>`, run through remote ops (`tool.install`/`tool.remove`/`tools.detect`/
     `machine.inspect`). They cover the Playwright Chromium build on 5 platforms, plus MinGit and the NuGet Python
     on Windows.
   - Anything that needs a package manager becomes a machine-admin job with a fixed prompt
     (`409 machine_admin_required` on the direct route).
5. **Per-machine memory.**
   - Each machine has a memory context document in namespace `machine:<workerId>` (admin/admin). It is written only
     by the service, from the agent's `machine_note` calls and the job-end summary. Owners and admins can edit it
     in Fleet.
   - The memory is injected (redacted, fenced as untrusted data) into later machine-admin jobs on that machine. It
     never appears in project search or other jobs' bundles.
6. **Chat.**
   - New tools: `machine_inspect` (read, admin), `draft_machine_task` (draft, admin; refused while machine admin is
     off), `draft_tool_install` and `draft_skill`.
   - Drafts never act: confirming is a human click, with always-fresh step-up for machine tasks and elevated
     installs.
7. **Panel skills key.**
   - `SKILLS_PANEL_KEY_FILE` holds an Ed25519 PEM, generated on the host and mode 0600.
   - It signs a skill bundle only after an administrator confirms a `draft_skill` card that shows the diff
     (step-up).
   - Workers learn the public key only through the **signed** managed configuration (`panelSkillKeys`,
     `panel-skills-v1`). An unsigned document that carries the key is rejected. The local veto is
     `localCeiling.allowPanelSkills: false`.
   - The offline key stays trusted as well. `skill_versions.signer` (`offline` | `panel`) is shown on the Skills
     page.
   - Assignments can target **All projects** (`project = '*'`). A project-specific assignment wins over it.

## Threat model
- **Assets:** the whole machine (SYSTEM/root), every account and secret on it, the networks it reaches; the
  integrity of skills on every worker.
- **New attack paths, and what stops them:**
  - *Prompt injection in a machine-admin job* (from an inspected file, a web page or a tool output).
    - Default `ask-all`: every elevated command waits for the owner, with the exact command shown.
    - `allow-all` needs two separate always-fresh opt-ins.
    - Inspect output and memory are fenced as untrusted data.
    - Runs are limited by the job timeout, cancel, and the session end on expiry or a stale heartbeat.
  - *Compromised worker service account* (local code running as the worker).
    - It can write requests, but the broker executes only commands with a valid master grant bound to that op
      digest, job, attempt and epoch, within 5 minutes and never replayed. It cannot forge one without the master
      lease key.
    - Results are written where only SYSTEM/root can write, so it cannot spoof results to the master either.
  - *Compromised panel or master* (the lease key or an owner session is stolen).
    - This is the largest new risk: such an attacker could grant elevated commands on every machine with machine
      admin on.
    - Limits:
      - Only machines where the owner switched machine admin on are affected.
      - The local veto is outside the panel's reach.
      - Every change is audited and the enable notification is critical.
      - Machines without the admin task (not re-installed) cannot elevate.
    - This is why the setting is per worker and off by default. The ops doc tells the owner to keep it on only
      while needed.
  - *Malicious skill pushed via the panel key.*
    - Only an administrator's confirmed draft is signed. The diff is shown before signing.
    - Workers can refuse panel skills locally.
    - Skills stay instructions for the runtime, not code that runs on its own, and they are subject to the job's
      sandbox and approvals.
    - Removing `SKILLS_PANEL_KEY_FILE` withdraws the key from every worker on its next configuration sync.
  - *Supply chain of tool recipes.*
    - Pinned URLs with SHA-256, checked before extraction and again for the entry binary.
    - The ZIP reader refuses traversal, absolute paths, escaping symlinks and CRC errors.
    - Downloads use the same egress as the worker; no elevation is involved.
- **Unchanged:**
  - Jobs never run as root/SYSTEM.
  - Untrusted sources are never auto-approved.
  - The platform gates (merge, force push, deploy, vault) still apply.
  - The update helper still installs only signed releases.

## Alternatives considered
- **Run the runtime as SYSTEM/root.** Rejected:
  - It would put the whole agent, its MCP servers and every subprocess at the highest privilege.
  - No per-command approval would be possible.
  - The subscription login would have to live in the SYSTEM profile.
- **A long-running privileged daemon with a local socket.** Rejected:
  - It is a new always-on privileged attack surface.
  - The existing helper plus an on-demand trigger is smaller and already audited.
- **Signing chat skills with the offline key.** Rejected: it would mean an online copy of the offline key.
  Separate keys keep a stolen panel key revocable on its own.
- **UAC / sudo prompts on the machine.** Rejected: the owner is usually not at the machine. The approval moves to
  the panel.

## Consequences
- Machines installed before this release need the installer kit re-run once, so the admin trigger and new helper
  are installed. The helper is never auto-updated, by design (ADR-0017).
- Migration 0038 adds:
  - the Machines project;
  - `machine_admin_commands`;
  - worker columns `tool_inventory` / `machine_admin`;
  - `skill_versions.signer`;
  - the `'*'` assignments;
  - widened CHECKs.
- Elevated commands are slower than local ones: the scheduler trigger adds up to one minute at session start, then
  each command round-trips through the master.

## Rollback
- **Per machine:**
  - Fleet → worker → Machine admin → Turn off. Placement then refuses new jobs, and the master denies every further
    command of a running job ("switched off").
  - Or set `localCeiling.allowMachineAdmin: false` in the machine's config and restart the worker. The worker
    refuses machine-admin leases, and the helper refuses every new session.
- **Remove the capability:** re-run the uninstaller, or delete the task/unit/plist by hand:
  - Windows: `schtasks /Delete /TN RemyralWorkerAdmin /F`.
  - Linux: `systemctl disable --now remyral-worker-admin.path`.
  - macOS: `launchctl bootout system/com.remyral.worker.admin`.
- **Panel skills:** unset `SKILLS_PANEL_KEY_FILE` and restart the master. Workers drop the key on their next
  configuration sync, and panel-signed versions stop verifying. Rotating the key is the same plus a new file.
- **Database:** migration 0038 is additive. Older masters ignore the new columns and table, so rolling the master
  image back is safe. Machine-admin jobs that were in flight are failed by the lease timeout.

## Verification
- Protocol tests: grant signing and verification, digest binding, schemas.
- Worker tests:
  - ZIP extractor, recipes, inventory and inspect;
  - the broker: refuses unsigned, expired, replayed and vetoed grants, the result ACL, and the heartbeat end;
  - the managed config refuses unsigned panel keys and applies the vetoes.
- Integration test (`machine-admin.test.ts`) with a real worker daemon and the broker:
  - opt-in gating;
  - approval and auto-approve paths;
  - memory;
  - tools routes;
  - panel skill signing and verification.
- Other tests:
  - chat tools RBAC (`chat.test.ts`);
  - placement reasons (`placement.test.ts`);
  - rbac-matrix and route coverage;
  - web tests.
- Real Windows target: see docs/design/p5-machine-admin.md §Verification.

## Amendment 2026-10-27: the panel skills key generated and rotated in the master (p17-panel-settings Part 5)

The panel-held skills key may now be **generated by the master** (Ayarlar → Sunucu ayarları → Anahtarlar), sealed in the
panel settings (AES-256-GCM, HKDF sub-key `panel-settings`); it takes precedence over `SKILLS_PANEL_KEY_FILE`, which
stays the default. A rotation generates a new key and keeps the previous **public** key trusted as "retired" (at most
four), so skills and MCP specs signed with it keep verifying; machines receive the trusted set through their signed
managed configuration (`panelSkillKeys`, a new generation `skills_key`), and `localCeiling.allowPanelSkills: false`
still refuses all of them. "Retire" removes the old public keys (dry run: how many panel-signed versions exist and how
many machines get a new configuration). Skills signed with a retired key stay classified as panel-signed (an
offline-only project keeps refusing them). Always-fresh step-up (`settings.panel` event), audited
`keys.skills-panel.rotate|retire` with the public key only. Design: docs/design/p17-panel-settings.md §7.

## Amendment 2026-10-27: runtime paths, the helper's trigger and rootless Docker from the panel (p17-worker-managed)

- **Runtime paths** (which binary a runtime executes, Pi extension files) may be set from the panel — the "a panel must
  never choose what binary a worker executes" rule of ADR-0015 is relaxed only under this ADR's approval: the owner,
  always-fresh step-up, machine administration enabled for the machine (and not vetoed locally), audited
  `worker.runtime_paths`; the worker accepts only an absolute path outside the workspace root naming the runtime's own
  executable, an existing regular file not writable by group / others. Switching machine administration off drops them.
- **The elevated broker's trigger** can be installed or removed from the panel (owner, always-fresh step-up) through the
  privileged prepare helper with the kit's own units; `localCeiling.allowMachineAdmin: false` refuses an install.
- **Rootless Docker** is a fixed machine-admin task of the release (`setup: rootless-docker`, Linux): its elevated
  commands go through the normal per-command approval.

Design: docs/design/p17-worker-managed.md §2, §4.
