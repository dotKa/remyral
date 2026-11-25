# Design note: `p8-preview-tunnels` — preview links through Cloudflare Tunnel

- **Task:** `p8-preview-tunnels` (follow-ups `p8-preview-tunnels-live`, `p8-preview-tools-others`,
  `p8-preview-container`). **Date:** 2026-10-16 — owner-approved plan.
- **Decision:** [ADR-0032](../adr/0032-preview-tunnels-connector-token-to-worker.md) (amends ADR-0028 §1 / §6).
- **Owner decisions:** protection default **open** (public link), optional per preview: Cloudflare Access e-mail
  one-time PIN allowlist, or a per-tunnel Access service token (mobile backends). Preview domain **per project**
  (Project → Deploy: zone + optional prefix; a zone of the connected account; console host, control-plane addresses and
  protected names refused — the ADR-0028 checks).
- **Provider facts:** [docs/compat/cloudflare.md §Preview tunnels](../compat/cloudflare.md) (Context7, 2026-10-16).
- **Migration:** 0067 (`preview_tunnels`, ops kinds `tunnel.*`, `via: job`, `workers.preview_tunnels`, package size
  check). **Worker release needed:** yes (`preview-tunnels-v1`, the `cloudflared` recipe, the tools).

## 1. Scenario

A job builds a web app (and a mobile app). The owner wants a link to the running dev server — or the APK is built
against a backend that a job serves, and the owner installs the APK and tests it remotely. That needs a **stable**
hostname (it is compiled into the APK).

```
 agent: open_preview{port}   human: job page "Open"   spec.previews.autoOpen (port declared at submission)
            │                        │                         │
            ▼ worker: port checks    │                         ▼ worker watches the port, then asks
   PREVIEW_REQUEST (lease-fenced) ───┼──────────▶ master: ops action tunnel.open (policy, limits, audit)
                                     ▼              │  POST cfd_tunnel · PUT configurations (1 ingress rule)
                               POST /jobs/:id/previews  POST dns_records CNAME → <id>.cfargotunnel.com
                                                    │  [POST access/service_tokens] [POST access/apps]
   worker ◀── TUNNEL_START{connectorToken, signed} ─┘  (token fetched via GET …/token, never stored)
   cloudflared tunnel --no-autoupdate run --token-file <dataDir>/previews/<id>.token   (supervised child)
   TUNNEL_STATUS starting → running ──▶ master (job page, chat note, Outputs)
   job ends / TTL / close ──▶ TUNNEL_STOP; delete Access app, service token, DNS record, tunnel (revokes the token)
```

## 2. Pieces

| Piece | Where |
| --- | --- |
| Wire (feature `preview-tunnels-v1`, PREVIEW_REQUEST / PREVIEW_RESULT / TUNNEL_START / TUNNEL_STOP / TUNNEL_STATUS, signatures, port policy, `JobSpec.previews`, `execution.previews`, CAPABILITIES.previewTunnels) | `packages/protocol/src/previews.ts` |
| Ops kinds `tunnel.open / close / extend` (params, policy fields, `DeployTargets.previews`) and the kind-handler hook | `apps/master/src/ops/{model,service}.ts` |
| Cloudflare Tunnel / Access calls; Test connection scope probe | `apps/master/src/ops/{cloudflare,integrations}.ts` |
| Pure rules (hostnames, lifetimes, decision, availability) | `apps/master/src/previews/model.ts` |
| Service: kind handler, PREVIEW_REQUEST, TUNNEL_STATUS, CAPABILITIES reconciliation, assignment, sweep, console API, chat note | `apps/master/src/previews/service.ts` |
| REST + OpenAPI | `apps/master/src/previews/routes.ts` |
| Outputs: open previews as `site:tunnel:<id>:preview` items; `.apk/.aab/.ipa` workspace outputs (≤ 80 MiB, ≤ 2 per job, download only) | `apps/master/src/outputs/*`, `apps/master/src/workspaces/service.ts`, `packages/protocol/src/workspace.ts` |
| Worker: `cloudflared` recipe (2026.10.0; raw / tgz install formats), port checks, connector supervisor, preview manager (tools, auto-open, TUNNEL_START checks) | `apps/worker/src/tools/*`, `apps/worker/src/previews/*`, `apps/worker/src/jobs/runner.ts` |
| Job tools `open_preview` / `close_preview` / `list_previews` (Claude Code, in-process MCP `remyral-preview`) | `packages/agent-adapters/src/preview-tools.ts` |
| Console: Integrations health row, Project → Deploy → Preview links, job Preview card, composer option, Deploys labels, Outputs | `apps/web/src/api/previews.ts`, `apps/web/src/screens/{deploy,job,composer,outputs}/*` |

## 3. Policy and limits

| Action | Decision (default) | Notes |
| --- | --- | --- |
| `tunnel.open` job-bound (any protection) | `policy.previewTunnel` (**auto**) | owner decision: open by default |
| `tunnel.open` re-attach of an existing stable name | `policy.previewTunnel` | the reservation was decided before |
| `tunnel.open` new stable reservation | `policy.stableTunnel` (**approval**) | project admin, Deploys page; the job's tool reports "pending" |
| `tunnel.extend` job-bound | `policy.previewTunnel` | ≤ 24 h from now |
| `tunnel.extend` stable (renew) | `policy.stableTunnel` | ≤ 30 days from now |
| `tunnel.close` | auto, always | never rate limited for the system |
| refusals | refused (recorded, audited) | not set up, job not running, container profile, worker without the feature / cloudflared, limits (default 5 open per project, 3 per job), protection not offered (`access` needs e-mails), protected / existing hostname, stable name served by another running job |

Who may request: people with `previews.open` (operator) from the job page / REST; a job's agent or auto-open as
`system:job:<id>` with `via: job`, the job's creator re-authorized (`previews.open`, account not disabled). The project
switch "agents may open previews" (default on) gates the agent tool; humans can always open. Ops actions keep their
idempotency key (`pv-<requestId>` for job requests) and the shared ops rate limit.

## 4. Lifecycle

- **Job-bound:** lifetime 4 h by default, 24 h at most; closed when the attempt is no longer the live lease (job ended,
  lease lost) or at expiry — `preview-tunnels` tick step (`PreviewService.sweep`, 20 per pass).
- **Stable:** the hostname (`[prefix-]<name>-<random>`) is fixed per project and name; up to 30 days, renewable. The
  connector runs only while a job serves it: when the job ends the tunnel **detaches** (`idle`, connector stopped,
  DNS / Access kept); a later job that opens the same name re-attaches it after `PATCH tunnel_secret` + connection
  clean-up (a new token for the new job). Explicit close or expiry deletes everything.
- **Reconnect:** CAPABILITIES.previewTunnels lists running connectors; the master re-sends TUNNEL_START (fresh token,
  fresh signature) for open previews the worker does not run and TUNNEL_STOP for connectors it does not know.
  Disconnected workers show `down` on the job page.
- **Failure:** a failed open tears down what it created; a failed tear-down stays `closing` and is retried; an
  `opening` row older than 10 min (crash mid-open) is torn down.

## 5. Worker side

- **Port checks** (before a request and again at TUNNEL_START): `previewPortProblem` (1024–65535, deny-list of service
  ports), the worker's own listening ports, a listener on loopback (127.0.0.1 / ::1). `owned`: the listener's pid must be
  in the job's process tree (pids from `onProcessSpawned`, descendants from the OS process table; listener pids from
  `/proc/net/tcp{,6}` on Linux, `lsof -nP -a -iTCP:<port> -sTCP:LISTEN -Fp` on macOS, `netstat -ano` on Windows) —
  unverifiable → refused. `declared` (the port a human gave at submission or on the job page): a listener that is not
  the worker's own.
- **Supported profiles:** host-restricted, unconfined, runtime-sandbox for Claude Code (its bash sandbox gets
  `allowLocalBinding: true` only for jobs with `execution.previews`). Container profile: since
  [p22-previews-inputs](p22-previews-inputs.md) on `preview-container-v1` workers (loopback relay into the container);
  Codex runtime-sandbox: no tools (its network sandbox blocks sockets). Tools for Codex, Pi and OpenCode: since
  p22-previews-inputs, on their job-tool channel.
- **Connector supervisor:** token file `<dataDir>/previews/<id>.token` (dir 0700, file 0600, atomic), `cloudflared
  tunnel --no-autoupdate run --token-file …`, minimal environment, no job secrets; running on "Registered tunnel
  connection"; restarts with backoff (≤ 5 in 10 min, then failed); stops at the signed expiry by itself; ≤ 8 connectors
  per machine; stop = SIGTERM, SIGKILL after a grace period, token file deleted; stale token files removed at start;
  only classified reasons reported, never cloudflared output.
- **TUNNEL_START checks:** lease-key signature (always required), issued ≤ 5 min ago, not expired, the job's live attempt
  and epoch on this worker, port re-check in the given mode, cloudflared present.
- **Tools:** `open_preview {port, name?, ttl? (minutes), protect?, stable?}` waits ≤ 45 s for the connector and returns
  the URL, protection, expiry, a public-link warning and — service-token previews — the two headers to send;
  `close_preview {id? | name?}`, `list_previews {}`. Auto-open polls the declared port every 5 s and opens once.

## 6. Security review

| Area | Finding / control | Test |
| --- | --- | --- |
| Credential scope | Only the connector token of one tunnel reaches a worker; the account token never does; the token runs a connector for that tunnel only (routing stays in Cloudflare) | integration: TUNNEL_START carries exactly `GET …/token`'s value |
| Token at rest / in logs | Master: never stored (fetched per send), `connectorToken` log redaction, absent from API / audit / ops rows. Worker: 0600 file in the data dir (job sandboxes deny it), never argv / env | integration canary search over rows, audit, logs, response bodies; worker supervisor test (argv, env, mode) |
| Revocation | Delete tunnel at close (revokes); rotate secret + clean connections on stable re-attach | integration: delete calls, rotated token differs |
| Message authenticity / replay | TUNNEL_START / STOP signed over the full binding incl. token hash; ≤ 5 min freshness; attempt + epoch must be live on the worker; PREVIEW_REQUEST fenced to the live lease | unit signature tests; worker manager tests (tampered, stale, wrong attempt); integration stale epoch refused |
| Exposure of machine services | Port deny-list + range + worker-own ports; listener ownership (process tree) for agent requests; only `localhost:<port>` of the job's worker; container refused | unit port matrix; worker probe tests |
| Untrusted content requesting actions | Only the job's own port; creator re-authorized; project switch; limits; stable reservations need approval by default; the agent cannot pick hostnames or zones | integration: agents disabled, not-declared port, limits |
| Hostname protection | Generated label under the configured zone; ADR-0028 protected-record checks on wanted and existing records; collision refused; zone validated against the token on save | integration: zone not permitted; unit protected names |
| Public links | Default by owner decision; console warning + "public link" badge; unguessable 50-bit label; TTL; job-end close | web tests; unit hostname randomness |
| Service token | Encrypted (sub-key `preview-tunnels`, AAD per tunnel); to the opening job only; reveal = project admin + always-fresh step-up, audited, `cache-control: no-store`; deleted at close | integration reveal + canary |
| Dev-server host checks | Ingress rewrites Host to `localhost:<port>` (Vite / webpack allowed-hosts) | integration ingress body |
| App packages | `.apk/.aab/.ipa` magic (ZIP) checked, ≤ 80 MiB, ≤ 2 per job, own budget, never inline, attachment + nosniff, never job inputs; binary secret scan as for other outputs | integration workspaces (6 MiB APK, fake APK dropped, continue-from skips it) |

Residual risks: anyone with a public link; a job that deliberately serves something sensitive on its own port; the
connector token is readable by `unconfined` jobs of the same machine while the preview is open (it serves only that
hostname); Linux / Windows listener probes are parser-tested only.

## 7. Unverified / owner steps

- **UNVERIFIED-LIVE:** every Cloudflare call ran against the local fake; the owner adds the token permissions
  (docs/guide/tr/onizleme-tunelleri.md), runs Test connection, sets the preview zone and opens a first preview.
- cloudflared flag order and the readiness log line; the macOS archive layout (`cloudflared` at the tgz root) — the
  online recipe test (`REMYRAL_ONLINE_TESTS=1`) checks pins and layout.
- Listener probes on real Linux (/proc) and Windows (netstat); whether bubblewrap host-restricted on Linux lets a job
  listen on localhost.
- Access e-mail protection needs the account's One-time PIN login method.

## 8. Deploy notes

Migration 0067 (additive). No new environment variables (`OPS_CONTROL_PLANE_ADDRESSES` is reused). No Traefik change.
New tick step `preview-tunnels`. Worker release needed; install cloudflared per machine (Machines → Tools).
