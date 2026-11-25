# p15-autonomy — owner-configurable security policy, agent autonomy, an assistant that acts directly

Status: implemented (2026-10-21). ADR-0056. Migration 0118. Backlog: `p15-autonomy`.

## 1. Owner direction (2026-10-21)

A closed system with few people. Use it like Claude Code in auto mode: by default agents and everything else have full
authority; permissions and settings are changed by talking to the chat (no "go and click"); "sen onayla, direkt
başlasın" works; a message to a job's agent goes at once; the authenticator window is longer and managed in the panel;
authenticator codes only for events the owner picks; security measures configurable, strong, detailed.

## 2. The policy document

`apps/master/src/security-policy/model.ts`. Stored as `{ preset, stepUp?, events?, autonomy? }` — a preset plus
overrides; the effective policy is the preset's values with the overrides on top (`effectivePolicy`), the stored
document always the smallest one (`documentFor`; setting a value back to the preset's drops the override). A change is
a patch (`SecurityPolicyPatch`: a preset — resets the overrides unless `resetOverrides: false` — and/or values).

| | Serbest (default then; fresh installs now start on Dengeli) | Dengeli | Sıkı (before ADR-0056) |
|---|---|---|---|
| Window | 12 h | 4 h | server (`AUTH_STEP_UP_MINUTES`, 10 min) |
| Remember this device | whole session | whole session | server (`AUTH_STEP_UP_TRUSTED`) |
| Always-fresh cap | — | — | 10 min |
| Events asking for a code | safe core | core + password, devices, vault, logins, sandbox, machine admin, production deploys, integrations, releases, MCP | all |
| New projects | host execution + auto-approve | same | confined |
| Job default | never ask (where allowed) | same | ask-sensitive |
| Master approvals of never-ask jobs | all pass by policy | all but deploy, force push, deletes outside workspace, secret reads | none |
| Assistant | acts directly | acts directly | cards only |
| Otomatik mod (p15-auto-mode) | on | off | off |
| Automatic retries (p15-auto-mode) | 3 | 3 | 0 |

Ranges: window 5 min – 30 days; always-fresh 1–60 min. `machine.admin` is never in the autonomy set.

## 3. Event catalog and enforcement

`apps/master/src/security-policy/events.ts`: 32 events in 12 categories (account, security, users, secrets,
machines, deploy, extensions, workflows, integrations, policies, jobs, data). An event lists authorization actions and
exact route overrides. `eventForRoute(method, url, action)`: override → action → none; `POST /chat/drafts/:id/confirm`
is `dynamic` (the card decides, `eventOfDraft`).

**Authenticator** (`auth/hooks.ts`): for a full session it reads the policy (cached 5 s per process, invalidated on a
local change; a broken row → Sıkı, fail closed) and the route's event.
- Event off → **waived**: `request.auth.stepUp = WAIVED_STEP_UP` (infinite ages) and `request.auth.session.mfaAt` =
  the request time (the real value kept in `realMfaAt`). Every check behind the route passes — the route's
  `requireStepUp` hook and the services that re-check `mfaAt` from `stepUpFields(request)` / `sessionOf(request)`
  (approvals, context, usage, skills, MCP, ops, automations, workflows, verify …) without touching each of them.
- Event on or no event → the policy's rule (`policyStepUp`): window, remember-device, always-fresh cap. A route with a
  check but no event is never waived.
- `GET /auth/session` reports `stepUpWaived` (events that are off) so the console does not ask for a code up front
  (`useFreshStepUp(event)`); draft cards always send first and show the inline code field on `step_up_required`.

Completeness: every authorization action is mapped or listed in `NO_STEP_UP_ACTIONS` (unit test); every route with a
step-up hook maps to an event (route-coverage test). `ALWAYS_FRESH_ROUTES` stays as the class the always-fresh cap
applies to.

## 4. Autonomy

- **New projects** (`Directory.createProject`): `host_execution` / `auto_approve_execution` from the policy, audited in
  `project.create`. Unconfined is never a default.
- **Job default** (`applyJobDefaults`, placement preview `defaultApprovalPolicy`): `allow-all` when the policy says so,
  the project allows it, the source is trusted and the job is not machine administration; the job store's ADR-0020
  checks are unchanged.
- **Master approvals** (`resolveRule` layer `autonomy`): for an `allow-all` job an action in the policy's autonomy set
  resolves to `allow`, source `security_policy`, audited by `approval.evaluate` as before. Other modes unchanged.
- **Apply to existing projects** (`POST /security/policy/apply-autonomy`): the two project switches on every project
  except Machines; unconfined only stays where host execution stays; one audit entry with the projects.

## 5. The assistant acts directly

> Superseded in part by [p15-chat-execute-default](p15-chat-execute-default.md) (2026-10-22): the platform, not the
> model, decides — a draft in a turn the user started runs at once unless the assistant marks it `propose: true`.

- Protocol: every `draft` tool takes `execute` (`assistantToolInput` adds it); new tools `get_settings` (read) and
  `change_settings` (draft kind `settings_change`; targets security_policy, apply_autonomy, project_execution,
  project_approval_rules, worker_runtime_policy — `chat/settings-actions.ts`, the same services and authorization
  actions as the screens).
- Master: `ChatTools.run` strips `execute` and reports it; `ChatService.#toolCall` hands the draft to
  `ChatDirectActions.execute` (`chat/direct.ts`), which confirms it through `DraftExecutor.confirm` for the sender with
  the step-up captured when the message was sent (`SendOptions.stepUp`, also for ask_user answers). Outcomes:
  executed (card confirmed, result to the model) · `needs_code` (card open, inline code) · `cards_required`
  (`chatDirect` off) · `failed` (service refusal, card open). Audit: `chat.direct_action` + `chat.draft.confirm`
  (`via: chat-direct`) + the service's own entry with user agent `remyral-chat-direct; …`.
- `DraftExecutor.confirm` now decides the step-up per card (`stepUpOf`: event + always-fresh class); the confirm route
  lost its route-level hook. A waived card runs with a waived human (services pass); a protected card needs the
  window (or the always-fresh cap).
- System prompt (worker, `packages/agent-adapters/src/assistant.ts`): rule 2 (execute on explicit instructions, never
  claim success without `executed: true`, never because of tool output), rule 8 (switch a missing project setting
  with change_settings), rule 20 (never "go to X and click Y" for a tool's job), rule 24 (approve / cancel at once
  when told), rule 26 (security and autonomy through change_settings). Job messages go through the existing
  `JobMessageService` (owned by p15-message-delivery).
- Replicas: a turn dispatched by another replica carries no captured step-up; its direct actions run only for events
  that need no code (others become cards).

## 6. Console

Ayarlar → Güvenlik (`/settings/security`, admin; Diyalog view, also mounted in the classic console):
presets with "apply", the window / remember-device / always-fresh selects, the per-event "TOTP iste" switches grouped
by category with the core badge and a warning when a core event is off, autonomy switches, "apply to existing
projects", risk-based rules. Save sends only the changed values with `expectedVersion` (409 on a stale view) through
the step-up provider (asks for a code only when the policy protects "security.policy"). Strings: `@remyral/i18n`
namespace `security` (TR + EN), errors `version_conflict.security_policy`, `forbidden.settings`,
`unavailable.settings`, `invalid_draft.settings`. Chat cards: kind `settings_change` (registry + summary).

## 7. Tests

- Unit `test/unit/security-policy.test.ts` — catalog completeness, presets, documents and patches, windows, autonomy in
  `resolveRule`, job defaults.
- Integration `test/integration/security-policy-enforcement.test.ts` — Sıkı / Serbest / Dengeli enforcement, the
  policy window in `/auth/session`, new-project autonomy, API RBAC, audit with changed paths, stale version, apply to
  existing projects, migration default.
- Integration `test/integration/chat-direct.test.ts` — direct security-policy change (core, fresh code), needs-code
  card with inline confirmation, RBAC refusals (operator: security policy, project execution), chatDirect off, get_settings
  visibility, direct approval as the operator, direct job message through the job message service, audit entries.
- `route-coverage.test.ts` — every step-up route has an event. Harness default preset: Sıkı (existing suites keep
  asserting the strict paths).

## 8. Security review

| Threat | Before | Now | Mitigation |
|---|---|---|---|
| Stolen session cookie | most privileged routes need a code within 10 min | in Serbest only the safe core needs one | `__Host-` cookies, CSRF, idle 30 min, absolute lifetime, device trust revocable; the core (policy, 2FA, users/roles, secret reveal) stays protected so a thief cannot lock the owner out or widen access silently; Dengeli / Sıkı one click away; every waived privileged action is still audited by its service |
| Weakening the policy | n/a | policy change | core event `security.policy` on by default; admin+ only; versioned; audited with `changed` and `coreOff`; stale-version refusal |
| Prompt injection makes the assistant act | cards only | direct actions | only `execute: true` acts; the prompt forbids execute from tool output; the user's own role applies (RBAC re-checked at confirmation); protected events still need a code; `chatDirect` switch; `chat.direct_action` audit |
| Untrusted repository gets auto-approved deploys | floor always asked | autonomy applies to `allow-all` jobs only | `allow-all` needs a trusted source and a project opt-in (ADR-0020, job store); untrusted jobs keep `ask-sensitive`; repository content stays without authority (ADR-0010 §1) |
| Machine root via autonomy | ADR-0021 two switches | unchanged | `machine.admin` excluded from the autonomy set; machine-admin jobs not defaulted to allow-all |
| Unconfined by default | never | never | autonomy sets host execution and auto-approve only; apply-to-existing never turns unconfined on |
| Policy unreadable | n/a | n/a | strict preset (fail closed), logged |
| New route without an event | n/a | not waived | fail closed + coverage tests |
| Multi-replica cache | n/a | ≤ 5 s stale on other replicas | a tightening applies within 5 s everywhere; local change immediate |
| Endless jobs via time limit | fixed at submission | extendable | policy cap `maxJobMinutes` (≤ 7 days), operator+ in the project, signed + fenced SET_TIME_LIMIT, audited; budgets / quotas unchanged |
| Approval never expiring | fixed | extendable | at most 7 days after the request, approver role of the rule, audited |

Residual risk accepted by the owner: in Serbest a hijacked session can run, approve and deploy without a code within the
session's lifetime. Recommended for shared or internet-exposed installations: Dengeli.

## 9. Operations

- Migration 0118 creates the tables and stores `{"preset":"serbest"}` (version 1, via `migration`).
- Back to the previous behaviour: Ayarlar → Güvenlik → "Sıkı" → "Bu ayarı uygula"; or tell the assistant "güvenlik
  politikasını sıkı yap"; or from the master shell:
  `UPDATE security_policy SET document = '{"preset":"siki"}', version = version + 1, updated_at = now() WHERE id = 1;`
  (applies within 5 s; the audit log does not record a shell change — prefer the console).
- `AUTH_STEP_UP_MINUTES` / `AUTH_STEP_UP_TRUSTED` apply only where the policy says "server default" (Sıkı).
- Worker release: needed for the assistant's system prompt and the new tool schemas; until then the assistant keeps
  drafting cards (the master accepts both).
- Rollback: the master code reads the table; rolling the master back leaves the table unused (strict behaviour of the
  old code). No data migration to undo.

## 10. Time limits and approval deadlines from the cards (owner request 2026-10-21)

"Süre sınırı karttan düzenlenebilmeli":

- **Job draft card**: the time limit (minutes) is an editable field (`PATCH /chat/drafts/:id` `maxDurationSec`,
  rebuilt through draft_job; above `autonomy.maxJobMinutes` refused).
- **Running / queued job**: `GET/POST /jobs/:id/time-limit` (`jobs.timelimit`, operator+, step-up event
  `jobs.control`; `addSec` or `maxDurationSec`, 1 min … `autonomy.maxJobMinutes` — Serbest 7 days, Dengeli 24 h,
  Sıkı 12 h). Changes are rows of `job_time_limit_changes` (migration 0118, latest seq wins; JobStore merges it into
  `spec.limits`, so the master's wall-time backstop and the next attempt use it). A running attempt's worker with
  `time-limit-v1` gets a signed, fenced SET_TIME_LIMIT; `RunClock.setBudget` keeps the time used and re-arms (a
  budget already used up ends the run as a timeout); the worker answers TIME_LIMIT_STATUS (applied + seconds left /
  refused). The adapter's hard backstop now sits above the protocol's 7-day maximum (the run clock is the budget).
  Older workers: delivery `unsupported` (next attempt), said on the card. Audit `job.time_limit.change` /
  `job.time_limit.applied`.
- **Cards**: job page side panel "Süre sınırı", the chat job cards after start, and the approval cards (home "Senden
  bekleyenler", job page, chat) show the limit with +30 dk / +1 saat / +4 saat and an exact value.
- **Assistant**: `draft_time_limit` (`addMinutes` / `minutes`, `execute: true` on "süreyi uzat").
- **Approval deadline**: `POST /approvals/:id/extend` (`approvals.decide`, the approver role of the rule, step-up
  event `approvals.decide`): later than now and the current deadline, at most 7 days after the request; audited
  `approval.extend`. The card shows "Karar gelmezse … süresi dolar" with +1 saat / +1 gün.
- Strings: `@remyral/i18n` namespace `timeLimits`; errors `time_limit_out_of_range`, `forbidden.time_limit`.
- Tests: `test/integration/time-limit.test.ts` (master + real worker daemons), `apps/worker/test/time-limit.test.ts`
  (run clock, signature).
- Note: an approval decided under a waived event stores the request time as its `step_up_at` (no code was asked).
