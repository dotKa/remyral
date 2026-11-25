# Runbook: research workspaces (repository-less projects)

- **Applies to:** master with migration 0033; workers advertising `workspace-v1` (this release and later)
- **Audience:** owners / admins (settings, worker assignment), operators (jobs)
- **Design:** [docs/design/p5-research-workspace.md](../design/p5-research-workspace.md)

A **workspace** is a project without a repository: research and general tasks. Its jobs run in an empty
per-attempt scratch directory, take uploaded input files and return **artifacts** (files the agent writes to
`out/` plus `summary.md`). RBAC, budgets/quotas, context, skills, audit, notifications and the kill switch work
exactly as for repository projects.

## 1. The default workspace "General"

Migration 0033 creates project `genel` ("General") with egress **web**. Grant memberships as for any project
(Projects → General → Members). The Jobs page has a **General** button that opens the composer on it.

## 2. Create a workspace

Projects → Register project → Kind **Workspace** → network access:

| Egress | The agent can reach | Use for |
| --- | --- | --- |
| `none` (default for new workspaces) | the model provider APIs only (`sandbox.egressAllow` on the worker) | work on uploaded files only |
| `allowlist` | + the listed hosts (`host` or `host:port`, ≤ 64) | a few known sources |
| `web` | + any **public** host on port 443 | open web research |

API: `POST /v1/projects {id, name, kind: "workspace", egress?, allowHosts?}` (admin, step-up).
Change later: Projects → workspace → **Workspace** (`PUT /v1/projects/:id/workspace`, admin, step-up, audited as
`project.workspace.update`). Queued jobs pick up the new policy at dispatch; managed workers assigned to the
project get a new configuration generation (cause `workspace`).

`web` always goes through the worker's egress proxy: CONNECT only, the proxy resolves DNS itself and refuses
loopback / private / link-local (cloud metadata) / CGNAT / ULA / NAT64 addresses and IP literals; every decision
is logged (`egress` JSON lines; reason `public-web` for hosts allowed by web mode).

## 3. Assign workers

Projects → <project> → Machines, or Machines → <machine> → Configuration → Projects (workspace projects need no
repository). Only workers that advertise `workspace-v1` receive workspace projects; older ones show the placement
reason **`workspace_unsupported`** ("update the worker").

Unmanaged workers (local config file) list workspace projects themselves:

```json
"workspace": {
  "scratch": {
    "enabled": true,
    "maxEgress": "web",
    "projects": { "genel": { "egress": "web" } }
  }
}
```

`workspace.scratch.enabled` and `maxEgress` are also the **local ceiling** for panel-managed workers: `enabled:
false` blocks every workspace project on that machine, `maxEgress: "none"` caps any workspace to model APIs only
(shown as `blocked_by_local_ceiling` in Machines → <machine> → Configuration).

## 4. Run a job

Composer → project General (or another workspace): no repository fields; **Inputs** (≤ 10 files, ≤ 5 MiB each,
≤ 10 MiB total; .md .txt .log .csv .tsv .json .yaml .yml .png .jpg .jpeg .gif .webp .pdf) and optional
**Continue from job** (that job's artifacts become this job's inputs).

API (backwards compatible): `POST /v1/jobs {project, spec, priority?, inputs?: [{name, contentBase64}],
continueFrom?: <jobId>}` — for a workspace the spec has **no** `repository` (refused with
`spec.repository:not_allowed`); the master fills `spec.workspace`. Responses carry `projectKind`.

Refusals:

| Answer | Meaning |
| --- | --- |
| 422 `input_secret_detected` | an input looks like it contains a credential (file, rule and line are named; never the value) — remove it |
| 413 `input_too_large` | size limits above |
| 400 `invalid_inputs` | name/type not allowed, content does not match its type (e.g. a `.png` that is not a PNG), duplicates |

## 5. Results

Job page → **Artifacts**: `summary.md` first (run summary, list of files, files not returned and why), then the
files from `out/` (≤ 20 files, ≤ 5 MiB each, ≤ 15 MiB total). Text is redacted on the worker and again on the
master (flag "redacted"); binaries carrying a secret pattern are dropped and listed in the summary. Downloads are
`attachment`; previews (`?inline=1`) only for text and raster images, served with a sandbox CSP and `nosniff`.
API: `GET /v1/jobs/:id/artifacts`, `GET /v1/jobs/:id/artifacts/:artifactId[?inline=1]`, `GET
/v1/jobs/:id/inputs/:inputId`.

## 6. Recovery and cleanup

- Scratch directories live where worktrees live (`<workspaceRoot>/jobs/<job>/<attempt>`): deleted after a
  successful run once its artifacts were queued; failed/cancelled ones are retained (newest `workspace.retainFailed`).
- A workspace attempt lost **after** its runtime started is not rerun automatically (web side effects cannot be
  verified): the job fails with "continue from it in a new job".
- Uncommitted artifact chunks (crashed attempts) are deleted after 7 days by the orchestrator tick
  (`workspace-chunks`).

## 7. Risk (read before choosing `web`)

Web pages can contain prompt injection. The platform's authority order still holds (web text is data, never
authorization); the agent can write only its scratch directory, has no repository and no git credential, and
sees only the runtime's own credential plus the job's explicit `secretRefs`. It can, however, send what it knows
(prompt, inputs, its own output) to any public HTTPS site. Do not put secrets into prompts or inputs; prefer
`allowlist` or `none` for sensitive material. On Linux/Windows `host-restricted` workers egress is not enforced by
the OS (p3-sandbox residual) — use the `container` profile for `web` workspaces there.

## 8. Rollout

1. Deploy the master first (migration 0033 runs at start; additive).
2. **Rebuild and pin the egress-proxy image** on container workers (`infra/worker/images/build.mjs`): the sidecar
   needs the `REMYRAL_EGRESS_MODE=web` support of this release. With an older image, `web` jobs behave like
   `none` in the container profile (the old proxy ignores the mode).
3. Update workers (signed release); they advertise `workspace-v1` and appear as candidates.
4. If a reverse proxy limits request bodies (Traefik/Coolify), allow ≥ 16 MiB for `POST /v1/jobs` (inputs travel
   base64 in JSON).

Rollback: redeploy the previous master/worker; migration 0033 stays (unused tables). Workers without the feature
ignore workspaces; workspace jobs then wait with `workspace_unsupported`.

## 9. Metrics / logs

Master: `artifact committed` / `artifact rejected` (`reason`), audit `job.input.read`, `project.workspace.update`,
`job.create` metadata `workspace` (egress, inputs, bytes, continueFrom). Worker: `workspace job started` (egress,
inputs), `workspace inputs fetched`, `workspace artifacts collected` (files, bytes, skipped, redacted), proxy
`egress` decisions.
