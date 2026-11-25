# p14-repo-egress — network access of repository projects, and the tools jobs can call

Status: implemented (worktree branch, 2026-10-21). Migration 0117. Worker feature `repo-egress-v1`. Owner finding
(project "demo-app"): every outbound request of a job (registry.npmjs.org, github.com, example.com …) got an
empty 403 from the platform's egress proxy (127.0.0.1:<port>), so agents could not `npm install`; the assistant told the
owner to look for an egress setting under Projects → Policy that did not exist. Separately, on Linux, `node` / `npm`
were not on the job's PATH although the machine page said "Node 24".

## 1. What was there

- **Workspace projects** have `WorkspaceEgress` none / allowlist / web (`project_workspaces`, p5-research-workspace),
  sent as `JobSpec.workspace.egress` and turned into the sandbox's `NetworkPolicy` by the worker (`networkPolicy()`).
- **Repository projects** had nothing: the worker built `{ mode: 'allowlist', targets: sandbox.egressAllow + MCP hosts }`
  for every repository job (`apps/worker/src/jobs/runner.ts`). `sandbox.egressAllow` is a worker-local list (default
  `api.anthropic.com`, `api.openai.com`, `apps/worker/src/sandbox/config.ts`). No documented project default existed
  beyond "model traffic only" (ADR-0010 rule 3); `network.ts` said "the operator can extend the allowlist per
  project", which was never built.
- The proxy (`apps/worker/src/sandbox/egress/proxy.ts`) refused with `403 Forbidden` and `Content-Length: 0`.

## 2. The setting

`project_repo_egress (project, mode, presets[], hosts[], updated_by, updated_at)` — no row = `none` (today's
behaviour is the default for every existing project).

| Mode        | Jobs reach (always + model APIs + the job's MCP hosts)                         |
| ----------- | ------------------------------------------------------------------------------ |
| `none`      | nothing more (default)                                                          |
| `allowlist` | the hosts of the chosen **presets** + the custom hosts (≤ 48, `host[:port]`)    |
| `web`       | any public host on 443, plus listed `host:port` entries for other ports         |

Presets (`packages/protocol/src/repo-egress.ts` `REPO_EGRESS_PRESETS`, port 443):

- package registries — `npm` (registry.npmjs.org, registry.yarnpkg.com, repo.yarnpkg.com), `pypi` (pypi.org,
  files.pythonhosted.org), `crates` (crates.io, index.crates.io, static.crates.io), `go` (proxy.golang.org,
  sum.golang.org), `maven` (repo.maven.apache.org, repo1.maven.org, plugins.gradle.org, services.gradle.org,
  downloads.gradle.org);
- code hosting — `github` (github.com, api.github.com, codeload.github.com, raw / objects / release-assets
  .githubusercontent.com), `gitlab` (gitlab.com).

The master stores preset **ids** and expands them at assignment, so a corrected preset list reaches every project with
the next master release. The console recommends "allowlist with the package registries" (one-click "apply the
recommendation"); it is not the default, because the default must not widen what existing projects' jobs reach.

**Security floor (unchanged, every mode):** the proxy accepts HTTPS `CONNECT host:port` only, no IP literals, resolves
the name itself and refuses the tunnel if any address is loopback / RFC 1918 / CGNAT / link-local (metadata
169.254.169.254) / ULA / multicast / reserved / mapped forms (`isForbiddenAddress`), then connects to the checked
address. The master accepts only public DNS names (`egressEntryProblem`, the workflow allowlist's check: no IP literals,
no `.local` / `.internal` / `localhost` / metadata names).

**Who may change it:** `projects.egress.write` (project admin) + always-fresh step-up (`PUT /projects/:id/repo-egress`
is in `ALWAYS_FRESH_ROUTES`); `GET` needs `projects.execution.read` (viewer). Every change is audited
`project.repo_egress.update` with before / after and the effective host count; denials are audited by the
authorization layer. Workspace projects are refused (`409 repo_egress_not_repository`): their egress stays on the
Workspace tab.

**Scope:** every repository agent job of the project (host and container profiles), including pull-request checks of
an untrusted source — the admin decides for the whole project; the UI says that web content is untrusted data.
`runtime-sandbox` (Codex's own sandbox) never gives tool commands network, whatever the setting. Not for workspace,
machine-admin, integration or function jobs (those have their own rules).

## 3. Wire and versions

- ASSIGN_JOB `execution.repoEgress: { mode, hosts }` (`AssignedRepoEgress`, strict, `EgressHost` entries, ≤ 80) —
  additive; `execution` is a non-strict object, so older workers ignore it.
- The master sends it only to workers advertising `repo-egress-v1` (`Orchestrator.#repoEgress`), re-read at every
  assignment (a change applies to queued jobs and the next attempt). A read failure is logged and the job runs without
  it (model APIs only — fails closed).
- `GET /projects/:id/repo-egress` lists `unsupportedWorkers` (approved, not revoked / archived, without the feature);
  the panel names them: "they keep model APIs only — update them".
- Deploy order: master first (a new worker's CAPABILITIES with an unknown feature fails validation on an older master),
  then the worker release.

## 4. Worker

- `repoNetworkPolicy(assigned, egressAllow + MCP hosts)` (`apps/worker/src/jobs/repo-egress.ts`): `none` / absent →
  exactly today's list; `allowlist` → + hosts; `web` → `NetworkPolicy.mode = 'web'` (+ hosts). The union stays within
  the sandbox's 128-target bound (48 custom + 22 preset + MCP 32 + model hosts).
- `NetworkPolicy.refusalHint` → the proxy's `refusalHint` (in-process proxy for host profiles, `REMYRAL_EGRESS_HINT` for
  the container sidecar). A refused tunnel now answers `403` with `Content-Type: text/plain; charset=utf-8`,
  `X-Remyral-Egress: not-allowlisted | forbidden-address | bad-request` and a body such as
  `Remyral egress proxy: registry.npmjs.org:443 refused: not allowed by the network policy of this job. project egress
  policy: none (model APIs only) — change it in Projeler → Politika → Ağ erişimi (Projects → Policy → Network access).`
  Private addresses say they are never reachable. Workspace jobs get their own hint. The hint is fixed platform text
  (no secret, no user input except the validated `host:port`).
- An older sidecar image ignores `REMYRAL_EGRESS_HINT` (container jobs then keep the empty 403 until the proxy image is
  rebuilt with the release); the policy itself works with the existing sidecar (`REMYRAL_EGRESS_ALLOW` /
  `REMYRAL_EGRESS_MODE=web`).

## 5. Tools on the job's PATH (problem 2)

**Where "Node 24" comes from:** the tool inventory's `node` entry is `{ found: true, version: process.versions.node }`
(`apps/worker/src/probe/tools.ts` `nodeTool`) — the version of the Node that runs the worker, with `path` only if a
`node` is on PATH or in `wellKnownDirs`. On Linux the installer keeps that Node privately under
`/opt/remyral-worker/node/node-v24.x-linux-<arch>/bin/node` (root-owned, verified; `infra/worker/linux/install.sh`,
`infra/worker/node/install-node.sh`) when no system-wide Node 24 exists, and the systemd unit has no `PATH=`, so jobs
inherited systemd's default PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) without it. It is
neither a fleet-tools install nor nvm. UNVERIFIED on ip-10-0-0-12 itself: confirm with
`systemctl show remyral-worker -p ExecStart` that ExecStart names `/opt/remyral-worker/node/…`.

**Change:** the daemon's `toolEnv` (already prepended the worker-managed tool bin dirs for host profiles) now also
appends `jobToolDirs()` (`apps/worker/src/tools/tool-env.ts`):

- `dirname(process.execPath)` — the worker's own Node with its `npm`, `npx`, `corepack`;
- the directories of the inventory's **system** `node`, `git`, `uv`, `python` hits (managed installs already come
  through `pathDirs`);
- appended after the runtime's PATH (never shadowing a system tool), deduplicated;
- never inside the worker data dir, the workspace root or the worker's HOME (nvm, `~/.local/bin`), and on POSIX never a
  directory the worker account can write (`access(W_OK)`; a failed check counts as writable) — a job running as the
  same account could otherwise plant a binary for later jobs. No secrets: directories only.
- macOS Seatbelt: `<dataDir>/tools` joins `readableInDataDir` (read-only), so the managed tools that were already on
  PATH are actually readable there. Windows per-job accounts already get RX on `<dataDir>\tools` from Prepare
  (`remyral-job-slots.ps1` readDirs); the worker's Node lives in the installer's protected directory (readable by
  Users). Containers are unchanged (their images carry their own tools).

Residual: on Windows `access(W_OK)` does not reflect ACLs, so the writable check is skipped there; only the worker's
own Node dir and the inventory's system node / git / uv / python dirs outside the data dir and the worker profile are
added.

## 6. Assistant

`ASSISTANT_SYSTEM_PROMPT` rule 26 names the real screen (Projects → <project> → Policy → Network access / Projeler →
<proje> → Politika → Ağ erişimi), the modes, the floor, that there is no draft tool for it and never to suggest
NO_PROXY or bypassing the proxy; rule 20's navigation lists "network access" under Policy. `list_projects` returns each
project's `networkAccess` (mode, presets, custom host count, the screen). The prompt runs on the worker that hosts the
assistant, so it ships with the worker release.

## 7. Tests

- master: `test/integration/repo-egress.test.ts` (default none, operator read / admin write, stale step-up refused,
  host validation, presets, workspace 409, 404, audit before / after + denial audit, DB checks, ASSIGN_JOB only to
  `repo-egress-v1` workers with presets expanded, change applies to the next assignment, unsupported workers listed,
  `list_projects.networkAccess`); `step-up.test.ts`, `rbac-matrix.test.ts` updated.
- worker: `test/repo-egress.test.ts` (policy per mode incl. presets; the in-process proxy: none → 403 body with the
  hint and header, plain HTTP hint, allowlist presets pass / others refused, web 443 only, LAN / metadata refused in
  web and for an allowlisted host resolving to a LAN address); `mcp-runner.test.ts` (ASSIGN_JOB → sandbox context per
  mode); `tool-env.test.ts` (PATH composition Linux / macOS / Windows, exclusions, writable dirs).
- web: `test/repo-egress.test.tsx` (TR + EN Diyalog panel, read-only, workspace hidden, classic section, preset parity
  with the protocol).
- protocol: `test/repo-egress.test.ts`; agent-adapters: `test/assistant-network.test.ts`.

UNVERIFIED (needs the real Linux worker ip-10-0-0-12 after the worker release): a job in "demo-app" with
"allowlist + package registries" runs `npm install` successfully; with `none` its npm error shows the new 403 text;
`command -v node npm npx` inside a host-restricted job prints the private Node's dir.

## 8. Rollback

Master: the table stays (older code never reads it); without the route the console shows the panel's load error.
Worker: an older worker ignores `execution.repoEgress` and the PATH change goes with the release.
