# p22-worker-limits — four open worker limits

Status: implemented 2026-11-02; two parts opt-in until their live check passed. **Migration:** none. **Protocol:** no
wire change (worker-internal settings; the `start_service` description text). **Worker release needed:** yes (job runner
version 3, services, Linux views). Master: workspace-project egress for services / IDE servers.

| Backlog task | Result |
| --- | --- |
| `p19-linux-net-isolation` | Implemented behind `sandbox.linuxPrivateNetwork` (**default `off`**) plus a network self-check; gated per run kind (§2). |
| `p19-linux-local-login-parallel` | Implemented behind `sandbox.linuxLoginStoreView` (**default `false`**); live check steps in §3.4. |
| `p9-windows-worker-token-privileges` | Implemented in `remyral-jobrun.ps1` (version 3); self-test enforces it; live check on Windows (§4.3). |
| p21-service-egress known limits | Workspace projects' services / IDE servers get the project's egress setting; a policy 403 makes a service run fail at once (§5). |

## 1. Owner problem

Four documented residual limits: Linux host attempts share the host network namespace; Linux subscription-login
attempts run one job family at a time; Windows attempts that run as the worker account inherit the service token's
privileges; workspace projects' services reach model APIs only and a refused package install restarts for minutes.

## 2. Linux: a private network namespace per view (`p19-linux-net-isolation`)

### 2.1 Mechanism (`apps/worker/src/sandbox/host/linux-isolation.ts`)

- `--unshare-net`: bubblewrap creates a network namespace with only `lo` (it brings it up itself).
- Relay, host side (`startEgressRelay`): a Unix socket `<tmpdir>/rmy-nXXXXXX/e.sock` (0700 dir, short path — socket
  names are ≤ 107 bytes) whose connections are piped to the attempt's own egress proxy on `127.0.0.1:<port>`.
- The socket is bound into the view at `/tmp/.remyral-egress.sock` (below the view's private tmpfs `/tmp`).
- Relay, view side (`NETNS_RELAY_SCRIPT`): `node -e … -- <socket> <port> <cmd> <args…>` — the worker's own Node
  (bound read-only into the view; no new dependency, no socat / slirp) listens on `127.0.0.1:<port>` of the view's
  loopback (the same port as the proxy, so `HTTPS_PROXY` is unchanged) and pipes each connection to the socket, then
  runs the command with the same stdio and exits with its status (signals passed on and re-raised).
- `network.mode = none`: `--unshare-net` without any relay (no network at all — before, such an attempt had the
  host's network with no proxy variables).

What the view no longer sees: other jobs' egress proxies and servers, services on the host's loopback (databases,
the worker's own ports), abstract Unix sockets (scoped to the network namespace), the host's interfaces and DNS. Its
own loopback works (a test server of the job on `127.0.0.1` is reachable from inside the job).

### 2.2 Who keeps the host network (gate per run kind, `HostRestrictedRunner.#privateNetworkFor`)

| Run kind | Network | Why |
| --- | --- | --- |
| Agent attempt, no previews (`host-restricted`, view active) | **own namespace** | nothing reaches it from outside |
| Job with `execution.previews` (`ctx.hostNetwork`, set by the job runner) | host | the preview port checks (`/proc/net/tcp` owner) and `cloudflared` reach the agent's dev server on host loopback (p8-preview-tunnels §5) |
| Services (`listen`) | host | health probes, tunnels, `service_url` use `127.0.0.1:<port>` (p15-services) |
| IDE servers (`listen`, `loopbackPorts`) | host | bridge port and gateway on host loopback (p19-ide W2b) |
| OpenCode (`listenRuntimes`) | host | the worker drives its loopback API server |
| `allowListen` machines, `runtime-sandbox`, `unconfined`, no view | host | as before |

A port relay *out* of a namespace (for previews / services) was not built: it needs a second, inbound relay, the
preview ownership check per namespace and tunnel changes — a separate task if wanted.

### 2.3 Proof before use: the network self-check

After the cross-attempt check passed and only with `linuxPrivateNetwork: "auto"`: one probe view with
`--unshare-net` behind the forwarder (`NET_PROBE_SCRIPT`). It must reach a stand-in proxy through the relay (`relay`),
must not reach a listener on the host's loopback (`host_loopback`), and its own loopback must work (`own_loopback`).
Passed → `IsolationStatus.privateNetwork = true`, detail "…; network: its own namespace …". Failed → the view stays
active with the host network and the detail says "network: shared with the host (network self-check failed: …)". It
never turns the filesystem isolation off.

### 2.4 Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| An attempt reaches another job's proxy / dev server / the worker's loopback ports | not in its namespace | attempts on the host network (§2.2) as before |
| An attempt bypasses its proxy (direct connection) | no route out of the namespace | — (Linux egress is then enforced for these attempts, as on macOS) |
| The relay socket is reached by another attempt | 0700 dir in the worker's tmp; views have a private `/tmp`; only the attempt's own socket is bound | `unconfined` attempts (unconfined by definition) |
| The forwarder | fixed script in the worker bundle, argv only, no secret | the attempt can kill / replace it inside its own view — it then only loses its own egress |

### 2.5 Default and rollback

Default `off` (owner decision for this change set: the real runtimes inside a namespace — Claude Code, Codex, Pi with
their proxy support, package managers, git — are not verified yet). Rollback: `"linuxPrivateNetwork": "off"` + worker
restart.

### 2.6 Live check (Linux, before switching it on)

1. Set `{"sandbox": {"linuxPrivateNetwork": "auto"}}`, restart the worker, run Prepare: the `host_isolation` check
   detail must end with "network: its own namespace …".
2. Run one job per runtime (Claude Code, Codex, Pi; OpenCode keeps the host network) with an allowlist project:
   it reaches the model API, `npm install` / `pip install` / `git clone https://…` of allowed hosts work, a refused host
   gets the proxy's 403.
3. In such a job: `curl http://127.0.0.1:<a worker / other job port>` must fail; `python3 -m http.server 8000 &` +
   `curl 127.0.0.1:8000` inside the job must work.
4. A job with previews (`open_preview`) and a service still work (host network).
5. Under the hardened systemd unit (`PrivateNetwork` is not set; `RestrictAddressFamilies` must allow `AF_UNIX` and
   `AF_NETLINK` for bwrap's loopback setup).

## 3. Linux: subscription-login attempts in parallel (`p19-linux-local-login-parallel`)

### 3.1 Why not a read-only home with the stores bound

Claude Code rewrites `~/.claude.json` atomically (temp file + rename in `$HOME`) and takes its refresh lock as
`~/.claude.lock` (a directory created next to `~/.claude`). Both need `$HOME` itself writable: a rename onto a
bind-mounted file fails (`EBUSY`) and `mkdir` in a read-only home fails (`EROFS`). Overlay mounts (`--overlay`) need
bubblewrap ≥ 0.10 (Ubuntu 24.04 ships 0.9).

### 3.2 The login-store view (`sandbox.linuxLoginStoreView: true`; `HostRestrictedRunner.#loginStoreHome`)

- The worker HOME becomes a **private tmpfs** at its own path (writes there are discarded with the attempt).
- Every top-level entry is bound back **read-only**, except the login stores and caches (`.cache`, `.npm`, `.yarn`,
  `.pnpm-store`, `.bun`, `.gradle`, `.m2` start fresh — a read-only cache would fail installs).
- The login stores are bound **read-write**: `~/.claude`, `~/.codex`, `~/.local/share/opencode`, `~/.pi/agent` (and
  `hostExtraWritable` entries inside the home).
- Their **trusted configuration** is bound read-only on top (`LOGIN_STORE_PROTECTED`): `.claude/{settings.json,
  settings.local.json, CLAUDE.md, commands, agents, hooks, skills, plugins, output-styles}`, `.codex/{config.toml,
  AGENTS.md, prompts, skills}`, `.pi/agent/{settings.json, AGENTS.md, extensions, skills, prompts}`. Missing ones are
  created first (`{}` for JSON, empty otherwise, empty dirs) — otherwise an attempt could plant one that the next job
  family executes.
- `~/.claude.json` is a **private copy** (copied to `<sandbox>/login-seed/` and into the tmpfs home by a fixed `sh`
  prelude), so its atomic rewrite works; the attempt's changes to it are discarded (it also cannot plant user-scope MCP
  servers there for others).
- `~/.claude.lock` lands in the private home: **the refresh lock is per attempt, not shared** (live check §3.4).
- Selection: with the view, `selectProfile` no longer applies the one-family rule to bwrap local-login attempts
  (`hostRestricted.loginStoreView`); the Sandbox card note says so.

### 3.3 Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| A plants `~/.gitconfig`, shell rc, tools for B | home entries read-only, writes go to A's tmpfs | — |
| A plants runtime config / hooks / MCP servers for B | trusted config read-only (created when missing); `.claude.json` private copy | config paths a runtime adds later (list to maintain) |
| A reads B's transcripts in the shared store | as before within a family; now across families | same login = same owner; documented |
| Concurrent OAuth refresh | — | per-attempt lock (§3.4 decides) |

### 3.4 Live check (Linux, before switching it on)

1. `{"sandbox": {"linuxLoginStoreView": true}}` (+ `keepHome: true` as for every local-login runtime), restart — or,
   since p22-sandbox-settings, Yerel ayarlar → Linux sandbox ayarları → "Abonelik işleri paralel" in the panel, then restart.
2. Two Claude Code subscription-login jobs of different projects at once: both run (Sandbox card note "…private home
   …"), both finish; the worker's `~/.claude.json` is unchanged afterwards except by the worker itself.
3. Force a token refresh while both run (an expired access token in `~/.claude/.credentials.json`, or a run longer
   than the token lifetime): both continue, and a third job afterwards still has a valid login. If one of them gets
   a 401 / "invalid_grant", the per-attempt lock is not enough: keep the setting off.
4. Codex: two subscription jobs at once; `~/.codex/auth.json` refreshes; sessions land in `~/.codex/sessions`.
5. A job that writes `~/.claude/settings.json` or `~/.codex/config.toml` gets `EROFS`; the files keep their content.

## 4. Windows: privilege-stripped token (`p9-windows-worker-token-privileges`)

### 4.1 Change (`infra/worker/windows/remyral-jobrun.ps1`, version 3)

`Run` (no `runAs`) no longer calls `CreateProcessW` with the service's token. It opens its own primary token
(`OpenProcessToken`: `TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT`), derives
`CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 0, NULL, &restricted)` and starts the child with
`CreateProcessAsUserW(restricted, …)` — suspended, assigned to the job object, resumed, the same handle list and
window station (`lpDesktop` is only set for per-job accounts). APIs (advapi32, documented in the Win32 security
reference): `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE` (0x1) deletes every privilege except
`SeChangeNotifyPrivilege`; deleted privileges cannot be re-enabled by the child. A restricted version of the caller's
own primary token needs no `SeAssignPrimaryTokenPrivilege` for `CreateProcessAsUser` (the same pattern sandboxed
browsers use from unprivileged processes). `GetTokenInformation(TokenPrivileges)` reads the result back.

### 4.2 Self-test

`-SelfTest` runs the limited job through the stripped token (as every real start does) and then fails with
"the stripped token still holds N privilege(s) besides SeChangeNotifyPrivilege" if any other privilege is in it. A
failing self-test makes the job runner `job_runner_selftest_failed` → host profiles not ready (fails closed). Per-job
accounts (`runAs`) are unchanged (their logon token holds only standard user rights).

### 4.3 Live check (Windows)

1. Update the worker; Sandbox → Prepare: `remyral-jobrun ok 3`.
2. A host job runs `whoami /priv`: only `SeChangeNotifyPrivilege` is listed (before: `SeImpersonatePrivilege`,
   `SeAssignPrimaryTokenPrivilege`, `SeIncreaseQuotaPrivilege` …).
3. Claude Code / Codex jobs, a service and an IDE server start and stop normally (kill-on-close still ends the tree).

## 5. Services and IDE servers of workspace projects; a policy 403 is final

- Master: `loadProjectEgress` (`apps/master/src/repo-egress/service.ts`): a workspace project → its Workspace-tab
  setting (`project_workspaces.egress` / `allow_hosts`, the same modes; no row → `none`); a repository project →
  `loadRepoEgress` as before. Used by `ServiceRegistry#withNetwork` and `IdeService#withNetwork` (files IDEs too). A
  change of the Workspace setting re-sends the project's running services (`onEgressChanged`, as for Network access).
- Worker: services and IDE servers use `projectProcessNetworkPolicy` — the job's rules with a 403 hint naming both
  screens (the worker does not know the project kind).
- Worker: the host runner reports each launch's proxy decisions (`SandboxContext.onEgressDecision`). A service run that
  saw a `not-allowlisted` refusal, then exits non-zero without having been healthy, is `failed` at once with
  "network policy refused <host> (egress proxy 403); not restarted. Allow it in Projeler → Politika → Ağ erişimi (or the
  Workspace tab …)" — no restart loop. A floor refusal (private address) or an unhealthy kill keeps the restart policy.
  A policy change re-sends the service at a new revision and it starts again.
- Assistant: the `start_service` description says the Workspace tab applies to workspace projects and that a 403 makes
  the service fail at once naming the host.

## 6. Tests

- `apps/worker/test/p22-worker-limits.test.ts` (18): view arguments (`--unshare-net`, relay bind, login-store home order
  and masks), forwarder + network probe as real processes (relay, own loopback, exit code), the host relay, the
  network self-check (auto pass / leak / off), runner argv per run kind (agent → namespace + forwarder; services, IDE,
  previews, OpenCode → host network; mode none), the login-store view (tmpfs home, stores, protected config created,
  `.claude.json` seed), selection with `loginStoreView`, the job runner script (token APIs, no `CreateProcessW`,
  version 3, self-test check), the service hint.
- `apps/worker/test/services-manager.test.ts`: a policy 403 → failed once, no restart, detail names the host; a floor
  refusal keeps the restart policy.
- `apps/master/test/unit/project-egress.test.ts`; `apps/master/test/integration/repo-egress.test.ts` (Postgres:
  `loadProjectEgress` for a workspace project with / without settings).

Not verified here (live checks): §2.6 (real bubblewrap + runtimes; the Linux integration test was not extended),
§3.4, §4.3.

## Changelog

- fix(master,worker,protocol): **services and IDE servers of workspace projects get the project's network setting, a package install refused by that setting fails at once naming the host, Windows host jobs no longer carry the worker service's privileges, and Linux gets opt-in private network namespaces and parallel subscription-login jobs** (p22-worker-limits, [design](p22-worker-limits.md); evidence: the four documented limits of p19-linux-host-isolation, p9-windows-host-isolation and p21-service-egress). Master `loadProjectEgress` (Workspace-tab egress for workspace projects; a Workspace change re-sends running services); worker services fail on a policy 403 instead of restarting; job runner v3 starts worker-account children with `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` (self-test enforced); `sandbox.linuxPrivateNetwork` (`--unshare-net` + Unix-socket relay to the job's proxy; services, IDE, OpenCode and preview jobs keep the host network) and `sandbox.linuxLoginStoreView` — both off until their live checks. Worker release needed.
