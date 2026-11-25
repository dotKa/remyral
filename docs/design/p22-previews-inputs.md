# Design note: `p22-previews-inputs` — preview tools on every runtime, container previews, large sub-job inputs

- **Tasks:** `p8-preview-tools-others`, `p8-preview-container`, `p8-subtask-large-inputs`. **Date:** 2026-11-02.
- **Builds on:** [p8-preview-tunnels](p8-preview-tunnels.md) (ADR-0032), [p8-orchestration](p8-orchestration.md)
  (ADR-0031), [p12-deploy-feedback](p12-deploy-feedback.md) (the shared job-tool channel), ADR-0007 (container
  profile), ADR-0011 (additive protocol).
- **Migration:** 0212 (`job_artifacts.kind` += `subtask-input`). **Worker features:** `preview-container-v1`,
  `subtask-staged-inputs-v1`. **Worker release needed:** yes. **Adapters:** yes (worker bundle).

## 1. What was missing

1. `open_preview` / `close_preview` / `list_previews` (and `publish_site`) existed only as Claude Code's in-process
   MCP server; Codex, Pi and OpenCode jobs could be auto-opened but their agents had no tool.
2. Container-profile jobs got no previews: the dev server runs inside a container with `--network none` or a per-job
   `--internal` network, unreachable from the worker's localhost where the connector points.
3. A sub-job request carried its input files inline in one control frame, so more than 256 KiB per request was
   refused.

## 2. Preview tools for Codex, Pi and OpenCode

No new mechanism: every runtime already has a **job-tool channel** that carries the sub-job, deploy, question and
service tools (`JobToolChannel`, `packages/agent-adapters/src/deploy-tools.ts`). It now also carries
`previewTools` — exactly the names the worker's host offers (`previewToolNamesOf`: the three preview tools, plus
`publish_site` when the lease allows it). Specs come from the same zod inputs `runPreviewTool` validates with
(`previewToolSpecs`).

| Runtime (pinned) | Mechanism (unchanged, verified in the adapter) | What changed |
| --- | --- | --- |
| Claude Code | in-process MCP server `remyral-preview` (SDK `createSdkMcpServer`) | nothing |
| Codex 0.162.1 | app-server `thread/start.dynamicTools` (experimental API) → server request `item/tool/call` | `hasJobChannelTools` / `codexSubtaskDynamicTools(ctx)` include the preview tools (ctx is the channel) |
| Pi | the job-tool extension (`pi.registerTool`) relayed as RPC UI dialogs; names in the gate's allowlist and `--tools` | same, through `jobChannelToolSpecs(ctx)` / `jobChannelToolNames(ctx)` |
| OpenCode 1.19.x | local MCP server `remyral-subtasks` (the OpenCode binary in Bun mode) + file relay | the channel the adapter builds lists `previewTools` |

No new CLI flag anywhere. The runtime's own permission prompt is skipped for these tools as for the other platform
tools (the master and the worker's port checks decide). Waits fit every channel: `open_preview` waits ≤ 45 s for the
connector plus ≤ 30 s for the master; the OpenCode MCP timeout (≥ 600 s) and the Pi dialog timeout (11 min) are
longer.

Worker: `previewSupport` gives tools to every runtime (`PREVIEW_TOOL_RUNTIMES`); `publish_site` too. **Unchanged
exception:** Codex in the `runtime-sandbox` profile — its tool sandbox has `networkAccess:false` (sockets blocked), so
its dev server cannot listen; it gets no preview tools (documented, as before). OpenCode and Pi have no runtime
sandbox (the profile is refused for them).

## 3. Container-profile previews (`preview-container-v1`)

Docker / Podman publish no port of a container on `--network none`, and an `--internal` network gives no host
route; giving the job a routable network for `-p 127.0.0.1:P:P` would also give it egress (ADR-0007, T-SBX-2). So
the worker publishes the port itself, **on its loopback only**:

```
cloudflared ──▶ 127.0.0.1:P (+ ::1 best effort; never 0.0.0.0)   worker ContainerPortForwarder
                └─ per connection: <engine> exec -i <job container> node -e <relay> P
                                    └─ stdin/stdout ⇄ net.connect(localhost:P) inside the container
```

- `apps/worker/src/previews/container.ts`: probe (`exec <c> node -e <probe> P`, exit 0 / 3), the per-(job, port)
  listener, ≤ 32 connections per port, closed at job end / worker stop. Every runtime image has `node` (base image).
- The relay runs as the container's user under its restrictions (read-only root, no capabilities, pids limit) and
  only connects to `localhost:P` inside that container. No network, route or published port is added to the job.
- Ownership: the listener is inside the job's own container (one attempt), so the container probe is the ownership
  check, whatever the mode (`owned` for agent requests, `declared` for auto-open / humans). The port policy (range,
  service deny-list, worker ports) applies first; a port already in use on the machine is refused (`worker_port`).
  Forwarded ports count as the worker's own for host-profile jobs (a host job cannot claim them).
- `ContainerSandboxRunner.jobContainers(jobId)`: names of the job's live containers (the only runner change).
- Master: `execution.previews` for container jobs and `previewAvailability` only for workers advertising
  `preview-container-v1`; otherwise the old refusal ("update the worker").
- The TUNNEL_START port re-check runs the same container check (the forwarder is idempotent).

## 4. Large sub-job inputs (`subtask-staged-inputs-v1`)

```
agent request_subtask{inputs} ─▶ worker reads files (no symlinks, ≤ 5 MiB each, ≤ 10 MiB total, redacts text)
  ≤ 256 KiB total  → inline as before (SUBTASK_REQUEST op.inputs)
  >  256 KiB total → per file ARTIFACT_CHUNK… + ARTIFACT_REF `ws-subin-<24 hex>` (sequenced outbox, the existing
                     artifact path; id = H(name, sha256) so a retry / second sub-job is the same artifact)
                   → SUBTASK_REQUEST op.stagedInputs [{name, artifactId, sizeBytes, sha256}]
master: commit → job_artifacts kind `subtask-input` (own budget 32 MiB per attempt, never an output, never listed or
        served — every `kind <> 'site'` reader now also excludes it); create → rows of the parent's LIVE attempt with
        the same id / size / SHA-256 → prepareInput (type, content, secret scan) → the child's inputs.
        Not committed yet → refused `inputs_pending` (not audited); the worker retries the SAME request id every
        second for ≤ 120 s (creation stays idempotent). An ARTIFACT_REF the inbox rejected → `input_refused`.
```

The master sets `execution.subtasks.stagedInputs` only for workers with the feature; older workers keep the inline
limit, older masters never see `stagedInputs`.

## 5. Security review

| Area | Control | Test |
| --- | --- | --- |
| New tool surfaces (Codex / Pi / OpenCode) | Same zod validation, same worker host, same master gates as Claude Code; only names the host offers are declared or dispatched (`publish_site` only with `assigned.publish`) | adapter contract tests per runtime, channel tests |
| Container port exposure | Loopback only (127.0.0.1 / ::1), never 0.0.0.0; relay reaches only `localhost:P` inside the job's own container; port policy first; no network change to the job | `previews-container.test.ts`, manager tests |
| Container egress | Unchanged: no network attached, no `-p`; the relay is an `exec` stdio pipe | args unchanged (`sandbox-container.test.ts`) |
| Staged inputs | Bound to the parent's live attempt (fenced chunks / commit, lease-checked create), id bound to name + hash, own size budget, `prepareInput` scan before the child sees them, hidden from outputs | worker staging tests, protocol schema tests, master integration (written) |
| Old peers | Both features opt-in by advertisement; the master gates on them | integration (assignment by feature) |

Residual: the forwarded port is reachable by any local process of the worker host while the job runs (the same as a
host-profile dev server on localhost); each preview connection costs one `exec` (latency ~0.1–0.3 s on a new
connection). Staged inputs stay stored until the job's files are pruned (counted in the project's storage quota).

## 6. Not verified / live checks

- **UNVERIFIED-LIVE:** a Codex, a Pi and an OpenCode job calling `open_preview` against a real master + Cloudflare;
  a container job (rootless Docker and Podman on Linux) serving Vite on 5173 through the relay, including WebSocket
  HMR; a 2–5 MiB sub-job input over a residential uplink.
- macOS host-restricted jobs: Seatbelt allows listening only for loopback-server runtimes (OpenCode) and services —
  a dev server of a Claude Code / Codex / Pi job may not be able to listen there (pre-existing, unchanged here).
- Master integration tests written, not run in the worktree (need Postgres): `agent-orchestration.test.ts` (staged
  inputs), `preview-tunnels.test.ts` (container assignment by feature).

## Changelog

- feat(master,worker,protocol,agent-adapters): **Codex, Pi and OpenCode agents can open preview links themselves, container-profile jobs get previews, and a sub-job can be handed input files up to 10 MiB** (p22-previews-inputs, [design](p22-previews-inputs.md); evidence backlog `p8-preview-tools-others`, `p8-preview-container`, `p8-subtask-large-inputs`). The preview tools ride on each runtime's existing job-tool channel (Codex dynamic tools, the Pi extension, OpenCode's local MCP server); Codex in its runtime sandbox still gets none (sockets blocked). A container job's port is relayed onto the worker's loopback only (127.0.0.1, never 0.0.0.0) through `exec`, without giving the container a network (worker feature `preview-container-v1`). Sub-job inputs above 256 KiB are staged as hidden artifacts of the requesting attempt and copied into the sub-job's inputs after the usual checks (migration 0212, worker feature `subtask-staged-inputs-v1`). Worker release needed.
