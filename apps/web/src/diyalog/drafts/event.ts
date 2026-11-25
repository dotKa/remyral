/**
 * p15-autonomy: the security policy event of a chat card — the console's copy of the master's `eventOfDraft`
 * (apps/master/src/security-policy/events.ts). Only used to skip the code field up front when the session reports
 * the event as waived (`stepUpWaived`); the master decides either way.
 */
export function draftEvent(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'approval_decision':
      return 'approvals.decide';
    case 'worker_config':
      return 'machines.config';
    case 'machine_task':
      return 'machines.admin';
    case 'tool_install':
      return payload.elevated === true ? 'machines.admin' : 'machines.ops';
    // p16-runtime-updates: the event of POST /fleet/tools/actions.
    case 'runtime_update':
      return 'machines.ops';
    // p16-webhooks-out: as Ayarlar → Webhook'lar; pausing only stops sending.
    case 'webhook':
      return payload.op === 'pause' ? 'chat.cards' : 'integrations.webhooks';
    // p16-doctor: sending the support report off-site.
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
    // p17-coolify-full: destructive cards (remove a storage, stop, delete) and Coolify-wide ones have their own events.
    case 'coolify_change':
      // p22-site-coolify: the chain opens a project (new) and a GitHub repository.
      if (payload.op === 'publish_site')
        return payload.newProject === true ? 'projects.policy' : 'integrations.connections';
      return payload.destructive === true && payload.op !== 'delete_app'
        ? 'coolify.destructive'
        : payload.scope === 'connection'
          ? 'coolify.manage'
          : 'deploy.coolify';
    case 'github_repo':
      return 'integrations.connections';
    // p17-chat-github: the event of POST /projects.
    case 'project_create':
      return 'projects.policy';
    // p18-multi-project W3: the event of POST /projects/:project/workflow-attachments.
    case 'workflow_attach':
      return 'workflows.privileged';
    case 'workfiles_export':
      return typeof payload.newRepository === 'object' && payload.newRepository !== null
        ? 'integrations.connections'
        : 'chat.cards';
    case 'http_request':
      return typeof payload.credential === 'object' && payload.credential !== null
        ? 'workflows.privileged'
        : 'chat.cards';
    case 'credential_save':
      return 'credentials.write';
    case 'memory_change':
      return 'context.admin';
    case 'workflow':
      return Array.isArray(payload.privileged) && payload.privileged.length > 0
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
      // p16-assistant-admin: an administration card carries its event (the master's adminOpEvent).
      if (payload.target === 'admin')
        return typeof payload.event === 'string' ? payload.event : 'security.policy';
      switch (payload.target) {
        case 'project_execution':
          return 'machines.sandbox';
        case 'project_approval_rules':
          return 'projects.policy';
        case 'worker_runtime_policy':
          return 'machines.config';
        default:
          return 'security.policy';
      }
    default:
      return 'chat.cards';
  }
}
