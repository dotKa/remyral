# Coolify API — what Remyral relies on (p6-deploy-integrations, ADR-0028)

- **Verified:** 2026-10-16 from the official docs (Context7 `/coollabsio/coolify-docs`) and the upstream OpenAPI
  document `coollabsio/coolify-docs` `main` → `config/openapi.json` (info.version `0.1`, Coolify v4 API).
- **Live status:** UNVERIFIED-LIVE — exercised only against `apps/master/test/helpers/fake-ops.ts`. The owner's first
  "Test connection" shows the instance version (`GET /version`); compare it with this page.
- Base: `<instance URL>/api/v1`, header `Authorization: Bearer <token>`. Self-hosted instances must have
  *Settings → Advanced → API access* enabled (otherwise 403) and may have an IP allowlist.

## Several instances (p13-multi-coolify, ADR-0050)

Every Coolify connection is its own base URL + team-scoped token; the endpoints below are called per connection with
that connection's token. Two teams of one instance are two connections. Nothing in the API differs between the
control-plane Coolify and an external one.

## Tokens

| Permission | Allows (docs) | Remyral |
| --- | --- | --- |
| `read` | list / inspect resources, sensitive values redacted | **needed** — the master reads every target before deploying (control-plane check, diff) |
| `read:sensitive` | logs, secrets, env values, compose | optional — only for the deployment logs view if the instance redacts them otherwise |
| `write` | create/update/delete resources | only when the connection has "manage applications" on (p15-coolify-create, ADR-0057); otherwise not needed — Test connection warns either way |
| `deploy` | deployments, restarts, stops, cancellations, deploy webhooks; "a deploy-only token cannot read" | **needed** |
| `root` | bypasses read/write/deploy checks, still team-bound | avoid |

Tokens are team-scoped (`GET /team` shows the team). 401 = wrong token/team, 403 = missing ability or API access
disabled, 429 = rate limited with `Retry-After` (seconds).

## Endpoints used

| Call | Use | Response fields used |
| --- | --- | --- |
| `GET /version` | Test connection | body text (e.g. `v4.0.0`) |
| `GET /team` | Test connection | `name` |
| `GET /applications` / `GET /applications?tag=<tag>` | Test (read probe), tag resolution | `uuid`, `name`, `fqdn`, `status`, `git_branch`, `git_commit_sha` |
| `GET /applications/{uuid}` | plan (target, deny-list by `fqdn`, diff) | as above |
| `PATCH /applications/{random}` (body `{}`) | Test: write-ability probe — 404 = ability present, 403 = missing (no resource exists, nothing changes) | status only |
| `POST /deployments/{random}/cancel` | Test: deploy-ability probe — 404 / 403 as above | status only |
| `POST /deploy?uuid=a,b[&force=true]` | `coolify.deploy` (always by resolved uuid, never by tag) | `deployments[].resource_uuid`, `.deployment_uuid`, `.message` |
| `POST /applications/{uuid}/restart` | `coolify.restart` | `deployment_uuid`, `message` |
| `GET /applications/{uuid}/rollback-images` | previous image before a deploy (best effort) | `current` |
| `POST /applications/{uuid}/rollback` `{commit}` | `coolify.rollback` | `deployment_uuid` |
| `GET /deployments/{uuid}` | status polling, logs | `status` (`queued`, `in_progress`, `finished`, `failed`, `cancelled-by-user`), `commit`, `application_name`, `deployment_url`, `logs` (JSON array of `{output, hidden}`) |
| `GET /applications/{uuid}/logs?lines=<n>&show_timestamps=true` | p12-deploy-feedback runtime logs (only resources of the project's current target, deny-list re-checked; `lines` 10–2000) — verified with Context7 `/coollabsio/coolify-docs` (OpenAPI `get-application-logs-by-uuid`), 2026-10-19 | `logs` (string); 404 = no running container. May need `read:sensitive` where the instance redacts logs |

Notes
- The ability probes rely on Coolify checking the token ability before resolving the resource; an answer other than
  403/404 is shown as "unknown".
- `restart` is `POST` in the current OpenAPI; very old v4 builds used `GET` — on 405 upgrade Coolify.
- `rollback-images` / `rollback` are recent; when absent the deploy still works and no Coolify rollback is offered.
- Not used: `GET /resources` (documented as "will be implemented later"), services/databases endpoints (phase 1
  deploys applications only).

## Application management (p15-coolify-create, ADR-0057)

Verified 2026-10-21 with Context7 `/coollabsio/coolify-docs` (`config/openapi.json`, Coolify v4 API, info.version
`0.1`). Only with "manage applications" on and a `write` token. **Live status:** UNVERIFIED-LIVE (FakeCoolify only;
steps in docs/design/p15-coolify-create.md §9).

| Call | Use | Fields sent / used |
| --- | --- | --- |
| `GET /servers` | wizard picker, create check | `uuid`, `name`, `description`, `ip`, `settings.is_reachable` / `is_usable` |
| `GET /projects` | wizard picker, create check | `uuid`, `name`, `description` |
| `GET /projects/{uuid}/environments` | wizard picker, create check | `id`, `uuid`, `name` |
| `GET /servers/{uuid}/destinations` | wizard picker (recent builds; 404 → server default) | `uuid`, `name`, `network` |
| `GET /github-apps` | private repository source | `uuid`, `name`, `organization`, `is_public` |
| `GET /security/keys` | deploy-key source | `uuid`, `name`, `fingerprint`, `is_git_related` (key material dropped) |
| `POST /applications/public` | repository, public | `project_uuid`, `server_uuid`, `environment_name`, `destination_uuid`, `git_repository`, `git_branch`, `build_pack`, `ports_exposes`, `domains`, `is_static`, `base_directory`, `publish_directory`, `install/build/start_command`, `dockerfile_location`, `docker_compose_location`, `name`, `description`, `health_check_*`, `instant_deploy: false` → `uuid` |
| `POST /applications/private-github-app` | repository via a Coolify GitHub App | as public + `github_app_uuid` |
| `POST /applications/private-deploy-key` | repository via a deploy key (SSH URL) | as public + `private_key_uuid` |
| `POST /applications/dockerfile` | Dockerfile content | `dockerfile`, `build_pack`, `base_directory` + common |
| `POST /applications/dockerimage` | ready image | `docker_registry_image_name`, `docker_registry_image_tag` + common |
| `GET /applications/{uuid}` | editors | `build_pack`, `ports_exposes`, `git_repository`, `docker_registry_image_name`, `base_directory`, `health_check_*`, `environment_id` |
| `PATCH /applications/{uuid}` | replace domains | `domains` (comma-separated) |
| `GET /applications/{uuid}/envs` | editor | `uuid`, `key`, `is_preview`, `is_buildtime`, `is_runtime`, `is_literal`, `is_multiline`, `is_shared`, `is_shown_once`; `value` only to detect a `{{scope.NAME}}` reference, otherwise dropped |
| `POST /applications/{uuid}/envs` | new variable | `key`, `value`, `is_preview`, `is_literal`, `is_multiline`, `is_buildtime` / `is_runtime` (only when not both true) |
| `PATCH /applications/{uuid}/envs` / `PATCH …/envs/bulk {data}` | change existing (one / several) | as above |
| `DELETE /applications/{uuid}/envs/{env_uuid}` | remove variable | — |
| `GET /applications` (p15-coolify-dedupe) | duplicate guard | `name`, `git_repository`, `git_branch`, `base_directory`, `dockerfile_location`, `docker_registry_image_name`, `environment_id` |
| `PATCH /applications/{uuid}` (p15-coolify-dedupe) | settings fix | `name`, `git_branch`, `build_pack`, `base_directory`, `publish_directory`, `dockerfile_location`, `docker_compose_location`, `ports_exposes`, `is_static`, `install/build/start_command`, `health_check_*` |
| `GET /deployments/applications/{uuid}?skip=0&take=` (p15-coolify-dedupe) | the application's newest deployment for its log | `deployment_uuid`, `status`, `commit`, `created_at` (array, or `{count, deployments}`) |
| `DELETE /applications/{uuid}?delete_configurations=&delete_volumes=&docker_cleanup=&delete_connected_networks=` (p15-coolify-dedupe) | delete an application of the project | all four flags sent explicitly (upstream default true; Remyral keeps volumes unless asked) → 200 `{message}` |

Errors: 422 `errors: {field: [msg]}` is shown per field; 409 `conflicts: [{domain, resource_name}]` is a domain
conflict (never overridden). Raw compose stacks (`POST /services` with `docker_compose_raw`) are not used.

## Coolify-wide management (p17-coolify-full, ADR-0057 amendment 2026-10-27)

Verified 2026-10-27 against the upstream OpenAPI documents at the release tags (`v4.5.0` … `v4.0.0-beta.420`) and
`routes/api.php` of `v4.5.0`; Context7 `/coollabsio/coolify-docs` for storages. **Live status:** UNVERIFIED-LIVE
(FakeCoolify only; steps in docs/design/p17-coolify-full.md §9). The full coverage table is in that design note §3.

| Call | Ability | Use | Fields sent / used |
| --- | --- | --- | --- |
| `GET /resources` | read | Coolify-wide list, deny checks, emptiness of projects / environments | `uuid`, `name`, `type` (`application`, `service`, `standalone-<engine>`), `status`, `environment_id`, `fqdn` |
| `GET /<applications\|databases\|services>/{uuid}/storages` | read | storages (since v4.0.0-beta.469) | `persistent_storages[]` (`uuid`, `name`, `mount_path`, `host_path`, `is_readonly`), `file_storages[]` (`uuid`, `mount_path`, `fs_path`, `is_directory`, `is_host_file`, `is_based_on_git`, `resource_uuid`; `content` only measured, never kept) |
| `POST …/storages` | write (+ deploy for content / outside paths) | add (since beta.470) | `type`, `name`, `mount_path`, `host_path` (≤ 4.2 only; 4.3+ → directory mount `is_directory` + `fs_path`), `content`, `fs_path`, `resource_uuid` (services) → the storage; Coolify stores the volume as `<uuid>-<name>` |
| `PATCH …/storages` | write | change | `uuid`, `type`, `name`, `mount_path`, `host_path` (≤ 4.2), `content` |
| `DELETE …/storages/{storage_uuid}` | write | remove | — |
| `POST /<kind>/{uuid}/start\|stop\|restart` | deploy | lifecycle | `stop?docker_cleanup=false`; services `restart?latest=true`; application start → `deployment_uuid` |
| `GET /databases/{uuid}/logs`, `GET /services/{uuid}/logs?sub_service_name=` | read:sensitive | logs | `lines`, `show_timestamps` → `logs` |
| `GET /deployments`, `POST /deployments/{uuid}/cancel` | read / deploy | running deployments, cancel | `deployment_uuid`, `status`, `application_name`, `server_name` |
| `GET /databases`, `GET /databases/{uuid}` | read | databases | `uuid`, `name`, `database_type`, `image`, `status`, `environment_id`, `is_public`, `public_port`, `limits_*`, user / database names (passwords and URLs dropped) |
| `POST /databases/<engine>` | write | create | common place fields + `postgres_user/db/password`, `mysql_*`, `mariadb_*`, `mongo_initdb_root_username`, `redis/keydb/dragonfly_password`, `clickhouse_admin_user/password`, `is_public`, `public_port`, `limits_memory`, `limits_cpus`, `instant_deploy` |
| `PATCH /databases/{uuid}` | write (+ deploy for `is_public`) | change | `name`, `description`, `image`, `is_public`, `public_port`, `limits_*`, `health_check_*` |
| `DELETE /databases\|services/{uuid}?…` | write + deploy | delete | all four flags sent explicitly |
| `GET/POST/PATCH/DELETE /databases/{uuid}/backups[/{backup}]`, `GET …/executions` | read / write (+ deploy for `backup_now`) | backups | `frequency`, `enabled`, `save_s3`, `s3_storage_uuid`, `databases_to_backup`, `dump_all`, `database_backup_retention_*_locally`, `backup_now`; executions `uuid`, `status`, `filename`, `size`, `created_at` (message dropped) |
| `GET /services`, `GET /services/{uuid}` | read | services | `uuid`, `name`, `service_type`, `status`, `environment_id`, `applications[]`, `databases[]` (compose text dropped) |
| `POST /services`, `PATCH /services/{uuid}` | write | create from a template / compose, change | `type` or `docker_compose_raw` (base64, panel only), place fields, `name`, `description`, `urls`, `instant_deploy` |
| `GET/POST/PATCH/DELETE /services/{uuid}/envs` | read / write | service variables | as application variables (values never kept) |
| `GET /servers/{uuid}`, `/resources`, `/domains` | read | server details | `proxy_type`, `port`, settings; validation logs and SSH user dropped |
| `POST /servers/{uuid}/validate` | write | server check | body `{}` (never `install`) |
| `POST /projects`, `DELETE /projects/{uuid}`, `POST/DELETE /projects/{uuid}/environments[/{name}]` | write | projects / environments | `name`, `description` |
| `GET /applications/{random}/logs` | read:sensitive | Test connection: the `read:sensitive` probe (404 present, 403 missing) | status only |

An unknown path answers `404 {"message":"Not found.","docs":…}` (the catch-all route); the client maps it to
`unsupported` ("this Coolify version has no such endpoint"), a missing resource stays `not_found`.

