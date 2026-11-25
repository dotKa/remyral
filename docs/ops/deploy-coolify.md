# Deploying the control plane on Coolify

Covers `p1-data-services` and `p1-environments`: the master + web images, Postgres, Redis and their
wiring as one Coolify **Docker Compose** resource per environment, on a Linux host (for example an EC2 instance)
prepared as in [§10](#10-host-perimeter-and-access). Files:

| File | Purpose |
|---|---|
| `apps/master/Dockerfile` | Master API image. Modes: `serve` (default), `migrate`, `admin:create`, `admin:reset`. |
| `apps/web/Dockerfile` | Static console on nginx-unprivileged, same security headers as the master. Proxies nothing. |
| `infra/coolify/compose.yaml` | The Coolify resource: `postgres`, `redis`, `migrate` (one-shot), `master`, `web` + Traefik labels. |
| `infra/coolify/local/proxy.compose.yaml` | Local stand-in for `coolify-proxy`, used only by `pnpm e2e:compose`. |
| `scripts/e2e/compose-coolify.mjs` | `pnpm e2e:compose`: builds the images and runs the whole bundle end to end (19 checks). |

## 1. Architecture

```
client ─TLS─▶ Cloudflare (proxied, Full strict) ─TLS─▶ coolify-proxy / Traefik :443 (Origin Certificate)
   ├─ Host(D) && /api, /api/*            ─ strip /api ─▶ master:8080   (priority 100)
   ├─ Host(D) && /v1/worker, /v1/worker/releases/*   ─▶ master:8080   (WebSocket; priority 100)
   ├─ Host(D) && /api/healthz|readyz|v1/worker*      ─▶ web → 404     (priority 200: not public)
   └─ Host(D) && everything else                     ─▶ web:8080      (priority 1, SPA fallback)
master ─▶ postgres:5432 (role remyral_app) and redis:6379 on the private "internal" network
migrate (role remyral_owner) runs to completion before master starts
```

- **Networks.** `internal` (compose-private): postgres, redis, migrate, master. `coolify` (external, the
  proxy's network): master and web only. No service publishes a host port; Postgres and Redis are never
  reachable from the proxy or the internet (T-CP-6).
- **Probes.** `/healthz` and `/readyz` are **not public**: Docker healthchecks call them inside the
  container. `/api/healthz`, `/api/readyz` and `/api/v1/worker*` are routed to the web server, which
  answers 404 for every `/api` path. Bare `/healthz` is just a console route. The public uptime probe is
  `/api/status` (cached `{"status":"ok"}`/`unavailable` only; [monitoring.md](monitoring.md)).
- **Database roles** (created by an initdb hook on the first start of an empty volume):
  - `postgres` — superuser, used only by the container itself (local peer auth) and for break-glass.
  - `remyral_owner` — owns the database, schema `public` and every table; used only by `migrate`.
  - `remyral_app` — runtime role of the master: `SELECT/INSERT/UPDATE/DELETE` via default privileges,
    no `TRUNCATE`, no DDL, owns nothing. It therefore **cannot disable the append-only triggers**
    (`ALTER TABLE … DISABLE TRIGGER` needs ownership) — the gap noted in p1-master-auth, p4-job-store
    and p4-approvals. `pnpm e2e:compose` proves it (`must be owner`, `permission denied`).
  - `pg_trgm` is created by the init hook (migration 0008's `CREATE EXTENSION IF NOT EXISTS` is a no-op).
  - Host auth is `scram-sha-256`.
- **Redis**: `requirepass`, AOF (`appendfsync everysec`) + RDB snapshots, `maxmemory 256mb` with
  `noeviction` (BullMQ requirement), named volume.
- **Client IP.** Cloudflare → Traefik → master: `TRUST_PROXY_HOPS=1`, so `request.ip` is the address
  that reached Traefik (a Cloudflare edge). The master then uses `CF-Connecting-IP` **only** if that
  address is in `TRUSTED_CLIENT_IP_SOURCES` (Cloudflare's ranges, default in the compose file) and the
  header is exactly one valid IP (`apps/master/src/http/client-ip.ts`, new flags
  `TRUSTED_CLIENT_IP_HEADER` / `TRUSTED_CLIENT_IP_SOURCES`). A direct-to-origin request with a forged
  header keeps its real address. Requirement: Coolify's Traefik must **not** run with
  `forwardedHeaders.insecure=true` or `trustedIPs` covering the internet on the `https` entry point
  (default Coolify config does not) — otherwise X-Forwarded-For becomes forgeable.
- **Hardening.** migrate/master/web: read-only root fs, `/tmp` tmpfs, `cap_drop: ALL`,
  `no-new-privileges`, non-root (master uid 10001, web uid 101), memory limits. Images contain no
  secrets, no `.env`, no sources/tests/dev dependencies (checked by the e2e).
- **Environments.** One Coolify resource per environment. `REMYRAL_ENV` (`prod`, `staging`) namespaces
  the compose project and every Traefik router/middleware/service name, so both can run on one host
  with different `REMYRAL_DOMAIN`s, volumes and secrets directories.

## 2. Images: build and transfer (no registry yet)

The repo is not on GitHub, so Coolify cannot build from git. **Recommended: build locally with buildx
for `linux/amd64`, ship with `docker save | ssh docker load`, record the digests.** (Alternative: rsync
the tree to the host and build there — slower on a t3.medium and puts sources on the server.)

```sh
TAG=$(git rev-parse --short=12 HEAD)          # immutable tag per commit; never "latest"
docker buildx build --platform linux/amd64 --load -f apps/master/Dockerfile -t remyral-master:$TAG .
docker buildx build --platform linux/amd64 --load -f apps/web/Dockerfile    -t remyral-web:$TAG .
docker image inspect remyral-master:$TAG remyral-web:$TAG --format '{{.Id}} {{index .RepoTags 0}}' \
  | tee -a docs/ops/deployed-images.log        # or keep this record outside the repo
docker save remyral-master:$TAG remyral-web:$TAG | gzip \
  | ssh <user>@<host> 'gunzip | sudo docker load'
ssh <user>@<host> \
  "sudo docker image inspect remyral-master:$TAG remyral-web:$TAG --format '{{.Id}}'"   # must match
```

The compose file uses `pull_policy: never` (`REMYRAL_PULL_POLICY`), so Coolify uses the loaded images and
never tries a registry. Keep at least the previous tag loaded on the host for rollback (§8). When a
registry exists (p1-cicd), push by digest and set `REMYRAL_MASTER_IMAGE=registry/…@sha256:…`,
`REMYRAL_PULL_POLICY=always`.

## 3. Secrets

### 3.1 Files on the host (key material)

Per environment, a directory readable only by the master's uid (10001), mounted read-only at
`/run/secrets/remyral`:

```sh
ENV=prod
sudo install -d -m 0700 -o 10001 -g 10001 /data/remyral/$ENV/secrets
cd /data/remyral/$ENV/secrets
# TOTP encryption key: base64 of 32 random bytes
sudo sh -c 'umask 077; head -c 32 /dev/urandom | base64 > totp.key'
# Lease-signing key: Ed25519 PKCS#8 PEM (must not be group/other readable)
sudo sh -c 'umask 077; openssl genpkey -algorithm ed25519 -out lease-signing.pem'
sudo chown 10001:10001 totp.key lease-signing.pem && sudo chmod 0400 totp.key lease-signing.pem
```

p16-ops-safety: Settings → Operations safety → Keys and expiry shows the age of these files (modification time only;
the master never reads them) and reminds owners and admins before the recommended rotation (lease / webhook HMAC /
skills / OIDC keys 365 days, TOTP key 730 days). After replacing one, record it:
`docker exec <master container> remyral-master secrets:rotated file:lease-key` (`--list` prints every item and id).

Back both files up **off the host** (password manager / secret manager) right away: losing `totp.key`
makes every enrolled TOTP secret undecryptable (all users must be reset); losing the lease key only
invalidates in-flight leases. Optional files in the same directory (set the `*_FILE` variable to
`/run/secrets/remyral/<name>`): `smtp-password`, `notify-webhook-hmac` (≥ 32 bytes), `github-app.pem`, `skills-panel.pem` (ADR-0021:
`sudo sh -c 'umask 077; openssl genpkey -algorithm ed25519 -out skills-panel.pem'`, owned by 10001, mode 0400; set
`SKILLS_PANEL_KEY_FILE`).

**Web Push (p8-pwa, optional, generated once):** the VAPID key pair, an EC P-256 private key:
`sudo sh -c 'umask 077; openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out vapid.pem'`,
owned by 10001, mode 0400 (or `pnpm --filter @remyral/master vapid:keygen /abs/path/vapid.pem`, which refuses to
overwrite). Set `PUSH_VAPID_PRIVATE_KEY_FILE=/run/secrets/remyral/vapid.pem` and `PUSH_VAPID_SUBJECT` (an operator
`mailto:` address or `https://` URL the push services may contact). Back it up with the other keys: a new key
invalidates every push subscription (users turn push on again in Settings → Devices). Without both variables the
push channel is simply unavailable. Details: [p8-pwa.md](../design/p8-pwa.md) §5.

### 3.2 Coolify environment variables

**p17-panel-settings — "default; the panel overrides":** for the variables listed in
[p17-panel-settings §3](../design/p17-panel-settings.md#settings-moved-from-the-environment-to-the-panel)
(`NOTIFY_WEBHOOK_*`, `PUSH_*`, `NOTIFY_SMTP_*`, `SEARCH_HTTP_*` / the HTTP or Bedrock choice, `TRUST_PROXY_HOPS`,
`TRUSTED_CLIENT_IP_*`, `AUTH_REMEMBER_*`, `AUTH_TRUSTED_DEVICE_DAYS`, `WORKER_ROTATION_REQUIRES_APPROVAL`,
`LOGIN_WAIT_MINUTES`, `JOB_OUTPUT_MAX_FILES`, `LOG_STORE_RETENTION_DAYS` / `_LEVEL` / `_REQUESTS`, `MEMORY_*` thresholds,
`WORKFLOW_ENGINE_V2(_FOR_V1)`, `OPS_*`, `SKILLS_PANEL_KEY_FILE`) the environment value is only the **default**: a value
saved in Ayarlar → Sunucu ayarları wins (no redeploy needed) until "Ortam değişkenine dön". The panel shows each
setting's source. `SEARCH_PROVIDER=off` and `MEMORY_AUTO_LEARN=off` stay kill switches the panel cannot override.

Set in the resource's **Environment Variables** page. Mark the secret ones as such ("Is Literal" on, so
`$` in generated passwords is not interpolated).

| Variable | Secret | Value / how to generate |
|---|---|---|
| `REMYRAL_ENV` | no | `prod` (or `staging`) |
| `REMYRAL_DOMAIN` | no | `console.example.org` |
| `REMYRAL_MASTER_IMAGE` | no | `remyral-master:<TAG>` |
| `REMYRAL_WEB_IMAGE` | no | `remyral-web:<TAG>` |
| `REMYRAL_SECRETS_DIR` | no | `/data/remyral/prod/secrets` |
| `POSTGRES_SUPERUSER_PASSWORD` | yes | `openssl rand -hex 32` |
| `REMYRAL_DB_OWNER_PASSWORD` | yes | `openssl rand -hex 32` |
| `REMYRAL_DB_APP_PASSWORD` | yes | `openssl rand -hex 32` |
| `REMYRAL_DB_BACKUP_PASSWORD` | yes | `openssl rand -hex 32` — read-only backup role (optional; [backups.md](backups.md) §3) |
| `REDIS_PASSWORD` | yes | `openssl rand -hex 32` |
| `PROXY_NETWORK` | no | default `coolify` (the proxy's network) |
| `TRUST_PROXY_HOPS` | no | default `1` |
| `TRUSTED_CLIENT_IP_HEADER` | no | default `cf-connecting-ip` |
| `TRUSTED_CLIENT_IP_SOURCES` | no | default: Cloudflare ranges of 2026-10-13 (compose file) |
| `RELEASE_PUBLIC_KEYS` | no | from `node scripts/release/sign.mjs keygen` (empty: release uploads refused) |
| `LOG_LEVEL`, `DATABASE_POOL_MAX`, `LEASE_TTL_MS`, `WORKER_ROTATION_REQUIRES_APPROVAL` | no | optional |
| `LOGIN_WAIT_MINUTES` | no | default 30: a job waits this long for a signed-out runtime to be logged in again (p10-claude-login-health); 0 fails it at once |
| `JOB_OUTPUT_MAX_FILES` | no | default 500 (1–2000): output files per workspace job, inline + storage together; the files beyond it are packed into one `out-rest.zip` (p17-output-limits). Ayarlar → Sunucu ayarları → İşler overrides it; a workspace project may lower it |
| `NOTIFY_SMTP_*`, `NOTIFY_WEBHOOK_*`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` | file paths only | optional, see `.env.example` |
| `WORKFLOW_ENGINE_V2`, `WORKFLOW_ENGINE_V2_FOR_V1` | no | both default `false` (p14-workflow-engine, ADR-0055). `WORKFLOW_ENGINE_V2=true` turns the new workflow engine on: v2 definitions (control flow, data, timers, approvals, sub-workflows — phase 14.1) may be saved and run, the Diyalog editor shows the new node types (`GET /auth/session` → `features.workflowEngineV2`), and the expression sandbox (worker threads inside the master process, 2 × 64 MiB heap) starts on first use. To turn it on: set the variable in the Coolify environment of the master service and redeploy; to turn it off again, set it back — new v2 saves and runs are refused (`engine_v2_disabled`), runs already on engine 2 finish (a code rollback freezes them instead). `WORKFLOW_ENGINE_V2_FOR_V1=true` (phase 14.5, needs `WORKFLOW_ENGINE_V2=true`) also starts **new** runs of version-1 (AI-only) workflows on engine 2; runs already in progress keep the engine they started on and finish there (the engine is stored per run), so the switch needs no drain. Before switching, run the read-only dry run in the master container: `docker exec <master container> remyral-master workflow:normalise-check` (Coolify → master → Terminal: `remyral-master workflow:normalise-check`; or `pnpm --filter @remyral/master workflow:normalise-check` from a checkout with the production `DATABASE_URL`) — it must print `failures: 0` and `ready: …`; it also prints how many version-1 workflows move and how many runs are open per engine. Rollback: set it back to `false` and redeploy — new version-1 runs start on engine 1 again, open engine-2 runs finish on engine 2 |
| `SKILLS_PUBLIC_KEYS` | no | public key(s) of the owner's offline skills key, from `node scripts/skills/sign.mjs keygen`: one or two base64url Ed25519 keys, comma-separated (empty and no panel key: skill uploads refused, jobs get no skills; p6-skills) |
| `SKILLS_PANEL_KEY_FILE` | file path only | optional: `/run/secrets/remyral/skills-panel.pem` — signs chat-authored skills (ADR-0021) and skills imported in the panel (folder / zip / GitHub, ADR-0054); unset it to revoke both |
| `PUSH_VAPID_PRIVATE_KEY_FILE`, `PUSH_VAPID_SUBJECT` | file path / contact only | optional, both or neither: `/run/secrets/remyral/vapid.pem`, `mailto:ops@…` (p8-pwa Web Push); `PUSH_ENDPOINT_ALLOWLIST` overrides the default push services |
| `SEARCH_PROVIDER`, `SEARCH_BEDROCK_REGION`, `SEARCH_BEDROCK_MODEL`, `SEARCH_BEDROCK_DIMENSIONS` | no | optional semantic search + memory dedupe (p10-semantic-memory): `bedrock`, `us-east-1` (the control plane's region), default `cohere.embed-multilingual-v3` ([p10-semantic-memory.md](../design/p10-semantic-memory.md) §3). Preferred since p10-bedrock-integration-panel: leave these empty and enter region, model and keys in Settings → Integrations → AWS Bedrock (takes precedence over env, §11); `SEARCH_PROVIDER=off` is the kill switch (ignores the panel) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN`) | **yes** | optional: keys of an IAM user allowed only `bedrock:InvokeModel` on the embedding model (policy in [proje-hafizasi.md](../guide/tr/proje-hafizasi.md)); master only. Leave empty when the instance has an instance profile with that permission (preferred). `AWS_REGION` is the fallback region |
| `MEMORY_SUGGEST_INTERVAL_MS`, `MEMORY_DUPLICATE_THRESHOLD` | no | optional: memory-suggestion pass period (default `60000`, `0` = off) and the semantic duplicate threshold (default `0.9`) |
| `MEMORY_CHAT_PER_THREAD_DAY` | no | optional: memory suggestions read from shared project-linked chat per conversation per 24 h (default `5`, `0` = chat is not read; p10-chat-memory-suggestions) |
| `MEMORY_AUTO_LEARN` | no | optional: `off` switches automatic acceptance and merging of memory suggestions off everywhere (default `on`; each project's "Otomatik öğrenme" setting applies only while on; p17-auto-learning) |
| `RELATED_WORK`, `RELATED_WORK_CONTEXT` | no | optional: `RELATED_WORK=off` switches similar past jobs, "solved before" failure hints, duplicate warnings and the job-context block off; `RELATED_WORK_CONTEXT=off` only the block in job contexts (both default `on`; p17-embeddings) |

Hex passwords avoid URL-escaping problems in `DATABASE_URL`/`REDIS_URL` (built by the compose file).
The DB role passwords are applied **only on the first start of an empty Postgres volume**; to rotate
later, `ALTER ROLE … PASSWORD` as `postgres` and then change the variable. Never paste secrets into
the compose text itself.

## 4. TLS: Cloudflare Origin Certificate (separate step)

The stack runs without it — Traefik then serves its built-in self-signed default certificate, which is
enough for the pre-TLS smoke test (§6) but **not** for Cloudflare *Full (strict)*. When the certificate
is available:

1. Cloudflare → SSL/TLS → Origin Server → Create certificate (RSA or ECDSA, hostnames
   `console.example.org` (+ `*.example.org` if staging shares it), 15 years). Save the cert (PEM) and
   key locally; never paste the key into the Coolify UI.
2. Copy to the host (Coolify mounts `/data/coolify/proxy` at `/traefik` in the proxy container):
   ```sh
   ssh … 'sudo install -d -m 700 /data/coolify/proxy/certs'
   scp origin.pem origin.key <user>@<host>:/tmp/
   ssh … 'sudo mv /tmp/origin.pem /tmp/origin.key /data/coolify/proxy/certs/ \
          && sudo chmod 600 /data/coolify/proxy/certs/origin.key && sudo chown root:root /data/coolify/proxy/certs/*'
   ```
3. Coolify UI → Servers → (server) → Proxy → **Dynamic Configurations** → Add `remyral-origin-cert.yaml`:
   ```yaml
   tls:
     certificates:
       - certFile: /traefik/certs/origin.pem
         keyFile: /traefik/certs/origin.key
   ```
   Traefik watches the directory; no restart. Our routers use `tls=true` without a certresolver, so the
   certificate is chosen by SNI from this file.
4. Cloudflare SSL/TLS mode → **Full (strict)**. Verify:
   `openssl s_client -connect <elastic-ip>:443 -servername console.example.org </dev/null | openssl x509 -noout -issuer`
   shows `CloudFlare Origin CA`.

## 5. Create the Coolify resource

1. Through the SSH tunnel (§10), Coolify → Projects → new project `remyral` →
   environment `production` → **+ New → Docker Compose Empty**.
2. Paste `infra/coolify/compose.yaml` verbatim.
3. Leave the **Domains** field of every service **empty** (routing comes from the labels; a Coolify
   domain would add a competing router and a Let's Encrypt attempt).
4. Keep "Connect to Predefined Network" **off** (master/web already join `coolify` explicitly).
5. Set the variables of §3.2; save.
6. In Coolify the `migrate` service shows as "exited" after each deploy — expected (one-shot). If your
   Coolify version supports it, add `exclude_from_hc: true` to `migrate` in the Coolify editor (it is not
   valid plain Compose, so it is not in the repo file).

## 6. First deploy and smoke test (works before the certificate)

1. Secrets files (§3.1) and images (§2) are on the host. **Deploy** in Coolify.
2. Order is enforced by compose: postgres/redis healthy → `migrate` exits 0 → master + web.
   Logs: `sudo docker logs <migrate container>` shows `migrations: N applied`.
3. Pre-TLS smoke test through a tunnel to the proxy (Traefik's default cert, hence `-k`):
   ```sh
   ssh -N -L 18443:127.0.0.1:443 -L 18080:127.0.0.1:80 <user>@<host> &
   R="--resolve console.example.org:18443:127.0.0.1"
   curl -sk $R https://console.example.org:18443/api/auth/session -o /dev/null -w '%{http_code}\n'  # 401
   curl -sk $R https://console.example.org:18443/ | grep -c 'id="root"'                              # 1
   curl -sk $R https://console.example.org:18443/api/healthz -o /dev/null -w '%{http_code}\n'        # 404
   curl -s --resolve console.example.org:18080:127.0.0.1 -o /dev/null -w '%{http_code}\n' \
     http://console.example.org:18080/                                                               # 301/308
   ```
   Also check that only the intended routers exist:
   `sudo docker inspect <master container> --format '{{json .Config.Labels}}' | tr , '\n' | grep traefik`.
4. After §4, the same checks against `https://console.example.org/` from anywhere (no `-k`).

## 7. Create the owner account

On the host, with a TTY (the CLI refuses to run without one; the password is typed, never an argument):

```sh
sudo docker exec -it $(sudo docker ps -qf name=master -f label=com.docker.compose.project=remyral-prod) \
  remyral-master admin:create
```

Then log in on the console and enroll TOTP (docs/ops/admin-bootstrap.md). `admin:reset` works the same way.

## 8. Rollback, upgrades, operations

- **Deploys and rollbacks are scripted** (p1-cicd): `node scripts/deploy/deploy.mjs [--env staging]` and
  `… rollback` — [cicd.md](cicd.md); they need the host (`--host` / `REMYRAL_DEPLOY_HOST`) and the console domain
  (`REMYRAL_DEPLOY_DOMAIN_PROD` / `REMYRAL_DEPLOY_DOMAIN_STAGING`). The manual procedure below remains the fallback.
- **App rollback**: set `REMYRAL_MASTER_IMAGE`/`REMYRAL_WEB_IMAGE` back to the previous tag (still loaded on
  the host) and redeploy. Migrations are forward-only: an older master refuses to start if the database
  has a migration it does not know (`downgrade refused`), so rolling back across a migration needs a
  database restore (p1-backups). Note in the deploy record which tags introduced migrations.
- **Upgrade**: load new images, change the two image variables, redeploy; `migrate` applies new files
  first, the master starts only if it succeeded.
- **Postgres/Redis versions** are pinned by digest; a major Postgres upgrade needs dump/restore.
- **Backups (p1-backups)**: encrypted 15-minute `pg_dump` + recovery secrets to S3 in a separate
  account/region, host systemd timer, read-only role `remyral_backup` (`REMYRAL_DB_BACKUP_PASSWORD`,
  optional variable). Setup, restore and DR runbook: [backups.md](backups.md). Redis is not backed up
  (ADR-0003).
- **Staging**: a second resource with `REMYRAL_ENV=staging`, another domain (e.g.
  `console-staging.example.org`), its own secrets dir `/data/remyral/staging/secrets` and passwords.

## 9. Local verification

`pnpm e2e:compose` (Docker + openssl; `--skip-build` reuses images, `--keep` leaves everything up):
builds the images, starts a Traefik stand-in with a dev-CA certificate for a test domain
via the file provider, runs `infra/coolify/compose.yaml` with random credentials and throw-away
volumes, and checks: migrations applied by `remyral_owner`; master connected as `remyral_app`;
`remyral_app` cannot disable triggers / truncate / create / update / delete audit rows; no published
ports; Redis needs AUTH and has AOF; `/api/auth/session` 401 via strip-prefix; console + SPA fallback +
caching; the 13 security headers identical between web and master; probes not public; HTTP → HTTPS;
owner created in the master container → login → TOTP enrollment through the proxy; a containerised
worker pairs, is approved and goes online over `wss://` through the proxy; `CF-Connecting-IP`
honoured only when the peer is in `TRUSTED_CLIENT_IP_SOURCES`. Everything is removed afterwards.

**Not verifiable locally** (check on the first real deploy): Coolify's handling of the pasted compose
(labels kept, external `coolify` network attached, no generated routers), Coolify's Traefik entry point
names (`http`/`https`) and forwarded-header settings, Cloudflare → origin TLS.

## 10. Host perimeter and access

Generic rules for the single Linux host that runs Coolify and the control plane. Values in angle brackets are yours
(`<host>` is the SSH alias or address of the host, `<user>` its admin user, `<elastic-ip>` its public address).

**Baseline.** A current Ubuntu LTS (or another distribution from [selfhost-install.md](selfhost-install.md)), at least
2 vCPU and 4 GiB of memory plus swap. `infra/ec2/bootstrap.sh` (idempotent; `--dry-run` first) applies OS updates and
unattended security upgrades, UTC and chrony, swap, key-only sshd, ufw (22/80/443) and installs Coolify with its official
script (the script's sha256 is logged). On AWS: enforce IMDSv2, encrypt the EBS volume, and give the instance a role
with only what it needs (for example SSM Session Manager and the CloudWatch agent, see [monitoring.md](monitoring.md)).

**Perimeter.** The cloud firewall (on AWS the **security group**) is the real perimeter: ports published by Docker
bypass ufw. Coolify publishes 8000 (UI), 6001/6002 (realtime / terminal) and the proxy's 8080 (Traefik dashboard) on
`0.0.0.0`; they **must stay closed** from the outside. Inbound rules:

| Port | Source | Why |
| --- | --- | --- |
| 22/tcp | your admin IP only (or closed when you use SSM Session Manager) | administration over SSH |
| 80/tcp, 443/tcp | the CDN's address ranges when the console sits behind Cloudflare (otherwise `0.0.0.0/0`) | HTTPS |
| everything else | — | closed |

Check from a machine outside the host's network that only the intended ports answer (for example `nc -vz <elastic-ip>
8000` must fail). Disable the Traefik dashboard if you do not use it.

**Access.**

- SSH with keys only; prefer an alias in `~/.ssh/config` (`IdentitiesOnly yes`) and use the same alias as the deploy
  host (`--host` / `REMYRAL_DEPLOY_HOST`, [cicd.md](cicd.md)). OpenSSH 10's `PerSourcePenalties` can lock out the admin
  IP after failed or aborted connections; if that happens, exempt that IP in a drop-in under `/etc/ssh/sshd_config.d/`
  (`PerSourcePenaltyExemptList`). The deploy scripts always open fresh connections (`ControlMaster=no`,
  `ControlPath=none`, `BatchMode=yes`).
- The Coolify UI is never public on port 8000. Put it behind the console's forward-auth gate and SSO
  ([coolify-sso.md](coolify-sso.md)), and keep an SSH tunnel as the break-glass path:

  ```sh
  ssh -N -L 8000:localhost:8000 <user>@<host>    # then open http://localhost:8000
  ```

- **The first account registered in Coolify becomes its admin.** Register immediately after installing, through the
  tunnel, with a strong password and 2FA.

**DNS and TLS.** The console name (for example `console.example.org`) points at the host, directly or through
Cloudflare (proxied). Behind Cloudflare use SSL mode **Full (strict)** with an Origin Certificate on the Coolify proxy
(§4); until then the Cloudflare → origin hop is encrypted but not authenticated.

**Small hosts: build off the host.** On a 2 vCPU / 4 GiB host the master's TypeScript build inside `docker build` can
swap for a long time and starve the running stack. Build on a workstation and load the images over SSH instead:

```sh
node scripts/deploy/build-local.mjs            # HEAD, or: build-local.mjs <commit>
node scripts/deploy/deploy.mjs --no-host-build
```

`build-local.mjs` exports the commit with `git archive`, builds the images for `linux/amd64` with the same revision
labels and `docker load`s them on the host; the deploy reuses them and records / signs / verifies their image IDs as
usual. `--no-host-build` refuses to fall back to a build on the host.

**Coolify's network.** The master joins Coolify's `coolify` network, where Coolify's own services are also called
`postgres` and `redis`. Never address the control plane's database by a bare service name: the compose file uses the
aliases `remyral-pg` and `remyral-redis`.

**Secrets on the host.** `<data dir>/<env>/secrets/` and `<data dir>/<env>/stack.env` (§3) hold the only copy of the
key material: back them up off the host ([backups.md](backups.md)).

## 11. Tam IDE origin (optional)

"Tam IDE" serves the IDE from its own origin, for example `https://ide.console.example.org` ([ADR-0066](../adr/0066-ide-stream-plane-and-origin.md)).
Until the steps below are done the console says "Tam IDE bu sunucuda ayarlı değil" and the code viewer works as before.
Do them in this order, then roll out a worker release with `ide-v1` to the Linux machines.

1. **DNS:** a record for the IDE name pointing at the same origin as the console (Cloudflare: a proxied CNAME to the
   console name, or an A record to `<elastic-ip>`). Cloudflare's WebSocket support must stay on (default).
2. **TLS:** the certificate the proxy serves must cover the new name. With a Cloudflare Origin Certificate, issue one for
   the console name and `*.<console name>` (or add the IDE name) and install it like the console's (§4). Cloudflare's
   edge certificate covers one level of subdomain on the zone's plan; a deeper name needs Advanced Certificate Manager —
   check the edge certificate in the dashboard.
3. **Proxy router** (compose labels of the master service, or a Traefik dynamic file): the IDE host goes to the master
   **without** the `/api` strip, every path:
   ```yaml
   - traefik.http.routers.${REMYRAL_PROJECT:-remyral-prod}-ide.rule=Host(`${REMYRAL_IDE_DOMAIN}`)
   - traefik.http.routers.${REMYRAL_PROJECT:-remyral-prod}-ide.entrypoints=${PROXY_ENTRYPOINT:-https}
   - traefik.http.routers.${REMYRAL_PROJECT:-remyral-prod}-ide.tls=true
   - traefik.http.routers.${REMYRAL_PROJECT:-remyral-prod}-ide.priority=100
   - traefik.http.routers.${REMYRAL_PROJECT:-remyral-prod}-ide.service=${REMYRAL_PROJECT:-remyral-prod}-master
   ```
   (`infra/coolify/compose.yaml` carries these lines commented out next to the master's routers; enable them once
   `REMYRAL_IDE_DOMAIN` is set — Traefik refuses a router with an empty `Host()`.) No forward-auth gate on this router:
   the IDE origin authenticates with its own ticket-bound cookie; the master answers only the IDE routes on that host.
4. **Master setting:** `IDE_ORIGIN=https://ide.console.example.org` in `stack.env` (the compose file passes it), then
   redeploy the master. The master refuses an `IDE_ORIGIN` whose host equals the console host.
5. **Check:** `curl -sI https://ide.console.example.org/healthz` → 404 (console routes never answer there);
   `curl -sI https://ide.console.example.org/w/00000000-0000-4000-8000-000000000000/` → 401 page; in the console
   Projeler → proje → Kod shows the Tam IDE panel with the Linux machines.

Rollback: remove `IDE_ORIGIN` (Tam IDE off at once; workspaces stay on the machines), then the router and the DNS record.
