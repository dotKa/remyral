# Design note: `p13-multi-coolify` — several Coolify connections

- **Task:** `p13-multi-coolify`. **Date:** 2026-10-20.
- **Owner request (2026-10-20):** "1'den fazla coolify sisteme eklenebilmeli. Şu anda sunucuda default coolify var ama
  harici coolify bağlamak daha mantıklı olabilir. Mevcut olan coolify'ı da harici coolify gibi handle ederiz."
- **Decision:** [ADR-0050](../adr/0050-multiple-coolify-connections.md) (amends ADR-0028 §1, §2, §4, §5).
- **Builds on:** ADR-0028 (master-held tokens, typed ops actions, control-plane refusal, SSRF rules), ADR-0030 (deploy
  on success target snapshot), ADR-0035 (health), ADR-0048 (deploy logs for agents), p5-coolify-sso, p8-uptime.
- **Provider facts:** unchanged — the same Coolify v4 endpoints per connection (docs/compat/coolify.md). Tokens are
  team-scoped, so two teams of one instance are two connections.

## 1. Model

| Before | Now |
| --- | --- |
| One row `ops_integrations(provider='coolify')` | Table `coolify_connections` (N rows) + `coolify_connection_projects` |
| `DeployTargets.coolify.{preview,production} = {uuids, tags}` | `{connection, uuids, tags}` — each environment names its connection |
| Ops actions always used "the" token | The plan resolves the environment's connection; the action's `target.connection = {id, label}` is used for execution, status polling, build logs and rollback |
| Uptime `coolify` monitor `{uuid}` | `{uuid, connection}` |
| "Open Coolify" one link | per connection: the server SSO gate for connections marked `useServerSso`, else the connection's browser URL |

A **connection** = `{id, label (unique), url (API base, SSRF rules), team?, denyResources[], openUrl?, useServerSso,
isDefault, allProjects, projects[], token (encrypted, never returned), keyFingerprint, lastTest}`.

- **Token at rest:** AES-256-GCM under the HKDF sub-key `ops-integrations` of the master key file (unchanged key), AAD
  `coolify-connection:<id>` for new / replaced tokens. The migrated row keeps the AAD it was written with
  (`ops-integration:coolify`, column `secret_aad`) so nobody re-enters the token; replacing the token re-encrypts it
  with the per-connection AAD. The AAD is chosen by the server, never by input.
- **Default:** at most one (`UNIQUE … WHERE is_default`). It is what a deploy target without an explicit connection,
  the legacy `/integrations/ops/coolify` endpoints and "Open Coolify" of old clients mean. It is *not* special for
  policy or protection.
- **Project assignment:** `allProjects` or the explicit `projects[]` list (admin-set, Settings → Integrations →
  Coolify). Saving deploy targets, planning any `coolify.*` action, runtime logs, build logs and uptime monitors refuse
  a connection the project may not use (403 `coolify_connection_not_allowed`). Refresh of an already running
  deployment is allowed (it only finishes what was approved).

## 2. Migration 0097 (transparent)

1. Create the two tables.
2. Copy `ops_integrations(provider='coolify')` → one connection **"Sunucu Coolify (varsayılan)"**: same config + `useServerSso
   true`, same secret/fingerprint/last test, `secret_aad 'ops-integration:coolify'`, `is_default`, `all_projects`
   (today every project could use it).
3. Stamp the connection id into: every `project_deploy_targets.config.coolify.<env>` object (`connection`), every
   `coolify.*` ops action's `target.connection = {id, label}` (in-flight polling continues), pending `coolify.rollback`
   params, `job_deploy_on_success.target_snapshot.coolify.connection` (pending deploys on success stay valid), and
   uptime `coolify` monitors' `config.connection`.
4. Delete the old `ops_integrations` coolify row (single source of truth). Cloudflare / Bedrock rows untouched.

No version bump of the deploy targets (an open editor that saves without `connection` gets the default = same).

## 3. Control-plane protection (non-overridable)

Unchanged rules, applied to **every** connection:
- `OPS_CONTROL_PLANE_COOLIFY_UUIDS` (env) is denied on every connection (cuids do not collide across instances; a
  stricter-than-needed rule costs nothing), plus that connection's own `denyResources` (additive, panel).
- An application whose `fqdn` serves the console host (or `PUBLIC_ORIGIN`) is refused on every connection.
- A connection is flagged `controlPlane` in the view when its origin is an `OPS_INTERNAL_ORIGINS` entry, its host is the
  SSO host, or its last Test saw an env-listed resource / console fqdn. The flag is informational: the refusal does not
  depend on it, so mislabelling a connection cannot weaken it.
- Test connection reports `controlPlaneResources` (how many of the visible applications are control plane).

## 4. API (REST + OpenAPI)

| Route | Authz | Step-up |
| --- | --- | --- |
| `GET /integrations/coolify/connections` | `integrations.ops.read` (admin) | — |
| `POST /integrations/coolify/connections` | `integrations.ops.write` | always-fresh |
| `PUT /integrations/coolify/connections/:id` (label, url, team, denyResources, openUrl, useServerSso, isDefault, allProjects, projects, token?) | `integrations.ops.write` | always-fresh |
| `DELETE /integrations/coolify/connections/:id` | `integrations.ops.write` | always-fresh |
| `POST /integrations/coolify/connections/:id/test` | `integrations.ops.write` | — |
| `GET /projects/:id/coolify-connections` (id, label, isDefault, host — what the project may use) | `deploy.read` | — |
| legacy `GET/PUT/DELETE /integrations/ops`, `/integrations/ops/coolify[/test]` | unchanged | unchanged — act on the default connection |

The view never has a token field: `{id, label, url, host, team, denyResources, openUrl, useServerSso, isDefault,
allProjects, projects, usedBy[{project, envs}], keyFingerprint, usable, controlPlane, lastTest, lastTestAt, updatedAt}`.
Removing a connection used by deploy targets is allowed (an admin must be able to pull a leaked token at once); the
confirm dialog lists the projects, and their Coolify deploys then fail with "connection removed" until re-pointed.

Audit: `ops.coolify_connection.create|update|remove|test` (target `coolify-connection:<id>`, metadata fingerprints,
settings, projects; never the token); `ops.targets.write` carries the targets with connection ids; `ops.action.*`
metadata carries the diff, whose `connection` names the Coolify.

## 5. Ops actions

- `#planCoolify(kind, env)`: target → connection (explicit, else default) → allowed for the project → client → resolve
  uuids/tags → deny-list (env + that connection) → plan. `target.connection = {id, label}`, `diff.connection = label`.
  The plan key keeps its p6 formula; an approval re-plan whose connection differs from the stored one is `stale`.
- Execute / refresh / build logs / rollback use the action's recorded connection (fallback: default, only for rows the
  migration could not stamp). The rollback request copies the connection id into its params.
- Runtime logs re-resolve the project's current target for the environment (and its connection).
- Deploy on success: the snapshot carries `coolify.connection`; a target moved to another connection after the
  pre-approval refuses the deploy (snapshot mismatch → nothing deployed), as any target change.
- Automations / workflow deploy steps keep fixed `{env}` params; the connection comes from the project's target.
- Policy, approvals, idempotency, rate limit: unchanged.

## 6. Chat, agents, uptime, SSO

- `draft_deploy`, `deploy_status`, `deploy_logs`, in-job `deploy_status` / `deploy_logs` / `request_redeploy`: no new
  parameters. The master resolves the connection from the project target; card target / diff and status summaries
  carry the connection label (`Coolify «label»`), the targets listing in `deploy_status` names each environment's
  connection. No URL beyond the host, never a token. **No tool schema or prompt change → no worker release.**
- `draft_monitor type coolify` and the monitor form: `connection` optional; when omitted the master picks the project's
  target connection that lists the uuid, else the project's single usable connection, else the default (must be allowed).
  Provider checks re-check the project's right on every check (undecided `provider_not_configured` otherwise).
- `GET /coolify-sso/config` adds `connections: [{id, label, url, sso}]` (owner/admin): `sso` connections (marked
  `useServerSso` while the server SSO gate is configured) open the gate URL; others their `openUrl`, else the https API
  base. The top-level `enabled/url` stay as before (the gate), so the default behaviour is unchanged.

## 7. Console

- Settings → Integrations → Coolify: list of connections (label, host, default badge, control-plane badge, last test,
  projects using it) with Add, Edit (label/url/team/open URL/SSO/projects/all projects), Replace token, Test, Set default,
  Remove (confirm listing the projects using it + always-fresh code). Diyalog native (`integrations-ops.tsx`), classic
  minimal (`OpsIntegrationsCards.tsx`).
- Project → Deploy → Coolify target: a connection picker per environment (only the connections the project may use).
- Uptime monitor form: connection picker for `coolify` monitors.
- Account menu / profile: one "Open Coolify" entry per connection (owner/admin).

## 8. Backups and standby

Connection tokens live in Postgres (`coolify_connections.secret`), encrypted with the master key file
(`secrets/totp.key`, HKDF sub-key `ops-integrations`) exactly like the previous single token. The DB dump carries the
ciphertext, the recovery-secrets archive carries the key: a restore (or standby promotion) brings every connection
back usable; neither alone reveals a token. Nothing new to back up.

## 9. Security review

| Threat | Mitigation |
| --- | --- |
| A project deploys to another team's / company's Coolify | Connection ↔ project assignment, checked at target save, plan (every request and re-plan), runtime / build logs and monitor checks |
| Token disclosure through the new list / chat / tools | No token field in any schema; canary tests over every response, audit row, log line; label/host only to tools |
| SSRF via a new connection URL | Same `checkBaseUrl` + guarded fetch (https, public addresses at connect time, no redirects, env-only internal origins); `openUrl` is only a link (https, no credentials), never fetched |
| A second connection to the control-plane Coolify bypasses the deny-list | Env deny-list and console-fqdn rule apply to all connections |
| Token swap between rows (DB write) | Per-connection AAD for new tokens; a DB writer could already redirect deploys — out of scope as before |
| Removing the default leaves targets dangling | Explicit errors ("connection removed"), no silent fallback to another connection |
| Stale approval after a target moved connection | Re-plan compares the connection id → `stale` |

## 10. Tests

- master integration `multi-coolify.test.ts`: two fake Coolify servers; per-connection deploy / restart / status /
  build + runtime logs / rollback; project-connection authz; control-plane refusal on the matching connection;
  SSRF; token canaries; audit; SSO config list; uptime monitor per connection; chat `draft_deploy` / `deploy_status`
  label; in-job deploy status.
- `multi-coolify-migration.test.ts`: migrate to 0096, insert the legacy row + targets + action + monitor, migrate,
  check the stamped ids and that the token still decrypts (deploy works without re-entry).
- web: connections list (classic + Diyalog), target editor picker, monitor form picker.

## 11. Rollback

Forward-only migration. To go back to one Coolify: remove the extra connections; the default keeps working through the
legacy endpoints. A binary rollback to a pre-0097 master is refused by the migration runner (newer schema) — restore
the pre-upgrade DB backup if a downgrade is ever needed.
