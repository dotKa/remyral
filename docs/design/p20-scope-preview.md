# p20-scope-preview — goal-bound permission, intent-fitting previews, work readiness

Owner complaints 2026-10-31 (#4, #7, #10, #11; `ux-research-2026-10-31/sentez.md`, `r3/codex-akis.md`,
`r3/codex-envanter.md`):

- "Makinede söylediğimi yap" (`autonomy.chatMachineAdmin`) held only for the user's own turn
  (`apps/master/src/chat/direct.ts` `USER_TURN_TRIGGERS`, drafts `machinePolicyCard`). The plan / watch continuation
  of the SAME goal — a system-written turn — fell back to a card or an approval wait.
- Asked for a development preview ("Cloudflare Tunnel yeterliydi"), the assistant went for a permanent Coolify
  deployment although the service model with quick / named tunnels exists (`start_service`).
- A missing tool, access or network was found as a failure after the work had started ("bu tarz araçlar otomatik
  kurulmalı").

## 1. Scope (what changes, what not)

Master + prompt. Migration **0206**; prompt rule **67** plus small additions to rules 7 / 9 / 27; new read tool
`check_work_readiness`; `draft_tool_install.tool` accepts the worker's existing recipes `cloudflared` and `uv`. The
prompt and the tool list ship with the worker: **worker 1.2.13** (an older worker keeps its prompt; the master parts
work with any worker).

Unchanged: the security policy's code rules (a continuation has no person present, so an event that needs a fresh
authenticator code stays a card), roles, the machine's own machine-admin switch (local veto), always-card tools
(`ASSISTANT_CARD_DEFAULT_TOOLS`, `cardOnly`, confirm-only tools such as backup restore), a watch's `then` step.

## 2. Goal-bound permission (`autonomy.goalGrants`, "Hedefe bağlı yetki")

- **Switch**: `AutonomySettings.goalGrants` — on in Serbest and Dengeli, **off in Sıkı**. Settings → Security →
  Autonomy has a switch; `change_settings` takes it.
- **Recording**: when a draft of the user's OWN turn (trigger `default` / `execute`, a person's session attached)
  runs directly and the switch is on, `GoalGrants.record` writes a `chat_goal_grants` row: thread, user, scope
  (`goalScopeOf`: `machine_admin` per machine; `service.run` / `service.stop`; `settings:<target>:<op>`; else the
  draft kind — plus project and machine), whether it ran machine administration by policy, `expires_at = now + 6 h`.
- **Inheritance**: a continuation turn (an approved autonomous plan → trigger `plan`; a watch follow-up → `watch`)
  asks `ChatDirectActions.goal` for each draft. In scope = an unexpired, unrevoked entry of the same thread and user
  with the same operation type and project and (machine administration always; otherwise when both name one) the
  same machine. Then:
  - a watch follow-up draft runs directly like in the user's turn (not only the follow-up tools); always-card tools
    stay cards;
  - machine administration inherits `chatMachineAdmin` (`inheritedMachineAdmin`: both switches on now and the entry
    itself ran by policy). The draft executor re-reads both switches; the machine-admin job carries
    `machine_admin_chat_grants.goal_grant_id` and every elevated command re-checks that the grant is not revoked and
    the switch is on (`MachineAdminService.#chatGrant`).
  - For a plan only machine administration is checked (the plan approval already covers its other drafts).
- **Out of scope**: one card, `refused: out_of_scope`, the tool result says why in one sentence (`outOfScope: true`);
  audited `chat.direct_action` denied with the scope.
- **Audit**: inherited actions carry `metadata.inherited {grantId, from: user_turn, scope, grantedAt, until}` and
  `policy: autonomy.goalGrants`; the machine-admin job and its command approvals carry `inherited.goalGrantId`.
- **Revoking**: the switch (read on every use), `DELETE /chat/threads/:id/goal-grants` (audited
  `chat.goal_grant.revoke`), expiry, or cancelling the plan / watch (only continuations read grants).
  `GET /chat/threads/:id/goal-grants` lists the live ones.
- **Fail closed**: any error reading the policy or the grants = `off` (the earlier behaviour).
- **The "otonomi" block** names `goalScope` so the assistant says what runs and what waits.

## 3. Intent-fitting previews (rule 67 a)

A development preview ("önizleme", "link ver", "Cloudflare Tunnel yeterli") is `start_service` with a tunnel (quick:
no setup). Coolify / Pages (`coolify_create_app`, `draft_deploy`, `pages.publish`, `draft_pages_project`) only when
the user asks to publish / deploy / go to production or names them. The user's chosen method is never swapped
(rule 60). The tool descriptions of `start_service`, `coolify_create_app` and `draft_deploy` say the same.

## 4. Work readiness (`check_work_readiness`, rule 67 b)

Read tool; the master decides deterministically (`apps/master/src/chat/work-readiness.ts` `assessWork`, pure) from the
project readiness (`ChatProjectSetup.evaluate`), the machines' `sandbox_status`, `tool_inventory`,
`preview_tunnels`, `machine_admin` reports, the caller's role (`workers.ops.write`) and the policy:

- `prepare`: ready tool calls — `draft_machine_prepare {workerId, privileged}` for an unready sandbox profile with fix
  `prepare` / `prepare_privileged` (bubblewrap & co.), `draft_tool_install cloudflared` for a tunnel — each with
  `runsAtOnce` (this turn runs drafts at once; a privileged / elevated step also needs `chatMachineAdmin`);
- `ask`: ONE question with its reason — machine assignment, network access, a panel setting, a runtime login, a
  preparation only an administrator may run;
- `blocked`: holds, offline / unknown machine, a worker without services, an owner-only sandbox fix, no cloudflared
  recipe;
- `checks` and `next`.

The assistant runs the prepare calls, asks the one question, or stops; it does not discover these as failures.

## Security

The grant never widens what a person could do: it only carries the user's own direct run into continuations of the
same conversation, for the same operation on the same machine / project, for 6 hours, with every switch re-read at use
and every elevated command re-checked. Code rules, roles, the local veto and always-card tools are untouched; Sıkı
keeps it off. A repository / tool result cannot create a grant (only a user-turn direct run records one).

## Rollback

Additive. An older master ignores the table and column (continuations behave as before); turning the switch off has
the same effect at once. SQL in migration 0206's header.

## Tests

`apps/master/test/unit/chat-goal-grants.test.ts` (scope, in scope passes, out of scope stops, Sıkı off, audit),
`apps/master/test/unit/work-readiness.test.ts`, `apps/master/test/unit/chat-direct-decision.test.ts` (otonomi block),
`packages/agent-adapters/test/assistant-scope-preview.test.ts` (rule 67, rules 7 / 9 / 27, tool descriptions).
