# ADR-0057: Remyral creates Coolify applications and changes their variables and domains (opt-in per connection)

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** owner (direction 2026-10-21: "deploy work without ever opening Coolify"), agent
- **Related:** p15-coolify-create; docs/design/p15-coolify-create.md; docs/compat/coolify.md; ADR-0028 (deploy
  integrations, §1 control plane, §2 tokens); ADR-0050 (several Coolify connections, project allowlist); ADR-0056
  (security policy); ADR-0016 (credential vault sealed to workers); migration 0123

## Context

Until now Remyral only listed, deployed, restarted and rolled back Coolify applications and read their logs; ADR-0028
§2 said the token needs `read` + `deploy` and warned about `write`. Putting a new project online therefore still meant
opening Coolify: creating the application, its variables and its domains by hand. The owner wants to do all of it from
the panel or the chat.

## Decision

1. **Opt-in per connection.** `coolify_connections.manage_apps` (default off). Only an administrator turns it on
   (Ayarlar → Entegrasyonlar → Coolify, always-fresh code as for every connection change); the token then needs
   Coolify's `write` ability. Test connection warns about `write` only when the connection does not manage
   applications, and about its absence when it does. ADR-0028 §2 is amended accordingly.
2. **What can be done.** Create an application (`POST /applications/{public|private-github-app|private-deploy-key|
   dockerfile|dockerimage}`: the project's repository + branch, a Dockerfile, or an image; build pack incl. Docker
   Compose from the repository; ports, domains, health check), set / remove its environment variables, replace its
   domains. Nothing is deleted in Coolify; services, databases and raw compose stacks stay out of scope.
3. **Scope.** Only a connection the project may use (ADR-0050 allowlist). Only applications linked to the project's
   deploy targets are changed. Never the control plane (ADR-0028 §1): a new application is refused in a Coolify
   environment that holds a deny-listed resource or whose server / project / environment / destination uuid is
   deny-listed; a linked application is changed only after the deny-list check (uuid + console host); domains never
   name the console host or a domain of a deny-listed application; Coolify's domain-conflict answer (409) is
   reported, `force_domain_override` is never sent.
4. **Who.** RBAC `deploy.coolify.read` / `deploy.coolify.manage`, project admin. The security policy (ADR-0056) decides
   the authenticator code with the new event `deploy.coolify` (off in Serbest, on in Dengeli / Sıkı; fresh installs start on Dengeli);
   the assistant's cards map to the same event.
5. **Secrets.** Remyral never stores a variable value: values typed in the panel go master → Coolify in the same
   request and are not persisted, logged, audited or returned (only keys, flags and the source `value` / `shared`).
   Coolify shared variables (`{{project.NAME}}`) are the reference form. The chat never carries a secret value: the
   assistant's tools refuse secret-looking keys and values (key pattern + the secret scanner) and point the user at the
   panel editor or a shared variable. The Remyral credential vault cannot be the source: its values are sealed to
   worker keys and the master cannot decrypt them by design (ADR-0016).
6. **After creation.** The application is linked to the project's deploy target (`add` / `replace` / `none`, through
   the normal targets write with its version check) and, on request, its first deploy is an ordinary ops action
   `coolify.deploy` with the new parameter `only` (the deploy policy, approvals, polling and logs apply; `only` can
   only narrow the target, never add to it). Creation is idempotent per project + key (`coolify_app_creations`).
7. **Audit.** `ops.coolify.app.create|envs|domains` with success / failure / denied, connection, request summary
   (never a value), the chat or API channel.

## Consequences

- An administrator who enables "manage applications" gives the master a token that can change any resource of that
  Coolify team; the master's own checks (3) are what keep it to the project's applications. Keep such connections on
  teams without control-plane resources where possible.
- The Coolify API shapes come from the upstream OpenAPI document (docs/compat/coolify.md); the real instance is
  UNVERIFIED until the owner's first creation (steps in the design note §9).

## Rollback

Old masters ignore the column and the table. Turn "manage applications" off to stop all writes at once.

## Amendment 2026-10-22 — one application per app, diagnose before recreate, delete (p15-coolify-dedupe)

Production incident: the assistant created five Exited applications for one app, answering each failed deploy with a
new application. Decision (docs/design/p15-coolify-dedupe.md, migration 0128):

1. **Duplicate guard in the master.** A new application is refused (409 `coolify_app_exists`, naming the existing
   application and its link state) when its Coolify environment already has one for the same repository + branch
   (+ base directory / Dockerfile location when given), the same image, or the same name. `allowDuplicate` overrides
   it only on the user's explicit request. Chat creation keys are derived from the turn and the request, so a retry in
   the same turn never creates twice.
2. **Read and fix instead of recreating.** Deployment and container logs of an application of the project (linked or
   created by it) are readable (redacted, bounded); its build / run settings can be changed (`PATCH
   /applications/{uuid}`, documented fields) and it is redeployed through the normal ops action.
3. **Delete** (amends "Nothing is deleted in Coolify" in Decision 2): an application of the project may be deleted
   (`DELETE /applications/{uuid}`, volumes kept unless asked) — never a control-plane resource or an application in
   the control plane's environment, never one another project's target lists; the project's targets stop listing it;
   audited `ops.coolify.app.delete`. It is destructive: the panel asks for confirmation, the assistant only proposes it
   on the user's explicit instruction and no automatic mode executes it (`isDestructiveDraft`).

Rollback: old masters ignore the new columns; the new routes and tools disappear with the rollback.

## Amendment 2026-10-27 — the whole Coolify from Remyral (p17-coolify-full)

Owner direction "coolify ı tamamen yönetebilmeliyiz" (trigger: the assistant could not add a persistent `/data` volume
to `remyral-site-preview`). Decision (docs/design/p17-coolify-full.md, migration 0176):

1. **Coolify-wide scope.** Besides a project's applications (`deploy.coolify.*`, project admins), a connection's whole
   Coolify — applications, databases (+ backups), services (+ variables), servers, projects and environments, running
   deployments — is readable (`coolify.read`) and changeable (`coolify.manage`) by administrators. Every write still
   needs the connection's "Uygulama yönetimi" switch, is audited `ops.coolify.<area>.<op>` on the connection (or the
   project) and is refused on a control-plane resource; deleting next to the control plane, or a server / project /
   environment that holds it, is refused.
2. **Storages.** Volumes, file and directory mounts of applications, databases and services can be listed, added,
   changed and removed. A new volume is announced as empty (the running container's data at that path is not copied).
   Paths Remyral made persistent are remembered and, with the data paths variables name, warned about when no storage
   covers them. An instance without the storage API (before v4.0.0-beta.470, from its version or the catch-all 404)
   gets the exact Coolify steps instead.
3. **Probe-aware.** A write the last connection test showed the token cannot do (`write`, `deploy`, `read:sensitive`
   for logs) is refused before Coolify is called, naming the permission.
4. **Destructive steps.** Removing a storage, stopping, deleting a database / service / application / project /
   environment / backup schedule take the resource's typed name (the panel always; the API checks it when given for an
   application, always for the rest) and answer with what is lost — volumes are kept unless asked. They have their own
   security-policy event `coolify.destructive` (route overrides); Coolify-wide changes `coolify.manage`. Both are off
   in Serbest and on in Dengeli / Sıkı. Destructive chat cards are never run by a default or automatic mode.
5. **Secrets.** Database passwords only from the panel (to Coolify, never stored / logged / audited); the assistant
   never passes passwords, secret variable values, secret file contents or compose text. Answers drop passwords,
   connection URLs, variable values, file contents and compose text.
6. **Not offered** (named with their Coolify screen): adding / removing servers, proxy, sentinel, docker cleanup,
   registries, cloud providers, notifications, keys and tokens, Git sources, shared variables, team members, imports,
   clone / move / migrate.

Rollback: an older master ignores `coolify_data_paths`; the new routes and tools disappear with the rollback; turning
"Uygulama yönetimi" off stops all writes at once.
