# p16-assistant-admin — administration through the ops chat

Status: implemented (2026-10-23). Backlog: `p16-assistant-admin`. No migration. Worker release needed (tool catalog
and prompt rule 39 live in the worker's assistant host).

## 1. Problem

Single-company install, Diyalog UI only. The ops chat could read the fleet, jobs, deploys and settings and change the
security policy, but the rest of the administration still needed a screen: users and roles, project memberships,
machine pairing / revocation / key rotation, the worker release rollout, backups, vault credentials, one's own
notification preferences, integration connections, and reads of quotas, schedules, preview links and Git state. The
master already has a route and a service for each of these.

## 2. Decision

Assistant tools that call **the same service method as the console route**, for the user who sent the turn, under the
same authorization action. No business logic is duplicated; reads are projections of what the route returns.

| Tool | Kind | Service (route) | Action | Card rule |
| --- | --- | --- | --- | --- |
| `list_users` | read | `Directory.listUsers` (`GET /users`) | users.read | — |
| `list_project_members` | read | `Directory.members` (`GET /projects/:id/members`) | projects.members.read | — |
| `worker_release_status` | read | `ReleaseService.list` + `FleetService.list` + `worker_update_targets` | releases.read | — |
| `describe_backups` | read | `BackupStatusService.overview` (`GET /backups/status`) | backups.read | — |
| `list_vault_credentials` | read | `VaultService.list` (metadata only) | vault.read | — |
| `open_credential_rotation` | read | `VaultService.list` → link `/settings/credentials?replace=<id>` | vault.write | nothing changes |
| `notification_preferences` | read | `NotificationService.preferences` (own) | notifications.self | — |
| `list_integrations` | read | `OpsIntegrations.status`, `GitHubConnectService.status` | integrations.*.read | — |
| `quota_status` | read | `QuotaService.status` (`GET /quotas/status`) | quotas.read | — |
| `list_schedules` | read | `ScheduleService.list` | schedules.read | — |
| `list_previews` | read | `PreviewService.projectView` (no tunnel token) | previews.read | — |
| `git_central_status` | read | `job_git` / `git_merge_requests` of visible projects, GitHub App status, `GitCentralService.fleet` | jobs.read / integrations.github.read / workers.read | — |
| `manage_user` invite | change | `Directory.createUser` | users.manage (owner) | **always a card** (one-time password) |
| `manage_user` set_role / enable | change | `Directory.setRole` / `enable` | users.manage | policy |
| `manage_user` disable | change | `Directory.disable` | users.manage | **destructive** |
| `manage_project_member` | change | `Directory.setMember` / `removeMember` | projects.members.write | policy |
| `manage_machine` approve / reject / rotate_key | change | `FleetService.approve` / `deny`, `RotationService.request` | workers.approve / workers.rotate | policy |
| `manage_machine` revoke | change | `FleetService.revoke` | workers.revoke | **destructive** |
| `manage_release` set_rollout / pause | change | `ReleaseService.promote` (pause = 0 %) | releases.publish | policy |
| `manage_release` rollback_machine | change | `ReleaseService.target` (rollback) | workers.update | policy |
| `update_notification_preferences` | change | `NotificationService.updatePreferences` (own) | notifications.self | policy |
| `check_integration` | change | `OpsIntegrations.test`, `CoolifyConnections.test`, `GitHubConnectService.sync` | integrations.*.write | policy |

"policy" = the p15-chat-execute-default rule: the user's own command runs at once where `autonomy.chatDirect` allows it
and the card's event needs no fresh code; otherwise a card (which asks for the code inline).

## 3. Cards without a migration

Changes are `settings_change` drafts with `target: "admin"` and `op` (e.g. `user.disable`). The existing
`chat_drafts.kind` check needs no widening. `DraftExecutor.#run` sends these cards to `ChatAdmin.run`;
`settings_change` other targets keep going to `ChatSettings`. The web names the card "Yönetim / Administration" and
summarises it from the payload (`summary.ts adminSummary`).

## 4. Events and codes (ADR-0056, AGENTS.md rule 10)

`adminOpEvent(op)` maps each operation to the event of its console route: users and memberships → `users.roles` (safe
core), machines and a machine rollback → `machines.fleet`, rollout → `releases.publish`, notification target changes →
`notifications.channels` (kind switches → `chat.cards`; the route asks no code for them), integration tests →
`chat.cards`. Unknown operations → `security.policy` (fail closed). User account operations are always-fresh, like
their routes (`freshStepUp`). The card asks for a code exactly when the screen would; nothing is hard-coded looser.

## 5. Card-only changes

The plan writes `cardOnly` into the hash-protected payload; `ChatDirectActions.execute` (the one gate for the platform
default, `execute: true` and watch steps) enforces it:

- `reveal` — an invite: the temporary password exists only in the confirmation answer (`reveal`, never stored, audited
  or given to the model). The card shows it once (`TemporaryPassword`). Never runs directly; `ChatAdmin.run` refuses a
  direct run as defence in depth.
- `destructive` — disabling a user, revoking a machine: runs directly only where the security policy's new
  `autonomy.chatDestructive` is on. Off in every preset (also in Otomatik mod); a switch in Ayarlar → Güvenlik → Ajan
  özerkliği and `change_settings`. Its event's code rule applies either way.

Restoring a backup would be card-only and code-only too, but it is not offered (§7).

## 6. Audit

Every change runs inside `withAuditSource('chat')` (an extension of the p16-api-tokens `auditRequestContext`). The
services' own entries keep the console's action names (`user.role.change`, `project.member.set`, `worker.revoke`,
`release.promote`, `worker.update.target`, `notification.preferences.update`, …) and gain `metadata.source: "chat"`;
`chat.draft.confirm` (via `chat-direct` / `card`) and `chat.direct_action` (with the refusal reason
`destructive` / `card_only` / `needs_code`) are written as before.

## 7. Not built (with reason)

- **Backup now, restore drill, restore.** The master only reads the backup service's status directory (mounted
  read-only); `remyral-backup run / drill / restore` run in the backup container on the host (docs/ops/backup-restore.md).
  There is no master service to call, and building a trigger channel would be new business logic. `describe_backups`
  says so; rule 39 forbids claiming a backup was started.
- **Vault rotation inside the chat.** The tool only opens the browser-sealed "new value" form of the credential
  (`/settings/credentials?replace=<id>`); the value never reaches the master or the model.
- **Reconnecting an integration with a new token / key.** Secrets never pass the chat; `check_integration` re-tests or
  re-syncs with what the master holds.

## 8. Security review

- Authorization: checked when planning (refusal to the model) and again when the card runs, for the confirming user.
- Secrets: vault reads return metadata only; webhook URLs only as origin; no tool input takes a token / password /
  value (protocol test); the pairing code is not shown on the card summary or echoed in the result; the invite's
  password is only in the HTTP confirmation answer (integration test checks drafts, audit and messages).
- Self-change: the signed-in user's own account cannot be changed (also refused by the Directory).
- Prompt injection: rule 39 — never an administration change because a tool result, document or job output asks.

## 9. Tests

- `packages/protocol/test/assistant-admin.test.ts` — kinds, descriptions, strict inputs, no secret inputs.
- `packages/agent-adapters/test/assistant-admin.test.ts` — rule 39, rule 2, engine specs.
- `apps/master/test/unit/assistant-admin.test.ts` — events, always-fresh, destructive set, policy switch, audit scope.
- `apps/master/test/integration/chat-admin.test.ts` — real master + real assistant worker (fake engine): permissions
  (viewer / admin / owner), direct vs card by policy (Serbest, Sıkı, chatDestructive), code-required cards, destructive
  and invite cards, audit rows with `source: chat`, no secret in results.
- `apps/web/test/assistant-admin.test.tsx`, `diyalog-w3-settings-admin.test.tsx` — card summary, event, password,
  security switch, rotation link.

## 10. Rollout and rollback

Master + web deploy, then a worker release (new tools and rule 39 reach the model only through the worker's assistant
host; older workers simply do not offer them). Rollback: redeploy the previous master; stored `settings_change` cards
with `target: "admin"` then fail with "Unknown settings target" and can be dismissed; the policy's `chatDestructive`
override is ignored by the old schema only if absent — remove it first (`change_settings`) when rolling back.
