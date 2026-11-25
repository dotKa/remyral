# Cloudflare API v4 — what Remyral relies on (p6-deploy-integrations, ADR-0028)

- **Verified:** 2026-10-16 from the official API reference (Context7 `/websites/developers_cloudflare_api`,
  `/websites/developers_cloudflare_pages`; developers.cloudflare.com/api/…).
- **Live status:** UNVERIFIED-LIVE — exercised only against `apps/master/test/helpers/fake-ops.ts`.
- Base `https://api.cloudflare.com/client/v4` (not configurable from the panel), `Authorization: Bearer <API token>`.
  Answers are `{success, errors[], messages[], result, result_info?}`; 429 carries `Retry-After`.

## Token (create in the dashboard → My Profile / Manage Account → API Tokens)

| Permission | Scope | Needed for |
| --- | --- | --- |
| Zone → DNS → Edit | only the zones the projects may change | `dns.upsert`, `dns.delete` |
| Zone → Zone → Read | same zones | listing zones in Test connection |
| Account → Cloudflare Pages → Edit | the account | `pages.deploy`, `pages.rollback`, Pages project list |

## Endpoints used

| Call | Use |
| --- | --- |
| `GET /accounts/{account_id}/tokens/verify`, fallback `GET /user/tokens/verify` | Test: `result.status` (`active`/`disabled`/`expired`), `expires_on` |
| `GET /zones?account.id=…&per_page=50&page=n` | Test (permitted zones), deploy-target validation |
| `GET /zones/{zone_id}/dns_records?name.exact=…&type=…` | plan: current record, console-host record contents |
| `GET /zones/{zone_id}/dns_records?per_page=1` | p10-publish-bundle: Test connection — can the token read the zone's records (`per_page` minimum 1, Context7 /websites/developers_cloudflare_api, 2026-10-18); 401/403 → "missing Zone → DNS → Edit" |
| `POST /zones/{zone_id}/dns_records` `{type,name,content,ttl,proxied}` | create (ttl 1 = automatic, else 60–86400) |
| `PATCH /zones/{zone_id}/dns_records/{dns_record_id}` (same body) | update |
| `DELETE /zones/{zone_id}/dns_records/{dns_record_id}` | delete (`result.id`) |
| `GET /accounts/{account_id}/pages/projects` | Test (Pages access) |
| `GET /accounts/{account_id}/pages/projects/{project_name}` | plan: `production_branch`, `domains`, `subdomain` |
| `GET …/pages/projects/{project_name}/deployments?env=production&per_page=5` | the production deployment before a deploy (rollback target) |
| `GET …/pages/projects/{project_name}/deployments/{deployment_id}` | status polling: `latest_stage.name/status`, `url` |
| `POST …/pages/projects/{project_name}/deployments/{deployment_id}/rollback` | `pages.rollback` |
| `GET …/pages/projects/{project_name}/upload-token` | Direct Upload: short-lived `result.jwt` |
| `POST /pages/assets/check-missing` `{hashes}` (JWT) | Direct Upload: hashes still to upload |
| `POST /pages/assets/upload` `[{key, value(base64), metadata:{contentType}, base64:true}]` (JWT) | Direct Upload |
| `POST /pages/assets/upsert-hashes` `{hashes}` (JWT) | Direct Upload |
| `POST …/pages/projects/{project_name}/deployments` multipart: `manifest` (JSON path → hash), `branch`, `commit_message`, `commit_dirty` | create the deployment (`id`, `url`, `environment`) |

| `POST /accounts/{account_id}/pages/projects` `{name, production_branch}` (no `source` → Direct Upload project) | `pages.create_project` (p6-pages-create) |
| `GET …/pages/projects/{project_name}/domains` | `pages.add_domain` plan: attached already? |
| `POST …/pages/projects/{project_name}/domains` `{name}` | `pages.add_domain`: attach (`status`, `validation_data`, `verification_data`) |
| `GET …/pages/projects/{project_name}/domains/{domain_name}` | `pages.add_domain`: validation status read-back (polled) |

Notes
- Pages project names (reference, `project_name`): start with a lowercase letter or digit; only lowercase letters,
  digits, hyphens. Remyral also caps at 58 characters and refuses a trailing hyphen (length not stated in the fetched
  reference — UNVERIFIED-LIVE). Cloudflare may append a suffix to the `pages.dev` name; Remyral stores `result.subdomain`.
- Asset keys: Remyral uses the first 32 hex characters of SHA-256 over base64(content) + file extension. The API
  documents the key only as "file content hash" (wrangler uses BLAKE3 for the same purpose). **To be confirmed on the
  first live run**; if Cloudflare rejects the keys, phase 2 switches to a pinned `wrangler pages deploy` on a worker
  with a short-lived Pages-only token — not before a new ADR.
- p10-site-upload: assets up to **25 MiB** each (Pages limit, developers.cloudflare.com/pages/platform/limits, Context7
  2026-10-18); Remyral sends `assets/upload` batches of ≤ 50 files and ≈ 30 MiB of base64 (our choice — the API does not
  state a batch limit; UNVERIFIED-LIVE) with a 120 s time-out; video content types `video/mp4`, `video/webm`.
- Pages custom domains: since p6-pages-create Remyral **adds** them (`pages.add_domain`, attach first, then the CNAME —
  the Pages docs warn that a CNAME without the attach gives 522). It never removes a domain or deletes a project.
- The production branch decides the environment: a deploy to `production_branch` is production (approval + step-up).

## Preview tunnels (p8-preview-tunnels, ADR-0032)

Verified 2026-10-16 with Context7 (`/websites/developers_cloudflare_api`, `/cloudflare/cloudflare-docs`:
create-remote-tunnel-api, run-parameters, Access applications / policies / service tokens). UNVERIFIED-LIVE.

### Extra token permissions

| Permission | Scope | Needed for |
| --- | --- | --- |
| Account → Cloudflare Tunnel → Edit | the account | create / configure / rotate / delete preview tunnels, read the connector token |
| Account → Access: Apps and Policies → Edit | the account | `access` and `service-token` protected previews |
| Account → Access: Service Tokens → Edit | the account | `service-token` protected previews only |
| Zone → DNS → Edit, Zone → Read | the preview zone | the CNAME of each preview (as for `dns.*`) |

Test connection probes the first three with list calls (`GET /accounts/{id}/cfd_tunnel?per_page=1&is_deleted=false`,
`GET /accounts/{id}/access/apps?per_page=1`, `GET /accounts/{id}/access/service_tokens?per_page=1`). A list call cannot
tell Read from Edit; Edit is proven by the first preview. `access` (e-mail) protection also needs the account's
**One-time PIN** login method enabled in Zero Trust → Settings → Authentication (not checked by the API).

### Calls

| Call | Use |
| --- | --- |
| `POST /accounts/{account_id}/cfd_tunnel` `{name, config_src: "cloudflare"}` | a remotely-managed tunnel (answer: `id`, `token`) |
| `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` `{config: {ingress: [{hostname, service: "http://localhost:<port>", originRequest: {httpHostHeader: "localhost:<port>"}}, {service: "http_status:404"}]}}` | the one ingress rule + catch-all (the Host header is rewritten so dev servers' host checks accept the preview) |
| `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token` | the connector token (`result` is the string); fetched for every TUNNEL_START, never stored |
| `PATCH /accounts/{account_id}/cfd_tunnel/{tunnel_id}` `{tunnel_secret}` | rotate (stable tunnel re-attached to another job): earlier tokens stop working |
| `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` | drop connectors after a rotation / before delete |
| `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}` | close (revokes the token) |
| `POST /zones/{zone_id}/dns_records` `{type: "CNAME", name, content: "<tunnel id>.cfargotunnel.com", ttl: 1, proxied: true}` | the preview hostname |
| `POST /accounts/{account_id}/access/apps` `{type: "self_hosted", name, domain, session_duration: "24h", policies: [{name, decision: "allow", include: [{email: {email}}…]}]}` | e-mail allowlist (one-time PIN) |
| same with `policies: [{name, decision: "non_identity", include: [{service_token: {token_id}}]}]` | service-token protection |
| `POST /accounts/{account_id}/access/service_tokens` `{name, duration: "<hours>h"}` | the only answer carrying `client_secret` |
| `DELETE /accounts/{account_id}/access/apps/{app_id}`, `DELETE /accounts/{account_id}/access/service_tokens/{id}` | close |

Notes
- Hostnames are ONE label under the zone (`[prefix-]<name>-<random>.<zone>`): Universal SSL covers the apex and
  first-level subdomains only.
- Connector: `cloudflared tunnel --no-autoupdate run --token-file <file>` (`--token-file` needs cloudflared ≥ 2025.4.0;
  pinned 2026.10.3 — worker tool recipe `cloudflared`, GitHub release asset digests). Readiness is taken from the log
  line "Registered tunnel connection" (UNVERIFIED-LIVE).

## p12-deploy-feedback (2026-10-19, Context7 `/websites/developers_cloudflare_api`)

| Call | Use | Response fields used |
| --- | --- | --- |
| `GET /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}` | deploy logs: the deployment's stages | `stages[]` (`name`, `status`, `started_on`, `ended_on`), `latest_stage`, `url` |
| `GET /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/history/logs` | deploy logs: the build log (Pages Read or Pages Edit) | `data[]` (`ts`, `line`), `total` |

Direct Upload deployments may have no build log; the stages still answer. UNVERIFIED-LIVE (fakes only).

## Quick tunnels for services (p15-services, 2026-10-21)

Context7 `/cloudflare/cloudflared` (cmd/cloudflared/tunnel/cmd.go `TunnelCommand`, quick_tunnel.go
`quickTunnelStartupLines`): `cloudflared tunnel --url http://localhost:<port>` runs a quick tunnel when `--quick-service`
is non-empty (default `https://api.trycloudflare.com`) and no `--name` is given; it prints "Your quick Tunnel has been
created! Visit it at (it may take some time to be reachable):" and the `https://<random>.trycloudflare.com` URL on the
next line; "Registered tunnel connection" follows as for named tunnels. The worker runs it with `--no-autoupdate`, an
empty worker-owned HOME (no user config file, which would turn the call into an error) and no credential. UNVERIFIED on
real hosts.

