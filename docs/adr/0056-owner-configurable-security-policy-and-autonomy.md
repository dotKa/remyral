# ADR-0056: Owner-configurable security policy — per-event authenticator codes, a long step-up window, full agent autonomy by default, an assistant that acts directly

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** owner (direction 2026-10-21), agent
- **Related:** p15-autonomy; docs/design/p15-autonomy.md; AGENTS.md rule 10; ADR-0009 §10 (step-up) and its
  amendment p5-stepup-window; ADR-0010 (approval policy, authority order); ADR-0018 (ops chat: drafts only);
  ADR-0019 / ADR-0020 (unconfined, "never ask"); ADR-0021 (machine administration); ADR-0049, ADR-0054, ADR-0055;
  migration 0118

## Context

The platform is a closed system used by a few trusted people. The owner wants to use it like Claude Code in auto mode
on their own PC: today it asks for an authenticator code for ~160 routes (10-minute window, a fresh code every time
for account security), agents need explicit opt-ins before they may run on the host or without prompts, merge /
deploy / force push / deletes always wait for a human, and the assistant may only draft cards and must send the user
to screens. Owner direction (2026-10-21): by default agents and everything else have full authority; permissions and
settings are changed by talking to the chat; "approve it, start it" and "send it to the job's agent" happen at once;
the authenticator window is longer and managed in the panel; codes are asked only for the events the owner picks;
security measures stay configurable, strong and detailed.

AGENTS.md rule 10 forbids automatic merge, deployment, destructive operations or secret disclosure "without a clearly
defined human approval policy". Until now that policy was a code constant (the platform floor of ADR-0010). This ADR
moves it to an owner-edited, versioned, audited document.

## Decision

1. **One security policy document** (`security_policy`, one row; every change also in `security_policy_versions` and
   audited `security.policy.update` with the changed paths, the channel `console` / `chat` and the versions). It is a
   **preset plus overrides**: `serbest` (default; fresh installs: `dengeli`, see the 2026-11-24 amendment), `dengeli`, `siki`. A value the document does not name takes its
   preset's default, so an event added later is protected or not by preset, never by accident. Admin+ reads and
   changes it (`security.read` / `security.write`). The stored document is the **human approval policy of AGENTS.md
   rule 10**.
2. **Step-up window from the policy:** 5 minutes to 30 days (default 12 hours; `null` = the server's
   `AUTH_STEP_UP_MINUTES`), "remember this device" (one code for the whole remembered / trusted-device session;
   `null` = `AUTH_STEP_UP_TRUSTED`) and an optional always-fresh cap for the account-security routes (`null` = the
   window). The session's own lifetime stays the upper bound.
3. **Per-event codes.** Every step-up–protected action belongs to exactly one **event** of a catalog
   (apps/master/src/security-policy/events.ts, 32 events in 12 categories) — by route override or by its
   authorization action; every action is either mapped or listed as never asking (unit test), every route with a
   step-up hook maps to an event (route-coverage test). The authenticator resolves the request's event: **off** = the
   request is waived (it passes every step-up check behind the route, services included); **on** = the policy's
   window applies. A route with a step-up check and no event is never waived (fail closed). The **safe core** is on in
   every preset by default: changing the security policy itself, disabling / resetting 2FA, user and role changes,
   revealing secrets in plain text. The owner may switch even those off (audited, `coreOff` in the entry).
4. **Agent autonomy defaults** (owner-switchable): new projects allow host execution and "never ask" jobs; a job
   without an approval policy gets `allow-all` where its project allows it and its source is trusted (the job store's
   own gates unchanged: untrusted sources, unconfined, machine administration); the master approvals of `allow-all`
   jobs that the policy marks "passes by policy" resolve to `allow` (new source `security_policy` in the authority
   order, between project and job). **Risk-based rules** keep chosen actions with a human ("Dengeli": deploy,
   force push, deletes outside the workspace, secret reads). `machine.admin` is never auto-approved by this policy
   (ADR-0021's two switches stay). "Apply to existing projects" sets the two project switches on every project except
   Machines (never unconfined), audited.
5. **The assistant acts directly.** Every draft tool takes `execute`; with `execute: true` (the user's own explicit
   instruction) the master confirms the card at once for the sender through the unchanged confirmation path
   (ownership, payload hash, the target action for the sender's role, the card's event, the normal service, its
   audit) and audits `chat.direct_action` (actor = the user, `via: chat`). A card stays when the request is
   ambiguous (no execute), when the policy keeps cards (`autonomy.chatDirect` off) or when the card's event needs a
   code the turn's session does not have (the card asks for it inline). New tools `get_settings` / `change_settings`
   (security policy, apply autonomy, project execution, project approval rules, a machine's runtime policy) call the
   same services as their screens. The system prompt forbids "go to X and click Y" for anything a tool does.
6. **Time limits and approval deadlines from the cards** (owner addendum 2026-10-21): a job's time limit is
   editable on its draft card and changeable while it waits or runs (signed SET_TIME_LIMIT to `time-limit-v1`
   workers, no restart) up to the policy's `autonomy.maxJobMinutes`; a pending approval's deadline is extendable by
   its approvers up to 7 days after the request. Both audited.
7. **Migration default:** migration 0118 seeds the policy row with **Serbest with the safe core on** (for new
   installations superseded by the 2026-11-24 amendment below). "Sıkı" is
   exactly the behaviour before this ADR (every event on, server window, 10-minute always-fresh cap, no
   auto-approval, cards only).

## Alternatives considered

- **Keep the platform floor in code, add more opt-ins.** Rejected: that is what the owner called "too many approvals,
  too many limits"; every new opt-in is another screen.
- **One global "trusted mode" switch.** Rejected: the owner asked for detailed, strong, configurable measures; a single
  switch cannot keep the safe core while relaxing the rest.
- **Waive per route list in the database.** Rejected: 160 routes are not a usable settings screen and a new route
  would silently be unprotected or protected depending on the list; events with a fail-closed fallback are reviewable.
- **Let the model decide when to act directly without a flag.** Rejected: `execute` makes the decision explicit in
  the tool call, audited, and refusable by policy.

## Consequences

- Fewer prompts by default; the owner can return to the previous behaviour with one preset ("Sıkı", or
  `UPDATE security_policy SET document = '{"preset":"siki"}' …`, docs/design/p15-autonomy.md §9).
- A stolen session in Serbest can do everything outside the safe core without a code for up to the session's life —
  accepted for a closed system; the security review lists the mitigations (§8 of the design note).
- Integration suites start on "Sıkı" (harness default) so their assertions keep testing the strict paths; the new
  suites test each preset.
- A worker release is needed for the assistant's new system prompt and tool schemas; older workers keep drafting cards.

## Verification

- `test/unit/security-policy.test.ts`: catalog completeness, presets, documents, windows, autonomy in `resolveRule`,
  job defaults.
- `test/integration/security-policy-enforcement.test.ts`: each preset's enforcement, the window, new-project
  autonomy, RBAC and audit of the API, apply-to-existing, the migration default.
- `test/integration/chat-direct.test.ts`: direct settings change, approval, job message, inline-code card, RBAC
  refusals, chatDirect off, audit entries.
- `test/integration/route-coverage.test.ts`: every step-up route maps to an event.

## Amendment 2026-10-22: "Otomatik mod" (p15-auto-mode)

Owner decision (2026-10-22): "Claude CLI'daki auto mode gibi davranabilmeli sistem … onaylar manasız." The policy gets
`autonomy.autoMode` (Serbest on, Dengeli / Sıkı off) and `autonomy.autoRetryMax` (0–5). With auto mode on, every
master approval the policy can grant is granted for trusted, non–machine-admin jobs that did not ask for more prompts —
in-run tool approvals, merge decisions, deploys (production too), MCP tools — audited `approvedVia: security_policy`
and shown on the job timeline. A hard floor always asks a person: `machine.admin`, `git.force_push`,
`fs.delete_outside_workspace`, DNS deletes; the safe core stays a step-up event. Transient failures are retried
automatically (1, 5, 20 min; another machine first when the cause is the machine's), missing base refs and diverged
attempts are healed by the platform, and a permanent failure opens one auto-fix job. Migration 0126 switches auto mode
on for the existing policy and removes the prod overrides `deploy` / `tool.mcp` / `runtime.dangerous_tool` = false
(a new version via `migration`, audited by the master as a system change). The stored document remains the human
approval policy of AGENTS.md rule 10. Details: docs/design/p15-auto-mode.md.

## Amendment 2026-10-23: destructive administration from the chat (p16-assistant-admin)

The assistant can now do the console's administration (users, memberships, machines, the release rollout, own
notifications, integration tests). Those changes follow this policy like every chat card: `autonomy.chatDirect` and
the event of the change's own route decide whether it runs at once or waits on a card (with a code). Two refinements:
the policy gets `autonomy.chatDestructive` (off in every preset, also with auto mode) — only when it is on does a
destructive change (disabling a user, revoking a machine) run directly on the user's explicit command; and a change
whose result is a one-time secret (inviting a user: the temporary password) is always a card, independent of the
policy. Details: docs/design/p16-assistant-admin.md.

## Amendment 2026-10-23: unverified runtime updates (p16-runtime-updates)

The policy gets a `fleet` section with `fleet.unverifiedRuntimeUpdates` — **on in Serbest, Dengeli and Sıkı** (owner
decision 2026-10-23, "varsayılan açık olsun"). On: an administrator may install a runtime version newer than the
worker release's pin (labelled unverified, ADR-0012 amendment), jobs run on such a version, and the master verifies
newer versions automatically on a canary machine. Off: pinned versions only (a queued unverified target fails with
`unverified_updates_disabled`, placement stops using unverified installs, no verification runs); rolling back to the
pin is always allowed. A change is audited like every policy change (`security.policy.update`, path
`fleet.unverifiedRuntimeUpdates`, console or chat). The install itself keeps its own gates: admin, the
`machines.ops` code rule, rate limits, canary-first. Details: docs/design/p16-runtime-updates.md.

## Amendment 2026-10-23: operations safety sections (p16-ops-safety)

The policy gets three flat sections, the same in Serbest, Dengeli and Sıkı:

- `limits` — requests per minute per person (`userReadPerMinute` 600, `userWritePerMinute` 120) and per API token
  (`tokenReadPerMinute` 600, `tokenWritePerMinute` 120), chat messages per person (`chatPerMinute` 10, `chatPerHour`
  120). The defaults are the budgets enforced before; the per-IP and credential-attempt limits stay fixed.
- `costBrake` — `mode` **warn** (owner direction: conservative but non-blocking), `dailyUsd` 50, `monthlyUsd` 500,
  `warnPercent` 80. Only the owner's explicit `block` makes an exceeded ceiling hold new non-urgent jobs and refuse new
  assistant turns; owners lift it for 1–72 hours (audited).
- `rollout` — the worker rollout circuit breaker, **on** (`failurePercent` 30, `minFailures` 1, `watchMinutes` 30,
  `jobFailureDelta` 30, `minJobs` 5). It can only hold a rollout; resuming or rolling back is an administrator's action
  with the `releases.publish` code rule.

Changes are audited like every policy change (`security.policy.update` with the changed paths, console or chat) and keep
the safe-core code rule of the `security.policy` event. Details: docs/design/p16-ops-safety.md.

## Amendment 2026-10-27: settings, key rotation and account recovery from the panel (p17-panel-settings)

New step-up events (docs/design/p17-panel-settings.md):

- `settings.panel` — **safe core** (on in every preset): changing the master-stored settings that used to be
  environment variables (webhook / push allowlists and keys, the search provider, trusted proxies and the client-IP
  header, session lifetimes, worker key approval, logs, memory, workflow engine, Coolify protection) and the panel's key
  rotation steps (actions `settings.panel.write`, `keys.rotate`; the rotation route is always-fresh).
- `users.recover` — **safe core**, always-fresh routes: resetting another user's authenticator or password and unlocking
  an account (action `users.recover`: owners for anyone but themselves, admins for operators and viewers). Resetting
  another owner while a third active owner exists waits for that owner's approval (also always-fresh).
- `maintenance.run` — balanced: starting a maintenance job (storage move, search backfill, memory auto-learning).

Decision: the session and machine-key settings (`auth.rememberIdleDays`, `auth.rememberAbsoluteDays`,
`auth.trustedDeviceDays`, `workers.rotationApproval`) are **not** part of the policy document: they have no preset
values (their default is the environment), so they are stored in the versioned panel settings (`panel_settings`,
history per save) and edited on Ayarlar → Sunucu ayarları → Oturumlar under the safe-core `settings.panel` event — a
preset switch must not silently change them. The policy's presets are unchanged.

## Amendment 2026-11-24: a fresh install starts on Dengeli (oss-sec3)

Owner decision (2026-11-24), ahead of the open-source release: a **new** installation starts on **Dengeli**, not
Serbest. Serbest's trade-off (no code outside the safe core — enabling machine administration, removing the sandbox,
approving machines, production deploys, credentials — and one code per remembered session) fits a single-person
closed system, not a stranger's first install. Migration 0221 writes `{"preset":"dengeli"}` as a new `via = 'migration'`
version only when no user exists yet, every stored version was written by a migration and the row is still the seeded
Serbest; any other installation keeps its document and version unchanged (a migration never changes a configured
preset).
`DEFAULT_DOCUMENT` (the fallback for a missing row, which cannot occur after 0118; an unreadable row is Sıkı) is Dengeli.
The setup wizard, Ayarlar → Güvenlik and the guides state what each preset waives. §7 above ("Migration default") is
history: it describes the seed of migration 0118.

## Amendment 2026-11-24: untrusted content holds direct actions; the person's answer is remembered (oss-sec3)

Owner decision (2026-11-24): "sorabilir; sonrasında hafızaya göre devam eder". §5's direct actions were decided from
the tool, the sender and the plan state only, so an instruction hidden in a job log, a repository file or a web response
could turn into an action that ran at once — under Dengeli as well as Serbest. Now:

- **Taint.** A turn is tainted once a tool returned content the person did not write (apps/master/src/chat/untrusted.ts:
  every read tool except the platform-metadata list, fail closed, plus create_watch / notify_when whose dry test returns
  a machine's check output), or its message carries attachments, uploads or content mentions (job, output, folder,
  code, another conversation). The turn row keeps `tainted_at` and `taint_sources` (migration 0222). A system-written
  continuation turn (plan, watch follow-up, late tool result, goal) inherits the taint of any earlier turn of the same
  conversation, and a watch follow-up that quotes what its check found or a job's attention words is tainted itself. A
  person's own new message starts clean: the history the model gets holds only one-line tool summaries, never results.
  Addendum 2026-11-25 (oss-c3, owner decision): a `list_approvals` call whose every item is a merge decision the git
  flow opened (`git.merge` gate by `system:gitflow`) does not taint — such an item reaches the model only through
  platform-generated, pattern-checked fields (attempt branch `rac/<job>/<attempt uuid>`, target branch, head sha,
  counts, check / merge states, PR number, review-flag kinds; never file paths, the PR URL, titles or commit messages);
  any other item (runtime tool approvals, the discard decision) or a field outside its pattern taints the whole call.
- **Hold.** In a tainted turn a draft that would have run at once (any trigger: default, execute, plan, watch) stays
  the normal confirmation card, marked `held = 'untrusted_content'` and audited `chat.direct_action` denied with that
  reason. Read-only tools keep working; a watch created in such a turn stores its `then` step as `ask` and its next step
  carries no consent of the person.
- **Memory.** Confirming a held card may carry `remember: true`: the action (draft kind + operation) on the target
  (project; host, method and credential of an HTTP request; machine of a service; deploy environment; workflow) is
  stored per user in `chat_untrusted_allows` (audited) and later held drafts with the same key run (audited with the
  allow id); step-up rules still apply. Only the confirm route (session + CSRF) writes it; no assistant tool can. Listed
  and forgotten in Ayarlar → Sohbet → Hatırlanan onaylar. Never remembered — always asked in a tainted turn: machine
  administration and configuration, approval decisions, settings / security policy / administration, credentials,
  memory, skill / MCP / install-script installs, outgoing webhooks, the support report, runtime updates, new projects,
  deletions, card-only changes and cards without a single target.

Left for the owner: `approvals.decide` and a credential-less `http_request` still map to events that ask for no code in
Dengeli (only Sıkı asks); a tainted turn now always asks for an approval decision and asks for such a request unless it
was remembered for that host.
