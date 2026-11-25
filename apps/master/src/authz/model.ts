import type { Role } from '../auth/users.js';

/**
 * Central authorization model (docs/design/p5-rbac.md). Pure: no I/O.
 *
 * - **Subject**: the authenticated user — account role plus project memberships.
 * - **Action**: an entry of the explicit {@link ACTIONS} catalog. Anything not in the catalog is denied.
 * - **Resource**: attributes of what is acted on — the project it belongs to (or none: a global resource
 *   or a collection) and, for self-service actions, its owner.
 *
 * Roles (ADR-0009): owner and admin are global — they hold their role in every project. operator and viewer
 * are per project: they see a project only through a membership, and their role there is the lower of the
 * membership role and their account role (the account role is a ceiling, so demoting an account demotes it
 * everywhere at once).
 */

export type { Role };
export type ProjectRole = 'operator' | 'viewer';
export const PROJECT_ROLES: readonly ProjectRole[] = ['operator', 'viewer'];
export const GLOBAL_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin']);

const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function lowerRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}

export interface ActionSpec {
  /** `project`: decided per project when the resource names one; `global`: account role only. */
  readonly scope: 'global' | 'project';
  /** Weakest role that may perform the action. */
  readonly minRole: Role;
  /** Only on resources owned by the subject (`resource.ownerId === subject.userId`). */
  readonly selfOnly?: boolean;
  readonly description: string;
}

/**
 * The action catalog. Route declarations name one of these; the matrix test holds an independent expected
 * table per action, so adding an action without deciding who may do it fails the build.
 */
export const ACTIONS = {
  // Own session (read, step-up, logout) and the API description.
  'session.self': {
    scope: 'global',
    minRole: 'viewer',
    selfOnly: true,
    description: 'Read or end one’s own session; step-up',
  },
  'api.docs': { scope: 'global', minRole: 'viewer', description: 'Read the OpenAPI document' },
  // Own notifications and notification preferences (p5-notifications).
  'notifications.self': {
    scope: 'global',
    minRole: 'viewer',
    selfOnly: true,
    description: 'Read and manage one’s own notifications and preferences',
  },

  // Jobs.
  'jobs.read': { scope: 'project', minRole: 'viewer', description: 'List and read jobs' },
  'jobs.create': { scope: 'project', minRole: 'operator', description: 'Create (submit) jobs' },
  'jobs.cancel': { scope: 'project', minRole: 'operator', description: 'Cancel jobs' },
  // p9-queue-priority: the queue screen's drag and drop (a priority adjustment within the job's class, audited) and
  // "run now" (the job becomes urgent and goes first; admin, step-up).
  'jobs.queue.reorder': {
    scope: 'project',
    minRole: 'operator',
    description: 'Reorder queued jobs within their priority class (queue screen, audited)',
  },
  'jobs.queue.runnow': {
    scope: 'project',
    minRole: 'admin',
    description: 'Run a queued job now: it becomes urgent (Acil) and goes first (step-up, audited)',
  },
  'jobs.export': { scope: 'project', minRole: 'operator', description: 'Export a task record' },
  // p5-ops-chat: a human message to the running agent of a job (adapter `interactive_prompt`).
  'jobs.message': {
    scope: 'project',
    minRole: 'operator',
    description: 'Send a message to the running agent of a job (runtimes with follow-up prompts)',
  },
  // p6-approval-mode-switch: change a job's approval mode before it starts or while it runs (allow-all keeps the
  // creation gates; a machine-admin job also needs machines.admin.run).
  'jobs.approval.mode': {
    scope: 'project',
    minRole: 'operator',
    description: 'Change the approval mode of a queued or running job (same gates as creating such a job)',
  },
  // p15-autonomy: change a queued or running job's time limit (the security policy caps it).
  'jobs.timelimit': {
    scope: 'project',
    minRole: 'operator',
    description: 'Change the time limit of a queued or running job (up to the security policy maximum)',
  },
  // p10-approval-pause: resume a paused job now (after its approval was decided) or restart it from scratch.
  'jobs.resume': {
    scope: 'project',
    minRole: 'operator',
    description: 'Resume a job paused for an approval, or restart it from scratch',
  },
  'jobs.merge': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Request a merge / acceptance / discard of a job’s changes (opens an approval; executing it needs the approval)',
  },
  // p19-ide W1: the console's code viewer, diff reviewer and `code` chat references (read-only on the repository).
  'code.read': {
    scope: 'project',
    minRole: 'viewer',
    description:
      'Browse a project’s repository files and kept working files, read diffs and review comments, reference lines in the chat',
  },
  'code.review': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Write review comments on a job’s changes and send “Değişiklik iste” (a message to the job’s agent or a follow-up job)',
  },
  // p19-ide W2 (ADR-0066): "Tam IDE" — openvscode-server workspaces on a Linux machine, opened on the IDE origin.
  'ide.use': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Create, start, open, stop and delete your own Tam IDE workspaces of the project and push their branch (start asks for an authenticator code when the security policy says so; audited)',
  },
  'ide.manage': {
    scope: 'project',
    minRole: 'admin',
    description: 'See, stop and delete other users’ Tam IDE workspaces of the project (audited)',
  },
  // p19-ide W3: the IDE extension allowlist (global) and a project's required / recommended / denied extensions.
  'ide.extensions': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Allow IDE extensions from Open VSX (the master caches the verified build), deny them, and set a project’s required / recommended extensions and enforced settings (step-up; audited)',
  },

  // Approvals and approval policy.
  'approvals.read': { scope: 'project', minRole: 'viewer', description: 'List and read approval requests' },
  'approvals.decide': {
    scope: 'project',
    minRole: 'operator',
    description: 'Approve or deny (the request’s own approver role still applies)',
  },
  'policy.read': { scope: 'project', minRole: 'admin', description: 'Read a project approval policy' },
  'policy.write': { scope: 'project', minRole: 'admin', description: 'Change a project approval policy' },

  // Context documents.
  'context.read': { scope: 'project', minRole: 'viewer', description: 'Read context documents' },
  'context.write': {
    scope: 'project',
    minRole: 'operator',
    description: 'Create, version and roll back context documents (document write role still applies)',
  },
  'context.delete': {
    scope: 'project',
    minRole: 'admin',
    description: 'Change document access, soft-delete documents',
  },
  'context.purge': { scope: 'global', minRole: 'admin', description: 'Hard-purge expired documents' },
  'context.bundle': { scope: 'project', minRole: 'operator', description: 'Preview a context bundle' },
  // p6-context-policy.
  'context.retention': {
    scope: 'project',
    minRole: 'admin',
    description: 'Change retention, legal hold and the agent memory-write policy of a namespace',
  },
  'context.export': {
    scope: 'project',
    minRole: 'operator',
    description: 'Export a project’s context (JSON Lines with manifest)',
  },
  'context.receipts': { scope: 'project', minRole: 'admin', description: 'Read context deletion receipts' },
  // p6-vector (optional semantic search).
  'context.search': {
    scope: 'project',
    minRole: 'viewer',
    description: "Semantic search over a project's context and job summaries",
  },
  'context.search.admin': {
    scope: 'project',
    minRole: 'admin',
    description: 'Consent to embedding capture for a namespace; rebuild its search index',
  },
  // p10-semantic-defaults-chat.
  'context.defaults': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Read and change the project knowledge defaults for new projects (search capture, memory suggestions)',
  },
  // p10-semantic-memory: project memory suggestions.
  'memory.suggestions.read': {
    scope: 'project',
    minRole: 'viewer',
    description: "Read a project's memory suggestions inbox and its setting",
  },
  'memory.suggestions.decide': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Accept (into the project context), edit or dismiss memory suggestions; draft a summarising job',
  },
  'memory.suggestions.admin': {
    scope: 'project',
    minRole: 'admin',
    description: 'Opt a project in or out of memory suggestions; backfill from earlier jobs',
  },
  // p11-memory-layers: one's own personal rules (the service allows only the caller's own `user:<id>` scope).
  'memory.personal': {
    scope: 'global',
    minRole: 'viewer',
    description: 'Read and change your own personal rules (they apply to the jobs and chats you create)',
  },

  // Audit.
  'audit.read': { scope: 'global', minRole: 'admin', description: 'Search and read the audit log' },
  'audit.verify': { scope: 'global', minRole: 'admin', description: 'Verify the audit hash chain' },
  'audit.export': { scope: 'global', minRole: 'admin', description: 'Export the audit log' },

  // p10-backup-restore: backup and restore-drill status (Settings → Backups; no download).
  'backups.read': { scope: 'global', minRole: 'admin', description: 'Read backup and restore-drill status' },
  // p17-host-actions part 3: backups managed from the console through the remyral-ctl host applier — owners only.
  'backups.manage': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Take a backup or a restore drill now; change the schedule, retention, WAL archiving, encryption recipients and the off-site target',
  },
  'backups.restore': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Replace the live database with a backup of this host (a signed request the host applier runs)',
  },

  // p16-observability: Ayarlar → Sistem durumu (health, queue, workers, errors, disk, recent traces) and the master's
  // log search. Read-only; owners and admins.
  'system.status': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the system status page and the recent slow / failed traces',
  },
  'system.logs': {
    scope: 'global',
    minRole: 'admin',
    description: "Search the master's recent (redacted) logs",
  },
  // p16-selfhost-onboarding (ADR-0063): the first-run wizard's progress and the signed control-plane update feed.
  // Owners only (the wizard is shown to owners; upgrades run on the host by whoever administers it).
  'onboarding.manage': {
    scope: 'global',
    minRole: 'owner',
    description: 'Read and record the first-run setup wizard (organisation name, step progress, completion)',
  },
  'updates.read': {
    scope: 'global',
    minRole: 'owner',
    description: 'Read the installed control-plane version and the newer signed releases',
  },
  // p17-panel-settings: settings that used to be environment variables, stored by the master (Ayarlar → Sunucu ayarları).
  'settings.panel.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the master-stored settings (effective values and their source; never a secret)',
  },
  'settings.panel.write': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Change the master-stored settings (notifications, search, network, sessions, logs, memory, workflows, ops)',
  },
  // p17-panel-settings Part 4: another user's MFA / password reset and unlock (owners; admins for non-owners).
  'users.recover': {
    scope: 'global',
    minRole: 'admin',
    description: "Reset another user's authenticator or password, or unlock the account",
  },
  // p17-panel-settings Part 5: key rotation from the panel (webhook HMAC, skills panel key, lease-signing key).
  'keys.rotate': {
    scope: 'global',
    minRole: 'owner',
    description: 'Rotate a key the master holds (webhook HMAC, skills panel key, lease-signing key)',
  },
  // p17-panel-settings Part 7: maintenance commands as background jobs (blobs:migrate, search:backfill, memory:autolearn).
  'maintenance.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the maintenance jobs and their progress',
  },
  'maintenance.run': {
    scope: 'global',
    minRole: 'owner',
    description: 'Start or cancel a maintenance job (storage move, search backfill, memory auto-learn)',
  },
  // p17-host-actions (ADR-0063 amendment 2026-10-26): control-plane update / rollback through the remyral-ctl host
  // applier — owners only (the host carries it out; the console signs the request).
  'host.actions.read': {
    scope: 'global',
    minRole: 'owner',
    description: 'Read the host applier and the update / rollback requests made from the console',
  },
  'host.update': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Upgrade or roll back the control plane (a signed request the remyral-ctl host applier runs)',
  },
  // p17-domain-wizard (ADR-0063 amendment 2026-10-24): the console's public address — owners only.
  'console.domain.read': {
    scope: 'global',
    minRole: 'owner',
    description: "Read the console's public address, the host applier and DNS checks for a new domain",
  },
  'console.domain.write': {
    scope: 'global',
    minRole: 'owner',
    description:
      "Change the console's public address (stored setting; on a remyral-ctl host a signed domain change request)",
  },

  // Worker fleet (routes arrive with p2/p5 fleet work).
  'workers.read': { scope: 'global', minRole: 'viewer', description: 'List workers and their status' },
  'workers.approve': { scope: 'global', minRole: 'admin', description: 'Approve a paired worker' },
  'workers.revoke': { scope: 'global', minRole: 'admin', description: 'Revoke a worker identity' },
  'workers.drain': { scope: 'global', minRole: 'admin', description: 'Drain or resume a worker' },
  'workers.archive': {
    scope: 'global',
    minRole: 'admin',
    description: 'Remove a denied or revoked worker from the fleet list, or put it back',
  },
  'workers.rotate': {
    scope: 'global',
    minRole: 'admin',
    description: 'Request or approve a worker device-key rotation',
  },
  'workers.rename': {
    scope: 'global',
    minRole: 'admin',
    description: 'Give a machine a display name (or clear it: its hostname again)',
  },
  'workers.update': {
    scope: 'global',
    minRole: 'admin',
    description: 'Set a worker’s update channel or target version (pin, rollback, force)',
  },
  // Panel-managed worker configuration (ADR-0015, p5-managed-workers).
  'workers.config.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read a worker’s panel configuration, its history, the worker’s report and drift',
  },
  'workers.config.write': {
    scope: 'global',
    minRole: 'admin',
    description: 'Change, roll back or bulk-apply worker configurations (step-up)',
  },

  // Remote operations (p5-remote-ops, ADR-0017): runtime install/remove, login relay, restart, logs, diagnostics.
  'workers.ops.read': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Read a worker’s remote operations, managed runtimes, login states, log lines and diagnostics',
  },
  'workers.ops.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Install/upgrade/remove runtimes, relay a runtime login, restart the worker or a runtime, fetch logs, run diagnostics (step-up)',
  },

  // AI machine administration (p5-machine-admin, ADR-0021): elevated machine-admin jobs on opted-in workers.
  'machines.admin.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read a worker’s machine administration state, elevated command log and machine memory',
  },
  'machines.admin.enable': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Enable or disable AI machine administration (root/Administrator) on a worker (owner only, always-fresh step-up)',
  },
  'machines.admin.run': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Start a machine administration job (always-fresh step-up) and edit a machine’s memory (step-up)',
  },

  // Credential vault (p5-credentials-models, ADR-0016): metadata reads and sealed writes, admin only.
  'vault.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'List vault credentials (metadata only), worker vault keys and delivery state',
  },
  'vault.write': {
    scope: 'global',
    minRole: 'admin',
    description: 'Create, rotate, unshare or revoke vault credentials; rotate a worker vault key (step-up)',
  },
  // Model catalog (p5-credentials-models).
  'models.read': {
    scope: 'global',
    minRole: 'viewer',
    description: 'Read the model catalog and per project/runtime defaults',
  },
  'models.write': {
    scope: 'global',
    minRole: 'admin',
    description: 'Change model profiles and defaults (step-up)',
  },

  // Runtime policies: pins, auth modes, model profiles, staged rollout (p3-runtime-policy).
  'runtimes.read': {
    scope: 'global',
    minRole: 'viewer',
    description: 'Read runtime policies and a worker’s effective runtime policy',
  },
  'runtimes.write': {
    scope: 'global',
    minRole: 'admin',
    description: 'Change runtime policies (versions, canary rollout, promotion, rollback) and assignments',
  },

  // Signed worker releases (p2-signed-updates).
  'releases.read': {
    scope: 'global',
    minRole: 'viewer',
    description: 'List worker releases, channels and update attempts',
  },
  'releases.publish': {
    scope: 'global',
    minRole: 'admin',
    description: 'Upload a signed worker release; promote a release to a channel / change its rollout',
  },
  // p17-update-channel (ADR-0065): which worker releases from the vendor's feed roll out by themselves — the owner's.
  'updates.channel.write': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Set the worker update channel policy (patch releases automatic, all need approval, all automatic) and the canary soak time',
  },

  // Fleet → Add machine (p5-worker-onboarding): installer kits and install commands.
  'installers.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Show the install commands and download the signed installer kits for adding a machine',
  },

  // Signed, versioned skills (p6-skills).
  'skills.read': {
    scope: 'global',
    minRole: 'viewer',
    description: 'List skills, their signed versions, files and project assignments',
  },
  'skills.publish': {
    scope: 'global',
    minRole: 'admin',
    description: 'Upload a skill version signed offline with the skills key',
  },
  'skills.assign': {
    scope: 'global',
    minRole: 'admin',
    description: 'Assign skills to projects (runtimes, version pin) or remove an assignment',
  },

  // External MCP servers for jobs (p14-mcp-core, ADR-0054).
  'mcp.read': {
    scope: 'global',
    minRole: 'viewer',
    description: 'List MCP servers, their signed versions, tools, policies, secret slots and assignments',
  },
  'mcp.manage': {
    scope: 'global',
    minRole: 'admin',
    description: 'Publish / archive MCP servers, bind their secrets, set tool policies, probe tools',
  },
  'mcp.assign': {
    scope: 'global',
    minRole: 'admin',
    description: 'Assign MCP servers to projects and switch MCP on or off for a project',
  },
  // p19-install-scripts (ADR-0068): npm install scripts an admin reviewed and approved for the whole platform.
  'mcp.scripts': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Review, approve and revoke npm install scripts (exact name, version and integrity) for local MCP installs',
  },

  // Usage, price table and budgets (p6-cost).
  'usage.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'Read usage summaries and the price table',
  },
  'usage.records': {
    scope: 'project',
    minRole: 'operator',
    description: 'Read record-level usage (job, attempt, worker)',
  },
  'prices.write': { scope: 'global', minRole: 'admin', description: 'Replace the price table' },
  'budgets.read': { scope: 'project', minRole: 'viewer', description: 'Read budgets' },
  'budgets.write': { scope: 'project', minRole: 'admin', description: 'Change budgets' },
  // p8-cost-efficiency: let work through an exhausted budget (step-up); one's own weekly reports and settings.
  'budgets.override': {
    scope: 'project',
    minRole: 'admin',
    description: 'Override an exhausted budget for its current window or one job (step-up)',
  },
  'reports.self': {
    scope: 'global',
    minRole: 'viewer',
    selfOnly: true,
    description: 'Read one’s own cost & efficiency reports; change one’s report settings',
  },

  // Workflows: DAG definitions, runs, approval gates (p4-dag).
  'workflows.read': { scope: 'project', minRole: 'viewer', description: 'List and read workflows and runs' },
  'workflows.define': { scope: 'project', minRole: 'operator', description: 'Define a workflow version' },
  'workflows.run': { scope: 'project', minRole: 'operator', description: 'Start or cancel workflow runs' },
  'workflows.approve': {
    scope: 'project',
    minRole: 'operator',
    description: 'Decide a workflow approval gate (the gate’s own approver role and step-up still apply)',
  },
  // p14-workflow-engine 14.1 (§8.5): expression preview and single-node tests of master-pure nodes in the sandbox.
  'workflows.test': {
    scope: 'project',
    minRole: 'operator',
    description: 'Preview workflow expressions and test a single node on sample data (master sandbox only)',
  },
  // p14-workflow-engine 14.2 (§8.5): saving a version that adds or changes privileged nodes (plus a fresh step-up).
  'workflows.define.network': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Save workflow versions that add or change GitHub, uptime, HTTP or e-mail nodes or a token-only webhook wait (step-up)',
  },
  'workflows.define.deploy': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Save workflow versions that add or change deploy, Pages or DNS nodes (step-up; the deploy policy still decides each action)',
  },
  'workflows.define.code': {
    scope: 'project',
    minRole: 'admin',
    description: 'Save workflow versions that add or change code nodes (step-up)',
  },
  // p14-workflow-engine 14.3 (§8.4, K1): the project's HTTP egress policy of HTTP / e-mail nodes (always-fresh step-up).
  'workflows.egress.write': {
    scope: 'project',
    minRole: 'admin',
    description:
      "Change the project's workflow HTTP egress policy (open / allowlist; LAN and metadata addresses stay refused; always-fresh step-up)",
  },
  'workflows.activate': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Enable or disable a workflow’s trigger nodes (bound automations); webhook / GitHub triggers also need automations.external and a step-up',
  },
  // p18-multi-project: shared workflows — the owner project offers, a target project attaches and binds credentials.
  'workflows.share': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Offer a workflow of the project to listed projects or to every project, or withdraw the offer (step-up)',
  },
  'workflows.attach': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Attach a workflow another project offers, detach it, change its settings here (follow / pin, overrides) and accept a pending version (step-up when it brings privileged nodes)',
  },
  'workflows.attach.credentials': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Bind or unbind the credential slots of an attached workflow to this project’s vault credentials (always-fresh step-up)',
  },

  // Schedules: scheduled job submissions and workflow runs (p5-composer).
  'schedules.read': { scope: 'project', minRole: 'viewer', description: 'List schedules; preview a cron' },
  'schedules.write': {
    scope: 'project',
    minRole: 'operator',
    description: 'Create (step-up) or cancel schedules; each fire re-checks the creator may still submit',
  },

  // Automations: cron / one-shot / GitHub / webhook / chain triggers (p6-automations, ADR-0024).
  'automations.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'List and read automations and their runs; preview a cron',
  },
  'automations.write': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Create / change (step-up), pause, resume, delete and run automations; each run re-checks the run-as user',
  },
  'automations.external': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Automations started from outside: GitHub event and signed webhook triggers (create, resume, rotate secret)',
  },
  'automations.crossproject': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Chain an automation to one of another project (needed in both projects; re-checked at every run, p6-automations-next)',
  },

  // Job templates (p8-templates): parameterised jobs per project, or global (admin).
  'templates.read': {
    scope: 'project',
    minRole: 'viewer',
    description:
      'List and read job templates, their versions and stats; template suggestions; render a template',
  },
  'templates.write': {
    scope: 'project',
    minRole: 'operator',
    description: 'Create, change, duplicate and archive the job templates of a project',
  },
  // p18-multi-project W4: the template library — share a project template with other projects (or every project).
  'templates.share': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Share a job template of the project with listed projects or every project, or withdraw it (the targets read and run it under their own policy; editing stays here)',
  },
  'templates.global': {
    scope: 'global',
    minRole: 'admin',
    description: 'Create, change and archive global job templates (usable in every project)',
  },

  // Quotas: concurrency, fairness, run limits, provider pauses (p4-quotas).
  'quotas.read': {
    scope: 'global',
    minRole: 'viewer',
    description: 'Read quota enforcement status (limits in use, provider pauses, holds, decisions)',
  },
  'quotas.write': {
    scope: 'global',
    minRole: 'admin',
    description: 'Change the quota policy; resume a provider pause early',
  },
  // p15-usage-refresh: "Şimdi kontrol et" — read the runtimes' usage windows now (read-only probes on the machines).
  'quotas.refresh': {
    scope: 'global',
    minRole: 'operator',
    description:
      'Read the runtime usage-limit windows now on the machines (read-only probes, no model request)',
  },
  'projects.kill': {
    scope: 'project',
    minRole: 'admin',
    description: 'Project kill switch: stop all running jobs, hold or release dispatch',
  },

  // Ops chat (p5-ops-chat, ADR-0018): one's own threads; the assistant's tools run with the caller's rights.
  'chat.use': {
    scope: 'global',
    minRole: 'viewer',
    description:
      'Use the ops chat: own threads, messages, draft cards (confirming a draft also needs the target action and step-up)',
  },
  'chat.admin': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Configure the ops chat: assistant worker, runtime, model profile, limits, kill switch (step-up)',
  },

  // Projects, memberships, users.
  'projects.read': { scope: 'project', minRole: 'viewer', description: 'List visible projects' },
  'projects.create': { scope: 'global', minRole: 'admin', description: 'Register a project' },
  'projects.git.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'Read a project’s git provider configuration (no secrets) and commit identity',
  },
  'projects.git.write': {
    scope: 'project',
    minRole: 'admin',
    description: 'Change a project’s git provider configuration or commit identity (step-up)',
  },
  // p5-research-workspace.
  'projects.workspace.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'Read a workspace project’s settings (egress policy)',
  },
  'projects.workspace.write': {
    scope: 'project',
    minRole: 'admin',
    description: 'Change a workspace project’s egress policy (step-up)',
  },
  // p5-sandbox-ops (ADR-0019): host-native / unconfined opt-ins of a project.
  'projects.execution.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'Read a project’s execution policy (host-native profiles, unconfined)',
  },
  'projects.execution.write': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Change a project’s execution policy: host-native profiles, unconfined (always-fresh step-up)',
  },
  // p14-repo-egress: a repository project's network egress for its jobs (none / allowlist / web; always-fresh step-up).
  'projects.egress.write': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Change a repository project’s network access for jobs (none / allowlist / web; LAN and metadata addresses stay refused; always-fresh step-up)',
  },
  'projects.workers.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'List the workers a project is assigned to and where it is in effect',
  },
  'projects.workers.write': {
    scope: 'project',
    minRole: 'admin',
    description: 'Assign a project to workers from the project side (changes worker configurations; step-up)',
  },
  'projects.members.read': { scope: 'project', minRole: 'viewer', description: 'List project members' },
  'projects.members.write': {
    scope: 'project',
    minRole: 'admin',
    description: 'Grant, change or revoke project memberships',
  },
  'users.read': { scope: 'global', minRole: 'admin', description: 'List user accounts' },
  // p5-github-connect (ADR-0022): Settings → Integrations → GitHub.
  'integrations.github.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the connected GitHub App (no secrets), its installations and their repositories',
  },
  'integrations.github.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Connect (App Manifest flow), rotate the key of, or disconnect the GitHub App; sync installations (always-fresh step-up)',
  },
  // p6-deploy-integrations (ADR-0028): master-held Coolify / Cloudflare tokens and typed ops actions.
  'integrations.ops.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the Coolify / Cloudflare connections (no tokens) and their last connection test',
  },
  'integrations.ops.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Connect, change or remove the Coolify / Cloudflare tokens (always-fresh step-up); test a connection',
  },
  // p10-bedrock-integration-panel: master-held AWS Bedrock keys for the embedding provider.
  'integrations.bedrock.read': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Read the AWS Bedrock embeddings connection (no keys), its last test and which provider source is active',
  },
  'integrations.bedrock.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Connect, change or remove the AWS Bedrock embedding keys, region and model (always-fresh step-up); test the connection',
  },
  // p17-object-storage: where blobs go (local disk / S3-compatible bucket), the bucket's keys and the limits.
  'integrations.storage.read': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Read the object storage settings (no keys), limits, usage per location and the last connection test',
  },
  'integrations.storage.write': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Choose local disk or an S3-compatible bucket, enter its keys and the limits (always-fresh step-up); test it',
  },
  // p16-git-providers (ADR-0061): master-held GitLab / Bitbucket access tokens.
  'integrations.githosts.read': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Read the GitLab / Bitbucket connections (no tokens), their expiry, last test and repositories',
  },
  'integrations.githosts.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Connect, change, rotate or remove GitLab / Bitbucket access tokens and open repositories with them (always-fresh step-up); test a connection',
  },
  'deploy.read': {
    scope: 'project',
    minRole: 'viewer',
    description:
      'Read a project’s deploy targets and its ops actions (deploys, DNS changes) with their diffs',
  },
  'deploy.request': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Request an ops action (deploy, restart, Pages deploy, DNS change, rollback); the project policy decides whether it needs approval',
  },
  'deploy.approve': {
    scope: 'project',
    minRole: 'admin',
    description: 'Approve or deny an ops action (always-fresh step-up where the policy says so)',
  },
  'deploy.targets.write': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Change a project’s deploy targets, allowed DNS zones, protected records and deploy policy (step-up)',
  },
  // p15-coolify-create (ADR-0057): applications on a Coolify connection that allows managing them.
  'deploy.coolify.read': {
    scope: 'project',
    minRole: 'admin',
    description:
      'See the Coolify servers, projects, environments and sources a new application can use, the repository’s build suggestion, and the variable keys (never values) and domains of the project’s linked applications',
  },
  'deploy.coolify.manage': {
    scope: 'project',
    minRole: 'admin',
    description:
      'Create a Coolify application for the project (linked to its deploy target), change the environment variables and domains of its linked applications (the security policy decides whether a code is needed)',
  },
  // p17-coolify-full: the whole Coolify of a connection (Ayarlar → Entegrasyonlar → Coolify → Kaynaklar, assistant).
  'coolify.read': {
    scope: 'global',
    minRole: 'admin',
    description:
      'See every resource of a Coolify connection: applications, databases, services, servers, projects, storages, backups, running deployments and logs (never passwords, connection URLs or variable values)',
  },
  'coolify.manage': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Change resources of a Coolify connection that allows it: storages (volumes, file mounts), start / stop / restart, databases and their backups, services, projects and environments, server checks, cancelling deployments (deletions name the resource; the security policy decides whether a code is needed)',
  },
  // p8-preview-tunnels (ADR-0032): preview links of running jobs through Cloudflare Tunnel (ops actions tunnel.*).
  'previews.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'See a project’s and a job’s preview links (hostnames, protection, expiry, connector state)',
  },
  'previews.open': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Open, extend or close a preview link of a running job (the project policy decides whether it needs approval)',
  },
  'previews.reveal': {
    scope: 'project',
    minRole: 'admin',
    description: 'Show the Access service token of a service-token protected preview (always-fresh step-up)',
  },
  // p15-services: long-running services machines keep for a project (dev servers, backends; no job slot).
  'services.read': {
    scope: 'project',
    minRole: 'viewer',
    description:
      'See a project’s services (state, health, URL, machine, uptime, CPU / memory) and their logs',
  },
  'services.manage': {
    scope: 'project',
    minRole: 'operator',
    description: 'Start, stop, restart, extend or remove a project’s services (audited)',
  },
  // p15-workspace-retention: kept working directories of workspace jobs on the machines ("Çalışma dosyaları").
  'workfiles.read': {
    scope: 'project',
    minRole: 'viewer',
    description:
      'See the kept working directories of a project’s workspace jobs (machine, size, expiry), list, preview and download their files',
  },
  'workfiles.manage': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Clean up kept working directories, push them to a repository as a branch + pull request, or make a site upload of them (audited)',
  },
  'workfiles.settings': {
    scope: 'global',
    minRole: 'admin',
    description: 'Change how long kept working directories stay and the per-machine size cap (audited)',
  },
  // p6-outputs: the Outputs screen — live sites, job files and notes; titles, tags, pins and notes are people's own.
  'outputs.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'List live sites, job output files and notes of a project; preview and download files',
  },
  'outputs.write': {
    scope: 'project',
    minRole: 'operator',
    description:
      'Title, tag and pin outputs; write notes (edit or delete one’s own notes; owners and admins any note)',
  },
  // p8-outputs-folders: the gate of folder writes — own personal folders for everyone; project folders additionally
  // need `outputs.write` in the folder's project (checked by the folder service).
  // p17-object-storage: time-limited share links of a job output (anyone holding the link can download the file).
  'outputs.share': {
    scope: 'project',
    minRole: 'admin',
    description: 'Create, list and revoke time-limited share links of output files (audited)',
  },
  'outputs.folders': {
    scope: 'project',
    minRole: 'viewer',
    description:
      'Manage folders on Outputs: one’s own personal folders; project folders with outputs.write in that project',
  },
  // p8-uptime: monitors of deployed sites and services (the master probes them).
  'uptime.read': {
    scope: 'project',
    minRole: 'viewer',
    description: 'See a project’s monitors, their status, uptime, latency charts, checks and incidents',
  },
  'uptime.write': {
    scope: 'project',
    minRole: 'operator',
    description: 'Create, edit, pause, delete and check now the monitors of a project',
  },
  'uptime.settings': {
    scope: 'project',
    minRole: 'admin',
    description: 'Switch “auto-monitor deployed sites” for a project',
  },
  // p5-git-identity: the workspace-wide default git commit identity (Settings → Integrations).
  'git.identity.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the workspace-wide default git commit identity',
  },
  'git.identity.write': {
    scope: 'global',
    minRole: 'admin',
    description: 'Set or remove the workspace-wide default git commit identity (step-up)',
  },
  // p16-api-tokens (ADR-0058): personal API tokens, every token (admins), service accounts.
  'tokens.self': {
    scope: 'global',
    minRole: 'viewer',
    selfOnly: true,
    description:
      'List, create, rotate and revoke one’s own API tokens (creating / rotating: a code by the policy)',
  },
  'tokens.admin': {
    scope: 'global',
    minRole: 'admin',
    description: 'List every API token (personal and service account, never secrets) and revoke any of them',
  },
  'serviceaccounts.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'List service accounts, their roles, project memberships and tokens (no secrets)',
  },
  'serviceaccounts.manage': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Create service accounts, change their role / description / state (users.roles event); create and rotate their tokens (api.tokens event)',
  },
  // p5-coolify-sso: open Coolify through the forward-auth gate and sign in to it via the master's OIDC.
  'sso.coolify': {
    scope: 'global',
    minRole: 'admin',
    description: 'Open Coolify (forward-auth gate) and sign in to it with the console account (OIDC)',
  },
  'users.manage': {
    scope: 'global',
    minRole: 'owner',
    description: 'Create users, change account roles, disable/enable accounts',
  },
  // p15-autonomy (ADR-0056): the security policy (step-up window, per-event codes, agent autonomy defaults).
  'security.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'Read the security policy (Settings → Security)',
  },
  'security.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Change the security policy, or apply its autonomy defaults to existing projects (a code when the policy keeps it protected)',
  },
  // p16-webhooks-out (ADR-0059): outgoing webhooks for external automation (Settings → Webhooks).
  'webhooks.read': {
    scope: 'global',
    minRole: 'admin',
    description: 'List outgoing webhooks, their delivery log and the event catalog (never a secret)',
  },
  'webhooks.write': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Create, change, pause, resume, test, redeliver and delete outgoing webhooks; rotate or reveal (once) their signing secret',
  },
  'webhooks.internal': {
    scope: 'global',
    minRole: 'owner',
    description:
      'Change the exact internal origins webhooks may target although they are not public (a trust-model change)',
  },
  // p16-doctor (ADR-0062): diagnostics and the support report (Settings → Diagnostics).
  'doctor.run': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Run the doctor on the master, ask the machines for theirs, read the results, and build / preview / download the redacted support report (nothing leaves the installation)',
  },
  'support.report': {
    scope: 'global',
    minRole: 'admin',
    description:
      'Send the redacted support report to the support address by e-mail (data leaves the installation)',
  },
  'support.settings': {
    scope: 'global',
    minRole: 'owner',
    description:
      "Change the support address and the support e-mail's SMTP server (where diagnostics data is sent)",
  },
} as const satisfies Record<string, ActionSpec>;

export type Action = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];

export function isAction(value: string): value is Action {
  return Object.hasOwn(ACTIONS, value);
}

export interface Subject {
  readonly userId: string;
  readonly role: Role;
  /** project id → membership role (only meaningful for operator/viewer accounts). */
  readonly memberships: ReadonlyMap<string, ProjectRole>;
}

export interface Resource {
  /** The project the resource belongs to; null/undefined for global resources and collections. */
  readonly project?: string | null;
  /** The user the resource belongs to (self-service actions). */
  readonly ownerId?: string | null;
}

export type DenyReason = 'unknown_action' | 'role' | 'not_visible' | 'not_owner';
export type Decision =
  { readonly allow: true; readonly role: Role } | { readonly allow: false; readonly reason: DenyReason };

/** The subject's role in `project`, or null when the project is not visible to them. */
export function projectRoleOf(subject: Subject, project: string): Role | null {
  if (GLOBAL_ROLES.has(subject.role)) return subject.role;
  const membership = subject.memberships.get(project);
  return membership === undefined ? null : lowerRole(membership, subject.role);
}

/** Projects the subject may see: null means every project (owner/admin). */
export function visibleProjects(subject: Subject): readonly string[] | null {
  if (GLOBAL_ROLES.has(subject.role)) return null;
  return [...subject.memberships.keys()].sort();
}

/**
 * The policy decision function. Deny by default; evaluation order matters:
 *
 * 1. unknown action → deny;
 * 2. the account role must reach the action's minimum role (resource-independent, so a refusal here never
 *    reveals whether a resource exists);
 * 3. self-only actions need `resource.ownerId === subject.userId`;
 * 4. project-scoped actions on a resource in a project: the project must be visible (else `not_visible`,
 *    which callers turn into 404) and the effective project role must reach the minimum role.
 *
 * Without a resource (collections) a project-scoped action is allowed by step 2; list endpoints then
 * filter rows by {@link visibleProjects}.
 */
export function authorize(subject: Subject, action: string, resource?: Resource | null): Decision {
  if (!isAction(action)) return { allow: false, reason: 'unknown_action' };
  const spec: ActionSpec = ACTIONS[action];
  if (!roleAtLeast(subject.role, spec.minRole)) return { allow: false, reason: 'role' };
  if (spec.selfOnly === true && resource?.ownerId !== subject.userId) {
    return { allow: false, reason: 'not_owner' };
  }
  const project = resource?.project;
  if (spec.scope === 'global' || project === undefined || project === null) {
    return { allow: true, role: subject.role };
  }
  const role = projectRoleOf(subject, project);
  if (role === null) return { allow: false, reason: 'not_visible' };
  if (!roleAtLeast(role, spec.minRole)) return { allow: false, reason: 'role' };
  return { allow: true, role };
}
