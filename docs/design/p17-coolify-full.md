# p17-coolify-full — manage Coolify completely from Remyral (panel + assistant)

Status: implemented (branch `p17-coolify-full`), real instance UNVERIFIED (§9). Backlog: `p17-coolify-full`. ADR-0057
amendment 2026-10-27. Migration 0176. Builds on p6-deploy-integrations,
p13-multi-coolify (ADR-0050), p15-coolify-create / p15-coolify-dedupe (ADR-0057).

## 1. Owner direction (2026-10-27)

"coolify ı tamamen yönetebilmeliyiz." Trigger: asked to give `remyral-site-preview` a persistent `/data` (its
database was lost on every deploy), the assistant answered "Volume bağlı değil, bağlamak için de aracım yok …
Persistent Storage eklemek bunların arasında yok. Mevcut bir volume olup olmadığını da göremiyorum" and sent the owner
to Coolify. Everything the Coolify API can do for an owner's day-to-day work must be possible from the panel and the
assistant; what the API cannot do is named with the exact Coolify screen.

## 2. Source of truth

- Context7 `/coollabsio/coolify-docs` ("Application Storages CRUD", persistent-storage guide, CLI `storage create`).
- Upstream OpenAPI `coollabsio/coolify` `openapi.json` at the release tags (read 2026-10-27): `v4.5.0` (current, 301
  operations), `v4.4.7`, `v4.3.24`, `v4.2.1`, `v4.1.3`, `v4.0.1`, `v4.0.0`, `v4.0.0-beta.420` … `beta.474`; and the
  route file `routes/api.php` of `v4.5.0` for the token ability of each route.
- Version facts that matter (verified from the tagged OpenAPI documents):
  - Application storages: `GET` / `PATCH /applications/{uuid}/storages` since **v4.0.0-beta.469**; `POST` and
    `DELETE …/storages/{storage_uuid}` since **v4.0.0-beta.470**. Database and service storages appear with them.
  - `host_path` on a persistent storage: in the API up to **v4.2.x**; removed in **v4.3.0** (a host directory is a
    *directory mount*: `type: file`, `is_directory: true`, `fs_path`).
  - `POST /applications/{uuid}/storages` stores the volume as `<app uuid>-<name>` (v4.5.0 controller).
  - A path the instance does not know answers `404 {"message":"Not found.","docs":"https://coolify.io/docs"}` (the
    catch-all route) — a resource that does not exist answers 404 without `docs`. The client maps the first to
    `unsupported`, so "this Coolify version has no such endpoint" is told apart from "no such resource".
- Abilities (routes/api.php v4.5.0): reads `read`; logs `read:sensitive`; creates / updates / storages / backups /
  projects / environments `write`; start / stop / restart / deploy / cancel `deploy`; deleting an application,
  database or service `write` + `deploy`; a file mount outside the resource directory or with content `deploy`.

## 3. Coverage table

Legend: **today** = before this wave; **added** = this wave (p17-coolify-full); **not** = deliberately not offered
(reason). "Panel" / "Asistan" say where it is reachable when added.

### Applications

| Endpoint group | Today | This wave | Not (reason) |
| --- | --- | --- | --- |
| list / get (`GET /applications`, `/applications/{uuid}`) | yes (targets, editors, dedupe) | Coolify-wide list per connection (panel Kaynaklar, asistan `coolify_resources`) | — |
| create (public / GitHub App / deploy key / Dockerfile / image) | yes (p15-coolify-create) | — | — |
| update (`PATCH /applications/{uuid}`: build, domains, health check …) | yes (domains, build settings, health check, watch paths) | resource limits fields (`limits_memory`, `limits_cpus` …) on update | — |
| delete | yes (project apps, dedupe) | name confirmation + "what is lost" (volumes) in the answer | — |
| envs CRUD + bulk | yes (values never stored) | — | — |
| start / stop / restart | restart only (ops action) | start, stop, restart per app (project panel + Coolify-wide + asistan `coolify_lifecycle`) | — |
| logs (`GET …/logs`) | yes (deploy feedback, dedupe) | Coolify-wide logs of any app (asistan `coolify_logs`) | — |
| deployments: by app, one, cancel, running list | by app + one | running list (`GET /deployments`), cancel (`POST /deployments/{uuid}/cancel`) | — |
| rollback, rollback images | yes (ops action) | — | — |
| **storages** (persistent volumes, file / directory mounts): list, create, update, delete | **no** (the trigger) | **yes**: list with warnings, add volume (name, mount path, optional host path), add file / directory mount, update, remove (name confirmation) — project panel, Coolify-wide, asistan `coolify_storage` | — |
| storage backups (`PUT/DELETE …/storages/{s}/backups`, `…/backups/run`) | no | — | new in v4.5 only; volume backups go to S3 storages Remyral does not manage — later wave |
| previews (PR deployments) | no | — | preview deployments come from Git pushes; Remyral's preview is a separate deploy target |
| scheduled tasks | no | — | cron jobs inside the container are an app concern; later wave |
| tags | no | — | Remyral targets by uuid; tags only for `coolify.deploy` tag targets |
| clone / move / migrate between servers or instances | no | — | infra moves with downtime; done in Coolify by the operator |
| destinations of an application (multi-server) | no | — | multi-server deployments are not used |
| secret manager (`PATCH …/secret-manager`) | no | — | external secret managers are outside Remyral's secret boundary |

### Databases

| Endpoint group | Today | This wave | Not (reason) |
| --- | --- | --- | --- |
| list / get | no | yes (no passwords or connection URLs — the client drops them) | — |
| create (postgresql, mysql, mariadb, mongodb, redis, keydb, dragonfly, clickhouse) | no | yes (panel + asistan `coolify_database`); passwords left to Coolify (generated) — the panel may set them, the assistant never | sqlite (`POST /databases/sqlite`, v4.5 only) |
| update (name, image, public port, limits, health check) | no | yes (non-secret fields) | password / conf fields from the assistant (secret) |
| delete | no | yes, name confirmation, volumes kept unless asked | — |
| start / stop / restart | no | yes | — |
| logs | no | yes (`read:sensitive`) | — |
| backups: list, create, update, delete config, executions | no | yes (list, create, update, delete, run now via `backup_now`, executions) | deleting a single execution file (rarely needed; in Coolify) |
| storages | no | yes (same model as applications) | — |
| envs | no | — | database variables are the engine's credentials (secret) |
| imports (upload a dump) | no | — | uploads of database dumps carry production data; done in Coolify |
| clone / move / migrate, tags | no | — | as for applications |

### Services (one-click and compose)

| Endpoint group | Today | This wave | Not (reason) |
| --- | --- | --- | --- |
| list / get | no | yes (no `docker_compose_raw` kept) | — |
| create from a one-click template (`type`) | no | yes (`type`, name, server / project / environment, urls, instant deploy) | raw compose content from the assistant (untrusted text); the panel may paste it |
| update (name, description, urls) | no | yes | — |
| delete | no | yes, name confirmation, volumes kept unless asked | — |
| start / stop / restart | no | yes | — |
| envs list / set / delete | no | yes (values never stored, secret refusal as for apps) | — |
| logs (per sub-service) | no | yes (`read:sensitive`) | — |
| storages | no | yes (sub-resource `resource_uuid`) | — |
| sub-applications / sub-databases start / stop / patch | no | — | the service as a whole is started / stopped; sub-resources in Coolify |
| scheduled tasks, tags, clone / move / migrate, imports | no | — | as above |

### Servers

| Endpoint group | Today | This wave | Not (reason) |
| --- | --- | --- | --- |
| list | yes (wizard) | Coolify-wide view | — |
| get, resources, domains | no | yes | — |
| validate (`POST /servers/{uuid}/validate`) | no | yes, without `install` | `install: true` (installs Docker / restarts the daemon — in Coolify) |
| create / update / delete, cloud providers (Hetzner, DigitalOcean, Vultr, Hostinger) | no | — | adds or removes machines and SSH access — infrastructure change done by the owner in Coolify |
| proxy, sentinel, log drains, docker cleanup, registries, cloudflare tunnel, transfer | no | — | server-level infrastructure; Coolify → Servers |
| destinations (list per server) | yes (wizard) | — | — |

### Projects, environments, team, keys, sources

| Endpoint group | Today | This wave | Not (reason) |
| --- | --- | --- | --- |
| projects list | yes | — | — |
| project create / delete | no | yes (delete: name confirmation, only empty projects — Coolify refuses others) | rename (`PATCH /projects`) — cosmetic, later |
| environments list | yes | — | — |
| environment create / delete | no | yes (delete: only empty — Coolify refuses others) | — |
| shared variables (team / project / environment / server) | no | — | shared variables are secrets of many resources; Coolify → Shared Variables |
| private keys list | yes (no key material) | — | create / update / delete (SSH key material through Remyral) |
| GitHub Apps list | yes | — | create / update / delete (OAuth app setup in Coolify) |
| GitLab Apps | no | — | as GitHub Apps |
| teams / members (`GET /team`, `/teams`) | team (test) | — | membership is Coolify's own user management |
| resources (`GET /resources`) | no | yes (the Coolify-wide overview) | — |
| version, health | version (test) | version-aware features (storages, host path) | — |
| notifications, instance e-mail settings, S3 storages, cloud tokens, cloud-init scripts, audit events, enable / disable API / MCP | no | — | instance administration and credentials; Coolify → Settings (root tokens) |

## 4. What the API cannot do — and how the owner is told

- **Older instances without storages** (before v4.0.0-beta.469 / .470): the master knows it from the connection test's
  version, or from the `unsupported` 404 when the version is unknown, and answers: "This Coolify (vX) has no storage
  API (added in v4.0.0-beta.470). In Coolify: <project> → <environment> → <application> → Persistent Storage → + Add →
  Volume Mount → name, destination path `/data` → Save, then Redeploy." The panel shows the same text; the assistant
  repeats it instead of "aracım yok".
- **A host path on a v4.3+ instance**: there is no persistent volume with a host path any more; the master creates a
  directory mount (`fs_path`) and says so.
- **Volume contents**: Coolify has no API to copy data into a new volume. A new volume is empty; the container's
  current data at that path is lost at the next redeploy unless copied first (the answer says this every time).
- **Everything in the "not" column** is named in the assistant prompt with its Coolify screen (Servers → <server> →
  Proxy / Sentinel / Docker Cleanup, Settings → Notifications, Keys & Tokens, Sources …).

## 5. Master

- **Client** (`apps/master/src/ops/coolify.ts`): typed parsers for every call of §3 "added" that drop passwords,
  connection URLs, variable values, file contents (size only), compose text, validation logs and the SSH user;
  `coolifyFeatures(version)` (storages `full` / `read` / `none` / `unknown`, volume host path up to 4.2); the catch-all
  404 → `unsupported`; the probe gains `readSensitive`. `CoolifyHandle.lastTest` carries the last test's version and
  abilities.
- **Service** (`coolify-resources.ts`, `CoolifyResourceService`): one implementation for both scopes — a connection
  (`coolify-connection:<id>` audit target, direct Coolify redeploy / restart) and a project application
  (`CoolifyAppService` resolves the linked-or-created application and its authorized connection first; `project:<id>`
  audit target; the redeploy is the project's `coolify.deploy` ops action of that application only). Rules of every
  write: manage switch (409 `coolify_manage_disabled`), probe-aware ability check (409
  `coolify_token_lacks_write|deploy|read_sensitive`, before Coolify is called), deny list (403
  `control_plane_resource`; destructive next to the control plane 403 `control_plane_environment`), typed confirmation
  (400 `confirmation_mismatch`), audit `ops.coolify.<area>.<op>` success / failure / denied with keys, paths and
  sizes only.
- **Storages**: add a volume (name, mount path, optional host path → `host_path` on ≤ 4.2, a directory mount on 4.3+,
  unknown version: try `host_path`, on its 422 a directory mount), a file mount (content, needs `deploy`) or a host
  directory; change; remove (typed volume name or mount path; says what is lost). The volume path is remembered in
  `coolify_data_paths`; the view warns for remembered paths and for bare data paths variables name
  (`DATABASE_PATH=/data/site.db`, `file:/data/x.sqlite`) that no volume / directory covers. The answer of every add
  says that the volume starts empty and the container's data at that path is lost at the redeploy unless copied.
- **Databases**: create (engine fields mapped per engine; password only from the panel, else generated by Coolify),
  change (non-secret fields), delete (typed name; volumes kept unless asked; lists them), backups (schedule, change,
  run now = `backup_now`, delete the schedule, executions).
- **Services**: create from a one-click template (the panel may paste compose), change (name, description, URLs),
  variables (as applications; optional restart), delete (typed name).
- **Servers / projects / environments**: details, resources, domains, check (never `install`); create / delete
  projects and environments (only empty ones — refused before Coolify with the count).
- **Application delete** (p15-coolify-dedupe) now takes the typed name (when given; the panel always sends it) and
  answers with `lost` (the application; its volumes kept unless asked, by name).
- **Application settings** take resource limits (`limitsMemory`, `limitsCpus` → `limits_memory`, `limits_cpus`).

## 6. Routes and RBAC

| Route | Action | Step-up event |
| --- | --- | --- |
| `GET /projects/:id/coolify/apps/:uuid/storages` | `deploy.coolify.read` | — |
| `POST /projects/:id/coolify/apps/:uuid/storages`, `PATCH …/storages/:storage` | `deploy.coolify.manage` | `deploy.coolify` |
| `DELETE /projects/:id/coolify/apps/:uuid/storages/:storage?confirm=` | `deploy.coolify.manage` | `coolify.destructive` |
| `POST /projects/:id/coolify/apps/:uuid/start\|restart` | `deploy.coolify.manage` | `deploy.coolify` |
| `POST /projects/:id/coolify/apps/:uuid/stop` | `deploy.coolify.manage` | `coolify.destructive` |
| `GET /integrations/coolify/connections/:id/resources[/:kind/:uuid[/storages\|/logs]]`, `/servers/:uuid`, `/projects/:uuid/environments`, `/databases/:uuid/backups/:backup/executions` | `coolify.read` | — |
| `POST …/resources/:kind/:uuid/storages`, `PATCH …/storages/:storage`, `POST …/start\|restart`, `POST …/deployments/:uuid/cancel`, `POST …/databases`, `PATCH …/databases/:uuid`, `POST\|PATCH …/backups`, `POST …/services`, `PATCH …/services/:uuid`, `PUT …/services/:uuid/envs`, `POST …/servers/:uuid/validate`, `POST …/projects`, `POST …/projects/:uuid/environments` | `coolify.manage` | `coolify.manage` |
| `DELETE …/storages/:storage`, `POST …/stop`, `DELETE …/databases/:uuid`, `DELETE …/backups/:backup`, `DELETE …/services/:uuid`, `DELETE …/projects/:uuid`, `DELETE …/projects/:uuid/environments/:environment` | `coolify.manage` | `coolify.destructive` |

`coolify.read` / `coolify.manage`: global, admin (API token scope `admin`). Both new events are off in Serbest and on
in Dengeli / Sıkı (not the safe core: owner direction 2026-10-21 keeps Coolify changes out of it); the typed name is
always required for deletions.

## 7. Panel

- **Projeler → Deploy → Coolify uygulamaları** (`deploy-coolify.tsx`): per linked application, next to Değişkenler /
  Alan adları / Ayarlar / Sil: **Depolama** (`CoolifyStoragePanel`: the list, the red "kalıcı değil" warnings, the
  amber "no persistent storage" notice, add volume / file / server folder with the empty-volume notice, remove after
  the typed name, the manual step of an old Coolify instead of the add button), **Başlat / durdur** (status, Başlat,
  Yeniden başlat, Durdur behind a confirmation) and **Loglar** (build log of the last deployment + container output,
  refresh). Sil now asks for the application's name.
- **Ayarlar → Entegrasyonlar → Coolify**: each usable connection gets **Kaynaklar**
  (`integrations-coolify-resources.tsx`): a kind picker (Uygulamalar, Veritabanları, Servisler, Sunucular, Projeler,
  Süren deploy'lar); per resource Depolama, Başlat / durdur, Loglar; databases: Yedekler (schedule, run now, delete) and
  a typed-name Sil; services: a variable (password field) with restart and Sil; servers: domains and "Bağlantıyı
  denetle"; projects: environments (add / delete) and Sil; running deploys: İptal et. New database / service / project
  forms use the same server / project / environment pickers. The control plane shows "kontrol düzlemi (salt okunur)"
  and no write buttons; without "Uygulama yönetimi" everything is read-only with a notice. The test result shows the
  `read:sensitive` flag.
- **Chat cards** (`coolify_change`, `op: resource`): the operation, the resource and where, the arguments (file content
  as its size), the volume notice on a new storage, the destructive warning.

Feature parity (nothing removed): every existing test id, aria-label, handler and link of `deploy-coolify.tsx`,
`integrations-coolify.tsx` and `summary.ts` is still there (diffed before finishing); the delete button of an
application is disabled until the name is typed (owner rule for deletions).

## 8. Assistant

Read tools `coolify_resources` (what is on a connection), `coolify_resource` (one resource with storages, data-path
warnings, the manual step, or a server), `coolify_logs`; draft tools `coolify_storage`, `coolify_lifecycle` (incl.
cancel), `coolify_database` (incl. backups), `coolify_service` (incl. variables), `coolify_infra` (projects,
environments, server check). A resource is named by uuid or Coolify name; with `project` and a project application the
card runs under the project (project admin, deploy policy for the redeploy), else Coolify-wide (administrators). The
default volume name is `<first word of the resource>-<last path part>` (`remyral-data` for `/data`). Cards carry
`destructive: true` for removals, stops and deletions (never run by a default or automatic mode) and the typed name
(`confirm`). No password field; secret-looking variable values and file contents are refused. System prompt rule 51:
never "aracım yok" for these, always the empty-volume notice and the redeploy as the next step, the manual step when
`unsupported`, the exact Coolify screen for what the API cannot do (§3 "not"). Trigger scenario
(`coolify-full.test.ts`): `coolify_resource {resource: remyral-site-preview}` → storages + "no storage" next step →
`coolify_storage {op: add, mount: volume, mountPath: /data}` → card "add volume remyral-data → /data" with the notice
and the redeploy step → confirmed → volume created in (fake) Coolify, audited `via: chat`.

## 9. Real-instance check — UNVERIFIED

Tested only against `apps/master/test/helpers/fake-ops.ts` (FakeCoolify, which refuses undocumented fields like the
v4.5 controllers). Steps for the owner:

1. Ayarlar → Entegrasyonlar → Coolify → the connection → Test: note the version and the four permission flags
   (`read:sensitive` new). Turn on "Uygulama yönetimi" if writes are wanted (token: read, read:sensitive, write,
   deploy).
2. Kaynaklar → Uygulamalar → `remyral-site-preview` → Depolama: the owner added the `/data` volume by hand on
   2026-10-27 — expect it listed (`<uuid>-<name>` → `/data`) and no "kalıcı değil" warning for `/data`. On a test
   application: add a volume `test-data` → `/data`, Başlat / durdur → Yeniden başlat (or Deploy → redeploy), check
   Coolify → Persistent Storage, then remove it with its typed name. If the instance is older than v4.0.0-beta.470,
   expect the manual step instead.
3. Loglar on that application and on a database (needs `read:sensitive`).
4. Veritabanları → Yeni veritabanı (postgresql, no password) → check it in Coolify; Yedekler → schedule `0 3 * * *`,
   Şimdi yedekle → an execution appears; Sil with the typed name (volumes kept).
5. Servisler → Yeni servis (`uptime-kuma`) → start / stop → Sil.
6. Projeler → Yeni proje → an environment → delete both.
7. Chat: "remyral-site-preview /data'ya kalıcı volume bağla" → the assistant reads the storages and offers the card
   with the notice; confirm.
8. Report any 422 field message (a field this instance's version does not know).

