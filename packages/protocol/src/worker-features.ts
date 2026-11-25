import { z } from 'zod';

/** Features a worker advertises in CAPABILITIES (additive in 1.0). */
export const WorkerFeature = z.enum([
  /**
   * Applies panel-managed configuration (ADR-0015): understands APPLY_WORKER_CONFIG, answers with
   * WORKER_CONFIG_STATUS and reports `workerConfig` in CAPABILITIES. The master sends APPLY_WORKER_CONFIG only
   * to workers that advertise it.
   */
  'worker-config-v1',
  /**
   * Panel credential vault and model settings (p5-credentials-models, ADR-0016): announces a vault key and
   * held credentials in CAPABILITIES.credentialVault, understands APPLY_CREDENTIAL / REVOKE_CREDENTIAL /
   * ROTATE_VAULT_KEY (answers CREDENTIAL_STATUS), accepts `credentialRef.source = "vault"` and the Claude
   * Code / Codex `model` settings in APPLY_WORKER_CONFIG.
   */
  'credential-vault-v1',
  /**
   * Remote operations (p5-remote-ops, ADR-0017): understands OPS_COMMAND (runtime install / remove / restart,
   * login relay, service restart, logs, diagnostics), answers OPS_UPDATE and reports CAPABILITIES.remoteOps.
   */
  'remote-ops-v1',
  /**
   * Ops chat assistant host (p5-ops-chat, ADR-0018): understands ASSISTANT_TURN / ASSISTANT_TOOL_RESULT /
   * ASSISTANT_CANCEL, answers ASSISTANT_UPDATE and reports CAPABILITIES.assistant.
   */
  'assistant-v1',
  /** Accepts JOB_MESSAGE (a human message to the running agent of a job, p5-ops-chat). */
  'job-message-v1',
  /**
   * p15-message-delivery: answers JOB_MESSAGE carrying `receipts: true` with JOB_MESSAGE_STATUS (received / delivered /
   * read / failed with a reason), dedupes messages by id and delivers them without blocking other job messages.
   */
  'job-message-receipts-v1',
  /**
   * Research workspaces (p5-research-workspace): runs jobs of workspace projects (JobSpec.workspace, scratch
   * directory, JOB_INPUT_REQUEST / ARTIFACT_CHUNK, egress modes) and accepts `workspaces` in APPLY_WORKER_CONFIG.
   */
  'workspace-v1',
  /**
   * p16-workflow-quality: runs a repository-less workflow step of a repository project
   * (`JobSpec.workspace.scratch`) in a scratch directory — the project must be one of its repository projects. The
   * master sends such a step to no worker without it.
   */
  'repo-scratch-v1',
  /**
   * p5-sandbox-ops (ADR-0019): reports CAPABILITIES.sandboxStatus, runs OPS_COMMAND `sandbox.prepare`, accepts
   * `allowUnconfined` in APPLY_WORKER_CONFIG and the `unconfined` profile (with `execution.unconfinedOptIn`).
   * The master sends none of these to workers without it.
   */
  'sandbox-ops-v1',
  /**
   * p5-full-access (ADR-0020): accepts `approvalPolicy: "allow-all"` (every runtime tool call runs without asking,
   * mapped to the runtime's own never-ask mode) with `execution.autoApproveOptIn`. The master sends such a job
   * to no worker without it.
   */
  'full-access-v1',
  /**
   * p5-machine-admin (ADR-0021): runs `machine-admin` jobs (elevated commands through the root/SYSTEM helper,
   * MACHINE_ADMIN_REQUEST / DECISION / RESULT), accepts `machineAdmin` in APPLY_WORKER_CONFIG and reports
   * CAPABILITIES.machineAdmin. The master sends none of these to workers without it.
   */
  'machine-admin-v1',
  /**
   * p17-worker-1-1-1: MACHINE_ADMIN_REQUEST carries the agent's `purpose` of each elevated command (unverified, not
   * signed). The master stores and shows it when present; nothing depends on it.
   */
  'machine-admin-purpose-v1',
  /**
   * p5-machine-admin: reports CAPABILITIES.toolInventory and runs OPS_COMMAND `tools.detect`, `tool.install`,
   * `tool.remove` and `machine.inspect`.
   */
  'tools-v1',
  /**
   * p5-machine-admin (ADR-0021): accepts `panelSkillKeys` in APPLY_WORKER_CONFIG and trusts skills signed by the
   * panel skills key (unless the local ceiling forbids it), next to the offline keys of its local config.
   */
  'panel-skills-v1',
  /**
   * p5-openhands-model-headers: accepts `JobSpec.modelProfile` (the job's catalog model profile: runtime model
   * string and credential reference). The master sends it to no worker without this feature.
   */
  'model-profile-v1',
  /**
   * p6-automations-next (ADR-0026): checks out `JobSpec.repository.pullRequest` (an untrusted pull request head
   * pinned to its SHA, fetched into a quarantine mirror, container only, never pushed). The master sends such a job
   * to no worker without it.
   */
  'pr-head-v1',
  /**
   * p6-deploy-pipeline (ADR-0028): builds `JobSpec.siteBundle` — packs the built static site into one secret-scanned
   * `site-bundle.json` artifact. The master sends such a job to no worker without it.
   */
  'site-bundle-v1',
  /**
   * p6-warm-caches (ADR-0029): hands the project's shared package caches to trusted host-profile jobs when the lease
   * says `execution.packageCaches`, accepts `workspace.packageCacheMaxBytes` in APPLY_WORKER_CONFIG and reports
   * CAPABILITIES.packageCaches. The master sends the config key to no worker without it.
   */
  'package-caches-v1',
  /**
   * p6-worker-boot-diagnostics: `logs.tail` honours `source` (`worker` | `boot` | `updater`). The master sends a
   * non-default source to no worker without it (an older worker would ignore the field and return its worker log).
   */
  'logs-source-v1',
  /**
   * p6-approval-mode-switch: understands SET_APPROVAL_POLICY (a running job's new approval mode, signed, fenced by
   * attempt + epoch) and answers APPROVAL_POLICY_STATUS. The master refuses to switch a running job on a worker
   * without it.
   */
  'approval-mode-switch-v1',
  /**
   * p15-autonomy: understands SET_TIME_LIMIT (a running job's new time limit, signed, fenced by attempt + epoch) and
   * answers TIME_LIMIT_STATUS. Without it a change applies to the next attempt only.
   */
  'time-limit-v1',
  /**
   * p8-capacity-auto: HEARTBEAT.load carries a sampled CPU percentage on every OS and the optional memory pressure
   * figures (available memory, swap / page file, swap-in rate, commit charge, PSI). The master's capacity
   * controller trusts `cpuPercent` only from workers with it (older Windows builds always sent 0).
   */
  'capacity-metrics-v1',
  /**
   * p8-chat-attachments-mentions: the assistant host accepts `attachments` / `context` in ASSISTANT_TURN, pulls the
   * attachment bytes with ASSISTANT_ATTACHMENT_REQUEST and reports `input` per engine. The master sends none of
   * these to workers without it.
   */
  'assistant-input-v1',
  /**
   * p8-orchestration (ADR-0031): offers `request_subtask` / `wait_subtask` / `cancel_subtask` to the agents of jobs whose
   * ASSIGN_JOB carries `execution.subtasks` (SUBTASK_REQUEST / SUBTASK_STATUS) and stores delivered sub-job files in
   * `in/subtasks/`. The master sends `execution.subtasks` to no worker without it.
   */
  'subtasks-v1',
  /**
   * p8-preview-tunnels (ADR-0032): understands TUNNEL_START / TUNNEL_STOP (a supervised `cloudflared` connector per
   * preview tunnel), sends PREVIEW_REQUEST / TUNNEL_STATUS, accepts `execution.previews` and reports
   * CAPABILITIES.previewTunnels. The master opens no preview on a worker without it.
   */
  'preview-tunnels-v1',
  /**
   * p9-queue-priority (ADR-0033): reports CAPABILITIES.profileConcurrency / exclusiveProfiles (per-profile slots the
   * master places against) and sends LEASE_ACK.declineKind / retryAfterMs with every decline. Masters treat a worker
   * without it by its `maxParallelJobs` only and classify its decline texts. Newer workers may add
   * CAPABILITIES.localLogin (p9-queue-local-login-accounting): subscription logins that run one at a time.
   */
  'profile-slots-v1',
  /**
   * p10-approval-pause (ADR-0036): understands PAUSE_JOB (stop the runtime, keep the attempt's workspace and session,
   * report JOB_RESULT.paused), ASSIGN_JOB `execution.approvalWait` and `execution.resume` (continue a paused attempt
   * on this machine). The master pauses no job on a worker without it.
   */
  'approval-pause-v1',
  /**
   * p10-publish-bundle (ADR-0038): offers `publish_site` to the agents of jobs whose ASSIGN_JOB carries
   * `execution.previews.publish` (PREVIEW_REQUEST `op.kind = 'publish'`). The master sets the flag for no worker
   * without it.
   */
  'site-publish-v1',
  /**
   * p12-deploy-feedback (ADR-0048): offers the in-job deploy tools (`deploy_status`, `deploy_logs`, `request_redeploy`)
   * to the agents of jobs whose ASSIGN_JOB carries `execution.previews.deploy` (PREVIEW_REQUEST `op.kind =
   * 'deploy_status' | 'deploy_logs' | 'redeploy'`). The master sets the flag for no worker without it.
   */
  'deploy-feedback-v1',
  /**
   * p11-master-resilience (ADR-0039): honours `lease.offlineGraceMs` (keeps running while the master is unreachable,
   * fences at once when a renewal is refused), dates confirmations by RENEW_LEASE `ackId`, and sends LEASE_ACK with a
   * worker-chosen `messageId`. The master grants an offline grace to no worker without it.
   */
  'offline-grace-v1',
  /**
   * p11-merge-pipeline (ADR-0041): runs `kind: "integration"` jobs (JobSpec.integration — deterministic merges of verified
   * branches into the checked-out integration head, no agent) and returns the `integration-report.json` artifact. The
   * master places such a job on no worker without it.
   */
  'integration-v1',
  /**
   * p11-usage-limit-fallback (ADR-0040): accepts ASSIGN_JOB `execution.usageLimitPark` (keep the attempt's workspace
   * and session when the run ends on a provider usage limit, report `JOB_RESULT.paused{cause: "usage_limit"}`) and
   * `execution.resume{cause: "usage_limit"}` (continue it — with the same runtime or another one in the same
   * workspace); sends `error.usageLimit`. The master parks no limited job on a worker without it (it requeues it).
   */
  'usage-limit-park-v1',
  /**
   * p11-session-continuity (ADR-0042): with ASSIGN_JOB `execution.continuity` takes periodic checkpoints of a running
   * attempt (hidden-ref WIP commit / snapshot manifest, runtime session pointer, recent tool calls) and reports them
   * (CHECKPOINT_REPORT); after a restart reports resumable attempts in HEARTBEAT `recoverableJobs` and accepts
   * `execution.resume{cause: "worker_restart"}`. The master sends none of these to a worker without it.
   */
  'session-continuity-v1',
  /**
   * p11-limit-visibility: sends HEARTBEAT `runtimeUsage` (the runtimes' usage-limit windows per login store, from a
   * read-only probe or seen in job / assistant event streams). Without it the master shows "no data from this worker".
   */
  'runtime-usage-v1',
  /**
   * p13-runtime-accounts (ADR-0049): several accounts per runtime — accepts `runtimes.<rt>.accounts` in
   * APPLY_WORKER_CONFIG, `account` on the login relay, ASSIGN_JOB `execution.account`, ASSISTANT_TURN `account` and
   * PAUSE_JOB `cause: "account_switch"`; reports CAPABILITIES `runtimeAccounts` and `account` on usage snapshots. The
   * master sends none of these to a worker without it.
   */
  'runtime-accounts-v1',
  /**
   * p13-fleet-tools (ADR-0052): runs OPS_COMMAND `tool.install.custom` / `tool.remove.custom` (an admin-defined download
   * recipe — allowlisted https host, mandatory SHA-256 and size — into `<dataDir>/tools/custom/`) and reports
   * `toolInventory.effective` (which install of a tool jobs use). The master sends no custom install to a worker
   * without it.
   */
  'custom-tools-v1',
  /**
   * p14-skill-import (ADR-0054): honours ASSIGN_JOB `execution.skillTrust: "offline-only"` — refuses a job whose
   * skills include a version signed by a panel key (only the owner's offline skills keys count). The master enforces
   * the same rule before it delivers skills, so older workers (which ignore the field) get no panel-signed skill for
   * such a project either; the worker check is defence in depth.
   */
  'skill-trust-v1',
  /**
   * p14-skill-catalogs (ADR-0054 decision 6): skill layout v2 — parses `schema: 2` manifests (any safe text path, ≤ 64
   * files / 512 KiB per skill, ≤ 640 KiB per job), takes ASSIGN_JOB `skills.deferred` and pulls those skills' files
   * with SKILL_FILE_REQUEST. The master sends v2 skills, deferred skills and job skill sets above 160 KiB only to
   * workers with it (placement reason `skill_layout_unsupported`).
   */
  'skills-layout-v2',
  /**
   * p14-mcp-core (ADR-0054 decision 7): external MCP servers for jobs — ASSIGN_JOB `mcp` (signed specs verified with
   * the worker's own skills keys, tool rules, vault-bound secrets), per-runtime config in the attempt's private dir,
   * the servers' hosts added to that attempt's egress only, `mcp_call` events and the `mcp.probe` remote op (tool
   * discovery). P3: remote servers (http / sse) only; stdio packages need `mcp-install-v1` (P4). The master sends MCP
   * only to workers with it (placement reason `mcp_unsupported`).
   */
  'mcp-v1',
  /**
   * p14-workflow-engine 14.3 (ADR-0055): runs `kind: "function"` jobs of type `http` and `email` (JobSpec.function —
   * a workflow's HTTP request / e-mail node: guarded DNS with every resolved address checked, K1 egress, vault
   * credentials bound to their hosts, Idempotency-Key) beside its AI slots, and returns `function-result.json`. The
   * master places such a job on no worker without it (placement reason `function_unsupported`).
   */
  'function-v1',
  /**
   * p14-workflow-engine 14.3 (K3): also runs `function` jobs of type `code` (JavaScript / Python in a network-less
   * container of a pinned image). Advertised only while the worker's container engine and code images are ready.
   */
  'function-code-v1',
  /**
   * p14-code-images (docs/design/p14-followups.md §2): runs the remote op `code.images.prepare` — pulls the pinned code
   * base images by digest and builds the code node images from the build contexts in its release. The master sends
   * the op to no worker without it.
   */
  'code-images-v1',
  /**
   * p15-git-central (docs/design/p15-git-central.md): fresh job-scoped git credentials right before each fetch / push
   * (CREDENTIAL_REQUEST `purpose`, one retry on refusal), a job-local git configuration for the agent's git / gh,
   * CAPABILITIES `gitReadiness`, the remote op `git.fix` and ASSIGN_JOB `execution.gitAuth` (project deploy key / HTTPS
   * token from the vault). The master sends the op and `gitAuth` to no worker without it.
   */
  'git-central-v1',
  /**
   * p14-ask-user (docs/design/p14-ask-user.md): offers `ask_user` / `wait_for_answer` to the agents of jobs whose
   * ASSIGN_JOB carries `execution.askUser` (QUESTION_REQUEST / QUESTION_STATUS, fenced to the live lease), and the
   * `ask_user` assistant tool. The master sends `execution.askUser` to no worker without it.
   */
  'ask-user-v1',
  /**
   * p14-mcp-stdio (ADR-0054 P4): local MCP servers — the `mcp.install` / `mcp.remove` remote ops (npm without install
   * scripts and PyPI through the pinned uv recipe without builds; the canary's lockfile captured, every other machine
   * installs exactly that lock), `CAPABILITIES.mcpInstalls`, stdio probes (run on the worker; the master never starts
   * a server) and stdio servers in jobs through a launcher (minimal env, secrets from the vault). The master sends
   * stdio servers only to workers with it that reported the exact install (placement reason `mcp_not_installed`).
   */
  'mcp-stdio-v1',
  /**
   * p14-repo-egress (docs/design/p14-repo-egress.md): applies ASSIGN_JOB `execution.repoEgress` — the repository
   * project's egress policy (none / allowlist / web) — in the job's egress proxy (host and container profiles), on top
   * of `sandbox.egressAllow` and the MCP hosts; refused tunnels get a 403 body that names the policy. The master sends
   * `execution.repoEgress` to no worker without it (such a worker keeps model APIs only and the console says so).
   */
  'repo-egress-v1',
  /**
   * p15-watches (docs/design/p15-watches.md): runs `function` jobs of type `probe` — a watch's check of a port on the
   * worker's own loopback interface (HTTP GET / HEAD or TCP connect, preview port policy). The master places such a
   * job on no worker without it (placement reason `function_unsupported`).
   */
  'watch-checks-v1',
  /**
   * p15-services (docs/design/p15-services.md): long-running services the worker owns (SERVICE_START / SERVICE_CONTROL
   * / SERVICE_TUNNEL / SERVICE_LOGS_REQUEST, answers SERVICE_STATUS / SERVICE_LOGS, reports CAPABILITIES.services),
   * the job tools `start_service` & co. for jobs whose ASSIGN_JOB carries `execution.services` (SERVICE_REQUEST /
   * SERVICE_RESULT) and the job → service hand-off of the attempt's worktree. The master starts no service on a worker
   * without it.
   */
  'services-v1',
  /**
   * p15-workspace-retention: keeps the working directory of workspace jobs after the end (ASSIGN_JOB
   * `execution.keepFiles`), seeds attempts from kept files (`execution.seedFiles`, local copy or WORKFILES_FETCH relay),
   * answers WORKFILES_REQUEST (list / read / delete / extend) and reports CAPABILITIES `workfiles` / WORKFILES_STATUS.
   * The master sends none of these to workers without it.
   */
  'workfiles-v1',
  /**
   * p15-chat-execute-default (docs/design/p15-chat-execute-default.md): the assistant's draft tools take `propose`
   * (and `execute`, now declared in the Claude Code tool schemas too) and the system prompt says actions the user asks
   * for run at once. The master runs drafts by default only for turns on a worker with it.
   */
  'assistant-propose-v1',
  /**
   * p17-chat-reconnect (docs/design/p17-chat-reconnect.md): an assistant turn keeps running across a transport
   * reconnect of the same worker process; its ASSISTANT_UPDATEs (numbered per turn) are kept and re-sent after
   * ASSISTANT_RESUME `{turnId, afterSeq}` (or a `failed: assistant_disconnected` when the turn is gone). The master holds
   * a turn for a grace period on a dropped connection only for workers with it.
   */
  'assistant-resume-v1',
  /**
   * p18-plan-mode (docs/design/p18-plan-mode.md §5): the assistant's tool catalog has the plan tools (`plan_propose`,
   * `plan_create`, `plan_update_items`, `plan_set_status`, `plan_ask_decision`, `plan_set_state`, `plan_read`), draft
   * tools take `planItem`, and the system prompt has the planning rule (52). The master offers plan mode and starts
   * plan continuation turns only on an answering machine with it.
   */
  'assistant-plan-v1',
  /**
   * p18-assistant-gaps (worker 1.2.1): the assistant has the workflow run, job output, backup / control-plane update,
   * template, uptime history, memory review, Outputs library, weekly report, health re-check, job question answer and
   * cost brake tools and the prompt rules that name them. The master mentions those tools in tool answers only to an
   * answering machine with it.
   */
  'assistant-ops-tools-v1',
  /**
   * p18-multi-project W3 + W5 (worker 1.2.1): the assistant knows the conversation's working projects (the master's
   * "Çalışma projeleri" block), names the project of every write when there are several, and has set_thread_projects,
   * attach_workflow, draft_job_batch and draft_workflow_run `project` (prompt rule 54). The master applies the
   * project-set rules of writes (project_not_in_thread / project_required) only for turns on such a machine.
   * W4 (same release): draft_automation `projects` — the same new automation in several working projects (a group);
   * the master drafts such a card only for a turn on such a machine.
   */
  'assistant-projects-v1',
  /**
   * p18-leftovers (worker 1.2.2): the assistant has draft_budget_change (budgets through the chat, prompt rule 55) and
   * may draft an automation group (draft_automation `projects`) with a GitHub trigger. The master answers
   * draft_budget_change and accepts a group card's GitHub trigger only for a turn on such a machine.
   */
  'assistant-budgets-v1',
  /**
   * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §4): the assistant has describe_project_readiness,
   * draft_project_network and draft_project_machines and the prompt rule (56) that makes it check a new project's
   * repository, network access and machines and ask the user before the first job. The master answers those tools only
   * for a turn on such a machine.
   */
  'assistant-project-setup-v1',
  /**
   * p18-project-bootstrap (docs/design/p18-project-bootstrap.md §2): a repository job on an EMPTY repository (no
   * branches, no tags) starts from an empty first commit of its base branch — pushed as the branch's first commit
   * (only while it does not exist) when the job publishes under git flow — instead of failing with
   * BaseRefNotFoundError. Informational: the master names older machines in its repair hint.
   */
  'workspace-empty-repo-v1',
  /**
   * p15-usage-refresh (docs/design/p15-usage-refresh.md): HEARTBEAT `runtimeUsage` snapshots carry the login's provider
   * account `identity` (hashed), the remote op `usage.refresh` reads the usage windows now (OPS_UPDATE
   * `usageRefresh`), and a subscription login is probed right after each job / chat turn. The master sends the op to no
   * worker without it.
   */
  'usage-refresh-v1',
  /**
   * p15-model-picker (docs/design/p15-model-picker.md): CAPABILITIES carries `runtimeModels` (the models each runtime's
   * own list command names on this machine, else the aliases this release knows), and the worker applies a job's
   * `defaultModel` (the panel's global default model) after its own default for the runtime. Older workers strip
   * `defaultModel` (their own default applies) and report no list (the console falls back to the catalog).
   */
  'runtime-models-v1',
  /**
   * p16-runtime-updates (docs/design/p16-runtime-updates.md): `runtime.install` with an `unverified` source (a version
   * outside the release's pinned set, owner policy `fleet.unverifiedRuntimeUpdates`), the `runtime.verify` op
   * (automatable checks in a scratch dir), CAPABILITIES `unverifiedUpdate` / remote-ops `installed[].unverified`, and
   * jobs on such an install. The master sends neither to a worker without it.
   */
  'runtime-unverified-v1',
  /**
   * p16-zip-job-input (docs/design/p16-zip-job-input.md): pulls ASSIGN_JOB `execution.inputBundle` (INPUT_BUNDLE_REQUEST
   * / INPUT_BUNDLE_DATA, size + SHA-256 per file) into the job's `in/` before the agent runs — a scratch `in/` next to
   * the checkout for repository jobs. The master places no job with an input bundle on a worker without it.
   */
  'input-bundle-v1',
  /**
   * p16-doctor (docs/design/p16-doctor.md): runs OPS_COMMAND `doctor.run` and answers OPS_UPDATE `doctor` (the same
   * report as `remyral-worker doctor`). The master asks older workers for `diagnostics.run` instead.
   */
  'doctor-v1',
  /**
   * p17-object-storage (docs/design/p17-object-storage.md): honours ASSIGN_JOB `execution.blobUpload` — large outputs
   * go to the master's blob store with a master-issued upload grant (BLOB_UPLOAD_REQUEST / GRANT / COMPLETE / STATUS,
   * then ARTIFACT_REF `blobUploadId`) instead of ARTIFACT_CHUNKs. The master sends `execution.blobUpload` to no worker
   * without it (such a worker keeps the chunk path and its limits).
   */
  'blob-upload-v1',
  /**
   * p17-output-limits (docs/design/p17-output-limits.md): honours ASSIGN_JOB `execution.outputLimits` (the job's output
   * file limit, inline + blob together; bytes decide the path; the files beyond the limits packed into one overflow
   * zip through the blob path) and `blobUpload.maxFiles` above 20, and reports JOB_RESULT `outputs`. The master sends
   * neither to a worker without it (such a worker keeps 20 inline + 20 blob files and its own skip list).
   */
  'output-limits-v1',
  /**
   * p17-disk-selfclean (docs/design/p17-disk-selfclean.md): frees its own disk space when the free space under the
   * workspace root falls below `workspace.minFreeBytes` plus a margin (and once a day lightly), reports
   * CAPABILITIES.diskHygiene, runs OPS_COMMAND `disk.clean` (answers OPS_UPDATE `diskClean`) and accepts
   * `workspace.diskHygiene` in APPLY_WORKER_CONFIG. The master sends neither the op nor the config key to a worker
   * without it.
   */
  'disk-hygiene-v1',
  /**
   * p17-update-channel (ADR-0065): accepts APPLY_VERSION_CATALOG (a version catalog signed by a catalog key this
   * worker trusts — compiled into its release or set in the root-owned config), answers VERSION_CATALOG_STATUS and
   * reports CAPABILITIES.versionCatalog; its install sets / recipes / pins include the accepted catalog's versions and
   * its runtime-policy rules without `pin: "hold"` follow its effective pin. The master sends the catalog to no
   * worker without it.
   */
  'version-catalog-v1',
  /**
   * p17-worker-managed (docs/design/p17-worker-managed.md): local settings from the panel (APPLY_WORKER_CONFIG
   * `settings`, CAPABILITIES `workerConfig.effective.settings`), the signed removal OPS_COMMAND `worker.uninstall` and
   * the privileged `helper.manage` op (machine-admin helper install / remove). One feature for the wave: the master sends
   * none of them to a worker without it.
   */
  'worker-managed-v1',
  /**
   * p17-runtime-verify (docs/design/p17-runtime-verify.md): runs OPS_COMMAND `runtime.capabilities.verify` (the capability
   * scenario set through the real adapter, evidence signed by the device key), reports CAPABILITIES runtime
   * `verification` (adapter revision, declared table) and honours ASSIGN_JOB `execution.verifiedCapabilities`. The master
   * offers no "Doğrula" and sends neither to a worker without it.
   */
  'runtime-capability-verify-v1',
  /**
   * p19-linux-host-isolation (ADR-0067): on Linux every `host-restricted` attempt runs in its own bubblewrap view (own
   * user + mount namespace, the attempt's dirs only) once the cross-attempt self-check passed, so such attempts run in
   * parallel (CAPABILITIES.profileConcurrency); the Sandbox card carries the `host_isolation` check and Prepare the
   * `host_isolation` / `bubblewrap_install` steps. The master's capacity advice names the bubblewrap / Prepare fix only
   * for a worker with it (older Linux workers: "update the machine first").
   */
  'host-isolation-linux-v1',
  /**
   * p19-linux-host-isolation Part 2: the assistant has the capacity prompt rule (capacity advice only from
   * describe_worker `capacity`, never an invented setting). The master adds the rule text to capacity answers only for
   * a turn on a worker without it.
   */
  'assistant-capacity-v1',
  /**
   * p19-ide W2 (docs/design/p19-ide.md, ADR-0066): runs IDE workspaces (IDE_START / IDE_CONTROL / IDE_GIT /
   * IDE_FILE_REQUEST / IDE_NOTICE, answers IDE_STATUS / IDE_GIT_RESULT / IDE_FILE_DATA / IDE_EVENT, reports
   * CAPABILITIES.ide) and speaks the STREAM_* plane with binary data frames (target `ide`). The master opens no stream
   * and starts no IDE on a worker without it. (`streams-v1` stays retired: it named the OpenHands-era plane.)
   */
  'ide-v1',
  /**
   * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md): honours `JobSpec.repository.inputs` — a repository job's
   * input files (chat attachments, earlier outputs) fetched with JOB_INPUT_REQUEST into a read-only scratch `in/` next
   * to the checkout (the attempt's sandbox dir, outside the repository: never committed, pushed or verified). The
   * master places no repository job with input files on a worker without it.
   */
  'repo-inputs-v1',
  /**
   * p19-repo-job-inputs: the assistant's prompt rule 58 and the draft_job text say chat attachments / earlier outputs
   * go to REPOSITORY jobs too. For a turn on a worker without it the master adds that note to the attachments context.
   */
  'assistant-repo-inputs-v1',
  /**
   * p19-ide W4 (docs/design/p19-ide.md §6, §9 W4): the assistant has read_code, list_code, read_workspace_diff,
   * open_code, open_diff and draft_review_changes and the prompt rule 59. The master answers those tools only for a turn
   * on such a machine.
   */
  'assistant-code-v1',
  /**
   * p19-ide W4: the IDE manager answers IDE_GIT `diff` (a workspace's uncommitted diff: changed and untracked files and
   * the unified diff, capped). The master sends that op to no machine without it.
   */
  'ide-diff-v1',
  /**
   * p19-ide W3 (docs/design/p19-ide.md §4): IDE extensions and settings sync — accepts IDE_START `profile` (signed) and
   * `downloadToken`, installs exactly the listed VSIX blobs from the master's verified Open VSX cache (offline cache on
   * the machine, SHA-256 checked), writes `extensions.allowed` and the project's enforced settings, disables the
   * IDE's own gallery, and runs bridge extension v2 (settings sync: IDE_EVENT `settings`). The master sends neither the
   * profile nor the token to a worker without it (its IDEs keep only the bridge extension).
   */
  'ide-extensions-v1',
  /**
   * p19-ide W2b (docs/design/p19-ide.md "Implementation (W2b)"): IDE workspaces on macOS and Windows machines too —
   * code-server (MIT) pinned per platform (URL, SHA-256, size), launched under the host-restricted sandbox (macOS:
   * Seatbelt; Windows: a per-job account in a Job Object), CAPABILITIES.ide `reasonCode` / `serverKind`, and the
   * macOS / Windows VSIX targets in IDE_START `profile`. The master treats a non-Linux machine without it as needing a
   * worker update.
   */
  'ide-platforms-v1',
  /**
   * p19-install-scripts (ADR-0068): `mcp.install` honours `installScripts` — a lockfile entry with an install script is
   * accepted when an admin approved exactly that name, version and integrity, and only those lifecycle scripts run
   * after unpacking (Linux: inside bubblewrap when it is usable; network allowed, writes only in the install). The
   * master sends approvals to no worker without it (such a worker keeps refusing `install_scripts_required`).
   */
  'mcp-install-scripts-v1',
  /**
   * p19-unconfined-parallel (docs/design/p19-unconfined-parallel.md): accepts `unconfinedParallel` in
   * APPLY_WORKER_CONFIG — attempts without filesystem confinement (`unconfined`, host profiles without per-attempt
   * isolation) run beside each other and beside other attempts, up to maxParallelJobs. The master sends the key to no
   * worker without it.
   */
  'unconfined-parallel-v1',
  /**
   * p20-chat-images (docs/design/p20-chat-images.md): the assistant has show_image (images of a job's outputs or kept
   * files inline in the conversation) and draft_screenshot (a screenshot job card) and the prompt rule 68. The master
   * answers those tools only for a turn on such a machine.
   */
  'assistant-images-v1',
  /**
   * p20-job-clock (docs/design/p20-job-clock.md): the run clock also stops while a question tool (`ask_user` /
   * `wait_for_answer`) waits for a person, like an approval wait; HEARTBEAT `runningJobs[].clock` and JOB_RESULT `clock`
   * report the budget, the run time used and the waits apart. A master reads the report from any worker (an older one
   * has no report) and subtracts question waits from its wall-time backstop only for workers with this feature.
   */
  'run-clock-v1',
  /**
   * p21-service-egress (docs/design/p21-service-egress.md): applies the project's repository egress policy
   * (p14-repo-egress) to the services (SERVICE_START `spec.network`) and IDE servers (IDE_START `spec.network`) it
   * runs, like a repository job's ASSIGN_JOB `execution.repoEgress`. The master sends `spec.network` to no worker
   * without it (the strict spec would be refused); such a worker keeps model APIs only and the console says so.
   */
  'service-egress-v1',
  /**
   * p22-runtime-diagnostics (docs/design/p22-runtime-diagnostics.md): honours ASSIGN_JOB `execution.tlsPins` of a
   * function job — an HTTPS request whose certificate fails verification is accepted only when the certificate the
   * server presents (or the self-signed root of its chain) has a SHA-256 fingerprint the project pinned for that
   * `host:port`; and reports an untrusted certificate as `http_error` with `params.cause = "tls_untrusted"` and its
   * fingerprint. The master sends `execution.tlsPins` to no worker without it (older workers stay strict).
   */
  'function-tls-pins-v1',
  /**
   * p22-previews-inputs (docs/design/p22-previews-inputs.md): previews of `container`-profile jobs — the worker
   * relays a port of the job's container to the worker's loopback only (127.0.0.1 / ::1, never 0.0.0.0) for the
   * preview connector. The master gives container jobs `execution.previews` and opens their previews only on workers
   * with it.
   */
  'preview-container-v1',
  /**
   * p22-previews-inputs: sub-job inputs above the inline limit (256 KiB per request) are staged as chunked artifacts
   * of the requesting attempt (ARTIFACT_CHUNK / ARTIFACT_REF `ws-subin-…`) and named in SUBTASK_REQUEST
   * `op.stagedInputs`. The master sets `execution.subtasks.stagedInputs` only for workers with it.
   */
  'subtask-staged-inputs-v1',
  /**
   * p22-timeout-continuity (docs/design/p22-timeout-continuity.md): a git-flow repository attempt stopped on its time
   * limit (run clock, or the master backstop's CANCEL_JOB `budget_exceeded: wall time …`) commits and pushes its
   * unfinished work to the attempt branch within the delivery grace (TIMEOUT_DELIVERY_GRACE_SEC) and reports it in
   * JOB_RESULT `partial`; an unpushed commit is kept under `refs/remana/kept/<attempt>` in its mirror. The master
   * continues such a job from that commit ("Aynı yerden devam et").
   */
  'timeout-delivery-v1',
  /**
   * p22-sandbox-settings (docs/design/p22-sandbox-settings.md): APPLY_WORKER_CONFIG `settings.sandbox`
   * (`linuxLoginStoreView`, `linuxPrivateNetwork`) is laid over the local file at the next start (a locally written key
   * pins it) and reported in CAPABILITIES `workerConfig.effective.settings.values.sandbox`.
   */
  'worker-sandbox-settings-v1',
]);
export type WorkerFeature = z.infer<typeof WorkerFeature>;

/**
 * ADR-0023: features older workers still advertise although the platform no longer uses them — the STREAM_*
 * plane (`streams-v1`) existed only for the interactive OpenHands sessions (`interactive-openhands`). They are
 * dropped when CAPABILITIES is parsed; any other unknown feature still fails validation.
 */
export const RETIRED_WORKER_FEATURES = ['streams-v1', 'interactive-openhands'] as const;

/** CAPABILITIES `features`: known features, retired ones silently dropped. */
export const WorkerFeatureList = z.preprocess(
  (v) =>
    Array.isArray(v) ? v.filter((x) => !(RETIRED_WORKER_FEATURES as readonly unknown[]).includes(x)) : v,
  z.array(WorkerFeature).max(96),
) as unknown as z.ZodArray<typeof WorkerFeature>;

/** p11-master-resilience: see `offline-grace-v1` above. */
export const OFFLINE_GRACE_FEATURE = 'offline-grace-v1' satisfies WorkerFeature;

/** p19-linux-host-isolation: see `host-isolation-linux-v1` above. */
export const HOST_ISOLATION_LINUX_FEATURE = 'host-isolation-linux-v1' satisfies WorkerFeature;

/** p19-linux-host-isolation: see `assistant-capacity-v1` above. */
export const ASSISTANT_CAPACITY_FEATURE = 'assistant-capacity-v1' satisfies WorkerFeature;

/** p8-capacity-auto: see `capacity-metrics-v1` above. */
export const CAPACITY_METRICS_FEATURE = 'capacity-metrics-v1' satisfies WorkerFeature;

/** p19-repo-job-inputs: see `repo-inputs-v1` above. */
export const REPO_INPUTS_FEATURE = 'repo-inputs-v1' satisfies WorkerFeature;

/** p19-repo-job-inputs: see `assistant-repo-inputs-v1` above. */
export const ASSISTANT_REPO_INPUTS_FEATURE = 'assistant-repo-inputs-v1' satisfies WorkerFeature;

/** p19-ide W4: see `ide-diff-v1` above. */
export const IDE_DIFF_FEATURE = 'ide-diff-v1' satisfies WorkerFeature;

/** p19-install-scripts: see `mcp-install-scripts-v1` above. */
export const MCP_INSTALL_SCRIPTS_FEATURE = 'mcp-install-scripts-v1' satisfies WorkerFeature;

/** p19-unconfined-parallel: see `unconfined-parallel-v1` above. */
export const UNCONFINED_PARALLEL_FEATURE = 'unconfined-parallel-v1' satisfies WorkerFeature;

/** p20-job-clock: see `run-clock-v1` above. */
export const RUN_CLOCK_FEATURE = 'run-clock-v1' satisfies WorkerFeature;

/** p21-service-egress: see `service-egress-v1` above. */
export const SERVICE_EGRESS_FEATURE = 'service-egress-v1' satisfies WorkerFeature;

/** p22-runtime-diagnostics: see `function-tls-pins-v1` above. */
export const FUNCTION_TLS_PINS_FEATURE = 'function-tls-pins-v1' satisfies WorkerFeature;

/** p22-previews-inputs: see `preview-container-v1` above. */
export const PREVIEW_CONTAINER_FEATURE = 'preview-container-v1' satisfies WorkerFeature;

/** p22-previews-inputs: see `subtask-staged-inputs-v1` above. */
export const SUBTASK_STAGED_INPUTS_FEATURE = 'subtask-staged-inputs-v1' satisfies WorkerFeature;
