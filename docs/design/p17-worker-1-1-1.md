# p17-worker-1-1-1 — purpose of elevated commands, cut-over repairs, root helper readiness

- **Task:** `p17-worker-1-1-1`. **Date:** 2026-10-25. The code of the next worker release (the first normally signed
  Remyral release after the 1.1.0 transition). Builds on [p5-machine-admin](p5-machine-admin.md) (ADR-0021),
  [p10-approval-readable](p10-approval-readable.md) and [p17-remyral-rebrand](p17-remyral-rebrand.md).
- **Migration:** 0155 (`machine_admin_commands.purpose`).
- **Protocol:** additive in 1.0 — worker feature `machine-admin-purpose-v1`, MACHINE_ADMIN_REQUEST `purpose`,
  CAPABILITIES `machineAdmin.helperReason`.
- **Release:** master + web first, then the worker release (§5). Ships what is already on main: the 0711
  `<install>/state/machine-admin` fix of the root helper (Linux `helper_not_started`), rule 48 of the assistant and the
  `blob-upload-v1` worker path (p17-object-storage).

## 1. Purpose of an elevated command

Owner: "onaylarda komutun ne için olduğunu görebileceğimizi konuşmuştuk ancak göremiyoruz." An approval of a
machine-admin command showed only `adminOpSummary` (`[sh] id -u # check: root helper works (read-only)`).

- **Agent.** `admin_exec`, `admin_write_file` and `admin_read_file` take `purpose`, described as required: "one
  sentence — why this command is needed now, in the user's language". The schema keeps it optional so a call without
  it still runs; then the command's own comment is used — a leading comment line (`# …`, cmd `REM …` / `:: …`) or a
  trailing `# …` on the first line outside quotes (`commandComment`, packages/agent-adapters/src/admin-tools.ts).
  The preamble already asks for self-explanatory commands.
- **Shape.** `AdminPurpose`: 1–300 characters, one line, no control or invisible (bidi / zero-width) characters,
  trimmed. `normalizeAdminPurpose` folds whitespace and control characters to one space, drops invisible characters
  and cuts at 300 with `…`; its output always satisfies the schema. The worker redacts (job secrets) before it
  normalises; the master redacts again with the pattern redactor and normalises once more.
- **Not signed.** The purpose is metadata next to `op`, never inside it: `adminOpDigest`, the command statement the
  master signs and the broker's checks are unchanged. A worker that lies about the purpose changes only a label; the
  approver still sees the exact command, and the UI says the text is the agent's unverified claim.
- **Master.** `machine_admin_commands.purpose` (migration 0155, CHECK 1–300), the `machine.admin.command` audit
  metadata, and the approval request's structured `details` (p10-approval-readable): `{tool: admin_exec, description:
  <purpose>, command, shell, cwd}` or `{tool: admin_write_file | admin_read_file, description, paths: [path]}`. The
  details are display only (the approval binds the request id; the signature binds the digest); they also give the
  approval the readable command plate and the "what it touches" reading. An auto-approved command has no approval —
  its purpose is in the command log and the audit. The job's event stream carries it as the tool call's argument.
- **Console.** Every approval with an agent explanation (the runtimes' own `description` / `reason` fields, now the
  machine-admin purpose too) shows it above the command as **"Amaç (ajanın açıklaması, doğrulanmadı)"** — the approval
  card (Senden bekleyenler, the job), the Onaylar row ("Amaç (doğrulanmadı): …") and the approval detail screen. The
  machine page's command log shows it above each command and in its detail.
- **Feature flag.** Workers with `machine-admin-purpose-v1` send `purpose`. Older workers send none and nothing is
  shown; an older master strips the unknown field (zod object), so a new worker keeps working against it.

## 2. Cut-over repairs (code marked `p17-cutover`)

> Removed 2026-10-25 with the rest of the transition code (p17-cutover-cleanup, `p17-remyral-rebrand.md` "Cut-over
> done"): the migration and both load-time tolerances are gone; a kit now refuses a pre-rename install.

The 1.1.0 migration kit (`remyral-worker-updater migrate-legacy`) moved the directories but left two values behind:

1. `config.json` `sandbox.workerUser` kept the pre-rename account (`NT SERVICE\RemanaWorker`, `remana-worker`,
   `_remanaworker`): the identity check then failed (`worker_user_mismatch`) and host profiles were refused.
2. `<data>/runtimes/<runtime>/state.json` kept `launch.file` / `launch.args` in the pre-rename data dir: the entry
   digest check failed and every managed runtime install was flagged `modified` (not used).

**Migration (new machines).** `rewrite-json` steps take `values` — exact-value renames at a key path, applied after
the prefix rewrite: `sandbox.workerUser` `NT SERVICE\RemanaWorker` (any case) → `NT SERVICE\RemyralWorker`,
`remana-worker` → `remyral-worker`, macOS `_remanaworker` → `_remyralworker` (and the plain `remana-worker` of
hand-made configs). No prefix matching on other strings. The probe lists the managed runtimes with a `state.json`
under the pre-rename data dir (`Facts.runtimeStates`); after the data dir moved, one `rewrite-json` step per runtime
rewrites its paths (Windows `C:\ProgramData\RemanaWorker\` → `RemyralWorker\` and the Program Files dir, Linux
`/var/lib/remana-worker/` and `/opt/remana-worker/`, macOS `/Library/Application Support/RemanaWorker/` and the log
dir). Both are journalled with the original text, so `--rollback` and a failing step restore them. Path prefixes now
match only the whole value or up to a separator (`/opt/remana-worker` no longer matches `/opt/remana-workerX`).

**Load-time tolerance (machines the 1.1.0 kit already migrated).** Only in the Remyral flavor:

- `evaluateIdentity`: when `sandbox.workerUser` is exactly the pre-rename account and the process runs as exactly the
  Remyral installer account (Windows: proven by the `RemyralWorker` service SID, never by a name), that account is
  used; `WorkerIdentity.legacyWorkerUser` is set and the job wiring logs a warning to fix the config.
- `RuntimeInstaller` load: a launch path in the pre-rename data dir (the current data dir with `remyral-worker` /
  `RemyralWorker` renamed back) whose file exists under the current data dir is read as that file; the digest check
  then passes and the install is not `modified`. The next save of the state file writes the current path.

The Linux machine is migrated with 1.1.0 and is repaired by this tolerance; Windows was fixed by hand.

## 3. Root helper readiness

"Available" meant only "the updater file carries `remana-admin-helper/v1`". On Linux that was true while every
session ended in `helper_not_started` (the 0750 answer dir), and the console said "Kurulu". The worker now probes,
read-only and without root (`apps/worker/src/machine-admin/report.ts`, cached for a minute):

| OS | Check | Reason code |
| --- | --- | --- |
| all | install dir known; updater present; marker | `install_dir_unknown`, `helper_missing`, `helper_outdated` |
| Linux | `/etc/systemd/system/remyral-worker-admin.path` exists | `admin_unit_missing` |
| Linux | enabled: `multi-user.target.wants` symlink, else `systemctl is-enabled` | `admin_unit_disabled`, `probe_failed` |
| Linux, macOS | `<install>/state/machine-admin` (else `<install>/state`) traversable (`access X_OK`) | `state_dir_not_traversable` |
| macOS | `/Library/LaunchDaemons/com.remyral.worker.admin.plist` exists | `admin_plist_missing` |
| Windows | `schtasks.exe /Query /TN RemyralWorkerAdmin` | `admin_task_missing`, `admin_task_unreadable` |

CAPABILITIES `machineAdmin.helper` stays `available | missing | unknown` (older masters validate that enum);
`helperReason` carries the code and `helperDetail` the English text. `missing` — the master refuses new machine tasks
with `helper_missing` — only for definite findings. A Windows task the service account cannot see, or a probe that
cannot tell, is `unknown` with its reason (UNVERIFIED on a real Windows: whether the virtual service account may query
a SYSTEM task; "not found" is matched in English and Turkish output only). The machine page shows "Kullanılabilir" /
"Kullanılamıyor — <reason in the user's language>"; Doctor (`remyral-worker doctor`, the remote `doctor.run`) has a
`machine_admin` check with the same codes (warning for definite findings, info when there is no helper or the probe
cannot tell).

## 4. Security

- The purpose is untrusted agent text: redacted twice, bounded, one line, invisible characters removed, rendered as
  React text only, labelled "doğrulanmadı". It never reaches a signature, a digest or a decision.
- The identity tolerance never loosens the check: it applies only to the exact pre-rename name and only when the
  process already is the Remyral installer account; admin / SYSTEM / root / console checks run unchanged.
- The launch path tolerance only follows a file under the worker's own current data dir; the digest recorded at
  install time is still verified against it.
- The readiness probe runs no privileged command: `lstat`, `access`, `systemctl is-enabled`, `schtasks /Query`.

## 5. Release order and rollback

1. Master + web (migration 0155 is additive; an older master ignores the column; drop it with
   `ALTER TABLE machine_admin_commands DROP COLUMN purpose`).
2. Worker release (normal signing domain). Older workers keep working: no purpose, no `helperReason`.
3. Machines with the 0750 helper dir still need the installer kit once (or `chmod 711 <install>/state/machine-admin`);
   the console now says so.

## Verification

Unit / integration tests: protocol `machine-admin.test.ts` (purpose schema, normalisation, report reason),
agent-adapters `admin-tools.test.ts` (purpose argument, comment fallback, host meta), worker `machine-admin.test.ts`
(the session sends the redacted purpose), `machine-admin-readiness.test.ts` (Linux / macOS / Windows probe, cache,
Doctor finding), `remana-to-remyral-migration.test.ts` (worker account + runtime states on Linux, macOS, Windows,
rollback), `remana-to-remyral-repairs.test.ts` (identity and launch path tolerance), master
`integration/machine-admin.test.ts` (purpose stored, approval details and headline, audit, auto-approved command) and
`unit/machine-admin-purpose.test.ts`, web `diyalog-approvals.test.tsx` and `diyalog-w3-machine-admin.test.tsx`.
UNVERIFIED on real machines: the migration and the probes on Windows / Linux / macOS (fakes only).
