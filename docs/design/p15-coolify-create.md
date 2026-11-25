# p15-coolify-create — deploy without ever opening Coolify

Status: implemented (2026-10-21), real instance UNVERIFIED (§9). ADR-0057. Migration 0123. Backlog:
`p15-coolify-create`.

## 1. Owner direction (2026-10-21)

"Deploy work without ever opening Coolify." Remyral could list, deploy, restart, roll back, follow deployments and read
logs. Missing: creating the application, its environment variables, its domains, and the listings needed for that.

## 2. Coolify API (verified with Context7 `/coollabsio/coolify-docs`, OpenAPI `config/openapi.json`, 2026-10-21)

Version assumption: Coolify v4 API as documented on `main` (info.version `0.1`), the same as docs/compat/coolify.md.
Used endpoints and fields are listed in docs/compat/coolify.md §"Application management". Key facts relied on:

- `POST /applications/public|private-github-app|private-deploy-key` require `project_uuid`, `server_uuid`,
  `environment_name` or `environment_uuid`, `git_repository`, `git_branch`, `build_pack` (`nixpacks`, `railpack`,
  `static`, `dockerfile`, `dockercompose`); plus `github_app_uuid` / `private_key_uuid`. `POST /applications/dockerfile`
  requires `dockerfile` (content), `POST /applications/dockerimage` `docker_registry_image_name` (+ tag). Answer
  `201 {uuid}`. Unknown fields are refused with 422, so `createBody` sends only documented fields per endpoint.
- `domains` is a comma-separated list; 409 `{conflicts: [{domain, resource_name}]}` on a domain conflict
  (`force_domain_override` is never sent). `autogenerate_domain` (default true) may give an empty-domain application
  an sslip.io domain — Remyral does not send it.
- Variables: `GET/POST/PATCH /applications/{uuid}/envs`, `PATCH …/envs/bulk {data}`, `DELETE …/envs/{env_uuid}`;
  `is_preview`, `is_literal`, `is_multiline`; `is_buildtime` / `is_runtime` are in the env model and are sent only
  when not both true (older builds refuse unknown fields).
- Listings: `GET /servers`, `/projects`, `/projects/{uuid}/environments`, `/servers/{uuid}/destinations` (recent;
  404 on older builds → "server default"), `/github-apps`, `/security/keys` (key material dropped by the client).
- Docker Compose: an application from the repository with build pack `dockercompose` and `docker_compose_location`.
  Raw compose content is a Coolify *service* (`POST /services`, base64 `docker_compose_raw`) — out of scope.

## 3. Model (`apps/master/src/ops/coolify-apps-model.ts`)

`CoolifyCreateAppInput` (strict): env (deploy target), connection?, server, coolifyProject, environment (name),
destination?, name?, description?, source (`repository` {access public|github_app|deploy_key, githubApp?, privateKey?,
branch?} | `dockerfile` {dockerfile} | `image` {image, tag?}), buildPack?, ports?, isStatic?, base/publish directory,
dockerfile/compose location, install/build/start command, domains (normalised https URLs, no IPs / credentials /
wildcards), healthCheck?, envs (≤ 100), link add|replace|none, deploy, idempotencyKey. `CoolifySetEnvsInput`
(set {key, value | shared, preview?, scope both|runtime|buildtime, literal?, multiline?} or {key, remove}) and
`CoolifySetDomainsInput` (the complete list, deploy?).

## 4. Master service (`apps/master/src/ops/coolify-apps.ts`)

- **Connection**: explicit, else the env target's, else the default — always through `CoolifyConnections.forAction`
  (ADR-0050 project allowlist). `manage_apps` must be on (409 `coolify_manage_disabled`).
- **Create**: idempotency first (`coolify_app_creations` unique project + key; a retry answers with the earlier row,
  a `creating` row older than 10 min is closed as "outcome unknown", never re-created). The server, Coolify project
  and environment must exist on the connection; refused (403 `control_plane_environment`, audited `denied`) when a
  deny-listed resource lives in that environment or the server / project / environment / destination uuid itself is
  deny-listed; domains are checked against the console host and the deny-listed applications' domains. Then
  `POST /applications/<kind>` with `instant_deploy: false`, the variables one by one, the target link through
  `OpsService.putTargets` (version-checked), and — on request — `coolify.deploy` with `only: [uuid]` (§6). A failure
  after creation (a variable, the link, the deploy) is a warning on the result; the creation is never undone.
- **Variables**: only for an application linked to the project's target and passing the deny list; create missing,
  update existing (single PATCH, or bulk for several), delete removed; optional redeploy of only that application.
- **Domains**: replace via `PATCH /applications/{uuid}` `{domains}`; optional redeploy.
- **Build suggestion** (`coolify-detect.ts`): root listing + `package.json` of the GitHub repository (fixed host
  api.github.com, panel GitHub App read-only token for private repositories): Dockerfile → `dockerfile`; compose file
  → `dockercompose`; static front-end (vite/astro/… build to dist, or `index.html` only) → nixpacks static with the
  publish directory; else nixpacks with port 3000. The repository is untrusted: it only pre-fills the wizard.
- **Audit**: `ops.coolify.app.create|envs|domains` — connection, request summary (keys and sources, never a value),
  `via` api|chat, result.

## 5. Routes (`coolify-app-routes.ts`) and RBAC

| Route | Action |
|---|---|
| `GET /projects/:id/coolify/options?connection&env&coolifyProject&server` | `deploy.coolify.read` |
| `GET /projects/:id/coolify/suggestion?branch` | `deploy.coolify.read` |
| `GET /projects/:id/coolify/apps` (linked + recent creations) | `deploy.coolify.read` |
| `GET /projects/:id/coolify/apps/:uuid` (domains, build settings, variable keys) | `deploy.coolify.read` |
| `POST /projects/:id/coolify/apps` | `deploy.coolify.manage`, CSRF, step-up |
| `PUT /projects/:id/coolify/apps/:uuid/envs` | `deploy.coolify.manage`, CSRF, step-up |
| `PUT /projects/:id/coolify/apps/:uuid/domains` | `deploy.coolify.manage`, CSRF, step-up |

Both actions are project admin. The step-up check is waived unless the security policy's event `deploy.coolify`
(category deploy; off in Serbest, on in Dengeli / Sıkı; fresh installs now start on Dengeli) asks for a code.

## 6. Deploy after creation

`CoolifyDeployParams.only` (≤ 20 uuids) narrows a `coolify.deploy` to resources of the target; a uuid that is not part
of the target is 409 `not_in_target`. The new application's first deploy is therefore an ordinary ops action: the
project's deploy policy decides (production usually waits for an approval), and the deploy list / detail follow it.

## 7. Panel (Diyalog Projeler → Deploy → "Coolify uygulamaları")

`deploy-coolify.tsx`: linked applications with Değişkenler / Alan adları editors; "Coolify’da yeni uygulama" wizard —
deploy target, connection, server, Coolify project, environment (pickers loaded from Coolify; the only server, the
project named like the Remyral project and the environment named like the target are preselected), destination when a
server has several, source (repository with access mode and GitHub App / deploy key pickers, image, Dockerfile), build
pack / ports / static / directories pre-filled from the suggestion, domains, health check path, variables (values in
password fields, or a shared-variable reference; scope build / runtime), link mode, "first deploy". The result links to
the deploy action. Ayarlar → Entegrasyonlar → Coolify gets the "Uygulama yönetimi" switch. Strings in
`@remyral/i18n` `coolifyApps` (TR + EN).

## 8. Assistant

`coolify_create_app`, `coolify_set_env`, `coolify_set_domains` (packages/protocol assistant tools, prompt rule 28):
draft tools with `execute` (ADR-0056 pattern) — `execute: true` on an explicit instruction runs at once through the
draft executor (role re-check, security-policy event `deploy.coolify`), otherwise a `coolify_change` card. The master
fills defaults and, when a choice is ambiguous, answers with the options so the assistant asks for exactly that.
Secret-looking keys / values are refused (no card is stored with them).

## 9. Real-instance check — UNVERIFIED

Tested only against `apps/master/test/helpers/fake-ops.ts` (FakeCoolify). Steps for the owner:

1. Coolify → Keys & Tokens: a token with `read`, `deploy`, `write` for the team that hosts project apps (not the
   control plane's, if possible).
2. Ayarlar → Entegrasyonlar → Coolify: edit the connection, enter the token, tick "Uygulama yönetimi", Test — no
   "lacks write" warning; note the version (`GET /version`) and compare with docs/compat/coolify.md.
3. Projeler → <project> → Deploy → "Coolify’da yeni uygulama": choose server / project / environment, keep the
   suggestion, add `NODE_ENV=production`, a test domain, "first deploy" → Oluştur. Expect the application in Coolify
   with the build pack / port / domain, the variable present (value visible only in Coolify), the target linked and a
   deploy action in Deploy.
4. Değişkenler: add one, remove one, "Kaydet ve deploy et". Alan adları: add one. Check in Coolify.
5. Repeat 3 with a private repository via the Coolify GitHub App and once with a deploy key; once with an image.
6. Chat: "shop projesi için Coolify'da preview uygulaması oluştur" → card / direct run.
7. Report any 422 field message (an endpoint field the instance's version does not know).

## 10. Security review

- Values: request bodies are not logged by Fastify; values are never written to `coolify_app_creations`, audit, chat
  cards (refused there) or answers; `GET …/envs` values are dropped by the client; private keys from
  `/security/keys` are dropped.
- Control plane: allowlist + deny list on every path; domains of the console refused; no deletes (since p15-coolify-dedupe: deletes of the project's own applications, see that design note); no
  `force_domain_override`.
- Untrusted repository: suggestion only pre-fills; nothing read is executed.
- Abuse of `only`: narrows only (checked against the resolved target).
- Residual risk: the `write` token can change any resource of its Coolify team; the control-plane environment check
  relies on Coolify reporting `environment_id` on applications (the uuid deny list covers the rest).
