# Design note: `p5-machine-admin`: AI-driven machine administration

- **Task:** `p5-machine-admin`. Owner decisions, 2026-10-14:
  - Elevated AI is an opt-in per worker, set by the owner only, with always-fresh step-up, audited, with a critical
    notification and a local veto.
  - Chat-authored skills are signed by a panel-held key, with the offline key kept.
- **Date:** 2026-10-14
- **Decision record:** ADR-0021 covers the threat model, mitigations and rollback.
- **Binding inputs:**
  - ADR-0007 / 0019 / 0020: profiles and full access; a job never runs as root.
  - ADR-0011: additive protocol.
  - ADR-0015: managed config.
  - ADR-0017: the privileged helper.
  - ADR-0018: chat drafts.
  - p6-skills, p6-context-model.
- **Ops:** docs/ops/machine-admin.md. **Owner note (TR):** docs/guide/tr/makine-yonetimi.md.

## Shape

```
packages/protocol      machine-admin.ts (AdminOp, digests, command + session grants, MACHINE_ADMIN_* payloads),
                       tools.ts (inventory, recipes, inspect, ELEVATED_RECIPES), worker-config machineAdmin +
                       panelSkillKeys, JobSpec.kind 'machine-admin', features machine-admin-v1 / tools-v1 /
                       panel-skills-v1, assistant tools machine_inspect / draft_machine_task / draft_tool_install /
                       draft_skill
packages/scheduler     PlacementJob.machineAdmin, PlacementWorker.machineAdmin, reasons machine_admin_unsupported /
                       machine_admin_not_enabled, tool_missing hints from the inventory
packages/agent-adapters admin-tools.ts (MCP server remyral-admin: admin_exec, admin_write_file, admin_read_file,
                       machine_note), Claude Code adapter registers it (auto-allowed; the master is the gate)
packages/memory        namespace machine:<workerId>
apps/worker            tools/ (zip, recipes, installer, detect, inventory, inspect), machine-admin/ (session, job,
                       report, shared paths), update/helper/admin.ts (the elevated broker), runner wiring,
                       managed-config vetoes allowMachineAdmin / allowPanelSkills
infra/worker           Windows task RemyralWorkerAdmin, Linux remyral-worker-admin.path/.service, macOS
                       com.remyral.worker.admin; uninstallers remove them
apps/master            migration 0038, machine-admin/ (service, routes), worker-config machineAdmin + panel keys,
                       remote-ops tools/inspect, approvals action machine.admin, skills panel key + diff + '*'
                       assignments, chat tools + drafts, memory store machine namespace, notifications
apps/web               Fleet → Tools panel, Fleet → Machine admin panel (switch, new task, command log, memory),
                       Skills signer + All projects, draft cards, Approvals label
```

## 1. Elevated execution (ADR-0021 §3)

```
runtime (service account) ──admin_exec──▶ worker MachineAdminSession ──MACHINE_ADMIN_REQUEST──▶ master
                                                     ▲                                          │ policy / approval
                                                     │ result file                              ▼
                                              broker (SYSTEM/root) ◀── request + signed grant ── MACHINE_ADMIN_DECISION
```

- **Purpose (p17-worker-1-1-1).** Each request may carry the agent's one-line `purpose` (feature
  `machine-admin-purpose-v1`), shown above the command as the agent's unverified explanation; it is never part of the
  operation digest or a signature. The helper's readiness (`machineAdmin.helper` + `helperReason`) is probed for real
  (trigger installed and enabled, answer dir traversable). See [p17-worker-1-1-1](p17-worker-1-1-1.md).

- **Session start.**
  1. When a machine-admin lease arrives, the worker asks the master for a session grant.
     `ASSIGN_JOB.machineAdmin.session` is signed by the lease key and bound to worker, job, attempt, epoch and
     sessionId, for at most 12 h.
  2. The worker writes `<dataDir>/machine-admin/session-request.json` and starts heartbeats
     (`sessions/<id>/alive`, every 15 s).
  3. The OS trigger starts `remyral-worker-updater.mjs admin-session`.
  4. The broker verifies the grant, writes `status.json` (`ready`) into
     `<install>/state/machine-admin/<sessionId>/`, and polls `sessions/<id>/requests/`.
- **Per command.** `admin_exec`, `admin_write_file` and `admin_read_file` become an `AdminOp`.
  1. The worker sends `MACHINE_ADMIN_REQUEST` with the SHA-256 digest of the canonical op.
  2. The master stores it in `machine_admin_commands`.
  3. The master decides:
     - Granted: only when the job is `allow-all`, the worker's `machineAdmin.autoApprove` is on, and the Machines
       project has `auto_approve_execution`.
     - Otherwise pending: an approval `machine.admin` is created (admin, always-fresh step-up, critical). Its
       decision reaches the worker as `APPROVAL_DECISION`, and the session then re-requests.
     - Denied: for example, when the setting was switched off.
  4. On a grant, the master signs over worker, job, attempt, epoch, requestId, a window of at most 5 minutes and
     the op digest.
  5. The worker writes the request file, the broker verifies and runs it, and the worker reads `results/<id>.json`
     and reports `MACHINE_ADMIN_RESULT`.
  6. The AI sees stdout/stderr (redacted, at most 64 KiB tail) as untrusted tool output.
- **Ops on Windows.**
  - `powershell` runs a temporary `.ps1` written with a UTF-8 BOM, via `-NoProfile -NonInteractive
    -ExecutionPolicy Bypass -File`. That keeps non-ASCII text and exit codes intact.
  - `cmd` runs `cmd.exe /d /s /c "<command>"` with verbatim arguments.
  - `write_file` uses modes create, overwrite or append. It reports the sha256 before and after.
  - `read_file` returns at most 256 KiB, base64.
- **Session end.**
  - The session ends on the worker's end marker (written when the job finishes), on expiry, or when the heartbeat
    is older than 45 s.
  - Results are deleted at the end; only `status.json` stays.
  - Session ids are remembered for 24 h, so a session request is never run twice.
- **Why not elevate the runtime:** see ADR-0021 "Alternatives". The subscription login, MCP servers and
  subprocesses all stay unprivileged.

## 2. Tool inventory and recipes

- Detection is a single pass:
  - `probeTools` finds git, docker, podman, python, node, uv and wsl.
  - Browsers come from their install layout (version folders on Windows, Info.plist on macOS) and are never
    started.
  - ffmpeg is checked with `-version`.
  - Managed installs come from `<dataDir>/tools/state.json`, with the entry sha256 re-checked.
- The inventory is cached for 6 h in `<dataDir>/tools/inventory.json`. The first detection runs 20 s after start,
  and is skipped with `devFakeRuntime`.
- The inventory is reported in `CAPABILITIES.toolInventory` (`tools-v1`). The master stores it in
  `workers.tool_inventory`.
- Placement treats a job's `tools` as satisfied by found tools plus aliases: `browser` ← chrome / edge / chromium /
  playwright-chromium; `container` ← docker / podman.
- Recipes:
  - Unprivileged recipes (`RECIPES`) are pinned URLs with size and sha256:
    - `browser@1248`: Playwright Chromium, 5 platforms.
    - `git@2.56.0.2`: MinGit, win32-x64.
    - `python@3.13.16`: NuGet `python` package, win32-x64.
  - The defensive ZIP extractor covers ZIP64, CRC, traversal and symlink containment, and limits on entries and
    bytes.
  - Elevated recipes (`ELEVATED_RECIPES`: Linux git / python / ffmpeg via apt or dnf) are not run by the worker.
    The master turns them into a machine-admin job with a fixed prompt.
- Routes:
  - `GET /workers/:id/tools` (`workers.read`).
  - The following are `workers.ops.write` (admin) + step-up:
  - `POST /workers/:id/tools/detect`;
  - `POST /workers/:id/tools/:tool/install` (`409 machine_admin_required` for elevated recipes);
  - `POST /workers/:id/tools/:tool/remove`;
  - `POST /workers/:id/inspect` (sections software, services, disk, logs, tools; redacted and bounded).

## 3. Per-machine memory

- The machine's memory is the context document `machine:<workerId>/memory` (kind memory, read/write admin).
- It is written only by `MachineAdminService`:
  - the agent's `machine_note` tool (a memory event of the job);
  - the worker's job-end summary of what ran elevated;
  - an owner/admin edit in Fleet (`PUT /workers/:id/machine-memory`, step-up).
- It is trimmed to 64 KiB (`MAX_MACHINE_MEMORY`), oldest entries first.
- Every later machine-admin job on that machine gets it in `ASSIGN_JOB.machineAdmin.memory`. The preamble fences
  it as notes from earlier jobs, data and not instructions.
- It is excluded from project search, other jobs' context bundles and the generic context editor.

## 4. Skills

- `SKILLS_PANEL_KEY_FILE` holds an Ed25519 PKCS#8 PEM, mode 0600, loaded at start.
- `draft_skill`:
  1. Validates the bundle (same limits as uploads).
  2. Computes a unified diff against the latest version.
  3. Stores a draft card showing the diff.
  4. On confirm (`skills.publish`, admin, step-up) the master signs with the panel key, and the version records
     `signer: 'panel'`.
- Workers trust the key through the signed managed configuration (`panelSkillKeys`). The worker's skill
  verification uses its local keys plus the panel keys, minus the local veto.
- An assignment with `project = '*'` applies to all projects. A project-specific assignment of the same skill
  wins.

## 5. Chat

| Tool | Kind | Who | Notes |
| --- | --- | --- | --- |
| `machine_inspect` | read | admin | runs remote op `machine.inspect`, waits ≤ 40 s, output fenced untrusted |
| `draft_machine_task` | draft | admin | refused while machine admin is off; confirm = owner/admin + always-fresh step-up |
| `draft_tool_install` | draft | admin | unprivileged → remote op; elevated → machine task (always-fresh) |
| `draft_skill` | draft | admin | shows the diff; refused without `SKILLS_PANEL_KEY_FILE` |

## 6. Data (migration 0038)

- The `machines` project: workspace kind, host execution, web egress, reserved for submissions.
- `machine_admin_commands`: request, op digest and summary, decision, approval id, result, timestamps.
- `workers.tool_inventory`, `workers.machine_admin` (the worker's report).
- `skill_versions.signer`, `skill_assignments.project = '*'`.
- Widened CHECKs: approval action, config causes, `worker_ops` kinds, `chat_drafts` kinds, context namespace.

## Verification

- **Unit and integration tests:**
  - protocol `machine-admin.test.ts`;
  - worker `tools-zip`, `tools-recipes` (online, opt-in), `tools-inventory`, `machine-admin`, `machine-admin-job`,
    `managed-config`, `service-installers`;
  - adapters `admin-tools`;
  - scheduler `placement`;
  - master integration `machine-admin.test.ts` (real worker daemon + broker), `chat.test.ts` (tool RBAC),
    rbac-matrix, route coverage;
  - web `machine-admin.test.tsx`.
- **Real target, 2026-10-14:** `desktop-pc`, Windows 11 26200, Windows PowerShell 5.1, tr-TR, worker 1.0.9
  running as `NT SERVICE\RemyralWorker`. Everything ran under `%TEMP%\rm-ma-check` and was removed afterwards. The
  service, `C:\ProgramData\RemyralWorker` and `C:\Program Files\RemyralWorker` were not touched.
  - **Tool detection** found:
    - node 24.21.0;
    - Chrome 155.0.8059.40 (from the version folder, not started);
    - wsl.
    - Edge correctly not found: it was removed from that machine, and only WebView2 remains.
    - git, python, docker and ffmpeg correctly absent.
  - **Inspect** returned 8 installed programs, 264 services and disk C:. Turkish names were intact ("Microsoft
    Edge WebView2 Çalışma Zamanı"). It found a real bug: registry values with trailing NULs ("Mesh Agent\0"). Fixed
    by dropping control characters, with a unit test.
  - **Recipe installs** into a temp data dir, with checksums verified and the ZIP extracted:
    - MinGit 2.56.0.2 (44 s);
    - Python 3.13.16 (7 s);
    - Playwright Chromium 1248 (153 s, about 200 MB).
    - All three were detected as managed and satisfy `git` / `python` / `browser`. The browser hint was
      produced.
  - **Broker in-process** (Administrator, real exec, real ACL):
    - `cmd whoami`;
    - PowerShell exit code 7 preserved, UTF-8 text `şğüİı` round-tripped, tr-TR culture with `ToUpperInvariant`
      correct;
    - `cmd` verbatim quoting kept;
    - write_file / read_file worked;
    - a forged grant was refused (`bad_signature`) and its command did not run;
    - the broker dir ACL is exactly `NT SERVICE\RemyralWorker:(OI)(CI)(RX)`, `BUILTIN\Administrators:(F)`,
      `NT AUTHORITY\SYSTEM:(F)`;
    - results were removed at session end.
  - **The real launcher:**
    - Setup:
      - The bundled `remyral-worker-updater.mjs admin-session` was built from this branch.
      - It was started by a temporary scheduled task with the installer's exact settings: SYSTEM (S-1-5-18),
        every minute, IgnoreNew, time limit.
      - The config and install dirs were in temp.
    - Every check above passed again, with `whoami` = `nt authority\system`.
    - The task's last result was 0, and the temporary task was unregistered.
  - **`infra/worker/windows/test/Install.Tests.ps1`** under Windows PowerShell 5.1 tr-TR: ALL PASSED (107
    assertions), including the RemyralWorkerAdmin task and its removal.
- **Not verified on a real target:**
  - The full chain from a live master to a real installed worker: the installer was not re-run on desktop-pc, by
    the safety limits of the task.
  - The worker process reading results as `NT SERVICE\RemyralWorker`: ACL shown, not exercised as that account.
  - The heartbeat-stale end on Windows (unit-tested on POSIX).
  - The Linux path unit and the macOS WatchPaths trigger (unit- and plan-tested only).
  - Elevated apt/dnf recipes.
