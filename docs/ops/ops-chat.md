# Runbook: ops chat (assistant on a worker)

- **Applies to:** master with migration 0034; the assistant worker advertising `assistant-v1` (this release and
  later); talking to running jobs needs workers advertising `job-message-v1`
- **Audience:** owners / admins (setup, kill switch, limits); everyone (using Chat)
- **Design:** [docs/design/p5-ops-chat.md](../design/p5-ops-chat.md), [ADR-0018](../adr/0018-ops-chat-assistant-on-worker.md),
  [ADR-0025](../adr/0025-assistant-engines-and-sandbox.md) (Codex / OpenCode / Pi engines, assistant sandbox;
  master with migration 0048, workers of this release)

The console opens on **Chat**: ChatGPT-style conversations about machines, projects, jobs, approvals and usage.
The assistant can look things up and **draft** work (jobs, workflow runs, worker configuration changes, approval
decisions, messages to running jobs); nothing happens until you confirm a draft card with an authenticator code.
Conversations are private to each user.

## 1. Set it up (admin)

1. Pick the machine that runs the assistant (any worker; it needs no repository). On it, in Machines → <machine> →
   Configuration → Runtimes & models: enable the runtime you want the assistant to use — **Claude Code**,
   **Codex**, **OpenCode** or **Pi** — and set its auth exactly as for jobs:
   - **local login** (your subscription — Machines → <machine> → Runtimes → Log in), or
   - a **vault credential** (Settings → Credentials; a provider API key sealed to that worker).
   OpenCode and Pi use the worker's model/provider settings for that runtime (Configuration → Runtimes & models),
   like their jobs.
2. Settings → **Chat** (needs a fresh authenticator code to save):
   - **Enabled** — the kill switch;
   - **Worker** — the machine from step 1;
   - **Runtime** — Claude Code, Codex, OpenCode or Pi; each shows whether it is ready on that worker (and why
     not). Every engine gets the same platform tools and the same draft-and-confirm rules; a worker built before
     this release offers Claude Code only;
   - **Model profile** — a catalog profile valid for that runtime, or "runtime default";
   - **Limits** — turns per user per 10 minutes (default 30), tokens per user per day (default 2 M), tokens of
     everyone per day, reported dollars per month (API-key runs only), tool calls per answer (default 24).
3. The status line turns green when the worker is online, the runtime is ready and chat is enabled. Users see the
   same status (and why not) above the message box.

The assistant on the worker has no shell, file, web or other tool of its own; its only tools are the platform's
read tools and draft tools, served by the master **with the permissions of the user who asked**.

**Assistant sandbox** (worker local config `assistant.sandbox`, default `auto`): the assistant runtime may write
only its own session directory (and, with a local login, its own login store), cannot read the worker's data
directory, any workspace or repository, SSH/cloud/browser credentials or the other runtimes' logins, and reaches
only the model API hosts of `sandbox.egressAllow` plus what its runtime needs — Claude Code: `api.anthropic.com`, and
with a subscription login `platform.claude.com` (OAuth token refresh); Codex: `api.openai.com`, and with a ChatGPT
login `chatgpt.com` and `auth.openai.com`. OpenCode / Pi providers' hosts go into `sandbox.egressAllow`. Enforcement: macOS Seatbelt (files and network), Linux
bubblewrap when user namespaces work (files; network only via the proxy environment), Windows Job Object
(limits only; without a verified job runner — Sandbox & policy → Prepare — only the proxy environment, as before). The worker reports what is enforced (Machines → <machine> → Overview, `assistant.sandbox`).
`required` refuses chat on machines without file confinement; `off` is for diagnosis only.

## 2. Using Chat

- New chat, then ask, e.g. "which workers are offline?", "what failed in alpha today and why?", "draft a job in
  alpha to fix the flaky login test with Codex", "suggest approving the pending merge in beta".
- Answers stream in; **Stop** ends the current answer. Conversations can be searched, renamed, archived and
  deleted (left list; on phones the list comes first).
- **Draft cards** show exactly what would run. **Confirm** asks for your authenticator code (when the last one is
  older than 10 minutes), re-checks that *you* may do it and runs it through the normal API (approval rules,
  quotas and policies still apply). **Dismiss** discards it. A card expires after 24 hours.
- **Untrusted content holds direct actions** (oss-sec3, ADR-0056 amendment): once a turn has read content the person
  did not write — job logs and outputs, repository files and diffs, web responses (`http_request_result`), machine
  output, attachments and uploads, content mentions — a draft that would run at once stays a card marked "not run
  directly" (`chat.direct_action` denied, reason `untrusted_content`, with the tool names that tainted the turn). The
  turn's row keeps `tainted_at` / `taint_sources`; system-written continuation turns of the same conversation (plan,
  watch follow-up, late tool result, goal) inherit it. On confirm the person may tick **Remember this**: the same
  action (draft kind + operation) on the same target (project; host, method and credential of an HTTP request; machine
  of a service; deploy environment; workflow) then runs without a card (`chat_untrusted_allows`, audited
  `chat.untrusted_allow.create` / `.revoke`, listed and forgotten in Settings → Chat → Remembered confirmations, API
  `GET /chat/untrusted-allows`, `DELETE /chat/untrusted-allows/:id`). Never remembered: machine administration and
  machine configuration, approval decisions, settings / security policy / administration, credentials, memory, skill /
  MCP / install-script installs, outgoing webhooks, the support report, runtime updates, new projects, deletions and
  card-only changes. Only the confirm route (session + CSRF) writes the memory; no assistant tool can.
  `list_approvals` taints only when it lists something other than the platform's own merge decisions (oss-c3): a
  `git.merge` gate opened by the git flow reaches the model through platform-generated fields only (attempt branch
  `rac/<job>/<attempt uuid>`, target branch, head sha, counts, check / merge states, PR number, review-flag kinds — no
  file paths, PR URL, titles or commit messages), so "PR'ları onayla" runs at once; a runtime tool approval, a discard
  decision or a field outside its pattern in the same listing taints the whole call.
- Research and general questions that need no repository become **workspace** job drafts (e.g. in `genel`).
- **Manage jobs** (p10-chat-job-actions): "cancel job abc123", "cancel all queued background jobs", "run the last
  failed job again", "move it to Arka plan", "run it now". The assistant resolves the jobs with `find_jobs` (asks when
  unclear) and drafts a **job action card** (`draft_job_action`, ≤ 50 jobs, each can be unchecked). Confirming
  re-checks every job for you and runs the Jobs screen's own action; results are per job (a job that finished
  meanwhile is reported as skipped). Permissions as on the Jobs screen (run now: admin). A started job's card has
  **Cancel / Run again / Open** buttons that draft the same card. Audit: `chat.job_action` per job, source `chat`.
- **Talk to a running job:** on the job page, "Message the agent" (or a `draft_job_message` card from chat)
  sends a follow-up to the running agent when its runtime accepts one; the message and the agent's reaction appear
  in the job's events.

## 3. Kill switch and budgets

- Settings → Chat → **Enabled off** stops running answers at once and refuses new messages for everyone
  (`chat_disabled`). Turn it back on the same way.
- On a single machine: in the root-owned local config `{"assistant": {"disabled": true}}` (needs one shell visit);
  the panel then shows "switched off locally". `assistant.maxSessions` (default 8) bounds conversations held in
  memory on that machine.
- Usage → **Chat** shows your tokens/turns today and this month (admins: everyone's) against the limits. Over a
  limit, sending answers `429 rate_limited` / `budget_exceeded`; budgets reset at 00:00 UTC (dollars: monthly).

## 4. Troubleshooting

| Shown | Meaning / action |
| --- | --- |
| "No assistant worker is configured" | Settings → Chat → choose a worker |
| "… is offline; chat is unavailable" | the assistant worker is not connected — check Machines, or pick another worker |
| "… must be updated to run the chat assistant" | worker build predates `assistant-v1` — update it (Settings → Worker releases) |
| "switched off locally" | `assistant.disabled` in the machine's local config |
| "<Runtime> is not ready …: <reason>" | runtime not enabled / no login or credential / not the pinned version — Machines → <machine> → Configuration or Runtimes |
| "… not reported by this worker" (Settings → Chat) | the worker predates the Codex / OpenCode / Pi engines — update it, or choose Claude Code |
| "the assistant sandbox is required but unavailable here" | `assistant.sandbox: required` on a machine without Seatbelt / usable bubblewrap — install bubblewrap, use `auto`, or another worker |
| answers fail with a network / provider error after the update | the provider host is not in `sandbox.egressAllow` of that worker (the assistant now reaches only those hosts); the worker log shows `assistant egress refused` with the host |
| "The assistant runtime has no login or credential" | as above; log in or share a vault credential with that worker |
| "refused the request: not signed by a key it trusts" | the worker pins `masterLeaseKeys` that do not match the master |
| "refused the request as expired" | worker clock off by more than ~2 minutes — fix NTP |
| "did not answer in time" / "disconnected while answering" | the turn timed out (6 min) or the connection dropped; ask again |
| `step_up_required` on Confirm | enter a current authenticator code; the card stays open |
| `draft_stale` | the worker configuration changed since the draft; ask for a new draft |
| `job_message_unavailable` | the job is not running, its worker needs an update, or the runtime takes no follow-ups |

## 5. Audit and data

- Audit: `chat.tool` (every tool call: user, tool, outcome, draft id — no inputs), `chat.draft.confirm`,
  `chat.settings.update`, `job.message` (length and hash of the text).
- Stored: threads and messages (assistant answers redacted), draft payloads and results, per-turn usage (kept for
  the budget line even after a thread is deleted). Not stored: streamed partial text, model credentials, tool
  results (only a one-line summary per call).
- Retention: conversations stay until their owner deletes them. To remove all chat content of a user, delete
  their threads (or the account).
