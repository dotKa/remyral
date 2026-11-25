# ADR-0032: Preview links through Cloudflare Tunnel — a per-tunnel connector token may reach a worker

- **Status:** Accepted — owner-approved plan, 2026-10-16 — the job tool channel also carries `publish`
  (`publish_site`) since [ADR-0038](0038-pre-approved-publish-bundle.md)
- **Date:** 2026-10-16
- **Deciders:** owner; implemented by `p8-preview-tunnels`
- **Amends:** [ADR-0028](0028-master-held-deploy-tokens-and-ops-actions.md) §1 ("never sent to a worker") for exactly one
  narrowly scoped credential — the connector token of one preview tunnel — and §6 ("nothing in job output can request an
  ops action") for one kind: a running job may ask for a `tunnel.open` / `tunnel.close` of **its own** localhost port.
- **Related:** docs/design/p8-preview-tunnels.md (design + security review), docs/compat/cloudflare.md §Preview tunnels,
  ADR-0004 (lease fencing), ADR-0007 (sandbox profiles), ADR-0010 (untrusted repository content), AGENTS.md rules 3, 4, 10.

## Context
The owner wants a link to what a job builds: a web app's dev server, or the backend an APK talks to — with a **stable**
address, because the APK is built with it and installed elsewhere. Workers are outbound-only (AGENTS.md rule 3), so the
only way in is an outbound tunnel. Cloudflare Tunnel needs a `cloudflared` connector on the machine that serves the port,
and that connector needs a credential. Until now no Cloudflare credential ever reached a worker (ADR-0028 §1).

## Decision
1. **The master still holds the account token.** It creates one **remotely-managed** named tunnel per preview
   (`POST …/cfd_tunnel {config_src: "cloudflare"}`) with exactly one ingress rule `hostname → http://localhost:<port>`
   (plus the mandatory 404 catch-all), the proxied CNAME `<hostname> → <tunnel id>.cfargotunnel.com` in the project's
   preview zone and, when asked, a Cloudflare Access application. Token scopes the owner adds: Account → Cloudflare
   Tunnel → Edit, Account → Access: Apps and Policies → Edit (and Access: Service Tokens → Edit for service-token
   protection). Test connection reports which are missing.
2. **Only the connector token of that tunnel reaches the worker** — in `TUNNEL_START`, a control message (never in the
   durable outbox), signed with a lease key over worker, job, attempt, epoch, tunnel, port, hostname, window and the
   token's SHA-256. The master never stores it (it is fetched from Cloudflare for every send), never logs it (log
   redaction path `connectorToken`), never puts it in an API answer, audit row, job environment or workspace. The worker
   writes it to a 0600 file in its own data directory (which every job sandbox denies) and runs
   `cloudflared tunnel --no-autoupdate run --token-file <file>` — never `--token` on a command line. The token can only
   run a connector for that one tunnel, whose routing lives in Cloudflare (the connector cannot change it).
3. **Revocation is deletion.** Closing a preview stops the connector and deletes the Access app, the service token, the
   DNS record and the tunnel; deleting the tunnel revokes its token. A stable tunnel re-attached to a later job gets a
   new tunnel secret first (`PATCH …/cfd_tunnel/{id} {tunnel_secret}`) and its old connections are cleaned up, so the
   previous holder's token stops working.
4. **A job may ask for a preview of its own port** (amends ADR-0028 §6). The agent tool `open_preview` (Claude Code,
   in-process MCP server `remyral-preview`) and the job's auto-open send `PREVIEW_REQUEST`, fenced by the live lease;
   the job's creator is re-authorized (`previews.open`); the project must have preview links set up and "agents may
   open previews" on. The worker vouches for the port first: 1024–65535, not a known service port (SSH, RDP, VNC,
   databases, container and cluster APIs, cloudflared metrics …) and not one of the worker's own; a listener on
   loopback that belongs to the job's process tree (`owned`), or — only for the port a human declared at submission or
   opens from the job page — any listener that is not the worker's (`declared`). The master can only expose
   `localhost:<that port>` of the job's own worker: no other host, no path, no ingress choice.
5. **Policy** (ops actions `tunnel.open`, `tunnel.close`, `tunnel.extend`, audited and listed with deploys):
   job-bound open and its extensions — `policy.previewTunnel`, default **auto** (owner decision: previews are open
   links by default, within limits); a **new stable reservation** and its renewal — `policy.stableTunnel`, default
   **approval** (project admin); close — auto, always. Limits per project (open previews, default 5) and per job
   (default 3), the shared ops rate limit, unguessable hostnames (`[prefix-]<name>-<10 random base32>`), job-bound
   lifetime 4 h by default and 24 h at most (closed when the attempt ends), stable 30 days at most (renewable; the
   connector runs only while a job serves it). The console host, control-plane addresses and the project's protected
   names are refused as hostnames (ADR-0028 §4 checks).
6. **Service-token protection hands the Access service token to the job that opened it** — the APK must send
   `CF-Access-Client-Id` / `-Secret`, so the job that builds it needs them. The secret is stored encrypted (HKDF sub-key
   `preview-tunnels`, AAD per tunnel), returned only to that job's live lease and to a project admin with an
   always-fresh step-up (audited), and deleted with the preview.

## Threat model impact
| Threat | Mitigation | Residual |
| --- | --- | --- |
| A prompt-injected agent exposes a machine service (SSH, a database, the worker's own ports) | Port range + deny-list + worker-own ports; listener must be in the job's process tree; only `localhost:<port>` of the job's worker; container profile refused | A service the job itself starts and exposes on purpose |
| The connector token leaks from the worker | 0600 file in the worker data dir (sandboxes deny it), never on argv / env; scoped to one tunnel; deleted (revoked) at close, rotated on re-attach | Host profiles without a sandbox (`unconfined`) could read it while the preview is open; its holder can only serve *that* hostname |
| The connector token leaks from the master | Never stored; redacted from logs; not in API, audit, ops rows; fetched per send | Master process memory while it is sent |
| A public preview leaks data | Default public by owner decision; "public link" warning in the console; unguessable hostname; TTL; auto-close at job end; Access e-mail or service-token protection per preview | Whoever is given the link |
| Hostname hijack of the console or mail | ADR-0028 protected-record checks on the generated hostname and any existing record; collision with an existing record refused | — |
| A stale worker or replayed message opens / keeps a tunnel | PREVIEW_REQUEST fenced to the live lease; TUNNEL_START signed, ≤ 5 min old, bound to attempt + epoch, re-checked by the worker; reconnect reconciliation stops unknown connectors | — |
| Runaway tunnels / cost | Per-project and per-job limits, ops rate limit, sweep closes expired and orphaned tunnels and retries failed tear-downs | Cloudflare resources if the master is down past the TTL (cleaned on the next sweep) |

## Rollback
- **Of a preview:** close it (job page, `close_preview`, or it expires) — every Cloudflare resource is deleted.
- **Of the feature:** clear Project → Deploy → Preview links (no new previews; open ones close at expiry or on close);
  or remove the token scopes in Cloudflare. Migration 0067 is additive (table `preview_tunnels`, new ops kinds and
  `via: job`, `workers.preview_tunnels`, the package size check). Older workers do not advertise `preview-tunnels-v1`
  and never get `execution.previews` or `TUNNEL_START`.

## Alternatives considered
- **`cloudflared` quick tunnels (`trycloudflare.com`)** — no stable hostname (APK requirement), no Access, no account
  control, random third-party domain.
- **A connector on the master that reaches the worker** — workers are outbound-only and not reachable; it would need a
  second tunnel from the worker anyway.
- **The account token on the worker** (`cloudflared tunnel create` locally) — far broader than one tunnel; rejected
  (ADR-0028 rationale).
- **Locally-managed tunnels with a credentials file** — the worker could then change ingress; remotely-managed config
  keeps the routing on the master.

## Verification
apps/master/test/integration/preview-tunnels.test.ts (fake Cloudflare API: exact Tunnel / DNS / Access calls, signed
TUNNEL_START, token absent from rows / audit / logs / responses, lease fencing, limits, Access e-mail + service-token
protection, reveal with step-up, stable approval → detach → re-attach with rotated secret, expiry and job-end sweep,
reconnect reconciliation), apps/master/test/unit/preview-tunnels.test.ts, apps/worker/test/previews-*.test.ts (port
policy and probes, supervisor with a fake cloudflared, signature / freshness / attempt checks), packages/agent-adapters
/test/preview-tools.test.ts. **UNVERIFIED-LIVE** until the owner adds the token scopes and opens a first preview
(docs/guide/tr/onizleme-tunelleri.md).

## Addendum 2026-10-21 — tunnels of services (p15-services)

Owner problem: a dev server kept up for a tunnel holds a job open (job timeout, job slot). p15-services
(docs/design/p15-services.md) adds **services** — long-running processes the worker owns, not a job — and amends this
ADR for their tunnels:

1. **Named service tunnels** are created by the master exactly as job previews are (one remotely-managed tunnel, one
   ingress rule `hostname → http://localhost:<port>`, proxied CNAME, optional Access), recorded in `preview_tunnels`
   with `service_id` instead of a job. Only that tunnel's connector token reaches the worker, in `SERVICE_TUNNEL`
   (control, signed with the lease key over worker, service, tunnel, hostname, port, window and the token's SHA-256,
   ≤ 5 min old), fetched from Cloudflare per send and never stored. They need the project's preview-link settings and
   `policy.previewTunnel = auto` (an approval is for job previews), count against the project's open-preview limit,
   follow the service's lifetime and are deleted (revoked) when the service stops or is removed.
2. **Quick tunnels** (`cloudflared tunnel --url http://localhost:<port>`, a random `trycloudflare.com` name, no
   account, no credential on the worker) — rejected above for job previews (no stable name, no Access) — are allowed
   **for services**: the owner asked for them; they need no Cloudflare credential at all, are public (the console
   says so), last only while the service runs and are refused to a job's agent when the project turned "agents may
   open previews" off.
3. Service connectors run in a supervisor of their own (`<dataDir>/services/tunnels`) and are reported in
   SERVICE_STATUS, never as preview connectors. Before a connector starts, the port must be served by the service's
   own process tree (the port policy of decision 4).

