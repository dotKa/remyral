# Design note: `p15-services` — Servisler (long-running services the worker owns)

- **Task:** `p15-services` (owner priority). **Date:** 2026-10-21. **Migration:** 0120. **Worker release:** yes
  (feature `services-v1`).
- **Owner problem (2026-10-21):** "Cloudflare tunnel'lar için, makinede ayağa kaldırılan dev sunucular için iş açık
  kalmasın; bu hem zaman sınırı olduğu için sorun, hem de açık bırakıp uzun süreli test edeceksem slotlarımı
  dolduruyor. Bunun için makinede aktif olan sunucular veya daha uygun bir kapsam varsa yönetilebilmeli."
- **Decision record:** [ADR-0032 addendum 2026-10-21](../adr/0032-preview-tunnels-connector-token-to-worker.md)
  (service-owned tunnels; quick tunnels for services). Related: p8-preview-tunnels, p15-watches (hand-off), ADR-0007
  (sandbox profiles), ADR-0012 rule 4 (no child left behind), ADR-0010 (untrusted repository content).

## 1. What a service is

A **service** is a long-running process a *worker* owns, not a job:

| Field | Notes |
| --- | --- |
| project, machine | the project's repository / a job of the project; the machine that runs it |
| working dir | a project checkout the worker keeps: the worktree a running job handed over (`source.kind = job`), or a checkout the worker made for the service (`source.kind = checkout`, project repository at `baseRef`, read-only token) |
| start command | `sh -c <command>` (Windows `cmd /d /s /c`) in the checkout (+ relative `cwd`) |
| env | plain values + secret **references** (`secret:vault-<id>` / worker store), resolved on the worker |
| port | where it listens on localhost (health checks, tunnels); `PORT` / `HOST=127.0.0.1` are set |
| health | `none` · `tcp` · `http` (path, expected status), interval / timeout / failures / start period |
| restart policy | `never` · `on-failure` (default) · `always`, at most `maxRestarts` in `windowSec`, backoff 1–30 s |
| tunnel | `none` · `quick` (`cloudflared tunnel --url`, random `trycloudflare.com`, no account) · `named` (a preview-zone hostname created by the master with the project's preview-link settings) |
| lifetime | TTL (default 4 h, ≤ 30 days per start / extension) or "until stopped" |
| limits, profile | memory / CPU / pids capped by the worker's job limits; `host-restricted` (default) or `unconfined` (project admin) |

It holds **no job slot**, has **no job timeout**, is not counted in HEARTBEAT `runningJobs`, the state machine or the
child registry the updater waits for.

## 2. Wire (`packages/protocol/src/services.ts`, feature `services-v1`)

All control messages (seq 0, never in the durable outbox); the master's desired state is in Postgres and reconciled.

| Message | Direction | Notes |
| --- | --- | --- |
| `SERVICE_START {spec, revision, issuedAt, gitToken?, signature}` | m → w | signed (lease key) over worker, service, revision, time, SHA-256 of the canonical spec; ≤ 5 min old; a higher revision replaces the spec (only `expiresAt` changed → no restart) |
| `SERVICE_CONTROL {serviceId, op: stop|restart|remove, reason, issuedAt, signature}` | m → w | signed |
| `SERVICE_TUNNEL {serviceId, tunnelId, hostname, port, expiresAt, connectorToken, issuedAt, signature}` | m → w | named tunnels: only that tunnel's connector token (ADR-0032 addendum) |
| `SERVICE_LOGS_REQUEST {serviceId, requestId, lines}` / `SERVICE_LOGS` | m → w / w → m | last ≤ 2000 lines, redacted on the worker |
| `SERVICE_STATUS {serviceId, revision, state, health, detail, pid, startedAt, restarts, exitCode, tunnel{state,url}, cpuPercent, memoryBytes}` | w → m | on every change + every minute while alive |
| `SERVICE_REQUEST {attemptId, epoch, requestId, op}` / `SERVICE_RESULT` | w → m / m → w (job messages) | a job agent's `start_service` & co., fenced by the live lease |
| CAPABILITIES `services {max, services[{serviceId, revision, state, since}]}` | w → m | reconciliation after every connect |
| ASSIGN_JOB `execution.services {tools, tunnels}` | m → w | repository jobs on `services-v1` workers (not container, machine-admin, function, workspace) |

States: `pending` (master only) → `starting` → `running` / `unhealthy` / `restarting` → `stopped` / `failed` /
`expired` / `refused`.

## 3. Master (`apps/master/src/services/*`, migration 0120)

- `services` table: desired (`running | stopped | removed`), observed (state, health, URL, pid, uptime, CPU / memory,
  tunnel state), spec (secret references only), revision, source job, creator, `via` (`api | chat | job`), expiry.
  `preview_tunnels.service_id` for named service tunnels. A trigger wakes p15-watches (`service:<id>`).
- `ServiceRegistry`: create (RBAC, limits ≤ 10 per project, name unique per project, machine choice, profile rules,
  spec validation), stop / remove, restart, extend, logs (request / answer with a 10 s timeout), list / get, worker
  messages, job requests, sweep (expiry, tunnels of stopped services), `assignment()` for ASSIGN_JOB, `resolveUrl()` for
  watches, the `events` hook (§8).
- Reconciliation: on CAPABILITIES, wanted services the worker does not run (or runs at a lower revision) get
  SERVICE_START; named tunnels not running get SERVICE_TUNNEL; services the master does not want are stopped / removed;
  unknown ones removed. A SERVICE_STATUS of a service the machine does not own is answered with a remove.
- REST (`services.read` viewer, `services.manage` operator): `GET /services?project=&worker=&state=`,
  `GET|POST /projects/:id/services`, `GET /services/:id`, `GET /services/:id/logs`, `POST /services/:id/stop|restart|extend`.
- Chat (owner decision: act directly, no card, when the user asks): assistant tools `list_services`, `start_service`,
  `stop_service`, `restart_service`, `service_logs`. start / stop / restart are draft tools with the p15-autonomy
  `execute` flag (ADR-0056): a `service_action` card (migration 0120 widens `chat_drafts.kind`) that `execute: true`
  runs at once through `ChatDirectActions` → `DraftExecutor.confirm` for the signed-in user (their own role, the
  security policy's `chatDirect` / code rules, `chat.direct_action` audit); without `execute`, or when the policy keeps
  cards, the user confirms the card. The registry re-checks `services.manage` (admin for `unconfined`) and audits
  `service.*` with `via: chat`.
- Named tunnels: `PreviewService.openForService` — the project's preview zone, `policy.previewTunnel` must be `auto`,
  counted against the project's open-preview limit, ADR-0028 protected-record checks, optional Access (e-mail /
  service token); closed (all Cloudflare resources deleted) when the service stops or is removed; lifetime follows the
  service's.

## 4. Worker (`apps/worker/src/services/*`)

- `ServiceManager`: verifies signatures and freshness, profile allowed, spec issues, ≤ 8 live services per machine;
  claims the job's worktree from the job runner (the runner then hands it over at the job's end instead of deleting
  it) or makes its own checkout (`<root>/jobs/svc-<id>/checkout`, allowlist, read-only token); keeps a record per
  service in `<dataDir>/services/<id>/record.json` (0600, data dir — every job sandbox denies it).
- Process: the profile runner's `launch` (same confinement code, limits and egress allowlist as a job; sandbox dir
  `<root>/sandboxes/svc-<id>/run`), `listen: true` (Seatbelt allows listening, as for the OpenCode server),
  `jobAccount: false` (Windows: never one of the per-job accounts, so no job slot is taken). PATH from the
  worker-managed tools, like a job's runtime.
- Health probes to 127.0.0.1 only; restart per policy with backoff; signed `expiresAt` enforced locally; CPU / memory of
  the tree every minute (`ps` on POSIX; memory only on Windows).
- Tunnels: a supervisor of its own (`<dataDir>/services/tunnels`, separate from job previews) — quick tunnels capture
  the `https://…trycloudflare.com` URL from cloudflared's output; named tunnels run with the token file. Before a tunnel
  starts, the port must be served by the service's own process tree (preview port policy + ownership check).
- Logs: `<dataDir>/services/<id>/service.log` + one rotated file, ≤ 1 MiB each, JSON lines, the service's secret values
  replaced by `[REDACTED]` before writing.
- Worker restart: graceful shutdown stops every service (ADR-0012 rule 4) and keeps the desired state; the next worker
  process starts them again (policy `never` → reported stopped). A crash leaves the process group: the next process
  kills a recorded pid of the same boot, then starts fresh. **Re-adoption is not attempted**: the egress proxy, the
  Seatbelt profile / Job Object and the per-job state belong to the process that started it; a fresh start keeps the
  sandbox floor.
- Job tools (`start_service`, `list_services`, `stop_service`, `restart_service`, `service_logs`): Claude Code
  in-process MCP server `remyral-services`; Codex / Pi / OpenCode on the shared job-tool channel. A job may stop /
  restart / read only the services it started.

## 5. Console (Diyalog)

- Makineler → makine → **Servisler** tab; Genel bakış shows a "Servisler" panel next to the slots ("iş slotu
  tutmaz").
- Projeler → proje → **Servisler** tab with the start form (machine, name, command, sub-directory, port, link
  none / quick / named, lifetime, health, restart policy).
- Rows: state, health, public URL (quick: "public link" warning), port, uptime, CPU, memory, expiry, restarts, starter,
  source job; logs dialog; stop / restart / +4 h / until stopped / remove (two-step). TR + EN (`services` namespace).

## 6. Security review

| Area | Control | Test |
| --- | --- | --- |
| Authority | starts / stops need `services.manage` (operator) in the project; `unconfined` a project admin; a job agent acts as its creator (re-authorized per request, disabled accounts refused) and only on its own services; chat acts with the user's own subject | integration (viewer 403, outsider 404, job `not_this_job`, chat forbidden for viewer), RBAC matrix |
| Message authenticity | SERVICE_START / CONTROL / TUNNEL signed with the lease key over the binding (spec hash, token hash), ≤ 5 min; unsigned / tampered / stale refused | protocol unit, worker manager test, integration signature checks |
| Sandbox floor | same runners, limits (capped by the job limits) and egress allowlist as jobs; container refused (port not on the host); `jobAccount: false` only skips the Windows account pool (the attempt DACL stays) | worker manager test (refusals), design review |
| Secrets | only references in the spec / DB / audit; values resolved on the worker, passed via the environment only (argv checked), redacted from the log file; the checkout git token is read-only, control-message only, redacted (`gitToken`) from master logs, never in the service env | integration (spec has the reference), worker log redaction test |
| Tunnels | quick tunnels need no credential (public random name, "public link" warning, agents only when the project allows agents to open previews); named: ADR-0032 rules (zone, protected names, limits, Access options, token per send, deleted at stop) | integration (quick URL captured), PreviewService code path shared with previews |
| Port exposure | preview port policy + the service's own process tree must serve the port before a tunnel starts | worker manager test |
| Runaway processes | ≤ 8 per machine, ≤ 10 per project, TTL default 4 h (until-stopped must be asked for), restart limit, sweep | worker + integration sweep tests |
| Audit | `service.start / stop / remove / restart / extend / expire / refused`, `preview.tunnel.open` for named tunnels | integration |
| Untrusted output | logs are fenced as data in the job tool and chat; the console renders them as text | job tools test |

Residual risks: a service the owner (or an agent acting for its creator) deliberately exposes through a public quick
tunnel; on Linux / Windows host profiles without filesystem confinement a service and a job of the same machine share
the OS user (the documented host-native residual of ADR-0007); a parked (approval-paused) job whose worktree a service
uses is retained by the runner's own rules.

## 7. Events for other features (§4 of the brief)

`ServiceRegistry.events` (`apps/master/src/services/events.ts`): `subscribe(filter, listener)` with
`kinds` / `project` / `serviceId`; kinds `service.url_up` (running with a public URL; again when a quick URL changes),
`service.healthy`, `service.down` (unhealthy / restarting / failed / expired / stopped / refused), `service.removed`.
In-process and best effort. Durable consumers (p15-watches `service_url`) use the DB trigger (`remana_watch`,
`service:<id>`) and `ServiceRegistry.resolveUrl(subject, id) → {project, label, url, up}` — wired as WatchChecks'
`ServiceUrlSource` in compose.

## 8. Tests

`packages/protocol/test/services.test.ts` (spec rules, canonical hash, signatures, freshness, expiry); `packages/
agent-adapters/test/service-tools.test.ts` (schemas, every runtime channel, Claude Code MCP server, continuity);
`apps/worker/test/services-manager.test.ts` (real processes: start → healthy → quick tunnel URL with a fake
cloudflared, redacted logs, crash → restart → failed, `never`, TTL expiry, stop / restart / remove, job hand-off and
release, worker restart restarts the service, refusals and the per-machine limit), `services-job-tools.test.ts`;
`apps/master/test/integration/services.test.ts` (RBAC, signed start, no slot consumption, status → URL / events /
watch source, logs, extend / stop / restart, reconciliation, job requests, expiry sweep, chat service_action cards, audit),
`test/unit/service-events.test.ts`, RBAC matrix; `apps/web/test/services-panel.test.tsx`.

## 9. UNVERIFIED (real hosts)

- cloudflared quick tunnels on real Linux, Windows and macOS hosts (`tunnel --url`, the URL line — taken from
  cloudflared's source via Context7, `quickTunnelStartupLines`), and a named service tunnel against the live Cloudflare
  account.
- Seatbelt with `allowListen` for a dev server on macOS; bubblewrap-free Linux host-restricted listening; Windows Job
  Object runner with `cmd /d /s /c` and a non-pool account; `taskkill` of a crashed worker's leftover tree.
- CPU sampling (`ps pcpu`) on Linux; memory on Windows (process table).
- A real Claude Code / Codex / Pi / OpenCode agent calling `start_service`.

## 10. Deploy notes

Migration 0120 (additive). No new environment variables, no Traefik change. New orchestrator tick step `services`.
Master + web, then a **worker release** (`services-v1`; `localCeiling.allowServices: false` lets a machine owner refuse
services). cloudflared on the machine for tunnels (Machines → Tools). Named service tunnels need Project → Deploy →
Preview links with `policy.previewTunnel = auto`.
