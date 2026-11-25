# ADR-0050: Several Coolify connections — the server's Coolify is one of them

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (request 2026-10-20: "1'den fazla coolify sisteme eklenebilmeli. Şu anda sunucuda default
  coolify var ama harici coolify bağlamak daha mantıklı olabilir. Mevcut olan coolify'ı da harici coolify gibi handle
  ederiz."); implemented by `p13-multi-coolify`
- **Amends:** ADR-0028 §1 (one Coolify integration → N connections, each with its own encrypted token), §2 (the target
  names a connection; actions record it), §4 (the control-plane deny-list applies to every connection), §5 (the SSRF
  rules apply to every connection URL). Everything else of ADR-0028 / ADR-0030 / ADR-0038 / ADR-0048 stays.
- **Related:** docs/design/p13-multi-coolify.md (design + security review), docs/compat/coolify.md, p5-coolify-sso,
  p8-uptime.

## Context
The master held exactly one Coolify token — the one of the Coolify that runs the control plane. The owner wants to
deploy to other Coolify instances (another server, another team) and to treat the existing one like any external one.

## Decision
1. **Connections.** Settings → Integrations → Coolify is a list of connections `{label, API base URL, team?, token,
   extra control-plane uuids, open URL, use server SSO, default, all projects | project list}` (table
   `coolify_connections`, migration 0097). Tokens: AES-256-GCM under the HKDF sub-key `ops-integrations` of the master
   key file, AAD `coolify-connection:<id>`; never returned, logged, audited, sent to a worker or shown to the assistant.
   Admin only; add / change / remove need an always-fresh code; Test connection reports version, team, permissions,
   visible applications and how many of them are control plane.
2. **Migration without re-entry.** The p6 integration becomes the default connection "Sunucu Coolify (varsayılan)"
   (all projects, server SSO) with its ciphertext unchanged (it keeps its AAD `ops-integration:coolify` until the token
   is replaced); deploy targets, Coolify ops actions, pending deploys on success and Coolify monitors are stamped with
   its id. The legacy `/integrations/ops/coolify` routes act on the default connection. The default has no special
   powers: it is only what an unspecified target means.
3. **Targets and actions.** Each Coolify environment of a project names its connection; a project may use a connection
   only when it is assigned to it (or the connection is for all projects), checked at target save, at every plan
   (request and approval re-plan), for build / runtime logs and for uptime checks. An action records
   `target.connection = {id, label}`; execution, status polling and rollback use that connection; an approval whose
   re-plan resolves another connection is `stale`. Policy, approvals, idempotency and rate limits are unchanged.
4. **Control plane.** `OPS_CONTROL_PLANE_COOLIFY_UUIDS` and the console-host fqdn rule apply to **every** connection
   (non-overridable); a connection adds its own deny-list. A connection is flagged "control plane" (internal origin,
   SSO host or a Test that saw a control-plane resource) for information only.
5. **Agents and chat** get no new parameters: the master resolves the connection from the target and mentions its
   label; no URL path, no token. No worker release.
6. **Open Coolify** lists the connections for owner/admin: the server SSO gate for connections marked for it while the
   gate is configured, else the connection's https link.

## Consequences
- An admin can connect an external Coolify and point one project (or one environment) at it without giving any other
  project access to it.
- Removing a connection takes effect at once; targets on it fail with "connection removed" until re-pointed (no silent
  fallback to another Coolify).
- Backups need nothing new: the ciphertext is in the DB dump, the key file in the recovery secrets.

## Alternatives considered
- **Connection per action (caller-chosen)** — rejected: ADR-0028 §2 resolves the target from the project's
  configuration, never from the caller.
- **Re-encrypt the migrated token at start-up** — needs a write on boot and a two-phase rollout; keeping the old AAD
  per row is simpler and equally safe (the AAD is server-chosen).
- **Exempt the default from project assignment** — would special-case "local", which the owner asked not to do.

## Verification
apps/master/test/integration/multi-coolify.test.ts (two fake Coolify servers: legacy → default, add with fresh code,
SSRF, per-connection deploy / approve / poll / build + runtime logs / rollback, control-plane refusal on both, project
authorization, uptime, chat labels, SSO list, unassign / token replace / default switch / remove, audit, canary tokens),
multi-coolify-migration.test.ts (0096 → 0097 with a real ciphertext), web tests coolify-connections / coolify-targets.
**UNVERIFIED-LIVE** against a second real Coolify until the owner connects one (docs/guide/tr/deploy-entegrasyonlari.md).
