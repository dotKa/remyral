/**
 * p15-autonomy (ADR-0056, docs/design/p15-autonomy.md §3): the catalog of step-up–protected events. Pure, DB-free.
 *
 * Every privileged action that can ask for an authenticator code belongs to exactly one **event**. The security policy
 * (Ayarlar → Güvenlik) says per event whether a code is required ("TOTP iste"); an event that is off is **waived**:
 * the request passes the step-up check of its route and of the services behind it without a code.
 *
 * An event is matched to a request by its route (`METHOD /url`, exact override) or else by the route's authorization
 * action (`config.authz.action`). Routes whose action is in {@link NO_STEP_UP_ACTIONS} and that have no override never
 * ask for a code and are never waived. A route that has a step-up check but matches no event is not waived (fail
 * closed) — route-coverage.test.ts fails the build for such a route, and security-policy.test.ts for an action that is
 * neither mapped nor listed as having no step-up.
 *
 * `POST /chat/drafts/:id/confirm` is **dynamic**: the confirmed card's kind decides the event ({@link eventOfDraft}),
 * checked by the draft executor itself.
 */

export const EVENT_CATEGORIES = [
  'account',
  'security',
  'users',
  'secrets',
  'machines',
  'deploy',
  'extensions',
  'workflows',
  'integrations',
  'policies',
  'jobs',
  'data',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface StepUpEventSpec {
  readonly category: EventCategory;
  /** Authorization actions whose routes belong to this event (unless a route override says otherwise). */
  readonly actions: readonly string[];
  /** Exact `METHOD /url` routes of this event (they win over the action mapping). */
  readonly routes: readonly string[];
  /**
   * The safe core: by design on by default in every preset — changing the security policy itself,
   * disabling / resetting 2FA, user and role changes, revealing secrets in plain text.
   */
  readonly core: boolean;
  /** On in the "Dengeli" (balanced) preset. */
  readonly balanced: boolean;
}

function ev(
  category: EventCategory,
  actions: readonly string[],
  routes: readonly string[] = [],
  flags: { core?: boolean; balanced?: boolean } = {},
): StepUpEventSpec {
  const core = flags.core === true;
  return { category, actions, routes, core, balanced: core || flags.balanced === true };
}

export const STEP_UP_EVENTS = {
  // ---------------------------------------------------------------- account security
  'account.password': ev('account', [], ['POST /auth/password'], { balanced: true }),
  'account.devices': ev('account', [], ['POST /auth/devices/revoke-all'], { balanced: true }),
  /** Disabling / resetting 2FA and regenerating recovery codes (today only through the master shell, no route). */
  'account.mfa': ev('account', [], [], { core: true }),
  // ---------------------------------------------------------------- the security policy itself
  // p16-webhooks-out: the owner's internal webhook targets lower the SSRF floor — a security policy change.
  'security.policy': ev('security', ['security.write', 'webhooks.internal'], [], { core: true }),
  // ---------------------------------------------------------------- users and roles
  'users.roles': ev(
    'users',
    ['users.manage', 'projects.members.write'],
    // p16-api-tokens (ADR-0058): creating a service account or changing its role / state is a user change.
    ['POST /service-accounts', 'PATCH /service-accounts/:id'],
    { core: true },
  ),
  /**
   * p16-api-tokens (ADR-0058): creating or rotating an API token (personal or a service account's) mints a long-lived
   * credential that needs no authenticator afterwards — safe core. Revoking never asks.
   */
  'api.tokens': ev(
    'security',
    [],
    [
      'POST /me/api-tokens',
      'POST /me/api-tokens/:id/rotate',
      'POST /service-accounts/:id/tokens',
      'POST /service-accounts/:id/tokens/:tokenId/rotate',
    ],
    { core: true },
  ),
  // ---------------------------------------------------------------- vault / credentials / secrets
  'credentials.write': ev('secrets', ['vault.write'], [], { balanced: true }),
  'secrets.reveal': ev('secrets', ['previews.reveal'], [], { core: true }),
  // ---------------------------------------------------------------- machines and sandbox
  'machines.fleet': ev('machines', [
    'workers.approve',
    'workers.revoke',
    'workers.drain',
    'workers.archive',
    'workers.rotate',
    'workers.update',
  ]),
  'machines.config': ev('machines', ['workers.config.write', 'runtimes.write', 'projects.workers.write']),
  'machines.ops': ev('machines', ['workers.ops.write']),
  'machines.logins': ev(
    'machines',
    [],
    [
      'POST /workers/:id/runtimes/:runtime/login',
      'POST /workers/:id/ops/:opId/input',
      'POST /workers/:id/runtimes/:runtime/logout',
      'DELETE /workers/:id/runtime-accounts/:runtime/:account',
    ],
    { balanced: true },
  ),
  'machines.sandbox': ev(
    'machines',
    [],
    [
      'POST /workers/:id/sandbox/prepare',
      'PUT /workers/:id/sandbox/unconfined',
      'PUT /projects/:id/execution',
    ],
    { balanced: true },
  ),
  'machines.admin': ev('machines', ['machines.admin.enable', 'machines.admin.run'], [], { balanced: true }),
  /**
   * p19-ide W2 (docs/design/p19-ide.md decision 5): creating / starting a Tam IDE workspace — interactive code
   * execution on a machine.
   * On in Dengeli / Sıkı (an authenticator code at start); switchable like every event.
   */
  'ide.start': ev('machines', [], ['POST /projects/:id/ide/workspaces', 'POST /ide/workspaces/:id/start'], {
    balanced: true,
  }),
  // ---------------------------------------------------------------- deploys / production
  /** Production deploys and their approvals, deploy-on-success pre-approvals (`POST /jobs` with deployOnSuccess). */
  'deploy.production': ev('deploy', ['deploy.request', 'deploy.approve'], ['POST /jobs'], { balanced: true }),
  'deploy.targets': ev('deploy', ['deploy.targets.write']),
  /**
   * p15-coolify-create (ADR-0057): creating a Coolify application, changing its environment variables or domains (the
   * panel and the assistant's coolify_* tools). Off in Serbest (off by default there), on in Dengeli / Sıkı.
   */
  'deploy.coolify': ev('deploy', ['deploy.coolify.manage'], [], { balanced: true }),
  /**
   * p17-coolify-full: Coolify-wide changes — storages, start / restart, databases and backups, services, projects and
   * environments, server checks, cancelling a deployment (Ayarlar → Entegrasyonlar → Coolify → Kaynaklar and the
   * assistant). Off in Serbest, on in Dengeli / Sıkı.
   */
  'coolify.manage': ev('deploy', ['coolify.manage'], [], { balanced: true }),
  /**
   * p17-coolify-full: what loses data or takes a site down — removing a storage, stopping a resource, deleting a
   * database, service, backup schedule, project or environment (also typed-name confirmation, always). Off in
   * Serbest, on in Dengeli / Sıkı.
   */
  'coolify.destructive': ev(
    'deploy',
    [],
    [
      'DELETE /projects/:id/coolify/apps/:uuid/storages/:storage',
      'POST /projects/:id/coolify/apps/:uuid/stop',
      'DELETE /integrations/coolify/connections/:id/resources/:kind/:uuid/storages/:storage',
      'POST /integrations/coolify/connections/:id/resources/:kind/:uuid/stop',
      'DELETE /integrations/coolify/connections/:id/databases/:uuid',
      'DELETE /integrations/coolify/connections/:id/databases/:uuid/backups/:backup',
      'DELETE /integrations/coolify/connections/:id/services/:uuid',
      'DELETE /integrations/coolify/connections/:id/projects/:uuid',
      'DELETE /integrations/coolify/connections/:id/projects/:uuid/environments/:environment',
    ],
    { balanced: true },
  ),
  // p17-update-channel: the owner's update channel policy is the same kind of decision as a rollout.
  'releases.publish': ev('deploy', ['releases.publish', 'updates.channel.write'], [], { balanced: true }),
  /**
   * p17-domain-wizard (ADR-0063 amendment 2026-10-24): the console's public address — where e-mail, install command,
   * GitHub callback and webhook links point, and on a remyral-ctl host the domain the proxy serves. Off in Serbest,
   * on in Dengeli / Sıkı.
   */
  'console.domain': ev('deploy', ['console.domain.write'], [], { balanced: true }),
  /**
   * p17-host-actions (ADR-0063 amendment 2026-10-26): upgrading or rolling back the control plane from the console (the
   * remyral-ctl host applier runs it; a rollback may restore a backup). Safe core, and always fresh (route class).
   */
  'host.update': ev('deploy', ['host.update'], [], { core: true }),
  /**
   * p17-host-actions part 3: backups from the console — a backup or drill now, schedule / retention / WAL / encryption
   * recipients, the off-site target (its keys). Off in Serbest, on in Dengeli / Sıkı.
   */
  'backups.manage': ev('data', ['backups.manage'], [], { balanced: true }),
  /** Replacing the live database with a backup: safe core, always fresh (route class). */
  'backups.restore': ev('data', ['backups.restore'], [], { core: true }),
  // ---------------------------------------------------------------- MCP / skills installs
  'extensions.skills': ev('extensions', ['skills.publish', 'skills.assign']),
  'extensions.mcp': ev('extensions', ['mcp.manage', 'mcp.assign'], [], { balanced: true }),
  /**
   * p19-install-scripts (ADR-0068): approving an npm install script lets that package's code run on every machine that
   * installs it — safe core (a code in every preset). Revoking never asks.
   */
  'extensions.install_scripts': ev('extensions', ['mcp.scripts'], [], { core: true }),
  /**
   * p19-ide W3: the IDE extension allowlist, deny lists, a project's required / recommended extensions and enforced
   * settings (what runs inside every Tam IDE). On in Dengeli / Sıkı.
   */
  'extensions.ide': ev('extensions', ['ide.extensions'], [], { balanced: true }),
  // ---------------------------------------------------------------- workflows: privileged nodes
  'workflows.privileged': ev('workflows', [
    'workflows.define',
    'workflows.define.network',
    'workflows.define.deploy',
    'workflows.define.code',
    'workflows.egress.write',
    'workflows.activate',
    // p18-multi-project: offering a workflow, attaching one (privileged nodes), binding its credential slots.
    'workflows.share',
    'workflows.attach',
    'workflows.attach.credentials',
  ]),
  // ---------------------------------------------------------------- integrations
  'integrations.connections': ev(
    'integrations',
    [
      'integrations.github.write',
      'integrations.ops.write',
      'integrations.bedrock.write',
      'integrations.githosts.write',
      // p17-object-storage: the bucket and keys every output goes to.
      'integrations.storage.write',
    ],
    [],
    { balanced: true },
  ),
  'integrations.git': ev('integrations', ['projects.git.write', 'git.identity.write']),
  /**
   * p16-webhooks-out (ADR-0059): an outgoing webhook sends event data to an outside address — creating or changing one,
   * resuming it and rotating / revealing its secret. Pausing, testing, redelivering and deleting never ask.
   */
  'integrations.webhooks': ev('integrations', ['webhooks.write'], [], { balanced: true }),
  // ---------------------------------------------------------------- project policies, limits, models, context
  'projects.policy': ev('policies', [
    'policy.write',
    'projects.create',
    'projects.workspace.write',
    'projects.kill',
    'projects.execution.write',
    // p14-repo-egress: a repository project's network access.
    'projects.egress.write',
    // p15-workspace-retention: how long kept working directories stay, the per-machine cap.
    'workfiles.settings',
  ]),
  'limits.budgets': ev('policies', ['quotas.write', 'budgets.write', 'budgets.override', 'prices.write']),
  'models.routing': ev('policies', ['models.write']),
  'context.admin': ev('policies', [
    'context.write',
    'context.delete',
    'context.purge',
    'context.retention',
    'context.search.admin',
    'context.defaults',
    'memory.suggestions.admin',
  ]),
  'chat.settings': ev('policies', ['chat.admin']),
  // ---------------------------------------------------------------- jobs, approvals, automations, chat cards
  'approvals.decide': ev('jobs', ['approvals.decide', 'workflows.approve']),
  'jobs.control': ev('jobs', ['jobs.resume', 'jobs.queue.runnow', 'jobs.approval.mode', 'jobs.timelimit']),
  'automations.manage': ev('jobs', [
    'automations.write',
    'automations.external',
    'automations.crossproject',
    'schedules.write',
    'templates.write',
    'templates.share',
    'templates.global',
  ]),
  /** Confirming a chat card that starts / steers work: job, workflow run, job message, resume, job actions, monitor. */
  'chat.cards': ev('jobs', []),
  // ---------------------------------------------------------------- data access
  'data.access': ev(
    'data',
    ['audit.read', 'audit.export', 'audit.verify', 'usage.records', 'jobs.export', 'context.export'],
    // p17-object-storage: a share link lets anyone holding it download the file (listing and revoking never ask).
    ['POST /jobs/:id/artifacts/:artifactId/shares'],
  ),
  /**
   * p16-doctor (ADR-0062): the support report leaves the installation — sending it by e-mail and changing where it goes
   * (support address, support SMTP). Off in Serbest, on in Dengeli / Sıkı. Running the doctor and downloading the
   * redacted bundle never ask.
   */
  'support.report': ev('data', ['support.report', 'support.settings'], [], { balanced: true }),
  /**
   * p17-panel-settings: the master-stored settings (webhook / push allowlists and keys, the search provider, trusted
   * proxies, session lifetimes, logs, memory, workflow engine, ops protection) and the panel's key rotations — safe core.
   */
  'settings.panel': ev('security', ['settings.panel.write', 'keys.rotate'], [], { core: true }),
  /** p17-panel-settings Part 4: resetting another user's authenticator / password, unlocking — safe core. */
  'users.recover': ev('users', ['users.recover'], [], { core: true }),
  /** p17-panel-settings Part 7: maintenance jobs (moving stored files, re-indexing, auto-learning). */
  'maintenance.run': ev('data', ['maintenance.run'], [], { balanced: true }),
  'notifications.channels': ev(
    'data',
    [],
    ['PUT /notifications/preferences', 'POST /notifications/push/subscriptions'],
  ),
} as const satisfies Record<string, StepUpEventSpec>;

export type StepUpEvent = keyof typeof STEP_UP_EVENTS;
export const STEP_UP_EVENT_IDS = Object.keys(STEP_UP_EVENTS) as StepUpEvent[];

export function isStepUpEvent(v: unknown): v is StepUpEvent {
  return typeof v === 'string' && Object.hasOwn(STEP_UP_EVENTS, v);
}

/** The safe core (on by default in every preset). */
export const CORE_EVENTS: readonly StepUpEvent[] = STEP_UP_EVENT_IDS.filter((e) => STEP_UP_EVENTS[e].core);

/**
 * Authorization actions that never ask for a code (reads, own-account self-service, everyday work). A route of one
 * of these actions is matched only by a route override. Every action of the authorization catalog is either mapped to
 * an event or listed here (security-policy.test.ts).
 */
export const NO_STEP_UP_ACTIONS: ReadonlySet<string> = new Set([
  'session.self',
  'api.docs',
  'notifications.self',
  'jobs.read',
  'jobs.create',
  'jobs.cancel',
  'jobs.queue.reorder',
  'jobs.message',
  'jobs.merge',
  'approvals.read',
  'policy.read',
  'context.read',
  'context.bundle',
  'context.receipts',
  'context.search',
  'memory.suggestions.read',
  'memory.suggestions.decide',
  'memory.personal',
  'backups.read',
  // p16-observability: read-only status, traces and log search.
  'system.status',
  'system.logs',
  // p16-selfhost-onboarding: the wizard's own progress (organisation name, step marks) and the update status. The
  // steps that change something sensitive go through their own routes and events.
  'onboarding.manage',
  'updates.read',
  // p17-domain-wizard: the address status and the DNS check only read.
  'console.domain.read',
  // p17-host-actions: the applier status and the progress of a request only read.
  'host.actions.read',
  'settings.panel.read',
  'maintenance.read',
  'workers.read',
  // p16-webhooks-out: reading the webhooks and their delivery log.
  'webhooks.read',
  // p16-doctor: running the doctor, reading it, previewing and downloading the redacted bundle (nothing leaves).
  'doctor.run',
  // p15-chat-cards-scroll: a machine's display name (admin, audited; no security effect).
  'workers.rename',
  'workers.config.read',
  'workers.ops.read',
  'machines.admin.read',
  'vault.read',
  'models.read',
  'runtimes.read',
  'releases.read',
  'installers.read',
  'skills.read',
  'mcp.read',
  'usage.read',
  'budgets.read',
  'reports.self',
  'workflows.read',
  'workflows.run',
  'workflows.test',
  'schedules.read',
  'automations.read',
  'templates.read',
  'quotas.read',
  // p15-usage-refresh: read-only usage probes on request (operator; bounded per user and machine, the op audited).
  'quotas.refresh',
  'chat.use',
  'projects.read',
  'projects.git.read',
  'projects.workspace.read',
  'projects.execution.read',
  'projects.workers.read',
  'projects.members.read',
  'users.read',
  'integrations.github.read',
  'integrations.ops.read',
  'integrations.bedrock.read',
  'integrations.githosts.read',
  'integrations.storage.read',
  'deploy.read',
  'deploy.coolify.read',
  // p17-coolify-full: the Coolify-wide view only reads.
  'coolify.read',
  'previews.read',
  'previews.open',
  // p15-services: like previews.open (operator, no step-up on the routes).
  'services.read',
  'services.manage',
  // p15-workspace-retention: kept working files — read, clean up, push to a repository (operator, audited).
  'workfiles.read',
  'workfiles.manage',
  // p19-ide W1: the code viewer / reviewer — reading and review comments never ask for a code (design §7).
  'code.read',
  'code.review',
  // p19-ide W2: the IDE routes never ask except the start ones (the `ide.start` route overrides); stopping, deleting,
  // opening (a ticket of a running workspace) and pushing the workspace branch do not.
  'ide.use',
  'ide.manage',
  'outputs.read',
  'outputs.write',
  'outputs.folders',
  'outputs.share',
  'uptime.read',
  'uptime.write',
  'uptime.settings',
  'git.identity.read',
  'sso.coolify',
  'security.read',
  // p16-api-tokens: reads and revocations never ask; create / rotate are the `api.tokens` route overrides, service
  // account create / change the `users.roles` ones.
  'tokens.self',
  'tokens.admin',
  'serviceaccounts.read',
  'serviceaccounts.manage',
]);

/** The chat card confirmation route: its event is the confirmed card's (see the module comment). */
export const DYNAMIC_ROUTES: ReadonlySet<string> = new Set(['POST /chat/drafts/:id/confirm']);

const BY_ROUTE = new Map<string, StepUpEvent>();
const BY_ACTION = new Map<string, StepUpEvent>();
for (const id of STEP_UP_EVENT_IDS) {
  const spec: StepUpEventSpec = STEP_UP_EVENTS[id];
  for (const r of spec.routes) BY_ROUTE.set(r, id);
  for (const a of spec.actions) BY_ACTION.set(a, id);
}

export type EventMatch = StepUpEvent | 'dynamic' | undefined;

/**
 * The event of a route: its override, else its authorization action's event; `dynamic` for the chat confirmation;
 * undefined when the route never asks for a code (or is unknown — then nothing is waived).
 */
export function eventForRoute(method: string, url: string, action: string | undefined): EventMatch {
  const m = method === 'HEAD' ? 'GET' : method;
  const key = `${m} ${url}`;
  if (DYNAMIC_ROUTES.has(key)) return 'dynamic';
  const byRoute = BY_ROUTE.get(key);
  if (byRoute !== undefined) return byRoute;
  if (action === undefined) return undefined;
  return BY_ACTION.get(action);
}

/** The action → event map (for tests and the settings screen). */
export function eventOfAction(action: string): StepUpEvent | undefined {
  return BY_ACTION.get(action);
}

/**
 * The event of a chat card (draft kind + payload) — what confirming it does, so the card asks for a code exactly when
 * the same action on its own screen would.
 */
export function eventOfDraft(kind: string, payload: Record<string, unknown>): StepUpEvent {
  switch (kind) {
    case 'approval_decision':
      return 'approvals.decide';
    case 'worker_config':
      return 'machines.config';
    case 'machine_task':
      return 'machines.admin';
    case 'tool_install':
      return payload.elevated === true ? 'machines.admin' : 'machines.ops';
    // p16-runtime-updates: the same event as POST /fleet/tools/actions (workers.ops.write).
    case 'runtime_update':
      return 'machines.ops';
    // p16-webhooks-out: creating / resuming a webhook as on Settings → Webhooks; pausing only stops sending.
    case 'webhook':
      return payload.op === 'pause' ? 'chat.cards' : 'integrations.webhooks';
    // p16-doctor: sending the support report as on Ayarlar → Tanılama.
    case 'support_report':
      return 'support.report';
    case 'skill':
    case 'skill_import':
      return 'extensions.skills';
    case 'mcp_install':
      return 'extensions.mcp';
    // p19-install-scripts: the event of POST /mcp/install-scripts.
    case 'install_script_approval':
      return 'extensions.install_scripts';
    case 'automation':
    case 'automation_change':
      return 'automations.manage';
    case 'ops_action':
      return 'deploy.production';
    case 'coolify_change':
      return coolifyDraftEvent(payload);
    case 'github_repo':
      return 'integrations.connections';
    // p17-chat-github: the event of POST /projects (projects.create).
    case 'project_create':
      return 'projects.policy';
    // p18-multi-project W3: the event of POST /projects/:project/workflow-attachments (workflows.attach).
    case 'workflow_attach':
      return 'workflows.privileged';
    // p15-workspace-retention: a branch + pull request (merging stays git flow's); a new repository like github_repo.
    case 'workfiles_export':
      return typeof payload.newRepository === 'object' && payload.newRepository !== null
        ? 'integrations.connections'
        : 'chat.cards';
    // p15-chat-vault: a request that carries a vault credential is a privileged network call (like an HTTP node with
    // auth); saving a credential is the vault's own write event.
    case 'http_request':
      return typeof payload.credential === 'object' && payload.credential !== null
        ? 'workflows.privileged'
        : 'chat.cards';
    case 'credential_save':
      return 'credentials.write';
    case 'memory_change':
      return 'context.admin';
    case 'workflow':
      // p16-workflow-quality: activating webhook / GitHub triggers is privileged too (`activateExternal`).
      return (Array.isArray(payload.privileged) && payload.privileged.length > 0) ||
        payload.activateExternal === true
        ? 'workflows.privileged'
        : 'chat.cards';
    case 'job_action':
      return payload.action === 'run_now' ? 'jobs.control' : 'chat.cards';
    case 'job_resume':
    case 'time_limit':
      return 'jobs.control';
    case 'account_action':
      return payload.action === 'switch_job' ? 'jobs.control' : 'machines.config';
    case 'settings_change':
      // p16-assistant-admin: an administration card's event is its change's own (user, machine, release …).
      return payload.target === 'admin'
        ? adminOpEvent(typeof payload.op === 'string' ? payload.op : '', payload)
        : settingsTargetEvent(typeof payload.target === 'string' ? payload.target : '');
    default:
      // job, workflow_run, job_message, job_resume, job_action, monitor
      return 'chat.cards';
  }
}

/** p15-autonomy: the event of a `change_settings` target (the same event as that setting's own route). */
export function settingsTargetEvent(target: string): StepUpEvent {
  switch (target) {
    case 'security_policy':
      return 'security.policy';
    case 'project_execution':
      return 'machines.sandbox';
    case 'project_approval_rules':
      return 'projects.policy';
    case 'worker_runtime_policy':
      return 'machines.config';
    case 'apply_autonomy':
      return 'security.policy';
    default:
      return 'security.policy';
  }
}

/**
 * p16-assistant-admin (docs/design/p16-assistant-admin.md): the event of an administration card (`settings_change`,
 * target "admin") — the event of the route the same change takes in the console, so the card asks for a code exactly
 * when that screen would. Unknown operations fall back to the safe core (`security.policy`): fail closed.
 */
export function adminOpEvent(op: string, payload: Record<string, unknown> = {}): StepUpEvent {
  switch (op) {
    case 'user.invite':
    case 'user.set_role':
    case 'user.enable':
    case 'user.disable':
    case 'member.add':
    case 'member.remove':
      return 'users.roles';
    case 'machine.approve':
    case 'machine.reject':
    case 'machine.revoke':
    case 'machine.rotate_key':
    case 'release.rollback_machine':
      return 'machines.fleet';
    // p19-chat-machine-admin: POST /workers/:id/sandbox/prepare (draft_machine_prepare).
    case 'machine.prepare':
      return 'machines.sandbox';
    case 'release.set_rollout':
    case 'release.pause':
      return 'releases.publish';
    // PUT /notifications/preferences asks for a code only when the e-mail address or the webhook changes.
    case 'notifications.update':
      return payload.changesTargets === true ? 'notifications.channels' : 'chat.cards';
    // The connection test / installation sync routes have no step-up of their own.
    case 'integration.check':
      return 'chat.cards';
    // p18-assistant-gaps: the events of the console routes these cards stand for.
    // POST /workflows/runs/:id/cancel, PATCH /uptime/monitors/:id, POST /jobs/:id/questions/:qid/answer and
    // POST /deploy-health/:id/recheck have no step-up of their own (workflows.run, uptime.write, jobs.message).
    case 'workflow.cancel_run':
    case 'monitor.update':
    case 'job.answer_question':
    case 'deploy.health_recheck':
      return 'chat.cards';
    case 'workflow.decide_node':
      return 'approvals.decide';
    case 'backup.run':
    case 'backup.drill':
      return 'backups.manage';
    case 'backup.restore':
      return 'backups.restore';
    case 'host.upgrade':
      return 'host.update';
    case 'template.from_job':
      return 'automations.manage';
    case 'cost_brake.lift':
    case 'cost_brake.end_lift':
    case 'cost_brake.project_ceiling':
    case 'budget.create': // p18-leftovers: POST / PUT / DELETE /budgets (budgets.write), the console's event.
    case 'budget.update':
    case 'budget.delete':
      return 'limits.budgets';
    // p18-project-bootstrap: PUT /projects/:id/repo-egress (projects.egress.write) and PUT /projects/:id/workers +
    // /preferred-workers (projects.workers.write) — the console routes' events.
    case 'project.network':
      return 'projects.policy';
    case 'project.machines':
      return 'machines.config';
    // p19-ide W4: POST /jobs/:id/review/request-changes (code.review) has no step-up of its own.
    case 'code.request_changes':
      return 'chat.cards';
    default:
      return 'security.policy';
  }
}

/**
 * p17-coolify-full: the event of a `coolify_change` card — a destructive one (`destructive: true`: remove a storage,
 * stop, delete) is `coolify.destructive`, a Coolify-wide one (`scope: connection`) `coolify.manage`, a project
 * application's `deploy.coolify`. The console mirrors it (apps/web/src/diyalog/drafts/event.ts).
 */
export function coolifyDraftEvent(payload: Record<string, unknown>): StepUpEvent {
  // p22-site-coolify: the chain opens a project (new) and a GitHub repository — the events of those cards.
  if (payload.op === 'publish_site')
    return payload.newProject === true ? 'projects.policy' : 'integrations.connections';
  if (payload.destructive === true && payload.op !== 'delete_app') return 'coolify.destructive';
  if (payload.scope === 'connection') return 'coolify.manage';
  return 'deploy.coolify';
}
