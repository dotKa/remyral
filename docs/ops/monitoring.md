# Monitoring, uptime and log shipping (control plane)

Covers `p1-monitoring` (host + container metrics, uptime check, log shipping with redaction). Application
telemetry and alert rules: [`docs/design/p6-observability.md`](../design/p6-observability.md). SLOs this
feeds: [slo.md](slo.md) (SLO-1 availability). Host: [deploy-coolify.md §10](deploy-coolify.md#10-host-perimeter-and-access).

| File | Purpose |
|---|---|
| `infra/monitoring/cloudformation.json` | Log groups (retention + masking policy), alert SNS topic, Route 53 uptime check, dashboard, metric filter, host alarms (p6-alerts) |
| `infra/monitoring/cloudwatch-agent.json` | CloudWatch agent: CPU / memory / swap / disk metrics, EMF listener on 127.0.0.1:25888 |
| `infra/monitoring/container-stats.sh` + `remyral-container-stats.{service,timer}` | Per-container `Up` / `Healthy` / CPU % / memory % once a minute (EMF → CloudWatch metrics) |
| `infra/monitoring/install-host.sh` | Idempotent host installer (`--dry-run`); verifies the agent package's GPG signature |
| `infra/monitoring/compose.awslogs.yaml` | Compose overlay: master / migrate / web stdout → CloudWatch Logs (`awslogs` driver) |
| `apps/master/src/routes/health.ts` `statusRoutes` | Public uptime probe `GET /api/status` |
| `apps/master/src/logging.ts` `redactingLogStream` | Pattern redaction of every master log line before it leaves the process |

## 1. What is watched, and from where

```
UptimeRobot / Better Stack (outside AWS) ──┐
Route 53 health checkers (AWS, optional) ──┼─HTTPS─▶ Cloudflare ─▶ Traefik ─▶ master GET /status ─▶ {"status":"ok"}
                                            │
EC2 host ── CloudWatch agent ── CPU/mem/swap/disk ───────────────▶ CloudWatch Metrics  Remyral/Host
         └─ container-stats.timer ─ EMF (udp 127.0.0.1:25888) ──▶ CloudWatch Metrics  Remyral/Containers
Docker daemon ─ awslogs driver ─ master/migrate/web stdout ──────▶ CloudWatch Logs     /remyral/<env>/containers
AWS/EC2 (built in, free) ─ CPUUtilization, CPUCreditBalance, StatusCheckFailed
```

| Signal | Source | Metric |
|---|---|---|
| Control plane reachable (SLO-1) | external probe + Route 53 | `/api/status` = `{"status":"ok"}` |
| t3 CPU credits | EC2 (5-min, free) | `AWS/EC2 CPUCreditBalance`, `CPUUtilization` |
| CPU steal / iowait | agent | `Remyral/Host cpu_usage_active`, `cpu_usage_steal`, `cpu_usage_iowait` |
| Memory, swap | agent | `mem_used_percent`, `mem_available`, `swap_used_percent` |
| Disk `/` | agent | `disk_used_percent`, `disk_inodes_used` |
| Containers | `container-stats.sh` | `Remyral/Containers Up`, `Healthy`, `CpuPercent`, `MemoryPercent` × {master, web, postgres, redis}, dimensions `Environment`, `Service` |
| Error log lines | metric filter `{ $.level >= 50 }` | `Remyral/Logs/<env> ErrorLines` |

Host metrics carry `InstanceId` only (`aggregation_dimensions`), so alarms and the dashboard do not depend on
device names. Cost (us-east-1, 2026 list prices): ~21 custom metrics ≈ USD 6.30/month, logs ingestion at
the current volume < USD 1/month, Route 53 HTTPS + string-match check ≈ USD 2.75/month, data protection
scanning < USD 0.10/month.

## 2. Uptime check

### 2.1 The probe: `GET https://console.example.org/api/status`

- Routed like every `/api/*` path (prefix stripped) to the master's `GET /status`, `config.auth: 'public'`.
- Answers exactly `{"status":"ok"}` (200) when Postgres and Redis answer within 2 s, else
  `{"status":"unavailable"}` (503). No probe names, versions, timings or error text (the failure reason is
  logged server-side at `warn`). `Cache-Control: no-store` (Cloudflare does not cache it).
- The result is cached for 10 s and computed single-flight: a flood of anonymous requests costs at most one
  `SELECT 1` + `PING` per 10 s. `/healthz` and `/readyz` stay internal (blocked at Traefik, unchanged).
- Why not reuse `/healthz`: it is liveness only (would stay green with the database down) and is
  deliberately not public; `/readyz` stays internal so the container healthcheck semantics never change for
  the outside world.

### 2.2 External probe (owner, 5 minutes, free) — SLO-1's "outside AWS" measurement

Cloudflare's own health checks need a Pro plan; use a free external monitor instead:

1. Create a free account at UptimeRobot (5-min interval) or Better Stack Uptime (3-min interval).
2. New monitor → **Keyword** (UptimeRobot) / **Keyword exists** (Better Stack):
   URL `https://console.example.org/api/status`, keyword `"status":"ok"`, timeout 30 s.
3. Second monitor (dashboard login page, SLO-1's other half): URL `https://console.example.org/`,
   keyword `id="root"`.
4. Alert contacts: the owner's e-mail (+ phone app). Optional: a status page.
5. Cloudflare: if Bot Fight Mode / a WAF rule challenges the monitor, add a WAF **custom rule → Skip**
   for `http.request.uri.path eq "/api/status"` (only that path; it reveals nothing).

### 2.3 Route 53 health check (AWS side, optional, in the stack)

`EnableUptimeHealthCheck=true` (default) creates an `HTTPS_STR_MATCH` check of `/api/status` from Route 53's
checkers every 30 s (3 failures = unhealthy). Its alarm (`remyral-<env>-uptime`, p6-alerts) pages through the
SNS topic, so the uptime signal lands in the same place as the host alarms. Route 53 health-check metrics
exist only in us-east-1 — the stack must be deployed there (it is: the host is in us-east-1).

## 3. Orchestrator steps (deployment)

Prerequisites: AWS CLI credentials of the owner's account on the orchestrator machine (never on the host),
region `us-east-1`. The host's instance role (`instanceRole`) already has `CloudWatchAgentServerPolicy` and
`AmazonSSMManagedInstanceCore` — nothing to add (the `awslogs` driver and the agent need
`logs:CreateLogStream`/`PutLogEvents`/`DescribeLogStreams`, `cloudwatch:PutMetricData`; all included).

1. **Stack** (log groups must exist before the overlay is used):
   ```sh
   INSTANCE_ID=$(aws ec2 describe-instances --filters Name=ip-address,Values=<elastic-ip> \
     --query 'Reservations[0].Instances[0].InstanceId' --output text)
   aws cloudformation deploy --region us-east-1 --stack-name remana-prod-monitoring \
     --template-file infra/monitoring/cloudformation.json \
     --parameter-overrides Environment=prod InstanceId=$INSTANCE_ID AlertEmail=<owner e-mail>
   ```
   The owner confirms the SNS subscription e-mail ("AWS Notification - Subscription Confirmation").
   If the container log group already exists (created by hand), import it or delete it first.
2. **Host agent + container stats** (idempotent; prints every step):
   ```sh
   rsync -a infra/monitoring/ <host>:/tmp/remyral-monitoring/
   ssh <host> 'sudo bash /tmp/remyral-monitoring/install-host.sh --env prod'
   ```
   `--dry-run` first if in doubt. Pin the agent with `CWAGENT_VERSION=<x.y.z>` (default `latest`; the
   package signature is verified either way).
3. **Ship container logs**: redeploy the stack with the overlay (same command as the normal deploy plus one
   `-f`; containers are recreated with the new logging driver, data volumes are untouched):
   ```sh
   cd /opt/remyral-src && sudo docker compose -p remyral-prod --env-file /data/remyral/prod/stack.env \
     -f infra/coolify/compose.yaml -f infra/monitoring/compose.awslogs.yaml up -d
   ```
   (Coolify resource instead of plain compose: add the overlay's `logging:` block to master, migrate and web
   in the pasted compose.)
4. **Verify** (2–3 minutes later):
   ```sh
   aws cloudwatch list-metrics --namespace Remyral/Containers --region us-east-1 --query 'Metrics[].Dimensions'
   aws logs tail /remyral/prod/containers --since 5m --region us-east-1 | head
   curl -s https://console.example.org/api/status        # {"status":"ok"}
   ```
   and open the `remana-prod` CloudWatch dashboard.

**Rollback**: redeploy without the overlay (back to `json-file`); `systemctl disable --now
remyral-container-stats.timer`; `amazon-cloudwatch-agent-ctl -a stop`; `aws cloudformation delete-stack`
(the container log group has `DeletionPolicy: Retain` — delete it by hand if wanted).

## 4. Log shipping and redaction

- **What**: master and migrate (pino JSON — one object per line, fields `level`, `time`, `msg`,
  `component`, `reqId`, …) and web (nginx). Postgres and Redis logs stay on the host: Postgres error
  `DETAIL` lines can quote row values (usernames, e-mail addresses).
- **Redaction, three layers**:
  1. pino path redaction (`REDACT_PATHS`: passwords, TOTP, tokens, cookies, session ids);
  2. `redactingLogStream`: every line is parsed and every string (keys included) passes through the
     `@remyral/observability` redactor (PEM keys, provider keys, GitHub/GitLab tokens, JWTs, bearer values,
     URL credentials, `password=`-style assignments); output stays one valid JSON object per line;
  3. CloudWatch Logs **data protection policy** on `/remyral/<env>/containers`: masks AWS secret keys,
     private keys and e-mail addresses plus custom identifiers (Anthropic/OpenAI/GitHub/GitLab tokens, URL
     credentials, bearer tokens, JWTs). Unmasked viewing requires the `logs:Unmask` permission.
     Findings are visible in the log group's *Data protection* tab.
- **Retention**: 30 days (`ContainerLogRetentionDays`), EMF metric events 7 days.
- **Loss behaviour**: `mode: non-blocking`, 4 MiB buffer: a CloudWatch outage drops lines instead of
  blocking the master; `docker logs` keeps working (Docker dual logging).
- **Queries** (Logs Insights, group `/remyral/prod/containers`):
  ```
  fields @timestamp, @logStream, level, component, msg | filter level >= 50 | sort @timestamp desc
  fields @timestamp, msg, reqId | filter component = "orchestrator" and level >= 40
  stats count(*) by bin(5m), level
  ```

## 5. Why these choices

- **`awslogs` driver, not the agent tailing `/var/lib/docker/containers/*/*-json.log`**: the agent ships only
  the most recently modified file of a glob (or needs one entry per container id), and json-file wraps the
  pino line in a string so Logs Insights would not see its fields. The driver gives one stream per
  container name and the raw JSON line.
- **EMF for container stats**: exact dimensions (`Environment`, `Service`) that alarms can rely on; plain
  StatsD adds agent-defined dimensions. The script runs as root only because it needs the Docker socket; it
  sends numbers and the service name, nothing else.
- **No Prometheus scraping by the agent**: application metrics (`/metrics`, p6-otel) stay internal; the
  in-master alert evaluator (p6-alerts) covers application alarms without an external Prometheus. p16-observability
  adds an optional, localhost-only Prometheus + Grafana (§8.4) and the console's own status page (§8.1).

## 6. Security review

- `/api/status` is the only new public route (route-coverage test allowlist); it returns a constant body,
  is cached, and needs no session. It cannot be used to enumerate anything or to load the database.
- No credentials are configured anywhere: the agent and the Docker daemon use the instance role via IMDSv2.
- The EMF listener and the agent bind on the host only; ufw and the security group keep 25888 closed.
- The agent package is installed only after its GPG signature verifies against AWS's published key
  fingerprint.
- Shipped logs are redacted in-process and masked again by CloudWatch; Postgres logs are not shipped.

## 7. CloudWatch alarms (p6-alerts)

Defined in `infra/monitoring/cloudformation.json`; every alarm notifies the SNS topic on ALARM **and** on OK.
Application alarms (offline worker, backlog, failure spike, budget) are evaluated inside the master and
arrive as in-app/e-mail/webhook notifications ([p6-observability.md §6](../design/p6-observability.md)).

| Alarm | Metric | Condition | Missing data |
|---|---|---|---|
| `remyral-<env>-cpu-credits-low` | `AWS/EC2 CPUCreditBalance` | min < 60 for 2 × 5 min (t3.medium earns 24/h, max 576) | ok |
| `remyral-<env>-cpu-high` | `AWS/EC2 CPUUtilization` | > 90 % for 3 × 5 min | ok |
| `remyral-<env>-status-check-failed` | `AWS/EC2 StatusCheckFailed` | ≥ 1 for 3 × 1 min | alarm |
| `remyral-<env>-disk-80` | `Remyral/Host disk_used_percent` | > 80 % for 2 × 5 min | missing |
| `remyral-<env>-memory-90` | `Remyral/Host mem_used_percent` | > 90 % for 3 × 5 min | missing |
| `remyral-<env>-swap-50` | `Remyral/Host swap_used_percent` | > 50 % for 3 × 5 min | missing |
| `remyral-<env>-{master,postgres,redis,web}-unhealthy` | `Remyral/Containers Healthy` | min < 1 for 3 × 1 min | **alarm** (stats timer/host down) |
| `remyral-<env>-error-logs` | `Remyral/Logs/<env> ErrorLines` | > 20 in 5 min | ok |
| `remyral-<env>-uptime` | `AWS/Route53 HealthCheckStatus` | < 1 for 3 × 1 min | alarm |

Owner step: confirm the SNS e-mail subscription after the stack deploy (§3 step 1). To add a chat channel,
subscribe an AWS Chatbot / HTTPS endpoint to the topic. Runbook hints: CPU credits low → find the busy
container on the dashboard (`CpuPercent`), consider `t3.large` or unlimited mode; disk > 80 % →
`docker system df`, prune old images (keep the previous tag for rollback); master unhealthy →
`docker logs` of the master, `/readyz` from inside the container.

## 8. In-product status, log search, traces and the optional dashboards (p16-observability)

Design: [p16-observability.md](../design/p16-observability.md). Everything in §8.1–§8.3 works with the normal deploy
(no extra container, no SSH); §8.4 is optional infrastructure.

### 8.1 Ayarlar → Sistem durumu (owners and admins)

- **Durum**: master / web / Postgres / Redis / backup, the queue and its oldest waiting job, machines with their last
  heartbeat, worker release channels, version feed, Coolify / Cloudflare / GitHub checks, errors of the last hour (from
  the master's own metrics), disk use of the host data volume and of Docker's disk, database and Redis size, the
  deployed release tag. The home page shows the verdict in its health panel.
- **Kayıtlar**: the master's redacted log lines (Postgres table `master_log_lines`, UNLOGGED, 7 days), filters
  level / component / text / job / request / trace id; a line links to the job's own log and to its trace.
- **İzler**: the latest slow (≥ 1 s) and failed traces kept in memory, with their spans.
- The assistant reads the same through `system_status` and `search_logs` (rule 42).

### 8.2 Settings (all optional; stack.env, empty = default)

| Variable | Default | |
| --- | --- | --- |
| `LOG_STORE_RETENTION_DAYS` | 7 | 0 turns the log search off (default; Ayarlar → Sunucu ayarları → Loglar overrides it, p17-panel-settings) |
| `LOG_STORE_LEVEL` | info | |
| `LOG_STORE_REQUESTS` | problems | `all`: also healthy request lines (more rows) |
| `LOG_STORE_MAX_ROWS` | 2000000 | |
| `TRACE_RECENT_LIMIT` | 50 | 0 = no in-process traces |
| `TRACE_SLOW_MS` | 1000 | |
| `TRACE_DB_SAMPLE_RATIO` / `TRACE_DB_SLOW_MS` | 0.1 / 100 | database spans: sampled, slow and failed always |
| `STATUS_WEB_URL` | `http://remyral-<env>-web:8080/index.html` | the web container's alias on the proxy network |
| `REMYRAL_RELEASE_TAG` | from `release.env` | written by `scripts/deploy/deploy.mjs` |

Sizing: with the default request policy the table grows by roughly 5–50 MB a day on this host; the row cap bounds it
(≈ 1–2 GB at 2 M rows). OTLP export (§3, `OTEL_EXPORTER_OTLP_ENDPOINT`) is unchanged and still off by default.

### 8.3 Checks after a deploy

1. Ayarlar → Sistem durumu: every service "Çalışıyor", the release tag equals the deployed tag, disk lines present.
2. Kayıtlar → level Hata: a recent error line (or "no line") — no `ghp_` / `sk-` / password values ever.
3. İzler: after a slow page load, its trace appears with `db` spans.

### 8.4 Optional Prometheus + Grafana (compose profile `monitoring`, off by default)

Files: `infra/monitoring/compose.monitoring.yaml`, `prometheus/prometheus.yml`, `grafana/provisioning/**`,
`grafana/dashboards/*.json` (Remyral — control plane; Remyral — jobs, chat and costs).

1. Secrets on the host (the uids are the containers' users):
   ```sh
   openssl rand -hex 32 | tr -d '\n' | sudo install -m 0440 -o 10001 -g 65534 /dev/stdin /data/remyral/prod/secrets/metrics.token
   openssl rand -base64 24 | tr -d '\n' | sudo install -m 0440 -o 472 -g 472 /dev/stdin /data/remyral/prod/secrets/grafana-admin.password
   ```
2. Start (the overlay also moves the master's `/metrics` to the internal network behind that token):
   ```sh
   cd /opt/remyral-src && sudo docker compose -p remyral-prod --env-file /data/remyral/prod/stack.env \
     --env-file /data/remyral/prod/release.env \
     -f infra/coolify/compose.yaml -f infra/monitoring/compose.monitoring.yaml --profile monitoring up -d
   ```
3. Open Grafana: it listens on **127.0.0.1:3300 of the host only** — `ssh -L 3300:127.0.0.1:3300 <host>`, then
   http://127.0.0.1:3300 (user `admin`, the password file above). It is deliberately not routed through Traefik and not
   behind the Coolify SSO gate (that gate serves the Coolify host only).
4. Prometheus keeps 15 days / at most 2 GB (`PROMETHEUS_RETENTION`, `PROMETHEUS_RETENTION_SIZE`); memory limits
   384 MiB / 256 MiB (`PROMETHEUS_MEM_LIMIT`, `GRAFANA_MEM_LIMIT`).

Rollback: run the normal deploy command without the overlay (the master returns to loopback `/metrics`), then
`docker compose -p remyral-prod rm -sf prometheus grafana`; the volumes `promdata` / `grafanadata` can be removed by hand.
