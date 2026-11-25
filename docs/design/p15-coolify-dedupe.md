# p15-coolify-dedupe — one Coolify application per app: diagnose, fix, redeploy

Status: implemented (2026-10-22), real instance UNVERIFIED (§8). ADR-0057 (amendment 2026-10-22). Migration 0128.
Backlog: `p15-coolify-dedupe`. Builds on docs/design/p15-coolify-create.md.

## 1. Incident (prod, 2026-10-22)

In project `demo-app` the assistant created **five** Coolify applications for one app (`coolify_app_creations`
rows, each from a different chat card: probe-main, sahne-metin, sahne-metin again, sahne-metin-deploy,
sahne-metin-main — only the last linked to the deploy target). All five showed `Exited`: each time a deploy failed
the assistant created a new application instead of reading the logs and fixing the existing one. Causes:

- nothing in the master refused a second application for the same repository + branch (only the idempotency key,
  which was new per card: `chat-<random>`);
- the assistant had no tool to read the deployment log of an application that was not deployed through a Remyral
  ops action, nor to change the build settings that were wrong (port, Dockerfile path, start command);
- nothing could remove the extra applications.

## 2. Duplicate guard (master, authoritative)

`CoolifyAppService.create` — after the place checks (server, Coolify project, environment, control plane) and the
domain check, before anything is created: `GET /applications`, keep those of the target Coolify environment
(`environment_id`; an application whose environment Coolify does not report is compared too — fail closed; when the
environment's id is unknown every application of the connection is compared), and refuse when one

- serves the same repository (compared as `owner/repo`, lower-case, whatever form Coolify stores: https URL, SSH URL,
  the bare `owner/repo` of GitHub App sources) **and** branch, and — only when the request gives them — the same base
  directory and Dockerfile location (a monorepo may hold several applications); or
- serves the same image (image source); or
- has the same name (case-insensitive).

Answer: **409 `coolify_app_exists`**, `params {uuid, name, environment}`, `existing: [{uuid, name, status, fqdn,
repository, branch, linked: preview|production|null, match: [repository|image|name]}]` and a message that tells the
caller to fix and redeploy that application instead. Nothing is stored in `coolify_app_creations` (the refusal comes
before the row), the refusal is audited `ops.coolify.app.create` `denied` `reason: duplicate`.

`allowDuplicate: true` (create input, default false) skips the guard. The panel offers it as a checkbox only after a
`coolify_app_exists` refusal; the assistant may pass it only when the user explicitly asked for a second application
(tool description + prompt rule 29). It is kept in the creation's `request` and shown on the card.

**Same-turn retries.** The chat's creation key is `chat-<sha256(thread, turn, the request without the key)>`: the same
request twice in one turn (two cards, or a retry after a timeout) is one creation — the second confirmation replays
the first. A changed request in the same turn (another name) is caught by the guard once the first exists.

**Before a card exists.** `ChatCoolify.#planCreate` asks `CoolifyAppService.existing()` (same matching, no audit):
a duplicate gets no card at all; the tool result names the application(s) and the next steps
(`coolify_deploy_logs` → fix → redeploy).

## 3. Diagnose before recreate — logs of an application

`CoolifyAppService.logs(project, uuid, {kind: deployment|runtime|both, lines})`, route
`GET /projects/:id/coolify/apps/:uuid/logs` (`deploy.coolify.read`, project admin), chat read tool
`coolify_deploy_logs` (project + appUuid, or env when the target has one application).

- Scope: an application **of the project** — linked to one of its deploy targets, or created by it through Remyral
  (`coolify_app_creations`, state created, not deleted). Its connection is authorized for the project (ADR-0050) and
  the application passes the deny list (uuid + console host).
- Deployment: the newest deployment a Remyral ops action of the project started for this application
  (`ops_actions.result.deployments|restarts|rollbacks`), unless Coolify's own list
  (`GET /deployments/applications/{uuid}?take=1`) has a newer one (a deploy from Coolify, a push); then that one
  (`from: action|coolify`). `GET /deployments/{uuid}` → hidden lines dropped (`coolifyLogText`).
- Runtime: `GET /applications/{uuid}/logs?lines=` (404 → "no running container (Exited): the deployment log tells
  why").
- Every text is redacted with the shared redactor (`DEFAULT_RULES`), tail-capped at 24 000 characters, and the chat
  tool output is redacted a second time and fenced as untrusted data.

Prompt rule 29: when a deploy failed or an application is Exited, read these logs, name the cause (build error,
wrong port, missing variable, start command, Dockerfile path / base directory), fix it on the **same** application
(`coolify_update_app`, `coolify_set_env`, a code job) and redeploy that application; never create a new one to retry.

## 4. Settings update

`CoolifyUpdateAppInput` (strict, at least one field): `name`, `branch`, `buildPack`, `baseDirectory`,
`publishDirectory`, `dockerfileLocation`, `composeLocation` (repository paths: start with `/`, no `..`), `ports`,
`isStatic`, `installCommand` / `buildCommand` / `startCommand` (no control characters; may be emptied),
`healthCheck`, `deploy`. → `PATCH /applications/{uuid}` with the documented fields only (`updateBody`); `deploy`
redeploys only this application through the normal ops action (`coolify.deploy` `only`). Linked applications only
(the redeploy needs the target). Route `PATCH /projects/:id/coolify/apps/:uuid` (`deploy.coolify.manage`, CSRF,
step-up per the security policy's `deploy.coolify`), panel "Ayarlar" editor (sends only what changed), chat draft tool
`coolify_update_app` (`coolify_change` card op `update_app`; commands the secret scanner flags are refused). Audit
`ops.coolify.app.update` with the changed values — commands only as `(set)` / `(cleared)`. `GET …/apps/:uuid` now
also returns publish directory, Dockerfile / compose location, commands and `is_static` for the editor.

## 5. Delete

`CoolifyAppService.delete(actor, project, uuid, {deleteVolumes=false, deleteConfigurations=true, dockerCleanup=true,
deleteConnectedNetworks=true})` → `DELETE /applications/{uuid}?delete_configurations=&delete_volumes=&docker_cleanup=&
delete_connected_networks=` (all four documented flags sent explicitly; Coolify's defaults are all true — Remyral keeps
volumes unless asked, they hold data).

Refused, audited `ops.coolify.app.delete` `denied`:

- not an application of the project (§3 scope) → 404 `app_not_linked`;
- deny-listed / console host → 403 `control_plane_resource`;
- an application in the environment of a deny-listed resource → 403 `control_plane_environment`;
- listed by **another** project's deploy targets → 409 `app_used_elsewhere`.

After the delete: the project's creation rows of that uuid get `deleted_at` / `deleted_by` (migration 0128; a
deleted creation is history only), and every deploy target of the project that listed it stops listing it (an env
left with no uuids and no tags becomes null; version-checked `putTargets`; a failure is a warning). Audit `success`
with options, `unlinked`, creations marked.

Who: route `DELETE /projects/:id/coolify/apps/:uuid` (`deploy.coolify.manage`, CSRF, step-up per `deploy.coolify`);
panel "Sil" on linked applications and on created-but-unlinked ones in "Son oluşturmalar", always behind an inline
confirmation (volumes checkbox, off). Assistant `coolify_delete_app`: appUuid required (never guessed), a
`coolify_change` card op `delete_app` with `destructive: true`. **Destructive floor:** it runs directly only with the
call's own `execute: true` on the user's explicit instruction in that message; `isDestructiveDraft()` marks such cards
so that no automatic path (auto mode, a default-execute) runs them — they stay a card the user confirms.

## 6. Coolify API (verified with Context7 `/coollabsio/coolify-docs`, `config/openapi.json`, 2026-10-22)

- `DELETE /applications/{uuid}` query `delete_configurations`, `delete_volumes`, `docker_cleanup`,
  `delete_connected_networks` (boolean, default true) → 200 `{message}`.
- `GET /deployments/applications/{uuid}` query `skip` (0), `take` (10) → an array (some versions wrap it as
  `{count, deployments}` — both are read).
- `PATCH /applications/{uuid}`: `build_pack`, `base_directory`, `publish_directory`, `dockerfile_location`,
  `docker_compose_location`, `ports_exposes`, `is_static`, `install_command`, `build_command`, `start_command`,
  `git_branch`, `name`, `health_check_*` (the CLI's `app update` flags and the OpenAPI body). The fake Coolify refuses
  any other field with 422 like the real API.

## 7. Tests

- `apps/master/test/unit/coolify-dedupe.test.ts`: repository keys, duplicate matching (repo + branch, name, image,
  base directory / Dockerfile only when given, other environments, unknown environment), the refusal text, input
  schemas, `updateBody` / `updateMeta`, the same-turn key, `isDestructiveDraft`, the client's delete flags, deployment
  list, PATCH field refusal (fake Coolify).
- `apps/master/test/integration/coolify-dedupe.test.ts` (real master + fake Coolify): refusal by repo + branch and by
  name (409 body, audit, no row), allowDuplicate, other environment allowed; logs (action deployment, Coolify's newer
  one, hidden lines dropped, token and secret redacted, unlinked created app readable, foreign app 404, operator 403);
  update (fields, redeploy of only that app, audit without the command, undocumented field 400, unlinked 404);
  delete (control plane, its neighbour, another project's target, operator, foreign — all refused; unlinked duplicate
  and linked app deleted, volumes flag, creation marked, target unlinked, audit); assistant through the real transport
  (same-turn twin cards → one creation, duplicate → no card naming the app, logs, update with execute, secret in a
  command refused, delete stays a destructive card until confirmed, no appUuid → refused).
- `apps/master/test/integration/coolify-create.test.ts`: the domain-conflict case now passes `allowDuplicate`.
- `apps/web/test/coolify-apps.test.tsx`: settings editor (only changes sent, redeploy), delete with confirmation
  (linked with volumes, unlinked duplicate), "create a second one anyway" after the refusal, the delete / settings
  card summaries.

## 8. Real-instance check — UNVERIFIED

Fake Coolify only. With the connection of p15-coolify-create §9:

1. Projeler → demo-app → Deploy → Coolify uygulamaları → "Son oluşturmalar": the four unlinked applications show
   "Sil"; delete them (volumes unticked). Expect them gone in Coolify and the creations marked "silindi".
2. "Coolify’da yeni uygulama" for the same repository + branch → refused naming sahne-metin-main.
3. Chat: "sahne-metin neden Exited?" → `coolify_deploy_logs` shows the last deployment's log; fix via "Ayarlar"
   (port / Dockerfile location / start command) with "Kaydet ve deploy et".
4. Note any 422 from `PATCH` (a field the instance's version does not take) or a different
   `GET /deployments/applications/{uuid}` shape.

## 9. Security review

- The guard is in the master service (not only the prompt); the chat check is advisory and repeated by `create`.
- Logs: project scope + connection allowlist + deny list; redacted twice; bounded; fenced as untrusted data; project
  admins only.
- Update: documented fields only (strict schema, fake refuses others); repository paths without `..`; commands
  without control characters, secret-looking commands refused in the chat, never audited verbatim.
- Delete: project scope, deny list incl. the control plane's environment, another project's target, CSRF + step-up
  per policy, explicit confirmation in the panel, destructive card in the chat (never guessed uuid, never automatic),
  audit of every refusal and success. The uuid is checked against the Coolify uuid alphabet before it reaches a
  `LIKE` pattern or a Coolify path.
- Residual: the guard relies on Coolify reporting `git_repository` / `git_branch` / `environment_id` in
  `GET /applications`; an application created outside Coolify's API conventions might not match (the name check
  still applies).
