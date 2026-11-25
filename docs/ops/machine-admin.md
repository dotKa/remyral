# Runbook: AI machine administration, tools and panel-signed skills

- **Applies to:**
  - Workers advertising `machine-admin-v1` / `tools-v1` / `panel-skills-v1` (this release and later).
  - Master with migration 0038.
- **Audience:** owners and admins.
- **Design:** [docs/design/p5-machine-admin.md](../design/p5-machine-admin.md). **Decision:**
  [ADR-0021](../adr/0021-ai-machine-administration.md).

Machine administration lets an AI agent run commands as **SYSTEM / root** on a machine you choose. That includes
installing software, changing services and editing system files. It is off on every machine until an owner turns
it on.

## 1. One-time setup per machine

1. **Update the worker** to this release (Settings → Worker releases, or automatic).
2. **Re-run the installer kit once, as Administrator/root.** The machine-admin trigger is part of the privileged
   helper, and that helper is never updated automatically:
   - Windows: `install.ps1` from the kit. It adds the scheduled task `RemyralWorkerAdmin` (SYSTEM, every minute).
   - Linux: `install.sh`. It adds `remyral-worker-admin.path` and `remyral-worker-admin.service`.
   - macOS: `install.sh`. It adds `/Library/LaunchDaemons/com.remyral.worker.admin.plist`.

   Until this is done, Machines → <machine> → Admin → Machine admin shows "Privileged helper: missing" (or "unknown") instead of "installed".
3. **Bind the helper to this machine's worker (once).** The root/SYSTEM helper only accepts master-signed sessions,
   commands and privileged requests for the worker id recorded in `<install dir>/state/admin-binding.json` (written
   by root/SYSTEM only — never by the worker). One master signs for every worker, so without this record a grant
   issued for another machine could be replayed here.
   - **Existing, already approved machine:** step 2 (re-running the installer) records it automatically and prints
     `machine administration bound to worker <id> (device key <fingerprint>)` — compare both with
     Machines → <machine>.
   - **New machine:** the installer runs before the approval, so after approving it run once, as root /
     Administrator:
     - Linux: `sudo <node> /opt/remyral-worker/remyral-worker-updater.mjs admin-bind`
     - macOS: `sudo <node> "/Library/Application Support/RemyralWorker/bin/remyral-worker-updater.mjs" admin-bind`
     - Windows (elevated PowerShell): `& "<node.exe>" "$env:ProgramFiles\RemyralWorker\remyral-worker-updater.mjs" admin-bind`

     `<node>` is the Node the installer used (its *Done* text prints the full line). Re-running the installer after the
     approval does the same. `--worker-id <id>` refuses to bind anything but the id you copied from the console.
   - **Machine paired again** (new worker id): `admin-bind --replace`, after comparing the fingerprint.

   Until then the console shows "Privileged helper: Unavailable — … not yet bound …" with the exact command, and the
   helper refuses sessions with `helper_not_bound` (`wrong_worker` for a grant of another worker). Sandbox prepare and
   panel-driven removal keep working on an unbound machine; once bound they too are refused for another worker id.
4. **Host jobs must be confined** (or you opt in explicitly). While `host-restricted` jobs on the machine run without
   filesystem confinement — Linux without a usable bubblewrap view (Ubuntu 24.04's default), Windows without per-job
   accounts — job code runs as the worker's own account and can read its device key and write its request files;
   together with machine administration that is a path to root. In that state the worker declines machine-admin jobs
   (`machine_admin_host_unconfined`) and the root/SYSTEM helper (re-run installer) checks on its own and refuses
   sessions (`host_unconfined`); the console shows "Privileged helper: Unavailable — host jobs … without filesystem
   confinement". Fix the confinement ([worker-sandbox.md](worker-sandbox.md#host-jobs-without-filesystem-confinement-none)),
   or accept the risk on this machine with `"localCeiling": { "allowMachineAdmin": true }` (installers:
   `--allow-machine-admin` / `-AllowMachineAdmin`) and restart the worker.
5. **Runtime:** machine-admin jobs use **Claude Code**. It must be installed, enabled for the worker and logged in
   (docs/ops/runtime-setup.md).
6. **Turn it on:** Machines → <machine> → **Admin → Machine admin** → *Enable machine administration…* → confirm. This needs:
   - the owner role;
   - an authenticator code from the last few minutes.

   Owners get a critical notification. The worker's projects gain **Machines**.
7. Optional, for unattended runs: tick *Allow full access* there, **and** enable *Allow auto-approve* on the
   Machines project (Projects → machines → Execution policy). Both are needed. Without them, every elevated command
   waits in Approvals.

**Local veto** (it beats the panel): in the machine's config file (Windows `C:\ProgramData\RemyralWorker\config.json`,
Linux `/etc/remyral-worker/config.json`, macOS `/Library/Application Support/RemyralWorker/config.json`) set:

```json
"localCeiling": { "allowMachineAdmin": false, "allowPanelSkills": false }
```

Then restart the worker. The worker refuses machine-admin leases, and the helper refuses every session. The
installers set it for you: `install.sh --no-machine-admin` (Linux, macOS) / `install.ps1 -NoMachineAdmin` (Windows) —
on a new config, and on an existing one (only that key changes, through
`remyral-worker-updater.mjs machine-admin-ceiling forbid`, and the worker is restarted). `--allow-machine-admin` /
`-AllowMachineAdmin` writes `true` (an explicit opt-in, which also accepts machine administration while host jobs run
without filesystem confinement, §1.4); `machine-admin-ceiling unset` removes the key again.

### Trust model: what the master can do on a machine

Read this before you enable machine administration anywhere.

- **The default is "the panel decides".** Without `localCeiling.allowMachineAdmin` in the machine's config, the
  machine accepts machine administration as soon as the console enables it for that worker, and the master can also
  install the helper's trigger remotely (Machines → <machine> → Admin → Machine admin, helper install — a master-signed `helper.manage`).
  The installers do not write the key unless you pass one of the flags above.
- **A compromised master, or a stolen lease-signing key, is therefore root / SYSTEM on every machine that has not
  vetoed it locally**: it can turn the switch on, install the trigger, and sign sessions and commands (with *Allow
  full access* none of them waits for a human). The owner step-up, the authenticator code and the approvals are
  controls *of the master*; they do not bind a master that is no longer yours. The helper only adds: one worker id
  per machine (§1.3), validity windows, replay protection and the local veto.
- **Not affected by a compromised master:** worker *updates* (they must be signed with the offline release key, and
  a rollback can only return to the version the machine ran before), and machines with the local veto.
- **To lock a machine down**, pick one:
  - `--no-machine-admin` / `-NoMachineAdmin` when you (re-)run the installer, or set the key by hand as above;
  - remove the trigger (table in §6) — the master can install it again unless the veto is set;
  - re-install without the updater (no helper at all; no automatic updates either).
- `masterLeaseKeys` in the config pins *which* master keys are trusted; it does not help once a pinned key is stolen.

## 2. Running a machine task

- **Machines → <machine> → Admin → Machine admin → New machine task:** enter a title and what to do, choose a policy ("Ask for
  every elevated command" is the default), then start (fresh code).
- **Chat:** "install Python on desktop-pc". The assistant drafts a *machine task* card, and you confirm it with a
  fresh code.
- **Machines → <machine> → Tools → Install** for a tool that needs a package manager (Linux git / python / ffmpeg) starts the same
  kind of job.

While the job runs, each elevated command appears in **Approvals** (critical, "Machine admin"), showing the exact
command, shell, working directory and timeout. Approve it only if you understand it. Commands, results, exit
codes and durations appear in the job's events and in Machines → <machine> → Admin → Machine admin → *Recent elevated commands*. The
audit actions are `machine.admin.*` and `worker.machine_admin`.

## 3. Tools

Machines → <machine> → **Tools** shows what was detected:
- browsers, git, python, node, docker / podman, uv, wsl, ffmpeg;
- tools the worker installed itself ("managed").

The inventory is refreshed every 6 h, or with *Detect now*.

| Install button | Where it goes | Needs elevation |
| --- | --- | --- |
| Browser (Playwright Chromium rev. 1248), all platforms | `<dataDir>/tools/browser/1248/` | no |
| Git (MinGit 2.56.0.3), Windows | `<dataDir>/tools/git/…` | no |
| Python 3.13.17 (+ `pip.cmd` launchers in `Scripts`), Windows | `<dataDir>/tools/python/…` | no |
| ffmpeg 9.0.2 (gyan.dev essentials, GitHub release `GyanD/codexffmpeg`), Windows | `<dataDir>/tools/ffmpeg/…` | no |
| Git / Python / ffmpeg on Linux | system packages (apt / dnf) | yes: becomes a machine task |

- **Use by the worker and agents (p5-live-fixes-2).** Repository jobs run git from the config's `gitBinary`, else
  the managed MinGit, else `git` on PATH — resolved per command, so an install takes effect without a restart. For
  the host profiles (`host-restricted`, `runtime-sandbox`, `unconfined`) the runtime's PATH starts with the managed
  bin dirs (git `cmd`, python and `python\Scripts` for pip, ffmpeg `bin`), and `PLAYWRIGHT_BROWSERS_PATH` /
  `REMYRAL_BROWSER` point at the managed Chromium unless the job sets them. The `container` profile is unchanged:
  the host's tool dirs are not mounted there; the runtime image brings its own tools.

- Each download is checked against its pinned SHA-256 before anything is extracted. `integrity_mismatch` means the
  CDN served other bytes. Do not retry blindly.
- Jobs that need a `browser` are placed only on workers that have one. Jobs on a worker with a managed browser are
  told its path (`PLAYWRIGHT_BROWSERS_PATH`).
- **Inspect** (Tools → Inspect, or chat `machine_inspect`) lists installed software, services, disks, recent logs
  and tools. It is read-only and redacted.

## 4. Machine memory

- Machines → <machine> → Admin → Machine admin → **Memory** holds the notes the agent kept about this machine (`machine_note`)
  and a summary of what ran elevated in each job.
- Later machine-admin jobs on the machine read it first.
- Edit it there (fresh code) to correct or remove something. It is never shown to project jobs or in search.

## 5. Panel-signed skills (chat-authored)

1. On the master host, create the key and back it up off the host:

   ```sh
   cd /data/remyral/prod/secrets
   sudo sh -c 'umask 077; openssl genpkey -algorithm ed25519 -out skills-panel.pem'
   sudo chown 10001:10001 skills-panel.pem && sudo chmod 0400 skills-panel.pem
   ```

2. Set `SKILLS_PANEL_KEY_FILE=/run/secrets/remyral/skills-panel.pem` in Coolify and redeploy. Managed workers
   receive the public key in their signed configuration within a minute.
3. In chat, ask the assistant to write or improve a skill. The *skill* card shows a unified diff. Confirming (admin,
   fresh code) signs and publishes the new version.
4. Skills → each version shows **Signed by: offline key / panel key**. Assign a skill to **All projects** or to one
   project; a project-specific assignment wins.

- **Rotate or revoke:** replace the file (rotate) or unset the variable (revoke), then redeploy. Workers drop the
  old key on their next configuration sync. Versions it signed stop verifying, so re-publish the ones you keep.
- The offline key (`scripts/skills/sign.mjs`) keeps working and stays the backup.

## 6. Turning it off / rollback

| Goal | Do |
| --- | --- |
| Stop for one machine | Machines → <machine> → Admin → Machine admin → *Disable machine administration*. New jobs are refused; further commands of a running job are denied. |
| Forbid locally | `localCeiling.allowMachineAdmin: false` + restart the worker (installers: `--no-machine-admin` / `-NoMachineAdmin`) |
| Remove the trigger | re-run the uninstaller, or `schtasks /Delete /TN RemyralWorkerAdmin /F` / `systemctl disable --now remyral-worker-admin.path` / `launchctl bootout system/com.remyral.worker.admin` |
| Stop panel skills | unset `SKILLS_PANEL_KEY_FILE` and redeploy; or `localCeiling.allowPanelSkills: false` on a machine |

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Job infeasible `machine_admin_unsupported` | worker older than this release |
| `machine_admin_not_enabled` | switch is off, or the machine's local veto is set (the message says which) |
| `auto_approve_not_allowed` | allow-all job without *Allow full access* on the worker or auto-approve on Machines |
| Commands fail `helper_not_started` (the elevated session never became ready) | installer not re-run (§1.2); on Windows check `Get-ScheduledTask RemyralWorkerAdmin`; Linux `systemctl status remyral-worker-admin.path` |
| Helper "not bound" / session refused `helper_not_bound` | §1.3: run `admin-bind` once as root / Administrator (or re-run the installer after the approval) |
| Session refused `wrong_worker` / helper "serves another worker id" | the grant was signed for another worker, or the machine was paired again: compare the fingerprint, then `admin-bind --replace` |
| Job declined `machine_admin_host_unconfined` / session refused `host_unconfined` | host jobs on the machine run without filesystem confinement: §1.4 |
| Session refused `keys_unavailable` | the helper could not fetch the master's lease keys; check `masterUrl` / network, or pin `masterLeaseKeys` in the config |
| Command `refused bad_signature` | the grant did not verify (lease key rotated mid-job); re-run the job |
| Chat: "machine administration is not enabled" | turn it on in Machines → <machine> → Admin first; the chat can never enable it |
| Chat: skill drafts need `SKILLS_PANEL_KEY_FILE` | §5 |
