# p6-safe-auto-approve — safe commands are approved by the master

Status: implemented 2026-10-16 (task `p6-safe-auto-approve`, plan: [p6-efficiency.md](p6-efficiency.md)).
Migration 0047. **Worker release needed** (the worker makes the claims). Related: ADR-0010 (untrusted repository
instructions), ADR-0020 §6 (less noise under `ask-sensitive`), [p4-approvals.md](p4-approvals.md).

## 1. Problem

Live use (2026-10-15/16, one Windows worker): harmless commands waited minutes, once ten, for a human —
`git status; git log`, `New-Item out; Set-Content out/date.md …`, `Get-ChildItem`. Jobs and unattended automations
stalled. ADR-0020 §6 had added a Claude-Code-only local allowlist for *single, metacharacter-free* bash commands, so
every compound command, every PowerShell command and every OpenCode / Pi shell call still asked — and the local
allowlist was neither audited nor switchable per project.

## 2. Decisions

1. **Project setting `safeCommands`** on the Policy tab (Projects → project → Policy → Safe commands), stored in
   `projects.safe_commands` (versioned with the execution policy: admin, always-fresh step-up, audited
   `project.execution.update` with before/after, owners/admins notified):
   - `off` — every shell command of an `ask-sensitive` job asks (the behaviour before);
   - `read-only` — commands proven read-only are approved automatically; writes ask;
   - `workspace-writes` — also commands that write only inside the job workspace.

2. **Default `read-only`** for existing and new projects. Reasoning: a read-only command inside the job workspace
   discloses nothing the agent cannot already read with its structured read tools (Claude Code Read / Grep / Glob,
   OpenCode read / grep / glob / list, Pi read / grep / find / ls), which never ask under `ask-sensitive` (ADR-0020
   §6, p3 adapters). The old Claude-Code-only local rule already auto-allowed a subset of these without any audit, so
   no existing project loses protection; it gains an audit trail and an off switch. **Workspace writes stay off by
   default**: they change the job's output and an admin should opt in knowingly. The UI warns when it is switched on.

3. **Where writes may go: the whole job workspace, minus anything that changes how tools behave later.** The
   execution profile (ADR-0007) already confines the job to its workspace, and ADR-0020 §6 already lets structured
   edits (Write / Edit) land anywhere in it, so restricting shell writes to `./out` would be inconsistent without
   making anything safer. Refused for writes: the workspace root itself, every path segment starting with `.`
   (`.git`, `.claude`, `.vscode`, `.husky`, `.env`, `.opencode` …), and agent instruction / runtime config files
   (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `opencode.json[c]`). `.git` is refused for reads too
   (hooks, config with credentials).

4. **Where the decision is made: the master's approval path, with the worker's agreement.** Follows the existing
   architecture (p4-approvals: the runtime/worker can only *ask*; the master answers):
   - The **worker** (adapter) runs the shared classifier on the *exact command the runtime will execute* (taken from
     the tool input / permission metadata, never from a description) and then checks every path on disk: symlinks of
     the deepest existing ancestor resolved, no hard-linked file (`nlink > 1` can be the same inode as a file
     outside), `.git`/dot rules re-applied to the resolved path, and for git commands a repository at the workspace
     root whose own config names no program (fsmonitor, filters, textconv, external diff, pager, includes …). Only
     then does it attach a **claim** (`safeCommand`) to the `approval_request` event.
   - The **master** (`ApprovalService.evaluate`) re-parses the claim, re-classifies the claimed command itself and
     approves only if: the request is a `runtime.dangerous_tool` in-run request, the job's approval policy is
     `ask-sensitive`, the project mode allows the verdict, the master's verdict equals the worker's, and no request
     with the same `(attempt, approvalId)` exists yet (a replay of something that already went to a human keeps that
     answer). It then answers `approve` at once (`decidedBy: safe-commands`) and audits **`approval.auto_safe`** with
     the tool, command, shells, platform, verdict, matched rule ids and mode. Otherwise the request goes to a human
     exactly as before, and its `approval.request` audit records why the claim did not count (`safeCheck`:
     `mode_off`, `mode_read_only`, `not_safe`, `verdict_mismatch`, `invalid_claim`, `job_policy`,
     `not_runtime_tool`).
   - Nothing else changes: `ask-all` asks for everything, `deny-sensitive` denies, `allow-all` (ADR-0020) does not ask;
     merge, push, deploy, deletes outside the workspace and secrets keep their platform floor (the claim is only
     looked at for `runtime.dangerous_tool`).

5. **The old local Bash shortcut is removed** (`isReadOnlyCommand`, `read_only_command`): every shell command now goes
   through the master so the project mode decides and each approval is audited. Structured workspace writes
   (ADR-0020 §6) stay local and unchanged.

## 3. The classifier (`@remyral/protocol/safe-commands`)

Pure, synchronous, no filesystem, no Node APIs (it also runs in the console to render the list). **Parse, don't
regex-guess**: one small recursive-descent parser per shell family accepts a strict subset and refuses everything it
does not model. A command line is safe only if **every** command in it is on the allowlist with allowed options, and
every path argument resolves lexically inside the workspace.

| Shell family | Accepted structure | Refused (examples) |
| --- | --- | --- |
| `posix` (bash, sh, zsh, Git Bash) | `;` newline `&&` `\|\|` `\|`, `( … )`, `$( … )` and backticks (inner commands classified too; their output only as text for `echo`), `'…'`, `"…"` without expansion, `<`, `>`, `>>`, `>\|`, `&>`, `n>&m`, `/dev/null` | `$VAR`, `${…}`, `$((…))`, globs `* ? [ ]`, braces, `~` at word start or after `=`/`:`, `!`, `#`, `\`, `^`, `=cmd`, here-docs, `<(…)`, `&` background, `\|&`, assignments (`FOO=1 ls`, `LD_PRELOAD=`), functions, `if`/`for`/`[[`, command paths (`/bin/ls`, `./x`), non-ASCII outside quotes |
| `powershell` (5.1 and 7, Windows only) | `;` newline `&&` `\|\|` `\|`, `-Param value`, `-Param:value`, `'…'`, `"…"` without `$`/backtick, comma arrays, `( … )` / `$( … )` sub-pipelines in value positions, `>`, `>>`, `n>`, `*>`, `2>&1`, `> $null` | variables, `@` (splat, here-strings, arrays, hashtables), `{ }` script blocks, `[type]::`, `&` call operator, `.` dot-source, `--%`, backtick, comments, typographic quotes / dashes / spaces PowerShell also accepts, member access after `)`, expression statements, module-qualified names, **parameter abbreviations** (exact names only), unknown aliases (`sc` is Service Control in PS 7), Get-ChildItem piped into a path-binding cmdlet (unchecked children) |
| `cmd` | `&` `&&` `\|\|` `\|` newline, `"…"`, `>`, `>>`, `<`, `n>&m`, `nul` | `%` and `!` (expand even inside quotes), `^`, `( )`, `@`, unquoted `,` `;` `=` (cmd splits on them), `dir/s`-style glued names |

Paths (all families): resolved lexically against the workspace root and refused when they leave it, when they are
`~`-relative, UNC / `\\?\` / `\\.\` / `//`, drive-relative (`C:foo`), root-relative (`\foo`, MSYS `/tmp`), contain a
stream or provider colon (`a.txt:s`, `env:`, `HKLM:`), 8.3 short names (any `~` on Windows: `GIT~1` can be `.git`),
reserved device names, trailing dots or spaces, or wildcards (PowerShell / cmd expand them even when quoted). Git Bash
`/c/...` maps to `C:\...`. Windows comparisons are case-insensitive.

**Allowlist** (`SAFE_COMMAND_RULES`, data in `packages/protocol/src/safe-commands/rules.ts`, rendered on the Policy
tab with what each mode covers):

- every shell: `git status|log|diff|show|branch|rev-parse|ls-files` — no global options except `--no-pager` (no `-c`,
  `-C`, `--git-dir`, `--work-tree`, `--exec-path`), no `--output`, `--ext-diff`, `--textconv`, `--no-index`, `-O`,
  `--upload-pack` (long options also by prefix: `--ou=`), `git branch` only lists, object specs (`HEAD:path`) without
  `..`; redirections (`<` read, `> /dev/null|$null|nul`, `2>&1`; `>`/`>>` into the workspace = write);
- POSIX: `ls cat head tail wc grep egrep fgrep rg find stat du tree diff sort uniq cut tr echo printf basename dirname
  pwd date uname whoami hostname`, writes `mkdir touch tee`, each with its forbidden options (e.g. `find -exec
  -execdir -ok -delete -fprint* -fls -L -H -follow -newer`, `rg --pre --pre-glob -z -L --hostname-bin`, `grep -R`,
  `tail -f`, `sort -o -T --compress-program`, `date -s` / operands other than `+FORMAT`, `hostname` without
  arguments) and the role (path / pattern / data) of every value-taking option (`grep -f FILE` is a path);
- PowerShell: `Get-ChildItem (gci ls dir) Get-Content (gc cat type) Get-Item Test-Path Select-String Get-Location
  Get-Date Get-CimInstance (Win32_OperatingSystem, ComputerSystem, Processor, LogicalDisk, BIOS, PhysicalMemory,
  VideoController only; no -ComputerName / -CimSession / -Query) Write-Output (echo) Write-Host Select-Object
  Sort-Object Measure-Object Format-Table/List Out-String Out-Null`, writes `New-Item (-ItemType File|Directory
  only) mkdir/md Set-Content Add-Content Out-File`; parameters are an exhaustive per-cmdlet list (no `-Wait`,
  `-Stream`, `-FollowSymlink`);
- cmd: `dir (not /p) type findstr (not /d) echo ver date /t time /t`, write `mkdir/md`.

Adding a command is a reviewed code change: list its options that write, execute, follow symlinks, reach the network
or hang, and give every option that takes a file its role.

## 4. Runtimes

| Runtime | Shell tool → shells claimed | Structured read tools (already non-sensitive under `ask-sensitive`) |
| --- | --- | --- |
| Claude Code | `Bash` → posix (Git Bash on Windows); `PowerShell` (Windows) → powershell. Claims only with input keys `command`, `timeout`, `description` (not `run_in_background`, not `dangerouslyDisableSandbox`). | Read, Grep, Glob, LS (permission mode); Write/Edit in the workspace (ADR-0020 §6) |
| OpenCode | `bash` permission (`metadata.command`) → posix on POSIX; on Windows OpenCode picks Git Bash or cmd (or PowerShell) at run time, so the command must be safe in **all three** | read, glob, grep, list = `allow` |
| Pi | gated `bash` → posix, `powershell` (Windows) → powershell; only complete gate JSON with keys `command`/`timeout` (the gate truncates at 4000 chars) | read, grep, find, ls run without the gate |
| Codex | no claims (its app-server reports a display command, not the exact argv; Codex runs its own known-safe commands without asking) — asks as before | — |

The fake runtime's scripted approvals can carry a shell command and use the same claim builder (integration tests).

## 5. Protocol, storage, API, UI

- Protocol 1.0, additive: `approval_request.safeCommand?: SafeCommandClaim` (`tool`, `command` ≤ 4000, `shells`,
  `platform`, `workspaceRoot`, `verdict`, `rules`). Older masters strip it; older workers never send it.
- Migration **0047**: `projects.safe_commands text NOT NULL DEFAULT 'read-only' CHECK (…)`. An unknown stored value
  reads as `off` (fail closed).
- `GET/PUT /projects/:id/execution` carry `safeCommands` (PUT: optional; absent keeps the value). The
  `project.execution` outbox / notification includes the mode.
- `APPROVAL_DECISION.decidedBy = "safe-commands"` for auto-approvals. No `approval_requests` row is written for an
  auto-approval (same as a policy `allow`); the audit event is the record.
- Console: Projects → project → Policy → **Safe commands** (radio cards, the full allowlist grouped by shell with what
  the selected mode covers, warning when enabling workspace writes); Overview → Policy shows the mode.

## 6. Tests

- `packages/protocol/test/safe-commands.test.ts` — ~470 cases: safe reads and writes per shell, and adversarial ones:
  compound commands with one bad part, substitutions feeding paths or options (`rg $(echo --pre=sh)`), variables and
  env expansion, globs, tilde forms, encoded / aliased / call-operator PowerShell (`-EncodedCommand`, `iex`, `&`, `.`),
  typographic dashes and quotes, parameter abbreviations, providers and ADS, UNC / `\\?\` / `\\.\`, drive-relative,
  8.3 names (`GIT~1`), trailing dots, device names, `git -c` / `-C` / `--git-dir` / `--output` / `--ou=` /
  `--no-index`, `find -exec`, MSYS roots, cmd `%VAR%` / `^` / `dir/s`, multi-shell intersection, malformed roots.
- `packages/agent-adapters/test/safe-commands.test.ts` — real filesystem: symlinked file / directory / dangling link,
  hard link, writes through links, missing repository, worktree link vs. a `.git/config` with `core.fsmonitor`,
  secrets in the command; runtime glue (Claude input keys, Pi gate JSON and truncation, OpenCode shells, `ask-all`
  makes no claim); Windows layout with an injected filesystem.
- `apps/master/test/integration/safe-commands.test.ts` — real master + real worker daemon: `git status; git log` of
  an `ask-sensitive` job is auto-approved, audited `approval.auto_safe` with command and rules, the job succeeds and no
  request row exists; `rm -rf src` waits; a workspace write waits under read-only (`safeCheck: mode_read_only`) and is
  auto-approved after switching to workspace writes; mode off and `ask-all` ask; forged claims (unsafe command,
  `; git push`, wrong verdict, outside path, bad shape, plain string, catalogued action, replay of a human request)
  never auto-approve.
- `apps/web/test/safe-commands.test.tsx` — mode display, allowlist coverage per mode, save with step-up keeping the
  other execution settings, older master → Off, read-only for non-editors.

## 7. Security review

**Assets:** files and credentials outside the job workspace, the repository metadata (`.git`), the worker host,
network egress, the human approval as a brake.

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Agent hides a dangerous part in a compound command (`git status; git push`, `ls \| sh`, `$(rm …)`) | Full parse; every command of every list, pipeline, subshell and substitution must be on the allowlist; substitutions only as text for `echo` | — |
| Obfuscation: encoded commands, aliases, call / dot-source operators, typographic dashes, parameter prefixes, env vars, globs, here-strings | Unknown programs and syntax are refused; PowerShell parameter names must match exactly; aliases are an explicit list valid in 5.1 and 7; Unicode quote / dash / space characters refused anywhere | A profile-defined function or alias shadowing an allowlisted name (see below) |
| Paths escaping the workspace (`..`, absolute, `~`, UNC, `\\?\`, providers, ADS, 8.3, device names, drive-relative) | Lexical resolution on both ends + worker-side realpath of the deepest existing ancestor | — |
| Symlink / junction inside the workspace pointing outside | Worker resolves every named path; dangling links refused; write targets re-checked after resolution | Recursive listings (`ls -R`, `find`, `grep -r`, `gci -Recurse`) do not follow links in recursion (PowerShell 7, GNU tools), but **Windows PowerShell 5.1 `Get-ChildItem -Recurse` may traverse junctions** — it lists names, never contents; creating a junction needs a human-approved command |
| Hard link to a file outside | `nlink > 1` on any named existing file refuses the claim | — |
| Time-of-check / time-of-use: the path changes between the worker's check and execution | Links cannot be created by any auto-approved command (no `ln`, `New-Item` limited to File / Directory, Write tool cannot make links), so only a human-approved command running concurrently could swap a path | Accepted; documented |
| git runs programs from config (fsmonitor, filters, textconv, external diff, pager, hooks, includes) or discovers a parent repository | No global options; `--ext-diff`, `--textconv`, `--output`, `--no-index` refused; worker requires the repository at the workspace root and refuses a `.git/config` naming any program; worker-managed worktrees keep config in the mirror (hooks off, `core.fsmonitor=false`) | A program installed in the user's *global* git config (e.g. git-lfs filters) runs as for any git use |
| Reading secrets | `.git` refused; commands containing a job secret value are never claimed; `env`/`printenv`/`$VAR`/`env:` refused | Files inside the workspace (e.g. a repository `.env`) are readable — exactly as with the Read tool |
| Network / process launch / installs / push / remote / config | Not on the allowlist (curl, wget, Invoke-WebRequest, npm, pip, ssh, nc, Start-Process, cmd /c, powershell -c, git push/remote/config/fetch …) | — |
| Writes that change later behaviour (hooks, runtime settings, agent instructions) | Writes refuse dot segments, the root and instruction / config file names; write mode is opt-in | Ordinary source files can be overwritten (as with Edit/Write); changes reach the repository only via commit, review and merge |
| A compromised or buggy worker sends a false claim | The master re-classifies the command itself and requires the same verdict; only `runtime.dangerous_tool` of `ask-sensitive` jobs; project mode decides; every approval audited | The worker reports the workspace root and the on-disk checks — a worker that lies about them is already able to run anything (it executes the jobs) |
| The description shown to humans differs from what runs | Decisions use the structured `command` from the tool input, never `description` | — |
| Claude Code `Bash` keeps its working directory between calls | Relative paths are checked against the workspace root; `cd` is not allowlisted, so only a human-approved command can move the shell elsewhere | After a human-approved `cd`, a later relative read would resolve elsewhere (reads only; writes still need the explicit write mode and the same check) |
| Denial of service (huge output, `tail -f`, reading a FIFO) | `tail -f`, `--follow`, `-Wait`, `dir /p` refused | A FIFO inside the workspace can block a read until the tool / job timeout |
| Parser bugs | Any exception → not safe; both ends must agree; ~470 adversarial unit cases | New syntax in future shell versions is refused by default (unknown → not safe) |
| Profiles: shell snapshots / `$PROFILE` define functions or aliases named like an allowlisted command | Profiles belong to the worker's service account (not writable by auto-approved commands: dot paths and outside paths refused) | A tampered service-account profile is out of scope (it already controls every job) |

Information shown to the model by `uname`, `whoami`, `hostname`, `Get-CimInstance` (machine description classes
only) is accepted. The change does not widen what a job can do *without* this feature in `allow-all`, and it never
touches the platform floor.

## 8. Rollout and rollback

- **Deploy the master first** (migration 0047; the API and the claim check), then the **worker release** (adapters
  build the claims). A new worker against an old master: claims are ignored, every shell command asks (the old local
  Bash shortcut is gone) — so do not ship the worker before the master. An old worker against the new master: no
  claims, behaviour as before.
- Rollback: set the project mode to `off` (immediate, per project); or roll the master back (the column stays,
  unused); or roll the worker back (no claims).
- Operational signal: `approval.auto_safe` audit events (Audit explorer filter); `approval.request` metadata
  `safeCheck` shows why a claimed command still asked.

## 9. Unverified (needs the owner / real hardware)

- Claude Code's Windows PowerShell tool name (`PowerShell`) and input key (`command`) are taken from the CLI's
  documented behaviour (`CLAUDE_CODE_USE_POWERSHELL_TOOL`, shell tool missing error); the pinned SDK's type file does
  not declare it. Verify on the Windows worker that the live commands (`git status; git log`, `Get-ChildItem`,
  `New-Item out; Set-Content out/date.md …`) arrive as `PowerShell` and are auto-approved.
- OpenCode's shell choice on native Windows (Git Bash vs cmd vs PowerShell) — handled conservatively by requiring
  safety in all three; verify which one runs.
- Windows PowerShell 5.1 recursion through junctions (listing only) — see §7.
