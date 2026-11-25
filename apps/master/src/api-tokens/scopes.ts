import type { Action, Role } from '../authz/model.js';
import { roleAtLeast } from '../authz/model.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §4, ADR-0058): token scopes. Pure.
 *
 * A token request is allowed when the route's authorization action is in one of the token's scopes **and** the
 * principal's role (with its project memberships) allows the action — the scope can only narrow the role.
 * {@link TOKEN_SCOPE_OF} is total over the action catalog (`Record<Action, …>`): adding an action without deciding its
 * scope fails `pnpm typecheck`. `null` = session only: never reachable with a token.
 */
export const TOKEN_SCOPES = ['read', 'jobs:write', 'approvals', 'deploy', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(v: unknown): v is TokenScope {
  return typeof v === 'string' && (TOKEN_SCOPES as readonly string[]).includes(v);
}

/** The weakest account role for which a scope can grant anything (a token may not name an unreachable scope). */
export const SCOPE_MIN_ROLE: Readonly<Record<TokenScope, Role>> = {
  read: 'viewer',
  'jobs:write': 'operator',
  approvals: 'operator',
  deploy: 'operator',
  admin: 'admin',
};

/** The scopes a principal with `role` may give a token. */
export function reachableScopes(role: Role): TokenScope[] {
  return TOKEN_SCOPES.filter((s) => roleAtLeast(role, SCOPE_MIN_ROLE[s]));
}

const R = 'read' as const;
const W = 'jobs:write' as const;
const A = 'approvals' as const;
const D = 'deploy' as const;
const ADM = 'admin' as const;

export const TOKEN_SCOPE_OF: Readonly<Record<Action, TokenScope | null>> = {
  // Own session, step-up, notifications and push, personal rules and reports: the browser's.
  'session.self': null,
  'api.docs': R,
  'notifications.self': null,
  // Jobs.
  'jobs.read': R,
  'jobs.create': W,
  'jobs.cancel': W,
  'jobs.queue.reorder': W,
  'jobs.queue.runnow': ADM,
  'jobs.export': R,
  'jobs.message': W,
  'jobs.approval.mode': W,
  'jobs.timelimit': W,
  'jobs.resume': W,
  'jobs.merge': W,
  // p19-ide W1: the code viewer / reviewer (read) and review comments / "Değişiklik iste" (jobs:write).
  'code.read': R,
  'code.review': W,
  // p19-ide W2: interactive code execution in the browser — the console session's only, never an API token's.
  'ide.use': null,
  'ide.manage': null,
  // p19-ide W3: extension policy — console session only (it changes what runs inside every IDE).
  'ide.extensions': null,
  // Approvals and approval policy.
  'approvals.read': R,
  'approvals.decide': A,
  'policy.read': ADM,
  'policy.write': ADM,
  // Context and memory.
  'context.read': R,
  'context.write': W,
  'context.delete': ADM,
  'context.purge': ADM,
  'context.bundle': R,
  'context.retention': ADM,
  'context.export': R,
  'context.receipts': ADM,
  'context.search': R,
  'context.search.admin': ADM,
  'context.defaults': ADM,
  'memory.suggestions.read': R,
  'memory.suggestions.decide': W,
  'memory.suggestions.admin': ADM,
  'memory.personal': null,
  // Audit and backups: admin data, never under the plain read scope.
  'audit.read': ADM,
  'audit.verify': ADM,
  'audit.export': ADM,
  'backups.read': ADM,
  // p16-observability: status page, traces and log search (admin data).
  'system.status': ADM,
  'system.logs': ADM,
  // p16-selfhost-onboarding: the owners' setup wizard is the browser's; the update status is admin data.
  'onboarding.manage': null,
  'updates.read': ADM,
  // p17-domain-wizard: the console's public address is changed in the browser's setup wizard only.
  'console.domain.read': null,
  'console.domain.write': null,
  // p17-host-actions: session only (the host's update / rollback needs an owner with a fresh authenticator code).
  'host.actions.read': null,
  // p17-panel-settings: never through an API token (owner settings, key rotation, account recovery, maintenance).
  'settings.panel.read': null,
  'settings.panel.write': null,
  'users.recover': null,
  'keys.rotate': null,
  'maintenance.read': null,
  'maintenance.run': null,
  'host.update': null,
  'backups.manage': null,
  'backups.restore': null,
  // Machines.
  'workers.read': R,
  'workers.approve': ADM,
  'workers.revoke': ADM,
  'workers.drain': ADM,
  'workers.archive': ADM,
  'workers.rotate': ADM,
  'workers.rename': ADM,
  'workers.update': ADM,
  'workers.config.read': ADM,
  'workers.config.write': ADM,
  'workers.ops.read': ADM,
  'workers.ops.write': ADM,
  'machines.admin.read': ADM,
  // Turning root/Administrator on for a machine is the owner's, in the browser.
  'machines.admin.enable': null,
  'machines.admin.run': ADM,
  // Vault: metadata reads for admins; writes carry ciphertext sealed in the browser.
  'vault.read': ADM,
  'vault.write': null,
  'models.read': R,
  'models.write': ADM,
  'runtimes.read': R,
  'runtimes.write': ADM,
  'releases.read': R,
  'releases.publish': ADM,
  // p17-update-channel: the owner's update policy is set in the browser only.
  'updates.channel.write': null,
  'installers.read': ADM,
  'skills.read': R,
  'skills.publish': ADM,
  'skills.assign': ADM,
  'mcp.read': R,
  'mcp.manage': ADM,
  'mcp.assign': ADM,
  // p19-install-scripts: approving code that runs on every machine stays the browser's (an always-fresh code).
  'mcp.scripts': null,
  // Usage and budgets.
  'usage.read': R,
  'usage.records': R,
  'prices.write': ADM,
  'budgets.read': R,
  'budgets.write': ADM,
  'budgets.override': ADM,
  'reports.self': null,
  // Workflows, schedules, automations, templates.
  'workflows.read': R,
  'workflows.define': W,
  'workflows.run': W,
  'workflows.approve': A,
  'workflows.test': W,
  'workflows.define.network': ADM,
  'workflows.define.deploy': ADM,
  'workflows.define.code': ADM,
  'workflows.egress.write': ADM,
  'workflows.activate': W,
  'workflows.share': ADM,
  'workflows.attach': ADM,
  'workflows.attach.credentials': ADM,
  'schedules.read': R,
  'schedules.write': W,
  'automations.read': R,
  'automations.write': W,
  'automations.external': ADM,
  'automations.crossproject': ADM,
  'templates.read': R,
  'templates.write': W,
  'templates.share': W,
  'templates.global': ADM,
  // Quotas and kill switch.
  'quotas.read': R,
  'quotas.write': ADM,
  'quotas.refresh': W,
  'projects.kill': ADM,
  // The chat is a browser conversation (cards, streams, the assistant acting for a person).
  'chat.use': null,
  'chat.admin': null,
  // Projects.
  'projects.read': R,
  'projects.create': ADM,
  'projects.git.read': R,
  'projects.git.write': ADM,
  'projects.workspace.read': R,
  'projects.workspace.write': ADM,
  'projects.execution.read': R,
  'projects.execution.write': ADM,
  'projects.egress.write': ADM,
  'projects.workers.read': R,
  'projects.workers.write': ADM,
  'projects.members.read': R,
  'projects.members.write': ADM,
  // Users and integrations.
  'users.read': ADM,
  'integrations.github.read': ADM,
  'integrations.github.write': ADM,
  'integrations.ops.read': ADM,
  'integrations.ops.write': ADM,
  'integrations.bedrock.read': ADM,
  'integrations.bedrock.write': ADM,
  'integrations.storage.read': ADM,
  // The bucket keys are typed by the owner in the browser, with a code.
  'integrations.storage.write': null,
  'integrations.githosts.read': ADM,
  'integrations.githosts.write': ADM,
  // Deploys and previews.
  'deploy.read': R,
  'deploy.request': D,
  'deploy.approve': A,
  'deploy.targets.write': ADM,
  'deploy.coolify.read': ADM,
  'deploy.coolify.manage': D,
  // p17-coolify-full: the Coolify-wide view and changes (admins).
  'coolify.read': ADM,
  'coolify.manage': ADM,
  'previews.read': R,
  'previews.open': D,
  // Showing a preview's Access service token is a secret reveal: the browser's, with a code.
  'previews.reveal': null,
  'services.read': R,
  'services.manage': W,
  'workfiles.read': R,
  'workfiles.manage': W,
  'workfiles.settings': ADM,
  'outputs.read': R,
  'outputs.write': W,
  'outputs.folders': W,
  // A share link hands a file to anyone holding it: the browser's, never a token's.
  'outputs.share': null,
  'uptime.read': R,
  'uptime.write': W,
  'uptime.settings': ADM,
  'git.identity.read': ADM,
  'git.identity.write': ADM,
  'sso.coolify': null,
  // Accounts and security: never through a token (a token cannot mint tokens or change who may do what).
  'users.manage': null,
  'tokens.self': null,
  'tokens.admin': null,
  'serviceaccounts.read': null,
  'serviceaccounts.manage': null,
  'security.read': ADM,
  'security.write': null,
  // p16-webhooks-out (ADR-0059): reading the webhooks with an admin token; changing them (new target, new secret) and the
  // internal targets only in the console.
  'webhooks.read': ADM,
  'webhooks.write': null,
  'webhooks.internal': null,
  // p16-doctor (ADR-0062): an admin token may run and read the doctor; sending the report off-site and changing where
  // it goes only in the console.
  'doctor.run': ADM,
  'support.report': null,
  'support.settings': null,
};

/** The scope a route's action needs, or null (session only). Unknown actions are session only. */
export function scopeForAction(action: string | undefined): TokenScope | null {
  if (action === undefined || !Object.hasOwn(TOKEN_SCOPE_OF, action)) return null;
  return TOKEN_SCOPE_OF[action as Action];
}
