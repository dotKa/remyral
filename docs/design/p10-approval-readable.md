# p10-approval-readable — readable approval requests

- **Task:** `p10-approval-readable`. **Date:** 2026-10-18.
- **Owner feedback:** "bu çok açıklayıcı görünmüyor. buna komutla alakalı açıklama geliyorsa onu da gösterirsek iyi
  olur" — the approval card ("Sensitive tool call", High, reported as `PowerShell`) showed under "What the agent wants
  to do" a raw, escaped, truncated JSON blob (`PowerShell: {"command":"$b = $env:REMYRAL_BROWSER; if (-not $b) { $b =
  \"C:\\ProgramData\\...\\chrome.exe\" }; … \"--screensho…`), although the runtime had sent a human description
  (Claude Code `description`, e.g. "Run whoami and save output") next to the command.
- **Builds on:** [p4-approvals](p4-approvals.md) (requests, inbox), [p5-live](p5-live.md) (activity items),
  [p6-safe-auto-approve](p6-safe-auto-approve.md) (the shell classifier), [p10-approval-pause](p10-approval-pause.md)
  (decision fingerprint), [p5-notifications](p5-notifications.md).
- **Migration:** 0085 (`approval_requests.details jsonb NULL`; 0084 = p10-publish-bundle, renumber at merge if taken).
- **Protocol:** additive optional field `details` on the `approval_request` agent event (protocol 1.0). No new worker
  feature (see §2.3). **Worker release:** needed for the structured fields; without it the console shows the request as
  before (summary text), with the new master the headline/notification simply fall back.

## 1. What was wrong

Every adapter built the request's `description` as `` `${toolName}: ${JSON.stringify(input)}` `` (or the Codex
`command — reason` text), whitespace-collapsed and cut at 2 KiB. The JSON quoting escaped every `"` and `\`, the cut
fell mid-JSON, and the agent's own one-line explanation was buried inside the blob. The master stored that text as
`summary` (2000 characters) and the console printed it in a `<pre>`.

## 2. Worker / adapters: structured, bounded fields

`@remyral/protocol/approval-details` (pure, zod-free; shared with the console) defines `ApprovalDetails`:

| Field | Source | Bound |
| --- | --- | --- |
| `tool` | runtime tool name (`Bash`, `PowerShell`, `shell`, `apply_patch`, `bash`, `edit`, …) | 128 |
| `description` | the agent's explanation: Claude Code / OpenCode `description`, Codex `reason` | 1 000, one line |
| `command` | `command` / `cmd` / `script`; Codex argv (`bash -lc SCRIPT` → SCRIPT, else quoted join) | 16 KiB, newlines kept |
| `commandTruncated` | the command was longer than 16 KiB | — |
| `shell` | `posix` / `powershell` / `cmd` when the adapter knows it (guessed for display otherwise) | — |
| `cwd` | Codex `cwd`, input `cwd` / `workdir` | 1 024 |
| `workspaceRoot` | the job workspace (for "outside the workspace" readings) | 1 024 |
| `paths` (+ `morePaths`) | `file_path` / `filePath` / `path` / `notebook_path`, Codex patch paths, OpenCode edit patterns | 20 × 1 024 |
| `url` | `url` / `uri` (fetch tools) | 2 048 |

`extractApprovalDetails(tool, input, opts)` order of work — this is the fix for "cut mid-JSON":

1. **Parse first.** An object is read as is; a string starting with `{` is `JSON.parse`d; a cut or invalid JSON text
   yields *no* command (Pi's gate cuts its JSON input at 4 000 characters — such a request keeps only the old summary).
   A plain string of a shell tool is the command.
2. **Per field:** redact the job's exact secret values on the *whole* field (so a cut can never leave half a secret),
   clean (CR/LF → LF, other control characters dropped, bidi overrides / isolates and zero-width characters made
   visible as `⟨U+202E⟩` — Trojan Source), then cut to the field's bound with `…`.

| Runtime | Where | Fields |
| --- | --- | --- |
| Claude Code | `canUseTool` | the tool input (`command` + `description` of Bash / PowerShell, `file_path` of Edit/Write, `url` of WebFetch), shell by tool name, workspace root |
| Codex | `item/commandExecution/requestApproval`, `execCommandApproval`, file-change / patch / permissions approvals | `command` (string or argv), `reason` → description, `cwd`, patch paths (now kept as a list), grant root |
| OpenCode | `permission.asked` | `metadata.command` / `metadata.description` of `bash`, `metadata.filepath` + patterns of edit-like permissions, `metadata.url` |
| Pi | gate dialog (JSON text input) | parsed input; shell by tool name |
| Fake | `approval` step (`input` or `shell`) | as the real adapters |

`description` (the old summary text) is unchanged, so an older master shows exactly what it showed before.

### 2.3 Compatibility, no feature flag

The field is optional and additive: older masters parse events with non-strict Zod objects and drop it; older workers
do not send it. A worker feature is deliberately *not* added: `WorkerFeatureList` refuses unknown features, so a new
feature would make a new worker unacceptable to an older master, and the master needs no permission to read an
optional field (the same choice as `safeCommand`).

## 3. Master: validate, redact again, store, read on the fly

- `effects.ts` passes `event.details` to `ApprovalService.evaluate`. `approvals/details.ts#detailsToStore` validates
  with `ApprovalDetailsSchema`; an invalid object is dropped (the request is still created — a display aid never blocks
  an approval). Every string goes through the **pattern** redactor (`@remyral/observability` default rules: a token
  typed into a command, which the worker cannot know as a job secret) and is cleaned and cut again.
- Stored in `approval_requests.details` (jsonb, ≤ 64 KiB, CHECK in 0085). NULL for gate requests and older workers.
- **Fingerprint** (p10-approval-pause carry-over): `sha256([action, requestedAction, summary, command])` when a command
  is present — the summary may be cut, the command is what a resumed run will re-run. Requests without a command keep
  the old 3-tuple; a pause straddling the upgrade simply asks again (fails safe).
- **Reads** re-validate the stored JSON (`storedDetails`) and derive `headline` and `hints` per request; better readings
  need no data migration. API additions (all additive): `GET /approvals`, `GET /approvals/:id`, decide answers →
  `details`, `hints`, `headline {text, source}`; `GET /jobs/:id` approvals → `headline`; live events of kind
  `approval_request` → `hints`.

## 4. "What this touches" — a deterministic static reading

`approvalHints(details)` (no LLM; pure function in the protocol package) reports neutral facts:

| Row | Read from |
| --- | --- |
| Runs | first word of every command at any depth (after `;` `&&` `||` `|` `&` newlines, `(` `{` `$(`, PowerShell `&` / `.` call), past keywords (`if`, `-not`, …), assignments and wrappers (`sudo`, `env`, `nohup`, `timeout`, `start`); `$b` resolved from an earlier `$b = "…"`; `$(…)` inside double quotes read too |
| Reaches | `http(s)/ws(s)/ftp/ssh/git://` URLs; `user@host` of ssh/scp/rsync/git; `git push/pull/fetch/clone` without a URL |
| Writes | `>` / `>>` targets (not `/dev/null`, `$null`, `NUL`, `2>&1`), `tee`/`touch`/`mkdir`, last operand of `cp`/`mv`/…, `New-Item`/`Set-Content`/`Out-File`/`Copy-Item -Destination`/`Invoke-WebRequest -OutFile`/…, `curl -o`, `wget -O`, `git push --force` |
| Deletes | `rm`/`rmdir`/`del`/`rd`/`Remove-Item`/…, `git clean`, `git reset --hard` |
| Installs | `npm/pnpm/yarn/bun add|install`, `pip`/`uv pip`/`python -m pip install`, `cargo/go/gem/brew/apt/dnf/… install`, `winget/choco/scoop install`, `Install-Module`, `npx`/`uvx` |
| Reads env vars | PowerShell `$env:X`, POSIX `$X`/`${X}` (upper case), cmd `%X%` |
| Outside the workspace | absolute / home / `..` paths not under the workspace root (or cwd); absolute paths when neither is known |
| Rights | `sudo`, `doas`, `runas`, `Start-Process -Verb RunAs` |
| Safe commands | the **same strict classifier** as p6-safe-auto-approve (`classifyCommand`) proves the command read-only or workspace-only (reuse; the strict parser refuses `$`, quotes and most real commands, so it cannot be the general reader) |

The tolerant lexer behind it never throws and is never used for a decision. Each list is capped at 10 items × 160
characters. The console labels it "A static reading of the command text, not a guarantee". The owner's example reads:
Runs `New-Item, Out-Null, chrome.exe, Resolve-Path` · Reaches `https://8ae687fa.demo-site.pages.dev` ·
Writes `out/verification` · Reads env vars `REMYRAL_BROWSER` · Outside the workspace `C:\ProgramData\…\chrome.exe`.

## 5. Console

`screens/approvals/ApprovalCall.tsx`:

1. **Agent says (its own words, unverified): "…"** — the description, first and labelled as the agent's claim.
2. **Command** — monospace `<pre>` with `white-space: pre-wrap` and `overflow-wrap: anywhere`, the command exactly as it
   runs (real newlines, no JSON escaping); collapsed (clipped visually, the text stays selectable) beyond 12 lines or
   ~1 200 characters with "Show all (N lines)"; **Copy** copies the original; **Formatted** (`aria-pressed`, offered
   when there is more than one top-level piece) shows `formatCommand` — one piece per line at top-level `;` `&&` `||`
   `|` (continuations indented); quotes, braces and subexpressions are never split. "Cut at 16 KiB" note when
   truncated.
3. **Fields** — working folder, files (+ "and N more"), URL.
4. **What this touches** — the hints (§4).
5. **Raw text from the machine** — the old summary in a closed `<details>`.

Without `details` (older worker or master) the card shows the summary block exactly as before. The risk badge,
"Reported as", effect, who can decide, expiry, decisions and the decision form are unchanged.

Same rendering elsewhere:

| Place | Shows |
| --- | --- |
| Approvals inbox rows | "Agent says: "…"" (else the command's first piece / the summary) and a one-line command preview |
| Job page → approvals | the headline |
| Job activity "Approval requested" | Agent says + command block + fields + hints (from `payload.details` and the event's `hints`); the plain description when absent |
| Home "Needs you" | the headline |
| Notification (`approval.requested`, `approval.stale`; bell, push, e-mail, webhook) | `The agent says (unverified): "…"` or `Command: Bash: …`, ≤ 160 characters, plain text; never the legacy summary |
| Chat watch note | the same line, Markdown-escaped (`mdText`), tr/en |

## 6. Security review

- **Untrusted text.** description / command / paths / url come from the runtime and the agent. Rendered only as React
  text (no `dangerouslySetInnerHTML`, no Markdown), labelled "its own words, unverified"; chat notes escape Markdown;
  notifications are plain text (SMTP `text/plain`, Web Push payload text). Tests render `<img onerror>` / `<script>`
  payloads and assert no element is created.
- **Display spoofing.** Bidi overrides and zero-width characters are made visible (worker and master), so a command
  cannot display differently from what runs; control characters are dropped. The "Formatted" view is for reading only;
  Copy and the default view show the exact command.
- **Secrets.** Worker: exact job secret values on whole fields before cutting. Master: pattern redaction of every field
  before storing and the live redactor on the event payload (store + read). A test puts a GitHub token into the
  description/command and asserts it is neither stored nor notified.
- **Bounds.** Per field (§2) and in the schema; the stored JSON ≤ 64 KiB (CHECK); the event stays far below the 512 KiB
  frame limit; hints are capped; the lexer is linear and capped at 4 000 tokens and 32 subexpressions.
- **No authority.** Neither `details` nor the hints decide anything: policy, risk, approver role and the safe-command
  auto-approval are unchanged (the auto-approval still classifies only the `safeCommand` claim). The hints say what a
  static reading found and say so; an approver must still read the command.
- **Notification content.** Up to now notifications carried the catalog action only, because the summary was an opaque
  runtime blob. They now carry one bounded, labelled, redacted line — the owner asked for it; it reaches only the people
  who may decide the request (unchanged recipients).
- **Fingerprint.** Binding the full command makes the pause carry-over stricter (a different command with the same
  2 000-character summary prefix no longer matches).

## 7. Tests

- `packages/protocol/test/approval-details.test.ts` — extraction (Claude Code Bash/PowerShell with description, Pi JSON
  text, cut JSON, non-JSON, Codex argv/reason/cwd, file tools, url, missing description, huge command, redaction before
  cutting, invisible characters), split/format, headline, hints (owner's PowerShell example, POSIX, PowerShell
  cmdlets, safe-commands reuse, outside paths, bounds), schema.
- `packages/agent-adapters/test/approval-details.test.ts` + assertions in the Claude Code, Codex, OpenCode and Pi
  adapter tests (details on the real event paths, secret redaction).
- `apps/master/test/unit/approval-details.test.ts` — store validation and pattern redaction, old/new rows, live event
  hints, notification line, fingerprint.
- `apps/master/test/integration/approvals.test.ts` (new + old shape through the API, job detail headline),
  `notifications.test.ts` (labelled description, token not leaked), `chat-watches.test.ts` (Markdown-escaped note).
- `apps/web/test/approval-readable.test.tsx` (inbox row, detail card, collapse, copy, formatted toggle, hints, old
  shape, parsers) and `live.test.tsx` (activity item).

## 8. Rollout and rollback

Master first (migration 0085 is additive; old workers keep working), then a worker release for the structured fields.
Rollback: the column can stay (NULL-able, ignored by the old code); a worker newer than the master is fine (the field is
stripped). Unverified live: a real Claude Code PowerShell request on the Windows fleet machine after the worker release
(needs the owner to look at the card).
