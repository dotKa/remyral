# p8-uptime — uptime monitoring of deployed sites and services

Status: implemented 2026-10-16. Builds on [p6-outputs](p6-outputs.md), [p6-deploy-integrations](p6-deploy-integrations.md)
(Cloudflare / Coolify clients, master-held tokens), [p5-notifications](p5-notifications.md) and
[p6-chat-notify](p6-chat-notify.md). Migration 0066 (number taken at merge time). Protocol: additive assistant tools
`list_monitors`, `draft_monitor`, watch target `monitor` with conditions `down` / `up`. Worker release needed only for
the assistant tools (the worker registers the tool catalog); everything else works with the deployed workers.

## 1. Problem

The owner deploys sites (Cloudflare Pages, Coolify) from jobs and the chat, and sees them on Outputs. Wanted: one quality
module that says "Pages works, Coolify works, the site answers" — monitors added by hand, for what was deployed and for
the services on Outputs, visible on an Uptime page and on the Outputs cards, with alerts when something goes down.

## 2. Monitors

`uptime_monitors` (per project). Types:

| Type | Settings | Up when |
|---|---|---|
| `http` | `url` (http/https), `method` GET\|HEAD, `expectStatus {min,max}` (200–399), `keyword {text, mode present\|absent}` (GET only), `maxLatencyMs`, `maxRedirects` 0–5 (3), `tlsWarnDays` 0–365 (14) | status in range, keyword rule holds on the first 64 KiB, latency ≤ max |
| `tcp` | `host`, `port` 1–65535 | the connection opens (nothing is sent) |
| `pages` | Cloudflare Pages `project`, `env` production\|preview | newest deployment's latest stage `deploy` = `success` |
| `coolify` | Coolify application `uuid` | application status `running`, `running:healthy`, `running:unknown` |

Schedule: `intervalSec` 30 – 86 400 (default 60; provider types default 300, at least 60 so the Cloudflare / Coolify API
is not polled harder than once a minute per monitor), `timeoutMs` 1 000 – 30 000 (default 10 000, shorter than the
interval), `retries` 0 – 10 (default 1 = the second failure in a row makes it down), `paused`.

**Region: master only.** The control-plane master runs every check itself; there is no second vantage point. A
network problem of the master's host therefore looks like every monitor going down at once — the incident list makes
that visible (same start time everywhere). Multi-region probing (e.g. through workers) is a follow-up, not built.

Limits: 50 monitors per project, 500 in total (counted under the project row lock), 16 checks in parallel per master
replica. Per-user budgets: 30 writes/min, 10 "check now"/min, and one check-now per monitor per 10 s.

## 3. Where monitors come from

1. **Uptime page** — "New monitor" form (any type).
2. **Outputs** — "Monitor this" on a site card (`POST /uptime/monitors/from-output {project, key}`): an http monitor for
   the site's live URL plus the provider monitor of its deploy target (the Pages project, or each Coolify application
   of the ops action, at most 5). Monitors that already exist for the item (same type and target) are kept, so the
   button is idempotent. The monitors carry `output_key` = the Outputs item key (`site:<target>:<env>`).
3. **Deploy success** — the job deploy card and Outputs show "Monitor this site" while the site has no monitor
   (a suggestion; nothing is created without a click).
4. **Auto-monitor deployed sites** — opt-in project setting (`uptime_settings`, project admins). Every tick step pass
   (at most once a minute) looks at the project's Outputs sites deployed after the setting's cursor and runs "Monitor
   this" for each as the system actor (`uptime-auto`, audited). The cursor moves past what was considered, so a monitor
   someone deleted is not re-created until that site is deployed again. Switching the setting on starts the cursor
   at that moment (earlier deploys are not picked up).
5. **Chat** — `draft_monitor` proposes a card (one monitor, or the "Monitor this" set for an `outputKey`); confirming it
   (full session, CSRF, step-up like every card) calls the same service as the API with `uptime.write` re-checked.
   `list_monitors` answers "is the site up?" within the user's visible projects.

## 4. Checks

### 4.1 Scheduler

An orchestrator tick step (`uptime`, every tick = 2 s). It claims due monitors with one statement —
`UPDATE … SET next_check_at = now + interval FROM (SELECT … WHERE NOT paused AND next_check_at <= now ORDER BY
next_check_at LIMIT free FOR UPDATE SKIP LOCKED)` — so several master replicas never run the same check, and a replica
that dies mid-check only delays that monitor by one interval. The checks run **outside** the tick (not awaited; at most
16 in flight per replica), so a slow site never delays job dispatch. Recording a result happens in one transaction:
lock the monitor row, drop the result if the monitor was edited while the check ran (`updated_at` changed), apply the
status machine (§5), insert the check, upsert the hourly rollup, open / close the incident, update the monitor, queue
the notification (outbox). A failing-but-not-yet-down monitor is re-checked sooner (a third of the interval, 30–60 s).

### 4.2 http / tcp probe (`src/uptime/probe.ts`)

See the security review (§10) for the guard. The probe measures latency from the start of the request to the final
response's headers (all redirect hops; one deadline for the whole check), reads the body only for a keyword check and
only its first 64 KiB, and reads the TLS certificate's `valid_to` from the first https hop. Failure causes are fixed
codes: `timeout`, `dns`, `address_refused`, `url_refused`, `connect`, `network`, `tls` (certificate refused — Node's
default verification is on), `status`, `keyword`, `slow`, `redirect`. Neither error messages nor bodies are stored.

### 4.3 Provider status (`src/uptime/providers.ts`)

The OpsIntegrations clients with the stored tokens (decrypted per call, never returned): Pages
`GET …/pages/projects/{name}/deployments?env=…` (newest first) and Coolify `GET /api/v1/applications/{uuid}`.
`failure` / `canceled` stages and Coolify states other than running / restarting / starting are **down**
(`provider_down`, detail = the provider's status word, e.g. `exited:unhealthy`). A deployment still building, a Coolify
app restarting, Cloudflare / Coolify not connected, the token refused (`provider_auth`), rate limiting or an unreachable
API are **undecided** (`ok = null`): they are recorded, shown, excluded from the uptime figure and never change the
status — the site's uptime is not the provider API's uptime. A project / app that no longer exists is down
(`provider_not_found`).

## 5. Status machine and flap suppression (`src/uptime/state.ts`, pure)

- Statuses `pending` (no decided check yet) → `up` / `down`; `paused` is a flag beside the status.
- A failed check counts; after `retries + 1` failures in a row the monitor is **down** (incident opened). One
  successful check makes it **up** (incident closed with its duration). pending → up is not news (no notification).
- **Flapping**: when the status changed `≥ 5` times within 30 minutes the monitor is flagged; one notification says
  "Flapping: …", the changes while it flaps are recorded (checks, incidents with `suppressed = true`) but not notified,
  and chat watches do not deliver them either. After 30 minutes without a change it is no longer flapping; if the status
  then differs from what people were last told (`notified_status`), that status is notified once.
- Editing a monitor's settings closes the open incident at the edit and starts the status over (`pending`).

## 6. Data and retention

| Table | Content | Kept |
|---|---|---|
| `uptime_monitors` | settings, status, counters, last check summary, TLS expiry, `next_check_at` | until deleted |
| `uptime_checks` | one row per check: `ok` (null = undecided), latency, HTTP status, cause code, short master-built detail | 7 days (p22-ops-hygiene; was 30) |
| `uptime_rollups` | hourly per monitor: decided checks, ok checks, latency sum / count / max (upserted with every check) | 90 days |
| `uptime_incidents` | down period: start, end, cause, detail, suppressed | 90 days after it ended |
| `uptime_settings` | per project: auto-monitor on/off, cursor | with the project |

Uptime % (24 h / 7 d / 30 d) = ok ÷ decided checks from the rollups (hour granularity). Charts: 24 h from the raw
checks in 5-minute buckets; 7 d hourly, 30 d per 6 h, 90 d daily from the rollups. The prune runs from the tick step at
most once an hour (batched deletes). Deleting a monitor removes its checks, rollups and incidents (cascade).

## 7. API and authorization

| Route | Action |
|---|---|
| `GET /uptime/monitors` (`project`, `status`, `q`, `outputKey`), `GET /uptime/monitors/:id`, `…/series`, `…/incidents`, `…/checks`, `GET /uptime/settings` | `uptime.read` (viewer, per project) |
| `POST /uptime/monitors`, `POST /uptime/monitors/from-output`, `PATCH` / `DELETE /uptime/monitors/:id`, `POST …/:id/check` | `uptime.write` (operator, per project) + CSRF |
| `PUT /uptime/settings` | `uptime.settings` (project admin) + CSRF |

Invisible projects answer 404 (not 403). Every write is audited (`uptime.monitor.create|update|delete|check`,
`uptime.settings.update`) with the target summary (URL / host:port / Pages project / Coolify uuid — never a secret,
there is none). `GET /outputs` site items carry `uptime: {status, uptime24h, monitors[…]}` (the linked monitors).

## 8. Console

Sidebar **Uptime** (own page after Outputs): counts (down / up / pending / paused), list with status dot, uptime %
24 h / 7 d / 30 d, a 24 h latency sparkline, last check and open incident; filters; New monitor form. Monitor page:
status, provider status rows ("Cloudflare Pages: healthy", "Coolify app: running:healthy"), latency / uptime chart with
range tabs, incidents (duration, cause, "not notified — flapping"), recent checks, TLS expiry warning, Check now /
Pause / Resume / Edit / Delete, link to the Outputs item. Outputs site cards and the drawer: status dot + uptime % 24 h
linking to the monitor, provider rows, and "Monitor this" when there is none. Project page → Deploy tab: "Auto-monitor
deployed sites" (project admins change it, others see it). Notification settings list the two new kinds.

## 9. Notifications and chat

Kinds `monitor.down` (critical; also "Flapping: …" and "Certificate expires soon: …" as warnings) and `monitor.up`
(info, with the down duration), for the project's operators and above; the user's kind / channel settings apply
(in-app always, e-mail / webhook opt-in), deduplicated per check. Producer: outbox topic `uptime.monitor`
(`src/uptime/notify.ts`), text from the monitor name, project, fixed cause code and the master's own duration only. TLS:
one notice per certificate (`tls_warned_expiry`) when it is within the monitor's warning days.

Chat watch target `monitor` (p6-chat-notify): conditions `down` / `up`, default the opposite of the current status,
`repeat: every` allowed; `uptime.read` is re-checked whenever it fires; flapping changes are not delivered.

## 10. Security review

**Threat: SSRF from the control plane.** The master sits next to Postgres, Redis, Coolify, the Docker network and the
cloud metadata endpoint; an operator (or a prompt-injected assistant card someone confirms) could point a monitor at
them. Controls (`src/uptime/probe.ts`, reused address rules of `src/ops/http.ts`):

- http(s) only; ports 80, 443, 8080, 8443 (explicit or default) — checked at creation **and** again by the probe before
  every hop; no credentials in the URL; no custom headers at all (fixed user agent, `accept: */*`, no cookies, no
  authorization) — a monitor cannot carry a secret, so there is nothing to encrypt (the optional per-monitor secret
  header was deliberately skipped).
- The host name is resolved inside the socket's `lookup`, and **every** resolved address must be public: loopback,
  RFC 1918, link-local incl. `169.254.169.254`, CGNAT / Tailscale `100.64/10`, `0.0.0.0/8`, benchmarking, documentation,
  multicast, reserved, IPv6 loopback / ULA / link-local / multicast / documentation / NAT64, IPv4-mapped IPv6 are refused
  (`address_refused`). The address checked is the one connected to, so DNS rebinding between check and connect does not
  work. IP literals are checked directly.
- Redirects are followed by hand (at most 5), each hop through the same checks (scheme, port, credentials, DNS); a
  redirect to an internal address is refused like a direct one.
- tcp: any port, but the same public-address rule; connect only, nothing is sent or read.
- One deadline per check (≤ 30 s), body read only for the keyword and only 64 KiB, then the socket is destroyed; no
  keep-alive agent. Nothing of the response except the status code, latency and certificate expiry is stored.
- Exceptions exist only as exact origins injected by tests (`MasterDeps.uptime.allowOrigins`); there is no environment
  variable or panel setting that widens the guard.
- Provider checks send only identifiers to Cloudflare / Coolify with the existing master-held tokens (no new token, no
  token in any response, log or check row — asserted in the integration test).

**Abuse / load.** Interval ≥ 30 s (providers ≥ 60 s), 50 monitors per project / 500 total, 16 concurrent checks per
replica, write and check-now rate limits, per-monitor check-now throttle. A monitor cannot be used to hammer a third
party faster than every 30 s per monitor; the total is bounded by the limits (≈ 17 requests/s at the absolute maximum).

**Authorization.** Project-scoped actions with independent expectations in the RBAC matrix; invisible = 404; chat tools
act for the signed-in user with the same actions; card confirmation re-checks `uptime.write`; watches re-check
`uptime.read` on every fire. Notifications go only to project members with operator role or above.

**Untrusted text.** Monitor names and URLs are user input rendered as text; provider status words are clipped and shown
as text; notification and chat texts are built from fixed codes and escaped (`mdText`) names.

**Residual risks.** (1) A public host can still be monitored without its owner's consent — the rate floor bounds it.
(2) Master-only region: a master network outage reads as everything down. (3) The http probe trusts the system CA
store; a site with a private CA is reported as `tls`.

## 11. Operations

- Migration 0066 (tables, constraints for the new notification kinds, chat watch target / conditions, chat draft kind
  `monitor`). Forward-only; rollback = deploy the previous master (the new tables are ignored; the widened CHECK
  constraints accept the old values).
- No environment variables, no Traefik change. Outbound traffic from the master to the monitored sites (http/https
  80/443/8080/8443, tcp to the configured ports) — the control-plane security group must allow egress (it does today).
- Worker release: needed for `list_monitors` / `draft_monitor` and the `monitor` watch target in the chat (the worker
  registers the tool catalog); older workers simply do not offer them.
- Metrics: the tick step is wrapped by the p6-otel step instrumentation (`uptime` step duration); checks and incidents
  are in Postgres for the console.

## 12. Tests

- Unit `apps/master/test/unit/uptime.test.ts`: URL rules, input validation and schedule rules, the status machine
  (retries, recovery, undecided, first up, flapping with one notice and settled status), provider outcome mapping, and
  the SSRF guard against real local servers (loopback / private / CGNAT / metadata / IPv6 / IPv4-mapped / localhost via
  DNS refused; exception exact; redirect hops to internal, localhost and metadata refused; redirect loop; status range;
  keyword present / absent on the first 64 KiB only; max latency; timeout; HEAD; self-signed TLS refused; tcp).
- Integration `apps/master/test/integration/uptime.test.ts` (Postgres, fake HTTP targets, fake Cloudflare / Coolify):
  per-role API, scheduler, incidents, notifications (operators only, no repeat), charts, check-now throttle, pause,
  cascade delete, SSRF on real checks with an internal service that must see zero requests, provider monitors incl.
  undecided token refusal, "Monitor this" + Outputs status, auto-monitor, limits, chat tools + card confirmation, a chat
  watch on a monitor; RBAC matrix and route coverage include every new route.
- Web `apps/web/test/uptime.test.tsx`.

UNVERIFIED: checks against real Cloudflare Pages / Coolify APIs (same endpoints as the deploy pipeline, fake APIs only
here); behaviour behind the production egress (no real site was monitored from the control-plane host).
