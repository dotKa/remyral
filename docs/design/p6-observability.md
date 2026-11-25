# Design note: observability — OpenTelemetry, alerts, AgentMagnify (P6)

- **Status:** Implemented
- **Date:** 2026-10-14
- **Backlog:** p6-otel, p6-alerts, p6-agentmagnify (host side: p1-monitoring, [docs/ops/monitoring.md](../ops/monitoring.md))
- **Decisions applied:** ADR-0003 (Postgres is the source of truth: metrics and alerts read it, not Redis),
  ADR-0006 (secrets only from files, redaction before anything leaves a process), ADR-0008 (cost data with
  provenance; budgets), [slo.md](../ops/slo.md) alert rules
- **Threat model:** T-SEC-1 (secrets in logs/telemetry), T-CP-3 (cross-project disclosure), T-CP-6
  (internal endpoints reachable from the internet)

## 1. Scope

| Piece | Where |
| --- | --- |
| OTel SDK setup, export-time attribute policy, OTLP headers file | `packages/observability/src/telemetry/` (subpath export `@remyral/observability/telemetry`) |
| Master: HTTP, Postgres, BullMQ hints, orchestrator steps, worker sessions | `apps/master/src/telemetry/instrument.ts` |
| Master: state gauges + transition tailer (job lifecycle spans, queue wait, durations, lease expiries) | `apps/master/src/telemetry/metrics.ts` |
| Master: internal `/metrics` listener | `apps/master/src/telemetry/server.ts` |
| Worker: job run / phase (adapter call) spans and metrics | `apps/worker/src/jobs/telemetry.ts`, `jobs/runner.ts` |

## 2. Traces

All instrumentation is **manual** (no monkey-patching auto-instrumentation): the master is ESM, and
explicit spans keep the attribute set under our control. Context propagation uses
`AsyncLocalStorageContextManager`.

### 2.1 Master

| Span | Where | Attributes |
| --- | --- | --- |
| `HTTP <METHOD> <route pattern>` (server) | first `onRequest` hook; active for the whole request | `http.request.method`, `http.route` (pattern, e.g. `/jobs/:id` — never the URL or query), `http.response.status_code` |
| `db <operation>` (client) | every pooled connection (`acquire` hook), only inside an active span | `db.system.name`, `db.operation.name` (`select`, `insert`, …) — never statement text or parameters |
| `hints publish` / `hints process` | BullMQ delivery hints | `messaging.*`, `remyral.count`, `remyral.job.id` |
| `orchestrator.<step>` | each reconciliation step (sweep, lost, cancel, retry, dispatch, quotas, workflows, schedules, effects, gitflow) | `remyral.step` |
| `worker.session` → `worker.message <TYPE>` | worker WebSocket session and every inbound message | `remyral.worker.id`, `remyral.worker.message`, `remyral.job.id`, `remyral.session.reason` |
| `job.transition <STATE>` | transition tailer, one per committed `job_transitions` row, timestamped at the transition | `remyral.job.id/from/to/trigger`, `remyral.runtime`, `remyral.attempt.id/epoch`, `remyral.worker.id` |

The job lifecycle is derived from the append-only `job_transitions` table rather than from the code paths
that make transitions (store, inbox, orchestrator, approvals, quotas, workflows): a transition counts once
it is committed, whichever path made it, and a crash between commit and instrumentation loses nothing
(the tailer resumes from its cursor; after a restart it starts at the end, so history is not replayed into
counters).

### 2.2 Worker

`job.run` per attempt (`remyral.job.id`, `remyral.attempt.id`, `remyral.attempt.epoch`, `remyral.runtime`) with
children `job.credential`, `job.workspace`, `job.spawn`, `job.prompt`, `job.stream`, `job.collect`,
`job.publish`, `job.cleanup` — i.e. every adapter call (`spawn`, `sendPrompt`, `events`, `collectResult`,
`cleanup`). Worker → master trace propagation is not done (the protocol stays unchanged); the two sides are
correlated by job/attempt ids and epoch.

**p16-observability amendments** ([p16-observability.md](p16-observability.md) §4): the master now records spans
always (an in-process recent-traces processor; OTLP export stays optional); `db <operation>` spans are sampled (slow
and failed queries always); `worker.message <TYPE>` is the root of its own trace with a link to `worker.session` (or
the child of a `traceparent` the worker sent); new spans `job.dispatch` and `chat.turn`. The envelope carries an
optional W3C `traceparent` (master → worker on durable messages and ASSISTANT_TURN), and the worker's `job.run`
continues the ASSIGN_JOB trace — master → worker propagation is done; worker → master echo is not yet.

## 3. Export and configuration

| | Master (env) | Worker (config file) |
| --- | --- | --- |
| OTLP/HTTP traces + metrics + logs | `OTEL_EXPORTER_OTLP_ENDPOINT` (off when unset), `OTEL_EXPORTER_OTLP_HEADERS_FILE` | `telemetry.otlpEndpoint`, `telemetry.otlpHeadersFile` (off when the section is absent) |
| Prometheus `/metrics` | separate listener `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`, `METRICS_ENABLED=true`), bearer `METRICS_TOKEN_FILE` (required when the host is not loopback) | none (no inbound ports on workers) |
| Service / environment | `OTEL_SERVICE_NAME` (default `remyral-master`), `REMYRAL_ENV` | `remyral-worker` |

- Batch span processor (queue 2048, 5 s), metric reader 60 s, OTLP timeout 10 s; an unreachable collector
  drops data, it never blocks requests or jobs.
- Headers files contain `name=value` lines (collector API keys); read once at start, never logged; a
  malformed line fails start-up without echoing the line.
- **Logs:** pino lines already carry `trace_id`/`span_id` of the active span when tracing is on (log ↔ trace
  correlation in CloudWatch or any backend). `Telemetry.emitLog` exports redacted records over OTLP logs;
  shipping the full log stream stays with the container log pipeline (p1-monitoring), which already
  redacts it.

## 4. Metrics

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `remyral_jobs` | gauge | `state` | Postgres snapshot (cached 15 s per scrape) |
| `remyral_workers`, `remyral_workers_online` | gauge | `state` | snapshot |
| `remyral_approvals_pending` | gauge | — | snapshot |
| `remyral_queue_oldest_seconds` | gauge | — | snapshot (age of the oldest QUEUED job) |
| `remyral_leases_active` | gauge | — | snapshot |
| `remyral_budget_consumption_ratio` | gauge | `budget_id`, `metric`, `scope` | enabled budgets, current window (ADR-0008 coverage: a lower bound when incomplete) |
| `remyral_job_transitions_total` | counter | `from`, `to`, `trigger` | tailer |
| `remyral_job_state_seconds` | histogram | `state`, `runtime` | tailer — `state="QUEUED"` is the **queue wait**, `RUNNING` the run time |
| `remyral_job_duration_seconds` | histogram | `outcome`, `runtime` | tailer (creation → terminal) |
| `remyral_lease_expiries_total` | counter | — | tailer (`lease_expired`) |
| `remyral_job_failures_total` | counter | `to` (`FAILED`/`LOST`), `runtime` | tailer |
| `remyral_http_server_duration_seconds` | histogram | `method`, `route`, `status_class` | HTTP hook (error rate = `status_class="5xx"`) |
| `remyral_db_query_duration_seconds`, `remyral_db_query_errors_total` | histogram / counter | `operation` | pool |
| `remyral_dispatch_hints_published_total`, `remyral_dispatch_hints_consumed_total` | counter | `result` | BullMQ |
| `remyral_orchestrator_step_duration_seconds`, `remyral_orchestrator_step_failures_total` | histogram / counter | `step` | orchestrator |
| `remyral_worker_sessions_active`, `remyral_worker_messages_total` | up-down / counter | `type`, `result` | gateway |
| `remyral_worker_job_phase_duration_seconds` | histogram | `phase`, `runtime`, `result` | worker (OTLP only) |
| `remyral_worker_jobs_finished_total` | counter | `outcome`, `runtime` | worker (OTLP only) |

Label cardinality is bounded: states, triggers, runtimes, routes (patterns), operations and steps are
closed sets; `budget_id` is bounded by the number of budgets.

## 5. Security review (telemetry)

- **No secrets, prompts or PII in telemetry.** Every exported span passes `SanitizingSpanExporter`: only
  allowlisted attribute keys survive (`remyral.job.id`, `http.route`, … — the regex `ALLOWED_ATTRIBUTE`);
  string values must look like identifiers/enumerations (anything else becomes `[filtered]`) after the
  secret redactor ran over them; span status messages and exception messages/stacks are dropped (only
  `exception.type` / `error.type`, the class name, remain). Instrumentation code that adds an attribute
  outside the policy loses it at export instead of leaking it. Tests assert a prompt canary and an API key
  never appear in spans or the Prometheus output (master and worker).
- **The metrics endpoint is not public.** It is a separate listener (never the API port Traefik routes to),
  bound to 127.0.0.1 by default and not published by the compose file; widening it (`METRICS_HOST=0.0.0.0`
  for an internal scraper) should be paired with `METRICS_TOKEN_FILE` (constant-time bearer check). Only
  `GET|HEAD /metrics` is served. `GET /metrics` on the API answers like any unknown route (401).
- Metric labels never carry user names, project names, repository URLs or reasons; worker ids and job ids
  are opaque identifiers already visible to every operator.
- OTLP export is opt-in and outbound only; collector credentials are read from files.

## 6. Alerts (p6-alerts, acceptance A-UX-6)

Two layers, so neither depends on the other being up:

| Layer | Watches | Delivered through |
| --- | --- | --- |
| **In-master evaluator** (`apps/master/src/alerts/`) | application signals from Postgres: offline workers with work, queue backlog, failure spikes, budgets | p5-notifications: in-app bell for owners/admins + their opted-in e-mail / webhook (kind `alert`) |
| **CloudWatch alarms** (`infra/monitoring/cloudformation.json`) | host and process signals the master cannot report about itself: CPU credits, CPU, disk > 80 %, memory, swap, status checks, containers unhealthy (master, postgres, redis, web), error-log rate, `/api/status` uptime | SNS topic `remyral-<env>-alerts` (e-mail subscription, alarm and OK) |

### 6.1 Rules (docs/ops/slo.md "Alerting")

| Rule | Instance | Fires when | Severity | Resolves when |
| --- | --- | --- | --- | --- |
| `worker.offline_with_work` | worker id | worker `offline` for ≥ 10 min and it still has open attempts or unreleased leases | critical | worker back, or its work reconciled |
| `queue.backlog` | `global` | a job has waited in `QUEUED` ≥ 5 min | warning | no job waits that long |
| `jobs.failure_spike` | `global` | FAILED/LOST transitions in the last 30 min ≥ 3 **and** > 3 × the 7-day average per 30 min | warning | below again |
| `budget.threshold` | budget id | an enabled budget ≥ 80 % in its current window; ≥ 100 % escalates | warning → critical | consumption below 80 % (new window), budget disabled/deleted |

"Eligible" in the SLO backlog rule is approximated by "QUEUED" (a job that waits for an infeasible
placement stays QUEUED with an actionable reason and should be noticed too). Per-project quotas still stop
new jobs at 100 % (p4-quotas); the alert is the notification side.

### 6.2 Semantics

- **State**: `alert_states` (migration 0023) — one row per (rule, instance): `firing`/`resolved`, severity,
  episode, timestamps, numeric details. The evaluator runs every `ALERT_INTERVAL_MS` (default 60 s, `0`
  disables it) in one transaction under an advisory lock (one evaluator across replicas), each rule inside a
  savepoint: a rule that fails is skipped for that pass and its firing alerts are kept (never falsely
  resolved).
- **Dedupe**: notification dedupe key `alert:<rule>:<instance>:<episode>:<fired|resolved|critical>` — a pass
  that runs twice, or two replicas, never notify twice.
- **Cooldown** (30 min): an instance that fires again within the cooldown after resolving re-opens its
  episode silently (no flapping storm; the later resolution is not announced a second time). After the
  cooldown a new episode notifies again.
- **Escalation**: warning → critical while firing notifies once more.
- **Audit**: `alert.fire`, `alert.escalate`, `alert.resolve` (actor `system:alerts`) with ids and numbers.
- **Recipients**: owners and admins (global roles). Notification text is built from the rule title,
  identifiers and numbers only (e.g. `instance=wrk_…, offlineMinutes=11, openAttempts=1`), never job prompts,
  names or reasons; links are console-relative (`/fleet?worker=…`, `/jobs`, `/usage`).
- Listeners (`MasterDeps.alerts.listeners`) receive committed alert events (used by p6-agentmagnify).

### 6.3 CloudWatch alarms

See [monitoring.md §7](../ops/monitoring.md#7-cloudwatch-alarms-p6-alerts) for thresholds and owner steps.
Container alarms treat missing data as breaching, so a dead stats timer or a dead host alarms too.

## 7. AgentMagnify plugin (p6-agentmagnify)

Optional, **disabled by default**: `AGENTMAGNIFY_API_URL` (https, or http to a loopback host) and
`AGENTMAGNIFY_TOKEN_FILE` (a project or workspace-ingestion token) must both be set; optional
`AGENTMAGNIFY_PROJECT_NAME`, `AGENTMAGNIFY_INTERVAL_MS` (default 10 s). Code:
`apps/master/src/integrations/agentmagnify.ts`.

- **Session**: `POST /v1/agent/sessions` (executor `custom`, label `remana-agent-cluster`) with the bearer
  token; reopened after 401/403/404/409.
- **Events**: `POST /v1/events/batch` (≤ 100 per batch), envelope `sessionId`, `protocolVersion`
  (`2026-07-31.1`), monotonic `sequence`, deterministic `eventId` `rac-t-<transition id>` (idempotent
  retries). The master reports as the main agent `remyral-master` (task created/assigned/progress/blocked/
  completed/failed) and the worker as a logical agent (`task.started`, verifying progress).

| Job state reached | Event | Task status |
| --- | --- | --- |
| QUEUED (new) / QUEUED (retry) | `task.created` / `task.reopened` | pending |
| RESERVED | `task.assigned` (`assigneeAgentId` = worker id) | assigned |
| RUNNING | `task.started` (reporter = worker) | in_progress |
| VERIFYING / AWAITING_APPROVAL | `task.progress` (80 / 90) | in_progress |
| BLOCKED / LOST | `task.blocked` | blocked |
| SUCCEEDED | `task.completed` (verification `acceptance_criteria` passed) | completed |
| FAILED / CANCELLED | `task.failed` | failed |
| alert fired / escalated / resolved | `blocker.created` / `blocker.updated` / `blocker.resolved` | — |

- **Metadata only**: task title `<runtime> job <first 8 chars of the id>`; `metadata` = job id, from/to
  state, trigger, runtime, project identifier, epoch, worker id. Summaries are fixed strings. Prompts,
  repository URLs, failure reasons, approval summaries, user names and secrets are never read by the
  forwarder (the test asserts a prompt canary, an API key and the repository name never reach the wire).
- **Delivery**: best effort, bounded in-memory queue (2000, oldest dropped and counted in `stats`),
  retried each pass on 429/5xx/network errors; events rejected by validation are dropped (not retried).
  The cursor over `job_transitions` starts at the end when the master starts: transitions while the master
  is down are not replayed (AgentMagnify is a progress mirror, not an audit log — the audit trail stays in
  Postgres).
- **Security**: the token is read from a file at start, sent only as a bearer header to the configured URL
  (`redirect: 'error'`), never logged (logs carry HTTP status codes only); outbound only.

## 8. Rollback

Telemetry is additive and off by default (no OTLP endpoint; /metrics loopback-only): revert the commit.
AgentMagnify: unset the two variables. Alerts: `ALERT_INTERVAL_MS=0` stops the evaluator; migration 0023 is forward-only (an older master refuses
a database with it — keep the evaluator disabled instead of rolling back across it). CloudWatch alarms:
delete them from the stack or remove the SNS subscription.
